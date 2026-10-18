/**
 * Typed parse of a screen's XML into a full render-ready model — fields/grids/buttons in document
 * order (respecting <fieldset> grouping), plus the same query/event metadata engine.ts already
 * extracts. Shares its DOM helpers with engine.ts (same @xmldom/xmldom parse) rather than
 * duplicating them; this module only adds what engine.ts didn't need (the UI's visual shape),
 * never changes how events/queries execute.
 */
import { DOMParser } from "@xmldom/xmldom";
import type { Element as XmlElement } from "@xmldom/xmldom";

export function isElement(n: unknown): n is XmlElement {
  return (n as { nodeType?: number }).nodeType === 1;
}

export function childElements(parent: XmlElement, tagName?: string): XmlElement[] {
  const els = Array.from(parent.childNodes || []).filter(isElement);
  return tagName ? els.filter((el) => el.tagName === tagName) : els;
}

// minAge/maxAge are for a type="date" field holding a birth date (or similar) — they don't compare
// the stored value itself, they compare the AGE IN WHOLE YEARS computed from it against today, e.g.
// <rule maxAge="23"/> on a date_of_birth field rejects anyone who has already turned 24.
export type FieldRule = {
  required?: boolean; pattern?: string; maxLength?: number; minValue?: number; maxValue?: number; unique?: boolean;
  minAge?: number; maxAge?: number;
};

export type FieldOption = { value: string; label: string };

export type FieldItem = {
  kind: "field";
  id: string;
  label: string;
  type: string;
  readonly: boolean;
  persistenceMapping: string | null;
  rules: FieldRule[];
  hint: string | null;
  eventTypes: string[];
  // <option value="..." label="..."/> children of a type="select" field — a real dropdown when
  // present; omitted/empty keeps today's plain-text-input fallback (no options source available).
  options: FieldOption[];
  // default="..." — the field's initial value, baked into the rendered control. Needed for any
  // field that isn't backed by a saved column (search/filter/sort/pagination inputs) but still has
  // to carry a sensible starting value the very first time the screen loads, e.g. a pagination
  // "skip" field defaulting to "0" so the first SKIP $skip in Cypher isn't an empty string.
  defaultValue: string | null;
  // optionValue="col" optionLabel="col" on a type="select" field — marks it as populated from a
  // REAL query's rows (e.g. picking an existing Exam to register for) instead of a fixed list the
  // AI wrote into the XML. Populated the same way a grid is: <map result="rows"
  // target="field:fieldId:options"/>. Takes priority over static <option> children when both
  // happen to be present.
  optionsBinding: { valueColumn: string; labelColumn: string } | null;
  // visibleRoles="Admin,Manager" — null means visible to every logged-in session (today's default
  // behavior); when set, only a session whose role is in this list gets the field rendered at all.
  // Hiding it here is the UI half only — engine.ts separately rejects a write sourced from a hidden
  // field server-side, since a client can always edit the DOM/request directly.
  visibleRoles: string[] | null;
};

export type GridColumn = { id: string; header: string; binding: string; persistenceMapping: string | null };
// <action type="edit"/> is a labeled affordance for the row-click-to-populate-form behavior the
// client script already does for every grid — it carries no target/confirm of its own.
// <action type="delete" target="buttonId" confirm="..."/> fires that REAL button's own <event>
// (declared normally in <events>, same as any other button) using the clicked row's
// persistence-mapped values instead of the form's current field values.
export type GridAction = { type: "edit" } | { type: "delete"; target: string; confirm: string | null };
export type GridItem = {
  kind: "grid"; id: string; label: string; emptyMessage: string; columns: GridColumn[]; eventTypes: string[]; actions: GridAction[];
};
// bulkCsv: the id of a textarea field on this same screen holding pasted CSV text (header row +
// data rows). When set, the button runs its own click event once PER DATA ROW instead of once —
// see renderer.ts's data-bulk-csv handler — reusing the exact same single-row event/query logic a
// normal Save already has, just invoked N times with that row's columns overlaid onto the form's
// other field values. Lets any "create one row" screen become a bulk importer with zero new
// engine/query concepts, only a different client-side trigger.
// downloadTemplate: a comma-separated header row (e.g. "name,email,phone") this button hands the
// browser as a plain .csv file download — pure client-side, no server round trip at all. Lets a
// bulk-import screen show exactly which columns/order the paste box expects, generated from data
// that already exists (the header text the AI wrote once) rather than the user guessing it.
export type ButtonItem = {
  kind: "button"; id: string; label: string; style: string; eventTypes: string[];
  bulkCsv: string | null; downloadTemplate: string | null;
};
export type FieldsetItem = { kind: "fieldset"; legend: string; items: UiItem[] };
// <stat id="totalStudents" label="Total Students" icon="users"/> — a Dashboard metric card.
// Populated the exact same way a grid already is: a <map target="stat:totalStudents"> inside the
// screen's own load event (see renderer.ts) — the engine needs no changes for this at all, "stat:"
// is purely a rendering-layer target prefix, same as how "grid:" already works. icon names one of
// renderer.ts's fixed icon set (semantic — what the number represents — never a free-form visual
// choice, so it stays meaningful even though every OTHER icon in the shell is renderer-inferred).
export type StatItem = { kind: "stat"; id: string; label: string; icon: string | null };
export type UiItem = FieldItem | GridItem | ButtonItem | FieldsetItem | StatItem;

