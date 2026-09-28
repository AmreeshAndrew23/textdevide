// One-shot: copies every existing project's generated work (schema, ER diagram, screens, validation,
// UI) from the legacy Postgres columns into Neo4j, instead of waiting for each project to be opened.
// Safe to re-run (already-migrated projects are skipped) and never modifies or deletes Postgres data.
//   npx tsx scripts/migrateWorkspaceToNeo4j.ts
import { db } from "../src/db/connection.js";
import { projects } from "../src/db/schema.js";
import { ensureWorkspaceSchema, hydrate } from "../src/services/projectStore.js";
import { closeNeo4j } from "../src/runtime/neo4jStore.js";

await ensureWorkspaceSchema();
const rows = await db.select().from(projects);
let ok = 0;
let failed = 0;
for (const row of rows) {
  try {
    const h = await hydrate(row); // migrates on first read, then reads back from Neo4j
    const screens = h.uiScreens ? (JSON.parse(h.uiScreens) as unknown[]).length : 0;
    console.log(`project ${row.id} "${row.name}": entities=${h.entities ? "yes" : "no"} screens=${screens}`);
    ok++;
  } catch (e) {
    console.error(`project ${row.id} "${row.name}" FAILED: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}
console.log(`\nDone: ${ok} migrated/verified, ${failed} failed, ${rows.length} total.`);
await closeNeo4j();
process.exit(failed ? 1 : 0);
