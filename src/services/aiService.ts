import { OPENAI_API_KEY } from "../config.js";
import { usedParams, validateCypherStatic } from "../runtime/cypher.js";

// Port of ai_service.py's shared prompt fragments and OpenAI call helpers. Prompts are copied
// verbatim (same wording = same model behavior) — only Python's str.format() {{ }} escaping is
// dropped since these are plain JS template literals, not Python format strings.

export const COLUMN_TYPE_RULES = `- Every table must have an "id" column as primary key
- For every VARCHAR column, ALWAYS include a suggested length, e.g. VARCHAR(50). Choose a sensible length for the field's purpose:
    - short codes / status / country: VARCHAR(20)
    - names / titles / cities: VARCHAR(100)
    - email / URL / file paths: VARCHAR(255)
    - long free text with no clear limit: use TEXT instead of VARCHAR
- Use the DATE type for calendar dates such as date_of_birth, joined_date, or start_date (do NOT store dates as VARCHAR)
- Use TIMESTAMP for created_at / updated_at style audit fields
- Mark foreign keys with the referenced "Table.column"
- Name tables in PascalCase
- Name columns in snake_case`;

export const EXTENDED_SCHEMA_RULES = `Column object shape — every column has these keys (use false/null where not applicable):
{
  "name": "snake_case_name",
  "type": "SQL type per the rules above, e.g. VARCHAR(100), INT, DECIMAL(3,2), TIMESTAMP",
  "pk": true|false,
  "fk": "Table.column" or null,
  "nullable": true|false,
  "default": "a literal default as a string, e.g. \\"true\\", \\"0.00\\", \\"now()\\", or null",
  "unique": true|false,
  "autonumber": null or {
    "prefix": "text before the number, may embed {YYYY}/{YY}/{MM}/{DD}, empty string if none",
    "suffix": "text after the number, empty string if none",
    "leading_zeroes": "integer — zero-padded digit width of the number part, default 4",
    "start_number": "integer, default 1",
    "step_number": "integer, default 1",
    "stop_number": "integer, default 9999 (or 10^leading_zeroes - 1)",
    "reset": {"type": "never|on_stop|yearly|monthly|daily|field_based", "field": "column name driving field_based reset, else null"}
  },
  "formula": null or {
    "expression": "the computation using other column names, e.g. internal_marks + external_marks",
    "inputs": ["array of column names this reads from, e.g. [\\"internal_marks\\", \\"external_marks\\"]"]
  }
}
- Only give a column an "autonumber" object when the user actually describes an auto-generated
  sequential/formatted identifier (invoice number, ticket code, employee code...). A plain
  surrogate "id" primary key is NOT an autonumber — leave its autonumber as null.
- An autonumbered column is always nullable:false, and usually also unique:true unless it's already the pk.
- Give a column a "formula" when the user describes it as computed/derived from other columns in
  the SAME table (a total, a sum, a difference, a percentage, a concatenation). Use plain arithmetic
  operators (+ - * /) and real column names from this same table in "expression". A formula column
  is always readonly (never directly entered by a user) — set its own "default" to null and
  "nullable" to true (it's computed, not stored input). Cross-table aggregates (e.g. "sum of all
  line items") aren't supported by this shape — add a non-blocking "unresolved" note instead of
  forcing a formula that can't actually be computed from this table's own columns.
- nullable defaults to true, EXCEPT: pk columns, autonumbered columns, and columns the user calls
  mandatory/required, which are false.

Table object shape:
{
  "name": "TableName",
  "description": "<one real sentence specific to what this table stores, or null if you don't have enough context to write one>",
  "columns": [ ...column objects... ],
  "audit_enabled": true|false,
  "history_enabled": true|false,
  "validations": [
    {"column": "col_name", "type": "required|unique|pattern|minValue|maxValue|maxLength", "detail": "a regex or numeric bound specific to this rule, or empty string if not applicable"}
  ]
}
- Set "audit_enabled": true only when the user asks for auditing / tracking who created or
  changed a record. When true, you MUST also APPEND these four objects as the LAST FOUR ITEMS
  INSIDE THE "columns" ARRAY ITSELF (they are columns, like any other — never separate top-level
  keys on the table object, never their own object outside "columns"). Keep these EXACT camelCase
  names — a deliberate exception to snake_case. Concretely, "columns" ends with exactly this
  (as four more entries in the same array as every other column, comma-separated like the rest):
  [ ... every other column ...,
    {"name": "createdBy", "type": "VARCHAR(100)", "pk": false, "fk": null, "nullable": false, "default": null, "unique": false, "autonumber": null},
    {"name": "createdAt", "type": "TIMESTAMP", "pk": false, "fk": null, "nullable": false, "default": "now()", "unique": false, "autonumber": null},
    {"name": "modifiedBy", "type": "VARCHAR(100)", "pk": false, "fk": null, "nullable": true, "default": null, "unique": false, "autonumber": null},
    {"name": "modifiedAt", "type": "TIMESTAMP", "pk": false, "fk": null, "nullable": true, "default": null, "unique": false, "autonumber": null} ]
  Do not duplicate these if the table already has columns with these names.
- Set "history_enabled": true only when the user asks to keep a change log / history / track
  changes over time for that table. This does not add columns to this table — a separate
  <TableName>_history companion table is generated downstream from this flag alone.
- "validations" holds structured rules beyond what pk/fk/nullable/unique already express (format
  patterns, numeric bounds, cross-field rules) — do not duplicate a plain uniqueness rule that's
  already captured by a column's "unique": true.

If something is genuinely ambiguous in a way that would change the resulting schema (an unclear
data type for a key field, a foreign key whose target table isn't described anywhere, contradictory
requirements) — do not silently guess. Instead add an entry to a top-level "unresolved" array
(sibling of "tables"), and still fill in your best-effort schema around it so nothing is blocked
on the question:
  {"unresolved": [{"entity": "TableName or null", "column": "col_name or null", "blocking": true|false, "question": "what's unclear and why it matters"}]}
- blocking:true = you had to guess at something that could produce a wrong/unusable schema (an
  undefined FK target you couldn't infer, an unstated key column, contradictory instructions).
- blocking:false = a minor assumption worth flagging but not worth stopping for (e.g. "assumed the
  referenced Customer table's key is customer_id since it wasn't defined here").
- Only use this for real ambiguity — most requests are clear enough that "unresolved" stays empty.`;

export const EXTRACT_PROMPT = `You are a database architect. Given the project description and features, extract all database entities (tables) with their columns, primary keys, foreign keys, and any auditing/history/autonumber/validation behavior the user describes.

Think about the actual domain being described, not just the literal words used. If the description names a broader feature or application (a bug tracker, a booking system, an inventory manager, ...) rather than a single simple lookup/reference table, identify and create EVERY table a complete, working implementation of that domain would reasonably need, correctly related via foreign keys — e.g. "a bug tracking application" isn't one Bug table, it's Bug + Project + User + Status + Priority + Comment (+ Label if tags are implied), each a real table with its own columns. Don't under-scope just because the request was short.

Return ONLY valid JSON in this exact format:
{
  "tables": [ ...table objects, see shape below... ],
  "unresolved": [ ...see shape below, [] when nothing is ambiguous... ]
}

${EXTENDED_SCHEMA_RULES}

Rules:
${COLUMN_TYPE_RULES}`;

export const REFINE_PROMPT_TEMPLATE = (entities: string, instruction: string) => `You are a database architect. Given the current schema and the user's instruction, update the schema accordingly. Keep every table and column the instruction doesn't touch exactly as it already is, including any nullable/default/unique/autonumber/audit_enabled/history_enabled/validations fields already present — never strip or reset them just because a table happened to pass through this step.

If the instruction names a broader feature or application (a bug tracker, a booking system, an inventory manager, ...) rather than a single simple lookup/reference table, add EVERY table a complete, working implementation of that domain would reasonably need, correctly related via foreign keys to each other and to the existing schema — e.g. "add tables for a bug tracking application" isn't one Bug table, it's Bug + Project + User + Status + Priority + Comment (+ Label if tags are implied), each a real table with its own columns. Don't under-scope just because the instruction was short or phrased as a single "entity."

Current schema:
<current_schema>
${entities}
</current_schema>

User's instruction:
<user_instruction>
${instruction}
</user_instruction>

${EXTENDED_SCHEMA_RULES}

Rules:
${COLUMN_TYPE_RULES}

Return ONLY valid JSON in this exact format:
{
  "tables": [ ...the full updated tables array, same shape as above... ],
  "unresolved": [ ...see shape above, [] when nothing is ambiguous... ]
}`;

export const SCHEMA_ASSISTANT_PROMPT_TEMPLATE = (table: string, otherTables: string, instruction: string) => `You are a database architect embedded in a schema editor, making one focused change at a
time to a SINGLE table based on a user's chat instruction. Keep everything about the table that the instruction
doesn't touch exactly as it already is — do not restructure, rename, or "improve" anything unasked.

Table being edited:
<table>
${table}
</table>

Other tables in this project (for foreign key targets and uniqueness context — do not modify these, only reference
them by exact name):
<other_tables>
${otherTables}
</other_tables>

User's instruction:
<instruction>
${instruction}
</instruction>

The string values shown in the shapes below are placeholders describing what to put there — replace every
one with a real, specific value for THIS table; never copy the placeholder wording itself into your output,
and never fabricate a description if the table already has a good one and the instruction doesn't touch it —
keep the existing description unchanged in that case.

${EXTENDED_SCHEMA_RULES}

Rules:
${COLUMN_TYPE_RULES}
- "Make X unique" adds a column-level validations entry AND sets unique=true on that column.
- A foreign key MUST reference a real table+column from <other_tables> (or this same table for a self-reference like
  a manager/parent) — never invent a table or column name that wasn't given to you.
- Only touch what the instruction actually asks for.

Return ONLY valid JSON in this exact shape (no markdown fences):
{
  "table": { ...the full updated table object, same shape as above... },
  "summary": "One or two plain-language sentences describing exactly what changed, written as if replying in a chat — e.g. \\"Added manager_id as a foreign key to employee.employee_id, and enabled auditing so created_by / modified_by are tracked.\\"",
  "unresolved": [ ...same shape as above, [] when nothing about this specific change is ambiguous... ]
}`;

