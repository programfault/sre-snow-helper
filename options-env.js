// options-env.js — Options > "Environment" tab.
//
// Shows the LAST captured ServiceNow / FSM order context, which is persistent:
// it does NOT clear when the active tab switches away (Options keeps its
// values once captured). Field definitions + display helpers come from
// env-defs.js (window.SRE_ENV) — the same file the side panel's header info
// popover uses — so the two views can never drift.
//
// Data path:
//   - On load / tab re-focus / Refresh  -> send snow_get_last / goble_get_last.
//     The background keeps the most recent non-empty capture per source in
//     memory and mirrors it to chrome.storage (sreSnowLastCtx / sreGobleLastCtx),
//     so values survive a service-worker restart too.
//   - Background live broadcasts (snow_ctx / goble_ctx) are merged in when
//     non-empty so a brand-new capture appears instantly; a null live never
//     clears this page.

const ENV_DEFS = window.SRE_ENV;

// Current "last remembered" context per source. Rendered rows are keyed the
// same way as the side panel popover.
const envCtx = { snow: null, goble: null };
const envRows = { snow: {}, goble: {} }; // src -> field key -> { valueEl, copyBtn }
let envEmptyEl = null;
let envBuilt = false;

function envFieldValue(src, f) {
  const c = envCtx[src];
  if (!c) return null;
  const v = c[f.key];
  return v === undefined || v === null || v === "" ? null : String(v);
}

/* ---------- Build the static view once ---------- */

function buildEnvRow(src, f, container) {
  const row = document.createElement("div");
  row.className = "env-row";

  const labelCol = document.createElement("div");
  labelCol.className = "env-row-label";
  const name = document.createElement("div");
  name.className = "env-row-name";
  name.textContent = f.label;
  const gvar = document.createElement("div");
  gvar.className = "env-row-gvar";
  gvar.textContent = "${" + f.gvar + "}";
  labelCol.appendChild(name);
  labelCol.appendChild(gvar);

  const value = document.createElement("div");
  value.className = "env-row-value empty";
  value.textContent = "—";
  value.title = "Empty — open the matching page and press Refresh";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "env-row-copy";
  copy.title = "Copy value";
  copy.innerHTML = ENV_DEFS.COPY_SVG;
  copy.disabled = true;
  copy.addEventListener("click", () => {
    const raw = envFieldValue(src, f);
    if (!raw) return;
    navigator.clipboard.writeText(raw).then(
      () => {
        copy.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
        copy.title = "Copied";
        setTimeout(() => {
          copy.innerHTML = ENV_DEFS.COPY_SVG;
          copy.title = "Copy value";
        }, 1200);
      },
      () => {}
    );
  });

  row.appendChild(labelCol);
  row.appendChild(value);
  row.appendChild(copy);
  container.appendChild(row);
  envRows[src][f.key] = { valueEl: value, copyBtn: copy };
}

function buildEnvView() {
  if (envBuilt) return;
  const wrap = document.getElementById("envWrap");
  if (!wrap) return;

  ENV_DEFS.SRC_ORDER.forEach((src) => {
    const card = document.createElement("div");
    card.className = "env-group";

    const head = document.createElement("div");
    head.className = "env-group-head";
    const title = document.createElement("div");
    title.className = "env-group-title";
    title.textContent = ENV_DEFS.SRC_TITLES[src];
    const meta = document.createElement("div");
    meta.className = "env-group-meta";
    meta.textContent =
      src === "snow"
        ? "Last ServiceNow page visited"
        : "Last FSM order page visited";
    head.appendChild(title);
    head.appendChild(meta);

    const rows = document.createElement("div");
    ENV_DEFS.bySrc(src).forEach((f) => buildEnvRow(src, f, rows));

    card.appendChild(head);
    card.appendChild(rows);
    wrap.appendChild(card);
  });

  envEmptyEl = document.createElement("div");
  envEmptyEl.className = "env-empty";
  envEmptyEl.innerHTML =
    "Nothing captured yet — open a ServiceNow incident or an FSM order page, then press <b>Refresh</b>.";
  wrap.appendChild(envEmptyEl);

  envBuilt = true;
}

