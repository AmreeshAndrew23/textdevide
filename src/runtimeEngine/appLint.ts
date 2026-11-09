/**
 * Static checks on a generated application: references that point nowhere and setups that can
 * never work. Pure and deterministic. "error" means something will fail for real users and is
 * sent back to the AI to repair; "warning" is a gap worth telling the builder about.
 */
import {
  parseActionElement, parseAuditingElement, parseDataSourceElement, parseEntityElement, parseRelationshipElement,
  parseScreenElement, parseValidationElement, type ActionDef, type AuditingDef, type DataSourceDef, type EntityDef,
  type RelationshipDef, type ScreenDef, type ValidationDef,
} from "./applicationModel.js";
import { assertKnownTag, assertAccountEntityShape } from "./applicationStore.js";
import { isAuthScreen, type AppModel } from "./publicAccess.js";
import { scopeProblems } from "./rowScope.js";

export type LintIssue = { severity: "error" | "warning"; message: string };
type Element = { tag: string; name: string; xml: string; position?: number };

const BUILTIN_ACTIONS = new Set([
  "save", "cancel", "delete", "openRecord", "login", "register", "changePassword",
  "verifyEmail", "requestPasswordReset", "resetPassword", "googleLogin", "githubLogin",
]);
const NOT_REDEFINABLE = new Set(["save", "cancel", "delete", "openRecord"]);
const REQUIRED_ACCOUNT_SCREENS = ["Login", "Signup", "VerifyEmail", "ForgotPassword", "ResetPassword", "ChangePassword"];

