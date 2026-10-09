import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectRow } from "../db/schema.js";
import { getOwnedProject, getProjectPublic } from "../services/projectStore.js";
import { PreviewRowsRequestSchema, RunEventRequestSchema } from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";
import { getCurrentUser, HttpError } from "../services/authService.js";
import { runEvent, isAnonymousEvent, type SiblingScreen } from "../runtime/engine.js";
import * as store from "../runtime/neo4jStore.js";
import { raceAbort, requestAbortSignal, RequestAbortedError } from "../utils/requestAbort.js";
import { cookieName, verifyAppSession, signAppSession, APP_SESSION_COOKIE_OPTS } from "../services/appSession.js";

type Screen = { id: string; name?: string; xml?: string };

function getScreens(project: ProjectRow): Screen[] {
  if (!project.uiScreens) return [];
  try {
    return JSON.parse(project.uiScreens);
  } catch {
    return [];
  }
}

// The project's data lives in Neo4j, namespaced by the Proj<id>_ label prefix — these routes are the
// runtime engine's HTTP surface used by the screen preview (row CRUD + server-side event execution).
// run-event (below) has its own dual authorization — a builder token, a real app session, or an
// explicit allowAnonymous event — so it does NOT use this blanket hook; every other route in this
// file (schema sync, preview-db row CRUD) stays builder-only, via requireAuth on each route.
export default async function previewDbRoutes(app: FastifyInstance) {
  // Neo4j's driver has no built-in way to cancel an in-flight session — a "Stop" click can't force
  // the remote write to abandon mid-statement. This races the HTTP response against the client
  // disconnecting instead: on abort, the handler stops waiting and returns promptly (freeing the
  // connection for the user to retry), even though whatever statement was already sent to Neo4j
  // may still complete server-side. Best-effort, not a true cancel — same trade-off syncSchema's
  // own "IF NOT EXISTS" idempotency already assumes (safe to re-run either way).
  const syncRoute = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    if (!project.entities) throw new HttpError(400, "No schema yet — extract entities first");
    const signal = requestAbortSignal(req);
    try {
      return await raceAbort(store.syncSchema(project.id, JSON.parse(project.entities), { force: true }), signal);
    } catch (e) {
      if (e instanceof RequestAbortedError) throw new HttpError(499, "Cancelled");
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("This project has no tables")) throw new HttpError(400, msg);
      req.log.error(e, `Neo4j schema sync failed for project ${project.id}`);
      throw new HttpError(500, `Neo4j schema creation failed: ${msg}`);
    }
  };

  // Explicit "Create DB (Neo4j)" button: {summary, statements, labels}.
  app.post("/projects/:id/neo4j/create-db", { preHandler: requireAuth }, async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    return reply.send(await syncRoute(req));
  });

  app.post("/projects/:id/preview-db/sync-schema", { preHandler: requireAuth }, async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const result = await syncRoute(req);
    return reply.send({ message: "Neo4j graph schema synced.", schema: `Proj${req.params.id}_`, ...result });
  });

  app.get("/projects/:id/preview-db/:entity", { preHandler: requireAuth }, async (req: FastifyRequest<{ Params: { id: string; entity: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    if (!project.entities) return reply.send({ rows: [], synced: false });
    const entities = JSON.parse(project.entities);
    try {
      if (!(await store.tableExists(project.id, req.params.entity))) return reply.send({ rows: [], synced: false });
      const rows = await store.withTx((tx) => store.listRows(tx, project.id, entities, req.params.entity));
      return reply.send({ rows, synced: true });
    } catch (e) {
      req.log.warn(`preview-db read failed for project ${project.id}/${req.params.entity}: ${e}`);
      return reply.send({ rows: [], synced: false });
    }
  });

  app.put("/projects/:id/preview-db/:entity", { preHandler: requireAuth }, async (req: FastifyRequest<{ Params: { id: string; entity: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    if (!project.entities) throw new HttpError(400, "No schema yet");
    const entities = JSON.parse(project.entities);
    const body = PreviewRowsRequestSchema.parse(req.body);
    try {
      await store.syncSchema(project.id, entities);
      await store.withTx((tx) => store.replaceAllRows(tx, project.id, entities, req.params.entity, body.rows));
    } catch (e) {
      throw new HttpError(500, `Preview data sync failed: ${e instanceof Error ? e.message : e}`);
    }
    return reply.send({ message: "ok" });
  });

  // Dual authorization, in order: (1) a builder JWT that owns this project — the Studio's own
  // editor/preview, full access, unchanged; (2) a real app session cookie for this exact project —
  // a genuinely logged-in end user of the GENERATED app, also full access; (3) neither — allowed
  // ONLY if the specific event being called is marked allowAnonymous="true" (a login/signup check).
  // Everything else is a 401. See services/appSession.ts and the plan this implements.
  app.post("/projects/:id/screens/:screenId/run-event", async (req: FastifyRequest<{ Params: { id: string; screenId: string } }>, reply) => {
    const projectId = Number(req.params.id);
    const bearer = (req.headers.authorization || "").replace("Bearer ", "").trim();

    let project: ProjectRow | null = null;
    let authorized = false;
    if (bearer) {
      try {
        const user = await getCurrentUser(bearer);
        project = await getOwnedProject(projectId, user.id);
        authorized = true;
      } catch {
        // Not a valid/owning builder token — fall through to the app-session check below.
      }
    }
    if (!authorized && verifyAppSession(req.cookies?.[cookieName(projectId)], projectId)) {
      project = await getProjectPublic(projectId);
      authorized = true;
    }
    if (!project) project = await getProjectPublic(projectId); // just to read the screen's XML below

    const allScreens = getScreens(project);
    const screen = allScreens.find((s) => s.id === req.params.screenId);
    if (!screen) throw new HttpError(404, "Screen not found");
    if (!screen.xml) throw new HttpError(400, "Screen has no XML yet");

    const body = RunEventRequestSchema.parse(req.body);
    if (!authorized && !isAnonymousEvent(screen.xml, body.elementId, body.eventType)) {
      throw new HttpError(401, "Please log in.");
    }

    const entities = project.entities ? JSON.parse(project.entities) : {};
    // Fetched fresh on every call (not baked into the XML at generation time) so a <navigate>
    // keeps resolving correctly even if a target screen was renamed or removed since this screen's
    // XML was written.
    const siblingScreens: SiblingScreen[] = allScreens.filter((s) => s.id !== screen.id).map((s) => ({ id: s.id, name: s.name || "" }));

    try {
      if ((entities.tables || []).length) await store.syncSchema(project.id, entities);
      const actions = await store.withTx((tx) =>
        runEvent((statement, params) => store.executeQuery(tx, project.id, entities, statement, params), entities, screen.xml!, body.elementId, body.eventType, body.fieldValues, siblingScreens)
      );
      // <session action="start"/"end"/> is a server-only concern (set/clear the real app-session
      // cookie) — never forwarded to the client, same spirit as "stop" carrying no client meaning.
      const clientActions = actions.filter((a) => {
        if (a.type !== "session") return true;
        if (a.action === "start") reply.setCookie(cookieName(projectId), signAppSession(projectId), APP_SESSION_COOKIE_OPTS);
        else reply.clearCookie(cookieName(projectId), { path: APP_SESSION_COOKIE_OPTS.path });
        return false;
      });
      return reply.send({ actions: clientActions });
    } catch (e) {
      req.log.warn(`run_event failed for project ${project.id} screen ${req.params.screenId}: ${e}`);
      const code = (e as { code?: string }).code || "";
      const message = code.includes("ConstraintValidationFailed")
        ? "A record with that key already exists."
        : "Something went wrong — please try again.";
      return reply.send({ actions: [{ type: "message", messageType: "error", value: message }] });
    }
  });
}
