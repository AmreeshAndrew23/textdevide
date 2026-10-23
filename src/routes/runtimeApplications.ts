import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeApplications } from "../db/schema.js";
import {
  RuntimeApplicationCreateSchema, RuntimeApplicationGenerateSchema, RuntimeApplicationRunSchema, RuntimeApplicationUpdateSchema,
  RuntimeApplicationChangePasswordSchema,
} from "../models/schemas.js";
import { HttpError } from "../services/authService.js";
import { requireAuth } from "./authGuard.js";
import { withTx } from "../runtime/neo4jStore.js";
import { generateApplicationXml } from "../services/aiService.js";
import { saveApplicationNodes, getApplication, deleteApplicationNodes, listApplicationSummaries, guard } from "../runtimeEngine/applicationStore.js";
import {
  parseEntityElement, parseRelationshipElement, parseValidationElement, parseScreenElement,
  parseActionElement, parseAuditingElement, parseDataSourceElement, escapeXmlAttr,
} from "../runtimeEngine/applicationModel.js";
import { runButtonAction, type RuntimeAction } from "../runtimeEngine/applicationEngine.js";
import { listEntityRows } from "../runtimeEngine/entityStore.js";
import { compileDataSource } from "../runtimeEngine/dataSourceCompiler.js";
import { fromDriverValue } from "../runtime/values.js";
import { rtAppCookieName, signRtAppSession, verifyRtAppSession, RT_APP_SESSION_COOKIE_OPTS } from "../runtimeEngine/appAuth.js";
import type { ApplicationDetail } from "../runtimeEngine/applicationStore.js";
import { saveUpload, resolveUploadPath, createReadStream, UploadError } from "../runtimeEngine/uploads.js";

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

// Finds the ONE Entity marked isAccount="true" (always "User" by the fixed convention) — present
// only on applications with real end-user accounts. null for every other application, in which
// case a Screen always runs as the Studio builder's own identity, exactly as before this feature.
function findAccountEntity(detail: ApplicationDetail) {
  for (const el of detail.elements) {
    if (el.tag !== "Entity") continue;
    const entity = parseEntityElement(el.xml);
    if (entity.isAccount) return entity;
  }
  return null;
}

// Actions that establish a NEW session rather than requiring an existing one — register is the
// one way the very first account ever gets created, so it has to run anonymously too, same as
// login (a bug caught live: register was 401ing exactly like every other action, since only
// "login" was exempted here — nothing could ever sign up).
const ANONYMOUS_ACTIONS = new Set(["login", "register"]);

// Resolves which identity a Screen/Action should run as. Applications with no real end-user
// accounts are unaffected (Studio builder identity, unchanged). Applications WITH one require a
// valid rtAppSession cookie for everything except login/register, which run anonymous.
function resolveRunSession(
  req: FastifyRequest, applicationId: number, accountEntity: ReturnType<typeof findAccountEntity>, action: string
): { identity: string | null; vars: Record<string, unknown> } {
  if (!accountEntity) return { identity: req.user.email, vars: {} };
  const verified = verifyRtAppSession(req.cookies?.[rtAppCookieName(applicationId)], applicationId);
  if (!verified) {
    if (ANONYMOUS_ACTIONS.has(action)) return { identity: null, vars: {} };
    throw new HttpError(401, "Not logged in.");
  }
  return { identity: verified.identity, vars: {} };
}

// After an action runs, a {type:"session",...} result (from the login/changePassword built-ins —
// see applicationEngine.ts) is the signal to actually set the cookie; this module is the only one
// that touches HTTP, so it's the only place that can act on that signal.
function applySessionResults(reply: import("fastify").FastifyReply, applicationId: number, actions: RuntimeAction[]): void {
  for (const a of actions) {
    if (a.type === "session") {
      reply.setCookie(rtAppCookieName(applicationId), signRtAppSession(applicationId, a.identity, a.mustChangePassword), RT_APP_SESSION_COOKIE_OPTS);
    }
  }
}

