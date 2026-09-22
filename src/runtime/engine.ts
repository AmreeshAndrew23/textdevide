/**
 * Server-side event engine for the screen XML's query/event schema: a screen's <events> declare
 * which <query> to run and what to do with the result; query execution, condition evaluation and
 * control flow all happen HERE, never on the client. The engine is storage-agnostic � it only needs
 * a `QueryExecutor` (see neo4jStore.executeQuery for the real one).
 */
import { DOMParser } from "@xmldom/xmldom";
import type { Element as XmlElement } from "@xmldom/xmldom";
import { type Entities, columnType, coerceValue } from "./values.js";
import { isElement, childElements } from "./screenModel.js";

export type QueryResult = { rows: Record<string, unknown>[]; count: number };
export type QueryExecutor = (statement: string, params: Record<string, unknown>) => Promise<QueryResult>;
const COMPARATORS: Record<string, (a: unknown, b: unknown) => boolean> = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  ">=": (a, b) => (a as any) >= (b as any),
  "<=": (a, b) => (a as any) <= (b as any),
  ">": (a, b) => (a as any) > (b as any),
  "<": (a, b) => (a as any) < (b as any),
};
// Longest operators first so ">=" isn't misparsed as ">" followed by a stray "=".
const CONDITION_RE = /^\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;
const LITERAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;
const PLACEHOLDER_RE = /\$\{\s*([^}]+?)\s*\}/g;

function resolveOperand(token: string, result: QueryResult, fieldValues: Record<string, unknown>): unknown {
  token = (token || "").trim();
  if (token === "result.count") {
    // The standard existence-check idiom is `RETURN count(x) AS count` — which always
    // returns exactly one row (aggregates never return zero rows), with a column literally named
    // "count" holding the real 0/N answer. A real generation reliably writes `result.count == 0`
    // INTENDING that column's value, not this token's other meaning (the execute's row-count) —
    // and those two meanings collide silently (row-count is always 1 for an aggregate query)
    // unless the actual column wins whenever it's present.
    const rows = result.rows || [];
    if (rows.length && "count" in rows[0]) return rows[0].count;
    return result.count ?? 0;
  }
  if (token === "result.rows.length") return result.count ?? 0;
  if (token.startsWith("result.")) {
    const rows = result.rows || [];
    return rows.length ? rows[0][token.slice("result.".length)] : null;
  }
  if (token.startsWith("field:")) return fieldValues[token.slice("field:".length)];
  if (token.length >= 2 && token[0] === token[token.length - 1] && (token[0] === "'" || token[0] === '"')) {
    return token.slice(1, -1);
  }
  if (LITERAL_NUMBER_RE.test(token)) return token.includes(".") ? parseFloat(token) : parseInt(token, 10);
  if (token.toLowerCase() === "true" || token.toLowerCase() === "false") return token.toLowerCase() === "true";
  return token; // bare word — compared as a plain string
}

// Normalizes numeric-looking strings (raw field values from a JSON request body) and numeric
// NUMERIC-as-string results to plain numbers so a condition like field:deptid == result.deptid
// can compare across those representations instead of silently mismatching. Anything else (null,
// non-numeric strings, bool) passes through unchanged.
function numify(v: unknown): unknown {
  if (typeof v === "string" && LITERAL_NUMBER_RE.test(v.trim())) {
    const s = v.trim();
    return s.includes(".") ? parseFloat(s) : parseInt(s, 10);
  }
  return v;
}

// No eval()/Function()/new Function() anywhere: a condition is exactly one comparison, both
// operands resolved to typed values FIRST (result.count/result.rows.length, result.<column>,
// field:<id>, or a literal), then compared via a plain JS operator — never re-injected into a
// string that gets parsed as code. A malformed or type-mismatched condition degrades to false
// with a logged warning rather than throwing, so one bad <when> never crashes the whole event.
export function evaluateCondition(condition: string, result: QueryResult, fieldValues: Record<string, unknown>): boolean {
  const m = CONDITION_RE.exec(condition || "");
  if (!m) {
    console.warn(`Unparseable event condition: ${JSON.stringify(condition)}`);
    return false;
  }
  const [, leftRaw, op, rightRaw] = m;
  const left = numify(resolveOperand(leftRaw, result, fieldValues));
  const right = numify(resolveOperand(rightRaw, result, fieldValues));
  try {
    return COMPARATORS[op](left, right);
  } catch {
    console.warn(`Type-mismatched event condition: ${JSON.stringify(condition)} (left=${JSON.stringify(left)} right=${JSON.stringify(right)})`);
    return false;
  }
}

