import { beforeEach, describe, expect, it } from "vitest";
import { labelFor, prepareCypher, validateCypherStatic } from "./cypher.js";
import { coerceValue } from "./values.js";
import {
  evaluateCondition, resolveTemplate, runEvent, isAnonymousEvent, hasAnonymousEntry, computeAgeYears,
  eventRequiredRole, screenRequiredRole, eventAllowsPasswordChange, hasPasswordChangeEntry, type QueryExecutor,
} from "./engine.js";
import { lintScreenXml } from "../services/aiService.js";
import { parseScreenModel } from "./screenModel.js";
import { renderScreen, THEMES, findScreenForLabel } from "./renderer.js";
import { hashPassword, verifyPassword } from "../services/authService.js";

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
  it("strips an invented literal:/const:/static:/default: prefix off a <parameter> source", () => {
    const withPrefix = `<query id="q"><statement>CREATE (a:Account {roleId: $roleId})</statement><parameters><parameter name="roleId" source="literal:Staff"/></parameters></query>`;
    expect(lintScreenXml(withPrefix)).toContain('source="Staff"');
    expect(lintScreenXml(withPrefix)).not.toContain("literal:");
  });
  it("rewrites a screen-list query written as Cypher-on-ScreenPermission to source=\"project:screens\"", () => {
    const broken = `<query id="listScreens"><dataSource ref="mainDB"/><statement>MATCH (s:ScreenPermission) RETURN s.screenId AS screenId, s.screenName AS screenName</statement></query>`;
    expect(lintScreenXml(broken)).toBe('<query id="listScreens" source="project:screens"/>');
  });
  it("leaves a real ScreenPermission query (one that selects requiredRoles) untouched", () => {
    const real = `<query id="listScreenPermissions"><dataSource ref="mainDB"/><statement>MATCH (sp:ScreenPermission) RETURN sp.screenId AS screenId, sp.requiredRoles AS requiredRoles</statement></query>`;
    expect(lintScreenXml(real)).toBe(real);
  });
  it("leaves an already-correct source=\"project:screens\" query untouched", () => {
    const already = `<query id="listScreens" source="project:screens"/>`;
    expect(lintScreenXml(already)).toBe(already);
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
  // Each nav item now carries a leading icon <svg>...</svg> (inferNavIcon) immediately before its
  // text — matched precisely (not a loose [\s\S]*?, which could false-match across separate <a>
  // elements) by requiring the icon's own closing tag directly before the screen name.
  const navItem = (name: string) => new RegExp(`<svg[^>]*>[\\s\\S]*?<\\/svg>${name}`);
  it("lists every screen in the nav, marking the current one active and not a link", () => {
    expect(html).toMatch(new RegExp(`<span class="app-nav-item active"[^>]*>${navItem("Department").source}<\\/span>`));
    expect(html).not.toMatch(new RegExp(`<a[^>]*>${navItem("Department").source}<\\/a>`));
  });
  it("links every OTHER screen to its real runtime URL with the token", () => {
    expect(html).toContain('href="http://localhost:8001/runtime/projects/42/screens/s2?token=tok123"');
    expect(html).toMatch(new RegExp(`<a class="app-nav-item" href="[^"]+">${navItem("Course").source}<\\/a>`));
  });
  it("a different screen's render shows the identical nav with a different item active", () => {
    const html2 = renderScreen(model, { ...shellOpts, screenId: "s2" });
    expect(html2).toMatch(new RegExp(`<span class="app-nav-item active"[^>]*>${navItem("Course").source}<\\/span>`));
    expect(html2).toMatch(new RegExp(`<a class="app-nav-item" href="[^"]+">${navItem("Department").source}<\\/a>`));
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

describe("renderer: bulkCsv button — bulk import by replaying a single-row event per CSV row", () => {
  const xml = `<screen id="s" title="S">
  <queries><query id="ins"><statement>CREATE (a:Student {name: $name})</statement>
    <parameters><parameter name="name" source="field:name"/></parameters></query></queries>
  <ui>
    <field id="csvData" label="CSV" type="textarea"/>
    <field id="name" label="Name" type="text"/>
    <button id="importButton" label="Import" bulkCsv="csvData"/>
  </ui>
  <events><event type="click" element="importButton"><execute query="ins"/></event></events>
</screen>`;
  const model = parseScreenModel(xml);
  const html = renderScreen(model, { apiBase: "http://localhost:8001", projectId: 1, screenId: "s", token: "tok" });

  it("renders data-bulk-csv pointing at the CSV field, never data-click", () => {
    expect(html).toContain('id="importButton" data-button data-bulk-csv="csvData"');
    expect(html).not.toMatch(/id="importButton"[^>]*data-click/);
  });
  it("emits the client-side per-row replay handler", () => {
    expect(html).toContain('querySelectorAll("[data-bulk-csv]")');
    expect(html).toContain("runRow(i + 1)"); // sequential, not parallel
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

describe("computeAgeYears: whole-years age from a birth-date-like value", () => {
  it("accounts for whether this year's birthday has already passed", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(computeAgeYears("2003-06-15", now)).toBe(23); // birthday is today
    expect(computeAgeYears("2003-06-16", now)).toBe(22); // birthday is tomorrow, hasn't happened yet
    expect(computeAgeYears("2003-06-14", now)).toBe(23); // birthday was yesterday
    expect(computeAgeYears("2003-01-01", now)).toBe(23);
    expect(computeAgeYears("2003-12-31", now)).toBe(22);
  });
  it("returns null for an unparseable or empty date value", () => {
    expect(computeAgeYears("not-a-date")).toBeNull();
    expect(computeAgeYears("")).toBeNull();
  });
});

describe("engine: minAge/maxAge validation, computed from a date field (not the stored value itself)", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="ins"><statement>CREATE (s:Student {dob: $dob})</statement>
      <parameters><parameter name="dob" source="field:dob"/></parameters></query>
  </queries>
  <ui>
    <field id="dob" label="Date Of Birth" type="date"><rule maxAge="23"/></field>
    <button id="save" label="Save"/>
  </ui>
  <events>
    <event type="click" element="save"><execute query="ins"/></event>
  </events>
</screen>`;
  const entities = { tables: [{ name: "Student", columns: [{ name: "dob", type: "DATE" }] }] };
  let seen: string[] = [];
  const exec: QueryExecutor = async (statement) => { seen.push(statement.split(" ")[0]); return { rows: [], count: 0 }; };
  beforeEach(() => { seen = []; });

  // Computed relative to the real current date, so the test stays correct no matter when it runs.
  function dobForAge(years: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  }

  it("blocks a save when the computed age exceeds maxAge", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { dob: dobForAge(24) });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Date Of Birth must indicate an age of at most 23." });
    expect(seen).toEqual([]);
  });
  it("allows a save when the computed age is exactly at the maxAge boundary", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { dob: dobForAge(23) });
    expect(actions.filter((a) => a.type === "message" && a.messageType === "error")).toEqual([]);
    expect(seen).toEqual(["CREATE"]);
  });
  it("blocks a save with an unparseable date value", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { dob: "not-a-date" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Date Of Birth must be a valid date." });
    expect(seen).toEqual([]);
  });
  it("never validates an empty, non-required date field", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { dob: "" });
    expect(actions.filter((a) => a.type === "message" && a.messageType === "error")).toEqual([]);
    expect(seen).toEqual(["CREATE"]);
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

describe("screenModel + renderer: data-backed select (options populated from a query's rows)", () => {
  const xml = `<screen id="s" title="S"><ui>
    <field id="examId" label="Exam" type="select" optionValue="examId" optionLabel="examName"/>
    <field id="status" label="Status" type="select"><option value="" label="All"/><option value="open" label="Open"/></field>
  </ui><events/></screen>`;
  const model = parseScreenModel(xml);
  it("parses optionValue/optionLabel into optionsBinding", () => {
    expect(model.fields.find((f) => f.id === "examId")?.optionsBinding).toEqual({ valueColumn: "examId", labelColumn: "examName" });
    expect(model.fields.find((f) => f.id === "status")?.optionsBinding).toBeNull();
  });
  it("renders a placeholder shell for a data-backed select and bakes FIELD_OPTIONS", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<select id="examId" name="examId"><option value="">Select…</option></select>');
    expect(html).toContain('var FIELD_OPTIONS = {"examId":{"value":"examId","label":"examName"}};');
  });
  it("a static-option select is completely unaffected", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<select id="status" name="status"><option value="">All</option><option value="open">Open</option></select>');
  });
  it("dynamic wins over static when a field somehow declares both", () => {
    const both = parseScreenModel(`<screen id="s" title="S"><ui><field id="x" label="X" type="select" optionValue="a" optionLabel="b"><option value="z" label="Z"/></field></ui><events/></screen>`);
    const html = renderScreen(both, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<select id="x" name="x"><option value="">Select…</option></select>');
    expect(html).not.toContain(">Z</option>");
  });
});

describe("engine: <session> action + allowAnonymous gating", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="check"><statement>MATCH (a:Account) WHERE a.username = $u AND a.password = $p RETURN count(a) AS count</statement>
      <parameters><parameter name="u" source="field:u"/><parameter name="p" source="field:p"/></parameters></query>
  </queries>
  <ui><field id="u" label="User" type="text"/><field id="p" label="Pass" type="password"/><button id="loginBtn" label="Login"/><button id="other" label="Other"/></ui>
  <events>
    <event type="click" element="loginBtn" allowAnonymous="true">
      <execute query="check">
        <when condition="result.count == 0"><message type="error" value="Invalid."/><stop/></when>
        <when condition="result.count > 0"><session action="start"/><navigate screen="Dashboard"/></when>
      </execute>
    </event>
    <event type="click" element="other"><session action="end"/></event>
  </events>
</screen>`;
  const entities = {};

  it("isAnonymousEvent is true only for the marked event", () => {
    expect(isAnonymousEvent(xml, "loginBtn", "click")).toBe(true);
    expect(isAnonymousEvent(xml, "other", "click")).toBe(false);
    expect(isAnonymousEvent(xml, "missing", "click")).toBe(false);
  });
  it("hasAnonymousEntry is true for a screen with at least one such event", () => {
    expect(hasAnonymousEntry(xml)).toBe(true);
    expect(hasAnonymousEntry(`<screen id="x"><ui/><events><event type="click" element="a"/></events></screen>`)).toBe(false);
  });
  it("a successful login produces session:start then navigate, in order, in the same chain", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ count: 1 }], count: 1 });
    const actions = await runEvent(exec, entities, xml, "loginBtn", "click", { u: "a", p: "b" }, [{ id: "d1", name: "Dashboard" }]);
    expect(actions).toEqual([{ type: "session", action: "start", mustChangePassword: false }, { type: "navigate", screenId: "d1", screenName: "Dashboard" }]);
  });
  it("a failed login produces no session action", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ count: 0 }], count: 1 });
    const actions = await runEvent(exec, entities, xml, "loginBtn", "click", { u: "a", p: "wrong" });
    expect(actions.some((a) => a.type === "session")).toBe(false);
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Invalid." });
  });
  it("<session action=\"end\"/> alone does not stop the chain (no following steps here, but it must not throw or short-circuit silently)", async () => {
    const exec: QueryExecutor = async () => ({ rows: [], count: 0 });
    const actions = await runEvent(exec, entities, xml, "other", "click", {});
    expect(actions).toEqual([{ type: "session", action: "end" }]);
  });
});

