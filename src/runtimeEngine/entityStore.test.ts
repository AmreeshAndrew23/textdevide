import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "neo4j-driver";
import {
  saveEntityRow, deleteEntityRow, restoreEntityRow, listEntityRows, getEntityRow,
  setEntityOtp, consumeEntityOtp, ValidationError, ConcurrencyError,
} from "./entityStore.js";
import type { EntityDef, RelationshipDef, ValidationDef, AuditingDef } from "./applicationModel.js";

// A minimal fake neo4j-driver Transaction: tx.run returns the next queued response in order,
// recording every (statement, params) pair it was called with so tests can assert on them. There
// is no real Neo4j reachable from this environment, so this is the only way to unit-test
// entityStore.ts's own decision logic (required/concurrency/validation/audit/cascade) without a
// live database — no existing precedent for this in the codebase, so this fake is deliberately
// minimal (just .run(), nothing else of the real driver's surface).
function fakeTx(responses: { records: { get: (key: string) => unknown }[] }[]) {
  const calls: { statement: string; params: unknown }[] = [];
  let i = 0;
  const run = vi.fn(async (statement: string, params?: unknown) => {
    calls.push({ statement, params });
    const res = responses[i++];
    if (!res) throw new Error(`fakeTx: no queued response for call #${i} (${statement})`);
    return res;
  });
  return { tx: { run } as unknown as Transaction, calls };
}

function record(props: Record<string, unknown>) {
  return { get: (key: string) => (key === "n" || key === "c" || key === "p" ? props : props[key]) };
}

const VENDOR: EntityDef = {
  name: "Vendor",
  auditing: "standard",
  isAccount: false,
  fields: [
    { name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] },
    { name: "name", type: "string", key: false, required: true, unique: false, autoNumber: null, values: [] },
    { name: "creditLimit", type: "decimal", key: false, required: false, unique: false, autoNumber: null, values: [] },
  ],
};
const AUDITING: AuditingDef = {
  name: "standard", concurrency: "timestamp",
  fields: [
    { role: "createdBy", name: "createdBy" }, { role: "createdOn", name: "createdOn" },
    { role: "updatedBy", name: "updatedBy" }, { role: "updatedOn", name: "updatedOn" },
  ],
};
const NO_RELATIONSHIPS: RelationshipDef[] = [];
const SESSION = { identity: "alice@example.com" };

describe("entityStore.saveEntityRow: required-field rejection happens before any database call", () => {
  it("rejects with ValidationError, never touching tx.run", async () => {
    const { tx, calls } = fakeTx([]);
    await expect(
      saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING, { id: "v1" }, SESSION) // name missing
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("entityStore.saveEntityRow: stale-edit conflict via the system-managed __version", () => {
  it("rejects with ConcurrencyError when the submitted __version doesn't match the stored row's", async () => {
    const { tx, calls } = fakeTx([
      { records: [record({ id: "v1", name: "Acme", __version: 2 })] }, // existing-row fetch
    ]);
    await expect(
      saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING,
        { id: "v1", name: "Acme Renamed", __version: 1 }, SESSION)
    ).rejects.toThrow(ConcurrencyError);
    expect(calls).toHaveLength(1); // never reaches the write
  });

  it("proceeds when the submitted __version matches the stored row's", async () => {
    const { tx } = fakeTx([
      { records: [record({ id: "v1", name: "Acme", __version: 1 })] }, // existing
      { records: [record({ id: "v1" })] }, // conditional write — matched, succeeded
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "v1", name: "Acme Renamed", __version: 2 })] }, // final read-back
    ]);
    const result = await saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING,
      { id: "v1", name: "Acme Renamed", __version: 1 }, SESSION);
    expect(result.created).toBe(false);
  });

  it("skips the check gracefully when the client never submitted __version (a pre-migration row, or a non-UI caller)", async () => {
    const { tx } = fakeTx([
      { records: [record({ id: "v1", name: "Acme" })] }, // existing, no __version property at all
      { records: [record({ id: "v1" })] },
      { records: [] },
      { records: [record({ id: "v1", name: "Acme Renamed" })] },
    ]);
    const result = await saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING,
      { id: "v1", name: "Acme Renamed" }, SESSION); // no __version submitted
    expect(result.created).toBe(false);
  });

  it("tight-race CAS: rejects with ConcurrencyError when the conditional write itself matches zero rows (another save landed between our read and our write)", async () => {
    const { tx } = fakeTx([
      { records: [record({ id: "v1", name: "Acme", __version: 1 })] }, // existing
      { records: [] }, // conditional write matched nothing — someone else won the race
    ]);
    await expect(
      saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING, { id: "v1", name: "Acme Renamed" }, SESSION)
    ).rejects.toThrow(ConcurrencyError);
  });
});

