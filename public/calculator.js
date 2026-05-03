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

  function appendOptions(select, selectedKey) {
    for (const group of containerGroups) {
      const option = document.createElement("option");
      option.value = group.key;
      option.textContent = group.label;
      option.selected = group.key === selectedKey;
      select.appendChild(option);
    }
  }

  function buildRow(selectedKey, quantity) {
    const row = document.createElement("div");
    row.className = "dynamic-row";
    row.setAttribute("data-row", "");

    const typeLabel = document.createElement("label");
    const typeText = document.createElement("span");
    typeText.textContent = i18n.containerType || "Container";
    const typeSelect = document.createElement("select");
    typeSelect.name = "containerGroupKey[]";
    appendOptions(typeSelect, selectedKey || containerGroups[0]?.key || "");
    typeLabel.append(typeText, typeSelect);

    const quantityLabel = document.createElement("label");
    const quantityText = document.createElement("span");
    quantityText.textContent = i18n.quantity || "Qty";
    const quantityInput = document.createElement("input");
    quantityInput.type = "number";
    quantityInput.min = "0";
    quantityInput.step = "1";
    quantityInput.name = "containerCount[]";
    quantityInput.value = quantity ?? 1;
    quantityLabel.append(quantityText, quantityInput);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost-button compact-button";
    removeButton.setAttribute("data-remove-row", "");
    removeButton.textContent = i18n.removeRow || "Remove";
    removeButton.title = i18n.keepOneContainer || "";

    row.append(typeLabel, quantityLabel, removeButton);
    return row;
  }

  function updateRemoveButtons() {
    const rows = [...rowsRoot.querySelectorAll("[data-row]")];
    rows.forEach((row) => {
      const removeButton = row.querySelector("[data-remove-row]");
      if (!removeButton) {
        return;
      }
      removeButton.disabled = rows.length <= 1;
      removeButton.title = rows.length <= 1 ? i18n.keepOneContainer || "" : "";
    });
  }

  addButton.addEventListener("click", () => {
    rowsRoot.appendChild(buildRow(containerGroups[0]?.key || "", 1));
    updateRemoveButtons();
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

    row.remove();
    updateRemoveButtons();
  });

  updateRemoveButtons();
})();
