import asyncio
import json
import re
import httpx
from app.config import OPENAI_API_KEY

# Shared across every prompt that emits database schema JSON, so type/length/naming
# conventions can't drift between extract/refine/workbench like they did before.
COLUMN_TYPE_RULES = """- Every table must have an "id" column as primary key
- For every VARCHAR column, ALWAYS include a suggested length, e.g. VARCHAR(50). Choose a sensible length for the field's purpose:
    - short codes / status / country: VARCHAR(20)
    - names / titles / cities: VARCHAR(100)
    - email / URL / file paths: VARCHAR(255)
    - long free text with no clear limit: use TEXT instead of VARCHAR
- Use the DATE type for calendar dates such as date_of_birth, joined_date, or start_date (do NOT store dates as VARCHAR)
- Use TIMESTAMP for created_at / updated_at style audit fields
- Mark foreign keys with the referenced "Table.column"
- Name tables in PascalCase
- Name columns in snake_case"""

# Column/table shape shared by extraction, refinement, and the per-table Schema Assistant so a
# table never has richer metadata just because of which of the three touched it last.
EXTENDED_SCHEMA_RULES = """Column object shape — every column has these keys (use false/null where not applicable):
{{
  "name": "snake_case_name",
  "type": "SQL type per the rules above, e.g. VARCHAR(100), INT, DECIMAL(3,2), TIMESTAMP",
  "pk": true|false,
  "fk": "Table.column" or null,
  "nullable": true|false,
  "default": "a literal default as a string, e.g. \\"true\\", \\"0.00\\", \\"now()\\", or null",
  "unique": true|false,
  "autonumber": null or {{
    "prefix": "text before the number, may embed {{YYYY}}/{{YY}}/{{MM}}/{{DD}}, empty string if none",
    "suffix": "text after the number, empty string if none",
    "leading_zeroes": "integer — zero-padded digit width of the number part, default 4",
    "start_number": "integer, default 1",
    "step_number": "integer, default 1",
    "stop_number": "integer, default 9999 (or 10^leading_zeroes - 1)",
    "reset": {{"type": "never|on_stop|yearly|monthly|daily|field_based", "field": "column name driving field_based reset, else null"}}
  }},
  "formula": null or {{
    "expression": "the computation using other column names, e.g. internal_marks + external_marks",
    "inputs": ["array of column names this reads from, e.g. [\\"internal_marks\\", \\"external_marks\\"]"]
  }}
}}
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
{{
  "name": "TableName",
  "description": "<one real sentence specific to what this table stores, or null if you don't have enough context to write one>",
  "columns": [ ...column objects... ],
  "audit_enabled": true|false,
  "history_enabled": true|false,
  "validations": [
    {{"column": "col_name", "type": "required|unique|pattern|minValue|maxValue|maxLength", "detail": "a regex or numeric bound specific to this rule, or empty string if not applicable"}}
  ]
}}
- Set "audit_enabled": true only when the user asks for auditing / tracking who created or
  changed a record. When true, you MUST also APPEND these four objects as the LAST FOUR ITEMS
  INSIDE THE "columns" ARRAY ITSELF (they are columns, like any other — never separate top-level
  keys on the table object, never their own object outside "columns"). Keep these EXACT camelCase
  names — a deliberate exception to snake_case. Concretely, "columns" ends with exactly this
  (as four more entries in the same array as every other column, comma-separated like the rest):
  [ ... every other column ...,
    {{"name": "createdBy", "type": "VARCHAR(100)", "pk": false, "fk": null, "nullable": false, "default": null, "unique": false, "autonumber": null}},
    {{"name": "createdAt", "type": "TIMESTAMP", "pk": false, "fk": null, "nullable": false, "default": "now()", "unique": false, "autonumber": null}},
    {{"name": "modifiedBy", "type": "VARCHAR(100)", "pk": false, "fk": null, "nullable": true, "default": null, "unique": false, "autonumber": null}},
    {{"name": "modifiedAt", "type": "TIMESTAMP", "pk": false, "fk": null, "nullable": true, "default": null, "unique": false, "autonumber": null}} ]
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
  {{"unresolved": [{{"entity": "TableName or null", "column": "col_name or null", "blocking": true|false, "question": "what's unclear and why it matters"}}]}}
- blocking:true = you had to guess at something that could produce a wrong/unusable schema (an
  undefined FK target you couldn't infer, an unstated key column, contradictory instructions).
- blocking:false = a minor assumption worth flagging but not worth stopping for (e.g. "assumed the
  referenced Customer table's key is customer_id since it wasn't defined here").
- Only use this for real ambiguity — most requests are clear enough that "unresolved" stays empty."""

EXTRACT_PROMPT = """You are a database architect. Given the project description and features, extract all database entities (tables) with their columns, primary keys, foreign keys, and any auditing/history/autonumber/validation behavior the user describes.

Think about the actual domain being described, not just the literal words used. If the description names a broader feature or application (a bug tracker, a booking system, an inventory manager, ...) rather than a single simple lookup/reference table, identify and create EVERY table a complete, working implementation of that domain would reasonably need, correctly related via foreign keys — e.g. "a bug tracking application" isn't one Bug table, it's Bug + Project + User + Status + Priority + Comment (+ Label if tags are implied), each a real table with its own columns. Don't under-scope just because the request was short.

Return ONLY valid JSON in this exact format:
{{
  "tables": [ ...table objects, see shape below... ],
  "unresolved": [ ...see shape below, [] when nothing is ambiguous... ]
}}

""" + EXTENDED_SCHEMA_RULES + """

Rules:
""" + COLUMN_TYPE_RULES

REFINE_PROMPT = """You are a database architect. Given the current schema and the user's instruction, update the schema accordingly. Keep every table and column the instruction doesn't touch exactly as it already is, including any nullable/default/unique/autonumber/audit_enabled/history_enabled/validations fields already present — never strip or reset them just because a table happened to pass through this step.

If the instruction names a broader feature or application (a bug tracker, a booking system, an inventory manager, ...) rather than a single simple lookup/reference table, add EVERY table a complete, working implementation of that domain would reasonably need, correctly related via foreign keys to each other and to the existing schema — e.g. "add tables for a bug tracking application" isn't one Bug table, it's Bug + Project + User + Status + Priority + Comment (+ Label if tags are implied), each a real table with its own columns. Don't under-scope just because the instruction was short or phrased as a single "entity."

Current schema:
<current_schema>
{entities}
</current_schema>

User's instruction:
<user_instruction>
{instruction}
</user_instruction>

""" + EXTENDED_SCHEMA_RULES + """

Rules:
""" + COLUMN_TYPE_RULES + """

Return ONLY valid JSON in this exact format:
{{
  "tables": [ ...the full updated tables array, same shape as above... ],
  "unresolved": [ ...see shape above, [] when nothing is ambiguous... ]
}}"""

ARCHITECT_WORKBENCH_PROMPT = """You are a senior software architect helping translate a plain-language requirement into concrete implementation impacts for an application: database schema, UI screens, and business validation rules.

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
""" + COLUMN_TYPE_RULES + """
- Keep each screen's "description" self-contained — it must make sense without referencing other screens
- If a category has no impact, return an empty array for it (but never drop existing entities/screens/rules that the new requirement doesn't touch)
- Return ONLY the JSON, no explanations or markdown fences"""

ENTITY_PROMPT = """You MUST generate SEPARATE files for each entity. Each file MUST start with exactly this separator on its own line:

=== FILENAME: filename.ext ===

You MUST generate one separate file per database table, plus an __init__ file.

Target Language: {language}

Database Schema:
{entities}

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

Return ONLY code with === FILENAME: === separators. No explanations. No markdown."""

AUTH_MODULE_PROMPT = """You are a senior backend developer. Generate a single, real, working authentication
utility module for this project — password hashing, JWT issue/verify, and a reusable "require a valid
token" dependency/middleware that every other endpoint in the project will use. This is shared
infrastructure generated once for the whole project, not tied to any one screen.

Backend Language: {backend_lang}

The "{user_entity}" table is the real user/account table this auth module authenticates against:
{user_entity_schema}

Conventions to follow exactly — a separate assembler places this file at a fixed path other
generated files import it from, so deviating breaks every other screen's build:
{auth_conventions}

Requirements:
- Real password hashing (never store or compare plaintext passwords).
- A real JWT (or equivalent) access token, signed with a secret, with a reasonable expiry.
- The token payload must carry enough to look the user back up (their id, at minimum).
- The "require a valid token" function/middleware must reject (401/unauthorized) any request with a
  missing, malformed, or expired/invalid token, and otherwise make the authenticated user available
  to the calling endpoint.
- No placeholders, no TODOs, no "implement this later" — this must be real, correct, runnable code.

Return ONLY the complete file's code. No explanations, no markdown fences, no === FILENAME: === marker
(the caller already knows the filename from the conventions above)."""

DB_MODULE_PROMPT = """You are a senior backend developer. Generate a single, real, working database
connection/ORM-setup module for this project — every other generated screen's routes will import
and query through this. This is shared infrastructure generated once for the whole project, not
tied to any one screen.

Backend Language: {backend_lang}

Use a real embedded SQLite database (a local file, e.g. app.db) so the generated project runs
immediately with nothing external to stand up — read the connection string from an environment
variable if one is conventionally used for this language/framework's DB config, defaulting to the
local SQLite file when unset.

Conventions to follow exactly — a separate assembler places this file at a fixed path other
generated files import it from, so deviating breaks every other screen's build:
{db_conventions}

Requirements:
- A real, working connection/session/ORM-context setup — whatever this language's idiomatic data
  access pattern is (a session factory, a DbContext, a connection pool, an ORM base class).
- Tables should be created automatically on startup if they don't already exist.
- No placeholders, no TODOs, no "implement this later" — this must be real, correct, runnable code.

Return ONLY the complete file's code. No explanations, no markdown fences, no === FILENAME: === marker
(the caller already knows the filename from the conventions above)."""

EMAIL_MODULE_PROMPT = """You are a senior backend developer. Generate a single, real, working email-sending
utility module for this project — every other generated screen whose job includes sending an email
will import and call through this. This is shared infrastructure generated once for the whole
project, not tied to any one screen.

Backend Language: {backend_lang}

Conventions to follow exactly — a separate assembler places this file at a fixed path other
generated files import it from, so deviating breaks every other screen's build:
{email_conventions}

Requirements:
- A real SMTP-based send function/method taking at minimum a recipient, subject, and body, reading
  SMTP host/port/username/password/from-address from environment variables.
- If the SMTP environment variables aren't configured, raise/throw a real, clear error explaining
  which env vars to set — never silently no-op or pretend an email was sent.
- No placeholders, no TODOs, no "implement this later" — this must be real, correct, runnable code.

Return ONLY the complete file's code. No explanations, no markdown fences, no === FILENAME: === marker
(the caller already knows the filename from the conventions above)."""

VALIDATION_EDIT_PROMPT = """You are a code generator. You have existing code files and a new instruction from the user. Edit the existing files or create new files as needed.

Target Language: {language}

Database Schema:
<current_schema>
{entities}
</current_schema>

Existing Code:
<existing_code>
{existing_code}
</existing_code>

User Instruction:
<user_instruction>
{instruction}
</user_instruction>

IMPORTANT RULES:
1. Separate each file with: === FILENAME: filename.ext ===
2. If the instruction affects an existing file, output the FULL updated version of that file
3. If the instruction requires a new file, create it
4. Include ALL existing files in output (even unchanged ones) so nothing is lost
5. Add/edit validation logic, business rules, or new code as requested

Return ONLY the code with file separators, no explanations or markdown fences."""

UI_PROMPT = """You are a UI code generator. Given database entities, a description of the desired user interface, and a target programming language/framework, generate form/UI code.

Target Language: {language}

Database Schema:
<current_schema>
{entities}
</current_schema>

UI Description:
<ui_description>
{description}
</ui_description>

IMPORTANT: Separate each file/component with a line like: === FILENAME: filename.ext ===
Generate separate files for each form or component.

For example:
=== FILENAME: student_form.html ===
(student form code here)
=== FILENAME: order_list.html ===
(order list code here)

Generate clean, well-structured UI code. If the language is:
- Python: generate Flask/Django template HTML forms
- Java: generate JSP or Thymeleaf forms
- JavaScript/TypeScript: generate React components
- HTML: generate plain HTML forms with CSS

Return ONLY the code with file separators, no explanations or markdown fences."""

SCREEN_INTENT_PROMPT = """You are a UI/UX architect analyzing a screen request. The description below may name ONE
specific screen, may already read as MULTIPLE distinct screens (e.g. "one screen for X, another screen for Y",
"also add a screen to...", a list of separate unrelated forms/pages), or may describe a broader feature/application
as a whole (e.g. "build a personal finance app with expense tracking, budgets, goals, and reports") without
enumerating screens at all.

Description:
<screen_request>
{description}
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
{{
  "screens": [
    {{"name": "Short Screen Name", "description": "Self-contained description of what THIS screen alone should contain — rewritten so it makes sense without referencing the other screens."}}
  ],
  "unresolved": [ ...see shape below, [] when nothing is ambiguous... ]
}}

If it's genuinely unclear how to split the app into screens in a way that would change the result (e.g. "reports"
could reasonably be one screen or several, and the description gives no hint which) — do not silently guess.
Instead add an entry to "unresolved" and still fill in your best-effort screen list around it so nothing is
blocked on the question:
  {{"unresolved": [{{"blocking": true|false, "question": "what's unclear and why it matters"}}]}}
- blocking:true = you had to guess at something that could produce the wrong screen set.
- blocking:false = a minor assumption worth flagging but not worth stopping for.
- Only use this for real ambiguity — most requests are clear enough that "unresolved" stays empty.

Rules:
- Keep each "name" short (2-5 words), Title Case
- Each "description" must stand alone and preserve every relevant detail from the original text for that screen — do not drop information, just split it correctly
- Return ONLY the JSON, no explanations or markdown fences"""

