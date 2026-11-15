import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";

const saved: Record<string, unknown>[] = [];
vi.mock("./applicationEngine.js", () => ({
  runButtonAction: vi.fn(async (_ctx: unknown, _action: string, _actions: unknown, values: Record<string, unknown>) => {
    if (values.name === "Broken") return [{ type: "message", messageType: "error", value: "Visit.visitDate is required" }];
    saved.push(values);
    return [{ type: "message", messageType: "success", value: "Created successfully." }];
  }),
}));
vi.mock("./entityStore.js", () => ({
  listEntityRows: vi.fn(async (_tx: unknown, _app: unknown, entity: { name: string }) =>
    entity.name === "Doctor"
      ? [{ id: "d1", name: "Dr. Rao", email: "rao@x.com" }, { id: "d2", name: "Dr. Iyer" }, { id: "d3", name: "Dr. Iyer" }]
      : []),
}));

const { cellValue, importRows, importableFields, parseDate, displayFieldOf } = await import("./csvImport.js");
const { buildAppModel } = await import("./publicAccess.js");

const f = (n: string, x = "") => `<Field name="${n}"${x}/>`;
const model = buildAppModel([
  { tag: "Entity", name: "Doctor", xml: `<Entity name="Doctor">${f("id", ` type="string" key="true"`)}${f("name", ` type="string"`)}${f("email", ` type="string"`)}</Entity>` },
  {
    tag: "Entity", name: "Visit",
    xml: `<Entity name="Visit">${f("id", ` type="string" key="true"`)}${f("number", ` type="string" autoNumber="v"`)}${f("name", ` type="string"`)}${f("doctorId", ` type="string"`)}${f("fee", ` type="decimal"`)}${f("visitDate", ` type="date"`)}${f("paid", ` type="boolean"`)}<Field name="status" type="enum"><Value>Booked</Value><Value>Done</Value></Field>${f("createdBy", ` type="string"`)}</Entity>`,
  },
  { tag: "Relationship", name: "r", xml: `<Relationship name="r" fromEntity="Visit" fromField="doctorId" toEntity="Doctor" toField="id" cardinality="N:1"/>` },
]);
const visit = model.entities.find((e) => e.name === "Visit")!;
const autoNumbers = { v: { id: "v", start: 1, increment: 1, padLength: 3, reset: "never", prefix: "V-" } } as never;
const auditing = { name: "a", fields: [{ name: "createdBy", role: "createdBy" }] } as never;
const ctx = { applicationId: 1, model, entity: visit, validations: [], auditing, autoNumbers, identity: "o@x.com", role: null };
const tx = {} as Transaction;

beforeEach(() => { saved.length = 0; });

describe("reading spreadsheet cells", () => {
  it("understands the date formats people actually type", () => {
    expect(parseDate("2026-03-13")).toBe("2026-03-13");
    expect(parseDate("13/03/2026")).toBe("2026-03-13");
    expect(parseDate("13-Mar-2026")).toBe("2026-03-13");
    expect(parseDate("March 13, 2026")).toBe("2026-03-13");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("soon")).toBeNull();
  });

  it("cleans numbers, yes/no and choice lists, and explains what's wrong", () => {
    const field = (name: string) => visit.fields.find((x) => x.name === name)!;
    expect(cellValue("₹1,250.50", field("fee"))).toEqual({ value: 1250.5 });
    expect(cellValue("abc", field("fee")).error).toMatch(/Fee should be a number/);
    expect(cellValue("Yes", field("paid"))).toEqual({ value: true });
    expect(cellValue("done", field("status"))).toEqual({ value: "Done" });
    expect(cellValue("Lost", field("status")).error).toMatch(/one of Booked, Done/);
    expect(cellValue("  ", field("name"))).toEqual({});
  });

  it("never lets a file set the key, a generated number or an audit stamp", () => {
    expect(importableFields(visit, auditing, autoNumbers).map((x) => x.name)).toEqual(["name", "doctorId", "fee", "visitDate", "paid", "status"]);
    expect(displayFieldOf(model.entities[0])).toBe("name");
  });
});

describe("importing rows", () => {
  it("adds good rows as new records, resolving linked names, and reports bad ones by row", async () => {
    const result = await importRows(tx, ctx, [
      { name: "Asha", doctorId: "dr. rao", fee: "500", visitDate: "13/03/2026", id: "HACK", number: "V-999" },
      { name: "Ravi", doctorId: "d2", status: "Lost" },
      { name: "Meena", doctorId: "Dr. Iyer" },
      { name: "Broken" },
      { name: "", fee: "" },
      { name: "Kiran", doctorId: "Nobody" },
    ]);
    expect(result.created).toBe(1);
    expect(saved[0]).toMatchObject({ name: "Asha", doctorId: "d1", fee: 500, visitDate: "2026-03-13" });
    expect(saved[0].id).not.toBe("HACK");
    expect(saved[0].number).toBeUndefined();
    expect(result.errors).toEqual([
      { row: 3, message: expect.stringMatching(/Status must be one of/) },
      { row: 4, message: expect.stringMatching(/more than one Doctor is called "Dr. Iyer"/) },
      { row: 5, message: "Visit date is required" },
      { row: 7, message: 'no Doctor called "Nobody"' },
    ]);
  });

  it("keeps a limited member to their own records", async () => {
    const scope = { field: "doctorId", allowed: new Set(["d1"]), fill: "d1", creator: false };
    const result = await importRows(tx, { ...ctx, scope }, [{ name: "Mine" }, { name: "Theirs", doctorId: "d2" }]);
    expect(result.created).toBe(1);
    expect(saved[0].doctorId).toBe("d1");
    expect(result.errors).toEqual([{ row: 3, message: "you can only add records that belong to you" }]);
  });
});
