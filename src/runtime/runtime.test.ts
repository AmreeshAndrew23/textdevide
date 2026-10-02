import { beforeEach, describe, expect, it } from "vitest";
import { labelFor, prepareCypher, validateCypherStatic } from "./cypher.js";
import { coerceValue } from "./values.js";
import { evaluateCondition, resolveTemplate, runEvent, type QueryExecutor } from "./engine.js";
import { lintScreenXml } from "../services/aiService.js";
import { parseScreenModel } from "./screenModel.js";
import { renderScreen, THEMES, findScreenForLabel } from "./renderer.js";

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

describe("screenModel", () => {
  const model = parseScreenModel(screenXml);
  it("extracts fields, grid, and buttons in document order", () => {
    expect(model.fields.map((f) => f.id)).toEqual(["deptid", "deptname"]);
    expect(model.grids[0]).toMatchObject({ id: "courses", columns: [{ id: "courseid", header: "ID", binding: "courseid" }] });
    expect(model.buttons.map((b) => b.id)).toEqual(["save"]);
  });
  it("attaches each element's declared event types", () => {
    expect(model.fields.find((f) => f.id === "deptid")?.eventTypes).toEqual(["change"]);
    expect(model.fields.find((f) => f.id === "deptname")?.eventTypes).toEqual([]);
    expect(model.buttons.find((b) => b.id === "save")?.eventTypes).toEqual(["click"]);
  });
});

