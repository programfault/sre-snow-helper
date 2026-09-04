// SRE Helper options script
// Tabs: Settings | Components | Playbook | Form
//
// Components (renamed from "Common") and Playbook share one card renderer.
// Each card uses a *real* CodeMirror 5 YAML editor (vendored locally) instead
// of a plain textarea, so the writer gets:
//   - native YAML syntax highlighting
//   - built-in line numbers
//   - indent-aware code folding (form: / steps: blocks can collapse)
//   - bracket auto-close and line-comment toggling with Ctrl-/
//   - native hint dropdown for slash-triggered completions
//
// Header (name + desc stacked) is derived from the YAML on each change.
// Per-card Validate button runs semantic checks:
//   Component: name + form keys/values against the Form library
//   Playbook : name + step refs against Components + step forms against Forms
//
// The Form tab exposes a CSV-like, column-fixed table (name / label / value /
// display / type) with click-to-edit rows. type ∈ {string, number, reference}.

const Y = SRE_YAML;

const DEFAULT_CONFIG = {
  displayName: "SRE",
  refreshInterval: 30,
  enableNotifications: true,
  theme: "light",
  apiEndpoint: "",
};

const STORES = {
  component: {
    storageKey: "sreComponents",
    legacyKey: "sreCommons",
    listId: "componentList",
    addId: "addComponent",
    validates: "component",
    placeholder:
      "# Reusable step component\n" +
      "#\n" +
      "# name: ack-step\n" +
      "# desc: Human acknowledgement step\n" +
      "# form:\n" +
      "#   note: ack   # \"note\" must exist in the Form tab\n",
  },
  playbook: {
    storageKey: "srePlaybooks",
    listId: "playbookList",
    addId: "addPlaybook",
    validates: "playbook",
    placeholder:
      "# Orchestration flow\n" +
      "#\n" +
      "# name: incident-response\n" +
      "# desc: Default incident response flow\n" +
      "# steps:\n" +
      "#   - ref: ack-step              # resolve by name from Components\n" +
      "#   - name: custom-check\n" +
      "#     desc: Custom inline step\n" +
      "#     form:\n" +
      "#       note: check done\n",
  },
};

const FORM_FIELDS = [
  { key: "name",    label: "Name"    },
  { key: "label",   label: "Label"   },
  { key: "value",   label: "Value"   },
  { key: "display", label: "Display" },
  { key: "type",    label: "Type"    },
];

const settingsEls = {
  displayName: document.getElementById("displayName"),
  refreshInterval: document.getElementById("refreshInterval"),
  enableNotifications: document.getElementById("enableNotifications"),
  theme: document.getElementById("theme"),
  apiEndpoint: document.getElementById("apiEndpoint"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
};

let components = [];
let playbooks = [];
let forms = []; // Array<{ id, name, label, value, display, type }>
const saveTimers = {};

/* ---------- Tabs ---------- */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
    // After a tab-switch, any CodeMirror we unmounted while display:none has
    // wrong measurement — refresh visible editors.
    document.querySelectorAll(".CodeMirror").forEach((el) => {
      if (el.CodeMirror) el.CodeMirror.refresh();
    });
  });
});

/* ---------- Settings ---------- */
let statusTimer = null;
function showStatus(msg) {
  settingsEls.status.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    settingsEls.status.textContent = "";
  }, 2000);
}
function fillSettingsForm(cfg) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  settingsEls.displayName.value = c.displayName || "";
  settingsEls.refreshInterval.value = c.refreshInterval;
  settingsEls.enableNotifications.checked = !!c.enableNotifications;
  settingsEls.theme.value = c.theme || "light";
  settingsEls.apiEndpoint.value = c.apiEndpoint || "";
}
function readSettingsForm() {
  return {
    displayName: settingsEls.displayName.value.trim() || "SRE",
    refreshInterval: Math.max(
      5,
      Math.min(3600, parseInt(settingsEls.refreshInterval.value, 10) || 30)
    ),
    enableNotifications: settingsEls.enableNotifications.checked,
    theme: settingsEls.theme.value,
    apiEndpoint: settingsEls.apiEndpoint.value.trim(),
  };
}
settingsEls.save.addEventListener("click", () => {
  chrome.storage.local.set({ sreConfig: readSettingsForm() }, () =>
    showStatus("Saved \u2713")
  );
});

/* ---------- Utilities ---------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function normalizeCard(c) {
  if (c && typeof c.yaml === "string") {
    return { id: c.id || uid(), yaml: c.yaml, collapsed: !!c.collapsed };
  }
  let yaml = "";
  if (c && c.name) yaml += `name: ${c.name}\n`;
  if (c && c.description) yaml += `desc: ${c.description}\n`;
  if (c && c.yaml) yaml += c.yaml;
  return { id: (c && c.id) || uid(), yaml, collapsed: !!(c && c.collapsed) };
}
function arrayFor(kind) {
  return kind === "component" ? components : playbooks;
}
function persist(kind) {
  const key = STORES[kind].storageKey;
  chrome.storage.local.set({ [key]: arrayFor(kind) });
}
function save(kind) {
  clearTimeout(saveTimers[kind]);
  saveTimers[kind] = setTimeout(() => persist(kind), 400);
}
function persistForms() {
  chrome.storage.local.set({ sreForms: forms });
}

/* ---------- CodeMirror slash-hint helper ---------- */

