import asyncio
import json
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
  }}
}}
- Only give a column an "autonumber" object when the user actually describes an auto-generated
  sequential/formatted identifier (invoice number, ticket code, employee code...). A plain
  surrogate "id" primary key is NOT an autonumber — leave its autonumber as null.
- An autonumbered column is always nullable:false, and usually also unique:true unless it's already the pk.
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

Return ONLY valid JSON in this exact format:
{{
  "tables": [ ...table objects, see shape below... ],
  "unresolved": [ ...see shape below, [] when nothing is ambiguous... ]
}}

""" + EXTENDED_SCHEMA_RULES + """

Rules:
""" + COLUMN_TYPE_RULES

REFINE_PROMPT = """You are a database architect. Given the current schema and the user's instruction, update the schema accordingly. Keep every table and column the instruction doesn't touch exactly as it already is, including any nullable/default/unique/autonumber/audit_enabled/history_enabled/validations fields already present — never strip or reset them just because a table happened to pass through this step.

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

SCREEN_INTENT_PROMPT = """You are a UI/UX architect analyzing a screen request. The description below may describe ONE screen, or it may describe MULTIPLE distinct screens (e.g. "one screen for X, another screen for Y", "also add a screen to...", or a list of separate unrelated forms/pages).

Description:
<screen_request>
{description}
</screen_request>

Split the description into one entry per distinct screen it implies. If it only describes a single screen, return exactly one entry.

Return ONLY valid JSON in this exact format:
{{
  "screens": [
    {{"name": "Short Screen Name", "description": "Self-contained description of what THIS screen alone should contain — rewritten so it makes sense without referencing the other screens."}}
  ]
}}

Rules:
- Keep each "name" short (2-5 words), Title Case
- Each "description" must stand alone and preserve every relevant detail from the original text for that screen — do not drop information, just split it correctly
- Do not invent screens that are not implied by the text
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
   - ONLY include buttons explicitly needed — no extra buttons

7. <dataBindings> — entity bindings with allowed operations (SELECT, INSERT, UPDATE, DELETE)

8. <accessibility> — ariaLabel, tabOrder

9. <navigation> — ONLY for a landing/hub/dashboard screen whose job is to route to other screens
   (not a data CRUD screen). Contains one <navItem> per destination, each with:
   targetScreen="ExactScreenName" (MUST exactly match a real screen name provided in the prompt
   context — never invent a screen name that wasn't given to you), label, description, icon
   (a short keyword like "users", "reports", "settings" — not an emoji/SVG, just a hint word).
   Use this element instead of a <form>/<grid> when the screen description signals it's a
   navigation hub / landing page / dashboard that links out to other screens.

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
- ID/code columns in grids MUST be rendered as clickable links/hyperlinks.
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
- Every form/bottom-toolbar button (save, clear, delete, cancel) MUST have a real onclick handler:
  since there's no backend, simulate the effect against local state (e.g. clear empties the form,
  delete removes/greys the row and shows a brief confirmation, save shows a success message) —
  never leave a button with no handler at all.
- select/dropdown fields with dataSource MUST be populated with real <option> entries derived from
  that entity's sample rows, not left empty.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VISUAL IDENTITY — pick ONE archetype below that best fits this specific screen's module/title/purpose text, then commit to it fully (color family AND typography AND corner roundedness AND shadow depth all come from the same archetype — don't mix them). Read the actual domain words in the XML closely and choose deliberately; do not default to the same archetype every time out of habit — two different screens should usually end up looking different unless their domains are genuinely similar.

The hex codes below are only illustrative of each hue FAMILY, not fixed values — pick your own specific shade within that family (vary saturation/lightness) rather than reusing these exact codes. Every generation should land on a slightly different exact hex even within the same archetype.

1. MODERN SAAS — general business tools, dashboards, internal tools: primary hue somewhere in the indigo/violet family, roughly #4F46E5-#8B5CF6-#6D28D9; font 'Inter', system-ui; card radius 10-12px; soft diffused shadows (0 1px 3px rgba(0,0,0,0.08)); spacious padding.
2. ENTERPRISE CONSOLE — ERP, ops, admin, procurement, logistics: primary hue somewhere in the steel-blue/slate family, roughly #1E3A5F-#334155-#0F4C75; font 'Roboto', 'Segoe UI', system-ui; sharper card radius 4-6px; flatter/tighter shadows; denser padding.
3. CLINICAL — healthcare, patient records, labs, clinics: primary hue somewhere in the teal/cyan family, roughly #0D9488-#0891B2-#0E7490; font 'Inter', 'Source Sans Pro'; card radius 8px; crisp light shadows; high contrast, generous whitespace.
4. FINTECH PRECISION — banking, accounting, billing, payments, audits: primary hue somewhere in the deep emerald/navy family, roughly #065F46-#14532D-#1E3A5F; font 'IBM Plex Sans', 'Inter'; card radius 6px; monospace for all currency/numeric values; tight, precise spacing.
5. WARM CONSUMER — hospitality, booking, retail, food, community, anything customer-facing and friendly: primary hue somewhere in the coral/amber/warm-orange family, roughly #F97316-#EA580C-#DC2626-#D97706; font 'Poppins', 'Nunito', system-ui; rounder card radius 14-16px; soft warm shadows; generous friendly spacing.
6. EDITORIAL BOLD — creative, media, marketing, content/portfolio tools: primary hue somewhere in the deep purple/magenta family, roughly #7C3AED-#A21CAF-#BE185D; font 'Poppins', 'Manrope'; card radius 12px; bold high-contrast headers; slightly asymmetric shadow depth.

If colors ARE specified in the XML, use those exact color values for --clr-primary and derive the rest of the palette from them, but still pick the archetype's typography/radius/shadow personality that best matches the domain.

Derive EVERY other color from your chosen --clr-primary — nothing below is a fixed value:
- --clr-bg: a very light, barely-tinted neutral leaning toward --clr-primary's hue (NOT a fixed gray — e.g. a warm archetype gets a warm-tinted off-white, a cool archetype gets a cool-tinted off-white)
- --clr-header-bg: a dark, deeply saturated shade of --clr-primary itself (not an unrelated dark blue) — this is what makes the header visually match the rest of the identity
- --clr-surface, --clr-border, --clr-text, --clr-muted: neutral tones consistent with the chosen hue family's temperature (warm hues get warm-leaning neutrals, cool hues get cool-leaning neutrals)
- --clr-danger stays a clear red regardless of archetype, for universal recognizability

Define the full palette and chosen typography/radius as CSS custom properties so the rest of the page can reference them consistently:
--clr-primary, --clr-primary-dark, --clr-primary-light, --clr-danger, --clr-border, --clr-bg, --clr-surface, --clr-text, --clr-muted, --clr-header-bg, --font-family, --radius-card

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

5. LIST CARD — separate white card below the form card, same soft style, margin-top 20px.
   - Header row inside the card: bold 14-15px title + a light count pill
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
   - Header: bold 14px title + count pill; search input + "Export CSV" ghost button on the right
   - Table fills edge to edge: sticky #F8FAFC thead, uppercase 11px/600 #6B7280 th, sortable columns show ↑↓ arrows, td padding 10px 16px, ID column renders as a monospace link, zebra rows, row hover #EEF4FF
   - Pagination row: "Showing X to Y of Z entries" + page pills

5. STICKY BOTTOM ACTION TOOLBAR — position fixed bottom 0, white bg, top border, shadow; buttons padding 8px 20px/600/radius 6px. Save = primary bg white text + <kbd>Ctrl+S</kbd> pill; Clear = white/bordered; Delete = #DC2626; Cancel = margin-left auto, transparent. ONLY render buttons present in the XML toolbar.

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

──────────────────────────────
<navigation> RENDERING (landing/hub screens only — replaces the form+grid layout entirely):
──────────────────────────────
- Render as a responsive card grid below the header (CSS grid, minmax(240px, 1fr), gap 20px, padding matching the archetype).
- One card per <navItem>: white card, border-radius var(--radius-card), border 1px solid var(--clr-border), padding 24px, cursor pointer, hover lifts slightly (translateY(-2px) + deeper shadow, transition 0.15s).
- Each card shows: a small colored icon badge derived from the item's icon keyword (a 40px circle tinted with --clr-primary, first letter or a simple glyph — no external icon library), the navItem's label as 15px/600 title, its description as 13px muted text below.
- This is a PREVIEW with no real router behind it, so clicking a card MUST still do something real and visible: show a toast reading exactly `Navigate to: {{targetScreen}}` (reuse the toast pattern from the SHARED section below) — never a dead card with no handler.
- Do NOT render a form, grid, or bottom action toolbar on a screen that has a <navigation> element — it replaces them, it doesn't sit alongside them.

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
- Grid search: typing filters rows in real-time across all columns; count badge updates
- Pagination: slice data per page; clicking page number re-renders rows
- Ctrl+S keyboard shortcut triggers save (where applicable in framework)
- Delete button opens confirmation modal; confirm triggers delete logic + shows toast
- Clear button resets all form fields
- Toast shows on save success/failure; auto-dismisses after 3 seconds

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
{extra_instructions_section}
XML UI Definition:
<xml_ui_definition>
{xml}
</xml_ui_definition>

Return ONLY the complete output file for the chosen framework, with all styles and logic included. No explanations, no markdown fences."""

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

