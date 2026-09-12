/* query.js — Mongo Query template card. */

/* ---------- Mongo Query template card ---------- */
//
// A card below the Tags card: pick one of the configured query templates
// (Options → Query Templates), fill the inputs that are rendered from its
// ${placeholder} tokens, then Generate copies the substituted query to the
// clipboard. Each distinct placeholder becomes one input whose hint is the
// inner text of the placeholder; the same placeholder reused twice is filled
// from that single input.
const QUERY_PLACEHOLDER_RE = /\$\{([^{}]*)\}/g;

// Distinct placeholder keys, first-occurrence order.
function queryPlaceholderKeys(text) {
  const keys = [];
  const re = new RegExp(QUERY_PLACEHOLDER_RE.source, "g");
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const key = m[1].trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Turn a multi-value input into a Mongo $in-ready list of quoted strings:
//   "1 2 3"  -> "1","2","3"     "1,2,3" -> "1","2","3"
// Separators: spaces, commas (half/full width), semicolons, tabs, newlines.
function formatIdList(raw) {
  const parts = String(raw || "")
    .split(/[,\uFF0C;；\t\r\n]+|\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts
    .map((p) => '"' + p.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"')
    .join(",");
}

let querySelId = null; // selected template id (survives full re-renders)
let queryValues = {}; // placeholder key -> last typed value
let queryFmt = {}; // placeholder key -> multi-value formatting on (default true)

function renderQueryTemplatePanel(templates) {
  const card = document.createElement("div");
  card.className = "snow-info snow-info-query";

  const head = document.createElement("div");
  head.className = "snow-info-head";
  const icon = document.createElement("span");
  icon.className = "snow-info-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10.5 4.5a1 1 0 0 1 1-1H15a1 1 0 0 1 1 1v3.5h-1V5h-3.5v3.5h-1v-4zm2 6h1v6h-1v-6zm-5.5 4a1 1 0 0 1 1-1h1v1H8v3.5H6.5v-3.5zm13 5.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-1h1v.5h4v-1h1v.5zm-11.5-6.5v-1h5v1h-5zm1.5-4.5v-2h2v2h-2z"/></svg>';
  const title = document.createElement("span");
  title.className = "snow-info-title";
  title.textContent = "Query";
  head.appendChild(icon);
  head.appendChild(title);

  const body = document.createElement("div");
  body.className = "snow-query-body";

  // --- control row: template picker + Generate ---
  const ctl = document.createElement("div");
  ctl.className = "snow-query-ctl";

  const select = document.createElement("select");
  select.className = "snow-query-select";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "Select a template…";
  select.appendChild(ph);
  let selected = templates.find((t) => t.id === querySelId) || null;
  templates.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name || "(unnamed template)";
    if (t.id === querySelId) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    querySelId = select.value || null;
    queryValues = {};
    queryFmt = {};
    rebuildFields();
  });
  ctl.appendChild(select);

  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "snow-query-btn";
  generate.textContent = "Generate";
  generate.addEventListener("click", () => {
    if (!selected) {
      toast.info("Query", "Pick a query template first.");
      return;
    }
    generateQuery();
  });
  ctl.appendChild(generate);
  body.appendChild(ctl);

  // --- dynamic placeholder inputs ---
  const fields = document.createElement("div");
  fields.className = "snow-query-fields";
  body.appendChild(fields);

  function rebuildFields() {
    fields.innerHTML = "";
    selected = templates.find((t) => t.id === querySelId) || null;
    if (!selected) return;
    const keys = queryPlaceholderKeys(selected.template);
    if (!keys.length) {
      const note = document.createElement("div");
      note.className = "snow-query-note";
      note.textContent = "This template has no placeholders — Generate copies it as-is.";
      fields.appendChild(note);
      return;
    }
    keys.forEach((key) => {
      const row = document.createElement("div");
      row.className = "snow-query-field";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "snow-query-input";
      input.dataset.key = key;
      input.placeholder = key;
      input.value = queryValues[key] || "";
      input.addEventListener("input", () => {
        queryValues[key] = input.value;
      });

      // Multi-value formatting toggle — ON by default. When ON, Generate first
      // turns the typed value into a quoted list, e.g. `1 2 3` → `"1","2","3"`.
      const fmtOn = queryFmt[key] !== false;
      const fmtBtn = document.createElement("button");
      fmtBtn.type = "button";
      fmtBtn.className = "snow-query-fmt" + (fmtOn ? " on" : "");
      fmtBtn.title =
        'Format multi-value input on Generate (1 2 3 → "1","2","3"). Currently ' +
        (fmtOn ? "ON" : "OFF");
      fmtBtn.setAttribute("aria-pressed", fmtOn ? "true" : "false");
      fmtBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 17h3l2-4V7H5v6h3l-2 4zm8 0h3l2-4V7h-6v6h3l-2 4z"/></svg>';
      fmtBtn.addEventListener("click", () => {
        const next = queryFmt[key] === false; // toggle: off -> on / on -> off
        queryFmt[key] = next;
        fmtBtn.classList.toggle("on", next);
        fmtBtn.setAttribute("aria-pressed", next ? "true" : "false");
        fmtBtn.title =
          'Format multi-value input on Generate (1 2 3 → "1","2","3"). Currently ' +
          (next ? "ON" : "OFF");
      });

      const hint = document.createElement("span");
      hint.className = "snow-query-hint";
      hint.textContent = "${" + key + "}";
      row.appendChild(input);
      row.appendChild(fmtBtn);
      row.appendChild(hint);
      fields.appendChild(row);
    });
  }
  rebuildFields();

  function generateQuery() {
    const tpl = selected;
    if (!tpl) return;
    const source = String(tpl.template || "");
    // Read values straight from the live inputs (source of truth at click
    // time); module queryValues only backfills keys with no rendered input.
    // Rows whose format toggle is ON (the default) get the multi-value input
    // turned into a quoted list first — `1 2 3` → `"1","2","3"`.
    const vals = {};
    fields.querySelectorAll(".snow-query-field").forEach((row) => {
      const inp = row.querySelector(".snow-query-input");
      if (!inp || !inp.dataset.key) return;
      const key = inp.dataset.key;
      let value = inp.value;
      if (queryFmt[key] !== false) value = formatIdList(value);
      vals[key] = value;
    });
    let out = "";
    let last = 0;
    const re = new RegExp(QUERY_PLACEHOLDER_RE.source, "g");
    let m;
    while ((m = re.exec(source)) !== null) {
      out += source.slice(last, m.index);
      const key = m[1].trim();
      if (Object.prototype.hasOwnProperty.call(vals, key)) {
        out += vals[key];
      } else if (key && Object.prototype.hasOwnProperty.call(queryValues, key)) {
        out += String(queryValues[key] || "");
      } else {
        out += m[0]; // unknown token — leave untouched
      }
      last = re.lastIndex;
    }
    out += source.slice(last);
    copyTextToClipboard(out).then((ok) => {
      if (ok) {
        toast.success("Query", "Generated query copied to the clipboard.");
      } else {
        toast.error("Query", "Clipboard is unavailable in this context.");
      }
    });
  }

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => fallbackCopyText(text));
  }
  return fallbackCopyText(text);
}

function fallbackCopyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return Promise.resolve(ok);
  } catch (_) {
    return Promise.resolve(false);
  }
}