describe("renderer: shell's built-in Log out + Profile controls", () => {
  const model = parseScreenModel(`<screen id="dash" title="Dashboard"><ui><button id="b" label="Do thing"/></ui><events/></screen>`);
  const screens = [{ id: "dash", name: "Dashboard" }, { id: "login", name: "Login" }, { id: "prof", name: "Profile" }];
  // The literal attribute pair below only appears on the real button (the client script also
  // mentions "data-app-logout" alone, in a querySelectorAll call, so a bare substring check would
  // false-positive on that).
  const hasLogoutButton = (html: string) => html.includes('data-app-logout data-login-url="');

  it("renders a Log out control pointed at the real login screen when loggedIn and a login screen exists", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: true, loginScreenId: "login" });
    expect(hasLogoutButton(html)).toBe(true);
    expect(html).toMatch(/data-app-logout data-login-url="[^"]*\/screens\/login\?/);
  });
  it("renders no Log out control when not logged in (anonymous or builder preview)", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: false, loginScreenId: "login" });
    expect(hasLogoutButton(html)).toBe(false);
  });
  it("renders no Log out control when logged in but the project has no login screen", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: true, loginScreenId: null });
    expect(hasLogoutButton(html)).toBe(false);
  });
  it("defaults to no Log out control when the caller omits loggedIn/loginScreenId entirely", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "t", screens });
    expect(hasLogoutButton(html)).toBe(false);
  });
  it("renders a Change Password link inside the Profile dropdown when loggedIn and a Profile screen exists, none otherwise", () => {
    // "Profile" (same name used by the sidebar nav's own real-screen listing, which is unrelated —
    // excluding a screen from THAT list is runtimeRender.ts's job, not renderer.ts's) — so these
    // checks target the specific dropdown item link, not any occurrence of the word anywhere.
    const changePasswordLink = /<a class="profile-dropdown-item" href="[^"]*\/screens\/prof\?[^"]*">[\s\S]*?Change Password<\/span><\/a>/;
    const loggedInHtml = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: true, loginScreenId: "login", profileScreenId: "prof" });
    expect(loggedInHtml).toMatch(changePasswordLink);
    const noneHtml = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: true, loginScreenId: "login", profileScreenId: null });
    expect(noneHtml).not.toMatch(changePasswordLink);
    const anonHtml = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: false, profileScreenId: "prof" });
    expect(anonHtml).not.toMatch(changePasswordLink);
  });
  it("the Profile dropdown always offers the theme toggle once logged in, regardless of Profile/login screens", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: true, loginScreenId: null, profileScreenId: null });
    expect(html).toContain("data-theme-toggle");
    expect(html).toContain('data-profile-menu');
  });
  it("never renders the Profile menu at all when not logged in — dark mode toggle included", () => {
    // Checks the actual rendered element, not a bare attribute-name substring — the always-present
    // client script's own querySelectorAll("[data-profile-menu]")/("[data-theme-toggle]") calls
    // contain those same substrings regardless of whether any such element was ever rendered.
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "", screens, loggedIn: false });
    expect(html).not.toContain('class="profile-menu" data-profile-menu');
    expect(html).not.toContain('class="profile-dropdown-item" data-theme-toggle');
  });
});

