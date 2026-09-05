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

// ServiceNow incident context — mirrors the best snapshot chosen by
// background.js (active ServiceNow tab, else most recent). Populated on load
// and kept fresh by the "snow_ctx" broadcasts below.
let snowCtx = null;

// goble.com order-page context — same shape as snowCtx but captured from the
// goble.com page the user is looking at (see goble-content.js). Populated on
// load and kept fresh by the "goble_ctx" broadcasts below.
let gobleCtx = null;

// Global context variables that are satisfied automatically instead of being
// prompted as user inputs. They resolve from the page snapshots above and can
// be referenced from any YAML document (playbooks, common steps, services):
//   ${number} / ${userToken} / ${incidentId} / ${instance}   ← ServiceNow page
//   ${f_wo_number} / ${f_sid} / ${f_access_token}            ← goble.com page
const SN_CTX_VARS = new Set(["number", "userToken", "incidentId", "instance"]);
const GOB_CTX_VARS = new Set(["f_wo_number", "f_sid", "f_access_token"]);
const CTX_VARS = new Set([...SN_CTX_VARS, ...GOB_CTX_VARS]);

// Map only the context fields that are actually present. Omitting an empty
// field leaves its ${placeholder} unresolved, so callers can surface a clear
// "open a page first" error instead of silently sending an empty string.
function snowVars() {
  const c = snowCtx || {};
  const out = {};
  if (c.sysid) out.incidentId = String(c.sysid);
  if (c.token) out.userToken = String(c.token);
  if (c.number) out.number = String(c.number);
  if (c.instance) out.instance = String(c.instance);
  return out;
}

function gobleVars() {
  const g = gobleCtx || {};
  const out = {};
  if (g.fwo) out.f_wo_number = String(g.fwo);
  if (g.fsid) out.f_sid = String(g.fsid);
  if (g.factok) out.f_access_token = String(g.factok);
  return out;
}

/* ---------- Base Info panel ---------- */
//
// Non-collapsible summary of the context the user is currently looking at:
// the ServiceNow incident snapshot plus the goble.com order-page snapshot,
// both mirroring the context broker's best choice (active tab, else the most
// recently touched one). Rows let users read / copy values before executing a
// flow. The same snapshots feed the ${number} / ${userToken} / ${incidentId} /
// ${instance} (ServiceNow) and ${f_wo_number} / ${f_sid} / ${f_access_token}
// (goble.com) placeholders, and the ServiceNow one signs real PATCH requests.
//
// Labels are display-only text — renaming one never affects the underlying
// placeholder (`gvar`), which is what YAML authors actually reference.
// Two-letter acronyms like "ID" keep their caps in the display labels.

const BASE_INFO_FIELDS = [
  { key: "number", src: "snow", label: "Incident", gvar: "number" },
  { key: "token", src: "snow", label: "Service Token", gvar: "userToken" },
  { key: "sysid", src: "snow", label: "Form ID", gvar: "incidentId" },
  { key: "fwo", src: "goble", label: "Order Number", gvar: "f_wo_number" },
  { key: "fsid", src: "goble", label: "Service ID", gvar: "f_sid" },
  { key: "factok", src: "goble", label: "Access Token", gvar: "f_access_token" },
];

// Snapshot that backs one row: "snow" → snowCtx, "goble" → gobleCtx.
function baseCtxFor(src) {
  return src === "goble" ? gobleCtx : snowCtx;
}

// Long values (tokens / sys_ids / service ids) are truncated to keep each row
// on one tidy line; the full value is always what gets copied and shown in the
// title tooltip.
const BASE_INFO_MAX = {
  number: 40,
  token: 26,
  sysid: 40,
  fwo: 40,
  fsid: 40,
  factok: 26,
};
function baseDisplayValue(raw, key) {
  const s = raw ? String(raw) : "";
  const max = BASE_INFO_MAX[key] || 40;
  if (s.length <= max) return s;
  const mid = max - 1;
  const head = Math.ceil(mid / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - (mid - head));
}

let baseInfoRoot = null; // the currently mounted Base Info panel (rebuilds on re-render)

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

// Ask the background broker for the freshest ServiceNow incident snapshot and
// refresh the Base Info panel once it answers.
function refreshSnowContext() {
  try {
    chrome.runtime.sendMessage({ type: "snow_get_current" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ctx) {
        snowCtx = resp.ctx;
        refreshBaseInfo();
      }
    });
  } catch (_) {}
}

// Same, for the goble.com order-page snapshot.
function refreshGobleContext() {
  try {
    chrome.runtime.sendMessage({ type: "goble_get_current" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ctx) {
        gobleCtx = resp.ctx;
        refreshBaseInfo();
      }
    });
  } catch (_) {}
}

// Manual refresh (Base Info refresh button): ask background to force the live
// ServiceNow and goble.com tabs to re-probe instead of returning possibly
// stale snapshots. Both probes run in parallel; the button spins until both
// settle, and a single toast fires only when neither source captured anything.
function baseManualRefresh(btn) {
  btn.classList.add("busy");
  let pending = 2;
  let foundAny = false;
  const settle = () => {
    pending -= 1;
    if (pending > 0) return;
    btn.classList.remove("busy");
    if (!foundAny) {
      toast.error(
        "Refresh",
        "Nothing captured. Open a ServiceNow incident or a globe.com.ph order page and try again."
      );
    }
  };
  try {
    chrome.runtime.sendMessage({ type: "snow_refresh" }, (resp) => {
      const ctx = !chrome.runtime.lastError && resp && resp.ctx ? resp.ctx : null;
      if (ctx) {
        snowCtx = ctx;
        refreshBaseInfo();
        if (ctx.token || ctx.sysid || ctx.number) foundAny = true;
      }
      settle();
    });
  } catch (_) {
    settle();
  }
  try {
    chrome.runtime.sendMessage({ type: "goble_refresh" }, (resp) => {
      const ctx = !chrome.runtime.lastError && resp && resp.ctx ? resp.ctx : null;
      if (ctx) {
        gobleCtx = ctx;
        refreshBaseInfo();
        if (ctx.fwo || ctx.fsid || ctx.factok) foundAny = true;
      }
      settle();
    });
  } catch (_) {
    settle();
  }
}

// Broadcasts from background.js keep both snapshots current while the user
// switches between ServiceNow / goble.com tabs or records.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "snow_ctx") {
    snowCtx = msg.ctx || null;
    refreshBaseInfo();
  } else if (msg.type === "goble_ctx") {
    gobleCtx = msg.ctx || null;
    refreshBaseInfo();
  }
});

