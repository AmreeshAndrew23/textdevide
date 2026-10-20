/**
 * A small, deliberately independent expression evaluator for <Condition test="..."> and
 * <Set value="..."> — never imports from runtime/engine.ts's evaluateCondition/resolveTemplate,
 * which have a different, incompatible token grammar (field:/result./session: prefixes, single
 * comparison only). This one needs relationship-aware aggregates (sum(lineItems.amount)) engine.ts
 * has no concept of, so it's reimplemented rather than shared — same "no eval(), fail soft on
 * malformed input" philosophy as the old engine's own evaluator.
 *
 * Supported: comparators ==,!=,<,<=,>,>= ; numeric/string/boolean literals; now(); age(field)
 * (whole years from a date field to today); sum/avg/count/min/max(alias.field) aggregating over
 * ctx.related[alias] (rows the CALLER pre-fetches — this evaluator never queries anything itself);
 * {session.x} template placeholders.
 */

export type ExpressionContext = {
  fields: Record<string, unknown>;
  related: Record<string, Record<string, unknown>[]>;
  session: Record<string, unknown>;
};

const AGGREGATE_FNS = new Set(["sum", "avg", "count", "min", "max"]);
const FUNCTION_CALL_RE = /^(\w+)\((.*)\)$/;
const SESSION_TEMPLATE_RE = /^\{session\.(\w+)\}$/;
const QUOTED_RE = /^'([^']*)'$|^"([^"]*)"$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function toComparable(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" || typeof v === "boolean") return Number(v);
  if (typeof v === "string") {
    const asDate = Date.parse(v);
    if (!Number.isNaN(asDate) && /^\d{4}-\d{2}-\d{2}/.test(v)) return asDate;
    const asNum = Number(v);
    return Number.isNaN(asNum) ? v : asNum;
  }
  return String(v);
}

function ageInYears(dateValue: unknown): number {
  const ms = dateValue instanceof Date ? dateValue.getTime() : Date.parse(String(dateValue));
  if (Number.isNaN(ms)) return NaN;
  const dob = new Date(ms);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const hadBirthdayThisYear = now.getMonth() > dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
  if (!hadBirthdayThisYear) age--;
  return age;
}

function aggregate(fn: string, rows: Record<string, unknown>[], field: string): number {
  const values = rows.map((r) => toNumber(r[field])).filter((n) => !Number.isNaN(n));
  if (fn === "count") return rows.length;
  if (!values.length) return 0;
  if (fn === "sum") return values.reduce((a, b) => a + b, 0);
  if (fn === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  if (fn === "min") return Math.min(...values);
  if (fn === "max") return Math.max(...values);
  return NaN;
}

function evaluateFunctionCall(fn: string, argStr: string, ctx: ExpressionContext): unknown {
  const arg = argStr.trim();
  if (fn === "now") return new Date();
  if (fn === "age") return ageInYears(resolveOperand(arg, ctx));
  if (AGGREGATE_FNS.has(fn)) {
    const dotIdx = arg.indexOf(".");
    if (dotIdx === -1) return NaN;
    const alias = arg.slice(0, dotIdx);
    const field = arg.slice(dotIdx + 1);
    return aggregate(fn, ctx.related[alias] || [], field);
  }
  return undefined;
}

// Shared by both evaluateCondition's two operands and evaluateExpression — a bare, unrecognized
// word falls back to a FIELD lookup here (Condition compares real field values); evaluateExpression
// (used for <Set value="...">) overrides that one case, since a Set's literal like value="draft"
// is a literal, not a field reference.
function resolveOperand(token: string, ctx: ExpressionContext): unknown {
  const t = token.trim();
  const sessionMatch = SESSION_TEMPLATE_RE.exec(t);
  if (sessionMatch) return ctx.session[sessionMatch[1]];
  const fnMatch = FUNCTION_CALL_RE.exec(t);
  if (fnMatch) return evaluateFunctionCall(fnMatch[1], fnMatch[2], ctx);
  const quoted = QUOTED_RE.exec(t);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  if (NUMBER_RE.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return ctx.fields[t];
}

// Splits on the FIRST top-level comparator — deliberately simple (no operator precedence, no
// boolean composition) since every Validation Condition in the target vocabulary is one
// comparison. Longest operators checked first so <= isn't split as < followed by a stray =.
const COMPARATOR_RE = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;

export function evaluateCondition(test: string, ctx: ExpressionContext): boolean {
  const m = COMPARATOR_RE.exec(test.trim());
  if (!m) {
    console.warn(`Malformed Condition test, treating as false: ${JSON.stringify(test)}`);
    return false;
  }
  const [, lhsRaw, op, rhsRaw] = m;
  try {
    const lhs = toComparable(resolveOperand(lhsRaw, ctx));
    const rhs = toComparable(resolveOperand(rhsRaw, ctx));
    switch (op) {
      case "==": return lhs === rhs;
      case "!=": return lhs !== rhs;
      case "<": return lhs < rhs;
      case "<=": return lhs <= rhs;
      case ">": return lhs > rhs;
      case ">=": return lhs >= rhs;
      default: return false;
    }
  } catch (e) {
    console.warn(`Condition evaluation failed, treating as false: ${JSON.stringify(test)} — ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// For <Set value="...">: a bare word that isn't a session template/function call/quoted/numeric/
// boolean literal is the LITERAL STRING ITSELF (value="draft" means the string "draft"), never a
// field lookup — the opposite default from resolveOperand's use inside evaluateCondition.
export function evaluateExpression(expr: string, ctx: ExpressionContext): unknown {
  const t = expr.trim();
  const sessionMatch = SESSION_TEMPLATE_RE.exec(t);
  if (sessionMatch) return ctx.session[sessionMatch[1]];
  const fnMatch = FUNCTION_CALL_RE.exec(t);
  if (fnMatch) return evaluateFunctionCall(fnMatch[1], fnMatch[2], ctx);
  const quoted = QUOTED_RE.exec(t);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  if (NUMBER_RE.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return t; // plain literal
}
