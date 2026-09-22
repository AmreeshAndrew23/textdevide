import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { projects, type ProjectRow } from "../db/schema.js";
import { serializeProject } from "../serializers.js";
import {
  ScreenCreateSchema, ScreenUpdateSchema, GenerateUIXmlRequestSchema, RefineUIRequestSchema,
  BatchGenerateScreensRequestSchema, BatchDeleteScreensRequestSchema,
} from "../models/schemas.js";
import { requireAuth } from "./authGuard.js";
import { generateUiXml, refineUiXml, type UsageEntry } from "../services/aiService.js";
import { logPrompt } from "../services/promptLog.js";
import { HttpError } from "../services/authService.js";
import { requestAbortSignal } from "../utils/requestAbort.js";

type Screen = {
  id: string;
  name: string;
  description: string;
  xml: string;
  html: string;
  api: string;
  primary_entities: string[];
  joined_entities: string[];
  reference_image: string | null;
  ui_chat?: unknown[];
  ui_notes?: unknown[];
};

function getScreens(project: ProjectRow): Screen[] {
  if (!project.uiScreens) return [];
  try {
    return JSON.parse(project.uiScreens);
  } catch {
    return [];
  }
}

async function saveScreens(projectId: number, screens: Screen[]): Promise<ProjectRow> {
  const [updated] = await db.update(projects).set({ uiScreens: JSON.stringify(screens) }).where(eq(projects.id, projectId)).returning();
  return updated;
}

async function getOwnedProject(projectId: number, userId: number): Promise<ProjectRow> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.userId !== userId) throw new HttpError(404, "Project not found");
  return project;
}

