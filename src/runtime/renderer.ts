/**
 * Turns a ScreenModel into one self-contained HTML page: server-rendered markup plus a small
 * inline client script that POSTs events to the existing, unmodified `/api/.../run-event` route
 * and applies the returned actions — a generalized, faithful port of XmlScreenRenderer.jsx's
 * `handleFieldCommit`/`applyActions` (see the plan for the exact behaviors being matched:
 * blur-commit vs immediate-commit, map/set treated identically, message replaces, stop is a
 * server-only concept the client never sees).
 */
import type { ButtonItem, FieldItem, GridAction, GridItem, ScreenModel, StatItem, UiItem } from "./screenModel.js";

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return esc(s).replace(/'/g, "&#39;");
}

const BUTTON_CLASS: Record<string, string> = { primary: "btn-primary", secondary: "btn-secondary", danger: "btn-danger", ghost: "btn-ghost" };

// ---------------------------------------------------------------------------
// Icon set — one cohesive outline style (24x24, 1.75px stroke, rounded caps), authored once here
// rather than pulled from an external pack, so every generated app shares the exact same visual
// language automatically. Used in three ways: (1) a fixed set an AI-generated <stat icon="..."/>
// picks from (semantic — what the number represents), and (2)/(3) nav items and buttons, which are
// NEVER AI-chosen — inferNavIcon/inferButtonIcon below pick them from data that already exists
// (screen name, button style/label), so the icon system stays identical across every app no matter
// what any one generation produces, and every already-generated app picks them up on its next
// render with zero regeneration.
// ---------------------------------------------------------------------------
const ICON_PATHS: Record<string, string> = {
  home: "M3 11.5 12 4l9 7.5M5.5 10v9a1 1 0 0 0 1 1H9.5v-6h5v6H18.5a1 1 0 0 0 1-1v-9",
  users: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16.5 3.13a4 4 0 0 1 0 7.75",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15Z",
  building: "M5 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M3 21h18M9 9h0M9 13h0M9 17h0M13 21v-4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13a8 8 0 0 0 0-2l2-1.5-2-3.46-2.36.94a8 8 0 0 0-1.73-1L15 3.5h-6l-.3 2.48a8 8 0 0 0-1.74 1l-2.35-.94-2 3.46L4.6 11a8 8 0 0 0 0 2l-2 1.5 2 3.46 2.35-.94a8 8 0 0 0 1.74 1L9 21.5h6l.3-2.48a8 8 0 0 0 1.74-1l2.35.94 2-3.46Z",
  chart: "M4 20V10M12 20V4M20 20v-7M3 20h18",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8L14 2ZM14 2v6h6",
  lock: "M5 11h14v10H5V11ZM8 11V7a4 4 0 0 1 8 0v4",
  plus: "M12 5v14M5 12h14",
  pencil: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  "log-out": "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  check: "M20 6 9 17l-5-5",
  "check-circle": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 12.5l2.5 2.5L16 9",
  "alert-circle": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 8v5M12 16h.01",
  "info-circle": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-5M12 8h.01",
  x: "M18 6 6 18M6 6l12 12",
  email: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM22 6l-10 7L2 6",
  user: "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM4 21a8 8 0 0 1 16 0",
  "chevron-down": "M6 9l6 6 6-6",
  moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
};