export type ScreenModel = {
  id: string;
  title: string;
  header: { title: string; subtitle: string };
  items: UiItem[];
  fields: FieldItem[];
  grids: GridItem[];
  buttons: ButtonItem[];
  stats: StatItem[];
  // Element ids of <event type="load"> handlers — fired once, automatically, when the page opens
  // (e.g. to fill a grid with the rows that already exist).
  loadElements: string[];
};

function attr(el: XmlElement, name: string, fallback = ""): string {
  return el.getAttribute(name) ?? fallback;
}

function text(el: XmlElement | undefined): string {
  return (el?.textContent ?? "").trim();
}

function firstChild(parent: XmlElement, tag: string): XmlElement | undefined {
  return childElements(parent, tag)[0];
}

function parseRules(fieldEl: XmlElement): FieldRule[] {
  return childElements(fieldEl, "rule").map((r) => {
    const rule: FieldRule = {};
    const requiredAttr = attr(r, "required");
    if (requiredAttr === "true") rule.required = true;
    if (attr(r, "unique") === "true") rule.unique = true;
    const pattern = attr(r, "pattern");
    if (pattern) rule.pattern = pattern;
    const maxLength = attr(r, "maxLength");
    if (maxLength) rule.maxLength = Number(maxLength);
    const minValue = attr(r, "minValue");
    if (minValue) rule.minValue = Number(minValue);
    const maxValue = attr(r, "maxValue");
    if (maxValue) rule.maxValue = Number(maxValue);
    const minAge = attr(r, "minAge");
    if (minAge) rule.minAge = Number(minAge);
    const maxAge = attr(r, "maxAge");
    if (maxAge) rule.maxAge = Number(maxAge);
    return rule;
  });
}

function parseOptions(fieldEl: XmlElement): FieldOption[] {
  return childElements(fieldEl, "option").map((o) => ({ value: attr(o, "value"), label: attr(o, "label", attr(o, "value")) }));
}

// Same parsing engine.ts's own role-list attributes use — duplicated rather than imported, same
// reasoning as FieldRule parsing already being independently re-read in both modules (this module
// renders what the server separately, independently enforces).
function parseRoleList(value: string | null): string[] | null {
  if (!value) return null;
  const roles = value.split(",").map((r) => r.trim()).filter(Boolean);
  return roles.length ? roles : null;
}

function parseField(el: XmlElement, eventsByElement: Map<string, string[]>): FieldItem {
  const id = attr(el, "id");
  return {
    kind: "field",
    id,
    label: attr(el, "label", id),
    type: attr(el, "type", "text"),
    readonly: attr(el, "readonly") === "true",
    persistenceMapping: el.getAttribute("persistenceMapping"),
    rules: parseRules(el),
    hint: text(firstChild(el, "hint")) || null,
    eventTypes: eventsByElement.get(id) || [],
    options: parseOptions(el),
    defaultValue: el.getAttribute("default"),
    optionsBinding: (() => {
      const valueColumn = el.getAttribute("optionValue");
      const labelColumn = el.getAttribute("optionLabel");
      return valueColumn && labelColumn ? { valueColumn, labelColumn } : null;
    })(),
    visibleRoles: parseRoleList(el.getAttribute("visibleRoles")),
  };
}

function parseButton(el: XmlElement, eventsByElement: Map<string, string[]>): ButtonItem {
  const id = attr(el, "id");
  return {
    kind: "button", id, label: attr(el, "label", id), style: attr(el, "style", "primary"),
    eventTypes: eventsByElement.get(id) || [], bulkCsv: el.getAttribute("bulkCsv") || null,
    downloadTemplate: el.getAttribute("downloadTemplate") || null,
  };
}

