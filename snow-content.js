// ServiceNow context capture content script.
//
// Runs on https://*.service-now.com/* (top frame AND subframes such as the
// classic UI's #gsft_main form iframe).
//
// What it captures about the currently viewed record:
//   * token        — the CSRF token (window.g_ck) used by the REST Table API.
//                    g_ck lives in the PAGE context, so we read it through a
//                    short-lived MAIN-world probe and receive it back via
//                    window.postMessage.
//   * instance     — the ServiceNow hostname (e.g. acme.service-now.com).
//   * sysid        — the record sys_id, parsed from the URL (sys_id=...).
//   * number       — the incident number, read from the form DOM when the
//                    record is an incident (table detected from the URL).
//   * at / url     — timestamp and current URL for freshness ordering.
//
// Every frame reports only what it can see; background.js merges the fields
// across frames/tabs and hands the best snapshot to the side panel.

(() => {
  const isSnow =
    location.hostname === "service-now.com" ||
    location.hostname.endsWith(".service-now.com");
  if (!isSnow) return;

  const PROBE_SOURCE = "sre-snow-probe";
  const origin = location.origin;
  let token = null;
  let lastSent = "";

  /* ---------- URL / DOM readers (isolated world, shared DOM) ---------- */

  function urlParam(url, name) {
    try {
      const u = new URL(url, location.href);
      return u.searchParams.get(name);
    } catch (_) {
      return null;
    }
  }

  // Identify the table this page is editing. Only incident forms produce a
  // Number + IncidentID snapshot; every ServiceNow page still yields a token.
  function currentTable() {
    const s = location.search || "";
    const uri = urlParam(location.href, "uri") || "";
    if (/^incident\.do/i.test(uri) || /(^|[?&])uri=incident\.do/i.test(s)) {
      return "incident";
    }
    const path = location.pathname.replace(/^\/+/, "");
    if (/^incident(\.do)?$/i.test(path)) return "incident";
    // Next Experience style record routes: /incident/<sysid> or /record/incident/<sysid>
    if (/(^|\/)incident\/[^/?#]+/.test(location.pathname)) return "incident";
    return null;
  }

  function currentSysId(url) {
    const sysId = urlParam(url, "sys_id");
    if (sysId && /^[a-zA-Z0-9]{32}$/.test(sysId)) return sysId;
    // Some URLs embed sys_id=... in a nav_to uri=... query that is itself
    // percent-encoded; URLSearchParams above already decodes it once.
    const m = String(url).match(/sys_id=([a-zA-Z0-9]{32})/i);
    return m ? m[1] : null;
  }

  // Best-effort incident number lookup. ServiceNow UI16 renders the readonly
  // number field with name "sys_readonly.incident.number"; several shells use
  // slightly different ids, so we try a few common candidates.
  function readIncidentNumber(doc) {
    if (!doc) return "";
    const candidates = [
      'input[name="sys_readonly.incident.number"]',
      'input[name="incident.number"]',
      'input[id="sys_readonly.incident.number"]',
      'input[name="sys_display.incident.number"]',
      '[data-table="incident"] [data-field="number"] input',
      '[data-field="number"] input',
    ];
    for (const sel of candidates) {
      try {
        const el = doc.querySelector(sel);
        if (el && (el.value || el.getAttribute("value"))) {
          return String(el.value || el.getAttribute("value")).trim();
        }
      } catch (_) {}
    }
    return "";
  }

  // When running in the top frame we can also peek at the form iframe that the
  // classic UI mounts (same-origin), so a single probe can report number even
  // if only the shell frame executes.
  function docFromFormFrame() {
    try {
      const f = document.getElementById("gsft_main");
      return f && f.contentWindow && f.contentWindow.document
        ? f.contentWindow.document
        : document;
    } catch (_) {
      return document;
    }
  }

  /* ---------- Collect + report ---------- */

  function collect() {
    const table = currentTable();
    const doc = docFromFormFrame();
    const ctx = {
      instance: location.hostname,
      url: location.href,
      at: Date.now(),
    };
    if (token) ctx.token = token;
    if (table === "incident") {
      const sysid = currentSysId(location.href);
      if (sysid) ctx.sysid = sysid;
      const number = readIncidentNumber(doc);
      if (number) ctx.number = number;
    }
    return ctx;
  }

  function report(force) {
    const ctx = collect();
    const json = JSON.stringify(ctx);
    if (!force && json === lastSent) return; // nothing changed in this frame
    lastSent = json;
    if (!ctx.token && !ctx.sysid && !ctx.number) return; // nothing useful yet
    try {
      chrome.runtime.sendMessage({ type: "snow_probe", ctx }, () => {
        // No receiver (e.g. extension just reloaded) — ignore quietly.
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  /* ---------- MAIN-world probe for window.g_ck ---------- */

  // Content scripts run in an isolated world where page globals such as g_ck
  // are invisible. Inject a tiny script into the page context that reads it
  // and hands it back over window.postMessage.
  function probeToken() {
    const old = document.getElementById(PROBE_SOURCE);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const script = document.createElement("script");
    script.id = PROBE_SOURCE;
    script.textContent =
      "(() => {" +
      "try{" +
      "var t = window.g_ck || null;" +
      "if(!t){var f=document.getElementById('gsft_main');" +
      "if(f&&f.contentWindow){try{t=f.contentWindow.g_ck||null;}catch(e){}}}" +
      "window.postMessage({source:" +
      JSON.stringify(PROBE_SOURCE) +
      ",token:t}," +
      JSON.stringify(origin) +
      ");" +
      "}catch(e){}" +
      "})();";
    (document.head || document.documentElement).appendChild(script);
    setTimeout(() => {
      if (script.parentNode) script.parentNode.removeChild(script);
    }, 200);
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== origin) return;
    const data = event.data || {};
    if (data.source !== PROBE_SOURCE) return;
    if (typeof data.token === "string" && data.token) {
      token = data.token;
      report(true);
    }
  });

  // Re-read on user returning to the tab / page becoming visible again.
  window.addEventListener("focus", () => probeToken());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") probeToken();
  });

  // Answer a "please probe now" request from the service worker (used when the
  // user switches to this tab so the side panel refreshes right away).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "snow_request_probe") return false;
    probeToken();
    // Report DOM-derived fields immediately; token arrives via postMessage.
    setTimeout(() => report(true), 350);
    setTimeout(() => report(true), 1200);
    sendResponse({ ok: true });
    return false;
  });

  /* ---------- Startup sequence ---------- */

  // Poll a few times after load: the form frame may mount later than this
  // frame, and record navigation inside the classic UI reloads subframes.
  let tries = 0;
  function poll() {
    tries++;
    report(false);
    probeToken();
    if (tries < 12) setTimeout(poll, 2000);
  }
  setTimeout(poll, 300);
  setTimeout(() => report(true), 1000);
})();