# Shared with REFINE_UI_XML_PROMPT so chat-based edits can't invent elements the HTML
# generator doesn't know how to render (e.g. a toolbar filter dropdown isn't a thing —
# filtering is expressed via filterable="true" on a <column>).
UI_XML_VOCABULARY_RULES = """1. <screen> root with id, title, module, purpose attributes
   - purpose: one sentence describing what this screen does and why it is useful (e.g. "Manage department records — add, update, and remove departments used across the organisation.")

2. <metadata> — entity, dataSource table, screen modes (CREATE, EDIT, VIEW)

3. <header> — title, subtitle, breadcrumb

4. <form> with <fieldset> groups containing fields. Use the CORRECT type for each field:
   - type="select"   → dropdown. Add dataSource="EntityName" valueField="id" displayField="name". Renders as <select> with options.
   - type="lookup"   → text input WITH a lookup/search button beside it. Add lookupEntity="EntityName" lookupField="field". Clicking the button opens a search. Use when user says "lookup", "search button", or "with a button".
   - type="text"     → plain text input
   - type="number"   → numeric input
   - type="date"     → date picker
   - type="time"     → time picker
   - type="checkbox" → boolean toggle (for is_/has_/can_ fields or a boolean column) — NEVER a radio button
   - type="email"    → email input (adds built-in email format validation)
   - type="phone"    → phone number input
   - type="password" → masked password input
   - type="url"      → URL/link input
   - type="color"    → color picker
   - type="file"     → file/image upload (for image/photo/avatar/logo/attachment fields)
   - type="textarea" → multi-line text (for description/notes/comment/bio/remarks fields)
   - Fields with binding="hidden" are omitted from the rendered form entirely (e.g. a foreign surrogate key never shown to the user) — still declare them so downstream code knows the field exists, but the HTML/API generators must not render an input for them.
   - Add readonly="true" on fields that auto-populate from another field (e.g. name filled after selecting a code). These render as disabled/greyed inputs.
   - Add autoFill="from:fieldId" to indicate which field triggers the auto-population.
   - A column with a schema-level "formula" (e.g. total = internal_marks + external_marks) is a
     computed field: type="number", readonly="true", and formula="internal_marks + external_marks"
     (the expression verbatim, referencing other fields on this SAME screen by their field name).
     It recalculates live whenever any input field it depends on changes — never user-typed directly.
   - Related fields that form one logical composite concept (an address' line1/line2/city/state/zip, a person's first/middle/last name, a start/end date pair, an amount+currency pair) go inside their own <fieldset legend="..."> so they're visually grouped as one unit, even though each sub-field is still its own <field> element — this format has no single "composite control" element, grouping is expressed purely via <fieldset>.
   - <rule> children for validation (required, pattern, unique, maxLength, minValue, maxValue)
   - <hint> for helper text
   - NEVER generate radio buttons. Use <select> for choices, or type="checkbox" for a single boolean.

5. <grid> for read-only display tables:
   - readonly="true" on the grid element
   - <column> with id, header, binding, width, sortable="true|false", filterable="true|false" — a "filter by X" request means setting filterable="true" on that column, NOT adding a new toolbar element
   - First ID column must have hyperlink="true" so the ID becomes a clickable link
   - <toolbar> — ONLY these four things: search input (placeholder "Search..."), count badge, refresh action, export-csv action. No other toolbar elements exist — do not invent dropdowns, buttons, or fields inside it.
   - pagination, pageSize, emptyMessage attributes
   - Include 8–10 realistic sample <row> data entries inside a <sampleData> block

6. <toolbar position="bottom"> with action buttons (save, clear, delete, cancel only)
   - Include type, label, style (primary|secondary|danger|ghost), shortcut, confirmation attributes
   - Whenever the screen has a <form>, this toolbar MUST include both a save and a cancel button —
     these two are never optional, regardless of what the description asked for. clear/delete are
     still only included when actually needed.

7. <dataBindings> — entity bindings with allowed operations (SELECT, INSERT, UPDATE, DELETE)

8. <accessibility> — ariaLabel, tabOrder

9. <navigation> — ONLY for a landing/hub/dashboard screen whose job is to route to other screens
   (not a data CRUD screen). Contains one <navItem> per destination, each with:
   targetScreen="ExactScreenName" (MUST exactly match a real screen name provided in the prompt
   context — never invent a screen name that wasn't given to you), label, description, icon
   (a short keyword like "users", "reports", "settings" — not an emoji/SVG, just a hint word).
   Use this element instead of a <form>/<grid> when the screen description signals it's a
   navigation hub / landing page / dashboard that links out to other screens.

10. <auth entity="EntityName"> — ONLY for a sign up / registration / log in / sign in screen. Use
    this instead of a <form>/<grid>/bottom <toolbar> entirely — an auth screen never shows a grid
    of other users' data and never has a delete action. entity="..." names the real user/account
    entity from the schema (usually "User"). Contains:
    - <signup> — one <field> per signup input, using the same <field>/<rule> shape as a normal
      <form> field (rule 4 above). Bind name/email-style fields to the entity's REAL columns when
      they exist (e.g. a "username" or "email" column). Always include a password field
      (type="password", rule required="true" minLength="8") and a confirmPassword field
      (name="confirmPassword", type="password", required="true") even though confirmPassword has
      no matching database column — it's a client-side-only check.
    - <login> — exactly two <field>s: the entity's real identifying column (email or username,
      type="email" or "text") and a password field (type="password", required="true"). No
      confirmPassword here.
    Do not add a <grid>, <toolbar>, or <dataBindings> sibling when <auth> is present — it replaces
    the whole form+grid+toolbar shape, not just the form.

These are the ONLY element/attribute types this format supports. Never introduce a new element or
attribute name beyond what's listed above, even if a request seems to call for one — find the closest
supported construct instead (e.g. a requested filter/search/tag control becomes filterable="true" on
a <column>, or a <form> field of the correct type, never a new kind of toolbar control)."""


UI_XML_PROMPT = """You are a UI/UX architect. Given a screen description and database schema, generate a complete XML UI definition.

Database Schema:
<database_schema>
{entities}
</database_schema>

Screen Description:
<screen_description>
{description}
</screen_description>
{existing_screens_section}
Before choosing this screen's shape, identify what it's actually FOR — do not default to a generic
create/edit form + grid + full CRUD toolbar just because that's the common case. Consider which of
these the description actually describes, and build ONLY the parts that fit:
- Browsing/managing records of an entity → the usual <form>+<grid>+<toolbar> (still the most common
  case — use it when that's genuinely what's being asked for).
- Sign up / registration / log in / sign in / authentication → <auth>, never a <form>+<grid> for this
  (see its own rules below) — a login screen must never show a grid of other users' data.
- A navigation/landing/hub screen that routes to other screens → <navigation>, not a data screen.
- A read-only report/summary (nothing is created or edited here) → <grid> alone (or a stats-only
  layout). Do NOT emit a <form> element at all in this case — a <form> exists to capture input for
  create/edit, which a pure report never does. Since there is no <form>, the mandatory-save/cancel
  rule below (rule 6) never applies either: with no <form> on the screen, omit the bottom
  <toolbar> entirely rather than adding one with save/cancel buttons that have nothing to save.
- A pure search/filter/lookup screen with no persistence implied → <grid> with its own filter/search
  toolbar, no <form>.
Match the XML to the real purpose. Forcing every request into the same CRUD template — including
onto screens that clearly aren't that — is the wrong default.

Generate a well-structured XML that defines the entire screen. Include:

""" + UI_XML_VOCABULARY_RULES + """

Return ONLY valid XML, no explanations or markdown fences."""

XML_TO_HTML_PROMPT = """You are a senior frontend developer. Convert this XML UI definition into production-ready code for the specified frontend framework.

Frontend Framework: {frontend_lang}

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
- ID/code columns in grids MUST be rendered as clickable links/hyperlinks, styled `color: var(--clr-primary); text-decoration: none;` (underline on hover) via a real CSS rule — never left to default browser link-blue, and never a hardcoded hex.
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
   window.addEventListener('message', function(event) {{
     if (!event.data || event.data.type !== 'TDIDE_INIT_DATA') return;
     const shared = event.data.data || {{}};
     if (shared[PRIMARY_ENTITY]) {{
       sampleData.length = 0;
       sampleData.push.apply(sampleData, shared[PRIMARY_ENTITY]);
     }}
     LOOKUP_ENTITIES.forEach(function(name) {{
       if (shared[name]) {{ /* use shared[name] to populate that entity's dropdown/lookup options instead of the hardcoded ones */ }}
     }});
     renderTable(); // call whatever this screen's own render/refresh function is actually named
   }});
   window.parent.postMessage({{ type: 'TDIDE_READY', entities: [PRIMARY_ENTITY].concat(LOOKUP_ENTITIES) }}, '*');
   (If no reply arrives — this screen opened standalone — the page just keeps its own generated
   sample data as a starting point, so it still works fine on its own.)

3. After EVERY successful create/update/delete of a PRIMARY_ENTITY row (save button, delete
   confirm, etc.) — right after you update the local sampleData/dataStore array and re-render —
   also broadcast the change so other screens pick it up:
   window.parent.postMessage({{ type: 'TDIDE_DATA_CHANGE', entity: PRIMARY_ENTITY, rows: sampleData }}, '*');
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
      const lookupData_paperCode = [ /* 5-8 real sample objects with every field this lookup needs to auto-fill, e.g. {{code:'P101', name:'Data Structures'}} */ ];
      function renderLookupList_paperCode(rows) {{
        document.getElementById('lookupList_paperCode').innerHTML = rows.map(r =>
          `<div style="padding:8px 12px;cursor:pointer;" onmouseover="this.style.background='var(--clr-bg)'" onmouseout="this.style.background=''" onclick="selectLookup_paperCode('${{r.code}}')">${{r.code}} — ${{r.name}}</div>`
        ).join('');
      }}
      function filterLookup_paperCode(q) {{ renderLookupList_paperCode(lookupData_paperCode.filter(r => r.code.includes(q) || r.name.toLowerCase().includes(q.toLowerCase()))); }}
      function selectLookup_paperCode(code) {{
        const row = lookupData_paperCode.find(r => r.code === code);
        document.getElementById('paperCode').value = row.code;
        document.getElementById('paperName').value = row.name; // populate every autoFill target the same way
        document.getElementById('lookupPanel_paperCode').style.display = 'none';
      }}
      document.getElementById('lookupBtn_paperCode').addEventListener('click', () => {{
        const panel = document.getElementById('lookupPanel_paperCode');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        renderLookupList_paperCode(lookupData_paperCode);
      }});
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
- This is a PREVIEW with no real router behind it, so clicking a card MUST still do something real and visible: show a toast reading exactly `Navigate to: {{targetScreen}}` (reuse the toast pattern from the SHARED section below) — never a dead card with no handler.
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
  navigate to yet in the preview, just re-render the card in a simple "logged in as {{email}}" state
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
  from it on every keystroke WITHOUT reassigning/overwriting the master array — e.g. `renderTable(
  masterData.filter(...))` passing the filtered list straight into the render function, never
  `masterData = masterData.filter(...)` or filtering from a separate original/seed array. Search
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
- On page load: postMessage {{type:'TDIDE_READY', entities:[...]}} to window.parent, and if a
  {{type:'TDIDE_INIT_DATA'}} reply arrives, replace the local sample data with it before first
  render — this is how the screen picks up live data from other screens (exact pattern under
  CROSS-SCREEN DATA SYNC above)
- After every save/delete of the primary entity: postMessage {{type:'TDIDE_DATA_CHANGE', entity,
  rows}} to window.parent so other screens previewing the same entity see the change too (exact
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
  handler, the window.parent.postMessage({{type:'TDIDE_READY', ...}}) call on load, and a
  window.parent.postMessage({{type:'TDIDE_DATA_CHANGE', ...}}) call after every save/delete of the primary
  entity. This is not optional — a screen missing it is an incomplete generation.
{extra_instructions_section}
{project_theme_section}
{image_reference_section}
XML UI Definition:
<xml_ui_definition>
{xml}
</xml_ui_definition>

Return ONLY the complete output file for the chosen framework, with all styles and logic included. No explanations, no markdown fences."""

IMAGE_REFERENCE_SECTION = """
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
"""

