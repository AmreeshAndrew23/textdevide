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

EXTRACT_PROMPT = """You are a database architect. Given the project description and features, extract all database entities (tables) with their columns, primary keys, and foreign keys.

Return ONLY valid JSON in this exact format:
{
  "tables": [
    {
      "name": "TableName",
      "columns": [
        {"name": "id", "type": "INT", "pk": true, "fk": null},
        {"name": "user_id", "type": "INT", "pk": false, "fk": "Users.id"},
        {"name": "full_name", "type": "VARCHAR(100)", "pk": false, "fk": null},
        {"name": "email", "type": "VARCHAR(255)", "pk": false, "fk": null},
        {"name": "date_of_birth", "type": "DATE", "pk": false, "fk": null}
      ]
    }
  ]
}

Rules:
""" + COLUMN_TYPE_RULES

REFINE_PROMPT = """You are a database architect. Given the current schema and the user's instruction, update the schema accordingly.

Current schema:
<current_schema>
{entities}
</current_schema>

User's instruction:
<user_instruction>
{instruction}
</user_instruction>

Rules:
""" + COLUMN_TYPE_RULES + """

Return ONLY the updated valid JSON in the same format (with "tables" array containing table objects with "name" and "columns")."""

ARCHITECT_WORKBENCH_PROMPT = """You are a senior software architect helping translate a plain-language requirement into concrete implementation impacts for an application: database schema, UI screens, and business validation rules.

You will be given the CURRENT state of the project (schema, screens, validation rules — any of which may be empty) and a NEW requirement in plain language. Determine the FULL resulting project state after applying the requirement, plus a human-readable summary of what changed.

Return ONLY valid JSON in exactly this shape:
{
  "changes": {
    "db_schema_changes": [{"action_type": "add|modify|remove", "entity_name": "...", "column_name": "..."}],
    "table_catalog": [{"entity_name": "...", "description": "one-line description of what this table stores, used for query routing"}],
    "ui_screens": [{"screen_name": "...", "ui_field_name": "...", "action": "what to do, e.g. 'add text input field for user name, required'"}],
    "business_rules": [{"rule_name": "...", "rule_description": "...", "action": "add|modify|remove"}]
  },
  "entities": {"tables": [{"name": "TableName", "columns": [{"name": "id", "type": "INT", "pk": true, "fk": null}]}]},
  "screens": [{"name": "Short Screen Name", "description": "self-contained description of everything this screen should contain"}],
  "validation_rules": "plain-language description of ALL business rules (existing + new) combined into one readable block of text"
}

Rules:
- "changes" lists ONLY what is new or different because of this specific requirement — a diff for the user to review, not the entire project
- "entities", "screens", and "validation_rules" must reflect the FULL resulting project state (existing state merged with this requirement), not just the diff
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

UI_XML_PROMPT = """You are a UI/UX architect. Given a screen description and database schema, generate a complete XML UI definition.

Database Schema:
<database_schema>
{entities}
</database_schema>

Screen Description:
<screen_description>
{description}
</screen_description>

Generate a well-structured XML that defines the entire screen. Include:

1. <screen> root with id, title, module, purpose attributes
   - purpose: one sentence describing what this screen does and why it is useful (e.g. "Manage department records — add, update, and remove departments used across the organisation.")

2. <metadata> — entity, dataSource table, screen modes (CREATE, EDIT, VIEW)

3. <header> — title, subtitle, breadcrumb

4. <form> with <fieldset> groups containing fields. Use the CORRECT type for each field:
   - type="select"   → dropdown. Add dataSource="EntityName" valueField="id" displayField="name". Renders as <select> with options.
   - type="lookup"   → text input WITH a lookup/search button beside it. Add lookupEntity="EntityName" lookupField="field". Clicking the button opens a search. Use when user says "lookup", "search button", or "with a button".
   - type="text"     → plain text input
   - type="number"   → numeric input
   - type="date"     → date picker
   - type="textarea" → multi-line text
   - Add readonly="true" on fields that auto-populate from another field (e.g. name filled after selecting a code). These render as disabled/greyed inputs.
   - Add autoFill="from:fieldId" to indicate which field triggers the auto-population.
   - <rule> children for validation (required, pattern, unique, maxLength, minValue, maxValue)
   - <hint> for helper text
   - NEVER generate radio buttons. Use <select> for choices.

5. <grid> for read-only display tables:
   - readonly="true" on the grid element
   - <column> with id, header, binding, width, sortable="true|false", filterable="true|false"
   - First ID column must have hyperlink="true" so the ID becomes a clickable link
   - <toolbar> with search input (placeholder "Search..."), count badge, refresh and export-csv actions
   - pagination, pageSize, emptyMessage attributes
   - Include 8–10 realistic sample <row> data entries inside a <sampleData> block

