/**
 * A flat, queryable security/audit log — no relationships needed, just rows. Deliberately its own
 * node label (RtAuditLog) rather than reusing any entity-data machinery, since this is runtime-
 * internal bookkeeping, never something an Application's own XML describes or an end user edits.
 */
import type { Transaction } from "neo4j-driver";
import { withTx } from "../runtime/neo4jStore.js";
import { toDriverValue, fromDriverValue } from "../runtime/values.js";
import { guard } from "./applicationStore.js";

export type AuditEventType =
  | "login_success" | "login_failure" | "register" | "delete" | "restore" | "access_denied";

export type AuditEvent = {
  type: AuditEventType;
  identity: string | null;
  detail: string;
};

export async function logAuditEvent(tx: Transaction, applicationId: number, event: AuditEvent): Promise<void> {
  await tx.run(
    `CREATE (:RtAuditLog {applicationId: $applicationId, type: $type, identity: $identity, detail: $detail, at: $at})`,
    {
      applicationId: toDriverValue(applicationId), type: event.type, identity: event.identity,
      detail: event.detail, at: new Date().toISOString(),
    }
  );
}

export type AuditLogRow = { type: string; identity: string | null; detail: string; at: string };

export async function listAuditEvents(applicationId: number, limit = 100): Promise<AuditLogRow[]> {
  return guard(() =>
    withTx(async (tx) => {
      const res = await tx.run(
        `MATCH (a:RtAuditLog {applicationId: $applicationId}) RETURN a ORDER BY a.at DESC LIMIT $limit`,
        { applicationId: toDriverValue(applicationId), limit: toDriverValue(limit) }
      );
      return res.records.map((r) => fromDriverValue(r.get("a")) as AuditLogRow);
    })
  );
}
