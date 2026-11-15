/**
 * Bulk "Import CSV" into one module. The browser parses the file and maps its columns to fields;
 * this takes the resulting rows and saves each one through the SAME save the module's form uses
 * (runButtonAction "save"), so required fields, validations, auto-numbers, auditing and row-level
 * access all apply exactly as if someone had typed the record in. A row that breaks a rule is
 * reported with its row number and the rest still go in.
 *
 * Every imported row is a NEW record (it gets a fresh key); a file can't overwrite or reach
 * existing records. Linked fields accept either the linked record's key or its display name
 * ("Dr. Rao" for a doctor link), which is what Export writes, so exported files import cleanly.
 */
import type { Transaction } from "neo4j-driver";
import { randomUUID, randomInt } from "crypto";
import type { AuditingDef, EntityDef, FieldDef, ValidationDef } from "./applicationModel.js";
import { runButtonAction } from "./applicationEngine.js";
import type { AutoNumbers } from "./autoNumber.js";
import { listEntityRows } from "./entityStore.js";
import { PROTECTED_ACCOUNT_FIELDS, type AppModel } from "./publicAccess.js";
import { matchesScope, type ResolvedScope } from "./rowScope.js";

export const MAX_IMPORT_ROWS = 1000;

export type ImportContext = {
  applicationId: number;
  model: AppModel;
  entity: EntityDef;
  validations: ValidationDef[];
  auditing: AuditingDef | null;
  autoNumbers: AutoNumbers;
  identity: string | null;
  role: string | null;
  scope?: ResolvedScope | null;
};

export type ImportResult = { created: number; errors: { row: number; message: string }[] };

