import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";
import { parseAutoNumberElement, type EntityDef } from "./applicationModel.js";
import { autoNumbersOf, formatAutoNumber, nextAutoNumber } from "./autoNumber.js";
import { runButtonAction, type ActionRunContext } from "./applicationEngine.js";
import { recipientsOf } from "./publishing.js";
import { buildAppModel } from "./publicAccess.js";

const def = parseAutoNumberElement(`<AutoNumber id="po" start="5" increment="2" padLength="6" reset="yearly"><Prefix>PO-{YYYY}-</Prefix></AutoNumber>`);
const NOW = new Date("2026-03-09T10:00:00");

describe("autoNumber: real, sequential record numbers", () => {
  it("reads the definition and formats the prefix and padding", () => {
    expect(def).toMatchObject({ id: "po", start: 5, increment: 2, padLength: 6, reset: "yearly", prefix: "PO-{YYYY}-" });
    expect(formatAutoNumber(def, 12, NOW)).toBe("PO-2026-000012");
    expect(autoNumbersOf([{ tag: "AutoNumber", xml: `<AutoNumber id="a"/>` }, { tag: "Theme", xml: "<Theme/>" }]).a).toMatchObject({ start: 1, increment: 1, padLength: 0, reset: "never", prefix: "" });
  });

  it("keeps a separate counter per year when it resets yearly, one overall otherwise", async () => {
    const run = vi.fn(async () => ({ records: [{ get: () => 7 }] }));
    expect(await nextAutoNumber({ run } as unknown as Transaction, 3, def, NOW)).toBe("PO-2026-000007");
    expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ period: "2026", id: "po" });
    await nextAutoNumber({ run } as unknown as Transaction, 3, { ...def, reset: "never" }, NOW);
    expect((run.mock.calls[1] as unknown[])[1]).toMatchObject({ period: "all" });
  });
});

const field = (name: string, extra = {}) => ({ name, type: "string", key: false, required: false, unique: false, autoNumber: null, values: [], ...extra });
const PO = { name: "PO", auditing: null, isAccount: false, fields: [field("id", { key: true }), field("number", { autoNumber: "po", required: true }), field("note")] } as unknown as EntityDef;

function ctxFor(existing: Record<string, unknown> | null) {
  const stored = existing ? [existing] : [];
  const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
    if (query.includes("RtAutoNumber")) return { records: [{ get: () => 41 }] };
    if (query.includes("RETURN n")) {
      if (stored[0]) return { records: [{ get: () => stored[0] }] };
      return { records: params.props ? [{ get: () => params.props }] : [] };
    }
    if (query.includes("SET n += $props")) { stored[0] = { ...stored[0], ...(params.props as object) }; return { records: [{ get: () => stored[0] }] }; }
    return { records: [] };
  });
  return {
    ctx: { applicationId: 1, entity: PO, relationships: [], validations: [], auditing: null, session: { identity: "a@b.co", vars: {} }, tx: { run } as unknown as Transaction, autoNumbers: { po: def } } as ActionRunContext,
    run, stored,
  };
}

describe("saving a numbered record", () => {
  it("assigns the next number to a new record, ignoring anything submitted", async () => {
    const { ctx, stored } = ctxFor(null);
    await runButtonAction(ctx, "save", [], { id: "x", number: "HACKED" });
    expect(String(stored[0].number)).toMatch(/-000041$/);
  });

  it("keeps a record's number when it's edited", async () => {
    const { ctx, run, stored } = ctxFor({ id: "x", number: "PO-2025-000003", __version: 1 });
    await runButtonAction(ctx, "save", [], { id: "x", number: "HACKED", note: "n" });
    expect(stored[0].number).toBe("PO-2025-000003");
    expect(run.mock.calls.some(([q]) => String(q).includes("RtAutoNumber"))).toBe(false);
  });
});

describe("Notify steps: who gets told", () => {
  const f = (n: string, x = "") => `<Field name="${n}" type="string"${x}/>`;
  const model = buildAppModel([
    { tag: "Entity", name: "User", xml: `<Entity name="User" isAccount="true">${f("id", ` key="true"`)}${f("email")}${f("passwordHash")}${f("mustChangePassword")}${f("firstName")}${f("lastName")}${f("dob")}${f("emailVerified")}${f("authProvider")}${f("roleId")}</Entity>` },
    { tag: "Entity", name: "AccessRole", xml: `<Entity name="AccessRole">${f("id", ` key="true"`)}${f("name")}</Entity>` },
    { tag: "Relationship", name: "r", xml: `<Relationship name="r" fromEntity="User" fromField="roleId" toEntity="AccessRole" toField="id" cardinality="N:1"/>` },
    { tag: "Screen", name: "S", xml: `<Screen name="S" entity="AccessRole" type="form" requiresRole="Manager"><Fields/></Screen>` },
  ]);
  const tx = (lists: Record<string, unknown>[][]) => ({ run: vi.fn(async () => ({ records: (lists.shift() ?? []).map((r) => ({ get: () => r })) })) }) as unknown as Transaction;

  it("accepts an email, or a field holding one", async () => {
    expect(await recipientsOf(tx([]), 1, model, { to: "Boss@Example.com", values: {} })).toEqual(["boss@example.com"]);
    expect(await recipientsOf(tx([]), 1, model, { to: "ownerEmail", values: { ownerEmail: "o@example.com" } })).toEqual(["o@example.com"]);
  });

  it("reaches everyone holding a role", async () => {
    const lists = [[{ id: "r1", name: "Manager" }], [{ id: "u1", email: "m1@example.com", roleId: "r1" }, { id: "u2", email: "m2@example.com", roleId: "r1" }, { id: "u3", email: "x@example.com", roleId: "r2" }]];
    expect(await recipientsOf(tx(lists), 1, model, { to: "manager", values: {} })).toEqual(["m1@example.com", "m2@example.com"]);
  });

  it("reaches nobody for a value it can't resolve", async () => {
    expect(await recipientsOf(tx([[{ id: "r1", name: "Manager" }]]), 1, model, { to: "someone", values: {} })).toEqual([]);
  });
});
