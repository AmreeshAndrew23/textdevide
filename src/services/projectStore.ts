/**
 * Where a project's data lives. Postgres keeps users, prompt logs/token usage and the project's own
 * details (name, description, features, status, theme, GitHub links). Everything a user CREATES while
 * working in the app — table schema, ER diagram, screens (XML), validation, generated UI — lives in
 * Neo4j. This module is the only place that knows that split: routes load a project through
 * getOwnedProject() (a normal ProjectRow with the Neo4j-held fields filled in) and save through
 * updateProject() (which routes each field to the right database), so the API JSON is unchanged.
 *
 * Neo4j model (labels are NOT prefixed "Proj", so no user/AI query can reach them — see cypher.ts):
 *   (:TdWorkspace {projectId, userId, projectName}) marker: this project's workspace lives in Neo4j.
 *     userId/projectName are NOT the access-control mechanism (ownership is enforced in Postgres by
 *     getOwnedProject below, on every route, before Neo4j is ever touched) — they're a lookup/legend
 *     so a human browsing Neo4j directly can tell which user and project a Proj<id>_ label prefix
 *     belongs to, without cross-referencing Postgres. e.g. MATCH (w:TdWorkspace {userId: 12}) RETURN
 *     w.projectId, w.projectName lists everything a given user owns.
 *   (:TdArtifact  {projectId, kind, content})       one per non-screen artifact (entities, er_diagram, ...)
 *   (:TdScreen    {projectId, screenId, name, position, json})   one per screen
 */
import { and, eq } from "drizzle-orm";
import neo4j, { type Transaction } from "neo4j-driver";
import { db } from "../db/connection.js";
import { projects, type ProjectRow } from "../db/schema.js";
import { HttpError } from "./authService.js";
import { neo4jSession, withTx } from "../runtime/neo4jStore.js";
import { fromDriverValue, toDriverValue } from "../runtime/values.js";

// ProjectRow field -> artifact kind stored in Neo4j. (uiScreens is stored per-screen, not as an artifact.)
export const ARTIFACT_KINDS = {
  entities: "entities",
  erDiagram: "er_diagram",
  validationRules: "validation_rules",
  validationCode: "validation_code",
  uiDescription: "ui_description",
  uiCode: "ui_code",
  uiXml: "ui_xml",
  uiHtml: "ui_html",
  uiApi: "ui_api",
} as const;
export type ArtifactField = keyof typeof ARTIFACT_KINDS;
const ARTIFACT_FIELDS = Object.keys(ARTIFACT_KINDS) as ArtifactField[];

export type ScreenNode = { screenId: string; name: string; position: number; json: string };
export type Workspace = { artifacts: Map<string, string>; screens: string | null };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function splitPatch(patch: Partial<ProjectRow>): {
  pg: Partial<ProjectRow>;
  artifacts: Partial<Record<ArtifactField, string | null>>;
  screens: string | null | undefined;
} {
  const pg: Record<string, unknown> = {};
  const artifacts: Partial<Record<ArtifactField, string | null>> = {};
  let screens: string | null | undefined;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "uiScreens") screens = value as string | null;
    else if (key in ARTIFACT_KINDS) artifacts[key as ArtifactField] = value as string | null;
    else pg[key] = value;
  }
  return { pg: pg as Partial<ProjectRow>, artifacts, screens };
}

export function screensToNodes(json: string | null | undefined): ScreenNode[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new HttpError(400, "ui_screens must be a JSON array of screens");
  }
  if (!Array.isArray(parsed)) throw new HttpError(400, "ui_screens must be a JSON array of screens");
  return parsed.map((s, position) => {
    if (!s || typeof s !== "object" || typeof (s as { id?: unknown }).id !== "string" || !(s as { id: string }).id) {
      throw new HttpError(400, "every screen needs a string id");
    }
    const screen = s as { id: string; name?: unknown };
    return { screenId: screen.id, name: typeof screen.name === "string" ? screen.name : "", position, json: JSON.stringify(s) };
  });
}

export function nodesToScreens(nodes: { position: number; json: string }[]): string | null {
  if (!nodes.length) return null;
  const ordered = [...nodes].sort((a, b) => a.position - b.position);
  return JSON.stringify(ordered.map((n) => JSON.parse(n.json)));
}

export function overlayWorkspace(row: ProjectRow, ws: Workspace): ProjectRow {
  const out: ProjectRow = { ...row, uiScreens: ws.screens };
  for (const field of ARTIFACT_FIELDS) out[field] = ws.artifacts.get(ARTIFACT_KINDS[field]) ?? null;
  return out;
}

// ---------------------------------------------------------------------------
// Neo4j access
// ---------------------------------------------------------------------------

const pid = (projectId: number) => neo4j.int(projectId);

// A Neo4j failure must read as "storage is unavailable", never as a crash — and never as a silent
// fallback to Postgres, which would split one project's data across two databases.
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("Workspace (Neo4j) operation failed:", e instanceof Error ? e.message : e);
    throw new HttpError(503, "Workspace database unavailable — please try again shortly.");
  }
}

