// SRE Helper — Google Chat Ring Monitor content script
//
// Injected on *://chat.google.com/*. Responsible for:
//   1. Heartbeat registration with the background SW so the sidepanel can
//      answer "is any gchat tab open?".
//   2. Detecting the sidebar space items and their unread badges.
//   3. Running an IDLE/ALERTING state machine per configured rule:
//        IDLE (unread=0)  ───  from 0 → >0  ───▶   立即响铃
//                              进入 ALERTING
//                              每 repeatIntervalSec 检查一次
//                                ├─ 还未读 && 次数<max → 再响
//                                └─ 已读（未读清零）→ IDLE
//   4. When the background routes a ring-broadcast back to us (fallback path —
//      the primary path is an offscreen audio document), play it via an
//      HTMLAudioElement on the page.

/* ---------- Self-guard: exactly one live instance per page ----------
 *
 * MV3 quirk: when the unpacked extension is "Reload"-ed while a chat tab is
 * still open, Chrome can inject the content script AGAIN on top of the still
 * running old copy. Two side-by-side copies would double every heartbeat,
 * observer and ring listener.
 *
 * We therefore wrap this whole file in an IIFE and treat an existing copy as
 * stale: the previous instance tears itself down (timers, observers AND its
 * onMessage listener — all tracked below) and we start a fresh copy. Because
 * everything lives inside the IIFE's function scope, the old copy's top-level
 * `const`/`let` can never clash with the new one's (that clash used to throw
 * "Identifier 'MSG' has already been declared" and killed the script silently,
 * which is why no [sre-chat] log ever appeared). */
