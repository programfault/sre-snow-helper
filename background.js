// SRE Helper background service worker
// Opens the side panel on toolbar icon click; the panel persists across tab switches and page navigation.
// Also handles Chat Ring Monitor: tab heartbeat registry, deduplicated ring-trigger
// routing, offscreen-document ringtone playback, and "no gchat tab open" state reporting.

/* ---------- Storage seeding ---------- */

const DEFAULT_STORAGE = {
  srePlaybooks: [],
  sreForms: [],
  // Ringtones library: [{ id, name, durationSec, mime, dataUrl, sizeBytes, createdAt }]
  sreRingtones: [],
  // Chat monitor rules:
  // [{ id, spaceName, ringtoneId, repeatIntervalSec, maxRepeats, enabled, alertOnStartup }]
  // A rule matches a Chat space/dm whose sidebar name equals spaceName
  // (case-insensitive; comma separates multiple names).
  sreChatSpaceRules: [],
  // Master switch and runtime counters persisted so the sidepanel can render
  // a useful status even when all gchat tabs are closed.
  sreChatMonitor: {
    // User intent switch (storage source of truth).
    monitorEnabled: false,
    // Summary counters aggregated from heartbeat + alert events.
    todayDate: "",
    todayRings: 0,
    // per-rule runtime state: { <ruleId>: { state: "IDLE"|"ALERTING", lastAlertAt, repeatCount, since } }
    perRule: {},
  },
};

function seedDefaultStorage() {
  const keys = Object.keys(DEFAULT_STORAGE);
  chrome.storage.local.get(keys, (data) => {
    const updates = {};
    for (const [k, defaultVal] of Object.entries(DEFAULT_STORAGE)) {
      if (data[k] === undefined) updates[k] = structuredClone(defaultVal);
    }
    if (Object.keys(updates).length) chrome.storage.local.set(updates);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("Failed to set side panel behavior:", error));

  seedDefaultStorage();
  // Install-time rollover: reset today counters once on day change.
  rolloverDailyCounters();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("Failed to set side panel behavior:", error));
  seedDefaultStorage();
  rolloverDailyCounters();
});

/* ---------- Daily counter rollover ---------- */

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function rolloverDailyCounters() {
  chrome.storage.local.get("sreChatMonitor", (d) => {
    const state = d.sreChatMonitor || structuredClone(DEFAULT_STORAGE.sreChatMonitor);
    const today = todayYYYYMMDD();
    if (state.todayDate !== today) {
      state.todayDate = today;
      state.todayRings = 0;
      chrome.storage.local.set({ sreChatMonitor: state });
    }
  });
}

/* ---------- Tab heartbeat registry ---------- */

// In-memory only (SW can terminate; but content scripts re-register heartbeat
// on wake-up, so we rebuild this map). tabId -> { lastSeenAt, tabUrl }
const aliveTabs = new Map();
const HEARTBEAT_TIMEOUT_MS = 15000;

setInterval(() => {
  // Drop tabs with stale heartbeats (e.g. Chrome killed a tab w/o beforeunload firing).
  const now = Date.now();
  let removed = 0;
  for (const [id, info] of aliveTabs.entries()) {
    if (now - info.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      aliveTabs.delete(id);
      removed++;
    }
  }
  if (removed > 0) pushRuntimeStateToStorage();
}, 5000);

function pushRuntimeStateToStorage() {
  // We mirror per-rule runtime state into storage so the sidepanel can render
  // it. State lives primarily in content scripts; background only keeps the
  // authoritative "any gchat tab alive?" boolean + alert counts.
  // perRule updates come in via MSG_RULE_STATE_CHANGED messages from content scripts.
  chrome.storage.local.get("sreChatMonitor", (d) => {
    const state = d.sreChatMonitor || structuredClone(DEFAULT_STORAGE.sreChatMonitor);
    state._aliveTabCount = aliveTabs.size;
    state._lastHeartbeatAt = Date.now();
    chrome.storage.local.set({ sreChatMonitor: state });
  });
}

/* ---------- Rule state & ring event coordination ---------- */

// Per-rule "just rang" cooldown. Content scripts run their own dedupe per tab,
// but if two gchat tabs (e.g. work + personal) are open, both might fire for
// the same matched Space. We keep a cross-tab guard so a rule only produces
// one ring notification within `repeatIntervalSec` of the rule's value.
const lastFiredPerRule = new Map(); // ruleId -> timestamp

