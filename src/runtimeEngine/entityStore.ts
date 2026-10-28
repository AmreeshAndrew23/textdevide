/**
 * Entity data-row CRUD: the ONE place the validate -> concurrency-check -> write -> audit-stamp
 * pipeline lives (shared by the Save step and the built-in save button — see applicationEngine.ts).
 * Reuses runtime/values.ts's coerceValue/toDriverValue/fromDriverValue/safeIdent for type-correct
 * Neo4j properties; does NOT reuse neo4jStore.ts's replaceAllRows/old-engine executors, since those
 * are shaped around the old engine's {tables:[...]} Column shape, not EntityDef's richer FieldDef.
 *
 * Every field/column name interpolated into a Cypher string here is a FieldDef.name/attribute
 * parsed straight out of the Application XML — i.e. attacker-controllable if someone crafts a
 * malicious Application. Every single one is run through safeIdent() before interpolation; this is
 * not optional defense-in-depth, it's the only thing standing between this module and a Cypher
 * injection via a field named e.g. `x}) DETACH DELETE (n`.
 */
import type { Transaction } from "neo4j-driver";
import { coerceValue, toDriverValue, fromDriverValue, safeIdent } from "../runtime/values.js";
import { entityLabelFor } from "./labels.js";
import { runValidations, type ValidationResult } from "./validationEngine.js";
import type { EntityDef, FieldDef, RelationshipDef, ValidationDef, AuditingDef } from "./applicationModel.js";
import type { ExpressionContext } from "./expressions.js";

export class ValidationError extends Error {}
export class ConcurrencyError extends Error {}

function sqlTypeOf(field: FieldDef): string {
  switch (field.type) {
    case "integer": return "INT";
    case "decimal": return "DECIMAL";
    case "date": return "DATE";
    case "boolean": return "BOOLEAN";
    default: return "TEXT"; // string, enum
  }
}

function keyFieldOf(entity: EntityDef): FieldDef {
  const key = entity.fields.find((f) => f.key);
  if (!key) throw new Error(`Entity "${entity.name}" has no key field`);
  return key;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

// "lineItems" <-> "LineItem" — same best-effort convention validationEngine.ts uses (including the
// consonant+y -> -ies fix: "Policy" -> "policies", never the naive "policys"), kept in sync
// deliberately rather than imported, since the two are independent small pure helpers.
function pluralizeCamel(entityName: string): string {
  const camel = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  if (/[^aeiou]y$/i.test(camel)) return camel.slice(0, -1) + "ies";
  return camel.endsWith("s") ? camel : `${camel}s`;
}

// Pre-fetches every related entity's rows, in BOTH directions, keyed by the same pluralized alias
// convention via="..." uses:
//  - children pointing AT this entity (the "many" side, e.g. a PurchaseOrder's LineItems) — found
//    by this entity's OWN key value, used for sum/avg/count/min/max(alias.field) over the set.
//  - the single PARENT this entity points TO (the "one" side, e.g. a Claim's Policy) — found by
//    the FK value already in `data` (not yet saved), used for a bare alias.field reference. Still
//    stored as a one-element array under the same alias shape, so a bare alias.field (which reads
//    the array's first row) and an aggregate function (which would just as correctly sum a single
//    value) both resolve the same way without the expression evaluator needing to know which
//    direction the relationship came from.
async function fetchRelatedRows(
  tx: Transaction, applicationId: string | number, entity: EntityDef, relationships: RelationshipDef[],
  keyValue: unknown, data: Record<string, unknown>
): Promise<Record<string, Record<string, unknown>[]>> {
  const related: Record<string, Record<string, unknown>[]> = {};
  for (const rel of relationships) {
    if (rel.toEntity === entity.name) {
      const alias = pluralizeCamel(rel.fromEntity);
      const childLabel = entityLabelFor(applicationId, rel.fromEntity);
      const fkField = safeIdent(rel.fromField);
      const res = await tx.run(
        `MATCH (c:${childLabel}) WHERE c.${fkField} = $key AND c.__deletedAt IS NULL RETURN c`,
        { key: toDriverValue(keyValue) }
      );
      related[alias] = res.records.map((r) => fromDriverValue(r.get("c")) as Record<string, unknown>);
    } else if (rel.fromEntity === entity.name) {
      const fkValue = data[rel.fromField];
      if (isBlank(fkValue)) continue; // nothing to look up yet (e.g. this field wasn't submitted)
      const alias = pluralizeCamel(rel.toEntity);
      const parentLabel = entityLabelFor(applicationId, rel.toEntity);
      const parentKeyField = safeIdent(rel.toField);
      const res = await tx.run(
        `MATCH (p:${parentLabel}) WHERE p.${parentKeyField} = $key AND p.__deletedAt IS NULL RETURN p`,
        { key: toDriverValue(fkValue) }
      );
      related[alias] = res.records.map((r) => fromDriverValue(r.get("p")) as Record<string, unknown>);
    }
  }
  return related;
}

export interface RowReadOptions {
  /** Include soft-deleted rows — only ever set by the "Show deleted"/restore paths. */
  includeDeleted?: boolean;
}

export async function listEntityRows(
  tx: Transaction, applicationId: string | number, entity: EntityDef, opts: RowReadOptions = {}
): Promise<Record<string, unknown>[]> {
  const label = entityLabelFor(applicationId, entity.name);
  const where = opts.includeDeleted ? "" : " WHERE n.__deletedAt IS NULL";
  const res = await tx.run(`MATCH (n:${label})${where} RETURN n`);
  return res.records.map((r) => fromDriverValue(r.get("n")) as Record<string, unknown>);
}

export async function getEntityRow(
  tx: Transaction, applicationId: string | number, entity: EntityDef, keyValue: unknown, opts: RowReadOptions = {}
): Promise<Record<string, unknown> | null> {
  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);
  const deletedClause = opts.includeDeleted ? "" : " AND n.__deletedAt IS NULL";
  const res = await tx.run(
    `MATCH (n:${label}) WHERE n.${keyField} = $key${deletedClause} RETURN n`,
    { key: toDriverValue(keyValue) }
  );
  return res.records[0] ? (fromDriverValue(res.records[0].get("n")) as Record<string, unknown>) : null;
}

