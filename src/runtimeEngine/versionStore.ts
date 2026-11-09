/**
 * Version history of an application's definition. Before every change that replaces or merges
 * elements, the current definition is saved here, so an AI change or a new design can be undone.
 * Only the definition is versioned: records live in their own nodes and are never touched.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { runtimeAppVersions } from "../db/schema.js";

const VERSIONS_KEPT = 30;

type Element = { tag: string; name: string; xml: string };
export type ElementDiff = { added: string[]; removed: string[]; changed: string[] };

// What restoring `target` would do to `current`, as "Tag: name" lists.
export function diffElements(current: Element[], target: Element[]): ElementDiff {
  const label = (e: Element) => `${e.tag}: ${e.name}`;
  const key = (e: Element) => `${e.tag}\u0000${e.name}`;
  const now = new Map(current.map((e) => [key(e), e]));
  const then = new Map(target.map((e) => [key(e), e]));
  return {
    added: target.filter((e) => !now.has(key(e))).map(label),
    removed: current.filter((e) => !then.has(key(e))).map(label),
    changed: target.filter((e) => now.has(key(e)) && now.get(key(e))!.xml !== e.xml).map(label),
  };
}

export async function recordVersion(applicationId: number, xml: string, label: string, createdBy: string): Promise<void> {
  const recent = await db.select().from(runtimeAppVersions)
    .where(eq(runtimeAppVersions.applicationId, applicationId)).orderBy(desc(runtimeAppVersions.id));
  if (recent[0]?.xml === xml) return; // nothing changed since the last snapshot
  await db.insert(runtimeAppVersions).values({ applicationId, xml, label: label.slice(0, 200), createdBy });
  const stale = recent.slice(VERSIONS_KEPT - 1).map((v) => v.id);
  if (stale.length > 0) await db.delete(runtimeAppVersions).where(inArray(runtimeAppVersions.id, stale));
}
