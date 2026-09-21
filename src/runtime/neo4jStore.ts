/**
 * Neo4j-backed data layer of the runtime engine. Each project is namespaced by a label prefix
 * (Proj<id>_<Table>) — Neo4j has no per-project schemas, and separate databases are Enterprise-only
 * — so a "table" is a node label, a "column" is a node property, and constraints/indexes/queries are
 * all scoped to the project's own labels. Schema creation is deterministic Cypher (no LLM).
 */
import neo4j, { type Driver, type Transaction } from "neo4j-driver";
import { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE } from "../config.js";
import { labelFor, prepareCypher } from "./cypher.js";
import type { QueryResult } from "./engine.js";
import {
  type Entities, type Table, autonumberSeed, coerceValue, findTable, formatAutonumber, fromDriverValue, INTEGER_TYPES,
  safeIdent, toDriverValue,
} from "./values.js";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!NEO4J_URI) throw new Error("NEO4J_URI not configured. Add NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD to your .env file.");
  driver ??= neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));
  return driver;
}

export async function closeNeo4j(): Promise<void> {
  await driver?.close();
  driver = null;
}

// One transaction per unit of work (a route call / a UI event): commit on success, roll back on any
// error — the same all-or-nothing behavior a screen event had on the Postgres preview database.
export async function withTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const session = getDriver().session({ database: NEO4J_DATABASE });
  const tx = session.beginTransaction();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Schema (constraints + indexes)
// ---------------------------------------------------------------------------

export type SchemaSyncResult = { summary: string; statements: string[]; labels: string[] };

