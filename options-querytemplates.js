// SRE Helper options — Query Templates tab.
//
// A "query template" is a reusable Mongo query snippet that may contain
// ${placeholder hint} tokens. The side panel's Query card turns each distinct
// placeholder into one input (the inner text is the input's hint) and
// substitutes the typed values when Generate is clicked.
//
// Stored as an array of { id, name, template } under chrome.storage.local key
// sreQueryTemplates. Shared global helpers (uid, escapeHtml, saveTimers) come
// from options-core.js, which loads before this file.

let queryTemplates = [];
const QUERY_TEMPLATES_KEY = "sreQueryTemplates";

// Distinct placeholder keys (trimmed inner text), first-occurrence order.
function qtmDistinctPlaceholders(text) {
  const keys = [];
  const re = /\$\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const key = m[1].trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function qtmPersist() {
  clearTimeout(saveTimers[QUERY_TEMPLATES_KEY]);
  saveTimers[QUERY_TEMPLATES_KEY] = setTimeout(() => {
    chrome.storage.local.set({ [QUERY_TEMPLATES_KEY]: queryTemplates });
  }, 250);
}

function qtmBuildCard(t) {
  const card = document.createElement("div");
  card.className = "pb-card qtm-card";

  /* ----- header ----- */
  const header = document.createElement("div");
  header.className = "pb-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "pb-toggle";
  toggle.title = "Collapse / expand";
  toggle.innerHTML =
    '<svg class="chevron" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';
  toggle.addEventListener("click", () => card.classList.toggle("collapsed"));

  const meta = document.createElement("div");
  meta.className = "pb-meta";

  const name = document.createElement("input");
  name.type = "text";
  name.className = "qtm-name-input";
  name.placeholder = "Template name";
  name.value = t.name || "";
  name.addEventListener("input", () => {
    t.name = name.value;
    qtmPersist();
  });
  meta.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "pb-actions";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pb-icon-btn delete";
  del.title = "Delete template";
  del.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  del.addEventListener("click", () => {
    if (!confirm('Delete query template "' + (t.name || "(unnamed)") + '"?')) return;
    queryTemplates = queryTemplates.filter((x) => x.id !== t.id);
    chrome.storage.local.set({ [QUERY_TEMPLATES_KEY]: queryTemplates });
    renderQueryTemplates();
  });
  actions.appendChild(del);

  header.appendChild(toggle);
  header.appendChild(meta);
  header.appendChild(actions);

  /* ----- body ----- */
  const body = document.createElement("div");
  body.className = "qtm-body";

  const editor = document.createElement("div");
  editor.className = "qtm-editor";
  const ta = document.createElement("textarea");
  ta.className = "qtm-text";
  ta.spellcheck = false;
  ta.placeholder = "db.order.find({ workOrder: ${wo number} })";
  ta.value = t.template || "";
  ta.addEventListener("input", () => {
    t.template = ta.value;
    qtmPersist();
    updateHint();
  });
  editor.appendChild(ta);
  body.appendChild(editor);

  const hints = document.createElement("div");
  hints.className = "qtm-hints";
  const count = document.createElement("span");
  count.className = "qtm-placeholder-count";
  const phList = document.createElement("span");
  hints.appendChild(count);
  hints.appendChild(phList);
  body.appendChild(hints);

  const updateHint = () => {
    const keys = qtmDistinctPlaceholders(t.template);
    if (!keys.length) {
      count.innerHTML =
        "No placeholders — the template is copied to the clipboard as-is.";
    } else {
      count.innerHTML =
        "Placeholders: <code>" +
        keys.map((k) => escapeHtml(k)).join("</code> · <code>") +
        "</code>";
    }
  };
  updateHint();

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function renderQueryTemplates() {
  const list = document.getElementById("queryTemplateList");
  if (!list) return;
  list.innerHTML = "";
  if (!queryTemplates.length) {
    const empty = document.createElement("div");
    empty.className = "form-empty";
    empty.textContent =
      "No query templates yet — click “+ Add template” to create one.";
    list.appendChild(empty);
    return;
  }
  queryTemplates.forEach((t) => list.appendChild(qtmBuildCard(t)));
}

(function initQueryTemplates() {
  const addBtn = document.getElementById("addQueryTemplate");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      queryTemplates.push({ id: uid(), name: "", template: "" });
      renderQueryTemplates();
      const inputs = document.querySelectorAll(".qtm-card .qtm-name-input");
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });
  }

  chrome.storage.local.get(QUERY_TEMPLATES_KEY, (data) => {
    const raw = data[QUERY_TEMPLATES_KEY];
    queryTemplates = (Array.isArray(raw) ? raw : [])
      .map((t) =>
        t && typeof t === "object"
          ? {
              id: t.id ? String(t.id) : uid(),
              name: typeof t.name === "string" ? t.name : "",
              template: typeof t.template === "string" ? t.template : "",
            }
          : null
      )
      .filter(Boolean);
    renderQueryTemplates();
  });

  // Keep the list in sync when another options window edits it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[QUERY_TEMPLATES_KEY]) return;
    const nv = Array.isArray(changes[QUERY_TEMPLATES_KEY].newValue)
      ? changes[QUERY_TEMPLATES_KEY].newValue
      : [];
    if (JSON.stringify(nv) !== JSON.stringify(queryTemplates)) {
      queryTemplates = nv.map((t) => ({
        id: t.id ? String(t.id) : uid(),
        name: typeof t.name === "string" ? t.name : "",
        template: typeof t.template === "string" ? t.template : "",
      }));
      renderQueryTemplates();
    }
  });
})();
