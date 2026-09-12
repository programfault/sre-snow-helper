/* loki.js — Grafana Loki logs card. */

/* ---------- Grafana Loki logs card ---------- */
//
// Two-stage trace lookup against Loki (through the Grafana datasource proxy),
// scoped to a date range picked in the card and defaulting to today:
//
//   1. SEEK  — query the expression exactly as written (Options → Grafana
//              `defaultExpr`, e.g. `{app="app-workorder"} |= `183756226``) with
//              no severity filtering, and read the `traceId` off the newest
//              matching line.
//   2. FETCH — splice that traceId into the expression's backtick literal and
//              query again, keeping only lines whose `level` is warn/error; the
//              newest five are shown in the results popover.
//
// A missing traceId (no logs, or a line without the field) and an expression
// without a backtick literal both stop the run with a toast — never a second
// query against the wrong condition. Runs straight from this page: the
// browser's Grafana session cookie is what authenticates the proxy, so the only
// requirement is having logged in to Grafana before.
const GRAFANA_DEFAULT = {
  domain: "https://clairvoyance.sre.globe.com.ph",
  dsUid: "prod-gcp-field-service-mgt-logs",
};
const LOKI_DEFAULT_EXPR = '{app="app-workorder"} |= `183756226`';
const LOKI_ORG_ID = "312";
const LOKI_CHUNK_MS = 24 * 60 * 60 * 1000; // one request per day of the window
const LOKI_SEEK_LIMIT = 1; // stage 1 only needs the newest line
const LOKI_FETCH_LIMIT = 5000; // rows per chunk while hunting warn/error
const LOKI_MAX_RESULTS = 5; // newest warn/error rows surfaced to the user

