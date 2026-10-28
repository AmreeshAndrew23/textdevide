import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";

// Same reasoning as applicationStore.test.ts: Neo4j is unreachable from this environment, so
// withTx/guard are mocked to verify this module's OWN logic (the Cypher it issues) rather than a
// live database round-trip.
const runCalls: { statement: string; params: unknown }[] = [];
vi.mock("../runtime/neo4jStore.js", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      run: async (statement: string, params: unknown) => {
        runCalls.push({ statement, params });
        return { records: [] };
      },
    }),
}));

const { logAuditEvent, listAuditEvents } = await import("./auditLog.js");

function fakeTx() {
  const calls: { statement: string; params: unknown }[] = [];
  const run = vi.fn(async (statement: string, params?: unknown) => {
    calls.push({ statement, params });
    return { records: [] };
  });
  return { tx: { run } as unknown as Transaction, calls };
}

describe("auditLog.logAuditEvent", () => {
  it("creates a flat RtAuditLog node scoped to the application, with no relationships", async () => {
    const { tx, calls } = fakeTx();
    await logAuditEvent(tx, 7, { type: "login_success", identity: "alice", detail: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0].statement).toContain("CREATE (:RtAuditLog");
    const params = calls[0].params as Record<string, unknown>;
    expect(params.type).toBe("login_success");
    expect(params.identity).toBe("alice");
  });
});

describe("auditLog.listAuditEvents", () => {
  it("reads back the application's own log, newest first", async () => {
    runCalls.length = 0;
    await listAuditEvents(7, 50);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].statement).toContain("MATCH (a:RtAuditLog {applicationId: $applicationId})");
    expect(runCalls[0].statement).toContain("ORDER BY a.at DESC");
  });
});