// ${result.<column>} / ${field:<id>} interpolation via plain string substitution — separate from
// and much simpler than a Function()-based safe-arithmetic evaluator; this only ever does string
// substitution, never anything parsed as code.
export function resolveTemplate(value: string, result: QueryResult, fieldValues: Record<string, unknown>): string {
  return (value || "").replace(PLACEHOLDER_RE, (_m, expr: string) => {
    const resolved = resolveOperand(expr, result, fieldValues);
    return resolved === null || resolved === undefined ? "" : String(resolved);
  });
}

type ParsedQuery = { statement: string; params: Record<string, string> };

function parseQueries(root: XmlElement): Map<string, ParsedQuery> {
  const queries = new Map<string, ParsedQuery>();
  const queryEls = Array.from(root.getElementsByTagName("query"));
  for (const q of queryEls) {
    const qid = q.getAttribute("id");
    if (!qid) continue;
    const stmtEl = q.getElementsByTagName("statement")[0];
    const statement = (stmtEl?.textContent || "").trim();
    const params: Record<string, string> = {};
    for (const p of Array.from(q.getElementsByTagName("parameter"))) {
      const pname = p.getAttribute("name");
      if (pname) params[pname] = p.getAttribute("source") || "";
    }
    queries.set(qid, { statement, params });
  }
  return queries;
}

// fieldId -> [table, column] from persistenceMapping="table.column" on <ui><field> — lets a query
// parameter bound to a field's value be coerced using that REAL column's type (via coerceValue)
// instead of always sending a raw string.
function parseFieldPersistence(root: XmlElement): Map<string, [string, string]> {
  const mapping = new Map<string, [string, string]>();
  for (const el of Array.from(root.getElementsByTagName("field"))) {
    const fid = el.getAttribute("id");
    const pm = el.getAttribute("persistenceMapping");
    if (fid && pm && pm.includes(".")) {
      const idx = pm.indexOf(".");
      mapping.set(fid, [pm.slice(0, idx).trim(), pm.slice(idx + 1).trim()]);
    }
  }
  return mapping;
}

// Equivalent of ElementTree's `for el in root.iter(): if el.get("id") == element_id`.
function findElementById(root: XmlElement, elementId: string): XmlElement | null {
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.getAttribute && el.getAttribute("id") === elementId) return el;
    const children = Array.from(el.childNodes || []).filter((n): n is XmlElement => n.nodeType === 1);
    stack.push(...children);
  }
  return null;
}

function resolveQueryParams(
  queryParams: Record<string, string>, fieldValues: Record<string, unknown>,
  fieldPersistence: Map<string, [string, string]>, entities: Entities
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [pname, source] of Object.entries(queryParams)) {
    if (source.startsWith("field:")) {
      const fid = source.slice("field:".length);
      let raw = fieldValues[fid];
      const persistence = fieldPersistence.get(fid);
      if (persistence) {
        const [table, col] = persistence;
        raw = coerceValue(raw, columnType(entities, table, col));
      }
      resolved[pname] = raw;
    } else {
      resolved[pname] = source; // literal default from the XML itself
    }
  }
  return resolved;
}

export type EventAction =
  | { type: "map"; target: string; value: unknown }
  | { type: "set"; target: string; value: unknown }
  | { type: "message"; messageType: string; value: string }
  | { type: "stop" };