const HINT_GROUP_TAGS = {
  "component-ref": "STEP",
  form: "FORM",
};

function slashHint(cm) {
  const cursor = cm.getCursor();
  const doc = cm.getDoc();
  let flat = 0;
  for (let i = 0; i < cursor.line; i++) flat += doc.getLine(i).length + 1;
  flat += cursor.ch;
  const ctx = Y.analyzeContext(doc.getValue(), flat);
  if (!ctx) return;

  const all = Y.buildCompletions({ forms, components });
  const items = Y.filterCompletions(all, ctx.prefix, ctx.kind);
  if (items.length === 0) return;

  const from = doc.posFromIndex(ctx.triggerStart);
  const to = cursor;

  let lastGroup = null;
  const hints = items.map((it) => {
    const grp = it.group || "misc";
    const isFirstInGroup = grp !== lastGroup;
    lastGroup = grp;
    return {
      text: it.snippet,
      displayText: it.label,
      className: "cm-sre-hint-" + grp,
      render: (elt /* , data, cur */) => {
        if (isFirstInGroup) {
          const head = document.createElement("div");
          head.className = "ac-group-lead";
          head.textContent = HINT_GROUP_TAGS[grp] || grp.toUpperCase();
          elt.appendChild(head);
        }
        const row = document.createElement("div");
        row.className = "ac-row";
        const label = document.createElement("span");
        label.className = "ac-label";
        label.textContent = it.label;
        const hint = document.createElement("span");
        hint.className = "ac-hint";
        hint.textContent = it.hint || "";
        row.appendChild(label);
        row.appendChild(hint);
        elt.appendChild(row);
      },
      _group: grp,
    };
  });
  return { list: hints, from, to };
}
// Note: group headers are now rendered *inside* each <li> as a "lead" div before
// the row when the group changes. No DOM decoration post-hook is required.

/* ---------- Shared card renderer (Components + Playbook) ---------- */