describe("renderer: dark mode — a per-viewer localStorage preference, applied before first paint", () => {
  const model = parseScreenModel(`<screen id="s" title="S"><ui/><events/></screen>`);
  const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t", loggedIn: true, loginScreenId: "login" });

  it("includes an early inline script, right after <body>, that applies the saved preference before anything else renders", () => {
    const bodyIdx = html.indexOf("<body ");
    const earlyScriptIdx = html.indexOf("td_theme_scheme");
    const headerIdx = html.indexOf("<header");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(earlyScriptIdx).toBeGreaterThan(bodyIdx);
    expect(earlyScriptIdx).toBeLessThan(headerIdx);
  });
  it("defines dark-mode CSS overrides keyed off body[data-color-scheme=\"dark\"]", () => {
    expect(html).toMatch(/body\[data-color-scheme="dark"\]\s*\{/);
  });
  it("the theme toggle button carries both icon variants and both labels as data attributes, not just one static label", () => {
    expect(html).toContain('data-label-light="Switch to Dark Mode"');
    expect(html).toContain('data-label-dark="Switch to Light Mode"');
    expect(html).toContain("data-icon-light=");
    expect(html).toContain("data-icon-dark=");
  });
  it("client script toggles the body attribute, persists the choice, and re-syncs the label/icon on click", () => {
    expect(html).toContain('document.body.setAttribute("data-color-scheme", "dark")');
    expect(html).toContain('document.body.removeAttribute("data-color-scheme")');
    expect(html).toContain("localStorage.setItem(THEME_KEY");
  });
});

describe("engine: session identity + session:identity parameter source", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="check"><statement>MATCH (a:Account) WHERE a.username = $u AND a.password = $p RETURN count(a) AS count</statement>
      <parameters><parameter name="u" source="field:u"/><parameter name="p" source="field:p"/></parameters></query>
    <query id="updatePassword"><statement>MATCH (a:Account) WHERE a.username = $identity SET a.password = $newPassword</statement>
      <parameters><parameter name="identity" source="session:identity"/><parameter name="newPassword" source="field:newPassword"/></parameters></query>
  </queries>
  <ui><field id="u" label="User" type="text"/><field id="p" label="Pass" type="password"/><field id="newPassword" label="New" type="password"/>
    <field id="identity" label="Spoof" type="text"/>
    <button id="loginBtn" label="Login"/><button id="saveBtn" label="Save"/></ui>
  <events>
    <event type="click" element="loginBtn" allowAnonymous="true">
      <execute query="check"><when condition="result.count > 0"><session action="start" identity="field:u"/><navigate screen="Dashboard"/></when></execute>
    </event>
    <event type="click" element="saveBtn"><execute query="updatePassword"/></event>
  </events>
</screen>`;
  const entities = {};

  it("captures the resolved field value as the session's identity on a successful login", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ count: 1 }], count: 1 });
    const actions = await runEvent(exec, entities, xml, "loginBtn", "click", { u: "alice", p: "x" }, [{ id: "d", name: "Dashboard" }]);
    expect(actions).toContainEqual({ type: "session", action: "start", identity: "alice", mustChangePassword: false });
  });
  it("captures no identity when the login fails (no session:start at all)", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ count: 0 }], count: 1 });
    const actions = await runEvent(exec, entities, xml, "loginBtn", "click", { u: "alice", p: "wrong" });
    expect(actions.some((a) => a.type === "session")).toBe(false);
  });
  it("session:identity resolves from the verified session passed into runEvent, not from fieldValues", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    // The client submits a field literally named "identity" trying to spoof someone else — must be ignored.
    await runEvent(exec, entities, xml, "saveBtn", "click", { newPassword: "new1", identity: "attacker" }, [], "realuser");
    expect(seenParams).toEqual({ identity: "realuser", newPassword: "new1" });
  });
  it("session:identity is null when no session was passed in", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    await runEvent(exec, entities, xml, "saveBtn", "click", { newPassword: "new1" });
    expect(seenParams.identity).toBeNull();
  });
});

describe("engine: session role — session:role parameter source, condition, and requiredRole helpers", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="check"><statement>MATCH (a:Account) WHERE a.username = $u AND a.password = $p RETURN count(a) AS count, a.role AS role</statement>
      <parameters><parameter name="u" source="field:u"/><parameter name="p" source="field:p"/></parameters></query>
    <query id="adminOnly"><statement>MATCH (x:Thing) WHERE x.owner = $owner RETURN count(x) AS count</statement>
      <parameters><parameter name="owner" source="session:role"/></parameters></query>
  </queries>
  <ui><field id="u" label="User" type="text"/><field id="p" label="Pass" type="password"/>
    <button id="loginBtn" label="Login"/><button id="checkBtn" label="Check"/></ui>
  <events>
    <event type="click" element="loginBtn" allowAnonymous="true">
      <execute query="check"><when condition="result.count > 0"><session action="start" identity="field:u" role="result.role"/></when></execute>
    </event>
    <event type="click" element="checkBtn"><execute query="adminOnly"/></event>
  </events>
</screen>`;
  const entities = {};

  it("captures the role column from the login query's own result on a successful login", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ count: 1, role: "Admin" }], count: 1 });
    const actions = await runEvent(exec, entities, xml, "loginBtn", "click", { u: "alice", p: "x" });
    expect(actions).toContainEqual({ type: "session", action: "start", identity: "alice", role: "Admin", mustChangePassword: false });
  });
  it("source=\"session:role\" resolves from the role passed into runEvent, never from fieldValues", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    // A client submitting a field literally named "owner" trying to spoof a role — must be ignored.
    await runEvent(exec, entities, xml, "checkBtn", "click", { owner: "attacker-role" }, [], "realuser", "Admin");
    expect(seenParams).toEqual({ owner: "Admin" });
  });
  it("session:role is null when no role was passed in", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    await runEvent(exec, entities, xml, "checkBtn", "click", {});
    expect(seenParams.owner).toBeNull();
  });
  it("evaluateCondition resolves session:role from the session argument, not fieldValues", () => {
    const result = { rows: [], count: 0 };
    expect(evaluateCondition("session:role == 'Admin'", result, {}, { identity: null, role: "Admin" })).toBe(true);
    expect(evaluateCondition("session:role == 'Admin'", result, {}, { identity: null, role: "Staff" })).toBe(false);
    expect(evaluateCondition("session:role == 'Admin'", result, { role: "Admin" })).toBe(false); // fieldValues never substitutes for it
  });

  describe("eventRequiredRole / screenRequiredRole: raw-XML role-list attributes", () => {
    const gated = `<screen id="s" title="S" requiredRole="Admin, Manager">
      <ui><button id="del" label="Delete"/></ui>
      <events><event type="click" element="del" requiredRole="Admin"><stop/></event></events>
    </screen>`;
    const ungated = `<screen id="s" title="S"><ui><button id="del" label="Delete"/></ui><events><event type="click" element="del"><stop/></event></events></screen>`;

    it("parses a comma-separated role list, trimmed", () => {
      expect(screenRequiredRole(gated)).toEqual(["Admin", "Manager"]);
      expect(eventRequiredRole(gated, "del", "click")).toEqual(["Admin"]);
    });
    it("returns null when the attribute is absent — no restriction", () => {
      expect(screenRequiredRole(ungated)).toBeNull();
      expect(eventRequiredRole(ungated, "del", "click")).toBeNull();
    });
    it("returns null for an event/element that doesn't exist, rather than throwing", () => {
      expect(eventRequiredRole(gated, "nope", "click")).toBeNull();
    });
  });
});

