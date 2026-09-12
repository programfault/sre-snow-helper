/* playbooks.js — rendering + flows/services selector panels + execute.
   Largest module; covers the playbook/services DOM renderers and the code that
   actually PATCHes ServiceNow / runs service HTTP calls. */

/* ---------- Rendering ---------- */

function updateMonitorDot(rules) {
  const dot = document.getElementById("monitorDot");
  if (!dot) return;
  const anyEnabled = (rules || []).some((r) => r.enabled);
  dot.classList.toggle("off", !anyEnabled);
  dot.title = anyEnabled
    ? "Chat monitor on"
    : "Chat monitor off — enable a rule in options → Notification";
}

function render(data) {
  const playbooks = data.playbooks || [];
  const forms = data.forms || [];
  const servicesYaml = data.servicesYaml || "";
  const services = Y.parseServicesDoc(servicesYaml).services || [];
  const chatRules = data.chatRules || [];
  const queryTemplates = data.queryTemplates || [];

  // 1) Header monitor signal — always present, left of the settings button.
  updateMonitorDot(chatRules);

  contentEl.innerHTML = "";

  const hasFlows = playbooks.length > 0 || services.length > 0;
  const hasTemplates = queryTemplates.length > 0;
  // (No whole-panel empty state anymore: the Logs card below is always useful.)

  // 2) Tags card — needs a captured ServiceNow context to be useful, so it is
  //    only shown when there is flow content below it.
  if (hasFlows) {
    contentEl.appendChild(renderBaseTagsPanel());
    snowTagCtxTick(); // initial Add-button state from whatever ctx we hold
  }

  // 3) Query-template card — directly below the Tags card. Shown whenever any
  //    templates exist, even when no flows/services are configured yet.
  if (hasTemplates) {
    contentEl.appendChild(renderQueryTemplatePanel(queryTemplates));
  }

  // 4) Grafana Loki Logs card — directly below the Query card; always rendered.
  contentEl.appendChild(renderLokiLogsPanel());
  updateLokiStatusUI();

  if (!hasFlows) return; // nothing below except the info cards above

  // 3) ServiceNow flows — a single selector card that shows one flow at a time
  //    (dropdown instead of a stack of collapsible playbook cards).
  if (playbooks.length > 0) {
    const common = Y.parseCommonSteps(data.commonYaml || "");
    contentEl.appendChild(renderFlowsSelectorPanel(playbooks, common, forms));
  }

  // 4) Services — the same selector pattern, below the flows.
  if (services.length > 0) {
    contentEl.appendChild(renderServicesSelectorPanel(services));
  }
}

function renderPlaybookCard(pb, common, forms) {
  const yaml = pb.yaml || "";
  const header = Y.parseHeader(yaml);
  const pbParams = Y.parseParams(yaml);
  const flow = Y.parseFlow(yaml);
  const commonParams = (common && common.params) || [];

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

  // Unified Parameters section: playbook-level params + (when the flow refs
  // any common step) the shared Common Steps params. Every input is tagged
  // with a source badge. Scope: common forms resolve with common params;
  // playbook forms resolve with playbook params — "common uses common, each
  // keeps its own".
  const hasRef = flow.some((st) => st.ref);
  const paramRows = [];
  if (hasRef) {
    commonParams.forEach((p, pIdx) => {
      paramRows.push({
        badge: "common",
        key: `common-param${pIdx}`,
        p,
      });
    });
  }
  pbParams.forEach((p, idx) => {
    paramRows.push({ badge: "playbook", key: `param${idx}`, p });
  });

  if (paramRows.length > 0) {
    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = "Parameters";
    cardBody.appendChild(sectionLabel);

    paramRows.forEach((r) => {
      cardBody.appendChild(renderParamRow(r, forms, pb.id));
    });
  }

  // Steps list
  if (flow.length > 0) {
    const stepsLabel = document.createElement("div");
    stepsLabel.className = "section-label";
    stepsLabel.textContent = "Steps";
    cardBody.appendChild(stepsLabel);

    const stepsContainer = document.createElement("div");
    stepsContainer.className = "steps-container";
    flow.forEach((step, idx) => {
      stepsContainer.appendChild(renderStepItem(step, idx, common));
    });
    cardBody.appendChild(stepsContainer);
  }

  // Dry Run / Execute buttons — two side-by-side actions at the card bottom.
  //   Dry Run  (墨绿) — resolve + preview only; nothing is sent or executed.
  //   Execute (primary) — resolve and execute (send each step / merged set).
  const execRow = document.createElement("div");
  execRow.className = "execute-row";

  const dryBtn = document.createElement("button");
  dryBtn.className = "btn-execute btn-dryrun";
  dryBtn.textContent = "Dry Run";
  dryBtn.title = "仅预览：解析参数并展示每个 step 的载荷，不真正执行";
  dryBtn.addEventListener("click", () => {
    executePlaybook(card, pb, flow, pbParams, commonParams, common, { dryRun: true });
  });
  execRow.appendChild(dryBtn);

  const execBtn = document.createElement("button");
  execBtn.className = "btn-execute";
  execBtn.textContent = "Execute";
  execBtn.addEventListener("click", () => {
    executePlaybook(card, pb, flow, pbParams, commonParams, common, { dryRun: false });
  });
  execRow.appendChild(execBtn);

  cardBody.appendChild(execRow);

  card.appendChild(cardHeader);
  card.appendChild(cardBody);
  return card;
}

