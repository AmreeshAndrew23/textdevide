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

const BUTTON_STYLES: Record<string, string> = {
  primary: "background:var(--clr-primary);color:#fff;border:none;",
  secondary: "background:#fff;color:var(--clr-text);border:1px solid var(--clr-border);",
  danger: "background:var(--clr-danger);color:#fff;border:none;",
  ghost: "background:transparent;color:var(--clr-primary);border:1px solid var(--clr-primary);",
};

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
  return `<div class="grid-wrap" data-grid="${escAttr(g.id)}">
  <h3>${esc(g.label)}</h3>
  <table>
    <thead><tr>${headers}</tr></thead>
    <tbody><tr class="empty-row"><td colspan="${g.columns.length || 1}">${esc(g.emptyMessage)}</td></tr></tbody>
  </table>
</div>`;
}

function renderButton(b: ButtonItem): string {
  const style = BUTTON_STYLES[b.style] || BUTTON_STYLES.primary;
  const wired = b.eventTypes.includes("click") ? " data-click" : "";
  return `<button type="button" id="${escAttr(b.id)}" data-button${wired} style="${style}">${esc(b.label)}</button>`;
}

function renderItems(items: UiItem[]): string {
  return items
    .map((it) => {
      if (it.kind === "field") return renderField(it);
      if (it.kind === "grid") return renderGrid(it);
      if (it.kind === "button") return renderButton(it);
      return `<fieldset><legend>${esc(it.legend)}</legend>${renderItems(it.items)}</fieldset>`;
    })
    .join("\n");
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
  return `<a class="app-topbar-title" href="${escAttr(shellUrl(opts, opts.screenId))}">${esc(opts.appName || "App")}</a>`;
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

export function renderScreen(
  model: ScreenModel,
  opts: { apiBase: string; projectId: number; screenId: string; token: string; appName?: string; screens?: ShellScreen[] }
): string {
  const shellOpts: ShellOpts = { ...opts, appName: opts.appName || "App", screens: opts.screens || [] };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)}</title>
<style>
  :root { --clr-primary: #4f46e5; --clr-danger: #dc2626; --clr-border: #cbd5e1; --clr-bg: #f8fafc; --clr-text: #1e293b; --clr-muted: #64748b; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: system-ui, sans-serif; color: var(--clr-text); background: var(--clr-bg); display: flex; flex-direction: column; }
  .app-topbar { flex-shrink: 0; padding: 12px 20px; border-bottom: 1px solid var(--clr-border); background: #fff; }
  .app-topbar-title { font-weight: 700; font-size: 15px; color: var(--clr-text); text-decoration: none; }
  .app-body { display: flex; flex: 1; min-height: 0; }
  .app-nav { width: 190px; flex-shrink: 0; border-right: 1px solid var(--clr-border); background: #fff; padding: 10px; overflow-y: auto; }
  .app-nav-item { display: block; padding: 8px 10px; border-radius: 6px; font-size: 13px; text-decoration: none; color: var(--clr-text); margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  a.app-nav-item:hover { background: var(--clr-bg); }
  .app-nav-item.active { background: var(--clr-primary); color: #fff; font-weight: 600; cursor: default; }
  .app-nav-empty { display: block; padding: 8px 10px; font-size: 12px; color: var(--clr-muted); }
  .app-content { flex: 1; min-width: 0; overflow: auto; padding: 24px 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: var(--clr-muted); font-size: 13px; margin-bottom: 20px; }
  .field-wrap { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; max-width: 360px; }
  .field-wrap label { font-size: 13px; font-weight: 600; }
  .req { color: var(--clr-danger); }
  .field-wrap input, .field-wrap textarea { padding: 8px 12px; border: 1px solid var(--clr-border); border-radius: 6px; font-size: 14px; font-family: inherit; }
  .field-wrap input:disabled, .field-wrap textarea:disabled { background: #f1f5f9; color: #6b7280; }
  .field-wrap input[type=checkbox] { width: 18px; height: 18px; }
  .hint { font-size: 12px; color: var(--clr-muted); }
  fieldset { border: 1px solid var(--clr-border); border-radius: 8px; margin: 0 0 16px; padding: 12px 16px; }
  legend { font-size: 12px; font-weight: 600; color: var(--clr-muted); padding: 0 6px; }
  .grid-wrap { margin: 20px 0; background: #fff; border: 1px solid var(--clr-border); border-radius: 8px; padding: 16px; max-width: 720px; }
  .grid-wrap h3 { margin: 0 0 12px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--clr-border); font-size: 13px; }
  th { color: var(--clr-muted); font-size: 11px; text-transform: uppercase; }
  .empty-row td { color: var(--clr-muted); font-style: italic; }
  button { padding: 8px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; margin-right: 8px; margin-top: 8px; }
  button:disabled { opacity: 0.6; cursor: default; }
  #screen-messages { margin-bottom: 16px; }
  .banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 8px; font-size: 14px; }
  .banner.notice { background: #e2e8f0; color: #334155; }
  .banner.error { background: #fee2e2; color: #991b1b; }
  .banner.success { background: #dcfce7; color: #166534; }
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