// Fields a file may fill: not the key, not a generated number, not an audit stamp, nothing secret.
export function importableFields(entity: EntityDef, auditing: AuditingDef | null, autoNumbers: AutoNumbers = {}): FieldDef[] {
  const stamped = new Set((auditing?.fields ?? []).map((f) => f.name));
  return entity.fields.filter((f) =>
    !f.key && !(f.autoNumber && autoNumbers[f.autoNumber]) && !stamped.has(f.name) && !f.name.startsWith("__") &&
    !PROTECTED_ACCOUNT_FIELDS.includes(f.name) && f.name !== "passwordHash"
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

// Spreadsheets write dates many ways. Day-first for slashes and dashes (13/03/2026), as the users
// this is built for write them; ISO and "13 Mar 2026" are unambiguous.
export function parseDate(text: string): string | null {
  const s = text.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})$/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return valid(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return valid(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return null;
}
function valid(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

// visitDate -> "Visit date", as the import dialog labels it.
const label = (f: FieldDef) => f.name.replace(/Id$/, "").replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/^./, (c) => c.toUpperCase());

// One cell into the value the form would have sent. undefined = left blank.
export function cellValue(raw: unknown, field: FieldDef): { value?: unknown; error?: string } {
  if (raw === null || raw === undefined) return {};
  const text = String(raw).trim();
  if (text === "") return {};
  switch (field.type) {
    case "integer":
    case "decimal": {
      const cleaned = text.replace(/[,\s₹$€£¥]/g, "").replace(/^\((.*)\)$/, "-$1");
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { error: `${label(field)} should be a number, not "${text}"` };
      const n = Number(cleaned);
      if (field.type === "integer" && !Number.isInteger(n)) return { error: `${label(field)} should be a whole number, not "${text}"` };
      return { value: n };
    }
    case "boolean": {
      const t = text.toLowerCase();
      if (["true", "yes", "y", "1", "✓"].includes(t)) return { value: true };
      if (["false", "no", "n", "0"].includes(t)) return { value: false };
      return { error: `${label(field)} should be yes or no, not "${text}"` };
    }
    case "date": {
      const iso = parseDate(text);
      return iso ? { value: iso } : { error: `${label(field)} should be a date like 2026-03-13, not "${text}"` };
    }
    case "enum": {
      const match = field.values.find((v) => v.toLowerCase() === text.toLowerCase());
      return match !== undefined ? { value: match } : { error: `${label(field)} must be one of ${field.values.join(", ")}, not "${text}"` };
    }
    default:
      return { value: text };
  }
}

// What a linked record is called in lists and exports: its name-like field, else its first text field.
export function displayFieldOf(entity: EntityDef): string | null {
  const names = ["name", "fullName", "title", "label", "code", "email"];
  for (const n of names) if (entity.fields.some((f) => f.name === n)) return n;
  const first = entity.fields.find((f) => !f.key && f.type === "string" && !f.name.startsWith("__") && f.name !== "passwordHash");
  return first?.name ?? null;
}

type Lookup = { target: string; keys: Map<string, unknown>; names: Map<string, unknown[]> };

async function lookupsFor(tx: Transaction, ctx: ImportContext): Promise<Map<string, Lookup>> {
  const out = new Map<string, Lookup>();
  for (const rel of ctx.model.relationships.filter((r) => r.fromEntity === ctx.entity.name)) {
    const target = ctx.model.entities.find((e) => e.name === rel.toEntity);
    if (!target || out.has(rel.fromField)) continue;
    const display = displayFieldOf(target);
    const fullName = target.fields.some((f) => f.name === "firstName") && target.fields.some((f) => f.name === "lastName");
    const lookup: Lookup = { target: target.name, keys: new Map(), names: new Map() };
    for (const row of await listEntityRows(tx, ctx.applicationId, target)) {
      const key = row[rel.toField];
      if (key === undefined || key === null) continue;
      lookup.keys.set(String(key).toLowerCase(), key);
      const names = [display ? row[display] : null, fullName ? `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() : null];
      for (const n of names) {
        if (n === null || n === undefined || n === "") continue;
        const k = String(n).trim().toLowerCase();
        lookup.names.set(k, [...(lookup.names.get(k) ?? []), key]);
      }
    }
    out.set(rel.fromField, lookup);
  }
  return out;
}

function resolveLink(text: string, lookup: Lookup): { value?: unknown; error?: string } {
  const k = text.trim().toLowerCase();
  if (lookup.keys.has(k)) return { value: lookup.keys.get(k) };
  const byName = lookup.names.get(k);
  if (byName?.length === 1) return { value: byName[0] };
  if (byName && byName.length > 1) return { error: `more than one ${lookup.target} is called "${text}" — use its ID instead` };
  return { error: `no ${lookup.target} called "${text}"` };
}

// The save reports a missing field as "Patient.fullName is required" — say "Full name is required".
function readable(message: string, entity: EntityDef): string {
  const m = message.match(/^(\w+)\.(\w+) is required$/);
  const field = m && m[1] === entity.name ? entity.fields.find((f) => f.name === m[2]) : null;
  return field ? `${label(field)} is required` : message;
}

function newKeyFor(entity: EntityDef): string | number {
  const keyField = entity.fields.find((f) => f.key);
  return keyField?.type === "integer" ? randomInt(1_000_000, 2_000_000_000) : randomUUID();
}

// rows: field name -> cell text, already mapped from the file's columns. Row numbers in errors
// count the header as row 1, as a spreadsheet shows them.
export async function importRows(tx: Transaction, ctx: ImportContext, rows: Record<string, unknown>[]): Promise<ImportResult> {
  const fields = importableFields(ctx.entity, ctx.auditing, ctx.autoNumbers);
  const lookups = await lookupsFor(tx, ctx);
  const keyName = ctx.entity.fields.find((f) => f.key)?.name ?? "id";
  const result: ImportResult = { created: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const source = rows[i] ?? {};
    const values: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const field of fields) {
      const raw = source[field.name];
      const lookup = lookups.get(field.name);
      const cell = lookup && raw !== undefined && raw !== null && String(raw).trim() !== "" ? resolveLink(String(raw), lookup) : cellValue(raw, field);
      if (cell.error) problems.push(cell.error);
      else if (cell.value !== undefined) values[field.name] = cell.value;
    }
    if (Object.keys(values).length === 0 && problems.length === 0) continue; // a blank line
    if (problems.length > 0) {
      result.errors.push({ row: rowNumber, message: problems.join("; ") });
      continue;
    }
    values[keyName] = newKeyFor(ctx.entity);

    const scope = ctx.scope;
    if (scope && !scope.creator) {
      if ((values[scope.field] === undefined || values[scope.field] === "") && scope.fill !== undefined) values[scope.field] = scope.fill;
      if (!matchesScope(values, scope)) {
        result.errors.push({ row: rowNumber, message: "you can only add records that belong to you" });
        continue;
      }
    }

    const out = await runButtonAction(
      {
        applicationId: ctx.applicationId, entity: ctx.entity, relationships: ctx.model.relationships, validations: ctx.validations,
        auditing: ctx.auditing, session: { identity: ctx.identity, vars: {}, role: ctx.role }, tx, autoNumbers: ctx.autoNumbers,
      },
      "save", [], values
    );
    const failed = out.find((a) => a.type === "message" && (a.messageType === "error" || a.messageType === "conflict"));
    if (failed && failed.type === "message") result.errors.push({ row: rowNumber, message: readable(String(failed.value), ctx.entity) });
    else result.created += 1;
  }
  return result;
}
