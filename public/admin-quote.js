(function () {
  const cargoRows = document.querySelector("[data-cargo-rows]");
  const cargoAdd = document.querySelector("[data-cargo-add]");
  const cargoTemplate = document.getElementById("cargo-row-template");
  const cargoDefault = document.querySelector('select[name="hd_cargoType"]');
  const cargoEmpty = document.querySelector("[data-cargo-empty]");

  function syncCargoDefaults() {
    if (!cargoRows || !cargoDefault) return;
    const selected = cargoDefault.value;
    const options = [new Option("—", "")];
    const seen = new Set();
    cargoRows.querySelectorAll("[data-cargo-row]").forEach((row) => {
      const code = row.querySelector('[name="cargo_code[]"]').value.trim().toUpperCase();
      const label = row.querySelector('[name="cargo_label[]"]').value.trim();
      const enabled = row.querySelector('[name="cargo_enabled[]"]').value === "1";
      if (enabled && /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code) && !seen.has(code)) {
        seen.add(code);
        // Keep an enabled default selected while its name is temporarily empty
        // during editing. Required/server validation still blocks saving it.
        options.push(new Option(label || code, code));
      }
    });
    cargoDefault.replaceChildren(...options);
    cargoDefault.value = seen.has(selected) ? selected : "";
    if (cargoEmpty) cargoEmpty.hidden = seen.size > 0;
    if (cargoAdd) cargoAdd.disabled = cargoRows.children.length >= 100;
  }

  if (cargoRows && cargoAdd && cargoTemplate) {
    cargoAdd.addEventListener("click", () => {
      const node = cargoTemplate.content.cloneNode(true);
      const input = node.querySelector("input");
      cargoRows.appendChild(node);
      syncCargoDefaults();
      input.focus();
    });
    cargoRows.addEventListener("input", syncCargoDefaults);
    cargoRows.addEventListener("change", syncCargoDefaults);
    cargoRows.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cargo-remove]");
      if (!button) return;
      button.closest("[data-cargo-row]").remove();
      syncCargoDefaults();
    });
    syncCargoDefaults();
  }
  const cargoError = document.querySelector("[data-cargo-error]");
  if (cargoError) cargoError.focus();

  const rows = document.querySelector("[data-remark-rows]");
  const addBtn = document.querySelector("[data-remark-add]");
  const tpl = document.getElementById("remark-row-template");
  if (addBtn && rows && tpl) {
    addBtn.addEventListener("click", () => {
      const node = tpl.content.cloneNode(true);
      node.querySelector('input[name="note_id[]"]').value = "note-" + Date.now();
      rows.appendChild(node);
    });
    rows.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-remark-remove]");
      if (!btn) return;
      const row = btn.closest("[data-remark-row]");
      if (row) row.remove();
    });
  }
})();
