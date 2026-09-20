/* bundle-test.js — node smoke test for the v3 flow bundle functions.
 * Run: node tests/bundle-test.js
 * (yaml-lite.js attaches to `this` at module scope, so it require()s cleanly.)
 */
"use strict";

const _mod = require("../yaml-lite.js");
// In node the IIFE attaches SRE_YAML to module.exports (the `this` fallback);
// in the browser it lands on window/self.
const Y = _mod.SRE_YAML || _mod;

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("  ok  - " + name);
  } else {
    failures++;
    console.log("  FAIL - " + name + (extra ? "\n         " + extra : ""));
  }
}

/* ---------- 1. parse + materialize the v3.2 sample ---------- */
console.log("[1] parseBundle + materializeBundle (v3.2 sample)");
const sample = `
version: 3

params:
- name: business_service
  type: option

common:
- name: ResolvedTemplate
  steps:
  - name: ack
    action: true
    items:
      state: 2
      work_notes: ack
      assigned_to: 3a302e092be60f107d50f4b20391bf02
  - name: update basic info
    action: true
    items:
      assigned_to: 3a302e092be60f107d50f4b20391bf02
      state: 6
      cmdb_ci: 254fc66147d8b61431c140d4116d4355
      u_application_service_incident: 2
- name: AskTemplate
  steps:
  - name: set ask state
    action: true
    items:
      state: 3
      work_notes: waiting for info
      assigned_to: 3a302e092be60f107d50f4b20391bf02

groups:
- group: Resolved
  common: ResolvedTemplate
  flows:
  - name: Device activation
    items:
      work_notes: Device activation is completed
      comments: ""
      u_initial_assessment: Device activation is pending completion
      close_notes: Device activation is completed
      business_service: \${business_service}
  - name: Modem replacement
    items:
      work_notes: Modem replacement completed
      close_notes: Modem replacement completed
      business_service: \${business_service}

- group: Ask
  common: AskTemplate
  flows:
  - name: Request customer info
    items:
      work_notes: Please provide serial number
      business_service: \${business_service}
`;

const parsed = Y.parseBundle(sample);
check("no raw errors", parsed.rawErrors.length === 0, parsed.rawErrors.join("; "));
check("1 param parsed", parsed.params.length === 1 && parsed.params[0].name === "business_service" && parsed.params[0].type === "option");
check("2 templates", parsed.commons.length === 2 && parsed.commons[0].steps.length === 2);
check("template action parsed as boolean", parsed.commons[0].steps[0].action === true);
check("2 groups", parsed.groups.length === 2);

const mat = Y.materializeBundle(parsed);
check("3 flows materialized", mat.flows.length === 3, JSON.stringify(mat.issues));
check("no materialize issues", mat.issues.length === 0, mat.issues.join("; "));
check("flow ids unique + stable",
  new Set(mat.flows.map((f) => f.id)).size === 3 &&
  mat.flows[0].id === Y.materializeBundle(parsed).flows[0].id);
check("group labels attached", mat.flows[0].group === "Resolved" && mat.flows[2].group === "Ask");

const devYaml = mat.flows[0].yaml;
const header = Y.parseHeader(devYaml);
check("materialized header", header.name === "Device activation");
const devParams = Y.parseParams(devYaml);
check("materialized params (named)", devParams.length === 1 && devParams[0].name === "business_service");
const devFlow = Y.parseFlow(devYaml);
check("template steps expanded + own items appended", devFlow.length === 3);
check("no refs remain", devFlow.every((s) => !s.ref));
check("action preserved on expanded steps", devFlow[0].action === true && devFlow[2].action !== true);

// named-variable resolution: file params win over captured globals
const values = Object.assign(
  { business_service: "GLOBAL-SHOULD-LOSE", incidentId: "abc123" },
  { business_service: "254fc66147d8b61431c140d4116d4355" }
);
const resolved = {};
Object.entries(devFlow[2].form).forEach(([k, v]) => {
  resolved[k] = Y.resolvePlaceholders(v, values);
});
check("named variable resolved", resolved.business_service === "254fc66147d8b61431c140d4116d4355", resolved.business_service);
check("global variable resolved", Y.resolvePlaceholders("${incidentId}", values) === "abc123");

