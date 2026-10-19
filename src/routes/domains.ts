import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { domainTemplates, userChosenDomains } from "../db/schema.js";
import { serializeDomainTemplateListItem, serializeDomainTemplate, serializeChosenDomain } from "../serializers.js";
import { DomainCreateSchema, DomainUpdateSchema } from "../models/schemas.js";
import { HttpError } from "../services/authService.js";
import { requireAuth } from "./authGuard.js";
import { extractEntities, type UsageEntry } from "../services/aiService.js";

// req.user is already populated by the file-wide requireAuth hook below — this just adds the
// is_superuser check on top, for the handful of routes that create/edit the shared catalog itself
// (browsing/choosing a domain needs no elevated role, only changing what's IN the catalog does).
async function requireSuperuser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user.isSuperuser) throw new HttpError(403, "Superuser access required");
}

// Validates the same {tables:[{name, columns:[...]}]} shape projectStore.ts's entitiesToNodes
// already enforces for a project's own entities — domain_templates.entities is a plain Postgres
// TEXT column (no Neo4j node-splitting involved, domains are never "run"), so this is a lighter,
// standalone check rather than reusing that Neo4j-specific function.
function assertValidEntitiesJson(json: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new HttpError(400, "entities must be a JSON object with a tables array");
  }
  const tables = (parsed as { tables?: unknown })?.tables;
  if (!Array.isArray(tables)) throw new HttpError(400, "entities must be a JSON object with a tables array");
  for (const t of tables) {
    if (!t || typeof t !== "object" || typeof (t as { name?: unknown }).name !== "string" || !(t as { name: string }).name) {
      throw new HttpError(400, "every table needs a string name");
    }
  }
}

// Domains live OUTSIDE any one project — a shared, admin-curated catalog (domain_templates) a user
// browses from the sidebar BEFORE starting a project, picks one (or several), and only later draws
// from when actually creating a project. "Choosing" a domain copies its current entities into this
// user's own library (user_chosen_domains) — a snapshot, not a live reference, so editing the
// canonical template later never silently changes what someone already picked.
export default async function domainRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // SuperUser-only: creates a catalog entry from a plain-English description, via the exact same
  // extractEntities() a project's own schema generation already calls — no new AI prompt needed.
  app.post("/domains", { preHandler: requireSuperuser }, async (req, reply) => {
    const body = DomainCreateSchema.parse(req.body);
    const usageSink: UsageEntry[] = [];
    let result: any;
    try {
      result = await extractEntities(body.description, "", usageSink);
    } catch (e) {
      throw new HttpError(500, `AI extraction failed: ${e instanceof Error ? e.message : e}`);
    }
    const entities = result && typeof result === "object" ? { tables: result.tables || [] } : result;
    const unresolved = result && typeof result === "object" ? result.unresolved || [] : [];

    const [row] = await db
      .insert(domainTemplates)
      .values({ name: body.name, description: body.description, category: body.category ?? undefined, entities: JSON.stringify(entities) })
      .returning();
    return reply.status(201).send({ ...serializeDomainTemplate(row), unresolved });
  });

  // SuperUser-only: hand-edit a domain's name/description/category, or replace its entities
  // wholesale (e.g. after reviewing the ER diagram and fixing something by hand) — partial update,
  // same semantics as PUT /projects/:id.
  app.put("/domains/:id", { preHandler: requireSuperuser }, async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const domainId = Number(req.params.id);
    const [existing] = await db.select().from(domainTemplates).where(eq(domainTemplates.id, domainId)).limit(1);
    if (!existing) throw new HttpError(404, "Domain not found");
    const body = DomainUpdateSchema.parse(req.body);
    if (body.entities != null) assertValidEntitiesJson(body.entities);

    const update: Record<string, unknown> = {};
    if (body.name != null) update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.category !== undefined) update.category = body.category;
    if (body.entities != null) update.entities = body.entities;
    if (!Object.keys(update).length) return reply.send(serializeDomainTemplate(existing));

    const [row] = await db.update(domainTemplates).set(update).where(eq(domainTemplates.id, domainId)).returning();
    return reply.send(serializeDomainTemplate(row));
  });

  // SuperUser-only. Blocked by the FK on user_chosen_domains if anyone has already chosen this
  // domain (ON DELETE defaults to NO ACTION) — deliberately: deleting it out from under someone's
  // own library would be a worse surprise than just refusing, since their snapshot is still valid
  // and usable on its own either way.
  app.delete("/domains/:id", { preHandler: requireSuperuser }, async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const domainId = Number(req.params.id);
    const [existing] = await db.select().from(domainTemplates).where(eq(domainTemplates.id, domainId)).limit(1);
    if (!existing) throw new HttpError(404, "Domain not found");
    try {
      await db.delete(domainTemplates).where(eq(domainTemplates.id, domainId));
    } catch {
      throw new HttpError(409, "Can't delete — at least one user has already chosen this domain.");
    }
    return reply.status(204).send();
  });

  app.get("/domains", async (_req, reply) => {
    const rows = await db.select().from(domainTemplates).orderBy(domainTemplates.name);
    return reply.send(rows.map(serializeDomainTemplateListItem));
  });

  app.get("/domains/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const [row] = await db.select().from(domainTemplates).where(eq(domainTemplates.id, Number(req.params.id))).limit(1);
    if (!row) throw new HttpError(404, "Domain not found");
    return reply.send(serializeDomainTemplate(row));
  });

  // Idempotent: choosing the same domain again just refreshes this user's snapshot to the
  // template's current entities, rather than piling up duplicate rows in their library.
  app.post("/domains/:id/choose", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const domainId = Number(req.params.id);
    const [domain] = await db.select().from(domainTemplates).where(eq(domainTemplates.id, domainId)).limit(1);
    if (!domain) throw new HttpError(404, "Domain not found");

    const [existing] = await db
      .select()
      .from(userChosenDomains)
      .where(and(eq(userChosenDomains.userId, req.user.id), eq(userChosenDomains.domainTemplateId, domainId)))
      .limit(1);

    const snapshot = { userId: req.user.id, domainTemplateId: domainId, domainName: domain.name, entitiesSnapshot: domain.entities };
    const [row] = existing
      ? await db.update(userChosenDomains).set(snapshot).where(eq(userChosenDomains.id, existing.id)).returning()
      : await db.insert(userChosenDomains).values(snapshot).returning();
    return reply.status(existing ? 200 : 201).send(serializeChosenDomain(row));
  });

  // The "start project" screen's picker — this user's own previously-chosen domains, entities
  // included, so creating a project from one of them is a single request.
  app.get("/domains/chosen", async (req: FastifyRequest, reply) => {
    const rows = await db.select().from(userChosenDomains).where(eq(userChosenDomains.userId, req.user.id)).orderBy(userChosenDomains.chosenAt);
    return reply.send(rows.map(serializeChosenDomain));
  });

  app.delete("/domains/chosen/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const [existing] = await db.select().from(userChosenDomains).where(eq(userChosenDomains.id, Number(req.params.id))).limit(1);
    if (!existing || existing.userId !== req.user.id) throw new HttpError(404, "Not found");
    await db.delete(userChosenDomains).where(eq(userChosenDomains.id, existing.id));
    return reply.status(204).send();
  });
}
