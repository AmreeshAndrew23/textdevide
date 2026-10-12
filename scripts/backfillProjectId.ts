// One-time backfill: stamps a projectId property onto every row that already exists under a
// Proj<id>_<Table> label, created before executeQuery started adding it automatically. Safe to
// re-run — setting the same value again is a no-op. Does not touch TdEntityTable (it already gets
// projectId at creation, via projectStore.ts's writeEntityTables).
import "dotenv/config";
import { neo4jSession, closeNeo4j } from "../src/runtime/neo4jStore.js";

const LABEL_RE = /^Proj(\d+)_(.+)$/;

async function main() {
  const session = neo4jSession();
  try {
    const labelsRes = await session.run("CALL db.labels() YIELD label RETURN label");
    const targets = labelsRes.records
      .map((r) => r.get("label") as string)
      .map((label) => ({ label, m: LABEL_RE.exec(label) }))
      .filter((x): x is { label: string; m: RegExpExecArray } => x.m !== null);

    console.log(`Found ${targets.length} project-data label(s) to backfill.`);
    let totalSet = 0;
    for (const { label, m } of targets) {
      const projectId = Number(m[1]);
      const res = await session.run(`MATCH (n:${label}) SET n.projectId = $pid RETURN count(n) AS c`, { pid: projectId });
      const count = Number(res.records[0]?.get("c") ?? 0);
      totalSet += count;
      console.log(`  ${label}: set projectId=${projectId} on ${count} node(s)`);
    }
    console.log(`Done. ${totalSet} node(s) updated across ${targets.length} label(s).`);
  } finally {
    await session.close();
    await closeNeo4j();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
