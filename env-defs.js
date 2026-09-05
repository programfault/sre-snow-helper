// env-defs.js — single source of truth for the "environment variables" the
// extension captures from the page the user is looking at.
//
// Shared by the side panel (header info popover) and the Options page
// ("Environment" tab) so a field list change never drifts between the two.
//
// Every field maps a captured snapshot key to a display label and the global
// placeholder YAML authors reference:
//   key   — property on the captured context snapshot (snowCtx / gobleCtx)
//   src   — which context family produced it: "snow" (ServiceNow) or
//           "goble" (FSM order pages: fsm.globe.com.ph / gsmgt-prod.gobetel.com)
//   label — human display name (shown in the UI; two-letter acronyms keep caps)
//   gvar  — the ${...} placeholder this value resolves (shown only where the
//           full reference is useful, e.g. the Options Environment page)
//   max   — truncation width for compact rows (full value stays in the title)
//
// Labels are display-only — renaming one never affects the ${gvar} it maps to.

(function (global) {
  const FIELDS = [
    { key: "number", src: "snow", label: "Incident", gvar: "number", max: 40 },
    { key: "callerName", src: "snow", label: "Caller Name", gvar: "caller_name", max: 40 },
    { key: "callerSysid", src: "snow", label: "Caller ID", gvar: "caller_sysid", max: 40 },
    { key: "token", src: "snow", label: "Service Token", gvar: "userToken", max: 26 },
    { key: "sysid", src: "snow", label: "Form ID", gvar: "incidentId", max: 40 },
    { key: "instance", src: "snow", label: "Instance", gvar: "instance", max: 40 },
    { key: "fwo", src: "goble", label: "Order Number", gvar: "f_wo_number", max: 40 },
    { key: "fsid", src: "goble", label: "Service ID", gvar: "f_sid", max: 40 },
    { key: "factok", src: "goble", label: "Access Token", gvar: "f_access_token", max: 26 },
  ];

  // Display group order + titles. goble covers both FSM domains.
  const SRC_ORDER = ["snow", "goble"];
  const SRC_TITLES = { snow: "ServiceNow", goble: "FSM order" };

  function bySrc(src) {
    return FIELDS.filter((f) => f.src === src);
  }

  // Long values are truncated to keep a row on one tidy line; the full value
  // is always available via the element title / the copy button.
  function display(raw, field) {
    const s = raw ? String(raw) : "";
    const max = (field && field.max) || 40;
    if (s.length <= max) return s;
    const mid = max - 1;
    const head = Math.ceil(mid / 2);
    return s.slice(0, head) + "…" + s.slice(s.length - (mid - head));
  }

  const COPY_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';

  global.SRE_ENV = {
    FIELDS,
    SRC_ORDER,
    SRC_TITLES,
    bySrc,
    display,
    COPY_SVG,
  };
})(window);