/* ---------- 2. validation ---------- */
console.log("[2] validateBundle");
const forms = [
  { name: "state", label: "State", value: "2", type: "number" },
  { name: "state", label: "State", value: "3", type: "number" },
  { name: "state", label: "State", value: "6", type: "number" },
  { name: "work_notes", label: "Work notes", value: "", type: "string" },
  { name: "comments", label: "Comments", value: "", type: "string" },
  { name: "assigned_to", label: "Assigned to", value: "3a302e092be60f107d50f4b20391bf02", type: "sysid" },
  { name: "cmdb_ci", label: "CI", value: "254fc66147d8b61431c140d4116d4355", type: "sysid" },
  { name: "u_application_service_incident", label: "App service", value: "2", type: "sysid" },
  { name: "u_initial_assessment", label: "Initial assessment", value: "", type: "string" },
  { name: "close_notes", label: "Close notes", value: "", type: "string" },
  { name: "close_code", label: "Close code", value: "Solved (Work Around)", type: "string" },
  { name: "business_service", label: "Business service", value: "254fc66147d8b61431c140d4116d4355", type: "sysid" },
];
const formsByName = Y.indexForms(forms);
const report = Y.validateBundle(sample, formsByName);
check("sample validates clean", report.ok && report.warnings.length === 0, JSON.stringify(report));

const badSample = sample
  .replace("common: ResolvedTemplate\n  flows:\n  - name: Device activation", "common: NoSuchTemplate\n  flows:\n  - name: Device activation")
  .replace("state: 2", "state: 9")
  .replace("business_service: ${business_service}", "business_service: ${buisness_service}");
const badReport = Y.validateBundle(badSample, formsByName);
check("missing template reported", badReport.errors.some((e) => e.includes("NoSuchTemplate")), badReport.errors.join("; "));
check("bad form value reported", badReport.errors.some((e) => e.includes('must be one of')), badReport.errors.join("; "));
check("typo variable is an ERROR (strict mode)", badReport.errors.some((e) => e.includes("buisness_service")), badReport.errors.join("; "));

/* ---------- 3. legacy migration ---------- */
console.log("[3] migrateLegacy");
const legacyCommon = `
params:
  - name: Assigned To SysId
common_steps:
  ack:
    action: true
    form:
      state: 2
      work_notes: ack
      assigned_to: \${param0}
  resolve:
    action: true
    form:
      assigned_to: \${param0}
      state: 6
      close_code: Solved (Work Around)
`;
const legacyPlaybooks = [
  {
    id: "card1",
    yaml: [
      "name: Ack only",
      "desc: Only ack",
      "flow:",
      "  - name: ack user",
      "    ref: ack",
    ].join("\n"),
  },
  {
    id: "card2",
    yaml: [
      "name: Resolved",
      "desc: Complete work order",
      "params:",
      "  - name: business_service",
      "    type: option",
      "flow:",
      "  - name: resolve it",
      "    ref: resolve",
      "  - name: Leave Message",
      "    form:",
      "      work_notes: Work order is completed",
      "      business_service: ${param0}",
    ].join("\n"),
  },
];
const migratedYaml = Y.migrateLegacy({ playbooks: legacyPlaybooks, commonYaml: legacyCommon });
const migrated = Y.parseBundle(migratedYaml);
check("migration: no raw errors", migrated.rawErrors.length === 0, migrated.rawErrors.join("; "));
check("migration: merged params", migrated.params.some((p) => p.name === "Assigned To SysId") && migrated.params.some((p) => p.name === "business_service"));
check("migration: 2 groups / 2 templates", migrated.groups.length === 2 && migrated.commons.length === 2);
const ackTpl = migrated.commons.find((c) => c.name === "Ack only Template");
check("migration: ref expanded with common params rewritten",
  ackTpl && ackTpl.steps[0].items.assigned_to === "${Assigned To SysId}",
  ackTpl && JSON.stringify(ackTpl.steps[0].items));
const mat2 = Y.materializeBundle(migrated);
check("migration: materializes to 2 flows", mat2.flows.length === 2 && mat2.issues.length === 0, mat2.issues.join("; "));
const migratedReport = Y.validateBundle(migratedYaml, formsByName);
check("migration: validates", migratedReport.ok, JSON.stringify(migratedReport.errors));
const card2Mat = mat2.flows.find((f) => f.group === "Resolved");
const c2Flow = Y.parseFlow(card2Mat.yaml);
const c2Values = { "Assigned To SysId": "SYS-1", business_service: "BS-9" };
const c2Resolved = {};
c2Flow.forEach((st) => {
  Object.entries(st.form || {}).forEach(([k, v]) => {
    c2Resolved[k] = Y.resolvePlaceholders(v, c2Values);
  });
});
check("migration: card2 items resolve named vars", c2Resolved.business_service === "BS-9", JSON.stringify(c2Resolved));
check("migration: card2 ref step resolved", c2Resolved.assigned_to === "SYS-1", JSON.stringify(c2Resolved));

