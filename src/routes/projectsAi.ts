import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { projects } from "../db/schema.js";
import { serializeProject } from "../serializers.js";
import {
  ExtractRequestSchema, RefineRequestSchema, SchemaAssistantRequestSchema, WorkbenchInterpretRequestSchema,
  GenerateValidationRequestSchema, GenerateUIXmlRequestSchema,
} from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";
import {
  extractEntities, refineEntities, schemaAssistantEditTable, interpretRequirement,
  generateEntityCode, editValidationCode, detectScreenIntents, type UsageEntry,
} from "../services/aiService.js";
import { logPrompt } from "../services/promptLog.js";
import { HttpError } from "../services/authService.js";
import { syncSchemaInBackground } from "../runtime/neo4jStore.js";

async function getOwnedProject(projectId: number, userId: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.userId !== userId) throw new HttpError(404, "Project not found");
  return project;
}

function getScreens(project: { uiScreens: string | null }): any[] {
  if (!project.uiScreens) return [];
  try {
    return JSON.parse(project.uiScreens);
  } catch {
    return [];
  }
}

// Port of routes/projects.py's _schema_suggestions — cheap, deterministic follow-up chips for
// the Schema Assistant, no AI call needed.
function schemaSuggestions(table: any, otherTables: any[]): string[] {
  const cols = table.columns || [];
  const suggestions: string[] = [];
  for (const c of cols) {
    const name = c.name || "";
    if ((name.includes("code") || name.endsWith("_no") || name.endsWith("_number")) && !c.unique) {
      suggestions.push(`Make ${name} unique`);
      break;
    }
  }
  for (const c of cols) {
    if ((c.type || "").toUpperCase().startsWith("BOOL") && (c.default === null || c.default === undefined || c.default === "")) {
      suggestions.push(`Add a default for ${c.name}`);
      break;
    }
  }
  if (!table.audit_enabled) {
    suggestions.push("Turn on auditing");
  } else if (!table.history_enabled) {
    suggestions.push("Keep a full change history");
  }
  if (otherTables.length && !cols.some((c: any) => c.fk)) {
    suggestions.push(`Add a foreign key to ${otherTables[0].name}`);
  }
  if (suggestions.length === 0) return ["Add a new column", "Add a validation rule", "Rename a column"];
  return suggestions.slice(0, 3);
}

