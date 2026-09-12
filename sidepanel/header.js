/* header.js — header environment-variable popover + snowCtx/gobleCtx management.
   Contains top-level init code (event bindings, popover build, runtime message
   listener), so it must load after shared.js. */

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
  if (c.callerName) out.caller_name = String(c.callerName);
  if (c.callerSysid) out.caller_sysid = String(c.callerSysid);
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

/* ---------- Header environment-variable popover ---------- */
//
// The rows mirror the background's LAST captured snapshot per source — the
// same "keep last" data the Options → Environment page reads. Switching to a
// non-source tab (chat, docs, another site…) therefore keeps the last values
// visible instead of wiping them; only a fresh capture on a ServiceNow / FSM
// page replaces them. This keeps the two surfaces consistent.
//
// Shows label + truncated value + copy button only (no ${gvar}); the Options
// Environment page carries the full reference list. Field definitions come
// from the shared env-defs.js so the two surfaces can never drift apart.

// Raw (untruncated) value for one field from its live snapshot.
function envRaw(f) {
  const ctx = f.src === "goble" ? gobleCtx : snowCtx;
  const raw = ctx && ctx[f.key];
  return raw != null ? String(raw) : "";
}

// Build the popover skeleton once. Row values are refreshed in place by
// refreshEnvValues below, so broadcasts never rebuild this DOM.
function buildEnvPopover() {
  envPopoverEl.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "ctx-popover-bar";
  const barTitle = document.createElement("span");
  barTitle.textContent = "Environment variables";
  bar.appendChild(barTitle);
  envPopoverEl.appendChild(bar);

  SRE_ENV.SRC_ORDER.forEach((src) => {
    const group = document.createElement("div");
    group.className = "ctx-group";
    const gTitle = document.createElement("div");
    gTitle.className = "ctx-group-title";
    gTitle.textContent = SRE_ENV.SRC_TITLES[src];
    group.appendChild(gTitle);
    SRE_ENV.bySrc(src).forEach((f) => {
      const row = document.createElement("div");
      row.className = "ctx-row";
      row.dataset.key = f.key;

      const label = document.createElement("span");
      label.className = "ctx-row-label";
      label.textContent = f.label;
      label.title = f.label;

      const value = document.createElement("span");
      value.className = "ctx-row-value empty";
      value.textContent = "—";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "snow-copy-btn disabled";
      copy.title = "Copy " + f.label;
      copy.innerHTML = SRE_ENV.COPY_SVG;
      copy.addEventListener("click", () => {
        const raw = envRaw(f);
        if (!raw) return;
        copyToClipboard(raw).then((ok) => {
          if (!ok) {
            toast.error(
              "Copy failed",
              "Could not copy " + f.label + " to the clipboard."
            );
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
      group.appendChild(row);
    });
    envPopoverEl.appendChild(group);
  });

  const empty = document.createElement("div");
  empty.className = "ctx-popover-empty";
  empty.textContent =
    "Open a ServiceNow incident or an FSM order page to capture values. The last captured values are kept until the next capture replaces them.";
  envPopoverEl.appendChild(empty);
}

// Refresh the mounted popover rows from the live snapshots (no-op while the
// popover is hidden). Returns nothing.
function refreshEnvValues() {
  if (!envPopoverEl || envPopoverEl.classList.contains("hidden")) return;
  let any = false;
  envPopoverEl.querySelectorAll(".ctx-row").forEach((row) => {
    const f = ENV_FIELDS_BY_KEY[row.dataset.key];
    if (!f) return;
    const raw = envRaw(f);
    if (raw) any = true;
    const valueEl = row.querySelector(".ctx-row-value");
    const copyEl = row.querySelector(".snow-copy-btn");
    if (valueEl) {
      valueEl.textContent = raw ? SRE_ENV.display(raw, f) : "—";
      valueEl.classList.toggle("empty", !raw);
      valueEl.title = raw;
    }
    if (copyEl) copyEl.classList.toggle("disabled", !raw);
  });
  const emptyEl = envPopoverEl.querySelector(".ctx-popover-empty");
  if (emptyEl) emptyEl.classList.toggle("hidden", any);
}

/* Popover open/close coordination. The info button and the popover are two
   separate elements with a small gap between them, so both mouseleave handlers
   schedule a delayed close that the other element's mouseenter cancels. */
let envOpenTimer = null;
let envCloseTimer = null;

function openEnvPopover() {
  clearTimeout(envCloseTimer);
  envCloseTimer = null;
  if (!envPopoverEl.classList.contains("hidden")) return;
  envPopoverEl.classList.remove("hidden");
  refreshEnvValues();
  // Re-pull the background's most recent snapshots right as it opens so values
  // render immediately instead of waiting for a broadcast.
  refreshSnowContext();
  refreshGobleContext();
}

function scheduleEnvOpen() {
  clearTimeout(envCloseTimer);
  envCloseTimer = null;
  if (envOpenTimer) return;
  envOpenTimer = setTimeout(() => {
    envOpenTimer = null;
    openEnvPopover();
  }, 120);
}

function closeEnvPopover() {
  clearTimeout(envOpenTimer);
  envOpenTimer = null;
  envPopoverEl.classList.add("hidden");
}

function scheduleEnvClose() {
  clearTimeout(envOpenTimer);
  envOpenTimer = null;
  if (envCloseTimer) return;
  envCloseTimer = setTimeout(() => {
    envCloseTimer = null;
    closeEnvPopover();
  }, 250);
}

function cancelEnvClose() {
  clearTimeout(envCloseTimer);
  envCloseTimer = null;
}

envInfoBtn.addEventListener("mouseenter", scheduleEnvOpen);
envInfoBtn.addEventListener("mouseleave", scheduleEnvClose);
envInfoBtn.addEventListener("click", () => {
  if (envPopoverEl.classList.contains("hidden")) openEnvPopover();
  else closeEnvPopover();
});
envPopoverEl.addEventListener("mouseenter", cancelEnvClose);
envPopoverEl.addEventListener("mouseleave", scheduleEnvClose);
document.addEventListener("mousedown", (e) => {
  if (envPopoverEl.classList.contains("hidden")) return;
  if (!envInfoBtn.contains(e.target) && !envPopoverEl.contains(e.target)) {
    closeEnvPopover();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEnvPopover();
});

/* Header refresh button — force a re-probe of the ACTIVE tab.
 *
 * Unlike the Options page's Refresh (which has to guess which tab to poke when
 * several are open), this button runs in the side panel that sits alongside the
 * page the user is actually looking at. background.js resolves snow_refresh /
 * goble_refresh against the active tab, so the returned live snapshot is
 * guaranteed to be the page in view. The poke also refreshes the "last"
 * snapshot (snowLastCtx / gobleLastCtx), so the Options Environment page picks
 * up the same values on its next load. */
function refreshEnvFromActiveTab() {
  if (!envRefreshBtn || envRefreshBtn.classList.contains("busy")) return;
  envRefreshBtn.classList.add("busy");

  const pokeSnow = new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "snow_refresh" }, (resp) => {
        // Only a real capture replaces the shown values — if the active tab is
        // not on a ServiceNow page the background answers null, and we keep the
        // last captured snapshot (same keep-last rule as Options → Environment).
        if (!chrome.runtime.lastError && resp && resp.ok && resp.ctx) {
          snowCtx = resp.ctx;
        }
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });

  const pokeGoble = new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "goble_refresh" }, (resp) => {
        if (!chrome.runtime.lastError && resp && resp.ok && resp.ctx) {
          gobleCtx = resp.ctx;
        }
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });

  Promise.all([pokeSnow, pokeGoble]).then(() => {
    envRefreshBtn.classList.remove("busy");
    snowTagCtxTick();
    updateHeaderNumbers();
    // Show the result: open the popover if it isn't already, so the user sees
    // the freshly captured values right away.
    if (envPopoverEl.classList.contains("hidden")) openEnvPopover();
    else refreshEnvValues();
  });
}

if (envRefreshBtn) {
  envRefreshBtn.addEventListener("click", refreshEnvFromActiveTab);
}

buildEnvPopover();

/* Header identity lines — the captured ServiceNow incident number, with the
 * FSM work order number underneath it.
 *
 * Reading the numbers off the header is faster than opening the Environment
 * popover to compare them against the page in front of you. Both come from the
 * snapshots that popover reads (snowCtx.number / gobleCtx.fwo, listed there as
 * Incident / Order Number), so the two surfaces can never disagree. The
 * incident line falls back to the plain product label the markup ships with;
 * the work order line stays hidden until an FSM order page has been captured. */
function updateHeaderNumbers() {
  const sn = snowCtx || {};
  const number = sn.number ? String(sn.number) : "";
  if (headerSubtitleEl) {
    headerSubtitleEl.textContent = number || "Servicenow";
    headerSubtitleEl.classList.toggle("has-number", !!number);
    headerSubtitleEl.title = number
      ? "ServiceNow incident " + number +
        (sn.instance ? " · " + sn.instance : "")
      : "ServiceNow incident number (none captured yet)";
  }
  if (!headerWorkOrderEl) return;
  const g = gobleCtx || {};
  const wo = g.fwo ? String(g.fwo) : "";
  headerWorkOrderEl.textContent = wo;
  headerWorkOrderEl.classList.toggle("has-number", !!wo);
  headerWorkOrderEl.classList.toggle("hidden", !wo);
  headerWorkOrderEl.title = wo ? "FSM work order " + wo : "";
}

updateHeaderNumbers();

// Pull the background's most recent ServiceNow snapshot into snowCtx. The
// background keeps the LAST non-empty capture (the same source the Options
// Environment page reads) rather than an active-tab-relative value — so
// switching away from the incident page never wipes these rows.
function refreshSnowContext() {
  try {
    chrome.runtime.sendMessage({ type: "snow_get_last" }, (resp) => {
      if (chrome.runtime.lastError) return;
      snowCtx = (resp && resp.ok && resp.ctx) || null;
      refreshEnvValues();
      snowTagCtxTick();
      updateHeaderNumbers();
    });
  } catch (_) {}
}

// Same, for the FSM order-page snapshot.
function refreshGobleContext() {
  try {
    chrome.runtime.sendMessage({ type: "goble_get_last" }, (resp) => {
      if (chrome.runtime.lastError) return;
      gobleCtx = (resp && resp.ok && resp.ctx) || null;
      refreshEnvValues();
      updateHeaderNumbers();
    });
  } catch (_) {}
}

// Broadcasts from background.js refresh both snapshots the moment a new capture
// lands. Live "null" payloads mean the user simply switched to a non-source tab
// — they are ignored so previously captured values stay visible, matching the
// Options Environment page's keep-last behaviour.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "snow_ctx") {
    if (msg.ctx) {
      snowCtx = msg.ctx;
      refreshEnvValues();
      snowTagCtxTick();
      updateHeaderNumbers();
    }
  } else if (msg.type === "goble_ctx") {
    if (msg.ctx) {
      gobleCtx = msg.ctx;
      refreshEnvValues();
      updateHeaderNumbers();
    }
  }
});

openOptionsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});