/* ---------- 4. serializer round-trip ---------- */
console.log("[4] serializeBundle round-trip");
const round = Y.parseBundle(Y.serializeBundle(migrated));
check("round-trip params equal", JSON.stringify(round.params) === JSON.stringify(migrated.params));
check("round-trip commons equal", JSON.stringify(round.commons) === JSON.stringify(migrated.commons));
check("round-trip groups equal", JSON.stringify(round.groups) === JSON.stringify(migrated.groups));

/* ---------- 6. steps library, refs, multi-step flows ---------- */
console.log("[6] steps library + refs + flow steps");
const libSample = `
version: 3

params:
- name: business_service
  type: option

steps:
- name: ack
  action: true
  items:
    state: 2
    work_notes: ack
- name: resolve
  action: true
  items:
    state: 6

common:
- name: T
  steps:
  - ref: ack
  - ref: resolve

groups:
- group: G
  common: T
  flows:
  - name: F1
    items:
      work_notes: done
      business_service: \${business_service}
  - name: F2
    steps:
    - ref: resolve
    - name: note
      items:
        work_notes: note text
`;
const libParsed = Y.parseBundle(libSample);
check("library parsed", libParsed.steps.length === 2 && libParsed.steps[0].name === "ack");
check("template ref entries kept", libParsed.commons[0].steps[0].ref === "ack");
const libMat = Y.materializeBundle(libParsed);
check("library materializes with no issues", libMat.issues.length === 0, libMat.issues.join("; "));
const f1Flow = Y.parseFlow(libMat.flows[0].yaml);
check("refs expanded in template (2) + own items (1)", f1Flow.length === 3 && f1Flow.every((s) => !s.ref));
check("ref step action inherited", f1Flow[0].action === true && f1Flow[2].action !== true);
const f2Flow = Y.parseFlow(libMat.flows[1].yaml);
check("flow steps list expanded after template",
  f2Flow.length === 4 &&
  f2Flow[0].name === "ack" && f2Flow[1].name === "resolve" &&
  f2Flow[2].name === "resolve" && f2Flow[3].name === "note",
  JSON.stringify(f2Flow.map((s) => s.name)));
const libReport = Y.validateBundle(libSample, formsByName);
check("library bundle validates", libReport.ok, JSON.stringify(libReport.errors));

const missingRef = libSample.replace("- ref: ack", "- ref: nope");
check("missing library ref is an error",
  Y.validateBundle(missingRef, formsByName).errors.some((e) => e.includes('"nope"')));
const bothSample = libSample.replace(
  "    steps:\n    - ref: resolve",
  "    items:\n      work_notes: x\n    steps:\n    - ref: resolve"
);
check("items + steps conflict is an error",
  Y.validateBundle(bothSample, formsByName).errors.some((e) => e.includes("not both")));

/* ---------- 7. ${var} autocomplete context ---------- */
console.log("[7] ${var} completion context");
const varLine = "      business_service: ${b";
const varCtx = Y.analyzeContext(varLine, varLine.length);
check("var context detected", varCtx && varCtx.kind === "var" && varCtx.prefix === "b", JSON.stringify(varCtx));
const varCtxEmpty = Y.analyzeContext("x: ${", "x: ${".length);
check("empty var context", varCtxEmpty && varCtxEmpty.kind === "var" && varCtxEmpty.prefix === "");
const varCtxClosed = Y.analyzeContext("x: ${b} rest", 13);
check("closed brace -> no var context", varCtxClosed === null || varCtxClosed.kind !== "var");
const varItems = Y.buildCompletions({
  kind: "var",
  params: ["business_service"],
  globals: ["incidentId", "business_service"],
});
check("var completions: params first, globals deduped",
  varItems.length === 2 &&
  varItems[0].label === "business_service" && varItems[0].group === "var-param" &&
  varItems[1].label === "incidentId" && varItems[1].group === "var-global",
  JSON.stringify(varItems));
check("var snippet includes closing brace", varItems[0].snippet === "business_service}");

/* ---------- 5. empty / degenerate docs ---------- */
console.log("[5] degenerate inputs");
const emptyMat = Y.materializeBundle(Y.parseBundle(""));
check("empty bundle -> no flows", emptyMat.flows.length === 0);
const emptyVal = Y.validateBundle("", formsByName);
check("empty bundle -> ok with warnings", emptyVal.ok && emptyVal.warnings.length > 0);

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
