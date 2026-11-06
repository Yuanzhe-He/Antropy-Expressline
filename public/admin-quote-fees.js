(function () {
  'use strict';
  const editor = document.querySelector('[data-fee-editor]');
  const template = document.getElementById('quote-fee-row-template');
  if (!editor || !template) return;
  const isSpanish = document.documentElement.lang === 'es';
  const text = (zh, es) => isSpanish ? es : zh;
  const input = (row, field) => row.querySelector(`[name="fee_${field}[]"]`);
  const deletedRows = { fixed: [], contingent: [] };
  const rows = () => [...editor.querySelectorAll('.fee-list [data-fee-row]')];

  function defaultCurrency(category) {
    const select = [...editor.querySelectorAll('[data-currency-category]')].find((node) => node.dataset.currencyCategory === category);
    return ['USD', 'MXN'].includes(select?.value) ? select.value : category === 'SHIPPING LINE' ? 'USD' : 'MXN';
  }

  function updateSummary(row) {
    const name = input(row, isSpanish ? 'es' : 'zh').value.trim() || input(row, 'en').value.trim() || text('新费用', 'Nuevo cargo');
    const kind = input(row, 'chargeKind').value === 'contingent' ? text('发生才收', 'Si ocurre') : text('固定费用', 'Cargo fijo');
    const percentage = input(row, 'priceType').value === 'percentage';
    const price = percentage ? (input(row, 'percentageRate').value.trim() || '—') + '%' : input(row, 'price').value.trim() || '—';
    row.querySelector('[data-fee-percentage-field]').hidden = !percentage;
    row.querySelector('[data-fee-amount-field]').hidden = percentage;
    const conflict = percentage && (input(row, 'max').value.trim() !== '' || /^at\s*cost$/i.test(input(row, 'price').value.trim()));
    row.querySelector('[data-fee-max-field]').hidden = percentage && !conflict;
    row.querySelector('[data-fee-pricing-warning]').hidden = !conflict;
    const max = input(row, 'max').value.trim();
    const status = input(row, 'active').value === '1' ? text('启用', 'Activo') : text('停用', 'Inactivo');
    row.querySelector('[data-fee-summary-name]').textContent = name;
    row.querySelector('[data-fee-summary-meta]').textContent = `${kind} · ${price}${!percentage && max ? `–${max}` : ''} ${percentage ? '' : input(row, 'currency').value} · ${status}`;
  }

  function updateCounts() {
    for (const kind of ['fixed', 'contingent']) {
      const count = editor.querySelector(`[data-fee-list="${kind}"]`).querySelectorAll('[data-fee-row]').length;
      editor.querySelector(`[data-fee-count="${kind}"]`).textContent = count;
      editor.querySelector(`[data-fee-empty="${kind}"]`).hidden = count > 0;
      editor.querySelector(`[data-fee-undo="${kind}"]`).disabled = !deletedRows[kind].length || rows().length >= 100;
    }
    editor.querySelectorAll('[data-fee-add]').forEach((button) => { button.disabled = rows().length >= 100; });
  }

  editor.addEventListener('click', (event) => {
    const undo = event.target.closest('[data-fee-undo]');
    if (undo) {
      const entry = deletedRows[undo.dataset.feeUndo]?.pop();
      if (entry) { entry.anchor.replaceWith(entry.row); updateCounts(); entry.row.open = true; entry.row.querySelector('input:not([type="hidden"])')?.focus(); }
      return;
    }
    const add = event.target.closest('[data-fee-add]');
    if (add && rows().length < 100) {
      const row = template.content.firstElementChild.cloneNode(true);
      const kind = add.dataset.feeAdd;
      input(row, 'id').value = `fee-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      input(row, 'code').value = '';
      input(row, 'chargeKind').value = kind;
      input(row, 'currency').value = defaultCurrency(input(row, 'category').value);
      editor.querySelector(`[data-fee-list="${kind}"]`).appendChild(row);
      updateSummary(row);
      updateCounts();
      input(row, isSpanish ? 'en' : 'zh').focus();
      return;
    }
    const remove = event.target.closest('[data-fee-remove]');
    if (remove) {
      const row = remove.closest('[data-fee-row]');
      const group = row.closest('[data-fee-group]');
      const kind = input(row, 'chargeKind').value === 'contingent' ? 'contingent' : 'fixed';
      const anchor = document.createComment('deleted fee template'); row.before(anchor);
      deletedRows[kind].push({ row, anchor });
      row.remove();
      updateCounts();
      group.querySelector('[data-fee-add]').focus();
    }
  });

  editor.addEventListener('input', (event) => {
    const row = event.target.closest('[data-fee-row]');
    if (row) updateSummary(row);
  });
  editor.addEventListener('change', (event) => {
    const row = event.target.closest('[data-fee-row]');
    if (!row) return; // Editing a default does not overwrite existing fees.
    if (event.target.matches('[data-fee-mode]')) {
      input(row, 'modes').value = [...row.querySelectorAll('[data-fee-mode]:checked')].map((node) => node.dataset.feeMode).join(',');
    }
    if (event.target.name === 'fee_category[]') {
      input(row, 'currency').value = defaultCurrency(event.target.value);
    }
    if (event.target.name === 'fee_chargeKind[]') {
      const kind = event.target.value === 'contingent' ? 'contingent' : 'fixed';
      const group = editor.querySelector(`[data-fee-group="${kind}"]`);
      group.open = true;
      group.querySelector('[data-fee-list]').appendChild(row);
      row.open = true;
      event.target.focus();
      updateCounts();
    }
    updateSummary(row);
  });
  rows().forEach(updateSummary);
  updateCounts();
  const error = editor.querySelector('[data-fee-error]');
  if (error) error.focus();
})();
