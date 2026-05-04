(function calculatorRowsAndDependencies() {
  const rowsRoot = document.querySelector("[data-container-rows]");
  const addButton = document.querySelector("[data-add-row]");
  const groupDataNode = document.querySelector("#container-group-data");
  const i18nNode = document.querySelector("#calculator-i18n");

  if (!rowsRoot || !addButton || !groupDataNode || !i18nNode) {
    return;
  }

  function parseJson(node, fallback) {
    try {
      return JSON.parse(node?.textContent || "");
    } catch (_error) {
      return fallback;
    }
  }

  const i18n = parseJson(i18nNode, {});
  let activeContainerGroups = parseJson(groupDataNode, []);

  function safeGroups(groups) {
    return Array.isArray(groups) ? groups : [];
  }

  function groupExists(groupKey) {
    return activeContainerGroups.some((group) => group.key === groupKey);
  }

  function resolveGroupKey(preferredKey, fallbackIndex = 0) {
    if (preferredKey && groupExists(preferredKey)) {
      return preferredKey;
    }
    return (
      activeContainerGroups[fallbackIndex]?.key ||
      activeContainerGroups[0]?.key ||
      ""
    );
  }

  function appendOptions(select, selectedKey) {
    select.replaceChildren();

    if (!activeContainerGroups.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = rowsRoot.dataset.emptyLabel || "No container types";
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    const safeSelectedKey = resolveGroupKey(selectedKey);
    for (const group of activeContainerGroups) {
      const option = document.createElement("option");
      option.value = group.key;
      option.textContent = group.label;
      option.selected = group.key === safeSelectedKey;
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
    appendOptions(typeSelect, selectedKey || activeContainerGroups[0]?.key || "");
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
    addButton.disabled = !activeContainerGroups.length;
  }

  function keepViewportStable(callback) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    callback();
    requestAnimationFrame(() => {
      window.scrollTo({ left: scrollX, top: scrollY, behavior: "auto" });
    });
  }

  function updateContainerGroups(nextGroups) {
    activeContainerGroups = safeGroups(nextGroups);
    const rows = [...rowsRoot.querySelectorAll("[data-row]")];

    if (!rows.length) {
      rowsRoot.appendChild(buildRow(activeContainerGroups[0]?.key || "", 1));
    }

    [...rowsRoot.querySelectorAll("[data-row]")].forEach((row, index) => {
      const select = row.querySelector("select[name='containerGroupKey[]']");
      if (!select) {
        return;
      }
      appendOptions(select, resolveGroupKey(select.value, index));
    });

    updateRemoveButtons();
  }

  addButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (!activeContainerGroups.length) {
      return;
    }
    keepViewportStable(() => {
      rowsRoot.appendChild(buildRow(activeContainerGroups[0]?.key || "", 1));
    });
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

    event.preventDefault();
    keepViewportStable(() => {
      row.remove();
    });
    updateRemoveButtons();
  });

  function formatTaxRate(value) {
    const numeric = Number(value);
    return `${Math.round((Number.isFinite(numeric) ? numeric : 0) * 100)}%`;
  }

  function taxDefaultText(defaultLabel) {
    const template = i18n.taxDefaultRate || "Default: __RATE__";
    return template.replace("__RATE__", defaultLabel || "0%");
  }

  function taxRateLabel(value, defaultLabel) {
    if (!value || value === "default") {
      return defaultLabel || "0%";
    }
    return value === "0.16" ? "16%" : "0%";
  }

  function taxDefaultValue(defaultLabel) {
    return Number.parseFloat(defaultLabel || "0") >= 16 ? "0.16" : "0";
  }

  function normalizeTaxOverride(value, defaultValue) {
    const safeValue = String(value || "default");
    if (safeValue === defaultValue) {
      return "default";
    }
    return safeValue === "0" || safeValue === "0.16" ? safeValue : "default";
  }

  function taxToggleText(templateKey, rate) {
    const template = i18n[templateKey] || "__RATE__";
    return template.replace("__RATE__", rate);
  }

  function updateTaxToggleButton(button) {
    const row = button.closest(".tax-control");
    const select = row?.querySelector("select[name='taxOverrideRate[]']");
    if (!select) {
      return;
    }

    const defaultValue = select.dataset.taxDefaultValue || taxDefaultValue(select.dataset.taxDefaultLabel);
    const defaultLabel = select.dataset.taxDefaultLabel || taxRateLabel(defaultValue, "0%");
    const oppositeValue = select.dataset.taxOppositeValue || (defaultValue === "0.16" ? "0" : "0.16");
    const normalizedValue = normalizeTaxOverride(select.value, defaultValue);
    select.value = normalizedValue;

    const effectiveValue = normalizedValue === "default" ? defaultValue : normalizedValue;
    const targetValue = normalizedValue === "default" ? oppositeValue : "default";
    const currentLabel = taxRateLabel(effectiveValue, defaultLabel);
    const targetLabel = taxRateLabel(targetValue, defaultLabel);

    button.classList.toggle("is-overridden", normalizedValue !== "default");
    button.replaceChildren();

    const currentNode = document.createElement("span");
    currentNode.textContent = taxToggleText("taxToggleCurrent", currentLabel);
    const targetNode = document.createElement("small");
    targetNode.textContent = taxToggleText("taxToggleToRate", targetLabel);
    button.append(currentNode, targetNode);
  }

  function setupTaxToggleButtons(root = document) {
    root.querySelectorAll("[data-tax-toggle]").forEach((button) => {
      updateTaxToggleButton(button);
    });
  }

  function readTaxOverrides() {
    const overrides = {};
    document.querySelectorAll("[data-tax-controls] .tax-control").forEach((row) => {
      const key = row.querySelector("input[name='taxOverrideKey[]']")?.value;
      const value = row.querySelector("select[name='taxOverrideRate[]']")?.value;
      if (key) {
        overrides[key] = value || "default";
      }
    });
    return overrides;
  }

  function renderTaxControls(controls, options) {
    const root = document.querySelector("[data-tax-controls]");
    const card = document.querySelector("[data-tax-overrides-card]");
    if (!root || !card) {
      return;
    }

    const safeControls = Array.isArray(controls) ? controls : [];
    const safeOptions = Array.isArray(options) ? options : [];
    const selectedOverrides = readTaxOverrides();

    card.hidden = !safeControls.length;
    root.replaceChildren();

    for (const control of safeControls) {
      const label = document.createElement("div");
      label.className = "tax-control";

      const keyInput = document.createElement("input");
      keyInput.type = "hidden";
      keyInput.name = "taxOverrideKey[]";
      keyInput.value = control.key || "";

      const title = document.createElement("span");
      title.textContent = control.label || "";

      const defaultText = document.createElement("small");
      defaultText.textContent = taxDefaultText(control.defaultLabel);

      const select = document.createElement("select");
      select.className = "tax-override-select";
      select.name = "taxOverrideRate[]";
      const defaultValue = taxDefaultValue(control.defaultLabel);
      const oppositeValue = defaultValue === "0.16" ? "0" : "0.16";
      select.dataset.taxDefaultValue = defaultValue;
      select.dataset.taxDefaultLabel = control.defaultLabel || "0%";
      select.dataset.taxOppositeValue = oppositeValue;
      select.dataset.taxOppositeLabel = taxRateLabel(oppositeValue, control.defaultLabel);
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
      const selectedValue = normalizeTaxOverride(
        selectedOverrides[control.key],
        defaultValue
      );
      for (const optionData of safeOptions) {
        const option = document.createElement("option");
        option.value = optionData.value;
        option.textContent = optionData.label;
        option.selected = String(optionData.value) === selectedValue;
        select.appendChild(option);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "tax-toggle-button";
      button.dataset.taxToggle = "";

      label.append(keyInput, title, defaultText, select, button);
      updateTaxToggleButton(button);
      root.appendChild(label);
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tax-toggle]");
    if (!button) {
      return;
    }

    const row = button.closest(".tax-control");
    const select = row?.querySelector("select[name='taxOverrideRate[]']");
    if (!select) {
      return;
    }

    const defaultValue = select.dataset.taxDefaultValue || taxDefaultValue(select.dataset.taxDefaultLabel);
    const normalizedValue = normalizeTaxOverride(select.value, defaultValue);
    select.value = normalizedValue === "default"
      ? select.dataset.taxOppositeValue || (defaultValue === "0.16" ? "0" : "0.16")
      : "default";
    updateTaxToggleButton(button);
  });

  function setText(selector, value) {
    const node = document.querySelector(selector);
    if (node) {
      node.textContent = value || "";
    }
  }

  function setupHandoverDependencies() {
    const node = document.querySelector("#handover-line-data");
    const select = document.querySelector("[data-handover-line-select]");
    if (!node || !select) {
      return;
    }

    const data = parseJson(node, {});
    const lines = Array.isArray(data.lines) ? data.lines : [];

    function findLine(lineId) {
      return lines.find((line) => line.id === lineId) || lines[0] || null;
    }

    function applyLine(line) {
      if (!line) {
        return;
      }

      setText("[data-handover-line-name]", line.name);
      setText("[data-handover-line-invoice]", line.invoiceLabel);
      setText("[data-handover-line-cutoff]", line.cutoffLabel);
      setText("[data-handover-line-guarantee]", line.guaranteeLabel);

      const notice = document.querySelector("[data-handover-line-notice]");
      const noticeText = document.querySelector("[data-handover-line-notice-text]");
      if (notice && noticeText) {
        noticeText.textContent = line.invoiceNote || "";
        notice.hidden = !line.invoiceNote;
      }

      keepViewportStable(() => {
        updateContainerGroups(line.containerGroups || []);
        renderTaxControls(line.taxControls || [], data.taxOverrideOptions || []);
      });
    }

    select.addEventListener("change", () => {
      applyLine(findLine(select.value));
    });
  }

  function setupCustomsDependencies() {
    const node = document.querySelector("#customs-dependency-data");
    const shippingLineSelect = document.querySelector(
      "[data-customs-shipping-line-select]"
    );
    const portSelect = document.querySelector("[data-customs-port-select]");
    const terminalSelect = document.querySelector("[data-customs-terminal-select]");
    const yardSelect = document.querySelector("[data-customs-yard-select]");
    const emptyYardsHint = document.querySelector("[data-customs-yard-empty]");

    if (!node || !shippingLineSelect || !portSelect || !terminalSelect || !yardSelect) {
      return;
    }

    const data = parseJson(node, {});
    const ports = Array.isArray(data.ports) ? data.ports : [];
    const yards = Array.isArray(data.yards) ? data.yards : [];
    const labels = data.labels || {};

    function findPort(portId) {
      return ports.find((entry) => entry.id === portId) || ports[0] || null;
    }

    function findTerminal(port, terminalId) {
      return (
        port?.terminals?.find((entry) => entry.id === terminalId) ||
        port?.terminals?.[0] ||
        null
      );
    }

    function getSelectedShippingLineName() {
      return (
        shippingLineSelect.selectedOptions?.[0]?.textContent?.trim() ||
        labels.notConfigured ||
        ""
      );
    }

    function getAvailableYards(portId, shippingLineId) {
      return yards.filter(
        (yard) =>
          (!portId || yard.portIds?.includes(portId)) &&
          (!shippingLineId || yard.shippingLineIds?.includes(shippingLineId))
      );
    }

    function renderSelectOptions(select, options, selectedId) {
      select.replaceChildren();
      for (const entry of options) {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = entry.name;
        option.selected = entry.id === selectedId;
        select.appendChild(option);
      }
      select.disabled = !options.length;
    }

    function buildCustomsTaxControls(terminal, yard) {
      const controls = [];

      for (const charge of terminal?.fixedCharges || []) {
        controls.push({
          key: `customs:fixed:${charge.id}`,
          label: `${labels.terminalFixed || ""} · ${charge.concept}`,
          defaultLabel: formatTaxRate(charge.taxRate),
        });
      }

      controls.push({
        key: "customs:storage",
        label: labels.terminalStorage || "",
        defaultLabel: formatTaxRate(terminal?.storageTaxRate || 0),
      });

      for (const charge of yard?.dropoffCharges || []) {
        controls.push({
          key: `customs:dropoff:${charge.id}`,
          label: `${labels.yardDropoff || ""} · ${charge.concept}`,
          defaultLabel: formatTaxRate(charge.taxRate),
        });
      }

      for (const charge of yard?.customsCharges || []) {
        controls.push({
          key: `customs:yard:${charge.id}`,
          label: `${labels.yardCustoms || ""} · ${charge.concept}`,
          defaultLabel: formatTaxRate(charge.taxRate),
        });
      }

      return controls;
    }

    function syncCustomsDependencies() {
      const port = findPort(portSelect.value);
      const terminal = findTerminal(port, terminalSelect.value);
      const availableYards = getAvailableYards(port?.id, shippingLineSelect.value);
      const yard =
        availableYards.find((entry) => entry.id === yardSelect.value) ||
        availableYards[0] ||
        null;

      renderSelectOptions(
        terminalSelect,
        port?.terminals || [],
        terminal?.id || ""
      );
      renderSelectOptions(yardSelect, availableYards, yard?.id || "");

      if (emptyYardsHint) {
        emptyYardsHint.hidden = Boolean(availableYards.length);
        emptyYardsHint.textContent = labels.noYardsAvailable || emptyYardsHint.textContent;
      }

      setText("[data-customs-current-port]", port?.name || labels.notConfigured);
      setText("[data-customs-meta-port]", port?.name || labels.notConfigured);
      setText("[data-customs-meta-terminal]", terminal?.name || labels.notConfigured);
      setText("[data-customs-meta-shipping-line]", getSelectedShippingLineName());
      setText("[data-customs-meta-yard]", yard?.name || labels.notConfigured);

      renderTaxControls(
        buildCustomsTaxControls(terminal, yard),
        data.taxOverrideOptions || []
      );
    }

    [shippingLineSelect, portSelect, terminalSelect, yardSelect].forEach((select) => {
      select.addEventListener("change", () => {
        keepViewportStable(syncCustomsDependencies);
      });
    });
  }

  updateContainerGroups(activeContainerGroups);
  setupHandoverDependencies();
  setupCustomsDependencies();
  setupTaxToggleButtons();
})();
