/* ---------- Form tab (column-fixed table <-> raw CSV editor) ---------- */

const FORM_FORM_WRAP_ID = "formTableWrap";
const FORM_CSV_WRAP_ID = "formCsvWrap";
const FORM_CSV_INPUT_ID = "formCsvInput";
const FORM_CSV_ERROR_ID = "formCsvError";
let editingFormId = null;
let formCsvMode = false;

/* ---------- CSV (de)serialization ---------- */
// The table and the CSV editor share one shape per line, column order =
// FORM_FIELDS: name,label,display,value,type.

function csvEscape(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formsToCsv() {
  return forms
    .map((row) => FORM_FIELDS.map((f) => csvEscape(row[f.key])).join(","))
    .join("\n");
}

// Minimal RFC-4180-ish parser: double quotes escape quotes, commas and
// newlines may live inside quoted fields.
function csvParse(text) {
  const src = String(text).replace(/\r\n?/g, "\n");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Map parsed cells to form rows. Blank lines are skipped; malformed lines are
// reported instead of silently dropped.
function csvImport(text) {
  const out = [];
  const problems = [];
  csvParse(text).forEach((cells, idx) => {
    if (cells.every((c) => String(c).trim() === "")) return;
    const lineNo = idx + 1;
    const name = String(cells[0] ?? "").trim();
    const label = String(cells[1] ?? "").trim();
    const display = String(cells[2] ?? "").trim();
    const value = String(cells[3] ?? ""); // keep raw — may be quoted on purpose
    const type = String(cells[4] ?? "").trim() || "string";
    if (!name) {
      problems.push(`line ${lineNo}: missing name`);
      return;
    }
    if (!Y.ALLOWED_FORM_TYPES.includes(type)) {
      problems.push(
        `line ${lineNo}: unknown type "${type}" (expected ${Y.ALLOWED_FORM_TYPES.join(" | ")})`
      );
      return;
    }
    out.push({ id: uid(), name, label, value, display, type });
  });
  return { rows: out, problems };
}

/* ---------- Table <-> CSV view ---------- */

function clearCsvError() {
  const el = document.getElementById(FORM_CSV_ERROR_ID);
  if (el) el.textContent = "";
}

function showCsvView() {
  formCsvMode = true;
  document.getElementById(FORM_CSV_INPUT_ID).value = formsToCsv();
  clearCsvError();
  document.getElementById(FORM_FORM_WRAP_ID).style.display = "none";
  document.getElementById(FORM_CSV_WRAP_ID).classList.add("open");
  document.getElementById("toggleFormCsv").textContent = "表格视图";
}

function showTableView() {
  formCsvMode = false;
  clearCsvError();
  document.getElementById(FORM_CSV_WRAP_ID).classList.remove("open");
  document.getElementById(FORM_FORM_WRAP_ID).style.display = "";
  document.getElementById("toggleFormCsv").textContent = "CSV 编辑";
}

function renderForms() {
  const wrap = document.getElementById(FORM_FORM_WRAP_ID);
  wrap.innerHTML = "";
  if (forms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.innerHTML = `<div class="form-empty">No form fields yet. Click "+ Add row" to define one, or paste a whole table with the CSV editor.</div>`;
    wrap.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "form-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  FORM_FIELDS.forEach((f) => {
    const th = document.createElement("th");
    th.textContent = f.label;
    if (f.key === "name") th.classList.add("name-col");
    if (f.key === "type") th.classList.add("type-col");
    headRow.appendChild(th);
  });
  const actionsTh = document.createElement("th");
  actionsTh.textContent = "Actions";
  actionsTh.className = "actions-col";
  headRow.appendChild(actionsTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  forms.forEach((row) => {
    const tr = document.createElement("tr");
    if (editingFormId === row.id) tr.classList.add("editing");
    tr.dataset.id = row.id;
    FORM_FIELDS.forEach((f) => {
      const td = document.createElement("td");
      if (f.key === "name") td.classList.add("name-col");
      if (f.key === "type") td.classList.add("type-col");
      const cell = document.createElement("div");
      cell.className = "form-cell";

      if (editingFormId === row.id) {
        let input;
        if (f.key === "type") {
          input = document.createElement("select");
          Y.ALLOWED_FORM_TYPES.forEach((t) => {
            const o = document.createElement("option");
            o.value = t;
            o.textContent = t;
            if (row.type === t) o.selected = true;
            input.appendChild(o);
          });
        } else {
          input = document.createElement("input");
          input.type = "text";
          input.value = row[f.key] ?? "";
          input.placeholder = f.key;
        }
        input.dataset.key = f.key;
        cell.appendChild(input);
      } else {
        const valueEl = document.createElement("div");
        valueEl.className = "form-cell-value";
        if (f.key === "type") {
          const t = row.type || "string";
          valueEl.innerHTML = `<span class="type-badge ${t}">${escapeHtml(t)}</span>`;
        } else {
          const v = row[f.key];
          valueEl.textContent = v !== undefined && v !== "" ? String(v) : "\u2014";
        }
        cell.appendChild(valueEl);
      }
      td.appendChild(cell);
      tr.appendChild(td);
    });

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions-col";
    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    if (editingFormId === row.id) {
      const saveBtn = document.createElement("button");
      saveBtn.className = "row-btn primary";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () => commitEdit(tr, row.id));
      const cancel = document.createElement("button");
      cancel.className = "row-btn cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        editingFormId = null;
        renderForms();
      });
      rowActions.appendChild(saveBtn);
      rowActions.appendChild(cancel);
    } else {
      const edit = document.createElement("button");
      edit.className = "row-btn";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => enterEdit(row.id));
      const del = document.createElement("button");
      del.className = "row-btn danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        forms = forms.filter((r) => r.id !== row.id);
        persistForms();
        renderForms();
      });
      rowActions.appendChild(edit);
      rowActions.appendChild(del);
    }
    actionsTd.appendChild(rowActions);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (editingFormId !== null) {
    const tr = wrap.querySelector(`tr[data-id="${editingFormId}"]`);
    if (tr) {
      const firstInput = tr.querySelector('input[data-key="name"]');
      if (firstInput) {
        firstInput.focus();
        firstInput.select();
      }
    }
  }
}

