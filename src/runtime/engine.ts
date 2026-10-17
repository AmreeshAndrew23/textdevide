/**
 * Server-side event engine for the screen XML's query/event schema: a screen's <events> declare
 * which <query> to run and what to do with the result; query execution, condition evaluation and
 * control flow all happen HERE, never on the client. The engine is storage-agnostic � it only needs
 * a `QueryExecutor` (see neo4jStore.executeQuery for the real one).
 */
import { DOMParser } from "@xmldom/xmldom";
import type { Element as XmlElement } from "@xmldom/xmldom";
import { randomInt } from "node:crypto";
import { type Entities, columnType, coerceValue, findTable } from "./values.js";
import { type FieldRule, isElement, childElements } from "./screenModel.js";
import { hashPassword, verifyPassword } from "../services/authService.js";

// No 0/O/1/l/I — a temporary password a person has to actually type back in shouldn't contain
// characters that look alike. 12 chars from a 58-symbol alphabet is well past any brute-force
// concern for a short-lived, one-time-use credential forced to be changed on first login.
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function generateSecureValue(_type: string): string {
  let out = "";
  for (let i = 0; i < 12; i++) out += PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)];
  return out;
}

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

// WHICH account/role is running this event — resolved ONLY from the verified session cookie, never
// from client-submitted fieldValues (same anti-spoofing precedent session:identity already set).
// Optional with a null default so every existing call site that doesn't care about session (most
// resolveTemplate uses, every test calling evaluateCondition with 3 args) keeps compiling unchanged.
export type SessionContext = { identity: string | null; role: string | null };
const NO_SESSION: SessionContext = { identity: null, role: null };

