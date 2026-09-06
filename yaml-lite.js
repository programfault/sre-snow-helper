// SRE Helper — YAML parsing + validation contract.
//
// Shared by the options page and the side-panel execution UI.
// Storage layout (chrome.storage.local):
//   sreCommonSteps: { id, yaml }                 — single shared "Common Steps" document
//   srePlaybooks:   Array<{ id, yaml, collapsed }>  — orchestration flows
//   sreForms:       Array<{ name, label, value, display, type }>
//   sreServices:    { id, yaml }                 — single shared "Services" document
//
// Services YAML shape (single doc):
//   services:            top-level list. Each entry is either an API call or a
//                        group (type: group, with its own nested `services:`).
//     - name: ...
//       method: POST          (GET when omitted)
//       endpoint: https://... (may embed ${var})
//       desc: ...
//       header: { k: v }      (values may embed ${var})
//       body: map or list     (keys/values may embed ${var})
//       output:
//         - alias: myName     (alias + json_path expose values to LATER APIs in
//           json_path: $.a.b  the same group; single APIs' outputs are unused)
// Variable rule: everything is written ${name}. A ${name} that equals an
// `output.alias` of an EARLIER service in the same group resolves from the
// chain automatically (no UI input); every other ${name} is prompted as a
// user input at run time.
//
// YAML shapes:
//   common doc:  params[]  + common_steps:  (map of step key -> { action?, form? })
//   playbook:    name, desc, params[]?, flow:
//     flow item: { name?, ref? }  (ref: key into common_steps)
//                { name?, desc?, form?, action? }  (inline step)
//
// Form schema (from sreForms rows):
//   name    : field identifier; must match keys in a YAML `form:` block.
//             NOT required to be unique — repeating a name groups rows into
//             candidate values for the same field (an enum/select).
//   label   : human-friendly label (what `/` hints show for the field name)
//   display : human-readable text shown by `/` value hints (falls back to value)
//   value   : candidate value for this row — the actual text inserted by the
//             hint. A field whose rows are all type "string" is free-form
//             (typed directly, no value hints); if any row is "number"/"sysid",
//             the YAML value must equal one of those rows' values.
//   type    : one of  "string" | "number" | "sysid"
//
// Param scope rule (2.3):
//   * Placeholders inside a common step's form resolve against the common doc's
//     own top-level `params:`.
//   * Placeholders inside an inline flow step's form resolve against the
//     playbook's own `params:`.
//
// `action` semantics (2.4):
//   * May be declared on a flow item or inside a common step body.
//   * Effective value = flow item's action when present, else the referenced
//     common step's action, else false.
//   * On execution: action=true steps send individually in flow order; the rest
//     are merged into one final send.
//
// Autocomplete (2.5):
//   * After `ref: ` only the common step keys are suggested.
//   * `/` slash completions are two-level:
//     - line has no `key: ` yet  => every distinct form `name` (deduped); each
//       candidate is shown by its human `label` and inserts `name: `;
//     - caret sits right after a `key: ` matching a form name => that name's
//       candidate `value`s (rows sharing the name); each candidate is shown by
//       its human-readable `display` (falling back to the value) and inserts
//       the `value`. Only offered when the field is NOT free-form: a field
//       whose rows are all type "string" accepts any text, so its value stage
//       suggests nothing.