function enterEdit(rowId) {
  editingFormId = rowId;
  renderForms();
}

function commitEdit(tr, rowId) {
  const inputs = tr.querySelectorAll("[data-key]");
  const patch = {};
  let hasError = "";
  inputs.forEach((el) => {
    const key = el.dataset.key;
    if (el.tagName === "SELECT") {
      patch[key] = el.value;
    } else {
      patch[key] = el.value.trim();
    }
  });
  if (!patch.name) {
    hasError = "name is required";
  }
  if (!hasError && patch.type && patch.type !== "string") {
    if (patch.value === undefined || String(patch.value).trim() === "") {
      hasError = `type "${patch.type}" requires a value`;
    }
  }
  const oldErr = tr.parentElement.parentElement.querySelector(":scope > .form-error");
  if (oldErr) oldErr.remove();
  if (hasError) {
    const err = document.createElement("div");
    err.className = "form-error";
    err.textContent = hasError;
    tr.parentElement.parentElement.insertBefore(err, tr.parentElement.nextSibling);
    return;
  }
  forms = forms.map((r) =>
    r.id === rowId
      ? {
          ...r,
          name: patch.name,
          label: patch.label,
          value: patch.value,
          display: patch.display,
          type: patch.type || "string",
        }
      : r
  );
  editingFormId = null;
  persistForms();
  renderForms();
}

document.getElementById("addFormRow").addEventListener("click", () => {
  const newRow = {
    id: uid(),
    name: "",
    label: "",
    value: "",
    display: "",
    type: "string",
  };
  forms = forms.concat(newRow);
  persistForms();
  editingFormId = newRow.id;
  renderForms();
});

document.getElementById("toggleFormCsv").addEventListener("click", () => {
  if (formCsvMode) showTableView();
  else showCsvView();
});

document.getElementById("formCsvCancel").addEventListener("click", () => {
  showTableView();
});

document.getElementById("formCsvSave").addEventListener("click", () => {
  const ta = document.getElementById(FORM_CSV_INPUT_ID);
  const { rows, problems } = csvImport(ta.value);
  const errEl = document.getElementById(FORM_CSV_ERROR_ID);
  if (problems.length > 0) {
    errEl.textContent = problems.join("\n");
    return;
  }
  forms = rows;
  editingFormId = null;
  persistForms();
  renderForms();
  showTableView();
});