// A single parameter widget on a playbook card. The widget depends on type:
//   textarea -> multi-line <textarea>
//   option   -> radio group fed from the Form library (paramOptionRows): each
//               radio shows the row's `display` and carries its `value`; the
//               first choice is pre-selected. When the Form library has no
//               matching field, fall back to a free-text input (with a hint) so
//               a mis-configuration never blocks execution.
//   else     -> single-line <input>
// `r` = { p: <parsed param {name,type}>, key: "paramN"|"common-paramN", badge }.
function renderParamRow(r, forms, cardId) {
  const row = document.createElement("div");
  row.className = "param-row";
  const label = (r.p && r.p.name) || "";
  const pType = ((r.p && r.p.type) || "").toLowerCase();

  const header = document.createElement("label");
  header.innerHTML = `<span class="param-source">${escapeHtml(r.badge)}</span><span class="param-label-text"></span>`;
  header.querySelector(".param-label-text").textContent = label;
  row.appendChild(header);

  const appendText = (hint) => {
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.param = r.key;
    input.placeholder = label;
    row.appendChild(input);
    if (hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "param-option-missing";
      hintEl.textContent = hint;
      row.appendChild(hintEl);
    }
  };

  if (pType === "option") {
    const options = Y.paramOptionRows(r.p, forms || []);
    if (options.length === 0) {
      appendText(
        `No Form-library match for “${label}” — entered as free text instead.`
      );
      return row;
    }
    const group = document.createElement("div");
    group.className = "param-options";
    // Radios group by their `name` attribute; give every card+param a unique
    // name so picking a choice on one card never clears another card's group.
    const groupName = `pbparam-${cardId || "?"}-${r.key}`;
    options.forEach((o, i) => {
      const opt = document.createElement("label");
      opt.className = "param-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = groupName;
      radio.value = o.value;
      radio.dataset.param = r.key;
      if (i === 0) radio.checked = true; // default: first choice
      const text = document.createElement("span");
      text.className = "param-option-text";
      text.textContent = o.display;
      opt.appendChild(radio);
      opt.appendChild(text);
      group.appendChild(opt);
    });
    row.appendChild(group);
    return row;
  }

  if (pType === "textarea") {
    const area = document.createElement("textarea");
    area.rows = 3;
    area.dataset.param = r.key;
    area.placeholder = label;
    row.appendChild(area);
    return row;
  }

  appendText();
  return row;
}

function renderStepItem(step, idx, common) {
  const item = document.createElement("div");
  item.className = "step-item";

  const index = document.createElement("div");
  index.className = "step-index";
  index.textContent = String(idx + 1);

  const content = document.createElement("div");
  content.className = "step-content";

  // Does this step send by itself? Flow item's `action` wins; otherwise the
  // referenced common step's value.
  const commonStepAction =
    step.ref && common && common.steps && common.steps[step.ref]
      ? common.steps[step.ref].action
      : undefined;
  const actsAlone = !!Y.effectiveAction(step.action, commonStepAction);

  const nameRow = document.createElement("div");
  nameRow.className = "step-name-row";

  if (step.ref) {
    // Ref step: tag it, then show the flow item's name (falls back to the
    // common step key).
    const tag = document.createElement("span");
    tag.className = "step-ref-tag";
    tag.textContent = "ref";
    nameRow.appendChild(tag);
    const nameEl = document.createElement("span");
    nameEl.className = "step-name";
    nameEl.textContent = step.name || step.ref;
    nameRow.appendChild(nameEl);
    content.appendChild(nameRow);

    const commonStep = common && common.steps ? common.steps[step.ref] : null;
    if (!commonStep) {
      const warn = document.createElement("div");
      warn.className = "step-desc";
      warn.textContent = `(common step "${step.ref}" not found)`;
      content.appendChild(warn);
    }
  } else {
    // Inline step: name + desc.
    const nameEl = document.createElement("span");
    nameEl.className = "step-name";
    nameEl.textContent = step.name || "(unnamed step)";
    nameRow.appendChild(nameEl);
    content.appendChild(nameRow);
    if (step.desc) {
      const descEl = document.createElement("div");
      descEl.className = "step-desc";
      descEl.textContent = step.desc;
      content.appendChild(descEl);
    }
  }

  if (actsAlone) {
    const tag = document.createElement("span");
    tag.className = "step-ref-tag";
    tag.style.color = "var(--primary)";
    tag.style.background = "var(--primary-soft)";
    tag.textContent = "action";
    nameRow.appendChild(tag);
  }

  item.appendChild(index);
  item.appendChild(content);
  return item;
}

/* ---------- Services panel ---------- */
//
// The shared Services document renders below Playbooks as its own mega panel.
// Each top-level entry is a runnable card: either a plain API call or a
// `type: group` whose nested services run top to bottom.
//
// Variable rule (shared with the options editor):
//   * every reference is written ${name};
//   * a ${name} that equals an `output.alias` of an EARLIER service inside the
//     same group resolves from the chain automatically — it is NOT prompted;
//   * every other ${name} is rendered as a user input field on the card.
//
// "Execute" performs real fetch() calls in order; captured aliases flow
// forward into later steps of the same card.

