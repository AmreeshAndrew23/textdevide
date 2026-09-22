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
};

export type GridColumn = { id: string; header: string; binding: string };
export type GridItem = { kind: "grid"; id: string; label: string; emptyMessage: string; columns: GridColumn[]; eventTypes: string[] };
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
  };
}

function parseButton(el: XmlElement, eventsByElement: Map<string, string[]>): ButtonItem {
  const id = attr(el, "id");
  return { kind: "button", id, label: attr(el, "label", id), style: attr(el, "style", "primary"), eventTypes: eventsByElement.get(id) || [] };
}

function parseGrid(el: XmlElement, eventsByElement: Map<string, string[]>): GridItem {
  const id = attr(el, "id");
  const columns = childElements(firstChild(el, "columns") ?? el, "column").map((c) => ({
    id: attr(c, "id"),
    header: attr(c, "header", attr(c, "id")),
    binding: attr(c, "binding", attr(c, "id")),
  }));
  return { kind: "grid", id, label: attr(el, "label", id), emptyMessage: attr(el, "emptyMessage", "No records."), columns, eventTypes: eventsByElement.get(id) || [] };
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
  const eventsEl = firstChild(root, "events");
  for (const ev of eventsEl ? childElements(eventsEl, "event") : []) {
    const elId = attr(ev, "element");
    const type = attr(ev, "type");
    if (!elId || !type) continue;
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
  };
}