function renderCards(kind) {
  const store = STORES[kind];
  const list = document.getElementById(store.listId);
  const arr = arrayFor(kind);
  list.innerHTML = "";

  if (arr.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pb-empty";
    empty.textContent = `No ${kind} yet. Click "+ Add ${kind}" to create one.`;
    list.appendChild(empty);
    return;
  }

  arr.forEach((item) => {
    const card = document.createElement("div");
    card.className = "pb-card" + (item.collapsed ? " collapsed" : "");
    card.dataset.id = item.id;
    card.innerHTML = `
      <div class="pb-header">
        <button class="pb-toggle" title="Collapse / expand" aria-label="Collapse / expand">
          <svg class="chevron" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div class="pb-meta">
          <div class="pb-name-display"></div>
          <div class="pb-desc-display"></div>
        </div>
        <div class="pb-actions">
          <button class="pb-icon-btn validate" title="Validate" aria-label="Validate">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
          </button>
          <button class="pb-icon-btn delete" title="Delete" aria-label="Delete">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </div>
      <div class="pb-body">
        <div class="pb-editor-wrap">
          <textarea class="pb-yaml" spellcheck="false"></textarea>
        </div>
        <div class="pb-validation"></div>
      </div>
    `;

    const nameEl = card.querySelector(".pb-name-display");
    const descEl = card.querySelector(".pb-desc-display");
    const yamlEl = card.querySelector(".pb-yaml");
    const toggleEl = card.querySelector(".pb-toggle");
    const validateBtn = card.querySelector(".pb-icon-btn.validate");
    const deleteEl = card.querySelector(".pb-icon-btn.delete");
    const valEl = card.querySelector(".pb-validation");

    function refreshHeader() {
      const h = Y.parseHeader(item.yaml);
      if (h.name) {
        nameEl.textContent = h.name;
        nameEl.classList.remove("placeholder");
      } else {
        nameEl.textContent = "(unnamed)";
        nameEl.classList.add("placeholder");
      }
      if (h.desc) {
        descEl.textContent = h.desc;
        descEl.style.display = "";
      } else {
        descEl.textContent = "";
        descEl.style.display = "none";
      }
    }

    function renderValidationReport(report) {
      valEl.classList.remove("visible", "ok", "err", "warn");
      valEl.innerHTML = "";
      const hasErrors = report && report.errors && report.errors.length;
      const hasWarns = report && report.warnings && report.warnings.length;
      if (!report || (!hasErrors && !hasWarns)) {
        valEl.classList.add("visible", "ok");
        valEl.textContent = "Valid \u2713";
        return;
      }
      if (hasErrors) {
        valEl.classList.add("visible", "err");
        const title = document.createElement("div");
        title.innerHTML = `<b>${report.errors.length} error(s)</b>`;
        const ul = document.createElement("ul");
        report.errors.forEach((e) => {
          const li = document.createElement("li");
          li.textContent = e;
          ul.appendChild(li);
        });
        valEl.appendChild(title);
        valEl.appendChild(ul);
      }
      if (hasWarns && !hasErrors) {
        valEl.classList.add("visible", "warn");
        const title = document.createElement("div");
        title.innerHTML = "<b>Warnings</b>";
        const ul = document.createElement("ul");
        report.warnings.forEach((w) => {
          const li = document.createElement("li");
          li.textContent = w;
          ul.appendChild(li);
        });
        valEl.appendChild(title);
        valEl.appendChild(ul);
      }
    }

    function doValidate() {
      card.classList.add("validating");
      requestAnimationFrame(() => {
        const formsByName = Y.indexForms(forms);
        const componentsByName = Y.indexComponents(components);
        let report;
        if (store.validates === "component") {
          report = Y.validateComponent(item.yaml, formsByName);
        } else {
          report = Y.validatePlaybook(
            item.yaml,
            componentsByName,
            formsByName
          );
        }
        renderValidationReport(report);
        card.classList.remove("validating");
      });
    }

    // Mount CodeMirror on the textarea.
    yamlEl.value = item.yaml;
    yamlEl.placeholder = store.placeholder;
    const cm = CodeMirror.fromTextArea(yamlEl, {
      mode: "yaml",
      theme: "eclipse",
      lineNumbers: true,
      foldGutter: true,
      gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
      autoCloseBrackets: true,
      matchBrackets: true,
      showCursorWhenSelecting: true,
      tabSize: 2,
      indentUnit: 2,
      lineWrapping: false,
      extraKeys: {
        "Ctrl-/": "toggleComment",
        "Cmd-/": "toggleComment",
        Tab: (cm2) => {
          if (cm2.somethingSelected()) cm2.indentSelection("add");
          else cm2.replaceSelection("  ", "end");
        },
      },
      placeholder: store.placeholder,
    });

    // After a card's first mount, call refresh() so CodeMirror picks up the
    // real dimensions (it is otherwise sometimes zero-width when appended to
    // a freshly-cloned DOM).
    setTimeout(() => cm.refresh(), 0);

    // YAML is purely indent-driven — indent-fold helper is registered by the
    // indent-fold.js addon. CodeMirror's default rangeFinder is CodeMirror.fold.auto
    // which consults all registered fold helpers, so nothing extra is needed.

    // Wire editor -> in-memory item, header, storage, validation clear.
    // `change` fires for every mutation (keystroke, paste, autocomplete, undo).
    let changeTimer = null;
    cm.on("change", () => {
      item.yaml = cm.getValue();
      refreshHeader();
      save(kind);
      // Clear the validation report since the document is now dirty.
      if (valEl.classList.contains("visible")) {
        valEl.classList.remove("visible", "ok", "err", "warn");
        valEl.innerHTML = "";
      }
    });

    // Slash-triggered autocomplete.
    // - Trigger immediately when the user types `/` or any character that falls
    //   inside an active `/query` sequence, OR when they cursor-navigate back
    //   onto a `/foo` token.
    // - CodeMirror's own keyboard handling (arrow up/down to pick, Enter/Tab to
    //   select, Esc to cancel) works out of the box because we use show-hint.
    function triggerHintIfAppropriate() {
      // Don't re-trigger while a hint is already visible.
      if (cm.state.completionActive) return;
      CodeMirror.showHint(cm, slashHint, {
        completeSingle: false,
        alignWithWord: false,
        closeOnUnfocus: true,
      });
    }
    cm.on("keyup", (cm2, evt) => {
      // Most common case: the slash that just kicked things off.
      const k = evt.key;
      if (k === "/" || /^[A-Za-z0-9_-]$/.test(k)) {
        triggerHintIfAppropriate();
      }
    });
    cm.on("cursorActivity", () => {
      // If the caret now sits right after a `/query` token (e.g. user moved
      // back with an arrow or repositioned the cursor), gently pop the hint.
      if (cm.state.completionActive) return;
      const pos = cm.getCursor();
      const line = cm.getLine(pos.line);
      const seg = line.slice(0, pos.ch);
      if (/\/[A-Za-z0-9_-]*$/.test(seg)) triggerHintIfAppropriate();
    });

    refreshHeader();

    toggleEl.addEventListener("click", () => {
      item.collapsed = !item.collapsed;
      card.classList.toggle("collapsed", item.collapsed);
      // CodeMirror layout may be stale after re-showing — refresh next frame.
      if (!item.collapsed) requestAnimationFrame(() => cm.refresh());
      persist(kind);
    });

    validateBtn.addEventListener("click", doValidate);

    deleteEl.addEventListener("click", () => {
      const a = arrayFor(kind);
      const i = a.findIndex((x) => x.id === item.id);
      if (i >= 0) a.splice(i, 1);
      persist(kind);
      renderCards(kind);
    });

    list.appendChild(card);
  });
}

function addCard(kind) {
  arrayFor(kind).push({ id: uid(), yaml: "", collapsed: false });
  persist(kind);
  renderCards(kind);
  const list = document.getElementById(STORES[kind].listId);
  const cms = list.querySelectorAll(".CodeMirror");
  if (cms.length) {
    const cm = cms[cms.length - 1].CodeMirror;
    if (cm) cm.focus();
  }
}

