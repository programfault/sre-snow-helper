// SRE Helper — YAML parsing + validation contract.
//
// Shared by the options page and the future side-panel execution UI.
// Storage layout (chrome.storage.local):
//   sreConfig:     { displayName, refreshInterval, enableNotifications, theme, apiEndpoint }
//   sreComponents: Array<{ id, yaml, collapsed }>  — reusable step components (was sreCommons)
//   srePlaybooks:  Array<{ id, yaml, collapsed }>  — orchestration flows
//   sreForms:      Array<{ name, label, value, display, type }>
//
// YAML shapes:
//   component:  name, desc, form          (form is a map of field names -> values)
//   playbook:   name, desc, steps[]
//     step:     { ref: "<component name>" }  OR  { name, desc, form? }
//
// Form schema (from sreForms rows):
//   name    : unique identifier for the field; must match keys in a YAML `form:` block
//   label   : human-friendly label
//   value   : reference/target value — required if type != "string"
//   display : rendering hint (opaque)
//   type    : one of  "string" | "number" | "reference"
//
// Validation rules:
//   * A YAML `form:` block's keys MUST exist in sreForms (matched by `name`).
//   * For any sreForms row where type !== "string", the matching YAML value
//     MUST equal the row's `value` field; otherwise validation fails.
//   * For type === "string", any value is accepted.
//
// Autocomplete helpers accept the text around the caret and return candidate
// suggestions (display name + insertion snippet) based on known component refs
// and form field entries.

