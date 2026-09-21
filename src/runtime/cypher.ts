/**
 * Safety layer for the Cypher a screen's <query><statement> is allowed to run. The screen XML is
 * AI-generated (and user-refinable), so this is deny-by-default: exactly one statement, a fixed set
 * of clauses, bound parameters only, no relationships/procedures/schema commands, and — because all
 * projects share one Neo4j database — EVERY node pattern must carry one of THIS project's own table
 * labels, which are then rewritten to their project-prefixed form (Proj<id>_<Table>). An unlabeled
 * `MATCH (n)` (a whole-database scan) is therefore impossible.
 */

export function labelFor(projectId: number, table: string): string {
  return `Proj${projectId}_${(table || "").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

const LITERAL_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
const ALLOWED_START = new Set(["MATCH", "OPTIONAL", "CREATE", "MERGE", "UNWIND", "WITH", "RETURN"]);
const FORBIDDEN_RE = /(?<![.\w])(CALL|LOAD|DROP|ALTER|SHOW|GRANT|DENY|REVOKE|USE|INDEX|CONSTRAINT|FOREACH|TERMINATE|START|PROFILE|EXPLAIN)(?!\w)/i;
const PROCEDURE_NAMESPACE_RE = /(?<![.\w])(apoc|dbms|db)\s*\./i;
const SUBQUERY_RE = /(?<![.\w])(EXISTS|COUNT|COLLECT)\s*\{/i;
const PARAM_RE = /\$([A-Za-z_]\w*)/g;

const TERMINATOR_RE = /(?<![.\w])(OPTIONAL\s+MATCH|MATCH|MERGE|CREATE|WHERE|RETURN|WITH|SET|DELETE|DETACH|REMOVE|ORDER|LIMIT|SKIP|UNWIND|ON|UNION)(?!\w)/gi;
const PATTERN_CLAUSES = new Set(["OPTIONAL MATCH", "MATCH", "MERGE", "CREATE"]);
const NODE_PATTERN_RE = /^\(\s*(?:[A-Za-z_]\w*)?\s*((?::\s*[A-Za-z_]\w*\s*)+)(?:\{[\s\S]*\})?\s*\)$/;
const NODE_LABELS_RE = /(\(\s*(?:[A-Za-z_]\w*)?\s*)((?::\s*[A-Za-z_]\w*\s*)+)/g;

export function maskLiterals(statement: string): string {
  return statement.replace(LITERAL_RE, "''");
}

export function usedParams(statement: string): Set<string> {
  return new Set(Array.from(maskLiterals(statement).matchAll(PARAM_RE)).map((m) => m[1]));
}

// Splits on commas that are not nested inside (), {} or [].
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Checks that don't need to know the project's tables — also what the generation-time linter uses.
// Returns the literal-masked statement for further analysis.
export function validateCypherStatic(statement: string, providedParams?: Set<string>): string {
  const stmt = (statement || "").trim();
  if (!stmt) throw new Error("Empty statement");
  const masked = maskLiterals(stmt);
  const first = (/^(\w+)/.exec(masked)?.[1] || "").toUpperCase();
  if (!ALLOWED_START.has(first)) throw new Error(`Statement must start with MATCH/OPTIONAL MATCH/CREATE/MERGE/UNWIND/WITH/RETURN, got: ${JSON.stringify(first)}`);
  if (masked.includes(";")) throw new Error("Statement must not contain ';'");
  if (/\/\/|\/\*/.test(masked)) throw new Error("Statement must not contain comments");
  if (/--|-\s*\[|\]\s*-/.test(masked)) throw new Error("Relationship patterns are not supported — relate tables by comparing key properties in WHERE");
  const forbidden = FORBIDDEN_RE.exec(masked);
  if (forbidden) throw new Error(`Statement must not use ${forbidden[1].toUpperCase()}`);
  if (PROCEDURE_NAMESPACE_RE.test(masked)) throw new Error("Procedure/namespace calls are not allowed");
  if (SUBQUERY_RE.test(masked)) throw new Error("Subqueries are not allowed");
  if (providedParams) {
    const missing = [...usedParams(stmt)].filter((p) => !providedParams.has(p));
    if (missing.length) throw new Error(`Statement uses undeclared parameter(s): ${JSON.stringify(missing)}`);
  }
  return masked;
}

// Full validation against a project's tables + label rewriting. Returns the statement ready to run.
export function prepareCypher(statement: string, projectId: number, tables: Set<string>, providedParams: Set<string>): string {
  const masked = validateCypherStatic(statement, providedParams);

  const keywords = Array.from(masked.matchAll(TERMINATOR_RE));
  keywords.forEach((kw, i) => {
    const name = kw[1].toUpperCase().replace(/\s+/g, " ");
    if (!PATTERN_CLAUSES.has(name)) return;
    const end = i + 1 < keywords.length ? keywords[i + 1].index! : masked.length;
    const body = masked.slice(kw.index! + kw[0].length, end).trim();
    if (!body) return; // e.g. the CREATE in "ON CREATE SET"
    for (const pattern of splitTopLevel(body)) {
      const m = NODE_PATTERN_RE.exec(pattern);
      if (!m) throw new Error(`Unsupported pattern in ${name}: ${JSON.stringify(pattern.slice(0, 80))} — use labeled node patterns like (x:Table)`);
      for (const label of Array.from(m[1].matchAll(/:\s*([A-Za-z_]\w*)/g)).map((l) => l[1])) {
        if (!tables.has(label)) throw new Error(`Unknown table/label "${label}" — this project's tables are ${JSON.stringify([...tables].sort())}`);
      }
    }
  });

  return statement.replace(/('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|([^'"]+)/g, (_m, literal: string | undefined, code: string | undefined) => {
    if (literal !== undefined) return literal;
    return (code as string).replace(NODE_LABELS_RE, (_x, open: string, labels: string) =>
      open + labels.replace(/:\s*([A-Za-z_]\w*)/g, (_y, name: string) => `:${labelFor(projectId, name)}`)
    );
  });
}