describe("renderer (server-side HTML)", () => {
  const model = parseScreenModel(screenXml);
  const html = renderScreen(model, { apiBase: "http://localhost:8001", projectId: 42, screenId: "s1", token: "tok123" });

  it("renders one input per field, a grid table, and a wired button", () => {
    expect(html).toContain('id="deptid"');
    expect(html).toContain('id="deptname"');
    expect(html).toContain('data-grid="courses"');
    expect(html).toContain(">ID<"); // grid column header
    expect(html).toContain('id="save" data-button data-click');
  });
  it("only wires a commit event for fields that declare one", () => {
    expect(html).toMatch(/id="deptid"[^>]*data-commit-event="blur"/);
    expect(html).not.toMatch(/id="deptname"[^>]*data-commit-event/);
  });
  it("bakes in the project/screen/token/API base for the client script", () => {
    expect(html).toContain('var API_BASE = "http://localhost:8001"');
    expect(html).toContain("var PROJECT_ID = 42");
    expect(html).toContain('var SCREEN_ID = "s1"');
    expect(html).toContain('var TOKEN = "tok123"');
    expect(html).toContain('"courses":["courseid"]'); // grid column bindings for the client script
  });
  it("falls back to a plain text input for type=select (no options source in this vocabulary)", () => {
    const selectXml = screenXml.replace('<field id="deptname" label="Name" type="text"', '<field id="deptname" label="Name" type="select"');
    const out = renderScreen(parseScreenModel(selectXml), { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(out).toMatch(/id="deptname"[^>]*type="text"|<input type="text" id="deptname"/);
    expect(out).not.toContain("<select");
  });
  it("escapes field/label/hint content so generated screen text can't break out of the HTML", () => {
    const xssXml = screenXml.replace('label="Name"', 'label="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    const out = renderScreen(parseScreenModel(xssXml), { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it("includes navigate handling in the generated client script", () => {
    expect(html).toContain("function navigateUrl(screenId)");
    expect(html).toContain("window.location.href = navigateUrl(navigateTo)");
  });
  it("falls back to sensible defaults when no app shell info is passed", () => {
    expect(html).toContain(">App<"); // default appName
    expect(html).toContain("No other screens yet");
  });
});

describe("renderer: app shell (persistent header + nav across screens)", () => {
  const model = parseScreenModel(screenXml);
  const shellOpts = {
    apiBase: "http://localhost:8001", projectId: 42, screenId: "s1", token: "tok123",
    appName: "Exam Registration", screens: [{ id: "s1", name: "Department" }, { id: "s2", name: "Course" }],
  };
  const html = renderScreen(model, shellOpts);

  it("shows the app name in the top bar", () => {
    expect(html).toContain(">Exam Registration<");
  });
  it("lists every screen in the nav, marking the current one active and not a link", () => {
    expect(html).toMatch(/<span class="app-nav-item active"[^>]*>Department<\/span>/);
    expect(html).not.toMatch(/<a[^>]*>Department<\/a>/);
  });
  it("links every OTHER screen to its real runtime URL with the token", () => {
    expect(html).toContain('href="http://localhost:8001/runtime/projects/42/screens/s2?token=tok123"');
    expect(html).toMatch(/<a class="app-nav-item" href="[^"]+">Course<\/a>/);
  });
  it("a different screen's render shows the identical nav with a different item active", () => {
    const html2 = renderScreen(model, { ...shellOpts, screenId: "s2" });
    expect(html2).toMatch(/<span class="app-nav-item active"[^>]*>Course<\/span>/);
    expect(html2).toMatch(/<a class="app-nav-item" href="[^"]+">Department<\/a>/);
  });
});

// A Login screen (password check via <when>, only navigates to Dashboard on success) plus a
// top-level, query-less <navigate> for "Forgot Password" — the two positions <navigate> is valid in.
const loginScreenXml = `<screen id="loginScreen" title="Login">
  <dataSources><dataSource id="mainDB" type="database"/></dataSources>
  <queries>
    <query id="checkLogin"><dataSource ref="mainDB"/>
      <statement>MATCH (u:User) WHERE u.email = $email AND u.password = $password RETURN count(u) AS count</statement>
      <parameters><parameter name="email" source="field:email"/><parameter name="password" source="field:password"/></parameters></query>
  </queries>
  <ui>
    <field id="email" label="Email" type="email"/>
    <field id="password" label="Password" type="password"/>
    <button id="loginBtn" label="Log In"/>
    <button id="forgotBtn" label="Forgot Password?"/>
  </ui>
  <events>
    <event type="click" element="loginBtn">
      <execute query="checkLogin">
        <when condition="result.count == 0"><message type="error" value="Invalid credentials"/><stop/></when>
        <when condition="result.count > 0"><navigate screen="dash1"/></when>
      </execute>
    </event>
    <event type="click" element="forgotBtn">
      <navigate screen="Forgot Password"/>
    </event>
  </events>
</screen>`;

describe("engine: <navigate>", () => {
  const entities = { tables: [{ name: "User" }] };
  const siblings = [{ id: "dash1", name: "Dashboard" }, { id: "fp1", name: "Forgot Password" }];
  const exec: QueryExecutor = async (statement) =>
    statement.includes("count(u)") ? { rows: [{ count: 1 }], count: 1 } : { rows: [], count: 0 };

  it("resolves a top-level, query-less navigate by name", async () => {
    const actions = await runEvent(exec, entities, loginScreenXml, "forgotBtn", "click", {}, siblings);
    expect(actions).toEqual([{ type: "navigate", screenId: "fp1", screenName: "Forgot Password" }]);
  });

  it("only navigates (by id) after a <when> condition matches", async () => {
    const actions = await runEvent(exec, entities, loginScreenXml, "loginBtn", "click", { email: "a@b.com", password: "x" }, siblings);
    expect(actions.at(-1)).toEqual({ type: "navigate", screenId: "dash1", screenName: "Dashboard" });
  });

  it("does not navigate when the guarding condition fails", async () => {
    const failExec: QueryExecutor = async () => ({ rows: [{ count: 0 }], count: 1 });
    const actions = await runEvent(failExec, entities, loginScreenXml, "loginBtn", "click", { email: "a@b.com", password: "wrong" }, siblings);
    expect(actions.some((a) => a.type === "navigate")).toBe(false);
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Invalid credentials" });
  });

  it("degrades to an error message instead of navigating nowhere when the target no longer exists", async () => {
    const actions = await runEvent(exec, entities, loginScreenXml, "forgotBtn", "click", {}, [{ id: "dash1", name: "Dashboard" }]);
    expect(actions).toEqual([{ type: "message", messageType: "error", value: "That screen isn't available right now." }]);
  });

  it("treats a missing siblingScreens argument the same as an empty project (degrades, never throws)", async () => {
    const actions = await runEvent(exec, entities, loginScreenXml, "forgotBtn", "click", {});
    expect(actions[0].type).toBe("message");
  });
});

describe("renderer: per-project theme", () => {
  const model = parseScreenModel(screenXml);
  const render = (theme?: string | null) => renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s1", token: "t", theme });

  it("applies each named theme's real primary color", () => {
    for (const [key, palette] of Object.entries(THEMES)) {
      const html = render(key);
      expect(html).toContain(`--clr-primary: ${palette.primary};`);
      expect(html).toContain(`--clr-secondary: ${palette.secondary};`);
    }
  });
  it("falls back to the default (indigo) theme when unset or unrecognized", () => {
    expect(render(undefined)).toContain(`--clr-primary: ${THEMES.indigo.primary};`);
    expect(render(null)).toContain(`--clr-primary: ${THEMES.indigo.primary};`);
    expect(render("not-a-real-theme")).toContain(`--clr-primary: ${THEMES.indigo.primary};`);
  });
  const bodyTag = (html: string) => /<body [^>]*>/.exec(html)![0];

  it("each of the six presets is a genuinely different layout, not just a recolor", () => {
    const signatures = new Set(Object.keys(THEMES).map((k) => bodyTag(render(k))));
    expect(signatures.size).toBe(6);
    const colors = new Set(Object.values(THEMES).map((t) => t.primary));
    expect(colors.size).toBe(6);
  });
  it("carries each preset's distinguishing structural markers", () => {
    expect(bodyTag(render("rose"))).toContain('data-nav="top"'); // Editorial: top nav, not a sidebar
    expect(bodyTag(render("indigo"))).toContain('data-nav="left"');
    expect(bodyTag(render("slate"))).toContain('data-fields="inline"'); // Enterprise: label-left forms
    expect(bodyTag(render("slate"))).toContain('data-toolbar="sticky"');
    expect(bodyTag(render("amber"))).toContain('data-header="light"'); // Warm: light header
    expect(bodyTag(render("emerald"))).toContain('data-card="border"'); // Clinical: borders, no shadows
    expect(bodyTag(render("ocean"))).toContain('data-mono="true"'); // Precision: monospace numerics
    expect(bodyTag(render("ocean"))).toContain('data-density="compact"');
    expect(render("amber")).toContain("--radius: 16px;");
    expect(render("slate")).toContain("--radius: 4px;");
  });
  it("the page body markup and client script are identical across presets — only the <body> attributes and CSS vary", () => {
    const fromHeader = (html: string) => html.slice(html.indexOf('<header class="app-topbar">'));
    const base = fromHeader(render("indigo"));
    for (const key of Object.keys(THEMES)) expect(fromHeader(render(key))).toBe(base);
  });
  it("every preset still renders every hook the engine/client script depend on", () => {
    for (const key of Object.keys(THEMES)) {
      const html = render(key);
      for (const hook of ["data-field=", "data-grid=", "data-button", 'id="screen-messages"', "GRID_COLUMNS", 'class="app-nav"', "run-event"]) {
        expect(html, `${key} missing ${hook}`).toContain(hook);
      }
    }
  });
});

describe("engine: unconditional nested steps and save feedback", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="ins"><statement>CREATE (s:Student {studentid: $id})</statement><parameters><parameter name="id" source="field:idField"/></parameters></query>
    <query id="list"><statement>MATCH (s:Student) RETURN s.studentid AS studentid</statement></query>
    <query id="del"><statement>MATCH (s:Student) WHERE s.studentid = $id DELETE s</statement><parameters><parameter name="id" source="field:idField"/></parameters></query>
  </queries>
  <ui><field id="idField" label="Id" type="text"/><button id="save" label="Save"/><button id="remove" label="Delete"/><grid id="g" label="G"><column id="c" header="Id" binding="studentid" persistenceMapping="Student.studentid"/></grid></ui>
  <events>
    <event type="click" element="save">
      <execute query="ins"><execute query="list"><map result="rows" target="grid:g"/></execute></execute>
    </event>
    <event type="click" element="remove"><execute query="del"/></event>
    <event type="load" element="s"><execute query="list"><map result="rows" target="grid:g"/></execute></event>
  </events>
</screen>`;
  const exec: QueryExecutor = async (statement) =>
    statement.startsWith("MATCH (s:Student) RETURN") ? { rows: [{ studentid: 1 }], count: 1 } : { rows: [], count: 0 };
  const entities = { tables: [{ name: "Student", columns: [{ name: "studentid", type: "INT" }] }] };

  it("runs an <execute> nested directly inside another <execute> (insert, then reload the grid)", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { idField: "1" });
    expect(actions).toContainEqual({ type: "map", target: "grid:g", value: [{ studentid: 1 }] });
  });
  it("confirms a save that wrote data but declared no message", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { idField: "1" });
    expect(actions).toContainEqual({ type: "message", messageType: "success", value: "Saved successfully." });
  });
  it("confirms a delete", async () => {
    const actions = await runEvent(exec, entities, xml, "remove", "click", { idField: "1" });
    expect(actions).toContainEqual({ type: "message", messageType: "success", value: "Deleted successfully." });
  });
  it("adds no confirmation for a read-only event", async () => {
    const actions = await runEvent(exec, entities, xml, "s", "load", {});
    expect(actions).toEqual([{ type: "map", target: "grid:g", value: [{ studentid: 1 }] }]);
  });
  it("model exposes load events and grid column persistence mappings; page fires them on open", () => {
    const model = parseScreenModel(xml);
    expect(model.loadElements).toEqual(["s"]);
    expect(model.grids[0].columns[0].persistenceMapping).toBe("Student.studentid");
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('var LOAD_ELEMENTS = ["s"];');
    expect(html).toContain('"g":["Student.studentid"]');
  });
});

describe("renderer: buttons that name another screen become links", () => {
  const screens = [
    { id: "s_login", name: "Login Screen" },
    { id: "s_dash", name: "Dashboard" },
    { id: "s_reset", name: "Forgot Password" },
    { id: "s_cur", name: "Current" },
  ];
  it("matches a label containing a screen's name, ignoring case, punctuation and 'Screen'/'Page' suffixes", () => {
    expect(findScreenForLabel("Go to Dashboard", screens, "s_cur")?.id).toBe("s_dash");
    expect(findScreenForLabel("Forgot Password?", screens, "s_cur")?.id).toBe("s_reset");
    expect(findScreenForLabel("Back to Login", screens, "s_cur")?.id).toBe("s_login");
  });
  it("does not match partial words, unrelated labels, or the current screen itself", () => {
    expect(findScreenForLabel("Dash", screens, "s_cur")).toBeNull();
    expect(findScreenForLabel("Save", screens, "s_cur")).toBeNull();
    expect(findScreenForLabel("Dashboard", screens, "s_dash")).toBeNull();
  });
  it("prefers the longest matching screen name", () => {
    const list = [{ id: "a", name: "Student" }, { id: "b", name: "Student Registration" }];
    expect(findScreenForLabel("Open Student Registration", list, "x")?.id).toBe("b");
  });

  const xml = `<screen id="cur" title="Cur"><ui>
    <field id="f" label="F" type="text"/>
    <button id="toDash" label="Go to Dashboard"/>
    <button id="save" label="Save Dashboard"/>
  </ui><events><event type="click" element="save"><execute query="q"/></event></events></screen>`;
  it("wires only handler-less buttons; a button with its own click event is never hijacked", () => {
    const html = renderScreen(parseScreenModel(xml), { apiBase: "http://x", projectId: 1, screenId: "cur", token: "t", screens });
    expect(html).toMatch(/id="toDash" data-button data-nav-href="http:\/\/x\/runtime\/projects\/1\/screens\/s_dash\?token=t"/);
    expect(html).toMatch(/id="save" data-button data-click class=/);
    expect(html).not.toMatch(/id="save"[^>]*data-nav-href/);
  });
});

describe("engine: server-side field validation (before any write query runs)", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="ins"><statement>CREATE (s:Student {regNo: $regNo, email: $email, age: $age})</statement>
      <parameters><parameter name="regNo" source="field:regNo"/><parameter name="email" source="field:email"/><parameter name="age" source="field:age"/></parameters></query>
    <query id="search"><statement>MATCH (s:Student) WHERE toLower(s.firstName) CONTAINS toLower($q) RETURN s.regNo AS regNo</statement>
      <parameters><parameter name="q" source="field:q"/></parameters></query>
  </queries>
  <ui>
    <field id="regNo" label="Reg No" type="text"><rule required="true" maxLength="6"/></field>
    <field id="email" label="Email" type="email"><rule required="true"/></field>
    <field id="age" label="Age" type="number"><rule minValue="1" maxValue="120"/></field>
    <field id="q" label="Search" type="text"/>
    <button id="save" label="Save"/>
    <button id="search" label="Search"/>
    <grid id="g" label="G"><column id="a" header="Id" binding="regNo"/></grid>
  </ui>
  <events>
    <event type="click" element="save"><execute query="ins"/></event>
    <event type="change" element="q"><execute query="search"><map result="rows" target="grid:g"/></execute></event>
  </events>
</screen>`;
  const entities = { tables: [{ name: "Student", columns: [{ name: "regNo", type: "VARCHAR(6)" }] }] };
  let seen: string[] = [];
  const exec: QueryExecutor = async (statement, params) => {
    seen.push(statement.split(" ")[0]);
    return { rows: [], count: 0 };
  };
  beforeEach(() => { seen = []; });

  it("blocks a save with an empty required field and never runs the write query", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { regNo: "", email: "a@b.com", age: "20" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Reg No is required." });
    expect(seen).toEqual([]);
  });
  it("blocks an invalid email and a too-long value, with meaningful separate messages", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { regNo: "TOOLONG1", email: "not-an-email", age: "20" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Email must be a valid email address." });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Reg No must be at most 6 characters." });
    expect(seen).toEqual([]);
  });
  it("blocks an out-of-range number with a meaningful message", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { regNo: "R1", email: "a@b.com", age: "999" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Age must be at most 120." });
    expect(seen).toEqual([]);
  });
  it("a valid save runs the write query with no validation messages", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { regNo: "R1", email: "a@b.com", age: "20" });
    expect(actions.filter((a) => a.type === "message" && a.messageType === "error")).toEqual([]);
    expect(seen).toEqual(["CREATE"]);
  });
  it("never validates fields for a read-only event, even with an empty required field elsewhere on the screen", async () => {
    const actions = await runEvent(exec, entities, xml, "q", "change", { regNo: "", email: "", age: "", q: "ar" });
    expect(actions.filter((a) => a.type === "message" && a.messageType === "error")).toEqual([]);
    expect(seen).toEqual(["MATCH"]);
  });
});

