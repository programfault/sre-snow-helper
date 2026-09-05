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
// the record it sees: token (window.g_ck), instance, sysid, number, and on the
// form also caller sysid/name. Multiple frames/tabs may report simultaneously —
// the classic UI splits data between the shell frame (token) and the
// #gsft_main form frame (sysid + number) — so we merge per tab.
//
// Context is ACTIVE-RELATIVE: the side panel only sees the snapshot of the tab
// the user is actually looking at (live ctx), and a null is broadcast the
// moment the active tab leaves a ServiceNow page. A separate "last" ctx keeps
// the most recent non-empty snapshot for the Options Environment page, which
// must keep showing values even while that page (not a SN page) is open.
const snowByTab = new Map(); // tabId -> merged ctx
let snowLastCtx = null; // last non-empty snapshot (Options Environment page)

// Single source of truth for "which tab the user is looking at right now".
// Both the ServiceNow and the FSM brokers resolve their LIVE context against
// this tab, so switching to a non-source tab clears that source instantly.
let activeTabInfo = { id: null, url: "" };

function isSnowUrl(url) {
  return /^https:\/\/[^/]*service-now\.com\//.test(String(url || ""));
}

function snowFields(entry) {
  if (!entry) return null;
  const snap = {
    instance: entry.instance || null,
    token: entry.token || null,
    sysid: entry.sysid || null,
    number: entry.number || null,
    callerSysid: entry.callerSysid || null,
    callerName: entry.callerName || null,
  };
  return snap.instance || snap.token || snap.sysid || snap.number ||
    snap.callerSysid || snap.callerName
    ? snap
    : null;
}

function snowSame(a, b) {
  return JSON.stringify(snowFields(a)) === JSON.stringify(snowFields(b));
}

// Live context = snapshot of the ACTIVE tab, but only while that tab is on a
// ServiceNow page. Any other active tab (chat, docs, options page, new tab…)
// yields null so the side panel clears instantly instead of resurrecting an
// older captured value.
function snowLive() {
  const a = activeTabInfo;
  if (a.id != null && isSnowUrl(a.url) && snowByTab.has(a.id)) {
    return snowFields(snowByTab.get(a.id));
  }
  return null;
}

function snowRemember(fields) {
  snowLastCtx = fields;
  try {
    chrome.storage.local.set({ sreSnowLastCtx: fields }).catch(() => {});
  } catch (_) {}
}

let snowLastBroadcast = null;
function snowBroadcast() {
  const live = snowLive();
  if (snowSame(snowLastBroadcast, live)) return;
  snowLastBroadcast = live;
  try {
    chrome.runtime
      .sendMessage({ type: "snow_ctx", ctx: live })
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
    callerSysid: ctx.callerSysid || prev.callerSysid || null,
    callerName: ctx.callerName || prev.callerName || null,
  };
  snowByTab.set(tabId, merged);
  // Any non-empty capture refreshes the "last" snapshot for the Options page,
  // no matter whether its tab is the currently active one.
  const fields = snowFields(merged);
  if (fields) snowRemember(fields);
  snowBroadcast();
}

/* ---------- FSM order-page context broker (globe.com.ph / gsmgt-prod.gobetel.com) ---------- */
//
// goble-content.js reports the order fields visible on the current FSM order
// page (fwo = OrderNumber, fsid = serviceid, factok = accesstoken). Pages that
// cannot extract a field report it as "" so a plain page clears stale values.
// Two hosts run the same app: globe.com.ph (+ subdomains) and, matched exactly,
// gsmgt-prod.gobetel.com. This broker mirrors the ServiceNow one: merge per
// tab, broadcast the ACTIVE tab's snapshot as "goble_ctx" (null once the active
// tab leaves an FSM page), and keep a "last" non-empty snapshot for the Options
// Environment page. The side panel exposes the fields as ${f_wo_number} /
// ${f_sid} / ${f_access_token} variables usable from any YAML document.
const gobleByTab = new Map(); // tabId -> merged ctx
let gobleLastCtx = null; // last non-empty snapshot (Options Environment page)

function gobleHostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
}

function isGobleUrl(url) {
  const h = gobleHostOf(String(url || ""));
  return (
    h === "globe.com.ph" ||
    h.endsWith(".globe.com.ph") ||
    h === "gsmgt-prod.gobetel.com" // exact host; second FSM order site
  );
}

function gobleFields(entry) {
  if (!entry) return null;
  const snap = {
    fwo: entry.fwo || null,
    fsid: entry.fsid || null,
    factok: entry.factok || null,
  };
  return snap.fwo || snap.fsid || snap.factok ? snap : null;
}