XML_TO_API_PROMPT = """You are a senior full-stack developer. Generate complete REST API code from this XML UI definition.

Backend Language: {backend_lang}
Frontend Language: {frontend_lang}

CRITICAL: You MUST generate an API endpoint for EVERY button and action in the HTML page. Do NOT skip any. Scan every <action>, <toolbar>, <button>, <grid> operation in the XML and generate a corresponding endpoint.

IMPORTANT: Separate each file with: === FILENAME: filename.ext ===

Generate the following files:

1. BACKEND ROUTES FILE (routes.ext) — complete route/controller code in {backend_lang}:
   - Python: FastAPI router with Pydantic models
   - Java: Spring Boot RestController with DTOs
   - JavaScript: Express.js router with validation
   - MUST include endpoints for ALL of these actions:
     * CRUD: Create (POST), Read single (GET), Read list (GET), Update (PUT), Delete (DELETE)
     * Save button -> POST/PUT endpoint
     * Delete button -> DELETE endpoint with confirmation
     * Clear/Reset button -> if server-side, add endpoint
     * Search/Filter -> GET with query parameters
     * Sort -> GET with sort/order params
     * Pagination -> GET with page/size params
     * Export CSV/XLSX -> GET /export endpoint with format param
     * Refresh -> GET list endpoint
     * Unique validation check -> GET /exists endpoint
     * Any dropdown/select data source -> GET endpoint for lookup data
   - Include proper error handling, status codes, request validation
   - Any field the XML marks readonly="true" with a formula attribute (e.g. a total computed from
     other fields) MUST be computed server-side from the other submitted/stored values on every
     create and update — never persist or trust a client-submitted value for that field, even if
     the request body happens to include one.

2. MODELS/SCHEMAS FILE (models.ext) — request/response models in {backend_lang}:
   - Define all DTOs/Pydantic models/interfaces
   - Include field validations (required, maxLength, pattern, min/max)

3. JSON API CONTRACTS FILE (api_contracts.json) — complete endpoint documentation. MUST be exactly this top-level shape (a single object with an "endpoints" array — not a bare array, not grouped by path):
   {{
     "endpoints": [
       {{
         "method": "GET|POST|PUT|DELETE",
         "path": "/api/...",
         "description": "one line describing what this endpoint does",
         "trigger": "which button/action calls this, e.g. 'Save button' or 'Page load'",
         "query_params": [{{"name": "...", "description": "..."}}],
         "request_body": {{"...": "sample request JSON, or null if none"}},
         "response_example": {{"...": "sample response JSON"}},
         "error_examples": [{{"status": 400, "body": {{"...": "..."}}}}]
       }}
     ]
   }}
   - Include EVERY endpoint generated in the routes file above, in the same order
   - query_params, request_body, and error_examples may be empty arrays / null when not applicable, but the keys must always be present

4. FRONTEND API SERVICE FILE (api_service.ext) — API call functions in {frontend_lang}:
   - React: axios service with typed functions
   - Angular: HttpClient service class with Observable returns
   - Vue: axios composable with reactive state
   - Flutter: http service class with model parsing
   - One function per endpoint, properly named
   - Include error handling

5. FRONTEND PAGE COMPONENT (page_component.ext) — the complete UI component in {frontend_lang}:
   - React: functional component with all state, handlers, form, grid, modals
   - Angular: component class + template with form handling
   - Vue: SFC with script setup, reactive refs, handlers
   - Flutter: StatefulWidget with form, table, dialogs
   - Wire EVERY button to its corresponding API call
   - Include loading states, error handling, success messages
{auth_frontend_section}
   - Include confirmation dialogs for destructive actions

IF THE XML'S ROOT SCREEN CONTAINS A <navigation> ELEMENT (a landing/hub screen, no <form>/<grid>):
this is not a CRUD screen — do not invent CRUD endpoints for it.
   - routes.ext / models.ext: emit a minimal file (e.g. an empty router/module with a one-line
     comment explaining this screen has no backend data of its own) rather than fabricated CRUD.
   - api_contracts.json: `{{"endpoints": []}}`.
   - page_component.ext: render one real navigable element per <navItem>, using the frontend
     framework's actual routing primitive — React: `<Link to="/{{slug}}">` (react-router) or an
     onClick calling `navigate("/{{slug}}")`; Vue: `<router-link to="/{{slug}}">`; Angular:
     `routerLink="/{{slug}}"`; Next.js: `<Link href="/{{slug}}">` — where {{slug}} is the
     targetScreen name kebab-cased (e.g. "Student Screen" -> "student-screen"). This is real
     routing code for whoever wires up the router, not a toast/stub like the preview uses.

IF THE XML'S ROOT SCREEN CONTAINS AN <auth> ELEMENT (a sign up / log in screen, no <form>/<grid>):
this is real authentication, not a CRUD screen for the user table — never generate generic
create/read/update/delete endpoints for it.
   - routes.ext: implement exactly two endpoints — one for signup (hash the password with this
     project's shared auth module, INSERT a real row into the real user table via the database
     conventions below, then issue and return an access token the same way login does; if the
     identifying column — username/email — must be unique and a row already exists, reject with a
     real 409/400, don't crash) and one for login (look up the real stored row by its identifying
     column, verify the submitted password against ITS real stored hash — not a fixed demo value
     — and if valid, issue and return an access token; reject with 401 if the row doesn't exist or
     the password doesn't match). Use the EXACT shared hashing/token functions and import path
     given in the auth conventions below, and the EXACT database access patterns given in the
     database conventions below — never reimplement hashing/JWT logic inline in this file, and
     never fall back to an in-memory or precomputed-demo-password shortcut now that a real
     database is wired in.
   - models.ext: request models for signup (matching the XML's <signup> fields) and login
     (matching <login>), plus a response model containing at least the access token.
   - api_contracts.json: exactly these two endpoints (signup, login).
   - page_component.ext: a real toggle-able signup/login form wired to real API calls (via
     api_service.ext) — on a successful response, store the returned token the same way this
     project's other authenticated screens read it from (see the frontend auth storage
     convention below), then show a real logged-in state, not a toast stub.
{auth_module_section}

IF send_email BELOW SAYS THIS SCREEN SENDS AN EMAIL/INVITATION: the endpoint handling that
send/submit action must actually send it via the shared email module — see the email conventions
below for the exact import/function to use. Never fake a "sent" success message without actually
calling it, and never swallow a real send failure into a fake success.
{email_conventions_section}

DATABASE — every CRUD screen (not the <navigation>/<auth> special cases above, which have their
own data-access rules) reads and writes a REAL database, never in-memory/hardcoded sample data:
{db_conventions_section}

STRUCTURAL CONVENTIONS — follow these exactly. A separate assembler places your files into a real runnable project (entrypoint, dependency manifest, folder layout) by relying on these exact names/exports — deviating breaks the build:
{backend_conventions}
{frontend_conventions}
{auth_requirement_section}

XML UI Definition:
<xml_ui_definition>
{xml}
</xml_ui_definition>

Return ONLY code with === FILENAME: === separators — no explanations, no markdown code fences (no ``` anywhere, not even around individual files)."""


BACKEND_CONVENTIONS = {
    "Python": (
        "- The FastAPI router object in routes.ext MUST be a module-level variable named exactly `router` "
        "(e.g. `router = APIRouter()`).\n"
        "- Do not mount an `/api` prefix inside the file itself — the assembler mounts this router at `/api` "
        "for you, so keep the paths exactly as you'd write them for a router with no prefix."
    ),
    "Java": (
        "- routes.ext: FILENAME must be the exact public class name + \".java\" (e.g. "
        "\"=== FILENAME: StudentScreenController.java ===\"). First line must be "
        "`package com.textdevide.app.controller;`. Class must be `public class StudentScreenController` "
        "annotated `@RestController` and `@RequestMapping(\"/api/...\")`.\n"
        "- models.ext: FILENAME must likewise be the exact public class name + \".java\" (Java requires the "
        "filename to match the public class name to compile). First line must be "
        "`package com.textdevide.app.model;`."
    ),
    "JavaScript": (
        "- routes.ext MUST end with `module.exports = router;` where `router` is an `express.Router()` instance.\n"
        "- models.ext MUST end with `module.exports = { ... };` exporting every model/validator it defines."
    ),
    "TypeScript": (
        "- routes.ext MUST end with `export default router;` where `router` is an `express.Router()` instance.\n"
        "- models.ext MUST `export` every interface/class it defines."
    ),
    "C#": (
        "- routes.ext: FILENAME must be the exact public controller class name + \".cs\" (e.g. "
        "\"=== FILENAME: StudentScreenController.cs ===\"). First line must be "
        "`namespace TextDevIde.App.Controllers;`. Class must be annotated `[ApiController]` and "
        "`[Route(\"api/...\")]`.\n"
        "- models.ext: first line must be `namespace TextDevIde.App.Models;`."
    ),
    "Go": (
        "- routes.ext MUST start with `package handlers` and expose exactly one exported function "
        "`func RegisterRoutes(mux *http.ServeMux)` that registers every endpoint on the given mux."
    ),
    "Ruby": (
        "- routes.ext MUST define a single top-level Sinatra-style class/module so it can be `require`-d "
        "directly and mounted."
    ),
    "PHP": (
        "- routes.ext MUST return a single callable (`return function ($router) { ... };`) that registers "
        "every endpoint on the given router, so the file can be `require`-d and immediately invoked."
    ),
}

# Real password hashing + JWT issue/verify, generated ONCE per project (generate_auth_module,
# not per-screen) and pushed as a single top-level file sibling to the entrypoint — NOT inside
# common-library/ (that folder is hyphenated and never actually imported by generated code
# today; a real cross-file Python import needs a valid module name, so the auth module lives at
# the repo root instead, importable the same way main.py already imports each screen's own
# {slug}.routes package). Every other screen's generate_api_from_xml call is told the exact same
# import path/function names here (see require_auth handling below) so its own routes can
# actually depend on this file, not just something that sounds plausible.
AUTH_CONVENTIONS = {
    "Python": (
        "- Use passlib[bcrypt] for hashing and python-jose[cryptography] for JWTs (this project's "
        "own backend uses this exact combination — mirror it).\n"
        "- The file MUST be named auth.py and live at the project root, a sibling of main.py — NOT "
        "inside any screen folder or common-library/. Export exactly these functions: "
        "`hash_password(password: str) -> str`, `verify_password(plain: str, hashed: str) -> bool`, "
        "`create_access_token(data: dict) -> str`, and a FastAPI dependency "
        "`async def get_current_user(authorization: str | None = Header(None)) -> dict` that raises "
        "HTTPException(401) if `authorization` is None/missing, doesn't start with \"Bearer \", or the "
        "token is invalid/expired when decoded — NEVER declare the header parameter as `Header(...)` "
        "(required with no default), because FastAPI then rejects a request with no header at all with "
        "its own 422 validation error before this function body ever runs, instead of the 401 this "
        "project requires for missing credentials.\n"
        "- Other screens' routes.ext import it as `from auth import get_current_user` (a plain "
        "top-level import — this works because main.py is always run from the project root, "
        "putting auth.py on the same import path) and add `user = Depends(get_current_user)` as a "
        "parameter on every protected endpoint function."
    ),
    "Java": (
        "- Use Spring Security + the jjwt library. Put the shared logic in "
        "src/main/java/com/textdevide/app/security/AuthUtil.java (package "
        "`com.textdevide.app.security`) exporting static hash/verify/issue/verify-token methods.\n"
        "- Other controllers import it as `import com.textdevide.app.security.AuthUtil;` and call a "
        "shared `AuthUtil.requireUser(request)` at the top of every protected endpoint method (or "
        "apply it as a filter/interceptor if that's cleaner — either way, every non-auth endpoint "
        "must reject requests with no valid token)."
    ),
    "JavaScript": (
        "- Use bcryptjs for hashing and jsonwebtoken for JWTs. Put the shared logic in "
        "middleware/auth.js, exporting `hashPassword`, `verifyPassword`, `createToken`, and an "
        "Express middleware `authenticateToken(req, res, next)`.\n"
        "- Other routes.ext files import it as `const { authenticateToken } = require('../middleware/auth');` "
        "and add `router.use(authenticateToken)` (or apply it per-route) so every endpoint requires a valid token."
    ),
    "TypeScript": (
        "- Same as JavaScript but in middleware/auth.ts with proper types, using `export` instead of "
        "`module.exports`; other files `import { authenticateToken } from '../middleware/auth';`."
    ),
    "C#": (
        "- Use BCrypt.Net for hashing and System.IdentityModel.Tokens.Jwt for JWTs. Put the shared "
        "logic in Security/AuthService.cs (namespace TextDevIde.App.Security) with hash/verify/issue "
        "methods and a token-validation helper.\n"
        "- Every other protected controller is annotated `[Authorize]` (standard ASP.NET Core JWT "
        "bearer auth, configured against this same signing key) rather than manually re-implementing "
        "the check per endpoint."
    ),
    "Go": (
        "- Use golang.org/x/crypto/bcrypt for hashing and golang-jwt/jwt for JWTs. Put the shared "
        "logic in middleware/auth.go (package middleware) exporting hash/verify/issue functions and "
        "an `Authenticate(next http.Handler) http.Handler` middleware.\n"
        "- Other handlers wrap their mux registration with `middleware.Authenticate(...)` so every "
        "endpoint requires a valid token."
    ),
    "Ruby": (
        "- Use the bcrypt and jwt gems. Put the shared logic in lib/auth.rb with hash/verify/issue "
        "helpers and a `require_auth!` check.\n"
        "- Every other route calls `require_auth!` (a `before` filter or the first line of each "
        "route block) so it rejects requests with no valid token."
    ),
    "PHP": (
        "- Use the built-in password_hash()/password_verify() plus the firebase/php-jwt package. Put "
        "the shared logic in lib/auth.php with hash/verify/issue functions and a "
        "`require_auth()` callable.\n"
        "- Every other route file calls `require_auth()` before doing anything else, so it rejects "
        "requests with no valid token."
    ),
}

# Real live database access — every CRUD screen's routes.ext must use this, not fake in-memory
# data. Unlike AUTH_CONVENTIONS this is ALWAYS threaded in (see db_conventions_section below), not
# conditional, because a real database is now the baseline for every generated project, not an
# opt-in capability. Python's db.py/db_models.py are deterministic (PYTHON_DATABASE_MODULE /
# generate_sqlalchemy_models above), not AI-generated; the other languages' equivalents are
# AI-generated per project the same way generate_auth_module works, since those aren't live-tested
# in this environment and consistency with the existing per-language pattern matters more here
# than the marginal safety deterministic generation buys (which really only pays off when you can
# actually run and iterate against real failures, as Python's auth.py needed last round).
DB_CONVENTIONS = {
    "Python": (
        "- A real SQLite-backed database is already wired up for this project via database.py "
        "(exports `get_db`, a FastAPI dependency yielding a SQLAlchemy `Session`) and db_models.py "
        "(exports one SQLAlchemy model class per table, already matching the real schema — column "
        "names, types, nullability, uniqueness, and foreign keys are already correct, don't "
        "redeclare or reinterpret them). Import both: `from database import get_db` and "
        "`from db_models import <TableClassName>` for the table(s) this screen actually uses.\n"
        "- Every endpoint takes `db: Session = Depends(get_db)` as a parameter and does REAL "
        "queries against it — never an in-memory list/dict, never hardcoded sample rows. Create: "
        "`obj = TableClass(**data); db.add(obj); db.commit(); db.refresh(obj)`. Read one: "
        "`db.query(TableClass).filter(TableClass.id == id).first()`, raise a real 404 "
        "(HTTPException) if it's None. Read list: `db.query(TableClass).offset(skip).limit(limit)"
        ".all()`. Update: fetch first (404 if missing), set attributes from the request body, "
        "`db.commit(); db.refresh(obj)`. Delete: fetch first (404 if missing), "
        "`db.delete(obj); db.commit()`.\n"
        "- A field the XML marks readonly with a formula MUST still be computed server-side before "
        "the row is written (same rule as always) — never trust a client-submitted value for it.\n"
        "- Import EVERY db_models class your code references anywhere in the file, including inside "
        "a validation/uniqueness check (e.g. querying User to check a username/email isn't already "
        "taken) — not just the ones tied to the endpoint's main response. A class used without a "
        "matching `from db_models import X` is a NameError at request time, not a warning."
    ),
    "Java": (
        "- Use Spring Data JPA against the project's SQLite database (already configured in "
        "application.properties) with `@Entity` classes matching the real schema. Autowire a "
        "`JpaRepository<Entity, Long>` per table and use it for every operation — no in-memory "
        "lists, no hardcoded sample data."
    ),
    "JavaScript": (
        "- Use the `better-sqlite3` connection already configured in db/connection.js (exports a "
        "`db` handle) for every query — real INSERT/SELECT/UPDATE/DELETE against the project's "
        "SQLite file, never an in-memory array or hardcoded sample data."
    ),
    "TypeScript": (
        "- Same as JavaScript but importing from db/connection.ts with proper types."
    ),
    "C#": (
        "- Use the EF Core `AppDbContext` (Microsoft.EntityFrameworkCore.Sqlite, already "
        "configured) injected via constructor — real `_context.Set<Entity>()` queries for every "
        "operation, never an in-memory list or hardcoded sample data."
    ),
    "Go": (
        "- Use the `*sql.DB` handle from db/db.go (mattn/go-sqlite3) for every operation — real "
        "parameterized SQL queries against the project's SQLite file, never an in-memory slice or "
        "hardcoded sample data."
    ),
    "Ruby": (
        "- Use ActiveRecord models (already configured against the project's SQLite database) for "
        "every operation — real `.create`/`.find`/`.where`/`.update`/`.destroy` calls, never an "
        "in-memory array or hardcoded sample data."
    ),
    "PHP": (
        "- Use the PDO SQLite connection from lib/db.php for every operation — real prepared-"
        "statement INSERT/SELECT/UPDATE/DELETE against the project's SQLite file, never an "
        "in-memory array or hardcoded sample data."
    ),
}

