/**
 * DependsOn-driven validation re-run selection — "the runtime reruns only affected validations
 * and impact analysis never has to parse the condition expression." affectedValidations/
 * buildDependencyIndex look ONLY at each Validation's declared dependsOn list, never at its test
 * string.
 */
import type { ValidationDef, RelationshipDef } from "./applicationModel.js";
import { evaluateCondition, type ExpressionContext } from "./expressions.js";

// "lineItems" from a plural camelCase alias <-> "LineItem" the entity name — best-effort, not a
// full English pluralizer, but handles the one irregular case common enough to matter here: a
// name ending in consonant+y (Policy, Category, Company) pluralizes to -ies, not a naive +s
// ("Policy" -> "policies", never "policys" — the AI reliably writes proper English plurals in
// via="...", so a naive +s here would simply never match for any such entity name).
function pluralizeCamel(entityName: string): string {
  const camel = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  if (/[^aeiou]y$/i.test(camel)) return camel.slice(0, -1) + "ies";
  return camel.endsWith("s") ? camel : `${camel}s`;
}

// Resolves a via="lineItems" alias (declared on a Validation that belongs to entity `ownerEntity`)
// to the actual related entity name, by finding the Relationship connecting ownerEntity to some
// other entity whose pluralized name matches the alias.
export function resolveViaAlias(ownerEntity: string, alias: string, relationships: RelationshipDef[]): string | null {
  for (const rel of relationships) {
    const other = rel.fromEntity === ownerEntity ? rel.toEntity : rel.toEntity === ownerEntity ? rel.fromEntity : null;
    if (other && pluralizeCamel(other) === alias) return other;
  }
  return null;
}

type DependencyKey = string; // `${entity}:${field}`
function dependencyKey(entity: string, field: string): DependencyKey {
  return `${entity}:${field}`;
}

// Maps "an entity:field changed" -> every Validation that declared a dependency on exactly that
// (resolving via-entries to the real related entity first) — built once per Application, reused
// across many saves rather than rescanning every Validation's dependsOn on every single change.
export function buildDependencyIndex(validations: ValidationDef[], relationships: RelationshipDef[]): Map<DependencyKey, ValidationDef[]> {
  const index = new Map<DependencyKey, ValidationDef[]>();
  for (const v of validations) {
    for (const dep of v.dependsOn) {
      const entity = dep.via ? resolveViaAlias(v.entity, dep.via, relationships) : v.entity;
      if (!entity) {
        console.warn(`Validation "${v.id}": couldn't resolve via="${dep.via}" against entity "${v.entity}" — ignoring this dependency`);
        continue;
      }
      const key = dependencyKey(entity, dep.field);
      const list = index.get(key) || [];
      list.push(v);
      index.set(key, list);
    }
  }
  return index;
}

export function affectedValidations(
  changedEntity: string, changedFieldNames: string[], index: Map<DependencyKey, ValidationDef[]>
): ValidationDef[] {
  const seen = new Set<string>();
  const out: ValidationDef[] = [];
  for (const field of changedFieldNames) {
    for (const v of index.get(dependencyKey(changedEntity, field)) || []) {
      if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
    }
  }
  return out;
}

export type ValidationResult = { id: string; passed: boolean; message: string; onViolation: "reject" | "warn" };

export function runValidations(validations: ValidationDef[], ctx: ExpressionContext): ValidationResult[] {
  return validations.map((v) => ({
    id: v.id,
    passed: v.test ? evaluateCondition(v.test, ctx) : true,
    message: v.message,
    onViolation: v.onViolation,
  }));
}
