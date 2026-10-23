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
 * a bare alias.field (no aggregate wrapper) resolving to that related set's FIRST row's field —
 * correct for a to-one relationship (ctx.related holds exactly one row there), arbitrary-but-
 * harmless for a genuine to-many one; {session.x} template placeholders; basic left-to-right
 * arithmetic (* / + -) between any two resolved operands, e.g. "policy.premiumAmount * 10";
 * evaluateCondition ALSO supports and/or combining two whole comparisons (left-to-right, no
 * parentheses/precedence), e.g. "hoursWorked >= 0 and hoursWorked <= 24" for a range check.
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
const DOTTED_RE = /^(\w+)\.(\w+)$/;
// Splits on the FIRST top-level * / + - (left-to-right, no operator precedence — deliberately
// simple; a test needing real precedence should use parentheses via nested function calls
// instead). Whitespace around the operator is REQUIRED (\s+, not \s*) — without it, a literal
// enum value like "pending-approval" (no spaces around its hyphen — a real value from this
// vocabulary's own worked example) would otherwise be misread as "pending" minus "approval".
// Every real arithmetic example in the prompt already writes spaces around the operator.
const ARITHMETIC_RE = /^(.+?)\s+([*/+-])\s+(.+)$/;

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
  const dotted = DOTTED_RE.exec(t);
  if (dotted) return (ctx.related[dotted[1]] || [])[0]?.[dotted[2]];
  return ctx.fields[t];
}

// Recursively splits on arithmetic operators before falling back to `single` for one term — lets
// "policy.premiumAmount * 10" (or any mix with a field/alias/function-call term) evaluate as real
// arithmetic rather than failing to resolve as one opaque, unrecognized token. `single` is
// pluggable because evaluateCondition's bare-word default (a field lookup) and evaluateExpression's
// (the literal string itself) genuinely differ — see each call site.
function resolveArithmetic(token: string, ctx: ExpressionContext, single: (t: string, c: ExpressionContext) => unknown): unknown {
  const t = token.trim();
  const m = ARITHMETIC_RE.exec(t);
  if (!m) return single(t, ctx); // no operator at all — the TOP-LEVEL term, use the caller's default
  const [, leftRaw, op, rightRaw] = m;
  // Sub-terms of an arithmetic split are never literals — "totalAmount" in "totalAmount + 5" is a
  // field reference, not the word "totalAmount" — so recursive resolution always uses resolveOperand
  // (field/related/function default) here, regardless of which `single` the top level was given.
  const left = toNumber(resolveArithmetic(leftRaw, ctx, resolveOperand));
  const right = toNumber(resolveArithmetic(rightRaw, ctx, resolveOperand));
  switch (op) {
    case "*": return left * right;
    case "/": return right === 0 ? NaN : left / right;
    case "+": return left + right;
    case "-": return left - right;
    default: return NaN;
  }
}

// Splits on the FIRST top-level comparator — deliberately simple (no operator precedence)
// since every single COMPARISON in the target vocabulary is one such split; boolean composition
// (and/or) is handled a level up, in evaluateCondition, before this is ever reached. Longest
// operators checked first so <= isn't split as < followed by a stray =.
const COMPARATOR_RE = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;

// A range check like "hoursWorked >= 0 and hoursWorked <= 24" is the single most common thing a
// Validation needs beyond one plain comparison — caught live: the AI wrote exactly this (a real,
// natural way to express "between 0 and 24"), and it was silently ALWAYS rejecting regardless of
// the actual value, because nothing before this split on "and"/"or" at all: the comparator regex
// greedily took the FIRST >= it found and treated the entire remainder ("0 and hoursWorked <= 24")
// as one bare right-hand operand, which doesn't resolve to any real field and compares as NaN.
// Required whitespace around the keyword (never a bare substring match) means a field literally
// named e.g. "brandId" is never mistaken for containing the word "and". Left-to-right, no
// parentheses grouping — same "deliberately simple" tradeoff the arithmetic splitter already
// documents; a Condition needing real precedence should split into separate Validations instead.
const LOGICAL_RE = /^(.+?)\s+(and|or)\s+(.+)$/i;

export function evaluateCondition(test: string, ctx: ExpressionContext): boolean {
  const trimmed = test.trim();
  const logical = LOGICAL_RE.exec(trimmed);
  if (logical) {
    const [, leftRaw, op, rightRaw] = logical;
    const left = evaluateCondition(leftRaw, ctx);
    const right = evaluateCondition(rightRaw, ctx);
    return op.toLowerCase() === "and" ? left && right : left || right;
  }
  const m = COMPARATOR_RE.exec(trimmed);
  if (!m) {
    console.warn(`Malformed Condition test, treating as false: ${JSON.stringify(test)}`);
    return false;
  }
  const [, lhsRaw, op, rhsRaw] = m;
  try {
    const lhs = toComparable(resolveArithmetic(lhsRaw, ctx, resolveOperand));
    const rhs = toComparable(resolveArithmetic(rhsRaw, ctx, resolveOperand));
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
// field lookup — the opposite default from resolveOperand's use inside evaluateCondition. Only
// used for the TOP-LEVEL single term with no arithmetic at all — resolveArithmetic's recursive
// sub-term resolution always uses resolveOperand instead (see below), since nobody writing
// value="totalAmount + 5" means the literal word "totalAmount" plus 5; arithmetic operands are
// always meant as field/related-row/function values, regardless of which context the WHOLE
// expression came from.
function resolveLiteralTerm(token: string, ctx: ExpressionContext): unknown {
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
  const dotted = DOTTED_RE.exec(t);
  if (dotted) return (ctx.related[dotted[1]] || [])[0]?.[dotted[2]];
  return t; // plain literal
}

export function evaluateExpression(expr: string, ctx: ExpressionContext): unknown {
  return resolveArithmetic(expr, ctx, resolveLiteralTerm);
}
