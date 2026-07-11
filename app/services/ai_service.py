import json
import httpx
from app.config import OPENAI_API_KEY

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
- Every table must have an "id" column as primary key
- Use proper data types: INT, VARCHAR(n), TEXT, BOOLEAN, DECIMAL, DATE, TIMESTAMP
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

ER_DIAGRAM_PROMPT = """You are a database architect creating an entity-relationship diagram. Given the database schema below, generate a Mermaid.js erDiagram definition.

Database Schema:
{entities}

Rules:
- Start with "erDiagram"
- Declare each table as an entity block with its columns and types, e.g.:
    Student {{
        int id PK
        int parent_id FK
        string name
    }}
- Mark primary keys with "PK" and foreign keys with "FK" after the column name
- Declare relationships between tables using crow's-foot notation based on foreign keys, e.g.:
    Parent ||--o{{ Student : "has"
- Use one relationship line per foreign key
- Choose a short, meaningful verb phrase for each relationship label (e.g. "has", "places", "contains")
- Keep table and column names exactly as given in the schema
- Do NOT include markdown fences, explanations, or any text outside the Mermaid syntax

Return ONLY the Mermaid erDiagram definition."""

REFINE_PROMPT = """You are a database architect. Given the current schema and the user's instruction, update the schema accordingly.

Current schema:
{entities}

User's instruction: {instruction}

Keep VARCHAR columns with an explicit suggested length (e.g. VARCHAR(100)) and use DATE for calendar fields such as date_of_birth.

Return ONLY the updated valid JSON in the same format (with "tables" array containing table objects with "name" and "columns")."""

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
{entities}

Existing Code:
{existing_code}

User Instruction:
{instruction}

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
{entities}

UI Description:
{description}

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

UI_XML_PROMPT = """You are a UI/UX architect. Given a screen description and database schema, generate a complete XML UI definition.

Database Schema:
{entities}

Screen Description:
{description}

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

XML UI Definition:
{xml}

COLOR PALETTE: If colors are specified in the XML use them. Otherwise choose a professional palette matching the domain (blue for HR/admin, green for finance, teal for healthcare, indigo for tech). Define everything as CSS custom properties:
--clr-primary, --clr-primary-dark, --clr-primary-light, --clr-danger, --clr-border, --clr-bg, --clr-surface, --clr-text, --clr-muted, --clr-header-bg

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYOUT STRUCTURE (follow exactly in this order):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL LAYOUT RULE: This is a DESKTOP WEB APPLICATION. The layout must be FULL WIDTH — do NOT use max-width containers, do NOT center content. It must fill the entire browser window like enterprise software (SAP, Oracle, Salesforce). Think 1440px monitor, not mobile.

1. PAGE WRAPPER
   - background: var(--clr-bg) (#F1F5F9)
   - min-height: 100vh
   - width: 100%
   - font-family: 'Inter', system-ui, sans-serif
   - NO max-width. NO margin: auto centering. Content fills the full viewport width.
   - Padding: 0 0 80px 0 (bottom only for toolbar clearance)

2. TOP HEADER BAND (full-width)
   - width: 100%, background: var(--clr-header-bg) — dark rich color (e.g. #0F3460, #1E3A5F)
   - padding: 20px 40px
   - Module name: 11px uppercase letter-spacing 0.1em color: rgba(255,255,255,0.55)
   - Page title: 24px font-weight 700 color: white, margin-top 4px
   - Purpose line: 13px italic color: rgba(255,255,255,0.5), margin-top 4px (from XML purpose attribute)

3. FORM CARD (white, border-radius 10px, box-shadow 0 1px 4px rgba(0,0,0,0.08), border 1px solid var(--clr-border), margin: 24px 40px 0)
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

Return ONLY the complete output file for the chosen framework, with all styles and logic included. No explanations, no markdown fences."""

XML_TO_API_PROMPT = """You are a senior full-stack developer. Generate complete REST API code from this XML UI definition.

XML UI Definition:
{xml}

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

Return ONLY code with === FILENAME: === separators, no explanations."""


async def _call_openai(messages: list, use_json: bool = False, timeout: int = 60) -> str:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY not configured. Add it to your .env file.")

    body = {
        "model": "gpt-4o-mini",
        "messages": messages,
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
        return data["choices"][0]["message"]["content"]


async def extract_entities(description: str, features: str) -> dict:
    text = await _call_openai([
        {"role": "system", "content": EXTRACT_PROMPT},
        {"role": "user", "content": f"Project Description: {description}\n\nDetailed Features: {features}"},
    ], use_json=True)
    return json.loads(text.strip())


async def refine_entities(entities: str, instruction: str) -> dict:
    prompt = REFINE_PROMPT.format(entities=entities, instruction=instruction)
    text = await _call_openai([
        {"role": "system", "content": "You are a database architect. Return ONLY valid JSON."},
        {"role": "user", "content": prompt},
    ], use_json=True)
    return json.loads(text.strip())


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
        {"role": "system", "content": f"You are a senior {frontend_lang} frontend developer. Return ONLY the complete output file for the chosen framework. No markdown fences."},
        {"role": "user", "content": prompt},
    ], timeout=180)


async def generate_api_from_xml(xml: str, backend_lang: str = "Python", frontend_lang: str = "React") -> str:
    prompt = XML_TO_API_PROMPT.format(xml=xml, backend_lang=backend_lang, frontend_lang=frontend_lang)
    return await _call_openai([
        {"role": "system", "content": f"You are a full-stack developer. Generate {backend_lang} backend + {frontend_lang} frontend code. Use === FILENAME: name.ext === to separate files. Return ONLY code."},
        {"role": "user", "content": prompt},
    ], timeout=180)


async def generate_er_diagram(entities: dict) -> str:
    prompt = ER_DIAGRAM_PROMPT.format(entities=json.dumps(entities, indent=2))
    text = await _call_openai([
        {"role": "system", "content": "You are a database architect. Return ONLY Mermaid erDiagram syntax, no markdown fences."},
        {"role": "user", "content": prompt},
    ])
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.lower().startswith("mermaid"):
            text = text[len("mermaid"):]
        text = text.strip()
    return text
