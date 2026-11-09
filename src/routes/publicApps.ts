import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Transaction } from "neo4j-driver";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeApplications, runtimeAppInvites } from "../db/schema.js";
import { RuntimeApplicationRunSchema } from "../models/schemas.js";
import { HttpError } from "../services/authService.js";
import { withTx } from "../runtime/neo4jStore.js";
import { fromDriverValue } from "../runtime/values.js";
import { dispatchEmailActions } from "./runtimeApplications.js";
import { guard } from "../runtimeEngine/applicationStore.js";
import {
  parseActionElement, parseApplicationXml, parseAuditingElement, parseValidationElement, type EntityDef,
} from "../runtimeEngine/applicationModel.js";
import { resolveAccountRole, identifierFieldOf, runButtonAction, type RuntimeAction } from "../runtimeEngine/applicationEngine.js";
import { signRtAppSession, verifyRtAppSession } from "../runtimeEngine/appAuth.js";
import { logAuditEvent } from "../runtimeEngine/auditLog.js";
import { compileDataSource } from "../runtimeEngine/dataSourceCompiler.js";
import { getEntityRow, getEntityRowByField, listEntityRows, restoreEntityRow, ValidationError } from "../runtimeEngine/entityStore.js";
import { isLocked, recordFailure, recordSuccess } from "../runtimeEngine/loginAttemptGuard.js";
import {
  buildAppModel, canEnterScreen, canReadEntity, canUseDataSource, elementsForViewer, isActionAllowed,
  PROTECTED_ACCOUNT_FIELDS, sanitizeRow, type AppModel, type StoredElement,
} from "../runtimeEngine/publicAccess.js";
import { inviteIdFromToken, isInviteExpired, isInviteTokenValid, makeSignupPolicy, type SignupMode } from "../runtimeEngine/publishing.js";
import { isScoped, matchesScope, resolveScope, type ResolvedScope } from "../runtimeEngine/rowScope.js";
import { saveUpload, UploadError } from "../runtimeEngine/uploads.js";

// A published application, used by real people through its public link. Registered WITHOUT the
// Studio's requireAuth: each request is authenticated with the app's own session token (sent as
// a bearer header, because the frontend and API are on different sites and a SameSite cookie
// wouldn't be sent) and every read and write is decided by publicAccess.ts. It serves the
// published snapshot of the definition, not the Studio's working copy.

type Slug = { Params: { slug: string } };
type Session = { identity: string; role: string | null; mustChangePassword: boolean };
type Published = { id: number; name: string; signupMode: SignupMode; elements: StoredElement[]; theme: string | null; database: string | null; model: AppModel };

const AUTH_RATE_LIMITED = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

async function loadPublished(slug: string): Promise<Published> {
  const [row] = await db.select().from(runtimeApplications).where(eq(runtimeApplications.slug, slug)).limit(1);
  if (!row || !row.publishedAt || !row.publishedXml) throw new HttpError(404, "This app isn't available.");
  const manifest = parseApplicationXml(row.publishedXml);
  return {
    id: row.id, name: manifest.name, theme: manifest.theme, database: manifest.database,
    signupMode: row.signupMode === "open" ? "open" : "invite",
    elements: manifest.elements, model: buildAppModel(manifest.elements),
  };
}

// The account is re-read on every request, so removing a member or changing their role applies
// immediately rather than when their 12-hour token expires.
async function currentSession(req: FastifyRequest, app: Published): Promise<Session | null> {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const verified = token ? verifyRtAppSession(token, app.id) : null;
  const account = app.model.accountEntity;
  if (!verified || !account) return null;
  return guard(() =>
    withTx(async (tx) => {
      const row = await getEntityRowByField(tx, app.id, account, identifierFieldOf(account), verified.identity);
      if (!row) return null;
      const role = account.fields.some((f) => f.name === "roleId")
        ? await resolveAccountRole({ applicationId: app.id, entity: account, relationships: app.model.relationships, tx }, row.roleId)
        : null;
      return { identity: verified.identity, role, mustChangePassword: row.mustChangePassword === true };
    })
  );
}

