(function calculatorRows() {
  const rowsRoot = document.querySelector("[data-container-rows]");
  const addButton = document.querySelector("[data-add-row]");
  const groupDataNode = document.querySelector("#container-group-data");
  const i18nNode = document.querySelector("#calculator-i18n");

  if (!rowsRoot || !addButton || !groupDataNode || !i18nNode) {
    return;
  }

  const containerGroups = JSON.parse(groupDataNode.textContent || "[]");
  const i18n = JSON.parse(i18nNode.textContent || "{}");

  function buildOptions(selectedKey) {
    return containerGroups
      .map(
        (group) =>
          `<option value="${group.key}" ${
            group.key === selectedKey ? "selected" : ""
          }>${group.label}</option>`
      )
      .join("");
  }

  function buildRow(selectedKey, quantity) {
    const row = document.createElement("div");
    row.className = "dynamic-row";
    row.setAttribute("data-row", "");
    row.innerHTML = `
      <label>
        <span>${i18n.containerType || "Container"}</span>
        <select name="containerGroupKey[]">
          ${buildOptions(selectedKey || containerGroups[0]?.key || "")}
        </select>
      </label>
      <label>
        <span>${i18n.quantity || "Qty"}</span>
        <input type="number" min="0" step="1" name="containerCount[]" value="${quantity ?? 1}" />
      </label>
      <button type="button" class="ghost-button compact-button" data-remove-row>${i18n.removeRow || "Remove"}</button>
    `;
    return row;
  }

  addButton.addEventListener("click", () => {
    rowsRoot.appendChild(buildRow(containerGroups[0]?.key || "", 1));
  });

  rowsRoot.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-row]");
    if (!removeButton) {
      return;
    }

    const row = removeButton.closest("[data-row]");
    if (!row) {
      return;
    }

    if (rowsRoot.querySelectorAll("[data-row]").length === 1) {
      row.querySelector("input").value = "1";
      row.querySelector("select").selectedIndex = 0;
      return;
    }

    row.remove();
  });
})();
