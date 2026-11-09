/**
 * Turns AI-generated example records into rows that are safe to save: parents before children,
 * real keys instead of the AI's placeholder ids, and foreign keys rewritten to match. Pure, no I/O
 * (see routes/sampleData.ts). Real users' accounts and roles are never touched, and an entity that
 * already holds records is left alone so sample data can't get mixed into real data.
 */
import type { EntityDef, RelationshipDef } from "./applicationModel.js";
import type { AppModel } from "./publicAccess.js";
import { PROTECTED_ACCOUNT_FIELDS } from "./publicAccess.js";

export type GeneratedRows = Record<string, unknown>;
export type SampleRow = { entity: EntityDef; key: string | number; row: Record<string, unknown> };

const MAX_ROWS_PER_ENTITY = 40;

function keyFieldName(entity: EntityDef): string {
  return entity.fields.find((f) => f.key)?.name ?? "id";
}

// Parents first, so a child's link check finds its parent. Circular links fall through in any order.
export function saveOrder(entities: EntityDef[], relationships: RelationshipDef[]): EntityDef[] {
  const remaining = new Map(entities.map((e) => [e.name, e]));
  const ordered: EntityDef[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((e) =>
      !relationships.some((r) => r.fromEntity === e.name && r.toEntity !== e.name && remaining.has(r.toEntity)));
    const batch = ready.length > 0 ? ready : [[...remaining.values()][0]];
    for (const e of batch) {
      ordered.push(e);
      remaining.delete(e.name);
    }
  }
  return ordered;
}

export function entitiesToFill(model: AppModel, roleEntityName: string | null, existingKeys: Map<string, unknown[]>): EntityDef[] {
  return model.entities.filter((e) => !e.isAccount && e.name !== roleEntityName && !(existingKeys.get(e.name)?.length));
}

export function buildSampleRows(
  model: AppModel, generated: GeneratedRows, fill: EntityDef[], existingKeys: Map<string, unknown[]>, newKey: (entity: EntityDef) => string | number
): SampleRow[] {
  const rowsOf = (e: EntityDef) => {
    const list = generated[e.name];
    return Array.isArray(list) ? list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").slice(0, MAX_ROWS_PER_ENTITY) : [];
  };
  // Placeholder id → real key, for every row first, so links resolve in any order.
  const keyMaps = new Map<string, Map<string, string | number>>();
  const keysOf = new Map<string, (string | number)[]>();
  for (const e of fill) {
    const map = new Map<string, string | number>();
    const keys = rowsOf(e).map((r) => {
      const key = newKey(e);
      map.set(String(r[keyFieldName(e)]), key);
      return key;
    });
    keyMaps.set(e.name, map);
    keysOf.set(e.name, keys);
  }

  const out: SampleRow[] = [];
  for (const entity of saveOrder(fill, model.relationships)) {
    const keyName = keyFieldName(entity);
    const links = model.relationships.filter((r) => r.fromEntity === entity.name);
    rowsOf(entity).forEach((source, index) => {
      const key = keysOf.get(entity.name)![index];
      const row: Record<string, unknown> = { [keyName]: key };
      for (const f of entity.fields) {
        if (f.key || f.type === "image" || f.autoNumber || PROTECTED_ACCOUNT_FIELDS.includes(f.name)) continue;
        if (source[f.name] !== undefined && source[f.name] !== null) row[f.name] = source[f.name];
      }
      for (const link of links) {
        const map = keyMaps.get(link.toEntity);
        const existing = existingKeys.get(link.toEntity) ?? [];
        const mapped = map?.get(String(source[link.fromField]));
        if (mapped !== undefined) row[link.fromField] = mapped;
        else if (existing.length > 0) row[link.fromField] = existing[index % existing.length];
        else delete row[link.fromField];
      }
      out.push({ entity, key, row });
    });
  }
  return out;
}
