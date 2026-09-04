/* ---------- Services single-document editor ---------- */
// Hosted on the "Services" tab. A single CodeMirror editor over the whole
// shared document (top-level `services:` list). Each entry is either an API
// call (method / endpoint / header / body, optional `output`) or a group
// (type: group with its own nested `services:`) that the side panel runs as
// one unit, top to bottom.
//
// Variable rule: everything is written ${name}. A ${name} that equals an
// `output.alias` of an EARLIER service inside the SAME group resolves from
// the chain automatically (no UI input); every other ${name} is prompted as
// a user input at run time.

// Shown when the document is empty / as an onboarding guide.
const SERVICES_DOC_PLACEHOLDER =
  [
    "# One shared document of runnable services.",
    "# Top-level entries are shown in the side panel. Each is either:",
    "#   - an API call:  name, desc?, method (GET when omitted), endpoint,",
    "#                   header?, body?, output?",
    "#   - a group:      name, desc?, type: group, then nested `services:`",
    "#                   (children run top to bottom as one unit)",
    "#",
    "# output:  [ { alias, json_path } ]   expose response values to LATER",
    "#          services inside the same group via json_path (e.g. $.data.id).",
    "#",
    "# References are plain ${name}. If ${name} equals an `output.alias` of an",
    "# earlier service in the same group it is filled from the chain; any other",
    "# ${name} is prompted as an input box when the panel runs the item.",
    "services:",
    "  - name: Login group",
    "    type: group",
    "    services:",
    "      - name: login",
    "        method: POST",
    "        endpoint: http://localhost:8787/login",
    "        desc: Real local test server (api-server/server.js)",
    "        header:",
    "          Content-Type: application/json",
    "        body:",
    "          username: ${username}",
    "          password: ${password}",
    "        output:",
    "          - alias: accessToken",
    "            json_path: $.data.accessToken",
    "      - name: my tasks",
    "        method: GET",
    "        endpoint: http://localhost:8787/tasks",
    "        header:",
    "          Authorization: Bearer ${accessToken}",
  ].join("\n");

let servicesCm = null;

// Mount (once) or update the editor to reflect the current `servicesDoc`.
function renderServicesDoc() {
  const container = document.getElementById("servicesEditor");
  if (!container) return;
  const yaml = (servicesDoc && servicesDoc.yaml) || "";

  if (servicesCm) {
    // Don't clobber the editor when storage echoes back our own debounced
    // saves, and never interrupt an active edit. Only adopt a genuinely
    // external change (e.g. a second options page).
    const active =
      document.activeElement === servicesCm.getWrapperElement() ||
      servicesCm.getWrapperElement().contains(document.activeElement);
    if (!active && servicesCm.getValue() !== yaml) servicesCm.setValue(yaml);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.spellcheck = false;
  container.appendChild(textarea);
  servicesCm = mountYamlEditor(textarea, SERVICES_DOC_PLACEHOLDER);
  if (yaml) servicesCm.setValue(yaml);

  servicesCm.on("change", () => {
    const v = servicesCm.getValue();
    if (!servicesDoc) {
      servicesDoc = { id: uid(), yaml: v };
    } else {
      servicesDoc.yaml = v;
    }
    saveServicesDoc();
    // Document is dirty again — clear the last validation report.
    const valEl = document.getElementById("servicesValidation");
    if (valEl && valEl.classList.contains("visible")) {
      valEl.classList.remove("visible", "ok", "err", "warn");
      valEl.innerHTML = "";
    }
  });
}

const servicesValidateBtn = document.getElementById("validateServicesDoc");
if (servicesValidateBtn) {
  servicesValidateBtn.addEventListener("click", () => {
    const valEl = document.getElementById("servicesValidation");
    const report = Y.validateServicesDoc((servicesDoc && servicesDoc.yaml) || "");
    renderValidationBox(valEl, report);
  });
}
