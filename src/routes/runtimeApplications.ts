import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeApplications } from "../db/schema.js";
import { RuntimeApplicationCreateSchema, RuntimeApplicationGenerateSchema, RuntimeApplicationRunSchema } from "../models/schemas.js";
import { HttpError } from "../services/authService.js";
import { requireAuth } from "./authGuard.js";
import { withTx } from "../runtime/neo4jStore.js";
import { generateApplicationXml } from "../services/aiService.js";
import { saveApplicationNodes, getApplication, deleteApplicationNodes, listApplicationSummaries, guard } from "../runtimeEngine/applicationStore.js";
import {
  parseEntityElement, parseRelationshipElement, parseValidationElement, parseScreenElement,
  parseActionElement, parseAuditingElement,
} from "../runtimeEngine/applicationModel.js";
import { runButtonAction } from "../runtimeEngine/applicationEngine.js";

// The second, independent "Runtime Engine" — see runtimeEngine/. Deliberately top-level, NOT
// nested under /projects/:id/..., since an Application isn't scoped to a project (confirmed with
// the user: "we need to have a separate space for both"). Ownership is checked against this row's
// own userId, the same shape domains.ts already uses for user_chosen_domains, just without a
// project in between.
async function getOwnedApplication(id: number, userId: number) {
  const [row] = await db.select().from(runtimeApplications).where(eq(runtimeApplications.id, id)).limit(1);
  if (!row || row.userId !== userId) throw new HttpError(404, "Application not found");
  return row;
}

export default async function runtimeApplicationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Returns the generated XML for review/editing — does NOT create anything itself. The caller
  // reviews (and can hand-edit) it client-side, then POSTs it to /runtime-applications as usual,
  // same two-step flow the Domains page already uses for its own AI-assisted creation.
  app.post("/runtime-applications/generate", async (req, reply) => {
    const body = RuntimeApplicationGenerateSchema.parse(req.body);
    try {
      const xml = await generateApplicationXml(body.description);
      return reply.send({ xml });
    } catch (e) {
      throw new HttpError(500, `AI generation failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  app.post("/runtime-applications", async (req, reply) => {
    const body = RuntimeApplicationCreateSchema.parse(req.body);
    const [row] = await db.insert(runtimeApplications).values({ name: body.name, userId: req.user.id }).returning();
    try {
      const parsed = await saveApplicationNodes(row.id, body.xml);
      return reply.status(201).send({ id: row.id, name: parsed.name, theme: parsed.theme, database: parsed.database, elementCounts: parsed.elementCounts });
    } catch (e) {
      // Same "nothing partially created" guarantee as the Domains-seeded project creation earlier
      // this session — a failed Neo4j write shouldn't leave an empty orphan Postgres row behind.
      await db.delete(runtimeApplications).where(eq(runtimeApplications.id, row.id));
      throw e;
    }
  });

  app.get("/runtime-applications", async (req: FastifyRequest, reply) => {
    const rows = await db.select().from(runtimeApplications).where(eq(runtimeApplications.userId, req.user.id));
    const summaries = await listApplicationSummaries(rows.map((r) => r.id));
    return reply.send(rows.map((r) => {
      const s = summaries.get(r.id);
      return { id: r.id, name: s?.name ?? r.name, theme: s?.theme ?? null, database: s?.database ?? null, elementCounts: s?.elementCounts ?? {}, createdAt: r.createdAt };
    }));
  });

  app.get("/runtime-applications/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const detail = await getApplication(owned.id);
    if (!detail) throw new HttpError(404, "Application not found");
    return reply.send({ id: owned.id, ...detail });
  });

  app.delete("/runtime-applications/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    await deleteApplicationNodes(owned.id);
    await db.delete(runtimeApplications).where(eq(runtimeApplications.id, owned.id));
    return reply.status(204).send();
  });

  app.post(
    "/runtime-applications/:id/screens/:screenName/run",
    async (req: FastifyRequest<{ Params: { id: string; screenName: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const body = RuntimeApplicationRunSchema.parse(req.body);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");

      const screenEl = detail.elements.find((e) => e.tag === "Screen" && e.name === req.params.screenName);
      if (!screenEl) throw new HttpError(404, "Screen not found");
      const screen = parseScreenElement(screenEl.xml);
      if (!screen.entity) throw new HttpError(400, "This screen isn't bound to an entity — nothing to run an action against");

      const entityEl = detail.elements.find((e) => e.tag === "Entity" && e.name === screen.entity);
      if (!entityEl) throw new HttpError(400, `Screen references unknown entity "${screen.entity}"`);
      const entity = parseEntityElement(entityEl.xml);

      const relationships = detail.elements.filter((e) => e.tag === "Relationship").map((e) => parseRelationshipElement(e.xml));
      const validations = detail.elements.filter((e) => e.tag === "Validation").map((e) => parseValidationElement(e.xml));
      const actions = detail.elements.filter((e) => e.tag === "Action").map((e) => parseActionElement(e.xml));
      const auditingEl = entity.auditing ? detail.elements.find((e) => e.tag === "Auditing" && e.name === entity.auditing) : undefined;
      const auditing = auditingEl ? parseAuditingElement(auditingEl.xml) : null;

      const resultActions = await guard(() =>
        withTx((tx) =>
          runButtonAction(
            { applicationId: owned.id, entity, relationships, validations, auditing, session: { identity: req.user.email, vars: {} }, tx },
            body.action, actions, body.fieldValues
          )
        )
      );
      return reply.send({ actions: resultActions });
    }
  );
}
