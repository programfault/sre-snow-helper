// SRE Helper background service worker
// Opens the side panel on toolbar icon click; the panel persists across tab switches and page navigation.
// Also handles Chat Ring Monitor: tab heartbeat registry, desktop notifications, deduplicated
// ring-trigger routing, and "no gchat tab open" state reporting.

/* ---------- Storage seeding ---------- */

const DEFAULT_STORAGE = {
  sreConfig: {
    displayName: "SRE",
    refreshInterval: 30,
    enableNotifications: true,
    theme: "light",
    apiEndpoint: "",
  },
  sreComponents: [],
  srePlaybooks: [],
  sreForms: [],
  // Ringtones library: [{ id, name, durationSec, mime, dataUrl, sizeBytes, createdAt }]
  sreRingtones: [],
  // Chat monitor rules:
  // [{ id, ruleName, matchType (exact|contains|selector), matchValue,
  //    ringtoneId, repeatIntervalSec, maxRepeats, enabled, alertOnStartup }]
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
    // sreComponents migration (sreCommons -> sreComponents).
    if (data.sreComponents === undefined) {
      updates.sreComponents = Array.isArray(data.sreCommons)
        ? data.sreCommons
        : [];
    }
    for (const [k, defaultVal] of Object.entries(DEFAULT_STORAGE)) {
      if (k === "sreComponents") continue;
      if (data[k] === undefined) updates[k] = structuredClone(defaultVal);
    }
    if (Object.keys(updates).length) chrome.storage.local.set(updates);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("Failed to set side panel behavior:", error));

  // Request notification permission up-front for MV3 SW (Notification permissions
  // are extension-level — if the user previously granted it stays granted).
  if (chrome.notifications && typeof chrome.notifications.getPermissionLevel === "function") {
    try {
      chrome.notifications.getPermissionLevel((level) => {
        if (level !== "granted") {
          console.log("[sre-chat] notification level:", level);
        }
      });
    } catch (_) {}
  }

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

/* ---------- Desktop notifications ---------- */

let notifIdCounter = 0;

function showDesktopNotification(ruleName, spaceName, ruleId) {
  if (!chrome.notifications) return;
  const id = `sre-chat-${ruleId}-${++notifIdCounter}-${Date.now()}`;
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: ruleName ? `${ruleName} — new message` : "Google Chat — new message",
      message: spaceName
        ? `Space "${spaceName}" has unread messages.`
        : `A watched Google Chat space has new unread messages.`,
      priority: 2,
      requireInteraction: true,
    });
  } catch (e) {
    // iconUrl might not resolve in some environments; fall back to no-icon creation.
    try {
      chrome.notifications.create(id, {
        type: "basic",
        title: ruleName || "Google Chat — new message",
        message: spaceName || "New unread message.",
        priority: 2,
        requireInteraction: true,
      });
    } catch (_) {}
  }
}

/* ---------- Broadcast ring to content scripts ---------- */

// Audio playback in MV3: a service worker can't play audio directly. We route
// the signal back to one of the content scripts; it creates an HTMLAudioElement
// on the page context (where autoplay is safe after user interaction) and plays
// the provided data URL.
async function broadcastRing(ringtoneId, contentPid, triggerTabId) {
  if (!ringtoneId) return { ok: false, reason: "no-ringtone" };
  const data = await new Promise((res) =>
    chrome.storage.local.get("sreRingtones", (d) => res(d.sreRingtones || []))
  );
  const ring = data.find((r) => r.id === ringtoneId);
  if (!ring || !ring.dataUrl) return { ok: false, reason: "ringtone-missing" };

  // Find alive gchat tabs (any URL under chat.google.com). Prefer the tab that
  // triggered the event so the sound is tied to the page with the new message.
  let targetIds = [];
  if (triggerTabId != null) targetIds.push(triggerTabId);
  for (const id of aliveTabs.keys()) if (!targetIds.includes(id)) targetIds.push(id);

  if (targetIds.length === 0) return { ok: false, reason: "no-alive-tab" };

  // Send to all alive tabs. Each content script dedupes internally via
  // chrome.runtime.sendMessage({type:MSG_PLAY_RING}) and returns once.
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
            if (chrome.runtime.lastError) {
              res({ ok: false, reason: "send-error" });
            } else {
              res(r || { ok: true });
            }
          }
        );
      });
      results.push(resp);
      if (resp && resp.ok) break; // first-success short-circuit
    } catch (_) {}
  }

  const ok = results.some((r) => r && r.ok);
  return { ok, ringtoneName: ring.name };
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
      const { ruleId, ruleName, repeatIntervalSec, ringtoneId, spaceName, tabId } =
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

      // Desktop notification (best effort).
      showDesktopNotification(ruleName, spaceName, ruleId);

      // Route ring back to an alive tab to actually play audio.
      const ringResp = await broadcastRing(ringtoneId, undefined, tabId || (sender && sender.tab ? sender.tab.id : undefined));
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
