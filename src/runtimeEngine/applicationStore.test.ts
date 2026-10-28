import { describe, expect, it, vi } from "vitest";

// Neo4j is unreachable from this environment (a known, pre-existing limitation this whole
// session) — withTx/neo4jSession are mocked so this still verifies applicationStore.ts's OWN
// logic (the tag allowlist guard, and the shape of what it asks the driver to do) without a real
// database. A live smoke test against a real Neo4j instance is the remaining verification gap,
// same as everywhere else in this codebase that touches the driver directly.
const runCalls: { statement: string; params: unknown }[] = [];
vi.mock("../runtime/neo4jStore.js", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({ run: async (statement: string, params: unknown) => { runCalls.push({ statement, params }); return { records: [] }; } }),
  neo4jSession: () => ({ run: async (statement: string, params: unknown) => { runCalls.push({ statement, params }); return { records: [] }; }, close: async () => {} }),
}));

const { saveApplicationNodes, mergeApplicationNodes, getElementXml } = await import("./applicationStore.js");

const MINIMAL_XML = `<Application name="Test" theme="corporate" database="relational">
  <Entity name="Vendor"><Field name="id" type="string" key="true"/></Entity>
</Application>`;

describe("applicationStore.saveApplicationNodes: rejects an unrecognized top-level tag before writing anything", () => {
  it("throws for a tag outside the known Application vocabulary", async () => {
    runCalls.length = 0;
    const malicious = `<Application name="Bad"><NotARealTag name="x"/></Application>`;
    await expect(saveApplicationNodes(1, malicious)).rejects.toThrow(/Unknown top-level Application element/);
    expect(runCalls).toHaveLength(0); // fails before the transaction ever opens
  });
});

