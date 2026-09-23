/**
 * Turns a ScreenModel into one self-contained HTML page: server-rendered markup plus a small
 * inline client script that POSTs events to the existing, unmodified `/api/.../run-event` route
 * and applies the returned actions — a generalized, faithful port of XmlScreenRenderer.jsx's
 * `handleFieldCommit`/`applyActions` (see the plan for the exact behaviors being matched:
 * blur-commit vs immediate-commit, map/set treated identically, message replaces, stop is a
 * server-only concept the client never sees).
 */
import type { ButtonItem, FieldItem, GridItem, ScreenModel, UiItem } from "./screenModel.js";

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return esc(s).replace(/'/g, "&#39;");
}

const BUTTON_CLASS: Record<string, string> = { primary: "btn-primary", secondary: "btn-secondary", danger: "btn-danger", ghost: "btn-ghost" };

// Every field type this vocabulary defines maps 1:1 to a native input, EXCEPT "select" — the
// current XML schema has no options source for it (no <option>, no dataSource/lookupEntity
// attribute), so — matching XmlScreenRenderer.jsx's NewFieldInput exactly — it falls back to a
// plain text input rather than rendering a dropdown with nothing in it.
function renderField(f: FieldItem): string {
  const required = f.rules.some((r) => r.required);
  const rule = f.rules[0] || {};
  const disabled = f.readonly ? " disabled" : "";
  const commitEvent = f.type === "checkbox" ? "change" : "blur";
  const wiredEvents = f.eventTypes.filter((t) => t === "change").length ? ` data-commit-event="${commitEvent}"` : "";

  let control: string;
  if (f.type === "checkbox") {
    control = `<input type="checkbox" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${disabled}${wiredEvents}>`;
  } else if (f.type === "textarea") {
    control = `<textarea id="${escAttr(f.id)}" name="${escAttr(f.id)}" rows="3"${disabled}${wiredEvents}></textarea>`;
  } else if (f.type === "number") {
    const min = rule.minValue !== undefined ? ` min="${rule.minValue}"` : "";
    const max = rule.maxValue !== undefined ? ` max="${rule.maxValue}"` : "";
    control = `<input type="number" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${min}${max}${disabled}${wiredEvents}>`;
  } else if (["date", "time", "email", "url", "color", "password"].includes(f.type)) {
    control = `<input type="${escAttr(f.type)}" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${disabled}${wiredEvents}>`;
  } else {
    // "select" and any other/unknown type — see comment above.
    const maxLength = rule.maxLength !== undefined ? ` maxlength="${rule.maxLength}"` : "";
    const pattern = rule.pattern ? ` pattern="${escAttr(rule.pattern)}"` : "";
    control = `<input type="text" id="${escAttr(f.id)}" name="${escAttr(f.id)}"${maxLength}${pattern}${disabled}${wiredEvents}>`;
  }

  const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : "";
  return `<div class="field-wrap" data-field="${escAttr(f.id)}">
  <label for="${escAttr(f.id)}">${esc(f.label)}${required ? ' <span class="req">*</span>' : ""}</label>
  ${control}
  ${hint}
</div>`;
}

function renderGrid(g: GridItem): string {
  const headers = g.columns.map((c) => `<th>${esc(c.header)}</th>`).join("");
  return `<div class="card grid-wrap" data-grid="${escAttr(g.id)}">
  <div class="card-header"><h3>${esc(g.label)}</h3></div>
  <div class="table-scroll">
  <table>
    <thead><tr>${headers}</tr></thead>
    <tbody><tr class="empty-row"><td colspan="${g.columns.length || 1}">${esc(g.emptyMessage)}</td></tr></tbody>
  </table>
  </div>
</div>`;
}

function renderButton(b: ButtonItem): string {
  const cls = BUTTON_CLASS[b.style] || BUTTON_CLASS.primary;
  const wired = b.eventTypes.includes("click") ? " data-click" : "";
  return `<button type="button" id="${escAttr(b.id)}" data-button${wired} class="${cls}">${esc(b.label)}</button>`;
}

function renderOne(it: UiItem): string {
  if (it.kind === "field") return renderField(it);
  if (it.kind === "grid") return renderGrid(it);
  if (it.kind === "button") return renderButton(it);
  return `<fieldset><legend>${esc(it.legend)}</legend>${renderInner(it.items)}</fieldset>`;
}

