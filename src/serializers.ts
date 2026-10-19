import type { UserRow, ProjectRow, PromptLogRow, DomainTemplateRow, UserChosenDomainRow } from "./db/schema.js";

// The existing React frontend is untouched and expects the EXACT SAME snake_case JSON shape the
// Python/Pydantic responses already produce — these mirror ProjectResponse/UserResponse/etc. in
// app/models/schemas.py field-for-field, including the has_auth/has_db/has_email presence-as-bool
// pattern (never expose the raw generated code, just whether it exists).

export function serializeUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.fullName,
    picture: u.picture,
    auth_provider: u.authProvider,
    github_token: u.githubToken,
    date_format: u.dateFormat || "YYYY-MM-DD",
    language: u.language || "en",
    is_superuser: u.isSuperuser,
  };
}

export function serializeProject(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    features: p.features,
    entities: p.entities,
    language: p.language || "Python",
    frontend_language: p.frontendLanguage || "React",
    status: p.status || "draft",
    validation_rules: p.validationRules,
    validation_code: p.validationCode,
    ui_description: p.uiDescription,
    ui_code: p.uiCode,
    ui_xml: p.uiXml,
    ui_html: p.uiHtml,
    ui_api: p.uiApi,
    er_diagram: p.erDiagram,
    ui_screens: p.uiScreens,
    ui_theme: p.uiTheme,
    github_repo: p.githubRepo,
    github_repo_url: p.githubRepoUrl,
    github_frontend_repo: p.githubFrontendRepo,
    github_frontend_repo_url: p.githubFrontendRepoUrl,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    has_auth: Boolean(p.authCode),
    has_db: Boolean(p.dbCode),
    has_email: Boolean(p.emailCode),
    unresolved: [] as unknown[],
  };
}

export function serializeProjectListItem(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status || "draft",
    language: p.language || "Python",
    entities: p.entities,
    github_repo_url: p.githubRepoUrl,
    updated_at: p.updatedAt,
  };
}

// entities omitted from the list view (the catalog browse) — only the detail/chosen views need
// the full {tables:[...]} payload, which can get sizable; browsing a dozen domains shouldn't pull
// a dozen schemas over the wire.
export function serializeDomainTemplateListItem(d: DomainTemplateRow) {
  return { id: d.id, name: d.name, description: d.description, category: d.category };
}

export function serializeDomainTemplate(d: DomainTemplateRow) {
  return { id: d.id, name: d.name, description: d.description, category: d.category, entities: d.entities };
}

// The "start project" picker needs entities right away to seed the new project in the same
// request — small enough (a user's own chosen handful, not the whole catalog) to just include.
export function serializeChosenDomain(c: UserChosenDomainRow) {
  return {
    id: c.id,
    domain_template_id: c.domainTemplateId,
    domain_name: c.domainName,
    entities: c.entitiesSnapshot,
    chosen_at: c.chosenAt,
  };
}

export function serializePromptLog(l: PromptLogRow) {
  return {
    id: l.id,
    project_id: l.projectId,
    kind: l.kind,
    prompt: l.prompt,
    response: l.response,
    created_at: l.createdAt,
  };
}
