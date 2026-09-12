/* tags.js — Tags base panel shell + ServiceNow Labels (tag) picker. */

// The Labels card — its own card, sitting above the playbooks / services
// panels, so refreshing the captured context never re-fetches the label list
// and vice versa. This card's refresh button re-fetches the picker candidates
// only (see tagsRefreshLabels).
function renderBaseTagsPanel() {
  const card = document.createElement("div");
  card.className = "snow-info snow-info-tags";

  const head = document.createElement("div");
  head.className = "snow-info-head";
  const icon = document.createElement("span");
  icon.className = "snow-info-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';
  const title = document.createElement("span");
  title.className = "snow-info-title";
  title.textContent = "Tags";

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "snow-refresh-btn";
  refresh.title = "Refresh label list";
  refresh.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
  refresh.addEventListener("click", () => tagsRefreshLabels(refresh));

  head.appendChild(icon);
  head.appendChild(title);
  head.appendChild(refresh);
  card.appendChild(head);
  card.appendChild(buildSnowTagSection());
  return card;
}

/* ---------- ServiceNow Labels (tag) picker ---------- */
//
// Rendered in its own "Labels" card directly below the Base Info card.
// Two moving parts:
//   * input/dropdown — auto-suggest / filter over the cached label list of the
//                current instance; picked labels become chips (multi-select).
//   * Add      — batch-attach every picked label to the current incident by
//                asking the active ServiceNow tab's content script to simulate
//                typing each name into the page's tag-it control.
// The label list is cached under chrome.storage.local key sreSnowLabels after
// a fetch; that fetch is driven by the Labels card's refresh button (the only
// path that re-hits ServiceNow).

const SN_LABEL_GROUP = "bcd9d8ac47243a1831c140d4116d43e5"; // fixed group filter from the original script
const SN_LABELS_KEY = "sreSnowLabels";

let snowLabelCache = null; // { at, instance, labels: [{ name, sys_id }] }
let snowTagRoot = null; // mounted .snow-tags section (rebuilt on render)
let snowTagApi = null; // refreshUi() hook of the currently mounted tag section
const snowTagSelected = new Map(); // label sys_id -> name, queued for the next Add

function normalizeLabelCache(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  if (!src) return null;
  const arr = Array.isArray(src.labels)
    ? src.labels
    : Array.isArray(src)
    ? src
    : [];
  const labels = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const name = it.name != null ? String(it.name).trim() : "";
    const sid = it.sys_id || it.sysid || "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    labels.push({ name, sys_id: String(sid) });
  }
  labels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { at: src.at || Date.now(), instance: src.instance || "", labels };
}

// Candidates shown in the dropdown: cached labels of the CURRENT instance only,
// so a switch to another instance simply yields an empty list until Refresh.
function snowCandidates() {
  const inst = (snowCtx && snowCtx.instance) || "";
  if (!inst || !snowLabelCache || snowLabelCache.instance !== inst) return [];
  return snowLabelCache.labels || [];
}

// Persist a freshly fetched label list both in memory and in chrome.storage.local
// (the cache that future side-panel renders read without hitting ServiceNow).
function snowSaveCache(labels) {
  const cache = {
    at: Date.now(),
    instance: (snowCtx && snowCtx.instance) || "",
    labels: labels || [],
  };
  snowLabelCache = normalizeLabelCache(cache);
  try {
    chrome.storage.local.set({ [SN_LABELS_KEY]: cache });
  } catch (_) {}
}

// Fetch every label of the fixed group from the current instance, paging 200
// records at a time (same pagination as the original manual script). Uses the
// captured UserToken + the browser's ServiceNow cookies, like the Info panel
// PATCHes do.
async function snowFetchLabels() {
  const c = snowCtx || {};
  if (!c.instance) {
    throw new Error("No ServiceNow instance captured. Open an incident page first.");
  }
  if (!c.token) {
    throw new Error("No UserToken captured. Open / refresh the incident page so the token is captured.");
  }
  const base = "https://" + c.instance + "/api/now/table/label";
  const headers = {
    Accept: "application/json",
    "X-UserToken": String(c.token),
  };
  const query = "group_listLIKE" + SN_LABEL_GROUP;
  const seen = new Set();
  const out = [];
  const PAGE = 200;
  for (let firstRow = 0, page = 0; page < 25; page++) {
    const qs = new URLSearchParams({
      sysparm_query: query,
      sysparm_limit: String(PAGE),
      sysparm_first_row: String(firstRow),
      sysparm_fields: "name,sys_id",
      sysparm_suppress_pagination_header: "true",
    });
    let resp;
    try {
      resp = await fetch(base + "?" + qs.toString(), {
        method: "GET",
        credentials: "include",
        headers,
      });
    } catch (e) {
      throw new Error("Network error while fetching labels: " + ((e && e.message) || e));
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error && j.error.message) msg += " — " + j.error.message;
      } catch (_) {}
      throw new Error("Label fetch failed (" + msg + ").");
    }
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {}
    const arr = data && Array.isArray(data.result) ? data.result : [];
    for (const r of arr) {
      if (!r) continue;
      const name = r.name != null ? String(r.name).trim() : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, sys_id: r.sys_id || r.sysid || "" });
    }
    if (arr.length < PAGE) break;
    firstRow += PAGE;
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