// Used inside a <fieldset> — no card grouping there, the fieldset border is already the grouping.
function renderInner(items: UiItem[]): string {
  return items.map(renderOne).join("\n");
}

// Top level only: consecutive fields/fieldsets group into one form card (a grid always starts its
// own separate card — see renderGrid). A button attaches to whatever field group is still open
// (so a Save button right after some fields renders inside that same card, at the bottom — the
// common form pattern) — but if nothing is open (a button appears right after a grid, or as the
// very first item, both real documented patterns), it renders as a plain toolbar instead of a
// lonely card containing only buttons.
function renderItems(items: UiItem[]): string {
  const out: string[] = [];
  let group: UiItem[] = [];
  let toolbar: ButtonItem[] = [];
  const flushGroup = () => {
    if (group.length) out.push(`<div class="card form-card">\n${group.map(renderOne).join("\n")}\n</div>`);
    group = [];
  };
  const flushToolbar = () => {
    if (toolbar.length) out.push(`<div class="toolbar">\n${toolbar.map(renderOne).join("\n")}\n</div>`);
    toolbar = [];
  };
  for (const it of items) {
    if (it.kind === "grid") {
      flushGroup();
      flushToolbar();
      out.push(renderOne(it));
    } else if (it.kind === "button") {
      if (group.length) group.push(it); // attach to the still-open form card
      else toolbar.push(it); // nothing open — accumulate as a standalone toolbar row instead
    } else {
      flushToolbar();
      group.push(it);
    }
  }
  flushGroup();
  flushToolbar();
  return out.join("\n");
}

// Column bindings per grid, keyed by grid id — baked into the page so the client script knows
// which JSON keys to project into <td>s without re-parsing the XML itself.
function gridColumnsJson(model: ScreenModel): string {
  const map: Record<string, string[]> = {};
  for (const g of model.grids) map[g.id] = g.columns.map((c) => c.binding);
  return JSON.stringify(map);
}

function clientScript(model: ScreenModel, opts: { apiBase: string; projectId: number; screenId: string; token: string }): string {
  return `
<script>
(function () {
  var API_BASE = ${JSON.stringify(opts.apiBase)};
  var PROJECT_ID = ${JSON.stringify(opts.projectId)};
  var SCREEN_ID = ${JSON.stringify(opts.screenId)};
  var TOKEN = ${JSON.stringify(opts.token)};
  var GRID_COLUMNS = ${gridColumnsJson(model)};
  var root = document;

  function fieldEl(id) { return root.querySelector('[data-field="' + id + '"] input, [data-field="' + id + '"] textarea'); }
  function fieldValue(el) { return el.type === "checkbox" ? el.checked : el.value; }
  function allFieldValues() {
    var values = {};
    root.querySelectorAll("[data-field]").forEach(function (wrap) {
      var el = wrap.querySelector("input, textarea");
      if (el) values[wrap.getAttribute("data-field")] = fieldValue(el);
    });
    return values;
  }

  function showMessages(messages) {
    var box = root.getElementById("screen-messages");
    box.innerHTML = "";
    (messages || []).forEach(function (m) {
      var div = document.createElement("div");
      div.className = "banner " + (m.messageType === "error" ? "error" : m.messageType === "success" ? "success" : "notice");
      div.textContent = m.value;
      box.appendChild(div);
    });
  }

  function setBusy(busy) {
    root.querySelectorAll("[data-button]").forEach(function (b) { b.disabled = busy; });
  }

  function navigateUrl(screenId) {
    return API_BASE + "/runtime/projects/" + PROJECT_ID + "/screens/" + screenId + "?token=" + encodeURIComponent(TOKEN);
  }

  function applyActions(actions) {
    var messages = [];
    var navigateTo = null;
    (actions || []).forEach(function (a) {
      if ((a.type === "map" || a.type === "set") && typeof a.target === "string" && a.target.indexOf("field:") === 0) {
        var el = fieldEl(a.target.slice(6));
        if (el) { if (el.type === "checkbox") el.checked = Boolean(a.value); else el.value = a.value == null ? "" : a.value; }
      } else if ((a.type === "map" || a.type === "set") && typeof a.target === "string" && a.target.indexOf("grid:") === 0 && Array.isArray(a.value)) {
        renderGridRows(a.target.slice(5), a.value);
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

  function renderGridRows(gridId, rows) {
    var wrap = root.querySelector('[data-grid="' + gridId + '"]');
    if (!wrap) return;
    var tbody = wrap.querySelector("tbody");
    var bindings = GRID_COLUMNS[gridId] || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="' + Math.max(bindings.length, 1) + '"></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (row) {
      return "<tr>" + bindings.map(function (b) {
        var v = row[b];
        var span = document.createElement("span"); span.textContent = v == null ? "" : String(v);
        return "<td>" + span.innerHTML + "</td>";
      }).join("") + "</tr>";
    }).join("");
  }

  function fireEvent(elementId, eventType, valuesOverride) {
    setBusy(true);
    showMessages([]);
    return fetch(API_BASE + "/api/projects/" + PROJECT_ID + "/screens/" + SCREEN_ID + "/run-event", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ elementId: elementId, eventType: eventType, fieldValues: valuesOverride || allFieldValues() }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) { applyActions(data.actions || []); })
      .catch(function () { showMessages([{ messageType: "error", value: "Something went wrong — please try again." }]); })
      .finally(function () { setBusy(false); });
  }

  root.querySelectorAll("[data-field]").forEach(function (wrap) {
    var fieldId = wrap.getAttribute("data-field");
    var el = wrap.querySelector("input, textarea");
    if (!el || !el.hasAttribute("data-commit-event")) return;
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

  root.querySelectorAll("[data-click]").forEach(function (btn) {
    btn.addEventListener("click", function () { fireEvent(btn.id, "click"); });
  });
})();
</script>`;
}

