import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";
import { runAction, runButtonAction, substituteFieldTemplate, type ActionRunContext } from "./applicationEngine.js";
import type { EntityDef, ActionDef, RelationshipDef } from "./applicationModel.js";
import { hashPassword } from "../services/authService.js";

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
  name: "PurchaseOrder", auditing: null, isAccount: false,
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
      { records: [] }, // CREATED_BY edge upsert
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
    const tx = fakeTx([{ records: [] }, { records: [] }, { records: [] }, { records: [record({ id: "po1" })] }]);
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

const USER: EntityDef = {
  name: "User", auditing: null, isAccount: true,
  fields: [
    { name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] },
    { name: "username", type: "string", key: false, required: true, unique: true, autoNumber: null, values: [] },
    { name: "passwordHash", type: "string", key: false, required: true, unique: false, autoNumber: null, values: [] },
    { name: "mustChangePassword", type: "boolean", key: false, required: true, unique: false, autoNumber: null, values: [] },
  ],
};

function accountCtx(tx: Transaction, identity: string | null = null): ActionRunContext {
  return { applicationId: 7, entity: USER, relationships: [], validations: [], auditing: null, session: { identity, vars: {} }, tx };
}

describe("applicationEngine.runButtonAction: \"login\" — real per-application end-user accounts", () => {
  const realHash = hashPassword("secret123");

  it("issues a session on correct username+password", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: false })] }]);
    const results = await runButtonAction(accountCtx(tx), "login", [], { username: "alice", password: "secret123" });
    expect(results).toEqual([
      { type: "message", messageType: "success", value: "Logged in." },
      { type: "session", identity: "alice", mustChangePassword: false, role: null },
    ]);
  });

  it("carries mustChangePassword through to the issued session", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: true })] }]);
    const results = await runButtonAction(accountCtx(tx), "login", [], { username: "alice", password: "secret123" });
    expect(results).toContainEqual({ type: "session", identity: "alice", mustChangePassword: true, role: null });
  });

  it("rejects a wrong password without revealing whether the username exists", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: false })] }]);
    const results = await runButtonAction(accountCtx(tx), "login", [], { username: "alice", password: "wrong" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Invalid username or password." }]);
  });

  it("rejects an unknown username the same way as a wrong password", async () => {
    const tx = fakeTx([{ records: [] }]);
    const results = await runButtonAction(accountCtx(tx), "login", [], { username: "nobody", password: "secret123" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Invalid username or password." }]);
  });

  it("rejects an empty username/password before touching the database", async () => {
    const tx = fakeTx([]);
    const results = await runButtonAction(accountCtx(tx), "login", [], { username: "", password: "" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Username and password are required." }]);
  });

  it("refuses to run against an entity that isn't marked isAccount", async () => {
    await expect(runButtonAction(ctx(fakeTx([])), "login", [], { username: "x", password: "y" })).rejects.toThrow(/isAccount entity/);
  });
});

// RBAC: the role lookup is strictly conditional on the account entity actually declaring a roleId
// field — every fixture above lacks one, so none of those tests ever trigger the extra query (this
// is a hard requirement of the implementation, not an optimization, specifically so the plain
// login/register/changePassword tests above don't need touching for this feature).
const USER_WITH_ROLE: EntityDef = {
  ...USER,
  fields: [...USER.fields, { name: "roleId", type: "string", key: false, required: false, unique: false, autoNumber: null, values: [] }],
};
const userToRole: RelationshipDef = { name: "User-to-AccessRole", fromEntity: "User", fromField: "roleId", toEntity: "AccessRole", toField: "id", cardinality: "N:1", onDelete: "setNull" };

describe("applicationEngine.runButtonAction: \"login\" — RBAC role resolution", () => {
  const realHash = hashPassword("secret123");

  it("resolves and includes the role when the account entity has roleId and it's set", async () => {
    const tx = fakeTx([
      { records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: false, roleId: "role-1" })] }, // username lookup
      { records: [record({ name: "HR" })] }, // the AccessRole lookup
    ]);
    const roleCtx: ActionRunContext = { applicationId: 7, entity: USER_WITH_ROLE, relationships: [userToRole], validations: [], auditing: null, session: { identity: null, vars: {} }, tx };
    const results = await runButtonAction(roleCtx, "login", [], { username: "alice", password: "secret123" });
    expect(results).toContainEqual({ type: "session", identity: "alice", mustChangePassword: false, role: "HR" });
  });

  it("resolves to a null role when roleId is blank, without an extra query", async () => {
    const tx = fakeTx([
      { records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: false, roleId: null })] },
    ]);
    const roleCtx: ActionRunContext = { applicationId: 7, entity: USER_WITH_ROLE, relationships: [userToRole], validations: [], auditing: null, session: { identity: null, vars: {} }, tx };
    const results = await runButtonAction(roleCtx, "login", [], { username: "alice", password: "secret123" });
    expect(results).toContainEqual({ type: "session", identity: "alice", mustChangePassword: false, role: null });
  });
});