function schemaStatements(projectId: number, table: Table): string[] {
  const label = labelFor(projectId, table.name);
  const cols = (table.columns || []).filter((c) => {
    try {
      safeIdent(c.name);
      return true;
    } catch {
      return false;
    }
  });
  const out: string[] = [];
  let hasIndexBackedObject = false;
  const seenUnique = new Set<string>();
  for (const c of cols) {
    if (c.pk || c.unique) {
      if (!seenUnique.has(c.name)) out.push(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.${c.name} IS UNIQUE`);
      seenUnique.add(c.name);
      hasIndexBackedObject = true;
    }
  }
  for (const c of cols) {
    if (c.nullable === false && !c.pk) out.push(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.${c.name} IS NOT NULL`);
  }
  for (const c of cols) {
    if (c.fk && !seenUnique.has(c.name)) {
      out.push(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${c.name})`);
      hasIndexBackedObject = true;
    }
  }
  // Every table gets at least one index so its existence can be detected (see tableExists).
  if (!hasIndexBackedObject && cols.length) out.push(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${cols[0].name})`);
  return out;
}

const syncedSignatures = new Map<number, string>();

function usableTables(entities: Entities): Table[] {
  return (entities.tables || []).filter((t) => {
    try {
      safeIdent(t.name);
    } catch {
      return false;
    }
    return (t.columns || []).length > 0;
  });
}

// Creates (idempotently) every constraint/index for the project's tables. Skips the round-trips when
// the schema hasn't changed since this process last synced it, unless `force` is set.
export async function syncSchema(projectId: number, entities: Entities, opts: { force?: boolean } = {}): Promise<SchemaSyncResult> {
  const tables = usableTables(entities);
  const labels = tables.map((t) => labelFor(projectId, t.name)).sort();
  if (!tables.length) throw new Error("This project has no tables in its schema yet — extract entities first.");

  const statements = tables.flatMap((t) => schemaStatements(projectId, t));
  const signature = statements.join("\n");
  if (!opts.force && syncedSignatures.get(projectId) === signature) {
    return { summary: "Schema already up to date.", statements: [], labels };
  }

  const executed: string[] = [];
  const failed: string[] = [];
  // Schema statements can't share a transaction with data writes, so each runs on its own.
  await Promise.all(
    statements.map(async (stmt) => {
      const session = getDriver().session({ database: NEO4J_DATABASE });
      try {
        await session.run(stmt);
        executed.push(stmt);
      } catch (e) {
        console.warn(`Neo4j schema statement failed: ${stmt} | ${e instanceof Error ? e.message : e}`);
        failed.push(stmt);
      } finally {
        await session.close();
      }
    })
  );
  if (!failed.length) syncedSignatures.set(projectId, signature);
  else syncedSignatures.delete(projectId);

  const ordered = statements.filter((s) => executed.includes(s));
  const summary = failed.length
    ? `Created what could be created — ${ordered.length} of ${statements.length} schema statement(s) applied.`
    : `Created (or confirmed already existing) ${ordered.length} schema statement(s) for ${labels.length} table(s).`;
  return { summary, statements: ordered, labels };
}

// Fire-and-forget hook for "a table was created/changed" — never fails the caller's request.
export function syncSchemaInBackground(projectId: number, entities: Entities | null | undefined): void {
  if (!entities || !usableTables(entities).length || !NEO4J_URI) return;
  syncSchema(projectId, entities).catch((e) => console.warn(`Background Neo4j schema sync failed for project ${projectId}: ${e instanceof Error ? e.message : e}`));
}

// Removes a deleted project's whole namespace: its nodes, constraints and indexes (every schema
// object whose label starts with Proj<id>_). Fire-and-forget; never fails the caller.
export function dropProjectDataInBackground(projectId: number, entities: Entities | null | undefined): void {
  if (!NEO4J_URI) return;
  (async () => {
    const prefix = `Proj${projectId}_`;
    syncedSignatures.delete(projectId);
    for (const t of usableTables(entities || {})) {
      const session = getDriver().session({ database: NEO4J_DATABASE });
      try {
        await session.run(`MATCH (n:${labelFor(projectId, t.name)}) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS`);
      } finally {
        await session.close();
      }
    }
    for (const kind of ["CONSTRAINT", "INDEX"] as const) {
      const session = getDriver().session({ database: NEO4J_DATABASE });
      try {
        const res = await session.run(`SHOW ${kind === "CONSTRAINT" ? "CONSTRAINTS" : "INDEXES"} YIELD name, labelsOrTypes WHERE any(l IN labelsOrTypes WHERE l STARTS WITH $prefix) RETURN name`, { prefix });
        for (const rec of res.records) {
          const name = String(rec.get("name"));
          if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
          await session.run(`DROP ${kind} ${name} IF EXISTS`);
        }
      } finally {
        await session.close();
      }
    }
  })().catch((e) => console.warn(`Neo4j cleanup failed for project ${projectId}: ${e instanceof Error ? e.message : e}`));
}

export async function tableExists(projectId: number, entity: string): Promise<boolean> {
  const label = labelFor(projectId, safeIdent(entity));
  const session = getDriver().session({ database: NEO4J_DATABASE });
  try {
    const res = await session.run("SHOW INDEXES YIELD labelsOrTypes WHERE $label IN labelsOrTypes RETURN count(*) AS c", { label });
    return fromDriverValue(res.records[0]?.get("c")) !== 0;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Row CRUD (what the preview grid uses)
// ---------------------------------------------------------------------------

export async function listRows(tx: Transaction, projectId: number, entities: Entities, entity: string): Promise<Record<string, unknown>[]> {
  const table = findTable(entities, entity);
  if (!table) return [];
  const label = labelFor(projectId, safeIdent(entity));
  const pk = (table.columns || []).find((c) => c.pk);
  const order = pk ? ` ORDER BY n.${safeIdent(pk.name)}` : "";
  const res = await tx.run(`MATCH (n:${label}) RETURN n${order} LIMIT 500`);
  return res.records.map((r) => fromDriverValue(r.get("n")) as Record<string, unknown>);
}

const AUDIT_COLUMN_NAMES = new Set(["createdby", "modifiedby", "updatedby", "created_by", "modified_by", "updated_by"]);

// Replaces the entity's whole row set (the preview UI always sends every row). Same shaping rules
// as before: unknown/blank values dropped, values coerced to the column type, autonumber columns
// filled, required audit columns defaulted, integer primary keys assigned sequentially when absent.
export async function replaceAllRows(
  tx: Transaction, projectId: number, entities: Entities, entity: string, rows: Record<string, unknown>[]
): Promise<void> {
  const table = findTable(entities, entity);
  if (!table) throw new Error(`Unknown entity: ${entity}`);
  const label = labelFor(projectId, safeIdent(entity));
  const columns = table.columns || [];
  const colTypes = new Map(columns.map((c) => [c.name, c.type || "TEXT"]));
  const requiredAuditCols = new Set(columns.filter((c) => c.nullable === false && AUDIT_COLUMN_NAMES.has(c.name.toLowerCase())).map((c) => c.name));

  const autonumberState = new Map<string, { config: NonNullable<(typeof columns)[number]["autonumber"]>; next: number; step: number }>();
  for (const c of columns) {
    if (!c.autonumber) continue;
    const existing = rows.map((r) => r[c.name]).filter((v) => v !== null && v !== undefined && v !== "");
    const [next, step] = autonumberSeed(c.autonumber, existing);
    autonumberState.set(c.name, { config: c.autonumber, next, step });
  }
  const identityCol = columns.find((c) => c.pk && !c.autonumber && INTEGER_TYPES.has((c.type || "").trim().toUpperCase()));
  let nextIdentity = 1;
  if (identityCol) {
    const used = rows.map((r) => Number(r[identityCol.name])).filter((n) => Number.isFinite(n));
    nextIdentity = used.length ? Math.max(...used) + 1 : 1;
  }

  const shaped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!colTypes.has(k) || v === null || v === undefined || v === "") continue;
      const coerced = coerceValue(v, colTypes.get(k));
      if (coerced !== null && coerced !== undefined) data[k] = coerced;
    }
    for (const c of requiredAuditCols) if (!(c in data)) data[c] = "preview";
    for (const [cname, state] of autonumberState) {
      if (row[cname] === null || row[cname] === undefined || row[cname] === "") {
        data[cname] = formatAutonumber(state.config, state.next);
        state.next += state.step;
      }
    }
    if (identityCol && !(identityCol.name in data)) data[identityCol.name] = nextIdentity++;
    if (Object.keys(data).length) shaped.push(toDriverValue(data) as Record<string, unknown>);
  }

  await tx.run(`MATCH (n:${label}) DETACH DELETE n`);
  if (shaped.length) await tx.run(`UNWIND $rows AS r CREATE (n:${label}) SET n = r`, { rows: shaped });
}

// ---------------------------------------------------------------------------
// Query execution for screen events
// ---------------------------------------------------------------------------

export async function executeQuery(
  tx: Transaction, projectId: number, entities: Entities, statement: string, params: Record<string, unknown>
): Promise<QueryResult> {
  const tables = new Set((entities.tables || []).map((t) => t.name));
  const cypher = prepareCypher(statement, projectId, tables, new Set(Object.keys(params)));
  const bound = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, toDriverValue(v)]));
  const res = await tx.run(cypher, bound);
  const rows = res.records.map((r) => fromDriverValue(r.toObject()) as Record<string, unknown>);
  const c = res.summary.counters.updates();
  const affected = Math.max(c.nodesCreated + c.nodesDeleted, c.propertiesSet > 0 ? 1 : 0);
  return { rows, count: Math.max(rows.length, affected) };
}