/* ---------- Flows & Services selector panels ---------- */
//
// The ServiceNow flows and the shared Services doc each render as one card in
// the Tags/Query style (edge-to-edge snow-info). Their picker reuses the Tags
// combobox UI (a filterable input whose dropdown stays inside the panel, so it
// never overflows the side bar): every item is listed a-z with its full label
// (name — desc), typing narrows the list, and only the chosen item's body is
// shown beneath it. The per-item body is still produced by renderPlaybookCard
// / renderServiceCard (behavior unchanged), just with its card chrome stripped.
//
// Selection is remembered across re-renders via srePanelState.selFlow (pb id)
// and srePanelState.selService (index in the services doc).

// Truncate a long label for display; the full text is kept in the tooltip.
function pickerShown(text) {
  return text.length > 48 ? text.slice(0, 48) + "…" : text;
}

// Builds a Tags-style picker card: head (icon + title), then a combo box row
// (filter input + dropdown), then a body host the caller fills with the chosen
// item. `items` are already sorted and carry the ORIGINAL index (`idx`) so the
// option order never breaks the value → item mapping. `onPick(idx)` is called
// with the item's original idx, or -1 when the user clears the selection.
function buildFilterPickerCard(title, iconSvg, items, placeholderText, initialIdx, onPick) {
  const card = document.createElement("div");
  card.className = "snow-info";

  const head = document.createElement("div");
  head.className = "snow-info-head";
  const icon = document.createElement("span");
  icon.className = "snow-info-icon";
  icon.innerHTML = iconSvg;
  const titleEl = document.createElement("span");
  titleEl.className = "snow-info-title";
  titleEl.textContent = title;
  head.appendChild(icon);
  head.appendChild(titleEl);

  // One-click reset: back to the blank "nothing selected" state. It only shows
  // once something is picked (no empty icon clutter like the Logs status btn).
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "snow-refresh-btn pick-reset";
  resetBtn.title = "Clear selection";
  resetBtn.hidden = true;
  resetBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  head.appendChild(resetBtn);
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "sel-body";

  // --- Picker row (same DOM/classes as the Tags combo) ---
  const row = document.createElement("div");
  row.className = "snow-tags-row";
  const combo = document.createElement("div");
  combo.className = "snow-tags-combo";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "snow-tags-input";
  input.placeholder = placeholderText || "Select…";
  input.autocomplete = "off";
  input.spellcheck = false;
  const drop = document.createElement("div");
  drop.className = "snow-tags-drop";
  combo.appendChild(input);
  combo.appendChild(drop);
  row.appendChild(combo);
  body.appendChild(row);

  const host = document.createElement("div");
  host.className = "sel-item-host";
  body.appendChild(host);

  card.appendChild(body);

  const byIdx = new Map(items.map((o) => [o.idx, o]));
  let cur = initialIdx >= 0 && byIdx.has(initialIdx) ? initialIdx : null;
  if (cur !== null) input.value = byIdx.get(cur).text;

  const labelOf = (idx) => (byIdx.get(idx) || {}).text || "";
  const close = () => drop.classList.remove("open");
  const syncReset = () => {
    resetBtn.hidden = cur === null;
  };
  syncReset();

  function paintList() {
    const q = input.value.trim().toLowerCase();
    const cands = items.filter((o) => !q || o.text.toLowerCase().includes(q));
    drop.replaceChildren();
    if (cur !== null) {
      const none = document.createElement("button");
      none.type = "button";
      none.className = "snow-tag-opt pick-clear";
      none.textContent = "— no selection —";
      none.title = "Clear selection";
      none.addEventListener("mousedown", (e) => e.preventDefault());
      none.addEventListener("click", (e) => {
        e.preventDefault();
        cur = null;
        input.value = "";
        input.blur();
        syncReset();
        onPick(-1);
      });
      drop.appendChild(none);
    }
    cands.slice(0, 60).forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "snow-tag-opt";
      b.textContent = pickerShown(o.text);
      b.title = o.text;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        cur = o.idx;
        input.value = o.text;
        input.blur();
        syncReset();
        onPick(o.idx);
      });
      drop.appendChild(b);
    });
    if (cands.length || cur !== null) drop.classList.add("open");
  }

  input.addEventListener("focus", () => {
    // Focus = start picking: blank the box so every option is reachable; the
    // previous label is restored on blur if nothing new is picked.
    input.value = "";
    paintList();
  });
  input.addEventListener("input", paintList);
  input.addEventListener("blur", () => {
    close();
    if (cur !== null) input.value = labelOf(cur);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      if (cur !== null) input.value = labelOf(cur);
      input.blur();
    }
  });

  resetBtn.addEventListener("click", () => {
    cur = null;
    input.value = "";
    close();
    input.blur();
    syncReset();
    onPick(-1);
  });

  return { card, host };
}

// Neutralize an existing playbook/service card node: drop its own header and
// border so only its body rows remain inside the selector card.
function neutralizeItemNode(node) {
  node.classList.remove("collapsed");
  node.classList.add("pb-sel-neutral");
  const hd = node.querySelector(".pb-card-header");
  if (hd) hd.remove();
  return node;
}

