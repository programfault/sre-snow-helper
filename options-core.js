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