// The unused, unexpired invite a personal link stands for, or null.
async function inviteFromToken(token: string | undefined, applicationId: number) {
  const id = token ? inviteIdFromToken(token) : null;
  if (!token || !id) return null;
  const [invite] = await db.select().from(runtimeAppInvites)
    .where(and(eq(runtimeAppInvites.id, id), eq(runtimeAppInvites.applicationId, applicationId))).limit(1);
  if (!invite || invite.acceptedAt || isInviteExpired(invite.createdAt) || !isInviteTokenValid(token, invite)) return null;
  return invite;
}

function viewerOf(session: Session | null) {
  return { signedIn: !!session, role: session?.role ?? null };
}

async function requireWorkingSession(req: FastifyRequest, app: Published): Promise<Session> {
  const session = await currentSession(req, app);
  if (!session) throw new HttpError(401, "Please sign in.");
  if (session.mustChangePassword) throw new HttpError(403, "Change your password to continue.");
  return session;
}

function readableEntity(app: Published, name: string, session: Session): EntityDef {
  const entity = app.model.entities.find((e) => e.name === name);
  if (!entity || !canReadEntity(app.model, name, viewerOf(session))) throw new HttpError(403, "You don't have permission to access this.");
  return entity;
}

// null when this viewer isn't limited on this entity.
function scopeFor(tx: Transaction, app: Published, entity: EntityDef, session: Session): Promise<ResolvedScope | null> | null {
  return isScoped(entity, session.role) ? resolveScope(tx, app.id, app.model, entity, session) : null;
}

// Brute-force protection for anything checking a secret: passwords and emailed one-time codes.
function lockKeyFor(action: string, values: Record<string, unknown>): string | null {
  if (action === "login") return String(values.email ?? values.username ?? "");
  if (action === "verifyEmail" || action === "resetPassword") return `otp:${String(values.email ?? "")}`;
  return null;
}
function actionSucceeded(action: string, results: RuntimeAction[]): boolean {
  if (action === "resetPassword") return results.some((a) => a.type === "message" && a.messageType === "success");
  return results.some((a) => a.type === "session");
}

