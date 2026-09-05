// goble.com order-page context capture content script.
//
// Runs on goble.com (and subdomains) at document_idle. It reads three values
// straight off the page the user is looking at, whenever they can be found:
//   * fwo  — OrderNumber: the first <h6> text inside main.body-content.
//   * fsid — serviceid: the first digit-bearing text inside the parent of the
//            <h6> whose text is exactly "Service ID".
//   * factok — accesstoken: localStorage.getItem("accessToken").
// Pages that do not expose a field report it as "" (empty), so switching to a
// different goble.com page clears whatever is no longer visible.
//
// Every report mirrors the ServiceNow probe contract: background.js merges
// per tab, picks the "best" snapshot and hands it to the side panel, which
// surfaces these values as the ${f_wo_number} / ${f_sid} / ${f_access_token}
// globals usable from any YAML document.

(() => {
  const host = location.hostname;
  const isGoble = host === "goble.com" || host.endsWith(".goble.com");
  if (!isGoble) return;

  let lastSent = "";

  /* ---------- DOM / storage readers ---------- */

  // OrderNumber / work-order number: first h6 inside main.body-content.
  function readOrderNumber() {
    const bodyContent = document.querySelector("main.body-content, .body-content");
    const firstH6 = bodyContent ? bodyContent.querySelector("h6") : null;
    return firstH6 ? String(firstH6.textContent || "").trim() : "";
  }

  // serviceid: <h6> labelled "Service ID" → look inside its parent for the
  // first text containing digits and take the first numeric run from it.
  function readServiceId() {
    let target = null;
    const h6s = document.querySelectorAll("h6");
    for (const el of h6s) {
      if (String(el.textContent || "").trim() === "Service ID") {
        target = el;
        break;
      }
    }
    if (!target) return "";
    const parent = target.parentElement;
    if (!parent) return "";
    const allTexts = Array.from(parent.querySelectorAll("*"))
      .map((el) => String(el.textContent || "").trim())
      .filter((t) => t && t !== "Service ID");
    const found = allTexts.find((t) => /\d+/.test(t)) || allTexts[0];
    if (!found) return "";
    const m = found.match(/\d+/);
    return m ? m[0] : found;
  }

  function readAccessToken() {
    try {
      const t = localStorage.getItem("accessToken");
      return t ? String(t).trim() : "";
    } catch (_) {
      return "";
    }
  }

  /* ---------- Collect + report ---------- */

  function collect() {
    const ctx = { url: location.href, at: Date.now() };
    // Always carry all three keys (possibly "") so a page that no longer shows
    // a field clears the previously captured value instead of keeping it.
    ctx.fwo = readOrderNumber();
    ctx.fsid = readServiceId();
    ctx.factok = readAccessToken();
    return ctx;
  }

  function report(force) {
    const ctx = collect();
    const json = JSON.stringify(ctx);
    if (!force && json === lastSent) return;
    lastSent = json;
    try {
      chrome.runtime.sendMessage({ type: "goble_probe", ctx }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  // SPA navigation (pushState/replaceState) swaps the visible order without a
  // full reload; re-collect shortly after the URL changes.
  function hookHistory() {
    const fire = () => setTimeout(() => report(true), 250);
    try {
      const patch = (type) => {
        const orig = history[type];
        history[type] = function (...args) {
          const r = orig.apply(this, args);
          fire();
          return r;
        };
      };
      patch("pushState");
      patch("replaceState");
    } catch (_) {}
    window.addEventListener("popstate", fire);
  }

  // Re-read when the tab/page becomes visible again.
  window.addEventListener("focus", () => report(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") report(true);
  });

  // Answer a "please probe now" request from the service worker (used when the
  // user switches to this tab so the side panel refreshes right away).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "goble_request_probe") return false;
    report(true);
    // Some order pages render their headings after first paint; give the DOM a
    // moment to settle before re-reporting.
    setTimeout(() => report(true), 350);
    setTimeout(() => report(true), 1200);
    sendResponse({ ok: true });
    return false;
  });

  /* ---------- Startup sequence ---------- */

  hookHistory();
  let tries = 0;
  function poll() {
    tries++;
    report(false);
    if (tries < 10) setTimeout(poll, 1500);
  }
  setTimeout(poll, 300);
  setTimeout(() => report(true), 1000);
})();
