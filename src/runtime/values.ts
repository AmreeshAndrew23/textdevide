import neo4j from "neo4j-driver";

export type AutonumberConfig = {
  prefix?: string;
  suffix?: string;
  leading_zeroes?: number | string;
  start_number?: number | string;
  step_number?: number | string;
};
export type Column = {
  name: string;
  type?: string;
  pk?: boolean;
  fk?: string;
  nullable?: boolean;
  unique?: boolean;
  autonumber?: AutonumberConfig | null;
};
export type Table = { name: string; columns?: Column[] };
export type Entities = { tables?: Table[] };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function safeIdent(name: string): string {
  if (!name || !IDENT_RE.test(name)) throw new Error(`Unsafe identifier: ${JSON.stringify(name)}`);
  return name;
}

export function findTable(entities: Entities, entity: string): Table | undefined {
  return (entities.tables || []).find((t) => t.name === entity);
}

export function columnType(entities: Entities, table: string, column: string): string {
  const col = (findTable(entities || {}, table)?.columns || []).find((c) => c.name === column);
  return col?.type || "TEXT";
}

export const INTEGER_TYPES = new Set(["INT", "INTEGER", "SMALLINT", "BIGINT"]);

// Converts a raw request value to the property type the column's declared SQL-ish type implies.
// Unparseable numerics become null (the property is then simply omitted) instead of failing a save.
export function coerceValue(value: unknown, sqlType: string | undefined): unknown {
  if (typeof value !== "string") return value;
  const t = (sqlType || "").trim().toUpperCase().replace(/\(.*\)$/, "");
  if (t.startsWith("TIMESTAMP")) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (t.startsWith("DATE")) return value.slice(0, 10);
  if (t === "DECIMAL" || t === "NUMERIC" || t === "FLOAT" || t === "REAL" || t === "DOUBLE PRECISION") {
    const n = parseFloat(value);
    return Number.isNaN(n) || !/^-?\d+(\.\d+)?$/.test(value.trim()) ? null : n;
  }
  if (t === "BOOLEAN" || t === "BOOL") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  if (INTEGER_TYPES.has(t)) {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }
  return value;
}

// JS numbers are sent to Neo4j as Float by default; whole numbers must be explicit Integers so
// integer keys/counters stay integers (and compare/sort as such).
export function toDriverValue(v: unknown): unknown {
  if (typeof v === "number" && Number.isInteger(v)) return neo4j.int(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toDriverValue);
  if (v && typeof v === "object" && !neo4j.isInt(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toDriverValue(x)]));
  }
  return v;
}

export function fromDriverValue(v: unknown): unknown {
  if (neo4j.isInt(v)) return neo4j.integer.inSafeRange(v) ? v.toNumber() : v.toString();
  if (Array.isArray(v)) return v.map(fromDriverValue);
  if (neo4j.isDate(v) || neo4j.isDateTime(v) || neo4j.isLocalDateTime(v) || neo4j.isTime(v) || neo4j.isLocalTime(v) || neo4j.isDuration(v)) {
    return String(v);
  }
  if (v && typeof v === "object") {
    const maybeNode = v as { properties?: unknown; labels?: unknown };
    if (maybeNode.properties && maybeNode.labels) return fromDriverValue(maybeNode.properties);
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fromDriverValue(x)]));
  }
  return v;
}

export function formatAutonumber(config: AutonumberConfig, n: number): string {
  const width = parseInt(String(config.leading_zeroes ?? 0), 10) || 0;
  return `${config.prefix || ""}${String(n).padStart(width, "0")}${config.suffix || ""}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function autonumberSeed(config: AutonumberConfig, existingValues: unknown[]): [number, number] {
  const prefix = config.prefix || "";
  const suffix = config.suffix || "";
  const step = parseInt(String(config.step_number ?? 1), 10) || 1;
  const start = parseInt(String(config.start_number ?? 1), 10) || 1;
  const pattern = new RegExp(`^${escapeRegex(prefix)}(\\d+)${escapeRegex(suffix)}$`);
  let seenMax: number | null = null;
  for (const v of existingValues) {
    const m = pattern.exec(String(v));
    if (m) {
      const n = parseInt(m[1], 10);
      seenMax = seenMax === null ? n : Math.max(seenMax, n);
    }
  }
  return [seenMax !== null ? seenMax + step : start, step];
}
