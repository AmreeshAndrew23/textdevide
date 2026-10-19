import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { domainTemplates, userChosenDomains } from "../db/schema.js";
import { serializeDomainTemplateListItem, serializeDomainTemplate, serializeChosenDomain } from "../serializers.js";
import { HttpError } from "../services/authService.js";
import { requireAuth } from "./authGuard.js";

// Domains live OUTSIDE any one project — a shared, admin-curated catalog (domain_templates) a user
// browses from the sidebar BEFORE starting a project, picks one (or several), and only later draws
// from when actually creating a project. "Choosing" a domain copies its current entities into this
// user's own library (user_chosen_domains) — a snapshot, not a live reference, so editing the
// canonical template later never silently changes what someone already picked.
export default async function domainRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

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
