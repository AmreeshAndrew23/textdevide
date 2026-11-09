import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeApplications, runtimeAppInvites } from "../db/schema.js";
import { HttpError } from "../services/authService.js";
import { sendEmail } from "../services/emailService.js";
import { requireAuth } from "./authGuard.js";
import { getOwnedApplication, buildApplicationXml } from "./runtimeApplications.js";
import { PublishSchema, PublishingSettingsSchema, InviteSchema, MemberRoleSchema } from "../models/schemas.js";
import { withTx } from "../runtime/neo4jStore.js";
import { getApplication, guard } from "../runtimeEngine/applicationStore.js";
import { deleteEntityRow, getEntityRow, listEntityRows, saveEntityRow, ValidationError } from "../runtimeEngine/entityStore.js";
import { buildAppModel, isValidSlug, slugify, type AppModel } from "../runtimeEngine/publicAccess.js";
import { ensureRoleRows, inviteToken, isInviteExpired, roleSetupOf } from "../runtimeEngine/publishing.js";

// The Studio's Publish panel — owner only. Publishing stores a snapshot of the app's definition,
// so later Studio edits don't reach real users until the owner publishes again. Records are shared
// between the Studio and the live app; only the definition is versioned this way.

type Params = { Params: { id: string } };

async function loadDraft(id: number) {
  const detail = await getApplication(id);
  if (!detail) throw new HttpError(404, "Application not found");
  let model: AppModel;
  try {
    model = buildAppModel(detail.elements);
  } catch (e) {
    throw new HttpError(400, `This app's definition has a problem: ${e instanceof Error ? e.message : e}`);
  }
  return { detail, model };
}

function identifierFieldOf(model: AppModel): "email" | "username" {
  return model.accountEntity?.fields.some((f) => f.name === "email") ? "email" : "username";
}

