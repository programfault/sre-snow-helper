/* ---------- Load + live sync ---------- */

chrome.storage.local.get(
  ["sreCommonSteps", "sreServices", "srePlaybooks", "sreForms", "sreRingtones", "sreChatSpaceRules"],
  (data) => {
    if (data.sreCommonSteps && typeof data.sreCommonSteps.yaml === "string") {
      commonDoc = data.sreCommonSteps;
    }
    if (data.sreServices && typeof data.sreServices.yaml === "string") {
      servicesDoc = data.sreServices;
    }
    playbooks = (Array.isArray(data.srePlaybooks) ? data.srePlaybooks : []).map(
      normalizeCard
    );
    forms = Array.isArray(data.sreForms) ? data.sreForms : [];
    forms = forms.map((r) => (r.id ? r : { id: uid(), ...r }));
    ringtones = Array.isArray(data.sreRingtones) ? data.sreRingtones : [];
    chatRules = Array.isArray(data.sreChatSpaceRules) ? data.sreChatSpaceRules : [];
    chatRules = chatRules.map((r) => (r.id ? r : { id: uid(), ...r }));
    renderCommonDoc();
    renderServicesDoc();
    renderCards();
    renderForms();
    renderRingtones();
    renderChatRules();
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sreCommonSteps) {
    const nv = changes.sreCommonSteps.newValue;
    const next =
      nv && typeof nv.yaml === "string" ? { ...nv } : null;
    if (next === null) {
      if (commonDoc !== null) {
        commonDoc = null;
        renderCommonDoc();
      }
    } else if (JSON.stringify(next) !== JSON.stringify(commonDoc)) {
      commonDoc = next;
      renderCommonDoc();
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
  if (changes.srePlaybooks) {
    const nv = (Array.isArray(changes.srePlaybooks.newValue)
      ? changes.srePlaybooks.newValue
      : []
    ).map(normalizeCard);
    if (JSON.stringify(nv) !== JSON.stringify(playbooks)) {
      playbooks = nv;
      renderCards();
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
