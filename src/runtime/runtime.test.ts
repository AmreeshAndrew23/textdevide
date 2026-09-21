import { describe, expect, it } from "vitest";
import { labelFor, prepareCypher, validateCypherStatic } from "./cypher.js";
import { coerceValue } from "./values.js";
import { evaluateCondition, resolveTemplate, runEvent, type QueryExecutor } from "./engine.js";
import { lintScreenXml } from "../services/aiService.js";

const tables = new Set(["Department", "Course"]);
const prep = (s: string, params: string[] = []) => prepareCypher(s, 7, tables, new Set(params));

describe("cypher: label namespacing per project", () => {
  it("prefixes every table label with the project namespace", () => {
    expect(labelFor(7, "Department")).toBe("Proj7_Department");
    expect(prep("MATCH (d:Department) WHERE d.deptid = $deptid RETURN d.deptname AS deptname", ["deptid"])).toBe(
      "MATCH (d:Proj7_Department) WHERE d.deptid = $deptid RETURN d.deptname AS deptname"
    );
  });
  it("rewrites CREATE with property maps, multiple patterns and MERGE ... ON CREATE SET", () => {
    expect(prep("CREATE (d:Department {deptid: $deptid, deptname: $deptname})", ["deptid", "deptname"])).toContain("(d:Proj7_Department {deptid");
    expect(prep("MATCH (d:Department), (c:Course) WHERE c.deptid = d.deptid RETURN c.courseid AS courseid")).toContain("(c:Proj7_Course)");
    expect(prep("MERGE (d:Department {deptid: $id}) ON CREATE SET d.deptname = $n", ["id", "n"])).toContain("(d:Proj7_Department {deptid");
  });
  it("leaves string literals alone", () => {
    const out = prep("MATCH (d:Department) WHERE d.note = '(x:Department); // call' RETURN d.deptid AS deptid");
    expect(out).toContain("'(x:Department); // call'");
    expect(out).toContain("(d:Proj7_Department)");
  });
});

describe("cypher: rejections", () => {
  const bad = (s: string, params: string[] = []) => expect(() => prep(s, params)).toThrow();
  it("blocks unlabeled patterns (would scan every project's data)", () => bad("MATCH (n) RETURN n"));
  it("blocks labels that are not this project's tables", () => {
    bad("MATCH (n:User) RETURN n");
    bad("MATCH (n:Proj9_Department) RETURN n");
  });
  it("blocks relationships, procedures, schema commands, subqueries, comments, multi-statement", () => {
    bad("MATCH (a:Department)-[:R]->(b:Course) RETURN a");
    bad("MATCH (a:Department)--(b:Course) RETURN a");
    bad("CALL db.labels()");
    bad("MATCH (d:Department) RETURN apoc.text.join(['a'], ',') AS x");
    bad("DROP CONSTRAINT foo");
    bad("CREATE CONSTRAINT FOR (n:Department) REQUIRE n.a IS UNIQUE");
    bad("MATCH (d:Department) WHERE EXISTS { MATCH (c:Course) } RETURN d");
    bad("MATCH (d:Department) RETURN d // hi");
    bad("MATCH (d:Department) RETURN d; MATCH (c:Course) RETURN c");
    bad("SHOW CONSTRAINTS");
    bad("LOAD CSV FROM 'x' AS r RETURN r");
  });
  it("requires every used parameter to be declared", () => bad("MATCH (d:Department) WHERE d.deptid = $deptid RETURN d", []));
  it("static check does not need to know the tables", () => {
    expect(() => validateCypherStatic("MATCH (x:Anything) RETURN x", new Set())).not.toThrow();
    expect(() => validateCypherStatic("SELECT 1")).toThrow();
  });
});

describe("values", () => {
  it("coerces by declared column type", () => {
    expect(coerceValue("42", "INT")).toBe(42);
    expect(coerceValue("x", "INT")).toBeNull();
    expect(coerceValue("3.5", "DECIMAL(5,2)")).toBe(3.5);
    expect(coerceValue("yes", "BOOLEAN")).toBe(true);
    expect(coerceValue("2024-05-01T10:00:00Z", "DATE")).toBe("2024-05-01");
  });
});

describe("lintScreenXml (Cypher)", () => {
  const xml = (statement: string) =>
    `<screen id="s"><queries><query id="q"><dataSource ref="mainDB"/><statement>${statement}</statement><parameters><parameter name="deptid" source="field:deptid"/></parameters></query></queries></screen>`;
  it("keeps a valid Cypher query", () => {
    const good = xml("MATCH (d:Department) WHERE d.deptid = $deptid RETURN d.deptname AS deptname");
    expect(lintScreenXml(good)).toBe(good);
  });
  it("neutralizes SQL and unbound-parameter queries to a safe no-op", () => {
    expect(lintScreenXml(xml("SELECT * FROM department WHERE deptid = :deptid"))).toContain("RETURN 1 AS noop LIMIT 0");
    expect(lintScreenXml(xml("MATCH (d:Department) RETURN d.deptname AS deptname"))).toContain("RETURN 1 AS noop LIMIT 0");
  });
});