document.getElementById(STORES.component.addId).addEventListener("click", () =>
  addCard("component")
);
document.getElementById(STORES.playbook.addId).addEventListener("click", () =>
  addCard("playbook")
);

/* ---------- Form tab (column-fixed CSV-like table) ---------- */

const FORM_FORM_WRAP_ID = "formTableWrap";
let editingFormId = null;

function renderForms() {
  const wrap = document.getElementById(FORM_FORM_WRAP_ID);
  wrap.innerHTML = "";
  if (forms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.innerHTML = `<div class="form-empty">No form fields yet. Click "+ Add row" to define one.</div>`;
    wrap.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "form-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  FORM_FIELDS.forEach((f) => {
    const th = document.createElement("th");
    th.textContent = f.label;
    if (f.key === "name") th.classList.add("name-col");
    if (f.key === "type") th.classList.add("type-col");
    headRow.appendChild(th);
  });
  const actionsTh = document.createElement("th");
  actionsTh.textContent = "Actions";
  actionsTh.className = "actions-col";
  headRow.appendChild(actionsTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  forms.forEach((row) => {
    const tr = document.createElement("tr");
    if (editingFormId === row.id) tr.classList.add("editing");
    tr.dataset.id = row.id;
    FORM_FIELDS.forEach((f) => {
      const td = document.createElement("td");
      if (f.key === "name") td.classList.add("name-col");
      if (f.key === "type") td.classList.add("type-col");
      const cell = document.createElement("div");
      cell.className = "form-cell";

      if (editingFormId === row.id) {
        let input;
        if (f.key === "type") {
          input = document.createElement("select");
          Y.ALLOWED_FORM_TYPES.forEach((t) => {
            const o = document.createElement("option");
            o.value = t;
            o.textContent = t;
            if (row.type === t) o.selected = true;
            input.appendChild(o);
          });
        } else {
          input = document.createElement("input");
          input.type = "text";
          input.value = row[f.key] ?? "";
          input.placeholder = f.key;
        }
        input.dataset.key = f.key;
        cell.appendChild(input);
      } else {
        const valueEl = document.createElement("div");
        valueEl.className = "form-cell-value";
        if (f.key === "type") {
          const t = row.type || "string";
          valueEl.innerHTML = `<span class="type-badge ${t}">${escapeHtml(t)}</span>`;
        } else {
          const v = row[f.key];
          valueEl.textContent = v !== undefined && v !== "" ? String(v) : "\u2014";
        }
        cell.appendChild(valueEl);
        cell.addEventListener("click", () => enterEdit(row.id));
      }
      td.appendChild(cell);
      tr.appendChild(td);
    });

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions-col";
    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    if (editingFormId === row.id) {
      const saveBtn = document.createElement("button");
      saveBtn.className = "row-btn primary";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () => commitEdit(tr, row.id));
      const cancel = document.createElement("button");
      cancel.className = "row-btn cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        editingFormId = null;
        renderForms();
      });
      rowActions.appendChild(saveBtn);
      rowActions.appendChild(cancel);
    } else {
      const edit = document.createElement("button");
      edit.className = "row-btn";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => enterEdit(row.id));
      const del = document.createElement("button");
      del.className = "row-btn danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        forms = forms.filter((r) => r.id !== row.id);
        persistForms();
        renderForms();
      });
      rowActions.appendChild(edit);
      rowActions.appendChild(del);
    }
    actionsTd.appendChild(rowActions);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (editingFormId !== null) {
    const tr = wrap.querySelector(`tr[data-id="${editingFormId}"]`);
    if (tr) {
      const firstInput = tr.querySelector('input[data-key="name"]');
      if (firstInput) {
        firstInput.focus();
        firstInput.select();
      }
    }
  }
}

function enterEdit(rowId) {
  editingFormId = rowId;
  renderForms();
}

function commitEdit(tr, rowId) {
  const inputs = tr.querySelectorAll("[data-key]");
  const patch = {};
  let hasError = "";
  inputs.forEach((el) => {
    const key = el.dataset.key;
    if (el.tagName === "SELECT") {
      patch[key] = el.value;
    } else {
      patch[key] = el.value.trim();
    }
  });
  if (!patch.name) {
    hasError = "name is required";
  } else {
    const dup = forms.find(
      (r) => r.id !== rowId && String(r.name) === patch.name
    );
    if (dup) hasError = `duplicate name "${patch.name}"`;
  }
  if (!hasError && patch.type && patch.type !== "string") {
    if (patch.value === undefined || String(patch.value).trim() === "") {
      hasError = `type "${patch.type}" requires a value`;
    }
  }
  const oldErr = tr.parentElement.parentElement.querySelector(":scope > .form-error");
  if (oldErr) oldErr.remove();
  if (hasError) {
    const err = document.createElement("div");
    err.className = "form-error";
    err.textContent = hasError;
    tr.parentElement.parentElement.insertBefore(err, tr.parentElement.nextSibling);
    return;
  }
  forms = forms.map((r) =>
    r.id === rowId
      ? {
          ...r,
          name: patch.name,
          label: patch.label,
          value: patch.value,
          display: patch.display,
          type: patch.type || "string",
        }
      : r
  );
  editingFormId = null;
  persistForms();
  renderForms();
}

