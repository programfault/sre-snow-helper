/* ---------- Form tab (column-fixed CSV-like table) ---------- */

const FORM_FORM_WRAP_ID = "formTableWrap";
let editingFormId = null;

function renderForms() {
  const wrap = document.getElementById(FORM_FORM_WRAP_ID);
  wrap.innerHTML = "";
  if (forms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.innerHTML = `<div class="form-empty">No form fields yet. Click "+ Add row" to define one.</div>`;
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
        cell.addEventListener("click", () => enterEdit(row.id));
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
  } else {
    const dup = forms.find(
      (r) => r.id !== rowId && String(r.name) === patch.name
    );
    if (dup) hasError = `duplicate name "${patch.name}"`;
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