describe("applicationEngine.runButtonAction: \"register\" — the only way the FIRST account ever gets created", () => {
  it("creates a new account and immediately signs it in", async () => {
    const tx = fakeTx([
      { records: [] }, // username-taken check — nobody yet
      { records: [] }, // saveEntityRow's existing-row check (by id, a brand new uuid)
      { records: [] }, // MERGE write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "u1", username: "bob", mustChangePassword: false })] }, // final read-back
    ]);
    const results = await runButtonAction(accountCtx(tx), "register", [], { username: "bob", password: "secret123" });
    expect(results).toEqual([
      { type: "message", messageType: "success", value: "Account created." },
      { type: "session", identity: "bob", mustChangePassword: false, role: null },
    ]);
  });

  it("rejects a username that's already taken, without writing anything", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", username: "bob" })] }]);
    const results = await runButtonAction(accountCtx(tx), "register", [], { username: "bob", password: "secret123" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "That username is already taken." }]);
  });

  it("rejects an empty username/password before touching the database", async () => {
    const results = await runButtonAction(accountCtx(fakeTx([])), "register", [], { username: "", password: "" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Username and password are required." }]);
  });

  it("refuses to run against an entity that isn't marked isAccount", async () => {
    await expect(runButtonAction(ctx(fakeTx([])), "register", [], { username: "x", password: "y" })).rejects.toThrow(/isAccount entity/);
  });
});

describe("applicationEngine.runButtonAction: \"changePassword\" — requires an existing session", () => {
  const realHash = hashPassword("oldpass");

  it("rejects when nobody is logged in", async () => {
    const results = await runButtonAction(accountCtx(fakeTx([]), null), "changePassword", [], { currentPassword: "oldpass", newPassword: "newpass" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "You must be logged in to change your password." }]);
  });

  it("rejects an incorrect current password, without writing anything", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: false })] }]);
    const results = await runButtonAction(accountCtx(tx, "alice"), "changePassword", [], { currentPassword: "wrong", newPassword: "newpass" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Current password is incorrect." }]);
  });

  it("on success, writes the new hash, clears mustChangePassword, and re-issues the session", async () => {
    const tx = fakeTx([
      { records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: true })] }, // lookup by username for password verification
      { records: [record({ id: "u1", username: "alice", passwordHash: realHash, mustChangePassword: true })] }, // saveEntityRow's existing-row check (by id)
      { records: [record({ id: "u1" })] }, // conditional write — matched, succeeded
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "u1", username: "alice", mustChangePassword: false })] }, // final read-back
    ]);
    const results = await runButtonAction(accountCtx(tx, "alice"), "changePassword", [], { currentPassword: "oldpass", newPassword: "newpass" });
    expect(results).toEqual([
      { type: "message", messageType: "success", value: "Password changed." },
      { type: "session", identity: "alice", mustChangePassword: false, role: null },
    ]);
  });
});