function icon(name: string, cls = "icon"): string {
  const d = ICON_PATHS[name];
  if (!d) return "";
  return `<svg class="${escAttr(cls)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// Best-effort keyword match on a screen's NAME (never AI-chosen) — a sensible icon for most real
// app sections, with a plain folder as the fallback for anything unrecognized, so nothing ever
// looks broken, just generic.
function inferNavIcon(name: string): string {
  const n = (name || "").toLowerCase();
  if (/\b(dashboard|home)\b/.test(n)) return "home";
  if (/\b(login|signup|sign up|account|auth)\b/.test(n)) return "lock";
  if (/\b(profile)\b/.test(n)) return "users";
  if (/\b(student|employee|user|staff|customer|member|people|person)\b/.test(n)) return "users";
  if (/\b(course|exam|paper|subject|class|lesson|training)\b/.test(n)) return "book";
  if (/\b(department|branch|office|building|facility)\b/.test(n)) return "building";
  if (/\b(report|result|analytic|stat|summary)\b/.test(n)) return "chart";
  if (/\b(setting|config|admin|role|permission)\b/.test(n)) return "settings";
  if (/\b(calendar|schedule|event|registration|booking|appointment)\b/.test(n)) return "calendar";
  if (/\b(invoice|order|document|record|file)\b/.test(n)) return "file";
  return "folder";
}

// Best-effort keyword match on a BUTTON's style/label — never AI-chosen. null means no icon (a
// button whose purpose doesn't map cleanly to anything in the set stays label-only, which is fine).
function inferButtonIcon(b: ButtonItem): string | null {
  const label = (b.label || "").toLowerCase();
  if (b.style === "danger" || /\b(delete|remove|cancel registration)\b/.test(label)) return "trash";
  if (/\b(add|new|create)\b/.test(label)) return "plus";
  if (/\b(save|submit|register|confirm)\b/.test(label)) return "check";
  if (/\b(search|filter)\b/.test(label)) return "search";
  if (/\b(export|download)\b/.test(label)) return "download";
  if (/\b(edit|update)\b/.test(label)) return "pencil";
  return null;
}

// Subtle field-type hint icon, shown small and muted next to the label — not load-bearing, purely a
// scannability aid for the types people recognize fastest.
function inferFieldIcon(f: FieldItem): string | null {
  if (f.type === "email") return "email";
  if (f.type === "date" || f.type === "time") return "calendar";
  if (f.type === "password") return "lock";
  return null;
}

// Every field type this vocabulary defines maps 1:1 to a native input. "select" renders a real
// <select> when the XML supplies <option value="..." label="..."/> children (e.g. a filter's fixed
// choice list); with no options source it falls back to a plain text input rather than rendering a
// dropdown with nothing in it — matching XmlScreenRenderer.jsx's NewFieldInput for that case.
function renderField(f: FieldItem): string {
  const required = f.rules.some((r) => r.required);
  const rule = f.rules[0] || {};
  const disabled = f.readonly ? " disabled" : "";
  // A <select>'s natural commit moment is choosing an option ("change"), not losing focus — same as
  // a checkbox, and unlike a text input where "blur" is what distinguishes "done typing" from every
  // keystroke.
  const commitEvent = f.type === "checkbox" || f.type === "select" || f.type === "image" ? "change" : "blur";
  const wiredEvents = f.eventTypes.filter((t) => t === "change").length ? ` data-commit-event="${commitEvent}"` : "";

  const def = f.defaultValue;
  let control: string;
  if (f.type === "checkbox") {
    const checked = def === "true" ? " checked" : "";
    control = `<input type="checkbox" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${checked}${disabled}${wiredEvents}>`;
  } else if (f.type === "image") {
    // Read client-side into a data-URL (see clientScript's image-field wiring below) — no server
    // upload endpoint; the only "value" the engine ever sees is that data-URL string, bound into a
    // query straight into a Neo4j property, same approach the Studio itself already uses for screen
    // reference images. Capped client-side at 2MB — a profile photo, not a full design upload. No
    // default/pre-fill: browsers block programmatically setting a file input's value.
    control = `<input type="file" accept="image/*" id="${escAttr(f.id)}" name="${escAttr(f.id)}" data-image-field${disabled}${wiredEvents}>`;
  } else if (f.type === "select" && f.optionsBinding) {
    // Populated from a REAL query's rows (e.g. picking an existing Exam), not a fixed list — this
    // is only the initial shell; the client script replaces it once the screen's load event (or
    // whatever event the XML wires) maps rows onto "field:fieldId:options", same spirit as a grid's
    // emptyMessage row before ITS load event fires.
    control = `<select id="${escAttr(f.id)}" name="${escAttr(f.id)}"${disabled}${wiredEvents}><option value="">Select…</option></select>`;
  } else if (f.type === "select" && f.options.length) {
    // A real dropdown only when the XML supplies <option> children (e.g. a filter's fixed choice
    // list) — a select with no options source still falls through to the plain-text-input fallback
    // below, exactly as before.
    const opts = f.options.map((o) => `<option value="${escAttr(o.value)}"${def !== null && o.value === def ? " selected" : ""}>${esc(o.label)}</option>`).join("");
    control = `<select id="${escAttr(f.id)}" name="${escAttr(f.id)}"${disabled}${wiredEvents}>${opts}</select>`;
  } else if (f.type === "textarea") {
    control = `<textarea id="${escAttr(f.id)}" name="${escAttr(f.id)}" rows="3"${disabled}${wiredEvents}>${def ? esc(def) : ""}</textarea>`;
  } else if (f.type === "number") {
    const min = rule.minValue !== undefined ? ` min="${rule.minValue}"` : "";
    const max = rule.maxValue !== undefined ? ` max="${rule.maxValue}"` : "";
    const value = def !== null ? ` value="${escAttr(def)}"` : "";
    control = `<input type="number" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${min}${max}${value}${disabled}${wiredEvents}>`;
  } else if (["date", "time", "email", "url", "color", "password"].includes(f.type)) {
    const value = def !== null ? ` value="${escAttr(def)}"` : "";
    control = `<input type="${escAttr(f.type)}" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${value}${disabled}${wiredEvents}>`;
  } else {
    // "select" with no options, and any other/unknown type — see comment above.
    const maxLength = rule.maxLength !== undefined ? ` maxlength="${rule.maxLength}"` : "";
    const pattern = rule.pattern ? ` pattern="${escAttr(rule.pattern)}"` : "";
    const value = def !== null ? ` value="${escAttr(def)}"` : "";
    control = `<input type="text" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${maxLength}${pattern}${value}${disabled}${wiredEvents}>`;
  }

  const fieldIcon = inferFieldIcon(f);
  const labelIcon = fieldIcon ? icon(fieldIcon, "icon field-label-icon") : "";
  const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : "";
  return `<div class="field-wrap" data-field="${escAttr(f.id)}">
  <label for="${escAttr(f.id)}">${labelIcon}${esc(f.label)}${required ? ' <span class="req">*</span>' : ""}</label>
  ${control}
  ${hint}
</div>`;
}

// 3 shimmering placeholder rows, shown until this grid's first real load — swapped for the real
// rows/empty-state by renderGridRows() client-side (see clientScript), with a safety fallback after
// the page's whole load-event chain settles so a grid that's never wired to load can't stay stuck.
function skeletonRows(colCount: number): string {
  return Array.from({ length: 3 }, () => `<tr class="skeleton-row">${`<td><div class="skeleton-bar"></div></td>`.repeat(colCount || 1)}</tr>`).join("");
}

function renderGrid(g: GridItem): string {
  const headers = g.columns.map((c) => `<th>${esc(c.header)}</th>`).join("") + (g.actions.length ? `<th class="actions-col">Actions</th>` : "");
  const colCount = g.columns.length + (g.actions.length ? 1 : 0);
  return `<div class="card grid-wrap" data-grid="${escAttr(g.id)}" data-empty="${escAttr(g.emptyMessage)}">
  <div class="card-header"><h3>${esc(g.label)}</h3></div>
  <div class="table-scroll">
  <table>
    <thead><tr>${headers}</tr></thead>
    <tbody class="skeleton">${skeletonRows(colCount)}</tbody>
  </table>
  </div>
</div>`;
}

// Given a button's label, the URL of the project screen it names (or null).
type Linker = (label: string) => string | null;

const NOISE_WORDS = /\b(screen|page|view)\b/g;
const normalizeLabel = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const normalizeScreenName = (s: string) => normalizeLabel(s).replace(NOISE_WORDS, " ").replace(/\s+/g, " ").trim();

// A button whose label names another screen ("Dashboard", "Go to Login", "Forgot Password?") is a
// link to it, even when the generated XML wired no <navigate>. Whole-word phrase match, so
// "Go to Dashboard" matches a screen named "Dashboard Screen" but "Dash" would not; the longest
// matching screen name wins. The current screen is never a target.
export function findScreenForLabel(label: string, screens: ShellScreen[], currentScreenId: string): ShellScreen | null {
  const text = ` ${normalizeLabel(label)} `;
  let best: { screen: ShellScreen; len: number } | null = null;
  for (const s of screens) {
    if (s.id === currentScreenId) continue;
    const name = normalizeScreenName(s.name);
    if (!name || !text.includes(` ${name} `)) continue;
    if (!best || name.length > best.len) best = { screen: s, len: name.length };
  }
  return best ? best.screen : null;
}

function renderButton(b: ButtonItem, linkFor: Linker): string {
  const cls = BUTTON_CLASS[b.style] || BUTTON_CLASS.primary;
  const wired = b.eventTypes.includes("click") ? " data-click" : "";
  // Only a button with NO handler of its own becomes an automatic link — a Save/Login button that
  // runs real queries must never be hijacked just because its label contains a screen's name.
  const href = wired ? null : linkFor(b.label);
  const link = href ? ` data-nav-href="${escAttr(href)}"` : "";
  const btnIcon = inferButtonIcon(b);
  const iconHtml = btnIcon ? icon(btnIcon, "icon btn-icon") : "";
  // A click that runs a real query can take a visible moment (especially against a cold/slow
  // database) — a spinner on the SPECIFIC button clicked, not just a page-wide disable, is what
  // tells the user their click registered and something is actually happening.
  return `<button type="button" id="${escAttr(b.id)}" data-button${wired}${link} class="${cls}"><span class="btn-spinner" hidden></span>${iconHtml}<span class="btn-label">${esc(b.label)}</span></button>`;
}

function renderStat(s: StatItem): string {
  const iconHtml = s.icon ? icon(s.icon, "icon stat-icon") : "";
  return `<div class="stat-card" data-stat="${escAttr(s.id)}">
  ${iconHtml}
  <div class="stat-body"><div class="stat-value">—</div><div class="stat-label">${esc(s.label)}</div></div>
</div>`;
}

function renderOne(it: UiItem, linkFor: Linker): string {
  if (it.kind === "field") return renderField(it);
  if (it.kind === "grid") return renderGrid(it);
  if (it.kind === "button") return renderButton(it, linkFor);
  if (it.kind === "stat") return renderStat(it);
  return `<fieldset><legend>${esc(it.legend)}</legend>${renderInner(it.items, linkFor)}</fieldset>`;
}

// Used inside a <fieldset> — no card grouping there, the fieldset border is already the grouping.
function renderInner(items: UiItem[], linkFor: Linker): string {
  return items.map((it) => renderOne(it, linkFor)).join("\n");
}

// Drops any field whose visibleRoles excludes the current session's role, before rendering ever
// starts — simpler than threading role through every render function, and means a hidden field
// never reaches the page at all (not just CSS-hidden). A fieldset that ends up empty after this is
// dropped too (an empty box with just a legend would look broken), recursively. This is the UI half
// only — engine.ts separately refuses to WRITE a value for a field the role can't see, since a
// client can always edit the DOM/request directly regardless of what got rendered.
function filterItemsByRole(items: UiItem[], sessionRole: string | null): UiItem[] {
  const out: UiItem[] = [];
  for (const it of items) {
    if (it.kind === "field") {
      if (it.visibleRoles && (!sessionRole || !it.visibleRoles.includes(sessionRole))) continue;
      out.push(it);
    } else if (it.kind === "fieldset") {
      const innerItems = filterItemsByRole(it.items, sessionRole);
      if (innerItems.length) out.push({ ...it, items: innerItems });
    } else {
      out.push(it);
    }
  }
  return out;
}

// Top level only: consecutive fields/fieldsets group into one form card (a grid always starts its
// own separate card — see renderGrid). A button attaches to whatever field group is still open
// (so a Save button right after some fields renders inside that same card, at the bottom — the
// common form pattern) — but if nothing is open (a button appears right after a grid, or as the
// very first item, both real documented patterns), it renders as a plain toolbar instead of a
// lonely card containing only buttons.
function renderItems(items: UiItem[], linkFor: Linker): string {
  const out: string[] = [];
  let group: UiItem[] = [];
  let toolbar: ButtonItem[] = [];
  let statGroup: StatItem[] = [];
  const flushGroup = () => {
    if (group.length) out.push(`<div class="card form-card">\n${group.map((g) => renderOne(g, linkFor)).join("\n")}\n</div>`);
    group = [];
  };
  const flushToolbar = () => {
    if (toolbar.length) out.push(`<div class="toolbar">\n${toolbar.map((b) => renderOne(b, linkFor)).join("\n")}\n</div>`);
    toolbar = [];
  };
  // Stats group into their own row of cards (a Dashboard's metrics strip), separate from the
  // form-card/toolbar/grid groupings above — never mixed into a form card with ordinary fields.
  const flushStats = () => {
    if (statGroup.length) out.push(`<div class="stats-row">\n${statGroup.map((s) => renderStat(s)).join("\n")}\n</div>`);
    statGroup = [];
  };
  for (const it of items) {
    if (it.kind === "grid") {
      flushGroup();
      flushToolbar();
      flushStats();
      out.push(renderOne(it, linkFor));
    } else if (it.kind === "stat") {
      flushGroup();
      flushToolbar();
      statGroup.push(it);
    } else if (it.kind === "button") {
      flushStats();
      if (group.length) group.push(it); // attach to the still-open form card
      else toolbar.push(it); // nothing open — accumulate as a standalone toolbar row instead
    } else {
      flushToolbar();
      flushStats();
      group.push(it);
    }
  }
  flushGroup();
  flushToolbar();
  flushStats();
  return out.join("\n");
}

// Column bindings per grid, keyed by grid id — baked into the page so the client script knows
// which JSON keys to project into <td>s without re-parsing the XML itself.
function gridColumnsJson(model: ScreenModel): string {
  const map: Record<string, string[]> = {};
  for (const g of model.grids) map[g.id] = g.columns.map((c) => c.binding);
  return JSON.stringify(map);
}

// Per-row action defs (edit/delete), keyed by grid id — baked in exactly like GRID_COLUMNS so the
// client script can render each row's action buttons without re-parsing the XML.
function gridActionsJson(model: ScreenModel): string {
  const map: Record<string, GridAction[]> = {};
  for (const g of model.grids) if (g.actions.length) map[g.id] = g.actions;
  return JSON.stringify(map);
}

// Value/label column bindings for every data-backed select field, keyed by field id — lets the
// client script turn a mapped query's rows into real <option>s without re-parsing the XML.
function fieldOptionsJson(model: ScreenModel): string {
  const map: Record<string, { value: string; label: string }> = {};
  for (const f of model.fields) if (f.optionsBinding) map[f.id] = { value: f.optionsBinding.valueColumn, label: f.optionsBinding.labelColumn };
  return JSON.stringify(map);
}

// Which "table.column" each grid column / form field is bound to — lets clicking a grid row fill
// the form fields that map to the same column (edit-in-place), with no AI involvement.
function mappingsJson(model: ScreenModel): { grid: string; field: string } {
  const grid: Record<string, (string | null)[]> = {};
  for (const g of model.grids) grid[g.id] = g.columns.map((c) => c.persistenceMapping);
  const field: Record<string, string> = {};
  for (const f of model.fields) if (f.persistenceMapping) field[f.id] = f.persistenceMapping;
  return { grid: JSON.stringify(grid), field: JSON.stringify(field) };
}

function clientScript(model: ScreenModel, opts: { apiBase: string; projectId: number; screenId: string; token: string }): string {
  const mappings = mappingsJson(model);
  return `
<script>
(function () {
  var API_BASE = ${JSON.stringify(opts.apiBase)};
  var PROJECT_ID = ${JSON.stringify(opts.projectId)};
  var SCREEN_ID = ${JSON.stringify(opts.screenId)};
  var TOKEN = ${JSON.stringify(opts.token)};
  var GRID_COLUMNS = ${gridColumnsJson(model)};
  var GRID_ACTIONS = ${gridActionsJson(model)};
  var FIELD_OPTIONS = ${fieldOptionsJson(model)};
  var GRID_MAPPINGS = ${mappings.grid};
  var FIELD_MAPPINGS = ${mappings.field};
  var LOAD_ELEMENTS = ${JSON.stringify(model.loadElements)};
  var GRID_ROWS = {};
  var root = document;

  var FIELD_CONTROL_SELECTOR = "input, textarea, select";
  function fieldEl(id) {
    var wrap = root.querySelector('[data-field="' + id + '"]');
    return wrap ? wrap.querySelector(FIELD_CONTROL_SELECTOR) : null;
  }
  function fieldValue(el) {
    if (el.type === "checkbox") return el.checked;
    // A file input's own .value is just the filename, never the content — the real data-URL (read
    // asynchronously by the change listener below) is cached on the element itself.
    if (el.type === "file") return el.dataset.dataUrl || "";
    return el.value;
  }
  function allFieldValues() {
    var values = {};
    root.querySelectorAll("[data-field]").forEach(function (wrap) {
      var el = wrap.querySelector(FIELD_CONTROL_SELECTOR);
      if (el) values[wrap.getAttribute("data-field")] = fieldValue(el);
    });
    return values;
  }

  var TOAST_ICONS = {
    error: ${JSON.stringify(icon("alert-circle", "icon toast-icon"))},
    success: ${JSON.stringify(icon("check-circle", "icon toast-icon"))},
    notice: ${JSON.stringify(icon("info-circle", "icon toast-icon"))},
  };
  // Floating toast stack, not an inline banner — same call signature/call site as before
  // (applyActions below), only the visual treatment changed. Each new batch replaces whatever
  // toasts are still showing (same "replace" semantics the old banner already had), but each toast
  // gets its own slide-in and, for success/notice, its own auto-dismiss timer — an error stays until
  // the user dismisses it or the next action replaces it, since that's the one people actually need
  // time to read.
  function showMessages(messages) {
    var box = root.getElementById("screen-messages");
    box.innerHTML = "";
    (messages || []).forEach(function (m) {
      var kind = m.messageType === "error" ? "error" : m.messageType === "success" ? "success" : "notice";
      var div = document.createElement("div");
      div.className = "toast toast-" + kind;
      div.innerHTML = (TOAST_ICONS[kind] || "") + '<span class="toast-text"></span><button type="button" class="toast-close" aria-label="Dismiss">' + ${JSON.stringify(icon("x", "icon"))} + "</button>";
      div.querySelector(".toast-text").textContent = m.value;
      div.querySelector(".toast-close").addEventListener("click", function () { div.remove(); });
      box.appendChild(div);
      if (kind !== "error") setTimeout(function () { div.remove(); }, 4500);
    });
  }

  function setBusy(busy, triggerBtn) {
    root.querySelectorAll("[data-button]").forEach(function (b) { b.disabled = busy; });
    if (triggerBtn) {
      var spinner = triggerBtn.querySelector(".btn-spinner");
      if (spinner) spinner.hidden = !busy;
    }
  }

  function navigateUrl(screenId) {
    return API_BASE + "/runtime/projects/" + PROJECT_ID + "/screens/" + screenId + "?token=" + encodeURIComponent(TOKEN);
  }

  function applyActions(actions) {
    var messages = [];
    var navigateTo = null;
    (actions || []).forEach(function (a) {
      if ((a.type === "map" || a.type === "set") && typeof a.target === "string" && a.target.indexOf("field:") === 0 && a.target.slice(-8) === ":options" && Array.isArray(a.value)) {
        renderFieldOptions(a.target.slice(6, -8), a.value);
      } else if ((a.type === "map" || a.type === "set") && typeof a.target === "string" && a.target.indexOf("field:") === 0) {
        var el = fieldEl(a.target.slice(6));
        if (el) { if (el.type === "checkbox") el.checked = Boolean(a.value); else el.value = a.value == null ? "" : a.value; }
      } else if ((a.type === "map" || a.type === "set") && typeof a.target === "string" && a.target.indexOf("grid:") === 0 && Array.isArray(a.value)) {
        renderGridRows(a.target.slice(5), a.value);
      } else if ((a.type === "map" || a.type === "set") && typeof a.target === "string" && a.target.indexOf("stat:") === 0) {
        var statWrap = root.querySelector('[data-stat="' + a.target.slice(5) + '"]');
        var statValueEl = statWrap ? statWrap.querySelector(".stat-value") : null;
        if (statValueEl) statValueEl.textContent = a.value == null ? "0" : String(a.value);
      } else if (a.type === "message") {
        messages.push(a);
      } else if (a.type === "navigate") {
        navigateTo = a.screenId;
      }
      // "stop" carries no client-side meaning — it already shaped which actions the server sent.
    });
    showMessages(messages);
    // Applied last, after every other action in this batch (a field/grid update right before
    // navigating away should still be visible for the instant before the page unloads) — a real
    // page navigation (the rendered screen IS the whole surface, no shell to swap in place), so
    // this works the same whether the page is standalone or embedded in an iframe.
    if (navigateTo) window.location.href = navigateUrl(navigateTo);
  }

  function attrEscape(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML.replace(/"/g, "&quot;");
  }

  // Values of the form fields bound (by persistenceMapping) to the same columns as this grid —
  // shared by edit-in-place (apply to the DOM) and a row's Delete action (send as fieldValues).
  function mappedRowValues(gridId, row) {
    var bindings = GRID_COLUMNS[gridId] || [];
    var mappings = GRID_MAPPINGS[gridId] || [];
    var values = {};
    bindings.forEach(function (binding, i) {
      if (!mappings[i]) return;
      Object.keys(FIELD_MAPPINGS).forEach(function (fieldId) {
        if (FIELD_MAPPINGS[fieldId] === mappings[i]) values[fieldId] = row[binding];
      });
    });
    return values;
  }

  var EMPTY_ICON = ${JSON.stringify(icon("folder", "icon empty-icon"))};
  var EDIT_ICON = ${JSON.stringify(icon("pencil", "icon"))};
  var DELETE_ICON = ${JSON.stringify(icon("trash", "icon"))};

  // Swaps this grid's skeleton placeholder (shown from first paint, see renderGrid) for its real
  // content — the one place that transition happens, whether triggered by a real load-event
  // response or the end-of-load-chain safety fallback below.
  function renderGridRows(gridId, rows) {
    var wrap = root.querySelector('[data-grid="' + gridId + '"]');
    if (!wrap) return;
    var tbody = wrap.querySelector("tbody");
    tbody.classList.remove("skeleton");
    var bindings = GRID_COLUMNS[gridId] || [];
    var actions = GRID_ACTIONS[gridId] || [];
    GRID_ROWS[gridId] = rows;
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="' + Math.max(bindings.length + (actions.length ? 1 : 0), 1) + '">' + EMPTY_ICON + '<span>' + (wrap.getAttribute("data-empty") || "") + "</span></td></tr>";
      return;
    }
    tbody.innerHTML = rows.map(function (row, i) {
      var cells = bindings.map(function (b) {
        var v = row[b];
        var span = document.createElement("span"); span.textContent = v == null ? "" : String(v);
        return "<td>" + span.innerHTML + "</td>";
      }).join("");
      if (actions.length) {
        cells += '<td class="row-actions">' + actions.map(function (a) {
          if (a.type === "edit") return '<button type="button" class="row-action-btn" data-row-edit="' + i + '">' + EDIT_ICON + "<span>Edit</span></button>";
          var confirmAttr = a.confirm ? ' data-row-confirm="' + attrEscape(a.confirm) + '"' : "";
          return '<button type="button" class="row-action-btn row-action-danger" data-row-delete="' + i + '" data-row-target="' + attrEscape(a.target) + '"' + confirmAttr + '><span class="btn-spinner" hidden></span>' + DELETE_ICON + "<span>Delete</span></button>";
        }).join("") + "</td>";
      }
      return '<tr data-row="' + i + '">' + cells + "</tr>";
    }).join("");
  }

  // Rebuilds a data-backed select's <option> list from a mapped query's rows — the sibling of
  // renderGridRows, for a dropdown instead of a table. A leading blank option is always included so
  // nothing is silently pre-selected; FIELD_OPTIONS[fieldId] names which row property is the value
  // and which is the label.
  function renderFieldOptions(fieldId, rows) {
    var binding = FIELD_OPTIONS[fieldId];
    var el = fieldEl(fieldId);
    if (!binding || !el || el.tagName !== "SELECT") {
      // Silent otherwise: a mapped "field:x:options" that can't be applied looks exactly like a
      // dropdown that "sometimes doesn't work" with nothing in the console to explain why — this is
      // almost always a mismatch between this query's map target and the field's own id, or a
      // missing optionValue/optionLabel on a select-type field (it then falls back to a plain text
      // input per renderField's comment above, so there is no dropdown at all).
      console.warn(
        "Dropdown options for field '" + fieldId + "' not applied: " +
        (!binding ? "no optionValue/optionLabel binding for this field id (check the <map target> matches a real <field optionValue optionLabel> id)."
          : !el ? "no field with this id found on the screen."
          : "field '" + fieldId + "' is not rendered as a dropdown (optionValue/optionLabel may be missing on it).")
      );
      return;
    }
    var opts = '<option value="">Select…</option>' + rows.map(function (row) {
      var v = row[binding.value];
      var l = row[binding.label];
      var span = document.createElement("span"); span.textContent = l == null ? "" : String(l);
      return '<option value="' + attrEscape(v == null ? "" : String(v)) + '">' + span.innerHTML + "</option>";
    }).join("");
    el.innerHTML = opts;
  }

  // Clicking a grid row copies its values into every form field bound to the same table.column
  // (edit-in-place) — the matching is by persistenceMapping, so it works for any generated screen.
  // A click on a row's Delete button instead fires that button's own <event> (wired normally in
  // <events>, same as any other button) using THIS row's values, after an optional confirm().
  root.querySelectorAll("[data-grid]").forEach(function (wrap) {
    wrap.addEventListener("click", function (e) {
      var gridId = wrap.getAttribute("data-grid");
      var delBtn = e.target.closest && e.target.closest("[data-row-delete]");
      if (delBtn) {
        var delRow = (GRID_ROWS[gridId] || [])[Number(delBtn.getAttribute("data-row-delete"))];
        if (!delRow) return;
        var confirmMsg = delBtn.getAttribute("data-row-confirm");
        if (confirmMsg && !window.confirm(confirmMsg)) return;
        var merged = allFieldValues();
        var rowValues = mappedRowValues(gridId, delRow);
        Object.keys(rowValues).forEach(function (k) { merged[k] = rowValues[k]; });
        fireEvent(delBtn.getAttribute("data-row-target"), "click", merged, delBtn);
        return;
      }
      var tr = e.target.closest && e.target.closest("tr[data-row]");
      if (!tr) return;
      var row = (GRID_ROWS[gridId] || [])[Number(tr.getAttribute("data-row"))];
      if (!row) return;
      var values = mappedRowValues(gridId, row);
      Object.keys(values).forEach(function (fieldId) {
        var el = fieldEl(fieldId);
        if (!el) return;
        var v = values[fieldId];
        if (el.type === "checkbox") el.checked = Boolean(v); else el.value = v == null ? "" : v;
      });
      wrap.querySelectorAll("tr.selected").forEach(function (r) { r.classList.remove("selected"); });
      tr.classList.add("selected");
    });
  });

  function fireEvent(elementId, eventType, valuesOverride, triggerBtn) {
    setBusy(true, triggerBtn);
    showMessages([]);
    return fetch(API_BASE + "/api/projects/" + PROJECT_ID + "/screens/" + SCREEN_ID + "/run-event", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ elementId: elementId, eventType: eventType, fieldValues: valuesOverride || allFieldValues() }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) { applyActions(data.actions || []); })
      .catch(function () { showMessages([{ messageType: "error", value: "Something went wrong — please try again." }]); })
      .finally(function () { setBusy(false, triggerBtn); });
  }

  root.querySelectorAll("[data-field]").forEach(function (wrap) {
    var fieldId = wrap.getAttribute("data-field");
    var el = wrap.querySelector(FIELD_CONTROL_SELECTOR);
    // A file input's own change fires synchronously, before the async FileReader read below ever
    // finishes populating its real value — auto-committing from THIS listener would send an empty/
    // stale value. Handled separately: no auto-commit, read into a data-URL only, submitted
    // whenever the surrounding form's own Save/Upload button is clicked (allFieldValues() already
    // picks the cached value up via fieldValue()'s el.type === "file" branch).
    if (!el || el.type === "file" || !el.hasAttribute("data-commit-event")) return;
    var commitEvent = el.getAttribute("data-commit-event");
    var lastCommitted = fieldValue(el);
    el.addEventListener(commitEvent, function () {
      var next = fieldValue(el);
      if (next === lastCommitted) return;
      lastCommitted = next;
      var values = allFieldValues();
      values[fieldId] = next;
      fireEvent(fieldId, "change", values);
    });
  });

  // Image fields (type="image" in the XML) — reads the chosen file into a data-URL client-side, the
  // same approach the Studio itself already uses for screen reference images. 2MB cap: a profile
  // photo, not a full design upload; rejected with a message rather than silently truncated.
  root.querySelectorAll("[data-image-field]").forEach(function (el) {
    el.addEventListener("change", function () {
      var file = el.files && el.files[0];
      if (!file) { delete el.dataset.dataUrl; return; }
      if (file.size > 2 * 1024 * 1024) {
        showMessages([{ messageType: "error", value: "Image is too large — please choose one under 2MB." }]);
        el.value = "";
        delete el.dataset.dataUrl;
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { el.dataset.dataUrl = reader.result; };
      reader.onerror = function () { showMessages([{ messageType: "error", value: "Couldn't read that image file." }]); };
      reader.readAsDataURL(file);
    });
  });

  root.querySelectorAll("[data-click]").forEach(function (btn) {
    btn.addEventListener("click", function () { fireEvent(btn.id, "click", undefined, btn); });
  });

  // A handler-less button whose label names another screen is a plain link to that screen.
  root.querySelectorAll("[data-nav-href]").forEach(function (btn) {
    btn.addEventListener("click", function () { window.location.href = btn.getAttribute("data-nav-href"); });
  });

  // The shell's built-in "Log out" control — structural, present automatically on every screen a
  // real app session is logged into, no XML/AI involvement needed. Clears the session server-side
  // (a plain cookie clear, not a Cypher event) then always navigates to the login screen, even if
  // the request itself fails — a stale cookie is harmless (it just won't verify on the next call).
  root.querySelectorAll("[data-app-logout]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var loginUrl = btn.getAttribute("data-login-url");
      fetch(API_BASE + "/runtime/projects/" + PROJECT_ID + "/logout", { method: "POST" })
        .catch(function () {})
        .then(function () { window.location.href = loginUrl; });
    });
  });

  // The Profile dropdown — click the trigger to open/close, click anywhere outside (or Escape) to
  // close. Structural, same spirit as Log out above.
  root.querySelectorAll("[data-profile-menu]").forEach(function (menu) {
    var trigger = menu.querySelector("[data-profile-trigger]");
    var dropdown = menu.querySelector("[data-profile-dropdown]");
    if (!trigger || !dropdown) return;
    function close() { dropdown.hidden = true; trigger.setAttribute("aria-expanded", "false"); }
    function open() { dropdown.hidden = false; trigger.setAttribute("aria-expanded", "true"); }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (dropdown.hidden) open(); else close();
    });
    document.addEventListener("click", function (e) { if (!menu.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  });

  // Dark/light mode — a per-viewer preference (localStorage, not synced server-side; see the early
  // inline <script> right after <body> that applies it before first paint to avoid a flash of the
  // wrong theme). The toggle's own icon/label always describes the OPPOSITE of the CURRENT mode.
  var THEME_KEY = "td_theme_scheme";
  root.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
    var iconEl = btn.querySelector("[data-theme-toggle-icon]");
    var labelEl = btn.querySelector("[data-theme-toggle-label]");
    function sync() {
      var dark = document.body.getAttribute("data-color-scheme") === "dark";
      iconEl.innerHTML = btn.getAttribute(dark ? "data-icon-dark" : "data-icon-light");
      labelEl.textContent = btn.getAttribute(dark ? "data-label-dark" : "data-label-light");
    }
    sync();
    btn.addEventListener("click", function () {
      var nowDark = document.body.getAttribute("data-color-scheme") !== "dark";
      if (nowDark) document.body.setAttribute("data-color-scheme", "dark");
      else document.body.removeAttribute("data-color-scheme");
      try { localStorage.setItem(THEME_KEY, nowDark ? "dark" : "light"); } catch (e) {}
      sync();
    });
  });

  // <event type="load"> handlers run once when the page opens, one after another (each finishes
  // before the next starts) — e.g. to fill a grid with the rows already saved.
  LOAD_ELEMENTS.reduce(function (chain, id) {
    return chain.then(function () { return fireEvent(id, "load"); });
  }, Promise.resolve()).then(function () {
    // Safety fallback: a grid genuinely never wired to any load event (filter/search-only) would
    // otherwise be stuck showing its skeleton forever — once every load event has had its chance,
    // anything still skeletal converts to its real (empty) state.
    root.querySelectorAll("tbody.skeleton").forEach(function (tbody) {
      var wrap = tbody.closest("[data-grid]");
      if (wrap) renderGridRows(wrap.getAttribute("data-grid"), GRID_ROWS[wrap.getAttribute("data-grid")] || []);
    });
  });
})();
</script>`;
}

export type ShellScreen = { id: string; name: string };

function shellUrl(opts: { apiBase: string; projectId: number; token: string }, screenId: string): string {
  return `${opts.apiBase}/runtime/projects/${opts.projectId}/screens/${screenId}?token=${encodeURIComponent(opts.token)}`;
}

type ShellOpts = {
  apiBase: string; projectId: number; screenId: string; token: string; appName: string; screens: ShellScreen[];
  // loggedIn is true ONLY for a real app session (never the builder's own Studio preview, never an
  // anonymous entry render) — that's when a structural, zero-AI-involvement "Log out" control (and
  // a "Profile" link, if the project has a screen by that name) appears in the shell.
  // loginScreenId (a sibling that hasAnonymousEntry) is where logout sends the user; null means no
  // such screen exists (no logout control rendered). profileScreenId is null if there's no Profile
  // screen (no Profile link rendered) — this is independent of loggedIn: never shown otherwise.
  loggedIn: boolean; loginScreenId: string | null; profileScreenId: string | null;
};

// Same top-bar + left-nav layout as frontend/src/components/AppShell.jsx — moved here so it's part
// of what actually ships (every screen carries its own copy), not preview-only React chrome that
// only existed inside the Studio.
function renderTopBar(opts: ShellOpts): string {
  const name = opts.appName || "App";
  const mark = esc(name.trim().charAt(0).toUpperCase() || "A");
  const brand = `<a class="app-topbar-brand" href="${escAttr(shellUrl(opts, opts.screenId))}"><span class="app-mark">${mark}</span><span class="app-topbar-title">${esc(name)}</span></a>`;
  if (!opts.loggedIn) return brand;
  // One Profile dropdown holds all three account-level actions — structural, zero AI/XML
  // involvement, present on every logged-in screen of every generated app. Change Password only
  // appears if the project has a screen named "Profile" (same detection runtimeRender.ts already
  // does); the theme toggle always appears (it's a pure client-side preference, no screen needed);
  // Log out only appears if a real login screen exists to send the user back to.
  const changePassword = opts.profileScreenId
    ? `<a class="profile-dropdown-item" href="${escAttr(shellUrl(opts, opts.profileScreenId))}">${icon("lock")}<span>Change Password</span></a>`
    : "";
  // data-theme-icon-light/dark hold BOTH icons' markup so the client script can swap between them
  // without re-fetching anything; data-theme-label-light/dark hold the matching label text. The
  // button always offers the OPPOSITE of the current mode ("Switch to Dark Mode" while in light).
  const themeToggle = `<button type="button" class="profile-dropdown-item" data-theme-toggle
      data-icon-light="${escAttr(icon("moon"))}" data-icon-dark="${escAttr(icon("sun"))}"
      data-label-light="Switch to Dark Mode" data-label-dark="Switch to Light Mode">
      <span data-theme-toggle-icon>${icon("moon")}</span><span data-theme-toggle-label>Switch to Dark Mode</span>
    </button>`;
  const logout = opts.loginScreenId
    ? `<button type="button" class="profile-dropdown-item profile-dropdown-danger" data-app-logout data-login-url="${escAttr(shellUrl(opts, opts.loginScreenId))}">${icon("log-out")}<span>Log out</span></button>`
    : "";
  const sep = changePassword ? '<div class="profile-dropdown-sep"></div>' : "";
  const menu = `<div class="profile-menu" data-profile-menu>
    <button type="button" class="profile-trigger" data-profile-trigger aria-haspopup="true" aria-expanded="false">
      ${icon("user")}<span>Account</span>${icon("chevron-down", "icon chevron")}
    </button>
    <div class="profile-dropdown" data-profile-dropdown hidden>
      ${changePassword}${sep}${themeToggle}${logout}
    </div>
  </div>`;
  return brand + `<div class="app-topbar-actions">${menu}</div>`;
}

// Plain <a href> links (real navigation, no JS needed for this part) — the active screen renders
// as inert text, not a link to itself.
function renderNavItems(opts: ShellOpts): string {
  if (!opts.screens.length) return '<span class="app-nav-empty">No other screens yet</span>';
  return opts.screens
    .map((s) => {
      const navIcon = icon(inferNavIcon(s.name), "icon nav-icon");
      return s.id === opts.screenId
        ? `<span class="app-nav-item active" aria-current="page">${navIcon}${esc(s.name)}</span>`
        : `<a class="app-nav-item" href="${escAttr(shellUrl(opts, s.id))}">${navIcon}${esc(s.name)}</a>`;
    })
    .join("\n");
}

export type ThemeKey = keyof typeof THEMES;

// A small curated set of named style presets — not free-form color picking, not AI-derived. Each
// key pairs a color palette WITH a real structural layout (header style, nav placement, form field
// layout, toolbar placement, card style, corner radius, density, numeric font) — not just a
// recolor of one fixed skeleton. Every structural difference is expressed as CSS driven by
// data-* attributes on <body> (see renderScreen) — the HTML shape itself never changes, so the
// event engine/client script stay completely unaffected by which preset is picked. Keys are
// unchanged from the original color-only version (already stored on real projects); "indigo"
// remains the default and what an unset/unrecognized key falls back to.
export const THEMES = {
  indigo: {
    label: "Modern", primary: "#4f46e5", primaryDark: "#3730a3", primaryLight: "#eef2ff", secondary: "#0891b2",
    header: "gradient", nav: "left", fields: "stacked", toolbar: "inline", card: "shadow", density: "comfortable", radius: "10px", mono: false,
  },
  slate: {
    label: "Enterprise", primary: "#334155", primaryDark: "#1e293b", primaryLight: "#f1f5f9", secondary: "#0891b2",
    header: "solid", nav: "left", fields: "inline", toolbar: "sticky", card: "shadow", density: "compact", radius: "4px", mono: false,
  },
  amber: {
    label: "Warm", primary: "#d97706", primaryDark: "#92400e", primaryLight: "#fffbeb", secondary: "#0369a1",
    header: "light", nav: "left", fields: "stacked", toolbar: "inline", card: "shadow", density: "comfortable", radius: "16px", mono: false,
  },
  emerald: {
    label: "Clinical", primary: "#059669", primaryDark: "#065f46", primaryLight: "#ecfdf5", secondary: "#7c3aed",
    header: "light", nav: "left", fields: "stacked", toolbar: "inline", card: "border", density: "comfortable", radius: "8px", mono: false,
  },
  ocean: {
    label: "Precision", primary: "#0284c7", primaryDark: "#075985", primaryLight: "#f0f9ff", secondary: "#7c3aed",
    header: "solid", nav: "left", fields: "stacked", toolbar: "inline", card: "shadow", density: "compact", radius: "6px", mono: true,
  },
  rose: {
    label: "Editorial", primary: "#e11d48", primaryDark: "#9f1239", primaryLight: "#fff1f2", secondary: "#0891b2",
    header: "solid", nav: "top", fields: "stacked", toolbar: "inline", card: "shadow", density: "comfortable", radius: "12px", mono: false,
  },
} as const;

export function resolveTheme(key: string | null | undefined) {
  return THEMES[(key as ThemeKey) ?? ""] ?? THEMES.indigo;
}

export function renderScreen(
  model: ScreenModel,
  opts: {
    apiBase: string; projectId: number; screenId: string; token: string; appName?: string; screens?: ShellScreen[]; theme?: string | null;
    loggedIn?: boolean; loginScreenId?: string | null; profileScreenId?: string | null; sessionRole?: string | null;
  }
): string {
  const shellOpts: ShellOpts = {
    ...opts, appName: opts.appName || "App", screens: opts.screens || [],
    loggedIn: opts.loggedIn ?? false, loginScreenId: opts.loginScreenId ?? null, profileScreenId: opts.profileScreenId ?? null,
  };
  const sessionRole = opts.sessionRole ?? null;
  const items = filterItemsByRole(model.items, sessionRole);
  // A field the client script never renders must also be absent from its option/mapping JSON, or
  // the script would carry live wiring for a field id with no matching DOM element.
  const visibleFields = model.fields.filter((f) => !f.visibleRoles || (sessionRole && f.visibleRoles.includes(sessionRole)));
  const visibleModel: ScreenModel = { ...model, items, fields: visibleFields };
  const t = resolveTheme(opts.theme);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  :root {
    --clr-primary: ${t.primary}; --clr-primary-dark: ${t.primaryDark}; --clr-primary-light: ${t.primaryLight};
    --clr-secondary: ${t.secondary};
    --clr-danger: #dc2626; --clr-success: #15803d;
    --clr-border: #e2e8f0; --clr-bg: #f8fafc; --clr-surface: #ffffff;
    --clr-text: #1e293b; --clr-muted: #64748b;
    --font-family: 'Inter', system-ui, -apple-system, sans-serif;
    --font-mono: 'SF Mono', 'Consolas', 'Menlo', monospace;
    --radius: ${t.radius};
    --shadow-card: 0 1px 2px rgba(15,23,42,0.04), 0 4px 12px rgba(15,23,42,0.05);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: var(--font-family); color: var(--clr-text); background: var(--clr-bg); display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }

  .icon { width: 17px; height: 17px; flex-shrink: 0; display: inline-block; vertical-align: -3px; }

  .app-topbar {
    flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; height: 56px;
    background: linear-gradient(135deg, var(--clr-primary-dark), var(--clr-primary));
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }
  .app-topbar-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .app-mark {
    width: 28px; height: 28px; border-radius: 8px; background: rgba(255,255,255,0.18);
    color: #fff; font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center;
  }
  .app-topbar-title { font-weight: 700; font-size: 15px; color: #fff; letter-spacing: 0.01em; }
  .app-topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .app-topbar-action {
    background: rgba(255,255,255,0.12); color: #fff; border: 1px solid rgba(255,255,255,0.25);
    padding: 7px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 600; cursor: pointer;
    font-family: inherit; text-decoration: none; display: inline-block;
  }
  .app-topbar-action:hover { background: rgba(255,255,255,0.22); }

  /* Profile menu — the single dropdown trigger that holds Change Password / theme toggle / Log out,
     structural on every screen a real app session is logged into, same zero-AI-involvement spirit
     as the rest of this shell. */
  .profile-menu { position: relative; }
  .profile-trigger {
    display: flex; align-items: center; gap: 7px; background: rgba(255,255,255,0.12); color: #fff;
    border: 1px solid rgba(255,255,255,0.25); padding: 6px 12px 6px 10px; border-radius: 7px;
    font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  .profile-trigger:hover { background: rgba(255,255,255,0.22); }
  .profile-trigger .chevron { width: 12px; height: 12px; transition: transform 0.15s; }
  .profile-trigger[aria-expanded="true"] .chevron { transform: rotate(180deg); }
  .profile-dropdown {
    position: absolute; top: calc(100% + 8px); right: 0; min-width: 210px; z-index: 50;
    background: var(--clr-surface); border: 1px solid var(--clr-border); border-radius: 10px;
    box-shadow: 0 8px 28px rgba(15,23,42,0.18), 0 2px 8px rgba(15,23,42,0.08); padding: 6px; overflow: hidden;
  }
  .profile-dropdown[hidden] { display: none; }
  .profile-dropdown-item {
    display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;
    padding: 9px 10px; border-radius: 7px; border: none; background: none; cursor: pointer;
    font-family: inherit; font-size: 13px; font-weight: 500; color: var(--clr-text); text-decoration: none;
    text-align: left;
  }
  .profile-dropdown-item:hover { background: var(--clr-bg); }
  .profile-dropdown-item .icon { color: var(--clr-muted); }
  .profile-dropdown-danger { color: var(--clr-danger); }
  .profile-dropdown-danger .icon { color: var(--clr-danger); }
  .profile-dropdown-sep { height: 1px; background: var(--clr-border); margin: 5px 2px; }

  .app-body { display: flex; flex: 1; min-height: 0; }
  .app-nav { width: 210px; flex-shrink: 0; background: var(--clr-surface); border-right: 1px solid var(--clr-border); padding: 16px 12px; overflow-y: auto; }
  .app-nav-item {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 7px; font-size: 13.5px; font-weight: 500;
    text-decoration: none; color: var(--clr-text); margin-bottom: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background 0.12s;
  }
  .app-nav-item .nav-icon { color: var(--clr-muted); }
  a.app-nav-item:hover { background: var(--clr-primary-light); color: var(--clr-primary-dark); }
  a.app-nav-item:hover .nav-icon { color: var(--clr-primary-dark); }
  .app-nav-item.active { background: var(--clr-primary); color: #fff; font-weight: 600; cursor: default; }
  .app-nav-item.active .nav-icon { color: rgba(255,255,255,0.85); }
  .app-nav-empty { display: block; padding: 9px 12px; font-size: 12.5px; color: var(--clr-muted); font-style: italic; }

  .app-content { flex: 1; min-width: 0; overflow: auto; padding: 32px 36px; }
  h1 { font-size: 23px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
  .subtitle { color: var(--clr-muted); font-size: 13.5px; margin-bottom: 24px; }

  .card { background: var(--clr-surface); border: 1px solid var(--clr-border); border-radius: var(--radius); box-shadow: var(--shadow-card); margin-bottom: 20px; }
  .form-card { padding: 24px 26px; max-width: 480px; }
  .card-header { padding: 16px 20px; border-bottom: 1px solid var(--clr-border); }
  .card-header h3 { margin: 0; font-size: 14.5px; font-weight: 600; }

  .stats-row { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; }
  .stat-card {
    display: flex; align-items: center; gap: 14px; background: var(--clr-surface);
    border: 1px solid var(--clr-border); border-radius: var(--radius); box-shadow: var(--shadow-card);
    padding: 18px 20px; flex: 1 1 200px; min-width: 180px;
  }
  .stat-icon {
    width: 40px; height: 40px; padding: 9px; border-radius: 10px; flex-shrink: 0;
    background: var(--clr-primary-light); color: var(--clr-primary-dark);
  }
  .stat-body { min-width: 0; }
  .stat-value { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; }
  .stat-label { font-size: 12.5px; color: var(--clr-muted); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .field-wrap { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .field-wrap:last-of-type { margin-bottom: 4px; }
  .field-wrap label { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--clr-text); }
  .field-label-icon { width: 14px; height: 14px; color: var(--clr-muted); }
  .req { color: var(--clr-danger); }
  .field-wrap input, .field-wrap textarea, .field-wrap select {
    padding: 9px 13px; border: 1.5px solid var(--clr-border); border-radius: 8px;
    font-size: 14px; font-family: inherit; color: var(--clr-text); background: var(--clr-surface);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .field-wrap input:focus, .field-wrap textarea:focus, .field-wrap select:focus {
    outline: none; border-color: var(--clr-primary); box-shadow: 0 0 0 3px var(--clr-primary-light);
  }
  .field-wrap input:disabled, .field-wrap textarea:disabled, .field-wrap select:disabled { background: #f1f5f9; color: #94a3b8; cursor: not-allowed; }
  .field-wrap input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--clr-primary); }
  .hint { font-size: 12px; color: var(--clr-muted); }

  fieldset { border: 1px solid var(--clr-border); border-radius: 8px; margin: 0 0 18px; padding: 14px 16px 4px; }
  legend { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--clr-muted); padding: 0 6px; }

  .grid-wrap { max-width: 100%; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 20px; border-bottom: 1px solid var(--clr-border); font-size: 13.5px; }
  th { color: var(--clr-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; background: #fafbfc; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: #fafbfc; }
  tbody tr[data-row] { cursor: pointer; }
  tbody tr.selected td { background: var(--clr-primary-light); }
  .empty-row td { color: var(--clr-muted); text-align: center; padding: 36px 20px; }
  .empty-row { display: table-row; }
  .empty-row td { display: flex; flex-direction: column; align-items: center; gap: 8px; border-bottom: none; }
  .empty-icon { width: 30px; height: 30px; color: #cbd5e1; }
  .actions-col { width: 1%; white-space: nowrap; }
  .row-actions { white-space: nowrap; }
  .row-action-btn {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; margin-right: 6px;
    border-radius: 6px; border: 1.5px solid var(--clr-border); background: var(--clr-surface); color: var(--clr-text); cursor: pointer;
  }
  .row-action-btn .icon { width: 13px; height: 13px; }
  .row-action-btn:hover { background: var(--clr-bg); }
  .row-action-danger { color: var(--clr-danger); border-color: #fecaca; }
  .row-action-danger:hover { background: #fef2f2; }

  /* Skeleton loading rows — shown from first paint until a grid's load event actually resolves. */
  .skeleton-bar { height: 13px; border-radius: 4px; background: linear-gradient(90deg, #eef1f5 25%, #e2e8f0 37%, #eef1f5 63%); background-size: 400% 100%; animation: skeleton-shimmer 1.4s ease infinite; }
  @keyframes skeleton-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

  .toolbar { margin-bottom: 20px; }
  button { font-family: inherit; padding: 9px 20px; border-radius: 8px; font-size: 13.5px; font-weight: 600; cursor: pointer; margin-right: 8px; margin-top: 4px; transition: filter 0.12s, box-shadow 0.12s; }
  button:disabled { opacity: 0.55; cursor: default; }
  .btn-primary { background: var(--clr-primary); color: #fff; border: none; box-shadow: 0 1px 2px rgba(79,70,229,0.3); }
  .btn-primary:not(:disabled):hover { filter: brightness(1.08); }
  .btn-secondary { background: #fff; color: var(--clr-text); border: 1.5px solid var(--clr-border); }
  .btn-secondary:not(:disabled):hover { background: var(--clr-bg); }
  .btn-danger { background: var(--clr-danger); color: #fff; border: none; }
  .btn-danger:not(:disabled):hover { filter: brightness(1.08); }
  .btn-ghost { background: transparent; color: var(--clr-primary); border: 1.5px solid var(--clr-primary); }
  .btn-ghost:not(:disabled):hover { background: var(--clr-primary-light); }
  .btn-spinner {
    display: inline-block; width: 12px; height: 12px; margin-right: 7px; vertical-align: -2px;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
    opacity: 0.85; animation: btn-spin 0.6s linear infinite;
  }
  .btn-spinner[hidden] { display: none; }
  @keyframes btn-spin { to { transform: rotate(360deg); } }
  .btn-icon { margin-right: 7px; }

  /* Floating toast stack — replaces the old inline banner. #screen-messages keeps its id/position in
     the DOM (right after the page header) but is now visually detached via fixed positioning. */
  #screen-messages {
    position: fixed; top: 18px; right: 18px; z-index: 1000;
    display: flex; flex-direction: column; gap: 8px; max-width: 360px;
  }
  .toast {
    display: flex; align-items: flex-start; gap: 10px; padding: 13px 14px; border-radius: 9px;
    font-size: 13.5px; font-weight: 500; box-shadow: 0 4px 16px rgba(15,23,42,0.12), 0 1px 3px rgba(15,23,42,0.08);
    animation: toast-in 0.18s ease-out;
  }
  .toast-icon { margin-top: 1px; }
  .toast-text { flex: 1; line-height: 1.4; }
  .toast-close { background: none; border: none; padding: 2px; margin: 0; cursor: pointer; opacity: 0.6; border-radius: 4px; }
  .toast-close:hover { opacity: 1; background: rgba(0,0,0,0.06); }
  .toast-close .icon { width: 13px; height: 13px; }
  .toast-notice { background: #f1f5f9; color: #334155; }
  .toast-error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
  .toast-success { background: #f0fdf4; color: var(--clr-success); border: 1px solid #bbf7d0; }
  @keyframes toast-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }

  /* ---- Structural preset variants, driven by data-* attributes on <body> ---- */
  /* header: gradient (default, above) | solid | light */
  body[data-header="solid"] .app-topbar { background: var(--clr-primary-dark); }
  body[data-header="light"] .app-topbar {
    background: var(--clr-surface); border-bottom: 1px solid var(--clr-border); box-shadow: none;
  }
  body[data-header="light"] .app-mark { background: var(--clr-primary); color: #fff; }
  body[data-header="light"] .app-topbar-title { color: var(--clr-text); }
  body[data-header="light"] .app-topbar-action { background: var(--clr-bg); color: var(--clr-text); border-color: var(--clr-border); }
  body[data-header="light"] .app-topbar-action:hover { background: var(--clr-border); }

  /* nav: left (default, above) | top — a genuinely different app shell, not just tighter spacing */
  body[data-nav="top"] .app-body { flex-direction: column; }
  body[data-nav="top"] .app-nav {
    width: 100%; display: flex; flex-direction: row; align-items: center; gap: 4px;
    border-right: none; border-bottom: 1px solid var(--clr-border);
    padding: 10px 24px; overflow-x: auto; overflow-y: visible; white-space: nowrap;
  }
  body[data-nav="top"] .app-nav-item, body[data-nav="top"] .app-nav-empty { margin-bottom: 0; flex-shrink: 0; }

  /* fields: stacked (default, above) | inline — label on the left, input on the right */
  body[data-fields="inline"] .field-wrap { flex-direction: row; align-items: center; gap: 14px; }
  body[data-fields="inline"] .field-wrap label { width: 150px; flex-shrink: 0; text-align: right; }
  body[data-fields="inline"] .field-wrap input, body[data-fields="inline"] .field-wrap textarea { flex: 1; }
  body[data-fields="inline"] .field-wrap .hint { margin-left: 164px; }
  body[data-fields="inline"] .form-card { max-width: 640px; }

  /* toolbar: inline (default, above) | sticky — pinned to the bottom of the content pane */
  body[data-toolbar="sticky"] .toolbar {
    position: sticky; bottom: 0; margin: 24px -36px -32px; padding: 14px 36px;
    background: var(--clr-surface); border-top: 1px solid var(--clr-border);
  }

  /* card: shadow (default, above) | border — flat, high-contrast, no drop shadow */
  body[data-card="border"] .card { box-shadow: none; border: 1.5px solid var(--clr-border); }
  body[data-card="border"] th { background: transparent; border-bottom: 1.5px solid var(--clr-border); }

  /* density: comfortable (default, above) | compact */
  body[data-density="compact"] .app-content { padding: 22px 26px; }
  body[data-density="compact"] .form-card { padding: 18px 20px; }
  body[data-density="compact"] .field-wrap { margin-bottom: 12px; gap: 4px; }
  body[data-density="compact"] .card-header { padding: 11px 16px; }
  body[data-density="compact"] th, body[data-density="compact"] td { padding: 7px 16px; font-size: 12.5px; }
  body[data-density="compact"] th { letter-spacing: 0.04em; }
  body[data-density="compact"] h1 { font-size: 19px; margin-bottom: 2px; }
  body[data-density="compact"] .subtitle { margin-bottom: 18px; }

  /* mono: numeric-looking inputs get a monospace font for scannable data entry */
  body[data-mono="true"] input[type=number] { font-family: var(--font-mono); }

  /* ---- Dark mode — a per-viewer preference (the Profile menu's toggle), layered on top of
     whichever color theme is active; --clr-primary/--clr-secondary stay the theme's own hue in
     both modes, only the neutral surface/text/border scale flips. color-scheme hints the browser's
     own chrome (scrollbars, form control defaults) to match too. ---- */
  body[data-color-scheme="dark"] {
    color-scheme: dark;
    --clr-bg: #0f172a; --clr-surface: #1e293b; --clr-border: #334155;
    --clr-text: #e2e8f0; --clr-muted: #94a3b8;
    --clr-primary-light: color-mix(in srgb, var(--clr-primary) 24%, transparent);
    --shadow-card: 0 1px 2px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.25);
  }
  body[data-color-scheme="dark"] th,
  body[data-color-scheme="dark"] tbody tr:hover td { background: #16213a; }
  body[data-color-scheme="dark"] .field-wrap input:disabled,
  body[data-color-scheme="dark"] .field-wrap textarea:disabled,
  body[data-color-scheme="dark"] .field-wrap select:disabled { background: #16213a; color: #64748b; }
  body[data-color-scheme="dark"] .btn-secondary { background: var(--clr-surface); }
  body[data-color-scheme="dark"] .row-action-danger:hover { background: color-mix(in srgb, var(--clr-danger) 18%, transparent); }
  body[data-color-scheme="dark"] .empty-icon { color: #475569; }
  body[data-color-scheme="dark"] .skeleton-bar { background: linear-gradient(90deg, #1e293b 25%, #334155 37%, #1e293b 63%); background-size: 400% 100%; }
  body[data-color-scheme="dark"] .toast-notice { background: #1e293b; color: #e2e8f0; }
  body[data-color-scheme="dark"] .toast-error { background: #2a1416; color: #fca5a5; border-color: #7f1d1d; }
  body[data-color-scheme="dark"] .toast-success { background: #0f2419; color: #86efac; border-color: #166534; }
  body[data-color-scheme="dark"][data-header="light"] .app-topbar { border-bottom-color: var(--clr-border); }
</style>
</head>
<body data-header="${t.header}" data-nav="${t.nav}" data-fields="${t.fields}" data-toolbar="${t.toolbar}" data-card="${t.card}" data-density="${t.density}" data-mono="${t.mono}">
<script>try{if(localStorage.getItem("td_theme_scheme")==="dark")document.body.setAttribute("data-color-scheme","dark");}catch(e){}</script>
<header class="app-topbar">
${renderTopBar(shellOpts)}
</header>
<div class="app-body">
<nav class="app-nav">
${renderNavItems(shellOpts)}
</nav>
<main class="app-content">
  <h1>${esc(model.header.title || model.title)}</h1>
  ${model.header.subtitle ? `<div class="subtitle">${esc(model.header.subtitle)}</div>` : ""}
  <div id="screen-messages"></div>
  ${renderItems(items, (label) => {
    const target = findScreenForLabel(label, shellOpts.screens, opts.screenId);
    return target ? shellUrl(opts, target.id) : null;
  })}
</main>
</div>
${clientScript(visibleModel, opts)}
</body>
</html>`;
}