// Executes one screen element's <events><event> chain for real, inside the CALLER's transaction
// (the caller commits/rolls back — same pattern as syncSchema/replaceAllRows). Walks its ordered
// <execute>/<when> steps and returns a flat, already-decided list of UI actions (map/set/message/
// stop) for the UI runtime to apply mechanically. Throws on a genuine failure (malformed XML,
// unknown element, a query that fails to execute) so the caller rolls back instead of silently
// committing a partially-applied chain.
export async function runEvent(
  exec: QueryExecutor, entities: Entities, screenXml: string,
  elementId: string, eventType: string, fieldValues: Record<string, unknown>
): Promise<EventAction[]> {
  let root: XmlElement;
  try {
    const doc = new DOMParser().parseFromString(screenXml, "text/xml");
    if (!doc.documentElement) throw new Error("empty document");
    root = doc.documentElement;
  } catch (e) {
    throw new Error(`Screen XML is not well-formed: ${e}`);
  }

  const queries = parseQueries(root);
  const fieldPersistence = parseFieldPersistence(root);
  const element = findElementById(root, elementId);
  if (!element) throw new Error(`No element with id ${JSON.stringify(elementId)} on this screen`);

  // <event> lives in ONE top-level <events> block (element="..." says what it's wired to), not
  // nested inside the field/button itself — matches the current vocabulary (ai_service.py).
  const eventEls = Array.from(root.getElementsByTagName("event"));
  const event = eventEls.find((ev) => ev.getAttribute("element") === elementId && ev.getAttribute("type") === eventType);
  if (!event) return []; // this element has no handler for this event type — a no-op, not an error

  const actions: EventAction[] = [];
  const values = { ...fieldValues }; // a <set> can feed later steps in the same chain

  const executeEls = childElements(event, "execute");
  for (const executeEl of executeEls) {
    const stopped = await runExecute(exec, queries, fieldPersistence, entities, executeEl, values, actions);
    if (stopped) break; // a <stop/> anywhere inside cancels any later top-level <execute> too
  }
  return actions;
}

// Runs ONE <execute>'s query and processes its map/when children in order. Returns true if a
// <stop/> fired anywhere inside it (including inside a nested <when><execute>), so the caller
// knows to stop walking any later sibling.
async function runExecute(
  exec: QueryExecutor, queries: Map<string, ParsedQuery>, fieldPersistence: Map<string, [string, string]>,
  entities: Entities, executeEl: XmlElement, fieldValues: Record<string, unknown>, actions: EventAction[]
): Promise<boolean> {
  const queryId = executeEl.getAttribute("query");
  const query = queryId ? queries.get(queryId) : undefined;
  if (!query) {
    console.warn(`run_event: unknown query id ${JSON.stringify(queryId)}`);
    return false;
  }
  const params = resolveQueryParams(query.params, fieldValues, fieldPersistence, entities);
  const result = await exec(query.statement, params);

  const children = childElements(executeEl);
  for (const child of children) {
    if (child.tagName === "map") {
      const resultKey = child.getAttribute("result");
      const target = child.getAttribute("target") || "";
      let value: unknown;
      if (resultKey === "rows") {
        value = result.rows || [];
      } else {
        const rows = result.rows || [];
        value = rows.length ? rows[0][resultKey || ""] : null;
      }
      if (target.startsWith("field:")) fieldValues[target.slice("field:".length)] = value;
      actions.push({ type: "map", target, value });
    } else if (child.tagName === "when") {
      if (!evaluateCondition(child.getAttribute("condition") || "", result, fieldValues)) continue;
      if (await runWhenBody(exec, queries, fieldPersistence, entities, child, result, fieldValues, actions)) {
        return true;
      }
    }
  }
  return false;
}

// Processes a matched <when>'s children in order: <set>/<message>/<stop>, or a nested <execute>
// — a real generation reliably nests a second <execute> inside a <when> for "only do the next
// step if this one found something" chains, so this supports it natively rather than forcing
// every conditional chain to be flattened into top-level siblings. Returns true if a <stop/> fired.
async function runWhenBody(
  exec: QueryExecutor, queries: Map<string, ParsedQuery>, fieldPersistence: Map<string, [string, string]>,
  entities: Entities, whenEl: XmlElement, result: QueryResult, fieldValues: Record<string, unknown>, actions: EventAction[]
): Promise<boolean> {
  const children = childElements(whenEl);
  for (const inner of children) {
    if (inner.tagName === "set") {
      const target = inner.getAttribute("target") || "";
      const value = resolveTemplate(inner.getAttribute("value") || "", result, fieldValues);
      if (target.startsWith("field:")) fieldValues[target.slice("field:".length)] = value;
      actions.push({ type: "set", target, value });
    } else if (inner.tagName === "message") {
      actions.push({
        type: "message",
        messageType: inner.getAttribute("type") || "info",
        value: resolveTemplate(inner.getAttribute("value") || "", result, fieldValues),
      });
    } else if (inner.tagName === "stop") {
      actions.push({ type: "stop" });
      return true;
    } else if (inner.tagName === "execute") {
      if (await runExecute(exec, queries, fieldPersistence, entities, inner, fieldValues, actions)) return true;
    }
  }
  return false;
}