STRUCTURAL CONVENTIONS — follow these exactly. A separate assembler places your files into a real runnable project (entrypoint, dependency manifest, folder layout) by relying on these exact names/exports — deviating breaks the build:
{backend_conventions}

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


async def _call_openai(messages: list, use_json: bool = False, timeout: int = 60, temperature: float = 0, max_retries: int = 2) -> str:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY not configured. Add it to your .env file.")

    body = {
        "model": "gpt-4o-mini",
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


async def extract_entities(description: str, features: str) -> dict:
    user_message = (
        f"<project_description>\n{description}\n</project_description>\n\n"
        f"<detailed_features>\n{features}\n</detailed_features>"
    )
    text = await _call_openai([
        {"role": "system", "content": EXTRACT_PROMPT.format()},
        {"role": "user", "content": user_message},
    ], use_json=True)
    return json.loads(text.strip())


async def refine_entities(entities: str, instruction: str) -> dict:
    prompt = REFINE_PROMPT.format(entities=entities, instruction=instruction)
    text = await _call_openai([
        {"role": "system", "content": "You are a database architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True)
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


async def schema_assistant_edit_table(table: dict, other_tables: list[dict], instruction: str) -> dict:
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
    ], use_json=True)
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


async def interpret_requirement(requirement: str, entities: dict | None, screens: list | None, validation_rules: str | None) -> dict:
    context = _workbench_context(entities, screens, validation_rules)
    user_message = f"<current_project_state>\n{context}\n</current_project_state>\n\n<new_requirement>\n{requirement}\n</new_requirement>"
    text = await _call_openai([
        {"role": "system", "content": ARCHITECT_WORKBENCH_PROMPT},
        {"role": "user", "content": user_message},
    ], use_json=True, timeout=90)
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


async def generate_entity_code(entities: dict, language: str) -> str:
    prompt = ENTITY_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2),
    )
    code = await _call_openai([
        {"role": "system", "content": "You generate code split into separate files. Every file MUST be preceded by a line: === FILENAME: name.ext === on its own line. Never combine multiple classes in one file."},
        {"role": "user", "content": prompt},
    ])
    return _ensure_file_splits(code, language)