// Same lookup as getEntityRow, but keyed on an arbitrary field instead of the entity's own key —
// used by the login built-in to find a User row by its "username" field (see applicationEngine.ts
// and appAuth.ts), since a login submits a username, never the row's internal id. A soft-deleted
// account can never log in — same as any other soft-deleted row being treated as gone.
export async function getEntityRowByField(
  tx: Transaction, applicationId: string | number, entity: EntityDef, fieldName: string, value: unknown,
  opts: RowReadOptions = {}
): Promise<Record<string, unknown> | null> {
  const label = entityLabelFor(applicationId, entity.name);
  const field = safeIdent(fieldName);
  const deletedClause = opts.includeDeleted ? "" : " AND n.__deletedAt IS NULL";
  const res = await tx.run(
    `MATCH (n:${label}) WHERE n.${field} = $value${deletedClause} RETURN n`,
    { value: toDriverValue(value) }
  );
  return res.records[0] ? (fromDriverValue(res.records[0].get("n")) as Record<string, unknown>) : null;
}

export async function saveEntityRow(
  tx: Transaction, applicationId: string | number, entity: EntityDef, relationships: RelationshipDef[],
  validations: ValidationDef[], auditing: AuditingDef | null, data: Record<string, unknown>,
  session: { identity: string | null }
): Promise<{ row: Record<string, unknown>; created: boolean; validationResults: ValidationResult[] }> {
  const keyField = keyFieldOf(entity);
  const keyValue = data[keyField.name];
  if (isBlank(keyValue)) throw new ValidationError(`Missing key value for ${entity.name}.${keyField.name}`);

  // 1. required-field check
  for (const f of entity.fields) {
    if (f.required && isBlank(data[f.name])) throw new ValidationError(`${entity.name}.${f.name} is required`);
  }

  const existing = await getEntityRow(tx, applicationId, entity, keyValue);

  // 2. stale-edit check — every row carries a system-managed __version (never an AI-declared Field,
  // never gated behind an Auditing opt-in attribute, so this applies to every entity in every app
  // automatically). The frontend round-trips __version for free: openRowForEdit seeds the edit
  // form with the ENTIRE loaded row (listEntityRows/getEntityRow return raw, unfiltered node
  // properties), and a save posts that object back verbatim — so __version naturally carries the
  // value the editor actually saw, with zero new frontend plumbing. Skipped gracefully when either
  // side has no version yet (a row saved before this feature existed, or a non-UI caller) — a
  // one-time grace period, not a bug; every row gets a real version after its first save here on.
  if (existing && data.__version !== undefined && Number(data.__version) !== Number(existing.__version ?? 1)) {
    throw new ConcurrencyError(`${entity.name} was modified by someone else since you loaded it — reload and try again`);
  }

  // 3. validations — this entity's OWN declared Validations (cross-entity re-validation when a
  // CHILD row changes, e.g. re-checking PurchaseOrder.total-matches-lines after saving a LineItem,
  // is not yet wired up here — Phase 2; see validationEngine.ts's affectedValidations for the piece
  // that would drive it).
  const relatedRows = await fetchRelatedRows(tx, applicationId, entity, relationships, keyValue, data);
  const ctx: ExpressionContext = { fields: data, related: relatedRows, session: { identity: session.identity } };
  const ownValidations = validations.filter((v) => v.entity === entity.name);
  const validationResults = runValidations(ownValidations, ctx);
  const rejected = validationResults.find((r) => !r.passed && r.onViolation === "reject");
  if (rejected) throw new ValidationError(rejected.message);

  // 4. write
  const props: Record<string, unknown> = {};
  for (const f of entity.fields) {
    if (data[f.name] === undefined) continue;
    props[safeIdent(f.name)] = toDriverValue(coerceValue(data[f.name], sqlTypeOf(f)));
  }

  // 5. audit stamp — via the Auditing element's own role->name mapping, so a renamed audit column
  // still stamps correctly.
  const now = new Date().toISOString();
  if (auditing) {
    for (const af of auditing.fields) {
      const col = safeIdent(af.name);
      if (af.role === "createdBy" && !existing) props[col] = session.identity;
      else if (af.role === "createdOn" && !existing) props[col] = now;
      else if (af.role === "updatedBy") props[col] = session.identity;
      else if (af.role === "updatedOn") props[col] = now;
    }
  }

  const label = entityLabelFor(applicationId, entity.name);
  const keyProp = safeIdent(keyField.name);
  const keyDriverValue = toDriverValue(coerceValue(keyValue, sqlTypeOf(keyField)));
  props[keyProp] = keyDriverValue;

  if (existing) {
    // Tight-race CAS (defense in depth, on top of the stale-edit check above): the write itself is
    // conditioned on __version still being exactly what we just read a moment ago in THIS
    // transaction. Zero rows matched despite `existing` having just been found means another save
    // landed in the gap between our read and this write — also a real conflict.
    const readVersion = existing.__version != null ? Number(existing.__version) : null;
    props.__version = toDriverValue((readVersion ?? 0) + 1);
    const res = await tx.run(
      `MATCH (n:${label} {${keyProp}: $key}) WHERE n.__deletedAt IS NULL AND (n.__version = $readVersion OR n.__version IS NULL) SET n += $props RETURN n`,
      { key: keyDriverValue, readVersion: readVersion === null ? null : toDriverValue(readVersion), props }
    );
    if (res.records.length === 0) {
      throw new ConcurrencyError(`${entity.name} was modified by someone else since you loaded it — reload and try again`);
    }
  } else {
    props.__version = toDriverValue(1);
    await tx.run(`MERGE (n:${label} {${keyProp}: $key}) SET n += $props`, { key: keyDriverValue, props });
  }
  // "everything created by user should be linked to him" — a REAL graph edge, not just a
  // createdBy string property buried on the node. session.identity is whoever actually ran this
  // save (the Studio builder's own email for an application with no real accounts, or the logged-
  // in end user's own username for one that has them — see routes/runtimeApplications.ts).
  if (session.identity) {
    await tx.run(
      `MATCH (n:${label} {${keyProp}: $key}) MERGE (u:RtUser {email: $email}) MERGE (n)-[:CREATED_BY]->(u)`,
      { key: keyDriverValue, email: session.identity }
    );
  }
  const row = (await getEntityRow(tx, applicationId, entity, keyValue))!;
  return { row, created: !existing, validationResults };
}