# Real external email sending — only threaded in for the specific screen(s) detected as actually
# sending an email/invitation (see the send_email flag / gen_screen_api's heuristic), not every
# screen, since most screens have nothing to do with email. Same deterministic-Python /
# AI-generated-elsewhere split as DB_CONVENTIONS, for the same reason.
EMAIL_CONVENTIONS = {
    "Python": (
        "- A real email-sending module is already wired up via email_service.py, exporting "
        "`send_email(to: str, subject: str, body: str) -> None` (raises RuntimeError if SMTP env "
        "vars aren't configured — let that propagate as a real error response, never catch it and "
        "pretend the email sent). Import it as `from email_service import send_email`.\n"
        "- The endpoint handling this screen's send/submit action calls `send_email(...)` with the "
        "REAL submitted to/subject/body field values from the request — never hardcoded strings."
    ),
    "Java": (
        "- Use Jakarta Mail (jakarta.mail) via the shared EmailService bean already configured "
        "from environment variables — call its `sendEmail(to, subject, body)` method with the real "
        "submitted field values, and let a send failure propagate as a real error response."
    ),
    "JavaScript": (
        "- Use nodemailer via the shared `sendEmail(to, subject, body)` helper in "
        "lib/emailService.js (already configured from environment variables) — call it with the "
        "real submitted field values, and let a send failure propagate as a real error response."
    ),
    "TypeScript": (
        "- Same as JavaScript but importing from lib/emailService.ts with proper types."
    ),
    "C#": (
        "- Use MailKit via the shared EmailService already configured from environment variables — "
        "call its SendEmailAsync(to, subject, body) with the real submitted field values, and let a "
        "send failure propagate as a real error response."
    ),
    "Go": (
        "- Use net/smtp via the shared SendEmail(to, subject, body string) error function in "
        "email/email.go (already configured from environment variables) — call it with the real "
        "submitted field values, and return its error as a real error response if it fails."
    ),
    "Ruby": (
        "- Use Net::SMTP via the shared send_email(to, subject, body) helper in lib/email.rb "
        "(already configured from environment variables) — call it with the real submitted field "
        "values, and let a send failure propagate as a real error response."
    ),
    "PHP": (
        "- Use PHPMailer via the shared send_email($to, $subject, $body) function in lib/email.php "
        "(already configured from environment variables) — call it with the real submitted field "
        "values, and let a send failure propagate as a real error response."
    ),
}

# Same reasoning as BACKEND_CONVENTIONS, but for the frontend files (api_service.ext /
# page_component.ext), and only where it's actually needed. React/Vue/Svelte/Next.js all use a
# plain `export default` for the component — the assembler can import that under any alias
# regardless of what the AI names it, so no convention is needed there. Angular and Flutter have
# no such name-agnostic import (Dart has no reflection in AOT/web builds; the assembler wires
# Angular's router by a typed import, not a default export), so those two need the class name
# itself to be predictable. Every other frontend_lang gets "" here — zero behavior change.
FRONTEND_CONVENTIONS = {
    "Angular": (
        "- page_component.ext: the component class MUST be named exactly `ScreenPageComponent` "
        "(standalone component, `@Component({{ standalone: true, ... }})`).\n"
        "- api_service.ext: the injectable service class MUST be named exactly `ScreenApiService` "
        "(`@Injectable({{ providedIn: 'root' }})`)."
    ),
    "Flutter": (
        "- page_component.ext: the top-level widget class MUST be named exactly `ScreenPage`."
    ),
}


