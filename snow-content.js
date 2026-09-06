// ServiceNow context capture content script.
//
// Runs on https://*.service-now.com/* (top frame AND subframes such as the
// classic UI's #gsft_main form iframe).
//
// What it captures about the currently viewed record:
//   * token        — the CSRF token (window.g_ck) used by the REST Table API.
//                    Two paths: (1) read the DOM hidden field
//                    input[name="sysparm_ck"] directly (works on shells that
//                    don't expose g_ck as a JS global); (2) g_ck lives in the
//                    PAGE context, so we also inject a short-lived MAIN-world
//                    probe and receive it back via window.postMessage.
//   * instance     — the ServiceNow hostname (e.g. acme.service-now.com).
//   * sysid        — the record sys_id, parsed from the URL (sys_id=...).
//   * number       — the incident number, read from the form DOM when the
//                    record is an incident (table detected from the URL).
//   * callerSysid / callerName — the caller reference field of the open form,
//                    read by the same MAIN-world probe via
//                    g_form.getValue('caller_id') / getDisplayValue('caller_id')
//                    (only when a live g_form is present, i.e. form pages).
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
  // caller reference field captured by the MAIN-world g_form probe; declared
  // here so collect() can read them without a ReferenceError before the first
  // postMessage arrives.
  let callerSysid = null;
  let callerName = null;

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

  // Caller reference field — DOM fallback for when the MAIN-world g_form probe
  // can't reach a live g_form (e.g. Next Experience shells that don't expose it
  // as a window global). ServiceNow renders the caller as two inputs:
  //   sys_display.incident.caller_id  -> the human-readable name (shown)
  //   incident.caller_id              -> the referenced user's sys_id (hidden)
  // Returns { name, sysid }; empty strings when the field isn't on the page.
  function readCallerDom(doc) {
    const out = { name: "", sysid: "" };
    if (!doc) return out;
    const nameSels = [
      'input[name="sys_display.incident.caller_id"]',
      'input[id="sys_display.incident.caller_id"]',
      '[data-table="incident"] [data-field="caller_id"] input',
      '[data-field="caller_id"] input',
    ];
    const sysidSels = [
      'input[name="incident.caller_id"]',
      'input[id="incident.caller_id"]',
    ];
    for (const sel of nameSels) {
      try {
        const el = doc.querySelector(sel);
        if (el && (el.value || el.getAttribute("value"))) {
          out.name = String(el.value || el.getAttribute("value")).trim();
          break;
        }
      } catch (_) {}
    }
    for (const sel of sysidSels) {
      try {
        const el = doc.querySelector(sel);
        if (el && (el.value || el.getAttribute("value"))) {
          out.sysid = String(el.value || el.getAttribute("value")).trim();
          break;
        }
      } catch (_) {}
    }
    return out;
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
    if (!token) token = readTokenDom() || null; // DOM hidden field fallback
    if (token) ctx.token = token;
    if (table === "incident") {
      const sysid = currentSysId(location.href);
      if (sysid) ctx.sysid = sysid;
      const number = readIncidentNumber(doc);
      if (number) ctx.number = number;
      // Caller reference: prefer the MAIN-world g_form probe value; fall back
      // to the DOM inputs (sys_display.incident.caller_id / incident.caller_id)
      // when g_form isn't reachable — common on Next Experience shells.
      const domCaller = readCallerDom(doc);
      if (!callerSysid && domCaller.sysid) callerSysid = domCaller.sysid;
      if (!callerName && domCaller.name) callerName = domCaller.name;
      if (callerSysid) ctx.callerSysid = callerSysid;
      if (callerName) ctx.callerName = callerName;
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

  /* ---------- DOM-based token fallback ---------- */

  // Not every ServiceNow shell exposes window.g_ck as a JS global; many
  // (especially newer/company-customized UIs) only render the CSRF token into a
  // hidden field. Content scripts CAN read the DOM, so read sysparm_ck directly
  // from the top document and the classic shell's #gsft_main form document.
  function readTokenDom() {
    const docs = [document];
    try {
      const f = document.getElementById("gsft_main");
      if (f && f.contentWindow && f.contentWindow.document) {
        docs.push(f.contentWindow.document);
      }
    } catch (_) {}
    const sels = [
      'input[name="sysparm_ck"]',
      'input[id="sysparm_ck"]',
      'input[name="sysparm_csrf_token"]',
    ];
    for (const d of docs) {
      for (const sel of sels) {
        try {
          const el = d.querySelector(sel);
          if (el && el.value) return String(el.value).trim();
        } catch (_) {}
      }
    }
    return "";
  }

  /* ---------- MAIN-world probe for window.g_ck + g_form caller ---------- */

  // Content scripts run in an isolated world where page globals such as g_ck
  // and g_form are invisible. Inject a tiny script into the page context that
  // reads them and hands everything back over window.postMessage.
  function probeToken() {
    const old = document.getElementById(PROBE_SOURCE);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const script = document.createElement("script");
    script.id = PROBE_SOURCE;
    // Runs in the MAIN world so it can see page globals (g_ck, g_form). Reads
    // the CSRF token plus the caller reference field of the open form:
    //   g_form.getValue('caller_id')        -> sys_id of the caller
    //   g_form.getDisplayValue('caller_id') -> human-readable caller name
    script.textContent = "(() => {" +
      "try{" +
      "var t=null;" +
      "try{t=window.g_ck||null;}catch(e){}" +
      "if(!t){var f=document.getElementById('gsft_main');if(f&&f.contentWindow){try{t=f.contentWindow.g_ck||null;}catch(e){}}}" +
      "var form=null;" +
      "try{form=window.g_form||null;}catch(e){}" +
      "if(!form){var ff=document.getElementById('gsft_main');if(ff&&ff.contentWindow){try{form=ff.contentWindow.g_form||null;}catch(e){}}}" +
      "var cs=null,cn=null;" +
      "if(form){try{var v=form.getValue('caller_id');if(v)cs=String(v);}catch(e){}try{var d=form.getDisplayValue('caller_id');if(d)cn=String(d);}catch(e){}}" +
      "window.postMessage({source:" + JSON.stringify(PROBE_SOURCE) + ",token:t,callerSysid:cs,callerName:cn}," + JSON.stringify(origin) + ");" +
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
    let changed = false;
    if (typeof data.token === "string" && data.token) {
      token = data.token;
      changed = true;
    }
    // caller_id (reference field): getValue() returns the sys_id of the
    // referenced user, getDisplayValue() the human name. Only captured when a
    // live g_form is available (incident form pages); list pages omit them.
    if (typeof data.callerSysid === "string" && data.callerSysid) {
      if (callerSysid !== data.callerSysid) {
        callerSysid = data.callerSysid;
        changed = true;
      }
    }
    if (typeof data.callerName === "string" && data.callerName) {
      if (callerName !== data.callerName) {
        callerName = data.callerName;
        changed = true;
      }
    }
    if (changed) report(true);
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

  /* ---------- Tag (label) injection ---------- */
  //
  // Adds labels to the incident currently shown in this frame by simulating a
  // user typing each label name into the page's tag-it widget (.tagit-new):
  // focus → set value → input/change → Enter keydown/keypress/keyup → blur.
  // The frame list covers both the classic UI's #gsft_main form iframe (we run
  // inside it AND can reach same-origin iframes from the top frame) and the
  // no-frame Next Experience shell.

  function snowTagDocs() {
    const docs = [];
    const seen = new Set();
    (function walk(d, depth) {
      if (!d || seen.has(d)) return;
      seen.add(d);
      docs.push(d);
      if (depth <= 0) return;
      const frames = d.querySelectorAll("iframe");
      for (const f of frames) {
        try {
          if (f.contentDocument) walk(f.contentDocument, depth - 1);
        } catch (_) {}
      }
    })(document, 3);
    return docs;
  }

  function snowFindTagInput() {
    const sels = [
      ".tagit-new .ui-autocomplete-input",
      ".tagit .ui-autocomplete-input",
      ".tagit-new input",
    ];
    for (const d of snowTagDocs()) {
      for (const sel of sels) {
        try {
          const el = d.querySelector(sel);
          if (el && !el.disabled && !el.readOnly) return { doc: d, input: el };
        } catch (_) {}
      }
    }
    return null;
  }

  function snowFindMoreToggle() {
    for (const d of snowTagDocs()) {
      try {
        const btn = d.getElementById("toggleMoreOptions");
        if (btn) return { doc: d, btn };
      } catch (_) {}
    }
    return null;
  }

  // The label field sits inside the form's "More Options" section, which is
  // collapsed by default: the .tagit-new widget is NOT in the DOM until that
  // section is expanded. So before typing labels we make sure the input is
  // actually rendered — if it isn't, click #toggleMoreOptions and poll until
  // the widget appears (or give up with a clear error instead of failing on a
  // missing element).
  async function snowWaitForTagInput(timeoutMs) {
    const limit = timeoutMs || 10000;
    const start = Date.now();
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    let found = snowFindTagInput();
    let clicks = 0;
    while (!found && clicks < 2 && Date.now() - start < limit) {
      const more = snowFindMoreToggle();
      if (more) {
        try {
          more.btn.click();
          clicks++;
        } catch (_) {}
      }
      // Poll after the click so lazy-rendered widgets get time to appear;
      // only click again if it still hasn't shown up.
      const pollUntil = Date.now() + (clicks === 1 ? 2500 : 3500);
      while (Date.now() < pollUntil && !found) {
        await pause(200);
        found = snowFindTagInput();
      }
    }
    return found;
  }

  function snowSetInputValue(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
  }

  function snowFireKey(doc, input, type) {
    let ev = null;
    try {
      ev = new doc.defaultView.KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
    } catch (_) {
      ev = new doc.defaultView.Event(type, { bubbles: true, cancelable: true });
    }
    input.dispatchEvent(ev);
  }

  async function snowAddTagsToForm(names) {
    const found = await snowWaitForTagInput();
    if (!found) {
      return {
        error:
          "The label (tag-it) input is not rendered. Tried expanding 'More Options' (#toggleMoreOptions) but the field never appeared — reload the incident form and try again.",
      };
    }
    const { doc, input } = found;
    const w = doc.defaultView || window;
    input.focus();
    const added = [];
    for (const name of names) {
      snowSetInputValue(input, name);
      try {
        input.dispatchEvent(new w.Event("input", { bubbles: true }));
      } catch (_) {}
      try {
        input.dispatchEvent(new w.Event("change", { bubbles: true }));
      } catch (_) {}
      snowFireKey(doc, input, "keydown");
      snowFireKey(doc, input, "keypress");
      snowFireKey(doc, input, "keyup");
      added.push(name);
      // Let the tag-it widget run its (async) add/autocomplete before the next.
      await new Promise((res) => setTimeout(res, 700));
    }
    // Flush any pending draft text and close the input.
    snowSetInputValue(input, "");
    try {
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
    } catch (_) {}
    input.blur();
    return { added };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "snow_add_tags") return false;
    const names = Array.isArray(msg.names)
      ? msg.names.map((n) => String(n).trim()).filter(Boolean)
      : [];
    if (names.length === 0) {
      sendResponse({ ok: false, error: "No label names supplied." });
      return false;
    }
    snowAddTagsToForm(names)
      .then((res) => sendResponse({ ok: true, result: res }))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
    return true; // async
  });
})();