function renderBaseInfoPanel() {
  const root = document.createElement("div");
  root.className = "snow-info";
  baseInfoRoot = root;

  const head = document.createElement("div");
  head.className = "snow-info-head";
  const icon = document.createElement("span");
  icon.className = "snow-info-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  const title = document.createElement("span");
  title.className = "snow-info-title";
  title.textContent = "Base Info";

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "snow-refresh-btn";
  refresh.title = "Refresh captured context";
  refresh.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
  refresh.addEventListener("click", () => baseManualRefresh(refresh));

  head.appendChild(icon);
  head.appendChild(title);
  head.appendChild(refresh);
  root.appendChild(head);

  const hint = document.createElement("div");
  hint.className = "snow-info-hint";
  hint.textContent =
    "Open a ServiceNow incident or a globe.com.ph order page — values capture automatically.";
  root.appendChild(hint);

  const rows = document.createElement("div");
  rows.className = "snow-info-rows";
  BASE_INFO_FIELDS.forEach((f) => {
    const row = document.createElement("div");
    row.className = "snow-info-row";
    row.dataset.field = f.key;

    const label = document.createElement("span");
    label.className = "snow-info-label";
    const labelText = document.createElement("span");
    labelText.className = "snow-info-label-text";
    labelText.textContent = f.label;
    // Referenceable global variable, shown under the label so authors know
    // ${gvar} can be used from any playbook / common step / service YAML.
    const labelVar = document.createElement("span");
    labelVar.className = "snow-info-label-var";
    labelVar.textContent = "${" + f.gvar + "}";
    label.appendChild(labelText);
    label.appendChild(labelVar);

    const value = document.createElement("span");
    value.className = "snow-info-value";
    value.textContent = "—";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "snow-copy-btn";
    copy.title = "Copy " + f.label;
    copy.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    copy.addEventListener("click", () => {
      const ctx = baseCtxFor(f.src) || {};
      const val = ctx[f.key];
      if (!val) return;
      copyToClipboard(String(val)).then((ok) => {
        if (!ok) {
          toast.error("Copy failed", "Could not copy " + f.label + " to the clipboard.");
          return;
        }
        copy.classList.add("copied");
        const prev = copy.innerHTML;
        copy.innerHTML = "✓";
        setTimeout(() => {
          copy.innerHTML = prev;
          copy.classList.remove("copied");
        }, 1200);
      });
    });
    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(copy);
    rows.appendChild(row);
  });
  root.appendChild(rows);
  return root;
}

// The Labels card — its own card, separate from Base Info, so refreshing the
// captured context never re-fetches the label list and vice versa. This card's
// refresh button re-fetches the picker candidates only (see tagsRefreshLabels).
function renderBaseTagsPanel() {
  const card = document.createElement("div");
  card.className = "snow-info snow-info-tags";

  const head = document.createElement("div");
  head.className = "snow-info-head";
  const icon = document.createElement("span");
  icon.className = "snow-info-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';
  const title = document.createElement("span");
  title.className = "snow-info-title";
  title.textContent = "Labels";

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "snow-refresh-btn";
  refresh.title = "Refresh label list";
  refresh.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
  refresh.addEventListener("click", () => tagsRefreshLabels(refresh));

  head.appendChild(icon);
  head.appendChild(title);
  head.appendChild(refresh);
  card.appendChild(head);
  card.appendChild(buildSnowTagSection());
  return card;
}

// Update the mounted Base Info panel's values from both snapshots without
// rebuilding the whole panel (so the rest of the UI is left untouched).
function refreshBaseInfo() {
  if (!baseInfoRoot || !baseInfoRoot.isConnected) return;
  const rowEls = baseInfoRoot.querySelectorAll(".snow-info-row");
  BASE_INFO_FIELDS.forEach((f, i) => {
    const row = rowEls[i];
    if (!row) return;
    const raw = (baseCtxFor(f.src) || {})[f.key];
    const text = raw ? String(raw) : "";
    const valueEl = row.querySelector(".snow-info-value");
    const copyEl = row.querySelector(".snow-copy-btn");
    if (valueEl) {
      valueEl.textContent = text ? baseDisplayValue(text, f.key) : "—";
      valueEl.classList.toggle("empty", !text);
      valueEl.title = text; // full value on hover
    }
    if (copyEl) copyEl.classList.toggle("disabled", !text);
  });
  const hint = baseInfoRoot.querySelector(".snow-info-hint");
  const hasAny = BASE_INFO_FIELDS.some((f) => (baseCtxFor(f.src) || {})[f.key]);
  if (hint) hint.classList.toggle("hidden", hasAny);
  snowTagCtxTick();
}

/* ---------- ServiceNow Labels (tag) picker ---------- */
//
// Rendered in its own "Labels" card directly below the Base Info card.
// Two moving parts:
//   * input/dropdown — auto-suggest / filter over the cached label list of the
//                current instance; picked labels become chips (multi-select).
//   * Add      — batch-attach every picked label to the current incident by
//                asking the active ServiceNow tab's content script to simulate
//                typing each name into the page's tag-it control.
// The label list is cached under chrome.storage.local key sreSnowLabels after
// a fetch; that fetch is driven by the Labels card's refresh button (the only
// path that re-hits ServiceNow).

const SN_LABEL_GROUP = "bcd9d8ac47243a1831c140d4116d43e5"; // fixed group filter from the original script
const SN_LABELS_KEY = "sreSnowLabels";

let snowLabelCache = null; // { at, instance, labels: [{ name, sys_id }] }
let snowTagRoot = null; // mounted .snow-tags section (rebuilt on render)
let snowTagApi = null; // refreshUi() hook of the currently mounted tag section
const snowTagSelected = new Map(); // label sys_id -> name, queued for the next Add

function normalizeLabelCache(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  if (!src) return null;
  const arr = Array.isArray(src.labels)
    ? src.labels
    : Array.isArray(src)
    ? src
    : [];
  const labels = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const name = it.name != null ? String(it.name).trim() : "";
    const sid = it.sys_id || it.sysid || "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    labels.push({ name, sys_id: String(sid) });
  }
  labels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { at: src.at || Date.now(), instance: src.instance || "", labels };
}

// Candidates shown in the dropdown: cached labels of the CURRENT instance only,
// so a switch to another instance simply yields an empty list until Refresh.
function snowCandidates() {
  const inst = (snowCtx && snowCtx.instance) || "";
  if (!inst || !snowLabelCache || snowLabelCache.instance !== inst) return [];
  return snowLabelCache.labels || [];
}

// Persist a freshly fetched label list both in memory and in chrome.storage.local
// (the cache that future side-panel renders read without hitting ServiceNow).
function snowSaveCache(labels) {
  const cache = {
    at: Date.now(),
    instance: (snowCtx && snowCtx.instance) || "",
    labels: labels || [],
  };
  snowLabelCache = normalizeLabelCache(cache);
  try {
    chrome.storage.local.set({ [SN_LABELS_KEY]: cache });
  } catch (_) {}
}

// Fetch every label of the fixed group from the current instance, paging 200
// records at a time (same pagination as the original manual script). Uses the
// captured UserToken + the browser's ServiceNow cookies, like the Info panel
// PATCHes do.
async function snowFetchLabels() {
  const c = snowCtx || {};
  if (!c.instance) {
    throw new Error("No ServiceNow instance captured. Open an incident page first.");
  }
  if (!c.token) {
    throw new Error("No UserToken captured. Open / refresh the incident page so the token is captured.");
  }
  const base = "https://" + c.instance + "/api/now/table/label";
  const headers = {
    Accept: "application/json",
    "X-UserToken": String(c.token),
  };
  const query = "group_listLIKE" + SN_LABEL_GROUP;
  const seen = new Set();
  const out = [];
  const PAGE = 200;
  for (let firstRow = 0, page = 0; page < 25; page++) {
    const qs = new URLSearchParams({
      sysparm_query: query,
      sysparm_limit: String(PAGE),
      sysparm_first_row: String(firstRow),
      sysparm_fields: "name,sys_id",
      sysparm_suppress_pagination_header: "true",
    });
    let resp;
    try {
      resp = await fetch(base + "?" + qs.toString(), {
        method: "GET",
        credentials: "include",
        headers,
      });
    } catch (e) {
      throw new Error("Network error while fetching labels: " + ((e && e.message) || e));
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error && j.error.message) msg += " — " + j.error.message;
      } catch (_) {}
      throw new Error("Label fetch failed (" + msg + ").");
    }
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {}
    const arr = data && Array.isArray(data.result) ? data.result : [];
    for (const r of arr) {
      if (!r) continue;
      const name = r.name != null ? String(r.name).trim() : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, sys_id: r.sys_id || r.sysid || "" });
    }
    if (arr.length < PAGE) break;
    firstRow += PAGE;
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