export function lintApplication(elements: Element[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const warn = (message: string) => issues.push({ severity: "warning", message });

  // Each element parses independently, so one bad element doesn't hide the rest.
  function parsed<T>(tag: string, parse: (xml: string) => T): T[] {
    const out: T[] = [];
    for (const el of elements.filter((e) => e.tag === tag)) {
      try {
        out.push(parse(el.xml));
      } catch (e) {
        error(`${tag} "${el.name}" is malformed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }
  for (const el of elements) {
    try {
      assertKnownTag(el.tag);
      assertAccountEntityShape({ ...el, position: el.position ?? 0 });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  }
  const seen = new Set<string>();
  for (const el of elements) {
    const key = `${el.tag}:${el.name}`;
    if (seen.has(key)) error(`There are two ${el.tag} elements named "${el.name}".`);
    seen.add(key);
  }

  const entities: EntityDef[] = parsed("Entity", parseEntityElement);
  const relationships: RelationshipDef[] = parsed("Relationship", parseRelationshipElement);
  const validations: ValidationDef[] = parsed("Validation", parseValidationElement);
  const dataSources: DataSourceDef[] = parsed("DataSource", parseDataSourceElement);
  const screens: ScreenDef[] = parsed("Screen", parseScreenElement);
  const actions: ActionDef[] = parsed("Action", parseActionElement);
  const auditing: AuditingDef[] = parsed("Auditing", parseAuditingElement);
  const autoNumbers = new Set(elements.filter((e) => e.tag === "AutoNumber").map((e) => e.name));

  const byName = new Map(entities.map((e) => [e.name, e]));
  const sources = new Map(dataSources.map((d) => [d.name, d]));
  const screenNames = new Set(screens.map((s) => s.name));
  const actionNames = new Set(actions.map((a) => a.name));
  const accountEntity = entities.find((e) => e.isAccount);

  // A field the runtime stamps itself (createdBy etc.) is readable without being declared.
  const hasField = (entity: EntityDef, field: string) =>
    entity.fields.some((f) => f.name === field) ||
    auditing.find((a) => a.name === entity.auditing)?.fields.some((f) => f.name === field) === true;

  for (const e of entities) {
    const keys = e.fields.filter((f) => f.key).length;
    if (keys !== 1) error(`Entity "${e.name}" must have exactly one key field but has ${keys}.`);
    if (e.auditing && !auditing.some((a) => a.name === e.auditing)) error(`Entity "${e.name}" uses Auditing "${e.auditing}", which doesn't exist.`);
    for (const f of e.fields) {
      if (f.type === "enum" && f.values.length === 0) error(`Field ${e.name}.${f.name} is an enum with no <Value> choices.`);
      if (f.autoNumber && !autoNumbers.has(f.autoNumber)) error(`Field ${e.name}.${f.name} uses AutoNumber "${f.autoNumber}", which doesn't exist.`);
    }
  }

  for (const r of relationships) {
    const from = byName.get(r.fromEntity);
    const to = byName.get(r.toEntity);
    if (!from) error(`Relationship "${r.name}" starts from Entity "${r.fromEntity}", which doesn't exist.`);
    else if (!hasField(from, r.fromField)) error(`Relationship "${r.name}" uses ${r.fromEntity}.${r.fromField}, which isn't a field.`);
    if (!to) error(`Relationship "${r.name}" points to Entity "${r.toEntity}", which doesn't exist.`);
    else if (!hasField(to, r.toField)) error(`Relationship "${r.name}" points to ${r.toEntity}.${r.toField}, which isn't a field.`);
  }

  for (const v of validations) {
    const entity = byName.get(v.entity);
    if (!entity) { error(`Validation "${v.id}" is for Entity "${v.entity}", which doesn't exist.`); continue; }
    for (const d of v.dependsOn) if (!d.via && !hasField(entity, d.field)) error(`Validation "${v.id}" depends on ${v.entity}.${d.field}, which isn't a field.`);
  }

  for (const d of dataSources) {
    const entity = byName.get(d.entity);
    if (!entity) { error(`DataSource "${d.name}" selects from Entity "${d.entity}", which doesn't exist.`); continue; }
    const names = [...d.fields.map((f) => f.name), ...d.conditions.map((c) => c.field), ...d.sort.map((s) => s.by), d.valueField, d.displayField];
    for (const n of new Set(names)) if (n && !hasField(entity, n)) error(`DataSource "${d.name}" uses ${d.entity}.${n}, which isn't a field.`);
  }

  const knownAction = (a: string) => BUILTIN_ACTIONS.has(a) || actionNames.has(a);
  for (const a of actions) {
    if (NOT_REDEFINABLE.has(a.name)) error(`Action "${a.name}" redefines a built-in action.`);
    const entity = byName.get(a.entity);
    if (!entity) { error(`Action "${a.name}" is for Entity "${a.entity}", which doesn't exist.`); continue; }
    for (const s of a.steps) if (s.kind === "set" && !hasField(entity, s.field)) error(`Action "${a.name}" sets ${a.entity}.${s.field}, which isn't a field.`);
  }

  for (const s of screens) {
    const entity = s.entity ? byName.get(s.entity) : undefined;
    if (s.entity && !entity) error(`Screen "${s.name}" is for Entity "${s.entity}", which doesn't exist.`);
    if (!s.entity && !s.grid?.rowsFrom) error(`Screen "${s.name}" isn't connected to an Entity.`);
    for (const b of s.buttons) if (!knownAction(b.action)) error(`Screen "${s.name}" has a button running "${b.action}", which doesn't exist.`);
    for (const ev of s.events) if (!knownAction(ev.action)) error(`Screen "${s.name}" runs "${ev.action}" on ${ev.event}, which doesn't exist.`);
    for (const f of s.fields) {
      for (const ev of f.onEvents) if (!knownAction(ev.action)) error(`Screen "${s.name}" field "${f.label}" runs "${ev.action}", which doesn't exist.`);
      if (f.optionsFrom?.startsWith("query:") && !sources.has(f.optionsFrom.slice(6))) error(`Screen "${s.name}" field "${f.label}" gets its options from DataSource "${f.optionsFrom.slice(6)}", which doesn't exist.`);
      const bound = f.valueFrom?.startsWith("field:") ? f.valueFrom.slice(6) : null;
      // Sign-in screens submit values that aren't real fields (password, otpCode...).
      if (entity && bound && !isAuthScreen(s.name) && !hasField(entity, bound)) error(`Screen "${s.name}" binds to ${entity.name}.${bound}, which isn't a field.`);
    }
    if (s.grid) {
      const gridEntity = s.grid.entity ? byName.get(s.grid.entity) : undefined;
      if (s.grid.entity && !gridEntity) error(`Screen "${s.name}" lists Entity "${s.grid.entity}", which doesn't exist.`);
      if (s.grid.rowsFrom?.startsWith("query:") && !sources.has(s.grid.rowsFrom.slice(6))) error(`Screen "${s.name}" lists DataSource "${s.grid.rowsFrom.slice(6)}", which doesn't exist.`);
      if (gridEntity) for (const c of s.grid.columns) if (!hasField(gridEntity, c.bind)) error(`Screen "${s.name}" has a column for ${gridEntity.name}.${c.bind}, which isn't a field.`);
      for (const ev of s.grid.onEvents) {
        if (ev.targetScreen && !screenNames.has(ev.targetScreen)) error(`Screen "${s.name}" opens Screen "${ev.targetScreen}" on ${ev.event}, which doesn't exist.`);
      }
    }
  }

  if (accountEntity) {
    for (const name of REQUIRED_ACCOUNT_SCREENS) {
      // A legacy username-based account has no email flows to go with those screens.
      if (["VerifyEmail", "ForgotPassword", "ResetPassword"].includes(name) && !accountEntity.fields.some((f) => f.name === "email")) continue;
      if (!screenNames.has(name)) error(`The app has user accounts but no "${name}" screen.`);
    }
  }

  const gated = screens.filter((s) => s.requiresRole);
  if (gated.length > 0) {
    const roleLink = accountEntity && relationships.find((r) => r.fromEntity === accountEntity.name && r.fromField === "roleId");
    const roleEntity = roleLink && byName.get(roleLink.toEntity);
    if (!accountEntity || !roleLink || !roleEntity?.fields.some((f) => f.name === "name")) {
      error(`Screens require roles (${gated[0].name}…), but User.roleId isn't linked to a role entity with a "name" field, so nobody could ever open them.`);
    }
  }

  const model: AppModel = { screens, entities, relationships, dataSources, accountEntity: accountEntity ?? null };
  for (const p of scopeProblems(model)) error(p);

  const roleEntityName = accountEntity ? relationships.find((r) => r.fromEntity === accountEntity.name && r.fromField === "roleId")?.toEntity : undefined;
  for (const e of entities) {
    if (e.isAccount || e.name === roleEntityName) continue;
    const own = screens.filter((s) => (s.grid?.entity ?? s.entity) === e.name);
    if (own.length === 0) warn(`${e.name} has no screen, so its records can't be viewed or added in the app.`);
    else if (own.every((s) => s.grid) && !own.some((s) => s.grid!.onEvents.some((ev) => ev.targetScreen))) warn(`${e.name} has a list but no way to add records.`);
  }
  return issues;
}
