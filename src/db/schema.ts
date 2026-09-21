import { pgTable, serial, integer, text, varchar, boolean, timestamp } from "drizzle-orm/pg-core";

// Column-for-column port of app/models/user.py, project.py, prompt_log.py — same table/column
// names so this schema reads the EXACT SAME real Postgres tables the Python backend already
// uses, no data migration involved.

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email").notNull().unique(),
  hashedPassword: varchar("hashed_password"),
  fullName: varchar("full_name"),
  picture: varchar("picture"),
  authProvider: varchar("auth_provider").default("email"),
  isActive: boolean("is_active").default(true),
  isSuperuser: boolean("is_superuser").default(false),
  githubToken: varchar("github_token"),
  dateFormat: varchar("date_format").default("YYYY-MM-DD"),
  language: varchar("language").default("en"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  description: varchar("description"),
  features: text("features"),
  language: varchar("language").default("Python"),
  entities: text("entities"),
  status: varchar("status").default("draft"),
  validationRules: text("validation_rules"),
  validationCode: text("validation_code"),
  uiDescription: text("ui_description"),
  uiCode: text("ui_code"),
  frontendLanguage: varchar("frontend_language").default("React"),
  uiXml: text("ui_xml"),
  uiHtml: text("ui_html"),
  uiApi: text("ui_api"),
  erDiagram: text("er_diagram"),
  uiScreens: text("ui_screens"),
  uiTheme: text("ui_theme"),
  authCode: text("auth_code"),
  dbCode: text("db_code"),
  emailCode: text("email_code"),
  githubRepo: varchar("github_repo"),
  githubRepoUrl: varchar("github_repo_url"),
  githubFrontendRepo: varchar("github_frontend_repo"),
  githubFrontendRepoUrl: varchar("github_frontend_repo_url"),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const promptLogs = pgTable("prompt_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  projectId: integer("project_id").references(() => projects.id),
  kind: varchar("kind").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response"),
  model: varchar("model"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type PromptLogRow = typeof promptLogs.$inferSelect;
