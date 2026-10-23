/**
 * Action/Steps execution + built-in button semantics — "Built-ins (save, cancel, delete,
 * openRecord) have fixed runtime semantics and are never redefined. Custom logic lives in named
 * actions composed of runtime steps; all steps run in one transaction." The caller (the route
 * layer) wraps the whole call in runtime/neo4jStore.ts's withTx, same as everywhere else that
 * touches Neo4j — this module takes an already-open Transaction, it never opens one itself.
 *
 * openRecord's actual navigation (a Grid row's rowClick -> targetScreen) is pure routing with no
 * database involvement at all, so it's resolved directly from ScreenDef.grid.onEvents by the
 * caller — there is deliberately no runtime function for it here.
 */
import type { Transaction } from "neo4j-driver";
import { randomUUID } from "crypto";
import type { EntityDef, RelationshipDef, ValidationDef, AuditingDef, ActionDef } from "./applicationModel.js";
import { evaluateExpression, type ExpressionContext } from "./expressions.js";
import { saveEntityRow, deleteEntityRow, getEntityRowByField, ValidationError, ConcurrencyError } from "./entityStore.js";
import { hashPassword, verifyPassword } from "../services/authService.js";

export type RuntimeAction =
  | { type: "message"; messageType: "success" | "error" | "info"; value: string }
  | { type: "fieldUpdate"; field: string; value: unknown }
  // Login/changePassword signal a session change this way rather than touching a cookie directly
  // — this module takes an already-open Transaction and knows nothing about HTTP; the route layer
  // (which does) turns this into a Set-Cookie using appAuth.ts after the transaction commits.
  | { type: "session"; identity: string; mustChangePassword: boolean };

export type ActionRunContext = {
  applicationId: number;
  entity: EntityDef;
  relationships: RelationshipDef[];
  validations: ValidationDef[];
  auditing: AuditingDef | null;
  session: { identity: string | null; vars: Record<string, unknown> };
  tx: Transaction;
};

// {poNumber} inside a Notify message -> the field's current value — a different placeholder
// grammar from expressions.ts's {session.x} (no "session." prefix, and only ever a plain
// substitution, never an expression), since a Notify message is free text, not a value expression.
function substituteFieldTemplate(template: string, fieldValues: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (full, field: string) => (field in fieldValues ? String(fieldValues[field]) : full));
}

async function runSave(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  try {
    const { created } = await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, fieldValues, { identity: ctx.session.identity });
    return [{ type: "message", messageType: "success", value: created ? "Created successfully." : "Saved successfully." }];
  } catch (e) {
    if (e instanceof ValidationError || e instanceof ConcurrencyError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
}

// login/changePassword only make sense against the one Entity marked isAccount="true" (always
// "User" by the fixed convention documented in aiService.ts's prompt) — fixed field names
// username/passwordHash/mustChangePassword, never parsed from the XML, just assumed, the same way
// the key field is always just assumed to be "id".
async function runLogin(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`login can only run against the isAccount entity, not "${ctx.entity.name}"`);
  const username = String(fieldValues.username ?? "");
  const password = String(fieldValues.password ?? "");
  if (!username || !password) return [{ type: "message", messageType: "error", value: "Username and password are required." }];
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "username", username);
  if (!row || !verifyPassword(password, String(row.passwordHash ?? ""))) {
    return [{ type: "message", messageType: "error", value: "Invalid username or password." }];
  }
  return [
    { type: "message", messageType: "success", value: "Logged in." },
    { type: "session", identity: username, mustChangePassword: row.mustChangePassword === true },
  ];
}

