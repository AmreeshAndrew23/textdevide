/**
 * Row-level access for published apps: <Entity scopeBy="..." scopeExempt="Admin,Receptionist">
 * limits which records a signed-in user can see or change. scopeBy is one of:
 *   "creator"    records this user created;
 *   a link field records whose link points at this user — either the account itself, or a row in
 *                the linked entity whose email matches their sign-in (Appointment.doctorId → the
 *                Doctor with this email);
 *   any other    records where that field holds this user's identity (an email column).
 * Fails closed: a rule that can't be resolved matches nothing. Not applied in the Studio preview,
 * which is the owner looking at all of their own data.
 */
import type { Transaction } from "neo4j-driver";
import type { EntityDef } from "./applicationModel.js";
import { entityLabelFor } from "./labels.js";
import { getEntityRowByField, listEntityRows } from "./entityStore.js";
import { safeIdent, fromDriverValue } from "../runtime/values.js";
import type { AppModel } from "./publicAccess.js";

export type ResolvedScope = {
  field: string; // the row field compared against allowed
  allowed: Set<string>; // lower-cased
  fill: unknown; // value to stamp on a new record when there's exactly one owner
  creator: boolean; // new records are always allowed: they become the creator's own
};
type Viewer = { identity: string; role: string | null };

const norm = (v: unknown) => String(v ?? "").toLowerCase();

export function isScoped(entity: EntityDef, role: string | null): boolean {
  if (!entity.scopeBy || entity.isAccount) return false;
  return !(role && entity.scopeExempt?.includes(role));
}

export function matchesScope(row: Record<string, unknown>, scope: ResolvedScope): boolean {
  return scope.allowed.has(norm(row[scope.field]));
}

function keyOf(entity: EntityDef): string {
  return entity.fields.find((f) => f.key)?.name ?? "id";
}

function emailFieldOf(entity: EntityDef): string | null {
  return entity.fields.find((f) => f.name === "email")?.name ?? entity.fields.find((f) => /email/i.test(f.name))?.name ?? null;
}

function scopeFrom(field: string, values: unknown[], creator = false): ResolvedScope {
  return { field, allowed: new Set(values.filter((v) => v !== null && v !== undefined).map(norm)), fill: values.length === 1 ? values[0] : undefined, creator };
}

export async function resolveScope(
  tx: Transaction, applicationId: number, model: AppModel, entity: EntityDef, viewer: Viewer
): Promise<ResolvedScope> {
  const by = entity.scopeBy!;
  const deny = scopeFrom(keyOf(entity), []);
  if (by === "creator") {
    const key = keyOf(entity);
    const res = await tx.run(
      `MATCH (n:${entityLabelFor(applicationId, entity.name)})-[:CREATED_BY]->(:RtUser {email: $email}) RETURN n.${safeIdent(key)} AS k`,
      { email: viewer.identity }
    );
    return scopeFrom(key, res.records.map((r) => fromDriverValue(r.get("k"))), true);
  }
  if (!entity.fields.some((f) => f.name === by)) return deny;
  const link = model.relationships.find((r) => r.fromEntity === entity.name && r.fromField === by);
  if (!link) return scopeFrom(by, [viewer.identity]);
  const target = model.entities.find((e) => e.name === link.toEntity);
  if (!target) return deny;
  if (target.isAccount) {
    const idField = target.fields.some((f) => f.name === "email") ? "email" : "username";
    const account = await getEntityRowByField(tx, applicationId, target, idField, viewer.identity);
    return account ? scopeFrom(by, [account[link.toField]]) : deny;
  }
  const emailField = emailFieldOf(target);
  if (!emailField) return deny;
  const owners = (await listEntityRows(tx, applicationId, target)).filter((r) => norm(r[emailField]) === norm(viewer.identity));
  return scopeFrom(by, owners.map((r) => r[link.toField]));
}

// The value of a rule that can't work as configured, for the Studio's Publish panel.
export function scopeProblems(model: AppModel): string[] {
  const problems: string[] = [];
  for (const e of model.entities) {
    if (!e.scopeBy || e.scopeBy === "creator") continue;
    if (!e.fields.some((f) => f.name === e.scopeBy)) {
      problems.push(`${e.name} is limited by "${e.scopeBy}", which isn't one of its fields, so nobody will see its records.`);
      continue;
    }
    const link = model.relationships.find((r) => r.fromEntity === e.name && r.fromField === e.scopeBy);
    const target = link && model.entities.find((t) => t.name === link.toEntity);
    if (target && !target.isAccount && !emailFieldOf(target)) {
      problems.push(`${e.name} is limited through ${target.name}, which has no email field to match against sign-ins, so nobody will see its records.`);
    }
  }
  return problems;
}
