/* ---------- Shared CodeMirror hint / editor helpers ---------- */
// Used by the Flows bundle editor, the Services editor and the Form tab.
// Bundle flows are materialized into self-contained playbooks (no `ref:`),
// so the ref-completion context no longer has a source of step keys — it
// simply offers nothing instead of reading a removed global.

const HINT_GROUP_TAGS = {
  "common-step": "STEP",
  form: "FORM",
  "form-value": "VALUE",
  "var-param": "PARAM",
  "var-global": "GLOBAL",
};

// Keys of the shared Common Steps document. The v3 bundle has no `ref:`
// mechanism — kept as a safe no-op so legacy ref-context hints stay harmless.
function commonStepKeys() {
  return [];
}

// Variable-name candidates for the `${` completion context: the bundle's
// declared file params first, then the captured page globals.
function editorVarParams() {
  try {
    const yaml = (typeof bundleDoc !== "undefined" && bundleDoc && bundleDoc.yaml) || "";
    if (!yaml) return [];
    return Y.parseBundle(yaml)
      .params.map((p) => p.name)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function editorVarGlobals() {
  return window.SRE_ENV ? SRE_ENV.FIELDS.map((f) => f.gvar) : Y.GLOBAL_GVARS;
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
      : ctx.kind === "var"
        ? Y.buildCompletions({
            kind: "var",
            params: editorVarParams(),
            globals: editorVarGlobals(),
          })
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
    if (k === "/" || k === "{" || k === " " || /^[A-Za-z0-9_-]$/.test(k)) {
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