function renderFlowsSelectorPanel(playbooks, common, forms) {
  // Flow names may repeat; the desc is what tells them apart, so the dropdown
  // shows `name — desc` and sorts options a-z by that label.
  const list = playbooks.map((pb, i) => {
    const yaml = pb.yaml || "";
    const h = Y.parseHeader(yaml);
    const name = h.name || "(unnamed)";
    const desc = h.desc || "";
    return { idx: i, text: desc ? name + " — " + desc : name };
  });
  list.sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: "base", numeric: true }));

  // Resolve the remembered selection (by pb.id). Nothing selected yet — the
  // body stays hidden, exactly like the Query card — unless a saved id matches.
  const savedId = srePanelState && srePanelState.selFlow;
  let startIdx = -1;
  if (savedId) {
    const found = playbooks.findIndex((p) => p.id === savedId);
    if (found >= 0) startIdx = found;
  }

  const { card, host } = buildFilterPickerCard(
    "Servicenow",
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 2 3 14h7l-1 8 11-12h-7z"/></svg>',
    list,
    "Select a flow…",
    startIdx,
    (idx) => {
      if (!srePanelState) srePanelState = {};
      srePanelState.selFlow = idx >= 0 && playbooks[idx] ? playbooks[idx].id : null;
      persistState();
      renderAt(idx);
    }
  );
  card.classList.add("snow-info-flows");

  function renderAt(idx) {
    host.replaceChildren();
    if (idx < 0 || !playbooks[idx]) return; // nothing chosen → keep it blank
    const node = neutralizeItemNode(renderPlaybookCard(playbooks[idx], common, forms));
    host.appendChild(node);
  }
  renderAt(startIdx);
  return card;
}

function renderServicesSelectorPanel(services) {
  const list = services.map((item, i) => {
    const isGroup = item.type === "group";
    const kind = isGroup
      ? "group · " + (item.services ? item.services.length : 0) + " calls"
      : item.method || "api";
    const desc = [kind, item.desc].filter(Boolean).join(" — ");
    const name = item.name || "(unnamed)";
    return { idx: i, text: desc ? name + " — " + desc : name };
  });
  list.sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: "base", numeric: true }));

  const saved = srePanelState && srePanelState.selService;
  let startIdx = -1;
  if (typeof saved === "number" && saved >= 0 && saved < services.length) {
    startIdx = saved;
  }

  const { card, host } = buildFilterPickerCard(
    "Services",
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18-.21 0-.41-.06-.57-.18l-7.9-4.44A.99.99 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18.21 0 .41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9zM12 4.15 6.04 7.5 12 10.85l5.96-3.35L12 4.15zM5 15.91l6 3.38V12.9L5 9.52v6.39zm14 0V9.52l-6 3.38v6.39l6-3.38z"/></svg>',
    list,
    "Select a service…",
    startIdx,
    (idx) => {
      if (!srePanelState) srePanelState = {};
      srePanelState.selService = idx >= 0 ? idx : null;
      persistState();
      renderAt(idx);
    }
  );
  card.classList.add("snow-info-services");

  function renderAt(idx) {
    host.replaceChildren();
    if (idx < 0 || !services[idx]) return; // nothing chosen → keep it blank
    const node = neutralizeItemNode(renderServiceCard(services[idx], idx));
    host.appendChild(node);
  }
  renderAt(startIdx);
  return card;
}

