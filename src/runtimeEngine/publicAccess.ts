/**
 * Who may see and do what in a PUBLISHED application — pure rules, no I/O, used by
 * routes/publicApps.ts. Once an app has a public link the Studio-owner check no longer protects
 * it, so every public request is decided here instead. Deliberately deny-by-default:
 *   - nothing but the sign-in screens is visible without a session;
 *   - a Screen's requiresRole is enforced for reads as well as actions;
 *   - the account entity (real users' emails/roles) is only reachable through a screen that
 *     explicitly requires a role the viewer holds — "no restriction" never applies to it;
 *   - an action must actually belong to the screen it's run on.
 */
import {
  parseEntityElement, parseScreenElement, parseDataSourceElement, parseRelationshipElement,
  type DataSourceDef, type EntityDef, type RelationshipDef, type ScreenDef,
} from "./applicationModel.js";

export type StoredElement = { tag: string; name: string; xml: string };
export type Viewer = { signedIn: boolean; role: string | null };

// Which built-in each sign-in screen may run. Keyed by screen name (a fixed convention — see
// aiService.ts's prompt) rather than trusting the screen's own buttons, so these actions can't be
// reached through any other screen.
const OAUTH = ["googleLogin", "githubLogin"];
const AUTH_SCREEN_ACTIONS: Record<string, Set<string>> = {
  Login: new Set(["login", ...OAUTH]),
  Signup: new Set(["register", ...OAUTH]),
  VerifyEmail: new Set(["verifyEmail"]),
  ForgotPassword: new Set(["requestPasswordReset"]),
  ResetPassword: new Set(["resetPassword"]),
  ChangePassword: new Set(["changePassword"]),
};
const AUTH_ACTIONS = new Set(Object.values(AUTH_SCREEN_ACTIONS).flatMap((s) => [...s]));
const NEEDS_SESSION_AUTH_SCREENS = new Set(["ChangePassword"]);

export function isAuthScreen(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTH_SCREEN_ACTIONS, name);
}

// Values that must never leave the server, whoever is asking.
const SECRET_FIELD = /^(passwordHash|__otpCode|__otpExpiresAt|__otpPurpose)$/;
export function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_FIELD.test(k)));
}

// Account fields only the sign-in built-ins may set — never taken from a submitted form.
export const PROTECTED_ACCOUNT_FIELDS = ["passwordHash", "emailVerified", "mustChangePassword", "authProvider"];

export type AppModel = {
  screens: ScreenDef[];
  entities: EntityDef[];
  relationships: RelationshipDef[];
  dataSources: DataSourceDef[];
  accountEntity: EntityDef | null;
};

export function buildAppModel(elements: StoredElement[]): AppModel {
  const of = (tag: string) => elements.filter((e) => e.tag === tag);
  const entities = of("Entity").map((e) => parseEntityElement(e.xml));
  return {
    screens: of("Screen").map((e) => parseScreenElement(e.xml)),
    entities,
    relationships: of("Relationship").map((e) => parseRelationshipElement(e.xml)),
    dataSources: of("DataSource").map((e) => parseDataSourceElement(e.xml)),
    accountEntity: entities.find((e) => e.isAccount) ?? null,
  };
}

function screenEntityName(screen: ScreenDef): string | null {
  return screen.grid?.entity ?? screen.entity;
}

export function canEnterScreen(model: AppModel, screen: ScreenDef, viewer: Viewer): boolean {
  if (isAuthScreen(screen.name)) return !NEEDS_SESSION_AUTH_SCREENS.has(screen.name) || viewer.signedIn;
  if (!viewer.signedIn) return false;
  const roleAllowed = !!viewer.role && !!screen.requiresRole?.includes(viewer.role);
  if (screenEntityName(screen) === model.accountEntity?.name) return roleAllowed;
  return screen.requiresRole === null || roleAllowed;
}

