/* ---------- Chat Spaces rules ---------- */

let chatRules = [];
let editingRuleId = null; // null => creating a new one

function persistChatRules() {
  chrome.storage.local.set({ sreChatSpaceRules: chatRules });
}

function ringtoneNameById(id) {
  const r = ringtones.find((x) => x.id === id);
  return r ? r.name : "(none)";
}

// Legacy rules (saved before the matchType/ruleName simplification) may still
// carry matchValue / ruleName instead of spaceName — always read through here.
function ruleSpaceName(rule) {
  return (rule && (rule.spaceName || rule.matchValue || rule.ruleName)) || "";
}

function emptyRuleDraft() {
  return {
    id: null,
    spaceName: "",
    ringtoneId: ringtones[0] ? ringtones[0].id : "",
    repeatIntervalSec: 10,
    maxRepeats: 20,
    enabled: true,
    alertOnStartup: false,
  };
}

function fillChatRuleForm(rule) {
  const wrap = document.getElementById("chatRulesEditForm");
  if (!wrap) return;
  wrap.innerHTML = "";
  const draft = rule ? { ...emptyRuleDraft(), ...rule } : emptyRuleDraft();
  if (!draft.ringtoneId && ringtones[0]) draft.ringtoneId = ringtones[0].id;
  editingRuleId = draft.id;

  const card = document.createElement("div");
  card.className = "rule-editor-card";
  const title = document.createElement("div");
  title.className = "rule-editor-title";
  title.textContent = editingRuleId ? `Editing rule · ${ruleSpaceName(draft) || "(unnamed)"}` : "Create a new rule";
  card.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "rule-form-grid";

  // --- Fields helpers ---
  const addField = (labelText, node, hintText, extraClass = "") => {
    const wrap2 = document.createElement("div");
    wrap2.className = `field ${extraClass}`;
    const lab = document.createElement("label");
    lab.textContent = labelText;
    wrap2.appendChild(lab);
    wrap2.appendChild(node);
    if (hintText) {
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = hintText;
      wrap2.appendChild(h);
    }
    grid.appendChild(wrap2);
    return node;
  };

  const mkInput = (value) => {
    const inp = document.createElement("input");
    inp.className = "input";
    inp.type = "text";
    inp.value = value || "";
    return inp;
  };
  const mkNum = (value) => {
    const inp = document.createElement("input");
    inp.className = "input";
    inp.type = "number";
    inp.min = "1";
    inp.step = "1";
    inp.value = value == null ? "" : String(value);
    return inp;
  };

  const space = mkInput(ruleSpaceName(draft));
  addField("Space name", space,
    "Sidebar name of the Space or DM. Matched exactly (case-insensitive); comma-separate multiple names.",
    "full");

  const ringtoneSel = document.createElement("select");
  ringtoneSel.className = "select";
  if (ringtones.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(upload ringtones first)";
    ringtoneSel.appendChild(opt);
  }
  for (const r of ringtones) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === draft.ringtoneId) opt.selected = true;
    ringtoneSel.appendChild(opt);
  }
  addField("Ringtone", ringtoneSel, "Played on every repeat until user reads or max repeats reached.");

  const interval = mkNum(draft.repeatIntervalSec);
  const intervalField = document.createElement("div");
  intervalField.style.display = "flex";
  intervalField.style.alignItems = "center";
  intervalField.style.gap = "8px";
  interval.style.flex = "1";
  intervalField.appendChild(interval);
  const intervalSuffix = document.createElement("span");
  intervalSuffix.className = "hint";
  intervalSuffix.textContent = "seconds";
  intervalField.appendChild(intervalSuffix);
  // Wrap in a "field" that addField would have made — but we need to pass the
  // number *input* reference into save handler, so keep interval unchanged.
  const intWrap = document.createElement("div");
  intWrap.className = "field";
  const intLab = document.createElement("label");
  intLab.textContent = "Repeat interval";
  intWrap.appendChild(intLab);
  intWrap.appendChild(intervalField);
  const intHint = document.createElement("div");
  intHint.className = "hint";
  intHint.textContent = "How often to re-check and re-ring while unread persists.";
  intWrap.appendChild(intHint);
  grid.appendChild(intWrap);

  const maxR = mkNum(draft.maxRepeats);
  addField("Max repeats", maxR, "Maximum re-rings before auto-idling (prevents spamming if tab is left open). 0 or empty = unlimited (not recommended).");

  card.appendChild(grid);
  // Switches row (Enabled + Startup)
  const swRow1 = document.createElement("div");
  swRow1.className = "rule-switch-row full";
  swRow1.style.borderTop = "1px solid var(--border)";
  swRow1.style.marginTop = "12px";
  swRow1.style.paddingTop = "12px";
  const sw1LabelWrap = document.createElement("div");
  const sw1Label = document.createElement("label");
  sw1Label.textContent = "Enable rule";
  sw1LabelWrap.appendChild(sw1Label);
  const sw1Hint = document.createElement("div");
  sw1Hint.className = "hint";
  sw1Hint.textContent = "Off = rule is ignored by monitoring entirely.";
  sw1LabelWrap.appendChild(sw1Hint);
  const sw1 = document.createElement("label");
  sw1.className = "switch";
  const sw1i = document.createElement("input");
  sw1i.type = "checkbox";
  sw1i.checked = Boolean(draft.enabled);
  const sw1t = document.createElement("span");
  sw1t.className = "slider-sw";
  sw1.appendChild(sw1i); sw1.appendChild(sw1t);
  swRow1.appendChild(sw1LabelWrap); swRow1.appendChild(sw1);
  card.appendChild(swRow1);

  const swRow2 = document.createElement("div");
  swRow2.className = "rule-switch-row full";
  const sw2LabelWrap = document.createElement("div");
  const sw2Label = document.createElement("label");
  sw2Label.textContent = "Alert on existing unread at startup";
  sw2LabelWrap.appendChild(sw2Label);
  const sw2Hint = document.createElement("div");
  sw2Hint.className = "hint";
  sw2Hint.textContent = "Default OFF: only alert when unread goes 0 → >0 (new messages). ON: page reload/navigation will also alert if the space already has unread.";
  sw2LabelWrap.appendChild(sw2Hint);
  const sw2 = document.createElement("label");
  sw2.className = "switch";
  const sw2i = document.createElement("input");
  sw2i.type = "checkbox";
  sw2i.checked = Boolean(draft.alertOnStartup);
  const sw2t = document.createElement("span");
  sw2t.className = "slider-sw";
  sw2.appendChild(sw2i); sw2.appendChild(sw2t);
  swRow2.appendChild(sw2LabelWrap); swRow2.appendChild(sw2);
  card.appendChild(swRow2);

  // Actions
  const actions = document.createElement("div");
  actions.className = "rule-editor-actions";
  const cancel = document.createElement("button");
  cancel.className = "row-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    editingRuleId = null;
    fillChatRuleForm(null);
    // Wipe the editor away (render just empty form header for "new" CTA-less)
    const w = document.getElementById("chatRulesEditForm");
    if (w) w.innerHTML = "";
  });
  const save = document.createElement("button");
  save.className = "btn btn-primary";
  save.textContent = editingRuleId ? "Save rule" : "Create rule";
  save.addEventListener("click", () => {
    const spaceVal = (space.value || "").trim();
    if (!spaceVal) {
      space.style.borderColor = "var(--danger, #e5484d)";
      space.focus();
      space.addEventListener("input", () => { space.style.borderColor = ""; }, { once: true });
      return;
    }
    const ruleInterval = parseInt(interval.value, 10);
    const ruleMaxR = parseInt(maxR.value, 10);
    const saved = {
      id: editingRuleId || uid(),
      spaceName: spaceVal,
      ringtoneId: ringtoneSel.value || "",
      repeatIntervalSec: isFinite(ruleInterval) && ruleInterval > 0 ? ruleInterval : 10,
      maxRepeats: !isFinite(ruleMaxR) || ruleMaxR <= 0 ? 0 : ruleMaxR,
      enabled: sw1i.checked,
      alertOnStartup: sw2i.checked,
    };
    if (editingRuleId) {
      chatRules = chatRules.map((r) => (r.id === editingRuleId ? saved : r));
    } else {
      chatRules.push(saved);
    }
    persistChatRules();
    renderChatRules();
    editingRuleId = null;
    const w = document.getElementById("chatRulesEditForm");
    if (w) w.innerHTML = "";
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  card.appendChild(actions);

  wrap.appendChild(card);
}

function renderChatRules() {
  const list = document.getElementById("chatRulesList");
  if (!list) return;
  list.innerHTML = "";

  const title = document.createElement("div");
  title.className = "saved-rules-title";
  title.textContent = "Saved rules";
  list.appendChild(title);

  if (chatRules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ring-empty";
    empty.textContent = "No rules yet. Click + Add rule above to create your first mapping.";
    list.appendChild(empty);
    return;
  }

  const root = document.createElement("div");
  root.className = "rule-saved-list";
  for (const rule of chatRules) {
    const card = document.createElement("div");
    card.className = "rule-card";
    const top = document.createElement("div");
    top.className = "rule-card-top";
    const main = document.createElement("div");
    main.className = "rule-card-main";
    const titleRow = document.createElement("div");
    titleRow.className = "rule-card-title";
    titleRow.textContent = ruleSpaceName(rule) || "(unnamed)";
    if (rule.enabled) {
      const b = document.createElement("span");
      b.className = "state-badge ref-badge";
      b.textContent = "ENABLED";
      titleRow.appendChild(b);
    } else {
      const b = document.createElement("span");
      b.className = "state-badge";
      b.style.background = "var(--input-bg)";
      b.style.color = "var(--muted)";
      b.textContent = "DISABLED";
      titleRow.appendChild(b);
    }
    const meta = document.createElement("div");
    meta.className = "rule-card-meta";
    const chips = [
      `ringtone: ${ringtoneNameById(rule.ringtoneId)}`,
      `${rule.repeatIntervalSec || 10}s / ×${rule.maxRepeats || 0 || "∞"}`,
    ];
    if (rule.alertOnStartup) chips.push("startup-alert=ON");
    for (const c of chips) {
      const s = document.createElement("span");
      s.className = "ring-chip";
      s.textContent = c;
      meta.appendChild(s);
    }
    main.appendChild(titleRow);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "rule-card-actions";
    const edit = document.createElement("button");
    edit.className = "row-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => fillChatRuleForm(rule));
    const del = document.createElement("button");
    del.className = "row-btn danger";
    del.textContent = "Del";
    del.addEventListener("click", () => {
      chatRules = chatRules.filter((r) => r.id !== rule.id);
      persistChatRules();
      renderChatRules();
    });
    actions.appendChild(edit); actions.appendChild(del);

    top.appendChild(main); top.appendChild(actions);
    card.appendChild(top);
    root.appendChild(card);
  }
  list.appendChild(root);
}

document.addEventListener("DOMContentLoaded", () => {
  const addBtn = document.getElementById("addChatRuleBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => fillChatRuleForm(null));
  }
});

/* ---------- State badges (reused across pages) ---------- */
// (Style is defined inline in options.html under .ref-badge / .state-badge.)