function resolveOperand(token: string, result: QueryResult, fieldValues: Record<string, unknown>, session: SessionContext = NO_SESSION): unknown {
  token = (token || "").trim();
  if (token === "session:identity") return session.identity;
  if (token === "session:role") return session.role;
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
export function evaluateCondition(condition: string, result: QueryResult, fieldValues: Record<string, unknown>, session: SessionContext = NO_SESSION): boolean {
  const m = CONDITION_RE.exec(condition || "");
  if (!m) {
    console.warn(`Unparseable event condition: ${JSON.stringify(condition)}`);
    return false;
  }
  const [, leftRaw, op, rightRaw] = m;
  const left = numify(resolveOperand(leftRaw, result, fieldValues, session));
  const right = numify(resolveOperand(rightRaw, result, fieldValues, session));
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

// hash="true" on a <parameter> — its resolved value is hashed (authService's hashPassword) before
// being bound into the Cypher parameter, instead of sent raw. passwordField/passwordColumn live on
// the <query> itself, not a parameter — a login query can't compare a submitted password against a
// stored bcrypt hash in Cypher at all (the same password hashes differently every time), so that
// comparison happens here in JS instead; see the passwordField/passwordColumn handling in runExecute.
type QueryParam = { source: string; hash: boolean };
type ParsedQuery = { statement: string; params: Record<string, QueryParam>; passwordField: string | null; passwordColumn: string | null };

function parseQueries(root: XmlElement): Map<string, ParsedQuery> {
  const queries = new Map<string, ParsedQuery>();
  const queryEls = Array.from(root.getElementsByTagName("query"));
  for (const q of queryEls) {
    const qid = q.getAttribute("id");
    if (!qid) continue;
    const stmtEl = q.getElementsByTagName("statement")[0];
    const statement = (stmtEl?.textContent || "").trim();
    const params: Record<string, QueryParam> = {};
    for (const p of Array.from(q.getElementsByTagName("parameter"))) {
      const pname = p.getAttribute("name");
      if (pname) params[pname] = { source: p.getAttribute("source") || "", hash: p.getAttribute("hash") === "true" };
    }
    queries.set(qid, {
      statement, params,
      passwordField: q.getAttribute("passwordField"),
      passwordColumn: q.getAttribute("passwordColumn"),
    });
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

type FieldMeta = { label: string; type: string; rules: FieldRule[]; visibleRoles: string[] | null };

// Parses a comma-separated role list attribute (requiredRole/visibleRoles) into a trimmed,
// non-empty array, or null when the attribute is absent — null means "no restriction", not "empty
// list" (an empty list would mean nobody, which no XML author means by omitting the attribute).
function parseRoleList(value: string | null): string[] | null {
  if (!value) return null;
  const roles = value.split(",").map((r) => r.trim()).filter(Boolean);
  return roles.length ? roles : null;
}

// fieldId -> {label, type, rules} straight off the <field> elements — same shape screenModel.ts
// parses for rendering, re-read here independently (engine.ts works off the raw XML, not a
// ScreenModel) so server-side validation enforces exactly what the rendered HTML already declares.
function parseFieldMeta(root: XmlElement): Map<string, FieldMeta> {
  const meta = new Map<string, FieldMeta>();
  for (const el of Array.from(root.getElementsByTagName("field"))) {
    const id = el.getAttribute("id");
    if (!id) continue;
    const rules: FieldRule[] = childElements(el, "rule").map((r) => {
      const rule: FieldRule = {};
      if (r.getAttribute("required") === "true") rule.required = true;
      if (r.getAttribute("unique") === "true") rule.unique = true;
      const pattern = r.getAttribute("pattern");
      if (pattern) rule.pattern = pattern;
      const maxLength = r.getAttribute("maxLength");
      if (maxLength) rule.maxLength = Number(maxLength);
      const minValue = r.getAttribute("minValue");
      if (minValue) rule.minValue = Number(minValue);
      const maxValue = r.getAttribute("maxValue");
      if (maxValue) rule.maxValue = Number(maxValue);
      const minAge = r.getAttribute("minAge");
      if (minAge) rule.minAge = Number(minAge);
      const maxAge = r.getAttribute("maxAge");
      if (maxAge) rule.maxAge = Number(maxAge);
      return rule;
    });
    meta.set(id, {
      label: el.getAttribute("label") || id, type: el.getAttribute("type") || "text", rules,
      visibleRoles: parseRoleList(el.getAttribute("visibleRoles")),
    });
  }
  return meta;
}

const WRITE_STATEMENT_RE = /\b(CREATE|MERGE|SET|REMOVE|DELETE)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmptyValue = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const IDENT_RE = /^[A-Za-z_]\w*$/;

// Age in whole years as of `now`, computed from a birth-date-like value (an ISO date string, e.g.
// what a type="date" field submits) — null if the value isn't a parseable date. Subtracts one year
// if `now` falls before this year's birthday, so DOB 2003-06-15 is age 22 on 2026-01-01 but 23 on
// 2026-06-15. Uses UTC accessors on both sides so the comparison doesn't depend on server timezone.
export function computeAgeYears(value: unknown, now: Date = new Date()): number | null {
  const dob = new Date(String(value));
  if (Number.isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    now.getUTCMonth() > dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age--;
  return age;
}

// True when some OTHER row already has this value for the field's persisted column — "other"
// meaning excluded by the table's own primary key when this write is an update (read off whichever
// field's persistenceMapping names that pk column; empty/absent means there's no row to exclude, so
// this is an insert). Goes through the same QueryExecutor every other screen statement runs
// through, so it gets the same label-prefixing/validation as an AI-authored existence check.
async function valueTaken(
  fieldId: string, value: unknown, fieldPersistence: Map<string, [string, string]>, entities: Entities,
  fieldValues: Record<string, unknown>, exec: QueryExecutor
): Promise<boolean> {
  const mapping = fieldPersistence.get(fieldId);
  if (!mapping) return false;
  const [table, column] = mapping;
  if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) return false;
  const params: Record<string, unknown> = { __uniqueVal: value };
  let exclude = "";
  const pkColumn = findTable(entities, table)?.columns?.find((c) => c.pk)?.name;
  if (pkColumn && IDENT_RE.test(pkColumn)) {
    const pkFieldId = [...fieldPersistence.entries()].find(([, m]) => m[0] === table && m[1] === pkColumn)?.[0];
    const pkValue = pkFieldId ? fieldValues[pkFieldId] : undefined;
    if (!isEmptyValue(pkValue)) {
      exclude = ` AND n.${pkColumn} <> $__uniquePk`;
      params.__uniquePk = pkValue;
    }
  }
  const result = await exec(`MATCH (n:${table}) WHERE n.${column} = $__uniqueVal${exclude} RETURN count(n) AS cnt`, params);
  return Number(result.rows[0]?.cnt ?? 0) > 0;
}

// Validates exactly the fields that SOURCE this query's parameters — derived purely from existing
// metadata (a query's own `source="field:x"` params + that field's <rule>s), never from an entity
// name or button label. A read-only query (search/filter/sort) never triggers this, so typing in a
// search box can never be blocked by an unrelated required field elsewhere on the same screen.
async function validateWriteFields(
  query: ParsedQuery, fieldValues: Record<string, unknown>, fieldMeta: Map<string, FieldMeta>,
  fieldPersistence: Map<string, [string, string]>, entities: Entities, exec: QueryExecutor, sessionRole: string | null
): Promise<EventAction[]> {
  const violations: EventAction[] = [];
  const say = (label: string, msg: string) => violations.push({ type: "message", messageType: "error", value: `${label} ${msg}` });
  for (const { source } of Object.values(query.params)) {
    if (!source.startsWith("field:")) continue;
    const fieldId = source.slice("field:".length);
    const meta = fieldMeta.get(fieldId);
    if (!meta) continue;
    const value = fieldValues[fieldId];
    // A field the current role was never even shown (visibleRoles excludes it) must never be
    // writable either — the client can always edit the DOM/request directly, so hiding it in the
    // rendered page is not enforcement on its own; this is the real boundary. Only an actually
    // SUBMITTED value is a violation — a role-restricted field the form simply never rendered
    // legitimately has no value at all, and that must not block saving the rest of the record
    // (same "other rules only constrain a value that's actually present" spirit as every rule below).
    if (meta.visibleRoles && !isEmptyValue(value) && (!sessionRole || !meta.visibleRoles.includes(sessionRole))) {
      say(meta.label, "cannot be set with your current role.");
      continue;
    }
    if (!meta.rules.length) continue;
    for (const rule of meta.rules) {
      if (rule.required && isEmptyValue(value)) {
        say(meta.label, "is required.");
        continue;
      }
      if (isEmptyValue(value)) continue; // other rules only constrain a value that's actually present
      const str = String(value);
      if (rule.pattern) {
        try {
          if (!new RegExp(rule.pattern).test(str)) say(meta.label, "is not in a valid format.");
        } catch {
          console.warn(`Unparseable validation pattern on field ${JSON.stringify(source)}: ${JSON.stringify(rule.pattern)}`);
        }
      }
      if (rule.maxLength !== undefined && str.length > rule.maxLength) say(meta.label, `must be at most ${rule.maxLength} characters.`);
      if (meta.type === "number" || rule.minValue !== undefined || rule.maxValue !== undefined) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          say(meta.label, "must be a number.");
        } else {
          if (rule.minValue !== undefined && num < rule.minValue) say(meta.label, `must be at least ${rule.minValue}.`);
          if (rule.maxValue !== undefined && num > rule.maxValue) say(meta.label, `must be at most ${rule.maxValue}.`);
        }
      }
      if (rule.minAge !== undefined || rule.maxAge !== undefined) {
        const age = computeAgeYears(value);
        if (age === null) {
          say(meta.label, "must be a valid date.");
        } else {
          if (rule.minAge !== undefined && age < rule.minAge) say(meta.label, `must indicate an age of at least ${rule.minAge}.`);
          if (rule.maxAge !== undefined && age > rule.maxAge) say(meta.label, `must indicate an age of at most ${rule.maxAge}.`);
        }
      }
      if (meta.type === "email" && !EMAIL_RE.test(str)) say(meta.label, "must be a valid email address.");
      if (rule.unique && (await valueTaken(fieldId, value, fieldPersistence, entities, fieldValues, exec))) {
        say(meta.label, "is already in use.");
      }
    }
  }
  return violations;
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
  queryParams: Record<string, QueryParam>, fieldValues: Record<string, unknown>,
  fieldPersistence: Map<string, [string, string]>, entities: Entities, fieldMeta: Map<string, FieldMeta>,
  sessionIdentity: string | null, sessionRole: string | null
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [pname, { source, hash }] of Object.entries(queryParams)) {
    if (source === "session:identity") {
      // From the VERIFIED session cookie only — never from fieldValues (the request body), so a
      // client can never spoof "I am someone else" by submitting a field of the same name.
      resolved[pname] = sessionIdentity;
    } else if (source === "session:role") {
      resolved[pname] = sessionRole; // same anti-spoofing precedent — never from fieldValues
    } else if (source.startsWith("field:")) {
      const fid = source.slice("field:".length);
      let raw = fieldValues[fid];
      const persistence = fieldPersistence.get(fid);
      if (persistence) {
        const [table, col] = persistence;
        raw = coerceValue(raw, columnType(entities, table, col));
      } else if (fieldMeta.get(fid)?.type === "number" && typeof raw === "string" && raw.trim() !== "") {
        // A browser <input type="number">'s .value is always a string, but a field with no
        // persistenceMapping (a pagination skip/pageSize, a numeric filter) has no column type to
        // coerce by above — Cypher's SKIP/LIMIT and numeric comparisons need a real number, not "0".
        const num = Number(raw);
        if (Number.isFinite(num)) raw = num;
      }
      resolved[pname] = raw;
    } else {
      resolved[pname] = source; // literal default from the XML itself
    }
    // Applied last, regardless of source — covers both a real signup's submitted password and a
    // <generate>-produced temp password through the same mechanism. Never stored/sent raw.
    if (hash && resolved[pname] !== null && resolved[pname] !== undefined) resolved[pname] = hashPassword(String(resolved[pname]));
  }
  return resolved;
}

export type EventAction =
  | { type: "map"; target: string; value: unknown }
  | { type: "set"; target: string; value: unknown }
  | { type: "message"; messageType: string; value: string }
  | { type: "navigate"; screenId: string; screenName: string }
  | { type: "session"; action: "start" | "end"; identity?: string; role?: string; mustChangePassword?: boolean }
  // Never forwarded to the client (filtered out the same way a "session" action is) — the caller
  // sends it for real, after its write transaction has committed; see previewDb.ts.
  | { type: "email"; to: string; subject: string; body: string }
  | { type: "stop" };

function parseScreenRoot(screenXml: string): XmlElement | null {
  try {
    const doc = new DOMParser().parseFromString(screenXml, "text/xml");
    return doc.documentElement || null;
  } catch {
    return null;
  }
}

// <event ... allowAnonymous="true"> marks an event as safe to run with no identity at all — the
// ONLY way an unauthenticated caller is allowed to do anything (see previewDb.ts's run-event dual
// auth). Only ever a login check or an account-creation/signup, by convention documented in the AI
// prompt; the engine itself enforces nothing about what such an event may contain, same as any
// other event — this just answers "is this specific element+type pair marked safe".
export function isAnonymousEvent(screenXml: string, elementId: string, eventType: string): boolean {
  const root = parseScreenRoot(screenXml);
  if (!root) return false;
  const event = Array.from(root.getElementsByTagName("event")).find(
    (ev) => ev.getAttribute("element") === elementId && ev.getAttribute("type") === eventType
  );
  return event?.getAttribute("allowAnonymous") === "true";
}

// requiredRole="Admin,Manager" on a specific <event> — null means no restriction beyond being
// logged in at all (the normal case today). Checked server-side in previewDb.ts's run-event route,
// before anything in the event runs; the builder's own Studio preview bypasses this the same way it
// already bypasses allowAnonymous/session concerns — the project owner always has full access.
export function eventRequiredRole(screenXml: string, elementId: string, eventType: string): string[] | null {
  const root = parseScreenRoot(screenXml);
  if (!root) return null;
  const event = Array.from(root.getElementsByTagName("event")).find(
    (ev) => ev.getAttribute("element") === elementId && ev.getAttribute("type") === eventType
  );
  return parseRoleList(event?.getAttribute("requiredRole") ?? null);
}

// requiredRole="Admin,Manager" on the <screen> element itself — null means any logged-in session
// may open it (the normal case today). Checked in runtimeRender.ts before the screen's structure is
// ever sent to the client, same bypass-for-the-builder rule as eventRequiredRole above.
export function screenRequiredRole(screenXml: string): string[] | null {
  const root = parseScreenRoot(screenXml);
  if (!root) return null;
  return parseRoleList(root.getAttribute("requiredRole"));
}

// <event ... allowPasswordChange="true"> marks an event as reachable even while the session is
// flagged mustChangePassword — the ONLY way such a session is allowed to do anything (mirrors
// isAnonymousEvent/allowAnonymous exactly, one level up: that gate is for "not logged in at all",
// this one is for "logged in, but must change a temporary password before anything else"). Only
// ever a Change Password screen's save event, by convention documented in the AI prompt.
export function eventAllowsPasswordChange(screenXml: string, elementId: string, eventType: string): boolean {
  const root = parseScreenRoot(screenXml);
  if (!root) return false;
  const event = Array.from(root.getElementsByTagName("event")).find(
    (ev) => ev.getAttribute("element") === elementId && ev.getAttribute("type") === eventType
  );
  return event?.getAttribute("allowPasswordChange") === "true";
}

// Whether this screen has AT LEAST ONE allowPasswordChange event — i.e. it's the Change Password
// screen, the only screen a mustChangePassword session may open. Mirrors hasAnonymousEntry exactly.
export function hasPasswordChangeEntry(screenXml: string): boolean {
  const root = parseScreenRoot(screenXml);
  if (!root) return false;
  return Array.from(root.getElementsByTagName("event")).some((ev) => ev.getAttribute("allowPasswordChange") === "true");
}

// Whether this screen has AT LEAST ONE allowAnonymous event — i.e. it's a genuine entry point (a
// Login/Signup screen) and may be rendered with no identity at all. Every other screen stays
// private (requires a builder token or a real app session) even if its id is guessed.
export function hasAnonymousEntry(screenXml: string): boolean {
  let root: XmlElement;
  try {
    const doc = new DOMParser().parseFromString(screenXml, "text/xml");
    if (!doc.documentElement) return false;
    root = doc.documentElement;
  } catch {
    return false;
  }
  return Array.from(root.getElementsByTagName("event")).some((ev) => ev.getAttribute("allowAnonymous") === "true");
}

// A project's OTHER screens (never includes the one currently running) — a <navigate screen="..">
// is resolved against this, real id first, then a case-insensitive name match, so navigation only
// ever lands on a screen that genuinely exists right now.
export type SiblingScreen = { id: string; name: string };

function resolveSibling(ref: string, siblingScreens: SiblingScreen[]): SiblingScreen | null {
  const trimmed = (ref || "").trim();
  if (!trimmed) return null;
  return siblingScreens.find((s) => s.id === trimmed) || siblingScreens.find((s) => s.name.trim().toLowerCase() === trimmed.toLowerCase()) || null;
}

// A reference to a screen that no longer exists (renamed away/deleted since this XML was
// generated, or the model referencing something that was never real) degrades to a visible error
// message instead of navigating nowhere or throwing — same "fail soft" spirit as
// evaluateCondition/resolveTemplate's handling of a malformed condition/template.
function runNavigate(el: XmlElement, siblingScreens: SiblingScreen[], actions: EventAction[]): void {
  const ref = el.getAttribute("screen") || "";
  const target = resolveSibling(ref, siblingScreens);
  if (target) {
    actions.push({ type: "navigate", screenId: target.id, screenName: target.name });
  } else {
    console.warn(`run_event: <navigate> referenced unknown screen ${JSON.stringify(ref)}`);
    actions.push({ type: "message", messageType: "error", value: "That screen isn't available right now." });
  }
}

// Executes one screen element's <events><event> chain for real, inside the CALLER's transaction
// (the caller commits/rolls back — same pattern as syncSchema/replaceAllRows). Walks its ordered
// <execute>/<navigate> steps and returns a flat, already-decided list of UI actions (map/set/
// message/navigate/stop) for the UI runtime to apply mechanically. Throws on a genuine failure
// (malformed XML, unknown element, a query that fails to execute) so the caller rolls back instead
// of silently committing a partially-applied chain.
export async function runEvent(
  exec: QueryExecutor, entities: Entities, screenXml: string,
  elementId: string, eventType: string, fieldValues: Record<string, unknown>,
  siblingScreens: SiblingScreen[] = [], sessionIdentity: string | null = null, sessionRole: string | null = null
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
  const fieldMeta = parseFieldMeta(root);
  const element = findElementById(root, elementId);
  if (!element) throw new Error(`No element with id ${JSON.stringify(elementId)} on this screen`);

  // <event> lives in ONE top-level <events> block (element="..." says what it's wired to), not
  // nested inside the field/button itself — matches the current vocabulary (ai_service.py).
  const eventEls = Array.from(root.getElementsByTagName("event"));
  const event = eventEls.find((ev) => ev.getAttribute("element") === elementId && ev.getAttribute("type") === eventType);
  if (!event) return []; // this element has no handler for this event type — a no-op, not an error

  const actions: EventAction[] = [];
  const values = { ...fieldValues }; // a <set> can feed later steps in the same chain

  // Tracks whether a real write/delete actually ran, so a save that succeeds silently (the XML
  // wrote no <message>) still tells the user something happened instead of looking like a dead button.
  const write = { kind: null as "save" | "delete" | null };
  const trackedExec: QueryExecutor = async (statement, params) => {
    if (/\bDELETE\b/i.test(statement)) write.kind = "delete";
    else if (/\b(CREATE|MERGE|SET|REMOVE)\b/i.test(statement) && write.kind !== "delete") write.kind = "save";
    return exec(statement, params);
  };

  for (const step of childElements(event)) {
    if (step.tagName === "execute") {
      const stopped = await runExecute(trackedExec, queries, fieldPersistence, entities, siblingScreens, fieldMeta, step, values, actions, sessionIdentity, sessionRole);
      if (stopped) break; // a <stop/> or <navigate/> anywhere inside cancels any later top-level step
    } else if (step.tagName === "navigate") {
      runNavigate(step, siblingScreens, actions);
      break; // navigating away ends the chain, same as <stop>
    } else if (
      step.tagName === "message" || step.tagName === "set" || step.tagName === "stop" || step.tagName === "session" ||
      step.tagName === "generate" || step.tagName === "email"
    ) {
      // e.g. a closing <message type="success" value="Saved."/> written after the executes. It has
      // no query result of its own, so ${result.*} placeholders resolve to empty.
      if (await runStep(trackedExec, queries, fieldPersistence, entities, siblingScreens, fieldMeta, step, { rows: [], count: 0 }, values, actions, sessionIdentity, sessionRole)) break;
    }
  }
  if (write.kind && !actions.some((a) => a.type === "message" || a.type === "navigate")) {
    actions.push({ type: "message", messageType: "success", value: write.kind === "delete" ? "Deleted successfully." : "Saved successfully." });
  }
  return actions;
}

// Runs ONE <execute>'s query and processes its map/when children in order. Returns true if a
// <stop/> or <navigate/> fired anywhere inside it (including inside a nested <when><execute>), so
// the caller knows to stop walking any later sibling.
async function runExecute(
  exec: QueryExecutor, queries: Map<string, ParsedQuery>, fieldPersistence: Map<string, [string, string]>,
  entities: Entities, siblingScreens: SiblingScreen[], fieldMeta: Map<string, FieldMeta>,
  executeEl: XmlElement, fieldValues: Record<string, unknown>, actions: EventAction[], sessionIdentity: string | null, sessionRole: string | null
): Promise<boolean> {
  const queryId = executeEl.getAttribute("query");
  const query = queryId ? queries.get(queryId) : undefined;
  if (!query) {
    console.warn(`run_event: unknown query id ${JSON.stringify(queryId)}`);
    return false;
  }
  // Validated before a write ever reaches the database — same transaction, so a rejected write
  // leaves nothing partially applied. A read-only query (list/search/filter/sort) never matches
  // WRITE_STATEMENT_RE, so this never blocks anything but an actual save/delete.
  if (WRITE_STATEMENT_RE.test(query.statement)) {
    const violations = await validateWriteFields(query, fieldValues, fieldMeta, fieldPersistence, entities, exec, sessionRole);
    if (violations.length) {
      actions.push(...violations, { type: "stop" });
      return true;
    }
  }
  const params = resolveQueryParams(query.params, fieldValues, fieldPersistence, entities, fieldMeta, sessionIdentity, sessionRole);
  let result = await exec(query.statement, params);

  // Login verification: the Cypher WHERE clause can never match a bcrypt hash (the same password
  // hashes differently every time), so this comparison happens here instead, right after the query
  // returns and before anything downstream (a <when>, a <map>) ever sees the row. Success keeps
  // result exactly as the query really returned it (so role/mustChangePassword/etc. columns stay
  // available) minus the raw hash itself; failure or no matching row forces result.count to 0 and
  // clears rows — the screen's existing <when condition="result.count > 0"> vocabulary is unchanged.
  if (query.passwordField && query.passwordColumn) {
    const row = result.rows[0];
    const storedHash = row?.[query.passwordColumn];
    const submitted = resolveOperand(query.passwordField, result, fieldValues, { identity: sessionIdentity, role: sessionRole });
    const matches = typeof storedHash === "string" && typeof submitted === "string" && verifyPassword(submitted, storedHash);
    if (!matches) {
      result = { rows: [], count: 0 };
    } else {
      const { [query.passwordColumn]: _hash, ...rest } = row;
      result = { rows: [rest], count: result.count };
    }
  }

  const session: SessionContext = { identity: sessionIdentity, role: sessionRole };
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
      if (!evaluateCondition(child.getAttribute("condition") || "", result, fieldValues, session)) continue;
      if (await runWhenBody(exec, queries, fieldPersistence, entities, siblingScreens, fieldMeta, child, result, fieldValues, actions, sessionIdentity, sessionRole)) {
        return true;
      }
    } else if (
      child.tagName === "execute" || child.tagName === "set" || child.tagName === "message" || child.tagName === "navigate" ||
      child.tagName === "stop" || child.tagName === "session" || child.tagName === "generate" || child.tagName === "email"
    ) {
      // The model routinely writes "insert, THEN reload the list" as a second <execute> nested
      // directly inside the first (no <when> around it). Silently skipping it meant a successful
      // save never refreshed the grid or confirmed anything — so an unconditional step runs the
      // same way a step inside a matched <when> does.
      if (await runStep(exec, queries, fieldPersistence, entities, siblingScreens, fieldMeta, child, result, fieldValues, actions, sessionIdentity, sessionRole)) return true;
    }
  }
  return false;
}