async def edit_validation_code(instruction: str, existing_code: str, entities: dict | None, language: str) -> str:
    prompt = VALIDATION_EDIT_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        existing_code=existing_code,
        instruction=instruction,
    )
    code = await _call_openai([
        {"role": "system", "content": "You edit existing code files and create new ones. Every file MUST be preceded by: === FILENAME: name.ext === on its own line. Output ALL files including unchanged ones. Never combine multiple classes in one file."},
        {"role": "user", "content": prompt},
    ])
    return _ensure_file_splits(code, language)


async def generate_ui_code(description: str, entities: dict | None, language: str) -> str:
    prompt = UI_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        description=description,
    )
    return await _call_openai([
        {"role": "system", "content": f"You are a UI code generator for {language}. Return ONLY code."},
        {"role": "user", "content": prompt},
    ])


async def detect_screen_intents(description: str) -> dict:
    prompt = SCREEN_INTENT_PROMPT.format(description=description)
    text = await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True)
    data = json.loads(text.strip())
    if not data.get("screens"):
        data["screens"] = [{"name": description[:40].strip(), "description": description}]
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


async def refine_ui_xml(xml: str, instruction: str) -> dict:
    prompt = REFINE_UI_XML_PROMPT.format(xml=xml, instruction=instruction)
    text = await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True)
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