async def _call_openai(messages: list, use_json: bool = False, timeout: int = 60, temperature: float = 0, max_retries: int = 2,
                        model: str = "gpt-4o-mini", usage_sink: list | None = None) -> str:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY not configured. Add it to your .env file.")

    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if use_json:
        body["response_format"] = {"type": "json_object"}

    for attempt in range(max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {OPENAI_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
                resp.raise_for_status()
                data = resp.json()
                choice = data["choices"][0]
                if choice.get("finish_reason") == "length":
                    raise ValueError("The AI response was cut off before finishing (hit the token limit) — try a shorter or simpler request.")
                # A plain list mutated by reference is safe to share across concurrent
                # asyncio.gather'd calls (single-threaded/cooperative — no race), unlike a
                # contextvars.ContextVar, which gets copied per-Task and wouldn't propagate
                # accumulated usage back to the caller once the gather completes.
                if usage_sink is not None:
                    usage = data.get("usage") or {}
                    usage_sink.append({
                        "model": model,
                        "prompt_tokens": usage.get("prompt_tokens", 0),
                        "completion_tokens": usage.get("completion_tokens", 0),
                        "total_tokens": usage.get("total_tokens", 0),
                    })
                return choice["message"]["content"]
        except httpx.TransportError as e:
            # Transient network/DNS-level failure (e.g. "getaddrinfo failed") — retry with
            # backoff. Does NOT catch httpx.HTTPStatusError, so real API errors (429, 500,
            # bad request) still surface immediately instead of being retried blindly.
            if attempt < max_retries:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            raise ConnectionError(
                "Couldn't reach the AI service due to a network error. Check your internet connection and try again."
            ) from e


async def extract_entities(description: str, features: str, usage_sink: list | None = None) -> dict:
    user_message = (
        f"<project_description>\n{description}\n</project_description>\n\n"
        f"<detailed_features>\n{features}\n</detailed_features>"
    )
    text = await _call_openai([
        {"role": "system", "content": EXTRACT_PROMPT.format()},
        {"role": "user", "content": user_message},
    ], use_json=True, usage_sink=usage_sink)
    return json.loads(text.strip())


async def refine_entities(entities: str, instruction: str, usage_sink: list | None = None) -> dict:
    prompt = REFINE_PROMPT.format(entities=entities, instruction=instruction)
    text = await _call_openai([
        {"role": "system", "content": "You are a database architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True, usage_sink=usage_sink)
    return json.loads(text.strip())


SCHEMA_ASSISTANT_PROMPT = """You are a database architect embedded in a schema editor, making one focused change at a
time to a SINGLE table based on a user's chat instruction. Keep everything about the table that the instruction
doesn't touch exactly as it already is — do not restructure, rename, or "improve" anything unasked.

Table being edited:
<table>
{table}
</table>

Other tables in this project (for foreign key targets and uniqueness context — do not modify these, only reference
them by exact name):
<other_tables>
{other_tables}
</other_tables>

User's instruction:
<instruction>
{instruction}
</instruction>

The string values shown in the shapes below are placeholders describing what to put there — replace every
one with a real, specific value for THIS table; never copy the placeholder wording itself into your output,
and never fabricate a description if the table already has a good one and the instruction doesn't touch it —
keep the existing description unchanged in that case.

""" + EXTENDED_SCHEMA_RULES + """

Rules:
""" + COLUMN_TYPE_RULES + """
- "Make X unique" adds a column-level validations entry AND sets unique=true on that column.
- A foreign key MUST reference a real table+column from <other_tables> (or this same table for a self-reference like
  a manager/parent) — never invent a table or column name that wasn't given to you.
- Only touch what the instruction actually asks for.

Return ONLY valid JSON in this exact shape (no markdown fences):
{{
  "table": {{ ...the full updated table object, same shape as above... }},
  "summary": "One or two plain-language sentences describing exactly what changed, written as if replying in a chat — e.g. \\"Added manager_id as a foreign key to employee.employee_id, and enabled auditing so created_by / modified_by are tracked.\\"",
  "unresolved": [ ...same shape as above, [] when nothing about this specific change is ambiguous... ]
}}"""


async def schema_assistant_edit_table(table: dict, other_tables: list[dict], instruction: str, usage_sink: list | None = None) -> dict:
    other_summary = "\n".join(
        f"- {t['name']}: columns [{', '.join(c['name'] for c in t.get('columns', []))}]"
        for t in other_tables
    ) or "none"
    prompt = SCHEMA_ASSISTANT_PROMPT.format(
        table=json.dumps(table, indent=2),
        other_tables=other_summary,
        instruction=instruction,
    )
    text = await _call_openai([
        {"role": "system", "content": "You are a database architect embedded in a schema editor. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True, usage_sink=usage_sink)
    return json.loads(text.strip())


def _workbench_context(entities: dict | None, screens: list | None, validation_rules: str | None) -> str:
    parts = []
    if entities and entities.get("tables"):
        parts.append(f"Current database schema:\n{json.dumps(entities, indent=2)}")
    else:
        parts.append("Current database schema: none yet.")
    if screens:
        screen_lines = "\n".join(f"- {s.get('name', '')}: {s.get('description', '')}" for s in screens)
        parts.append(f"Current screens:\n{screen_lines}")
    else:
        parts.append("Current screens: none yet.")
    parts.append(f"Current validation rules:\n{validation_rules}" if validation_rules else "Current validation rules: none yet.")
    return "\n\n".join(parts)


async def interpret_requirement(requirement: str, entities: dict | None, screens: list | None, validation_rules: str | None, usage_sink: list | None = None) -> dict:
    context = _workbench_context(entities, screens, validation_rules)
    user_message = f"<current_project_state>\n{context}\n</current_project_state>\n\n<new_requirement>\n{requirement}\n</new_requirement>"
    text = await _call_openai([
        {"role": "system", "content": ARCHITECT_WORKBENCH_PROMPT},
        {"role": "user", "content": user_message},
    ], use_json=True, timeout=90, usage_sink=usage_sink)
    data = json.loads(text.strip())
    changes = data.get("changes") or {}
    data["changes"] = {
        "db_schema_changes": changes.get("db_schema_changes") or [],
        "table_catalog": changes.get("table_catalog") or [],
        "ui_screens": changes.get("ui_screens") or [],
        "business_rules": changes.get("business_rules") or [],
    }
    data["entities"] = data.get("entities") or (entities or {"tables": []})
    data["screens"] = data.get("screens") or (screens or [])
    data["validation_rules"] = data.get("validation_rules") or (validation_rules or "")
    data["summary"] = data.get("summary") or "Updated project"
    data["summary_detail"] = data.get("summary_detail") or ""
    data["suggestions"] = data.get("suggestions") or []
    return data


def generate_sql(entities: dict) -> str:
    lines = ["-- Auto-generated SQL schema", "-- Created by Text Dev IDE", ""]
    fk_statements = []

    for table in entities.get("tables", []):
        name = table["name"].lower()
        lines.append(f"CREATE TABLE {name} (")
        col_lines = []
        for col in table.get("columns", []):
            col_name = col["name"]
            col_type = col.get("type", "VARCHAR")
            type_map = {
                "INT": "INTEGER",
                "VARCHAR": "VARCHAR(255)",
                "TEXT": "TEXT",
                "BOOLEAN": "BOOLEAN",
                "DECIMAL": "DECIMAL(10,2)",
                "DATE": "DATE",
                "TIMESTAMP": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
            }
            sql_type = type_map.get(col_type.upper(), col_type)
            if col.get("pk"):
                col_lines.append(f"    {col_name} SERIAL PRIMARY KEY")
            elif col_name.endswith("_id") or col.get("fk"):
                col_lines.append(f"    {col_name} INTEGER NOT NULL")
            else:
                col_lines.append(f"    {col_name} {sql_type}")

            if col.get("fk"):
                ref_table, ref_col = col["fk"].lower().split(".")
                fk_statements.append(
                    f"ALTER TABLE {name} ADD CONSTRAINT fk_{name}_{col_name} "
                    f"FOREIGN KEY ({col_name}) REFERENCES {ref_table}({ref_col});"
                )

        lines.append(",\n".join(col_lines))
        lines.append(");\n")

    if fk_statements:
        lines.append("-- Foreign Key Constraints")
        lines.extend(fk_statements)
        lines.append("")

    return "\n".join(lines)


def _ensure_file_splits(code: str, language: str) -> str:
    if "=== FILENAME:" in code:
        return code

    import re
    ext = {"Python": "py", "Java": "java", "JavaScript": "js", "TypeScript": "ts", "C#": "cs", "Go": "go", "Ruby": "rb", "PHP": "php"}.get(language, "py")

    if language == "Python":
        parts = re.split(r'(?=^@dataclass\s*\nclass\s|^class\s)', code, flags=re.MULTILINE)
    elif language == "Java":
        parts = re.split(r'(?=^public\s+class\s)', code, flags=re.MULTILINE)
    else:
        parts = re.split(r'(?=^class\s|^export\s+class\s|^export\s+interface\s)', code, flags=re.MULTILINE)

    if len(parts) <= 1:
        return f"=== FILENAME: entities.{ext} ===\n{code}"

    imports = parts[0].strip()
    files = []
    for part in parts[1:]:
        part = part.strip()
        if not part:
            continue
        match = re.search(r'class\s+(\w+)', part)
        name = match.group(1).lower() if match else f"file{len(files)}"
        full = f"{imports}\n\n{part}" if imports else part
        files.append(f"=== FILENAME: {name}.{ext} ===\n{full}")

    if imports:
        lines = []
        for p in parts[1:]:
            m = re.search(r'class (\w+)', p)
            if m:
                cls = m.group(1)
                lines.append(f"from .{cls.lower()} import {cls}")
        init_imports = "\n".join(lines)
        files.insert(0, f"=== FILENAME: __init__.{ext} ===\n{init_imports}")

    return "\n\n".join(files)


async def generate_entity_code(entities: dict, language: str, usage_sink: list | None = None) -> str:
    prompt = ENTITY_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2),
    )
    code = await _call_openai([
        {"role": "system", "content": "You generate code split into separate files. Every file MUST be preceded by a line: === FILENAME: name.ext === on its own line. Never combine multiple classes in one file."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)
    return _ensure_file_splits(code, language)


async def generate_auth_module(backend_lang: str, entities: dict, usage_sink: list | None = None) -> str:
    """Generated ONCE per project (not per-screen), the first time a screen using <auth> is
    generated — see routes/projects.py. Every other screen's generate_api_from_xml call is told
    to import this same file (see require_auth below), so it must stay stable once created."""
    tables = entities.get("tables", []) if entities else []
    user_table = next((t for t in tables if t.get("name", "").lower() in ("user", "account", "member")), None) \
        or next((t for t in tables if "password" in [c.get("name", "").lower() for c in t.get("columns", [])]), None) \
        or (tables[0] if tables else {"name": "User", "columns": []})
    prompt = AUTH_MODULE_PROMPT.format(
        backend_lang=backend_lang,
        user_entity=user_table.get("name", "User"),
        user_entity_schema=json.dumps(user_table, indent=2),
        auth_conventions=AUTH_CONVENTIONS.get(backend_lang, "- Use idiomatic hashing/JWT libraries and file layout for this language."),
    )
    code = await _call_openai([
        {"role": "system", "content": f"You are a senior backend developer writing real, secure authentication code in {backend_lang}. Return ONLY the file's code, no explanations, no markdown fences."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)
    return _strip_markdown_fence(code)


async def generate_db_module(backend_lang: str, usage_sink: list | None = None) -> str:
    """Non-Python languages only — Python's database.py is deterministic (PYTHON_DATABASE_MODULE
    above), needing no AI call at all. For the other languages (not live-tested in this
    environment), this mirrors generate_auth_module's shape: generated ONCE per project, the first
    time a screen with a schema is generated — see routes/projects.py."""
    prompt = DB_MODULE_PROMPT.format(
        backend_lang=backend_lang,
        db_conventions=DB_CONVENTIONS.get(backend_lang, "- Use an idiomatic embedded SQLite setup for this language."),
    )
    code = await _call_openai([
        {"role": "system", "content": f"You are a senior backend developer writing real database connection/ORM code in {backend_lang}. Return ONLY the file's code, no explanations, no markdown fences."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)
    return _strip_markdown_fence(code)


async def generate_email_module(backend_lang: str, usage_sink: list | None = None) -> str:
    """Non-Python languages only — Python's email_service.py is deterministic
    (PYTHON_EMAIL_SERVICE_MODULE above). Same generated-once-per-project shape as
    generate_auth_module/generate_db_module for the other languages."""
    prompt = EMAIL_MODULE_PROMPT.format(
        backend_lang=backend_lang,
        email_conventions=EMAIL_CONVENTIONS.get(backend_lang, "- Use an idiomatic SMTP-based email send for this language."),
    )
    code = await _call_openai([
        {"role": "system", "content": f"You are a senior backend developer writing real SMTP email-sending code in {backend_lang}. Return ONLY the file's code, no explanations, no markdown fences."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)
    return _strip_markdown_fence(code)


async def edit_validation_code(instruction: str, existing_code: str, entities: dict | None, language: str, usage_sink: list | None = None) -> str:
    prompt = VALIDATION_EDIT_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        existing_code=existing_code,
        instruction=instruction,
    )
    code = await _call_openai([
        {"role": "system", "content": "You edit existing code files and create new ones. Every file MUST be preceded by: === FILENAME: name.ext === on its own line. Output ALL files including unchanged ones. Never combine multiple classes in one file."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)
    return _ensure_file_splits(code, language)


async def generate_ui_code(description: str, entities: dict | None, language: str, usage_sink: list | None = None) -> str:
    prompt = UI_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        description=description,
    )
    return await _call_openai([
        {"role": "system", "content": f"You are a UI code generator for {language}. Return ONLY code."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)


async def detect_screen_intents(description: str, usage_sink: list | None = None) -> dict:
    prompt = SCREEN_INTENT_PROMPT.format(description=description)
    text = await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True, usage_sink=usage_sink)
    data = json.loads(text.strip())
    if not data.get("screens"):
        data["screens"] = [{"name": description[:40].strip(), "description": description}]
    data["unresolved"] = data.get("unresolved") or []
    return data


REFINE_UI_XML_PROMPT = """You are a UI/UX architect. You are given an existing XML UI definition for a screen and a
follow-up change request from the user. Apply ONLY the requested change — keep every other element, attribute,
and sample row exactly as it already is unless the change necessarily affects it.

This XML format supports ONLY the following element/attribute vocabulary — the same rules the screen was
originally generated under. Express the requested change using these constructs; never introduce a new
element or attribute name, even if the request seems to call for one:

""" + UI_XML_VOCABULARY_RULES + """

Existing XML UI Definition:
<existing_xml>
{xml}
</existing_xml>

Change request:
<change_request>
{instruction}
</change_request>

Return ONLY valid JSON in this exact shape (no markdown fences) — the "xml" value is the complete
updated XML as a single string (the whole screen, not a diff or fragment; escape it properly as a
JSON string):
{{
  "xml": "the complete updated XML",
  "summary": "One or two plain-language sentences describing exactly what changed, written as if replying in a chat — e.g. \\"Added a status filter to the grid and made the email field required.\\" Be specific about field/column names, not generic (\\"Applied your change\\" is not acceptable)."
}}"""


async def refine_ui_xml(xml: str, instruction: str, usage_sink: list | None = None) -> dict:
    prompt = REFINE_UI_XML_PROMPT.format(xml=xml, instruction=instruction)
    text = await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True, usage_sink=usage_sink)
    return json.loads(text.strip())


UI_METADATA_PROMPT = """You are a UI metadata generator. Given a list of tables and columns for a user
interface page, produce a single JSON object describing the fields, their controls, and the page layout.

Page: __PAGE__

__TABLES__

### Your task

1. For every column listed, produce exactly one field entry in the output JSON's flat "fields" array,
   each with a unique "id".
2. Infer a default control for every field using the rules below, in priority order (first match wins).
3. Preserve the input's column order in the output.
4. Produce a "layout" object that arranges the fields (by "id" reference) into sections and rows/grids
   using the default layout rules below.

### Default control inference rules (apply in order; rule 0 first, across each table's whole column list)

| Priority | Pattern | Default control |
|---|---|---|
| 0 | A table contains a recognizable cluster of columns matching a known composite pattern (see below), not already part of another group | Group them into one composite field; control = the matching pattern name; source: "default" |
| 1 | Column is the table's own primary key | "hidden" |
| 2 | Column is a foreign key to another table | "dropdown" |
| 3 | Name starts with is_/has_/can_, or type is boolean | "checkbox" |
| 4 | Name contains date or _dt or _at | "date_picker" |
| 5 | Name contains time only (no date) | "time_picker" |
| 6 | Name contains email | "email_input" |
| 7 | Name contains phone or mobile | "phone_input" |
| 8 | Name contains password | "password_input" |
| 9 | Name contains url, link, or website | "url_input" |
| 10 | Name contains color or colour | "color_picker" |
| 11 | Name contains image, photo, avatar, or logo | "file_upload" |
| 12 | Name contains description, notes, comment, bio, or remarks | "textarea" |
| 13 | Name contains status, type, category, role, country, state, or ends in _code | "dropdown" |
| 14 | Type is numeric, or name contains amount/price/qty/quantity | "number_input" |
| 15 | Type is long/unbounded text | "textarea" |
| 16 | Fallback | "text_input" |

### Known composite patterns (for rule 0) — only auto-group when a strong majority of a pattern's
columns are present in the SAME table; never force a weak/partial match

| Composite control | Trigger columns (name/underscore-insensitive) | Roles |
|---|---|---|
| address | 3+ of: door_no/house_no/address_line1, street/street_name/address_line2, city/city_name, state/province, zip/zipcode/postal_code, country/country_code | line1, line2, city, state, zip, country |
| full_name | first_name + last_name (+ optional middle_name) | first, middle, last |
| date_range | a pair like start_date/end_date or from_date/to_date | start, end |
| money_with_currency | an amount column (amount/price/total) paired with a currency/currency_code column | amount, currency |
| geo_coordinates | latitude/lat + longitude/lng/long | lat, lng |

### Field id convention

- Simple field -> id = "<table>.<column>" (e.g. "customers.email").
- Composite field -> id = "field.<group_name>" (e.g. "field.address", "field.full_name").

### Output JSON schema

{
  "page": "string",
  "fields": [
    { "kind": "simple", "id": "string", "table": "string", "column": "string", "control": "string", "source": "explicit|default", "label": "string" },
    { "kind": "composite", "id": "string", "field": "string", "control": "string", "source": "explicit|default", "label": "string",
      "columns": [ { "table": "string", "column": "string", "role": "string", "label": "string" } ] }
  ],
  "layout": {
    "type": "page", "direction": "vertical",
    "sections": [
      { "id": "string", "title": "string|null", "columns": "integer",
        "rows": [ { "cells": [ { "field_id": "string", "col_span": "integer" } ] } ] }
    ]
  }
}

### Default layout generation

1. One section per table with at least one visible field, titled with the humanized table name.
   Cross-table composite fields go into their own section named after the group's label, placed
   before the sections of the tables they draw from.
2. Fields with control "hidden" still appear in "fields" but are excluded from every section's "rows".
3. Default columns per section = 2, unless the section has 3 or fewer visible fields, then 1.
4. Within a section, col_span equals the section's columns value (full-width row) for any textarea,
   composite field, or file_upload control. Everything else defaults to col_span: 1, packed per row
   in input order.
5. Preserve input order for section order and row/field order within a section.

Return ONLY the JSON object — no commentary, no markdown code fences, no explanation. Ensure valid,
parseable JSON. Every field_id used in "layout" must correspond to a real fields[].id, and every
non-hidden field must appear in exactly one layout cell."""


async def generate_ui_metadata(page: str, table_blocks: str, usage_sink: list | None = None) -> dict:
    prompt = UI_METADATA_PROMPT.replace("__PAGE__", page).replace("__TABLES__", table_blocks)
    text = await _call_openai([
        {"role": "system", "content": "You are a UI metadata generator. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True, usage_sink=usage_sink)
    return json.loads(text.strip())


_METADATA_CONTROL_TO_FIELD_TYPE = {
    "hidden": "text", "dropdown": "select", "checkbox": "checkbox", "date_picker": "date",
    "time_picker": "time", "email_input": "email", "phone_input": "phone", "password_input": "password",
    "url_input": "url", "color_picker": "color", "file_upload": "file", "textarea": "textarea",
    "number_input": "number", "text_input": "text",
}


def _humanize(name: str) -> str:
    return " ".join(w.capitalize() for w in name.replace("-", "_").split("_"))


def _fuzzy_col_key(table: str, column: str) -> tuple[str, str]:
    # The metadata generator normalizes table names on its own (lowercases, sometimes
    # singularizes) independent of our real table names, e.g. "Students" -> "student" —
    # match loosely by column name + a fuzzy table match instead of an exact string.
    return (table.rstrip("s").lower(), column.lower())


_VARCHAR_LEN_RE = re.compile(r"VARCHAR\s*\(\s*(\d+)\s*\)", re.IGNORECASE)


def _xml_attr_escape(value: str) -> str:
    return (str(value).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def _entity_validation_maps(entities: dict | None, table_names: list[str]) -> tuple[dict, dict]:
    """Keyed by _fuzzy_col_key(table, column) so _metadata_to_form_xml can look up the REAL
    schema's nullable/type/unique/validations for a field the metadata generator produced —
    letting a deterministic <rule> get attached without depending on the AI to remember the
    schema's constraints on its own."""
    columns_by_key, validations_by_key = {}, {}
    for tname in table_names:
        table = next((t for t in (entities or {}).get("tables", []) if t["name"] == tname), None)
        if not table:
            continue
        for c in table.get("columns", []):
            columns_by_key[_fuzzy_col_key(tname, c["name"])] = c
        for v in table.get("validations", []) or []:
            if v.get("column"):
                validations_by_key.setdefault(_fuzzy_col_key(tname, v["column"]), []).append(v)
    return columns_by_key, validations_by_key


def _rule_element_for(column: dict | None, validations: list[dict]) -> str:
    """Builds a single <rule .../> from the real schema's nullable/type/unique plus any
    structured "validations" entries (required/unique/pattern/minValue/maxValue/maxLength) —
    forms generated via the prebuilt-metadata path otherwise carry NO validation at all, since
    the metadata generator's JSON schema has no slot for it (only control/label)."""
    attrs = {}
    # An autonumbered column (e.g. deptid formatted like "d0009") is never typed by the user —
    # it's generated by the system — so it must never be marked required no matter what the
    # column's own nullable/validations say about the STORED value being mandatory. Required
    # would otherwise block every save on a field the user has no way to fill in themselves.
    is_autonumber = bool(column is not None and column.get("autonumber"))
    if column is not None and not column.get("nullable", True) and not is_autonumber:
        attrs["required"] = "true"
    if column is not None and column.get("unique"):
        attrs["unique"] = "true"
    if column is not None:
        m = _VARCHAR_LEN_RE.search(column.get("type") or "")
        if m:
            attrs["maxLength"] = m.group(1)
    for v in validations:
        vtype, detail = v.get("type"), v.get("detail")
        if vtype == "required":
            if not is_autonumber:
                attrs["required"] = "true"
        elif vtype == "unique":
            attrs["unique"] = "true"
        elif vtype in ("pattern", "maxLength", "minValue", "maxValue") and detail not in (None, ""):
            attrs[vtype] = detail
    if not attrs:
        return ""
    attr_str = " ".join(f'{k}="{_xml_attr_escape(v)}"' for k, v in attrs.items())
    return f"\n      <rule {attr_str}/>"


def _metadata_to_form_xml(metadata: dict, fk_targets: dict | None = None,
                           columns_by_key: dict | None = None, validations_by_key: dict | None = None) -> str:
    """Deterministic, non-AI conversion of the metadata generator's fields+layout JSON into
    <fieldset>/<field> XML matching this app's screen vocabulary — hidden fields are dropped,
    composite fields become one <fieldset> grouping their sub-columns, section order/grouping
    from "layout" is preserved as fieldset order. fk_targets maps "table.column" -> the real
    referenced table name, for the subset of "select" fields that are genuine FK lookups.
    columns_by_key/validations_by_key (see _entity_validation_maps) drive the <rule> child each
    field gets, from the entity's actual nullable/type/unique/validations — not the AI's guess."""
    fk_targets_norm = {}
    for key, target in (fk_targets or {}).items():
        tbl, col = key.rsplit(".", 1)
        fk_targets_norm[_fuzzy_col_key(tbl, col)] = target

    fields_by_id = {f["id"]: f for f in metadata.get("fields", [])}
    lines = ["<form>"]
    for section in metadata.get("layout", {}).get("sections", []):
        field_ids_in_section = [c["field_id"] for row in section.get("rows", []) for c in row.get("cells", [])]
        if not field_ids_in_section:
            continue
        title = section.get("title") or "Details"
        lines.append(f'  <fieldset legend="{title}">')

        def _simple_field_line(table, column, control, label, indent="    "):
            ftype = _METADATA_CONTROL_TO_FIELD_TYPE.get(control, "text")
            key = _fuzzy_col_key(table, column)
            # "select" catches both true FK lookups (rule 2) and plain status/category/_code
            # dropdowns (rule 13) — only the former has a real table to point dataSource at.
            fk_target = fk_targets_norm.get(key)
            col_info = (columns_by_key or {}).get(key)
            extra = f' dataSource="{fk_target}" valueField="id" displayField="name"' if ftype == "select" and fk_target else ""
            # Same reasoning as _rule_element_for's required-skip: the user never types this in,
            # the system assigns it — render it readonly (like the vocabulary's existing
            # auto-populated-field convention) rather than a normal editable input.
            if col_info and col_info.get("autonumber"):
                extra += ' readonly="true"'
            rule = _rule_element_for(col_info, (validations_by_key or {}).get(key, []))
            open_tag = f'{indent}<field name="{column}" label="{label or _humanize(column)}" type="{ftype}"{extra}'
            return f'{open_tag}/>' if not rule else f'{open_tag}>{rule}\n{indent}</field>'

        for fid in field_ids_in_section:
            f = fields_by_id.get(fid)
            if not f:
                continue
            sub_columns = f.get("columns", []) if f["kind"] == "composite" else []
            if f["kind"] == "composite" and len(sub_columns) >= 2:
                lines.append(f'    <fieldset legend="{f.get("label", f["field"])}">')
                for sub in sub_columns:
                    # Sub-columns don't carry their own inferred control — a role like "line1"/
                    # "city"/"zip" is always short free text; "start"/"end" in a date_range would
                    # be the exception, handled generically by checking the role name.
                    role = sub.get("role", "")
                    control = "date_picker" if role in ("start", "end") else "text_input"
                    lines.append(_simple_field_line(sub["table"], sub["column"], control, sub.get("label"), indent="      "))
                lines.append('    </fieldset>')
            elif f["kind"] == "composite" and len(sub_columns) == 1:
                # A "composite" the model applied to a single column isn't really composite —
                # treat it as one plain field instead of forcing it into a fake group.
                sub = sub_columns[0]
                lines.append(_simple_field_line(sub["table"], sub["column"], "text_input", sub.get("label") or f.get("label")))
            else:
                lines.append(_simple_field_line(f["table"], f["column"], f.get("control", "text_input"), f.get("label")))
        lines.append('  </fieldset>')
    lines.append("</form>")
    return "\n".join(lines)


def _entity_table_blocks(entities: dict, table_names: list[str]) -> tuple[str, dict]:
    """Builds the "Table: X\\n- column" plaintext blocks the metadata generator expects, from
    this project's real schema — never invented columns. Also returns a "table.column" -> real
    FK target table map, and annotates FK/autonumber columns inline so the model has real
    relationship context instead of guessing off the column name alone (e.g. so a "_code" column
    that's actually an autonumber doesn't get misclassified as a lookup dropdown)."""
    blocks = []
    fk_targets = {}
    for tname in table_names:
        table = next((t for t in entities.get("tables", []) if t["name"] == tname), None)
        if not table:
            continue
        col_lines = []
        for c in table.get("columns", []):
            hint = ""
            if c.get("fk"):
                target = c["fk"].split(".")[0]
                fk_targets[f"{tname}.{c['name']}"] = target
                hint = f" (foreign key -> {c['fk']})"
            elif c.get("autonumber"):
                hint = " (auto-generated identifier, not a lookup)"
            col_lines.append(f"- {c['name']}{hint}")
        blocks.append(f"Table: {tname}\n" + "\n".join(col_lines))
    return "\n\n".join(blocks), fk_targets


async def generate_ui_xml(description: str, entities: dict | None, existing_screens: list[dict] | None = None,
                           screen_name: str = "", screen_entities: list[str] | None = None,
                           usage_sink: list | None = None) -> str:
    if existing_screens:
        lines = "\n".join(f"- \"{s['name']}\": {s.get('purpose') or 'no description'}" for s in existing_screens)
        existing_screens_section = (
            "\nThis screen routes to other screens that already exist in this project. If (and only if) "
            "the description above calls for a navigation/hub/landing screen, use a <navigation> element "
            "with one <navItem targetScreen=\"...\"> per screen below, using these EXACT names — do not "
            "invent, rename, or abbreviate them:\n"
            f"{lines}\n"
        )
    else:
        existing_screens_section = ""

    # Multiple primary entities means a navigation/hub screen (no form fields at all) — the
    # richer metadata pipeline only applies to single/few-entity CRUD-style screens. Also skip it
    # for screens whose description unambiguously signals read-only (a report/summary screen):
    # once a fully-built <form> block is dangling in the final prompt as "already designed, paste
    # it in", the model reliably pastes it in even when told the classification above overrides
    # that — in testing it kept the form (and the mandatory save/cancel toolbar that follows from
    # having one) regardless of prose telling it not to. Not building the form at all removes the
    # temptation instead of relying on the model to decline it.
    _read_only_signals = ("read-only", "read only", "readonly", "view only", "view-only",
                           "no editing", "not editable", "no create", "no crud")
    _desc_lower = (description or "").lower()
    is_read_only_report = any(sig in _desc_lower for sig in _read_only_signals)

    prebuilt_form_section = ""
    if entities and screen_entities and len(screen_entities) <= 3 and not is_read_only_report:
        table_blocks, fk_targets = _entity_table_blocks(entities, screen_entities)
        if table_blocks:
            try:
                metadata = await generate_ui_metadata(screen_name or "Screen", table_blocks, usage_sink=usage_sink)
                columns_by_key, validations_by_key = _entity_validation_maps(entities, screen_entities)
                form_xml = _metadata_to_form_xml(metadata, fk_targets, columns_by_key, validations_by_key)
                prebuilt_form_section = (
                    "\nIF (and only if) the screen-shape classification above concluded this screen needs "
                    "a data-entry <form> at all (i.e. it's a genuine create/browse/manage screen, NOT a "
                    "read-only report, pure search/lookup, navigation hub, or auth screen): a <form> "
                    "section has already been designed for it using richer field-control inference than "
                    "you'd do alone (proper email/phone/url/color/file inputs, checkboxes for booleans, "
                    "composite fieldsets for address/name/date-range groups). COPY IT BYTE-FOR-BYTE as the "
                    "screen's <form> element in that case — do not add, remove, or infer a "
                    "dataSource/valueField/displayField/rule/hint/autoFill on ANY of these fields even "
                    "if the general field-type rules above would normally call for one, do not change "
                    "any type= value, do not add or remove fields, do not reorder or rename anything. "
                    "Treat the block below as an opaque, already-finished string to paste in unmodified — "
                    "build everything else around it (header, grid if a list view is warranted, bottom "
                    "toolbar, navigation if applicable, dataBindings, accessibility).\n"
                    "IF the classification above concluded this is a read-only report/summary or pure "
                    "search/lookup screen, IGNORE this pre-built form entirely — do not paste it in, do "
                    "not include a <form> element at all, per the classification rules above.\n"
                    f"{form_xml}\n"
                )
            except Exception:
                prebuilt_form_section = ""  # fall through to the AI designing the form itself

    prompt = UI_XML_PROMPT.format(
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        description=description,
        existing_screens_section=existing_screens_section + prebuilt_form_section,
    )
    xml = await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid XML."},
        {"role": "user", "content": prompt},
    ], usage_sink=usage_sink)
    return _strip_form_if_read_only(xml)


_ALLOWED_OPS_RE = re.compile(r"<allowedOperations>\s*([^<]*)\s*</allowedOperations>", re.IGNORECASE)
_FORM_BLOCK_RE = re.compile(r"[ \t]*<form\b.*?</form>\s*\n?", re.IGNORECASE | re.DOTALL)
_BOTTOM_TOOLBAR_RE = re.compile(
    r'[ \t]*<toolbar\s+position="bottom".*?</toolbar>\s*\n?', re.IGNORECASE | re.DOTALL
)


def _strip_form_if_read_only(xml: str) -> str:
    """Backstop for a real gap in gpt-4o-mini's instruction-following: even when told explicitly
    that a read-only report/search screen must have no <form> and no save/cancel <toolbar>, it
    reliably ignores that and includes both anyway — in testing this happened even with the
    prebuilt-metadata form generation skipped entirely, so it's the model's own independent
    choice, not it copying a fed-in form. But it DOES reliably self-report the screen as
    SELECT-only in <dataBindings><allowedOperations> even while making that mistake, so that's a
    trustworthy signal to post-process against deterministically rather than keep tuning prose."""
    ops_match = _ALLOWED_OPS_RE.search(xml)
    if not ops_match:
        return xml
    ops = ops_match.group(1).upper()
    if "INSERT" in ops or "UPDATE" in ops or "DELETE" in ops:
        return xml
    xml = _FORM_BLOCK_RE.sub("", xml)
    xml = _BOTTOM_TOOLBAR_RE.sub("", xml)
    return xml


def _inject_cross_screen_sync(html: str, xml: str) -> str:
    """Deterministically injects the cross-screen data sync script into generated HTML.
    Asking the model to write this itself (via the prompt) proved unreliable across repeated
    attempts — this reads/writes the rendered <table> generically, so it works regardless of
    what internal JS variable names the model happened to use, with zero dependence on the
    model actually following that part of the prompt.

    Rows are keyed by each <column>'s real "binding" attribute (the actual field/column name,
    always present per the grid vocabulary rules), NOT by rendered header text — a header like
    "DOB" has no reliable reverse mapping to the real column "date_of_birth", but binding= does,
    which matters once this data needs to round-trip through a real database, not just memory."""
    entity_match = re.search(r"<entity>([^<]+)</entity>", xml)
    entity = entity_match.group(1).strip() if entity_match else None
    if not entity:
        return html
    lookups = sorted(set(re.findall(r'(?:dataSource|lookupEntity)="([^"]+)"', xml)) - {entity})
    bindings = re.findall(r'<column\b[^>]*\bbinding="([^"]+)"', xml)
    # The XML's <rule required="true"/> is the schema's actual source of truth for what's
    # mandatory, but whether the generated page's Save handler actually CHECKS it before saving
    # is up to the model — same reliability problem as the sync protocol itself. Extracting and
    # enforcing this deterministically means a required field can never silently "save
    # successfully" empty, regardless of what the generated JS does or doesn't check.
    required_fields = []
    for m in re.finditer(r'<field\s+([^>]*)>(.*?)</field>', xml, re.S):
        open_attrs, inner = m.group(1), m.group(2)
        if 'readonly="true"' in open_attrs:
            continue  # system/auto-populated (e.g. an autonumber) — never user-entered
        name_m = re.search(r'name="([^"]+)"', open_attrs)
        if name_m and re.search(r'<rule\b[^>]*\brequired="true"', inner):
            required_fields.append(name_m.group(1))
    # Fields the user never types into (readonly — an autonumber, or auto-populated from
    # another field) must be excluded when a new row gets deterministically built from the
    # form below, same reasoning as excluding them from required_fields above.
    readonly_fields = set()
    for m in re.finditer(r"<field\b([^>]*)>", xml):
        attrs = m.group(1)
        if 'readonly="true"' not in attrs:
            continue
        name_m = re.search(r'name="([^"]+)"', attrs)
        if name_m:
            readonly_fields.add(name_m.group(1))
    # A hub/landing screen's <navItem> buttons are real routing code in the actual generated
    # frontend deliverable (React Router Link, etc. — see XML_TO_HTML_PROMPT), but the
    # STANDALONE HTML preview has no router at all — it's one isolated iframe per screen, so
    # the AI is told to render a toast/stub there instead of pretending to navigate. That
    # means clicking a nav card in the Studio's live preview visibly does nothing. Fix this
    # deterministically: extract the real targetScreen/label pairs from the XML and have the
    # parent (Dashboard.jsx) actually switch the Studio to that screen on click, the same way
    # cross-screen data sync doesn't depend on the AI writing the wiring itself.
    nav_items = [
        {"targetScreen": m.group("target"), "label": m.group("label")}
        for m in re.finditer(r'<navItem\s+[^>]*\btargetScreen="(?P<target>[^"]+)"[^>]*\blabel="(?P<label>[^"]+)"', xml)
    ] or [
        {"targetScreen": m.group("target"), "label": m.group("label")}
        for m in re.finditer(r'<navItem\s+[^>]*\blabel="(?P<label>[^"]+)"[^>]*\btargetScreen="(?P<target>[^"]+)"', xml)
    ]
    script = f"""
<!-- TDIDE_SYNC_SCRIPT_START -->
<script>
(function() {{
  var TDIDE_ENTITY = {json.dumps(entity)};
  var TDIDE_LOOKUPS = {json.dumps(lookups)};
  var TDIDE_BINDINGS = {json.dumps(bindings)};
  var TDIDE_REQUIRED = {json.dumps(required_fields)};
  var TDIDE_NAV_ITEMS = {json.dumps(nav_items)};
  if (TDIDE_NAV_ITEMS.length) {{
    document.addEventListener("click", function(e) {{
      var el = e.target;
      for (var depth = 0; el && depth < 6; depth++, el = el.parentElement) {{
        var onclickAttr = el.getAttribute && el.getAttribute("onclick");
        for (var i = 0; i < TDIDE_NAV_ITEMS.length; i++) {{
          var item = TDIDE_NAV_ITEMS[i];
          // The AI's own stub usually still mentions the real target screen name inside its
          // onclick (e.g. showToast("Navigate to: X")) even though it doesn't act on it —
          // that's a more reliable signal than text-matching, so check it first. Fall back to
          // "this small-ish element's text starts with the nav item's label" (a nav card
          // typically shows the label as its own heading) for generations that don't.
          var matchesOnclick = onclickAttr && onclickAttr.indexOf(item.targetScreen) !== -1;
          var matchesText = !matchesOnclick && el.children && el.children.length <= 8 &&
            el.textContent && el.textContent.trim().indexOf(item.label) === 0;
          if (matchesOnclick || matchesText) {{
            try {{ window.parent.postMessage({{ type: "TDIDE_NAVIGATE", targetScreen: item.targetScreen }}, "*"); }} catch (err) {{}}
            return;
          }}
        }}
      }}
    }}, true);
  }}
  var TDIDE_READONLY = {json.dumps(sorted(readonly_fields))};
  var tdideObserver = null;
  // A grid re-render isn't always a real save — the page's own initial render from its
  // hardcoded sample data, a Refresh/Sort/Search click, or a simulated async-fetch delay (some
  // generations re-render from sample data ~500ms after load to fake a loading state) all fire
  // the same DOM mutations a genuine Save/Delete does. Gating on ANY click still let Refresh-type
  // clicks through, which reset the grid back to fake sample data and broadcast THAT. Only a
  // click on something that actually reads as a save/delete action should count.
  var tdideLastInteraction = 0;
  document.addEventListener("click", function(e) {{
    var el = e.target.closest("button, [role='button'], input[type='submit'], input[type='button'], a");
    if (!el) return;
    var text = (el.textContent || el.value || el.id || el.className || "").toLowerCase();
    if (!/save|delete|submit/.test(text)) return;
    tdideLastInteraction = Date.now();
    if (!/save|submit/.test(text)) return;  // Delete just needs the timing gate above, not this
    // The XML's required-field rules are the schema's actual source of truth — whether the
    // generated page's own Save handler checks them before claiming success is inconsistent
    // across generations. Block the click here, before the page's own handler runs, if a
    // required field is empty — so a "saved successfully" toast can never lie about a row that
    // was actually rejected (or silently missing data) because a mandatory field was blank.
    var missing = TDIDE_REQUIRED.filter(function(name) {{
      var field = document.getElementById(name);
      return field && !field.value;
    }});
    if (missing.length) {{
      e.preventDefault();
      e.stopImmediatePropagation();
      alert("Please fill in required field(s): " + missing.join(", "));
      tdideLastInteraction = 0;
      return;
    }}
    // The generated page's own Save handler is inconsistently reliable about actually
    // constructing a new row from the form — sometimes it just re-broadcasts whatever
    // sampleData already was, unchanged. Build and apply the new row deterministically here
    // instead (from TDIDE_BINDINGS -> matching form field by id, skipping readonly/system
    // fields like an autonumber), and block the page's own handler from running at all so it
    // can't immediately clobber this with stale data. This only handles CREATE (appending a
    // new row) — an in-place edit still depends on the page's own logic, which this does not
    // intercept for non-save-labeled interactions.
    var table = tdideFindGrid();
    if (table) {{
      var newRow = {{}};
      TDIDE_BINDINGS.forEach(function(binding) {{
        if (TDIDE_READONLY.indexOf(binding) !== -1) return;
        var field = document.getElementById(binding);
        if (field) newRow[binding] = field.value;
      }});
      var rows = tdideTableToRows(table).concat([newRow]);
      tdideApplyRows(table, rows);
      try {{
        window.parent.postMessage({{ type: "TDIDE_DATA_CHANGE", entity: TDIDE_ENTITY, rows: rows }}, "*");
      }} catch (err) {{}}
    }}
    e.preventDefault();
    e.stopImmediatePropagation();
  }}, true);

  function tdideFindGrid() {{
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {{
      if (tables[i].querySelector("tbody")) return tables[i];
    }}
    return null;
  }}
  function tdideHeaders(table) {{
    // Real column names (from the XML's binding= attrs) when available and the count lines up
    // with what actually rendered; otherwise fall back to rendered header text positionally.
    var thCount = table.querySelectorAll("thead th").length;
    if (TDIDE_BINDINGS.length === thCount) return TDIDE_BINDINGS.slice();
    var out = [];
    table.querySelectorAll("thead th").forEach(function(th) {{
      out.push(th.textContent.replace(/[\\u2191\\u2193\\u25b2\\u25bc]/g, "").trim());
    }});
    return out;
  }}
  function tdideTableToRows(table) {{
    var headers = tdideHeaders(table);
    var rows = [];
    table.querySelectorAll("tbody tr").forEach(function(tr) {{
      var obj = {{}};
      tr.querySelectorAll("td").forEach(function(td, i) {{ obj[headers[i] || ("col" + i)] = td.textContent.trim(); }});
      rows.push(obj);
    }});
    return rows;
  }}
  function tdideBroadcast() {{
    if (Date.now() - tdideLastInteraction > 2000) return;  // not user-driven — likely a passive/simulated re-render
    var table = tdideFindGrid();
    if (!table) return;
    try {{
      window.parent.postMessage({{ type: "TDIDE_DATA_CHANGE", entity: TDIDE_ENTITY, rows: tdideTableToRows(table) }}, "*");
    }} catch (e) {{}}
  }}
  function tdideApplyRows(table, rows) {{
    var headers = tdideHeaders(table);
    var tbody = table.querySelector("tbody");
    if (!tbody || !rows) return;
    if (tdideObserver) tdideObserver.disconnect();
    // An empty array is real, meaningful information (this table genuinely has no rows yet) —
    // it must still clear out whatever fake sample rows the page rendered on its own, not be
    // treated as "nothing to apply." Leaving fake rows in place is exactly what let them get
    // silently persisted alongside a user's first genuine save on an empty table.
    var out = "";
    rows.forEach(function(row) {{
      out += "<tr>";
      headers.forEach(function(h) {{
        var v = row[h];
        out += "<td>" + (v != null ? String(v).replace(/</g, "&lt;") : "") + "</td>";
      }});
      out += "</tr>";
    }});
    tbody.innerHTML = out;
    if (tdideObserver) tdideObserver.observe(tbody, {{ childList: true, subtree: true, characterData: true }});
  }}

  window.addEventListener("message", function(event) {{
    var msg = event.data;
    if (!msg || msg.type !== "TDIDE_INIT_DATA") return;
    var rows = msg.data && msg.data[TDIDE_ENTITY];
    if (!Array.isArray(rows)) return;
    // Some generated pages simulate an async data load (e.g. a fake fetch delay) that
    // re-renders the grid from its own hardcoded sample data shortly after page load,
    // which would silently overwrite this if applied only once. Re-apply a few times
    // over the following second so this update is the one that actually sticks.
    var applyNow = function() {{
      var table = tdideFindGrid();
      if (table) tdideApplyRows(table, rows);
    }};
    applyNow();
    setTimeout(applyNow, 400);
    setTimeout(applyNow, 900);
    setTimeout(applyNow, 1500);
  }});

  window.addEventListener("load", function() {{
    try {{
      window.parent.postMessage({{ type: "TDIDE_READY", entities: [TDIDE_ENTITY].concat(TDIDE_LOOKUPS) }}, "*");
    }} catch (e) {{}}
    var table = tdideFindGrid();
    var tbody = table && table.querySelector("tbody");
    if (tbody) {{
      tdideObserver = new MutationObserver(function() {{ tdideBroadcast(); }});
      tdideObserver.observe(tbody, {{ childList: true, subtree: true, characterData: true }});
    }}
  }});
}})();
</script>
<!-- TDIDE_SYNC_SCRIPT_END -->
"""
    # Idempotent: strip out any previously-injected copy first (identified by the marker
    # comments) so this can be safely re-run on already-generated HTML to pick up a fix to
    # the injected script itself — e.g. after a bug fix here — without a fresh AI call and
    # without accumulating duplicate <script> blocks each time it's re-applied.
    html = re.sub(r"\n?<!-- TDIDE_SYNC_SCRIPT_START -->.*?<!-- TDIDE_SYNC_SCRIPT_END -->\n?", "", html, flags=re.S)
    if "</body>" in html:
        return html.replace("</body>", script + "</body>", 1)
    return html + script


def _strip_markdown_fence(text: str) -> str:
    """Defensively strips a leading ```lang / trailing ``` if the model wrapped its output in a
    markdown code fence despite being told not to — observed happening occasionally with gpt-4o
    (image-reference mode) even though gpt-4o-mini rarely does it. Left untouched if no fence."""
    stripped = text.strip()
    m = re.match(r"^```[a-zA-Z]*\n(.*)\n```\s*$", stripped, flags=re.S)
    return m.group(1) if m else text


_THEME_VARS = ["--clr-primary", "--clr-primary-dark", "--clr-primary-light", "--clr-secondary", "--clr-secondary-dark",
               "--clr-header-bg", "--clr-bg", "--clr-surface", "--clr-border", "--clr-text", "--clr-muted",
               "--font-family", "--radius-card"]


def _extract_theme_from_html(html: str, density: str) -> dict | None:
    """Regex-extracts the :root custom properties a generated screen committed to, so they can be
    saved once (Project.ui_theme) and handed back as a hard override to every later screen in the
    same project — the same idea frontend/src/utils/theme.js uses client-side for recoloring,
    done here in Python since this runs server-side right after generation. None if no
    --clr-primary was found (nothing usable to lock)."""
    root_match = re.search(r":root\s*\{([^}]*)\}", html)
    if not root_match:
        return None
    block = root_match.group(1)
    theme = {}
    for var in _THEME_VARS:
        m = re.search(rf"{re.escape(var)}\s*:\s*([^;]+);", block)
        if m:
            theme[var] = m.group(1).strip()
    if "--clr-primary" not in theme:
        return None
    # Not every generation defines every variable in _THEME_VARS (observed in practice: a
    # DENSE-style screen that omitted --clr-header-bg/--clr-surface entirely) — fall back to a
    # close existing relative rather than leaving a gap that later screens would then derive
    # freshly on their own, quietly breaking consistency for just that one property.
    theme.setdefault("--clr-header-bg", theme.get("--clr-secondary-dark") or theme.get("--clr-primary-dark") or theme["--clr-primary"])
    theme.setdefault("--clr-surface", theme.get("--clr-bg") or "#FFFFFF")
    theme["density"] = density
    return theme


def _build_project_theme_section(theme: dict) -> str:
    lines = "\n".join(f"  {k}: {v};" for k, v in theme.items() if k != "density")
    density = theme.get("density", "CLEAN")
    return f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROJECT THEME — THIS OVERRIDES THE VISUAL IDENTITY SECTION ABOVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This application already has an established visual identity, committed to by an earlier screen in
this same project. Do NOT pick your own archetype, colors, font, or radius — use EXACTLY these:
{lines}
Also use LAYOUT DENSITY: {density} — follow that section's structural rules (spacing, card style,
header band, toolbar), but with the colors/font/radius given above instead of anything derived
there. This keeps every screen in the app looking like one consistent product, not a new design
each time. The XML is still the source of truth for WHAT controls/data exist — only the color
palette, typography, radius, and density are fixed by this override.
"""


async def generate_html_from_xml(xml: str, frontend_lang: str = "HTML/CSS", extra_instructions: list[str] | None = None,
                                  reference_image: str | None = None, usage_sink: list | None = None,
                                  project_theme: dict | None = None) -> str:
    if extra_instructions:
        notes = "\n".join(f"- {n}" for n in extra_instructions)
        extra_section = (
            "\nADDITIONAL USER REQUESTS — apply ALL of these. Some may be purely visual/behavioral "
            "tweaks (colors, spacing, which controls should be more/less prominent) that the XML "
            "above has no attribute for — apply them directly to the rendered output anyway, and "
            "let them OVERRIDE any conflicting default styling rule elsewhere in this prompt:\n"
            f"{notes}\n"
        )
    else:
        extra_section = ""
    image_section = IMAGE_REFERENCE_SECTION if reference_image else ""
    # A locked project theme is a hard override too, but an explicit reference image (a one-off
    # visual instruction for THIS screen) still wins if somehow both are present.
    theme_section = _build_project_theme_section(project_theme) if (project_theme and not reference_image) else ""
    prompt = XML_TO_HTML_PROMPT.format(xml=xml, frontend_lang=frontend_lang, extra_instructions_section=extra_section,
                                        project_theme_section=theme_section, image_reference_section=image_section)
    # A reference image (wireframe/screenshot) turns the user message into a multimodal content
    # list per OpenAI's standard image_url block — _call_openai passes messages straight through
    # with no transformation, so this needs no changes there.
    user_content = prompt if not reference_image else [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": reference_image, "detail": "high"}},
    ]
    # Image mode needs faithful copying, not creative reinterpretation, so it uses the
    # full gpt-4o (materially better vision fidelity than mini) at a much lower temperature
    # than the no-image path, which stays high/gpt-4o-mini for cheap design variety.
    call_kwargs = {"model": "gpt-4o", "temperature": 0.4} if reference_image else {"temperature": 0.9}
    html = await _call_openai([
        {"role": "system", "content": f"You are a senior UI/UX product designer who also writes production {frontend_lang} code. Design first — commit to a distinct visual identity (color, type, spacing, shape) before you touch markup — then implement it precisely and correctly. Return ONLY the complete output file for the chosen framework. No markdown fences."},
        {"role": "user", "content": user_content},
    ], timeout=180, usage_sink=usage_sink, **call_kwargs)  # visual/creative output — temperature=0 made every design collapse to the same "safest" choice
    html = _strip_markdown_fence(html)
    if frontend_lang == "HTML/CSS":
        html = _inject_cross_screen_sync(html, xml)
    return html


# Forced style hints for the 3 design variants offered when generating from a text prompt
# (no reference image). These reuse the archetype/density vocabulary already defined in
# XML_TO_HTML_PROMPT's VISUAL IDENTITY / LAYOUT DENSITY sections, so the model just needs to
# honor an explicit choice instead of making one — this is what guarantees the 3 results are
# visibly different, rather than leaving it to temperature chance (which tends to collapse to
# the same archetype for the same domain words).
_VARIANT_STYLE_HINTS = [
    ("Clean & Minimal", "LAYOUT DENSITY: use CLEAN (not DENSE). Pick whichever color archetype best fits the domain."),
    ("Bold & Colorful", "LAYOUT DENSITY: use CLEAN (not DENSE). Color archetype: use WARM CONSUMER or EDITORIAL BOLD "
                         "(whichever isn't the obvious/default choice for this domain) — a vivid, saturated, confident palette, not a muted one."),
    ("Compact & Dense", "LAYOUT DENSITY: use DENSE (not CLEAN), the full enterprise-console style with a dark header band and sticky bottom toolbar."),
]


async def generate_html_variants_from_xml(xml: str, frontend_lang: str = "HTML/CSS",
                                           extra_instructions: list[str] | None = None,
                                           usage_sink: list | None = None,
                                           project_theme: dict | None = None) -> list[dict]:
    """3 concurrent generate_html_from_xml calls, each forced toward a distinct visual style,
    so the caller can offer the user a real choice instead of one AI-picked look. Text-prompt
    mode only — pointless against a single reference image, so callers should not use this
    when a reference_image is set. Callers also shouldn't normally pass project_theme once a
    project already has one locked (offering 3 variants defeats the point of a shared theme),
    but it's threaded through defensively in case this is ever called at that point anyway."""
    base_instructions = list(extra_instructions or [])

    async def _one(label: str, hint: str) -> dict:
        # Sharing one usage_sink list across all 3 concurrent tasks is safe — asyncio is
        # single-threaded/cooperative, so concurrent list.append calls never race.
        html = await generate_html_from_xml(xml, frontend_lang=frontend_lang, extra_instructions=base_instructions + [hint],
                                             usage_sink=usage_sink, project_theme=project_theme)
        return {"label": label, "html": html}

    return await asyncio.gather(*(_one(label, hint) for label, hint in _VARIANT_STYLE_HINTS))


async def generate_api_from_xml(xml: str, backend_lang: str = "Python", frontend_lang: str = "React",
                                 usage_sink: list | None = None, require_auth: bool = False,
                                 entities: dict | None = None, send_email: bool = False) -> str:
    conventions = BACKEND_CONVENTIONS.get(backend_lang, "- Use idiomatic file/module naming for this language.")
    frontend_conventions = FRONTEND_CONVENTIONS.get(frontend_lang, "")
    auth_conventions_text = AUTH_CONVENTIONS.get(backend_lang, "- Use idiomatic hashing/JWT libraries and file layout for this language.")
    # Real database is the baseline for every CRUD screen now, not conditional like auth/email —
    # always threaded in. When the caller also has the real schema, name this screen's exact real
    # table/columns so the model can't invent or rename one that doesn't actually exist.
    db_conventions_text = DB_CONVENTIONS.get(
        backend_lang, "- Use a real embedded/local database for this language — never in-memory or hardcoded sample data.")
    entity_note = ""
    if entities:
        m = re.search(r"<entity>\s*([^<]+?)\s*</entity>", xml)
        if m:
            table = next((t for t in entities.get("tables", []) if t.get("name") == m.group(1).strip()), None)
            if table:
                cols = ", ".join(c["name"] for c in table.get("columns", []))
                entity_note = (
                    f"\n   This screen's real table is `{table['name']}` with real columns: {cols}. "
                    "Use these EXACT names — never invent, rename, or omit a column.\n"
                )
    db_conventions_section = f"{db_conventions_text}{entity_note}"
    email_conventions_text = EMAIL_CONVENTIONS.get(
        backend_lang, "- Use a real SMTP-based email send for this language, configured via environment variables — never fake a success.")
    email_conventions_section = f"   Email conventions for {backend_lang}:\n{email_conventions_text}\n" if send_email else ""
    # Only relevant when this screen's own XML is the <auth> screen — gives it the shared
    # module's exact import path/function names so its signup/login endpoints use the real
    # shared implementation instead of reinventing hashing/JWT inline.
    auth_module_section = f"   Auth module conventions for {backend_lang}:\n{auth_conventions_text}" if "<auth" in xml else ""
    # Applies to every OTHER screen once the project has a shared auth module — never passed for
    # the auth screen's own generation (its signup/login endpoints must stay unauthenticated).
    auth_requirement_section = (
        "\nAUTHENTICATION REQUIRED — this project already has a shared auth module generated. EVERY "
        "endpoint in routes.ext for THIS screen MUST require a valid access token and reject requests "
        f"without one, using the exact shared import/dependency pattern below:\n{auth_conventions_text}\n"
    ) if require_auth else ""
    # Frontend token handling: the auth screen stores what login/signup returns; every other
    # protected screen attaches it. Both read/write the same localStorage key so they interop —
    # this app's own frontend/src/api/client.js is the literal reference for the axios shape.
    if "<auth" in xml:
        auth_frontend_section = (
            "   AUTH TOKEN STORAGE — on a successful signup/login API response, store the returned "
            "access token in localStorage under the key \"token\" (Flutter: shared preferences under "
            "the same key name) so every other screen's api_service.ext can read it."
        )
    elif require_auth:
        auth_frontend_section = (
            "   AUTH TOKEN ATTACHMENT — this screen's endpoints require a token. api_service.ext MUST "
            "attach it as an `Authorization: Bearer <token>` header on every request, reading it from "
            "localStorage key \"token\" (Flutter: shared preferences). For axios-based frontends "
            "(React/Vue/Next.js/Svelte), add a request interceptor:\n"
            "     api.interceptors.request.use((config) => {\n"
            "       const token = localStorage.getItem(\"token\");\n"
            "       if (token) config.headers.Authorization = `Bearer ${token}`;\n"
            "       return config;\n"
            "     });\n"
            "   For Angular, use an HttpInterceptor with the same logic; for Flutter, add the header "
            "in the http service's request method."
        )
    else:
        auth_frontend_section = ""
    prompt = XML_TO_API_PROMPT.format(xml=xml, backend_lang=backend_lang, frontend_lang=frontend_lang,
                                       backend_conventions=conventions, frontend_conventions=frontend_conventions,
                                       auth_module_section=auth_module_section, auth_requirement_section=auth_requirement_section,
                                       auth_frontend_section=auth_frontend_section,
                                       db_conventions_section=db_conventions_section,
                                       email_conventions_section=email_conventions_section)
    code = await _call_openai([
        {"role": "system", "content": f"You are a full-stack developer. Generate {backend_lang} backend + {frontend_lang} frontend code. Use === FILENAME: name.ext === to separate files. Return ONLY code — never wrap any file in markdown code fences (```)."},
        {"role": "user", "content": prompt},
    ], timeout=180, usage_sink=usage_sink)
    if backend_lang == "Python":
        code = _fix_python_sibling_imports(code)
        if entities:
            code = _ensure_db_model_imports(code, entities)
    return code


def _fix_python_sibling_imports(api_code: str) -> str:
    """Deterministic fix for a real, pre-existing bug caught by an actual multi-screen pip-install
    run: routes.py and models.py always live together in the same per-screen folder
    (_backend_file_path: {slug}/routes.py, {slug}/models.py), but the model writes
    `from models import X` — a bare absolute import that only resolves if models.py sits at the
    repo root. With more than one screen, main.py's `from {slug}.routes import ...` makes each
    screen folder an (implicit namespace) package, and `from models import X` inside it raises
    ModuleNotFoundError at startup. `from .models import X` (relative to the same package) always
    resolves correctly regardless of the folder's actual name, so rewrite it rather than trying to
    get the AI to know its own slug."""
    return re.sub(r"^from models import", "from .models import", api_code, flags=re.MULTILINE)


_DB_MODELS_IMPORT_RE = re.compile(r"^from db_models import ([\w, ]+)$", re.MULTILINE)


def _ensure_db_model_imports(api_code: str, entities: dict) -> str:
    """Deterministic backstop for a real, repeatable model mistake: even when explicitly told to
    import every db_models class it references, the model sometimes references one (e.g. querying
    User inside an incidental uniqueness check on an otherwise unrelated endpoint) without adding
    the import — a NameError at request time, not a warning. Tuning the prompt wording further
    didn't fix it in testing, so this fixes it mechanically instead, the same lesson learned from
    the read-only-report <form>-stripping fix earlier."""
    table_names = [t.get("name") for t in entities.get("tables", []) if t.get("name")]
    if not table_names:
        return api_code

    # The model is supposed to substitute the real extension (routes.py) but sometimes echoes the
    # literal "routes.ext" placeholder from the prompt instead — match either, same defensive
    # reasoning as _backend_file_path forcing the real filename regardless of what the AI wrote.
    marker_match = re.search(r"=== FILENAME: routes\.\w+ ===", api_code)
    if not marker_match:
        return api_code
    body_start = marker_match.end()
    next_marker = api_code.find("=== FILENAME:", body_start)
    end = next_marker if next_marker != -1 else len(api_code)
    section = api_code[body_start:end]

    m = _DB_MODELS_IMPORT_RE.search(section)
    imported = {n.strip() for n in m.group(1).split(",") if n.strip()} if m else set()

    missing = [
        tname for tname in table_names
        if tname not in imported and re.search(rf"\b{re.escape(tname)}\s*[.(]", section)
    ]
    if not missing:
        return api_code

    if m:
        new_line = f"from db_models import {', '.join(sorted(imported | set(missing)))}"
        section = section[:m.start()] + new_line + section[m.end():]
    else:
        insertion = f"from db_models import {', '.join(missing)}\n"
        lines = section.splitlines(keepends=True)
        insert_at = 0
        for i, line in enumerate(lines):
            if line.startswith(("from ", "import ")):
                insert_at = i + 1
            elif line.strip() == "":
                continue
            else:
                break
        lines.insert(insert_at, insertion)
        section = "".join(lines)

    return api_code[:body_start] + section + api_code[end:]


def generate_er_diagram(entities: dict) -> str:
    """Deterministic Mermaid erDiagram — the schema is already fully known, so there's
    no need to ask the AI to reconstruct it (removes an API call and a failure mode)."""
    type_map = {
        "INT": "int", "INTEGER": "int", "TEXT": "string", "BOOLEAN": "bool",
        "DATE": "date", "TIMESTAMP": "timestamp", "DECIMAL": "decimal",
    }
    lines = ["erDiagram"]
    for table in entities.get("tables", []):
        lines.append(f"    {table['name']} {{")
        for col in table.get("columns", []):
            base_type = col.get("type", "VARCHAR").split("(")[0].upper()
            mermaid_type = type_map.get(base_type, "string")
            flag = " PK" if col.get("pk") else (" FK" if col.get("fk") else "")
            lines.append(f"        {mermaid_type} {col['name']}{flag}")
        lines.append("    }")

    seen_rels = set()
    for table in entities.get("tables", []):
        for col in table.get("columns", []):
            fk = col.get("fk")
            if not fk or "." not in fk:
                continue
            ref_table = fk.split(".")[0]
            key = (ref_table, table["name"])
            if ref_table != table["name"] and key not in seen_rels:
                seen_rels.add(key)
                lines.append(f'    {ref_table} ||--o{{ {table["name"]} : "has"')

    return "\n".join(lines)


# Real, live database wiring for the generated Python backend (SQLite by default, overridable via
# DATABASE_URL). Deterministic, not AI-generated — unlike auth.py, this needs zero per-project
# judgment: every project gets the exact same engine/session boilerplate, so there's no reason to
# spend a model call (or risk a hallucinated mistake) on it. Lands at the repo root, sibling of
# main.py/auth.py, importable the same way (see _db_module_path in github_service.py).
PYTHON_DATABASE_MODULE = '''import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Defaults to a local SQLite file so the generated app works immediately after
# `pip install -r requirements.txt && uvicorn main:app` with nothing else to set up. Point
# DATABASE_URL at a real Postgres/MySQL/etc connection string later if you want to.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
'''


_SQLALCHEMY_TYPE_ARGS_RE = re.compile(r"\(([^)]*)\)")


def _sql_type_to_sqlalchemy(col_type: str) -> str:
    """Maps this app's schema "type" strings (VARCHAR(50), DECIMAL(10,2), INT, DATE, TIMESTAMP,
    BOOLEAN, TEXT — see COLUMN_TYPE_RULES) to a SQLAlchemy column-type expression, as source text
    to embed in generated code. Mirrors the split-then-uppercase approach generate_er_diagram
    already uses (col_type.split("(")[0].upper()) rather than generate_sql's less reliable
    type_map.get(col_type.upper(), ...) which never matches a type that carries a "(...)" suffix."""
    raw = col_type or "VARCHAR"
    base = raw.split("(")[0].strip().upper()
    args_match = _SQLALCHEMY_TYPE_ARGS_RE.search(raw)
    args = args_match.group(1).strip() if args_match else ""
    if base == "VARCHAR":
        return f"String({args})" if args else "String(255)"
    if base == "TEXT":
        return "Text"
    if base in ("INT", "INTEGER"):
        return "Integer"
    if base == "DECIMAL":
        return f"Numeric({args})" if args else "Numeric(10, 2)"
    if base == "DATE":
        return "Date"
    if base == "TIMESTAMP":
        return "DateTime"
    if base == "BOOLEAN":
        return "Boolean"
    return "String(255)"


def generate_sqlalchemy_models(entities: dict) -> str:
    """Deterministic, non-AI conversion of project.entities into real SQLAlchemy ORM model
    classes — one per table — that the generated backend's routes actually read/write through.
    Same reasoning as generate_sql/generate_er_diagram: the schema is already fully known
    structured data, so there's no reason to ask the AI to reconstruct it and risk a mistake in
    something entirely mechanical. Becomes db_models.py at the repo root (see _db_module_path)."""
    tables = entities.get("tables", []) if entities else []
    used_types = set()
    class_blocks = []
    for table in tables:
        tname = table["name"]
        lines = [f'class {tname}(Base):', f'    __tablename__ = "{tname}"', ""]
        for col in table.get("columns", []):
            cname = col["name"]
            if col.get("pk"):
                used_types.add("Integer")
                lines.append(f"    {cname} = Column(Integer, primary_key=True, autoincrement=True)")
                continue
            sa_type = _sql_type_to_sqlalchemy(col.get("type", "VARCHAR"))
            used_types.add(sa_type.split("(")[0])
            attrs = []
            fk = col.get("fk")
            if fk and "." in fk:
                ref_table, ref_col = fk.split(".", 1)
                attrs.append(f'ForeignKey("{ref_table}.{ref_col}")')
            if not col.get("nullable", True):
                attrs.append("nullable=False")
            if col.get("unique"):
                attrs.append("unique=True")
            if col.get("default") == "now()":
                used_types.add("func")
                attrs.append("server_default=func.now()")
            attr_str = f", {', '.join(attrs)}" if attrs else ""
            lines.append(f"    {cname} = Column({sa_type}{attr_str})")
        class_blocks.append("\n".join(lines) + "\n")

    type_imports = sorted(t for t in used_types if t not in ("Integer", "func"))
    if "Integer" in used_types:
        type_imports.insert(0, "Integer")
    header = ["from sqlalchemy import Column, ForeignKey, " + ", ".join(type_imports or ["String"])]
    if "func" in used_types:
        header.append("from sqlalchemy.sql import func")
    header.append("from database import Base")
    header.append("")
    header.append("")
    return "\n".join(header) + "\n\n\n".join(class_blocks)


# Real email sending for the generated Python backend — stdlib smtplib, zero new dependency,
# configured entirely through env vars so it works with any SMTP provider (Gmail, Outlook, a
# company relay) with no third-party sign-up required. Deterministic for the same reason
# PYTHON_DATABASE_MODULE is: sending mail has no per-project variation to reason about. An
# unconfigured deployment fails loudly (RuntimeError) instead of silently pretending to send —
# that's the whole point of this being real instead of a fake success toast.
PYTHON_EMAIL_SERVICE_MODULE = '''import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)


def send_email(to: str, subject: str, body: str) -> None:
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASSWORD:
        raise RuntimeError(
            "Email is not configured — set SMTP_HOST, SMTP_USER, SMTP_PASSWORD "
            "(and optionally SMTP_PORT, SMTP_FROM) in your environment / .env file."
        )
    msg = MIMEMultipart()
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(SMTP_FROM, [to], msg.as_string())
'''