document.getElementById("addFormRow").addEventListener("click", () => {
  const newRow = {
    id: uid(),
    name: "",
    label: "",
    value: "",
    display: "",
    type: "string",
  };
  forms = forms.concat(newRow);
  persistForms();
  editingFormId = newRow.id;
  renderForms();
});

/* ---------- Load + live sync ---------- */
function migrateLegacy(data) {
  if (
    Array.isArray(data.sreCommons) &&
    data.sreCommons.length &&
    (!data.sreComponents || data.sreComponents.length === 0)
  ) {
    chrome.storage.local.set({ sreComponents: data.sreCommons });
    return data.sreCommons.map(normalizeCard);
  }
  return Array.isArray(data.sreComponents) ? data.sreComponents : [];
}

chrome.storage.local.get(
  ["sreConfig", "sreComponents", "sreCommons", "srePlaybooks", "sreForms", "sreRingtones", "sreChatSpaceRules"],
  (data) => {
    fillSettingsForm(data.sreConfig || {});
    components = migrateLegacy(data).map(normalizeCard);
    playbooks = (Array.isArray(data.srePlaybooks) ? data.srePlaybooks : []).map(
      normalizeCard
    );
    forms = Array.isArray(data.sreForms) ? data.sreForms : [];
    forms = forms.map((r) => (r.id ? r : { id: uid(), ...r }));
    ringtones = Array.isArray(data.sreRingtones) ? data.sreRingtones : [];
    chatRules = Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [];
    chatRules = chatRules.map((r) => (r.id ? r : { id: uid(), ...r }));
    renderCards("component");
    renderCards("playbook");
    renderForms();
    renderRingtones();
    renderChatRules();
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sreComponents) {
    const nv = (Array.isArray(changes.sreComponents.newValue)
      ? changes.sreComponents.newValue
      : []
    ).map(normalizeCard);
    if (JSON.stringify(nv) !== JSON.stringify(components)) {
      components = nv;
      renderCards("component");
      renderCards("playbook");
    }
  }
  if (changes.srePlaybooks) {
    const nv = (Array.isArray(changes.srePlaybooks.newValue)
      ? changes.srePlaybooks.newValue
      : []
    ).map(normalizeCard);
    if (JSON.stringify(nv) !== JSON.stringify(playbooks)) {
      playbooks = nv;
      renderCards("playbook");
    }
  }
  if (changes.sreForms) {
    const nv = Array.isArray(changes.sreForms.newValue)
      ? changes.sreForms.newValue
      : [];
    if (JSON.stringify(nv) !== JSON.stringify(forms)) {
      forms = nv.map((r) => (r.id ? r : { id: uid(), ...r }));
      renderForms();
      document.querySelectorAll(".pb-validation.visible").forEach((v) => {
        v.classList.remove("visible", "ok", "err", "warn");
        v.innerHTML = "";
      });
    }
  }
  if (changes.sreRingtones) {
    const nv = Array.isArray(changes.sreRingtones.newValue) ? changes.sreRingtones.newValue : [];
    if (JSON.stringify(nv) !== JSON.stringify(ringtones)) {
      ringtones = nv;
      renderRingtones();
      renderChatRules(); // ringtone dropdown reflects new list
    }
  }
  if (changes.sreChatSpaceRules) {
    const nv = Array.isArray(changes.sreChatSpaceRules.newValue) ? changes.sreChatSpaceRules.newValue : [];
    const norm = nv.map((r) => (r.id ? r : { id: uid(), ...r }));
    if (JSON.stringify(norm) !== JSON.stringify(chatRules)) {
      chatRules = norm;
      renderChatRules();
    }
  }
});

/* ---------- Ringtones ---------- */

let ringtones = [];
let _previewAudio = null;

function persistRingtones() {
  chrome.storage.local.set({ sreRingtones: ringtones });
}

function ringtoneReferencedCount(ringtoneId) {
  return chatRules.filter((r) => r.ringtoneId === ringtoneId).length;
}

function formatSizeKB(bytes) {
  if (!bytes) return "— KB";
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

function stopPreview() {
  if (_previewAudio) {
    try { _previewAudio.pause(); } catch (_) {}
    _previewAudio = null;
  }
}

function playPreview(dataUrl) {
  stopPreview();
  if (!dataUrl) return;
  try {
    const a = new Audio(dataUrl);
    a.volume = 1.0;
    a.play().catch(() => {});
    a.addEventListener("ended", () => { if (_previewAudio === a) _previewAudio = null; });
    _previewAudio = a;
  } catch (_) {}
}

function readAudioFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result, mime: file.type });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function durationClass(sec) {
  if (sec == null) return "";
  if (sec <= 2) return "short";
  if (sec >= 5) return "long";
  return "";
}

