/**
 * Publishing support shared by the Studio preview and public links: making an app's roles real
 * (rows the User.roleId field can point at) and deciding who may create an account and with which
 * role — the first account gets the app's top role, an invited one gets the role it was invited
 * with. Without this, an app with role-restricted screens was unusable: nobody could ever hold a
 * role, because assigning one required already having one.
 */
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { Transaction } from "neo4j-driver";
import type { EntityDef, RelationshipDef, ScreenDef } from "./applicationModel.js";
import type { ActionRunContext, SignupPolicy } from "./applicationEngine.js";
import { listEntityRows, saveEntityRow, ValidationError } from "./entityStore.js";
import { roleNamesFromScreens, topRole, type AppModel } from "./publicAccess.js";
import { SECRET_KEY } from "../config.js";

export type RoleSetup = { roleEntity: EntityDef; keyField: string; roleNames: string[]; topRole: string | null };
export type SignupMode = "invite" | "open";
export type InviteRow = { email: string; role: string | null };

// A personal invite link's token: the invite's id plus a signature over who it was issued to.
// Nothing secret is stored, the same link can be copied again from the Studio, and deleting or
// re-issuing the invite (a new id) kills the old link.
const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
type TokenFields = { id: number; applicationId: number; email: string };

function inviteSignature(i: TokenFields): string {
  return createHmac("sha256", SECRET_KEY).update(`rt-invite:${i.id}:${i.applicationId}:${i.email.toLowerCase()}`).digest("base64url");
}
export function inviteToken(i: TokenFields): string {
  return `${i.id}.${inviteSignature(i)}`;
}
export function inviteIdFromToken(token: string): number | null {
  const id = Number(token.split(".")[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
export function isInviteTokenValid(token: string, i: TokenFields): boolean {
  const given = Buffer.from(token);
  const expected = Buffer.from(inviteToken(i));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export function isInviteExpired(createdAt: Date | null, now = Date.now()): boolean {
  return !createdAt || now - createdAt.getTime() > INVITE_LIFETIME_MS;
}

// Who a Notify step reaches: an email, a field holding one, or everyone with a named role.
export async function recipientsOf(
  tx: Transaction, applicationId: number, model: AppModel, n: { to: string; values: Record<string, unknown> }
): Promise<string[]> {
  const isEmail = (v: unknown): boolean => typeof v === "string" && /^[^\s@]+@[^\s@]+$/.test(v.trim());
  const to = n.to.trim();
  if (isEmail(to)) return [to.toLowerCase()];
  if (isEmail(n.values[to])) return [(n.values[to] as string).trim().toLowerCase()];
  const setup = roleSetupOf(model);
  const account = model.accountEntity;
  if (!setup || !account) return [];
  const role = (await listEntityRows(tx, applicationId, setup.roleEntity)).find((r) => String(r.name).toLowerCase() === to.toLowerCase());
  if (!role) return [];
  const idField = account.fields.some((f) => f.name === "email") ? "email" : "username";
  return (await listEntityRows(tx, applicationId, account))
    .filter((a) => String(a.roleId) === String(role[setup.keyField]))
    .map((a) => String(a[idField]).toLowerCase());
}

// null unless the app actually uses the convention: User.roleId → a role entity with a "name".
export function roleSetupOf(model: AppModel): RoleSetup | null {
  const account = model.accountEntity;
  if (!account || !account.fields.some((f) => f.name === "roleId")) return null;
  const rel: RelationshipDef | undefined = model.relationships.find((r) => r.fromEntity === account.name && r.fromField === "roleId");
  const roleEntity = rel && model.entities.find((e) => e.name === rel.toEntity);
  const keyField = roleEntity?.fields.find((f) => f.key)?.name;
  if (!roleEntity || !keyField || !roleEntity.fields.some((f) => f.name === "name")) return null;
  const screens: ScreenDef[] = model.screens;
  return { roleEntity, keyField, roleNames: roleNamesFromScreens(screens), topRole: topRole(screens) };
}

// Creates any role the app's screens mention but that has no row yet; returns name → key for all.
export async function ensureRoleRows(
  tx: Transaction, applicationId: number, setup: RoleSetup, relationships: RelationshipDef[], identity: string | null
): Promise<Map<string, string>> {
  const rows = await listEntityRows(tx, applicationId, setup.roleEntity);
  const ids = new Map(rows.map((r) => [String(r.name), String(r[setup.keyField])]));
  for (const name of setup.roleNames) {
    if (ids.has(name)) continue;
    const id = randomUUID();
    try {
      await saveEntityRow(tx, applicationId, setup.roleEntity, relationships, [], null, { [setup.keyField]: id, name }, { identity });
      ids.set(name, id);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e; // a role entity with extra required fields: left for the owner to create
    }
  }
  return ids;
}

export function makeSignupPolicy(
  model: AppModel, opts: { mode: SignupMode; invites: InviteRow[]; promoteOnLogin?: boolean; verifiedEmail?: string | null }
): SignupPolicy {
  const setup = roleSetupOf(model);
  return {
    promoteOnLogin: opts.promoteOnLogin ?? false,
    async decide(ctx: ActionRunContext, identifier: string) {
      const invite = opts.invites.find((i) => i.email.toLowerCase() === identifier.toLowerCase());
      const verified = opts.verifiedEmail?.toLowerCase() === identifier.toLowerCase() ? true : undefined;
      if (opts.mode === "invite" && !invite) {
        return { allowed: false, message: "This app is invite only. Ask its owner for an invitation." };
      }
      if (!setup) return { allowed: true, verified };
      const accounts = await listEntityRows(ctx.tx, ctx.applicationId, ctx.entity);
      const roleName = invite?.role ?? (accounts.some((a) => a.roleId) ? null : setup.topRole);
      if (!roleName) return { allowed: true, verified };
      const ids = await ensureRoleRows(ctx.tx, ctx.applicationId, setup, ctx.relationships, identifier);
      return { allowed: true, roleId: ids.get(roleName) ?? null, verified };
    },
  };
}