describe("conditions and templates", () => {
  const result = { rows: [{ count: 0 }], count: 1 };
  it("prefers a column literally named count over the row count", () => {
    expect(evaluateCondition("result.count == 0", result, {})).toBe(true);
  });
  it("compares fields and literals; malformed degrades to false", () => {
    expect(evaluateCondition("field:a == 'x'", result, { a: "x" })).toBe(true);
    expect(evaluateCondition("nonsense", result, {})).toBe(false);
  });
  it("substitutes placeholders", () => {
    expect(resolveTemplate("No course for ${field:deptid}", result, { deptid: "CS" })).toBe("No course for CS");
  });
});

// The current screen vocabulary: one top-level <events> block, Cypher statements, a nested <execute>.
const screenXml = `<screen id="departmentScreen" title="Department">
  <dataSources><dataSource id="mainDB" type="database"/></dataSources>
  <queries>
    <query id="loadDepartment"><dataSource ref="mainDB"/>
      <statement>MATCH (d:Department) WHERE d.deptid = $deptid RETURN d.deptname AS deptname</statement>
      <parameters><parameter name="deptid" source="field:deptid"/></parameters></query>
    <query id="loadCourses"><dataSource ref="mainDB"/>
      <statement>MATCH (c:Course) WHERE c.deptid = $deptid RETURN c.courseid AS courseid, c.coursename AS coursename</statement>
      <parameters><parameter name="deptid" source="field:deptid"/></parameters></query>
    <query id="saveDept"><dataSource ref="mainDB"/>
      <statement>CREATE (d:Department {deptid: $deptid, deptname: $deptname})</statement>
      <parameters><parameter name="deptid" source="field:deptid"/><parameter name="deptname" source="field:deptname"/></parameters></query>
  </queries>
  <ui>
    <field id="deptid" label="Dept" type="text" persistenceMapping="Department.deptid"/>
    <field id="deptname" label="Name" type="text" persistenceMapping="Department.deptname"/>
    <grid id="courses" label="Courses"><column id="courseid" header="ID" binding="courseid"/></grid>
    <button id="save" label="Save"/>
  </ui>
  <events>
    <event type="change" element="deptid">
      <execute query="loadDepartment">
        <map result="deptname" target="field:deptname"/>
        <when condition="result.count == 0"><message type="error" value="Department not found"/><stop/></when>
        <when condition="result.count > 0">
          <execute query="loadCourses">
            <map result="rows" target="grid:courses"/>
            <when condition="result.count == 0"><message type="info" value="No course available for this department: \${field:deptid}"/></when>
          </execute>
        </when>
      </execute>
    </event>
    <event type="click" element="save">
      <execute query="saveDept"><when condition="result.count > 0"><message type="success" value="Saved"/></when></execute>
    </event>
  </events>
</screen>`;

describe("engine (fake Neo4j executor)", () => {
  const entities = { tables: [{ name: "Department", columns: [{ name: "deptid", type: "VARCHAR(20)" }] }, { name: "Course" }] };
  const executorFor = (data: { dept: boolean; courses: number }): { exec: QueryExecutor; seen: string[] } => {
    const seen: string[] = [];
    const exec: QueryExecutor = async (statement, params) => {
      seen.push(`${statement.split(" ")[0]}:${JSON.stringify(params)}`);
      if (statement.includes("RETURN d.deptname")) return data.dept ? { rows: [{ deptname: "Computer Science" }], count: 1 } : { rows: [], count: 0 };
      if (statement.includes("RETURN c.courseid")) {
        const rows = Array.from({ length: data.courses }, (_, i) => ({ courseid: `C${i}`, coursename: "n" }));
        return { rows, count: rows.length };
      }
      return { rows: [], count: 1 };
    };
    return { exec, seen };
  };

  it("cascades: department -> courses grid", async () => {
    const { exec } = executorFor({ dept: true, courses: 2 });
    const actions = await runEvent(exec, entities, screenXml, "deptid", "change", { deptid: "CS" });
    expect(actions[0]).toEqual({ type: "map", target: "field:deptname", value: "Computer Science" });
    expect(actions.find((a) => a.type === "map" && a.target === "grid:courses")).toMatchObject({ value: [{ courseid: "C0" }, { courseid: "C1" }] });
  });
  it("shows the empty-grid message when the department has no courses", async () => {
    const { exec } = executorFor({ dept: true, courses: 0 });
    const actions = await runEvent(exec, entities, screenXml, "deptid", "change", { deptid: "CS" });
    expect(actions).toContainEqual({ type: "message", messageType: "info", value: "No course available for this department: CS" });
  });
  it("stops after 'not found' without loading courses", async () => {
    const { exec, seen } = executorFor({ dept: false, courses: 5 });
    const actions = await runEvent(exec, entities, screenXml, "deptid", "change", { deptid: "ZZ" });
    expect(actions.at(-1)).toEqual({ type: "stop" });
    expect(seen).toHaveLength(1);
  });
  it("runs a create query with bound parameters", async () => {
    const { exec, seen } = executorFor({ dept: true, courses: 0 });
    const actions = await runEvent(exec, entities, screenXml, "save", "click", { deptid: "ME", deptname: "Mech" });
    expect(actions).toContainEqual({ type: "message", messageType: "success", value: "Saved" });
    expect(seen[0]).toBe('CREATE:{"deptid":"ME","deptname":"Mech"}');
  });
});