// Soft delete: a row is never actually removed, just stamped __deletedAt/__deletedBy and excluded
// from every normal read (listEntityRows/getEntityRow/getEntityRowByField/dataSourceCompiler all
// filter it out by default). Recoverable via restoreEntityRow. Known limitation, not silently
// papered over: restoring a cascade-deleted parent does NOT cascade-restore its children — they
// stay deleted and must be restored individually.
export async function deleteEntityRow(
  tx: Transaction, applicationId: string | number, entity: EntityDef, relationships: RelationshipDef[],
  keyValue: unknown, session: { identity: string | null }
): Promise<void> {
  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);

  const existing = await getEntityRow(tx, applicationId, entity, keyValue, { includeDeleted: true });
  if (!existing) throw new ValidationError(`${entity.name} not found`);
  if (existing.__deletedAt) throw new ValidationError(`This ${entity.name} is already deleted`);

  for (const rel of relationships) {
    if (rel.toEntity !== entity.name) continue; // only relationships where other rows point AT this one
    const childLabel = entityLabelFor(applicationId, rel.fromEntity);
    const fkField = safeIdent(rel.fromField);
    const countRes = await tx.run(
      `MATCH (c:${childLabel}) WHERE c.${fkField} = $key AND c.__deletedAt IS NULL RETURN count(c) AS cnt`,
      { key: toDriverValue(keyValue) }
    );
    const count = Number(fromDriverValue(countRes.records[0].get("cnt")));
    if (count === 0) continue;
    if (rel.onDelete === "restrict") {
      throw new ValidationError(`Cannot delete this ${entity.name} — ${count} ${rel.fromEntity} row(s) still reference it`);
    }
    if (rel.onDelete === "cascade") {
      await tx.run(
        `MATCH (c:${childLabel}) WHERE c.${fkField} = $key AND c.__deletedAt IS NULL SET c.__deletedAt = $now, c.__deletedBy = $identity`,
        { key: toDriverValue(keyValue), now: new Date().toISOString(), identity: session.identity }
      );
    }
    // onDelete="setNull": Phase 2 — needs the FK field to be nullable in practice, not just in theory.
  }

  await tx.run(
    `MATCH (n:${label}) WHERE n.${keyField} = $key SET n.__deletedAt = $now, n.__deletedBy = $identity`,
    { key: toDriverValue(keyValue), now: new Date().toISOString(), identity: session.identity }
  );
}