export type ShellScreen = { id: string; name: string };

function shellUrl(opts: { apiBase: string; projectId: number; token: string }, screenId: string): string {
  return `${opts.apiBase}/runtime/projects/${opts.projectId}/screens/${screenId}?token=${encodeURIComponent(opts.token)}`;
}

type ShellOpts = { apiBase: string; projectId: number; screenId: string; token: string; appName: string; screens: ShellScreen[] };

// Same top-bar + left-nav layout as frontend/src/components/AppShell.jsx — moved here so it's part
// of what actually ships (every screen carries its own copy), not preview-only React chrome that
// only existed inside the Studio.
function renderTopBar(opts: ShellOpts): string {
  const name = opts.appName || "App";
  const mark = esc(name.trim().charAt(0).toUpperCase() || "A");
  return `<a class="app-topbar-brand" href="${escAttr(shellUrl(opts, opts.screenId))}"><span class="app-mark">${mark}</span><span class="app-topbar-title">${esc(name)}</span></a>`;
}

// Plain <a href> links (real navigation, no JS needed for this part) — the active screen renders
// as inert text, not a link to itself.
function renderNavItems(opts: ShellOpts): string {
  if (!opts.screens.length) return '<span class="app-nav-empty">No other screens yet</span>';
  return opts.screens
    .map((s) =>
      s.id === opts.screenId
        ? `<span class="app-nav-item active" aria-current="page">${esc(s.name)}</span>`
        : `<a class="app-nav-item" href="${escAttr(shellUrl(opts, s.id))}">${esc(s.name)}</a>`
    )
    .join("\n");
}

export type ThemeKey = keyof typeof THEMES;

// A small curated set of named palettes — not free-form color picking, not AI-derived. Each just
// supplies the accent colors; the layout/typography/spacing system (cards, nav, forms, focus
// states) stays the one already built and is identical across every theme. "indigo" is the
// original default and what an unset/unrecognized theme key falls back to.
export const THEMES = {
  indigo: { label: "Indigo", primary: "#4f46e5", primaryDark: "#3730a3", primaryLight: "#eef2ff", secondary: "#0891b2" },
  emerald: { label: "Emerald", primary: "#059669", primaryDark: "#065f46", primaryLight: "#ecfdf5", secondary: "#7c3aed" },
  slate: { label: "Slate", primary: "#334155", primaryDark: "#1e293b", primaryLight: "#f1f5f9", secondary: "#0891b2" },
  rose: { label: "Rose", primary: "#e11d48", primaryDark: "#9f1239", primaryLight: "#fff1f2", secondary: "#0891b2" },
  amber: { label: "Amber", primary: "#d97706", primaryDark: "#92400e", primaryLight: "#fffbeb", secondary: "#0369a1" },
  ocean: { label: "Ocean", primary: "#0284c7", primaryDark: "#075985", primaryLight: "#f0f9ff", secondary: "#7c3aed" },
} as const;

