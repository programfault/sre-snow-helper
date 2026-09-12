/* shared.js — global state, helpers, toast, storage and clipboard.
   Loaded FIRST by sidepanel.html; every other sidepanel/*.js builds on the
   globals declared here. */

// SRE Helper side panel — playbook execution UI
//
// Hierarchy:
//   mega-panel (collapsible) ─ wraps all playbooks
//     └─ pb-card (collapsible) per playbook
//         ├─ params form (playbook `params:` + shared Common Steps `params:`)
//         ├─ steps list (`flow:` items; `ref:` steps show the common key)
//         └─ Dry Run / Execute buttons — collect param values and resolve
//             ${placeholders} per param scope (see yaml-lite.js):
//               action=true steps  → sent individually, in flow order
//               remaining steps    → merged into one final send
//             Dry Run (墨绿) previews the resolved payloads without sending.

const Y = SRE_YAML;

// UI state persisted in chrome.storage.local.
let srePanelState = { megaCollapsed: {}, cardCollapsed: {} };

const contentEl = document.getElementById("content");
const openOptionsBtn = document.getElementById("openOptions");
const envInfoBtn = document.getElementById("envInfoBtn");
const envRefreshBtn = document.getElementById("envRefreshBtn");
const envPopoverEl = document.getElementById("envPopover");
const headerSubtitleEl = document.getElementById("headerSubtitle");

// ServiceNow incident context — mirrors the LAST non-empty capture kept by
// background.js (same data source as Options → Environment). Replaced whenever
// a fresh ServiceNow snapshot lands; kept when the user switches to tabs that
// are not on a ServiceNow page. Populated on load and kept fresh by the
// "snow_ctx" broadcasts (see header.js).
let snowCtx = null;

// FSM order-page context — same shape as snowCtx but captured from the FSM
// page (fsm.globe.com.ph / gsmgt-prod.gobetel.com, see goble-content.js).
// Same "keep last" semantics as snowCtx above.
let gobleCtx = null;

// Global context variables that are satisfied automatically instead of being
// prompted as user inputs. They resolve from the page snapshots above and can
// be referenced from any YAML document (playbooks, common steps, services):
//   ${number} / ${userToken} / ${incidentId} / ${instance} / ${caller_name} /
//   ${caller_sysid}                                  ← ServiceNow page
//   ${f_wo_number} / ${f_sid} / ${f_access_token}    ← FSM order page
const SN_CTX_VARS = new Set([
  "number",
  "userToken",
  "incidentId",
  "instance",
  "caller_name",
  "caller_sysid",
]);
const GOB_CTX_VARS = new Set(["f_wo_number", "f_sid", "f_access_token"]);
const CTX_VARS = new Set([...SN_CTX_VARS, ...GOB_CTX_VARS]);

// Field lookup (key → definition) shared by both source groups.
const ENV_FIELDS_BY_KEY = {};
SRE_ENV.FIELDS.forEach((f) => {
  ENV_FIELDS_BY_KEY[f.key] = f;
});

function copyToClipboard(text) {
  if (!text) return Promise.resolve(false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

// execCommand fallback (works in the side panel without clipboardWrite).
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {}
  document.body.removeChild(ta);
  return ok;
}

/* ---------- Storage ---------- */

function loadState(cb) {
  chrome.storage.local.get(
    [
      "srePlaybooks",
      "sreCommonSteps",
      "sreForms",
      "sreServices",
      "srePanelState",
      "sreChatSpaceRules",
      "sreRingtones",
      "sreChatMonitor",
      "sreSnowLabels",
      "sreQueryTemplates",
    ],
    (data) => {
      // Panel state
      srePanelState = data.srePanelState || {
        megaCollapsed: {},
        cardCollapsed: {},
      };
      // ServiceNow label cache (loaded so renders never hit ServiceNow again;
      // only the Labels Refresh button re-fetches).
      snowLabelCache = normalizeLabelCache(data.sreSnowLabels);
      cb({
        playbooks: Array.isArray(data.srePlaybooks) ? data.srePlaybooks : [],
        forms: Array.isArray(data.sreForms) ? data.sreForms : [],
        commonYaml:
          data.sreCommonSteps && typeof data.sreCommonSteps.yaml === "string"
            ? data.sreCommonSteps.yaml
            : "",
        servicesYaml:
          data.sreServices && typeof data.sreServices.yaml === "string"
            ? data.sreServices.yaml
            : "",
        chatRules: Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [],
        ringtones: Array.isArray(data.sreRingtones) ? data.sreRingtones : [],
        chatMonitor: data.sreChatMonitor || { monitorEnabled: false, perRule: {}, todayRings: 0, todayDate: "" },
        queryTemplates: (Array.isArray(data.sreQueryTemplates)
          ? data.sreQueryTemplates
          : []
        ).filter((t) => t && typeof t === "object"),
      });
    }
  );
}

function persistState() {
  chrome.storage.local.set({ srePanelState: srePanelState });
}

/* ---------- Toast ---------- */
//
// A lightweight global toast notification component.
//   toast.info(title, body)   — blue (default)
//   toast.success(title, body)— green
//   toast.error(title, body)  — red
// `body` is optional; when provided it renders in a monospace block (useful
// for JSON / debug output). Toasts auto-dismiss after `duration` ms (default
// 4000) and can be closed manually via the × button in the header.
// Multiple toasts stack vertically in the bottom-right corner.

const toast = (() => {
  let container = null;

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
    return container;
  }

  function show(type, title, body, duration) {
    const c = ensureContainer();
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;

    const head = document.createElement("div");
    head.className = "toast-head";

    const titleEl = document.createElement("span");
    titleEl.className = "toast-title";
    titleEl.textContent = title;
    head.appendChild(titleEl);

    // Manual close: lets the user dismiss a toast immediately instead of
    // waiting for the auto-dismiss countdown to finish.
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close notification");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", () => {
      clearTimeout(timer);
      dismiss(el);
    });
    head.appendChild(closeBtn);

    el.appendChild(head);

    if (body !== undefined && body !== null && String(body).length > 0) {
      const bodyEl = document.createElement("div");
      bodyEl.className = "toast-body";
      bodyEl.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
      el.appendChild(bodyEl);
    }

    c.appendChild(el);

    const ms = duration || 4000;
    // Hover-pause: when the mouse enters, cancel the auto-dismiss timer so the
    // user can read the content; on mouseleave restart the countdown.
    let timer = setTimeout(() => dismiss(el), ms);
    el.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      timer = null;
    });
    el.addEventListener("mouseleave", () => {
      if (timer === null) {
        timer = setTimeout(() => dismiss(el), ms);
      }
    });
    return el;
  }

  function dismiss(el) {
    if (!el || !el.parentNode) return;
    el.classList.add("toast-out");
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }

  return {
    info: (t, b, d) => show("info", t, b, d),
    success: (t, b, d) => show("success", t, b, d),
    error: (t, b, d) => show("error", t, b, d),
    dismiss,
  };
})();

/* ---------- Helpers ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function escapeAttr(s) {
  return String(s).replace(/["'&<>]/g, (c) =>
    ({ '"': "&quot;", "'": "&#39;", "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])
  );
}

// Minimal CSS.escape polyfill for older Chrome / edge cases.
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}