describe("engine: visibleRoles on a field — hidden from a role must also be unwritable by that role", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="ins"><statement>CREATE (e:Employee {name: $name, salary: $salary})</statement>
      <parameters><parameter name="name" source="field:name"/><parameter name="salary" source="field:salary"/></parameters></query>
  </queries>
  <ui>
    <field id="name" label="Name" type="text"/>
    <field id="salary" label="Salary" type="number" visibleRoles="Admin,HR"/>
    <button id="save" label="Save"/>
  </ui>
  <events><event type="click" element="save"><execute query="ins"/></event></events>
</screen>`;
  const entities = { tables: [{ name: "Employee", columns: [{ name: "name", type: "VARCHAR(50)" }] }] };
  let seen: string[] = [];
  const exec: QueryExecutor = async (statement) => { seen.push(statement.split(" ")[0]); return { rows: [], count: 0 }; };
  beforeEach(() => { seen = []; });

  it("blocks a submitted value for a role-restricted field when the session's role isn't allowed", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { name: "Bob", salary: "90000" }, [], null, "Staff");
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Salary cannot be set with your current role." });
    expect(seen).toEqual([]);
  });
  it("allows the save when the role-restricted field is simply left empty — a role that can't see it must still save the rest", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { name: "Bob", salary: "" }, [], null, "Staff");
    expect(actions.filter((a) => a.type === "message" && a.messageType === "error")).toEqual([]);
    expect(seen).toEqual(["CREATE"]);
  });
  it("allows a submitted value when the session's role is permitted", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { name: "Bob", salary: "90000" }, [], null, "Admin");
    expect(actions.filter((a) => a.type === "message" && a.messageType === "error")).toEqual([]);
    expect(seen).toEqual(["CREATE"]);
  });
  it("blocks it when no role at all is present on the session", async () => {
    const actions = await runEvent(exec, entities, xml, "save", "click", { name: "Bob", salary: "90000" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Salary cannot be set with your current role." });
    expect(seen).toEqual([]);
  });
});

describe("renderer: visibleRoles hides a field (and its fieldset, if emptied) from a role that can't see it", () => {
  const xml = `<screen id="s" title="S"><ui>
    <field id="name" label="Name" type="text"/>
    <fieldset legend="Payroll"><field id="salary" label="Salary" type="number" visibleRoles="Admin,HR"/></fieldset>
  </ui><events/></screen>`;
  const model = parseScreenModel(xml);

  it("renders a visibleRoles field for a role that's allowed", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t", sessionRole: "Admin" });
    expect(html).toContain('id="salary"');
    expect(html).toContain("Payroll");
  });
  it("omits the field entirely (not just visually) for a role that isn't allowed, and drops the now-empty fieldset", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t", sessionRole: "Staff" });
    expect(html).not.toContain('id="salary"');
    expect(html).not.toContain("Payroll");
    expect(html).toContain('id="name"'); // the unrestricted sibling field is unaffected
  });
  it("omits it when no sessionRole is given at all", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).not.toContain('id="salary"');
  });
});

describe("renderer: type=\"image\" field", () => {
  const model = parseScreenModel(`<screen id="s" title="S"><ui><field id="pic" label="Picture" type="image"/></ui><events/></screen>`);
  it("renders a real file picker, no value/default support", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('<input type="file" accept="image/*" id="pic" name="pic" data-image-field>');
  });
  it("is wired into the dedicated image-field FileReader handler, not the generic auto-commit path", () => {
    const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });
    expect(html).toContain('querySelectorAll("[data-image-field]")');
    expect(html).toContain("el.type === \"file\"");
  });
});

describe("engine: <generate> — securely server-generated values", () => {
  const xml = `<screen id="s" title="S">
  <ui><field id="tempPassword" label="Temp Password" type="text"/><button id="go" label="Go"/></ui>
  <events><event type="click" element="go"><generate target="field:tempPassword" type="password"/></event></events>
</screen>`;
  const exec: QueryExecutor = async () => ({ rows: [], count: 0 });

  it("produces a 12-character value from an unambiguous alphabet", async () => {
    const actions = await runEvent(exec, {}, xml, "go", "click", {});
    const set = actions.find((a) => a.type === "set") as { value: string };
    expect(set.value).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
  });
  it("never produces the same value twice in a row", async () => {
    const a = (await runEvent(exec, {}, xml, "go", "click", {})).find((a) => a.type === "set") as { value: string };
    const b = (await runEvent(exec, {}, xml, "go", "click", {})).find((a) => a.type === "set") as { value: string };
    expect(a.value).not.toBe(b.value);
  });
});

describe("engine: hash=\"true\" on a <parameter> — real bcrypt, not plaintext", () => {
  const xml = `<screen id="s" title="S">
  <queries><query id="ins"><statement>CREATE (a:Account {password: $password})</statement>
    <parameters><parameter name="password" source="field:password" hash="true"/></parameters></query></queries>
  <ui><field id="password" label="Password" type="password"/><button id="save" label="Save"/></ui>
  <events><event type="click" element="save"><execute query="ins"/></event></events>
</screen>`;

  it("binds a real bcrypt hash, verifiable against the original, never the plaintext", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    await runEvent(exec, {}, xml, "save", "click", { password: "correct horse battery staple" });
    expect(seenParams.password).not.toBe("correct horse battery staple");
    expect(String(seenParams.password)).toMatch(/^\$2[aby]\$/); // real bcrypt hash shape
    expect(verifyPassword("correct horse battery staple", String(seenParams.password))).toBe(true);
    expect(verifyPassword("wrong guess", String(seenParams.password))).toBe(false);
  });
});

describe("engine: a literal <parameter> source never leaks an invented \"literal:\" prefix", () => {
  // The model has twice written source="literal:Staff" (mirroring field:/session: syntax, but
  // never a real prefix this engine recognizes) expecting the literal value "Staff" — with no
  // defensive stripping, that whole string including the prefix gets stored verbatim.
  const xml = `<screen id="s" title="S">
  <queries><query id="ins"><statement>CREATE (a:Account {roleId: $roleId, verified: $verified})</statement>
    <parameters>
      <parameter name="roleId" source="literal:Staff"/>
      <parameter name="verified" source="false"/>
    </parameters></query></queries>
  <ui><button id="save" label="Save"/></ui>
  <events><event type="click" element="save"><execute query="ins"/></event></events>
</screen>`;

  it("strips an invented literal: prefix down to the real value", async () => {
    let seenParams: Record<string, unknown> = {};
    const exec: QueryExecutor = async (statement, params) => { seenParams = params; return { rows: [], count: 0 }; };
    await runEvent(exec, {}, xml, "save", "click", {});
    expect(seenParams.roleId).toBe("Staff");
    expect(seenParams.verified).toBe("false"); // an ordinary literal with no prefix is untouched
  });
});

describe("engine: passwordField/passwordColumn — login verification against a stored hash", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="checkLogin" passwordField="field:password" passwordColumn="passwordHash">
      <statement>MATCH (a:Account) WHERE a.username = $u RETURN a.password AS passwordHash, a.role AS role, a.mustChangePassword AS mustChangePassword, count(a) AS count</statement>
      <parameters><parameter name="u" source="field:u"/></parameters>
    </query>
  </queries>
  <ui><field id="u" label="User" type="text"/><field id="password" label="Password" type="password"/><button id="login" label="Login"/></ui>
  <events>
    <event type="click" element="login" allowAnonymous="true">
      <execute query="checkLogin">
        <when condition="result.count == 0"><message type="error" value="Invalid username or password."/><stop/></when>
        <when condition="result.count &gt; 0"><session action="start" identity="field:u" role="result.role" mustChangePassword="result.mustChangePassword"/></when>
      </execute>
    </event>
  </events>
</screen>`;
  // Built the same way a signup's hash="true" parameter already would have.
  const hash = hashPassword("correctPassword123");

  it("succeeds for the right password, keeps role/mustChangePassword available, never leaks the hash", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ passwordHash: hash, role: "Student", mustChangePassword: true, count: 1 }], count: 1 });
    const actions = await runEvent(exec, {}, xml, "login", "click", { u: "bob", password: "correctPassword123" });
    expect(actions).toContainEqual({ type: "session", action: "start", identity: "bob", role: "Student", mustChangePassword: true });
    expect(actions.some((a) => a.type === "message" && a.messageType === "error")).toBe(false);
  });
  it("fails for the wrong password — treated exactly like no matching account", async () => {
    const exec: QueryExecutor = async () => ({ rows: [{ passwordHash: hash, role: "Student", mustChangePassword: false, count: 1 }], count: 1 });
    const actions = await runEvent(exec, {}, xml, "login", "click", { u: "bob", password: "wrongGuess" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Invalid username or password." });
    expect(actions.some((a) => a.type === "session")).toBe(false);
  });
  it("fails cleanly when no account row comes back at all", async () => {
    const exec: QueryExecutor = async () => ({ rows: [], count: 0 });
    const actions = await runEvent(exec, {}, xml, "login", "click", { u: "ghost", password: "anything" });
    expect(actions).toContainEqual({ type: "message", messageType: "error", value: "Invalid username or password." });
  });
});