describe("entityStore.saveEntityRow: this entity's own Validations reject before any write", () => {
  const creditLimitNonNegative: ValidationDef = {
    id: "credit-non-negative", entity: "Vendor", when: "onSave", onViolation: "reject",
    dependsOn: [{ field: "creditLimit", via: null }], test: "creditLimit >= 0", message: "Credit limit cannot be negative",
  };

  it("rejects with the Validation's own message, and never reaches the write", async () => {
    const { tx, calls } = fakeTx([{ records: [] }]); // only the existing-row fetch happens
    await expect(
      saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [creditLimitNonNegative], AUDITING,
        { id: "v1", name: "Acme", creditLimit: -50 }, SESSION)
    ).rejects.toThrow("Credit limit cannot be negative");
    expect(calls).toHaveLength(1); // existing-row fetch only — no MERGE ever ran
  });

  it("passes and writes normally when the condition holds", async () => {
    const { tx } = fakeTx([
      { records: [] }, // no existing row — this is a create
      { records: [] }, // MERGE write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "v1", name: "Acme", creditLimit: 500 })] }, // final read-back
    ]);
    const result = await saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [creditLimitNonNegative], AUDITING,
      { id: "v1", name: "Acme", creditLimit: 500 }, SESSION);
    expect(result.created).toBe(true);
  });
});

describe("entityStore.saveEntityRow: audit stamping", () => {
  it("stamps createdBy/createdOn on a create, and updatedBy/updatedOn on both create and update", async () => {
    const { tx, calls } = fakeTx([
      { records: [] }, // no existing row
      { records: [] }, // MERGE write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "v1" })] }, // final read-back
    ]);
    await saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING, { id: "v1", name: "Acme" }, SESSION);
    const mergeCall = calls[1];
    const props = (mergeCall.params as { props: Record<string, unknown> }).props;
    expect(props.createdBy).toBe("alice@example.com");
    expect(props.updatedBy).toBe("alice@example.com");
    expect(typeof props.createdOn).toBe("string");
    expect(typeof props.updatedOn).toBe("string");
  });

  it("does NOT re-stamp createdBy/createdOn on an update", async () => {
    const { tx, calls } = fakeTx([
      { records: [record({ id: "v1", name: "Acme", createdBy: "bob@example.com", createdOn: "2020-01-01T00:00:00.000Z" })] },
      { records: [record({ id: "v1" })] }, // conditional write — matched, succeeded
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "v1" })] },
    ]);
    await saveEntityRow(tx, 7, VENDOR, NO_RELATIONSHIPS, [], AUDITING, { id: "v1", name: "Acme Updated" }, SESSION);
    const props = (calls[1].params as { props: Record<string, unknown> }).props;
    expect(props.createdBy).toBeUndefined();
    expect(props.createdOn).toBeUndefined();
    expect(props.updatedBy).toBe("alice@example.com");
  });
});

describe("entityStore.saveEntityRow: validating against a single PARENT record (the real Insurance Claims case found live)", () => {
  const CLAIM: EntityDef = {
    name: "Claim", auditing: null, isAccount: false,
    fields: [
      { name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] },
      { name: "policyId", type: "string", key: false, required: true, unique: false, autoNumber: null, values: [] },
      { name: "claimAmount", type: "decimal", key: false, required: true, unique: false, autoNumber: null, values: [] },
    ],
  };
  const claimToPolicy: RelationshipDef = { name: "Claim-to-Policy", fromEntity: "Claim", fromField: "policyId", toEntity: "Policy", toField: "id", cardinality: "N:1", onDelete: "restrict" };
  const claimWithinLimit: ValidationDef = {
    id: "claim-within-limit", entity: "Claim", when: "onSave", onViolation: "reject",
    dependsOn: [{ field: "claimAmount", via: null }, { field: "premiumAmount", via: "policies" }],
    test: "claimAmount <= policies.premiumAmount * 10", message: "Claim amount cannot exceed ten times the policy premium amount",
  };

  it("fetches the single related Policy row (not a collection) and evaluates the bare-alias arithmetic condition against it", async () => {
    const { tx, calls } = fakeTx([
      { records: [] }, // existing-row fetch — none, this is a create
      { records: [record({ id: "pol-1", premiumAmount: 500 })] }, // the parent Policy fetch
      { records: [] }, // MERGE write
      { records: [] }, // CREATED_BY edge upsert
      { records: [record({ id: "claim-1" })] }, // final read-back
    ]);
    const result = await saveEntityRow(tx, 7, CLAIM, [claimToPolicy], [claimWithinLimit], null,
      { id: "claim-1", policyId: "pol-1", claimAmount: 4999 }, SESSION);
    expect(result.created).toBe(true);
    expect(calls[1].statement).toContain("MATCH (p:");
  });

  it("rejects when the claim amount exceeds ten times the policy's premium", async () => {
    const { tx, calls } = fakeTx([
      { records: [] },
      { records: [record({ id: "pol-1", premiumAmount: 500 })] },
    ]);
    await expect(
      saveEntityRow(tx, 7, CLAIM, [claimToPolicy], [claimWithinLimit], null,
        { id: "claim-1", policyId: "pol-1", claimAmount: 5001 }, SESSION)
    ).rejects.toThrow("Claim amount cannot exceed ten times the policy premium amount");
    expect(calls).toHaveLength(2); // never reaches the write
  });
});

