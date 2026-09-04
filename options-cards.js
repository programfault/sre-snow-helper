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