(function (global) {
  "use strict";

  const ALLOWED_FORM_TYPES = ["string", "number", "reference"];

  function stripQuotes(v) {
    const t = String(v).trim();
    if (
      t.length >= 2 &&
      ((t[0] === '"' && t[t.length - 1] === '"') ||
        (t[0] === "'" && t[t.length - 1] === "'"))
    ) {
      return t.slice(1, -1);
    }
    return t;
  }

  /* ---------- Top-level scalar parsing ---------- */
  function parseHeader(yaml) {
    const result = { name: "", desc: "" };
    if (!yaml) return result;
    // Allow optional leading whitespace so this works on both top-level
    // YAML and dedented step fragments.
    const nameMatch = yaml.match(/^[ \t]*name:[ \t]*(.+?)[ \t]*$/m);
    const descMatch = yaml.match(/^[ \t]*desc:[ \t]*(.+?)[ \t]*$/m);
    if (nameMatch) result.name = stripQuotes(nameMatch[1]);
    if (descMatch) result.desc = stripQuotes(descMatch[1]);
    return result;
  }

  function parseRefs(yaml) {
    const refs = [];
    if (!yaml) return refs;
    const re = /^[ \t]*-[ \t]*ref:[ \t]*(.+?)[ \t]*$/gm;
    let m;
    while ((m = re.exec(yaml)) !== null) refs.push(stripQuotes(m[1]));
    return refs;
  }

  /* ---------- YAML block parsing ---------- */

  // Parse `form:` block of a single step into { field: value }.
  // The form block lives under the component/playbook-step level.
  // `indentLevel` is a hint for the expected indentation of the `form:` header;
  // 0 = top-level, 2 = inside a step. Leading whitespace is tolerated.
  // Returns {} when no form block.
  function parseFormBlock(yaml, indentLevel) {
    const form = {};
    if (!yaml) return form;
    const ind = indentLevel || 0;
    // Match "form:" with optional leading whitespace.
    const formHeader = new RegExp(`^[ \\t]{${ind},}form:[ \\t]*$`, "m");
    const startMatch = yaml.match(formHeader);
    if (!startMatch) return form;
    // Determine the actual indentation of the matched `form:` line.
    const matchedLine = startMatch[0];
    const actualIndent = (matchedLine.match(/^[ \t]*/) || [""])[0].length;
    let i = startMatch.index + startMatch[0].length;
    if (yaml[i] === "\n") i++;
    else if (yaml[i] === "\r" && yaml[i + 1] === "\n") i += 2;
    // Children must be indented strictly deeper than the form header line.
    const childIndent = actualIndent + 2;
    const childRe = new RegExp(
      `^([ \\t]{${childIndent},})([A-Za-z_][\\w-]*):[ \\t]*(.*?)[ \\t]*$`,
      "gm"
    );
    const sub = yaml.slice(i);
    let m;
    while ((m = childRe.exec(sub)) !== null) {
      form[stripQuotes(m[2])] = stripQuotes(m[3]);
    }
    return form;
  }

  // Parse every step in a playbook's `steps:` block.
  // Each step is normalized to { ref? | name, desc, form }.
  function parseSteps(playbookYaml) {
    const steps = [];
    if (!playbookYaml) return steps;
    const startMatch = playbookYaml.match(/^steps:[ \t]*$/m);
    if (!startMatch) return steps;
    let i = startMatch.index + startMatch[0].length;
    if (playbookYaml[i] === "\n") i++;
    else if (playbookYaml[i] === "\r" && playbookYaml[i + 1] === "\n") i += 2;
    const tail = playbookYaml.slice(i);
    // Each list item starts with "  - " (2 spaces, dash, space). A new step begins
    // whenever we see a line matching "  - <key>:". We split the tail into step
    // fragments, then parse each.
    const lines = tail.split(/\r?\n/);
    let buf = [];
    // Detect step-start lines: any indented "- <key>:" (1+ spaces indent).
    // Tolerates 1-4 space indentation.
    const stepStartRe = /^(\s+)-\s+(?:ref|name|desc|form|steps):/;
    const pushStep = () => {
      if (buf.length === 0) return;
      const blob = buf.join("\n");
      // Detect ref step: first key line should be "- ref: <name>"
      const refMatch = blob.match(/^[ \t]*-[ \t]*ref:[ \t]*(.+?)[ \t]*$/m);
      if (refMatch) {
        // Ref step may carry its own form block — parse it so callers can
        // decide whether to use the ref step's form or the component's.
        const form = parseFormBlock(blob, 0);
        steps.push({ ref: stripQuotes(refMatch[1]), form });
      } else {
        // Inline step: extract name, desc, form from the fragment.
        // Strip the "- " prefix from the first line, then compute the minimum
        // indent across remaining lines and remove it so the top-level fields
        // (name/desc/form) align at col 0 while form children keep their
        // relative indentation.
        const stepLines = buf.map((ln) =>
          /^(\s*)-\s/.test(ln) ? ln.replace(/^(\s*)-\s/, "$1") : ln
        );
        // Find min indent (ignore blank lines).
        let minIndent = Infinity;
        for (const ln of stepLines) {
          if (ln.trim() === "") continue;
          const m = ln.match(/^(\s*)/);
          const ind = m ? m[1].length : 0;
          if (ind < minIndent) minIndent = ind;
        }
        if (!isFinite(minIndent)) minIndent = 0;
        const denuded = stepLines
          .map((ln) => (ln.trim() === "" ? ln : ln.slice(minIndent)))
          .join("\n");
        const h = parseHeader(denuded);
        const form = parseFormBlock(denuded, 0);
        steps.push({ name: h.name, desc: h.desc, form });
      }
    };
    for (const line of lines) {
      if (stepStartRe.test(line)) {
        pushStep();
        buf = [line];
      } else if (buf.length > 0) {
        // Continuation of current step (must be indented).
        buf.push(line);
      }
    }
    pushStep();
    return steps;
  }

  /* ---------- Params + placeholder resolution ---------- */

  // Parse a playbook's `params:` block.
  // Each entry: { name }. Params are referenced by index: ${param0}, ${param1}, ...
  //   params:
  //     - name: User Name
  //     - name: Alert ID
  // Returns [] when no params block.
  function parseParams(playbookYaml) {
    const params = [];
    if (!playbookYaml) return params;
    const startMatch = playbookYaml.match(/^params:[ \t]*$/m);
    if (!startMatch) return params;
    let i = startMatch.index + startMatch[0].length;
    if (playbookYaml[i] === "\n") i++;
    else if (playbookYaml[i] === "\r" && playbookYaml[i + 1] === "\n") i += 2;
    const tail = playbookYaml.slice(i);
    const lines = tail.split(/\r?\n/);
    let cur = null;
    for (const line of lines) {
      // A new params entry starts at "  - name:" (with 2-space indent).
      const itemMatch = line.match(/^(\s*)-\s+name:/);
      if (itemMatch) {
        if (cur) params.push(cur);
        cur = {};
      }
      if (!cur) {
        // Stop if we've left the params block (non-indented, non-blank line).
        if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) {
          break;
        }
        continue;
      }
      // Also stop if we hit a non-indented line (end of params block).
      if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) {
        params.push(cur);
        cur = null;
        break;
      }
      // name: value — on the "- name:" line.
      const nm = line.match(/^\s*-?\s*name:[ \t]*(.+?)[ \t]*$/);
      if (nm) cur.name = stripQuotes(nm[1]);
    }
    if (cur) params.push(cur);
    return params.filter((p) => p.name);
  }

  // Extract all ${placeholder} names from an arbitrary string.
  // Returns an array of unique names (without ${}).
  function extractPlaceholderNames(str) {
    if (!str) return [];
    const names = [];
    const re = /\$\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const n = m[1].trim();
      if (n && names.indexOf(n) === -1) names.push(n);
    }
    return names;
  }

  // Replace all ${paramN} occurrences in `str` with values from `values` map.
  // `values` is keyed by the placeholder token (e.g. "param0", "param1").
  // Unknown placeholders are left untouched.
  function resolvePlaceholders(str, values) {
    if (!str) return str;
    return str.replace(/\$\{([^}]+)\}/g, (full, name) => {
      const key = name.trim();
      if (Object.prototype.hasOwnProperty.call(values || {}, key)) {
        return String(values[key]);
      }
      return full; // leave unresolved
    });
  }

  // Resolve placeholders across an entire playbook YAML string and re-parse
  // its steps so each step's final form (HTTP body) is materialised.
  // Returns: { yaml, steps } where steps is the output of parseSteps on the
  // resolved YAML.
  function resolvePlaybook(playbookYaml, values) {
    const resolved = resolvePlaceholders(playbookYaml || "", values || {});
    return { yaml: resolved, steps: parseSteps(resolved) };
  }

  /* ---------- Validation ---------- */

  // Collect component name -> component index map.
  function indexComponents(components) {
    const byName = new Map();
    (components || []).forEach((c, idx) => {
      const { name } = parseHeader(c.yaml || "");
      if (name) byName.set(name, c);
    });
    return byName;
  }

  // Build form definition map: formDef.name -> row.
  function indexForms(forms) {
    const byName = new Map();
    (forms || []).forEach((row) => {
      if (row && row.name) byName.set(row.name, row);
    });
    return byName;
  }

  // Validate a single form map ({field: value}) against the form definitions.
  // Returns { ok, errors: string[] }
  function validateForm(formMap, formsByName) {
    const errors = [];
    for (const [key, val] of Object.entries(formMap)) {
      const def = formsByName.get(key);
      if (!def) {
        errors.push(`form key "${key}" is not defined in the Form library`);
        continue;
      }
      if (def.type !== "string") {
        // Non-string types require the YAML value to equal the definition value.
        if (String(val) !== String(def.value ?? "")) {
          errors.push(
            `form key "${key}" (type ${def.type}) requires value "${def.value ?? ""}", got "${val}"`
          );
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // Validate a component's YAML.
  function validateComponent(yaml, formsByName) {
    const errors = [];
    const { name } = parseHeader(yaml);
    if (!name) errors.push("missing top-level `name:`");
    const form = parseFormBlock(yaml, 0);
    const fv = validateForm(form, formsByName);
    if (!fv.ok) errors.push(...fv.errors);
    return { ok: errors.length === 0, errors };
  }

  // Validate a playbook's YAML against components and form definitions.
  // Returns { ok, errors, warnings }
  function validatePlaybook(yaml, componentsByName, formsByName) {
    const errors = [];
    const warnings = [];
    const { name } = parseHeader(yaml);
    if (!name) errors.push("missing top-level `name:`");
    const steps = parseSteps(yaml);
    if (steps.length === 0) warnings.push("no `steps:` block or steps list is empty");
    steps.forEach((step, idx) => {
      const prefix = `step ${idx + 1}`;
      if (step.ref) {
        if (!componentsByName.has(step.ref)) {
          errors.push(`${prefix}: ref "${step.ref}" not found in Components`);
          return;
        }
        const comp = componentsByName.get(step.ref);
        const compForm = parseFormBlock(comp.yaml || "", 0);
        const fv = validateForm(compForm, formsByName);
        if (!fv.ok) {
          errors.push(
            ...fv.errors.map((e) => `${prefix} (ref "${step.ref}"): ${e}`)
          );
        }
      } else {
        if (!step.name) {
          errors.push(`${prefix}: missing \`name:\``);
        }
        const fv = validateForm(step.form || {}, formsByName);
        if (!fv.ok) {
          errors.push(...fv.errors.map((e) => `${prefix}: ${e}`));
        }
      }
    });
    return { ok: errors.length === 0, errors, warnings };
  }

  /* ---------- Autocomplete helpers ---------- */

  // Build the list of autocomplete items from the current libraries.
  // Each item is { label, snippet, group, hint }.
  function buildCompletions(ctx) {
    const items = [];
    // 1. Component refs => "- ref: <name>" snippets (used inside playbook steps)
    (ctx.components || []).forEach((c) => {
      const { name, desc } = parseHeader(c.yaml || "");
      if (!name) return;
      items.push({
        label: `ref: ${name}`,
        snippet: `- ref: ${name}`,
        group: "component-ref",
        hint: desc || "",
      });
    });
    // 2. Form fields => "key: value" snippets for fast form filling
    (ctx.forms || []).forEach((row) => {
      if (!row.name) return;
      const display =
        row.value !== undefined && row.value !== ""
          ? `${row.name}: ${row.value}`
          : `${row.name}:`;
      items.push({
        label: display,
        snippet: row.value ? `${row.name}: ${row.value}` : `${row.name}: `,
        group: "form",
        hint: row.label || row.type || "",
        row,
      });
    });
    return items;
  }

  // Analyze textarea { value, selectionStart } to decide autocomplete context.
  // Trigger: typing a slash `/` (IDE slash-command style).
  //   - `/` must be at the beginning of a "token" — either line-start, preceded
  //     by whitespace, OR preceded by a YAML key terminator `:` followed by space.
  //   - We do NOT trigger inside a literal token (alphanumerics immediately before
  //     the `/`) to avoid popping the menu inside URLs / paths / `a/b` words.
  //
  // Returns:
  //   { triggerStart: number   // absolute index of the `/` we're replacing
  //   , prefix      : string   // chars after the triggering `/`, used for filtering
  //   , kind        : "slash"  // uniform kind for now
  //   }
  // or null if nothing actionable.
  function analyzeContext(value, cursor) {
    const v = value == null ? "" : String(value);
    if (cursor < 1 || cursor > v.length) return null;
    // Find the latest `/` in substring [0, cursor).
    const upToCursor = v.slice(0, cursor);
    const slashIdx = upToCursor.lastIndexOf("/");
    if (slashIdx < 0) return null;
    // Boundary rule: the char before `/` must be whitespace, start-of-string, or
    // the `: ` sequence at the end of a YAML key line. We never trigger when the
    // preceding character is a letter/digit/underscore (avoids URLs / filenames).
    if (slashIdx > 0) {
      const prev = v.charCodeAt(slashIdx - 1);
      const prevPrev = slashIdx >= 2 ? v[slashIdx - 2] : "";
      const isWhitespaceBefore =
        prev === 0x20 || prev === 0x09 || prev === 0x0a || prev === 0x0d;
      const isColonSpaceBefore = slashIdx >= 2 && prevPrev === ":" && prev === 0x20;
      const isWordBefore =
        (prev >= 48 && prev <= 57) || // 0-9
        (prev >= 65 && prev <= 90) || // A-Z
        (prev >= 97 && prev <= 122) || // a-z
        prev === 95; // _
      if (!isWhitespaceBefore && !isColonSpaceBefore && isWordBefore) return null;
    }
    // `prefix` is the run of chars between `/` and `cursor` — must not contain
    // whitespace (indicates user has moved past the query).
    const tail = v.slice(slashIdx + 1, cursor);
    if (/\s/.test(tail)) return null;
    return { triggerStart: slashIdx, prefix: tail, kind: "slash" };
  }

  // Filter completions by prefix (case-insensitive substring match on label).
  // With the slash trigger we accept all completion groups.
  function filterCompletions(items, prefix /*, kind */) {
    const p = (prefix || "").toLowerCase();
    return items
      .filter((it) => !p || it.label.toLowerCase().indexOf(p) !== -1)
      .slice(0, 25);
  }

  global.SRE_YAML = {
    ALLOWED_FORM_TYPES,
    stripQuotes,
    parseHeader,
    parseRefs,
    parseFormBlock,
    parseSteps,
    parseParams,
    extractPlaceholderNames,
    resolvePlaceholders,
    resolvePlaybook,
    indexComponents,
    indexForms,
    validateForm,
    validateComponent,
    validatePlaybook,
    buildCompletions,
    analyzeContext,
    filterCompletions,
  };
})(typeof self !== "undefined" ? self : this);