// Re-fetch the label list for the captured instance and repaint the picker.
// Owned by the Labels card's refresh button (the picker no longer rides on the
// Base Info refresh). Resolves true when labels were refreshed, false when no
// instance/token is captured. Errors are toasted here.
function refreshSnowLabelCache() {
  if (!(snowCtx && snowCtx.instance && snowCtx.token)) return Promise.resolve(false);
  return snowFetchLabels()
    .then((labels) => {
      snowSaveCache(labels);
      if (snowTagApi) snowTagApi.refreshUi();
      return true;
    })
    .catch((err) => {
      toast.error("Labels", String((err && err.message) || "Label refresh failed."));
      return false;
    });
}

// Manual refresh of the Labels card: re-fetch the picker candidates only —
// never touches the captured context or the Base Info rows.
function tagsRefreshLabels(btn) {
  if (!(snowCtx && snowCtx.instance && snowCtx.token)) {
    toast.error("Labels", "Open a ServiceNow incident page first so the token is captured.");
    return;
  }
  btn.classList.add("busy");
  refreshSnowLabelCache().finally(() => btn.classList.remove("busy"));
}

// Toggle Add / Refresh availability from the current incident context. Called
// on every snow_ctx change and whenever the section repaints.
function snowTagCtxTick() {
  if (!snowTagRoot || !snowTagRoot.isConnected) return;
  const okCtx = !!(snowCtx && snowCtx.instance && snowCtx.token);
  const add = snowTagRoot.querySelector(".snow-tags-add");
  if (add && !snowTagRoot.classList.contains("busy")) {
    add.disabled = !okCtx || snowTagSelected.size === 0;
  }
}

function buildSnowTagSection() {
  const root = document.createElement("div");
  root.className = "snow-tags";
  snowTagRoot = root;

  // --- Row: combo input + Add ---
  const row = document.createElement("div");
  row.className = "snow-tags-row";

  const combo = document.createElement("div");
  combo.className = "snow-tags-combo";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "snow-tags-input";
  input.placeholder = "Type to filter labels…";
  input.autocomplete = "off";
  input.spellcheck = false;
  const drop = document.createElement("div");
  drop.className = "snow-tags-drop";
  combo.appendChild(input);
  combo.appendChild(drop);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "snow-tags-btn snow-tags-add";
  addBtn.textContent = "Add";
  addBtn.title = "Attach the selected labels to the current incident";

  row.appendChild(combo);
  row.appendChild(addBtn);
  root.appendChild(row);

  const chips = document.createElement("div");
  chips.className = "snow-tags-chips";
  root.appendChild(chips);

  // --- Repaint helpers (touch only the label subtree, never the whole page) ---
  const hideDrop = () => drop.classList.remove("open");
  // True while we programmatically refocus the input right after a pick, so the
  // focus handler skips reopening the dropdown. The next real focus (clicking
  // the field again, typing) reopens it as usual.
  let suppressFocusDrop = false;

  const filterCandidates = () => {
    const filter = input.value.trim().toLowerCase();
    return snowCandidates().filter((l) => {
      if (snowTagSelected.has(l.sys_id || l.name)) return false;
      return !filter || l.name.toLowerCase().indexOf(filter) !== -1;
    });
  };

  const selectLabel = (l) => {
    const key = l.sys_id || l.name;
    if (snowTagSelected.has(key)) return;
    snowTagSelected.set(key, l.name);
    input.value = "";
    // Most incidents need only one label (rarely two), so close the dropdown
    // right after a pick instead of leaving it open over the chips. Focus stays
    // on the input: typing again immediately shows the filtered candidates.
    repaintNoDrop();
    if (document.activeElement !== input) {
      suppressFocusDrop = true;
      input.focus();
    }
  };

  const repaintChips = () => {
    chips.innerHTML = "";
    if (snowTagSelected.size === 0) {
      chips.style.display = "none";
      return;
    }
    chips.style.display = "flex";
    Array.from(snowTagSelected.entries()).forEach(([sid, name]) => {
      const chip = document.createElement("span");
      chip.className = "snow-tag-chip";
      const txt = document.createElement("span");
      txt.textContent = name;
      txt.title = name;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "snow-tag-x";
      x.textContent = "×";
      x.title = "Remove " + name;
      // Keep focus on the search input while pressing the remove button: this
      // prevents the blur → dropdown flash and lets the user delete several
      // chips in a row without re-focusing.
      x.addEventListener("mousedown", (e) => e.preventDefault());
      x.addEventListener("click", () => {
        snowTagSelected.delete(sid);
        repaintNoDrop();
      });
      chip.appendChild(txt);
      chip.appendChild(x);
      chips.appendChild(chip);
    });
  };

  const repaintDrop = () => {
    const cands = filterCandidates();
    drop.innerHTML = "";
    if (cands.length === 0) {
      hideDrop();
      return;
    }
    cands.slice(0, 30).forEach((l) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "snow-tag-opt";
      item.textContent = l.name;
      item.title = l.sys_id || l.name;
      item.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus
      item.addEventListener("click", (e) => {
        e.preventDefault();
        selectLabel(l);
      });
      drop.appendChild(item);
    });
    // Never auto-open the dropdown: show it only while the user is actively
    // picking (the input is focused or has text) or it is already visible.
    // Passive repaints — initial render, Info refresh, ctx broadcasts — must
    // not pop the list open over the panels below.
    const wantsOpen =
      document.activeElement === input ||
      input.value.trim().length > 0 ||
      drop.classList.contains("open");
    drop.classList.toggle("open", wantsOpen);
  };

  const repaintAll = () => {
    repaintChips();
    snowTagCtxTick();
  };

  // Quiet repaint used after picking/removing a chip or finishing an Add:
  // refresh chips & the Add button but keep the dropdown closed.
  const repaintNoDrop = () => {
    hideDrop();
    repaintChips();
    snowTagCtxTick();
  };

  const setBusy = (busy) => {
    root.classList.toggle("busy", busy);
    addBtn.disabled = busy || !(snowCtx && snowCtx.instance) || snowTagSelected.size === 0;
  };

  // Exposed to the Labels card refresh button so it can repaint the picker
  // after a label cache refresh. repaintDrop is gated, so this never pops the
  // dropdown open on its own.
  snowTagApi = {
    refreshUi: () => {
      repaintChips();
      repaintDrop();
      snowTagCtxTick();
    },
  };

  // --- Input / dropdown events ---
  input.addEventListener("input", repaintDrop);
  input.addEventListener("focus", () => {
    if (suppressFocusDrop) {
      suppressFocusDrop = false;
      return;
    }
    repaintDrop();
  });
  input.addEventListener("blur", () => setTimeout(hideDrop, 160));
  // Clicking the already-focused field reopens the list (e.g. to add a second
  // label after a pick closed it).
  input.addEventListener("click", () => {
    if (!drop.classList.contains("open")) repaintDrop();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.keyCode === 13) {
      e.preventDefault();
      // Only confirm the top candidate while the dropdown is visible, so Enter
      // never blindly attaches an invisible label after a pick closed it.
      if (!drop.classList.contains("open")) return;
      const top = filterCandidates()[0];
      if (top) selectLabel(top);
    } else if ((e.key === "Backspace" || e.keyCode === 8) && !input.value) {
      const keys = Array.from(snowTagSelected.keys());
      const last = keys[keys.length - 1];
      if (last !== undefined) {
        snowTagSelected.delete(last);
        repaintNoDrop(); // keep the dropdown closed while deleting
      }
    } else if (e.key === "Escape" || e.keyCode === 27) {
      hideDrop();
      input.blur();
    }
  });

  // --- Add: batch-attach every picked label via the page's tag-it widget ---
  addBtn.addEventListener("click", () => {
    const c = snowCtx || {};
    if (!c.instance) {
      toast.error("Add labels", "Open a ServiceNow incident page first, then add labels.");
      return;
    }
    const names = Array.from(snowTagSelected.values());
    if (names.length === 0) {
      toast.info("Add labels", "Pick one or more labels first.");
      return;
    }
    setBusy(true);
    addBtn.textContent = "Adding…";
    const settle = () => {
      addBtn.textContent = "Add";
      setBusy(false);
    };
    try {
      chrome.runtime.sendMessage({ type: "snow_add_tags", names }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          settle();
          toast.error(
            "Add labels",
            "Could not reach the ServiceNow tab. Reload the incident page and try again."
          );
          return;
        }
        if (!resp.ok) {
          settle();
          toast.error("Add labels failed", String(resp.error || "Unknown error."));
          return;
        }
        const r = (resp && resp.result) || {};
        if (r && r.error) {
          settle();
          toast.error("Add labels failed", String(r.error));
          return;
        }
        const added = r && Array.isArray(r.added) ? r.added.length : names.length;
        settle();
        toast.success("Labels added", "Added " + added + " label(s) to the current incident.");
        snowTagSelected.clear();
        repaintNoDrop(); // close the dropdown after a completed Add
      });
    } catch (e) {
      settle();
      toast.error("Add labels", String((e && e.message) || e));
    }
  });

  repaintAll();
  return root;
}

openOptionsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

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
      });
    }
  );
}

function persistState() {
  chrome.storage.local.set({ srePanelState: srePanelState });
}

/* ---------- Rendering ---------- */

function updateMonitorDot(rules) {
  const dot = document.getElementById("monitorDot");
  if (!dot) return;
  const anyEnabled = (rules || []).some((r) => r.enabled);
  dot.classList.toggle("off", !anyEnabled);
  dot.title = anyEnabled
    ? "Chat monitor on"
    : "Chat monitor off — enable a rule in options → Notification";
}

function render(data) {
  const playbooks = data.playbooks || [];
  const forms = data.forms || [];
  const servicesYaml = data.servicesYaml || "";
  const services = Y.parseServicesDoc(servicesYaml).services || [];
  const chatRules = data.chatRules || [];

  // 1) Header monitor signal — always present, left of the settings button.
  updateMonitorDot(chatRules);

  // 2) Base Info pinned strip — full sidebar width right under the header.
  //    It never scrolls; only .content below it scrolls.
  const stripEl = document.getElementById("baseStrip");
  stripEl.innerHTML = "";
  stripEl.appendChild(renderBaseInfoPanel());
  refreshBaseInfo(); // render current snapshots once the strip is mounted

  contentEl.innerHTML = "";

  if (playbooks.length === 0 && services.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "No ServiceNow flows or services configured.<br>Open options to create one.";
    contentEl.appendChild(empty);
    return;
  }

  // 3) Labels card — stays in the scrollable area, above the panels below.
  contentEl.appendChild(renderBaseTagsPanel());

  if (playbooks.length > 0) {
    // Shared Common Steps document (params + step map).
    const common = Y.parseCommonSteps(data.commonYaml || "");

    // --- Mega panel ---
    const mega = document.createElement("div");
    mega.className = "mega-panel";
    // Persisted collapsed state (default: expanded).
    const megaCollapsed = srePanelState.megaCollapsed.all === true;
    if (megaCollapsed) mega.classList.add("collapsed");

    const megaHeader = document.createElement("div");
    megaHeader.className = "mega-header";
    megaHeader.innerHTML = `
      <span class="mega-toggle">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
      </span>
      <span class="mega-title">ServiceNow</span>
      <span class="mega-count">${playbooks.length}</span>
    `;
    megaHeader.addEventListener("click", () => {
      mega.classList.toggle("collapsed");
      srePanelState.megaCollapsed.all = mega.classList.contains("collapsed");
      persistState();
    });

    const megaBody = document.createElement("div");
    megaBody.className = "mega-body";

    playbooks.forEach((pb) => {
      megaBody.appendChild(renderPlaybookCard(pb, common, forms));
    });

    mega.appendChild(megaHeader);
    mega.appendChild(megaBody);
    contentEl.appendChild(mega);
    snowTagCtxTick();
  }

  // 4) Services mega panel (runs below Playbooks).
  if (services.length > 0) {
    contentEl.appendChild(renderServicesPanel(services));
  }
}

function renderPlaybookCard(pb, common, forms) {
  const yaml = pb.yaml || "";
  const header = Y.parseHeader(yaml);
  const pbParams = Y.parseParams(yaml);
  const flow = Y.parseFlow(yaml);
  const commonParams = (common && common.params) || [];

  const card = document.createElement("div");
  card.className = "pb-card";
  const cardCollapsed = srePanelState.cardCollapsed[pb.id] === true;
  if (cardCollapsed) card.classList.add("collapsed");

  // --- Card header ---
  const cardHeader = document.createElement("div");
  cardHeader.className = "pb-card-header";
  cardHeader.innerHTML = `
    <span class="pb-card-toggle">
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </span>
    <div class="pb-card-meta">
      <div class="pb-card-name"></div>
      <div class="pb-card-desc"></div>
    </div>
  `;
  cardHeader.querySelector(".pb-card-name").textContent =
    header.name || "(unnamed)";
  cardHeader.querySelector(".pb-card-desc").textContent = header.desc || "";
  cardHeader.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    srePanelState.cardCollapsed[pb.id] = card.classList.contains("collapsed");
    persistState();
  });

  // --- Card body ---
  const cardBody = document.createElement("div");
  cardBody.className = "pb-card-body";

  // Unified Parameters section: playbook-level params + (when the flow refs
  // any common step) the shared Common Steps params. Every input is tagged
  // with a source badge. Scope: common forms resolve with common params;
  // playbook forms resolve with playbook params — "common uses common, each
  // keeps its own".
  const hasRef = flow.some((st) => st.ref);
  const paramRows = [];
  if (hasRef) {
    commonParams.forEach((p, pIdx) => {
      paramRows.push({
        badge: "common",
        key: `common-param${pIdx}`,
        p,
      });
    });
  }
  pbParams.forEach((p, idx) => {
    paramRows.push({ badge: "playbook", key: `param${idx}`, p });
  });

  if (paramRows.length > 0) {
    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = "Parameters";
    cardBody.appendChild(sectionLabel);

    paramRows.forEach((r) => {
      cardBody.appendChild(renderParamRow(r, forms, pb.id));
    });
  }

  // Steps list
  if (flow.length > 0) {
    const stepsLabel = document.createElement("div");
    stepsLabel.className = "section-label";
    stepsLabel.textContent = "Steps";
    cardBody.appendChild(stepsLabel);

    const stepsContainer = document.createElement("div");
    stepsContainer.className = "steps-container";
    flow.forEach((step, idx) => {
      stepsContainer.appendChild(renderStepItem(step, idx, common));
    });
    cardBody.appendChild(stepsContainer);
  }

  // Dry Run / Execute buttons — two side-by-side actions at the card bottom.
  //   Dry Run  (墨绿) — resolve + preview only; nothing is sent or executed.
  //   Execute (primary) — resolve and execute (send each step / merged set).
  const execRow = document.createElement("div");
  execRow.className = "execute-row";

  const dryBtn = document.createElement("button");
  dryBtn.className = "btn-execute btn-dryrun";
  dryBtn.textContent = "Dry Run";
  dryBtn.title = "仅预览：解析参数并展示每个 step 的载荷，不真正执行";
  dryBtn.addEventListener("click", () => {
    executePlaybook(card, pb, flow, pbParams, commonParams, common, { dryRun: true });
  });
  execRow.appendChild(dryBtn);

  const execBtn = document.createElement("button");
  execBtn.className = "btn-execute";
  execBtn.textContent = "Execute";
  execBtn.addEventListener("click", () => {
    executePlaybook(card, pb, flow, pbParams, commonParams, common, { dryRun: false });
  });
  execRow.appendChild(execBtn);

  cardBody.appendChild(execRow);

  card.appendChild(cardHeader);
  card.appendChild(cardBody);
  return card;
}

