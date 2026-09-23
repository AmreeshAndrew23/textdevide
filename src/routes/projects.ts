import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { projects, promptLogs, type ProjectRow } from "../db/schema.js";
import { serializeProject, serializeProjectListItem, serializePromptLog } from "../serializers.js";
import { ProjectCreateSchema, ProjectUpdateSchema } from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";
import { generateSql } from "../services/sqlGen.js";
import { HttpError } from "../services/authService.js";
import { syncSchemaInBackground, dropProjectDataInBackground } from "../runtime/neo4jStore.js";
import { THEMES } from "../runtime/renderer.js";

function safeJson(text: string | null | undefined): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Port of routes/projects.py's `_get_project` — 404s if missing or not owned by this user.
async function getOwnedProject(projectId: number, userId: number): Promise<ProjectRow> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) throw new HttpError(404, "Project not found");
  return project;
}

// snake_case ProjectUpdate body -> the Drizzle row's camelCase column names, only for keys
// actually present in the body (mirrors Pydantic's exclude_unset=True partial-update semantics).
const UPDATE_KEY_MAP: Record<string, string> = {
  name: "name", description: "description", features: "features", entities: "entities",
  status: "status", language: "language", validation_rules: "validationRules",
  validation_code: "validationCode", ui_description: "uiDescription", ui_code: "uiCode",
  ui_xml: "uiXml", ui_html: "uiHtml", ui_api: "uiApi", frontend_language: "frontendLanguage",
  er_diagram: "erDiagram", ui_screens: "uiScreens", theme: "uiTheme",
};

export default async function projectRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/projects", async (req: FastifyRequest, reply: FastifyReply) => {
    const rows = await db.select().from(projects).where(eq(projects.userId, req.user.id)).orderBy(desc(projects.updatedAt));
    return reply.send(rows.map(serializeProjectListItem));
  });

  app.post("/projects", async (req, reply) => {
    const body = ProjectCreateSchema.parse(req.body);
    const [project] = await db
      .insert(projects)
      .values({
        name: body.name,
        description: body.description ?? undefined,
        features: body.features ?? undefined,
        language: body.language,
        frontendLanguage: body.frontend_language,
        status: "draft", // Column(String, default="draft") in project.py — explicit, see authService's NEW_USER_DEFAULTS note
        uiTheme: body.theme && body.theme in THEMES ? body.theme : "indigo",
        userId: req.user.id,
      })
      .returning();
    // GitHub repo auto-creation intentionally dropped — github_service.py was already retired
    // this session (its routes return 410); porting it would resurrect dead functionality.
    return reply.status(201).send(serializeProject(project));
  });

  app.get("/projects/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    return reply.send(serializeProject(project));
  });

  app.put("/projects/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = ProjectUpdateSchema.parse(req.body);
    const update: Record<string, unknown> = {};
    for (const [snakeKey, value] of Object.entries(body)) {
      if (value === undefined) continue; // not present in the request body — leave untouched
      const drizzleKey = UPDATE_KEY_MAP[snakeKey];
      if (drizzleKey) update[drizzleKey] = value;
    }
    const [updated] = await db.update(projects).set(update).where(eq(projects.id, project.id)).returning();
    if (typeof update.entities === "string") syncSchemaInBackground(project.id, safeJson(update.entities));
    return reply.send(serializeProject(updated));
  });

  app.delete("/projects/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    dropProjectDataInBackground(project.id, safeJson(project.entities));
    await db.delete(promptLogs).where(eq(promptLogs.projectId, project.id));
    await db.delete(projects).where(eq(projects.id, project.id));
    return reply.status(204).send();
  });

  app.get("/projects/:id/download-sql", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    if (!project.entities) throw new HttpError(400, "No entities to export");
    const sql = generateSql(JSON.parse(project.entities));
    const filename = `${project.name.toLowerCase().replace(/\s+/g, "_")}_schema.sql`;
    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type("application/sql")
      .send(sql);
  });

  app.get("/projects/:id/download-json", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    if (!project.entities) throw new HttpError(400, "No entities to export");
    const formatted = JSON.stringify(JSON.parse(project.entities), null, 2);
    const filename = `${project.name.toLowerCase().replace(/\s+/g, "_")}_schema.json`;
    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type("application/json")
      .send(formatted);
  });

  app.get("/projects/:id/prompt-logs", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const rows = await db
      .select()
      .from(promptLogs)
      .where(and(eq(promptLogs.projectId, project.id), eq(promptLogs.userId, req.user.id)))
      .orderBy(desc(promptLogs.createdAt));
    return reply.send(rows.map(serializePromptLog));
  });
}
