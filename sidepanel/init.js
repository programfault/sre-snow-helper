/* init.js — bootstrap. Loaded LAST: starts the panel (loadState → render) and
   registers the storage.onChanged live-sync listener. */

/* ---------- Init + live sync ---------- */

loadState((data) => {
  render(data);
  refreshSnowContext();
  refreshGobleContext();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  // Only structural keys (the data this panel actually edits/renders) deserve a
  // full re-render. The chat-monitor keys below are written by the background
  // on every gchat heartbeat (~5s) and carry a fresh timestamp each time, so
  // treating them as structural made the panel rebuild its whole DOM every few
  // seconds — wiping any text the user was typing and closing open dropdowns.
  const structuralKeys = [
    "srePlaybooks",
    "sreCommonSteps",
    "sreServices",
    "sreForms",
    "srePanelState",
    "sreQueryTemplates",
  ];
  if (structuralKeys.some((k) => changes[k])) {
    loadState((data) => render(data));
    return;
  }
  // Chat monitor / rules only drive the header dot — refresh it in place.
  // (sreRingtones has no visual effect on this panel and is ignored here.)
  if (changes.sreChatMonitor || changes.sreChatSpaceRules) {
    chrome.storage.local.get("sreChatSpaceRules", (d) => {
      updateMonitorDot(
        Array.isArray(d.sreChatSpaceRules) ? d.sreChatSpaceRules : []
      );
    });
  }
});
