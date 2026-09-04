// SRE Helper — Google Chat Ring Monitor content script
//
// Injected on *://chat.google.com/*. Responsible for:
//   1. Heartbeat registration with the background SW so the sidepanel can
//      answer "is any gchat tab open?".
//   2. Detecting the sidebar space items and their unread badges.
//   3. Running an IDLE/ALERTING state machine per configured rule:
//        IDLE (unread=0)  ───  from 0 → >0  ───▶   立即响铃 + 桌面通知
//                              进入 ALERTING
//                              每 repeatIntervalSec 检查一次
//                                ├─ 还未读 && 次数<max → 再响
//                                └─ 已读（未读清零）→ IDLE
//   4. When the background routes a ring-broadcast back to us (SW can't play
//      audio directly), play it via an HTMLAudioElement on the page.

/* ---------- Self-guard: only one instance per page ---------- */
if (window.__SRE_CHAT_RUNNING__) {
  // In MV3 extension reloads the content script is re-injected on top of the
  // old one. Tear down the prior instance's timers/observers first.
  try {
    if (window.__SRE_CHAT_TEARDOWN__) window.__SRE_CHAT_TEARDOWN__();
  } catch (_) {}
}
window.__SRE_CHAT_RUNNING__ = true;

/* ---------- Message constants (kept in sync with background.js) ---------- */
const MSG = {
  HEARTBEAT: "CHAT_HEARTBEAT",
  TAB_GOING_AWAY: "CHAT_TAB_GOING_AWAY",
  TRY_RING: "CHAT_TRY_RING",
  RULE_STATE_CHANGED: "CHAT_RULE_STATE_CHANGED",
  PLAY_RING: "CHAT_PLAY_RING",
};

/* ---------- Local state ---------- */
/** @type {Array} */
let rules = []; // latest sreChatSpaceRules from storage
let monitorEnabled = false; // latest sreChatMonitor.monitorEnabled
let ringtones = []; // for resolving display names in state push messages

// Per-rule local state machine: { <ruleId>: { state, lastUnread, repeatCount, timer } }
const ruleState = new Map();

// Audio context / playback handles
let _audioEls = []; // keep references so garbage collection doesn't cut them off mid-play

// Heartbeat and storage
const HEARTBEAT_MS = 5000;
let heartbeatTimer = null;

// Detecting space + unread badge
let observer = null;
let detectTimer = null;

/* ---------- Helpers ---------- */

function log(...args) {
  console.log("[sre-chat]", ...args);
}

function safeSendMessage(payload, cb) {
  try {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        // Experience 100023937: no-route-to-receiver is expected during SW wakeup
        // or page teardown. We never make the message a hard prerequisite.
        if (typeof cb === "function") cb({ ok: false, reason: "no-route" });
      } else if (typeof cb === "function") {
        cb(resp || { ok: true });
      }
    });
  } catch (_) {
    if (typeof cb === "function") cb({ ok: false, reason: "exception" });
  }
}