async function uniqueSlug(base: string, ownId: number): Promise<string> {
  for (let n = 1; n < 200; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [taken] = await db.select({ id: runtimeApplications.id }).from(runtimeApplications)
      .where(and(eq(runtimeApplications.slug, candidate), ne(runtimeApplications.id, ownId))).limit(1);
    if (!taken) return candidate;
  }
  throw new HttpError(409, "Couldn't find a free link name — choose one yourself.");
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export default async function publishingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/runtime-applications/:id/publishing", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const { detail, model } = await loadDraft(owned.id);
    const invites = await db.select().from(runtimeAppInvites).where(eq(runtimeAppInvites.applicationId, owned.id));
    const setup = roleSetupOf(model);
    const account = model.accountEntity;
    const { roles, members } = await guard(() =>
      withTx(async (tx) => {
        const roleRows = setup ? await listEntityRows(tx, owned.id, setup.roleEntity) : [];
        const nameById = new Map(roleRows.map((r) => [String(r[setup!.keyField]), String(r.name)]));
        const keyField = account?.fields.find((f) => f.key)?.name ?? "id";
        const idField = identifierFieldOf(model);
        const rows = account ? await listEntityRows(tx, owned.id, account) : [];
        return {
          roles: [...new Set([...(setup?.roleNames ?? []), ...roleRows.map((r) => String(r.name))])],
          members: rows.map((r) => ({
            key: String(r[keyField]),
            identity: String(r[idField] ?? ""),
            name: [r.firstName, r.lastName].filter(Boolean).join(" "),
            role: r.roleId ? nameById.get(String(r.roleId)) ?? null : null,
            verified: idField === "email" ? r.emailVerified === true : true,
          })),
        };
      })
    );
    const joined = new Set(members.map((m) => m.identity.toLowerCase()));
    return reply.send({
      slug: owned.slug,
      published: !!owned.publishedAt,
      publishedAt: owned.publishedAt,
      signupMode: owned.signupMode || "invite",
      hasUnpublishedChanges: !!owned.publishedXml && owned.publishedXml !== buildApplicationXml(detail),
      hasAccounts: !!account,
      hasLogin: model.screens.some((s) => s.name === "Login"),
      usesRoles: !!setup && setup.roleNames.length > 0,
      supportsInvites: identifierFieldOf(model) === "email",
      suggestedSlug: owned.slug || (await uniqueSlug(slugify(detail.name), owned.id)),
      roles,
      members,
      invites: invites.map((i) => ({
        id: i.id, email: i.email, role: i.role,
        joined: !!i.acceptedAt || joined.has(i.email.toLowerCase()),
        expired: isInviteExpired(i.createdAt),
        token: inviteToken(i),
      })),
    });
  });

  app.post("/runtime-applications/:id/publish", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = PublishSchema.parse(req.body ?? {});
    const { detail, model } = await loadDraft(owned.id);
    // Without accounts nothing could tell one visitor from another, and everyone with the link
    // would have full access to the data.
    if (!model.accountEntity) throw new HttpError(400, "This app has no user sign-in, so it can't be published safely. Use the AI builder to add \"users sign up and log in\" first.");
    if (!model.screens.some((s) => s.name === "Login")) throw new HttpError(400, "This app has no Login screen. Use the AI builder to add one first.");

    const slug = body.slug ?? owned.slug ?? (await uniqueSlug(slugify(detail.name), owned.id));
    if (!isValidSlug(slug)) throw new HttpError(400, "A link name can only use lowercase letters, numbers and hyphens.");

    const setup = roleSetupOf(model);
    if (setup) await guard(() => withTx((tx) => ensureRoleRows(tx, owned.id, setup, model.relationships, req.user.email)));
    try {
      const [row] = await db.update(runtimeApplications).set({
        slug,
        publishedXml: buildApplicationXml(detail),
        publishedAt: new Date(),
        signupMode: body.signupMode ?? owned.signupMode ?? "invite",
      }).where(eq(runtimeApplications.id, owned.id)).returning();
      return reply.send({ slug: row.slug, publishedAt: row.publishedAt, signupMode: row.signupMode });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "That link name is already taken — try another.");
      throw e;
    }
  });

  app.post("/runtime-applications/:id/unpublish", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    await db.update(runtimeApplications).set({ publishedAt: null }).where(eq(runtimeApplications.id, owned.id));
    return reply.status(204).send();
  });

  app.put("/runtime-applications/:id/publishing", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = PublishingSettingsSchema.parse(req.body);
    await db.update(runtimeApplications).set({ signupMode: body.signupMode }).where(eq(runtimeApplications.id, owned.id));
    return reply.status(204).send();
  });

  app.post("/runtime-applications/:id/invites", async (req: FastifyRequest<Params>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = InviteSchema.parse(req.body);
    const email = body.email.toLowerCase();
    await db.delete(runtimeAppInvites).where(and(eq(runtimeAppInvites.applicationId, owned.id), eq(runtimeAppInvites.email, email)));
    const [invite] = await db.insert(runtimeAppInvites).values({ applicationId: owned.id, email, role: body.role ?? null }).returning();
    const origin = req.headers.origin;
    if (owned.publishedAt && owned.slug && origin && /^https?:\/\/[^/]+$/.test(origin)) {
      void sendEmail(email, `You're invited to ${owned.name}`, `You've been invited to ${owned.name}. Create your account here: ${origin}/a/${owned.slug}?invite=${inviteToken(invite)}`);
    }
    return reply.status(201).send({ id: invite.id, email: invite.email, role: invite.role, joined: false, expired: false, token: inviteToken(invite) });
  });

  app.delete("/runtime-applications/:id/invites/:inviteId", async (req: FastifyRequest<{ Params: { id: string; inviteId: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    await db.delete(runtimeAppInvites).where(and(eq(runtimeAppInvites.id, Number(req.params.inviteId)), eq(runtimeAppInvites.applicationId, owned.id)));
    return reply.status(204).send();
  });

  app.put("/runtime-applications/:id/members/:key/role", async (req: FastifyRequest<{ Params: { id: string; key: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const body = MemberRoleSchema.parse(req.body);
    const { model } = await loadDraft(owned.id);
    const setup = roleSetupOf(model);
    if (!setup || !model.accountEntity) throw new HttpError(400, "This app doesn't use roles.");
    const account = model.accountEntity;
    await guard(() =>
      withTx(async (tx) => {
        const row = await getEntityRow(tx, owned.id, account, req.params.key);
        if (!row) throw new HttpError(404, "Member not found");
        let roleId: string | null = null;
        if (body.role) {
          const ids = await ensureRoleRows(tx, owned.id, setup, model.relationships, req.user.email);
          roleId = ids.get(body.role) ?? null;
          if (!roleId) throw new HttpError(400, "That role doesn't exist.");
        }
        try {
          await saveEntityRow(tx, owned.id, account, model.relationships, [], null, { ...row, roleId }, { identity: req.user.email });
        } catch (e) {
          if (e instanceof ValidationError) throw new HttpError(400, e.message);
          throw e;
        }
      })
    );
    return reply.status(204).send();
  });

  app.delete("/runtime-applications/:id/members/:key", async (req: FastifyRequest<{ Params: { id: string; key: string } }>, reply) => {
    const owned = await getOwnedApplication(Number(req.params.id), req.user.id);
    const { model } = await loadDraft(owned.id);
    if (!model.accountEntity) throw new HttpError(400, "This app has no user accounts.");
    const account = model.accountEntity;
    await guard(() =>
      withTx(async (tx) => {
        try {
          await deleteEntityRow(tx, owned.id, account, model.relationships, req.params.key, { identity: req.user.email });
        } catch (e) {
          if (e instanceof ValidationError) throw new HttpError(400, e.message);
          throw e;
        }
      })
    );
    return reply.status(204).send();
  });
}