function renderRingtones() {
  const wrap = document.getElementById("ringtonesList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (ringtones.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ring-empty";
    empty.textContent = "No ringtones uploaded yet. Click + Upload ringtone to add mp3 / wav / ogg.";
    wrap.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "ring-list";

  for (const r of ringtones) {
    const item = document.createElement("div");
    item.className = "ring-item";

    const main = document.createElement("div");
    main.className = "ring-item-main";
    const title = document.createElement("div");
    title.className = "ring-item-title";
    title.textContent = r.name || "(unnamed)";
    const meta = document.createElement("div");
    meta.className = "ring-item-meta";
    const durChip = document.createElement("span");
    durChip.className = `ring-chip ${durationClass(r.durationSec)}`;
    durChip.textContent = r.durationSec != null ? `${r.durationSec.toFixed(1)}s` : "—s";
    meta.appendChild(durChip);
    const fmt = document.createElement("span");
    fmt.className = "ring-chip";
    fmt.textContent = (r.mime || r.format || "audio").split("/").pop().toUpperCase();
    meta.appendChild(fmt);
    const size = document.createElement("span");
    size.className = "ring-chip";
    size.textContent = formatSizeKB(r.sizeBytes);
    meta.appendChild(size);
    const refs = ringtoneReferencedCount(r.id);
    if (refs > 0) {
      const used = document.createElement("span");
      used.className = "ref-badge";
      used.textContent = `used ${refs} rule${refs === 1 ? "" : "s"}`;
      meta.appendChild(used);
    }
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "ring-actions";
    const chipPlay = document.createElement("span");
    chipPlay.className = "ring-chip-play";
    chipPlay.innerHTML = `<span>${r.name || "audio"}</span>`;
    const btnPlay = document.createElement("button");
    btnPlay.className = "btn-mini-play";
    btnPlay.title = "Preview";
    btnPlay.textContent = "▶";
    btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreview(r.dataUrl);
    });
    chipPlay.appendChild(btnPlay);
    actions.appendChild(chipPlay);

    const btnDel = document.createElement("button");
    btnDel.className = "row-btn danger";
    btnDel.textContent = "Del";
    btnDel.title = "Delete ringtone";
    if (refs > 0) {
      btnDel.disabled = true;
      btnDel.style.opacity = "0.45";
      btnDel.style.cursor = "not-allowed";
      btnDel.title = `Still used by ${refs} rule(s). Unlink first.`;
    } else {
      btnDel.addEventListener("click", () => {
        stopPreview();
        ringtones = ringtones.filter((x) => x.id !== r.id);
        persistRingtones();
      });
    }
    actions.appendChild(btnDel);

    item.appendChild(main);
    item.appendChild(actions);
    list.appendChild(item);
  }
  wrap.appendChild(list);
}

async function addRingtonesFromFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  for (const f of files) {
    try {
      if (!f.type.startsWith("audio/") && !/\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name)) continue;
      const { dataUrl, mime } = await readAudioFileAsDataURL(f);
      // Best-effort duration probe: load in an offscreen Audio() element; if
      // metadata load is slow (> 1.5s) just record null.
      let durationSec = null;
      try {
        durationSec = await new Promise((resolve) => {
          const a = new Audio(dataUrl);
          let settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          a.addEventListener("loadedmetadata", () => done(a.duration && isFinite(a.duration) ? a.duration : null));
          a.addEventListener("error", () => done(null));
          setTimeout(() => done(null), 1500);
        });
      } catch (_) {}
      const base = f.name.replace(/\.[^.]+$/, "");
      ringtones.push({
        id: uid(),
        name: base,
        durationSec,
        mime: mime || f.type || "audio/*",
        dataUrl,
        sizeBytes: f.size || 0,
        createdAt: Date.now(),
      });
    } catch (e) {
      console.warn("ringtone upload failed:", f.name, e);
    }
  }
  persistRingtones();
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("addRingtoneBtn");
  const input = document.getElementById("ringtoneFileInput");
  if (btn && input) {
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => {
      addRingtonesFromFiles(e.target.files);
      // reset so same file picked again still fires change
      e.target.value = "";
    });
  }
});

/* ---------- Chat Spaces rules ---------- */

let chatRules = [];
let editingRuleId = null; // null => creating a new one

function persistChatRules() {
  chrome.storage.local.set({ sreChatSpaceRules: chatRules });
}

function ringtoneNameById(id) {
  const r = ringtones.find((x) => x.id === id);
  return r ? r.name : "(none)";
}

// Legacy rules (saved before the matchType/ruleName simplification) may still
// carry matchValue / ruleName instead of spaceName — always read through here.
function ruleSpaceName(rule) {
  return (rule && (rule.spaceName || rule.matchValue || rule.ruleName)) || "";
}

function emptyRuleDraft() {
  return {
    id: null,
    spaceName: "",
    ringtoneId: ringtones[0] ? ringtones[0].id : "",
    repeatIntervalSec: 10,
    maxRepeats: 20,
    enabled: true,
    alertOnStartup: false,
  };
}

