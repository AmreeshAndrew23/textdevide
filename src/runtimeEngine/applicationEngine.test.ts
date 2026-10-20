import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";
import { runAction, runButtonAction, substituteFieldTemplate, type ActionRunContext } from "./applicationEngine.js";
import type { EntityDef, ActionDef } from "./applicationModel.js";

function fakeTx(responses: { records: { get: (key: string) => unknown }[] }[]) {
  let i = 0;
  const run = vi.fn(async () => {
    const res = responses[i++];
    if (!res) throw new Error("fakeTx: no queued response");
    return res;
  });
  return { run } as unknown as Transaction;
}
function record(props: Record<string, unknown>) {
  return { get: (key: string) => (key === "n" ? props : props[key]) };
}

const PO: EntityDef = {
  name: "PurchaseOrder", auditing: null,
  fields: [
    { name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] },
    { name: "status", type: "string", key: false, required: false, unique: false, autoNumber: null, values: [] },
    { name: "branchId", type: "string", key: false, required: false, unique: false, autoNumber: null, values: [] },
  ],
};

function ctx(tx: Transaction): ActionRunContext {
  return { applicationId: 7, entity: PO, relationships: [], validations: [], auditing: null, session: { identity: "alice@example.com", vars: { branch: "NYC" } }, tx };
}

describe("applicationEngine.substituteFieldTemplate", () => {
  it("substitutes {field} placeholders from current field values", () => {
    expect(substituteFieldTemplate("PO {poNumber} awaiting approval", { poNumber: "PO-2026-000012" })).toBe("PO PO-2026-000012 awaiting approval");
  });
  it("leaves an unresolvable placeholder untouched rather than throwing", () => {
    expect(substituteFieldTemplate("Hello {unknownField}", {})).toBe("Hello {unknownField}");
  });
});

describe("applicationEngine.runAction: the real initPO sample — Set steps only, no Save", () => {
  const initPO: ActionDef = {
    name: "initPO", entity: "PurchaseOrder",
    steps: [{ kind: "set", field: "branchId", value: "{session.branch}" }, { kind: "set", field: "status", value: "draft" }],
  };
  it("resolves {session.branch} and a plain literal, in order, with no database calls", async () => {
    const tx = fakeTx([]);
    const results = await runAction(ctx(tx), initPO, {});
    expect(results).toEqual([
      { type: "fieldUpdate", field: "branchId", value: "NYC" },
      { type: "fieldUpdate", field: "status", value: "draft" },
    ]);
  });
});

describe("applicationEngine.runAction: the real submitForApproval sample — Set, Save, Notify in one transaction", () => {
  const submitForApproval: ActionDef = {
    name: "submitForApproval", entity: "PurchaseOrder",
    steps: [{ kind: "set", field: "status", value: "pending-approval" }, { kind: "save" }, { kind: "notify", to: "manager", message: "PO {id} awaiting approval" }],
  };

  it("runs all three steps when Save succeeds, substituting the Notify message from the post-Set field values", async () => {
    const tx = fakeTx([
      { records: [] }, // existing-row fetch inside saveEntityRow — none, this is a create
      { records: [] }, // MERGE write
      { records: [record({ id: "po1", status: "pending-approval" })] }, // final read-back
    ]);
    const results = await runAction(ctx(tx), submitForApproval, { id: "po1" });
    expect(results).toEqual([
      { type: "fieldUpdate", field: "status", value: "pending-approval" },
      { type: "message", messageType: "success", value: "Created successfully." },
      { type: "message", messageType: "info", value: "PO po1 awaiting approval" },
    ]);
  });

  it("stops before Notify when Save rejects (e.g. a required field is missing)", async () => {
    const tx = fakeTx([]); // required-field rejection happens before any tx.run call
    const requiredEntity: EntityDef = { ...PO, fields: [...PO.fields, { name: "vendorId", type: "string", key: false, required: true, unique: false, autoNumber: null, values: [] }] };
    const results = await runAction({ ...ctx(tx), entity: requiredEntity }, submitForApproval, { id: "po1" });
    expect(results).toEqual([
      { type: "fieldUpdate", field: "status", value: "pending-approval" },
      { type: "message", messageType: "error", value: "PurchaseOrder.vendorId is required" },
    ]);
  });
});

describe("applicationEngine.runButtonAction: built-ins vs named actions", () => {
  it("\"save\" runs the built-in save pipeline directly, with no Action lookup needed", async () => {
    const tx = fakeTx([{ records: [] }, { records: [] }, { records: [record({ id: "po1" })] }]);
    const results = await runButtonAction(ctx(tx), "save", [], { id: "po1" });
    expect(results).toEqual([{ type: "message", messageType: "success", value: "Created successfully." }]);
  });

  it("\"cancel\" and \"openRecord\" are no-ops server-side", async () => {
    expect(await runButtonAction(ctx(fakeTx([])), "cancel", [], {})).toEqual([]);
    expect(await runButtonAction(ctx(fakeTx([])), "openRecord", [], {})).toEqual([]);
  });

  it("an unrecognized action name that isn't a built-in and has no matching <Action> throws clearly", async () => {
    await expect(runButtonAction(ctx(fakeTx([])), "doesNotExist", [], {})).rejects.toThrow(/Unknown action "doesNotExist"/);
  });

  it("a named action is looked up by name and delegated to runAction", async () => {
    const initPO: ActionDef = { name: "initPO", entity: "PurchaseOrder", steps: [{ kind: "set", field: "status", value: "draft" }] };
    const results = await runButtonAction(ctx(fakeTx([])), "initPO", [initPO], {});
    expect(results).toEqual([{ type: "fieldUpdate", field: "status", value: "draft" }]);
  });
});
