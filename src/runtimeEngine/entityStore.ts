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
      const res = await tx.run(`MATCH (c:${childLabel}) WHERE c.${fkField} = $key RETURN c`, { key: toDriverValue(keyValue) });
      related[alias] = res.records.map((r) => fromDriverValue(r.get("c")) as Record<string, unknown>);
    } else if (rel.fromEntity === entity.name) {
      const fkValue = data[rel.fromField];
      if (isBlank(fkValue)) continue; // nothing to look up yet (e.g. this field wasn't submitted)
      const alias = pluralizeCamel(rel.toEntity);
      const parentLabel = entityLabelFor(applicationId, rel.toEntity);
      const parentKeyField = safeIdent(rel.toField);
      const res = await tx.run(`MATCH (p:${parentLabel}) WHERE p.${parentKeyField} = $key RETURN p`, { key: toDriverValue(fkValue) });
      related[alias] = res.records.map((r) => fromDriverValue(r.get("p")) as Record<string, unknown>);
    }
  }
  return related;
}

export async function listEntityRows(tx: Transaction, applicationId: string | number, entity: EntityDef): Promise<Record<string, unknown>[]> {
  const label = entityLabelFor(applicationId, entity.name);
  const res = await tx.run(`MATCH (n:${label}) RETURN n`);
  return res.records.map((r) => fromDriverValue(r.get("n")) as Record<string, unknown>);
}

export async function getEntityRow(
  tx: Transaction, applicationId: string | number, entity: EntityDef, keyValue: unknown
): Promise<Record<string, unknown> | null> {
  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);
  const res = await tx.run(`MATCH (n:${label}) WHERE n.${keyField} = $key RETURN n`, { key: toDriverValue(keyValue) });
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

  // 2. concurrency check — only meaningful on an update, and only when the caller actually
  // submitted the updatedOn it loaded (a create has nothing to compare against).
  if (existing && auditing?.concurrency === "timestamp") {
    const updatedOnField = auditing.fields.find((f) => f.role === "updatedOn")?.name;
    if (updatedOnField && !isBlank(data[updatedOnField]) && String(data[updatedOnField]) !== String(existing[updatedOnField])) {
      throw new ConcurrencyError(`${entity.name} was modified by someone else since you loaded it — reload and try again`);
    }
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
  await tx.run(`MERGE (n:${label} {${keyProp}: $key}) SET n += $props`, { key: keyDriverValue, props });
  const row = (await getEntityRow(tx, applicationId, entity, keyValue))!;
  return { row, created: !existing, validationResults };
}

export async function deleteEntityRow(
  tx: Transaction, applicationId: string | number, entity: EntityDef, relationships: RelationshipDef[], keyValue: unknown
): Promise<void> {
  const label = entityLabelFor(applicationId, entity.name);
  const keyField = safeIdent(keyFieldOf(entity).name);

  for (const rel of relationships) {
    if (rel.toEntity !== entity.name) continue; // only relationships where other rows point AT this one
    const childLabel = entityLabelFor(applicationId, rel.fromEntity);
    const fkField = safeIdent(rel.fromField);
    const countRes = await tx.run(`MATCH (c:${childLabel}) WHERE c.${fkField} = $key RETURN count(c) AS cnt`, { key: toDriverValue(keyValue) });
    const count = Number(fromDriverValue(countRes.records[0].get("cnt")));
    if (count === 0) continue;
    if (rel.onDelete === "restrict") {
      throw new ValidationError(`Cannot delete this ${entity.name} — ${count} ${rel.fromEntity} row(s) still reference it`);
    }
    if (rel.onDelete === "cascade") {
      await tx.run(`MATCH (c:${childLabel}) WHERE c.${fkField} = $key DETACH DELETE c`, { key: toDriverValue(keyValue) });
    }
    // onDelete="setNull": Phase 2 — needs the FK field to be nullable in practice, not just in theory.
  }

  await tx.run(`MATCH (n:${label}) WHERE n.${keyField} = $key DETACH DELETE n`, { key: toDriverValue(keyValue) });
}
