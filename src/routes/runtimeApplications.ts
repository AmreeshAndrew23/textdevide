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
import { generateApplicationXml, generateApplicationFixXml } from "../services/aiService.js";
import { saveApplicationNodes, mergeApplicationNodes, getApplication, deleteApplicationNodes, listApplicationSummaries, guard } from "../runtimeEngine/applicationStore.js";
import {
  parseEntityElement, parseRelationshipElement, parseValidationElement, parseScreenElement,
  parseActionElement, parseAuditingElement, parseDataSourceElement, escapeXmlAttr,
} from "../runtimeEngine/applicationModel.js";
import { runButtonAction, type RuntimeAction } from "../runtimeEngine/applicationEngine.js";
import { listEntityRows, getEntityRow, restoreEntityRow, ValidationError } from "../runtimeEngine/entityStore.js";
import { compileDataSource } from "../runtimeEngine/dataSourceCompiler.js";
import { fromDriverValue } from "../runtime/values.js";
import { rtAppCookieName, signRtAppSession, verifyRtAppSession, RT_APP_SESSION_COOKIE_OPTS } from "../runtimeEngine/appAuth.js";
import type { ApplicationDetail } from "../runtimeEngine/applicationStore.js";
import { saveUpload, resolveUploadPath, createReadStream, UploadError } from "../runtimeEngine/uploads.js";
import { logAuditEvent, listAuditEvents } from "../runtimeEngine/auditLog.js";
import { isLocked, recordFailure, recordSuccess } from "../runtimeEngine/loginAttemptGuard.js";
import { sendEmail } from "../services/emailService.js";

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

// Actions that establish a NEW session (or don't need one at all) rather than requiring an
// existing one — register is the one way the very first account ever gets created, so it has to
// run anonymously too, same as login (a bug caught live: register was 401ing exactly like every
// other action, since only "login" was exempted here — nothing could ever sign up). The
// email-verification/forgot-password/OAuth built-ins are all reachable before any session exists
// for the same reason.
const ANONYMOUS_ACTIONS = new Set([
  "login", "register", "verifyEmail", "requestPasswordReset", "resetPassword", "googleLogin", "githubLogin",
]);

// Resolves which identity a Screen/Action should run as. Applications with no real end-user
// accounts are unaffected (Studio builder identity, unchanged). Applications WITH one require a
// valid rtAppSession cookie for everything except login/register, which run anonymous.
function resolveRunSession(
  req: FastifyRequest, applicationId: number, accountEntity: ReturnType<typeof findAccountEntity>, action: string
): { identity: string | null; vars: Record<string, unknown>; role: string | null } {
  if (!accountEntity) return { identity: req.user.email, vars: {}, role: null };
  const verified = verifyRtAppSession(req.cookies?.[rtAppCookieName(applicationId)], applicationId);
  if (!verified) {
    if (ANONYMOUS_ACTIONS.has(action)) return { identity: null, vars: {}, role: null };
    throw new HttpError(401, "Not logged in.");
  }
  return { identity: verified.identity, vars: {}, role: verified.role };
}

// After an action runs, a {type:"session",...} result (from the login/changePassword built-ins —
// see applicationEngine.ts) is the signal to actually set the cookie; this module is the only one
// that touches HTTP, so it's the only place that can act on that signal.
function applySessionResults(reply: import("fastify").FastifyReply, applicationId: number, actions: RuntimeAction[]): void {
  for (const a of actions) {
    if (a.type === "session") {
      reply.setCookie(
        rtAppCookieName(applicationId),
        signRtAppSession(applicationId, a.identity, a.mustChangePassword, a.role),
        RT_APP_SESSION_COOKIE_OPTS
      );
    }
  }
}

// register/requestPasswordReset return a {type:"sendEmail",...} action instead of calling
// emailService.ts's sendEmail themselves (that module takes an open Transaction and does zero
// I/O — a slow/failed send must never risk the write, and a transaction that later rolls back must
// never have already emailed someone). This is the ONE place that acts on it, deliberately called
// only AFTER withTx(...) has resolved successfully — fire-and-forget, same as emailService.ts's
// own "never throw" design.
function dispatchEmailActions(actions: RuntimeAction[]): void {
  for (const a of actions) {
    if (a.type === "sendEmail") void sendEmail(a.to, a.subject, a.body);
  }
}