export const ARCHITECT_WORKBENCH_PROMPT = `You are a senior software architect helping translate a plain-language requirement into concrete implementation impacts for an application: database schema, UI screens, and business validation rules.

You will be given the CURRENT state of the project (schema, screens, validation rules — any of which may be empty) and a NEW requirement in plain language. Determine the FULL resulting project state after applying the requirement, plus a human-readable summary of what changed.

Return ONLY valid JSON in exactly this shape:
{
  "summary": "Short 3-6 word title for this change, e.g. 'Added hotel management features'",
  "summary_detail": "One short paragraph in plain language describing what was built or changed, written the way a product changelog reads. Wrap the names of tables/screens/key concepts in **double asterisks** for emphasis.",
  "changes": {
    "db_schema_changes": [{"action_type": "add|modify|remove", "entity_name": "...", "column_name": "..."}],
    "table_catalog": [{"entity_name": "...", "description": "one-line description of what this table stores, used for query routing"}],
    "ui_screens": [{"screen_name": "...", "ui_field_name": "...", "action": "what to do, e.g. 'add text input field for user name, required'"}],
    "business_rules": [{"rule_name": "...", "rule_description": "...", "action": "add|modify|remove"}]
  },
  "entities": {"tables": [{"name": "TableName", "columns": [{"name": "id", "type": "INT", "pk": true, "fk": null}]}]},
  "screens": [{"name": "Short Screen Name", "description": "self-contained description of everything this screen should contain"}],
  "validation_rules": "plain-language description of ALL business rules (existing + new) combined into one readable block of text",
  "suggestions": ["3-4 short, specific, actionable next-step prompts the user could send next, grounded in what THIS project actually needs next (e.g. 'Add booking availability check', 'Add booking status workflow') — not generic advice"]
}

Rules:
- "summary" and "summary_detail" describe ONLY what changed in THIS turn, like a changelog entry — not the whole project
- "changes" lists ONLY what is new or different because of this specific requirement — a diff for the user to review, not the entire project
- "entities", "screens", and "validation_rules" must reflect the FULL resulting project state (existing state merged with this requirement), not just the diff
- CRITICAL: whenever the requirement describes an entity together with its fields (e.g. "Create a hotel master which has room type, room no, floor", "X should have a name, email...", "a booking where the customer name, address... is required"), that ALWAYS also implies at least one screen to create/view/manage that entity — you MUST add that screen to "screens" and describe its fields in "changes.ui_screens" NOW, in this same turn. Do NOT defer screen creation to "suggestions" — only skip a screen if the user explicitly says they only want the data model with no UI (e.g. "just the database", "no screen needed").
- Every entity you add or significantly change should end up with a corresponding screen unless the user said otherwise — a schema with zero screens is almost always wrong
- "suggestions" are for genuinely NEW follow-up work beyond what this turn already covers (e.g. workflows, extra screens for a different entity, extra validation) — never suggest something that "screens" or "entities" in THIS response should have already included
- "suggestions" must be concrete and specific to this project's actual domain and current gaps — never generic filler like "add more features"
${COLUMN_TYPE_RULES}
- Keep each screen's "description" self-contained — it must make sense without referencing other screens
- If a category has no impact, return an empty array for it (but never drop existing entities/screens/rules that the new requirement doesn't touch)
- Return ONLY the JSON, no explanations or markdown fences`;

// Port of the query/event XML vocabulary (ai_service.py's UI_XML_VOCABULARY_RULES/UI_XML_PROMPT/
// generate_ui_xml/_lint_screen_xml) — verbatim prompt wording. Deliberately NOT porting the
// legacy form/grid/auth/navigation vocabulary or its per-project dispatch (_project_is_legacy_xml)
// — that exists in Python only to keep already-existing old-format screens (e.g. the user's real
// Bug Tracking app) rendering unchanged, which stays true as long as that project keeps being
// served by the Python backend. This Node backend is the forward-looking replacement and only
// ever generates the current query/event schema.
export const UI_XML_VOCABULARY_RULES = `1. <screen> root with id, title, module, purpose attributes
   - purpose: one sentence describing what this screen does and why it is useful (e.g. "Manage department records — add, update, and remove departments used across the organisation.")

2. <header> — title, subtitle, breadcrumb

3. <dataSources> — exactly one <dataSource id="mainDB" type="database"/>. Every <query> references
   it via <dataSource ref="mainDB"/>. There is only ever one data source in this application (the
   project's own database) — never invent a second one.

4. <queries> — one <query id="uniqueQueryId"> per distinct database operation this screen needs.
   The database is Neo4j (a graph database): every table in the schema below is a node LABEL with
   exactly the table's name, and every column is a PROPERTY of that node with exactly the column's
   name.
   - <dataSource ref="mainDB"/>
   - <statement>...</statement> — REAL parameterized Cypher against the REAL labels/properties from
     the schema below. Exactly one statement per query, built only from MATCH, OPTIONAL MATCH, WHERE,
     WITH, UNWIND, RETURN, ORDER BY, SKIP, LIMIT, CREATE, MERGE, SET, REMOVE, DELETE / DETACH DELETE.
     EVERY node pattern MUST carry its table label — (d:Department), or
     CREATE (d:Department {deptid: $deptid, deptname: $deptname}) — never an unlabeled (n). This data
     model has NO relationships (no -[]-, no --, no ->): relate tables by comparing the foreign-key
     property to the referenced key property in WHERE, e.g. MATCH (c:Course) WHERE c.deptid = $deptid.
     No CALL, no APOC, no constraint/index statements, no ';', no comments. Bind every variable part
     with a named parameter ($paramName) — NEVER inline a literal that came from a field or another
     query's result directly into the Cypher text.
   - RETURN every value you need with an explicit alias equal to the name a <map>/<column binding>
     refers to: RETURN d.deptname AS deptname. A single-row existence/uniqueness check is
     MATCH (d:Department) WHERE d.deptid = $deptid RETURN count(d) AS count.
   - <parameters><parameter name="paramName" source="field:fieldId"/></parameters> — one entry per
     $paramName used in the statement. source is "field:<fieldId>" (that field's current value) or
     a literal default.
   Write one query per distinct purpose (a lookup query, a children/list query, an insert query, an
   update query, a uniqueness-check query, ...) rather than making one query serve several purposes.

5. <ui> — the screen's visible elements, each with a stable id, in the order they should appear:
   - <field id="fieldId" label="..." type="text|number|date|select|checkbox|password|email|textarea"
     persistenceMapping="table.column" readonly="true|false"/> — persistenceMapping names the REAL
     table.column this field reads from/writes to; omit it for a field that only ever holds an
     in-memory value (e.g. a search box). <rule> (required, pattern, unique, maxLength, minValue,
     maxValue) and <hint> children work as before. Related fields may be visually grouped inside a
     <fieldset legend="..."> — this is purely cosmetic grouping, not a new data concept.
   - <grid id="gridId" label="..." readonly="true|false" emptyMessage="...">
       <column id="colId" header="..." binding="resultColumn" persistenceMapping="table.column"/>
     </grid> — a grid never references a query directly; it is populated only when some field's or
     button's event <map>s a result onto "grid:gridId" (rule 6). Do not include sampleData — grids
     render real rows at runtime.
   - <button id="buttonId" label="..." style="primary|secondary|danger|ghost"/>
   There is no separate <form> or <toolbar> wrapper — fields, grids, and buttons live directly
   under <ui>. NEVER generate radio buttons — use type="select" for choices, type="checkbox" for a
   single boolean. Elements in <ui> NEVER contain an <events> child of their own — see rule 6, which
   is the ONLY place <event> is ever declared.

6. <events> — a SINGLE top-level <events> block, a sibling of <ui> (not nested inside it, and not
   nested inside any <field>/<button>), listing every event on the whole screen:
   <events>
     <event type="change|click" element="fieldOrButtonId">
       <execute query="queryId">
         <map result="columnName" target="field:fieldId"/>   -- one row's column -> a field
         <map result="rows" target="grid:gridId"/>           -- the whole result set -> a grid
         <when condition="result.count == 0">
           <message type="info" value="No records found."/>
           <stop/>
         </when>
         <when condition="result.count > 0">
           <set target="field:fieldId" value="\${result.someColumn}"/>
           <execute query="anotherQueryId">...</execute>  -- a <when> may nest another <execute>,
                                                               e.g. only look up a department's
                                                               courses once the department itself
                                                               was found — its own <map>/<when>
                                                               children work exactly the same way
         </when>
       </execute>
       <execute query="thirdQueryId">...</execute>  -- top-level steps also run in order; a
                                                          <stop/> anywhere (nested or not) ends
                                                          the whole event immediately
     </event>
     <event type="click" element="anotherButtonId">...</event>
   </events>
   - element="..." is REQUIRED on every <event> and MUST exactly match the id of a real <field> or
     <button> declared in <ui> above — this is how an event is wired to what triggers it, since
     <event> never lives inside the element itself. type="change" pairs with a <field>'s id, "click"
     with a <button>'s id.
   - condition is one comparison: a left operand, one of == != > &lt; >= &lt;=, and a right
     operand — a bare "<" is invalid inside an XML attribute value, so write it as "&lt;" (a bare
     ">" is fine unescaped, as used above). Operands are: result.count / result.rows.length (row
     count of the execute this <when> is nested in — both mean the same thing), result.<column>
     (that column from the first result row), field:<fieldId> (that field's current value), or a
     literal (number or quoted string).
   - Any value attribute (on <set>, <message>, ...) may use \${result.<column>} or \${field:<fieldId>}
     placeholders, substituted from the enclosing execute's result / the screen's current fields.
   - A save/insert/update button's event is typically: a validation query first (e.g. "does this
     deptid exist?"), a <when> that <message>s an error and <stop/>s if it's invalid, then the real
     insert/update query.

7. <dataBindings> — <entity name="EntityName" operations="SELECT, INSERT, UPDATE, DELETE"/> for
   every real table this screen's queries touch (documentation only — actual permissions come from
   the queries themselves).

8. <accessibility> — ariaLabel, tabOrder

There is no dedicated <auth> or <navigation> element in this format. A login/signup screen is built
from the same generic <field>/<button>/<events>/<query> primitives as any other screen (a login
button's click event runs a lookup query keyed on the identifying column, compares the stored password
column against field:password in a <when>, and either <set>s a logged-in outcome or <message>s an
error). Cross-screen navigation is handled by the application shell outside this XML — never build
a screen whose only job is linking to other screens.

These are the ONLY element/attribute types this format supports. Never introduce a new element or
attribute name beyond what's listed above, even if a request seems to call for one.`;