// Same-process serialization of a project's writes, so two overlapping saves (a batch generation
// finishing screens at once) can't interleave their delete-and-recreate of the screen nodes.
const locks = new Map<number, Promise<unknown>>();
async function withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(projectId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(projectId) === tail) locks.delete(projectId);
  }
}

async function writeArtifact(tx: Transaction, projectId: number, kind: string, content: string | null): Promise<void> {
  if (content === null) {
    await tx.run("MATCH (a:TdArtifact {projectId: $pid, kind: $kind}) DELETE a", { pid: pid(projectId), kind });
    return;
  }
  await tx.run("MERGE (a:TdArtifact {projectId: $pid, kind: $kind}) SET a.content = $content, a.updatedAt = datetime()", {
    pid: pid(projectId), kind, content,
  });
}

async function writeScreens(tx: Transaction, projectId: number, nodes: ScreenNode[]): Promise<void> {
  await tx.run("MATCH (s:TdScreen {projectId: $pid}) DELETE s", { pid: pid(projectId) });
  if (!nodes.length) return;
  await tx.run(
    "UNWIND $nodes AS n CREATE (s:TdScreen {projectId: $pid, screenId: n.screenId, name: n.name, position: n.position, json: n.json})",
    { pid: pid(projectId), nodes: nodes.map((n) => toDriverValue(n)) }
  );
}

async function readWorkspace(tx: Transaction, projectId: number): Promise<Workspace> {
  const art = await tx.run("MATCH (a:TdArtifact {projectId: $pid}) RETURN a.kind AS kind, a.content AS content", { pid: pid(projectId) });
  const artifacts = new Map<string, string>();
  for (const r of art.records) {
    const content = r.get("content");
    if (typeof content === "string") artifacts.set(String(r.get("kind")), content);
  }
  const scr = await tx.run("MATCH (s:TdScreen {projectId: $pid}) RETURN s.position AS position, s.json AS json", { pid: pid(projectId) });
  const screens = nodesToScreens(scr.records.map((r) => ({ position: Number(fromDriverValue(r.get("position"))), json: String(r.get("json")) })));
  return { artifacts, screens };
}

// Projects created before this change still have their work in the Postgres columns. The first time
// one is opened, copy it into Neo4j (idempotent MERGEs) and mark it migrated. The Postgres columns
// are left untouched as a backup. `migrated` + `pending` make this run once per project per process
// even when the frontend fires several requests for a project at the same moment.
const migrated = new Set<number>();
const pending = new Map<number, Promise<void>>();

async function migrateInTx(tx: Transaction, row: ProjectRow): Promise<void> {
  const marker = await tx.run("MATCH (w:TdWorkspace {projectId: $pid}) RETURN count(w) AS c", { pid: pid(row.id) });
  if (Number(fromDriverValue(marker.records[0].get("c"))) > 0) return;
  for (const field of ARTIFACT_FIELDS) {
    const legacy = row[field];
    if (typeof legacy === "string" && legacy !== "") await writeArtifact(tx, row.id, ARTIFACT_KINDS[field], legacy);
  }
  let nodes: ScreenNode[] = [];
  try {
    nodes = screensToNodes(row.uiScreens);
  } catch {
    console.warn(`Project ${row.id}: legacy ui_screens is not a valid screen array — screens were not migrated`);
  }
  await writeScreens(tx, row.id, nodes);
  await tx.run("MERGE (w:TdWorkspace {projectId: $pid}) SET w.migratedAt = datetime(), w.userId = $userId, w.projectName = $projectName", {
    pid: pid(row.id), userId: neo4j.int(row.userId), projectName: row.name,
  });
}

async function ensureMigrated(row: ProjectRow): Promise<void> {
  if (migrated.has(row.id)) return;
  let inFlight = pending.get(row.id);
  if (!inFlight) {
    inFlight = withTx((tx) => migrateInTx(tx, row))
      .then(() => { migrated.add(row.id); })
      .finally(() => { pending.delete(row.id); });
    pending.set(row.id, inFlight);
  }
  await inFlight;
}