export function resolveTheme(key: string | null | undefined) {
  return THEMES[(key as ThemeKey) ?? ""] ?? THEMES.indigo;
}

export function renderScreen(
  model: ScreenModel,
  opts: { apiBase: string; projectId: number; screenId: string; token: string; appName?: string; screens?: ShellScreen[]; theme?: string | null }
): string {
  const shellOpts: ShellOpts = { ...opts, appName: opts.appName || "App", screens: opts.screens || [] };
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
    --radius: 10px;
    --shadow-card: 0 1px 2px rgba(15,23,42,0.04), 0 4px 12px rgba(15,23,42,0.05);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: var(--font-family); color: var(--clr-text); background: var(--clr-bg); display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }

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

  .app-body { display: flex; flex: 1; min-height: 0; }
  .app-nav { width: 210px; flex-shrink: 0; background: var(--clr-surface); border-right: 1px solid var(--clr-border); padding: 16px 12px; overflow-y: auto; }
  .app-nav-item {
    display: block; padding: 9px 12px; border-radius: 7px; font-size: 13.5px; font-weight: 500;
    text-decoration: none; color: var(--clr-text); margin-bottom: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background 0.12s;
  }
  a.app-nav-item:hover { background: var(--clr-primary-light); color: var(--clr-primary-dark); }
  .app-nav-item.active { background: var(--clr-primary); color: #fff; font-weight: 600; cursor: default; }
  .app-nav-empty { display: block; padding: 9px 12px; font-size: 12.5px; color: var(--clr-muted); font-style: italic; }

  .app-content { flex: 1; min-width: 0; overflow: auto; padding: 32px 36px; }
  h1 { font-size: 23px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
  .subtitle { color: var(--clr-muted); font-size: 13.5px; margin-bottom: 24px; }

  .card { background: var(--clr-surface); border: 1px solid var(--clr-border); border-radius: var(--radius); box-shadow: var(--shadow-card); margin-bottom: 20px; }
  .form-card { padding: 24px 26px; max-width: 480px; }
  .card-header { padding: 16px 20px; border-bottom: 1px solid var(--clr-border); }
  .card-header h3 { margin: 0; font-size: 14.5px; font-weight: 600; }

  .field-wrap { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .field-wrap:last-of-type { margin-bottom: 4px; }
  .field-wrap label { font-size: 13px; font-weight: 600; color: var(--clr-text); }
  .req { color: var(--clr-danger); }
  .field-wrap input, .field-wrap textarea {
    padding: 9px 13px; border: 1.5px solid var(--clr-border); border-radius: 8px;
    font-size: 14px; font-family: inherit; color: var(--clr-text); background: var(--clr-surface);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .field-wrap input:focus, .field-wrap textarea:focus {
    outline: none; border-color: var(--clr-primary); box-shadow: 0 0 0 3px var(--clr-primary-light);
  }
  .field-wrap input:disabled, .field-wrap textarea:disabled { background: #f1f5f9; color: #94a3b8; cursor: not-allowed; }
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
  .empty-row td { color: var(--clr-muted); font-style: italic; text-align: center; padding: 28px 20px; }

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

  #screen-messages:empty { display: none; }
  #screen-messages { margin-bottom: 18px; }
  .banner { padding: 11px 16px; border-radius: 8px; margin-bottom: 8px; font-size: 13.5px; font-weight: 500; }
  .banner.notice { background: #f1f5f9; color: #334155; }
  .banner.error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
  .banner.success { background: #f0fdf4; color: var(--clr-success); border: 1px solid #bbf7d0; }
</style>
</head>
<body>
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
  ${renderItems(model.items)}
</main>
</div>
${clientScript(model, opts)}
</body>
</html>`;
}