export const UI_XML_PROMPT = (entities: string, description: string) => `You are a UI/UX architect. Given a screen description and database schema, generate a complete XML UI definition.

Database Schema:
<database_schema>
${entities}
</database_schema>

Screen Description:
<screen_description>
${description}
</screen_description>

Design the screen using REAL queries against the REAL tables/columns in the schema above — never
invent a table or column. Think through what happens step by step before writing XML: what does the
screen show first, what user actions exist, and for each action which query (or queries) it runs and
what should happen with the result (populate a field, populate a grid, show a message, stop). A
screen that only reads data needs read-only (MATCH ... RETURN) queries and no insert/update/delete button. A screen that
creates or edits records needs a save button whose event validates first (a lookup/uniqueness-check
query) and only then runs the real CREATE/SET query. A login/signup screen is built the same way
— see the note on this at the end of the vocabulary rules below, there is no dedicated element for it.

Generate a well-structured XML that defines the entire screen. Include:

${UI_XML_VOCABULARY_RULES}

Return ONLY valid XML, no explanations or markdown fences.`;

const QUERY_BLOCK_RE = /<query[^>]*>[\s\S]*?<\/query>/gi;
const STATEMENT_RE = /<statement>([\s\S]*?)<\/statement>/id; // `d` flag -> match.indices for group offsets
const PARAM_NAME_RE = /<parameter[^>]*name="([^"]*)"/gi;

// Deterministic backstop over the model's generated Cypher: every <query>'s <statement> must pass
// the runtime's static Cypher checks (single statement, allowed clauses, no relationships/
// procedures/comments) and bind every declared <parameter> as $name rather than inlining it. A
// query that fails gets its statement swapped for a safe no-op (never touches the database)
// instead of failing the whole generation. The runtime re-runs the full validation (including the
// project-label allow-list) at actual execution time (runtime/cypher.ts).
export function lintScreenXml(xml: string): string {
  return xml.replace(QUERY_BLOCK_RE, (block) => {
    const stmtMatch = STATEMENT_RE.exec(block) as (RegExpExecArray & { indices: [number, number][] }) | null;
    if (!stmtMatch) return block;
    const [groupStart, groupEnd] = stmtMatch.indices[1]; // offsets of capture group 1 within `block`
    const statement = stmtMatch[1].trim();
    const decoded = statement
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    const declaredParams = new Set(Array.from(block.matchAll(PARAM_NAME_RE)).map((m) => m[1]));
    let bad = false;
    try {
      validateCypherStatic(decoded, declaredParams);
      const bound = usedParams(decoded);
      bad = ![...declaredParams].every((p) => bound.has(p));
    } catch {
      bad = true;
    }
    if (!bad) return block;
    console.warn(`Neutralized an invalid generated query statement: ${JSON.stringify(statement.slice(0, 200))}`);
    const safeStatement = "RETURN 1 AS noop LIMIT 0";
    return block.slice(0, groupStart) + safeStatement + block.slice(groupEnd);
  });
}

export async function generateUiXml(description: string, entities: any, usageSink?: UsageEntry[], signal?: AbortSignal): Promise<string> {
  const prompt = UI_XML_PROMPT(entities ? JSON.stringify(entities, null, 2) : "No schema defined yet", description);
  const xml = await callOpenAI(
    [
      { role: "system", content: "You are a UI/UX architect. Return ONLY valid XML." },
      { role: "user", content: prompt },
    ],
    { usageSink, signal }
  );
  return lintScreenXml(xml);
}

type ChatMessage = { role: string; content: string | unknown[] };

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type UsageEntry = { model: string; prompt_tokens: number; completion_tokens: number; total_tokens: number };

export async function callOpenAI(
  messages: ChatMessage[],
  opts: { useJson?: boolean; timeout?: number; temperature?: number; maxRetries?: number; model?: string; usageSink?: UsageEntry[]; signal?: AbortSignal } = {}
): Promise<string> {
  const { useJson = false, temperature = 0, maxRetries = 2, model = "gpt-4o-mini", usageSink, signal } = opts;
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured. Add it to your .env file.");
  if (signal?.aborted) throw new DOMException("Cancelled before the request started", "AbortError");

  const body: Record<string, unknown> = { model, messages, temperature };
  if (useJson) body.response_format = { type: "json_object" };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`OpenAI API error ${resp.status}: ${text.slice(0, 500)}`);
      }
      const data = (await resp.json()) as any;
      const choice = data.choices[0];
      if (choice.finish_reason === "length") {
        throw new Error("The AI response was cut off before finishing (hit the token limit) — try a shorter or simpler request.");
      }
      if (usageSink) {
        const usage = data.usage || {};
        usageSink.push({
          model,
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        });
      }
      return choice.message.content as string;
    } catch (e) {
      const isNetworkError = e instanceof TypeError; // fetch throws TypeError on network failure
      if (isNetworkError && attempt < maxRetries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (isNetworkError) {
        throw new Error("Couldn't reach the AI service due to a network error. Check your internet connection and try again.");
      }
      throw e;
    }
  }
  throw new Error("Unreachable");
}

export async function callOpenAIWithTools(
  messages: (ChatMessage & { tool_calls?: unknown; tool_call_id?: string })[],
  tools: unknown[],
  opts: { timeout?: number; temperature?: number; maxRetries?: number; model?: string } = {}
): Promise<{ content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }> {
  const { temperature = 0, maxRetries = 2, model = "gpt-4o-mini" } = opts;
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured. Add it to your .env file.");

  const body = { model, messages, temperature, tools };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`OpenAI API error ${resp.status}: ${text.slice(0, 500)}`);
      }
      const data = (await resp.json()) as any;
      return data.choices[0].message;
    } catch (e) {
      const isNetworkError = e instanceof TypeError;
      if (isNetworkError && attempt < maxRetries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (isNetworkError) {
        throw new Error("Couldn't reach the AI service due to a network error. Check your internet connection and try again.");
      }
      throw e;
    }
  }
  throw new Error("Unreachable");
}

export async function extractEntities(description: string, features: string, usageSink?: UsageEntry[]): Promise<any> {
  const userMessage = `<project_description>\n${description}\n</project_description>\n\n<detailed_features>\n${features}\n</detailed_features>`;
  const text = await callOpenAI(
    [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: userMessage },
    ],
    { useJson: true, usageSink }
  );
  return JSON.parse(text.trim());
}

export async function refineEntities(entities: string, instruction: string, usageSink?: UsageEntry[]): Promise<any> {
  const prompt = REFINE_PROMPT_TEMPLATE(entities, instruction);
  const text = await callOpenAI(
    [
      { role: "system", content: "You are a database architect. Return ONLY valid JSON." },
      { role: "user", content: prompt },
    ],
    { useJson: true, usageSink }
  );
  return JSON.parse(text.trim());
}

export async function schemaAssistantEditTable(
  table: Record<string, any>,
  otherTables: Record<string, any>[],
  instruction: string,
  usageSink?: UsageEntry[]
): Promise<any> {
  const otherSummary =
    otherTables.map((t) => `- ${t.name}: columns [${(t.columns || []).map((c: any) => c.name).join(", ")}]`).join("\n") || "none";
  const prompt = SCHEMA_ASSISTANT_PROMPT_TEMPLATE(JSON.stringify(table, null, 2), otherSummary, instruction);
  const text = await callOpenAI(
    [
      { role: "system", content: "You are a database architect embedded in a schema editor. Return ONLY valid JSON." },
      { role: "user", content: prompt },
    ],
    { useJson: true, usageSink }
  );
  return JSON.parse(text.trim());
}

function workbenchContext(entities: any, screens: any[] | null | undefined, validationRules: string | null | undefined): string {
  const parts: string[] = [];
  if (entities && entities.tables && entities.tables.length) {
    parts.push(`Current database schema:\n${JSON.stringify(entities, null, 2)}`);
  } else {
    parts.push("Current database schema: none yet.");
  }
  if (screens && screens.length) {
    const screenLines = screens.map((s) => `- ${s.name || ""}: ${s.description || ""}`).join("\n");
    parts.push(`Current screens:\n${screenLines}`);
  } else {
    parts.push("Current screens: none yet.");
  }
  parts.push(validationRules ? `Current validation rules:\n${validationRules}` : "Current validation rules: none yet.");
  return parts.join("\n\n");
}