// A single parameter widget on a playbook card. The widget depends on type:
//   textarea -> multi-line <textarea>
//   option   -> radio group fed from the Form library (paramOptionRows): each
//               radio shows the row's `display` and carries its `value`; the
//               first choice is pre-selected. When the Form library has no
//               matching field, fall back to a free-text input (with a hint) so
//               a mis-configuration never blocks execution.
//   else     -> single-line <input>
// `r` = { p: <parsed param {name,type}>, key: "paramN"|"common-paramN", badge }.
function renderParamRow(r, forms, cardId) {
  const row = document.createElement("div");
  row.className = "param-row";
  const label = (r.p && r.p.name) || "";
  const pType = ((r.p && r.p.type) || "").toLowerCase();

  const header = document.createElement("label");
  header.innerHTML = `<span class="param-source">${escapeHtml(r.badge)}</span><span class="param-label-text"></span>`;
  header.querySelector(".param-label-text").textContent = label;
  row.appendChild(header);

  const appendText = (hint) => {
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.param = r.key;
    input.placeholder = label;
    row.appendChild(input);
    if (hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "param-option-missing";
      hintEl.textContent = hint;
      row.appendChild(hintEl);
    }
  };

  if (pType === "option") {
    const options = Y.paramOptionRows(r.p, forms || []);
    if (options.length === 0) {
      appendText(
        `No Form-library match for “${label}” — entered as free text instead.`
      );
      return row;
    }
    const group = document.createElement("div");
    group.className = "param-options";
    // Radios group by their `name` attribute; give every card+param a unique
    // name so picking a choice on one card never clears another card's group.
    const groupName = `pbparam-${cardId || "?"}-${r.key}`;
    options.forEach((o, i) => {
      const opt = document.createElement("label");
      opt.className = "param-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = groupName;
      radio.value = o.value;
      radio.dataset.param = r.key;
      if (i === 0) radio.checked = true; // default: first choice
      const text = document.createElement("span");
      text.className = "param-option-text";
      text.textContent = o.display;
      opt.appendChild(radio);
      opt.appendChild(text);
      group.appendChild(opt);
    });
    row.appendChild(group);
    return row;
  }

  if (pType === "textarea") {
    const area = document.createElement("textarea");
    area.rows = 3;
    area.dataset.param = r.key;
    area.placeholder = label;
    row.appendChild(area);
    return row;
  }

  appendText();
  return row;
}

function renderStepItem(step, idx, common) {
  const item = document.createElement("div");
  item.className = "step-item";

  const index = document.createElement("div");
  index.className = "step-index";
  index.textContent = String(idx + 1);

  const content = document.createElement("div");
  content.className = "step-content";

  // Does this step send by itself? Flow item's `action` wins; otherwise the
  // referenced common step's value.
  const commonStepAction =
    step.ref && common && common.steps && common.steps[step.ref]
      ? common.steps[step.ref].action
      : undefined;
  const actsAlone = !!Y.effectiveAction(step.action, commonStepAction);

  const nameRow = document.createElement("div");
  nameRow.className = "step-name-row";

  if (step.ref) {
    // Ref step: tag it, then show the flow item's name (falls back to the
    // common step key).
    const tag = document.createElement("span");
    tag.className = "step-ref-tag";
    tag.textContent = "ref";
    nameRow.appendChild(tag);
    const nameEl = document.createElement("span");
    nameEl.className = "step-name";
    nameEl.textContent = step.name || step.ref;
    nameRow.appendChild(nameEl);
    content.appendChild(nameRow);

    const commonStep = common && common.steps ? common.steps[step.ref] : null;
    if (!commonStep) {
      const warn = document.createElement("div");
      warn.className = "step-desc";
      warn.textContent = `(common step "${step.ref}" not found)`;
      content.appendChild(warn);
    }
  } else {
    // Inline step: name + desc.
    const nameEl = document.createElement("span");
    nameEl.className = "step-name";
    nameEl.textContent = step.name || "(unnamed step)";
    nameRow.appendChild(nameEl);
    content.appendChild(nameRow);
    if (step.desc) {
      const descEl = document.createElement("div");
      descEl.className = "step-desc";
      descEl.textContent = step.desc;
      content.appendChild(descEl);
    }
  }

  if (actsAlone) {
    const tag = document.createElement("span");
    tag.className = "step-ref-tag";
    tag.style.color = "var(--primary)";
    tag.style.background = "var(--primary-soft)";
    tag.textContent = "action";
    nameRow.appendChild(tag);
  }

  item.appendChild(index);
  item.appendChild(content);
  return item;
}

/* ---------- Services panel ---------- */
//
// The shared Services document renders below Playbooks as its own mega panel.
// Each top-level entry is a runnable card: either a plain API call or a
// `type: group` whose nested services run top to bottom.
//
// Variable rule (shared with the options editor):
//   * every reference is written ${name};
//   * a ${name} that equals an `output.alias` of an EARLIER service inside the
//     same group resolves from the chain automatically — it is NOT prompted;
//   * every other ${name} is rendered as a user input field on the card.
//
// "Execute" performs real fetch() calls in order; captured aliases flow
// forward into later steps of the same card.

function renderServicesPanel(services) {
  const panel = document.createElement("div");
  panel.className = "mega-panel";
  const collapsedKey = "services";
  if (srePanelState.megaCollapsed && srePanelState.megaCollapsed[collapsedKey]) {
    panel.classList.add("collapsed");
  }

  const head = document.createElement("div");
  head.className = "mega-header";
  head.innerHTML = `
    <span class="mega-toggle">
      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </span>
    <span class="mega-title">Services</span>
    <span class="mega-count">${services.length}</span>
  `;
  head.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    if (!srePanelState.megaCollapsed) srePanelState.megaCollapsed = {};
    srePanelState.megaCollapsed[collapsedKey] = panel.classList.contains("collapsed");
    persistState();
  });

  const body = document.createElement("div");
  body.className = "mega-body";
  services.forEach((item, idx) => body.appendChild(renderServiceCard(item, idx)));

  panel.appendChild(head);
  panel.appendChild(body);
  return panel;
}