export default async function screensRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/projects/:id/screens", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = ScreenCreateSchema.parse(req.body);
    const screens = getScreens(project);
    const primaryEntities = body.primary_entities ?? (body.primary_entity ? [body.primary_entity] : []);
    screens.push({
      id: randomUUID().slice(0, 8),
      name: body.name,
      description: body.description,
      xml: "",
      html: "",
      api: "",
      primary_entities: primaryEntities,
      joined_entities: body.joined_entities ?? [],
      reference_image: body.reference_image ?? null,
    });
    const updated = await saveScreens(project.id, screens);
    return reply.status(201).send(serializeProject(updated));
  });

  app.put("/projects/:id/screens/:screenId", async (req: FastifyRequest<{ Params: { id: string; screenId: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = ScreenUpdateSchema.parse(req.body);
    const screens = getScreens(project);
    const idx = screens.findIndex((s) => s.id === req.params.screenId);
    if (idx === -1) throw new HttpError(404, "Screen not found");
    const screen = screens[idx];
    if (body.name !== undefined && body.name !== null) screen.name = body.name;
    if (body.description !== undefined && body.description !== null) screen.description = body.description;
    if (body.primary_entities !== undefined && body.primary_entities !== null) {
      screen.primary_entities = body.primary_entities;
    } else if (body.primary_entity !== undefined && body.primary_entity !== null) {
      screen.primary_entities = body.primary_entity ? [body.primary_entity] : [];
    }
    if (body.joined_entities !== undefined && body.joined_entities !== null) screen.joined_entities = body.joined_entities;
    if (body.reference_image !== undefined) screen.reference_image = body.reference_image || null;
    screens[idx] = screen;
    const updated = await saveScreens(project.id, screens);
    return reply.send(serializeProject(updated));
  });

  app.delete("/projects/:id/screens/:screenId", async (req: FastifyRequest<{ Params: { id: string; screenId: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const screens = getScreens(project).filter((s) => s.id !== req.params.screenId);
    const updated = await saveScreens(project.id, screens);
    return reply.send(serializeProject(updated));
  });

  // Removes several screens in one call/one project update, instead of the client looping the
  // single-screen DELETE per selected screen.
  app.post("/projects/:id/screens/batch-delete", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = BatchDeleteScreensRequestSchema.parse(req.body);
    const toDelete = new Set(body.screen_ids);
    const screens = getScreens(project).filter((s) => !toDelete.has(s.id));
    const updated = await saveScreens(project.id, screens);
    return reply.send(serializeProject(updated));
  });

  app.post("/projects/:id/screens/:screenId/generate-xml", async (req: FastifyRequest<{ Params: { id: string; screenId: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = GenerateUIXmlRequestSchema.parse(req.body);
    const screens = getScreens(project);
    const idx = screens.findIndex((s) => s.id === req.params.screenId);
    if (idx === -1) throw new HttpError(404, "Screen not found");
    const entities = project.entities ? JSON.parse(project.entities) : null;

    const usageSink: UsageEntry[] = [];
    const signal = requestAbortSignal(req);
    let xml: string;
    try {
      xml = await generateUiXml(body.description, entities, usageSink, signal);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new HttpError(499, "Cancelled");
      throw new HttpError(500, `XML generation failed: ${e instanceof Error ? e.message : e}`);
    }
    await logPrompt(req.user.id, project.id, "screen_generate_xml", body.description, xml, usageSink);

    const screen = screens[idx];
    screen.description = body.description;
    screen.xml = xml;
    screen.html = "";
    screen.api = "";
    screen.ui_chat = [];
    screen.ui_notes = [];
    screens[idx] = screen;
    const updated = await saveScreens(project.id, screens);
    return reply.send(serializeProject(updated));
  });

  // Generates several screens' XML in one call (e.g. every screen detect-intents split a
  // description into) instead of the client looping create+generate-xml per screen. Each screen
  // is created and generated independently and concurrently — one failing (a bad AI response, a
  // transient network error) doesn't lose the others; the caller gets a per-screen result list
  // alongside the updated project so it knows which ones need a manual retry via the existing
  // single-screen generate-xml route.
  app.post("/projects/:id/screens/batch-generate", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = BatchGenerateScreensRequestSchema.parse(req.body);
    const entities = project.entities ? JSON.parse(project.entities) : null;
    const screens = getScreens(project);
    const signal = requestAbortSignal(req);

    const outcomes = await Promise.all(
      body.screens.map(async (s) => {
        const id = randomUUID().slice(0, 8);
        const usageSink: UsageEntry[] = [];
        try {
          const xml = await generateUiXml(s.description, entities, usageSink, signal);
          await logPrompt(req.user.id, project.id, "screen_generate_xml", s.description, xml, usageSink);
          return { screen: { id, name: s.name, description: s.description, xml, html: "", api: "", primary_entities: [], joined_entities: [], reference_image: null } as Screen, ok: true as const };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          return { screen: { id, name: s.name, description: s.description, xml: "", html: "", api: "", primary_entities: [], joined_entities: [], reference_image: null } as Screen, ok: false as const, error };
        }
      })
    );

    screens.push(...outcomes.map((o) => o.screen));
    const updated = await saveScreens(project.id, screens);
    const results = outcomes.map((o) => ({ screen_id: o.screen.id, name: o.screen.name, ok: o.ok, error: o.ok ? null : o.error }));
    return reply.status(201).send({ ...serializeProject(updated), results });
  });

  app.post("/projects/:id/screens/:screenId/refine-ui", async (req: FastifyRequest<{ Params: { id: string; screenId: string } }>, reply) => {
    const project = await getOwnedProject(Number(req.params.id), req.user.id);
    const body = RefineUIRequestSchema.parse(req.body);
    const screens = getScreens(project);
    const idx = screens.findIndex((s) => s.id === req.params.screenId);
    if (idx === -1) throw new HttpError(404, "Screen not found");
    const screen = screens[idx];
    if (!screen.xml) throw new HttpError(400, "Generate the initial screen first");

    const notes = [...(screen.ui_notes || []), body.instruction];
    const usageSink: UsageEntry[] = [];
    let newXml: string;
    let summary: string;
    try {
      const refineResult = await refineUiXml(screen.xml, body.instruction, usageSink);
      newXml = refineResult.xml || screen.xml;
      summary = refineResult.summary || "Applied your change — check the preview.";
    } catch (e) {
      throw new HttpError(500, `UI refinement failed: ${e instanceof Error ? e.message : e}`);
    }
    await logPrompt(req.user.id, project.id, "screen_refine_ui", body.instruction, newXml, usageSink);

    screen.xml = newXml;
    screen.html = "";
    screen.ui_notes = notes;
    screen.api = "";
    const chat = screen.ui_chat || [];
    chat.push({ role: "user", text: body.instruction });
    chat.push({ role: "assistant", text: summary });
    screen.ui_chat = chat;
    screens[idx] = screen;
    const updated = await saveScreens(project.id, screens);
    return reply.send(serializeProject(updated));
  });
}