/* ---------- Render / merge ---------- */

function renderEnv() {
  if (!envBuilt) return;
  let any = false;
  ENV_DEFS.SRC_ORDER.forEach((src) => {
    ENV_DEFS.bySrc(src).forEach((f) => {
      const raw = envFieldValue(src, f);
      const el = envRows[src][f.key];
      if (!el) return;
      if (raw) any = true;
      el.valueEl.textContent = raw || "—";
      el.valueEl.classList.toggle("empty", !raw);
      el.valueEl.title = raw
        ? raw
        : "Empty — open the matching page and press Refresh";
      el.copyBtn.disabled = !raw;
    });
  });
  if (envEmptyEl) envEmptyEl.classList.toggle("visible", !any);
}

// Replace wholesale from the authoritative background "last" snapshot.
function setLastCtx(src, ctx) {
  if (ctx && typeof ctx === "object") envCtx[src] = ctx;
  renderEnv();
}

// Merge a live broadcast over what we show. Only non-empty keys are applied
// and existing keys are never dropped, so Options keeps values even while a
// source has no live page anymore.
function mergeLiveCtx(src, ctx) {
  if (!ctx || typeof ctx !== "object") return;
  const merged = {};
  const base = envCtx[src] || {};
  Object.keys(base).forEach((k) => {
    if (base[k] !== undefined && base[k] !== null && base[k] !== "") {
      merged[k] = base[k];
    }
  });
  Object.keys(ctx).forEach((k) => {
    if (ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== "") {
      merged[k] = ctx[k];
    }
  });
  envCtx[src] = merged;
  renderEnv();
}

/* ---------- Data fetching ---------- */

function loadLast(src) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: src === "snow" ? "snow_get_last" : "goble_get_last" },
      (resp) => {
        if (!chrome.runtime.lastError && resp && resp.ok) {
          setLastCtx(src, resp.ctx);
        }
        resolve();
      }
    );
  });
}

function loadAllLast() {
  return Promise.all([loadLast("snow"), loadLast("goble")]);
}

function setStatus(text, kind) {
  const st = document.getElementById("envStatus");
  if (!st) return;
  st.textContent = text || "";
  st.classList.toggle("busy", kind === "busy");
  st.classList.toggle("ok", kind === "ok");
}

function refreshAll() {
  const btn = document.getElementById("envRefreshBtn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  setStatus("Re-reading the page in the active tab…", "busy");

  const poke = (type) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type }, () => resolve());
      } catch (_) {
        resolve();
      }
    });

  Promise.all([poke("snow_refresh"), poke("goble_refresh")])
    .then(loadAllLast)
    .then(() => {
      btn.disabled = false;
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      setStatus("Updated " + hh + ":" + mm, "ok");
      setTimeout(() => {
        const st = document.getElementById("envStatus");
        if (st && st.textContent) st.textContent = "";
      }, 3000);
    })
    .catch(() => {
      btn.disabled = false;
      setStatus("Refresh failed", "");
    });
}

/* ---------- Wire up ---------- */

function initEnvTab() {
  buildEnvView();
  renderEnv();
  loadAllLast();

  const refreshBtn = document.getElementById("envRefreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

  // Coming back to this Options tab may have happened long after the last
  // capture — re-ask the background for its freshest "last" snapshot.
  window.addEventListener("focus", loadAllLast);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadAllLast();
  });

  // Live broadcasts arrive while this page is open; apply non-empty ones so a
  // fresh capture shows up without needing a manual Refresh.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "snow_ctx") mergeLiveCtx("snow", msg.ctx);
    else if (msg.type === "goble_ctx") mergeLiveCtx("goble", msg.ctx);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initEnvTab);
} else {
  initEnvTab();
}