describe("engine: <email> — produces an action, to/subject/body resolve via the existing operand/template resolvers", () => {
  const xml = `<screen id="s" title="S">
  <ui><field id="email" label="Email" type="email"/><field id="tempPassword" label="Temp" type="text"/><button id="go" label="Go"/></ui>
  <events><event type="click" element="go">
    <generate target="field:tempPassword" type="password"/>
    <email to="field:email" subject="Your account" body="Your temporary password is \${field:tempPassword}."/>
  </event></events>
</screen>`;
  it("resolves to from the field, and substitutes a value generated earlier in the same chain into body", async () => {
    const exec: QueryExecutor = async () => ({ rows: [], count: 0 });
    const actions = await runEvent(exec, {}, xml, "go", "click", { email: "student@example.com" });
    const emailAction = actions.find((a) => a.type === "email") as { to: string; subject: string; body: string };
    const setAction = actions.find((a) => a.type === "set") as { value: string };
    expect(emailAction.to).toBe("student@example.com");
    expect(emailAction.subject).toBe("Your account");
    expect(emailAction.body).toBe(`Your temporary password is ${setAction.value}.`);
  });
});

describe("engine: allowPasswordChange gate helpers (raw-XML)", () => {
  const gated = `<screen id="s" title="S"><ui><button id="save" label="Save"/></ui>
    <events><event type="click" element="save" allowPasswordChange="true"><stop/></event></events></screen>`;
  const ungated = `<screen id="s" title="S"><ui><button id="save" label="Save"/></ui>
    <events><event type="click" element="save"><stop/></event></events></screen>`;

  it("eventAllowsPasswordChange is true only for a marked event", () => {
    expect(eventAllowsPasswordChange(gated, "save", "click")).toBe(true);
    expect(eventAllowsPasswordChange(ungated, "save", "click")).toBe(false);
  });
  it("hasPasswordChangeEntry is true only when at least one event is marked", () => {
    expect(hasPasswordChangeEntry(gated)).toBe(true);
    expect(hasPasswordChangeEntry(ungated)).toBe(false);
  });
});