export default async function projectsAiRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/projects/:id/extract", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = ExtractRequestSchema.parse(req.body);
    const usageSink: UsageEntry[] = [];
    let result: any;
    try {
      result = await extractEntities(body.description, body.features, usageSink);
    } catch (e) {
      throw new HttpError(500, `AI extraction failed: ${e instanceof Error ? e.message : e}`);
    }
    const unresolved = result && typeof result === "object" ? result.unresolved || [] : [];
    const entities = result && typeof result === "object" ? { tables: result.tables || [] } : result;

    let entityCode: string | null = null;
    try {
      entityCode = await generateEntityCode(entities, project.language || "Python", usageSink);
    } catch {
      entityCode = null;
    }

    await logPrompt(req.user.id, project.id, "extract_entities",
      `Description: ${body.description}\n\nFeatures: ${body.features}`, JSON.stringify(entities), usageSink);

    const updateValues: Record<string, unknown> = { description: body.description, features: body.features, entities: JSON.stringify(entities), status: "draft" };
    if (entityCode) updateValues.validationCode = entityCode;
    const [updated] = await db
      .update(projects)
      .set(updateValues)
      .where(eq(projects.id, project.id))
      .returning();
    syncSchemaInBackground(project.id, entities);
    return reply.send({ ...serializeProject(updated), unresolved });
  });

  app.post("/projects/:id/refine", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = RefineRequestSchema.parse(req.body);
    const usageSink: UsageEntry[] = [];
    let result: any;
    try {
      result = await refineEntities(body.entities, body.instruction, usageSink);
    } catch (e) {
      throw new HttpError(500, `AI refinement failed: ${e instanceof Error ? e.message : e}`);
    }
    const unresolved = result && typeof result === "object" ? result.unresolved || [] : [];
    const entities = result && typeof result === "object" ? { tables: result.tables || [] } : result;

    await logPrompt(req.user.id, project.id, "refine_entities", body.instruction, JSON.stringify(entities), usageSink);

    const [updated] = await db
      .update(projects)
      .set({ entities: JSON.stringify(entities), status: "draft" })
      .where(eq(projects.id, project.id))
      .returning();
    syncSchemaInBackground(project.id, entities);
    return reply.send({ ...serializeProject(updated), unresolved });
  });

  app.post("/projects/:id/schema-assistant/:tableName", async (req: FastifyRequest<{ Params: { id: string; tableName: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    if (!project.entities) throw new HttpError(400, "No schema yet — extract entities first");
    const body = SchemaAssistantRequestSchema.parse(req.body);
    const entities = JSON.parse(project.entities);
    const tables: any[] = entities.tables || [];
    const idx = tables.findIndex((t) => t.name === req.params.tableName);
    if (idx === -1) throw new HttpError(404, "Table not found");
    const table = tables[idx];
    const otherTables = tables.filter((t) => t.name !== req.params.tableName);

    const usageSink: UsageEntry[] = [];
    let result: any;
    try {
      result = await schemaAssistantEditTable(table, otherTables, body.instruction, usageSink);
    } catch (e) {
      throw new HttpError(500, `Schema assistant failed: ${e instanceof Error ? e.message : e}`);
    }

    const updatedTable = result.table || table;
    tables[idx] = updatedTable;
    entities.tables = tables;
    const entitiesJson = JSON.stringify(entities);
    await db.update(projects).set({ entities: entitiesJson }).where(eq(projects.id, project.id));
    syncSchemaInBackground(project.id, entities);
    await logPrompt(req.user.id, project.id, "schema_assistant", `[${req.params.tableName}] ${body.instruction}`, result.summary || "", usageSink);

    return reply.send({
      table: updatedTable,
      summary: result.summary || "Done — check the Schema tab.",
      suggestions: schemaSuggestions(updatedTable, otherTables),
      entities: entitiesJson,
      unresolved: result.unresolved || [],
    });
  });

  app.post("/projects/:id/workbench/interpret", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = WorkbenchInterpretRequestSchema.parse(req.body);

    let entities: any, screens: any[], validationRules: string | null;
    if (body.current_entities !== undefined || body.current_screens !== undefined || body.current_validation_rules !== undefined) {
      entities = body.current_entities ?? null;
      screens = body.current_screens ?? [];
      validationRules = body.current_validation_rules ?? null;
    } else {
      entities = project.entities ? JSON.parse(project.entities) : null;
      screens = getScreens(project);
      validationRules = project.validationRules;
    }

    const usageSink: UsageEntry[] = [];
    let result: any;
    try {
      result = await interpretRequirement(body.requirement, entities, screens, validationRules, usageSink);
    } catch (e) {
      throw new HttpError(500, `Requirement interpretation failed: ${e instanceof Error ? e.message : e}`);
    }

    await logPrompt(req.user.id, project.id, "workbench_interpret", body.requirement, JSON.stringify(result), usageSink);
    return reply.send(result);
  });

  app.post("/projects/:id/generate-validation", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = GenerateValidationRequestSchema.parse(req.body);
    const entities = project.entities ? JSON.parse(project.entities) : null;
    const existingCode = project.validationCode || "";
    let code: string;
    try {
      code = await editValidationCode(body.rules, existingCode, entities, project.language || "Python");
    } catch (e) {
      throw new HttpError(500, `Validation generation failed: ${e instanceof Error ? e.message : e}`);
    }
    const [updated] = await db
      .update(projects)
      .set({ validationRules: `${project.validationRules || ""}\n${body.rules}`, validationCode: code })
      .where(eq(projects.id, project.id))
      .returning();
    return reply.send(serializeProject(updated));
  });

  app.post("/projects/:id/finalize", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const [updated] = await db.update(projects).set({ status: "finalized" }).where(eq(projects.id, project.id)).returning();
    return reply.send(serializeProject(updated));
  });

  app.post("/projects/:id/unlock", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const [updated] = await db.update(projects).set({ status: "draft" }).where(eq(projects.id, project.id)).returning();
    return reply.send(serializeProject(updated));
  });

  app.post("/projects/:id/screens/detect-intents", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    await getOwnedProject(Number(req.params.id), req.user.id);
    const body = GenerateUIXmlRequestSchema.parse(req.body);
    let result: any;
    try {
      result = await detectScreenIntents(body.description);
    } catch (e) {
      throw new HttpError(500, `Screen intent detection failed: ${e instanceof Error ? e.message : e}`);
    }
    return reply.send(result);
  });
}