// Re-fetch the label list for the captured instance and repaint the picker.
// Owned by the Labels card's refresh button (the picker no longer rides on the
// Base Info refresh). Resolves true when labels were refreshed, false when no
// instance/token is captured. Errors are toasted here.
function refreshSnowLabelCache() {
  if (!(snowCtx && snowCtx.instance && snowCtx.token)) return Promise.resolve(false);
  return snowFetchLabels()
    .then((labels) => {
      snowSaveCache(labels);
      if (snowTagApi) snowTagApi.refreshUi();
      return true;
    })
    .catch((err) => {
      toast.error("Labels", String((err && err.message) || "Label refresh failed."));
      return false;
    });
}

// Manual refresh of the Labels card: re-fetch the picker candidates only —
// never touches the captured context or the Base Info rows.
function tagsRefreshLabels(btn) {
  if (!(snowCtx && snowCtx.instance && snowCtx.token)) {
    toast.error("Labels", "Open a ServiceNow incident page first so the token is captured.");
    return;
  }
  btn.classList.add("busy");
  refreshSnowLabelCache().finally(() => btn.classList.remove("busy"));
}

// Toggle Add / Refresh availability from the current incident context. Called
// on every snow_ctx change and whenever the section repaints.
function snowTagCtxTick() {
  if (!snowTagRoot || !snowTagRoot.isConnected) return;
  const okCtx = !!(snowCtx && snowCtx.instance && snowCtx.token);
  const add = snowTagRoot.querySelector(".snow-tags-add");
  if (add && !snowTagRoot.classList.contains("busy")) {
    add.disabled = !okCtx || snowTagSelected.size === 0;
  }
}