async def generate_ui_metadata(page: str, table_blocks: str) -> dict:
    prompt = UI_METADATA_PROMPT.replace("__PAGE__", page).replace("__TABLES__", table_blocks)
    text = await _call_openai([
        {"role": "system", "content": "You are a UI metadata generator. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True)
    return json.loads(text.strip())


_METADATA_CONTROL_TO_FIELD_TYPE = {
    "hidden": "text", "dropdown": "select", "checkbox": "checkbox", "date_picker": "date",
    "time_picker": "time", "email_input": "email", "phone_input": "phone", "password_input": "password",
    "url_input": "url", "color_picker": "color", "file_upload": "file", "textarea": "textarea",
    "number_input": "number", "text_input": "text",
}


def _humanize(name: str) -> str:
    return " ".join(w.capitalize() for w in name.replace("-", "_").split("_"))


def _metadata_to_form_xml(metadata: dict, fk_targets: dict | None = None) -> str:
    """Deterministic, non-AI conversion of the metadata generator's fields+layout JSON into
    <fieldset>/<field> XML matching this app's screen vocabulary — hidden fields are dropped,
    composite fields become one <fieldset> grouping their sub-columns, section order/grouping
    from "layout" is preserved as fieldset order. fk_targets maps "table.column" -> the real
    referenced table name, for the subset of "select" fields that are genuine FK lookups."""
    def _norm_key(table, column):
        # The metadata generator normalizes table names on its own (lowercases, sometimes
        # singularizes) independent of our real table names, e.g. "Students" -> "student" —
        # match loosely by column name + a fuzzy table match instead of an exact string.
        return (table.rstrip("s").lower(), column.lower())

    fk_targets_norm = {}
    for key, target in (fk_targets or {}).items():
        tbl, col = key.rsplit(".", 1)
        fk_targets_norm[_norm_key(tbl, col)] = target

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
            # "select" catches both true FK lookups (rule 2) and plain status/category/_code
            # dropdowns (rule 13) — only the former has a real table to point dataSource at.
            fk_target = fk_targets_norm.get(_norm_key(table, column))
            extra = f' dataSource="{fk_target}" valueField="id" displayField="name"' if ftype == "select" and fk_target else ""
            return f'{indent}<field name="{column}" label="{label or _humanize(column)}" type="{ftype}"{extra}/>'

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
                           screen_name: str = "", screen_entities: list[str] | None = None) -> str:
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
    # richer metadata pipeline only applies to single/few-entity CRUD-style screens.
    prebuilt_form_section = ""
    if entities and screen_entities and len(screen_entities) <= 3:
        table_blocks, fk_targets = _entity_table_blocks(entities, screen_entities)
        if table_blocks:
            try:
                metadata = await generate_ui_metadata(screen_name or "Screen", table_blocks)
                form_xml = _metadata_to_form_xml(metadata, fk_targets)
                prebuilt_form_section = (
                    "\nA <form> section has already been designed for this screen using richer "
                    "field-control inference than you'd do alone (proper email/phone/url/color/file "
                    "inputs, checkboxes for booleans, composite fieldsets for address/name/date-range "
                    "groups). COPY IT BYTE-FOR-BYTE as the screen's <form> element. This OVERRIDES every "
                    "other rule above about how to build a <form> — do not add, remove, or infer a "
                    "dataSource/valueField/displayField/rule/hint/autoFill on ANY of these fields even "
                    "if the general field-type rules above would normally call for one, do not change "
                    "any type= value, do not add or remove fields, do not reorder or rename anything. "
                    "Treat the block below as an opaque, already-finished string to paste in unmodified — "
                    "build everything else around it (header, grid if a list view is warranted, bottom "
                    "toolbar, navigation if applicable, dataBindings, accessibility):\n"
                    f"{form_xml}\n"
                )
            except Exception:
                prebuilt_form_section = ""  # fall through to the AI designing the form itself

    prompt = UI_XML_PROMPT.format(
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        description=description,
        existing_screens_section=existing_screens_section + prebuilt_form_section,
    )
    return await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid XML."},
        {"role": "user", "content": prompt},
    ])


async def generate_html_from_xml(xml: str, frontend_lang: str = "HTML/CSS", extra_instructions: list[str] | None = None) -> str:
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
    prompt = XML_TO_HTML_PROMPT.format(xml=xml, frontend_lang=frontend_lang, extra_instructions_section=extra_section)
    return await _call_openai([
        {"role": "system", "content": f"You are a senior UI/UX product designer who also writes production {frontend_lang} code. Design first — commit to a distinct visual identity (color, type, spacing, shape) before you touch markup — then implement it precisely and correctly. Return ONLY the complete output file for the chosen framework. No markdown fences."},
        {"role": "user", "content": prompt},
    ], timeout=180, temperature=0.9)  # visual/creative output — temperature=0 made every design collapse to the same "safest" choice


async def generate_api_from_xml(xml: str, backend_lang: str = "Python", frontend_lang: str = "React") -> str:
    conventions = BACKEND_CONVENTIONS.get(backend_lang, "- Use idiomatic file/module naming for this language.")
    prompt = XML_TO_API_PROMPT.format(xml=xml, backend_lang=backend_lang, frontend_lang=frontend_lang, backend_conventions=conventions)
    return await _call_openai([
        {"role": "system", "content": f"You are a full-stack developer. Generate {backend_lang} backend + {frontend_lang} frontend code. Use === FILENAME: name.ext === to separate files. Return ONLY code — never wrap any file in markdown code fences (```)."},
        {"role": "user", "content": prompt},
    ], timeout=180)


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