function parseSpaceListItems() {
  // Return an array of candidate space records collected from the side nav.
  // Each record is: { name, hasUnread, unreadCount, el }.
  //
  // Google Chat's DOM is version-dependent, so we use several heuristics:
  //   1. list items with data-group-id^="space/" (old reliable class)
  //   2. any <a> or [role=listitem] containing a numeric unread badge
  //   3. fallback: visible list-like nodes matching common chat side nav markers
  //
  // We deliberately avoid exact class names because Google rewrites them.
  const results = [];
  const seen = new WeakSet();

  function collect(candidates) {
    if (!candidates) return;
    for (const el of candidates) {
      if (!el || seen.has(el)) continue;
      if (el.offsetParent === null) continue; // not visible
      const text = (el.innerText || "").trim();
      if (!text) continue;

      // Extract name = all lines that don't look like timestamps or message snippets
      // (heuristic: first line, or the line that does NOT start with a digit badge char)
      const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      // Find any small numeric badge (1-3 digits) rendered near this item.
      // Strategy: walk descendants, pick any element whose innerText is a pure
      // number 1..9999 and occupies a visibly small text span.
      let hasUnread = false;
      let unreadCount = 0;
      // Heuristic 1: look for pure numeric spans within this item's subtree
      // that are not long dates/times.
      const smallSpans = el.querySelectorAll(
        "span, div[class], b, strong, sup, sub"
      );
      for (const s of smallSpans) {
        const t = (s.innerText || "").trim();
        if (/^\d{1,3}$/.test(t)) {
          const n = parseInt(t, 10);
          if (n > 0 && n < 1000) {
            hasUnread = true;
            unreadCount = Math.max(unreadCount, n);
          }
        }
      }
      // Heuristic 2: if we didn't find a badge subtree yet, but the item's text
      // lines end with something like " (3)", use that.
      if (!hasUnread) {
        for (const l of lines) {
          const m = l.match(/\((\d{1,3})\)\s*$/);
          if (m) {
            hasUnread = true;
            unreadCount = Math.max(unreadCount, parseInt(m[1], 10));
          }
        }
      }

      // Final guard: discard items whose name is too generic (avoids capturing
      // "Home", "Chats", etc., if they happen to look structurally similar).
      // Keep a record only if the visible text is >= 2 chars (skips icons alone).
      const name = lines[0] || "";
      if (name.length < 2) continue;

      seen.add(el);
      results.push({ name, hasUnread, unreadCount, el });
    }
  }

  // Priority 1: list items with space-like data-group-id.
  collect(document.querySelectorAll('[data-group-id^="space/"]'));
  // Priority 2: items with role=listitem inside common sidebars.
  collect(document.querySelectorAll('aside [role="listitem"], nav [role="listitem"]'));
  // Priority 3: any <a> inside a sidebar with a numeric badge (very broad fallback).
  collect(document.querySelectorAll("aside a, nav a"));

  return results;
}

