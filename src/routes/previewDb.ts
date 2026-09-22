import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { projects, type ProjectRow } from "../db/schema.js";
import { PreviewRowsRequestSchema, RunEventRequestSchema } from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";
import { HttpError } from "../services/authService.js";
import { runEvent } from "../runtime/engine.js";
import * as store from "../runtime/neo4jStore.js";
import { raceAbort, requestAbortSignal, RequestAbortedError } from "../utils/requestAbort.js";

type Screen = { id: string; xml?: string };

function getScreens(project: ProjectRow): Screen[] {
  if (!project.uiScreens) return [];
  try {
    return JSON.parse(project.uiScreens);
  } catch {
    return [];
  }
}

async function getOwnedProject(projectId: number, userId: number): Promise<ProjectRow> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.userId !== userId) throw new HttpError(404, "Project not found");
  return project;
}

// The project's data lives in Neo4j, namespaced by the Proj<id>_ label prefix — these routes are the
// runtime engine's HTTP surface used by the screen preview (row CRUD + server-side event execution).
export default async function previewDbRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

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
  app.post("/projects/:id/neo4j/create-db", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    return reply.send(await syncRoute(req));
  });

  app.post("/projects/:id/preview-db/sync-schema", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const result = await syncRoute(req);
    return reply.send({ message: "Neo4j graph schema synced.", schema: `Proj${req.params.id}_`, ...result });
  });

  app.get("/projects/:id/preview-db/:entity", async (req: FastifyRequest<{ Params: { id: string; entity: string } }>, reply) => {
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

  app.put("/projects/:id/preview-db/:entity", async (req: FastifyRequest<{ Params: { id: string; entity: string } }>, reply) => {
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

  app.post("/projects/:id/screens/:screenId/run-event", async (req: FastifyRequest<{ Params: { id: string; screenId: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const screen = getScreens(project).find((s) => s.id === req.params.screenId);
    if (!screen) throw new HttpError(404, "Screen not found");
    if (!screen.xml) throw new HttpError(400, "Screen has no XML yet");
    const entities = project.entities ? JSON.parse(project.entities) : {};
    const body = RunEventRequestSchema.parse(req.body);

    try {
      if ((entities.tables || []).length) await store.syncSchema(project.id, entities);
      const actions = await store.withTx((tx) =>
        runEvent((statement, params) => store.executeQuery(tx, project.id, entities, statement, params), entities, screen.xml!, body.elementId, body.eventType, body.fieldValues)
      );
      return reply.send({ actions });
    } catch (e) {
      req.log.warn(`run_event failed for project ${project.id} screen ${req.params.screenId}: ${e}`);
      return reply.send({ actions: [{ type: "message", messageType: "error", value: "Something went wrong — please try again." }] });
    }
  });
}
