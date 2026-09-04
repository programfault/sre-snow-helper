// SRE Helper side panel — playbook execution UI
//
// Hierarchy:
//   mega-panel (collapsible) ─ wraps all playbooks
//     └─ pb-card (collapsible) per playbook
//         ├─ params form (generated from the playbook's `params:` block)
//         ├─ steps list (ref steps show the referenced name; inline steps
//         │   show name + desc)
//         └─ Execute button — collects param values, resolves ${placeholders},
//             and renders each step's final form (HTTP body preview).

const Y = SRE_YAML;

// UI state persisted in chrome.storage.local.
let srePanelState = { megaCollapsed: {}, cardCollapsed: {} };

const contentEl = document.getElementById("content");
const openOptionsBtn = document.getElementById("openOptions");

openOptionsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

/* ---------- Storage ---------- */

function loadState(cb) {
  chrome.storage.local.get(
    [
      "sreConfig",
      "srePlaybooks",
      "sreComponents",
      "srePanelState",
      "sreChatSpaceRules",
      "sreRingtones",
      "sreChatMonitor",
    ],
    (data) => {
      const config = data.sreConfig || {};
      // Theme
      if (config.theme === "dark") document.body.classList.add("dark");
      else document.body.classList.remove("dark");
      // Panel state
      srePanelState = data.srePanelState || {
        megaCollapsed: {},
        cardCollapsed: {},
      };
      cb({
        playbooks: Array.isArray(data.srePlaybooks) ? data.srePlaybooks : [],
        components: Array.isArray(data.sreComponents)
          ? data.sreComponents
          : [],
        chatRules: Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [],
        ringtones: Array.isArray(data.sreRingtones) ? data.sreRingtones : [],
        chatMonitor: data.sreChatMonitor || { monitorEnabled: false, perRule: {}, todayRings: 0, todayDate: "" },
      });
    }
  );
}

function persistState() {
  chrome.storage.local.set({ srePanelState: srePanelState });
}

/* ---------- Chat Ring Monitor (side panel UI) ---------- */

function ringtoneName(ringtones, ringtoneId) {
  const r = ringtones.find((x) => x.id === ringtoneId);
  return r ? r.name : "(none)";
}

function setChatMonitorEnabled(nextEnabled) {
  chrome.storage.local.get("sreChatMonitor", (d) => {
    const cur = d.sreChatMonitor || { monitorEnabled: false };
    cur.monitorEnabled = Boolean(nextEnabled);
    chrome.storage.local.set({ sreChatMonitor: cur });

    // If turning on but no alive tabs, toast a call-to-action.
    if (nextEnabled) {
      try {
        chrome.runtime.sendMessage({ type: "CHAT_GET_ALIVE_TAB_COUNT" }, (resp) => {
          const count = resp && typeof resp.aliveTabCount === "number" ? resp.aliveTabCount : 0;
          if (count === 0) {
            toast.info(
              "Monitor enabled",
              "No chat.google.com tab is open. Open Google Chat to start monitoring."
            );
          }
        });
      } catch (_) {}
    }
  });
}

function openChatTab() {
  try {
    chrome.runtime.sendMessage({ type: "CHAT_OPEN_GCHAT_TAB" });
  } catch (_) {}
}

