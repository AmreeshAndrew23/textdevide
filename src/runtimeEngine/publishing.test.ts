import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";
import type { ActionRunContext } from "./applicationEngine.js";
import { buildAppModel, type StoredElement } from "./publicAccess.js";
import { inviteIdFromToken, inviteToken, isInviteExpired, isInviteTokenValid, makeSignupPolicy, roleSetupOf } from "./publishing.js";

const ELEMENTS: StoredElement[] = [
  { tag: "Entity", name: "User", xml: `<Entity name="User" isAccount="true"><Field name="id" type="string" key="true"/><Field name="email" type="string"/><Field name="passwordHash" type="string"/><Field name="mustChangePassword" type="boolean"/><Field name="firstName" type="string"/><Field name="lastName" type="string"/><Field name="dob" type="date"/><Field name="emailVerified" type="boolean"/><Field name="authProvider" type="string"/><Field name="roleId" type="string"/></Entity>` },
  { tag: "Entity", name: "AccessRole", xml: `<Entity name="AccessRole"><Field name="id" type="string" key="true"/><Field name="name" type="string"/></Entity>` },
  { tag: "Relationship", name: "userRole", xml: `<Relationship name="userRole" fromEntity="User" fromField="roleId" toEntity="AccessRole" toField="id" cardinality="N:1"/>` },
  { tag: "Screen", name: "Staff", xml: `<Screen name="Staff" entity="AccessRole" type="form" requiresRole="Admin,Receptionist"><Fields/></Screen>` },
];
const model = buildAppModel(ELEMENTS);
const rows = (list: Record<string, unknown>[]) => ({ records: list.map((r) => ({ get: () => r })) });

function ctxWith(responses: ReturnType<typeof rows>[]) {
  const run = vi.fn(async () => responses.shift() ?? rows([]));
  return { applicationId: 1, entity: model.accountEntity!, relationships: model.relationships, tx: { run } as unknown as Transaction } as unknown as ActionRunContext;
}
const ROLES = [{ id: "r-admin", name: "Admin" }, { id: "r-rec", name: "Receptionist" }];

describe("publishing: who can join a published app, and with which role", () => {
  it("recognizes the app's role setup", () => {
    expect(roleSetupOf(model)).toMatchObject({ roleNames: ["Admin", "Receptionist"], topRole: "Admin" });
  });

  it("refuses an uninvited email on an invite-only app", async () => {
    const decision = await makeSignupPolicy(model, { mode: "invite", invites: [] }).decide(ctxWith([]), "stranger@example.com");
    expect(decision.allowed).toBe(false);
  });

  it("gives an invited person their invited role, matching email case-insensitively", async () => {
    const policy = makeSignupPolicy(model, { mode: "invite", invites: [{ email: "desk@example.com", role: "Receptionist" }] });
    const decision = await policy.decide(ctxWith([rows([]), rows(ROLES)]), "Desk@Example.com");
    expect(decision).toEqual({ allowed: true, roleId: "r-rec" });
  });

  it("makes the first account the top role, and later ones roleless", async () => {
    const policy = makeSignupPolicy(model, { mode: "open", invites: [] });
    expect(await policy.decide(ctxWith([rows([]), rows(ROLES)]), "first@example.com")).toEqual({ allowed: true, roleId: "r-admin" });
    expect(await policy.decide(ctxWith([rows([{ id: "u1", roleId: "r-admin" }])]), "next@example.com")).toEqual({ allowed: true });
  });
});

describe("publishing: personal invite links", () => {
  const invite = { id: 42, applicationId: 7, email: "desk@example.com" };

  it("accepts only the exact link issued for that invite", () => {
    const token = inviteToken(invite);
    expect(inviteIdFromToken(token)).toBe(42);
    expect(isInviteTokenValid(token, invite)).toBe(true);
    expect(isInviteTokenValid(token, { ...invite, email: "other@example.com" })).toBe(false);
    expect(isInviteTokenValid(token, { ...invite, applicationId: 8 })).toBe(false);
    expect(isInviteTokenValid("42.forged", invite)).toBe(false);
    expect(inviteIdFromToken("junk")).toBeNull();
  });

  it("expires after 14 days", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    expect(isInviteExpired(new Date("2026-11-10T00:00:00Z"), now)).toBe(false);
    expect(isInviteExpired(new Date("2026-11-01T00:00:00Z"), now)).toBe(true);
    expect(isInviteExpired(null, now)).toBe(true);
  });

  it("skips the emailed code only for the email the link was issued to", async () => {
    const policy = makeSignupPolicy(model, { mode: "invite", invites: [{ email: "desk@example.com", role: null }], verifiedEmail: "desk@example.com" });
    expect((await policy.decide(ctxWith([rows([{ roleId: "x" }])]), "desk@example.com")).verified).toBe(true);
    const other = makeSignupPolicy(model, { mode: "open", invites: [], verifiedEmail: "desk@example.com" });
    expect((await other.decide(ctxWith([rows([{ roleId: "x" }])]), "someone@example.com")).verified).toBeUndefined();
  });
});
