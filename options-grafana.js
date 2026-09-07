// SRE Helper options — Grafana settings.
//
// Backs the side panel's Logs (Loki) card. Two values:
//   domain — Grafana origin (default clairvoyance.sre.globe.com.ph), and
//   dsUid  — Loki datasource UID inside that Grafana.
// Persisted under chrome.storage.local key sreGrafana. The side panel reads
// this key fresh on every query, so no cross-page notification is required.

const GRAFANA_STORE = "sreGrafana";
const GRAFANA_FALLBACK = {
  domain: "https://clairvoyance.sre.globe.com.ph",
  dsUid: "prod-gcp-field-service-mgt-logs",
};

let grafSaveTimer = null;

function grafStatusEl() {
  return document.getElementById("grafStatus");
}

function grafPersistSoon() {
  const status = grafStatusEl();
  if (status) {
    status.textContent = "Saving…";
    status.classList.remove("saved");
  }
  clearTimeout(grafSaveTimer);
  grafSaveTimer = setTimeout(() => {
    const settings = {
      domain: document.getElementById("grafDomain").value.trim(),
      dsUid: document.getElementById("grafDsUid").value.trim(),
    };
    chrome.storage.local.set({ [GRAFANA_STORE]: settings }, () => {
      const st = grafStatusEl();
      if (st) {
        st.textContent = "Saved.";
        st.classList.add("saved");
      }
    });
  }, 400);
}

function renderGrafanaSettings() {
  chrome.storage.local.get(GRAFANA_STORE, (data) => {
    const g = (data && data.sreGrafana) || {};
    const domain = document.getElementById("grafDomain");
    const dsUid = document.getElementById("grafDsUid");
    if (domain) {
      domain.value = g.domain && String(g.domain).trim()
        ? String(g.domain)
        : GRAFANA_FALLBACK.domain;
    }
    if (dsUid) {
      dsUid.value = g.dsUid && String(g.dsUid).trim()
        ? String(g.dsUid)
        : GRAFANA_FALLBACK.dsUid;
    }
  });
}

(function initGrafanaSettings() {
  const domain = document.getElementById("grafDomain");
  const dsUid = document.getElementById("grafDsUid");
  if (domain) domain.addEventListener("input", grafPersistSoon);
  if (dsUid) dsUid.addEventListener("input", grafPersistSoon);
  renderGrafanaSettings();
})();