export default async function runtimeApplicationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Returns the generated XML for review/editing — does NOT create anything itself. The caller
  // reviews (and can hand-edit) it client-side, then POSTs it to /runtime-applications as usual,
  // same two-step flow the Domains page already uses for its own AI-assisted creation.
  //
  // With existingXml (an application that already has real content — adding a feature, or fixing
  // something), this returns a FRAGMENT (only the new/changed elements), meant for PATCH below —
  // never the whole-application rework that used to risk the AI subtly dropping or altering an
  // unrelated screen just by being asked to reproduce everything. Without existingXml (a brand
  // new, empty application), it's the normal full generation, meant for POST/PUT.
  app.post("/runtime-applications/generate", async (req, reply) => {
    const body = RuntimeApplicationGenerateSchema.parse(req.body);
    try {
      const xml = body.existingXml
        ? await generateApplicationFixXml(body.description, body.existingXml)
        : await generateApplicationXml(body.description);
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
      const parsed = await saveApplicationNodes(row.id, xml, req.user.email);
      return reply.status(201).send({ id: row.id, name: parsed.name, theme: parsed.theme, database: parsed.database, elementCounts: parsed.elementCounts });
    } catch (e) {
      // Same "nothing partially created" guarantee as the Domains-seeded project creation earlier
      // this session — a failed Neo4j write shouldn't leave an empty orphan Postgres row behind.
      await db.delete(runtimeApplications).where(eq(runtimeApplications.id, row.id));
      throw e;
    }
  });

  // Full replace — the WHOLE Application's structure is dropped and recreated from `xml`. Only
  // ever right for a brand-new or empty application (PUT after a from-scratch /generate); an
  // application that already has real content should go through PATCH below instead, which
  // touches only what actually changed.
  app.put("/runtime-applications/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = RuntimeApplicationUpdateSchema.parse(req.body);
    const parsed = await saveApplicationNodes(owned.id, body.xml, req.user.email);
    return reply.send({ id: owned.id, name: parsed.name, theme: parsed.theme, database: parsed.database, elementCounts: parsed.elementCounts });
  });

  // Targeted merge — `xml` is a FRAGMENT (only the elements that are new or changed, from
  // /generate's existingXml branch); every other element, and every real data row, is left
  // completely untouched. This is the safe path for "describe a fix/change" once an application
  // already has real content — see applicationStore.ts's mergeApplicationNodes.
  app.patch("/runtime-applications/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = RuntimeApplicationUpdateSchema.parse(req.body);
    const parsed = await mergeApplicationNodes(owned.id, body.xml, req.user.email);
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
  // ?includeDeleted=true is the "Show deleted" toggle — soft-deleted rows are excluded by default.
  app.get(
    "/runtime-applications/:id/entities/:entityName/rows",
    async (req: FastifyRequest<{ Params: { id: string; entityName: string }; Querystring: { includeDeleted?: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      const entityEl = detail.elements.find((e) => e.tag === "Entity" && e.name === req.params.entityName);
      if (!entityEl) throw new HttpError(404, "Entity not found");
      const entity = parseEntityElement(entityEl.xml);
      const includeDeleted = req.query.includeDeleted === "true";
      const rows = await guard(() => withTx((tx) => listEntityRows(tx, owned.id, entity, { includeDeleted })));
      return reply.send({ rows });
    }
  );

  // A single row by its own key — needed for the Run panel's "Reload latest" conflict-resolution
  // action (see applicationEngine.ts's ConcurrencyError / the "conflict" messageType), which has
  // to re-fetch exactly the one record that just failed to save, not the whole grid.
  app.get(
    "/runtime-applications/:id/entities/:entityName/rows/:key",
    async (req: FastifyRequest<{ Params: { id: string; entityName: string; key: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      const entityEl = detail.elements.find((e) => e.tag === "Entity" && e.name === req.params.entityName);
      if (!entityEl) throw new HttpError(404, "Entity not found");
      const entity = parseEntityElement(entityEl.xml);
      const row = await guard(() => withTx((tx) => getEntityRow(tx, owned.id, entity, req.params.key)));
      if (!row) throw new HttpError(404, "Row not found");
      return reply.send({ row });
    }
  );

  // Un-deletes a soft-deleted row. Known limitation (documented, not silently handled): restoring
  // a cascade-deleted parent does NOT cascade-restore its children — see entityStore.ts.
  app.post(
    "/runtime-applications/:id/entities/:entityName/rows/:key/restore",
    async (req: FastifyRequest<{ Params: { id: string; entityName: string; key: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      const entityEl = detail.elements.find((e) => e.tag === "Entity" && e.name === req.params.entityName);
      if (!entityEl) throw new HttpError(404, "Entity not found");
      const entity = parseEntityElement(entityEl.xml);
      await guard(() =>
        withTx(async (tx) => {
          try {
            await restoreEntityRow(tx, owned.id, entity, req.params.key);
          } catch (e) {
            if (e instanceof ValidationError) throw new HttpError(400, e.message);
            throw e;
          }
          await logAuditEvent(tx, owned.id, { type: "restore", identity: req.user.email, detail: `${entity.name} ${req.params.key}` });
        })
      );
      return reply.status(204).send();
    }
  );

  // Owner-only read-back of the security/audit log (logins, registrations, deletes, restores,
  // RBAC denials) — see auditLog.ts.
  app.get(
    "/runtime-applications/:id/audit-log",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const events = await listAuditEvents(owned.id);
      return reply.send({ events });
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

      // RBAC gate — a Screen with requiresRole can only be entered by a session whose resolved
      // role is in that list, checked BEFORE the action runs so a disallowed user gets a clean 403
      // rather than the action silently doing something it shouldn't (see applicationModel.ts).
      if (screen.requiresRole && (!session.role || !screen.requiresRole.includes(session.role))) {
        await guard(() =>
          withTx((tx) =>
            logAuditEvent(tx, owned.id, {
              type: "access_denied", identity: session.identity,
              detail: `Screen "${screen.name}" requires role: ${screen.requiresRole!.join(", ")}`,
            })
          )
        );
        throw new HttpError(403, "You don't have permission to access this screen.");
      }

      // Login-attempt lockout — identity-keyed, independent of the blanket per-IP rate limit
      // registered in server.ts (see loginAttemptGuard.ts). Falls back to username for an
      // already-generated, legacy-shape app's User entity (see applicationModel.ts's dual-shape
      // account convention) — a current one submits email instead.
      const loginIdentifier = body.action === "login" ? String(body.fieldValues.email ?? body.fieldValues.username ?? "") : null;
      if (loginIdentifier && isLocked(owned.id, loginIdentifier)) {
        throw new HttpError(429, "Too many failed login attempts — try again in a few minutes.");
      }

      const resultActions = await guard(() =>
        withTx(async (tx) => {
          const actionResults = await runButtonAction(
            { applicationId: owned.id, entity, relationships, validations, auditing, session, tx },
            body.action, actions, body.fieldValues
          );
          // Audit + lockout bookkeeping, in the SAME transaction the action itself ran in.
          if (loginIdentifier) {
            const succeeded = actionResults.some((a) => a.type === "session");
            if (succeeded) recordSuccess(owned.id, loginIdentifier); else recordFailure(owned.id, loginIdentifier);
            await logAuditEvent(tx, owned.id, { type: succeeded ? "login_success" : "login_failure", identity: loginIdentifier, detail: "" });
          } else if (body.action === "register" && actionResults.some((a) => a.type === "message" && a.messageType === "success")) {
            // A current-shape registration succeeds WITHOUT a "session" action (it's unverified —
            // see applicationEngine.ts's runRegister), so this is keyed off the success message
            // instead, unlike the login branch above.
            await logAuditEvent(tx, owned.id, {
              type: "register", identity: String(body.fieldValues.email ?? body.fieldValues.username ?? "") || null, detail: "",
            });
          } else if (body.action === "delete" && actionResults.some((a) => a.type === "message" && a.messageType === "success")) {
            await logAuditEvent(tx, owned.id, { type: "delete", identity: session.identity, detail: entity.name });
          }
          return actionResults;
        })
      );
      applySessionResults(reply, owned.id, resultActions);
      dispatchEmailActions(resultActions);
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
      // Real relationships (not a hardcoded []) — found live: this route's RBAC role resolution
      // silently always came back null regardless of the entity's actual roleId setup, since
      // resolveAccountRole needs the real Relationship from roleId to the role entity to look
      // anything up, and an empty array can never contain it.
      const relationships = detail.elements.filter((e) => e.tag === "Relationship").map((e) => parseRelationshipElement(e.xml));
      const auditingEl = accountEntity.auditing ? detail.elements.find((e) => e.tag === "Auditing" && e.name === accountEntity.auditing) : undefined;
      const auditing = auditingEl ? parseAuditingElement(auditingEl.xml) : null;

      const resultActions = await guard(() =>
        withTx((tx) =>
          runButtonAction(
            { applicationId: owned.id, entity: accountEntity, relationships, validations: [], auditing, session, tx },
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