function renderServiceCard(item, idx) {
  const isGroup = item.type === "group";
  const steps = isGroup ? item.services || [] : [item];
  // Manual inputs only: ${name}s that name a captured global (ServiceNow ctx
  // or globe.com.ph order page) resolve automatically at run time and must NOT
  // be prompted here — an empty input would shadow the captured value.
  const inputs = Y.collectServiceInputs(item).filter((inp) => !CTX_VARS.has(inp.var));

  const card = document.createElement("div");
  card.className = "pb-card svc-card";
  const cardKey = "svc-" + idx;
  if (srePanelState.cardCollapsed && srePanelState.cardCollapsed[cardKey]) {
    card.classList.add("collapsed");
  }

  const head = document.createElement("div");
  head.className = "pb-card-header";
  head.innerHTML = `
    <span class="pb-card-toggle">
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </span>
    <div class="pb-card-meta">
      <div class="pb-card-name"></div>
      <div class="pb-card-desc"></div>
    </div>
  `;
  const nameEl = head.querySelector(".pb-card-name");
  nameEl.textContent = item.name || "(unnamed)";
  const descEl = head.querySelector(".pb-card-desc");
  descEl.textContent = item.desc || (isGroup ? `${steps.length} call(s)` : "");
  if (!item.name) nameEl.style.fontStyle = "italic";

  const kindChip = document.createElement("span");
  kindChip.className = "step-ref-tag svc-kind";
  kindChip.textContent = isGroup ? "group" : steps[0] && steps[0].method || "api";
  kindChip.style.color = isGroup ? "#6f42c1" : "var(--muted)";
  kindChip.style.background = isGroup ? "#f3ecff" : "var(--bg)";
  head.appendChild(kindChip);

  head.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    if (!srePanelState.cardCollapsed) srePanelState.cardCollapsed = {};
    srePanelState.cardCollapsed[cardKey] = card.classList.contains("collapsed");
    persistState();
  });

  const body = document.createElement("div");
  body.className = "pb-card-body";

  // ---- Inputs (only vars not satisfied by an earlier alias in the group) ----
  if (inputs.length > 0) {
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Inputs";
    body.appendChild(label);

    inputs.forEach((inp) => {
      const row = document.createElement("div");
      row.className = "param-row";
      const field = document.createElement("input");
      field.type = "text";
      field.dataset.svcVar = inp.var;
      field.placeholder = inp.var;
      const l = document.createElement("label");
      const src = document.createElement("span");
      src.className = "param-source";
      src.textContent = "input";
      const txt = document.createElement("span");
      txt.className = "param-label-text";
      txt.textContent = inp.var;
      l.appendChild(src);
      l.appendChild(txt);
      row.appendChild(l);
      row.appendChild(field);
      if (inp.from) {
        const hint = document.createElement("div");
        hint.className = "hint svc-var-hint";
        hint.textContent = "first used by " + inp.from;
        row.appendChild(hint);
      }
      body.appendChild(row);
    });
  }

  // ---- Steps / requests ----
  const stepsLabel = document.createElement("div");
  stepsLabel.className = "section-label";
  stepsLabel.textContent = isGroup ? "Requests" : "Request";
  body.appendChild(stepsLabel);

  const stepsContainer = document.createElement("div");
  stepsContainer.className = "steps-container";
  steps.forEach((svc, i) => stepsContainer.appendChild(renderServiceStepRow(svc, i)));
  body.appendChild(stepsContainer);

  // ---- Dry Run / Run ----
  const execRow = document.createElement("div");
  execRow.className = "execute-row";
  const dryBtn = document.createElement("button");
  dryBtn.className = "btn-execute btn-dryrun";
  dryBtn.textContent = "Dry Run";
  dryBtn.addEventListener("click", () => {
    dryRunServiceCard(card, steps, inputs);
  });
  execRow.appendChild(dryBtn);
  const runBtn = document.createElement("button");
  runBtn.className = "btn-execute";
  runBtn.textContent = "Run";
  runBtn.addEventListener("click", () => {
    executeServiceCard(card, steps, inputs, runBtn);
  });
  execRow.appendChild(runBtn);
  body.appendChild(execRow);

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function renderServiceStepRow(svc, idx) {
  const row = document.createElement("div");
  row.className = "step-item svc-step";

  const index = document.createElement("div");
  index.className = "step-index";
  index.textContent = String(idx + 1);

  const content = document.createElement("div");
  content.className = "step-content";

  const nameRow = document.createElement("div");
  nameRow.className = "step-name-row";

  const method = document.createElement("span");
  method.className = "step-ref-tag svc-method m-" + String(svc.method || "GET").toLowerCase();
  method.textContent = svc.method || "GET";
  nameRow.appendChild(method);

  const nameEl = document.createElement("span");
  nameEl.className = "step-name";
  nameEl.textContent = svc.name || "(unnamed call)";
  nameRow.appendChild(nameEl);
  content.appendChild(nameRow);

  if (svc.desc) {
    const d = document.createElement("div");
    d.className = "step-desc";
    d.textContent = svc.desc;
    content.appendChild(d);
  }

  const endpoint = document.createElement("div");
  endpoint.className = "svc-endpoint";
  endpoint.textContent = svc.endpoint || "(no endpoint)";
  endpoint.title = svc.endpoint || "";
  content.appendChild(endpoint);

  if (svc.outputs && svc.outputs.length > 0) {
    const outRow = document.createElement("div");
    outRow.className = "svc-output-row";
    svc.outputs.forEach((o) => {
      const chip = document.createElement("span");
      chip.className = "svc-out-chip";
      chip.textContent = "out: " + o.alias;
      chip.title = "json_path " + o.path;
      outRow.appendChild(chip);
    });
    content.appendChild(outRow);
  }

  row.appendChild(index);
  row.appendChild(content);
  return row;
}

// Build the exact request that runServiceStep would send — method, URL, headers
// and body with every placeholder resolved — WITHOUT fetching. Shared by the
// real execution path and the Dry Run preview so what you preview is exactly
// what would be sent. Returns { method, url, headers, hasBody, bodyObj,
// bodyJson, isSnow, leftover }.
function prepareServiceStep(svc, values) {
  // Context placeholders from both snapshots resolve automatically: ServiceNow
  // (${incidentId}, ${userToken}, ${number}, ${instance}) and globe.com.ph
  // order page (${f_wo_number}, ${f_sid}, ${f_access_token}). Explicit service
  // inputs win over context on a name clash.
  const effective = Object.assign({}, snowVars(), gobleVars(), values || {});
  const url = Y.resolvePlaceholders(svc.endpoint, effective);
  const headers = {};
  const rawHeaders = Y.resolveTemplate(svc.header || {}, effective);
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (v !== null && v !== undefined) headers[k] = String(v);
  }
  const method = svc.method || "GET";
  const hasBody = method !== "GET" && svc.body !== null && svc.body !== undefined;
  let bodyObj = null;
  if (hasBody) {
    bodyObj = Y.resolveTemplate(svc.body, effective);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  const bodyJson = bodyObj === null ? null : JSON.stringify(bodyObj);

  // Universal ServiceNow layer: any request aimed at *.service-now.com is sent
  // with the browser's login cookies (credentials: include) and signed with
  // the CSRF token captured from the page (X-UserToken, window.g_ck).
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (_) {}
  const isSnow = /(^|\.)service-now\.com$/i.test(host);
  if (isSnow && !headers["X-UserToken"] && snowCtx && snowCtx.token) {
    headers["X-UserToken"] = String(snowCtx.token);
  }

  // Leftover ${name}s mean an input was left empty, a context page is not
  // open, or an alias from an earlier step has no value yet.
  const leftover = collectUnresolved([url, headers, hasBody ? bodyJson : null]);
  return { method, url, headers, hasBody, bodyObj, bodyJson, isSnow, leftover };
}

