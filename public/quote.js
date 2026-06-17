(function quoteBuilder() {
  const form = document.querySelector("[data-quote-form]");
  if (!form) {
    return;
  }

  const readJson = (id, fallback) => {
    const el = document.getElementById(id);
    if (!el) return fallback;
    try {
      return JSON.parse(el.textContent);
    } catch (_error) {
      return fallback;
    }
  };

  const selectorData = readJson("quote-selector-data", { ports: [], shippingLines: [], destinations: [], containerTypes: [] });
  const feeCodes = readJson("quote-fee-codes", []);
  const initial = readJson("quote-initial", {});
  // Q8/Q10: fee codes carry en/zh/es names; keep the whole row so the concept can
  // be filled per language when the code changes.
  const feeByCode = new Map(feeCodes.map((fc) => [fc.code, fc]));

  const CATEGORIES = ["SHIPPING LINE", "PORT FEES", "CUSTOMS CLEARANCE", "TRANSPORTATION", "DUTY"];

  function fmtMoney(value) {
    return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function parseNum(value) {
    const n = parseFloat(String(value || "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  // --- Port -> terminal dependent select ---
  const portSelect = form.querySelector("[data-quote-port]");
  const terminalSelect = form.querySelector("[data-quote-terminal]");
  function fillTerminals(portId, selectedTerminalId) {
    if (!terminalSelect) return;
    const port = selectorData.ports.find((p) => p.id === portId);
    terminalSelect.innerHTML = '<option value="">—</option>';
    if (!port) return;
    for (const terminal of port.terminals || []) {
      const opt = document.createElement("option");
      opt.value = terminal.id;
      opt.textContent = terminal.name;
      if (terminal.id === selectedTerminalId) opt.selected = true;
      terminalSelect.appendChild(opt);
    }
  }
  if (portSelect) {
    portSelect.addEventListener("change", () => fillTerminals(portSelect.value, ""));
    fillTerminals(initial.selectedPortId || portSelect.value, initial.selectedTerminalId || "");
  }

  // --- Row helpers ---
  function rowEls(row) {
    return {
      unit: row.querySelector("[data-quote-unit]"),
      price: row.querySelector("[data-quote-price]"),
      currency: row.querySelector("[data-quote-currency]"),
      total: row.querySelector("[data-quote-rowtotal]"),
      atCostHidden: row.querySelector("[data-quote-atcost]"),
      atCostToggle: row.querySelector("[data-quote-atcost-toggle]"),
      code: row.querySelector("[data-quote-code]"),
    };
  }

  function recomputeRow(row) {
    const els = rowEls(row);
    const atCost = els.atCostHidden && els.atCostHidden.value === "1";
    if (atCost) {
      els.total.textContent = "AT COST";
      els.total.classList.add("quote-atcost");
      return { atCost: true };
    }
    els.total.classList.remove("quote-atcost");
    const unit = els.unit && els.unit.value !== "" ? parseNum(els.unit.value) : null;
    const price = parseNum(els.price ? els.price.value : 0);
    if (unit === null) {
      els.total.textContent = "AT COST";
      return { atCost: true };
    }
    const total = Math.round(unit * price * 100) / 100;
    els.total.textContent = fmtMoney(total);
    return { atCost: false, total, currency: els.currency ? els.currency.value : "" };
  }

  function recomputeAll() {
    const subtotals = {};
    form.querySelectorAll("[data-quote-row]").forEach((row) => {
      const result = recomputeRow(row);
      if (!result.atCost && result.currency) {
        subtotals[result.currency] = (subtotals[result.currency] || 0) + result.total;
      }
    });
    const mxn = form.querySelector("[data-quote-subtotal-mxn]");
    const usd = form.querySelector("[data-quote-subtotal-usd]");
    if (mxn) mxn.textContent = fmtMoney(subtotals.MXN || 0);
    if (usd) usd.textContent = fmtMoney(subtotals.USD || 0);
  }

  function wireAtCostToggle(row) {
    const els = rowEls(row);
    if (!els.atCostToggle) return;
    els.atCostToggle.addEventListener("change", () => {
      els.atCostHidden.value = els.atCostToggle.checked ? "1" : "0";
      if (els.price) els.price.disabled = els.atCostToggle.checked;
      recomputeAll();
    });
  }

  // Q10: when the code changes, ALWAYS set the concept from the fee dictionary
  // (EN + ZH), not only when empty. ZH falls back to EN when no translation yet.
  function wireCodeAutofill(row) {
    const els = rowEls(row);
    if (!els.code) return;
    els.code.addEventListener("change", () => {
      const fee = feeByCode.get(els.code.value.trim());
      if (!fee) return;
      const en = row.querySelector('input[name="li_conceptEn[]"]');
      const zh = row.querySelector('input[name="li_conceptZh[]"]');
      if (en) en.value = fee.en || fee.description || "";
      if (zh) zh.value = fee.zh || fee.en || fee.description || "";
    });
  }

  function wireRow(row) {
    wireAtCostToggle(row);
    wireCodeAutofill(row);
    row.querySelectorAll("[data-quote-unit], [data-quote-price], [data-quote-currency]").forEach((input) => {
      input.addEventListener("input", recomputeAll);
      input.addEventListener("change", recomputeAll);
    });
    const remove = row.querySelector("[data-quote-remove]");
    if (remove) {
      remove.addEventListener("click", () => {
        row.remove();
        recomputeAll();
      });
    }
  }

  // --- Add row ---
  function buildRow() {
    const tr = document.createElement("tr");
    tr.setAttribute("data-quote-row", "");
    const catOptions = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
    const id = "li-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    tr.innerHTML =
      '<td><select name="li_category[]">' + catOptions + "</select></td>" +
      '<td class="concept-cell"><input type="text" name="li_conceptEn[]" placeholder="EN" /><input type="text" name="li_conceptZh[]" placeholder="中" lang="zh" /></td>' +
      '<td><input type="text" name="li_code[]" list="fee-codes" data-quote-code /></td>' +
      '<td><input type="number" min="0" step="1" name="li_unit[]" value="1" data-quote-unit /></td>' +
      '<td><input type="number" min="0" step="0.01" name="li_unitPrice[]" value="0" data-quote-price /></td>' +
      '<td><select name="li_currency[]" data-quote-currency><option value="">—</option><option value="MXN" selected>MXN</option><option value="USD">USD</option></select></td>' +
      '<td class="quote-total-cell" data-quote-rowtotal>0.00</td>' +
      '<td><input type="text" name="li_remark[]" /></td>' +
      '<td><label class="quote-source-pill"><input type="checkbox" data-quote-atcost-toggle /> AT COST</label>' +
      '<input type="hidden" name="li_atCost[]" value="0" data-quote-atcost />' +
      '<input type="hidden" name="li_id[]" value="' + id + '" />' +
      '<input type="hidden" name="li_source[]" value="manual" />' +
      '<input type="hidden" name="li_calcModule[]" value="" />' +
      '<input type="hidden" name="li_calcField[]" value="" /></td>' +
      '<td><button type="button" class="ghost-button compact-button quote-row-remove" data-quote-remove aria-label="remove">✕</button></td>';
    return tr;
  }

  const addBtn = form.querySelector("[data-quote-add]");
  const tbody = form.querySelector("[data-quote-rows]");
  if (addBtn && tbody) {
    addBtn.addEventListener("click", () => {
      const row = buildRow();
      tbody.appendChild(row);
      wireRow(row);
      recomputeAll();
    });
  }

  form.querySelectorAll("[data-quote-row]").forEach(wireRow);
  recomputeAll();
})();
