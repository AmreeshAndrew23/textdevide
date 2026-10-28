/**
 * Pure XML -> typed-model parsing for the SECOND, independent "Application" vocabulary
 * (Application/Entity/Relationship/Validation/DataSource/Screen/Action/Theme/Session/Auditing/
 * AutoNumber) — a completely different, richer document model than runtime/screenModel.ts's
 * <screen> vocabulary. Deliberately never imports from runtime/engine.ts, so the two engines stay
 * fully decoupled; only the generic, vocabulary-agnostic DOM helpers (isElement/childElements) are
 * reused from runtime/screenModel.ts, since those have zero coupling to the <screen> tag set.
 *
 * Every parse* function here is pure (no I/O) and operates on a single already-extracted element's
 * XML string — applicationStore.ts stores one top-level child's own XML verbatim per Neo4j node,
 * and these functions re-parse that one string on demand, never a whole Application document at
 * once (except parseApplicationXml itself, whose only job is splitting the root into those pieces).
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Element as XmlElement } from "@xmldom/xmldom";
import { isElement, childElements } from "../runtime/screenModel.js";

// For building a minimal <Application> shell (e.g. a brand-new, name-only Application before any
// description has been given) rather than parsing one — name is user-supplied free text, so it
// must be escaped before landing inside an XML attribute value.
export function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseXml(xml: string): XmlElement {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root) throw new Error("Empty or invalid XML");
  return root;
}

function serialize(el: XmlElement): string {
  return new XMLSerializer().serializeToString(el);
}

function attr(el: XmlElement, name: string, fallback = ""): string {
  return el.getAttribute(name) ?? fallback;
}
function attrOrNull(el: XmlElement, name: string): string | null {
  return el.getAttribute(name);
}
function attrBool(el: XmlElement, name: string): boolean {
  return el.getAttribute(name) === "true";
}
function attrNum(el: XmlElement, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
function textOf(el: XmlElement): string {
  return (el.textContent || "").trim();
}

// ---------------------------------------------------------------------------
// Top-level split — <Application>'s direct children only, each kept as its own verbatim XML
// string. Nested tags (Field, Value, Condition, Steps, DependsOn, ...) never get their own
// element here or their own Neo4j node later — they stay inside the parent's xml string, re-parsed
// lazily by the matching parse*Element function only when actually needed.
// ---------------------------------------------------------------------------
export type ParsedTopLevelElement = { tag: string; name: string; xml: string; position: number };
export type ApplicationManifest = {
  name: string;
  theme: string | null;
  database: string | null;
  elements: ParsedTopLevelElement[];
};

// Session has no name/id of its own in the sample vocabulary (it's a singleton) — normalized to
// this literal so every element node still has a non-empty, queryable `name` property.
const SESSION_SINGLETON_NAME = "default";

function nameOf(tag: string, el: XmlElement): string {
  if (tag === "Session") return SESSION_SINGLETON_NAME;
  if (tag === "AutoNumber") return attr(el, "id") || SESSION_SINGLETON_NAME;
  if (tag === "Validation") return attr(el, "id") || SESSION_SINGLETON_NAME;
  return attr(el, "name") || SESSION_SINGLETON_NAME;
}

export function parseApplicationXml(xml: string): ApplicationManifest {
  const root = parseXml(xml);
  if (root.tagName !== "Application") throw new Error(`Expected a root <Application> element, got <${root.tagName}>`);
  const elements = childElements(root).map((el, position) => ({
    tag: el.tagName,
    name: nameOf(el.tagName, el),
    xml: serialize(el),
    position,
  }));
  return { name: attr(root, "name"), theme: attrOrNull(root, "theme"), database: attrOrNull(root, "database"), elements };
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------
// "image" is stored exactly like "string" (its value is just the served upload URL — see
// runtimeEngine/uploads.ts) — the distinct type only tells the Run panel to render a real file
// picker + thumbnail for that field instead of a text box.
export type FieldType = "string" | "integer" | "decimal" | "date" | "enum" | "boolean" | "image";
export type FieldDef = {
  name: string;
  type: FieldType;
  key: boolean;
  required: boolean;
  unique: boolean;
  maxLength?: number;
  min?: number;
  precision?: number;
  scale?: number;
  autoNumber: string | null;
  values: string[]; // <Value> children, for type="enum"
};
// isAccount marks the ONE entity (by fixed convention, always named "User") that holds real
// end-user accounts for login/logout/change-password — see appAuth.ts and the login/
// changePassword built-ins in applicationEngine.ts. Its fields follow a fixed name convention
// (email/passwordHash/mustChangePassword/firstName/lastName/dob/emailVerified/authProvider, or the
// older username-based shape still supported for already-generated apps) documented in
// aiService.ts's prompt, not parsed here.
export type EntityDef = { name: string; auditing: string | null; isAccount: boolean; fields: FieldDef[] };

// Caught live: the AI sometimes writes an Entity named "User" with EXACTLY the right
// account-field shape (the convention it was told to follow) but forgets the isAccount="true"
// attribute itself — silently breaking login/signup for that application, since nothing downstream
// would ever recognize it as the account entity. Defense in depth, same reasoning as
// applicationStore.ts's assertAccountEntityShape: don't rely on the AI getting every instruction
// right every time when the shape alone is already unambiguous — an Entity named exactly "User"
// with exactly one of the two known-good field sets below IS the account entity, attribute or not.
//
// TWO shapes are recognized, not one — kept in lockstep with applicationStore.ts's
// assertAccountEntityShape (and RuntimeEngine.jsx's own frontend mirror):
//   - LEGACY: id/username/passwordHash/mustChangePassword — what every app generated before the
//     email/OTP/OAuth overhaul used, and what already-seeded apps (e.g. the HRM/property-management
//     apps) still have real data under. Never generated by the AI anymore, but must keep being
//     RECOGNIZED forever so those apps keep logging in and stay editable.
//   - CURRENT: id/email/passwordHash/mustChangePassword/firstName/lastName/dob/emailVerified/
//     authProvider — what the AI generates from now on. passwordHash/firstName/lastName/dob are
//     NOT required="true" here (an OAuth-only signup has no password and Google/GitHub never hand
//     us a birthdate) — applicationEngine.ts's built-ins enforce what password-signup actually
//     needs via explicit checks, the same way they already hand-roll their own blank checks today.
const LEGACY_ACCOUNT_FIELD_NAMES = new Set(["id", "username", "passwordHash", "mustChangePassword"]);
const CURRENT_ACCOUNT_FIELD_NAMES = new Set([
  "id", "email", "passwordHash", "mustChangePassword", "firstName", "lastName", "dob", "emailVerified", "authProvider",
]);
// "roleId" is the one optional extra field the RBAC convention allows on the account entity (see
// applicationStore.ts's assertAccountEntityShape) — applies to EITHER shape above. This structural
// fallback has to recognize it too, or a User entity that has roleId but forgot isAccount="true"
// would stop being recognized as the account entity at all, silently breaking login for an app that
// was trying to add roles.
const OPTIONAL_ACCOUNT_FIELD_NAMES = new Set(["roleId"]);
function matchesAccountShape(names: string[], shape: Set<string>): boolean {
  const hasAllRequired = [...shape].every((n) => names.includes(n));
  const noUnknownFields = names.every((n) => shape.has(n) || OPTIONAL_ACCOUNT_FIELD_NAMES.has(n));
  return hasAllRequired && noUnknownFields;
}
function looksLikeAccountEntity(name: string, fields: FieldDef[]): boolean {
  if (name !== "User") return false;
  const names = fields.map((f) => f.name);
  return matchesAccountShape(names, LEGACY_ACCOUNT_FIELD_NAMES) || matchesAccountShape(names, CURRENT_ACCOUNT_FIELD_NAMES);
}

export function parseEntityElement(xml: string): EntityDef {
  const el = parseXml(xml);
  const fields = childElements(el, "Field").map((f): FieldDef => ({
    name: attr(f, "name"),
    type: (attr(f, "type", "string") as FieldType),
    key: attrBool(f, "key"),
    required: attrBool(f, "required"),
    unique: attrBool(f, "unique"),
    maxLength: attrNum(f, "maxLength"),
    min: attrNum(f, "min"),
    precision: attrNum(f, "precision"),
    scale: attrNum(f, "scale"),
    autoNumber: attrOrNull(f, "autoNumber"),
    values: childElements(f, "Value").map(textOf),
  }));
  const name = attr(el, "name");
  const isAccount = attrBool(el, "isAccount") || looksLikeAccountEntity(name, fields);
  return { name, auditing: attrOrNull(el, "auditing"), isAccount, fields };
}

// ---------------------------------------------------------------------------
// Relationship — "fields stay plain-typed; the Relationship tag carries the whole link"
// ---------------------------------------------------------------------------
export type Cardinality = "1:1" | "1:N" | "N:1" | "N:N";
export type OnDelete = "restrict" | "cascade" | "setNull";
export type RelationshipDef = {
  name: string;
  fromEntity: string;
  fromField: string;
  toEntity: string;
  toField: string;
  cardinality: Cardinality;
  onDelete: OnDelete;
};

export function parseRelationshipElement(xml: string): RelationshipDef {
  const el = parseXml(xml);
  return {
    name: attr(el, "name"),
    fromEntity: attr(el, "fromEntity"),
    fromField: attr(el, "fromField"),
    toEntity: attr(el, "toEntity"),
    toField: attr(el, "toField"),
    cardinality: (attr(el, "cardinality", "N:1") as Cardinality),
    onDelete: (attr(el, "onDelete", "restrict") as OnDelete),
  };
}

// ---------------------------------------------------------------------------
// Validation — "DependsOn is an inner tag: every field the validation reads is declared up
// front... so the runtime reruns only affected validations and impact analysis never has to parse
// the condition expression." Re-run selection (validationEngine.ts) uses ONLY dependsOn, never test.
// ---------------------------------------------------------------------------
export type DependsOnEntry = { field: string; via: string | null };
export type ValidationDef = {
  id: string;
  entity: string;
  when: "onSave" | "onChange";
  onViolation: "reject" | "warn";
  dependsOn: DependsOnEntry[];
  test: string;
  message: string;
};

export function parseValidationElement(xml: string): ValidationDef {
  const el = parseXml(xml);
  const dependsOnEl = childElements(el, "DependsOn")[0];
  const dependsOn = dependsOnEl
    ? childElements(dependsOnEl, "Field").map((f) => ({ field: attr(f, "name"), via: attrOrNull(f, "via") }))
    : [];
  const conditionEl = childElements(el, "Condition")[0];
  const messageEl = childElements(el, "Message")[0];
  return {
    id: attr(el, "id"),
    entity: attr(el, "entity"),
    when: (attr(el, "when", "onSave") as "onSave" | "onChange"),
    onViolation: (attr(el, "onViolation", "reject") as "reject" | "warn"),
    dependsOn,
    test: conditionEl ? attr(conditionEl, "test") : "",
    message: messageEl ? textOf(messageEl) : "",
  };
}

// ---------------------------------------------------------------------------
// DataSource — "Generic declarative query spec — no SQL or Cypher in the XML. The runtime
// compiles this to the target database." See dataSourceCompiler.ts for the compile step.
// ---------------------------------------------------------------------------
export type AggregateFn = "sum" | "avg" | "count" | "min" | "max";
export type ConditionOperator = "equals" | "notEquals" | "gt" | "gte" | "lt" | "lte" | "contains";
export type DataSourceDef = {
  name: string;
  entity: string;
  fields: { name: string; alias: string | null; aggregate: AggregateFn | null }[];
  conditions: { field: string; operator: ConditionOperator; value: string }[];
  groupBy: string[];
  sort: { by: string; order: "asc" | "desc" }[];
  valueField: string | null;
  displayField: string | null;
};

export function parseDataSourceElement(xml: string): DataSourceDef {
  const el = parseXml(xml);
  const selectEl = childElements(el, "Select")[0];
  const fields = selectEl
    ? childElements(selectEl, "Field").map((f) => ({
        name: attr(f, "name"),
        alias: attrOrNull(f, "alias"),
        aggregate: (attrOrNull(f, "aggregate") as AggregateFn | null),
      }))
    : [];
  const conditions = selectEl
    ? childElements(selectEl, "Condition").map((c) => ({
        field: attr(c, "field"),
        operator: (attr(c, "operator", "equals") as ConditionOperator),
        value: attr(c, "value"),
      }))
    : [];
  const groupBy = selectEl ? childElements(selectEl, "GroupBy").map((g) => attr(g, "field")) : [];
  const sort = selectEl
    ? childElements(selectEl, "Sort").map((s) => ({ by: attr(s, "by"), order: (attr(s, "order", "asc") as "asc" | "desc") }))
    : [];
  const valueFieldEl = childElements(el, "ValueField")[0];
  const displayFieldEl = childElements(el, "DisplayField")[0];
  return {
    name: attr(el, "name"),
    entity: selectEl ? attr(selectEl, "entity") : "",
    fields,
    conditions,
    groupBy,
    sort,
    valueField: valueFieldEl ? textOf(valueFieldEl) : null,
    displayField: displayFieldEl ? textOf(displayFieldEl) : null,
  };
}

// ---------------------------------------------------------------------------
// Screen — "Binding is decoupled: valueFrom is two-way (where the value lives), optionsFrom is
// one-way (where a dropdown's list comes from). bind=... is shorthand for valueFrom=field:...
// A screen is a container: fields, grids and buttons mix freely."
// ---------------------------------------------------------------------------
export type UIFieldDef = {
  label: string;
  bind: string | null;
  control: string | null;
  valueFrom: string | null; // resolved below: bind is shorthand for valueFrom="field:<bind>"
  optionsFrom: string | null;
  readonly: boolean;
  onEvents: { event: string; action: string }[];
};
export type GridColumnDef = { header: string; bind: string };
export type GridDef = {
  name: string;
  entity: string | null;
  rowsFrom: string | null; // "query:<DataSource name>" — set when not entity-bound
  readonly: boolean;
  columns: GridColumnDef[];
  onEvents: { event: string; action: string; targetScreen: string | null }[];
};
export type ScreenButtonDef = { label: string; event: string; action: string };
export type ScreenDef = {
  name: string;
  entity: string | null;
  type: "form" | "grid" | null;
  fields: UIFieldDef[];
  grid: GridDef | null;
  buttons: ScreenButtonDef[];
  events: { event: string; action: string }[]; // screen-level <Events><On .../></Events>, e.g. load
  // RBAC gate — optional comma-separated role list from requiresRole="RoleA,RoleB" on <Screen>; a
  // logged-in session's resolved role (see applicationEngine.ts's runLogin) must be in this list or
  // the screen-run route 403s before ever calling runButtonAction. null means "no restriction."
  requiresRole: string[] | null;
};

// Two shapes appear in the sample vocabulary for the exact same <On> tag: Grid/Screen wrap it in
// an <Events> container, but a UIField's <On> is a direct child with no wrapper at all. Checking
// both (rather than picking one) means either shape parses correctly wherever <On> appears.
function parseOnEvents(el: XmlElement): { event: string; action: string; targetScreen: string | null }[] {
  const eventsEl = childElements(el, "Events")[0];
  const onElements = eventsEl ? childElements(eventsEl, "On") : childElements(el, "On");
  return onElements.map((on) => ({
    event: attr(on, "event"),
    action: attr(on, "action"),
    targetScreen: attrOrNull(on, "targetScreen"),
  }));
}

export function parseScreenElement(xml: string): ScreenDef {
  const el = parseXml(xml);
  const fieldsEl = childElements(el, "Fields")[0];
  const fields: UIFieldDef[] = fieldsEl
    ? childElements(fieldsEl, "UIField").map((f) => {
        const bind = attrOrNull(f, "bind");
        return {
          label: attr(f, "label"),
          bind,
          control: attrOrNull(f, "control"),
          valueFrom: attrOrNull(f, "valueFrom") || (bind ? `field:${bind}` : null),
          optionsFrom: attrOrNull(f, "optionsFrom"),
          readonly: attrBool(f, "readonly"),
          onEvents: parseOnEvents(f).map(({ event, action }) => ({ event, action })),
        };
      })
    : [];
  const gridEl = childElements(el, "Grid")[0];
  const grid: GridDef | null = gridEl
    ? {
        name: attr(gridEl, "name"),
        entity: attrOrNull(gridEl, "entity"),
        rowsFrom: attrOrNull(gridEl, "rowsFrom"),
        readonly: attrBool(gridEl, "readonly"),
        columns: childElements(gridEl, "Column").map((c) => ({ header: attr(c, "header"), bind: attr(c, "bind") })),
        onEvents: parseOnEvents(gridEl),
      }
    : null;
  const buttonsEl = childElements(el, "Buttons")[0];
  const buttons: ScreenButtonDef[] = buttonsEl
    ? childElements(buttonsEl, "Button").map((b) => ({ label: attr(b, "label"), event: attr(b, "event", "click"), action: attr(b, "action") }))
    : [];
  const events = parseOnEvents(el).map(({ event, action }) => ({ event, action }));
  const requiresRoleAttr = attrOrNull(el, "requiresRole");
  const requiresRole = requiresRoleAttr ? requiresRoleAttr.split(",").map((r) => r.trim()).filter(Boolean) : null;
  return {
    name: attr(el, "name"), entity: attrOrNull(el, "entity"), type: (attrOrNull(el, "type") as "form" | "grid" | null),
    fields, grid, buttons, events, requiresRole: requiresRole && requiresRole.length ? requiresRole : null,
  };
}

// ---------------------------------------------------------------------------
// Action — "Built-ins (save, cancel, delete, openRecord) have fixed runtime semantics and are
// never redefined. Custom logic lives in named actions composed of runtime steps; all steps run
// in one transaction."
// ---------------------------------------------------------------------------
export type Step =
  | { kind: "set"; field: string; value: string }
  | { kind: "save" }
  | { kind: "notify"; to: string; message: string };
export type ActionDef = { name: string; entity: string; steps: Step[] };

export function parseActionElement(xml: string): ActionDef {
  const el = parseXml(xml);
  const stepsEl = childElements(el, "Steps")[0];
  const steps: Step[] = stepsEl
    ? childElements(stepsEl).map((s): Step => {
        if (s.tagName === "Set") return { kind: "set", field: attr(s, "field"), value: attr(s, "value") };
        if (s.tagName === "Save") return { kind: "save" };
        if (s.tagName === "Notify") return { kind: "notify", to: attr(s, "to"), message: attr(s, "message") };
        throw new Error(`Unknown Action step <${s.tagName}>`);
      })
    : [];
  return { name: attr(el, "name"), entity: attr(el, "entity"), steps };
}

// ---------------------------------------------------------------------------
// Auditing — role -> column name mapping, so a renamed audit column still stamps correctly.
// ---------------------------------------------------------------------------
export type AuditRole = "createdBy" | "createdOn" | "updatedBy" | "updatedOn";
export type AuditingDef = {
  name: string;
  concurrency: "timestamp" | null;
  fields: { role: AuditRole; name: string }[];
};

export function parseAuditingElement(xml: string): AuditingDef {
  const el = parseXml(xml);
  const fields = childElements(el, "Field").map((f) => ({ role: (attr(f, "role") as AuditRole), name: attr(f, "name") }));
  return { name: attr(el, "name"), concurrency: (attrOrNull(el, "concurrency") as "timestamp" | null), fields };
}