// Format a prepared request for the Dry Run toast.
function describePreparedRequest(req, aliasOwner) {
  const lines = [];
  lines.push(`${req.method} ${req.url || "(no endpoint)"}`);
  if (req.isSnow) {
    lines.push("Note: browser session cookies (credentials: include) will be sent to *.service-now.com");
  }
  lines.push("");
  lines.push("Headers:");
  const entries = Object.entries(req.headers);
  lines.push(entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("\n") : "(none)");
  lines.push("");
  lines.push("Body:");
  if (req.hasBody) lines.push(JSON.stringify(req.bodyObj, null, 2));
  else lines.push("(none)");

  // Placeholders that will be filled by an earlier step's captured output
  // cannot be previewed (nothing is fetched) — say so instead of implying the
  // request is broken.
  const owned = req.leftover.filter((n) => aliasOwner[n]);
  if (owned.length) {
    const nums = [...new Set(owned.map((n) => aliasOwner[n]))].sort().join(", ");
    lines.push("");
    lines.push(`Note: ${owned.map((n) => "${" + n + "}").join(", ")} will be filled from the response of step ${nums} at run time.`);
  }
  const missing = req.leftover.filter((n) => !aliasOwner[n]);
  if (missing.length) {
    lines.push("");
    lines.push("MISSING — " + describeMissingPlaceholders(missing, "in the service inputs"));
  }
  return lines.join("\n");
}

// Dry Run for a services card: resolve every step into the request that would
// be sent (endpoint, headers, body) and preview it as toasts — nothing is
// actually fetched. Steps that consume a previous step's output are flagged:
// the value only exists after a real Run.
function dryRunServiceCard(card, steps, inputs) {
  const values = {};
  inputs.forEach((inp) => {
    const el = card.querySelector(`[data-svc-var="${cssEscape(inp.var)}"]`);
    values[inp.var] = el ? el.value : "";
  });
  const aliasOwner = {};
  steps.forEach((svc, i) => {
    (svc.outputs || []).forEach((o) => {
      if (!(o.alias in aliasOwner)) aliasOwner[o.alias] = i + 1;
    });
  });
  toast.info("Dry run", `${steps.length} step(s) · nothing was sent`);
  steps.forEach((svc, i) => {
    const req = prepareServiceStep(svc, values);
    const name = svc.name || svc.endpoint || "(unnamed)";
    const title = `Dry run · Step ${i + 1}/${steps.length} · ${name}`;
    const text = describePreparedRequest(req, aliasOwner);
    const missing = req.leftover.filter((n) => !aliasOwner[n]);
    if (missing.length) toast.error(title, text);
    else toast.success(title, text);
  });
}

// Perform one HTTP call. Returns { failed, status?, error?, url?, out }.
async function runServiceStep(svc, values) {
  const req = prepareServiceStep(svc, values);
  if (req.leftover.length > 0) {
    return {
      failed: true,
      error: describeMissingPlaceholders(req.leftover, "in the service inputs"),
    };
  }

  const init = { method: req.method, headers: req.headers };
  if (req.isSnow) init.credentials = "include";
  if (req.hasBody) init.body = req.bodyJson;

  try {
    const resp = await fetch(req.url, init);
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    const out = {};
    (svc.outputs || []).forEach((o) => {
      const v = Y.queryPath(json, o.path);
      if (v !== undefined) out[o.alias] = v;
    });
    return { failed: !resp.ok, status: resp.status, ok: resp.ok, json, text, out, url: req.url };
  } catch (err) {
    return { failed: true, error: String((err && err.message) || err) };
  }
}

function collectUnresolved(values) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      Y.extractPlaceholderNames(v).forEach((n) => found.add(n));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  values.forEach(walk);
  return Array.from(found);
}

// Human-readable reason for ${…} names that survived resolution. Context
// placeholders are split by source so the hint tells the user which page to
// open (ServiceNow incident vs goble.com order page) instead of asking them to
// fill in a value that is meant to be captured automatically.
function describeMissingPlaceholders(names, inputsLabel) {
  const fmt = (arr) => arr.map((n) => "${" + n + "}").join(", ");
  const inputs = names.filter((n) => !CTX_VARS.has(n));
  const snow = names.filter((n) => SN_CTX_VARS.has(n));
  const goble = names.filter((n) => GOB_CTX_VARS.has(n));
  const msgs = [];
  if (inputs.length) msgs.push("fill in " + fmt(inputs) + " " + inputsLabel);
  if (snow.length)
    msgs.push("open an incident in ServiceNow so " + fmt(snow) + " can be captured");
  if (goble.length)
    msgs.push("open an order page on globe.com.ph so " + fmt(goble) + " can be captured");
  return "missing value(s): " + msgs.join("; ");
}