(function (global) {
  "use strict";

  const ALLOWED_FORM_TYPES = ["string", "number", "sysid"];

  const TRUE_TOKENS = new Set(["true", "yes", "on", "1"]);
  const FALSE_TOKENS = new Set(["false", "no", "off", "0", "", "null", "~"]);

  function stripQuotes(v) {
    const t = String(v).trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
      // Double-quoted: resolve escape sequences (\n, \t, \\, \", ...)
      return unescapeDoubleQuoted(t.slice(1, -1));
    }
    if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
      // Single-quoted: the only escape is '' -> '
      return t.slice(1, -1).replace(/''/g, "'");
    }
    return t;
  }

  // Resolve YAML double-quoted escape sequences into the characters they
  // represent. Without this, "line1\nline2" stays as the two literal
  // characters backslash-n instead of a newline — so a body value sent to a
  // server would contain the text "\n" rather than an actual line break.
  // Covers the common escapes; anything unrecognized keeps the char after the
  // backslash (lenient, like most YAML loaders).
  function unescapeDoubleQuoted(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc) => {
      switch (esc[0]) {
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        case "b": return "\b";
        case "f": return "\f";
        case "v": return "\v";
        case "0": return "\0";
        case "\\": return "\\";
        case '"': return '"';
        case "/": return "/";
        case "u": return String.fromCharCode(parseInt(esc.slice(1), 16));
        case "x": return String.fromCharCode(parseInt(esc.slice(1), 16));
        default: return esc;
      }
    });
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

  /* ---------- Action token parsing ---------- */

  // YAML-ish boolean coercion for `action:`. Returns undefined when the key is
  // absent or holds an unrecognized token (so callers can fall back).
  function parseActionToken(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (TRUE_TOKENS.has(s)) return true;
    if (FALSE_TOKENS.has(s)) return false;
    return undefined;
  }

  // Merge a flow-item action with a referenced common step's action.
  function effectiveAction(flowItemAction, commonStepAction) {
    if (flowItemAction !== undefined) return flowItemAction;
    if (commonStepAction !== undefined) return commonStepAction;
    return false;
  }

  /* ---------- YAML block parsing ---------- */

  // Parse `form:` block of a single step into { field: value }.
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
    const lines = yaml.slice(i).split(/\r?\n/);
    const childRe = new RegExp(
      `^([ \\t]{${childIndent},})([A-Za-z_][\\w-]*):[ \\t]*(.*?)[ \\t]*$`
    );

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const m = line.match(childRe);
      if (!m) {
        // Blank line: skip (content may continue after it).
        if (/^\s*$/.test(line)) continue;
        // A line indented shallower than the fields' minimum ends the block.
        const lineIndent = (line.match(/^[ \t]*/) || [""])[0].length;
        if (lineIndent < childIndent) break;
        continue; // deeper but not a key:value line — ignore
      }
      const key = stripQuotes(m[2]);
      const rawVal = m[3];
      // Block scalar indicator, e.g. `work_notes: |` or `body: >-`.
      const bm = rawVal.match(/^([|>])([+-]?)([0-9]*)$/);
      if (bm) {
        const style = bm[1]; // "|" literal | ">" folded
        const chomp = bm[2]; // "+" / "-" / "" (clip)
        const explicitIndent = bm[3] ? parseInt(bm[3], 10) : 0;
        const keyIndent = m[1].length;
        // Collect every line indented deeper than this key line.
        let contentIndent = explicitIndent > 0 ? keyIndent + explicitIndent : null;
        const blockLines = [];
        li++;
        while (li < lines.length) {
          const bl = lines[li];
          if (/^\s*$/.test(bl)) {
            blockLines.push("");
            li++;
            continue;
          }
          const blIndent = (bl.match(/^[ \t]*/) || [""])[0].length;
          if (blIndent <= keyIndent) {
            li--; // belongs to a sibling key or the parent — rewind
            break;
          }
          if (contentIndent === null) contentIndent = blIndent;
          blockLines.push(bl.slice(contentIndent));
          li++;
        }
        let value = blockLines.join("\n");
        // Chomping: clip keeps one trailing \n, strip removes all, keep leaves all.
        if (chomp === "-") value = value.replace(/\n+$/, "");
        else if (chomp === "") value = value.replace(/\n+$/, "\n");
        if (style === ">") {
          value = value
            .replace(/\n{2,}/g, "\u0000")
            .replace(/\n/g, " ")
            .replace(/\u0000/g, "\n");
          if (chomp === "") value = value.replace(/[ \t]+$/, "");
        }
        form[key] = value;
      } else {
        form[key] = stripQuotes(rawVal);
      }
    }
    return form;
  }

  // Parse a `params:` block from the top of a document (common doc or playbook).
  // Each entry: { name, type? } — `type` only steers front-end rendering:
  //   type: textarea => a multi-line <textarea>; type: option => a radio group
  //   whose choices come from the Form library (see paramOptionRows below);
  //   anything else (or omitted) => a single-line <input type="text">.
  // Params are referenced by index: ${param0}, ${param1}, ...
  // Returns [] when no params block.
  function parseParams(yaml) {
    const params = [];
    if (!yaml) return params;
    const startMatch = yaml.match(/^params:[ \t]*$/m);
    if (!startMatch) return params;
    let i = startMatch.index + startMatch[0].length;
    if (yaml[i] === "\n") i++;
    else if (yaml[i] === "\r" && yaml[i + 1] === "\n") i += 2;
    const tail = yaml.slice(i);
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
      // Sub-keys of the current entry: `name:` (also on the "- name:" line)
      // and the optional `type:` widget hint.
      const nm = line.match(/^\s*-?\s*name:[ \t]*(.+?)[ \t]*$/);
      if (nm) cur.name = stripQuotes(nm[1]);
      const ty = line.match(/^\s*type:[ \t]*(.+?)[ \t]*$/);
      if (ty) cur.type = stripQuotes(ty[1]).toLowerCase();
    }
    if (cur) params.push(cur);
    return params.filter((p) => p.name);
  }

  // Resolve the choices behind an `option`-typed param from the Form library.
  // The param's `name` is looked up as the human `label` of a field first (e.g.
  // a param named "Configuration item" finds the u_substate field whose rows
  // carry that label); if nothing matches, it falls back to the field `name`
  // itself. Every candidate choice renders with its `display` text (falling
  // back to the raw value) and, once selected, fills the row's `value`. The
  // first choice is the default selection. Returns [] when no usable row is
  // found — callers should fall back to free text.
  function paramOptionRows(param, forms) {
    const src = Array.isArray(forms) ? forms : [];
    const want = param && param.name ? String(param.name).trim() : "";
    if (!want) return [];
    const byLabel = src.filter(
      (r) => r && r.label && String(r.label).trim() === want
    );
    // Prefer the field reached via its label; otherwise allow matching the raw
    // field key directly. Either way all rows of the resolved field participate
    // (they share the field's candidate set regardless of per-row labels).
    const fieldName = byLabel.length
      ? byLabel[0].name
      : (src.find((r) => r && r.name && String(r.name).trim() === want) || {}).name;
    if (!fieldName) return [];
    const seen = new Set();
    const out = [];
    src.forEach((r) => {
      if (!r || !r.name || r.name !== fieldName) return;
      const val = r.value === undefined || r.value === null ? "" : String(r.value);
      if (String(val).trim() === "") return; // nothing to fill
      if (seen.has(val)) return;
      seen.add(val);
      out.push({
        display: r.display ? String(r.display) : val,
        value: val,
        type: r.type || "string",
      });
    });
    return out;
  }

  // Warnings for `type: option` params that resolve to no Form-library choice.
  // Each param's `name` must match a field (by its label, else its key) that
  // defines at least one value row. Returns { ok, errors, warnings }.
  function validateOptionParams(yaml, forms) {
    const warnings = [];
    const params = parseParams(yaml || "");
    params.forEach((p, idx) => {
      if (!p.type || p.type.toLowerCase() !== "option") return;
      const name = String(p.name || "").trim();
      if (paramOptionRows(p, forms).length === 0) {
        warnings.push(
          `param ${idx + 1} "${name}": type: option matches no choice in the Form library (a field whose label or name equals "${name}" with at least one defined value)`
        );
      }
    });
    return { ok: warnings.length === 0, errors: [], warnings };
  }

  /* ---------- Common steps (single doc) ---------- */

  // Parse the shared Common Steps document:
  //   params:
  //     - name: User Name
  //   common_steps:
  //     ack:
  //       action: true
  //       form:
  //         note: ack ${param0}
  // Returns { params: [...], steps: { key: { action?, form } } }.
  function parseCommonSteps(commonYaml) {
    const params = parseParams(commonYaml);
    const steps = {};
    if (!commonYaml) return { params, steps };
    const startMatch = commonYaml.match(/^common_steps:[ \t]*(?:#.*)?$/m);
    if (!startMatch) return { params, steps };
    const headerIndent = (startMatch[0].match(/^[ \t]*/) || [""])[0].length;
    let i = startMatch.index + startMatch[0].length;
    if (commonYaml[i] === "\n") i++;
    else if (commonYaml[i] === "\r" && commonYaml[i + 1] === "\n") i += 2;
    const lines = commonYaml.slice(i).split(/\r?\n/);
    // A map entry is a line indented deeper than the header ending in ":",
    // e.g. "  ack:". Its body is everything up to the next entry at the same
    // indent (or a col-0 key, which ends the block).
    let curKey = null;
    let buf = [];
    const flush = () => {
      if (curKey === null) return;
      const slice = buf.join("\n");
      const entry = {};
      const act = slice.match(/^[ \t]*action:[ \t]*(.+?)[ \t]*$/m);
      if (act) {
        const a = parseActionToken(act[1]);
        if (a !== undefined) entry.action = a;
      }
      entry.form = parseFormBlock(slice, headerIndent);
      steps[curKey] = entry;
      buf = [];
      curKey = null;
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        if (curKey !== null) buf.push(line);
        continue;
      }
      if (!line.startsWith(" ")) {
        // A col-0 key means the common_steps block is over.
        flush();
        break;
      }
      // Entry boundary: indented, non-"list-dash", ends with a bare ":".
      const entryMatch = line.match(/^([ \t]+)([\w-]+):[ \t]*(?:#.*)?$/);
      if (entryMatch) {
        const indent = entryMatch[1].length;
        if (indent > headerIndent) {
          if (curKey === null) {
            curKey = entryMatch[2];
            buf = [line];
            continue;
          }
          // Same indent as the current entry => new sibling entry.
          const curIndentMatch = buf[0].match(/^([ \t]+)/);
          const curIndent = curIndentMatch ? curIndentMatch[1].length : 0;
          if (indent === curIndent) {
            flush();
            curKey = entryMatch[2];
            buf = [line];
            continue;
          }
        }
      }
      if (curKey !== null) buf.push(line);
    }
    flush();
    return { params, steps };
  }

  // Convenience: index the common doc into a Map key -> { action?, form }.
  function indexCommonSteps(commonYaml) {
    const { steps } = parseCommonSteps(commonYaml || "");
    return new Map(Object.entries(steps));
  }

  /* ---------- Playbook flow ---------- */

  // Parse a playbook's `flow:` list. Each item keeps its own declared fields
  // (name / desc / ref / form / action); effective resolution happens later.
  function parseFlow(playbookYaml) {
    const flow = [];
    if (!playbookYaml) return flow;
    const startMatch = playbookYaml.match(/^flow:[ \t]*(?:#.*)?$/m);
    if (!startMatch) return flow;
    let i = startMatch.index + startMatch[0].length;
    if (playbookYaml[i] === "\n") i++;
    else if (playbookYaml[i] === "\r" && playbookYaml[i + 1] === "\n") i += 2;
    const lines = playbookYaml.slice(i).split(/\r?\n/);
    let buf = [];
    let itemIndent = null; // indentation of the flow list's dash items
    const flush = () => {
      if (buf.length === 0) return;
      flow.push(parseFlowItem(buf));
      buf = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        if (buf.length) buf.push(line);
        continue;
      }
      // A col-0 key means the flow list is over.
      if (!line.startsWith(" ")) {
        flush();
        break;
      }
      // A new item starts with a dash at the flow list's item indent. Lines at
      // a deeper indent (form children etc.) belong to the current item.
      const dashMatch = line.match(/^([ \t]+)-\s+/);
      if (dashMatch) {
        const indent = dashMatch[1].length;
        if (itemIndent === null) itemIndent = indent;
        if (indent === itemIndent) {
          flush();
          buf = [line];
          continue;
        }
      }
      if (buf.length) buf.push(line);
    }
    flush();
    return flow;
  }

  // Normalize a raw `- ` item fragment into { name?, desc?, ref?, action?, form? }.
  function parseFlowItem(buf) {
    const stepLines = buf.map((ln) =>
      /^(\s*)-\s/.test(ln) ? ln.replace(/^(\s*)-\s/, "$1") : ln
    );
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
    const item = {};
    const h = parseHeader(denuded);
    if (h.name) item.name = h.name;
    if (h.desc) item.desc = h.desc;
    // Field lines keep some residual indentation after de-denting — match them
    // at any indent level.
    const refMatch = denuded.match(/^[ \t]*ref:[ \t]*(.+?)[ \t]*$/m);
    if (refMatch) item.ref = stripQuotes(refMatch[1]);
    const actMatch = denuded.match(/^[ \t]*action:[ \t]*(.+?)[ \t]*$/m);
    if (actMatch) {
      const a = parseActionToken(actMatch[1]);
      if (a !== undefined) item.action = a;
    }
    const form = parseFormBlock(denuded, 0);
    if (Object.keys(form).length > 0) item.form = form;
    return item;
  }

  /* ---------- Placeholders ---------- */

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

  /* ---------- Validation ---------- */

  // Build a form-definition index: form name -> array of rows.
  // A name may appear on many rows — together they describe the candidate
  // values available for one YAML field.
  function indexForms(forms) {
    const byName = new Map();
    (forms || []).forEach((row) => {
      if (row && row.name) {
        if (!byName.has(row.name)) byName.set(row.name, []);
        byName.get(row.name).push(row);
      }
    });
    return byName;
  }

  // Validate a single form map ({field: value}) against the form definitions.
  // A field whose rows are all type "string" accepts any YAML value; as soon
  // as any row is typed "number"/"sysid", the YAML value must equal one of
  // those rows' values.
  // Returns { ok, errors: string[] }
  function validateForm(formMap, formsByName) {
    const errors = [];
    for (const [key, val] of Object.entries(formMap)) {
      const defs = formsByName.get(key);
      if (!defs || defs.length === 0) {
        errors.push(`form key "${key}" is not defined in the Form library`);
        continue;
      }
      const fixedValues = defs
        .filter((d) => d.type && d.type !== "string")
        .map((d) => String(d.value ?? ""));
      if (fixedValues.length > 0 && fixedValues.indexOf(String(val)) === -1) {
        errors.push(
          `form key "${key}" must be one of ${fixedValues
            .map((x) => `"${x}"`)
            .join(", ")}, got "${val}"`
        );
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // Validate the shared Common Steps document.
  // Returns { ok, errors, warnings }
  function validateCommonStepsDoc(commonYaml, formsByName) {
    const errors = [];
    const warnings = [];
    const { steps } = parseCommonSteps(commonYaml || "");
    const keys = Object.keys(steps);
    if (keys.length === 0) {
      warnings.push("no `common_steps:` block, or the map is empty");
    }
    keys.forEach((key) => {
      const step = steps[key];
      const fv = validateForm(step.form || {}, formsByName);
      if (!fv.ok) {
        errors.push(
          ...fv.errors.map((e) => `common step "${key}": ${e}`)
        );
      }
    });
    return { ok: errors.length === 0, errors, warnings };
  }

  // Validate a playbook's YAML against the Common Steps map and form library.
  // Returns { ok, errors, warnings }
  function validatePlaybookFlow(yaml, commonByName, formsByName) {
    const errors = [];
    const warnings = [];
    const { name } = parseHeader(yaml);
    if (!name) errors.push("missing top-level `name:`");
    const flow = parseFlow(yaml);
    if (flow.length === 0) warnings.push("no `flow:` block, or the flow is empty");
    flow.forEach((item, idx) => {
      const prefix = `flow step ${idx + 1}`;
      if (item.ref) {
        if (!commonByName.has(item.ref)) {
          errors.push(
            `${prefix}: ref "${item.ref}" not found in Common Steps`
          );
          return;
        }
        // A ref item may override with its own form — validate it too.
        if (item.form && Object.keys(item.form).length) {
          const fv = validateForm(item.form, formsByName);
          if (!fv.ok) {
            errors.push(...fv.errors.map((e) => `${prefix}: ${e}`));
          }
        }
      } else {
        if (!item.name) {
          errors.push(`${prefix}: missing \`name:\``);
        }
        const fv = validateForm(item.form || {}, formsByName);
        if (!fv.ok) {
          errors.push(...fv.errors.map((e) => `${prefix}: ${e}`));
        }
      }
    });
    return { ok: errors.length === 0, errors, warnings };
  }

  /* ---------- Services (single shared API doc) ---------- */

  // Strip a trailing `# comment` from a YAML line, honoring quotes.
  function stripYamlComment(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && (i === 0 || text[i - 1] !== "\\")) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
        return text.slice(0, i).trimEnd();
      }
    }
    return text.trimEnd();
  }

  // Parse `key: rest` at the head of a line. Keys are plain tokens (may contain
  // "-"/"_"). Returns null when the line is not a mapping entry.
  function parseKVLine(text) {
    const ci = text.indexOf(":");
    if (ci <= 0) return null;
    const key = text.slice(0, ci).trim();
    if (!/^[A-Za-z_][\w-]*$/.test(key)) return null;
    return { key, rest: text.slice(ci + 1).trim(), hasValue: text.slice(ci + 1).trim().length > 0 };
  }

  function isDashText(t) {
    return t === "-" || /^-\s/.test(t);
  }

  // Coerce an inline scalar. Strings containing ${...} are kept verbatim.
  function coerceScalar(raw) {
    let s = String(raw).trim();
    if (s === "") return null;
    if (
      s.length >= 2 &&
      s[0] === '"' && s[s.length - 1] === '"'
    ) {
      // Double-quoted: resolve escape sequences (\n, \t, \\, \", etc.)
      return unescapeDoubleQuoted(s.slice(1, -1));
    }
    if (
      s.length >= 2 &&
      s[0] === "'" && s[s.length - 1] === "'"
    ) {
      // Single-quoted: the only escape is '' -> '
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s.indexOf("${") !== -1) return s;
    const low = s.toLowerCase();
    if (TRUE_TOKENS.has(low)) return true;
    if (FALSE_TOKENS.has(low)) return false;
    if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
      if (/^[-+]?0\d+/.test(s)) return s; // keep leading-zero ids as strings
      const n = Number(s);
      if (!Number.isNaN(n)) return n;
    }
    return s;
  }

  // Minimal indentation-based YAML reader that returns plain JS data
  // (objects / arrays / scalars). Supports nested maps & sequences; no flow
  // style, no block scalars, no tabs.
  function readYamlNode(toks, i, indent) {
    if (i >= toks.length) return { node: null, i };
    const t = toks[i];
    if (t.indent !== indent) return { node: null, i };
    if (isDashText(t.text)) return readYamlSequence(toks, i, indent);
    return readYamlMapping(toks, i, indent);
  }

  function readYamlMapping(toks, i, indent) {
    const map = {};
    while (i < toks.length) {
      const t = toks[i];
      if (t.indent !== indent || isDashText(t.text)) break;
      const kv = parseKVLine(t.text);
      if (!kv) {
        i++;
        continue;
      }
      const key = kv.key;
      let value;
      if (kv.hasValue) {
        value = coerceScalar(kv.rest);
        i++;
      } else {
        const nxt = toks[i + 1];
        if (nxt && nxt.indent > indent) {
          const r = readYamlNode(toks, i + 1, nxt.indent);
          value = r.node;
          i = r.i;
        } else {
          value = null;
          i++;
        }
      }
      map[key] = value;
    }
    return { node: map, i };
  }

  function readYamlSequence(toks, i, indent) {
    const arr = [];
    while (i < toks.length) {
      const t = toks[i];
      if (t.indent !== indent || !isDashText(t.text)) break;
      const dashLen = /^-\s/.test(t.text) ? 2 : 1;
      const content = t.text.slice(dashLen).trim();
      const kv = content ? parseKVLine(content) : null;
      if (kv) {
        const item = {};
        let j = i + 1;
        let value;
        if (kv.hasValue) {
          value = coerceScalar(kv.rest);
        } else {
          const nxt = toks[j];
          if (nxt && nxt.indent > indent) {
            const r = readYamlNode(toks, j, nxt.indent);
            value = r.node;
            j = r.i;
          } else value = null;
        }
        item[kv.key] = value;
        // Remaining deeper key lines belong to the same list item's map.
        while (
          j < toks.length &&
          toks[j].indent > indent &&
          !isDashText(toks[j].text)
        ) {
          const t2 = toks[j];
          const kv2 = parseKVLine(t2.text);
          if (!kv2) {
            j++;
            continue;
          }
          let v2;
          if (kv2.hasValue) {
            v2 = coerceScalar(kv2.rest);
            j++;
          } else {
            const nn = toks[j + 1];
            if (nn && nn.indent > t2.indent) {
              const rr = readYamlNode(toks, j + 1, nn.indent);
              v2 = rr.node;
              j = rr.i;
            } else {
              v2 = null;
              j++;
            }
          }
          item[kv2.key] = v2;
        }
        arr.push(item);
        i = j;
      } else {
        arr.push(content === "" ? null : coerceScalar(content));
        i++;
      }
    }
    return { node: arr, i };
  }

  // Parse an arbitrary YAML string into plain JS data (or null when empty).
  function parseNestedYaml(yamlText) {
    const toks = [];
    const rawLines = String(yamlText || "").replace(/\r\n/g, "\n").split("\n");

    // Block scalar indicator after a key, e.g. `comments: |` or `body: >-`.
    // Captures: key, style (| or >), chomp (+ / - / ""), optional indent digit.
    const blockIndicatorRe = /^([A-Za-z_][\w-]*):[ \t]*([|>])([+-]?)([0-9]*)[ \t]*(?:#.*)?$/;

    for (let li = 0; li < rawLines.length; li++) {
      const rawLine = rawLines[li];
      if (/^\s*$/.test(rawLine)) continue;
      const indent = (rawLine.match(/^[ \t]*/) || [""])[0].length;
      const text = stripYamlComment(rawLine.trim());
      if (!text) continue;

      // --- Block scalar: key: | or key: > (possibly with + / - chomping) ---
      const bm = text.match(blockIndicatorRe);
      if (bm) {
        const key = bm[1];
        const style = bm[2]; // "|" (literal) or ">" (folded)
        const chomp = bm[3]; // "+", "-", or "" (clip)
        const explicitIndent = bm[4] ? parseInt(bm[4], 10) : 0;

        // Gather every subsequent line indented strictly deeper than the key.
        // Blank lines are kept (they separate paragraphs for folded style).
        const blockLines = [];
        let contentIndent = explicitIndent > 0 ? indent + explicitIndent : null;
        li++;
        while (li < rawLines.length) {
          const bl = rawLines[li];
          if (/^\s*$/.test(bl)) {
            blockLines.push("");
            li++;
            continue;
          }
          const blIndent = (bl.match(/^[ \t]*/) || [""])[0].length;
          if (blIndent <= indent) {
            // This line belongs to the parent context — rewind so the outer
            // loop picks it up.
            li--;
            break;
          }
          if (contentIndent === null) contentIndent = blIndent;
          // Strip the base content indentation but keep any deeper relative
          // indent (e.g. for nested code blocks inside a literal scalar).
          blockLines.push(bl.slice(contentIndent));
          li++;
        }

        let value = blockLines.join("\n");

        // Chomping: how to treat trailing newlines.
        //   "" (clip) -> keep a single trailing newline
        //   "-" (strip) -> remove all trailing newlines
        //   "+" (keep) -> preserve every trailing newline
        if (chomp === "-") {
          value = value.replace(/\n+$/, "");
        } else if (chomp === "") {
          value = value.replace(/\n+$/, "\n");
        }
        // "+" leaves everything as-is.

        // Folded style (>): single newlines become spaces; blank lines (two+
        // newlines) become a single newline. This matches standard YAML >.
        if (style === ">") {
          value = value
            .replace(/\n{2,}/g, "\u0000")
            .replace(/\n/g, " ")
            .replace(/\u0000/g, "\n");
          // Fold leaves a trailing space after the last line; normalise it.
          if (chomp === "") value = value.replace(/[ \t]+$/, "");
        }

        // Re-emit as an inline double-quoted scalar. JSON.stringify escapes
        // newlines, quotes and backslashes, and coerceScalar's
        // unescapeDoubleQuoted path reverses them — so the final value holds
        // real newline characters, not the literal two chars "\n".
        toks.push({ indent, text: `${key}: ${JSON.stringify(value)}` });
        continue;
      }

      toks.push({ indent, text });
    }
    if (toks.length === 0) return null;
    const r = readYamlNode(toks, 0, toks[0].indent);
    return r ? r.node : null;
  }

  // Derive an output alias from a JSONPath when the doc does not spell one out.
  function aliasFromPath(path) {
    const m = String(path).match(/\.([A-Za-z_$][\w$-]*)\s*$/);
    return m ? m[1] : String(path);
  }

  // Normalize `output:` (list of {alias,json_path} | alias->path map | a single
  // JSONPath string) into [{ alias, path }].
  function normalizeServiceOutputs(rawOut) {
    const list = [];
    if (rawOut == null) return list;
    if (Array.isArray(rawOut)) {
      rawOut.forEach((e) => {
        if (e == null) return;
        if (typeof e === "string") {
          if (e.trim()) list.push({ alias: aliasFromPath(e), path: e.trim() });
        } else if (typeof e === "object") {
          const alias = e.alias != null ? String(e.alias).trim() : "";
          const path =
            e.json_path != null
              ? String(e.json_path).trim()
              : e.path != null
                ? String(e.path).trim()
                : "";
          if (alias && path) list.push({ alias, path });
          else if (path) list.push({ alias: aliasFromPath(path), path });
        }
      });
    } else if (typeof rawOut === "object") {
      for (const [k, v] of Object.entries(rawOut)) {
        if (v != null) list.push({ alias: String(k).trim(), path: String(v).trim() });
      }
    } else if (typeof rawOut === "string" && rawOut.trim()) {
      list.push({ alias: aliasFromPath(rawOut), path: rawOut.trim() });
    }
    return list;
  }

  // Normalize one parsed service entry (raw object from parseNestedYaml).
  // type: "api" | "group". A group may carry name/desc + nested services[].
  function normalizeServiceEntry(raw, label) {
    const isGroup =
      raw &&
      (raw.services !== undefined ||
        String(raw.type || "").toLowerCase() === "group");
    if (isGroup) {
      const children = Array.isArray(raw.services)
        ? raw.services.map((c, idx) =>
            normalizeServiceEntry(c, `${label} → service ${idx + 1}`)
          )
        : [];
      return {
        name: raw.name != null ? stripQuotes(String(raw.name)) : "",
        type: "group",
        desc: raw.desc != null ? String(raw.desc) : "",
        services: children,
      };
    }
    const out = {
      name: raw && raw.name != null ? stripQuotes(String(raw.name)) : "",
      type: "api",
      desc: raw && raw.desc != null ? String(raw.desc) : "",
      method: raw && raw.method != null ? String(raw.method).trim().toUpperCase() : "GET",
      endpoint: raw && raw.endpoint != null ? stripQuotes(String(raw.endpoint)) : "",
      header: raw && raw.header != null ? raw.header : null,
      body: raw && raw.body !== undefined ? raw.body : null,
      outputs: normalizeServiceOutputs(raw && raw.output),
    };
    return out;
  }

  // Parse the shared Services document.
  // Returns { services: [...], rawErrors: string[] }.
  function parseServicesDoc(yaml) {
    const rawErrors = [];
    let data;
    try {
      data = parseNestedYaml(yaml || "");
    } catch (e) {
      return { services: [], rawErrors: [`unparseable YAML: ${e.message}`] };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { services: [], rawErrors: ["missing top-level `services:` list"] };
    }
    const list = data.services;
    if (!Array.isArray(list)) {
      return { services: [], rawErrors: ["missing top-level `services:` list"] };
    }
    const services = list.map((item, idx) =>
      normalizeServiceEntry(item, `services[${idx + 1}]`)
    );
    return { services, rawErrors };
  }

  function validateServicesDoc(yaml) {
    const errors = [];
    const warnings = [];
    const doc = parseServicesDoc(yaml || "");
    errors.push(...doc.rawErrors);

    const visit = (svc, prefix, depth) => {
      const where = svc.name ? `${prefix} "${svc.name}"` : prefix;
      if (!svc.name) errors.push(`${prefix}: missing name:`);
      if (svc.type === "group") {
        if (!svc.services || svc.services.length === 0) {
          warnings.push(`${where}: group has no services`);
        }
        (svc.services || []).forEach((child, idx) => {
          visit(child, `${prefix} → service ${idx + 1}`, depth + 1);
          if (child.type === "group") {
            errors.push(
              `${prefix} → service ${idx + 1}: nested groups are not supported`
            );
          }
        });
        return;
      }
      if (!svc.endpoint) {
        errors.push(`${where}: missing endpoint`);
      } else if (!/^https?:\/\//i.test(svc.endpoint)) {
        warnings.push(`${where}: endpoint is not an http(s) URL`);
      }
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(svc.method)) {
        errors.push(`${where}: unsupported method "${svc.method}"`);
      }
      // output aliases must be unique within this service
      const seen = new Set();
      (svc.outputs || []).forEach((o) => {
        if (seen.has(o.alias)) {
          errors.push(`${where}: duplicate output alias "${o.alias}"`);
        }
        seen.add(o.alias);
      });
    };

    doc.services.forEach((s, idx) => visit(s, `services[${idx + 1}]`, 1));

    // Duplicate top-level names are confusing in the side panel.
    const nameSeen = new Set();
    doc.services.forEach((s) => {
      if (!s.name) return;
      if (nameSeen.has(s.name)) {
        warnings.push(`top-level name "${s.name}" is duplicated`);
      }
      nameSeen.add(s.name);
    });

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      doc: doc.services,
    };
  }

  /* ---------- Services: placeholders, alias chain, path lookup ---------- */

  // Recursively collect ${name}s from scalars (and mapping keys) in `value`.
  function collectRefs(value, out) {
    if (typeof value === "string") {
      extractPlaceholderNames(value).forEach((n) => out.add(n));
    } else if (Array.isArray(value)) {
      value.forEach((v) => collectRefs(v, out));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        extractPlaceholderNames(String(k)).forEach((n) => out.add(n));
        collectRefs(v, out);
      }
    }
  }

  function serviceRefNames(svc) {
    const set = new Set();
    collectRefs(svc.endpoint, set);
    collectRefs(svc.header, set);
    collectRefs(svc.body, set);
    return set;
  }

  // Compute the user inputs a runnable unit (top-level API or whole group) needs.
  // A ${name} that equals an output alias of an EARLIER sibling inside the same
  // group is satisfied by the chain and is NOT returned here.
  // Returns [{ var, from }] — unique var names in first-use order.
  function collectServiceInputs(topItem) {
    const inputs = [];
    const seen = new Set();
    const want = (n, from) => {
      if (seen.has(n)) return;
      seen.add(n);
      inputs.push({ var: n, from });
    };
    const walk = (svc, knownAliases, prefix) => {
      const from = `${prefix} ${svc.name || "service"}`.trim();
      const refs = serviceRefNames(svc);
      refs.forEach((n) => {
        if (!knownAliases.has(n)) want(n, from);
      });
      // outputs become visible to later siblings in the same group
      (svc.outputs || []).forEach((o) => knownAliases.add(o.alias));
    };
    if (topItem && topItem.type === "group") {
      const known = new Set();
      (topItem.services || []).forEach((child, idx) =>
        walk(child, known, `${topItem.name || "Group"} · ${idx + 1}`)
      );
    } else if (topItem) {
      walk(topItem, new Set(), "Service");
    }
    return inputs;
  }

  // Deep-replace ${name} placeholders in an arbitrary template value.
  // Unknown placeholders are left untouched.
  function resolveTemplate(value, values) {
    if (typeof value === "string") return resolvePlaceholders(value, values);
    if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, values));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[resolvePlaceholders(String(k), values)] = resolveTemplate(v, values);
      }
      return out;
    }
    return value;
  }

  // Minimal JSONPath evaluator over parsed JSON: $.a.b[0].c, $.a['x-y'] ...
  // Returns undefined when any segment is missing.
  function queryPath(obj, path) {
    if (path == null) return undefined;
    let p = String(path).trim();
    if (!p) return undefined;
    if (p === "$") return obj;
    if (p[0] === "$") p = p.slice(1);
    const segs = [];
    const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g;
    let m;
    while ((m = re.exec(p)) !== null) {
      segs.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : m[3]);
    }
    if (segs.length === 0) {
      // bare key like "data.id" (no leading dot) — try whole-key match
      const parts = p.split(".").filter(Boolean);
      if (parts.length) segs.push(...parts);
    }
    let cur = obj;
    for (const s of segs) {
      if (cur == null) return undefined;
      cur = cur[s];
    }
    return cur;
  }

  /* ---------- Autocomplete helpers ---------- */

  // Build autocomplete candidates for the given context.
  // ctx.kind === "ref"  => only common step keys (after "ref: ").
  // ctx.kind === "slash" => two-level form completions (see below).
  // Each item is { label, snippet, group, hint }.
  function buildCompletions(ctx) {
    const items = [];
    const c = ctx || {};
    if (c.kind === "ref") {
      const keys = Array.isArray(c.commonSteps) ? c.commonSteps : [];
      keys.forEach((k) => {
        items.push({
          label: k,
          snippet: k,
          group: "common-step",
          hint: "common step",
        });
      });
      return items;
    }
    // Slash context — two levels:
    //   * no `key: ` yet on the line (ctx.formKey empty) => suggest every
    //     distinct form `name` once (names may repeat across rows). Each
    //     candidate is shown by its human `label` and, when chosen, inserts
    //     `name: `.
    //   * the caret sits right after `key: ` (ctx.formKey set): value
    //     candidates are only offered for fields with fixed rows. A field whose
    //     rows are ALL type "string" is free-form — it accepts any text, so its
    //     value stage suggests nothing.
    const rows = c.forms || [];
    const key = c.formKey || null;
    if (key) {
      const defs = rows.filter((r) => r && r.name === key);
      const hasFixedValues = defs.some((d) => d.type && d.type !== "string");
      if (!hasFixedValues) return items; // all-string field: free-form input
      const seen = new Set();
      defs.forEach((row) => {
        if (row.value === undefined || row.value === null) return;
        const s = String(row.value);
        if (s.trim() === "" || seen.has(s)) return;
        seen.add(s);
        // In the dropdown show the human-readable `display` (falling back to
        // the raw value) but insert the actual `value` when one is chosen.
        items.push({
          label: row.display ? String(row.display) : s,
          snippet: s,
          group: "form-value",
          hint: row.type || "",
          row,
        });
      });
      return items;
    }
    // Field-name stage: group repeated names, remember the first row's label
    // and whether the group contains any non-string (fixed-value) row.
    const meta = new Map();
    rows.forEach((row) => {
      if (!row || !row.name) return;
      if (!meta.has(row.name)) {
        meta.set(row.name, {
          row,
          fixedType: row.type && row.type !== "string" ? row.type : "",
        });
        return;
      }
      const m = meta.get(row.name);
      if (!m.fixedType && row.type && row.type !== "string") {
        m.fixedType = row.type;
      }
    });
    meta.forEach((m, name) => {
      items.push({
        label: m.row.label || name,
        snippet: `${name}: `,
        group: "form",
        hint: m.fixedType,
        row: m.row,
      });
    });
    return items;
  }

  // Analyze textarea { value, selectionStart } to decide autocomplete context.
  //
  // Two triggers:
  //   1. `ref: ` — a YAML key token "ref:" followed by a space, at the start of
  //      a line (allowing leading whitespace or a "- " list prefix). The caret
  //      sits inside the key being typed after the colon+space.
  //   2. `/` (slash) — slash-command style (unchanged): `/` at the start of a
  //      token (line-start / after whitespace / after `: `), never inside a
  //      literal word (avoids URLs / filenames).
  //
  // Returns { triggerStart, prefix, kind: "ref"|"slash" } or null.
  function analyzeContext(value, cursor) {
    const v = value == null ? "" : String(value);
    if (cursor < 0 || cursor > v.length) return null;
    const upToCursor = v.slice(0, cursor);
    const lineStart = upToCursor.lastIndexOf("\n") + 1;
    const linePrefix = upToCursor.slice(lineStart);

    // --- ref: completion context ---
    const refMatch = linePrefix.match(
      /^[ \t]*(?:-\s+)?ref:[ \t]+([\w-]*)$/
    );
    if (refMatch) {
      const colonIdx = linePrefix.indexOf(":");
      let sp = colonIdx + 1;
      while (sp < linePrefix.length && /[ \t]/.test(linePrefix[sp])) sp++;
      return {
        triggerStart: lineStart + sp,
        prefix: linePrefix.slice(sp),
        kind: "ref",
      };
    }

    // --- slash completion context ---
    if (cursor < 1) return null;
    const slashIdx = upToCursor.lastIndexOf("/");
    if (slashIdx < 0) return null;
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
    const tail = v.slice(slashIdx + 1, cursor);
    if (/\s/.test(tail)) return null;
    // If the caret sits right after a bare `key: ` (indent + optional list dash,
    // the key token, colon and spaces only), the slash completes that key's
    // candidate values; otherwise it starts a fresh field-name query.
    const lineUpToSlash = upToCursor.slice(lineStart, slashIdx);
    const keyMatch = lineUpToSlash.match(
      /^[ \t]*(?:-\s+)?([A-Za-z_][\w-]*):[ \t]*$/
    );
    return {
      triggerStart: slashIdx,
      prefix: tail,
      kind: "slash",
      formKey: keyMatch ? keyMatch[1] : null,
    };
  }

  // Filter completions by prefix. Field-name candidates are shown by their
  // human `label` but insert a `name`, so match both label and snippet text.
  function filterCompletions(items, prefix) {
    const p = (prefix || "").toLowerCase();
    return items
      .filter((it) => {
        if (!p) return true;
        const label = String(it.label || "").toLowerCase();
        const snippet = String(it.snippet || "").toLowerCase();
        return label.indexOf(p) !== -1 || snippet.indexOf(p) !== -1;
      })
      .slice(0, 25);
  }

  global.SRE_YAML = {
    ALLOWED_FORM_TYPES,
    stripQuotes,
    parseHeader,
    parseFormBlock,
    parseParams,
    paramOptionRows,
    validateOptionParams,
    parseActionToken,
    effectiveAction,
    parseCommonSteps,
    indexCommonSteps,
    parseFlow,
    extractPlaceholderNames,
    resolvePlaceholders,
    indexForms,
    validateForm,
    validateCommonStepsDoc,
    validatePlaybookFlow,
    parseServicesDoc,
    parseNestedYaml,
    validateServicesDoc,
    collectServiceInputs,
    resolveTemplate,
    queryPath,
    buildCompletions,
    analyzeContext,
    filterCompletions,
  };
})(typeof self !== "undefined" ? self : this);