// Processes a matched <when>'s children in order: <set>/<message>/<navigate>/<stop>, or a nested
// <execute> — a real generation reliably nests a second <execute> inside a <when> for "only do the
// next step if this one found something" chains, so this supports it natively rather than forcing
// every conditional chain to be flattened into top-level siblings. Returns true if a <stop/> or
// <navigate/> fired.
async function runWhenBody(
  exec: QueryExecutor, queries: Map<string, ParsedQuery>, fieldPersistence: Map<string, [string, string]>,
  entities: Entities, siblingScreens: SiblingScreen[], fieldMeta: Map<string, FieldMeta>,
  whenEl: XmlElement, result: QueryResult, fieldValues: Record<string, unknown>, actions: EventAction[], sessionIdentity: string | null, sessionRole: string | null
): Promise<boolean> {
  for (const inner of childElements(whenEl)) {
    if (await runStep(exec, queries, fieldPersistence, entities, siblingScreens, fieldMeta, inner, result, fieldValues, actions, sessionIdentity, sessionRole)) return true;
  }
  return false;
}

// One <set>/<message>/<navigate>/<stop>/<session>/<execute> step, shared by a matched <when> and an
// unconditional step directly inside an <execute>. Returns true if a <stop/> or <navigate/> fired.
async function runStep(
  exec: QueryExecutor, queries: Map<string, ParsedQuery>, fieldPersistence: Map<string, [string, string]>,
  entities: Entities, siblingScreens: SiblingScreen[], fieldMeta: Map<string, FieldMeta>,
  inner: XmlElement, result: QueryResult, fieldValues: Record<string, unknown>, actions: EventAction[], sessionIdentity: string | null, sessionRole: string | null
): Promise<boolean> {
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
  } else if (inner.tagName === "navigate") {
    runNavigate(inner, siblingScreens, actions);
    return true;
  } else if (inner.tagName === "stop") {
    actions.push({ type: "stop" });
    return true;
  } else if (inner.tagName === "session") {
    const action = inner.getAttribute("action");
    if (action === "start" || action === "end") {
      // identity="field:x" / role="field:x" (only meaningful on "start") — resolved the SAME way
      // any other operand is (field:/result./literal/session:identity/session:role), via the
      // existing resolveOperand, so a login/signup's identity/role is whatever field or result
      // column the AI names — and a password-change event can re-issue the CURRENT session's own
      // identity/role via identity="session:identity" role="session:role" without having to re-know
      // or re-look them up.
      const session: SessionContext = { identity: sessionIdentity, role: sessionRole };
      const identitySource = action === "start" ? inner.getAttribute("identity") : null;
      const resolvedIdentity = identitySource ? resolveOperand(identitySource, result, fieldValues, session) : null;
      const identity = resolvedIdentity !== null && resolvedIdentity !== undefined && resolvedIdentity !== "" ? String(resolvedIdentity) : undefined;
      const roleSource = action === "start" ? inner.getAttribute("role") : null;
      const resolvedRole = roleSource ? resolveOperand(roleSource, result, fieldValues, session) : null;
      const role = resolvedRole !== null && resolvedRole !== undefined && resolvedRole !== "" ? String(resolvedRole) : undefined;
      // mustChangePassword="result.mustChangePassword" (or a literal "true"/"false") — marks a
      // session issued with a temporary password; omitted means false (a normal session). Only
      // meaningful on "start".
      const mcpSource = action === "start" ? inner.getAttribute("mustChangePassword") : null;
      const resolvedMcp = mcpSource ? resolveOperand(mcpSource, result, fieldValues, session) : null;
      const mustChangePassword = resolvedMcp === true || resolvedMcp === "true";
      actions.push({
        type: "session", action,
        ...(identity !== undefined ? { identity } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(action === "start" ? { mustChangePassword } : {}),
      });
    }
    // Deliberately does NOT return true — a login success is typically <session action="start"/>
    // immediately followed by a sibling <navigate>, and both need to run in the same chain.
  } else if (inner.tagName === "generate") {
    // <generate target="field:x" type="password"/> — a securely server-generated value (Node's
    // crypto, never Math.random), written into fieldValues exactly like <set> so a later step
    // (hashing it into a CREATE, emailing it) can reference it the same way any other field value
    // is referenced. Sent to the client as a normal "set" action — the person running this event is
    // already an authenticated Staff/Admin creating someone else's account, the same trust level as
    // every other field value they can already see.
    const target = inner.getAttribute("target") || "";
    const value = generateSecureValue(inner.getAttribute("type") || "password");
    if (target.startsWith("field:")) fieldValues[target.slice("field:".length)] = value;
    actions.push({ type: "set", target, value });
  } else if (inner.tagName === "email") {
    // <email to="field:x" subject="..." body="..."/> — to resolves via the same operand resolver
    // every other field/result/session reference does; subject/body resolve via the existing
    // ${field:x}/${result.x} template substitution, identical syntax to <message value="...">.
    // Never sent to the client (filtered out downstream, same as a "session" action) — the caller
    // sends it for real only after its write transaction has committed; see previewDb.ts.
    const session: SessionContext = { identity: sessionIdentity, role: sessionRole };
    const toRaw = resolveOperand(inner.getAttribute("to") || "", result, fieldValues, session);
    const to = toRaw !== null && toRaw !== undefined ? String(toRaw) : "";
    const subject = resolveTemplate(inner.getAttribute("subject") || "", result, fieldValues);
    const body = resolveTemplate(inner.getAttribute("body") || "", result, fieldValues);
    actions.push({ type: "email", to, subject, body });
  } else if (inner.tagName === "execute") {
    if (await runExecute(exec, queries, fieldPersistence, entities, siblingScreens, fieldMeta, inner, fieldValues, actions, sessionIdentity, sessionRole)) return true;
  }
  return false;
}