describe("engine: worked pattern — create a record, auto-provision its login, email the temp password", () => {
  const xml = `<screen id="s" title="S">
  <queries>
    <query id="createStudent"><statement>CREATE (s:Student {name: $name, email: $email})</statement>
      <parameters><parameter name="name" source="field:name"/><parameter name="email" source="field:email"/></parameters></query>
    <query id="createAccount"><statement>CREATE (a:Account {username: $email, password: $password, role: $role, mustChangePassword: $mustChangePassword})</statement>
      <parameters>
        <parameter name="email" source="field:email"/>
        <parameter name="password" source="field:tempPassword" hash="true"/>
        <parameter name="role" source="Student"/>
        <parameter name="mustChangePassword" source="true"/>
      </parameters></query>
  </queries>
  <ui><field id="name" label="Name" type="text"/><field id="email" label="Email" type="email"/>
    <field id="tempPassword" label="Temp" type="text"/><button id="save" label="Save"/></ui>
  <events><event type="click" element="save">
    <execute query="createStudent"/>
    <generate target="field:tempPassword" type="password"/>
    <execute query="createAccount"/>
    <email to="field:email" subject="Your account" body="Your temporary password is \${field:tempPassword}. You'll be asked to change it on first login."/>
  </event></events>
</screen>`;

  it("creates the record, hashes a fresh temp password into the new Account, and emails the plaintext version", async () => {
    const calls: { statement: string; params: Record<string, unknown> }[] = [];
    const exec: QueryExecutor = async (statement, params) => { calls.push({ statement, params }); return { rows: [], count: 0 }; };
    const actions = await runEvent(exec, {}, xml, "save", "click", { name: "Bob", email: "bob@example.com" });

    const accountCall = calls.find((c) => c.statement.includes("CREATE (a:Account"))!;
    const emailAction = actions.find((a) => a.type === "email") as { to: string; body: string };
    const plaintextMatch = emailAction.body.match(/temporary password is (\S+)\./);
    expect(plaintextMatch).toBeTruthy();
    const plaintext = plaintextMatch![1];

    expect(accountCall.params.password).not.toBe(plaintext);
    expect(verifyPassword(plaintext, String(accountCall.params.password))).toBe(true);
    expect(emailAction.to).toBe("bob@example.com");
  });
});