export async function interpretRequirement(
  requirement: string,
  entities: any,
  screens: any[] | null | undefined,
  validationRules: string | null | undefined,
  usageSink?: UsageEntry[]
): Promise<any> {
  const context = workbenchContext(entities, screens, validationRules);
  const userMessage = `<current_project_state>\n${context}\n</current_project_state>\n\n<new_requirement>\n${requirement}\n</new_requirement>`;
  const text = await callOpenAI(
    [
      { role: "system", content: ARCHITECT_WORKBENCH_PROMPT },
      { role: "user", content: userMessage },
    ],
    { useJson: true, timeout: 90, usageSink }
  );
  const data = JSON.parse(text.trim());
  const changes = data.changes || {};
  data.changes = {
    db_schema_changes: changes.db_schema_changes || [],
    table_catalog: changes.table_catalog || [],
    ui_screens: changes.ui_screens || [],
    business_rules: changes.business_rules || [],
  };
  data.entities = data.entities || entities || { tables: [] };
  data.screens = data.screens || screens || [];
  data.validation_rules = data.validation_rules || validationRules || "";
  data.summary = data.summary || "Updated project";
  data.summary_detail = data.summary_detail || "";
  data.suggestions = data.suggestions || [];
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — remaining routes for full parity: per-table entity code
// (extract's validation_code side effect), validation-rule chat edits,
// screen-intent detection, chat-based XML refinement, and the
// text-template -> XML -> HTML preview flow (ScreenGenerator.jsx).
// ─────────────────────────────────────────────────────────────────────────

const ENTITY_PROMPT = (language: string, entities: string) => `You MUST generate SEPARATE files for each entity. Each file MUST start with exactly this separator on its own line:

=== FILENAME: filename.ext ===

You MUST generate one separate file per database table, plus an __init__ file.

Target Language: ${language}

Database Schema:
${entities}

Example output format (you MUST follow this exact structure):

=== FILENAME: __init__.py ===
from .student import Student
from .parent import Parent

=== FILENAME: student.py ===
from dataclasses import dataclass

@dataclass
class Student:
    id: int
    name: str

=== FILENAME: parent.py ===
from dataclasses import dataclass

@dataclass
class Parent:
    id: int
    name: str

Rules:
- ONE file per entity/table - NEVER put multiple classes in one file
- Python: use dataclasses with type hints and a validate() method
- Java: use separate .java files with POJOs
- JavaScript/TypeScript: use separate .js/.ts files with classes
- Include field validation in each entity class
- The separator line === FILENAME: xxx === MUST appear before every file

Return ONLY code with === FILENAME: === separators. No explanations. No markdown.`;

const VALIDATION_EDIT_PROMPT = (language: string, entities: string, existingCode: string, instruction: string) => `You are a code generator. You have existing code files and a new instruction from the user. Edit the existing files or create new files as needed.

Target Language: ${language}

Database Schema:
<current_schema>
${entities}
</current_schema>

Existing Code:
<existing_code>
${existingCode}
</existing_code>

User Instruction:
<user_instruction>
${instruction}
</user_instruction>

IMPORTANT RULES:
1. Separate each file with: === FILENAME: filename.ext ===
2. If the instruction affects an existing file, output the FULL updated version of that file
3. If the instruction requires a new file, create it
4. Include ALL existing files in output (even unchanged ones) so nothing is lost
5. Add/edit validation logic, business rules, or new code as requested

Return ONLY the code with file separators, no explanations or markdown fences.`;

const SCREEN_INTENT_PROMPT = (description: string) => `You are a UI/UX architect analyzing a screen request. The description below may name ONE
specific screen, may already read as MULTIPLE distinct screens (e.g. "one screen for X, another screen for Y",
"also add a screen to...", a list of separate unrelated forms/pages), or may describe a broader feature/application
as a whole (e.g. "build a personal finance app with expense tracking, budgets, goals, and reports") without
enumerating screens at all.

Description:
<screen_request>
${description}
</screen_request>

Think about what's actually being asked, not just literal phrasing:
- If it clearly names or describes one specific screen, return exactly that one entry — do not pad it out with
  extra screens it didn't ask for.
- If it already reads as an explicit list of screens, split it into one entry per screen.
- If it describes a broader feature or application rather than one screen, infer the FULL set of screens a
  complete, working implementation of that domain would reasonably need — e.g. a personal finance app isn't one
  "Finance" screen, it's an Expense Entry/List screen, a Budget Planner screen, a Goals screen, a Reports screen,
  etc., each a real screen with its own purpose. Don't under-scope just because the request was short or generic.
- When you infer 3 or more screens this way, ALSO append one final landing/dashboard screen (name it "Dashboard"
  unless a better module-specific name fits) whose description says it's a navigation hub routing to the other
  screens by name — and it MUST be the LAST entry in "screens" when present, since the caller treats the last
  entry specially. Do not add a dashboard screen for a single screen or an explicit short list — only when you
  yourself inferred a broader multi-screen set.

Return ONLY valid JSON in this exact format:
{
  "screens": [
    {"name": "Short Screen Name", "description": "Self-contained description of what THIS screen alone should contain — rewritten so it makes sense without referencing the other screens."}
  ],
  "unresolved": [ ...see shape below, [] when nothing is ambiguous... ]
}

If it's genuinely unclear how to split the app into screens in a way that would change the result (e.g. "reports"
could reasonably be one screen or several, and the description gives no hint which) — do not silently guess.
Instead add an entry to "unresolved" and still fill in your best-effort screen list around it so nothing is
blocked on the question:
  {"unresolved": [{"blocking": true|false, "question": "what's unclear and why it matters"}]}
- blocking:true = you had to guess at something that could produce the wrong screen set.
- blocking:false = a minor assumption worth flagging but not worth stopping for.
- Only use this for real ambiguity — most requests are clear enough that "unresolved" stays empty.

Rules:
- Keep each "name" short (2-5 words), Title Case
- Each "description" must stand alone and preserve every relevant detail from the original text for that screen — do not drop information, just split it correctly
- Return ONLY the JSON, no explanations or markdown fences`;

const REFINE_UI_XML_PROMPT = (xml: string, instruction: string) => `You are a UI/UX architect. You are given an existing XML UI definition for a screen and a
follow-up change request from the user. Apply ONLY the requested change — keep every other element, attribute,
and sample row exactly as it already is unless the change necessarily affects it.

This XML format supports ONLY the following element/attribute vocabulary — the same rules the screen was
originally generated under. Express the requested change using these constructs; never introduce a new
element or attribute name, even if the request seems to call for one:

${UI_XML_VOCABULARY_RULES}

Existing XML UI Definition:
<existing_xml>
${xml}
</existing_xml>

Change request:
<change_request>
${instruction}
</change_request>

Return ONLY valid JSON in this exact shape (no markdown fences) — the "xml" value is the complete
updated XML as a single string (the whole screen, not a diff or fragment; escape it properly as a
JSON string):
{
  "xml": "the complete updated XML",
  "summary": "One or two plain-language sentences describing exactly what changed, written as if replying in a chat — e.g. \\"Added a status filter to the grid and made the email field required.\\" Be specific about field/column names, not generic (\\"Applied your change\\" is not acceptable)."
}`;

// Defensively strips a leading ```lang / trailing ``` if the model wrapped its output in a
// markdown code fence despite being told not to.
function stripMarkdownFence(text: string): string {
  const stripped = text.trim();
  const m = stripped.match(/^```[a-zA-Z]*\n([\s\S]*)\n```\s*$/);
  return m ? m[1] : text;
}

const FILE_EXT: Record<string, string> = { Python: "py", Java: "java", JavaScript: "js", TypeScript: "ts", "C#": "cs", Go: "go", Ruby: "rb", PHP: "php" };

function ensureFileSplits(code: string, language: string): string {
  if (code.includes("=== FILENAME:")) return code;
  const ext = FILE_EXT[language] || "py";

  let splitRe: RegExp;
  if (language === "Python") splitRe = /(?=^@dataclass\s*\nclass\s|^class\s)/m;
  else if (language === "Java") splitRe = /(?=^public\s+class\s)/m;
  else splitRe = /(?=^class\s|^export\s+class\s|^export\s+interface\s)/m;

  const parts = code.split(splitRe);
  if (parts.length <= 1) return `=== FILENAME: entities.${ext} ===\n${code}`;

  const imports = parts[0].trim();
  const files: string[] = [];
  for (const raw of parts.slice(1)) {
    const part = raw.trim();
    if (!part) continue;
    const match = part.match(/class\s+(\w+)/);
    const name = match ? match[1].toLowerCase() : `file${files.length}`;
    const full = imports ? `${imports}\n\n${part}` : part;
    files.push(`=== FILENAME: ${name}.${ext} ===\n${full}`);
  }

  if (imports) {
    const lines: string[] = [];
    for (const p of parts.slice(1)) {
      const m = p.match(/class (\w+)/);
      if (m) lines.push(`from .${m[1].toLowerCase()} import ${m[1]}`);
    }
    files.unshift(`=== FILENAME: __init__.${ext} ===\n${lines.join("\n")}`);
  }

  return files.join("\n\n");
}

export async function generateEntityCode(entities: any, language: string, usageSink?: UsageEntry[]): Promise<string> {
  const prompt = ENTITY_PROMPT(language, JSON.stringify(entities, null, 2));
  const code = await callOpenAI(
    [
      { role: "system", content: "You generate code split into separate files. Every file MUST be preceded by a line: === FILENAME: name.ext === on its own line. Never combine multiple classes in one file." },
      { role: "user", content: prompt },
    ],
    { usageSink }
  );
  return ensureFileSplits(code, language);
}

export async function editValidationCode(
  instruction: string,
  existingCode: string,
  entities: any,
  language: string,
  usageSink?: UsageEntry[]
): Promise<string> {
  const prompt = VALIDATION_EDIT_PROMPT(language, entities ? JSON.stringify(entities, null, 2) : "No schema defined yet", existingCode, instruction);
  const code = await callOpenAI(
    [
      { role: "system", content: "You edit existing code files and create new ones. Every file MUST be preceded by: === FILENAME: name.ext === on its own line. Output ALL files including unchanged ones. Never combine multiple classes in one file." },
      { role: "user", content: prompt },
    ],
    { usageSink }
  );
  return ensureFileSplits(code, language);
}

export async function detectScreenIntents(description: string, usageSink?: UsageEntry[]): Promise<any> {
  const prompt = SCREEN_INTENT_PROMPT(description);
  const text = await callOpenAI(
    [
      { role: "system", content: "You are a UI/UX architect. Return ONLY valid JSON." },
      { role: "user", content: prompt },
    ],
    { useJson: true, usageSink }
  );
  const data = JSON.parse(text.trim());
  if (!data.screens || !data.screens.length) {
    data.screens = [{ name: description.slice(0, 40).trim(), description }];
  }
  data.unresolved = data.unresolved || [];
  return data;
}

export async function refineUiXml(xml: string, instruction: string, usageSink?: UsageEntry[]): Promise<any> {
  const prompt = REFINE_UI_XML_PROMPT(xml, instruction);
  const text = await callOpenAI(
    [
      { role: "system", content: "You are a UI/UX architect. Return ONLY valid JSON." },
      { role: "user", content: prompt },
    ],
    { useJson: true, usageSink }
  );
  return JSON.parse(text.trim());
}

const XML_TO_HTML_PROMPT = (
  xml: string,
  frontendLang: string,
  extraInstructionsSection: string,
  projectThemeSection: string,
  imageReferenceSection: string
) => `You are a senior frontend developer. Convert this XML UI definition into production-ready code for the specified frontend framework.

Frontend Framework: ${frontendLang}

FRAMEWORK OUTPUT RULES — follow exactly based on the framework:

• HTML/CSS → generate a complete self-contained <!DOCTYPE html> page with all CSS and JS inline.
• React → generate a single .jsx file: one default-exported functional component with useState/useEffect hooks. Import nothing external — use inline styles. At the top add these CDN script tags so it previews in an iframe:
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  Wrap the component in a full HTML page with <script type="text/babel"> so it renders live.
• Vue → generate a complete HTML page using Vue 3 CDN (https://unpkg.com/vue@3/dist/vue.global.js). Use Composition API (setup()). All CSS inline.
• Angular → generate a complete TypeScript component file (.component.ts) with the @Component decorator, template, and styles inline. Also include a brief index.html showing how to bootstrap it. No external imports needed — note it requires Angular CLI.
• Next.js → generate a complete page file (pages/screen.jsx or app/page.jsx) using Next.js conventions. Use React hooks. Include getServerSideProps if data fetching is needed.
• Svelte → generate a complete .svelte single-file component with <script>, <style>, and template sections.
• Flutter → generate a complete Dart widget class (StatefulWidget) with all form fields, table, and buttons mapped.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES — NEVER VIOLATE THESE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- NEVER render radio buttons or checkboxes as section/panel icons or decorative elements.
- NEVER add section icons that look like radio buttons. Panel titles are plain text only.
- NEVER add buttons not present in the XML toolbar.
- ID/code columns in grids MUST be rendered as clickable links/hyperlinks, styled \`color: var(--clr-primary); text-decoration: none;\` (underline on hover) via a real CSS rule — never left to default browser link-blue, and never a hardcoded hex.
- Grids are ALWAYS read-only (no inline editing).
- Every grid column marked sortable="true" MUST have a clickable sort header with ↑↓ arrows.
- The page must include a one-line purpose statement pulled from the XML purpose attribute, shown in muted text directly below the page title.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVERY INTERACTIVE ELEMENT MUST ACTUALLY WORK — this is a real preview, not a static mockup.
There is no live backend behind it, so "working" means driven by real vanilla JS against the
<sampleData> rows embedded in the XML (plus a small in-memory array for lookups if the target
entity isn't the grid's own). A button, filter, or control that's present but visually inert is
a bug. Concretely, in plain HTML/CSS/vanilla JS (no framework, no build step):
- type="lookup" fields: the button click MUST open a real inline dropdown/panel listing rows
  from the relevant sample data, filterable as the user types, and selecting a row MUST populate
  that field plus every field with autoFill="from:thisFieldId" — with actual JS, not a no-op.
- Grid search input MUST live-filter the visible rows as the user types (real keyup/input handler).
- Sort headers MUST actually re-order the visible rows on click, not just show static arrows.
- Refresh MUST reset the grid back to the full, unfiltered sample dataset.
- Export-csv MUST actually trigger a client-side CSV download (Blob + temporary <a download>) of
  the currently visible rows.
- Pagination controls, if pageSize is set, MUST actually page through the sample rows.
- Every form MUST have a Save button AND a Cancel button, whether or not the XML toolbar lists
  them — these two are never optional. Every form/bottom-toolbar button (save, cancel, clear,
  delete, ...) MUST have a real onclick handler: since there's no backend, simulate the effect
  against local state (e.g. clear/cancel empties the form, delete removes/greys the row and shows
  a brief confirmation, save shows a success message) — never leave a button with no handler at all.
- select/dropdown fields with dataSource MUST be populated with real <option> entries derived from
  that entity's sample rows, not left empty.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CROSS-SCREEN DATA SYNC (REQUIRED) — this preview does not run alone. Other screens generated for
this same project may be previewing the SAME entities, and edits made in one screen's preview must
be visible in another screen's preview when the user switches between them — like a real app backed
by one shared database, not isolated fake data per screen. This works via postMessage with the
parent page. Add this exact pattern, adapted to your actual variable/function names:

1. Work out entity names from the XML: PRIMARY_ENTITY = the <metadata><entity> value. Also collect
   every distinct dataSource="X" and lookupEntity="X" value used anywhere in the XML as LOOKUP
   entities (reference data this screen reads but doesn't primarily own).

2. On page load, request current shared data and listen for it:
   const PRIMARY_ENTITY = "Student"; // replace with the real entity name from <metadata><entity>
   const LOOKUP_ENTITIES = ["Course"]; // replace with real dataSource/lookupEntity values found, [] if none
   window.addEventListener('message', function(event) {
     if (!event.data || event.data.type !== 'TDIDE_INIT_DATA') return;
     const shared = event.data.data || {};
     if (shared[PRIMARY_ENTITY]) {
       sampleData.length = 0;
       sampleData.push.apply(sampleData, shared[PRIMARY_ENTITY]);
     }
     LOOKUP_ENTITIES.forEach(function(name) {
       if (shared[name]) { /* use shared[name] to populate that entity's dropdown/lookup options instead of the hardcoded ones */ }
     });
     renderTable(); // call whatever this screen's own render/refresh function is actually named
   });
   window.parent.postMessage({ type: 'TDIDE_READY', entities: [PRIMARY_ENTITY].concat(LOOKUP_ENTITIES) }, '*');
   (If no reply arrives — this screen opened standalone — the page just keeps its own generated
   sample data as a starting point, so it still works fine on its own.)

3. After EVERY successful create/update/delete of a PRIMARY_ENTITY row (save button, delete
   confirm, etc.) — right after you update the local sampleData/dataStore array and re-render —
   also broadcast the change so other screens pick it up:
   window.parent.postMessage({ type: 'TDIDE_DATA_CHANGE', entity: PRIMARY_ENTITY, rows: sampleData }, '*');
   Only ever broadcast PRIMARY_ENTITY changes (what this screen actually owns/edits) — never
   broadcast a LOOKUP_ENTITY as if this screen edited it, since it's only reading that data here.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VISUAL IDENTITY — pick ONE archetype below that best fits this APPLICATION's overall domain (read the
project/module context, not just this one screen's title in isolation), then commit to it fully (color
family AND typography AND corner roundedness AND shadow depth all come from the same archetype — don't
mix them). This decision represents the whole application's visual identity, not just one page — every
screen belonging to the same application should land on the SAME archetype and the SAME exact hex shades,
not a different one per screen. (If a PROJECT THEME override appears later in this prompt, it takes full
precedence over everything in this section — that means a theme was already established by an earlier
screen in this app and must be reused exactly, not re-derived.)

The hex codes below are only illustrative of each hue FAMILY, not fixed values — pick your own specific
shade within that family. Commit to a confident, specific, premium-feeling shade the way real enterprise
products do (Stripe, Linear, Salesforce, Notion) — never a flat, washed-out, low-saturation, or generic
"default blue" choice; a dumb/average-looking palette is a failure here, not a safe choice.

1. MODERN SAAS — general business tools, dashboards, internal tools: primary hue somewhere in the indigo/violet family, roughly #4F46E5-#8B5CF6-#6D28D9; font 'Inter', system-ui; card radius 10-12px; soft diffused shadows (0 1px 3px rgba(0,0,0,0.08)); spacious padding.
2. ENTERPRISE CONSOLE — ERP, ops, admin, procurement, logistics: primary hue somewhere in the steel-blue/slate family, roughly #1E3A5F-#334155-#0F4C75; font 'Roboto', 'Segoe UI', system-ui; sharper card radius 4-6px; flatter/tighter shadows; denser padding.
3. CLINICAL — healthcare, patient records, labs, clinics: primary hue somewhere in the teal/cyan family, roughly #0D9488-#0891B2-#0E7490; font 'Inter', 'Source Sans Pro'; card radius 8px; crisp light shadows; high contrast, generous whitespace.
4. FINTECH PRECISION — banking, accounting, billing, payments, audits: primary hue somewhere in the deep emerald/navy family, roughly #065F46-#14532D-#1E3A5F; font 'IBM Plex Sans', 'Inter'; card radius 6px; monospace for all currency/numeric values; tight, precise spacing.
5. WARM CONSUMER — hospitality, booking, retail, food, community, anything customer-facing and friendly: primary hue somewhere in the coral/amber/warm-orange family, roughly #F97316-#EA580C-#DC2626-#D97706; font 'Poppins', 'Nunito', system-ui; rounder card radius 14-16px; soft warm shadows; generous friendly spacing.
6. EDITORIAL BOLD — creative, media, marketing, content/portfolio tools: primary hue somewhere in the deep purple/magenta family, roughly #7C3AED-#A21CAF-#BE185D; font 'Poppins', 'Manrope'; card radius 12px; bold high-contrast headers; slightly asymmetric shadow depth.

If colors ARE specified in the XML, use those exact color values for --clr-primary and derive the rest of the palette from them, but still pick the archetype's typography/radius/shadow personality that best matches the domain.

Also pick --clr-secondary: a second accent hue, analogous or complementary to --clr-primary —
NOT just a darker/lighter shade of it, a genuinely different hue (e.g. primary indigo + secondary
teal, or primary emerald + secondary amber) — so the page reads as a deliberate two-tone palette,
not one hue used everywhere. Use it for the header/nav band and any secondary badges, highlighted
counts, or secondary-emphasis accents.

Derive EVERY other color from --clr-primary and --clr-secondary — nothing below is a fixed value:
- --clr-bg: a very light, barely-tinted neutral leaning toward --clr-primary's hue (NOT a fixed gray — e.g. a warm archetype gets a warm-tinted off-white, a cool archetype gets a cool-tinted off-white)
- --clr-header-bg: a dark, deeply saturated shade of --clr-secondary (not primary) — this is what makes the header read as the second color in the palette rather than a repeat of the primary
- --clr-surface, --clr-border, --clr-text, --clr-muted: neutral tones consistent with the chosen hue family's temperature (warm hues get warm-leaning neutrals, cool hues get cool-leaning neutrals)
- --clr-danger stays a clear red regardless of archetype, for universal recognizability

Define the full palette and chosen typography/radius as CSS custom properties so the rest of the page can reference them consistently:
--clr-primary, --clr-primary-dark, --clr-primary-light, --clr-secondary, --clr-secondary-dark, --clr-danger, --clr-border, --clr-bg, --clr-surface, --clr-text, --clr-muted, --clr-header-bg, --font-family, --radius-card

EVERY downstream CSS rule — backgrounds, borders, focus/hover glows, shadows tinted with the primary hue, link colors — MUST reference these custom properties (var(--clr-primary), rgba equivalents built from them, etc), never repeat a literal hex/rgb value that duplicates one of the above. This page's colors need to stay changeable later by swapping only the :root values, so a hardcoded color anywhere outside :root is a bug.

POLISH — avoid a bare/generic look. Within the archetype you picked, add tasteful touches that make this feel like a real, distinct product rather than a wireframe:
- Header band: a subtle gradient from --clr-header-bg to a slightly darker or lighter tone of the same hue (pick the direction), not a flat single color
- A small icon or monogram mark next to the module name in the header, colored to match the palette
- Buttons and the active sort arrow get a brief hover/transition treatment consistent with the archetype's personality (crisp and fast for Enterprise Console, slightly softer/springier for Warm Consumer, etc.)
- Card header bars may carry a thin 3px left accent border in --clr-primary instead of being perfectly flat, if it fits the archetype
These are additive polish only — they must never violate the STRICT RULES above (no radio buttons, no extra buttons, grids stay read-only, etc.).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYOUT DENSITY — pick ONE, independent of the color/type archetype above
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• CLEAN (default — use this for almost everything: master/detail CRUD, bookings, reservations, catalogs, small-to-medium business tools, anything a single business or small team uses day to day). This is what well-regarded modern products look like: calm, generous whitespace, soft cards, a simple light top nav instead of a heavy dark header band. Pick this unless you have a specific reason not to.

• DENSE (rare — only when the domain explicitly signals large-scale, multi-department, power-user ops/admin tooling used all day by trained staff: an ERP procurement console, a call-center queue manager, a logistics dispatch board, a compliance audit workbench). This is the classic full-bleed enterprise console style (SAP, Oracle, Salesforce) with a dark header band and a sticky action toolbar.

Default to CLEAN. Most screens — including anything booking/reservation/catalog/registration-shaped — are CLEAN, not DENSE.

──────────────────────────────
IF CLEAN:
──────────────────────────────
1. TOP NAV BAR — white background, thin 1px bottom border in var(--clr-border), NOT a dark full-bleed band. Left: app/module name, 18-20px bold var(--clr-text). If this screen is naturally one of several sibling sections, show them as simple horizontal text tab-links to the right; the active one gets a light pill background in a faint tint of --clr-primary. Padding 16px 32px.

2. PAGE HEADING — margin-top 32-40px below the nav. Title 28-32px bold var(--clr-text). Purpose line directly below: 14-15px var(--clr-muted), not italic.

3. CONTENT WIDTH — comfortable reading width: either a max-width of roughly 900-1100px with breathing-room margin around it, or full width with generous 40-60px side padding. Never an edge-to-edge dense table with tiny margins.

4. FORM CARD — white, border-radius var(--radius-card), border 1px solid var(--clr-border), subtle shadow (0 1px 3px rgba(0,0,0,0.06)), padding 24-28px, margin-top 24px.
   - Card title: bold 15-16px plain text sitting in the card body — no separate header-bar background
   - Fields stacked VERTICALLY (label above input, full width) with 16-20px gaps — do NOT use a two-column label-left layout, it reads dense/enterprise
   - Label: 13-14px font-weight 600 var(--clr-text), margin-bottom 6px; required asterisk in var(--clr-danger)
   - Input: full width, border 1px solid var(--clr-border), border-radius 8px, padding 10px 14px, font-size 14px, placeholder shows a realistic example value
   - Focus: border-color var(--clr-primary), subtle glow shadow
   - The primary action button ("Add X" / "Save") sits directly below the fields, INSIDE the card, left-aligned, normal size (padding 10px 20px) — NOT a page-level sticky bottom toolbar
   - A Cancel button sits directly beside Save (ghost/secondary style, same size) — every form gets both, regardless of what the XML toolbar lists

5. LIST CARD — separate white card below the form card, same soft style, margin-top 20px.
   - Header row inside the card: bold 14-15px title + a count pill styled with var(--clr-secondary) (light tint background, --clr-secondary text) — this is what makes --clr-secondary visible on CLEAN screens too, not just the DENSE header band
   - Body: a clean simple table — light/no-fill header row, generous 12-14px vertical row padding, subtle 1px row dividers, comfortable 14px font
   - ID/code column values are still clickable links in var(--clr-primary); sortable columns still show ↑↓ arrows; a simple inline search input in the card header — no heavy toolbar bar
   - Empty state: centered muted italic text, generous vertical padding

6. No dark header band. No fixed/sticky bottom toolbar — actions live inside their own card. No more than 2-3 cards stacked with generous gaps. This should read calm and uncluttered, not dense.

──────────────────────────────
IF DENSE (only when deliberately chosen above):
──────────────────────────────
CRITICAL: full width — do NOT use max-width containers, do NOT center content. Fill the entire browser window like enterprise software (SAP, Oracle, Salesforce). Think 1440px monitor, not mobile.

1. PAGE WRAPPER — background var(--clr-bg); min-height 100vh; width 100%; font-family var(--font-family); NO max-width/centering; padding 0 0 80px 0 (bottom clearance for the sticky toolbar).

2. TOP HEADER BAND (full-width) — background var(--clr-header-bg) (the dark saturated shade of --clr-primary you derived above); padding 20px 40px. Module name 11px uppercase letter-spacing 0.1em rgba(255,255,255,0.55); page title 24px/700 white; purpose line 13px italic rgba(255,255,255,0.5).

3. FORM CARD (white, border-radius var(--radius-card), shadow matching the archetype's depth, border 1px solid var(--clr-border), margin 24px 40px 0)
   - Card header bar: background #F8FAFC, padding 12px 20px, border-bottom 1px solid var(--clr-border); title only, plain bold 14px
   - Card body padding 24px 28px; fields in a two-column label+input layout: label column 160px, 13px/500 #374151; input flex:1, border 1.5px var(--clr-border), radius 6px, padding 8px 12px
   - Fieldset: <fieldset> + <legend> uppercase 10.5px letter-spacing 0.08em #9CA3AF

4. LIST/GRID CARD (same card style, margin 20px 40px 0)
   - Header: bold 14px title + count pill styled with var(--clr-secondary) (light tint background, --clr-secondary text); search input + "Export CSV" ghost button on the right
   - Table fills edge to edge: sticky #F8FAFC thead, uppercase 11px/600 #6B7280 th, sortable columns show ↑↓ arrows, td padding 10px 16px, ID column renders as a monospace link, zebra rows, row hover #EEF4FF
   - Pagination row: "Showing X to Y of Z entries" + page pills

5. STICKY BOTTOM ACTION TOOLBAR — position fixed bottom 0, white bg, top border, shadow; buttons padding 8px 20px/600/radius 6px. Save = primary bg white text + <kbd>Ctrl+S</kbd> pill; Clear = white/bordered; Delete = #DC2626; Cancel = margin-left auto, transparent. Save and Cancel are ALWAYS rendered, on every form, whether or not the XML toolbar lists them — every other button (Clear, Delete, ...) still only renders if the XML toolbar lists it.

──────────────────────────────
FIELD TYPE RENDERING RULES (apply regardless of density):
──────────────────────────────
- type="select" → render as <select> dropdown with realistic sample <option> values from sampleData or inferred from domain. NEVER render as <input type="text">.
- type="lookup" → render as a row with: text <input> (flex:1) + adjacent "🔍 Lookup" button. Default style (only if not overridden by an additional instruction below): background var(--clr-primary), color white, border-radius 6px, padding 8px 14px, no border, cursor pointer, margin-left 8px.
  Clicking it MUST show an absolutely-positioned panel directly under the input, listing REAL rows
  from that entity's sample data (reuse the grid's sampleData if it's the same entity, otherwise
  invent 5-8 realistic rows for the lookupEntity), each row clickable. A non-functional stub
  (alert(), or hardcoding one fixed "selected" value instead of letting the user pick from a list)
  is WRONG. Concrete pattern to follow, adapted to the real field/entity names:
    <div class="lookup-panel" id="lookupPanel_paperCode" style="display:none;position:absolute;background:white;border:1px solid var(--clr-border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.12);max-height:220px;overflow-y:auto;z-index:20;width:320px;">
      <input type="text" placeholder="Filter..." oninput="filterLookup_paperCode(this.value)" style="width:100%;padding:8px;border:none;border-bottom:1px solid var(--clr-border);">
      <div id="lookupList_paperCode"></div>
    </div>
    <script>
      const lookupData_paperCode = [ /* 5-8 real sample objects with every field this lookup needs to auto-fill, e.g. {code:'P101', name:'Data Structures'} */ ];
      function renderLookupList_paperCode(rows) {
        document.getElementById('lookupList_paperCode').innerHTML = rows.map(r =>
          \`<div style="padding:8px 12px;cursor:pointer;" onmouseover="this.style.background='var(--clr-bg)'" onmouseout="this.style.background=''" onclick="selectLookup_paperCode('\${r.code}')">\${r.code} — \${r.name}</div>\`
        ).join('');
      }
      function filterLookup_paperCode(q) { renderLookupList_paperCode(lookupData_paperCode.filter(r => r.code.includes(q) || r.name.toLowerCase().includes(q.toLowerCase()))); }
      function selectLookup_paperCode(code) {
        const row = lookupData_paperCode.find(r => r.code === code);
        document.getElementById('paperCode').value = row.code;
        document.getElementById('paperName').value = row.name; // populate every autoFill target the same way
        document.getElementById('lookupPanel_paperCode').style.display = 'none';
      }
      document.getElementById('lookupBtn_paperCode').addEventListener('click', () => {
        const panel = document.getElementById('lookupPanel_paperCode');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        renderLookupList_paperCode(lookupData_paperCode);
      });
    </script>
  Follow this exact shape (panel + filter input + clickable rows + select handler that populates
  every autoFill target) for every lookup field, with names adapted to that field's real id.
- readonly="true" → render as <input disabled> with background #F1F5F9, color #6B7280, cursor not-allowed. Label shows "(auto)" in muted text.
- autoFill fields → add JS so selecting/entering the source field updates the readonly target field with a realistic value.
- formula fields → add a real JS function that evaluates the formula attribute's expression using the CURRENT
  values of its input fields (parse numbers with parseFloat, treat blank/NaN inputs as 0), and writes the
  result into the readonly formula field. Attach this recalculation to the input/change event of every field
  the formula references, so it updates live as the user types — never a static/hardcoded value.

──────────────────────────────
<navigation> RENDERING (landing/hub screens only — replaces the form+grid layout entirely):
──────────────────────────────
- Render as a responsive card grid below the header (CSS grid, minmax(240px, 1fr), gap 20px, padding matching the archetype).
- One card per <navItem>: white card, border-radius var(--radius-card), border 1px solid var(--clr-border), padding 24px, cursor pointer, hover lifts slightly (translateY(-2px) + deeper shadow, transition 0.15s).
- Each card shows: a small colored icon badge derived from the item's icon keyword (a 40px circle tinted with --clr-primary, first letter or a simple glyph — no external icon library), the navItem's label as 15px/600 title, its description as 13px muted text below.
- This is a PREVIEW with no real router behind it, so clicking a card MUST still do something real and visible: show a toast reading exactly \`Navigate to: {targetScreen}\` (reuse the toast pattern from the SHARED section below) — never a dead card with no handler.
- Do NOT render a form, grid, or bottom action toolbar on a screen that has a <navigation> element — it replaces them, it doesn't sit alongside them.

──────────────────────────────
<auth> RENDERING (sign up / log in screens only — replaces the form+grid+toolbar layout entirely):
──────────────────────────────
- ONE centered card (max-width ~400px, margin auto, vertical-centered on the page), archetype-matched
  styling (border-radius var(--radius-card), shadow, colors) — no page header/nav band, no sidebar.
- A Sign Up / Log In toggle at the top of the card: two tab-style labels, or a single form with a
  link below it ("Already have an account? Log in" / "Don't have an account? Sign up") that swaps
  which field set (<signup> or <login>) is shown. Only one mode's fields are visible at a time.
- Password fields render as real <input type="password"> (masked) — never plain text.
- Signup mode: client-side JS MUST check password === confirmPassword on submit and show an inline
  error ("Passwords don't match") if they differ, before allowing the simulated submit to proceed.
- Primary submit button label matches the mode: "Sign Up" for signup, "Log In" for login — never
  "Save". No Cancel/Clear/Delete buttons on an auth screen.
- There is no live backend behind this preview (same as every other screen) — simulate success on
  submit: show a success toast ("Account created!" / "Logged in!") and, since there's nothing to
  navigate to yet in the preview, just re-render the card in a simple "logged in as {email}" state
  with a "Log out" link that returns to the login form. Do not fabricate a fake token or persist
  anything — this is a visual simulation only, exactly like every other screen's fake local CRUD.
- Never render a <grid>, sample user rows, or any list of other accounts on this screen.

──────────────────────────────
SHARED (both densities):
──────────────────────────────
6. CONFIRMATION MODAL (for delete)
   - Overlay: position fixed inset 0 background rgba(15,23,42,0.45) display none
   - Dialog: background white border-radius 12px max-width 380px margin auto mt 20vh padding 28px box-shadow 0 20px 60px rgba(0,0,0,0.2)
   - Title 18px bold, body text 14px muted, buttons row: Cancel (ghost) + Confirm Delete (danger)

7. TOAST NOTIFICATION
   - Fixed bottom-right: bottom 24px right 24px (use bottom 90px if DENSE, to clear the sticky toolbar)
   - background #1E293B color white padding 12px 18px border-radius 8px font-size 13px
   - Success variant: background #15803D
   - Hidden by default; shown for 3 seconds then auto-dismiss

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
JAVASCRIPT/FRAMEWORK BEHAVIOUR:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Form validation on submit: check required, maxLength, pattern; show inline error messages
- Blur validation: validate each field when user leaves it
- Grid sorting: clicking a column header sorts the data by that column, toggles asc/desc
- Grid search: typing filters rows in real-time across all columns; count badge updates. Keep ONE
  master data array (the same one Save/Delete/TDIDE_INIT_DATA mutate) and derive the filtered view
  from it on every keystroke WITHOUT reassigning/overwriting the master array — e.g. \`renderTable(
  masterData.filter(...))\` passing the filtered list straight into the render function, never
  \`masterData = masterData.filter(...)\` or filtering from a separate original/seed array. Search
  must never be the thing that discards a saved row or data loaded from TDIDE_INIT_DATA.
- Pagination: slice data per page; clicking page number re-renders rows
- Ctrl+S keyboard shortcut triggers save (where applicable in framework)
- Delete button opens confirmation modal; confirm triggers delete logic + shows toast
- Clear button resets all form fields
- Cancel button resets all form fields AND exits edit mode if a row was selected for editing
  (deselect it, so the form returns to its "add new" state) — same field-reset as Clear, plus
  clearing the edit-target row
- Save button logic MUST actually mutate the underlying data before rendering/broadcasting anything:
  read every form field's current value, then either (a) CREATE — no existing row is selected for
  edit — build a new row object from those values (generate/increment an ID client-side if the PK
  isn't a user-entered field) and push it into the data array, or (b) EDIT — a row is selected —
  find that row in the data array by its ID and overwrite its fields in place. Re-render the grid
  from the updated data array, THEN broadcast TDIDE_DATA_CHANGE with that same updated array. A
  Save handler that only shows a success toast and re-broadcasts the data array unchanged is
  broken — the new/edited row must actually appear in the grid and in the broadcast, not just a
  fake success message.
- Toast shows on save success/failure; auto-dismisses after 3 seconds
- On page load: postMessage {type:'TDIDE_READY', entities:[...]} to window.parent, and if a
  {type:'TDIDE_INIT_DATA'} reply arrives, replace the local sample data with it before first
  render — this is how the screen picks up live data from other screens (exact pattern under
  CROSS-SCREEN DATA SYNC above)
- After every save/delete of the primary entity: postMessage {type:'TDIDE_DATA_CHANGE', entity,
  rows} to window.parent so other screens previewing the same entity see the change too (exact
  pattern under CROSS-SCREEN DATA SYNC above) — do this for every single generation, it is not optional

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL CHECKS before returning:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- You deliberately chose CLEAN or DENSE and applied it consistently — no mixing (e.g. no dark full-bleed header inside an otherwise CLEAN page)
- If CLEAN: no dark header band, no sticky bottom toolbar, form fields stacked vertically, generous whitespace
- No radio buttons anywhere on the page
- All sortable columns have sort arrows
- ID column values are hyperlinks/clickable
- Purpose sentence appears below the title
- Sample data rows are realistic (8-10 rows)
- All XML fields, buttons, and grid columns are mapped
- The CROSS-SCREEN DATA SYNC block is included, verbatim in spirit: the window.addEventListener('message', ...)
  handler, the window.parent.postMessage({type:'TDIDE_READY', ...}) call on load, and a
  window.parent.postMessage({type:'TDIDE_DATA_CHANGE', ...}) call after every save/delete of the primary
  entity. This is not optional — a screen missing it is an incomplete generation.
${extraInstructionsSection}
${projectThemeSection}
${imageReferenceSection}
XML UI Definition:
<xml_ui_definition>
${xml}
</xml_ui_definition>

Return ONLY the complete output file for the chosen framework, with all styles and logic included. No explanations, no markdown fences.`;

const IMAGE_REFERENCE_SECTION = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AN IMAGE IS ATTACHED — THIS OVERRIDES THE DESIGN-SYSTEM RULES ABOVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before writing any code, look closely at the attached image and privately note, specifically:
1. The exact background color, header/sidebar color, primary accent color, and text color you see.
2. The layout skeleton: sidebar or top-nav, column count, where the title/actions/table sit.
3. Corner roundedness, border weight, and shadow style.
Then use those exact observations while writing the code below — do not skip this and jump straight
to a generic layout.

Ignore the archetype/color-derivation system, the CLEAN vs DENSE choice, and every specific
color/spacing/pixel value given earlier in this prompt — none of that applies to this generation.
Instead, look at the attached image and copy what you actually see in it:
- --clr-primary, --clr-bg, --clr-header-bg, and every other color: read the ACTUAL colors visible in
  the image (background, accents, text, borders) and use those literal colors, not a derived palette
  from an archetype. If the image has a bright pink sidebar, the output has a bright pink sidebar —
  do not tone it down or substitute a "safer" color.
- Layout: replicate the image's actual arrangement — sidebar vs top-nav, column count, section order,
  spacing density, border/shadow style — instead of the CLEAN/DENSE templates described above.
- Typography and shape language (rounded vs sharp corners, border weight, etc.): match what's in the
  image.
This is a hard override, not a suggestion to blend with the rules above — when the image and the
earlier design-system instructions disagree, the image wins every time.
The XML is still the source of truth for WHAT controls and data actually exist (fields, grid columns,
buttons) and for all the FUNCTIONAL requirements above (working search/sort/save/etc.) — only the
VISUAL styling and layout come from the image. If the XML requires a field the image doesn't show, add
it styled consistently with the image rather than omitting it.
`;

function buildProjectThemeSection(theme: Record<string, string>): string {
  const lines = Object.entries(theme)
    .filter(([k]) => k !== "density")
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const density = theme.density || "CLEAN";
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROJECT THEME — THIS OVERRIDES THE VISUAL IDENTITY SECTION ABOVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This application already has an established visual identity, committed to by an earlier screen in
this same project. Do NOT pick your own archetype, colors, font, or radius — use EXACTLY these:
${lines}
Also use LAYOUT DENSITY: ${density} — follow that section's structural rules (spacing, card style,
header band, toolbar), but with the colors/font/radius given above instead of anything derived
there. This keeps every screen in the app looking like one consistent product, not a new design
each time. The XML is still the source of truth for WHAT controls/data exist — only the color
palette, typography, radius, and density are fixed by this override.
`;
}

