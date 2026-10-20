/**
 * Compiles a declarative <DataSource> definition to a safe, parameterized Cypher statement —
 * "Generic declarative query spec — no SQL or Cypher in the XML. The runtime compiles this to the
 * target database. Values are always bound parameters, so queries are injection-safe." Every
 * statement this produces is machine-generated (never AI- or hand-written), then still run through
 * labels.ts's prepareAppCypher for defense-in-depth.
 *
 * MVP scope only (Phase 1 of the plan): plain fields (no aggregate), equals-style Conditions, Sort.
 * Aggregate fields, GroupBy, and cross-entity dotted fields (e.g. "vendor.name") are Phase 2 — this
 * throws a clear, explicit error for those rather than silently compiling something wrong.
 */
import type { DataSourceDef } from "./applicationModel.js";
import { prepareAppCypher } from "./labels.js";

const OPERATOR_TO_CYPHER: Record<string, string> = {
  equals: "=", notEquals: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", contains: "CONTAINS",
};

const SESSION_TEMPLATE_RE = /^\{session\.(\w+)\}$/;

function resolveConditionValue(value: string, sessionCtx: Record<string, unknown>): unknown {
  const m = SESSION_TEMPLATE_RE.exec(value);
  return m ? sessionCtx[m[1]] : value;
}

export function compileDataSource(
  def: DataSourceDef, applicationId: string | number, entityNames: Set<string>, sessionCtx: Record<string, unknown>
): { statement: string; params: Record<string, unknown> } {
  if (!def.entity) throw new Error(`DataSource "${def.name}" has no Select entity — cross-entity/query-only sources aren't supported yet`);
  if (def.fields.some((f) => f.aggregate)) throw new Error(`DataSource "${def.name}": aggregate fields aren't supported yet (Phase 2)`);
  if (def.groupBy.length) throw new Error(`DataSource "${def.name}": GroupBy isn't supported yet (Phase 2)`);
  if (def.fields.some((f) => f.name.includes(".")) || def.sort.some((s) => s.by.includes("."))) {
    throw new Error(`DataSource "${def.name}": cross-entity dotted fields aren't supported yet (Phase 2)`);
  }

  const params: Record<string, unknown> = {};
  const whereClauses: string[] = [];
  def.conditions.forEach((c, i) => {
    const paramName = `cond${i}`;
    const op = OPERATOR_TO_CYPHER[c.operator];
    if (!op) throw new Error(`DataSource "${def.name}": unknown condition operator "${c.operator}"`);
    params[paramName] = resolveConditionValue(c.value, sessionCtx);
    whereClauses.push(`n.${c.field} ${op} $${paramName}`);
  });

  const returnFields = (def.fields.length ? def.fields : [{ name: "id", alias: null, aggregate: null }])
    .map((f) => `n.${f.name} AS ${f.alias || f.name}`)
    .join(", ");

  let statement = `MATCH (n:${def.entity})`;
  if (whereClauses.length) statement += ` WHERE ${whereClauses.join(" AND ")}`;
  statement += ` RETURN ${returnFields}`;
  if (def.sort.length) {
    statement += ` ORDER BY ${def.sort.map((s) => `n.${s.by} ${s.order.toUpperCase()}`).join(", ")}`;
  }

  return { statement: prepareAppCypher(statement, applicationId, entityNames, new Set(Object.keys(params))), params };
}
