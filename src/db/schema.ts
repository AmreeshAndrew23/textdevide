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

// LEGACY: entities, validation_rules/code, ui_description/code/xml/html/api, er_diagram and ui_screens
// are no longer read or written — a project's work lives in Neo4j (see services/projectStore.ts).
// The columns stay as a backup of what existed before the move; they are copied into Neo4j the first
// time each old project is opened.
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

// A shared, admin-curated catalog — same rows for every user, outside any one user's projects.
// entities is the exact same {tables:[...]} JSON shape projects.entities/updateProject's entities
// patch already use, so a chosen domain's entities can be handed straight to updateProject with
// zero transformation when a new project starts from it.
export const domainTemplates = pgTable("domain_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull().unique(),
  description: varchar("description"),
  category: varchar("category"),
  entities: text("entities").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// A user's own library of domains they've picked, browsed outside/before any specific project
// (the sidebar's Domains page) — not yet tied to one. entitiesSnapshot is a COPY taken at the
// moment of choosing, so a later edit to the canonical domainTemplates row never retroactively
// changes what this user already picked; domainName is denormalized the same way, so it still
// displays correctly even if the template is later renamed or removed.
export const userChosenDomains = pgTable("user_chosen_domains", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  domainTemplateId: integer("domain_template_id").notNull().references(() => domainTemplates.id),
  domainName: varchar("domain_name").notNull(),
  entitiesSnapshot: text("entities_snapshot").notNull(),
  chosenAt: timestamp("chosen_at", { withTimezone: true }).defaultNow(),
});

// The ownership/listing anchor for the second, independent "Runtime Engine" (the Application/
// Entity/Relationship/Validation/DataSource/Screen/Action vocabulary) — deliberately NOT a
// project, since an Application isn't scoped to one. This row's own id IS the applicationId used
// throughout runtimeEngine/'s Neo4j storage (:RtApplication {applicationId: <this id>, ...}) —
// Postgres is the one ownership source of truth, Neo4j holds the actual structure.
export const runtimeApplications = pgTable("runtime_applications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  name: varchar("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type PromptLogRow = typeof promptLogs.$inferSelect;
export type DomainTemplateRow = typeof domainTemplates.$inferSelect;
export type UserChosenDomainRow = typeof userChosenDomains.$inferSelect;
export type RuntimeApplicationRow = typeof runtimeApplications.$inferSelect;
