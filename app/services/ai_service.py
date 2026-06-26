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
        {"name": "email", "type": "VARCHAR", "pk": false, "fk": null}
      ]
    }
  ]
}

Rules:
- Every table must have an "id" column as primary key
- Use proper data types: INT, VARCHAR, TEXT, BOOLEAN, DECIMAL, DATE, TIMESTAMP
- Mark foreign keys with the referenced "Table.column"
- Name tables in PascalCase
- Name columns in snake_case"""

REFINE_PROMPT = """You are a database architect. Given the current schema and the user's instruction, update the schema accordingly.

Current schema:
{entities}

User's instruction: {instruction}

Return ONLY the updated valid JSON in the same format (with "tables" array containing table objects with "name" and "columns")."""

VALIDATION_PROMPT = """You are a code generator. Given database entities, validation rules described in plain English, and a target programming language, generate clean validation code.

Target Language: {language}

Database Schema:
{entities}

Validation Rules:
{rules}

Generate validation functions/methods in {language} that enforce these rules. Include:
- Input validation functions for each rule
- Clear error messages
- Type checking where appropriate

Return ONLY the code, no explanations or markdown fences."""

UI_PROMPT = """You are a UI code generator. Given database entities, a description of the desired user interface, and a target programming language/framework, generate form/UI code.

Target Language: {language}

Database Schema:
{entities}

UI Description:
{description}

Generate clean, well-structured UI code. If the language is:
- Python: generate a Flask/Django template HTML form
- Java: generate a JSP or Thymeleaf form
- JavaScript/TypeScript: generate a React component with form
- HTML: generate a plain HTML form with CSS
- Other: generate an appropriate HTML form

Return ONLY the code, no explanations or markdown fences."""


async def _call_openai(messages: list, use_json: bool = False) -> str:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY not configured. Add it to your .env file.")

    body = {
        "model": "gpt-4o-mini",
        "messages": messages,
    }
    if use_json:
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=60) as client:
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


async def generate_validation_code(rules: str, entities: dict | None, language: str) -> str:
    prompt = VALIDATION_PROMPT.format(
        language=language,
        entities=json.dumps(entities, indent=2) if entities else "No schema defined yet",
        rules=rules,
    )
    return await _call_openai([
        {"role": "system", "content": f"You are a {language} code generator. Return ONLY code."},
        {"role": "user", "content": prompt},
    ])


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