// The "first account" problem: login/changePassword alone give no way for the very first real
// end user to ever get an account — there's nothing to log into yet. register creates a new
// User row (rejecting a taken username) and immediately signs it in, the same way a normal
// signup flow would, so "first-time login" actually has something to log into.
async function runRegister(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`register can only run against the isAccount entity, not "${ctx.entity.name}"`);
  const username = String(fieldValues.username ?? "");
  const password = String(fieldValues.password ?? "");
  if (!username || !password) return [{ type: "message", messageType: "error", value: "Username and password are required." }];
  const existing = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "username", username);
  if (existing) return [{ type: "message", messageType: "error", value: "That username is already taken." }];
  try {
    await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
      id: randomUUID(), username, passwordHash: hashPassword(password), mustChangePassword: false,
    }, { identity: username });
  } catch (e) {
    if (e instanceof ValidationError || e instanceof ConcurrencyError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
  return [
    { type: "message", messageType: "success", value: "Account created." },
    { type: "session", identity: username, mustChangePassword: false },
  ];
}

async function runChangePassword(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  if (!ctx.entity.isAccount) throw new Error(`changePassword can only run against the isAccount entity, not "${ctx.entity.name}"`);
  if (!ctx.session.identity) return [{ type: "message", messageType: "error", value: "You must be logged in to change your password." }];
  const currentPassword = String(fieldValues.currentPassword ?? "");
  const newPassword = String(fieldValues.newPassword ?? "");
  if (!currentPassword || !newPassword) return [{ type: "message", messageType: "error", value: "Current and new password are required." }];
  const row = await getEntityRowByField(ctx.tx, ctx.applicationId, ctx.entity, "username", ctx.session.identity);
  if (!row || !verifyPassword(currentPassword, String(row.passwordHash ?? ""))) {
    return [{ type: "message", messageType: "error", value: "Current password is incorrect." }];
  }
  try {
    // Write through the full save pipeline with the WHOLE current row (not just passwordHash) —
    // saveEntityRow's required-field check runs over every one of the entity's own fields.
    await saveEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, ctx.validations, ctx.auditing, {
      ...row, passwordHash: hashPassword(newPassword), mustChangePassword: false,
    }, { identity: ctx.session.identity });
  } catch (e) {
    if (e instanceof ValidationError || e instanceof ConcurrencyError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
  return [
    { type: "message", messageType: "success", value: "Password changed." },
    { type: "session", identity: ctx.session.identity, mustChangePassword: false },
  ];
}

async function runDelete(ctx: ActionRunContext, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  const keyField = ctx.entity.fields.find((f) => f.key);
  if (!keyField) throw new Error(`Entity "${ctx.entity.name}" has no key field`);
  try {
    await deleteEntityRow(ctx.tx, ctx.applicationId, ctx.entity, ctx.relationships, fieldValues[keyField.name]);
    return [{ type: "message", messageType: "success", value: "Deleted successfully." }];
  } catch (e) {
    if (e instanceof ValidationError) return [{ type: "message", messageType: "error", value: e.message }];
    throw e;
  }
}

// Walks a named Action's Steps in order. A failed Save step stops the rest of the steps (same
// reasoning the old engine's <when><message/><stop/></when> pattern already follows: don't run
// Notify after a save that didn't actually happen).
export async function runAction(ctx: ActionRunContext, action: ActionDef, fieldValues: Record<string, unknown>): Promise<RuntimeAction[]> {
  const values = { ...fieldValues };
  const results: RuntimeAction[] = [];
  for (const step of action.steps) {
    if (step.kind === "set") {
      const exprCtx: ExpressionContext = { fields: values, related: {}, session: ctx.session.vars };
      const resolved = evaluateExpression(step.value, exprCtx);
      values[step.field] = resolved;
      results.push({ type: "fieldUpdate", field: step.field, value: resolved });
    } else if (step.kind === "save") {
      const saveResults = await runSave(ctx, values);
      results.push(...saveResults);
      if (saveResults.some((r) => r.type === "message" && r.messageType === "error")) return results; // stop
    } else if (step.kind === "notify") {
      results.push({ type: "message", messageType: "info", value: substituteFieldTemplate(step.message, values) });
    }
  }
  return results;
}

const BUILTIN_ACTIONS = new Set(["save", "cancel", "delete", "openRecord", "login", "register", "changePassword"]);

export async function runButtonAction(
  ctx: ActionRunContext, actionName: string, actions: ActionDef[], fieldValues: Record<string, unknown>
): Promise<RuntimeAction[]> {
  if (actionName === "save") return runSave(ctx, fieldValues);
  if (actionName === "delete") return runDelete(ctx, fieldValues);
  if (actionName === "login") return runLogin(ctx, fieldValues);
  if (actionName === "register") return runRegister(ctx, fieldValues);
  if (actionName === "changePassword") return runChangePassword(ctx, fieldValues);
  if (actionName === "cancel" || actionName === "openRecord") return []; // no server-side effect; openRecord's navigation is resolved by the caller from Grid.onEvents
  if (BUILTIN_ACTIONS.has(actionName)) return []; // unreachable given the checks above, kept for exhaustiveness
  const action = actions.find((a) => a.name === actionName);
  if (!action) throw new Error(`Unknown action "${actionName}" — not a built-in and no matching <Action name="${actionName}"> was found`);
  return runAction(ctx, action, fieldValues);
}

export { substituteFieldTemplate };
