const BASE = "http://localhost:8001";
const EMAIL = `renderverify_${Date.now()}@example.com`;

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

const SCREEN_XML = `<screen id="departmentScreen" title="Department">
  <dataSources><dataSource id="mainDB" type="database"/></dataSources>
  <queries>
    <query id="loadDepartment"><dataSource ref="mainDB"/>
      <statement>MATCH (d:Department) WHERE d.deptid = $deptid RETURN d.deptname AS deptname</statement>
      <parameters><parameter name="deptid" source="field:deptid"/></parameters></query>
  </queries>
  <ui>
    <field id="deptid" label="Department ID" type="text" persistenceMapping="Department.deptid">
      <rule required="true"/>
      <hint>Type an existing department id</hint>
    </field>
    <field id="deptname" label="Department Name" type="text" persistenceMapping="Department.deptname" readonly="true"/>
    <grid id="courses" label="Courses" emptyMessage="No course available for this department"><column id="courseid" header="Course ID" binding="courseid"/><column id="coursename" header="Course Name" binding="coursename"/></grid>
    <button id="save" label="Save" style="primary"/>
  </ui>
  <events>
    <event type="change" element="deptid">
      <execute query="loadDepartment"><map result="deptname" target="field:deptname"/></execute>
    </event>
    <event type="click" element="save">
      <execute query="loadDepartment"><map result="deptname" target="field:deptname"/></execute>
    </event>
  </events>
</screen>`;

let projectId = 0;
let token = "";
try {
  await api("POST", "/api/auth/register", undefined, { email: EMAIL, password: "testpass123", full_name: "Render Verify" });
  token = (await api("POST", "/api/auth/login", undefined, { email: EMAIL, password: "testpass123" })).access_token;
  const project = await api("POST", "/api/projects", token, { name: "Render Verify Project" });
  projectId = project.id;
  console.log("project", projectId);

  const withScreen = await api("POST", `/api/projects/${projectId}/screens`, token, { name: "Department", description: "" });
  const screenId = JSON.parse(withScreen.ui_screens)[0].id;
  // Inject the XML directly (bypassing the AI) via the project's ui_screens field, so this test is deterministic.
  const screens = JSON.parse(withScreen.ui_screens);
  screens[0].xml = SCREEN_XML;
  await api("PUT", `/api/projects/${projectId}`, token, { ui_screens: JSON.stringify(screens) });

  console.log("--- 1. missing token -> 401 HTML error page, not JSON ---");
  const noToken = await fetch(`${BASE}/runtime/projects/${projectId}/screens/${screenId}`);
  console.log("status:", noToken.status, "content-type:", noToken.headers.get("content-type"));
  if (noToken.status !== 401) throw new Error("expected 401 without token");

  console.log("--- 2. wrong user's token -> 404 ---");
  const otherEmail = `renderverify2_${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", undefined, { email: otherEmail, password: "testpass123" });
  const otherToken = (await api("POST", "/api/auth/login", undefined, { email: otherEmail, password: "testpass123" })).access_token;
  const wrongUser = await fetch(`${BASE}/runtime/projects/${projectId}/screens/${screenId}?token=${encodeURIComponent(otherToken)}`);
  console.log("status:", wrongUser.status);
  if (wrongUser.status !== 404) throw new Error("expected 404 for a project owned by someone else");

  console.log("--- 3. real render ---");
  const res = await fetch(`${BASE}/runtime/projects/${projectId}/screens/${screenId}?token=${encodeURIComponent(token)}`);
  const html = await res.text();
  console.log("status:", res.status, "content-type:", res.headers.get("content-type"), "bytes:", html.length);
  const checks: [string, boolean][] = [
    ['title has "Department"', html.includes("<title>Department</title>")],
    ['deptid input present', /id="deptid"/.test(html)],
    ['deptid required asterisk', html.includes('<span class="req">*</span>')],
    ['deptid hint rendered', html.includes("Type an existing department id")],
    ['deptname disabled (readonly)', /id="deptname"[^>]*disabled/.test(html)],
    ['deptid wired to commit on blur', /id="deptid"[^>]*data-commit-event="blur"/.test(html)],
    ['grid headers present', html.includes(">Course ID<") && html.includes(">Course Name<")],
    ['grid empty message baked in', html.includes("No course available for this department")],
    ['save button wired for click', /id="save" data-button data-click/.test(html)],
    ['token embedded for client script', html.includes(`var TOKEN = "${token}"`)],
    ['project/screen ids embedded', html.includes(`var PROJECT_ID = ${projectId}`) && html.includes(`var SCREEN_ID = "${screenId}"`)],
    ['run-event URL built from baked API_BASE/PROJECT_ID/SCREEN_ID', html.includes('"/api/projects/" + PROJECT_ID + "/screens/" + SCREEN_ID + "/run-event"')],
  ];
  for (const [label, ok] of checks) console.log(ok ? "OK" : "FAIL", "-", label);
  if (checks.some(([, ok]) => !ok)) throw new Error("one or more structural checks failed");

  console.log("--- 4. run-event still works unchanged, called exactly as the rendered page's script calls it ---");
  const ev = await api("POST", `/api/projects/${projectId}/screens/${screenId}/run-event`, token, {
    elementId: "deptid", eventType: "change", fieldValues: { deptid: "NOPE" },
  });
  console.log("actions for a department that doesn't exist yet:", JSON.stringify(ev.actions));

  console.log("\nALL SERVER-RENDER CHECKS PASSED");
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  if (projectId) await api("DELETE", `/api/projects/${projectId}`, token).catch(() => {});
}