6. <toolbar position="bottom"> with action buttons (save, clear, delete, cancel only)
   - Include type, label, style (primary|secondary|danger|ghost), shortcut, confirmation attributes
   - ONLY include buttons explicitly needed — no extra buttons

7. <dataBindings> — entity bindings with allowed operations (SELECT, INSERT, UPDATE, DELETE)

8. <accessibility> — ariaLabel, tabOrder

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
LAYOUT STRUCTURE (follow exactly in this order):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL LAYOUT RULE: This is a DESKTOP WEB APPLICATION. The layout must be FULL WIDTH — do NOT use max-width containers, do NOT center content. It must fill the entire browser window like enterprise software (SAP, Oracle, Salesforce). Think 1440px monitor, not mobile.

1. PAGE WRAPPER
   - background: var(--clr-bg) — the tinted off-white you derived above, NOT a fixed gray
   - min-height: 100vh
   - width: 100%
   - font-family: var(--font-family) (from the archetype you picked above)
   - NO max-width. NO margin: auto centering. Content fills the full viewport width.
   - Padding: 0 0 80px 0 (bottom only for toolbar clearance)

2. TOP HEADER BAND (full-width)
   - width: 100%, background: var(--clr-header-bg) — the dark saturated shade of --clr-primary you derived above
   - padding: 20px 40px
   - Module name: 11px uppercase letter-spacing 0.1em color: rgba(255,255,255,0.55)
   - Page title: 24px font-weight 700 color: white, margin-top 4px
   - Purpose line: 13px italic color: rgba(255,255,255,0.5), margin-top 4px (from XML purpose attribute)