export async function restoreEntityRow(
  tx: Transaction, applicationId: string | number, entity: EntityDef, keyValue: unknown
): Promise<void> {
  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);
  const existing = await getEntityRow(tx, applicationId, entity, keyValue, { includeDeleted: true });
  if (!existing) throw new ValidationError(`${entity.name} not found`);
  if (!existing.__deletedAt) throw new ValidationError(`This ${entity.name} isn't deleted`);
  await tx.run(
    `MATCH (n:${label}) WHERE n.${keyField} = $key SET n.__deletedAt = null, n.__deletedBy = null`,
    { key: toDriverValue(keyValue) }
  );
}

export type OtpPurpose = "verifyEmail" | "resetPassword";

// A one-time code for email verification / forgot-password, stored directly on the row as raw
// system properties — never a declared Field, never AI-authored, same treatment as
// __version/__deletedAt above. `purpose` scopes the code so a verify-email code can't be replayed
// to reset a password (one mechanism, two call sites in applicationEngine.ts).
export async function setEntityOtp(
  tx: Transaction, applicationId: string | number, entity: EntityDef, keyValue: unknown,
  purpose: OtpPurpose, code: string, ttlMinutes: number
): Promise<void> {
  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await tx.run(
    `MATCH (n:${label}) WHERE n.${keyField} = $key SET n.__otpCode = $code, n.__otpExpiresAt = $expiresAt, n.__otpPurpose = $purpose`,
    { key: toDriverValue(keyValue), code, expiresAt, purpose }
  );
}

export type OtpResult = { ok: true } | { ok: false; reason: "none" | "expired" | "mismatch" };

// Checks the submitted code against what's stored for this exact purpose, and — on success —
// clears all three OTP properties in the SAME write, so a code can never be consumed twice.
export async function consumeEntityOtp(
  tx: Transaction, applicationId: string | number, entity: EntityDef, keyValue: unknown,
  purpose: OtpPurpose, submittedCode: string
): Promise<OtpResult> {
  const row = await getEntityRow(tx, applicationId, entity, keyValue);
  if (!row || !row.__otpCode || row.__otpPurpose !== purpose) return { ok: false, reason: "none" };
  if (!row.__otpExpiresAt || new Date(String(row.__otpExpiresAt)).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (String(row.__otpCode) !== submittedCode) return { ok: false, reason: "mismatch" };

  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);
  await tx.run(
    `MATCH (n:${label}) WHERE n.${keyField} = $key SET n.__otpCode = null, n.__otpExpiresAt = null, n.__otpPurpose = null`,
    { key: toDriverValue(keyValue) }
  );
  return { ok: true };
}
