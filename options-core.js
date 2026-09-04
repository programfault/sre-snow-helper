// SRE Helper options script
// Tabs: ServiceNow (Form | Common | Flows) | Services | Notification (Ringtones | Space Rules)
//
// Playbook cards use a *real* CodeMirror 5 YAML editor (vendored locally).
// The "Common Steps" tab hosts a single shared document (top-level `params:`
// + a `common_steps:` map) that playbook `flow:` items reference via `ref:`.
//
// Header (name + desc stacked) for playbooks is derived from the YAML on each
// change. Per-card Validate runs semantic checks:
//   Playbook : name + flow refs against Common Steps + forms against the library
//   Common   : every common_steps form against the Form library
//
// The Form tab exposes a CSV-like, column-fixed table (name / label / display /
// value / type) with click-to-edit rows and a bulk CSV editor (toggle button).
// type ∈ {string, number, sysid}. `name` is not a unique key: repeating a name
// groups rows into candidate values for one YAML field.

const Y = SRE_YAML;

const STORES = {
  playbook: {
    storageKey: "srePlaybooks",
    listId: "playbookList",
    addId: "addPlaybook",
    placeholder:
      "# Orchestration flow\n" +
      "#\n" +
      "# name: ask-questions\n" +
      "# desc: Need more details before acting\n" +
      "# params:\n" +
      "#   - name: User Name\n" +
      "#     type: textarea   # optional: multi-line input box\n" +
      "# flow:\n" +
      "#   - name: ack user\n" +
      "#     ref: ack              # key into the Common Steps doc\n" +
      "#   - name: custom check\n" +
      "#     action: true\n" +
      "#     form:\n" +
      "#       note: check ${param0}\n",
  },
};

// The shared Common Steps single document lives under sreCommonSteps as
// { id, yaml }. Its editor is hosted on the "common" tab.
const COMMON_DOC_STORE = {
  storageKey: "sreCommonSteps",
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

let playbooks = [];
let commonDoc = null; // { id, yaml }
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

/* ---------- Storage helpers ---------- */
function persistPlaybooks() {
  chrome.storage.local.set({ [STORES.playbook.storageKey]: playbooks });
}
function savePlaybooks() {
  clearTimeout(saveTimers.playbook);
  saveTimers.playbook = setTimeout(persistPlaybooks, 400);
}
function persistCommonDoc() {
  if (commonDoc) {
    chrome.storage.local.set({ [COMMON_DOC_STORE.storageKey]: commonDoc });
  }
}
function saveCommonDoc() {
  clearTimeout(saveTimers.commonDoc);
  saveTimers.commonDoc = setTimeout(persistCommonDoc, 400);
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