// Deterministically injects the cross-screen data sync script into generated HTML — asking the
// model to write this itself proved unreliable, so this reads/writes the rendered <table>
// generically regardless of what internal JS variable names the model happened to use. Rows are
// keyed by each <column>'s "binding" attribute (the real column name), not rendered header text.
function injectCrossScreenSync(html: string, xml: string): string {
  const entityMatch = xml.match(/<entity>([^<]+)<\/entity>/);
  const entity = entityMatch ? entityMatch[1].trim() : null;
  if (!entity) return html;

  const lookups = [...new Set(Array.from(xml.matchAll(/(?:dataSource|lookupEntity)="([^"]+)"/g)).map((m) => m[1]))]
    .filter((l) => l !== entity)
    .sort();
  const bindings = Array.from(xml.matchAll(/<column\b[^>]*\bbinding="([^"]+)"/g)).map((m) => m[1]);

  const requiredFields: string[] = [];
  for (const m of xml.matchAll(/<field\s+([^>]*)>([\s\S]*?)<\/field>/g)) {
    const [, openAttrs, inner] = m;
    if (openAttrs.includes('readonly="true"')) continue;
    const nameM = openAttrs.match(/name="([^"]+)"/);
    if (nameM && /<rule\b[^>]*\brequired="true"/.test(inner)) requiredFields.push(nameM[1]);
  }

  const readonlyFields = new Set<string>();
  for (const m of xml.matchAll(/<field\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!attrs.includes('readonly="true"')) continue;
    const nameM = attrs.match(/name="([^"]+)"/);
    if (nameM) readonlyFields.add(nameM[1]);
  }

  let navItems = Array.from(xml.matchAll(/<navItem\s+[^>]*\btargetScreen="([^"]+)"[^>]*\blabel="([^"]+)"/g)).map((m) => ({
    targetScreen: m[1],
    label: m[2],
  }));
  if (!navItems.length) {
    navItems = Array.from(xml.matchAll(/<navItem\s+[^>]*\blabel="([^"]+)"[^>]*\btargetScreen="([^"]+)"/g)).map((m) => ({
      targetScreen: m[2],
      label: m[1],
    }));
  }

  const script = `
<!-- TDIDE_SYNC_SCRIPT_START -->
<script>
(function() {
  var TDIDE_ENTITY = ${JSON.stringify(entity)};
  var TDIDE_LOOKUPS = ${JSON.stringify(lookups)};
  var TDIDE_BINDINGS = ${JSON.stringify(bindings)};
  var TDIDE_REQUIRED = ${JSON.stringify(requiredFields)};
  var TDIDE_NAV_ITEMS = ${JSON.stringify(navItems)};
  if (TDIDE_NAV_ITEMS.length) {
    document.addEventListener("click", function(e) {
      var el = e.target;
      for (var depth = 0; el && depth < 6; depth++, el = el.parentElement) {
        var onclickAttr = el.getAttribute && el.getAttribute("onclick");
        for (var i = 0; i < TDIDE_NAV_ITEMS.length; i++) {
          var item = TDIDE_NAV_ITEMS[i];
          var matchesOnclick = onclickAttr && onclickAttr.indexOf(item.targetScreen) !== -1;
          var matchesText = !matchesOnclick && el.children && el.children.length <= 8 &&
            el.textContent && el.textContent.trim().indexOf(item.label) === 0;
          if (matchesOnclick || matchesText) {
            try { window.parent.postMessage({ type: "TDIDE_NAVIGATE", targetScreen: item.targetScreen }, "*"); } catch (err) {}
            return;
          }
        }
      }
    }, true);
  }
  var TDIDE_READONLY = ${JSON.stringify([...readonlyFields].sort())};
  var tdideObserver = null;
  var tdideLastInteraction = 0;
  document.addEventListener("click", function(e) {
    var el = e.target.closest("button, [role='button'], input[type='submit'], input[type='button'], a");
    if (!el) return;
    var text = (el.textContent || el.value || el.id || el.className || "").toLowerCase();
    if (!/save|delete|submit/.test(text)) return;
    tdideLastInteraction = Date.now();
    if (!/save|submit/.test(text)) return;
    var missing = TDIDE_REQUIRED.filter(function(name) {
      var field = document.getElementById(name);
      return field && !field.value;
    });
    if (missing.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      alert("Please fill in required field(s): " + missing.join(", "));
      tdideLastInteraction = 0;
      return;
    }
    var table = tdideFindGrid();
    if (table) {
      var newRow = {};
      TDIDE_BINDINGS.forEach(function(binding) {
        if (TDIDE_READONLY.indexOf(binding) !== -1) return;
        var field = document.getElementById(binding);
        if (field) newRow[binding] = field.value;
      });
      var rows = tdideTableToRows(table).concat([newRow]);
      tdideApplyRows(table, rows);
      try {
        window.parent.postMessage({ type: "TDIDE_DATA_CHANGE", entity: TDIDE_ENTITY, rows: rows }, "*");
      } catch (err) {}
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  function tdideFindGrid() {
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].querySelector("tbody")) return tables[i];
    }
    return null;
  }
  function tdideHeaders(table) {
    var thCount = table.querySelectorAll("thead th").length;
    if (TDIDE_BINDINGS.length === thCount) return TDIDE_BINDINGS.slice();
    var out = [];
    table.querySelectorAll("thead th").forEach(function(th) {
      out.push(th.textContent.replace(/[\\u2191\\u2193\\u25b2\\u25bc]/g, "").trim());
    });
    return out;
  }
  function tdideTableToRows(table) {
    var headers = tdideHeaders(table);
    var rows = [];
    table.querySelectorAll("tbody tr").forEach(function(tr) {
      var obj = {};
      tr.querySelectorAll("td").forEach(function(td, i) { obj[headers[i] || ("col" + i)] = td.textContent.trim(); });
      rows.push(obj);
    });
    return rows;
  }
  function tdideBroadcast() {
    if (Date.now() - tdideLastInteraction > 2000) return;
    var table = tdideFindGrid();
    if (!table) return;
    try {
      window.parent.postMessage({ type: "TDIDE_DATA_CHANGE", entity: TDIDE_ENTITY, rows: tdideTableToRows(table) }, "*");
    } catch (e) {}
  }
  function tdideApplyRows(table, rows) {
    var headers = tdideHeaders(table);
    var tbody = table.querySelector("tbody");
    if (!tbody || !rows) return;
    if (tdideObserver) tdideObserver.disconnect();
    var out = "";
    rows.forEach(function(row) {
      out += "<tr>";
      headers.forEach(function(h) {
        var v = row[h];
        out += "<td>" + (v != null ? String(v).replace(/</g, "&lt;") : "") + "</td>";
      });
      out += "</tr>";
    });
    tbody.innerHTML = out;
    if (tdideObserver) tdideObserver.observe(tbody, { childList: true, subtree: true, characterData: true });
  }

  window.addEventListener("message", function(event) {
    var msg = event.data;
    if (!msg || msg.type !== "TDIDE_INIT_DATA") return;
    var rows = msg.data && msg.data[TDIDE_ENTITY];
    if (!Array.isArray(rows)) return;
    var applyNow = function() {
      var table = tdideFindGrid();
      if (table) tdideApplyRows(table, rows);
    };
    applyNow();
    setTimeout(applyNow, 400);
    setTimeout(applyNow, 900);
    setTimeout(applyNow, 1500);
  });

  window.addEventListener("load", function() {
    try {
      window.parent.postMessage({ type: "TDIDE_READY", entities: [TDIDE_ENTITY].concat(TDIDE_LOOKUPS) }, "*");
    } catch (e) {}
    var table = tdideFindGrid();
    var tbody = table && table.querySelector("tbody");
    if (tbody) {
      tdideObserver = new MutationObserver(function() { tdideBroadcast(); });
      tdideObserver.observe(tbody, { childList: true, subtree: true, characterData: true });
    }
  });
})();
</script>
<!-- TDIDE_SYNC_SCRIPT_END -->
`;

  html = html.replace(/\n?<!-- TDIDE_SYNC_SCRIPT_START -->[\s\S]*?<!-- TDIDE_SYNC_SCRIPT_END -->\n?/, "");
  return html.includes("</body>") ? html.replace("</body>", script + "</body>") : html + script;
}

