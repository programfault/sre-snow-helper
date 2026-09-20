// SRE Helper options script
// Tabs: ServiceNow (Form | Flows) | Services | Notification (Ringtones | Space Rules)
//
// The "Flows" tab hosts a single bundle document (v3 schema: file-level named
// `params:`, a `common:` template library and `groups:` binding dropdown groups
// to templates with nested `flows:`). The side panel materializes each flow
// into a self-contained playbook; variables are ${name} — file params win over
// captured page globals.
//
// Per-doc Validate runs semantic checks against the Form library.
//
// The Form tab exposes a CSV-like, column-fixed table (name / label / display /
// value / type) with click-to-edit rows and a bulk CSV editor (toggle button).
// type ∈ {string, number, sysid}. `name` is not a unique key: repeating a name
// groups rows into candidate values for one YAML field.

const Y = SRE_YAML;

// The flows bundle lives under sreFlowBundle as { id, yaml }. Its editor is
// hosted on the "Flows" tab. Legacy keys (sreCommonSteps / srePlaybooks) are
// only read once by the migration in options-init.js.
const BUNDLE_DOC_STORE = {
  storageKey: "sreFlowBundle",
};

// The shared Services single document lives under sreServices as { id, yaml }.
// Its editor is hosted on the "services" tab.
const SERVICES_DOC_STORE = {
  storageKey: "sreServices",
};

const FORM_FIELDS = [
  { key: "name",    label: "Name"    },
  { key: "label",   label: "Label"   },
  { key: "display", label: "Display" },
  { key: "value",   label: "Value"   },
  { key: "type",    label: "Type"    },
];

let bundleDoc = null; // { id, yaml } — the unified flows bundle
let servicesDoc = null; // { id, yaml }
let forms = []; // Array<{ id, name, label, value, display, type }>
const saveTimers = {};

/* ---------- Tabs ---------- */
// Top-level tabs switch between .tab-page containers.
document.querySelectorAll(".tab.top").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab.top").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.add("hidden"));
    document.getElementById("page-" + btn.dataset.tab).classList.remove("hidden");
    refreshEditors();
  });
});

// Sub-tabs only switch the inner .tab-content blocks of their own page, so a
// ServiceNow (Form/Common/Flows) selection is kept independently from
// Notification (Ringtones/Space Rules).
document.querySelectorAll(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const page = btn.closest(".tab-page");
    if (!page) return;
    page.querySelectorAll(".subtab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    page.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
    document.getElementById("tab-" + btn.dataset.subtab).classList.remove("hidden");
    refreshEditors();
  });
});

// After a tab-switch, any CodeMirror we unmounted while display:none has
// wrong measurement — refresh visible editors.
function refreshEditors() {
  document.querySelectorAll(".CodeMirror").forEach((el) => {
    if (el.CodeMirror) el.CodeMirror.refresh();
  });
}

/* ---------- Utilities ---------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---------- Storage helpers ---------- */
function persistBundleDoc() {
  if (bundleDoc) {
    // Saving the bundle makes it authoritative — always set the migration
    // marker so the sidepanel switches to it even if the one-time migration
    // in options-init was skipped (empty seeded bundle, fresh install, ...).
    chrome.storage.local.set({
      [BUNDLE_DOC_STORE.storageKey]: bundleDoc,
      sreFlowBundleMigrated: true,
    });
  }
}
function saveBundleDoc() {
  clearTimeout(saveTimers.bundleDoc);
  saveTimers.bundleDoc = setTimeout(persistBundleDoc, 400);
}
function persistServicesDoc() {
  if (servicesDoc) {
    chrome.storage.local.set({ [SERVICES_DOC_STORE.storageKey]: servicesDoc });
  }
}
function saveServicesDoc() {
  clearTimeout(saveTimers.servicesDoc);
  saveTimers.servicesDoc = setTimeout(persistServicesDoc, 400);
}
function persistForms() {
  chrome.storage.local.set({ sreForms: forms });
}