describe("applicationStore.mergeApplicationNodes: same validation as a full save, applied to the fragment", () => {
  // mergeApplicationNodes is the targeted counterpart to saveApplicationNodes — its happy path
  // (upsert-by-name, re-derive the structural graph) is covered by the live smoke test against
  // the real Neo4j instance (same precedent this file's own top comment documents for every
  // other happy path here); what a mock usefully proves is that it validates a fragment with
  // EXACTLY the same rules as a full save, before ever opening a transaction.
  it("rejects an unrecognized tag in the fragment before writing anything", async () => {
    runCalls.length = 0;
    await expect(mergeApplicationNodes(1, `<Application><NotARealTag name="x"/></Application>`)).rejects.toThrow(/Unknown top-level Application element/);
    expect(runCalls).toHaveLength(0);
  });

  it("rejects a fragment that redefines the isAccount entity with an extra field", async () => {
    runCalls.length = 0;
    const bad = `<Application><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="extra" type="string" required="true"/>
    </Entity></Application>`;
    await expect(mergeApplicationNodes(1, bad)).rejects.toThrow(/don't match either known account shape/);
    expect(runCalls).toHaveLength(0);
  });
});

describe("applicationStore.saveApplicationNodes: isAccount Entity must match the fixed convention exactly", () => {
  // Regression test for a real incident: the AI added extra required fields (an account code, a
  // role link) straight onto an isAccount Entity, and every signup then failed with "X is
  // required" since the login/register built-ins only ever set a fixed field list. Caught here,
  // at save time, not just discovered at first signup.
  it("rejects an isAccount Entity with an extra required field", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Bad"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="accountCode" type="string" required="true" unique="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).rejects.toThrow(/don't match either known account shape/);
    expect(runCalls).toHaveLength(0);
  });

  it("rejects an isAccount Entity missing one of the fixed fields", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Bad"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).rejects.toThrow(/don't match either known account shape/);
  });

  // LEGACY shape — never generated by the AI anymore, but already-generated apps with real
  // seeded accounts still use it, so it must keep validating cleanly forever.
  it("accepts an isAccount Entity with exactly the legacy (username-based) field set", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Good"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).resolves.toBeTruthy();
  });

  // CURRENT shape — what the AI generates from now on (email identity, OTP verification, OAuth).
  it("accepts an isAccount Entity with exactly the current (email-based) field set", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Good"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="email" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="firstName" type="string"/>
      <Field name="lastName" type="string"/>
      <Field name="dob" type="date"/>
      <Field name="emailVerified" type="boolean" required="true"/>
      <Field name="authProvider" type="string" required="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).resolves.toBeTruthy();
  });

  it("rejects a current-shape Entity missing one of its fixed fields", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Bad"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="email" type="string" required="true" unique="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="emailVerified" type="boolean" required="true"/>
      <Field name="authProvider" type="string" required="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).rejects.toThrow(/don't match either known account shape/);
  });

  it("rejects mixing fields from both the legacy and current shapes", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Bad"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="email" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).rejects.toThrow(/don't match either known account shape/);
  });

  it("leaves a non-account Entity alone no matter what fields it has", async () => {
    runCalls.length = 0;
    await expect(saveApplicationNodes(1, MINIMAL_XML)).resolves.toBeTruthy();
  });

  // The ONE allowed exception to "exactly these fields" — the optional RBAC roleId field (see
  // the plan's "role-based access control" section), for EITHER shape. Still rejected extra for
  // any OTHER field, and still rejected when roleId itself is required="true" (the exact bug
  // class this whole function exists to prevent — a required extra field breaks every signup).
  it("accepts an isAccount Entity with the fixed fields plus an optional, non-required roleId", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Good"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="roleId" type="string"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).resolves.toBeTruthy();
  });

  it("rejects roleId when it's marked required", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Bad"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="roleId" type="string" required="true"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).rejects.toThrow(/roleId must not be required/);
  });

  it("still rejects any field other than roleId as an extra field", async () => {
    runCalls.length = 0;
    const xml = `<Application name="Bad"><Entity name="User" isAccount="true">
      <Field name="id" type="string" key="true"/>
      <Field name="username" type="string" required="true" unique="true"/>
      <Field name="passwordHash" type="string" required="true"/>
      <Field name="mustChangePassword" type="boolean" required="true"/>
      <Field name="roleId" type="string"/>
      <Field name="employeeCode" type="string"/>
    </Entity></Application>`;
    await expect(saveApplicationNodes(1, xml)).rejects.toThrow(/don't match either known account shape/);
  });
});

describe("applicationStore.saveApplicationNodes: writes a delete-then-recreate sequence", () => {
  it("issues a detach-delete of the old graph, then creates the root + one child + a CONTAINS edge", async () => {
    runCalls.length = 0;
    const result = await saveApplicationNodes(7, MINIMAL_XML);
    expect(result).toEqual({ name: "Test", theme: "corporate", database: "relational", elementCounts: { Entity: 1 } });
    expect(runCalls[0].statement).toContain("DETACH DELETE a, child");
    expect(runCalls[1].statement).toContain("CREATE (a:RtApplication");
    expect(runCalls[2].statement).toContain("CREATE (child:Entity");
    expect(runCalls[2].statement).toContain("CREATE (a)-[:CONTAINS]->(child)");
  });
});

