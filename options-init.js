/* ---------- Load + live sync ---------- */
function migrateLegacy(data) {
  if (
    Array.isArray(data.sreCommons) &&
    data.sreCommons.length &&
    (!data.sreComponents || data.sreComponents.length === 0)
  ) {
    chrome.storage.local.set({ sreComponents: data.sreCommons });
    return data.sreCommons.map(normalizeCard);
  }
  return Array.isArray(data.sreComponents) ? data.sreComponents : [];
}

chrome.storage.local.get(
  ["sreConfig", "sreComponents", "sreCommons", "srePlaybooks", "sreForms", "sreRingtones", "sreChatSpaceRules"],
  (data) => {
    fillSettingsForm(data.sreConfig || {});
    components = migrateLegacy(data).map(normalizeCard);
    playbooks = (Array.isArray(data.srePlaybooks) ? data.srePlaybooks : []).map(
      normalizeCard
    );
    forms = Array.isArray(data.sreForms) ? data.sreForms : [];
    forms = forms.map((r) => (r.id ? r : { id: uid(), ...r }));
    ringtones = Array.isArray(data.sreRingtones) ? data.sreRingtones : [];
    chatRules = Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [];
    chatRules = chatRules.map((r) => (r.id ? r : { id: uid(), ...r }));
    renderCards("component");
    renderCards("playbook");
    renderForms();
    renderRingtones();
    renderChatRules();
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sreComponents) {
    const nv = (Array.isArray(changes.sreComponents.newValue)
      ? changes.sreComponents.newValue
      : []
    ).map(normalizeCard);
    if (JSON.stringify(nv) !== JSON.stringify(components)) {
      components = nv;
      renderCards("component");
      renderCards("playbook");
    }
  }
  if (changes.srePlaybooks) {
    const nv = (Array.isArray(changes.srePlaybooks.newValue)
      ? changes.srePlaybooks.newValue
      : []
    ).map(normalizeCard);
    if (JSON.stringify(nv) !== JSON.stringify(playbooks)) {
      playbooks = nv;
      renderCards("playbook");
    }
  }
  if (changes.sreForms) {
    const nv = Array.isArray(changes.sreForms.newValue)
      ? changes.sreForms.newValue
      : [];
    if (JSON.stringify(nv) !== JSON.stringify(forms)) {
      forms = nv.map((r) => (r.id ? r : { id: uid(), ...r }));
      renderForms();
      document.querySelectorAll(".pb-validation.visible").forEach((v) => {
        v.classList.remove("visible", "ok", "err", "warn");
        v.innerHTML = "";
      });
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