async function executeServiceCard(card, steps, inputs, runBtn) {
  const values = {};
  inputs.forEach((inp) => {
    const el = card.querySelector(`[data-svc-var="${cssEscape(inp.var)}"]`);
    values[inp.var] = el ? el.value : "";
  });

  const dryBtn = card.querySelector(".btn-dryrun");
  runBtn.disabled = true;
  runBtn.textContent = "Running…";
  if (dryBtn) dryBtn.disabled = true;
  const total = steps.length;
  try {
    for (let i = 0; i < total; i++) {
      const step = await runServiceStep(steps[i], values);
      const label = `Step ${i + 1}/${total} · ${steps[i].name || steps[i].endpoint || "(unnamed)"}`;
      if (step.failed) {
        toast.error(label, step.error || `HTTP ${step.status}`);
        return;
      }
      const full =
        step.json !== null && step.json !== undefined
          ? step.json
          : step.text && step.text.length > 0
          ? step.text
          : step.url;
      toast.success(`${label} · HTTP ${step.status}`, full || "ok");
      Object.assign(values, step.out);
    }
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run";
    if (dryBtn) dryBtn.disabled = false;
  }
}

/* ---------- Execute ---------- */

// Build the REST Table API endpoint for the incident currently in context.
// This round targets incidents only: PATCH /api/now/table/incident/<sys_id>.
function snowIncidentEndpoint() {
  const c = snowCtx || {};
  if (!c.instance || !c.sysid) return null;
  return "https://" + c.instance + "/api/now/table/incident/" + c.sysid;
}

