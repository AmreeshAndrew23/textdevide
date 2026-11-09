import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";
import { isScoped, matchesScope, resolveScope, scopeProblems } from "./rowScope.js";
import { buildAppModel, type StoredElement } from "./publicAccess.js";

const f = (n: string, x = "") => `<Field name="${n}" type="string"${x}/>`;
const appt = (attrs: string) => `<Entity name="Appointment"${attrs}>${f("id", ` key="true"`)}${f("doctorId")}${f("ownerEmail")}${f("userId")}</Entity>`;
const rel = (name: string, field: string, to: string) => ({ tag: "Relationship", name, xml: `<Relationship name="${name}" fromEntity="Appointment" fromField="${field}" toEntity="${to}" toField="id" cardinality="N:1"/>` });
const modelFor = (attrs: string, extra: StoredElement[] = []) => buildAppModel([
  { tag: "Entity", name: "User", xml: `<Entity name="User" isAccount="true">${f("id", ` key="true"`)}${f("email")}${f("passwordHash")}${f("mustChangePassword")}${f("firstName")}${f("lastName")}${f("dob")}${f("emailVerified")}${f("authProvider")}</Entity>` },
  { tag: "Entity", name: "Doctor", xml: `<Entity name="Doctor">${f("id", ` key="true"`)}${f("email")}</Entity>` },
  { tag: "Entity", name: "Ward", xml: `<Entity name="Ward">${f("id", ` key="true"`)}</Entity>` },
  { tag: "Entity", name: "Appointment", xml: appt(attrs) },
  ...extra,
]);
const entity = (m: ReturnType<typeof modelFor>) => m.entities.find((e) => e.name === "Appointment")!;
const txWith = (lists: Record<string, unknown>[][]) => ({
  run: vi.fn(async () => ({ records: (lists.shift() ?? []).map((r) => ({ get: (k: string) => (k === "n" ? r : r[k]) })) })),
}) as unknown as Transaction;
const viewer = { identity: "Rao@Example.com", role: "Doctor" };

describe("rowScope: which records a signed-in user can reach", () => {
  it("limits everyone except exempt roles, and never scopes accounts", () => {
    const m = modelFor(` scopeBy="doctorId" scopeExempt="Admin,Receptionist"`);
    expect(isScoped(entity(m), "Doctor")).toBe(true);
    expect(isScoped(entity(m), null)).toBe(true);
    expect(isScoped(entity(m), "Admin")).toBe(false);
    expect(isScoped(m.entities.find((e) => e.name === "Doctor")!, "Doctor")).toBe(false);
  });

  it("matches through a linked record by sign-in email, case-insensitively", async () => {
    const m = modelFor(` scopeBy="doctorId"`, [rel("r", "doctorId", "Doctor")]);
    const scope = await resolveScope(txWith([[{ id: "d1", email: "rao@example.com" }, { id: "d2", email: "lee@example.com" }]]), 1, m, entity(m), viewer);
    expect(scope.fill).toBe("d1");
    expect(matchesScope({ doctorId: "d1" }, scope)).toBe(true);
    expect(matchesScope({ doctorId: "d2" }, scope)).toBe(false);
    expect(matchesScope({}, scope)).toBe(false);
  });

  it("matches a link straight to the account", async () => {
    const m = modelFor(` scopeBy="userId"`, [rel("r", "userId", "User")]);
    const scope = await resolveScope(txWith([[{ id: "u9", email: "rao@example.com" }]]), 1, m, entity(m), viewer);
    expect(matchesScope({ userId: "u9" }, scope)).toBe(true);
  });

  it("matches an email stored on the record", async () => {
    const m = modelFor(` scopeBy="ownerEmail"`);
    const scope = await resolveScope(txWith([]), 1, m, entity(m), viewer);
    expect(matchesScope({ ownerEmail: "rao@example.com" }, scope)).toBe(true);
    expect(matchesScope({ ownerEmail: "x@example.com" }, scope)).toBe(false);
  });

  it("matches records the user created", async () => {
    const m = modelFor(` scopeBy="creator"`);
    const scope = await resolveScope(txWith([[{ k: "a1" }]]), 1, m, entity(m), viewer);
    expect(scope.creator).toBe(true);
    expect(matchesScope({ id: "a1" }, scope)).toBe(true);
    expect(matchesScope({ id: "a2" }, scope)).toBe(false);
  });

  it("fails closed when a user has no linked record or the rule can't work", async () => {
    const linked = modelFor(` scopeBy="doctorId"`, [rel("r", "doctorId", "Doctor")]);
    const none = await resolveScope(txWith([[{ id: "d2", email: "lee@example.com" }]]), 1, linked, entity(linked), viewer);
    expect(matchesScope({ doctorId: "d2" }, none)).toBe(false);
    const missing = modelFor(` scopeBy="nope"`);
    expect((await resolveScope(txWith([]), 1, missing, entity(missing), viewer)).allowed.size).toBe(0);
    const noEmail = modelFor(` scopeBy="doctorId"`, [rel("r", "doctorId", "Ward")]);
    expect((await resolveScope(txWith([]), 1, noEmail, entity(noEmail), viewer)).allowed.size).toBe(0);
    expect(scopeProblems(noEmail)[0]).toMatch(/no email field/);
    expect(scopeProblems(missing)[0]).toMatch(/isn't one of its fields/);
  });
});
