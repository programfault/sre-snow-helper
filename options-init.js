/* ---------- Load + live sync ---------- */

chrome.storage.local.get(
  [
    "sreFlowBundle",
    // Migration marker — set once after the legacy keys are converted so an
    // intentionally-emptied bundle never resurrects the old data.
    "sreFlowBundleMigrated",
    // Legacy keys — read only to run the one-time migration below.
    "sreCommonSteps",
    "srePlaybooks",
    "sreServices",
    "sreForms",
    "sreRingtones",
    "sreChatSpaceRules",
  ],
  (data) => {
    // NOTE: background.js seeds an empty sreFlowBundle ({id:"", yaml:""}) on
    // install/update. An empty yaml must NOT count as "bundle exists" — it
    // would skip the legacy migration and leave sreFlowBundleMigrated unset,
    // which makes the sidepanel ignore the bundle forever (it only trusts the
    // bundle once that marker exists).
    const hasBundle =
      data.sreFlowBundle &&
      typeof data.sreFlowBundle.yaml === "string" &&
      data.sreFlowBundle.yaml.trim() !== "";
    if (hasBundle) {
      bundleDoc = data.sreFlowBundle;
      // Bundle content exists but the migration marker never got set (e.g.
      // the user authored the bundle directly). Make the bundle authoritative
      // now, otherwise the sidepanel keeps rendering legacy playbooks.
      if (!data.sreFlowBundleMigrated) {
        chrome.storage.local.set({ sreFlowBundleMigrated: true });
      }
    } else if (
      !data.sreFlowBundleMigrated &&
      ((Array.isArray(data.srePlaybooks) && data.srePlaybooks.length > 0) ||
        (data.sreCommonSteps && typeof data.sreCommonSteps.yaml === "string"))
    ) {
      // One-time migration: legacy playbook cards + Common Steps doc ->
      // unified bundle (refs expanded into per-card templates, ${paramN}
      // rewritten to named variables). Legacy keys are kept untouched as a
      // backup; the bundle becomes the source of truth from now on.
      try {
        const yaml = Y.migrateLegacy({
          playbooks: Array.isArray(data.srePlaybooks) ? data.srePlaybooks : [],
          commonYaml:
            data.sreCommonSteps && typeof data.sreCommonSteps.yaml === "string"
              ? data.sreCommonSteps.yaml
              : "",
        });
        bundleDoc = { id: uid(), yaml };
        persistBundleDoc();
        chrome.storage.local.set({ sreFlowBundleMigrated: true });
      } catch (e) {
        // Never block the options page on a migration failure — start empty.
        bundleDoc = null;
      }
    }
    if (data.sreServices && typeof data.sreServices.yaml === "string") {
      servicesDoc = data.sreServices;
    }
    forms = Array.isArray(data.sreForms) ? data.sreForms : [];
    forms = forms.map((r) => (r.id ? r : { id: uid(), ...r }));
    ringtones = Array.isArray(data.sreRingtones) ? data.sreRingtones : [];
    chatRules = Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [];
    chatRules = chatRules.map((r) => (r.id ? r : { id: uid(), ...r }));
    renderBundleDoc();
    renderServicesDoc();
    renderForms();
    renderRingtones();
    renderChatRules();
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sreFlowBundle) {
    const nv = changes.sreFlowBundle.newValue;
    const next =
      nv && typeof nv.yaml === "string" ? { ...nv } : null;
    if (next === null) {
      if (bundleDoc !== null) {
        bundleDoc = null;
        renderBundleDoc();
      }
    } else if (JSON.stringify(next) !== JSON.stringify(bundleDoc)) {
      bundleDoc = next;
      renderBundleDoc();
    }
  }
  if (changes.sreServices) {
    const nv = changes.sreServices.newValue;
    const next =
      nv && typeof nv.yaml === "string" ? { ...nv } : null;
    if (next === null) {
      if (servicesDoc !== null) {
        servicesDoc = null;
        renderServicesDoc();
      }
    } else if (JSON.stringify(next) !== JSON.stringify(servicesDoc)) {
      servicesDoc = next;
      renderServicesDoc();
    }
  }
  if (changes.sreForms) {
    const nv = Array.isArray(changes.sreForms.newValue)
      ? changes.sreForms.newValue
      : [];
    if (JSON.stringify(nv) !== JSON.stringify(forms)) {
      forms = nv.map((r) => (r.id ? r : { id: uid(), ...r }));
      renderForms();
    }
  }
  if (changes.sreRingtones) {
    const nv = Array.isArray(changes.sreRingtones.newValue) ? changes.sreRingtones.newValue : [];
    if (JSON.stringify(nv) !== JSON.stringify(ringtones)) {
      ringtones = nv;
      renderRingtones();
      renderChatRules(); // ringtone dropdown reflects new list
    }
  }
  if (changes.sreChatSpaceRules) {
    const nv = Array.isArray(changes.sreChatSpaceRules.newValue) ? changes.sreChatSpaceRules.newValue : [];
    const norm = nv.map((r) => (r.id ? r : { id: uid(), ...r }));
    if (JSON.stringify(norm) !== JSON.stringify(chatRules)) {
      chatRules = norm;
      renderChatRules();
    }
  }
});