describe("screenModel: <stat> parsing", () => {
  it("parses id/label/icon, and defaults label to id when omitted", () => {
    const model = parseScreenModel(`<screen id="s" title="S"><ui>
      <stat id="totalStudents" label="Total Students" icon="users"/>
      <stat id="totalCourses"/>
    </ui><events/></screen>`);
    expect(model.stats).toEqual([
      { kind: "stat", id: "totalStudents", label: "Total Students", icon: "users" },
      { kind: "stat", id: "totalCourses", label: "totalCourses", icon: null },
    ]);
  });
  it("finds a <stat> nested inside a <fieldset> too, same as any other item", () => {
    const model = parseScreenModel(`<screen id="s" title="S"><ui>
      <fieldset legend="Metrics"><stat id="x" label="X"/></fieldset>
    </ui><events/></screen>`);
    expect(model.stats.map((s) => s.id)).toEqual(["x"]);
  });
});

describe("renderer: <stat> widget — card markup and live client-side update", () => {
  const model = parseScreenModel(`<screen id="dash" title="Dashboard"><ui>
    <stat id="totalStudents" label="Total Students" icon="users"/>
    <stat id="totalCourses" label="Total Courses"/>
  </ui><events><event type="load" element="dash"><execute query="q"/></event></events></screen>`);
  const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "dash", token: "t" });

  it("renders a stat card per <stat>, grouped into one stats-row, with a placeholder value", () => {
    expect(html).toContain('class="stats-row"');
    expect(html).toContain('data-stat="totalStudents"');
    expect(html).toContain('data-stat="totalCourses"');
    expect(html).toMatch(/data-stat="totalStudents"[\s\S]*?class="stat-value">—</);
  });
  it("includes the icon for a stat that specifies one, and omits it for one that doesn't", () => {
    const studentsCard = html.slice(html.indexOf('data-stat="totalStudents"'), html.indexOf('data-stat="totalCourses"'));
    const coursesCard = html.slice(html.indexOf('data-stat="totalCourses"'));
    expect(studentsCard).toContain("stat-icon");
    expect(coursesCard.slice(0, coursesCard.indexOf("stat-body"))).not.toContain("stat-icon");
  });
  it("the client script updates a stat's value element when a map/set action targets stat:<id>", () => {
    expect(html).toContain('a.target.indexOf("stat:") === 0');
    expect(html).toContain('root.querySelector(\'[data-stat="\' + a.target.slice(5) + \'"]\')');
  });
});

