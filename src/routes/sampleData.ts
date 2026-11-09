import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomInt, randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeApplications } from "../db/schema.js";
import { HttpError } from "../services/authService.js";
import { generateSampleRows } from "../services/aiService.js";
import { requireAuth } from "./authGuard.js";
import { buildApplicationXml, getOwnedApplication } from "./runtimeApplications.js";
import { withTx } from "../runtime/neo4jStore.js";
import { getApplication, guard } from "../runtimeEngine/applicationStore.js";
import { parseAuditingElement, parseValidationElement } from "../runtimeEngine/applicationModel.js";
import { ConcurrencyError, listEntityRows, permanentlyDeleteRows, saveEntityRow, ValidationError } from "../runtimeEngine/entityStore.js";
import { buildAppModel } from "../runtimeEngine/publicAccess.js";
import { roleSetupOf } from "../runtimeEngine/publishing.js";
import { buildSampleRows, entitiesToFill } from "../runtimeEngine/sampleData.js";
import { autoNumbersOf, nextAutoNumber, numberedFields } from "../runtimeEngine/autoNumber.js";

// Owner-only "fill this app with example records", so a new app can be tried without typing data
// in by hand. The keys created are remembered so "Remove sample data" deletes exactly those rows.

type Params = { Params: { id: string } };
type CreatedKeys = Record<string, (string | number)[]>;

function createdKeys(raw: string | null): CreatedKeys {
  try {
    return raw ? (JSON.parse(raw) as CreatedKeys) : {};
  } catch {
    return {};
  }
}
const countOf = (keys: CreatedKeys) => Object.values(keys).reduce((n, list) => n + list.length, 0);

async function loadModel(id: number) {
  const detail = await getApplication(id);
  if (!detail) throw new HttpError(404, "Application not found");
  return { detail, model: buildAppModel(detail.elements) };
}

export default async function sampleDataRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/runtime-applications/:id/sample-data", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    return reply.send({ count: countOf(createdKeys(owned.sampleRows)), published: !!owned.publishedAt });
  });

  app.post("/runtime-applications/:id/sample-data", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    // Records are shared with the live app, so real users would see these.
    if (owned.publishedAt) throw new HttpError(409, "This app is live, so its users would see the sample records. Unpublish it first.");
    const { detail, model } = await loadModel(owned.id);
    const roleEntityName = roleSetupOf(model)?.roleEntity.name ?? null;

    const existingKeys = await guard(() =>
      withTx(async (tx) => {
        const map = new Map<string, unknown[]>();
        for (const e of model.entities) {
          const key = e.fields.find((f) => f.key)?.name ?? "id";
          map.set(e.name, (await listEntityRows(tx, owned.id, e)).map((r) => r[key]));
        }
        return map;
      })
    );
    const fill = entitiesToFill(model, roleEntityName, existingKeys);
    if (fill.length === 0) throw new HttpError(409, "Every module already has records, so there's nothing to fill.");

    let generated;
    try {
      generated = await generateSampleRows(buildApplicationXml(detail), fill.map((e) => e.name), new Date().toISOString().slice(0, 10));
    } catch (e) {
      throw new HttpError(500, `Couldn't create sample data: ${e instanceof Error ? e.message : e}`);
    }

    const newKey = (entity: (typeof fill)[number]) => {
      const keyField = entity.fields.find((f) => f.key);
      return keyField?.type === "integer" ? randomInt(1_000_000, 2_000_000_000) : randomUUID();
    };
    const planned = buildSampleRows(model, generated, fill, existingKeys, newKey);
    const autoNumbers = autoNumbersOf(detail.elements);
    const validations = detail.elements.filter((e) => e.tag === "Validation").map((e) => parseValidationElement(e.xml));

    const { created, skipped, firstProblem } = await guard(() =>
      withTx(async (tx) => {
        const done: CreatedKeys = {};
        let skippedCount = 0;
        let problem: string | null = null;
        for (const { entity, key, row } of planned) {
          const auditingEl = entity.auditing ? detail.elements.find((e) => e.tag === "Auditing" && e.name === entity.auditing) : undefined;
          try {
            for (const f of numberedFields(entity, autoNumbers)) row[f.name] = await nextAutoNumber(tx, owned.id, autoNumbers[f.autoNumber!]);
            await saveEntityRow(tx, owned.id, entity, model.relationships, validations, auditingEl ? parseAuditingElement(auditingEl.xml) : null, row, { identity: req.user.email });
            (done[entity.name] ??= []).push(key);
          } catch (e) {
            // One example breaking a business rule shouldn't lose all the others.
            if (!(e instanceof ValidationError || e instanceof ConcurrencyError)) throw e;
            skippedCount += 1;
            problem ??= e.message;
          }
        }
        return { created: done, skipped: skippedCount, firstProblem: problem };
      })
    );

    const merged = createdKeys(owned.sampleRows);
    for (const [name, keys] of Object.entries(created)) merged[name] = [...(merged[name] ?? []), ...keys];
    await db.update(runtimeApplications).set({ sampleRows: JSON.stringify(merged) }).where(eq(runtimeApplications.id, owned.id));
    return reply.status(201).send({ created: countOf(created), skipped, firstProblem, modules: Object.keys(created).length });
  });

  app.delete("/runtime-applications/:id/sample-data", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const keys = createdKeys(owned.sampleRows);
    const { model } = await loadModel(owned.id);
    await guard(() =>
      withTx(async (tx) => {
        for (const [name, list] of Object.entries(keys)) {
          const entity = model.entities.find((e) => e.name === name);
          if (entity) await permanentlyDeleteRows(tx, owned.id, entity, list);
        }
      })
    );
    await db.update(runtimeApplications).set({ sampleRows: null }).where(eq(runtimeApplications.id, owned.id));
    return reply.send({ removed: countOf(keys) });
  });
}
