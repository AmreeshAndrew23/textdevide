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
import type { EntityDef, RelationshipDef, ValidationDef, AuditingDef, ActionDef } from "./applicationModel.js";
import { evaluateExpression, type ExpressionContext } from "./expressions.js";
import { saveEntityRow, deleteEntityRow, ValidationError, ConcurrencyError } from "./entityStore.js";

export type RuntimeAction =
  | { type: "message"; messageType: "success" | "error" | "info"; value: string }
  | { type: "fieldUpdate"; field: string; value: unknown };

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

const BUILTIN_ACTIONS = new Set(["save", "cancel", "delete", "openRecord"]);

export async function runButtonAction(
  ctx: ActionRunContext, actionName: string, actions: ActionDef[], fieldValues: Record<string, unknown>
): Promise<RuntimeAction[]> {
  if (actionName === "save") return runSave(ctx, fieldValues);
  if (actionName === "delete") return runDelete(ctx, fieldValues);
  if (actionName === "cancel" || actionName === "openRecord") return []; // no server-side effect; openRecord's navigation is resolved by the caller from Grid.onEvents
  if (BUILTIN_ACTIONS.has(actionName)) return []; // unreachable given the checks above, kept for exhaustiveness
  const action = actions.find((a) => a.name === actionName);
  if (!action) throw new Error(`Unknown action "${actionName}" — not a built-in and no matching <Action name="${actionName}"> was found`);
  return runAction(ctx, action, fieldValues);
}

export { substituteFieldTemplate };