function renderChatMonitorPanel(rules, monitor, ringtones) {
  const globalEnabled = rules.some((r) => r.enabled);
  const perRule = monitor.perRule || {};
  const aliveTabCount = typeof monitor._aliveTabCount === "number" ? monitor._aliveTabCount : -1;
  const ringtoneLib = ringtones || [];

  // Root uses the same mega-panel class as Playbooks for visual parity.
  const panel = document.createElement("div");
  panel.className = "mega-panel chat-monitor-mega";

  // --- Header (mirrors Playbooks mega-header style exactly) ---
  // Layout: [toggle | title (flex:1) | status-dot | count pill]
  const head = document.createElement("div");
  head.className = "mega-header chat-monitor-head";

  const toggle = document.createElement("span");
  toggle.className = "mega-toggle chat-monitor-toggle";
  const collapsedKey = "chatMonitor";
  const isCollapsed = srePanelState.megaCollapsed && srePanelState.megaCollapsed[collapsedKey] === true;
  if (isCollapsed) panel.classList.add("collapsed");
  toggle.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>`;
  head.appendChild(toggle);

  const title = document.createElement("span");
  title.className = "mega-title";
  title.style.flex = "1";
  title.style.minWidth = "0";
  title.textContent = "Chat Ring Monitor";
  head.appendChild(title);

  // Right side: status dot (first — visually attached to count pill) + count pill.
  const dot = document.createElement("span");
  dot.className = "monitor-status-dot";
  dot.style.marginRight = "6px";
  if (!globalEnabled) dot.classList.add("off");
  head.appendChild(dot);

  const ruleCount = rules.length;
  const enabledCount = rules.filter((r) => r.enabled).length;
  const count = document.createElement("span");
  count.className = "mega-count";
  count.textContent = `${enabledCount} / ${ruleCount} rules`;
  head.appendChild(count);

  // Collapse toggling
  head.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    if (!srePanelState.megaCollapsed) srePanelState.megaCollapsed = {};
    srePanelState.megaCollapsed[collapsedKey] = panel.classList.contains("collapsed");
    persistState();
  });

  panel.appendChild(head);

  // --- Body ---
  const body = document.createElement("div");
  body.className = "mega-body chat-monitor-body";

  // Top banner: no tab / disabled coverage / enabled info.
  const anyEnabled = enabledCount > 0;
  if (anyEnabled && aliveTabCount === 0) {
    const warn = document.createElement("div");
    warn.className = "chat-tab-warning";
    const wLeft = document.createElement("div");
    wLeft.style.display = "flex"; wLeft.style.alignItems = "center";
    wLeft.style.gap = "8px"; wLeft.style.flex = "1"; wLeft.style.minWidth = "0";
    const ic = document.createElement("span");
    ic.textContent = "⚠";
    ic.style.fontSize = "14px";
    ic.style.flexShrink = "0";
    const wText = document.createElement("div");
    wText.innerHTML = `<b>No chat.google.com tab is open.</b><br><small>Monitoring starts once a tab is open.</small>`;
    wLeft.appendChild(ic); wLeft.appendChild(wText);
    const openBtn = document.createElement("button");
    openBtn.className = "row-btn";
    openBtn.textContent = "Open Chat";
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openChatTab();
    });
    warn.appendChild(wLeft); warn.appendChild(openBtn);
    body.appendChild(warn);
  } else if (anyEnabled && aliveTabCount > 0) {
    const info = document.createElement("div");
    info.className = "chat-tab-info";
    info.innerHTML = `Monitoring ${aliveTabCount} Google Chat tab${aliveTabCount === 1 ? "" : "s"}.`;
    body.appendChild(info);
  } else if (!anyEnabled) {
    const info = document.createElement("div");
    info.className = "chat-tab-info chat-tab-info-muted";
    info.textContent = "No rule is enabled. Turn on a rule below to start monitoring. Create rules in options → Chat Spaces.";
    body.appendChild(info);
  }

  // --- Per-rule list: row = (name, match) + state badge + per-rule switch. ---
  const listLab = document.createElement("div");
  listLab.className = "section-label";
  listLab.textContent = "Rules";
  body.appendChild(listLab);

  const list = document.createElement("div");
  list.className = "chat-rule-status-list";

  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pb-card chat-rule-empty";
    empty.style.textAlign = "center";
    empty.style.padding = "20px 0";
    empty.style.color = "var(--muted)";
    empty.style.fontSize = "12px";
    empty.textContent = "No rules yet. Open options → Chat Spaces to create a rule.";
    list.appendChild(empty);
  } else {
    for (const rule of rules) {
      const item = document.createElement("div");
      item.className = "pb-card chat-rule-status-item";
      item.style.padding = "10px 12px";
      item.style.gap = "12px";
      const left = document.createElement("div");
      left.className = "chat-rule-left";
      left.style.minWidth = "0";
      const row1 = document.createElement("div");
      row1.style.fontWeight = "600";
      row1.style.fontSize = "13px";
      row1.textContent = rule.spaceName || rule.matchValue || rule.ruleName || "(unnamed)";
      const row2 = document.createElement("div");
      row2.className = "chat-rule-meta";
      const rtName = ringtoneName(ringtoneLib, rule.ringtoneId);
      if (rtName && rtName !== "(none)") row2.textContent = "ringtone · " + rtName;
      left.appendChild(row1); left.appendChild(row2);

      const rightRow = document.createElement("div");
      rightRow.style.display = "flex";
      rightRow.style.alignItems = "center";
      rightRow.style.gap = "10px";

      // State badge (left of switch)
      const stateBadge = document.createElement("span");
      let badgeText = "DISABLED", badgeClass = "state-badge-off";
      if (rule.enabled) {
        const rs = perRule[rule.id];
        if (rs && rs.state === "ALERTING") {
          badgeText = "ALERTING";
          badgeClass = "state-badge-alert";
        } else {
          badgeText = globalEnabled ? "IDLE" : "PAUSED";
          badgeClass = "state-badge-idle";
        }
      }
      stateBadge.className = `chat-rule-badge ${badgeClass}`;
      stateBadge.textContent = badgeText;
      rightRow.appendChild(stateBadge);

      // Per-rule switch (controls rule.enabled).
      const sw = document.createElement("label");
      sw.className = "monitor-switch";
      const swIn = document.createElement("input");
      swIn.type = "checkbox";
      swIn.checked = Boolean(rule.enabled);
      swIn.addEventListener("change", () => toggleRuleEnabled(rule.id, swIn.checked));
      const swT = document.createElement("span");
      swT.className = "monitor-slider";
      sw.appendChild(swIn); sw.appendChild(swT);
      rightRow.appendChild(sw);

      item.appendChild(left);
      item.appendChild(rightRow);
      list.appendChild(item);
    }
  }
  body.appendChild(list);

  panel.appendChild(body);
  return panel;
}

// Flip rule.enabled in storage; options page and content scripts read it in real time.
function toggleRuleEnabled(ruleId, next) {
  chrome.storage.local.get("sreChatSpaceRules", (d) => {
    const arr = Array.isArray(d.sreChatSpaceRules) ? d.sreChatSpaceRules : [];
    const nextArr = arr.map((r) =>
      r.id === ruleId ? { ...r, enabled: Boolean(next) } : r
    );
    chrome.storage.local.set({ sreChatSpaceRules: nextArr });
  });
}

/* ---------- Rendering ---------- */

function render(data) {
  const playbooks = data.playbooks || [];
  const components = data.components || [];
  const chatRules = data.chatRules || [];
  const chatMonitor = data.chatMonitor || { monitorEnabled: false, perRule: {}, todayRings: 0, _aliveTabCount: 0 };

  contentEl.innerHTML = "";

  // 1) Chat Ring Monitor — appears above the Playbooks mega panel.
  contentEl.appendChild(renderChatMonitorPanel(chatRules, chatMonitor, data.ringtones || []));

  // 2) Playbooks mega panel.
  if (!playbooks || playbooks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "No playbooks configured.<br>Open options to create one.";
    contentEl.appendChild(empty);
    return;
  }

  const componentsByName = Y.indexComponents(components);

  // --- Mega panel ---
  const mega = document.createElement("div");
  mega.className = "mega-panel";
  // Persisted collapsed state (default: expanded).
  const megaCollapsed = srePanelState.megaCollapsed.all === true;
  if (megaCollapsed) mega.classList.add("collapsed");

  const megaHeader = document.createElement("div");
  megaHeader.className = "mega-header";
  megaHeader.innerHTML = `
    <span class="mega-toggle">
      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </span>
    <span class="mega-title">Playbooks</span>
    <span class="mega-count">${playbooks.length}</span>
  `;
  megaHeader.addEventListener("click", () => {
    mega.classList.toggle("collapsed");
    srePanelState.megaCollapsed.all = mega.classList.contains("collapsed");
    persistState();
  });

  const megaBody = document.createElement("div");
  megaBody.className = "mega-body";

  playbooks.forEach((pb) => {
    megaBody.appendChild(renderPlaybookCard(pb, componentsByName));
  });

  mega.appendChild(megaHeader);
  mega.appendChild(megaBody);
  contentEl.appendChild(mega);
}

function renderPlaybookCard(pb, componentsByName) {
  const yaml = pb.yaml || "";
  const header = Y.parseHeader(yaml);
  const params = Y.parseParams(yaml);
  const steps = Y.parseSteps(yaml);

  const card = document.createElement("div");
  card.className = "pb-card";
  const cardCollapsed = srePanelState.cardCollapsed[pb.id] === true;
  if (cardCollapsed) card.classList.add("collapsed");

  // --- Card header ---
  const cardHeader = document.createElement("div");
  cardHeader.className = "pb-card-header";
  cardHeader.innerHTML = `
    <span class="pb-card-toggle">
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </span>
    <div class="pb-card-meta">
      <div class="pb-card-name"></div>
      <div class="pb-card-desc"></div>
    </div>
  `;
  cardHeader.querySelector(".pb-card-name").textContent =
    header.name || "(unnamed)";
  cardHeader.querySelector(".pb-card-desc").textContent = header.desc || "";
  cardHeader.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    srePanelState.cardCollapsed[pb.id] = card.classList.contains("collapsed");
    persistState();
  });

  // --- Card body ---
  const cardBody = document.createElement("div");
  cardBody.className = "pb-card-body";

  // Unified Parameters section: collect playbook-level params AND every ref
  // step's referenced-component params into one form, each row tagged with a
  // source badge so the user knows where each input comes from.
  const paramRows = [];
  // Playbook-level params (data-param="param0", "param1", ...).
  params.forEach((p, idx) => {
    paramRows.push({
      badge: "playbook",
      label: p.name,
      key: `param${idx}`,
    });
  });
  // Component-level params from ref steps (data-param="cparam-{stepIdx}-{pIdx}").
  steps.forEach((step, idx) => {
    if (!step.ref) return;
    const comp = componentsByName.get(step.ref);
    if (!comp) return;
    const compParams = Y.parseParams(comp.yaml || "");
    const compName = Y.parseHeader(comp.yaml || "").name || step.ref;
    compParams.forEach((p, pIdx) => {
      paramRows.push({
        badge: `${idx + 1} ${compName}`,
        label: p.name,
        key: `cparam-${idx}-${pIdx}`,
      });
    });
  });

  if (paramRows.length > 0) {
    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = "Parameters";
    cardBody.appendChild(sectionLabel);

    paramRows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "param-row";
      row.innerHTML = `
        <label><span class="param-source">${escapeHtml(r.badge)}</span><span class="param-label-text"></span></label>
        <input type="text" data-param="${escapeAttr(r.key)}" placeholder="${escapeAttr(r.label)}" />
      `;
      row.querySelector(".param-label-text").textContent = r.label;
      cardBody.appendChild(row);
    });
  }

  // Steps list
  const stepsLabel = document.createElement("div");
  stepsLabel.className = "section-label";
  stepsLabel.textContent = "Steps";
  cardBody.appendChild(stepsLabel);

  const stepsContainer = document.createElement("div");
  stepsContainer.className = "steps-container";
  steps.forEach((step, idx) => {
    stepsContainer.appendChild(
      renderStepItem(step, idx, componentsByName, pb.id)
    );
  });
  cardBody.appendChild(stepsContainer);

  // Execute button
  const execRow = document.createElement("div");
  execRow.className = "execute-row";
  const execBtn = document.createElement("button");
  execBtn.className = "btn-execute";
  execBtn.textContent = "Execute";
  execBtn.addEventListener("click", () => {
    executePlaybook(card, pb, params, steps, componentsByName);
  });
  execRow.appendChild(execBtn);
  cardBody.appendChild(execRow);

  card.appendChild(cardHeader);
  card.appendChild(cardBody);
  return card;
}

function renderStepItem(step, idx, componentsByName, pbId) {
  const item = document.createElement("div");
  item.className = "step-item";

  const index = document.createElement("div");
  index.className = "step-index";
  index.textContent = String(idx + 1);

  const content = document.createElement("div");
  content.className = "step-content";

  if (step.ref) {
    // Ref step: look up the referenced component.
    const comp = componentsByName.get(step.ref);
    const compHeader = comp ? Y.parseHeader(comp.yaml || "") : null;
    const displayName = compHeader
      ? (compHeader.name || step.ref)
      : step.ref;

    // Name row with a "ref" badge to distinguish from inline steps.
    const nameRow = document.createElement("div");
    nameRow.className = "step-name-row";
    nameRow.innerHTML = `<span class="step-ref-tag">ref</span><span class="step-name"></span>`;
    nameRow.querySelector(".step-name").textContent = displayName;
    content.appendChild(nameRow);

    // Desc subtitle (from the component).
    if (compHeader && compHeader.desc) {
      const descEl = document.createElement("div");
      descEl.className = "step-desc";
      descEl.textContent = compHeader.desc;
      content.appendChild(descEl);
    }
    if (!comp) {
      const warn = document.createElement("div");
      warn.className = "step-desc";
      warn.textContent = `(component "${step.ref}" not found)`;
      content.appendChild(warn);
    }
    // Note: component params are rendered in the unified Parameters section
    // above, not here, to keep all inputs in one place.
  } else {
    // Inline step: show name + desc.
    const nameEl = document.createElement("div");
    nameEl.className = "step-name";
    nameEl.textContent = step.name || "(unnamed step)";
    content.appendChild(nameEl);
    if (step.desc) {
      const descEl = document.createElement("div");
      descEl.className = "step-desc";
      descEl.textContent = step.desc;
      content.appendChild(descEl);
    }
  }

  item.appendChild(index);
  item.appendChild(content);
  return item;
}

/* ---------- Toast ---------- */
//
// A lightweight global toast notification component.
//   toast.info(title, body)   — blue (default)
//   toast.success(title, body)— green
//   toast.error(title, body)  — red
// `body` is optional; when provided it renders in a monospace block (useful
// for JSON / debug output). Toasts auto-dismiss after `duration` ms (default
// 4000). Multiple toasts stack vertically in the bottom-right corner.

const toast = (() => {
  let container = null;

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
    return container;
  }

  function show(type, title, body, duration) {
    const c = ensureContainer();
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;

    const head = document.createElement("div");
    head.className = "toast-head";
    head.textContent = title;
    el.appendChild(head);

    if (body !== undefined && body !== null && String(body).length > 0) {
      const bodyEl = document.createElement("div");
      bodyEl.className = "toast-body";
      bodyEl.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
      el.appendChild(bodyEl);
    }

    c.appendChild(el);

    const ms = duration || 4000;
    // Hover-pause: when the mouse enters, cancel the auto-dismiss timer so the
    // user can read the content; on mouseleave restart the countdown.
    let timer = setTimeout(() => dismiss(el), ms);
    el.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      timer = null;
    });
    el.addEventListener("mouseleave", () => {
      if (timer === null) {
        timer = setTimeout(() => dismiss(el), ms);
      }
    });
    return el;
  }

  function dismiss(el) {
    if (!el || !el.parentNode) return;
    el.classList.add("toast-out");
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }

  return {
    info: (t, b, d) => show("info", t, b, d),
    success: (t, b, d) => show("success", t, b, d),
    error: (t, b, d) => show("error", t, b, d),
    dismiss,
  };
})();

/* ---------- Execute ---------- */

function executePlaybook(card, pb, params, steps, componentsByName) {
  const header = Y.parseHeader(pb.yaml || "");
  // Collect playbook-level param values (param0, param1, ...).
  const pbValues = {};
  params.forEach((p, idx) => {
    const key = `param${idx}`;
    const input = card.querySelector(`input[data-param="${cssEscape(key)}"]`);
    if (input) pbValues[key] = input.value;
  });

  if (steps.length === 0) {
    toast.info("No steps", "This playbook has no steps to execute.");
    return;
  }

  // Start toast
  toast.info(
    `Executing: ${header.name || ""}`,
    `${steps.length} step(s)`
  );

  steps.forEach((step, idx) => {
    let formMap;
    if (step.ref) {
      const hasOwnForm = step.form && Object.keys(step.form).length > 0;
      if (hasOwnForm) {
        // Ref step has its own form — use it, resolved with playbook params
        // (the ref step lives in the playbook YAML, so its ${paramN} refer
        // to the playbook's params).
        formMap = {};
        for (const [k, v] of Object.entries(step.form)) {
          formMap[k] = Y.resolvePlaceholders(v, pbValues);
        }
      } else {
        // No own form — use the referenced component's form, resolved with
        // the component's own params.
        const comp = componentsByName.get(step.ref);
        if (comp) {
          const compParams = Y.parseParams(comp.yaml || "");
          const compValues = {};
          compParams.forEach((p, pIdx) => {
            const key = `cparam-${idx}-${pIdx}`;
            const input = card.querySelector(
              `input[data-param="${cssEscape(key)}"]`
            );
            if (input) compValues[`param${pIdx}`] = input.value;
          });
          formMap = Y.parseFormBlock(comp.yaml || "", 0);
          const resolved = {};
          for (const [k, v] of Object.entries(formMap)) {
            resolved[k] = Y.resolvePlaceholders(v, compValues);
          }
          formMap = resolved;
        } else {
          formMap = { error: `Component "${step.ref}" not found` };
        }
      }
    } else {
      // Inline step: use the step's own form, resolved with playbook params.
      formMap = {};
      for (const [k, v] of Object.entries(step.form || {})) {
        formMap[k] = Y.resolvePlaceholders(v, pbValues);
      }
    }

    // Toast: progress + the JSON body for this step.
    const stepName = step.ref
      ? `ref: ${step.ref}`
      : (step.name || "(unnamed)");
    const isLast = idx === steps.length - 1;
    const toastTitle = `Step ${idx + 1}/${steps.length} — ${stepName}`;
    if (formMap && formMap.error) {
      toast.error(toastTitle, formMap.error);
    } else {
      toast.success(
        isLast ? `${toastTitle} (done)` : toastTitle,
        JSON.stringify(formMap, null, 2)
      );
    }
  });
}

/* ---------- Helpers ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function escapeAttr(s) {
  return String(s).replace(/["'&<>]/g, (c) =>
    ({ '"': "&quot;", "'": "&#39;", "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])
  );
}

// Minimal CSS.escape polyfill for older Chrome / edge cases.
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}

/* ---------- Init + live sync ---------- */

loadState((data) => {
  render(data);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.srePlaybooks ||
    changes.sreComponents ||
    changes.srePanelState ||
    changes.sreConfig ||
    changes.sreChatSpaceRules ||
    changes.sreRingtones ||
    changes.sreChatMonitor
  ) {
    loadState((data) => render(data));
  }
});