function shouldFireRule(ruleId, repeatIntervalSec) {
  const now = Date.now();
  const last = lastFiredPerRule.get(ruleId) || 0;
  const minGap = Math.max(1000, (repeatIntervalSec || 10) * 1000);
  if (now - last < minGap) return false;
  lastFiredPerRule.set(ruleId, now);
  return true;
}

/* ---------- Broadcast ring to a real audio player ---------- */

// MV3 audio: a service worker cannot play audio. Two routes exist for playing a
// ringtone:
//   1) Preferred: an offscreen document created with the AUDIO_PLAYBACK reason.
//      Chrome plays it unconditionally — it is NOT subject to the page autoplay
//      policy, so the ringtone rings even if the gchat tab was never clicked or
//      sits in the background (the case where "system notification arrived but
//      the chat page stayed silent").
//   2) Fallback: the alive gchat content scripts, which create an
//      HTMLAudioElement on the page.
const OFFSCREEN_URL = "offscreen.html";
let offscreenReady = false;

function playViaOffscreen(dataUrl) {
  return new Promise((resolve) => {
    const ask = () => {
      chrome.runtime.sendMessage(
        { type: "CHAT_PLAY_RING_OFFSCREEN", dataUrl },
        (resp) => {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, reason: "offscreen-not-listening" });
          }
          resolve(
            resp && resp.ok
              ? { ok: true }
              : { ok: false, reason: (resp && resp.reason) || "play-error" }
          );
        }
      );
    };

    if (offscreenReady) return ask();
    if (!chrome.offscreen) return resolve({ ok: false, reason: "offscreen-unavailable" });

    // chrome.offscreen APIs are promise-based. We treat createDocument as
    // best-effort: whether it created a fresh document or found the existing
    // one (createDocument errors in that case), we then just ask it to play.
    chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["AUDIO_PLAYBACK"],
        justification:
          "Play Google Chat ringtones when a monitored space gets a new unread message.",
      })
      .then(() => {
        offscreenReady = true;
        ask();
      })
      .catch(() => {
        // Most likely "Only a single offscreen document may be created" — a
        // document left over from an earlier SW session is still usable.
        offscreenReady = true;
        ask();
      });
  });
}

async function broadcastRing(ringtoneId, contentPid, triggerTabId) {
  if (!ringtoneId) return { ok: false, reason: "no-ringtone" };
  const data = await new Promise((res) =>
    chrome.storage.local.get("sreRingtones", (d) => res(d.sreRingtones || []))
  );
  const ring = data.find((r) => r.id === ringtoneId);
  if (!ring || !ring.dataUrl) return { ok: false, reason: "ringtone-missing" };

  // 1) Preferred: offscreen document (not gated by page autoplay policy).
  const off = await playViaOffscreen(ring.dataUrl);
  if (off && off.ok) return { ok: true, via: "offscreen", ringtoneName: ring.name };
  if (off && off.reason) console.log("[sre-chat] offscreen ring failed:", off.reason);

  // 2) Fallback: any alive gchat content script can create an HTMLAudioElement.
  let targetIds = [];
  if (triggerTabId != null) targetIds.push(triggerTabId);
  for (const id of aliveTabs.keys()) if (!targetIds.includes(id)) targetIds.push(id);

  if (targetIds.length === 0) {
    return { ok: false, reason: (off && off.reason) || "no-audio-target" };
  }

  const results = [];
  for (const id of targetIds) {
    try {
      const resp = await new Promise((res) => {
        chrome.tabs.sendMessage(
          id,
          {
            type: "CHAT_PLAY_RING",
            pid: contentPid || `${Date.now()}-${Math.random()}`,
            dataUrl: ring.dataUrl,
          },
          (r) => {
            if (chrome.runtime.lastError) res({ ok: false, reason: "send-error" });
            else res(r || { ok: false, reason: "no-response" });
          }
        );
      });
      results.push(resp);
      if (resp && resp.ok) break; // first-success short-circuit
    } catch (_) {}
  }

  const played = results.find((r) => r && r.ok);
  if (played) return { ok: true, via: "content", ringtoneName: ring.name };
  const last = results.length ? results[results.length - 1] : null;
  const reasons = [];
  if (off && off.ok === false && off.reason) reasons.push("offscreen:" + off.reason);
  reasons.push((last && last.reason) || "no-alive-tab");
  return { ok: false, reason: reasons.join(" | ") };
}