describe("entityStore.deleteEntityRow: onDelete restrict vs cascade", () => {
  const PO: EntityDef = { name: "PurchaseOrder", auditing: null, isAccount: false, fields: [{ name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] }] };
  const restrictRel: RelationshipDef = { name: "LineItem-to-PO", fromEntity: "LineItem", fromField: "poId", toEntity: "PurchaseOrder", toField: "id", cardinality: "N:1", onDelete: "restrict" };
  const cascadeRel: RelationshipDef = { ...restrictRel, onDelete: "cascade" };

  it("restrict: refuses to delete when a child row still references it", async () => {
    const { tx, calls } = fakeTx([
      { records: [record({ id: "po1" })] }, // leading existing-row fetch (found, not deleted)
      { records: [record({ cnt: 2 })] }, // count check finds 2 LineItems
    ]);
    await expect(deleteEntityRow(tx, 7, PO, [restrictRel], "po1", SESSION)).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(2); // never reaches the actual delete
  });

  it("restrict: deletes cleanly when no child rows reference it", async () => {
    const { tx, calls } = fakeTx([{ records: [record({ id: "po1" })] }, { records: [record({ cnt: 0 })] }, { records: [] }]);
    await deleteEntityRow(tx, 7, PO, [restrictRel], "po1", SESSION);
    expect(calls).toHaveLength(3); // existing fetch, count check, then the soft-delete itself
    expect(calls[2].statement).toContain("SET n.__deletedAt");
  });

  it("cascade: soft-deletes child rows first, then this row", async () => {
    const { tx, calls } = fakeTx([
      { records: [record({ id: "po1" })] }, { records: [record({ cnt: 2 })] }, { records: [] }, { records: [] },
    ]);
    await deleteEntityRow(tx, 7, PO, [cascadeRel], "po1", SESSION);
    expect(calls).toHaveLength(4); // existing fetch, count check, cascade soft-delete of children, soft-delete of this row
    expect(calls[2].statement).toContain("SET c.__deletedAt");
    expect(calls[2].statement).not.toContain("DETACH DELETE");
  });

  it("rejects when the row doesn't exist", async () => {
    const { tx, calls } = fakeTx([{ records: [] }]); // leading existing-row fetch finds nothing
    await expect(deleteEntityRow(tx, 7, PO, [], "ghost", SESSION)).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(1);
  });

  it("rejects when the row is already soft-deleted", async () => {
    const { tx, calls } = fakeTx([{ records: [record({ id: "po1", __deletedAt: "2024-01-01T00:00:00.000Z" })] }]);
    await expect(deleteEntityRow(tx, 7, PO, [], "po1", SESSION)).rejects.toThrow("already deleted");
    expect(calls).toHaveLength(1);
  });
});

describe("entityStore.restoreEntityRow", () => {
  const PO: EntityDef = { name: "PurchaseOrder", auditing: null, isAccount: false, fields: [{ name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] }] };

  it("un-deletes a soft-deleted row", async () => {
    const { tx, calls } = fakeTx([
      { records: [record({ id: "po1", __deletedAt: "2024-01-01T00:00:00.000Z" })] }, // found, deleted
      { records: [] }, // the restore write
    ]);
    await restoreEntityRow(tx, 7, PO, "po1");
    expect(calls).toHaveLength(2);
    expect(calls[1].statement).toContain("__deletedAt = null");
  });

  it("rejects when the row isn't actually deleted", async () => {
    const { tx } = fakeTx([{ records: [record({ id: "po1" })] }]); // found, not deleted
    await expect(restoreEntityRow(tx, 7, PO, "po1")).rejects.toThrow("isn't deleted");
  });

  it("rejects when the row doesn't exist at all", async () => {
    const { tx } = fakeTx([{ records: [] }]);
    await expect(restoreEntityRow(tx, 7, PO, "ghost")).rejects.toThrow(ValidationError);
  });
});