// The screens a viewer can actually work with (sign-in screens don't grant data access).
function workScreens(model: AppModel, viewer: Viewer): ScreenDef[] {
  return model.screens.filter((s) => !isAuthScreen(s.name) && canEnterScreen(model, s, viewer));
}

export function canReadEntity(model: AppModel, entityName: string, viewer: Viewer): boolean {
  return workScreens(model, viewer).some((s) => screenEntityName(s) === entityName);
}

export function isActionAllowed(screen: ScreenDef, action: string): boolean {
  if (isAuthScreen(screen.name)) return AUTH_SCREEN_ACTIONS[screen.name].has(action);
  if (AUTH_ACTIONS.has(action)) return false;
  if (screen.buttons.some((b) => b.action === action)) return true;
  // The list page's row delete runs against the grid screen itself, with no button of its own.
  return action === "delete" && !!screen.grid;
}

// A dropdown's options (or a list's linked-record names): the source must be used by a screen the
// viewer can open, or point at the target of a link from an entity they can read.
export function canUseDataSource(model: AppModel, source: DataSourceDef, viewer: Viewer): boolean {
  for (const f of [source.valueField, source.displayField]) if (f && SECRET_FIELD.test(f)) return false;
  if (source.fields.some((f) => SECRET_FIELD.test(f.name))) return false;
  const screens = workScreens(model, viewer);
  if (screens.some((s) => s.fields.some((f) => f.optionsFrom === `query:${source.name}` || f.optionsFrom === source.name))) return true;
  const readable = new Set(screens.map(screenEntityName));
  return model.relationships.some((r) => r.toEntity === source.entity && readable.has(r.fromEntity));
}

// The application definition a viewer's browser receives. Rules (Validation), server-side steps
// (Action) and anything else not needed to draw their screens stay on the server.
export function elementsForViewer(elements: StoredElement[], model: AppModel, viewer: Viewer): StoredElement[] {
  const screens = new Set(model.screens.filter((s) => canEnterScreen(model, s, viewer)).map((s) => s.name));
  const accountName = model.accountEntity?.name;
  if (!viewer.signedIn) {
    return elements.filter((e) => e.tag === "Theme" || (e.tag === "Screen" && screens.has(e.name)) || (e.tag === "Entity" && e.name === accountName));
  }
  const entities = new Set<string>(accountName ? [accountName] : []);
  for (const s of workScreens(model, viewer)) {
    const name = screenEntityName(s);
    if (name) entities.add(name);
  }
  for (const r of model.relationships) if (entities.has(r.fromEntity)) entities.add(r.toEntity);
  const sources = new Set(model.dataSources.filter((d) => canUseDataSource(model, d, viewer)).map((d) => d.name));
  const relationships = new Set(
    elements.filter((e) => e.tag === "Relationship").filter((e) => {
      const r = parseRelationshipElement(e.xml);
      return entities.has(r.fromEntity) && entities.has(r.toEntity);
    }).map((e) => e.name)
  );
  return elements.filter((e) =>
    e.tag === "Theme" ||
    (e.tag === "Screen" && screens.has(e.name)) ||
    (e.tag === "Entity" && entities.has(e.name)) ||
    (e.tag === "DataSource" && sources.has(e.name)) ||
    (e.tag === "Relationship" && relationships.has(e.name))
  );
}

export function roleNamesFromScreens(screens: ScreenDef[]): string[] {
  return [...new Set(screens.flatMap((s) => s.requiresRole ?? []))];
}

// The role the first account gets: an admin-like role if there is one, else whichever role opens
// the most screens.
export function topRole(screens: ScreenDef[]): string | null {
  const names = roleNamesFromScreens(screens);
  const admin = names.find((n) => /admin|owner|manager/i.test(n));
  if (admin) return admin;
  const count = (n: string) => screens.filter((s) => s.requiresRole?.includes(n)).length;
  return [...names].sort((a, b) => count(b) - count(a))[0] ?? null;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "app";
}
