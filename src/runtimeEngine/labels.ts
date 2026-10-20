/**
 * Label scheme + Cypher safety for the new engine's Entity data rows — deliberately its OWN
 * namespace (RtApp<applicationId>_<EntityName>), never the old engine's Proj<id>_<Table> space,
 * so an Entity named "Vendor" here can never collide with an unrelated AI-generated "Vendor" table
 * from the old engine. Reuses runtime/cypher.ts's validateCypherStatic directly (pure syntax
 * checks, label-scheme-agnostic) but reimplements the label-REWRITING step with its own label
 * function rather than importing prepareCypher, which is hardcoded to the old engine's labelFor.
 */
import { validateCypherStatic } from "../runtime/cypher.js";

export function entityLabelFor(applicationId: string | number, entityName: string): string {
  return `RtApp${applicationId}_${(entityName || "").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

const TERMINATOR_RE = /(?<![.\w])(OPTIONAL\s+MATCH|MATCH|MERGE|CREATE|WHERE|RETURN|WITH|SET|DELETE|DETACH|REMOVE|ORDER|LIMIT|SKIP|UNWIND|ON|UNION)(?!\w)/gi;
const PATTERN_CLAUSES = new Set(["OPTIONAL MATCH", "MATCH", "MERGE", "CREATE"]);
const NODE_PATTERN_RE = /^\(\s*(?:[A-Za-z_]\w*)?\s*((?::\s*[A-Za-z_]\w*\s*)+)(?:\{[\s\S]*\})?\s*\)$/;
const NODE_LABELS_RE = /(\(\s*(?:[A-Za-z_]\w*)?\s*)((?::\s*[A-Za-z_]\w*\s*)+)/g;

// Splits on commas not nested inside (), {} or [] — same approach cypher.ts's splitTopLevel uses.
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

// Full validation against this Application's own entity names + label rewriting to
// RtApp<applicationId>_<EntityName>. Only every machine-generated statement this engine itself
// compiles (dataSourceCompiler.ts, entityStore.ts) ever reaches this — never AI- or hand-written
// Cypher — so the allowlist below is defense-in-depth, not the primary safety mechanism.
export function prepareAppCypher(
  statement: string, applicationId: string | number, entityNames: Set<string>, providedParams: Set<string>
): string {
  const masked = validateCypherStatic(statement, providedParams);

  const keywords = Array.from(masked.matchAll(TERMINATOR_RE));
  keywords.forEach((kw, i) => {
    const name = kw[1].toUpperCase().replace(/\s+/g, " ");
    if (!PATTERN_CLAUSES.has(name)) return;
    const end = i + 1 < keywords.length ? keywords[i + 1].index! : masked.length;
    const body = masked.slice(kw.index! + kw[0].length, end).trim();
    if (!body) return;
    for (const pattern of splitTopLevel(body)) {
      const m = NODE_PATTERN_RE.exec(pattern);
      if (!m) throw new Error(`Unsupported pattern in ${name}: ${JSON.stringify(pattern.slice(0, 80))} — use labeled node patterns like (x:EntityName)`);
      for (const label of Array.from(m[1].matchAll(/:\s*([A-Za-z_]\w*)/g)).map((l) => l[1])) {
        if (!entityNames.has(label)) throw new Error(`Unknown entity "${label}" — this application's entities are ${JSON.stringify([...entityNames].sort())}`);
      }
    }
  });

  return statement.replace(/('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|([^'"]+)/g, (_m, literal: string | undefined, code: string | undefined) => {
    if (literal !== undefined) return literal;
    return (code as string).replace(NODE_LABELS_RE, (_x, open: string, labels: string) =>
      open + labels.replace(/:\s*([A-Za-z_]\w*)/g, (_y, name: string) => `:${entityLabelFor(applicationId, name)}`)
    );
  });
}