/* ---------- Message router (content script + sidepanel + options) ---------- */

const MSG = {
  HEARTBEAT: "CHAT_HEARTBEAT",
  TAB_GOING_AWAY: "CHAT_TAB_GOING_AWAY",
  TRY_RING: "CHAT_TRY_RING",
  RULE_STATE_CHANGED: "CHAT_RULE_STATE_CHANGED",
  GET_ALIVE_TAB_COUNT: "CHAT_GET_ALIVE_TAB_COUNT",
  OPEN_GCHAT_TAB: "CHAT_OPEN_GCHAT_TAB",
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // --- Heartbeat: register the sender tab as alive. ---
  if (msg.type === MSG.HEARTBEAT) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId != null) {
      aliveTabs.set(tabId, {
        lastSeenAt: Date.now(),
        tabUrl: (sender.tab && sender.tab.url) || "",
      });
      // Defer persistence so bursts of heartbeats don't write every 5s.
      pushRuntimeStateToStorage();
    }
    sendResponse({ ok: true, serverTime: Date.now() });
    return false;
  }

  // --- Tab going away: beforeunload fires this. ---
  if (msg.type === MSG.TAB_GOING_AWAY) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId != null) {
      aliveTabs.delete(tabId);
      pushRuntimeStateToStorage();
    }
    sendResponse({ ok: true });
    return false;
  }

  // --- A content script decided it should ring right now. ---
  // Route through the coordinator so multiple tabs don't duplicate, and then
  // route ring playback back to an alive tab for HTMLAudio playback.
  if (msg.type === MSG.TRY_RING) {
    (async () => {
      rolloverDailyCounters();
      const { ruleId, ruleName, repeatIntervalSec, ringtoneId, tabId } =
        msg || {};
      if (!shouldFireRule(ruleId, repeatIntervalSec)) {
        sendResponse({ ok: false, deduped: true });
        return;
      }

      // Bump today counters.
      chrome.storage.local.get("sreChatMonitor", (d) => {
        const state = d.sreChatMonitor || structuredClone(DEFAULT_STORAGE.sreChatMonitor);
        state.todayRings = (state.todayRings || 0) + 1;
        chrome.storage.local.set({ sreChatMonitor: state });
      });

      // Route the ringtone back to an audio player (offscreen doc preferred).
      const ringResp = await broadcastRing(ringtoneId, undefined, tabId || (sender && sender.tab ? sender.tab.id : undefined));
      if (ringResp && !ringResp.ok) {
        console.log("[sre-chat] ring failed for rule '" + (ruleName || ruleId) + "':", ringResp.reason);
      }
      sendResponse({ ok: true, ring: ringResp });
    })();
    return true; // async
  }

  // --- Per-rule state snapshot pushed by a content script so the sidepanel ---
  // can render the current IDLE/ALERTING state of each rule.
  if (msg.type === MSG.RULE_STATE_CHANGED) {
    const { updates } = msg || {};
    if (!updates) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.storage.local.get("sreChatMonitor", (d) => {
      const state = d.sreChatMonitor || structuredClone(DEFAULT_STORAGE.sreChatMonitor);
      state.perRule = state.perRule || {};
      Object.assign(state.perRule, updates);
      chrome.storage.local.set({ sreChatMonitor: state }, () => {
        sendResponse({ ok: true });
      });
    });
    return true; // async
  }

  // --- sidepanel wants a fresh count of alive gchat tabs. ---
  if (msg.type === MSG.GET_ALIVE_TAB_COUNT) {
    sendResponse({
      ok: true,
      aliveTabCount: aliveTabs.size,
      tabs: Array.from(aliveTabs.keys()),
    });
    return false;
  }

  // --- Side-panel "Open Google Chat" call-to-action. ---
  if (msg.type === MSG.OPEN_GCHAT_TAB) {
    try {
      chrome.tabs.create({ url: "https://chat.google.com", active: true }, () => {
        sendResponse({ ok: true });
      });
      return true; // async — tabs.create invokes callback
    } catch (_) {
      sendResponse({ ok: false });
      return false;
    }
  }

  return false;
});