// Sign a real PATCH against the current incident with the captured CSRF token
// and the browser's ServiceNow cookies (credentials: include). `url` is the
// endpoint captured at run start so a mid-run tab switch cannot retarget it.
async function snowPatchIncident(body, url) {
  const c = snowCtx || {};
  const target = url || snowIncidentEndpoint();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (c.token) headers["X-UserToken"] = String(c.token);
  try {
    const resp = await fetch(target, {
      method: "PATCH",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    return { ok: resp.ok, failed: !resp.ok, status: resp.status, json, text, url: target };
  } catch (err) {
    return { failed: true, error: String((err && err.message) || err) };
  }
}

// Keep result toasts readable (a successful PATCH echoes back the whole record).
function snowResultBody(r) {
  if (!r || r.failed) {
    return r && r.error
      ? r.error
      : r && r.text && r.text.length
      ? r.text
      : "Request failed.";
  }
  const txt = (r.text || "").trim();
  const display = txt.length ? txt : "HTTP " + r.status;
  return display.length > 600 ? display.slice(0, 600) + "\n…" : display;
}

// Read one parameter widget's value off a playbook card: for an option group
// the *checked* radio wins (the first choice is pre-selected at render time);
// text inputs / textareas report their raw value. Returns null when no widget
// exists for the key.
function readParamValue(card, key) {
  const sel = `[data-param="${cssEscape(key)}"]`;
  const checked = card.querySelector(sel + ":checked");
  if (checked) return checked.value;
  const field = card.querySelector(sel);
  return field ? field.value : null;
}

// Execute a flow against the current ServiceNow incident.
//   Dry Run  — resolve + preview payloads only, nothing is sent.
//   Execute  — action=true steps are PATCHed individually in flow order; the
//              remaining steps are merged into a single final PATCH. Every
//              request is signed with the captured UserToken and the browser's
//              ServiceNow cookies.
async function executePlaybook(card, pb, flow, pbParams, commonParams, common, opts) {
  const dryRun = Boolean(opts && opts.dryRun);
  const header = Y.parseHeader(pb.yaml || "");
  const title = header.name || "";
  if (flow.length === 0) {
    toast.info("No steps", "This playbook has no steps to execute.");
    return;
  }

  // Collect param values from the card widgets (text <input> / <textarea> /
  // option radio groups — every widget is tagged with data-param).
  const pbValues = {};
  pbParams.forEach((p, idx) => {
    const v = readParamValue(card, "param" + idx);
    if (v !== null) pbValues["param" + idx] = v;
  });
  const commonValues = {};
  commonParams.forEach((p, idx) => {
    const v = readParamValue(card, "common-param" + idx);
    if (v !== null) commonValues["param" + idx] = v;
  });

  // Page context satisfies both placeholder families automatically — ServiceNow
  // (${incidentId} / ${userToken} / ${number} / ${instance}) and goble.com
  // (${f_wo_number} / ${f_sid} / ${f_access_token}); explicit parameter values
  // keep their normal keys.
  const ctxVars = Object.assign({}, snowVars(), gobleVars());
  const pbResolve = Object.assign({}, ctxVars, pbValues);
  const commonResolve = Object.assign({}, ctxVars, commonValues);

  // Resolve every step into a payload (or an error) first, tagging each with
  // its effective `action` (flow item's own value wins; else the referenced
  // common step's value; else false). A payload still containing ${…} after
  // resolution is an error — it must never reach ServiceNow literally.
  const commonSteps = (common && common.steps) || {};
  // Practical shortcut: comments and work_notes are virtually always kept in
  // sync, so whenever a payload sends work_notes we mirror the same value into
  // comments automatically. Authors only define work_notes (and its
  // placeholder) once — no separate comments field/handling is needed.
  const mirrorComments = (form) => {
    if (form && typeof form.work_notes === "string" && form.work_notes.length > 0) {
      form.comments = form.work_notes;
    }
    return form;
  };
  const finishUnit = (idx, displayName, refName, formMap, actionVal) => {
    const leftover = collectUnresolved([formMap]);
    if (leftover.length > 0) {
      return {
        idx,
        name: displayName,
        error: describeMissingPlaceholders(leftover, "in the Parameters form"),
      };
    }
    mirrorComments(formMap);
    return { idx, name: displayName, ref: refName, form: formMap, action: actionVal };
  };

  const units = flow.map((step, idx) => {
    const displayName = step.name || step.ref || `step ${idx + 1}`;
    const resolve = (formMap, values) => {
      const resolved = {};
      for (const [k, v] of Object.entries(formMap)) {
        resolved[k] = Y.resolvePlaceholders(v, values);
      }
      return resolved;
    };
    if (step.ref) {
      const commonStep = commonSteps[step.ref];
      const hasOwn = step.form && Object.keys(step.form).length > 0;
      if (hasOwn) {
        // A ref item may carry its own form; its ${paramN} refer to the
        // playbook's params (the item lives in the playbook YAML).
        return finishUnit(
          idx,
          displayName,
          step.ref,
          resolve(step.form, pbResolve),
          Y.effectiveAction(step.action, commonStep && commonStep.action)
        );
      }
      if (commonStep) {
        // Reuse the referenced common step's form, resolved against the
        // common doc's own params.
        return finishUnit(
          idx,
          displayName,
          step.ref,
          resolve(commonStep.form || {}, commonResolve),
          Y.effectiveAction(step.action, commonStep.action)
        );
      }
      return { idx, name: displayName, error: `Common step "${step.ref}" not found` };
    }
    // Inline step.
    return finishUnit(
      idx,
      displayName,
      undefined,
      resolve(step.form || {}, pbResolve),
      Y.effectiveAction(step.action, undefined)
    );
  });

  const errors = units.filter((u) => u.error);
  const solo = units.filter((u) => !u.error && u.action === true);
  const merged = units.filter((u) => !u.error && u.action !== true);

  // Errors — surfaced immediately, individually.
  errors.forEach((u) => {
    toast.error(`Step ${u.idx + 1}/${flow.length} — ${u.name}`, u.error);
  });

  // ---- Dry run: preview only. ----
  if (dryRun) {
    toast.info(`Dry run: ${title}`, `${flow.length} step(s)`);
    solo.forEach((u) => {
      const label = u.ref ? `ref ${u.name}` : u.name;
      toast.info(`Dry run · Step ${u.idx + 1}/${flow.length} · ${label}`, JSON.stringify(u.form, null, 2));
    });
    if (merged.length > 0) {
      const combined = {};
      merged.forEach((u) => Object.assign(combined, u.form));
      mirrorComments(combined);
      const positions = merged.map((u) => u.idx + 1).join(", ");
      toast.info(`Dry run · Steps ${positions} merged → single PATCH`, JSON.stringify(combined, null, 2));
    }
    return;
  }

  // ---- Real run: PATCH the incident on ServiceNow. ----
  const execBtn = card.querySelector(".btn-execute");
  const dryBtn = card.querySelector(".btn-dryrun");
  const setBusy = (busy) => {
    if (execBtn) {
      execBtn.disabled = busy;
      execBtn.textContent = busy ? "Running…" : "Execute";
    }
    if (dryBtn) dryBtn.disabled = busy;
  };

  // Lock the target record once: a ServiceNow tab switch mid-run must not
  // retarget the remaining PATCHes to a different incident.
  const endpoint = snowIncidentEndpoint();
  if (!endpoint) {
    toast.error(
      `Execute: ${title}`,
      "No ServiceNow incident context. Open the incident in ServiceNow and make sure its tab is active so the instance and sys_id are captured, then try again."
    );
    return;
  }

  setBusy(true);
  toast.info(`Executing: ${title}`, `${flow.length} step(s)`);
  try {
    // 1) action=true steps — PATCHed individually, in flow order.
    for (const u of solo) {
      const label = u.ref ? `ref ${u.name}` : u.name;
      const t = `Step ${u.idx + 1}/${flow.length} · ${label}`;
      const r = await snowPatchIncident(u.form, endpoint);
      if (r.ok) toast.success(`${t} · HTTP ${r.status}`, snowResultBody(r));
      else toast.error(`${t} failed`, snowResultBody(r));
    }

    // 2) Remaining steps — merged into a single final PATCH.
    if (merged.length > 0) {
      const combined = {};
      merged.forEach((u) => Object.assign(combined, u.form));
      mirrorComments(combined);
      const positions = merged.map((u) => u.idx + 1).join(", ");
      const t = `Steps ${positions} merged`;
      const r = await snowPatchIncident(combined, endpoint);
      if (r.ok) toast.success(`${t} · HTTP ${r.status}`, snowResultBody(r));
      else toast.error(`${t} failed`, snowResultBody(r));
    }

    if (solo.length === 0 && merged.length === 0 && errors.length === 0) {
      toast.info(`Executing: ${title}`, "Nothing to send.");
    }
  } finally {
    setBusy(false);
  }
}
