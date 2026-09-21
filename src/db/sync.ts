import { pool } from "./connection.js";
import { SUPERUSER_EMAILS } from "../config.js";

// Port of database.py's _add_missing_columns/init_db — this app has no formal migration tool, so
// schema drift is bridged at every startup instead: any column declared here but missing from the
// live table gets ALTER-ed in. All 3 tables already exist for real (the Python backend created
// them against this SAME database) — this only matters once someone adds a new column to
// schema.ts without a matching Python-side (now moot) or manual migration.
const COLUMN_DEFS: Record<string, { name: string; ddlType: string; defaultSql?: string }[]> = {
  users: [
    { name: "email", ddlType: "VARCHAR" },
    { name: "hashed_password", ddlType: "VARCHAR" },
    { name: "full_name", ddlType: "VARCHAR" },
    { name: "picture", ddlType: "VARCHAR" },
    { name: "auth_provider", ddlType: "VARCHAR", defaultSql: "'email'" },
    { name: "is_active", ddlType: "BOOLEAN", defaultSql: "true" },
    { name: "is_superuser", ddlType: "BOOLEAN", defaultSql: "false" },
    { name: "github_token", ddlType: "VARCHAR" },
    { name: "date_format", ddlType: "VARCHAR", defaultSql: "'YYYY-MM-DD'" },
    { name: "language", ddlType: "VARCHAR", defaultSql: "'en'" },
    { name: "created_at", ddlType: "TIMESTAMPTZ", defaultSql: "now()" },
  ],
  projects: [
    { name: "name", ddlType: "VARCHAR" },
    { name: "description", ddlType: "VARCHAR" },
    { name: "features", ddlType: "TEXT" },
    { name: "language", ddlType: "VARCHAR", defaultSql: "'Python'" },
    { name: "entities", ddlType: "TEXT" },
    { name: "status", ddlType: "VARCHAR", defaultSql: "'draft'" },
    { name: "validation_rules", ddlType: "TEXT" },
    { name: "validation_code", ddlType: "TEXT" },
    { name: "ui_description", ddlType: "TEXT" },
    { name: "ui_code", ddlType: "TEXT" },
    { name: "frontend_language", ddlType: "VARCHAR", defaultSql: "'React'" },
    { name: "ui_xml", ddlType: "TEXT" },
    { name: "ui_html", ddlType: "TEXT" },
    { name: "ui_api", ddlType: "TEXT" },
    { name: "er_diagram", ddlType: "TEXT" },
    { name: "ui_screens", ddlType: "TEXT" },
    { name: "ui_theme", ddlType: "TEXT" },
    { name: "auth_code", ddlType: "TEXT" },
    { name: "db_code", ddlType: "TEXT" },
    { name: "email_code", ddlType: "TEXT" },
    { name: "github_repo", ddlType: "VARCHAR" },
    { name: "github_repo_url", ddlType: "VARCHAR" },
    { name: "github_frontend_repo", ddlType: "VARCHAR" },
    { name: "github_frontend_repo_url", ddlType: "VARCHAR" },
    { name: "user_id", ddlType: "INTEGER" },
    { name: "created_at", ddlType: "TIMESTAMPTZ", defaultSql: "now()" },
    { name: "updated_at", ddlType: "TIMESTAMPTZ", defaultSql: "now()" },
  ],
  prompt_logs: [
    { name: "user_id", ddlType: "INTEGER" },
    { name: "project_id", ddlType: "INTEGER" },
    { name: "kind", ddlType: "VARCHAR" },
    { name: "prompt", ddlType: "TEXT" },
    { name: "response", ddlType: "TEXT" },
    { name: "model", ddlType: "VARCHAR" },
    { name: "prompt_tokens", ddlType: "INTEGER" },
    { name: "completion_tokens", ddlType: "INTEGER" },
    { name: "total_tokens", ddlType: "INTEGER" },
    { name: "created_at", ddlType: "TIMESTAMPTZ", defaultSql: "now()" },
  ],
};

export async function syncSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const [table, columns] of Object.entries(COLUMN_DEFS)) {
      const existing = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      );
      if (existing.rowCount === 0) continue; // table doesn't exist yet — not this app's job to create it from scratch
      const existingNames = new Set(existing.rows.map((r) => r.column_name));
      for (const col of columns) {
        if (existingNames.has(col.name)) continue;
        await client.query(`ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${col.ddlType}`);
        if (col.defaultSql !== undefined) {
          // A newly-added column with a code-level default needs pre-existing rows backfilled —
          // a bare ALTER TABLE ADD COLUMN leaves them NULL, same reasoning as the Python original.
          await client.query(`UPDATE "${table}" SET "${col.name}" = ${col.defaultSql} WHERE "${col.name}" IS NULL`);
        }
      }
    }
  } finally {
    client.release();
  }
}

export async function syncSuperusers(): Promise<void> {
  if (SUPERUSER_EMAILS.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE users SET is_superuser = true WHERE lower(email) = ANY($1) AND is_superuser = false`,
      [SUPERUSER_EMAILS]
    );
  } finally {
    client.release();
  }
}