function renderServiceCard(item, idx) {
  const isGroup = item.type === "group";
  const steps = isGroup ? item.services || [] : [item];
  // Manual inputs only: ${name}s that name a captured global (ServiceNow ctx
  // or globe.com.ph order page) resolve automatically at run time and must NOT
  // be prompted here — an empty input would shadow the captured value.
  const inputs = Y.collectServiceInputs(item).filter((inp) => !CTX_VARS.has(inp.var));

  const card = document.createElement("div");
  card.className = "pb-card svc-card";
  const cardKey = "svc-" + idx;
  if (srePanelState.cardCollapsed && srePanelState.cardCollapsed[cardKey]) {
    card.classList.add("collapsed");
  }

  const head = document.createElement("div");
  head.className = "pb-card-header";
  head.innerHTML = `
    <span class="pb-card-toggle">
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </span>
    <div class="pb-card-meta">
      <div class="pb-card-name"></div>
      <div class="pb-card-desc"></div>
    </div>
  `;
  const nameEl = head.querySelector(".pb-card-name");
  nameEl.textContent = item.name || "(unnamed)";
  const descEl = head.querySelector(".pb-card-desc");
  descEl.textContent = item.desc || (isGroup ? `${steps.length} call(s)` : "");
  if (!item.name) nameEl.style.fontStyle = "italic";

  const kindChip = document.createElement("span");
  kindChip.className = "step-ref-tag svc-kind";
  kindChip.textContent = isGroup ? "group" : steps[0] && steps[0].method || "api";
  kindChip.style.color = isGroup ? "#6f42c1" : "var(--muted)";
  kindChip.style.background = isGroup ? "#f3ecff" : "var(--bg)";
  head.appendChild(kindChip);

  head.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    if (!srePanelState.cardCollapsed) srePanelState.cardCollapsed = {};
    srePanelState.cardCollapsed[cardKey] = card.classList.contains("collapsed");
    persistState();
  });

  const body = document.createElement("div");
  body.className = "pb-card-body";

  // ---- Inputs (only vars not satisfied by an earlier alias in the group) ----
  if (inputs.length > 0) {
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Inputs";
    body.appendChild(label);

    inputs.forEach((inp) => {
      const row = document.createElement("div");
      row.className = "param-row";
      const field = document.createElement("input");
      field.type = "text";
      field.dataset.svcVar = inp.var;
      field.placeholder = inp.var;
      const l = document.createElement("label");
      const src = document.createElement("span");
      src.className = "param-source";
      src.textContent = "input";
      const txt = document.createElement("span");
      txt.className = "param-label-text";
      txt.textContent = inp.var;
      l.appendChild(src);
      l.appendChild(txt);
      row.appendChild(l);
      row.appendChild(field);
      if (inp.from) {
        const hint = document.createElement("div");
        hint.className = "hint svc-var-hint";
        hint.textContent = "first used by " + inp.from;
        row.appendChild(hint);
      }
      body.appendChild(row);
    });
  }

  // ---- Steps / requests ----
  const stepsLabel = document.createElement("div");
  stepsLabel.className = "section-label";
  stepsLabel.textContent = isGroup ? "Requests" : "Request";
  body.appendChild(stepsLabel);

  const stepsContainer = document.createElement("div");
  stepsContainer.className = "steps-container";
  steps.forEach((svc, i) => stepsContainer.appendChild(renderServiceStepRow(svc, i)));
  body.appendChild(stepsContainer);

  // ---- Dry Run / Run ----
  const execRow = document.createElement("div");
  execRow.className = "execute-row";
  const dryBtn = document.createElement("button");
  dryBtn.className = "btn-execute btn-dryrun";
  dryBtn.textContent = "Dry Run";
  dryBtn.addEventListener("click", () => {
    dryRunServiceCard(card, steps, inputs);
  });
  execRow.appendChild(dryBtn);
  const runBtn = document.createElement("button");
  runBtn.className = "btn-execute";
  runBtn.textContent = "Run";
  runBtn.addEventListener("click", () => {
    executeServiceCard(card, steps, inputs, runBtn);
  });
  execRow.appendChild(runBtn);
  body.appendChild(execRow);

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function renderServiceStepRow(svc, idx) {
  const row = document.createElement("div");
  row.className = "step-item svc-step";

  const index = document.createElement("div");
  index.className = "step-index";
  index.textContent = String(idx + 1);

  const content = document.createElement("div");
  content.className = "step-content";

  const nameRow = document.createElement("div");
  nameRow.className = "step-name-row";

  const method = document.createElement("span");
  method.className = "step-ref-tag svc-method m-" + String(svc.method || "GET").toLowerCase();
  method.textContent = svc.method || "GET";
  nameRow.appendChild(method);

  const nameEl = document.createElement("span");
  nameEl.className = "step-name";
  nameEl.textContent = svc.name || "(unnamed call)";
  nameRow.appendChild(nameEl);
  content.appendChild(nameRow);

  if (svc.desc) {
    const d = document.createElement("div");
    d.className = "step-desc";
    d.textContent = svc.desc;
    content.appendChild(d);
  }

  const endpoint = document.createElement("div");
  endpoint.className = "svc-endpoint";
  endpoint.textContent = svc.endpoint || "(no endpoint)";
  endpoint.title = svc.endpoint || "";
  content.appendChild(endpoint);

  if (svc.outputs && svc.outputs.length > 0) {
    const outRow = document.createElement("div");
    outRow.className = "svc-output-row";
    svc.outputs.forEach((o) => {
      const chip = document.createElement("span");
      chip.className = "svc-out-chip";
      chip.textContent = "out: " + o.alias;
      chip.title = "json_path " + o.path;
      outRow.appendChild(chip);
    });
    content.appendChild(outRow);
  }

  row.appendChild(index);
  row.appendChild(content);
  return row;
}

// Build the exact request that runServiceStep would send — method, URL, headers
// and body with every placeholder resolved — WITHOUT fetching. Shared by the
// real execution path and the Dry Run preview so what you preview is exactly
// what would be sent. Returns { method, url, headers, hasBody, bodyObj,
// bodyJson, isSnow, leftover }.
function prepareServiceStep(svc, values) {
  // Context placeholders from both snapshots resolve automatically: ServiceNow
  // (${incidentId}, ${userToken}, ${number}, ${instance}) and globe.com.ph
  // order page (${f_wo_number}, ${f_sid}, ${f_access_token}). Explicit service
  // inputs win over context on a name clash.
  const effective = Object.assign({}, snowVars(), gobleVars(), values || {});
  const url = Y.resolvePlaceholders(svc.endpoint, effective);
  const headers = {};
  const rawHeaders = Y.resolveTemplate(svc.header || {}, effective);
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (v !== null && v !== undefined) headers[k] = String(v);
  }
  const method = svc.method || "GET";
  const hasBody = method !== "GET" && svc.body !== null && svc.body !== undefined;
  let bodyObj = null;
  if (hasBody) {
    bodyObj = Y.resolveTemplate(svc.body, effective);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  const bodyJson = bodyObj === null ? null : JSON.stringify(bodyObj);

  // Universal ServiceNow layer: any request aimed at *.service-now.com is sent
  // with the browser's login cookies (credentials: include) and signed with
  // the CSRF token captured from the page (X-UserToken, window.g_ck).
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (_) {}
  const isSnow = /(^|\.)service-now\.com$/i.test(host);
  if (isSnow && !headers["X-UserToken"] && snowCtx && snowCtx.token) {
    headers["X-UserToken"] = String(snowCtx.token);
  }

  // Leftover ${name}s mean an input was left empty, a context page is not
  // open, or an alias from an earlier step has no value yet.
  const leftover = collectUnresolved([url, headers, hasBody ? bodyJson : null]);
  return { method, url, headers, hasBody, bodyObj, bodyJson, isSnow, leftover };
}