function gobleSame(a, b) {
  return JSON.stringify(gobleFields(a)) === JSON.stringify(gobleFields(b));
}

// Live context = snapshot of the ACTIVE tab, but only while that tab is on an
// FSM order page. Any other active tab yields null so the side panel clears.
function gobleLive() {
  const a = activeTabInfo;
  if (a.id != null && isGobleUrl(a.url) && gobleByTab.has(a.id)) {
    return gobleFields(gobleByTab.get(a.id));
  }
  return null;
}

function gobleRemember(fields) {
  gobleLastCtx = fields;
  try {
    chrome.storage.local.set({ sreGobleLastCtx: fields }).catch(() => {});
  } catch (_) {}
}

let gobleLastBroadcast = null;
function gobleBroadcast() {
  const live = gobleLive();
  if (gobleSame(gobleLastBroadcast, live)) return;
  gobleLastBroadcast = live;
  try {
    chrome.runtime
      .sendMessage({ type: "goble_ctx", ctx: live })
      .catch(() => {});
  } catch (_) {}
}

function gobleMergeReport(tabId, ctx) {
  if (!ctx || typeof ctx !== "object") return;
  const prev = gobleByTab.get(tabId) || {};
  const merged = {
    url: ctx.url || prev.url || "",
    at: ctx.at || Date.now(),
    // Content script always sends the three keys (possibly ""); overwrite so a
    // goble page that shows no field clears the earlier captured value.
    fwo: ctx.fwo !== undefined ? ctx.fwo : prev.fwo || "",
    fsid: ctx.fsid !== undefined ? ctx.fsid : prev.fsid || "",
    factok: ctx.factok !== undefined ? ctx.factok : prev.factok || "",
  };
  gobleByTab.set(tabId, merged);
  const fields = gobleFields(merged);
  if (fields) gobleRemember(fields);
  gobleBroadcast();
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

  // Content script (goble-content.js) reporting an order-page snapshot.
  if (msg.type === "goble_probe") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId != null) gobleMergeReport(tabId, msg.ctx);
    sendResponse({ ok: true });
    return false;
  }

  // Side panel asking for the current LIVE snapshot (active tab only). If the
  // active tab is a ServiceNow page but we have nothing cached yet (e.g. the
  // service worker restarted) poke that tab to re-probe and answer after it has
  // had a moment to report back.
  if (msg.type === "snow_get_current") {
    const live = snowLive();
    if (!live && activeTabInfo.id != null && isSnowUrl(activeTabInfo.url)) {
      try {
        chrome.tabs.sendMessage(activeTabInfo.id, { type: "snow_request_probe" });
      } catch (_) {}
      setTimeout(() => {
        sendResponse({ ok: true, ctx: snowLive() });
      }, 650);
      return true; // async
    }
    sendResponse({ ok: true, ctx: live });
    return false;
  }

  // FSM twin of snow_get_current.
  if (msg.type === "goble_get_current") {
    const live = gobleLive();
    if (!live && activeTabInfo.id != null && isGobleUrl(activeTabInfo.url)) {
      try {
        chrome.tabs.sendMessage(activeTabInfo.id, { type: "goble_request_probe" });
      } catch (_) {}
      setTimeout(() => {
        sendResponse({ ok: true, ctx: gobleLive() });
      }, 650);
      return true; // async
    }
    sendResponse({ ok: true, ctx: live });
    return false;
  }

  // Options Environment page: query the "last" snapshot (most recent non-empty
  // capture), which does NOT clear when the active tab switches away. Falls
  // back to storage if this freshly-woken service worker never saw a capture.
  if (msg.type === "snow_get_last") {
    if (snowLastCtx) {
      sendResponse({ ok: true, ctx: snowLastCtx });
      return false;
    }
    chrome.storage.local.get("sreSnowLastCtx", (d) => {
      snowLastCtx = (d && d.sreSnowLastCtx) || null;
      sendResponse({ ok: true, ctx: snowLastCtx });
    });
    return true; // async
  }

  // FSM twin of snow_get_last.
  if (msg.type === "goble_get_last") {
    if (gobleLastCtx) {
      sendResponse({ ok: true, ctx: gobleLastCtx });
      return false;
    }
    chrome.storage.local.get("sreGobleLastCtx", (d) => {
      gobleLastCtx = (d && d.sreGobleLastCtx) || null;
      sendResponse({ ok: true, ctx: gobleLastCtx });
    });
    return true; // async
  }

  // Manual refresh (Options Environment page): always re-poke a live
  // ServiceNow tab (active one preferred) so stale/empty snapshots are
  // re-probed right away instead of returning whatever is cached.
  if (msg.type === "snow_refresh") {
    chrome.tabs.query({ url: "https://*.service-now.com/*" }, (tabs) => {
      const list = tabs || [];
      const target =
        list.find((t) => t.id === activeTabInfo.id) || list[0] || null;
      if (target) {
        try {
          chrome.tabs.sendMessage(target.id, { type: "snow_request_probe" });
        } catch (_) {}
      }
      setTimeout(() => {
        sendResponse({ ok: true, ctx: snowLive() });
      }, target ? 800 : 0);
    });
    return true; // async
  }

  // FSM twin of snow_refresh.
  if (msg.type === "goble_refresh") {
    chrome.tabs.query(
      {
        url: [
          "*://globe.com.ph/*",
          "*://*.globe.com.ph/*",
          "https://gsmgt-prod.gobetel.com/*",
        ],
      },
      (tabs) => {
        const list = tabs || [];
        const target =
          list.find((t) => t.id === activeTabInfo.id) || list[0] || null;
        if (target) {
          try {
            chrome.tabs.sendMessage(target.id, { type: "goble_request_probe" });
          } catch (_) {}
        }
        setTimeout(() => {
          sendResponse({ ok: true, ctx: gobleLive() });
        }, target ? 800 : 0);
      }
    );
    return true; // async
  }

  // Side panel adding labels: forward each picked label name to the active
  // ServiceNow tab's content script, which simulates typing it into the page's
  // tag-it widget (same as adding the label by hand). Active SN tab preferred,
  // first ServiceNow tab as fallback — same targeting as snow_refresh.
  if (msg.type === "snow_add_tags") {
    const names = Array.isArray(msg.names)
      ? msg.names.map((n) => String(n))
      : [];
    chrome.tabs.query({ url: "https://*.service-now.com/*" }, (tabs) => {
      const list = tabs || [];
      const target =
        list.find((t) => t.id === activeTabInfo.id) || list[0] || null;
      if (!target) {
        sendResponse({
          ok: false,
          error: "No ServiceNow tab is open. Open the incident page and try again.",
        });
        return;
      }
      try {
        chrome.tabs.sendMessage(
          target.id,
          { type: "snow_add_tags", names },
          (resp) => {
            if (chrome.runtime.lastError || !resp) {
              sendResponse({
                ok: false,
                error:
                  "The ServiceNow tab is not ready. Reload the incident page and try again.",
              });
              return;
            }
            sendResponse({ ok: true, result: resp.result || resp });
          }
        );
      } catch (err) {
        sendResponse({
          ok: false,
          error: String((err && err.message) || err),
        });
      }
    });
    return true; // async
  }

  return false;
});

