/* ---------- Flows bundle single-document editor ---------- */
// Hosted on the "Flows" tab. A single CodeMirror editor over the whole bundle
// document (v3 schema):
//   version: 3
//   params:   — named variables shared by every flow (file params win over
//               captured page globals like ${incidentId})
//   common:   — template library (name + ordered steps with action/items)
//   groups:   — dropdown group -> template binding + nested flows (items are
//               appended after the template's steps)
// The side panel materializes each flow into a self-contained playbook.

// Shown when the document is empty / as an onboarding guide.
const BUNDLE_DOC_PLACEHOLDER =
  [
    "# Flows bundle — one document for all flows.",
    "# params: named variables (${name} — type \"+\" hints file params and",
    "#   captured globals); type: option builds a radio group from the Form",
    "#   library, type: textarea a multi-line box.",
    "# steps: shared single-step library — templates and flows may `ref:` them.",
    "# common: reusable step sequences; groups: bind a dropdown group to a",
    "#   template and list its flows (own items/steps run after the template).",
    "version: 3",
    "",
    "params:",
    "  - name: business_service",
    "    type: option",
    "",
    "steps:",
    "  - name: ack",
    "    action: true",
    "    items:",
    "      state: 2",
    "      work_notes: ack",
    "",
    "common:",
    "  - name: ResolvedTemplate",
    "    steps:",
    "      - ref: ack",
    "      - name: update basic info",
    "        action: true",
    "        items:",
    "          state: 6",
    "          close_code: Solved (Work Around)",
    "",
    "groups:",
    "  - group: Resolved",
    "    common: ResolvedTemplate",
    "    flows:",
    "      - name: Device activation",
    "        items:",
    "          work_notes: Device activation is completed",
    "          business_service: ${business_service}",
  ].join("\n");

let bundleCm = null;

// Mount (once) or update the editor to reflect the current `bundleDoc`.
function renderBundleDoc() {
  const container = document.getElementById("bundleEditor");
  if (!container) return;
  const yaml = (bundleDoc && bundleDoc.yaml) || "";

  if (bundleCm) {
    // Don't clobber the editor when storage echoes back our own debounced
    // saves, and never interrupt an active edit. Only adopt a genuinely
    // external change (e.g. a second options page).
    const active =
      document.activeElement === bundleCm.getWrapperElement() ||
      bundleCm.getWrapperElement().contains(document.activeElement);
    if (!active && bundleCm.getValue() !== yaml) bundleCm.setValue(yaml);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.spellcheck = false;
  container.appendChild(textarea);
  bundleCm = mountYamlEditor(textarea, BUNDLE_DOC_PLACEHOLDER);
  if (yaml) bundleCm.setValue(yaml);

  bundleCm.on("change", () => {
    const v = bundleCm.getValue();
    if (!bundleDoc) {
      bundleDoc = { id: uid(), yaml: v };
    } else {
      bundleDoc.yaml = v;
    }
    saveBundleDoc();
    // Document is dirty again — clear the last validation report.
    const valEl = document.getElementById("bundleValidation");
    if (valEl && valEl.classList.contains("visible")) {
      valEl.classList.remove("visible", "ok", "err", "warn");
      valEl.innerHTML = "";
    }
  });
}

const bundleValidateBtn = document.getElementById("validateBundleDoc");
if (bundleValidateBtn) {
  bundleValidateBtn.addEventListener("click", () => {
    const valEl = document.getElementById("bundleValidation");
    const yaml = (bundleDoc && bundleDoc.yaml) || "";
    const gvars = window.SRE_ENV ? SRE_ENV.FIELDS.map((f) => f.gvar) : null;
    const report = Y.validateBundle(yaml, Y.indexForms(forms), gvars);
    renderValidationBox(valEl, report);
  });
}