// Format a prepared request for the Dry Run toast.
function describePreparedRequest(req, aliasOwner) {
  const lines = [];
  lines.push(`${req.method} ${req.url || "(no endpoint)"}`);
  if (req.isSnow) {
    lines.push("Note: browser session cookies (credentials: include) will be sent to *.service-now.com");
  }
  lines.push("");
  lines.push("Headers:");
  const entries = Object.entries(req.headers);
  lines.push(entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("\n") : "(none)");
  lines.push("");
  lines.push("Body:");
  if (req.hasBody) lines.push(JSON.stringify(req.bodyObj, null, 2));
  else lines.push("(none)");

  // Placeholders that will be filled by an earlier step's captured output
  // cannot be previewed (nothing is fetched) — say so instead of implying the
  // request is broken.
  const owned = req.leftover.filter((n) => aliasOwner[n]);
  if (owned.length) {
    const nums = [...new Set(owned.map((n) => aliasOwner[n]))].sort().join(", ");
    lines.push("");
    lines.push(`Note: ${owned.map((n) => "${" + n + "}").join(", ")} will be filled from the response of step ${nums} at run time.`);
  }
  const missing = req.leftover.filter((n) => !aliasOwner[n]);
  if (missing.length) {
    lines.push("");
    lines.push("MISSING — " + describeMissingPlaceholders(missing, "in the service inputs"));
  }
  return lines.join("\n");
}

// Dry Run for a services card: resolve every step into the request that would
// be sent (endpoint, headers, body) and preview it as toasts — nothing is
// actually fetched. Steps that consume a previous step's output are flagged:
// the value only exists after a real Run.
function dryRunServiceCard(card, steps, inputs) {
  const values = {};
  inputs.forEach((inp) => {
    const el = card.querySelector(`[data-svc-var="${cssEscape(inp.var)}"]`);
    values[inp.var] = el ? el.value : "";
  });
  const aliasOwner = {};
  steps.forEach((svc, i) => {
    (svc.outputs || []).forEach((o) => {
      if (!(o.alias in aliasOwner)) aliasOwner[o.alias] = i + 1;
    });
  });
  toast.info("Dry run", `${steps.length} step(s) · nothing was sent`);
  steps.forEach((svc, i) => {
    const req = prepareServiceStep(svc, values);
    const name = svc.name || svc.endpoint || "(unnamed)";
    const title = `Dry run · Step ${i + 1}/${steps.length} · ${name}`;
    const text = describePreparedRequest(req, aliasOwner);
    const missing = req.leftover.filter((n) => !aliasOwner[n]);
    if (missing.length) toast.error(title, text);
    else toast.success(title, text);
  });
}

// Perform one HTTP call. Returns { failed, status?, error?, url?, out }.
async function runServiceStep(svc, values) {
  const req = prepareServiceStep(svc, values);
  if (req.leftover.length > 0) {
    return {
      failed: true,
      error: describeMissingPlaceholders(req.leftover, "in the service inputs"),
    };
  }

  const init = { method: req.method, headers: req.headers };
  if (req.isSnow) init.credentials = "include";
  if (req.hasBody) init.body = req.bodyJson;

  try {
    const resp = await fetch(req.url, init);
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    const out = {};
    (svc.outputs || []).forEach((o) => {
      const v = Y.queryPath(json, o.path);
      if (v !== undefined) out[o.alias] = v;
    });
    return { failed: !resp.ok, status: resp.status, ok: resp.ok, json, text, out, url: req.url };
  } catch (err) {
    return { failed: true, error: String((err && err.message) || err) };
  }
}

function collectUnresolved(values) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      Y.extractPlaceholderNames(v).forEach((n) => found.add(n));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  values.forEach(walk);
  return Array.from(found);
}

// Human-readable reason for ${…} names that survived resolution. Context
// placeholders are split by source so the hint tells the user which page to
// open (ServiceNow incident vs goble.com order page) instead of asking them to
// fill in a value that is meant to be captured automatically.
function describeMissingPlaceholders(names, inputsLabel) {
  const fmt = (arr) => arr.map((n) => "${" + n + "}").join(", ");
  const inputs = names.filter((n) => !CTX_VARS.has(n));
  const snow = names.filter((n) => SN_CTX_VARS.has(n));
  const goble = names.filter((n) => GOB_CTX_VARS.has(n));
  const msgs = [];
  if (inputs.length) msgs.push("fill in " + fmt(inputs) + " " + inputsLabel);
  if (snow.length)
    msgs.push("open an incident in ServiceNow so " + fmt(snow) + " can be captured");
  if (goble.length)
    msgs.push("open an order page on globe.com.ph so " + fmt(goble) + " can be captured");
  return "missing value(s): " + msgs.join("; ");
}

