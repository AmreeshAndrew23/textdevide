import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeAppVersions } from "../db/schema.js";
import { HttpError } from "../services/authService.js";
import { requireAuth } from "./authGuard.js";
import { buildApplicationXml, getOwnedApplication } from "./runtimeApplications.js";
import { getApplication, saveApplicationNodes } from "../runtimeEngine/applicationStore.js";
import { parseApplicationXml } from "../runtimeEngine/applicationModel.js";
import { diffElements, recordVersion } from "../runtimeEngine/versionStore.js";

// Owner-only history of an app's definition: list earlier versions and restore one. Restoring is
// itself undoable (the current definition is saved first), leaves every record alone, and doesn't
// affect a published app until the owner publishes again.

export default async function versionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/runtime-applications/:id/versions", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const detail = await getApplication(owned.id);
    if (!detail) throw new HttpError(404, "Application not found");
    const versions = await db.select().from(runtimeAppVersions)
      .where(eq(runtimeAppVersions.applicationId, owned.id)).orderBy(desc(runtimeAppVersions.id));
    return reply.send({
      versions: versions.map((v) => {
        let diff = null;
        try {
          diff = diffElements(detail.elements, parseApplicationXml(v.xml).elements);
        } catch {
          // An unreadable old snapshot still lists; it just can't say what would change.
        }
        return { id: v.id, label: v.label, createdAt: v.createdAt, createdBy: v.createdBy, diff };
      }),
    });
  });

  app.post(
    "/runtime-applications/:id/versions/:versionId/restore",
    async (req: FastifyRequest<{ Params: { id: string; versionId: string } }>, reply) => {
      const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
      const [version] = await db.select().from(runtimeAppVersions)
        .where(and(eq(runtimeAppVersions.id, Number(req.params.versionId)), eq(runtimeAppVersions.applicationId, owned.id))).limit(1);
      if (!version) throw new HttpError(404, "That version no longer exists.");
      const detail = await getApplication(owned.id);
      if (!detail) throw new HttpError(404, "Application not found");
      await recordVersion(owned.id, buildApplicationXml(detail), "Before restoring an earlier version", req.user.email);
      await saveApplicationNodes(owned.id, version.xml, req.user.email);
      const restored = await getApplication(owned.id);
      return reply.send({ id: owned.id, ...restored });
    }
  );
}