export async function generateHtmlFromXml(
  xml: string,
  frontendLang: string = "HTML/CSS",
  opts: { extraInstructions?: string[]; referenceImage?: string | null; usageSink?: UsageEntry[]; projectTheme?: Record<string, string> | null } = {}
): Promise<string> {
  const { extraInstructions, referenceImage, usageSink, projectTheme } = opts;
  const extraSection = extraInstructions && extraInstructions.length
    ? "\nADDITIONAL USER REQUESTS — apply ALL of these. Some may be purely visual/behavioral " +
      "tweaks (colors, spacing, which controls should be more/less prominent) that the XML " +
      "above has no attribute for — apply them directly to the rendered output anyway, and " +
      "let them OVERRIDE any conflicting default styling rule elsewhere in this prompt:\n" +
      extraInstructions.map((n) => `- ${n}`).join("\n") + "\n"
    : "";
  const imageSection = referenceImage ? IMAGE_REFERENCE_SECTION : "";
  const themeSection = projectTheme && !referenceImage ? buildProjectThemeSection(projectTheme) : "";
  const prompt = XML_TO_HTML_PROMPT(xml, frontendLang, extraSection, themeSection, imageSection);

  const userContent: string | unknown[] = !referenceImage
    ? prompt
    : [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: referenceImage, detail: "high" } },
      ];

  const callOpts = referenceImage ? { model: "gpt-4o", temperature: 0.4 } : { temperature: 0.9 };
  let html = await callOpenAI(
    [
      {
        role: "system",
        content: `You are a senior UI/UX product designer who also writes production ${frontendLang} code. Design first — commit to a distinct visual identity (color, type, spacing, shape) before you touch markup — then implement it precisely and correctly. Return ONLY the complete output file for the chosen framework. No markdown fences.`,
      },
      { role: "user", content: userContent },
    ],
    { timeout: 180, usageSink, ...callOpts }
  );
  html = stripMarkdownFence(html);
  if (frontendLang === "HTML/CSS") html = injectCrossScreenSync(html, xml);
  return html;
}