function fillChatRuleForm(rule) {
  const wrap = document.getElementById("chatRulesEditForm");
  if (!wrap) return;
  wrap.innerHTML = "";
  const draft = rule ? { ...emptyRuleDraft(), ...rule } : emptyRuleDraft();
  if (!draft.ringtoneId && ringtones[0]) draft.ringtoneId = ringtones[0].id;
  editingRuleId = draft.id;

  const card = document.createElement("div");
  card.className = "rule-editor-card";
  const title = document.createElement("div");
  title.className = "rule-editor-title";
  title.textContent = editingRuleId ? `Editing rule · ${ruleSpaceName(draft) || "(unnamed)"}` : "Create a new rule";
  card.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "rule-form-grid";

  // --- Fields helpers ---
  const addField = (labelText, node, hintText, extraClass = "") => {
    const wrap2 = document.createElement("div");
    wrap2.className = `field ${extraClass}`;
    const lab = document.createElement("label");
    lab.textContent = labelText;
    wrap2.appendChild(lab);
    wrap2.appendChild(node);
    if (hintText) {
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = hintText;
      wrap2.appendChild(h);
    }
    grid.appendChild(wrap2);
    return node;
  };

  const mkInput = (value) => {
    const inp = document.createElement("input");
    inp.className = "input";
    inp.type = "text";
    inp.value = value || "";
    return inp;
  };
  const mkNum = (value) => {
    const inp = document.createElement("input");
    inp.className = "input";
    inp.type = "number";
    inp.min = "1";
    inp.step = "1";
    inp.value = value == null ? "" : String(value);
    return inp;
  };

  const space = mkInput(ruleSpaceName(draft));
  addField("Space name", space,
    "Sidebar name of the Space or DM. Matched exactly (case-insensitive); comma-separate multiple names.",
    "full");

  const ringtoneSel = document.createElement("select");
  ringtoneSel.className = "select";
  if (ringtones.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(upload ringtones first)";
    ringtoneSel.appendChild(opt);
  }
  for (const r of ringtones) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === draft.ringtoneId) opt.selected = true;
    ringtoneSel.appendChild(opt);
  }
  addField("Ringtone", ringtoneSel, "Played on every repeat until user reads or max repeats reached.");

  const interval = mkNum(draft.repeatIntervalSec);
  const intervalField = document.createElement("div");
  intervalField.style.display = "flex";
  intervalField.style.alignItems = "center";
  intervalField.style.gap = "8px";
  interval.style.flex = "1";
  intervalField.appendChild(interval);
  const intervalSuffix = document.createElement("span");
  intervalSuffix.className = "hint";
  intervalSuffix.textContent = "seconds";
  intervalField.appendChild(intervalSuffix);
  // Wrap in a "field" that addField would have made — but we need to pass the
  // number *input* reference into save handler, so keep interval unchanged.
  const intWrap = document.createElement("div");
  intWrap.className = "field";
  const intLab = document.createElement("label");
  intLab.textContent = "Repeat interval";
  intWrap.appendChild(intLab);
  intWrap.appendChild(intervalField);
  const intHint = document.createElement("div");
  intHint.className = "hint";
  intHint.textContent = "How often to re-check and re-ring while unread persists.";
  intWrap.appendChild(intHint);
  grid.appendChild(intWrap);

  const maxR = mkNum(draft.maxRepeats);
  addField("Max repeats", maxR, "Maximum re-rings before auto-idling (prevents spamming if tab is left open). 0 or empty = unlimited (not recommended).");

  card.appendChild(grid);
  // Switches row (Enabled + Startup)
  const swRow1 = document.createElement("div");
  swRow1.className = "rule-switch-row full";
  swRow1.style.borderTop = "1px solid var(--border)";
  swRow1.style.marginTop = "12px";
  swRow1.style.paddingTop = "12px";
  const sw1LabelWrap = document.createElement("div");
  const sw1Label = document.createElement("label");
  sw1Label.textContent = "Enable rule";
  sw1LabelWrap.appendChild(sw1Label);
  const sw1Hint = document.createElement("div");
  sw1Hint.className = "hint";
  sw1Hint.textContent = "Off = rule is ignored by monitoring entirely.";
  sw1LabelWrap.appendChild(sw1Hint);
  const sw1 = document.createElement("label");
  sw1.className = "switch";
  const sw1i = document.createElement("input");
  sw1i.type = "checkbox";
  sw1i.checked = Boolean(draft.enabled);
  const sw1t = document.createElement("span");
  sw1t.className = "slider-sw";
  sw1.appendChild(sw1i); sw1.appendChild(sw1t);
  swRow1.appendChild(sw1LabelWrap); swRow1.appendChild(sw1);
  card.appendChild(swRow1);

  const swRow2 = document.createElement("div");
  swRow2.className = "rule-switch-row full";
  const sw2LabelWrap = document.createElement("div");
  const sw2Label = document.createElement("label");
  sw2Label.textContent = "Alert on existing unread at startup";
  sw2LabelWrap.appendChild(sw2Label);
  const sw2Hint = document.createElement("div");
  sw2Hint.className = "hint";
  sw2Hint.textContent = "Default OFF: only alert when unread goes 0 → >0 (new messages). ON: page reload/navigation will also alert if the space already has unread.";
  sw2LabelWrap.appendChild(sw2Hint);
  const sw2 = document.createElement("label");
  sw2.className = "switch";
  const sw2i = document.createElement("input");
  sw2i.type = "checkbox";
  sw2i.checked = Boolean(draft.alertOnStartup);
  const sw2t = document.createElement("span");
  sw2t.className = "slider-sw";
  sw2.appendChild(sw2i); sw2.appendChild(sw2t);
  swRow2.appendChild(sw2LabelWrap); swRow2.appendChild(sw2);
  card.appendChild(swRow2);

  // Actions
  const actions = document.createElement("div");
  actions.className = "rule-editor-actions";
  const cancel = document.createElement("button");
  cancel.className = "row-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    editingRuleId = null;
    fillChatRuleForm(null);
    // Wipe the editor away (render just empty form header for "new" CTA-less)
    const w = document.getElementById("chatRulesEditForm");
    if (w) w.innerHTML = "";
  });
  const save = document.createElement("button");
  save.className = "btn btn-primary";
  save.textContent = editingRuleId ? "Save rule" : "Create rule";
  save.addEventListener("click", () => {
    const spaceVal = (space.value || "").trim();
    if (!spaceVal) {
      space.style.borderColor = "var(--danger, #e5484d)";
      space.focus();
      space.addEventListener("input", () => { space.style.borderColor = ""; }, { once: true });
      return;
    }
    const ruleInterval = parseInt(interval.value, 10);
    const ruleMaxR = parseInt(maxR.value, 10);
    const saved = {
      id: editingRuleId || uid(),
      spaceName: spaceVal,
      ringtoneId: ringtoneSel.value || "",
      repeatIntervalSec: isFinite(ruleInterval) && ruleInterval > 0 ? ruleInterval : 10,
      maxRepeats: !isFinite(ruleMaxR) || ruleMaxR <= 0 ? 0 : ruleMaxR,
      enabled: sw1i.checked,
      alertOnStartup: sw2i.checked,
    };
    if (editingRuleId) {
      chatRules = chatRules.map((r) => (r.id === editingRuleId ? saved : r));
    } else {
      chatRules.push(saved);
    }
    persistChatRules();
    renderChatRules();
    editingRuleId = null;
    const w = document.getElementById("chatRulesEditForm");
    if (w) w.innerHTML = "";
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  card.appendChild(actions);

  wrap.appendChild(card);
}

function renderChatRules() {
  const list = document.getElementById("chatRulesList");
  if (!list) return;
  list.innerHTML = "";

  const title = document.createElement("div");
  title.className = "saved-rules-title";
  title.textContent = "Saved rules";
  list.appendChild(title);

  if (chatRules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ring-empty";
    empty.textContent = "No rules yet. Click + Add rule above to create your first mapping.";
    list.appendChild(empty);
    return;
  }

  const root = document.createElement("div");
  root.className = "rule-saved-list";
  for (const rule of chatRules) {
    const card = document.createElement("div");
    card.className = "rule-card";
    const top = document.createElement("div");
    top.className = "rule-card-top";
    const main = document.createElement("div");
    main.className = "rule-card-main";
    const titleRow = document.createElement("div");
    titleRow.className = "rule-card-title";
    titleRow.textContent = ruleSpaceName(rule) || "(unnamed)";
    if (rule.enabled) {
      const b = document.createElement("span");
      b.className = "state-badge ref-badge";
      b.textContent = "ENABLED";
      titleRow.appendChild(b);
    } else {
      const b = document.createElement("span");
      b.className = "state-badge";
      b.style.background = "var(--input-bg)";
      b.style.color = "var(--muted)";
      b.textContent = "DISABLED";
      titleRow.appendChild(b);
    }
    const meta = document.createElement("div");
    meta.className = "rule-card-meta";
    const chips = [
      `ringtone: ${ringtoneNameById(rule.ringtoneId)}`,
      `${rule.repeatIntervalSec || 10}s / ×${rule.maxRepeats || 0 || "∞"}`,
    ];
    if (rule.alertOnStartup) chips.push("startup-alert=ON");
    for (const c of chips) {
      const s = document.createElement("span");
      s.className = "ring-chip";
      s.textContent = c;
      meta.appendChild(s);
    }
    main.appendChild(titleRow);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "rule-card-actions";
    const edit = document.createElement("button");
    edit.className = "row-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => fillChatRuleForm(rule));
    const del = document.createElement("button");
    del.className = "row-btn danger";
    del.textContent = "Del";
    del.addEventListener("click", () => {
      chatRules = chatRules.filter((r) => r.id !== rule.id);
      persistChatRules();
      renderChatRules();
    });
    actions.appendChild(edit); actions.appendChild(del);

    top.appendChild(main); top.appendChild(actions);
    card.appendChild(top);
    root.appendChild(card);
  }
  list.appendChild(root);
}

document.addEventListener("DOMContentLoaded", () => {
  const addBtn = document.getElementById("addChatRuleBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => fillChatRuleForm(null));
  }
});

/* ---------- State badges (reused across pages) ---------- */
// (Style is defined inline in options.html under .ref-badge / .state-badge.)