describe("screenModel + renderer: real <select> dropdowns", () => {
  const xml = `<screen id="s" title="S"><ui>
    <field id="course" label="Course" type="select"><option value="" label="All"/><option value="CSE" label="CSE"/></field>
    <field id="plain" label="Plain" type="select"/>
  </ui><events/></screen>`;
  const model = parseScreenModel(xml);
  it("parses <option> children into FieldItem.options", () => {
    expect(model.fields.find((f) => f.id === "course")?.options).toEqual([{ value: "", label: "All" }, { value: "CSE", label: "CSE" }]);
    expect(model.fields.find((f) => f.id === "plain")?.options).toEqual([]);
  });
  it("renders a real <select> with options, and falls back to a text input with none", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<select id="course" name="course">');
    expect(html).toContain('<option value="">All</option><option value="CSE">CSE</option></select>');
    expect(html).toMatch(/<input type="text" id="plain"/);
  });
});

describe("screenModel + renderer: grid row actions (edit/delete)", () => {
  const xml = `<screen id="s" title="S"><ui>
    <field id="regNo" label="Reg No" type="text" persistenceMapping="Student.regNo"/>
    <button id="deleteBtn" label="Delete" style="danger"/>
    <grid id="g" label="Students">
      <column id="a" header="Reg No" binding="regNo" persistenceMapping="Student.regNo"/>
      <actions><action type="edit"/><action type="delete" target="deleteBtn" confirm="Really delete?"/></actions>
    </grid>
  </ui><events><event type="click" element="deleteBtn"><execute query="q"/></event></events></screen>`;
  const model = parseScreenModel(xml);
  it("parses the <actions> block", () => {
    expect(model.grids[0].actions).toEqual([{ type: "edit" }, { type: "delete", target: "deleteBtn", confirm: "Really delete?" }]);
  });
  it("renders an Actions column header and bakes GRID_ACTIONS for the client script", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<th class="actions-col">Actions</th>');
    expect(html).toContain('var GRID_ACTIONS = {"g":[{"type":"edit"},{"type":"delete","target":"deleteBtn","confirm":"Really delete?"}]};');
    expect(html).toContain("data-row-delete");
    expect(html).toContain("data-row-target");
  });
  it("a grid with no <actions> renders no Actions column and an empty GRID_ACTIONS entry", () => {
    const plain = parseScreenModel(`<screen id="s2" title="S"><ui><grid id="g2" label="G"><column id="a" header="A" binding="a"/></grid></ui><events/></screen>`);
    const html = renderScreen(plain, { apiBase: "x", projectId: 1, screenId: "s2", token: "t" });
    expect(html).not.toContain('<th class="actions-col">');
    expect(html).toContain("var GRID_ACTIONS = {};");
  });
});

