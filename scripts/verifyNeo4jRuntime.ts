import "dotenv/config";
import neo4j from "neo4j-driver";
import { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE } from "../src/config.js";

const BASE = "http://localhost:8001/api";
const EMAIL = `neo4jrt_${Date.now()}@example.com`;

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));
async function cypher(q: string, p: Record<string, unknown> = {}) {
  const s = driver.session({ database: NEO4J_DATABASE });
  try { return (await s.run(q, p)).records; } finally { await s.close(); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const entities = {
  tables: [
    { name: "Department", columns: [
      { name: "deptid", type: "VARCHAR(20)", pk: true, nullable: false },
      { name: "deptname", type: "VARCHAR(100)", nullable: false },
    ] },
    { name: "Course", columns: [
      { name: "courseid", type: "VARCHAR(20)", pk: true, nullable: false },
      { name: "coursename", type: "VARCHAR(100)", nullable: false },
      { name: "deptid", type: "VARCHAR(20)", fk: "Department.deptid", nullable: false },
    ] },
  ],
};

let projectId = 0;
let token = "";
try {
  await api("POST", "/auth/register", undefined, { email: EMAIL, password: "testpass123", full_name: "N4J" });
  token = (await api("POST", "/auth/login", undefined, { email: EMAIL, password: "testpass123" })).access_token;
  const project = await api("POST", "/projects", token, { name: "Neo4j Runtime Test" });
  projectId = project.id;
  const P = `Proj${projectId}_`;
  console.log("project", projectId);

  console.log("--- 1. saving entities auto-creates the tables in Neo4j ---");
  await api("PUT", `/projects/${projectId}`, token, { entities: JSON.stringify(entities) });
  let constraints: string[] = [];
  for (let i = 0; i < 20 && constraints.length < 4; i++) {
    await wait(1000);
    constraints = (await cypher("SHOW CONSTRAINTS YIELD name, labelsOrTypes WHERE any(l IN labelsOrTypes WHERE l STARTS WITH $p) RETURN name", { p: P })).map((r) => r.get("name"));
  }
  console.log("constraints in Neo4j:", constraints.length, constraints);
  if (constraints.length < 4) throw new Error("expected >= 4 constraints (2 pk unique + 3 not-null... ) auto-created");

  console.log("--- 2. explicit Create DB button endpoint (deterministic, no LLM) ---");
  const t0 = Date.now();
  const created = await api("POST", `/projects/${projectId}/neo4j/create-db`, token);
  console.log(`create-db ${Date.now() - t0}ms:`, created.summary, "| labels:", created.labels);

  console.log("--- 3. preview rows go to Neo4j ---");
  await api("PUT", `/projects/${projectId}/preview-db/Department`, token, { rows: [{ deptid: "CS", deptname: "Computer Science" }, { deptid: "HIST", deptname: "History" }] });
  await api("PUT", `/projects/${projectId}/preview-db/Course`, token, { rows: [
    { courseid: "CS101", coursename: "Intro", deptid: "CS" }, { courseid: "CS201", coursename: "Data Structures", deptid: "CS" },
  ] });
  const direct = await cypher(`MATCH (c:${P}Course) RETURN c.courseid AS id ORDER BY id`);
  console.log("courses read straight from Neo4j:", direct.map((r) => r.get("id")));
  const got = await api("GET", `/projects/${projectId}/preview-db/Department`, token);
  console.log("GET preview-db/Department:", JSON.stringify(got));

  console.log("--- 4. AI generates a Cypher screen ---");
  const withScreen = await api("POST", `/projects/${projectId}/screens`, token, { name: "Department", description: "" });
  const screenId = JSON.parse(withScreen.ui_screens)[0].id;
  const gen = await api("POST", `/projects/${projectId}/screens/${screenId}/generate-xml`, token, {
    description: "Department screen with fields deptid and deptname and a grid of courseid and coursename. When deptid changes, load the department name and fill the grid with that department's courses; if there are no courses show 'no course available for this department: <deptid>'. A Save button inserts a new department.",
  });
  const xml: string = JSON.parse(gen.ui_screens)[0].xml;
  const stmts = [...xml.matchAll(/<statement>([\s\S]*?)<\/statement>/g)].map((m) => m[1].trim().replace(/\s+/g, " "));
  console.log("generated statements:\n  " + stmts.join("\n  "));
  if (stmts.some((s) => /^SELECT/i.test(s))) throw new Error("model produced SQL");
  const noop = stmts.filter((s) => s.includes("noop")).length;
  console.log("neutralized (invalid) statements:", noop);

  console.log("--- 5. run the screen's events on the runtime engine ---");
  const fieldEl = xml.match(/<event[^>]*type="change"[^>]*element="([^"]+)"|<event[^>]*element="([^"]+)"[^>]*type="change"/);
  const changeEl = fieldEl?.[1] || fieldEl?.[2];
  console.log("change event element:", changeEl);
  const ev = await api("POST", `/projects/${projectId}/screens/${screenId}/run-event`, token, { elementId: changeEl, eventType: "change", fieldValues: { deptid: "CS" } });
  console.log("actions (CS):", JSON.stringify(ev.actions));
  const ev2 = await api("POST", `/projects/${projectId}/screens/${screenId}/run-event`, token, { elementId: changeEl, eventType: "change", fieldValues: { deptid: "HIST" } });
  console.log("actions (HIST, no courses):", JSON.stringify(ev2.actions));

  const saveEl = xml.match(/<event[^>]*type="click"[^>]*element="([^"]+)"|<event[^>]*element="([^"]+)"[^>]*type="click"/);
  const saveId = saveEl?.[1] || saveEl?.[2];
  const ev3 = await api("POST", `/projects/${projectId}/screens/${screenId}/run-event`, token, { elementId: saveId, eventType: "click", fieldValues: { deptid: "MATH", deptname: "Mathematics" } });
  console.log("actions (save MATH):", JSON.stringify(ev3.actions));
  const saved = await cypher(`MATCH (d:${P}Department {deptid: 'MATH'}) RETURN d.deptname AS n`);
  console.log("MATH now in Neo4j:", saved.map((r) => r.get("n")));

  console.log("--- 6. project delete removes its namespace ---");
  await api("DELETE", `/projects/${projectId}`, token);
  let left = 99;
  for (let i = 0; i < 20 && left > 0; i++) {
    await wait(1000);
    const nodes = Number((await cypher(`MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH $p) RETURN count(n) AS c`, { p: P }))[0].get("c"));
    const cons = (await cypher("SHOW CONSTRAINTS YIELD name, labelsOrTypes WHERE any(l IN labelsOrTypes WHERE l STARTS WITH $p) RETURN name", { p: P })).length;
    left = nodes + cons;
  }
  console.log("nodes+constraints left after delete:", left);
  projectId = 0;
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  if (projectId) await api("DELETE", `/projects/${projectId}`, token).catch(() => {});
  await driver.close();
}
