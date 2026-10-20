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

const { saveApplicationNodes, getElementXml } = await import("./applicationStore.js");

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

describe("applicationStore.getElementXml: also rejects an unrecognized tag before querying", () => {
  it("throws without ever calling the driver", async () => {
    runCalls.length = 0;
    await expect(getElementXml(7, "NotARealTag", "x")).rejects.toThrow(/Unknown top-level Application element/);
    expect(runCalls).toHaveLength(0);
  });
});