// CURRENT (email-based) account shape — the convention every app generates from now on. The
// LEGACY (username-based) fixtures above exercise the dual-shape branching from the other side;
// everything below exercises identifierFieldOf's "email" branch plus the new OTP/OAuth built-ins.
const USER_EMAIL: EntityDef = {
  name: "User", auditing: null, isAccount: true,
  fields: [
    { name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] },
    { name: "email", type: "string", key: false, required: true, unique: true, autoNumber: null, values: [] },
    { name: "passwordHash", type: "string", key: false, required: false, unique: false, autoNumber: null, values: [] },
    { name: "mustChangePassword", type: "boolean", key: false, required: true, unique: false, autoNumber: null, values: [] },
    { name: "firstName", type: "string", key: false, required: false, unique: false, autoNumber: null, values: [] },
    { name: "lastName", type: "string", key: false, required: false, unique: false, autoNumber: null, values: [] },
    { name: "dob", type: "date", key: false, required: false, unique: false, autoNumber: null, values: [] },
    { name: "emailVerified", type: "boolean", key: false, required: true, unique: false, autoNumber: null, values: [] },
    { name: "authProvider", type: "string", key: false, required: true, unique: false, autoNumber: null, values: [] },
  ],
};
function emailAccountCtx(tx: Transaction, identity: string | null = null): ActionRunContext {
  return { applicationId: 7, entity: USER_EMAIL, relationships: [], validations: [], auditing: null, session: { identity, vars: {} }, tx };
}
const adultDob = new Date(Date.now() - 25 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const minorDob = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("applicationEngine.runButtonAction: \"register\" — current (email-based) shape", () => {
  it("creates an unverified account, emails an OTP, and does NOT sign the user in", async () => {
    const tx = fakeTx([
      { records: [] }, // email-taken check — nobody yet
      { records: [] }, // saveEntityRow's existing-row check (by id, a brand new uuid)
      { records: [] }, // MERGE write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "u1" })] }, // final read-back
      { records: [] }, // setEntityOtp's raw SET
    ]);
    const results = await runButtonAction(emailAccountCtx(tx), "register", [], {
      email: "bob@example.com", password: "secret123", firstName: "Bob", lastName: "Jones", dob: adultDob,
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ type: "message", messageType: "success", value: "Account created — check your email for a verification code." });
    expect(results[1]).toMatchObject({ type: "sendEmail", to: "bob@example.com", subject: "Verify your email" });
    expect((results[1] as { body: string }).body).toMatch(/Your verification code is \d{6}\. It expires in 10 minutes\./);
  });

  it("rejects a duplicate email without writing anything", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", email: "bob@example.com" })] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "register", [], {
      email: "bob@example.com", password: "secret123", firstName: "Bob", lastName: "Jones", dob: adultDob,
    });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "An account with that email already exists." }]);
  });

  it("rejects someone under the minimum signup age, before touching the database", async () => {
    const results = await runButtonAction(emailAccountCtx(fakeTx([])), "register", [], {
      email: "kid@example.com", password: "secret123", firstName: "Kid", lastName: "Jones", dob: minorDob,
    });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "You must be at least 18 years old to create an account." }]);
  });

  it("rejects a missing first/last name, before touching the database", async () => {
    const results = await runButtonAction(emailAccountCtx(fakeTx([])), "register", [], {
      email: "bob@example.com", password: "secret123", firstName: "", lastName: "", dob: adultDob,
    });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "First name and last name are required." }]);
  });

  it("rejects a malformed email, before touching the database", async () => {
    const results = await runButtonAction(emailAccountCtx(fakeTx([])), "register", [], {
      email: "not-an-email", password: "secret123", firstName: "Bob", lastName: "Jones", dob: adultDob,
    });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "A valid email address is required." }]);
  });
});