(() => {
if (window.__SRE_CHAT_RUNNING__) {
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
let ringtones = []; // for resolving display names in state push messages
// monitorEnabled is defined later, next to loadStorageAndBoot (monitoring is on
// iff at least one rule is enabled; there is no master-switch storage field).

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
  // Google Chat real DOM (2026): sidebar items are <span class="IL9EXe ..."
  // data-group-id="space/<ID>">.  The name is the FIRST \n-separated line of
  // innerText (further lines are "Space" / "Meeting conversation" / etc.).
  // data-group-id=space/ still works (confirmed via user diagnostics).
  //
  // Strategy:
  //   1) Primary: span[data-group-id^="space/"]
  //   2) Fallback: any [role="listitem"] whose first-line text looks reasonable.
  //   3) We do NOT filter on offsetParent === null because modern Material
  //      design wraps visible items in layout-<span> trees whose offsetParent
  //      is null even though the <span> itself is visible.
  //
  // Unread badge detection (3 strategies, OR-ed):
  //   A) Pure 1-3 digit text in a descendant element's innerText.
  //   B) Descendant element with aria-label matching "unread/new messages/未读".
  //   C) Lines of innerText that contain new-message words like "new",
  //      "unread", "未读" (these are the "1 new" / "未读 1 条" strings that
  //      Google sometimes shows instead of a separated number badge).
  //
  // This function is the sole source of Space + unread truth for the state
  // machine; if it returns stale the whole monitor is dead.

  const results = [];
  const seen = new WeakSet();

  // Name of a sidebar item. Google Chat prepends an unread marker to the title
  // line when the space has unread messages, e.g. innerText:
  //   "Unread\nOnlyForTest Space\nOpen in a pop-up\nOptions"
  // or, when inlined:
  //   "Unread OnlyForTest Space\n..."
  // We therefore skip pure-noise / unread-marker lines and strip a leading
  // "Unread"/"New message"/"未读"/"新消息" token that may be glued to the title.
  function itemNameFromText(innerText) {
    const lines = (innerText || "").split(/\n/).map((s) => s.trim()).filter(Boolean);
    for (const raw of lines) {
      const low = raw.toLowerCase();
      if (
        /^(open in a pop-up|options|go back|back|you|google workspace tools|suggested contact|away|meeting conversation)$/.test(low)
      ) {
        continue;
      }
      if (/^(unread|new message|new messages|未读|新消息)$/.test(low)) {
        continue; // pure unread marker — the name is on a following line
      }
      // Strip a leading unread marker glued to the title ("Unread OnlyForTest Space")
      const stripped = raw
        .replace(/^(unread|new message|new messages|未读|新消息)[\s:：]+/i, "")
        .trim();
      if (stripped.length >= 2) return stripped;
    }
    return lines[0] || "";
  }

  // Detect whether a sidebar item has unread badge/messages.
  //
  // Google Chat DOM fact (verified against live markup): the SAME row carries a
  // persistent <span class="mL1cqe">Unread</span> label in BOTH the read and
  // unread states — it is only visually hidden via CSS when read. So the word
  // "Unread" is NOT a usable signal. The actual difference is:
  //   read:   preview container is empty, no numeric chip anywhere
  //   unread: a numeric chip (e.g. <span aria-hidden="true">1</span>) plus a
  //           "N Notification" line appears inside the preview container.
  // Therefore we ONLY trust (1) a small pure-number chip inside the row, and
  // (2) numbered/word unread markers that explicitly carry a count.
  function detectUnread(el) {
    const baseText = el.innerText || "";
    let hasUnread = false;
    let unreadCount = 0;
    const bump = (n) => {
      hasUnread = true;
      if (n > 0) unreadCount = Math.max(unreadCount, n);
    };

    // (A) Small pure-number descendant chip (the classic unread badge). Read
    // rows have none; unread rows carry one next to "N Notification".
    const smalls = el.querySelectorAll("span, div, b, strong, sup, sub");
    for (const s of smalls) {
      const t = (s.textContent || "").trim();
      if (!t) continue;
      if (/^\d{1,3}$/.test(t)) {
        const n = parseInt(t, 10);
        if (n > 0 && n < 1000) bump(n);
      }
    }

    // (B) ARIA / a11y badge labels carrying an unread/notification meaning.
    const labelTargets = el.querySelectorAll("*");
    for (const s of labelTargets) {
      const aria =
        (s.getAttribute && s.getAttribute("aria-label")) ||
        (s.getAttribute && s.getAttribute("title")) ||
        "";
      if (!aria) continue;
      if (/(unread|new\s+message|new\s+msg|notification|未读|新消息|新的消息)/i.test(aria)) {
        const m = aria.match(/(\d{1,3})/);
        bump(m ? parseInt(m[1], 10) : 1);
      }
    }

    // (C) Counted text markers in the row's own innerText, e.g. "1 Notification",
    // "(3)" at the end, "3 new messages", "2 未读", "5 条新消息".
    // Note: a bare "Unread" / "Notification" word WITHOUT any count is NOT
    // trusted alone (the row shows it even when read).
    if (!hasUnread) {
      const norm = baseText.replace(/\s+/g, " ").trim();
      const pm = norm.match(/\((\d{1,3})\)\s*$/);
      const nm = norm.match(
        /(\d{1,3})\s*(notifications?|new\b\s*messages?|unread|未读|条\s*新?消息)/i
      );
      if (pm || nm) {
        bump(pm ? parseInt(pm[1], 10) : parseInt(nm[1], 10));
      }
    }

    // (D) The "Notification" word is a strong unread signal on its own: the
    // user's original working script keyed on exactly this (space row text
    // contains "Notification" only while unread — read rows never render it).
    // The word sits in the unread preview area next to the numeric chip.
    if (!hasUnread) {
      const norm = baseText.replace(/\s+/g, " ").trim();
      if (/(?:^|[\s(])(notifications?)(?:[\s)]|$)/i.test(norm)) {
        const m = norm.match(/(\d{1,3})\s+notifications?/i);
        bump(m ? parseInt(m[1], 10) : 1);
      }
    }

    return { hasUnread, unreadCount };
  }

  // Elements that are clearly NOT sidebar space rows (main conversation panel,
  // composer, dialog). Excluding them stops reaction counts / message bodies
  // from being misread as unread badges.
  const BLOCKLIST_NAMES = new Set([
    "go back", "back", "options", "you",
    "google workspace tools", "open in a pop-up",
  ]);

  function collect(candidates) {
    if (!candidates) return;
    for (const el of candidates) {
      if (!el || seen.has(el)) continue;
      // Visibility guard: try a reasonable check, but softer than
      // offsetParent === null which kills wrapped spans.
      try {
        const rect = el.getBoundingClientRect
          ? el.getBoundingClientRect()
          : { width: 0, height: 0 };
        if (rect.width + rect.height === 0) continue;
        // Sidebar rows are small (roughly ≤560px wide, ≤140px tall). The main
        // conversation panel + composer for the OPEN space also carry the same
        // data-group-id, so drop anything conversation-sized.
        if (rect.height > 140 || rect.width > 560) continue;
      } catch (_) {}
      const text = el.innerText || "";
      const name = itemNameFromText(text);
      if (name.length < 2) continue;
      if (BLOCKLIST_NAMES.has(name.toLowerCase())) continue;

      // Dedupe by (name + first 100 chars of text). If two entries produce
      // the same visible "row" we keep the first match.
      const dedupeKey = name + "||" + text.slice(0, 100);
      if (results.findIndex((r) => r._key === dedupeKey) >= 0) continue;

      const { hasUnread, unreadCount } = detectUnread(el);
      seen.add(el);
      results.push({ name, hasUnread, unreadCount, el, _key: dedupeKey });
    }
  }

  // Priority 1: space data-group-id (most reliable).
  collect(document.querySelectorAll('[data-group-id^="space/"]'));
  // Priority 2: dm data-group-id (1:1 conversations are also watched as "spaces").
  collect(document.querySelectorAll('[data-group-id^="dm/"]'));
  // Priority 3: listitem items in body-sidebars (fallback if above attr ever removed).
  collect(document.querySelectorAll('[role="listitem"]'));

  // Strip private dedupe key before returning.
  return results.map(({ _key, ...rest }) => rest);
}

// Human label for a rule — the Space name it watches. Legacy fields
// (matchValue / ruleName) are tolerated until the rule is next saved.
function ruleLabel(rule) {
  return (rule && (rule.spaceName || rule.matchValue || rule.ruleName)) || rule.id || "space";
}

function ruleMatches(rule, space) {
  const name = (space.name || "").trim().toLowerCase();
  if (!name) return false;
  // Space name match, exact & case-insensitive. Comma separates multiple names.
  return ruleLabel(rule)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((v) => name === v.toLowerCase());
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
    const detail = [];
    for (const it of items) {
      if (ruleMatches(rule, it)) {
        if (it.hasUnread) {
          hasUnread = true;
          detail.push({
            n: it.name,
            u: it.unreadCount || 0,
            t: (it.el ? it.el.innerText : "").replace(/\s+/g, " ").slice(0, 120),
          });
        }
        count += it.unreadCount || 0;
      }
    }
    snapshot[rule.id] = { hasUnread, count, detail: detail.slice(0, 3) };
  }
  return snapshot;
}

/* ---------- Ring playback (background -> content) ---------- */

function playRingtone(dataUrl) {
  return new Promise((resolve) => {
    let audio;
    try {
      audio = new Audio(dataUrl);
    } catch (e) {
      resolve({ ok: false, reason: String(e) });
      return;
    }
    audio.volume = 1.0;
    audio.play().then(
      () => {
        // Keep the element referenced so GC doesn't cut playback short.
        _audioEls.push(audio);
        resolve({ ok: true });
      },
      (err) => {
        // Autoplay policies may block this until user interaction. Best-effort.
        log("play ring failed:", err && err.message);
        resolve({ ok: false, reason: (err && err.message) || "autoplay-blocked" });
      }
    );
    audio.addEventListener("ended", () => {
      const idx = _audioEls.indexOf(audio);
      if (idx >= 0) _audioEls.splice(idx, 1);
    });
  });
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
        ruleName: ruleLabel(rule),
        repeatIntervalSec: rule.repeatIntervalSec || 10,
        ringtoneId: rule.ringtoneId,
        spaceName: matchedName || ruleLabel(rule),
      },
      (resp) => {
        const ring = resp && resp.ring;
        if (ring && !ring.ok) {
          log("ring failed:", ring.reason || "unknown");
        }
        resolve(resp || { ok: false });
      }
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
      // Highest unread count this tab instance has already notified about.
      // New unread only rings when it EXCEEDS alertHigh, so a pre-existing
      // backlog at boot is treated as already-known (alertHigh == its count)
      // and never rings on its own. Seeing the space fully read resets it to 0.
      alertHigh: snap.count,
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
    const now = snap[rule.id] || { hasUnread: false, count: 0, detail: [] };
    let st = ruleState.get(rule.id);
    if (!st) {
      st = {
        state: "IDLE",
        lastUnread: now.count,
        repeatCount: 0,
        since: Date.now(),
        lastAlertAt: null,
        timer: null,
        alertHigh: now.count, // treat anything unread at wake-up as already-known
      };
      ruleState.set(rule.id, st);
    }

    const intervalSec = Math.max(1, rule.repeatIntervalSec || 10);
    const maxR = Math.max(1, rule.maxRepeats || 20);

    if (st.state === "IDLE") {
      if (!now.hasUnread && now.count === 0) {
        // Space fully read: disarm. The next 0→N is always a brand-new message.
        st.alertHigh = 0;
        st.lastUnread = 0;
      } else if (now.hasUnread && now.count > 0 && now.count > st.alertHigh) {
        // Genuine unread INCREASE → enter ALERTING and ring.
        st.state = "ALERTING";
        st.since = Date.now();
        st.lastAlertAt = Date.now();
        st.repeatCount = 1;
        st.alertHigh = now.count;
        stateChanged = true;
        const d = now.detail && now.detail[0];
        log(
          "new message detected → ring: " + ruleLabel(rule) +
          " (count=" + now.count + ")" +
          (d ? " culprit=" + JSON.stringify(d) : "")
        );
        alertRule(rule);
        // Install per-rule repeater timer.
        if (st.timer) clearInterval(st.timer);
        st.timer = setInterval(() => {
          const currentSt = ruleState.get(rule.id);
          if (!currentSt || currentSt.state !== "ALERTING") return;
          const s = snapshotRuleUnread();
          const cur = (s && s[rule.id]) || { hasUnread: false, count: 0 };
          if (!cur.hasUnread) {
            // Already read: go IDLE and disarm.
            currentSt.state = "IDLE";
            currentSt.lastUnread = 0;
            currentSt.repeatCount = 0;
            currentSt.alertHigh = 0;
            if (currentSt.timer) clearInterval(currentSt.timer);
            currentSt.timer = null;
            pushRuleStateToStorage();
            return;
          }
          currentSt.alertHigh = Math.max(currentSt.alertHigh || 0, cur.count);
          if (currentSt.repeatCount >= maxR) {
            // Reached the repeat cap while still unread: go IDLE but KEEP
            // alertHigh at the current count — the same unread state must
            // never re-trigger. Only a further INCREASE rings again.
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
      }
      // else: hasUnread but count <= alertHigh → old/known backlog, stay silent.
    } else if (st.state === "ALERTING") {
      if (!now.hasUnread) {
        // Unread cleared → back to IDLE and disarm.
        st.state = "IDLE";
        st.repeatCount = 0;
        st.lastAlertAt = null;
        st.alertHigh = 0;
        if (st.timer) clearInterval(st.timer);
        st.timer = null;
        stateChanged = true;
        log("read → IDLE: " + ruleLabel(rule));
      } else {
        // Still unread: keep tracking the highest count already notified.
        st.alertHigh = Math.max(st.alertHigh || 0, now.count);
      }
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

// There is deliberately NO master switch anymore. Monitoring is ON iff at least
// one rule is enabled (per-rule toggles in the sidepanel / options page). We
// track the previous value only to log transitions once (not per storage event).
let monitorEnabled = false;

function loadStorageAndBoot() {
  chrome.storage.local.get(["sreChatSpaceRules", "sreRingtones"], (data) => {
    rules = Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [];
    ringtones = Array.isArray(data.sreRingtones) ? data.sreRingtones : [];

    const wasEnabled = monitorEnabled;
    const nowEnabled = rules.some((r) => r.enabled);
    monitorEnabled = nowEnabled;

    // Full clean restart every time rules change: stop observers/pollers and
    // per-rule timers, then (re)start only if something is actually enabled.
    teardownRuleTimers();
    stopDetection();
    if (monitorEnabled) {
      const snap = snapshotRuleUnread();
      startRuleStateMachine(snap);
      startDetection();
      if (!wasEnabled) {
        log("monitoring started: " + rules.filter((r) => r.enabled).length + " rule(s) enabled");
      }
    } else {
      if (wasEnabled) log("monitoring stopped: no rule enabled");
    }
    pushRuleStateToStorage();
  });
}

// Reload the boot state only when the RULE LIST changes (user toggles/edits a
// rule). NOT on sreRingtones/sreChatMonitor writes — background updates
// sreChatMonitor.perRule on every state push/ring, and reacting to those would
// tear down and restart the whole monitor repeatedly.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sreChatSpaceRules) {
    loadStorageAndBoot();
  }
});

/* ---------- Message listener (background ring broadcast) ---------- */

let _msgListener = null;
function registerMessageListener() {
  if (_msgListener && chrome.runtime && chrome.runtime.onMessage) {
    try { chrome.runtime.onMessage.removeListener(_msgListener); } catch (_) {}
  }
  _msgListener = (msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type === MSG.PLAY_RING && msg.dataUrl) {
      // Report the REAL playback result back (ok:false when autoplay blocked).
      playRingtone(msg.dataUrl).then(sendResponse);
      return true; // async response
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(_msgListener);
}

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
  if (_msgListener && chrome.runtime && chrome.runtime.onMessage) {
    try { chrome.runtime.onMessage.removeListener(_msgListener); } catch (_) {}
    _msgListener = null;
  }
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.__SRE_CHAT_RUNNING__ = false;
  window.__SRE_CHAT_TEARDOWN__ = null;
}
window.__SRE_CHAT_TEARDOWN__ = teardownEverything;

function main() {
  registerMessageListener();
  unlockAutoplay();
  window.addEventListener("beforeunload", onBeforeUnload);
  startHeartbeat();
  loadStorageAndBoot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
})();