describe("entityStore.listEntityRows / getEntityRow: soft-deleted rows excluded by default", () => {
  const PO: EntityDef = { name: "PurchaseOrder", auditing: null, isAccount: false, fields: [{ name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] }] };

  it("listEntityRows filters __deletedAt IS NULL unless includeDeleted is passed", async () => {
    const { tx: tx1, calls: calls1 } = fakeTx([{ records: [] }]);
    await listEntityRows(tx1, 7, PO);
    expect(calls1[0].statement).toContain("__deletedAt IS NULL");

    const { tx: tx2, calls: calls2 } = fakeTx([{ records: [] }]);
    await listEntityRows(tx2, 7, PO, { includeDeleted: true });
    expect(calls2[0].statement).not.toContain("__deletedAt");
  });

  it("getEntityRow filters __deletedAt IS NULL unless includeDeleted is passed", async () => {
    const { tx: tx1, calls: calls1 } = fakeTx([{ records: [] }]);
    await getEntityRow(tx1, 7, PO, "po1");
    expect(calls1[0].statement).toContain("__deletedAt IS NULL");

    const { tx: tx2, calls: calls2 } = fakeTx([{ records: [] }]);
    await getEntityRow(tx2, 7, PO, "po1", { includeDeleted: true });
    expect(calls2[0].statement).not.toContain("__deletedAt");
  });
});

describe("entityStore.setEntityOtp / consumeEntityOtp — the OTP mechanism behind email verification and forgot-password", () => {
  const USER: EntityDef = { name: "User", auditing: null, isAccount: true, fields: [{ name: "id", type: "string", key: true, required: false, unique: false, autoNumber: null, values: [] }] };

  it("setEntityOtp writes code/expiry/purpose as a single raw SET", async () => {
    const { tx, calls } = fakeTx([{ records: [] }]);
    await setEntityOtp(tx, 7, USER, "u1", "verifyEmail", "123456", 10);
    expect(calls).toHaveLength(1);
    expect(calls[0].statement).toContain("__otpCode = $code");
    expect(calls[0].statement).toContain("__otpExpiresAt = $expiresAt");
    expect(calls[0].statement).toContain("__otpPurpose = $purpose");
    const params = calls[0].params as { code: string; purpose: string };
    expect(params.code).toBe("123456");
    expect(params.purpose).toBe("verifyEmail");
  });

  it("consumeEntityOtp succeeds on a matching, unexpired code, and clears it in the same write", async () => {
    const row = { id: "u1", __otpCode: "123456", __otpPurpose: "verifyEmail", __otpExpiresAt: new Date(Date.now() + 5 * 60000).toISOString() };
    const { tx, calls } = fakeTx([{ records: [record(row)] }, { records: [] }]);
    const result = await consumeEntityOtp(tx, 7, USER, "u1", "verifyEmail", "123456");
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].statement).toContain("__otpCode = null");
  });

  it("rejects a mismatched code without clearing anything", async () => {
    const row = { id: "u1", __otpCode: "123456", __otpPurpose: "verifyEmail", __otpExpiresAt: new Date(Date.now() + 5 * 60000).toISOString() };
    const { tx, calls } = fakeTx([{ records: [record(row)] }]);
    const result = await consumeEntityOtp(tx, 7, USER, "u1", "verifyEmail", "000000");
    expect(result).toEqual({ ok: false, reason: "mismatch" });
    expect(calls).toHaveLength(1); // no clearing write on failure
  });

  it("rejects an expired code", async () => {
    const row = { id: "u1", __otpCode: "123456", __otpPurpose: "verifyEmail", __otpExpiresAt: new Date(Date.now() - 1000).toISOString() };
    const { tx } = fakeTx([{ records: [record(row)] }]);
    const result = await consumeEntityOtp(tx, 7, USER, "u1", "verifyEmail", "123456");
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a code submitted for the wrong purpose (verify-email code replayed against a password reset)", async () => {
    const row = { id: "u1", __otpCode: "123456", __otpPurpose: "verifyEmail", __otpExpiresAt: new Date(Date.now() + 5 * 60000).toISOString() };
    const { tx } = fakeTx([{ records: [record(row)] }]);
    const result = await consumeEntityOtp(tx, 7, USER, "u1", "resetPassword", "123456");
    expect(result).toEqual({ ok: false, reason: "none" });
  });

  it("rejects when there's no OTP on the row at all", async () => {
    const { tx } = fakeTx([{ records: [record({ id: "u1" })] }]);
    const result = await consumeEntityOtp(tx, 7, USER, "u1", "verifyEmail", "123456");
    expect(result).toEqual({ ok: false, reason: "none" });
  });
});