function parseGridActions(el: XmlElement): GridAction[] {
  const actionsEl = firstChild(el, "actions");
  if (!actionsEl) return [];
  const out: GridAction[] = [];
  for (const a of childElements(actionsEl, "action")) {
    const type = attr(a, "type");
    if (type === "edit") out.push({ type: "edit" });
    else if (type === "delete") {
      const target = attr(a, "target");
      if (target) out.push({ type: "delete", target, confirm: a.getAttribute("confirm") });
    }
  }
  return out;
}

function parseGrid(el: XmlElement, eventsByElement: Map<string, string[]>): GridItem {
  const id = attr(el, "id");
  const columns = childElements(firstChild(el, "columns") ?? el, "column").map((c) => ({
    id: attr(c, "id"),
    header: attr(c, "header", attr(c, "id")),
    binding: attr(c, "binding", attr(c, "id")),
    persistenceMapping: c.getAttribute("persistenceMapping"),
  }));
  return {
    kind: "grid", id, label: attr(el, "label", id), emptyMessage: attr(el, "emptyMessage", "No records."),
    columns, eventTypes: eventsByElement.get(id) || [], actions: parseGridActions(el),
  };
}

function parseStat(el: XmlElement): StatItem {
  const id = attr(el, "id");
  return { kind: "stat", id, label: attr(el, "label", id), icon: el.getAttribute("icon") };
}

function parseUiItems(parent: XmlElement, eventsByElement: Map<string, string[]>): UiItem[] {
  const items: UiItem[] = [];
  for (const el of childElements(parent)) {
    if (el.tagName === "field") items.push(parseField(el, eventsByElement));
    else if (el.tagName === "grid") items.push(parseGrid(el, eventsByElement));
    else if (el.tagName === "button") items.push(parseButton(el, eventsByElement));
    else if (el.tagName === "stat") items.push(parseStat(el));
    else if (el.tagName === "fieldset") items.push({ kind: "fieldset", legend: attr(el, "legend"), items: parseUiItems(el, eventsByElement) });
  }
  return items;
}

function flatten(items: UiItem[]): { fields: FieldItem[]; grids: GridItem[]; buttons: ButtonItem[]; stats: StatItem[] } {
  const fields: FieldItem[] = [];
  const grids: GridItem[] = [];
  const buttons: ButtonItem[] = [];
  const stats: StatItem[] = [];
  const walk = (list: UiItem[]) => {
    for (const it of list) {
      if (it.kind === "field") fields.push(it);
      else if (it.kind === "grid") grids.push(it);
      else if (it.kind === "button") buttons.push(it);
      else if (it.kind === "stat") stats.push(it);
      else walk(it.items);
    }
  };
  walk(items);
  return { fields, grids, buttons, stats };
}

export class ScreenParseError extends Error {}

export function parseScreenModel(xml: string): ScreenModel {
  let root: XmlElement;
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (!doc.documentElement) throw new Error("empty document");
    root = doc.documentElement;
  } catch (e) {
    throw new ScreenParseError(`Screen XML is not well-formed: ${e}`);
  }
  if (root.tagName !== "screen") throw new ScreenParseError('Root element must be <screen>');

  const eventsByElement = new Map<string, string[]>();
  const loadElements: string[] = [];
  const eventsEl = firstChild(root, "events");
  for (const ev of eventsEl ? childElements(eventsEl, "event") : []) {
    const elId = attr(ev, "element");
    const type = attr(ev, "type");
    if (!elId || !type) continue;
    if (type === "load" && !loadElements.includes(elId)) loadElements.push(elId);
    const list = eventsByElement.get(elId) || [];
    list.push(type);
    eventsByElement.set(elId, list);
  }

  const headerEl = firstChild(root, "header");
  const uiEl = firstChild(root, "ui");
  const items = uiEl ? parseUiItems(uiEl, eventsByElement) : [];
  const { fields, grids, buttons, stats } = flatten(items);

  return {
    id: attr(root, "id"),
    title: attr(root, "title", attr(root, "id")),
    header: { title: text(firstChild(headerEl ?? root, "title")) || attr(root, "title"), subtitle: text(firstChild(headerEl ?? root, "subtitle")) },
    items,
    fields,
    grids,
    buttons,
    stats,
    loadElements,
  };
}