function ruleMatches(rule, space) {
  const t = rule.matchType;
  const name = space.name || "";
  const el = space.el;
  switch (t) {
    case "exact":
      return rule.matchValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((v) => name === v);
    case "contains":
      return rule.matchValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((v) => name.toLowerCase().includes(v.toLowerCase()));
    case "selector": {
      if (!el || !rule.matchValue) return false;
      try {
        // Run custom selector against the space element or document.
        const needle = rule.matchValue.trim();
        if (el.matches && el.matches(needle)) return true;
        if (document.querySelector(needle) === el) return true;
        return false;
      } catch (_) {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Aggregate, for each enabled rule, its current unread state:
 *   true  = at least one matching space has unread messages
 *   false = all matching spaces have 0 unread (or no matching space exists)
 */
function snapshotRuleUnread() {
  const items = parseSpaceListItems();
  const snapshot = {};
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let hasUnread = false;
    let count = 0;
    for (const it of items) {
      if (ruleMatches(rule, it)) {
        if (it.hasUnread) hasUnread = true;
        count += it.unreadCount || 0;
      }
    }
    snapshot[rule.id] = { hasUnread, count, matchedItemCount: count };
  }
  return snapshot;
}

/* ---------- Ring playback (background -> content) ---------- */

function playRingtone(dataUrl) {
  try {
    const audio = new Audio(dataUrl);
    audio.volume = 1.0;
    audio.play().then(
      () => {},
      (err) => {
        // Autoplay policies may block this until user-interaction. Best-effort.
        log("play ring failed:", err && err.message);
      }
    );
    audio.addEventListener("ended", () => {
      const idx = _audioEls.indexOf(audio);
      if (idx >= 0) _audioEls.splice(idx, 1);
    });
    _audioEls.push(audio);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// Unlock autoplay on first user interaction: AudioContext / Audio play() after
// a user gesture (click, keydown) is always allowed. Without this call, the
// first ring after page load might be blocked by autoplay policy.
function unlockAutoplay() {
  const once = () => {
    try {
      // Invisible 1ms silence via AudioContext unlocks the policy.
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.001);
      osc.addEventListener("ended", () => ctx.close().catch(() => {}));
    } catch (_) {}
    window.removeEventListener("pointerdown", once);
    window.removeEventListener("keydown", once);
  };
  window.addEventListener("pointerdown", once);
  window.addEventListener("keydown", once);
}

/* ---------- State machine ---------- */

function alertRule(rule, matchedName) {
  return new Promise((resolve) => {
    safeSendMessage(
      {
        type: MSG.TRY_RING,
        ruleId: rule.id,
        ruleName: rule.ruleName,
        repeatIntervalSec: rule.repeatIntervalSec || 10,
        ringtoneId: rule.ringtoneId,
        spaceName: matchedName || rule.ruleName,
      },
      (resp) => resolve(resp || { ok: false })
    );
  });
}

function pushRuleStateToStorage() {
  // Best-effort, non-blocking.
  const updates = {};
  for (const rule of rules) {
    const st = ruleState.get(rule.id);
    updates[rule.id] = {
      state: st ? st.state : "OFF",
      repeatCount: st ? st.repeatCount : 0,
      lastAlertAt: st ? st.lastAlertAt : null,
      since: st ? st.since : null,
      ruleEnabled: rule.enabled,
    };
  }
  safeSendMessage({ type: MSG.RULE_STATE_CHANGED, updates }, () => {});
}

function teardownRuleTimers() {
  for (const st of ruleState.values()) {
    if (st.timer) clearInterval(st.timer);
  }
  ruleState.clear();
}

function startRuleStateMachine(initialSnapshot) {
  teardownRuleTimers();
  if (!monitorEnabled) {
    pushRuleStateToStorage();
    return;
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const snap = (initialSnapshot && initialSnapshot[rule.id]) || {
      hasUnread: false,
      count: 0,
    };
    // Initial state: IDLE. Unless `alertOnStartup` is true AND we start with
    // unread — in that case we boot into ALERTING immediately and ring once.
    const startAlerting = Boolean(rule.alertOnStartup && snap.hasUnread);

    const st = {
      state: startAlerting ? "ALERTING" : "IDLE",
      lastUnread: snap.count,
      repeatCount: startAlerting ? 1 : 0,
      since: Date.now(),
      lastAlertAt: startAlerting ? Date.now() : null,
      timer: null,
    };
    ruleState.set(rule.id, st);

    if (startAlerting) {
      const maxR = Math.max(1, rule.maxRepeats || 20);
      if (st.repeatCount <= maxR) {
        alertRule(rule);
      }
    }
  }
  pushRuleStateToStorage();
}

function applySnapshotsToStateMachine(snap) {
  if (!monitorEnabled) return;
  let stateChanged = false;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const now = snap[rule.id] || { hasUnread: false, count: 0 };
    const st = ruleState.get(rule.id) || {
      state: "IDLE",
      lastUnread: 0,
      repeatCount: 0,
      since: Date.now(),
      timer: null,
    };
    if (!ruleState.has(rule.id)) ruleState.set(rule.id, st);

    const intervalSec = Math.max(1, rule.repeatIntervalSec || 10);
    const maxR = Math.max(1, rule.maxRepeats || 20);

    // Transition: IDLE + unread 0→>0 => ALERTING + ring now
    if (st.state === "IDLE" && now.hasUnread && st.lastUnread === 0) {
      st.state = "ALERTING";
      st.since = Date.now();
      st.lastAlertAt = Date.now();
      st.repeatCount = 1;
      stateChanged = true;
      // Fire-and-forget ring
      alertRule(rule);
      // Install per-rule repeater timer
      if (st.timer) clearInterval(st.timer);
      st.timer = setInterval(() => {
        const currentSt = ruleState.get(rule.id);
        if (!currentSt || currentSt.state !== "ALERTING") return;
        const s = snapshotRuleUnread();
        const cur = (s && s[rule.id]) || { hasUnread: false, count: 0 };
        if (!cur.hasUnread) {
          // Already read: go IDLE
          currentSt.state = "IDLE";
          currentSt.lastUnread = 0;
          currentSt.repeatCount = 0;
          if (currentSt.timer) clearInterval(currentSt.timer);
          currentSt.timer = null;
          pushRuleStateToStorage();
          return;
        }
        if (currentSt.repeatCount >= maxR) {
          // Max repeats reached: go IDLE (stop spamming).
          currentSt.state = "IDLE";
          currentSt.repeatCount = 0;
          if (currentSt.timer) clearInterval(currentSt.timer);
          currentSt.timer = null;
          pushRuleStateToStorage();
          return;
        }
        currentSt.repeatCount += 1;
        currentSt.lastAlertAt = Date.now();
        pushRuleStateToStorage();
        alertRule(rule);
      }, intervalSec * 1000);
    } else if (st.state === "ALERTING" && !now.hasUnread) {
      // ALERTING + unread cleared → back to IDLE
      st.state = "IDLE";
      st.repeatCount = 0;
      st.lastAlertAt = null;
      if (st.timer) clearInterval(st.timer);
      st.timer = null;
      stateChanged = true;
    }

    st.lastUnread = now.count;
  }

  if (stateChanged) pushRuleStateToStorage();
}

/* ---------- Detection loop + MutationObserver ---------- */

function runDetection() {
  if (!monitorEnabled) return;
  const snap = snapshotRuleUnread();
  applySnapshotsToStateMachine(snap);
}

function startDetection() {
  stopDetection();
  // Fallback 2s polling (protects against missed mutations when Google Chat
  // uses virtualized list rendering).
  detectTimer = setInterval(runDetection, 2000);
  // MutationObserver on the entire document body is a blunt instrument but it
  // catches new-message badge renders nearly instantly (< 100ms).
  try {
    observer = new MutationObserver(() => {
      // Debounced: only one detection within 500ms.
      if (startDetection._deb) clearTimeout(startDetection._deb);
      startDetection._deb = setTimeout(runDetection, 300);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch (_) {}
  // Initial run
  runDetection();
}

function stopDetection() {
  if (observer) {
    try { observer.disconnect(); } catch (_) {}
    observer = null;
  }
  if (detectTimer) {
    clearInterval(detectTimer);
    detectTimer = null;
  }
  if (startDetection._deb) {
    clearTimeout(startDetection._deb);
    startDetection._deb = null;
  }
}

/* ---------- Storage sync ---------- */

function loadStorageAndBoot() {
  const keys = ["sreChatSpaceRules", "sreChatMonitor", "sreRingtones"];
  chrome.storage.local.get(keys, (data) => {
    rules = Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [];
    ringtones = Array.isArray(data.sreRingtones) ? data.sreRingtones : [];
    const monitor = data.sreChatMonitor || { monitorEnabled: false };
    monitorEnabled = Boolean(monitor.monitorEnabled);

    teardownRuleTimers();
    if (monitorEnabled) {
      const snap = snapshotRuleUnread();
      startRuleStateMachine(snap);
      startDetection();
    } else {
      stopDetection();
      pushRuleStateToStorage();
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.sreChatSpaceRules ||
    changes.sreChatMonitor ||
    changes.sreRingtones
  ) {
    loadStorageAndBoot();
  }
});

/* ---------- Message listener (background ring broadcast) ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (msg.type === MSG.PLAY_RING && msg.dataUrl) {
    const res = playRingtone(msg.dataUrl);
    sendResponse(res);
    return false;
  }
  return false;
});

/* ---------- Heartbeat + teardown ---------- */

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = () => safeSendMessage({ type: MSG.HEARTBEAT }, () => {});
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}

function onBeforeUnload() {
  try {
    // Synchronous best-effort (beforeunload timers are capped).
    chrome.runtime.sendMessage({ type: MSG.TAB_GOING_AWAY }, () => {
      /* swallow lastError */
      if (chrome.runtime.lastError) void chrome.runtime.lastError;
    });
  } catch (_) {}
}

/* ---------- Main ---------- */

function teardownEverything() {
  stopDetection();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  teardownRuleTimers();
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.__SRE_CHAT_RUNNING__ = false;
  window.__SRE_CHAT_TEARDOWN__ = null;
}
window.__SRE_CHAT_TEARDOWN__ = teardownEverything;

function main() {
  unlockAutoplay();
  window.addEventListener("beforeunload", onBeforeUnload);
  startHeartbeat();
  loadStorageAndBoot();
  log("content script booted");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
