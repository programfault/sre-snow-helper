/* ---------- Shared CodeMirror hint / editor helpers ---------- */
// These are used by BOTH the Playbook cards (below) and the Common Steps
// single-doc editor (options-common.js) — classic scripts share the global
// scope, so both can call slashHint / mountYamlEditor / renderValidationBox.

const HINT_GROUP_TAGS = {
  "common-step": "STEP",
  form: "FORM",
  "form-value": "VALUE",
};

// Keys of the shared Common Steps document (from the global `commonDoc`).
function commonStepKeys() {
  const yaml = (commonDoc && commonDoc.yaml) || "";
  const { steps } = Y.parseCommonSteps(yaml);
  return Object.keys(steps);
}

// CodeMirror hint source. The yaml-lite analyzer decides the context:
//   kind === "ref"   -> suggest only common step keys (after `ref: `)
//   kind === "slash" -> two-level form hints: deduped field names when no key
//                       is on the line yet, else that field's candidate values.
function slashHint(cm) {
  const cursor = cm.getCursor();
  const doc = cm.getDoc();
  let flat = 0;
  for (let i = 0; i < cursor.line; i++) flat += doc.getLine(i).length + 1;
  flat += cursor.ch;
  const ctx = Y.analyzeContext(doc.getValue(), flat);
  if (!ctx) return;

  const all =
    ctx.kind === "ref"
      ? Y.buildCompletions({ kind: "ref", commonSteps: commonStepKeys() })
      : Y.buildCompletions({ ...ctx, forms });
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
// Note: group headers are rendered *inside* each <li> as a "lead" div before
// the row when the group changes. No DOM decoration post-hook is required.

// Mount a CodeMirror 5 YAML editor over a textarea with the shared option set,
// autocomplete wiring (both `/` slash and `ref: ` contexts) and placeholder.
function mountYamlEditor(textarea, placeholderText) {
  textarea.placeholder = placeholderText;
  const cm = CodeMirror.fromTextArea(textarea, {
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
    placeholder: placeholderText,
  });

  // After mount, call refresh() so CodeMirror picks up the real dimensions
  // (it is otherwise sometimes zero-width when appended to fresh DOM).
  setTimeout(() => cm.refresh(), 0);

  // YAML is purely indent-driven — the indent-fold helper is registered by the
  // indent-fold.js addon. CodeMirror's default rangeFinder (fold.auto)
  // consults all registered fold helpers, so nothing extra is needed.

  // Autocomplete trigger. Pop the hint on the keystroke that starts a query:
  //   "/"      -> slash-form query   (e.g. `note: /`)
  //   " "      -> empty `ref: ` just got typed, show all common step keys
  //   word char-> filtering as the user keeps typing (an already-open list is
  //              filtered internally by show-hint, so don't double-trigger)
  // CodeMirror's own keyboard handling (arrows to pick, Enter/Tab to select,
  // Esc to cancel) works out of the box because we use show-hint. We do NOT
  // auto-reopen on cursorActivity: after a selection the caret sits on a
  // completed `ref: key` that still matches the ref pattern, so reopening
  // would keep the dropdown alive instead of hiding it like the slash hints.
  function triggerHintIfAppropriate() {
    if (cm.state.completionActive) return;
    CodeMirror.showHint(cm, slashHint, {
      completeSingle: false,
      alignWithWord: false,
      closeOnUnfocus: true,
    });
  }
  cm.on("keyup", (cm2, evt) => {
    const k = evt.key;
    if (k === "/" || k === " " || /^[A-Za-z0-9_-]$/.test(k)) {
      triggerHintIfAppropriate();
    }
  });

  return cm;
}

// Render a { ok, errors, warnings } validation report into a container that
// uses the .pb-validation styles (ok / err / warn visual states).
function renderValidationBox(valEl, report) {
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

/* ---------- Playbook cards ---------- */

const PB_STORE = STORES.playbook;

function renderCards() {
  const list = document.getElementById(PB_STORE.listId);
  list.innerHTML = "";

  if (playbooks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pb-empty";
    empty.textContent =
      'No flows yet. Click "+ Add flow" to create one.';
    list.appendChild(empty);
    return;
  }

  playbooks.forEach((item) => {
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

    function doValidate() {
      card.classList.add("validating");
      requestAnimationFrame(() => {
        const commonByName = Y.indexCommonSteps(
          (commonDoc && commonDoc.yaml) || ""
        );
        const formsByName = Y.indexForms(forms);
        const base = Y.validatePlaybookFlow(
          item.yaml,
          commonByName,
          formsByName
        );
        const opt = Y.validateOptionParams(item.yaml, forms);
        const report = {
          ok: base.ok && opt.ok,
          errors: base.errors.concat(opt.errors),
          warnings: base.warnings.concat(opt.warnings),
        };
        renderValidationBox(valEl, report);
        card.classList.remove("validating");
      });
    }

    // Mount CodeMirror on the textarea.
    yamlEl.value = item.yaml;
    const cm = mountYamlEditor(yamlEl, PB_STORE.placeholder);

    // Wire editor -> in-memory item, header, storage, validation clear.
    // `change` fires for every mutation (keystroke, paste, autocomplete, undo).
    cm.on("change", () => {
      item.yaml = cm.getValue();
      refreshHeader();
      savePlaybooks();
      // Clear the validation report since the document is now dirty.
      if (valEl.classList.contains("visible")) {
        valEl.classList.remove("visible", "ok", "err", "warn");
        valEl.innerHTML = "";
      }
    });

    refreshHeader();

    toggleEl.addEventListener("click", () => {
      item.collapsed = !item.collapsed;
      card.classList.toggle("collapsed", item.collapsed);
      // CodeMirror layout may be stale after re-showing — refresh next frame.
      if (!item.collapsed) requestAnimationFrame(() => cm.refresh());
      persistPlaybooks();
    });

    validateBtn.addEventListener("click", doValidate);

    deleteEl.addEventListener("click", () => {
      const i = playbooks.findIndex((x) => x.id === item.id);
      if (i >= 0) playbooks.splice(i, 1);
      persistPlaybooks();
      renderCards();
    });

    list.appendChild(card);
  });
}

function addCard() {
  playbooks.push({ id: uid(), yaml: "", collapsed: false });
  persistPlaybooks();
  renderCards();
  const list = document.getElementById(PB_STORE.listId);
  const cms = list.querySelectorAll(".CodeMirror");
  if (cms.length) {
    const cm = cms[cms.length - 1].CodeMirror;
    if (cm) cm.focus();
  }
}

document.getElementById(PB_STORE.addId).addEventListener("click", addCard);