export default async function runtimeApplicationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Returns the generated XML for review/editing — does NOT create anything itself. The caller
  // reviews (and can hand-edit) it client-side, then POSTs it to /runtime-applications as usual,
  // same two-step flow the Domains page already uses for its own AI-assisted creation.
  app.post("/runtime-applications/generate", async (req, reply) => {
    const body = RuntimeApplicationGenerateSchema.parse(req.body);
    try {
      const xml = await generateApplicationXml(body.description, body.existingXml);
      return reply.send({ xml });
    } catch (e) {
      throw new HttpError(500, `AI generation failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  // xml is optional — "just a name" creates a real, empty Application; the description flow
  // (POST .../generate + PUT below) fills it in afterward, in one or several increments.
  app.post("/runtime-applications", async (req, reply) => {
    const body = RuntimeApplicationCreateSchema.parse(req.body);
    const [row] = await db.insert(runtimeApplications).values({ name: body.name, userId: req.user.id }).returning();
    const xml = body.xml || `<Application name="${escapeXmlAttr(body.name)}">\n</Application>`;
    try {
      const parsed = await saveApplicationNodes(row.id, xml);
      return reply.status(201).send({ id: row.id, name: parsed.name, theme: parsed.theme, database: parsed.database, elementCounts: parsed.elementCounts });
    } catch (e) {
      // Same "nothing partially created" guarantee as the Domains-seeded project creation earlier
      // this session — a failed Neo4j write shouldn't leave an empty orphan Postgres row behind.
      await db.delete(runtimeApplications).where(eq(runtimeApplications.id, row.id));
      throw e;
    }
  });

  // Reworks an existing Application's whole structure in place — same full-replace semantics
  // saveApplicationNodes always had; this just exposes it as an explicit update step for the
  // incremental describe-your-app flow (add an entity now, a screen later, etc.).
  app.put("/runtime-applications/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = RuntimeApplicationUpdateSchema.parse(req.body);
    const parsed = await saveApplicationNodes(owned.id, body.xml);
    return reply.send({ id: owned.id, name: parsed.name, theme: parsed.theme, database: parsed.database, elementCounts: parsed.elementCounts });
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

  // Lists an Entity's real, saved rows — what a Grid-type Screen browses. Read-only, so no
  // transaction/write-pipeline involvement; just the rows as they currently exist in Neo4j.
  app.get(
    "/runtime-applications/:id/entities/:entityName/rows",
    async (req: FastifyRequest<{ Params: { id: string; entityName: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      const entityEl = detail.elements.find((e) => e.tag === "Entity" && e.name === req.params.entityName);
      if (!entityEl) throw new HttpError(404, "Entity not found");
      const entity = parseEntityElement(entityEl.xml);
      const rows = await guard(() => withTx((tx) => listEntityRows(tx, owned.id, entity)));
      return reply.send({ rows });
    }
  );

  // Resolves a UIField's optionsFrom="query:<DataSource>" into {value,label} pairs for a real
  // dropdown — the AI generates these DataSources specifically for FK fields (see
  // dataSourceCompiler.ts), but until now nothing ever executed them; the Run panel rendered a
  // bare text input for every field, FK or not.
  app.get(
    "/runtime-applications/:id/datasources/:name/options",
    async (req: FastifyRequest<{ Params: { id: string; name: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      const dsEl = detail.elements.find((e) => e.tag === "DataSource" && e.name === req.params.name);
      if (!dsEl) throw new HttpError(404, "DataSource not found");
      const def = parseDataSourceElement(dsEl.xml);
      const entityNames = new Set(detail.elements.filter((e) => e.tag === "Entity").map((e) => e.name));
      const { statement, params } = compileDataSource(def, owned.id, entityNames, { identity: req.user.email });
      const rows = await guard(() =>
        withTx(async (tx) => {
          const res = await tx.run(statement, params);
          return res.records.map((r) => {
            const obj: Record<string, unknown> = {};
            for (const key of r.keys as string[]) obj[key] = fromDriverValue(r.get(key));
            return obj;
          });
        })
      );
      const valueField = def.valueField || "id";
      const displayField = def.displayField || valueField;
      return reply.send({ options: rows.map((r) => ({ value: r[valueField], label: String(r[displayField] ?? r[valueField]) })) });
    }
  );

  // Picture upload for a Field type="image" (an Employee photo, a Vendor logo, ...) — see
  // runtimeEngine/uploads.ts. Returns the URL to store as that field's value, same as any other
  // string field as far as entityStore.ts is concerned; ownership-checked the same way every
  // other per-application route is, so an upload always lands under the right application's own
  // folder and nobody can upload into an application they don't own.
  app.post("/runtime-applications/:id/uploads", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file uploaded.");
    const buffer = await file.toBuffer();
    try {
      const url = await saveUpload(owned.id, file.mimetype, buffer);
      return reply.status(201).send({ url });
    } catch (e) {
      if (e instanceof UploadError) throw new HttpError(400, e.message);
      throw e;
    }
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

      const accountEntity = findAccountEntity(detail);
      const session = resolveRunSession(req, owned.id, accountEntity, body.action);

      const resultActions = await guard(() =>
        withTx((tx) =>
          runButtonAction(
            { applicationId: owned.id, entity, relationships, validations, auditing, session, tx },
            body.action, actions, body.fieldValues
          )
        )
      );
      applySessionResults(reply, owned.id, resultActions);
      return reply.send({ actions: resultActions });
    }
  );

  // Logging out isn't "running a Screen" — a dedicated route rather than forcing it through the
  // Screen/Action machinery (see applicationEngine.ts's comment on why `logout` has no built-in).
  app.post("/runtime-applications/:id/auth/logout", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    reply.clearCookie(rtAppCookieName(owned.id), { path: RT_APP_SESSION_COOKIE_OPTS.path });
    return reply.status(204).send();
  });

  // Same changePassword built-in the ChangePassword screen's Button would run, exposed directly
  // so the Run panel's persistent account bar can offer it without navigating to that screen.
  app.post(
    "/runtime-applications/:id/auth/change-password",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const body = RuntimeApplicationChangePasswordSchema.parse(req.body);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      const accountEntity = findAccountEntity(detail);
      if (!accountEntity) throw new HttpError(400, "This application has no end-user accounts.");
      const session = resolveRunSession(req, owned.id, accountEntity, "changePassword");

      const resultActions = await guard(() =>
        withTx((tx) =>
          runButtonAction(
            { applicationId: owned.id, entity: accountEntity, relationships: [], validations: [], auditing: null, session, tx },
            "changePassword", [], { currentPassword: body.currentPassword, newPassword: body.newPassword }
          )
        )
      );
      applySessionResults(reply, owned.id, resultActions);
      return reply.send({ actions: resultActions });
    }
  );
}

// Deliberately a SEPARATE route function, registered in server.ts WITHOUT requireAuth — a plain
// <img src="..."> tag can't send an Authorization header, so an uploaded picture has to be
// servable without one. The random-UUID filename (see uploads.ts's saveUpload) is the real gate
// here, the same "unguessable URL" tradeoff every plain image/CDN URL already makes; nothing
// sensitive (no write, no listing) is reachable through this route.
export async function runtimeUploadsPublicRoutes(app: FastifyInstance) {
  app.get(
    "/runtime-applications/:id/uploads/:filename",
    async (req: FastifyRequest<{ Params: { id: string; filename: string } }>, reply) => {
      const resolved = await resolveUploadPath(Number(req.params.id), req.params.filename);
      if (!resolved) throw new HttpError(404, "Image not found.");
      reply.type(resolved.contentType);
      return reply.send(createReadStream(resolved.filePath));
    }
  );
}