describe("applicationStore.saveApplicationNodes: links elements into a real connected graph, not a flat star", () => {
  // "each screen should be connected to [its] node, and like this it all should be connected" —
  // beyond RtApplication-[:CONTAINS]->child, Entities connect to each other via Relationship,
  // and every other element connects to the Entity/DataSource/Action/Screen it references.
  const CONNECTED_XML = `<Application name="Connected">
    <Entity name="Vendor"><Field name="id" type="string" key="true"/></Entity>
    <Entity name="PurchaseOrder"><Field name="id" type="string" key="true"/><Field name="vendorId" type="string"/></Entity>
    <Relationship name="PO-to-Vendor" fromEntity="PurchaseOrder" fromField="vendorId" toEntity="Vendor" toField="id" cardinality="N:1" onDelete="restrict"/>
    <Validation id="total-check" entity="PurchaseOrder" when="onSave" onViolation="reject"><DependsOn/><Condition test="true"/><Message>x</Message></Validation>
    <DataSource name="activeVendors" type="query"><Select entity="Vendor"><Field name="id"/></Select></DataSource>
    <Action name="submitForApproval" entity="PurchaseOrder"><Steps><Save/></Steps></Action>
    <Screen name="POForm" entity="PurchaseOrder" type="form">
      <Fields><UIField label="Vendor" control="dropdown" valueFrom="field:vendorId" optionsFrom="query:activeVendors"/></Fields>
      <Buttons><Button label="Save" event="click" action="save"/><Button label="Submit" event="click" action="submitForApproval"/></Buttons>
    </Screen>
    <Screen name="POBrowse" entity="PurchaseOrder">
      <Grid name="g" entity="PurchaseOrder"><Column header="x" bind="id"/>
        <Events><On event="rowClick" action="openRecord" targetScreen="POForm"/></Events>
      </Grid>
    </Screen>
  </Application>`;

  it("connects a Relationship to both the entities it joins", async () => {
    runCalls.length = 0;
    await saveApplicationNodes(1, CONNECTED_XML);
    const rel = runCalls.find((c) => c.statement.includes("FROM_ENTITY") && c.statement.includes("TO_ENTITY"));
    expect(rel).toBeTruthy();
    expect(rel!.params).toMatchObject({ relName: "PO-to-Vendor", fromEntity: "PurchaseOrder", toEntity: "Vendor" });
  });

  it("connects Validation, Action, and DataSource to the Entity each one is for", async () => {
    runCalls.length = 0;
    await saveApplicationNodes(1, CONNECTED_XML);
    const forEntityCalls = runCalls.filter((c) => c.statement.includes("FOR_ENTITY"));
    const fromNames = forEntityCalls.map((c) => (c.params as { fromName: string }).fromName);
    expect(fromNames).toContain("total-check"); // Validation
    expect(fromNames).toContain("submitForApproval"); // Action
    expect(fromNames).toContain("activeVendors"); // DataSource
    expect(fromNames).toContain("POForm"); // Screen itself is also FOR_ENTITY-linked
  });

  it("connects a Screen to the DataSource its dropdown field uses", async () => {
    runCalls.length = 0;
    await saveApplicationNodes(1, CONNECTED_XML);
    const ds = runCalls.find((c) => c.statement.includes("USES_DATASOURCE"));
    expect(ds).toBeTruthy();
    expect(ds!.params).toMatchObject({ sName: "POForm", dsName: "activeVendors" });
  });

  it("connects a Screen's Button to the named Action it runs, but never to a built-in", async () => {
    runCalls.length = 0;
    await saveApplicationNodes(1, CONNECTED_XML);
    const runs = runCalls.filter((c) => c.statement.includes("RUNS_ACTION"));
    expect(runs).toHaveLength(1); // only "submitForApproval" — "save" is a built-in, never linked
    expect(runs[0].params).toMatchObject({ sName: "POForm", actionName: "submitForApproval" });
  });

  it("connects a Grid's rowClick to its target Screen", async () => {
    runCalls.length = 0;
    await saveApplicationNodes(1, CONNECTED_XML);
    const opens = runCalls.find((c) => c.statement.includes("OPENS_SCREEN"));
    expect(opens).toBeTruthy();
    expect(opens!.params).toMatchObject({ sName: "POBrowse", targetScreen: "POForm" });
  });
});

describe("applicationStore.getElementXml: also rejects an unrecognized tag before querying", () => {
  it("throws without ever calling the driver", async () => {
    runCalls.length = 0;
    await expect(getElementXml(7, "NotARealTag", "x")).rejects.toThrow(/Unknown top-level Application element/);
    expect(runCalls).toHaveLength(0);
  });
});