function buildSnowTagSection() {
  const root = document.createElement("div");
  root.className = "snow-tags";
  snowTagRoot = root;

  // --- Row: combo input + Add ---
  const row = document.createElement("div");
  row.className = "snow-tags-row";

  const combo = document.createElement("div");
  combo.className = "snow-tags-combo";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "snow-tags-input";
  input.placeholder = "Type to filter labels…";
  input.autocomplete = "off";
  input.spellcheck = false;
  const drop = document.createElement("div");
  drop.className = "snow-tags-drop";
  combo.appendChild(input);
  combo.appendChild(drop);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "snow-tags-btn snow-tags-add";
  addBtn.textContent = "Add";
  addBtn.title = "Attach the selected labels to the current incident";

  row.appendChild(combo);
  row.appendChild(addBtn);
  root.appendChild(row);

  const chips = document.createElement("div");
  chips.className = "snow-tags-chips";
  root.appendChild(chips);

  // --- Repaint helpers (touch only the label subtree, never the whole page) ---
  const hideDrop = () => drop.classList.remove("open");
  // True while we programmatically refocus the input right after a pick, so the
  // focus handler skips reopening the dropdown. The next real focus (clicking
  // the field again, typing) reopens it as usual.
  let suppressFocusDrop = false;

  const filterCandidates = () => {
    const filter = input.value.trim().toLowerCase();
    return snowCandidates().filter((l) => {
      if (snowTagSelected.has(l.sys_id || l.name)) return false;
      return !filter || l.name.toLowerCase().indexOf(filter) !== -1;
    });
  };

  const selectLabel = (l) => {
    const key = l.sys_id || l.name;
    if (snowTagSelected.has(key)) return;
    snowTagSelected.set(key, l.name);
    input.value = "";
    // Most incidents need only one label (rarely two), so close the dropdown
    // right after a pick instead of leaving it open over the chips. Focus stays
    // on the input: typing again immediately shows the filtered candidates.
    repaintNoDrop();
    if (document.activeElement !== input) {
      suppressFocusDrop = true;
      input.focus();
    }
  };

  const repaintChips = () => {
    chips.innerHTML = "";
    if (snowTagSelected.size === 0) {
      chips.style.display = "none";
      return;
    }
    chips.style.display = "flex";
    Array.from(snowTagSelected.entries()).forEach(([sid, name]) => {
      const chip = document.createElement("span");
      chip.className = "snow-tag-chip";
      const txt = document.createElement("span");
      txt.textContent = name;
      txt.title = name;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "snow-tag-x";
      x.textContent = "×";
      x.title = "Remove " + name;
      // Keep focus on the search input while pressing the remove button: this
      // prevents the blur → dropdown flash and lets the user delete several
      // chips in a row without re-focusing.
      x.addEventListener("mousedown", (e) => e.preventDefault());
      x.addEventListener("click", () => {
        snowTagSelected.delete(sid);
        repaintNoDrop();
      });
      chip.appendChild(txt);
      chip.appendChild(x);
      chips.appendChild(chip);
    });
  };

  const repaintDrop = () => {
    const cands = filterCandidates();
    drop.innerHTML = "";
    if (cands.length === 0) {
      hideDrop();
      return;
    }
    cands.slice(0, 30).forEach((l) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "snow-tag-opt";
      item.textContent = l.name;
      item.title = l.sys_id || l.name;
      item.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus
      item.addEventListener("click", (e) => {
        e.preventDefault();
        selectLabel(l);
      });
      drop.appendChild(item);
    });
    // Never auto-open the dropdown: show it only while the user is actively
    // picking (the input is focused or has text) or it is already visible.
    // Passive repaints — initial render, Info refresh, ctx broadcasts — must
    // not pop the list open over the panels below.
    const wantsOpen =
      document.activeElement === input ||
      input.value.trim().length > 0 ||
      drop.classList.contains("open");
    drop.classList.toggle("open", wantsOpen);
  };

  const repaintAll = () => {
    repaintChips();
    snowTagCtxTick();
  };

  // Quiet repaint used after picking/removing a chip or finishing an Add:
  // refresh chips & the Add button but keep the dropdown closed.
  const repaintNoDrop = () => {
    hideDrop();
    repaintChips();
    snowTagCtxTick();
  };

  const setBusy = (busy) => {
    root.classList.toggle("busy", busy);
    addBtn.disabled = busy || !(snowCtx && snowCtx.instance) || snowTagSelected.size === 0;
  };

  // Exposed to the Labels card refresh button so it can repaint the picker
  // after a label cache refresh. repaintDrop is gated, so this never pops the
  // dropdown open on its own.
  snowTagApi = {
    refreshUi: () => {
      repaintChips();
      repaintDrop();
      snowTagCtxTick();
    },
  };

  // --- Input / dropdown events ---
  input.addEventListener("input", repaintDrop);
  input.addEventListener("focus", () => {
    if (suppressFocusDrop) {
      suppressFocusDrop = false;
      return;
    }
    repaintDrop();
  });
  input.addEventListener("blur", () => setTimeout(hideDrop, 160));
  // Clicking the already-focused field reopens the list (e.g. to add a second
  // label after a pick closed it).
  input.addEventListener("click", () => {
    if (!drop.classList.contains("open")) repaintDrop();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.keyCode === 13) {
      e.preventDefault();
      // Only confirm the top candidate while the dropdown is visible, so Enter
      // never blindly attaches an invisible label after a pick closed it.
      if (!drop.classList.contains("open")) return;
      const top = filterCandidates()[0];
      if (top) selectLabel(top);
    } else if ((e.key === "Backspace" || e.keyCode === 8) && !input.value) {
      const keys = Array.from(snowTagSelected.keys());
      const last = keys[keys.length - 1];
      if (last !== undefined) {
        snowTagSelected.delete(last);
        repaintNoDrop(); // keep the dropdown closed while deleting
      }
    } else if (e.key === "Escape" || e.keyCode === 27) {
      hideDrop();
      input.blur();
    }
  });

  // --- Add: batch-attach every picked label via the page's tag-it widget ---
  addBtn.addEventListener("click", () => {
    const c = snowCtx || {};
    if (!c.instance) {
      toast.error("Add labels", "Open a ServiceNow incident page first, then add labels.");
      return;
    }
    const names = Array.from(snowTagSelected.values());
    if (names.length === 0) {
      toast.info("Add labels", "Pick one or more labels first.");
      return;
    }
    setBusy(true);
    addBtn.textContent = "Adding…";
    const settle = () => {
      addBtn.textContent = "Add";
      setBusy(false);
    };
    try {
      chrome.runtime.sendMessage({ type: "snow_add_tags", names }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          settle();
          toast.error(
            "Add labels",
            "Could not reach the ServiceNow tab. Reload the incident page and try again."
          );
          return;
        }
        if (!resp.ok) {
          settle();
          toast.error("Add labels failed", String(resp.error || "Unknown error."));
          return;
        }
        const r = (resp && resp.result) || {};
        if (r && r.error) {
          settle();
          toast.error("Add labels failed", String(r.error));
          return;
        }
        const added = r && Array.isArray(r.added) ? r.added.length : names.length;
        settle();
        toast.success("Labels added", "Added " + added + " label(s) to the current incident.");
        snowTagSelected.clear();
        repaintNoDrop(); // close the dropdown after a completed Add
      });
    } catch (e) {
      settle();
      toast.error("Add labels", String((e && e.message) || e));
    }
  });

  repaintAll();
  return root;
}
