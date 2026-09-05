/* ---------- Common Steps single-document editor ---------- */
// Hosted on the "Common Steps" tab. A single CodeMirror editor over the whole
// shared document (`params:` + `common_steps:` map). Playbook `flow:` items
// reference the step keys below via `ref:`.

// Shown when the document is empty / as an onboarding guide.
const COMMON_DOC_PLACEHOLDER =
  [
    "# Shared parameters for the common steps below.",
    "# Referenced inside common forms as ${param0}, ${param1}, ...",
    "# Optional per-param type hints:",
    "#   type: textarea -> multi-line box (default is a single-line input)",
    "#   type: option   -> radio group whose choices come from the Form library",
    "params:",
    "  - name: User Name",
    "    type: textarea",
    "  - name: Configuration item",
    "    type: option",
    "",
    "# Library of reusable steps. The key is what playbooks use in `ref:`.",
    "# `action: true` marks a step that is sent by itself (not merged).",
    "common_steps:",
    "  ack:",
    "    action: true",
    "    form:",
    "      note: acknowledged ${param0}",
    "  investigate:",
    "    action: true",
    "    form:",
    "      u_substate: ${param1}",
  ].join("\n");

let commonCm = null;

// Mount (once) or update the editor to reflect the current `commonDoc`.
function renderCommonDoc() {
  const container = document.getElementById("commonEditor");
  if (!container) return;
  const yaml = (commonDoc && commonDoc.yaml) || "";

  if (commonCm) {
    // Don't clobber the editor when storage echoes back our own debounced
    // saves, and never interrupt an active edit. Only adopt a genuinely
    // external change (e.g. a second options page).
    const active =
      document.activeElement === commonCm.getWrapperElement() ||
      commonCm.getWrapperElement().contains(document.activeElement);
    if (!active && commonCm.getValue() !== yaml) commonCm.setValue(yaml);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.spellcheck = false;
  container.appendChild(textarea);
  commonCm = mountYamlEditor(textarea, COMMON_DOC_PLACEHOLDER);
  if (yaml) commonCm.setValue(yaml);

  commonCm.on("change", () => {
    const v = commonCm.getValue();
    if (!commonDoc) {
      commonDoc = { id: uid(), yaml: v };
    } else {
      commonDoc.yaml = v;
    }
    saveCommonDoc();
    // Document is dirty again — clear the last validation report.
    const valEl = document.getElementById("commonValidation");
    if (valEl && valEl.classList.contains("visible")) {
      valEl.classList.remove("visible", "ok", "err", "warn");
      valEl.innerHTML = "";
    }
  });
}

const commonValidateBtn = document.getElementById("validateCommonDoc");
if (commonValidateBtn) {
  commonValidateBtn.addEventListener("click", () => {
    const valEl = document.getElementById("commonValidation");
    const yaml = (commonDoc && commonDoc.yaml) || "";
    const base = Y.validateCommonStepsDoc(yaml, Y.indexForms(forms));
    const opt = Y.validateOptionParams(yaml, forms);
    const report = {
      ok: base.ok && opt.ok,
      errors: base.errors.concat(opt.errors),
      warnings: base.warnings.concat(opt.warnings),
    };
    renderValidationBox(valEl, report);
  });
}