chrome.tabs.onActivated.addListener((info) => {
  activeTabInfo = { id: info.tabId, url: "" };
  // Resolve the newly focused tab's URL, poke it to re-probe if it is one of
  // our capture sites, then broadcast the new live context (null for sources
  // the active tab is not on, so the side panel clears instantly).
  try {
    chrome.tabs.get(info.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      const url = String(tab.url || "");
      activeTabInfo.url = url;
      if (isSnowUrl(url)) {
        try {
          chrome.tabs.sendMessage(info.tabId, { type: "snow_request_probe" });
        } catch (_) {}
      }
      // Same for an FSM order page (goble globals track it live).
      if (isGobleUrl(url)) {
        try {
          chrome.tabs.sendMessage(info.tabId, { type: "goble_request_probe" });
        } catch (_) {}
      }
      snowBroadcast();
      gobleBroadcast();
    });
  } catch (_) {
    snowBroadcast();
    gobleBroadcast();
  }
});

// Same-tab navigation: if the ACTIVE tab navigates away from a capture site
// (e.g. an FSM order page redirects to a plain web page), its live context must
// clear right away — the probe content script is gone and would never report.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabInfo.id) return;
  const newUrl = changeInfo && changeInfo.url;
  if (!newUrl) return;
  activeTabInfo.url = String(newUrl);
  snowBroadcast();
  gobleBroadcast();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (snowByTab.delete(tabId)) snowBroadcast();
  if (gobleByTab.delete(tabId)) gobleBroadcast();
  if (activeTabInfo.id === tabId) activeTabInfo = { id: null, url: "" };
});