describe("screenModel + renderer: field default values", () => {
  const xml = `<screen id="s" title="S"><ui>
    <field id="skip" label="Skip" type="number" default="0"/>
    <field id="pageSize" label="Page Size" type="number" default="20"/>
    <field id="sortDir" label="Sort" type="select" default="desc"><option value="asc" label="Asc"/><option value="desc" label="Desc"/></field>
    <field id="active" label="Active" type="checkbox" default="true"/>
    <field id="name" label="Name" type="text"/>
  </ui><events/></screen>`;
  const model = parseScreenModel(xml);
  it("parses the default attribute", () => {
    expect(model.fields.find((f) => f.id === "skip")?.defaultValue).toBe("0");
    expect(model.fields.find((f) => f.id === "name")?.defaultValue).toBeNull();
  });
  it("bakes the default into the rendered control so the first load has real values to bind", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<input type="number" id="skip" name="skip" value="0">');
    expect(html).toContain('<input type="number" id="pageSize" name="pageSize" value="20">');
    expect(html).toContain('<option value="desc" selected>Desc</option>');
    expect(html).not.toContain('<option value="asc" selected>');
    expect(html).toContain('<input type="checkbox" id="active" name="active" checked>');
    expect(html).toContain('<input type="text" id="name" name="name">');
  });
});

describe("engine: numeric fields with no persistenceMapping are coerced before binding", () => {
  const xml = `<screen id="s" title="S">
  <queries><query id="page"><statement>MATCH (s:Student) RETURN s.regNo AS regNo SKIP $skip LIMIT $pageSize</statement>
    <parameters><parameter name="skip" source="field:skip"/><parameter name="pageSize" source="field:pageSize"/></parameters></query></queries>
  <ui><field id="skip" label="Skip" type="number" default="0"/><field id="pageSize" label="Page Size" type="number" default="20"/>
    <grid id="g" label="G"><column id="a" header="A" binding="regNo"/></grid></ui>
  <events><event type="load" element="s"><execute query="page"><map result="rows" target="grid:g"/></execute></event></events>
</screen>`;
  const entities = {};
  it("sends real numbers (not the browser's string input values) as $skip/$pageSize", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    // Exactly what a real browser's allFieldValues() sends: <input type="number">.value is always a string.
    await runEvent(exec, entities, xml, "s", "load", { skip: "0", pageSize: "20" });
    expect(seenParams).toEqual({ skip: 0, pageSize: 20 });
    expect(typeof seenParams.skip).toBe("number");
  });
});