export default async function publicAppRoutes(app: FastifyInstance) {
  app.get("/public-apps/:slug", async (req: FastifyRequest<Slug>, reply) => {
    const published = await loadPublished(req.params.slug);
    const session = await currentSession(req, published);
    return reply.send({
      id: published.id, name: published.name, theme: published.theme, database: published.database,
      signupMode: published.signupMode,
      elements: elementsForViewer(published.elements, published.model, viewerOf(session)),
      session,
    });
  });

  app.get(
    "/public-apps/:slug/invite-check",
    AUTH_RATE_LIMITED,
    async (req: FastifyRequest<{ Params: { slug: string }; Querystring: { token?: string } }>, reply) => {
      const published = await loadPublished(req.params.slug);
      const invite = await inviteFromToken(req.query.token, published.id);
      if (!invite) throw new HttpError(404, "This invitation link has expired or was already used.");
      return reply.send({ email: invite.email });
    }
  );

  app.get(
    "/public-apps/:slug/entities/:entityName/rows",
    async (req: FastifyRequest<{ Params: { slug: string; entityName: string }; Querystring: { includeDeleted?: string } }>, reply) => {
      const published = await loadPublished(req.params.slug);
      const session = await requireWorkingSession(req, published);
      const entity = readableEntity(published, req.params.entityName, session);
      const rows = await guard(() =>
        withTx(async (tx) => {
          const all = await listEntityRows(tx, published.id, entity, { includeDeleted: req.query.includeDeleted === "true" });
          const scope = await scopeFor(tx, published, entity, session);
          return scope ? all.filter((r) => matchesScope(r, scope)) : all;
        })
      );
      return reply.send({ rows: rows.map(sanitizeRow) });
    }
  );

  app.get(
    "/public-apps/:slug/entities/:entityName/rows/:key",
    async (req: FastifyRequest<{ Params: { slug: string; entityName: string; key: string } }>, reply) => {
      const published = await loadPublished(req.params.slug);
      const session = await requireWorkingSession(req, published);
      const entity = readableEntity(published, req.params.entityName, session);
      const row = await guard(() =>
        withTx(async (tx) => {
          const found = await getEntityRow(tx, published.id, entity, req.params.key);
          const scope = found ? await scopeFor(tx, published, entity, session) : null;
          return found && scope && !matchesScope(found, scope) ? null : found;
        })
      );
      if (!row) throw new HttpError(404, "Row not found");
      return reply.send({ row: sanitizeRow(row) });
    }
  );

  app.post(
    "/public-apps/:slug/entities/:entityName/rows/:key/restore",
    async (req: FastifyRequest<{ Params: { slug: string; entityName: string; key: string } }>, reply) => {
      const published = await loadPublished(req.params.slug);
      const session = await requireWorkingSession(req, published);
      const entity = readableEntity(published, req.params.entityName, session);
      await guard(() =>
        withTx(async (tx) => {
          const scope = await scopeFor(tx, published, entity, session);
          if (scope) {
            const found = await getEntityRow(tx, published.id, entity, req.params.key, { includeDeleted: true });
            if (!found || !matchesScope(found, scope)) throw new HttpError(404, "Row not found");
          }
          try {
            await restoreEntityRow(tx, published.id, entity, req.params.key);
          } catch (e) {
            if (e instanceof ValidationError) throw new HttpError(400, e.message);
            throw e;
          }
          await logAuditEvent(tx, published.id, { type: "restore", identity: session.identity, detail: `${entity.name} ${req.params.key}` });
        })
      );
      return reply.status(204).send();
    }
  );

  app.get(
    "/public-apps/:slug/datasources/:name/options",
    async (req: FastifyRequest<{ Params: { slug: string; name: string } }>, reply) => {
      const published = await loadPublished(req.params.slug);
      const session = await requireWorkingSession(req, published);
      const source = published.model.dataSources.find((d) => d.name === req.params.name);
      if (!source || !canUseDataSource(published.model, source, viewerOf(session))) throw new HttpError(403, "You don't have permission to access this.");
      const entityNames = new Set(published.model.entities.map((e) => e.name));
      const { statement, params } = compileDataSource(source, published.id, entityNames, { identity: session.identity });
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
      const valueField = source.valueField || "id";
      const displayField = source.displayField || valueField;
      // A dropdown over a limited entity only offers the records this person can reach.
      const sourceEntity = published.model.entities.find((e) => e.name === source.entity);
      const reachable = sourceEntity && isScoped(sourceEntity, session.role)
        ? await guard(() =>
            withTx(async (tx) => {
              const scope = await resolveScope(tx, published.id, published.model, sourceEntity, session);
              return new Set((await listEntityRows(tx, published.id, sourceEntity)).filter((r) => matchesScope(r, scope)).map((r) => String(r[valueField])));
            })
          )
        : null;
      return reply.send({
        options: rows.filter((r) => !reachable || reachable.has(String(r[valueField])))
          .map((r) => ({ value: r[valueField], label: String(r[displayField] ?? r[valueField]) })),
      });
    }
  );

  app.post("/public-apps/:slug/uploads", AUTH_RATE_LIMITED, async (req: FastifyRequest<Slug>, reply) => {
    const published = await loadPublished(req.params.slug);
    await requireWorkingSession(req, published);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file uploaded.");
    try {
      return reply.status(201).send({ url: await saveUpload(published.id, file.mimetype, await file.toBuffer()) });
    } catch (e) {
      if (e instanceof UploadError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  app.post(
    "/public-apps/:slug/screens/:screenName/run",
    AUTH_RATE_LIMITED,
    async (req: FastifyRequest<{ Params: { slug: string; screenName: string } }>, reply) => {
      const published = await loadPublished(req.params.slug);
      const { model } = published;
      const body = RuntimeApplicationRunSchema.parse(req.body);
      const screen = model.screens.find((s) => s.name === req.params.screenName);
      if (!screen?.entity) throw new HttpError(404, "Screen not found");
      const entity = model.entities.find((e) => e.name === screen.entity);
      if (!entity) throw new HttpError(400, "This screen isn't set up correctly.");

      const session = await currentSession(req, published);
      if (!canEnterScreen(model, screen, viewerOf(session)) || !isActionAllowed(screen, body.action)) {
        if (session) {
          await guard(() => withTx((tx) => logAuditEvent(tx, published.id, { type: "access_denied", identity: session.identity, detail: `Screen "${screen.name}" action "${body.action}"` })));
          throw new HttpError(403, "You don't have permission to do that.");
        }
        throw new HttpError(401, "Please sign in.");
      }
      if (session?.mustChangePassword && body.action !== "changePassword") throw new HttpError(403, "Change your password to continue.");

      const lockKey = lockKeyFor(body.action, body.fieldValues);
      if (lockKey && isLocked(published.id, lockKey)) throw new HttpError(429, "Too many attempts — try again in a few minutes.");

      const of = (tag: string) => published.elements.filter((e) => e.tag === tag);
      const validations = of("Validation").map((e) => parseValidationElement(e.xml));
      const actions = of("Action").map((e) => parseActionElement(e.xml));
      const auditingEl = entity.auditing ? of("Auditing").find((e) => e.name === entity.auditing) : undefined;
      const auditing = auditingEl ? parseAuditingElement(auditingEl.xml) : null;
      const invites = (await db.select().from(runtimeAppInvites).where(eq(runtimeAppInvites.applicationId, published.id)))
        .filter((i) => !isInviteExpired(i.createdAt));
      // The link only counts for the email it was issued to.
      const linkInvite = body.action === "register" ? await inviteFromToken(body.inviteToken, published.id) : null;
      const verifiedInvite = linkInvite && linkInvite.email === String(body.fieldValues.email ?? "").trim().toLowerCase() ? linkInvite : null;

      const results = await guard(() =>
        withTx(async (tx) => {
          let values = body.fieldValues;
          // A form can never set an account's password or verification state — those stay exactly
          // as stored (and are still present for the required-field check).
          if (entity.isAccount && body.action === "save") {
            values = Object.fromEntries(Object.entries(values).filter(([k]) => !PROTECTED_ACCOUNT_FIELDS.includes(k)));
            const key = values[entity.fields.find((f) => f.key)?.name ?? "id"];
            const existing = key ? await getEntityRow(tx, published.id, entity, key) : null;
            if (existing) for (const f of PROTECTED_ACCOUNT_FIELDS) if (existing[f] !== undefined) values[f] = existing[f];
          }
          // Row-level access: the record being acted on must be this person's, and a save can't
          // hand it to someone else. On a new record the owner link is filled in for them.
          const scope = session && !entity.isAccount ? await scopeFor(tx, published, entity, session) : null;
          if (scope) {
            const keyName = entity.fields.find((f) => f.key)?.name ?? "id";
            const key = values[keyName];
            const existing = key ? await getEntityRow(tx, published.id, entity, key, { includeDeleted: true }) : null;
            if (existing && !matchesScope(existing, scope)) throw new HttpError(403, "You don't have permission to do that.");
            if (!scope.creator && body.action !== "delete") {
              const proposed = { ...existing, ...values };
              if ((proposed[scope.field] === undefined || proposed[scope.field] === "") && scope.fill !== undefined) {
                values = { ...values, [scope.field]: scope.fill };
                proposed[scope.field] = scope.fill;
              }
              if (body.action === "save" && !matchesScope(proposed, scope)) throw new HttpError(403, "You can only save records that belong to you.");
            }
          }
          const out = await runButtonAction(
            {
              applicationId: published.id, entity, relationships: model.relationships, validations, auditing,
              session: { identity: session?.identity ?? null, vars: {}, role: session?.role ?? null }, tx,
              signup: makeSignupPolicy(model, { mode: published.signupMode, invites, verifiedEmail: verifiedInvite?.email ?? null }),
            },
            body.action, actions, values
          );
          if (lockKey) {
            const ok = actionSucceeded(body.action, out);
            if (ok) recordSuccess(published.id, lockKey); else recordFailure(published.id, lockKey);
            if (body.action === "login") await logAuditEvent(tx, published.id, { type: ok ? "login_success" : "login_failure", identity: lockKey, detail: "" });
          }
          return out;
        })
      );
      dispatchEmailActions(results);
      const established = results.find((a) => a.type === "session");
      if (verifiedInvite && established) {
        await db.update(runtimeAppInvites).set({ acceptedAt: new Date() }).where(eq(runtimeAppInvites.id, verifiedInvite.id));
      }
      const appToken = established?.type === "session"
        ? signRtAppSession(published.id, established.identity, established.mustChangePassword, established.role)
        : undefined;
      return reply.send({ actions: results, appToken });
    }
  );
}