describe("applicationEngine.runButtonAction: \"login\" — current (email-based) shape", () => {
  const realHash = hashPassword("secret123");

  it("logs in a verified account", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", email: "bob@example.com", passwordHash: realHash, mustChangePassword: false, emailVerified: true })] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "login", [], { email: "bob@example.com", password: "secret123" });
    expect(results).toEqual([
      { type: "message", messageType: "success", value: "Logged in." },
      { type: "session", identity: "bob@example.com", mustChangePassword: false, role: null },
    ]);
  });

  it("blocks an unverified account even with the correct password", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", email: "bob@example.com", passwordHash: realHash, mustChangePassword: false, emailVerified: false })] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "login", [], { email: "bob@example.com", password: "secret123" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Please verify your email before logging in." }]);
  });

  it("points an OAuth-only account at the OAuth button instead of a generic failure", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", email: "bob@example.com", passwordHash: null, emailVerified: true })] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "login", [], { email: "bob@example.com", password: "anything" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "This account signs in with Google or GitHub — use that button instead." }]);
  });

  it("rejects an unknown email generically", async () => {
    const tx = fakeTx([{ records: [] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "login", [], { email: "nobody@example.com", password: "secret123" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Invalid email or password." }]);
  });
});

describe("applicationEngine.runButtonAction: \"changePassword\" — current shape, OAuth-only account", () => {
  it("tells an OAuth-only account it has no password to change", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", email: "bob@example.com", passwordHash: null })] }]);
    const results = await runButtonAction(emailAccountCtx(tx, "bob@example.com"), "changePassword", [], { currentPassword: "x", newPassword: "y" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "This account doesn't have a password — it signs in with Google or GitHub." }]);
  });
});