/* ---------- ServiceNow incident context broker ---------- */
//
// snow-content.js (every service-now.com frame) reports partial snapshots of
// the record it sees: token (window.g_ck), instance, sysid, number. Multiple
// frames/tabs may report simultaneously — the classic UI splits data between
// the shell frame (token) and the #gsft_main form frame (sysid + number) — so
// we merge per tab and hand the SIDE PANEL the "best" snapshot:
//   * the snapshot of the ACTIVE ServiceNow tab if there is one, otherwise
//   * the most recently updated one.
// The side panel exposes it as the incident Info row and uses it to sign
// real PATCH requests (credentials include + X-UserToken).
const snowByTab = new Map(); // tabId -> merged ctx
let snowActiveTabId = null;

function snowFields(entry) {
  if (!entry) return null;
  const snap = {
    instance: entry.instance || null,
    token: entry.token || null,
    sysid: entry.sysid || null,
    number: entry.number || null,
  };
  return snap.instance || snap.token || snap.sysid || snap.number ? snap : null;
}

function snowSame(a, b) {
  return JSON.stringify(snowFields(a)) === JSON.stringify(snowFields(b));
}

function snowPickBest() {
  let best = null;
  if (snowActiveTabId != null && snowByTab.has(snowActiveTabId)) {
    best = snowByTab.get(snowActiveTabId);
  }
  if (!best) {
    // Most recent across all tabs.
    for (const entry of snowByTab.values()) {
      if (!best || entry.at > best.at) best = entry;
    }
  }
  return snowFields(best);
}

let snowLastBroadcast = null;
function snowBroadcast() {
  const best = snowPickBest();
  if (snowSame(snowLastBroadcast, best)) return;
  snowLastBroadcast = best;
  try {
    chrome.runtime
      .sendMessage({ type: "snow_ctx", ctx: best })
      .catch(() => {});
  } catch (_) {}
}

function snowMergeReport(tabId, ctx) {
  if (!ctx || typeof ctx !== "object") return;
  const prev = snowByTab.get(tabId) || {};
  const merged = {
    instance: ctx.instance || prev.instance || null,
    url: ctx.url || prev.url || "",
    at: ctx.at || Date.now(),
    token: ctx.token || prev.token || null,
    sysid: ctx.sysid || prev.sysid || null,
    number: ctx.number || prev.number || null,
  };
  snowByTab.set(tabId, merged);
  snowBroadcast();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // Content script (snow-content.js) reporting a record snapshot.
  if (msg.type === "snow_probe") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId != null) snowMergeReport(tabId, msg.ctx);
    sendResponse({ ok: true });
    return false;
  }

  // Side panel asking for the current best snapshot. If we have nothing (e.g.
  // the service worker restarted) poke the active ServiceNow tab to re-probe
  // and answer after it has had a moment to report back.
  if (msg.type === "snow_get_current") {
    let best = snowPickBest();
    if (!best && snowActiveTabId != null) {
      try {
        chrome.tabs.sendMessage(snowActiveTabId, { type: "snow_request_probe" });
      } catch (_) {}
      setTimeout(() => {
        sendResponse({ ok: true, ctx: snowPickBest() });
      }, 650);
      return true; // async
    }
    sendResponse({ ok: true, ctx: best });
    return false;
  }

  return false;
});

chrome.tabs.onActivated.addListener((info) => {
  snowActiveTabId = info.tabId;
  // If the newly focused tab is a ServiceNow tab, ask it to refresh so the
  // side panel Info row follows what the user is actually looking at.
  try {
    chrome.tabs.get(info.tabId, (tab) => {
      if (!tab || !tab.url) return;
      const url = String(tab.url || "");
      const isSnow =
        /^https:\/\/[^/]*service-now\.com\//.test(url);
      if (isSnow) {
        try {
          chrome.tabs.sendMessage(info.tabId, { type: "snow_request_probe" });
        } catch (_) {}
      }
    });
  } catch (_) {}
  snowBroadcast();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (snowByTab.delete(tabId)) snowBroadcast();
  if (snowActiveTabId === tabId) snowActiveTabId = null;
});