async function executeServiceCard(card, steps, inputs, runBtn) {
  const values = {};
  inputs.forEach((inp) => {
    const el = card.querySelector(`[data-svc-var="${cssEscape(inp.var)}"]`);
    values[inp.var] = el ? el.value : "";
  });

  const dryBtn = card.querySelector(".btn-dryrun");
  runBtn.disabled = true;
  runBtn.textContent = "Running…";
  if (dryBtn) dryBtn.disabled = true;
  const total = steps.length;
  try {
    for (let i = 0; i < total; i++) {
      const step = await runServiceStep(steps[i], values);
      const label = `Step ${i + 1}/${total} · ${steps[i].name || steps[i].endpoint || "(unnamed)"}`;
      if (step.failed) {
        toast.error(label, step.error || `HTTP ${step.status}`);
        return;
      }
      const full =
        step.json !== null && step.json !== undefined
          ? step.json
          : step.text && step.text.length > 0
          ? step.text
          : step.url;
      toast.success(`${label} · HTTP ${step.status}`, full || "ok");
      Object.assign(values, step.out);
    }
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run";
    if (dryBtn) dryBtn.disabled = false;
  }
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

/* ---------- Execute ---------- */

// Build the REST Table API endpoint for the incident currently in context.
// This round targets incidents only: PATCH /api/now/table/incident/<sys_id>.
function snowIncidentEndpoint() {
  const c = snowCtx || {};
  if (!c.instance || !c.sysid) return null;
  return "https://" + c.instance + "/api/now/table/incident/" + c.sysid;
}

// Sign a real PATCH against the current incident with the captured CSRF token
// and the browser's ServiceNow cookies (credentials: include). `url` is the
// endpoint captured at run start so a mid-run tab switch cannot retarget it.
async function snowPatchIncident(body, url) {
  const c = snowCtx || {};
  const target = url || snowIncidentEndpoint();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (c.token) headers["X-UserToken"] = String(c.token);
  try {
    const resp = await fetch(target, {
      method: "PATCH",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    return { ok: resp.ok, failed: !resp.ok, status: resp.status, json, text, url: target };
  } catch (err) {
    return { failed: true, error: String((err && err.message) || err) };
  }
}

// Keep result toasts readable (a successful PATCH echoes back the whole record).
function snowResultBody(r) {
  if (!r || r.failed) {
    return r && r.error
      ? r.error
      : r && r.text && r.text.length
      ? r.text
      : "Request failed.";
  }
  const txt = (r.text || "").trim();
  const display = txt.length ? txt : "HTTP " + r.status;
  return display.length > 600 ? display.slice(0, 600) + "\n…" : display;
}

// Read one parameter widget's value off a playbook card: for an option group
// the *checked* radio wins (the first choice is pre-selected at render time);
// text inputs / textareas report their raw value. Returns null when no widget
// exists for the key.
function readParamValue(card, key) {
  const sel = `[data-param="${cssEscape(key)}"]`;
  const checked = card.querySelector(sel + ":checked");
  if (checked) return checked.value;
  const field = card.querySelector(sel);
  return field ? field.value : null;
}

// Execute a flow against the current ServiceNow incident.
//   Dry Run  — resolve + preview payloads only, nothing is sent.
//   Execute  — action=true steps are PATCHed individually in flow order; the
//              remaining steps are merged into a single final PATCH. Every
//              request is signed with the captured UserToken and the browser's
//              ServiceNow cookies.
async function executePlaybook(card, pb, flow, pbParams, commonParams, common, opts) {
  const dryRun = Boolean(opts && opts.dryRun);
  const header = Y.parseHeader(pb.yaml || "");
  const title = header.name || "";
  if (flow.length === 0) {
    toast.info("No steps", "This playbook has no steps to execute.");
    return;
  }

  // Collect param values from the card widgets (text <input> / <textarea> /
  // option radio groups — every widget is tagged with data-param).
  const pbValues = {};
  pbParams.forEach((p, idx) => {
    const v = readParamValue(card, "param" + idx);
    if (v !== null) pbValues["param" + idx] = v;
  });
  const commonValues = {};
  commonParams.forEach((p, idx) => {
    const v = readParamValue(card, "common-param" + idx);
    if (v !== null) commonValues["param" + idx] = v;
  });

  // Page context satisfies both placeholder families automatically — ServiceNow
  // (${incidentId} / ${userToken} / ${number} / ${instance}) and goble.com
  // (${f_wo_number} / ${f_sid} / ${f_access_token}); explicit parameter values
  // keep their normal keys.
  const ctxVars = Object.assign({}, snowVars(), gobleVars());
  const pbResolve = Object.assign({}, ctxVars, pbValues);
  const commonResolve = Object.assign({}, ctxVars, commonValues);

  // Resolve every step into a payload (or an error) first, tagging each with
  // its effective `action` (flow item's own value wins; else the referenced
  // common step's value; else false). A payload still containing ${…} after
  // resolution is an error — it must never reach ServiceNow literally.
  const commonSteps = (common && common.steps) || {};
  // Practical shortcut: comments and work_notes are virtually always kept in
  // sync, so whenever a payload sends work_notes we mirror the same value into
  // comments automatically. Authors only define work_notes (and its
  // placeholder) once — no separate comments field/handling is needed.
  const mirrorComments = (form) => {
    if (form && typeof form.work_notes === "string" && form.work_notes.length > 0) {
      form.comments = form.work_notes;
    }
    return form;
  };
  const finishUnit = (idx, displayName, refName, formMap, actionVal) => {
    const leftover = collectUnresolved([formMap]);
    if (leftover.length > 0) {
      return {
        idx,
        name: displayName,
        error: describeMissingPlaceholders(leftover, "in the Parameters form"),
      };
    }
    mirrorComments(formMap);
    return { idx, name: displayName, ref: refName, form: formMap, action: actionVal };
  };

  const units = flow.map((step, idx) => {
    const displayName = step.name || step.ref || `step ${idx + 1}`;
    const resolve = (formMap, values) => {
      const resolved = {};
      for (const [k, v] of Object.entries(formMap)) {
        resolved[k] = Y.resolvePlaceholders(v, values);
      }
      return resolved;
    };
    if (step.ref) {
      const commonStep = commonSteps[step.ref];
      const hasOwn = step.form && Object.keys(step.form).length > 0;
      if (hasOwn) {
        // A ref item may carry its own form; its ${paramN} refer to the
        // playbook's params (the item lives in the playbook YAML).
        return finishUnit(
          idx,
          displayName,
          step.ref,
          resolve(step.form, pbResolve),
          Y.effectiveAction(step.action, commonStep && commonStep.action)
        );
      }
      if (commonStep) {
        // Reuse the referenced common step's form, resolved against the
        // common doc's own params.
        return finishUnit(
          idx,
          displayName,
          step.ref,
          resolve(commonStep.form || {}, commonResolve),
          Y.effectiveAction(step.action, commonStep.action)
        );
      }
      return { idx, name: displayName, error: `Common step "${step.ref}" not found` };
    }
    // Inline step.
    return finishUnit(
      idx,
      displayName,
      undefined,
      resolve(step.form || {}, pbResolve),
      Y.effectiveAction(step.action, undefined)
    );
  });

  const errors = units.filter((u) => u.error);
  const solo = units.filter((u) => !u.error && u.action === true);
  const merged = units.filter((u) => !u.error && u.action !== true);

  // Errors — surfaced immediately, individually.
  errors.forEach((u) => {
    toast.error(`Step ${u.idx + 1}/${flow.length} — ${u.name}`, u.error);
  });

  // ---- Dry run: preview only. ----
  if (dryRun) {
    toast.info(`Dry run: ${title}`, `${flow.length} step(s)`);
    solo.forEach((u) => {
      const label = u.ref ? `ref ${u.name}` : u.name;
      toast.info(`Dry run · Step ${u.idx + 1}/${flow.length} · ${label}`, JSON.stringify(u.form, null, 2));
    });
    if (merged.length > 0) {
      const combined = {};
      merged.forEach((u) => Object.assign(combined, u.form));
      mirrorComments(combined);
      const positions = merged.map((u) => u.idx + 1).join(", ");
      toast.info(`Dry run · Steps ${positions} merged → single PATCH`, JSON.stringify(combined, null, 2));
    }
    return;
  }

  // ---- Real run: PATCH the incident on ServiceNow. ----
  const execBtn = card.querySelector(".btn-execute");
  const dryBtn = card.querySelector(".btn-dryrun");
  const setBusy = (busy) => {
    if (execBtn) {
      execBtn.disabled = busy;
      execBtn.textContent = busy ? "Running…" : "Execute";
    }
    if (dryBtn) dryBtn.disabled = busy;
  };

  // Lock the target record once: a ServiceNow tab switch mid-run must not
  // retarget the remaining PATCHes to a different incident.
  const endpoint = snowIncidentEndpoint();
  if (!endpoint) {
    toast.error(
      `Execute: ${title}`,
      "No ServiceNow incident context. Open the incident in ServiceNow and make sure its tab is active so the instance and sys_id are captured, then try again."
    );
    return;
  }

  setBusy(true);
  toast.info(`Executing: ${title}`, `${flow.length} step(s)`);
  try {
    // 1) action=true steps — PATCHed individually, in flow order.
    for (const u of solo) {
      const label = u.ref ? `ref ${u.name}` : u.name;
      const t = `Step ${u.idx + 1}/${flow.length} · ${label}`;
      const r = await snowPatchIncident(u.form, endpoint);
      if (r.ok) toast.success(`${t} · HTTP ${r.status}`, snowResultBody(r));
      else toast.error(`${t} failed`, snowResultBody(r));
    }

    // 2) Remaining steps — merged into a single final PATCH.
    if (merged.length > 0) {
      const combined = {};
      merged.forEach((u) => Object.assign(combined, u.form));
      mirrorComments(combined);
      const positions = merged.map((u) => u.idx + 1).join(", ");
      const t = `Steps ${positions} merged`;
      const r = await snowPatchIncident(combined, endpoint);
      if (r.ok) toast.success(`${t} · HTTP ${r.status}`, snowResultBody(r));
      else toast.error(`${t} failed`, snowResultBody(r));
    }

    if (solo.length === 0 && merged.length === 0 && errors.length === 0) {
      toast.info(`Executing: ${title}`, "Nothing to send.");
    }
  } finally {
    setBusy(false);
  }
}

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

/* ---------- Init + live sync ---------- */

loadState((data) => {
  render(data);
  refreshSnowContext();
  refreshGobleContext();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.srePlaybooks ||
    changes.sreCommonSteps ||
    changes.sreForms ||
    changes.sreServices ||
    changes.srePanelState ||
    changes.sreChatSpaceRules ||
    changes.sreRingtones ||
    changes.sreChatMonitor
  ) {
    loadState((data) => render(data));
  }
});