// Creates the uniqueness constraints once at startup. Never fatal: without them everything still
// works (the writes are MERGEs), it just loses the belt-and-braces duplicate guard.
export async function ensureWorkspaceSchema(): Promise<void> {
  const statements = [
    "CREATE CONSTRAINT td_workspace_key IF NOT EXISTS FOR (w:TdWorkspace) REQUIRE w.projectId IS UNIQUE",
    "CREATE CONSTRAINT td_artifact_key IF NOT EXISTS FOR (a:TdArtifact) REQUIRE (a.projectId, a.kind) IS UNIQUE",
    "CREATE CONSTRAINT td_screen_key IF NOT EXISTS FOR (s:TdScreen) REQUIRE (s.projectId, s.screenId) IS UNIQUE",
  ];
  for (const stmt of statements) {
    let session;
    try {
      session = neo4jSession();
      await session.run(stmt);
    } catch (e) {
      console.warn(`Workspace schema statement failed (${stmt}): ${e instanceof Error ? e.message : e}`);
    } finally {
      await session?.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Public API used by the routes
// ---------------------------------------------------------------------------

// A Neo4j round trip is slow from a hosted instance (~0.5s measured), and every screen event / page
// load reads the project. This process is the only writer (updateProject / deleteWorkspace update or
// drop the entry), so a cached copy stays correct; the TTL only bounds staleness if a second server
// instance or a manual edit in Neo4j Browser ever changes data behind this process's back.
const WORKSPACE_CACHE_TTL_MS = 60_000;
const workspaceCache = new Map<number, { ws: Workspace; at: number }>();

export async function hydrate(row: ProjectRow): Promise<ProjectRow> {
  const cached = workspaceCache.get(row.id);
  if (cached && Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS) return overlayWorkspace(row, cached.ws);
  return guard(async () => {
    await ensureMigrated(row);
    const ws = await withTx((tx) => readWorkspace(tx, row.id));
    workspaceCache.set(row.id, { ws, at: Date.now() });
    return overlayWorkspace(row, ws);
  });
}

// 404s if the project is missing or not owned by this user (ownership stays in Postgres).
export async function getOwnedProject(projectId: number, userId: number): Promise<ProjectRow> {
  const [row] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!row) throw new HttpError(404, "Project not found");
  return hydrate(row);
}

// The project list only needs each project's table schema. One query for all of them; a project not
// migrated yet still shows its legacy Postgres schema, and if Neo4j is down the list still loads
// (without table info) instead of failing.
export async function hydrateListEntities(rows: ProjectRow[]): Promise<ProjectRow[]> {
  if (!rows.length) return rows;
  try {
    const ids = rows.map((r) => pid(r.id));
    const { migratedIds, entities } = await withTx(async (tx) => {
      const m = await tx.run("MATCH (w:TdWorkspace) WHERE w.projectId IN $ids RETURN w.projectId AS id", { ids });
      const e = await tx.run("MATCH (a:TdArtifact {kind: 'entities'}) WHERE a.projectId IN $ids RETURN a.projectId AS id, a.content AS content", { ids });
      return {
        migratedIds: new Set(m.records.map((r) => Number(fromDriverValue(r.get("id"))))),
        entities: new Map(e.records.map((r) => [Number(fromDriverValue(r.get("id"))), String(r.get("content"))] as const)),
      };
    });
    return rows.map((r) => (migratedIds.has(r.id) ? { ...r, entities: entities.get(r.id) ?? null } : r));
  } catch (e) {
    console.error("Workspace list hydration failed:", e instanceof Error ? e.message : e);
    return rows.map((r) => ({ ...r, entities: null }));
  }
}

// Writes each field to its own database (Neo4j first — if it fails nothing has changed) and returns
// the project as the API serializes it. The Neo4j write and the read-back share one transaction.
export async function updateProject(projectId: number, patch: Partial<ProjectRow>): Promise<ProjectRow> {
  const [current] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!current) throw new HttpError(404, "Project not found");
  const { pg, artifacts, screens } = splitPatch(patch);
  const screenNodes = screens === undefined ? undefined : screensToNodes(screens); // validates before anything is written

  const ws = await guard(() =>
    withProjectLock(projectId, async () => {
      await ensureMigrated(current);
      return withTx(async (tx) => {
        for (const [field, content] of Object.entries(artifacts) as [ArtifactField, string | null][]) {
          await writeArtifact(tx, projectId, ARTIFACT_KINDS[field], content);
        }
        if (screenNodes !== undefined) await writeScreens(tx, projectId, screenNodes);
        return readWorkspace(tx, projectId);
      });
    })
  );

  workspaceCache.set(projectId, { ws, at: Date.now() });
  let row = current;
  if (Object.keys(pg).length) {
    [row] = await db.update(projects).set(pg).where(eq(projects.id, projectId)).returning();
  }
  if (typeof pg.name === "string" && pg.name !== current.name) {
    // Best-effort — keeps the TdWorkspace lookup node's display name in sync with a rename. Never
    // blocks or fails this request: the rename already succeeded in Postgres, and this field is a
    // browsing convenience, not something anything else reads.
    try {
      await withTx((tx) => tx.run("MATCH (w:TdWorkspace {projectId: $pid}) SET w.projectName = $name", { pid: pid(projectId), name: pg.name }));
    } catch (e) {
      console.warn(`Failed to refresh TdWorkspace.projectName for project ${projectId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return overlayWorkspace(row, ws);
}

export async function deleteWorkspace(projectId: number): Promise<void> {
  await guard(async () => {
    await withTx(async (tx) => {
      for (const label of ["TdArtifact", "TdScreen", "TdWorkspace"]) {
        await tx.run(`MATCH (n:${label} {projectId: $pid}) DETACH DELETE n`, { pid: pid(projectId) });
      }
    });
    migrated.delete(projectId);
    workspaceCache.delete(projectId);
  });
}
