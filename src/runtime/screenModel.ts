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

export type FieldRule = { required?: boolean; pattern?: string; maxLength?: number; minValue?: number; maxValue?: number };

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
export type ButtonItem = { kind: "button"; id: string; label: string; style: string; eventTypes: string[] };
export type FieldsetItem = { kind: "fieldset"; legend: string; items: UiItem[] };
export type UiItem = FieldItem | GridItem | ButtonItem | FieldsetItem;

export type ScreenModel = {
  id: string;
  title: string;
  header: { title: string; subtitle: string };
  items: UiItem[];
  fields: FieldItem[];
  grids: GridItem[];
  buttons: ButtonItem[];
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
    const pattern = attr(r, "pattern");
    if (pattern) rule.pattern = pattern;
    const maxLength = attr(r, "maxLength");
    if (maxLength) rule.maxLength = Number(maxLength);
    const minValue = attr(r, "minValue");
    if (minValue) rule.minValue = Number(minValue);
    const maxValue = attr(r, "maxValue");
    if (maxValue) rule.maxValue = Number(maxValue);
    return rule;
  });
}

function parseOptions(fieldEl: XmlElement): FieldOption[] {
  return childElements(fieldEl, "option").map((o) => ({ value: attr(o, "value"), label: attr(o, "label", attr(o, "value")) }));
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
  };
}

function parseButton(el: XmlElement, eventsByElement: Map<string, string[]>): ButtonItem {
  const id = attr(el, "id");
  return { kind: "button", id, label: attr(el, "label", id), style: attr(el, "style", "primary"), eventTypes: eventsByElement.get(id) || [] };
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

function parseUiItems(parent: XmlElement, eventsByElement: Map<string, string[]>): UiItem[] {
  const items: UiItem[] = [];
  for (const el of childElements(parent)) {
    if (el.tagName === "field") items.push(parseField(el, eventsByElement));
    else if (el.tagName === "grid") items.push(parseGrid(el, eventsByElement));
    else if (el.tagName === "button") items.push(parseButton(el, eventsByElement));
    else if (el.tagName === "fieldset") items.push({ kind: "fieldset", legend: attr(el, "legend"), items: parseUiItems(el, eventsByElement) });
  }
  return items;
}

function flatten(items: UiItem[]): { fields: FieldItem[]; grids: GridItem[]; buttons: ButtonItem[] } {
  const fields: FieldItem[] = [];
  const grids: GridItem[] = [];
  const buttons: ButtonItem[] = [];
  const walk = (list: UiItem[]) => {
    for (const it of list) {
      if (it.kind === "field") fields.push(it);
      else if (it.kind === "grid") grids.push(it);
      else if (it.kind === "button") buttons.push(it);
      else walk(it.items);
    }
  };
  walk(items);
  return { fields, grids, buttons };
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
  const { fields, grids, buttons } = flatten(items);

  return {
    id: attr(root, "id"),
    title: attr(root, "title", attr(root, "id")),
    header: { title: text(firstChild(headerEl ?? root, "title")) || attr(root, "title"), subtitle: text(firstChild(headerEl ?? root, "subtitle")) },
    items,
    fields,
    grids,
    buttons,
    loadElements,
  };
}