describe("applicationEngine.runButtonAction: \"verifyEmail\"", () => {
  function otpRow(extra: Record<string, unknown> = {}) {
    return {
      id: "u1", email: "bob@example.com", mustChangePassword: false, emailVerified: false, authProvider: "password",
      __otpCode: "123456", __otpPurpose: "verifyEmail", __otpExpiresAt: new Date(Date.now() + 5 * 60000).toISOString(), ...extra,
    };
  }

  it("confirms the code, flips emailVerified, and logs the user in", async () => {
    const row = otpRow();
    const tx = fakeTx([
      { records: [record(row)] }, // getEntityRowByField email lookup
      { records: [record(row)] }, // consumeEntityOtp's getEntityRow (by id)
      { records: [] }, // consumeEntityOtp's clearing SET
      { records: [record(row)] }, // saveEntityRow's existing-row check
      { records: [record({ ...row, emailVerified: true })] }, // conditional write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ ...row, emailVerified: true })] }, // final read-back
    ]);
    const results = await runButtonAction(emailAccountCtx(tx), "verifyEmail", [], { email: "bob@example.com", otpCode: "123456" });
    expect(results).toEqual([
      { type: "message", messageType: "success", value: "Email verified!" },
      { type: "session", identity: "bob@example.com", mustChangePassword: false, role: null },
    ]);
  });

  it("rejects a wrong code without writing anything", async () => {
    const row = otpRow();
    const tx = fakeTx([{ records: [record(row)] }, { records: [record(row)] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "verifyEmail", [], { email: "bob@example.com", otpCode: "000000" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Invalid or expired code." }]);
  });

  it("rejects an expired code", async () => {
    const row = otpRow({ __otpExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const tx = fakeTx([{ records: [record(row)] }, { records: [record(row)] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "verifyEmail", [], { email: "bob@example.com", otpCode: "123456" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Invalid or expired code." }]);
  });
});

describe("applicationEngine.runButtonAction: \"requestPasswordReset\" — enumeration-safe", () => {
  it("returns the generic message for an unknown email, with no email sent", async () => {
    const tx = fakeTx([{ records: [] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "requestPasswordReset", [], { email: "nobody@example.com" });
    expect(results).toEqual([{ type: "message", messageType: "success", value: "If that email is registered, a reset code has been sent." }]);
  });

  it("returns the SAME generic message for an OAuth-only account (no password to reset), with no email sent", async () => {
    const tx = fakeTx([{ records: [record({ id: "u1", email: "bob@example.com", passwordHash: null })] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "requestPasswordReset", [], { email: "bob@example.com" });
    expect(results).toEqual([{ type: "message", messageType: "success", value: "If that email is registered, a reset code has been sent." }]);
  });

  it("emails a real OTP for a known, password-based account", async () => {
    const tx = fakeTx([
      { records: [record({ id: "u1", email: "bob@example.com", passwordHash: hashPassword("secret123") })] },
      { records: [] }, // setEntityOtp's raw SET
    ]);
    const results = await runButtonAction(emailAccountCtx(tx), "requestPasswordReset", [], { email: "bob@example.com" });
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ type: "sendEmail", to: "bob@example.com", subject: "Reset your password" });
    expect((results[1] as { body: string }).body).toMatch(/Your password reset code is \d{6}\. It expires in 10 minutes\./);
  });
});

describe("applicationEngine.runButtonAction: \"resetPassword\"", () => {
  function otpRow(extra: Record<string, unknown> = {}) {
    return {
      id: "u1", email: "bob@example.com", passwordHash: hashPassword("oldpass"), mustChangePassword: false, emailVerified: true, authProvider: "password",
      __otpCode: "654321", __otpPurpose: "resetPassword", __otpExpiresAt: new Date(Date.now() + 5 * 60000).toISOString(), ...extra,
    };
  }

  it("confirms the code and writes the new password hash", async () => {
    const row = otpRow();
    const tx = fakeTx([
      { records: [record(row)] }, // email lookup
      { records: [record(row)] }, // consumeEntityOtp's getEntityRow
      { records: [] }, // consumeEntityOtp's clearing SET
      { records: [record(row)] }, // saveEntityRow's existing-row check
      { records: [record(row)] }, // conditional write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record(row)] }, // final read-back
    ]);
    const results = await runButtonAction(emailAccountCtx(tx), "resetPassword", [], { email: "bob@example.com", otpCode: "654321", newPassword: "newpass123" });
    expect(results).toEqual([{ type: "message", messageType: "success", value: "Password reset — you can now log in." }]);
  });

  it("rejects a wrong code without writing anything", async () => {
    const row = otpRow();
    const tx = fakeTx([{ records: [record(row)] }, { records: [record(row)] }]);
    const results = await runButtonAction(emailAccountCtx(tx), "resetPassword", [], { email: "bob@example.com", otpCode: "000000", newPassword: "newpass123" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "Invalid or expired code." }]);
  });
});

// Google/GitHub's full happy paths need a real JWKS verification / live code-exchange round trip
// respectively — covered by the live smoke test (same precedent as everywhere else in this
// session that touches an external provider), not mocked here. These are the two guard clauses
// that DON'T need network access: an entity missing "email" at all, and GitHub specifically being
// unconfigured in this environment (confirmed no GITHUB_CLIENT_ID/SECRET are set for this test run).
describe("applicationEngine.runButtonAction: \"googleLogin\"/\"githubLogin\" — guard clauses", () => {
  it("googleLogin refuses to run against a legacy (username-based) entity with no email field", async () => {
    const results = await runButtonAction(accountCtx(fakeTx([])), "googleLogin", [], { credential: "x" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "This application's account entity doesn't support Google sign-in." }]);
  });

  it("githubLogin refuses to run against a legacy (username-based) entity with no email field", async () => {
    const results = await runButtonAction(accountCtx(fakeTx([])), "githubLogin", [], { code: "x" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "This application's account entity doesn't support GitHub sign-in." }]);
  });

  it("githubLogin reports clearly when GitHub sign-in isn't configured", async () => {
    const results = await runButtonAction(emailAccountCtx(fakeTx([])), "githubLogin", [], { code: "x" });
    expect(results).toEqual([{ type: "message", messageType: "error", value: "GitHub sign-in is not configured." }]);
  });
});