// Backtick literal in a LogQL expression — the value swapped for the traceId.
const LOKI_BACKTICK_RE = /`[^`]*`/;

let lokiExpr = LOKI_DEFAULT_EXPR;
let lokiExprTouched = false; // user edited the expr input at least once
let lokiStartDate = lokiTodayStr(); // "YYYY-MM-DD", inclusive
let lokiEndDate = lokiTodayStr(); // "YYYY-MM-DD", inclusive
let lokiResults = null; // null = never ran; otherwise array (may be empty)
let lokiRunning = false;
let lokiError = "";
let lokiTraceId = ""; // traceId the last completed run was built around
let lokiResolvedExpr = ""; // expression actually queried in stage 2
let lokiRunRange = ""; // range label of the last completed run
let lokiScanned = 0; // stage 2 lines examined (0 results ⇒ tells you why)
let lokiOverlay = null; // lazily-created results popover

// Local calendar date as "YYYY-MM-DD" — the format <input type="date"> uses.
function lokiTodayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}

// Local-day bounds of one "YYYY-MM-DD": 00:00:00.000 → 23:59:59.999.
function lokiDayBounds(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map((n) => parseInt(n, 10));
  const startMs = new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime();
  return { startMs, endMs: startMs + LOKI_CHUNK_MS - 1 };
}

// The window actually queried: start date 00:00 → end date 23:59:59, clamped to
// "now" so a range ending today never reaches into the future.
function lokiRange() {
  const { startMs } = lokiDayBounds(lokiStartDate);
  const { endMs } = lokiDayBounds(lokiEndDate);
  return { startMs, endMs: Math.min(endMs, Date.now()) };
}

function lokiRangeText() {
  return lokiStartDate === lokiEndDate
    ? lokiStartDate
    : lokiStartDate + " → " + lokiEndDate;
}

function normalizeGrafanaDomain(raw) {
  let d = String(raw || "").trim();
  if (!d) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(d)) d = "https://" + d;
  return d.replace(/\/+$/, "");
}

function getGrafanaSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("sreGrafana", (data) => {
      const g = (data && data.sreGrafana) || {};
      resolve({
        domain: normalizeGrafanaDomain(g.domain) || GRAFANA_DEFAULT.domain,
        dsUid: (g.dsUid && String(g.dsUid).trim()) || GRAFANA_DEFAULT.dsUid,
        defaultExpr:
          (g.defaultExpr && String(g.defaultExpr).trim()) || LOKI_DEFAULT_EXPR,
      });
    });
  });
}

// Ask for host access at runtime for non-default Grafana domains
// (e.g. another host under the corporate SSO).
function ensureGrafanaHostPermission(origin) {
  const pattern = origin + "/*";
  if (!chrome.permissions || !chrome.permissions.contains) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [pattern] }, (has) => {
      if (chrome.runtime.lastError || has) return resolve(has);
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(!!granted);
      });
    });
  });
}

async function fetchLokiChunk(origin, dsUid, expr, startMs, endMs, limit) {
  const startNs = (BigInt(startMs) * 1000000n).toString();
  const endNs = (BigInt(endMs) * 1000000n).toString();
  const qs = new URLSearchParams({
    query: expr,
    start: startNs,
    end: endNs,
    limit: String(limit),
    direction: "BACKWARD", // newest first — "the first line" must mean the latest
  });
  const url =
    origin +
    "/api/datasources/proxy/uid/" +
    encodeURIComponent(dsUid) +
    "/loki/api/v1/query_range?" +
    qs.toString();
  const resp = await fetch(url, {
    credentials: "include",
    headers: { "X-Grafana-Org-Id": LOKI_ORG_ID },
  });
  if (!resp.ok) {
    throw new Error(
      "HTTP " +
        resp.status +
        (resp.status === 401 || resp.status === 403
          ? " — Grafana session expired? Open Grafana once and log in."
          : "")
    );
  }
  const j = await resp.json();
  if (j && j.status === "error") throw new Error(String(j.error || "Loki error"));
  return j && j.data ? j.data.result || [] : [];
}

// Walk the window one day at a time, newest chunk first, handing each raw log
// line to `visit` as { tsMs, line } (newest first within every chunk). `visit`
// returns true to stop the walk. Sorting here is what makes "the first line"
// mean the most recent one across the whole range rather than whichever line
// Loki happens to return first.
async function lokiWalkLines(origin, dsUid, expr, range, limit, visit) {
  let currentEndMs = range.endMs;
  while (currentEndMs > range.startMs) {
    const currentStartMs = Math.max(range.startMs, currentEndMs - LOKI_CHUNK_MS);
    const streams = await fetchLokiChunk(
      origin,
      dsUid,
      expr,
      currentStartMs,
      currentEndMs,
      limit
    );
    const lines = [];
    for (const stream of streams || []) {
      for (const pair of stream.values || []) {
        if (!Array.isArray(pair) || pair[0] == null) continue;
        lines.push({
          tsMs: Number(BigInt(String(pair[0])) / 1000000n),
          line: pair[1] || "",
        });
      }
    }
    lines.sort((a, b) => b.tsMs - a.tsMs);
    for (const it of lines) {
      if (visit(it)) return;
    }
    currentEndMs = currentStartMs - 1;
  }
}

function lokiCleanLine(line) {
  return String(line).replace(/\u001b\[[0-9;]*m/g, "");
}

// Log lines are hand-written, so a value can keep some framing after the match
// — `[warn]`, `"warn"` or `\"warn\"` should all read as `warn`. Only *wrapping*
// characters come off, so a message like `[ERROR] disk full` keeps its text.
function lokiTrimValue(v) {
  let s = String(v).trim();
  // Double-encoded lines (`{\"level\":\"warn\"}`) arrive with escaped quotes;
  // a trailing backslash is what is left when the closing quote was in the class.
  s = s.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\+$/, "").trim();
  s = s.replace(/^["']+/, "").replace(/["']+$/, "").trim();
  const wrapped = s.match(/^\[([\s\S]*)\]$/);
  if (wrapped) {
    s = wrapped[1].trim().replace(/^["']+/, "").replace(/["']+$/, "").trim();
  }
  return s.replace(/[}"';,\]]+$/, "").trim(); // leftovers from a bare capture
}

// Value of one `"name":"value"` field on a log line; "" when the field is
// absent. Quoted values win so their commas/spaces survive; a bare value is
// accepted as a fallback for lines that are not strictly JSON.
function lokiFieldValue(line, name) {
  const clean = lokiCleanLine(line);
  // `edge` keeps `logLevel` / `parentTraceId` from answering for `level` /
  // `traceId`; `[:=]` accepts both JSON (`"level":"error"`) and logfmt
  // (`level=error`) lines; the backslashes tolerate `\"level\":\"error\"`.
  const head =
    String.raw`(?:^|[^A-Za-z0-9_])["'\\]*` +
    name +
    String.raw`["'\\]*\s*[:=]\s*["'\[\s\\]*`;
  const quoted = clean.match(new RegExp(head + '["\']([^"\']*)["\']', "i"));
  if (quoted) return lokiTrimValue(quoted[1]);
  const bare = clean.match(new RegExp(head + "([^,\\s]+)", "i"));
  return bare ? lokiTrimValue(bare[1]) : "";
}

// Severity of a log line, read from its own `level` field. The value is matched
// loosely on purpose — `"warn"`, `[warn]`, `["WARN"]`, `'error'`, `level=warn`
// and a nested `\"level\":\"warn\"` all resolve — so bracket, array or
// re-quoted styles never hide a warn/error row. "" means the line is neither,
// and stage 2 skips it.
const LOKI_LEVEL_RE =
  /(?:^|[^A-Za-z0-9_])["'\\]*level["'\\]*\s*[:=]\s*["'\[\s\\]*(warn|warning|error)\b/i;

function lokiLevelFromLine(line) {
  const m = lokiCleanLine(line).match(LOKI_LEVEL_RE);
  if (!m) return "";
  const lv = m[1].toLowerCase();
  return lv === "warning" ? "warn" : lv;
}

// Swap the traceId into the expression's first backtick literal:
//   {app="x"} |= `183756226`  →  {app="x"} |= `abc123`
// runLokiQuery validates the literal exists before calling this.
function lokiExprWithTraceId(expr, traceId) {
  const m = expr.match(LOKI_BACKTICK_RE);
  return expr.slice(0, m.index) + "`" + traceId + "`" + expr.slice(m.index + m[0].length);
}

// Stage 1 — the newest line of the unfiltered query, and the traceId it carries.
async function lokiSeekTraceId(origin, dsUid, expr, range) {
  let newest = null;
  await lokiWalkLines(origin, dsUid, expr, range, LOKI_SEEK_LIMIT, (it) => {
    newest = it;
    return true;
  });
  if (!newest) {
    throw new Error(
      "No logs matched the expression in " + lokiRunRange + " — nothing to take a traceId from."
    );
  }
  const traceId = lokiFieldValue(newest.line, "traceId");
  if (!traceId) {
    throw new Error(
      "The newest matching log line carries no traceId — cannot run the trace lookup."
    );
  }
  return traceId;
}

// Stage 2 — newest warn/error lines of the trace, capped at LOKI_MAX_RESULTS and
// returned newest first (the walk visits them in that order).
async function lokiFetchWarnErrors(origin, dsUid, expr, range) {
  const out = [];
  let scanned = 0;
  await lokiWalkLines(origin, dsUid, expr, range, LOKI_FETCH_LIMIT, (it) => {
    scanned++;
    const level = lokiLevelFromLine(it.line);
    if (!level) return false; // not warn/error — keep looking
    out.push({
      tsMs: it.tsMs,
      level,
      fnName: lokiFieldValue(it.line, "function"),
      msg:
        lokiFieldValue(it.line, "errorMessage") ||
        lokiFieldValue(it.line, "message"),
      clean: lokiCleanLine(it.line),
    });
    return out.length >= LOKI_MAX_RESULTS; // the newest five are enough
  });
  lokiScanned = scanned;
  return out;
}

// Runs both stages and returns the warn/error rows for the selected range.
async function runLokiQuery() {
  const expr = lokiExpr.trim();
  // The traceId is spliced into the expression's backtick literal, so an
  // expression without one has nothing to replace — fail before querying.
  if (!LOKI_BACKTICK_RE.test(expr)) {
    throw new Error(
      'The expression needs a backtick value to swap for the traceId, e.g. {app="app-workorder"} |= `183756226`.'
    );
  }

  const s = await getGrafanaSettings();
  const url = new URL(s.domain);
  const granted = await ensureGrafanaHostPermission(url.origin);
  if (!granted) {
    throw new Error("Host access to " + url.origin + " was not granted.");
  }

  const range = lokiRange();
  lokiRunRange = lokiRangeText();

  // Stage 1 — which trace are we looking at?
  lokiTraceId = await lokiSeekTraceId(url.origin, s.dsUid, expr, range);
  lokiResolvedExpr = lokiExprWithTraceId(expr, lokiTraceId);
  toast.info("Logs", "traceId " + lokiTraceId + " — fetching warn/error lines…");

  // Stage 2 — the warn/error lines of that trace, newest first.
  return lokiFetchWarnErrors(url.origin, s.dsUid, lokiResolvedExpr, range);
}

async function startGrafanaQuery() {
  if (lokiRunning) return;
  if (!lokiExpr.trim()) {
    toast.error("Logs", "Enter a LogQL expression first.");
    return;
  }
  lokiRunning = true;
  lokiResults = null;
  lokiError = "";
  lokiTraceId = "";
  lokiResolvedExpr = "";
  lokiScanned = 0;
  updateLokiStatusUI();
  try {
    const records = await runLokiQuery();
    lokiResults = records;
    toast.success(
      "Logs",
      records.length
        ? "traceId " + lokiTraceId + ": " + records.length + " warn/error line(s)."
        : "traceId " +
            lokiTraceId +
            ": no warn/error lines in " +
            lokiRunRange +
            " (scanned " +
            lokiScanned +
            " line(s))."
    );
  } catch (e) {
    lokiError = (e && e.message) || String(e);
    toast.error("Logs", lokiError);
  } finally {
    lokiRunning = false;
    updateLokiStatusUI();
  }
}

// One-time results popover (reused across queries). Built lazily on first open.
function ensureLokiOverlay() {
  if (lokiOverlay) return lokiOverlay;

  const overlay = document.createElement("div");
  overlay.className = "loki-overlay hidden";
  const box = document.createElement("div");
  box.className = "loki-overlay-box";

  const head = document.createElement("div");
  head.className = "loki-overlay-head";
  const hTitle = document.createElement("span");
  hTitle.className = "loki-overlay-title";
  head.appendChild(hTitle);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "loki-overlay-close";
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>';
  close.addEventListener("click", () => overlay.classList.add("hidden"));
  head.appendChild(close);
  box.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "loki-overlay-meta";
  box.appendChild(meta);

  const list = document.createElement("div");
  list.className = "loki-overlay-list";
  box.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "loki-overlay-foot";
  box.appendChild(foot);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
  document.body.appendChild(overlay);
  lokiOverlay = overlay;
  return overlay;
}

function openLokiResults() {
  if (lokiResults === null) return;
  const overlay = ensureLokiOverlay();
  const list = overlay.querySelector(".loki-overlay-list");
  const meta = overlay.querySelector(".loki-overlay-meta");
  const foot = overlay.querySelector(".loki-overlay-foot");
  overlay.querySelector(".loki-overlay-title").textContent =
    lokiError ? "Logs query failed" : "Trace warn / error logs";

  if (lokiError) {
    meta.textContent = "";
    foot.textContent = "";
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "loki-row loki-row-error";
    err.textContent = lokiError;
    list.appendChild(err);
    overlay.classList.remove("hidden");
    return;
  }

  const total = lokiResults.length;
  const metaParts = [
    total + " warn/error line(s)",
    "traceId: " + (lokiTraceId || "—"),
    lokiRunRange,
  ];
  // An empty result set is ambiguous — "nothing matched the trace" reads very
  // differently from "rows came back but none had level warn/error".
  if (!total) metaParts.push("scanned " + lokiScanned + " line(s)");
  meta.textContent = metaParts.join(" · ");
  const footParts = [];
  if (total >= LOKI_MAX_RESULTS) {
    footParts.push("showing the newest " + LOKI_MAX_RESULTS + " warn/error lines");
  }
  if (lokiResolvedExpr) footParts.push("expr: " + lokiResolvedExpr);
  foot.textContent = footParts.join(" · ");

  list.innerHTML = "";
  lokiResults.forEach((r) => {
    const row = document.createElement("div");
    row.className = "loki-row";

    const top = document.createElement("div");
    top.className = "loki-row-top";
    const time = document.createElement("span");
    time.className = "loki-row-time";
    time.textContent = new Date(r.tsMs).toLocaleString();
    const badge = document.createElement("span");
    badge.className = "loki-row-badge level-" + r.level;
    badge.textContent = r.level.toUpperCase();
    top.appendChild(time);
    top.appendChild(badge);
    const fn = document.createElement("span");
    fn.className = "loki-row-fn";
    fn.textContent = r.fnName || "—";
    fn.title = r.fnName || "";
    top.appendChild(fn);
    row.appendChild(top);

    const msg = document.createElement("div");
    msg.className = "loki-row-msg";
    msg.textContent = r.msg || "(no message captured)";
    row.appendChild(msg);

    const raw = document.createElement("details");
    raw.className = "loki-row-raw";
    const sum = document.createElement("summary");
    sum.textContent = "Raw log";
    raw.appendChild(sum);
    const pre = document.createElement("pre");
    pre.textContent = r.clean;
    raw.appendChild(pre);
    row.appendChild(raw);

    list.appendChild(row);
  });

  overlay.classList.remove("hidden");
}

function renderLokiLogsPanel() {
  const card = document.createElement("div");
  card.className = "snow-info snow-info-loki";

  const head = document.createElement("div");
  head.className = "snow-info-head";
  const icon = document.createElement("span");
  icon.className = "snow-info-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 4h16v3H4V4zm0 6.5h10v3H4v-3zm0 6.5h16v3H4v-3z"/></svg>';
  const title = document.createElement("span");
  title.className = "snow-info-title";
  title.textContent = "Logs";
  head.appendChild(icon);
  head.appendChild(title);
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "snow-loki-body";

  const exprRow = document.createElement("div");
  exprRow.className = "snow-loki-expr-row";
  const exprInput = document.createElement("input");
  exprInput.type = "text";
  exprInput.className = "snow-loki-expr";
  exprInput.spellcheck = false;
  exprInput.value = lokiExpr;
  exprInput.title = "LogQL expression";
  exprInput.addEventListener("input", () => {
    lokiExpr = exprInput.value;
    lokiExprTouched = true;
  });
  exprRow.appendChild(exprInput);
  body.appendChild(exprRow);

  // Pre-fill the field with the stored default expression (Options → Grafana)
  // unless the user has already edited it. The module value above stays as the
  // fallback while the async read is in flight.
  chrome.storage.local.get("sreGrafana", (data) => {
    if (lokiExprTouched || !card.isConnected) return;
    const g = (data && data.sreGrafana) || {};
    const def =
      (g.defaultExpr && String(g.defaultExpr).trim()) || LOKI_DEFAULT_EXPR;
    if (exprInput.value !== def) {
      lokiExpr = def;
      exprInput.value = def;
    }
  });

  // --- date range: start → end, both defaulting to today. "Today" as the end
  //     stops at the current time; any earlier day covers its full 24h. ---
  const rangeRow = document.createElement("div");
  rangeRow.className = "snow-loki-range";

  const startInput = document.createElement("input");
  startInput.type = "date";
  startInput.className = "snow-loki-date";
  startInput.value = lokiStartDate;
  startInput.max = lokiTodayStr();
  startInput.title = "From (00:00 of this day)";
  startInput.addEventListener("change", () => {
    lokiStartDate = startInput.value || lokiTodayStr();
    startInput.value = lokiStartDate;
    // Keep the range ordered: an end sitting before the new start snaps forward.
    if (lokiEndDate < lokiStartDate) {
      lokiEndDate = lokiStartDate;
      endInput.value = lokiEndDate;
    }
    endInput.min = lokiStartDate;
  });

  const rangeSep = document.createElement("span");
  rangeSep.className = "snow-loki-range-sep";
  rangeSep.textContent = "→";

  const endInput = document.createElement("input");
  endInput.type = "date";
  endInput.className = "snow-loki-date";
  endInput.value = lokiEndDate;
  endInput.min = lokiStartDate;
  endInput.max = lokiTodayStr();
  endInput.title = "To (inclusive; today stops at now)";
  endInput.addEventListener("change", () => {
    const today = lokiTodayStr();
    lokiEndDate = endInput.value || today;
    if (lokiEndDate > today) lokiEndDate = today;
    if (lokiEndDate < lokiStartDate) lokiEndDate = lokiStartDate;
    endInput.value = lokiEndDate;
  });

  rangeRow.appendChild(startInput);
  rangeRow.appendChild(rangeSep);
  rangeRow.appendChild(endInput);
  body.appendChild(rangeRow);

  const ctl = document.createElement("div");
  ctl.className = "snow-loki-ctl";

  const spacer = document.createElement("div");
  spacer.className = "snow-loki-spacer";
  ctl.appendChild(spacer);

  const statusBtn = document.createElement("button");
  statusBtn.type = "button";
  statusBtn.className = "snow-loki-status";
  statusBtn.hidden = true;
  statusBtn.addEventListener("click", openLokiResults);
  ctl.appendChild(statusBtn);

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "snow-loki-run";
  runBtn.textContent = "Query";
  runBtn.addEventListener("click", startGrafanaQuery);
  ctl.appendChild(runBtn);

  body.appendChild(ctl);

  const errLine = document.createElement("div");
  errLine.className = "snow-loki-error";
  errLine.hidden = true;
  body.appendChild(errLine);

  card.appendChild(body);
  return card;
}

// Syncs the card's controls with lokiRunning / lokiResults / lokiError state.
function updateLokiStatusUI() {
  const panel = document.querySelector(".snow-info-loki");
  if (!panel) return;
  const run = panel.querySelector(".snow-loki-run");
  const statusBtn = panel.querySelector(".snow-loki-status");
  const errLine = panel.querySelector(".snow-loki-error");

  if (run) {
    run.disabled = lokiRunning;
    run.textContent = lokiRunning ? "Querying…" : "Query";
    run.classList.toggle("busy", lokiRunning);
  }
  if (errLine) {
    errLine.hidden = !lokiError;
    errLine.textContent = lokiError || "";
  }
  if (statusBtn) {
    // Visible while a query runs (spinner) or once results exist (icon+count);
    // hidden only when idle with no results yet.
    statusBtn.hidden = !lokiRunning && lokiResults === null;
    statusBtn.classList.toggle("busy", lokiRunning);
    statusBtn.classList.toggle("has-results", !lokiRunning && lokiResults !== null);
    if (lokiRunning) {
      statusBtn.title = "Query running…";
      statusBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 6v3l4-4-4-4v3a8 8 0 0 0-8 8c0 1.5.4 2.9 1.1 4.1l1.5-1.5A5.9 5.9 0 0 1 6 12a6 6 0 0 1 6-6z"/></svg>';
    } else if (lokiResults !== null) {
      statusBtn.title = "Show " + lokiResults.length + " result(s)";
      statusBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M4 4h16v3H4V4zm0 6.5h10v3H4v-3zm0 6.5h16v3H4v-3z"/></svg>' +
        '<span class="snow-loki-count">' +
        lokiResults.length +
        "</span>";
    }
  }
}