3. FORM CARD (white, border-radius var(--radius-card), box-shadow matching the archetype's shadow depth, border 1px solid var(--clr-border), margin: 24px 40px 0)
   - Card header bar: background #F8FAFC, padding 12px 20px, border-bottom 1px solid var(--clr-border)
     * Title only — plain bold 14px text, no icons, no radio buttons, no decorative elements
   - Card body: padding 24px 28px
   - Fields in a two-column label+input layout:
     * Label column: 160px wide, font-size 13px, font-weight 500, color #374151
     * Required asterisk: color var(--clr-danger)
     * Input: flex:1, border 1.5px solid var(--clr-border), border-radius 6px, padding 8px 12px, font-size 14px
     * ID/code inputs: font-family monospace, letter-spacing 0.05em
     * Focus: border-color var(--clr-primary), box-shadow 0 0 0 3px rgba(var(--clr-primary-rgb),0.12)
     * Error message: 12px color var(--clr-danger), margin-top 4px, hidden by default
   - FIELD TYPE RENDERING RULES (critical — follow exactly):
     * type="select" → render as <select> dropdown with realistic sample <option> values from sampleData or inferred from domain. NEVER render as <input type="text">.
     * type="lookup" → render as a row with: text <input> (flex:1) + adjacent "🔍 Lookup" button (background var(--clr-primary), color white, border-radius 6px, padding 8px 14px, no border, cursor pointer, margin-left 8px). Clicking shows an alert or inline modal stub.
     * readonly="true" → render as <input disabled> with background #F1F5F9, color #6B7280, cursor not-allowed. Label shows "(auto)" in muted text.
     * autoFill fields → add JS so selecting/entering the source field updates the readonly target field with a realistic value.
   - Fieldset: HTML <fieldset> + <legend> uppercase 10.5px letter-spacing 0.08em color #9CA3AF, margin-bottom 20px

4. LIST/GRID CARD (same card style as form card, margin: 20px 40px 0)
   - Card header bar: left side has bold 14px title + row count badge (e.g. "12 of 12" in a pill shape)
     * Right side: search input (with SVG magnifier icon, placeholder "Search...") + "Export CSV" ghost button
   - Table inside card body (no padding — table fills edge to edge):
     * border-collapse: collapse, width 100%
     * <thead>: background #F8FAFC, position sticky top 0
     * <th>: uppercase 11px letter-spacing 0.07em font-weight 600 color #6B7280, padding 10px 16px, border-bottom 2px solid var(--clr-border), cursor pointer (if sortable)
     * Sortable columns show "↑↓" by default; active sort shows "↑" or "↓" in var(--clr-primary)
     * <td>: padding 10px 16px, font-size 14px, border-bottom 1px solid #F1F5F9
     * ID column <td>: font-family monospace; render value as <a href="#" class="id-link"> with color var(--clr-primary), text-decoration none, font-weight 600
     * ID link hover: text-decoration underline
     * Alternating rows: odd rows white, even rows #FAFAFA
     * Row hover: background #EEF4FF
     * Empty state: single <td colspan="N"> centered, italic, muted gray
   - Pagination row below table (inside card, padding 10px 16px, border-top 1px solid #F1F5F9):
     * Left: "Showing X to Y of Z entries" in 13px muted
     * Right: page number pills (border 1px solid var(--clr-border), border-radius 4px, padding 4px 10px)
     * Active page pill: background var(--clr-primary) color white border-color var(--clr-primary)

5. STICKY BOTTOM ACTION TOOLBAR
   - position: fixed; bottom: 0; left: 0; right: 0
   - background white, border-top 1px solid #E2E8F0, box-shadow 0 -2px 8px rgba(0,0,0,0.06)
   - Inner wrapper: width 100%, padding 10px 40px, display flex, align-items center, gap 10px
   - Button sizing: padding 8px 20px, font-size 13.5px, font-weight 600, border-radius 6px, cursor pointer, transition 120ms
   - Save button: background var(--clr-primary) color white border none — after button text show a small keyboard badge: <kbd>Ctrl+S</kbd> styled as 10px monospace gray pill
   - Clear button: background white color #374151 border 1.5px solid #D1D5DB hover bg #F9FAFB
   - Delete button: background #DC2626 color white border none hover bg #B91C1C
   - Cancel button: margin-left auto background transparent color #6B7280 border none hover color #111 hover underline
   - Button active state: transform scale(0.97)
   - ONLY render buttons that appear in the XML toolbar. No extra buttons.

6. CONFIRMATION MODAL (for delete)
   - Overlay: position fixed inset 0 background rgba(15,23,42,0.45) display none
   - Dialog: background white border-radius 12px max-width 380px margin auto mt 20vh padding 28px box-shadow 0 20px 60px rgba(0,0,0,0.2)
   - Title 18px bold, body text 14px muted, buttons row: Cancel (ghost) + Confirm Delete (danger)

7. TOAST NOTIFICATION
   - Fixed bottom-right: bottom 90px right 24px (above toolbar)
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
- No radio buttons anywhere on the page
- All sortable columns have sort arrows
- ID column values are hyperlinks/clickable
- Purpose sentence appears below the title
- Sample data rows are realistic (8-10 rows)
- All XML fields, buttons, and grid columns are mapped

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

3. JSON API CONTRACTS FILE (api_contracts.json) — complete endpoint documentation:
   - For EVERY endpoint: method, path, description, which button triggers it
   - Request body JSON with sample data
   - Response JSON with sample data
   - Query parameters with descriptions
   - Error response examples

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

XML UI Definition:
<xml_ui_definition>
{xml}
</xml_ui_definition>

Return ONLY code with === FILENAME: === separators, no explanations."""


async def _call_openai(messages: list, use_json: bool = False, timeout: int = 60, temperature: float = 0) -> str:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY not configured. Add it to your .env file.")

    body = {
        "model": "gpt-4o-mini",
        "messages": messages,
        "temperature": temperature,
    }
    if use_json:
        body["response_format"] = {"type": "json_object"}

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


async def extract_entities(description: str, features: str) -> dict:
    user_message = (
        f"<project_description>\n{description}\n</project_description>\n\n"
        f"<detailed_features>\n{features}\n</detailed_features>"
    )
    text = await _call_openai([
        {"role": "system", "content": EXTRACT_PROMPT},
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


async def generate_ui_xml(description: str, entities: dict | None) -> str:
    prompt = UI_XML_PROMPT.format(
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        description=description,
    )
    return await _call_openai([
        {"role": "system", "content": "You are a UI/UX architect. Return ONLY valid XML."},
        {"role": "user", "content": prompt},
    ])


async def generate_html_from_xml(xml: str, frontend_lang: str = "HTML/CSS") -> str:
    prompt = XML_TO_HTML_PROMPT.format(xml=xml, frontend_lang=frontend_lang)
    return await _call_openai([
        {"role": "system", "content": f"You are a senior UI/UX product designer who also writes production {frontend_lang} code. Design first — commit to a distinct visual identity (color, type, spacing, shape) before you touch markup — then implement it precisely and correctly. Return ONLY the complete output file for the chosen framework. No markdown fences."},
        {"role": "user", "content": prompt},
    ], timeout=180, temperature=0.9)  # visual/creative output — temperature=0 made every design collapse to the same "safest" choice


async def generate_api_from_xml(xml: str, backend_lang: str = "Python", frontend_lang: str = "React") -> str:
    prompt = XML_TO_API_PROMPT.format(xml=xml, backend_lang=backend_lang, frontend_lang=frontend_lang)
    return await _call_openai([
        {"role": "system", "content": f"You are a full-stack developer. Generate {backend_lang} backend + {frontend_lang} frontend code. Use === FILENAME: name.ext === to separate files. Return ONLY code."},
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