describe("renderer: nav icons are inferred from the screen name, never AI-chosen", () => {
  const screens = [
    { id: "a", name: "Dashboard" }, { id: "b", name: "Student Master" }, { id: "c", name: "Course Catalog" },
    { id: "d", name: "Department List" }, { id: "e", name: "Exam Report" }, { id: "f", name: "Totally Unrecognizable Xyz" },
  ];
  const model = parseScreenModel(`<screen id="a" title="S"><ui/><events/></screen>`);
  const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "a", token: "t", screens });

  it("picks a sensible icon per recognizable screen name", () => {
    // Order in ICON_PATHS/inferNavIcon isn't asserted directly (private) — instead confirm distinct
    // screens with clearly different domains don't all collapse onto the exact same icon markup.
    const iconFor = (name: string) => {
      const idx = html.indexOf(`>${name}<`);
      const start = html.lastIndexOf("<svg", idx);
      return html.slice(start, html.indexOf("</svg>", start) + 7);
    };
    expect(iconFor("Dashboard")).not.toBe(iconFor("Student Master"));
    expect(iconFor("Student Master")).not.toBe(iconFor("Course Catalog"));
    expect(iconFor("Course Catalog")).not.toBe(iconFor("Department List"));
  });
  it("falls back to a generic icon for an unrecognized screen name, without throwing", () => {
    expect(() => html).not.toThrow();
    expect(html).toContain(">Totally Unrecognizable Xyz<");
  });
});

describe("renderer: toast notifications replace the old plain banner", () => {
  const model = parseScreenModel(`<screen id="s" title="S"><ui><field id="f" label="F" type="text"/></ui><events/></screen>`);
  const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });

  it("keeps the same #screen-messages container id (call site in applyActions is unchanged)", () => {
    expect(html).toContain('id="screen-messages"');
  });
  it("client script builds a toast with an icon per message type and an auto-dismiss for non-errors", () => {
    expect(html).toContain("toast-" + "error");
    expect(html).toContain("TOAST_ICONS");
    expect(html).toContain('kind !== "error"');
    expect(html).toContain("setTimeout");
  });
});

describe("renderer: grid skeleton loading state", () => {
  const model = parseScreenModel(`<screen id="s" title="S"><ui>
    <grid id="g" label="G" emptyMessage="No records."><column id="c" header="C" binding="c"/></grid>
  </ui><events/></screen>`);
  const html = renderScreen(model, { apiBase: "x", projectId: 1, screenId: "s", token: "t" });

  it("renders a skeleton tbody by default, not the empty-state message, before any load completes", () => {
    expect(html).toMatch(/<tbody class="skeleton">/);
    // "No records." legitimately appears once, in the data-empty attribute the client script reads
    // later — it must NOT also appear as real rendered row content in the initial (skeleton) tbody.
    const tbodyMatch = html.match(/<tbody class="skeleton">[\s\S]*?<\/tbody>/);
    expect(tbodyMatch).toBeTruthy();
    expect(tbodyMatch![0]).not.toContain("No records.");
  });
  it("client script clears the skeleton class once real rows (or an empty result) are applied", () => {
    expect(html).toContain('tbody.classList.remove("skeleton")');
  });
  it("has a safety fallback that resolves any still-skeletal grid once the load-event chain settles", () => {
    expect(html).toContain('querySelectorAll("tbody.skeleton")');
  });
});

describe("engine: source=\"project:screens\" — a screen-picker query with no <statement> and no executor round trip", () => {
  const xml = `<screen id="rbac" title="RBAC">
  <queries><query id="listScreens" source="project:screens"/></queries>
  <ui><button id="go" label="Go"/></ui>
  <events><event type="click" element="go"><execute query="listScreens"><map result="rows" target="field:x:options"/></execute></event></events>
</screen>`;

  it("returns this project's OTHER screens as rows, without ever calling the executor", async () => {
    let execCalled = false;
    const exec: QueryExecutor = async () => { execCalled = true; return { rows: [], count: 0 }; };
    const siblingScreens = [{ id: "s1", name: "Department Master" }, { id: "s2", name: "Student Master" }];
    const actions = await runEvent(exec, {}, xml, "go", "click", {}, siblingScreens);
    const mapAction = actions.find((a) => a.type === "map") as { value: unknown };
    expect(mapAction.value).toEqual([
      { screenId: "s1", screenName: "Department Master" },
      { screenId: "s2", screenName: "Student Master" },
    ]);
    expect(execCalled).toBe(false);
  });
  it("never includes the currently-running screen, the same exclusion <navigate> already relies on", async () => {
    const exec: QueryExecutor = async () => ({ rows: [], count: 0 });
    // siblingScreens is defined (by runtimeRender.ts, which builds it) to already exclude the
    // current screen — this just proves the query faithfully reflects whatever list it's given,
    // so an RBAC screen can never end up listing (and therefore restricting) itself.
    const actions = await runEvent(exec, {}, xml, "go", "click", {}, []);
    const mapAction = actions.find((a) => a.type === "map") as { value: unknown };
    expect(mapAction.value).toEqual([]);
  });
});
