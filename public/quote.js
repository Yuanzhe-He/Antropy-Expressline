(function quoteBuilder() {
  const form = document.querySelector('[data-quote-form]');
  if (!form) return;
  const readJson = (id, fallback) => {
    try { return JSON.parse(document.getElementById(id)?.textContent || 'null') ?? fallback; }
    catch (_) { return fallback; }
  };
  const labels = readJson('quote-ui-labels', {});
  const settings = readJson('quote-fee-settings', { currencyDefaults: {}, templates: [] });
  const cargoStateData = readJson('quote-cargo-state-data', { states: {}, rules: {} });
  const cargoStates = { ...(cargoStateData.states || {}) };
  const cargoTypes = ['FCL', 'LCL', 'BBK', 'AIR'];
  const feeByCode = new Map(readJson('quote-fee-codes', []).map((fee) => [fee.code, fee]));
  const modeSelect = form.querySelector('[data-quote-mode]');
  const cargoSelect = form.querySelector('[data-cargo-type]');
  const pricingResult = form.querySelector('[data-cargo-result]');
  const byName = (parent, name) => parent.querySelector(`[name="${name}"]`);
  const val = (parent, name) => byName(parent, name)?.value ?? '';
  const number = (value) => {
    if (value == null || String(value).trim() === '') return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  };
  const roundMoney = (value) => { const cents = value * 100; return Math.round(cents + Number.EPSILON * Math.max(1, Math.abs(cents))) / 100; };
  const fmtMoney = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
  const currencyDefault = (category) => settings.currencyDefaults?.[category] || (category === 'SHIPPING LINE' ? 'USD' : 'MXN');
  let cargoCalculation = null;
  let initialSubtotalBasis = null;
  const removedTemplateIds = new Set();
  let activeCargoType = cargoSelect?.value || '';

  function collectCargoPricing(type = activeCargoType) {
    return {
      containers: type === 'FCL' ? [...form.querySelectorAll('[data-cargo-container-row]')].map((row) => ({
        containerType: val(row, 'cargo_containerType[]'), quantity: val(row, 'cargo_containerQuantity[]'),
        unitPrice: val(row, 'cargo_containerPrice[]'), currency: val(row, 'cargo_containerCurrency[]'),
      })) : [],
      packages: type !== 'FCL' ? [...form.querySelectorAll('[data-cargo-package-row]')].map((row) => ({
        lengthCm: val(row, 'cargo_lengthCm[]'), widthCm: val(row, 'cargo_widthCm[]'), heightCm: val(row, 'cargo_heightCm[]'),
        packageCount: val(row, 'cargo_packageCount[]'), weightKg: val(row, 'cargo_weightKg[]'), weightCount: val(row, 'cargo_weightCount[]'),
      })) : [],
      unitPrice: type === 'FCL' ? '' : val(form, 'cargo_unitPrice'),
      currency: type === 'FCL' ? '' : val(form, 'cargo_currency'),
      method: type === 'FCL' ? 'raw_max' : val(form, 'cargo_method'),
      manualChargeable: type === 'FCL' ? '' : val(form, 'cargo_manualChargeable'),
      volumeDivisor: type === 'FCL' ? '' : val(form, 'cargo_volumeDivisor'),
      ...(Array.isArray(cargoStates[type]?.validationErrors) ? { validationErrors: [...cargoStates[type].validationErrors] } : {}),
    };
  }

  function saveCargoState() {
    if (cargoTypes.includes(activeCargoType)) cargoStates[activeCargoType] = collectCargoPricing(activeCargoType);
    // These type markers describe current local errors. Rebuild them instead
    // of propagating an old context error into otherwise valid modalities.
    const cacheErrors = (Array.isArray(cargoStates._validationErrors) ? cargoStates._validationErrors : []).filter((error) => !/^cargoPricingByType:(FCL|LCL|BBK|AIR):invalid_state$/.test(error));
    for (const type of cargoTypes) {
      const state = cargoStates[type];
      if (!Array.isArray(state?.validationErrors)) continue;
      state.validationErrors = state.validationErrors.filter((error) => !error.startsWith('cargoPricingByType:'));
      if (state.validationErrors.some((error) => error.startsWith('pricing:') || /:(?:invalid_rows|too_many_rows|invalid_row)$/.test(error))) cacheErrors.push(`cargoPricingByType:${type}:invalid_state`);
    }
    if (cacheErrors.length || cargoStates._validationErrors) cargoStates._validationErrors = [...new Set(cacheErrors)];
    const field = byName(form, 'cargoPricingByType');
    if (field) field.value = JSON.stringify(cargoStates);
  }

  function newCargoState(type) {
    const rule = cargoStateData.rules?.[type] || {};
    return { containers: [{ currency: currencyDefault('TRANSPORTATION') }], packages: [{}],
      unitPrice: '', currency: currencyDefault('TRANSPORTATION'), method: rule.method || (type === 'AIR' ? 'manual' : 'raw_max'),
      volumeDivisor: rule.volumeDivisor ?? '', manualChargeable: '' };
  }

  function clearCargoFieldErrors(input) {
    const state = cargoStates[activeCargoType];
    if (!Array.isArray(state?.validationErrors) || !input?.name) return;
    let field = input.name.replace(/^cargo_/, '').replace(/\[\]$/, '');
    const container = input.closest('[data-cargo-container-row]');
    const pkg = input.closest('[data-cargo-package-row]');
    if (container) {
      field = { containerType: 'containerType', containerQuantity: 'quantity', containerPrice: 'unitPrice', containerCurrency: 'currency' }[field];
      const index = [...container.parentNode.querySelectorAll('[data-cargo-container-row]')].indexOf(container);
      field = `containers.${index}.${field}`;
    } else if (pkg) {
      const index = [...pkg.parentNode.querySelectorAll('[data-cargo-package-row]')].indexOf(pkg);
      field = `packages.${index}.${field}`;
    }
    state.validationErrors = state.validationErrors.filter((error) => !error.startsWith(field + ':'));
  }

  function clearCargoRowErrors(kind, index, removed) {
    const state = cargoStates[activeCargoType];
    if (!Array.isArray(state?.validationErrors)) return;
    const prefix = kind === 'container' ? 'containers' : 'packages';
    state.validationErrors = state.validationErrors.flatMap((error) => {
      const match = error.match(/^(containers|packages)\.(\d+)([.:].*)$/);
      if (!match || match[1] !== prefix) return [error];
      const rowIndex = Number(match[2]);
      if (rowIndex === index) return [];
      return [removed && rowIndex > index ? `${prefix}.${rowIndex - 1}${match[3]}` : error];
    });
  }

  function appendResult(label, amount, suffix = '') {
    const item = document.createElement('span');
    item.append(document.createTextNode(label + ': '));
    const value = document.createElement('strong');
    value.textContent = amount + (suffix ? ' ' + suffix : '');
    item.append(value);
    pricingResult.append(item);
  }

  function recomputeCargo() {
    const cargoType = cargoSelect?.value || '';
    const method = val(form, 'cargo_method');
    saveCargoState();
    const pricing = collectCargoPricing();
    const cacheErrors = Array.isArray(cargoStates._validationErrors) ? cargoStates._validationErrors : [];
    // Map-level failures block the preview, but are not copied into individual
    // states: correcting one broken modality must not corrupt another one.
    const calculationPricing = cacheErrors.length ? { ...pricing, validationErrors: [...new Set([...(pricing.validationErrors || []), ...cacheErrors])] } : pricing;
    const attempted = window.QuotePricing?.cargoPricingAttempted
      ? window.QuotePricing.cargoPricingAttempted(cargoType, calculationPricing)
      : (cargoType === 'FCL' ? pricing.containers.some((row) => String(row.unitPrice).trim() !== '') : String(pricing.unitPrice).trim() !== '');
    const title = form.querySelector('[data-cargo-package-title]');
    if (title) title.textContent = labels.cargoTitles?.[cargoType] || cargoType;
    const typeHint = form.querySelector('[data-cargo-type-hint]');
    if (typeHint) typeHint.textContent = labels.cargoTypeHints?.[cargoType] || '';
    const methodHint = form.querySelector('[data-cargo-method-hint]');
    if (methodHint) methodHint.textContent = labels.cargoMethodHints?.[method] || '';
    form.querySelectorAll('[data-cargo-method-field]').forEach((field) => { field.hidden = field.dataset.cargoMethodField !== method; });
    form.querySelectorAll('[data-cargo-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.cargoPanel === 'FCL' ? cargoType !== 'FCL' : !['LCL', 'BBK', 'AIR'].includes(cargoType);
      // The JSON field preserves inactive modes. Only the active legacy inputs
      // submit, so hidden invalid numbers cannot block a different workflow.
      panel.querySelectorAll('input,select').forEach((input) => { input.disabled = panel.hidden; });
      panel.querySelectorAll('input[type="number"]').forEach((input) => {
        for (const attribute of ['min', 'step']) {
          const savedKey = attribute === 'min' ? 'cargoMin' : 'cargoStep';
          if (input.dataset[savedKey] == null) input.dataset[savedKey] = input.getAttribute(attribute) || '';
          if (panel.hidden || !attempted || input.closest('[data-cargo-method-field][hidden]') || (method === 'manual' && input.closest('[data-cargo-package-row]'))) {
            if (attribute === 'step') input.setAttribute('step', 'any');
            else input.removeAttribute(attribute);
          }
          else if (input.dataset[savedKey]) input.setAttribute(attribute, input.dataset[savedKey]);
        }
      });
    });
    const savedErrors = cargoStates[cargoType]?.validationErrors || [];
    const typeCacheError = cacheErrors.includes(`cargoPricingByType:${cargoType}:invalid_state`);
    const globalCacheError = cacheErrors.some((error) => error !== `cargoPricingByType:${cargoType}:invalid_state`);
    const recovery = form.querySelector('[data-cargo-recovery]');
    if (recovery) {
      recovery.hidden = !savedErrors.length && !typeCacheError && !globalCacheError;
      const structural = savedErrors.some((error) => /:(?:invalid_rows|too_many_rows|invalid_row|invalid_object)$/.test(error));
      recovery.querySelector('[data-cargo-recovery-message]').textContent = globalCacheError ? labels.cargoInvalidCache : (structural || typeCacheError ? labels.cargoInvalidRows : labels.cargoInvalidSaved);
      if (!globalCacheError && !structural && !typeCacheError) {
        const fields = [...new Set(savedErrors.map((error) => {
          const path = error.split(':')[0];
          const rowField = path.match(/^(containers|packages)\.(\d+)\.(\w+)$/);
          if (rowField && labels.cargoFieldNames?.[rowField[3]]) return `${rowField[1] === 'containers' ? labels.cargoContainerRow : labels.cargoPackageRow} ${Number(rowField[2]) + 1} · ${labels.cargoFieldNames[rowField[3]]}`;
          return labels.cargoFieldNames?.[path] || '';
        }).filter(Boolean))];
        if (fields.length) recovery.querySelector('[data-cargo-recovery-message]').append(document.createTextNode(` ${labels.cargoCheckFields}: ${fields.slice(0, 6).join('、')}${fields.length > 6 ? '…' : ''}`));
      }
      recovery.querySelector('[data-cargo-reset]').hidden = globalCacheError;
      recovery.querySelector('[data-cargo-reset-all]').hidden = !globalCacheError;
    }
    if (!pricingResult) return;
    pricingResult.replaceChildren();
    pricingResult.hidden = !cargoType;
    cargoCalculation = null;
    if (!cargoType || !window.QuotePricing) return;
    cargoCalculation = window.QuotePricing.calculateCargoPricing(cargoType, calculationPricing);
    pricingResult.dataset.valid = String(cargoCalculation.valid);
    if (['LCL', 'BBK', 'AIR'].includes(cargoType)) {
      if (cargoCalculation.totalWeightKg != null) appendResult(labels.weight, fmtQty(cargoCalculation.totalWeightKg), 'kg');
      if (cargoCalculation.totalVolumeCm3 != null) appendResult(labels.volume, fmtQty(cargoCalculation.totalVolumeCm3), 'cm³');
      if (cargoCalculation.chargeableValue != null) appendResult(labels.chargeable, fmtQty(cargoCalculation.chargeableValue));
    }
    form.querySelectorAll('[data-cargo-container-row]').forEach((row) => {
      const qty = number(val(row, 'cargo_containerQuantity[]'));
      const price = number(val(row, 'cargo_containerPrice[]'));
      const cell = row.querySelector('[data-cargo-container-total]');
      const complete = val(row, 'cargo_containerType[]').trim() && qty > 0 && Number.isInteger(qty) && price != null && price >= 0 && val(row, 'cargo_containerCurrency[]');
      if (cell) cell.textContent = complete ? fmtMoney(roundMoney(qty * price)) : '—';
    });
    if (cargoCalculation.valid) {
      (cargoCalculation.subtotals || []).forEach((subtotal) => appendResult(labels.pricingTotal, fmtMoney(subtotal.amount), subtotal.currency));
    }
    const hint = document.createElement('p');
    hint.className = 'quote-hint';
    const hasAmounts = cargoCalculation.valid && (cargoCalculation.subtotals || []).length > 0;
    hint.textContent = hasAmounts ? labels.cargoIncluded : (!attempted ? labels.emptyCargo : labels.pending);
    pricingResult.append(hint);
  }

  function applicability(row) {
    const modes = val(row, 'li_appliesTo[]').split(',').map((c) => c.trim()).filter(Boolean);
    const activeCargo = cargoSelect?.value || '';
    const geo = val(row, 'li_section[]') !== 'foreign' || modeSelect?.value === 'ocean_mexico';
    const historical = activeCargo && activeCargo === cargoStateData.historicalCargoType && !cargoTypes.includes(activeCargo);
    return geo && (historical || !activeCargo || !modes.length || modes.includes(activeCargo));
  }

  function recomputeRow(row) {
    const cell = row.querySelector('[data-quote-rowtotal]');
    row.hidden = !applicability(row);
    const atCost = val(row, 'li_atCost[]') === '1';
    const included = val(row, 'li_included[]') !== '0';
    const contingent = val(row, 'li_chargeKind[]') === 'contingent';
    row.classList.toggle('quote-row-excluded', !contingent && !included);
    cell.classList.toggle('quote-atcost', atCost);
    const priceInput = row.querySelector('[data-quote-price]');
    if (priceInput) priceInput.readOnly = atCost;
    if (atCost) {
      const rangeLabel = row.querySelector('[data-quote-range-label]');
      if (rangeLabel) rangeLabel.hidden = true;
      cell.textContent = 'AT COST'; return null;
    }
    const quantity = number(val(row, 'li_unit[]'));
    const price = number(val(row, 'li_unitPrice[]'));
    const upper = number(val(row, 'li_unitPriceMax[]'));
    const rangeLabel = row.querySelector('[data-quote-range-label]');
    if (rangeLabel) { rangeLabel.hidden = upper == null || upper <= price; rangeLabel.textContent = upper != null ? '– ' + fmtMoney(upper) : ''; }
    if (quantity == null || price == null || quantity < 0 || price < 0) {
      cell.textContent = '—';
      return null;
    }
    const total = roundMoney(quantity * price);
    const isRange = upper != null && upper > price;
    cell.textContent = fmtMoney(total) + (isRange ? ' – ' + fmtMoney(roundMoney(quantity * upper)) : '');
    if (contingent || !included || row.hidden || isRange) return null;
    return { total, currency: val(row, 'li_currency[]') };
  }

  function recomputeAll() {
    recomputeCargo();
    const subtotals = {};
    form.querySelectorAll('[data-quote-row]').forEach((row) => {
      const amount = recomputeRow(row);
      if (amount?.currency) subtotals[amount.currency] = roundMoney((subtotals[amount.currency] || 0) + amount.total);
    });
    if (cargoCalculation?.valid) {
      (cargoCalculation.subtotals || []).forEach(({ currency, amount }) => {
        subtotals[currency] = roundMoney((subtotals[currency] || 0) + amount);
      });
    }
    const subtotalBasis = JSON.stringify(['MXN', 'USD'].map((currency) => Math.round((subtotals[currency] || 0) * 100)));
    if (initialSubtotalBasis === null) initialSubtotalBasis = subtotalBasis;
    const indicative = form.querySelector('[data-quote-indicative]');
    // This conversion is server-rendered. Do not show an old FX total after
    // local edits change its underlying amounts.
    if (indicative) indicative.hidden = subtotalBasis !== initialSubtotalBasis;
    refreshTemplateChoices();
    ['MXN', 'USD'].forEach((currency) => {
      const el = form.querySelector(`[data-quote-subtotal-${currency.toLowerCase()}]`);
      if (el) el.textContent = fmtMoney(subtotals[currency] || 0);
    });
  }

  function autofillCode(row) {
    const fee = feeByCode.get(val(row, 'li_code[]').trim());
    if (!fee) return;
    for (const suffix of ['En', 'Zh', 'Es']) {
      const field = byName(row, `li_concept${suffix}[]`);
      if (field) field.value = fee[suffix.toLowerCase()] || fee.en || fee.description || '';
    }
  }

  function wireRow(row) {
    row.addEventListener('input', recomputeAll);
    row.addEventListener('change', (event) => {
      if (event.target.matches('[data-quote-atcost-toggle]')) byName(row, 'li_atCost[]').value = event.target.checked ? '1' : '0';
      if (event.target.matches('[data-quote-included-toggle]')) byName(row, 'li_included[]').value = event.target.checked ? '1' : '0';
      if (event.target.name === 'li_category[]') byName(row, 'li_currency[]').value = currencyDefault(event.target.value);
      if (event.target.matches('[data-quote-code]')) autofillCode(row);
      recomputeAll();
    });
    row.querySelector('[data-quote-remove]')?.addEventListener('click', () => {
      const id = val(row, 'li_id[]');
      if (id) removedTemplateIds.add(id);
      row.remove(); recomputeAll();
    });
  }

  function buildRow(kind, data = {}) {
    const source = document.querySelector('#quote-row-template')?.content.querySelector('[data-quote-row]');
    if (!source) return null;
    const row = source.cloneNode(true);
    const fields = {
      section: data.section || 'mexico', category: data.category || 'SHIPPING LINE',
      conceptEn: data.conceptEn || '', conceptZh: data.conceptZh || '', conceptEs: data.conceptEs || '', code: data.code || '',
      unit: data.defaultQuantity ?? data.unit ?? '', uom: data.unitOfMeasure || data.uom || '', unitPrice: data.unitPrice ?? '', unitPriceMax: data.unitPriceMax ?? '',
      currency: data.currency || currencyDefault(data.category || 'SHIPPING LINE'), remark: data.remark || '', atCost: data.isAtCost ? '1' : '0',
      id: data.id || ('li-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)), source: data.source || 'manual',
      chargeKind: kind, appliesTo: Array.isArray(data.appliesTo) ? data.appliesTo.join(',') : (data.appliesTo || ''),
      included: kind !== 'contingent' && data.included !== false && !(data.included == null && data.selectionRequired) ? '1' : '0',
    };
    Object.entries(fields).forEach(([key, value]) => { const field = byName(row, `li_${key}[]`); if (field) field.value = String(value); });
    row.dataset.chargeKind = kind;
    row.querySelector('[data-quote-atcost-toggle]').checked = fields.atCost === '1';
    const inclusion = row.querySelector('[data-quote-included-toggle]');
    if (kind === 'contingent') inclusion?.closest('label').remove();
    else if (inclusion) inclusion.checked = fields.included === '1';
    return row;
  }

  function templateApplies(template, kind, existingIds) {
    if (template.enabled !== true || !template.id || existingIds.has(template.id)) return false;
    if ((template.chargeKind === 'contingent' ? 'contingent' : 'fixed') !== kind) return false;
    if (template.section === 'foreign' && modeSelect?.value !== 'ocean_mexico') return false;
    const modes = Array.isArray(template.appliesTo) ? template.appliesTo : [];
    return !cargoSelect?.value || !modes.length || modes.includes(cargoSelect.value);
  }

  function refreshTemplateChoices() {
    const existingIds = new Set([...form.querySelectorAll('[name="li_id[]"]')].map((field) => field.value));
    form.querySelectorAll('[data-quote-template-picker]').forEach((select) => {
      const kind = select.dataset.quoteTemplatePicker;
      const previous = select.value;
      const available = (settings.templates || []).filter((template) => templateApplies(template, kind, existingIds));
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = available.length ? labels.templateSelect : labels.templateEmpty;
      select.append(placeholder);
      for (const template of available) {
        const option = document.createElement('option'); option.value = template.id;
        option.textContent = (labels.uiLang === 'zh' ? template.conceptZh : template.conceptEs) || template.conceptEn || template.code || template.id;
        select.append(option);
      }
      select.value = available.some((template) => template.id === previous) ? previous : '';
      select.disabled = !available.length;
      const button = form.querySelector(`[data-quote-add-template="${kind}"]`);
      if (button) button.disabled = !select.value;
    });
  }

  form.querySelectorAll('[data-quote-template-picker]').forEach((select) => select.addEventListener('change', () => {
    const button = form.querySelector(`[data-quote-add-template="${select.dataset.quoteTemplatePicker}"]`);
    if (button) button.disabled = !select.value;
  }));
  form.querySelectorAll('[data-quote-add-template]').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.quoteAddTemplate;
    const picker = form.querySelector(`[data-quote-template-picker="${kind}"]`);
    const template = (settings.templates || []).find((entry) => entry.id === picker?.value);
    const existing = new Set([...form.querySelectorAll('[name="li_id[]"]')].map((field) => field.value));
    if (!template || !templateApplies(template, kind, existing)) return;
    const row = buildRow(kind, template);
    if (!row) return;
    form.querySelector(`[data-quote-rows="${kind}"]`).append(row);
    removedTemplateIds.delete(template.id);
    wireRow(row); recomputeAll();
    row.querySelector('.concept-cell input[type="text"]')?.focus();
  }));

  function seedForeignTemplates() {
    if (modeSelect?.value !== 'ocean_mexico') return;
    const existing = new Set([...form.querySelectorAll('[name="li_id[]"]')].map((f) => f.value));
    for (const template of settings.templates || []) {
      if (template.section !== 'foreign' || template.enabled !== true || existing.has(template.id) || removedTemplateIds.has(template.id)) continue;
      const kind = template.chargeKind === 'contingent' ? 'contingent' : 'fixed';
      const row = buildRow(kind, template);
      if (row) { form.querySelector(`[data-quote-rows="${kind}"]`)?.append(row); existing.add(template.id); wireRow(row); }
    }
  }
  form.querySelectorAll('[data-quote-row]').forEach(wireRow);
  form.querySelectorAll('[data-quote-add]').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.quoteAdd === 'contingent' ? 'contingent' : 'fixed';
    const row = buildRow(kind, { unit: 1, appliesTo: cargoTypes.includes(activeCargoType) ? [activeCargoType] : cargoTypes });
    if (!row) return;
    form.querySelector(`[data-quote-rows="${kind}"]`).append(row);
    wireRow(row); recomputeAll();
    row.querySelector('.concept-cell input[type="text"]')?.focus();
  }));
  modeSelect?.addEventListener('change', () => { seedForeignTemplates(); recomputeAll(); });
  cargoSelect?.addEventListener('change', () => {
    saveCargoState();
    activeCargoType = cargoSelect.value;
    if (cargoTypes.includes(activeCargoType)) restoreCargoState(activeCargoType, cargoStates[activeCargoType] || newCargoState(activeCargoType));
    if (cargoTypes.includes(activeCargoType)) {
      const department = byName(form, 'department');
      const transportMode = byName(form, 'transportMode');
      if (department) department.value = activeCargoType === 'AIR' ? 'AIR' : 'OCEAN';
      if (transportMode) transportMode.value = activeCargoType === 'AIR' ? 'AIR' : 'SEA';
    }
    recomputeAll();
  });

  const cargoRows = {
    container: { list: form.querySelector('[data-cargo-container-rows]'), selector: '[data-cargo-container-row]' },
    package: { list: form.querySelector('[data-cargo-package-rows]'), selector: '[data-cargo-package-row]' },
  };
  const cargoRowTemplates = Object.fromEntries(Object.entries(cargoRows).map(([kind, collection]) => [kind, collection.list?.querySelector(collection.selector)?.cloneNode(true)]));
  function restoreCargoState(type, state) {
    const kind = type === 'FCL' ? 'container' : 'package';
    const collection = cargoRows[kind];
    const fields = kind === 'container'
      ? { containerType: 'cargo_containerType[]', quantity: 'cargo_containerQuantity[]', unitPrice: 'cargo_containerPrice[]', currency: 'cargo_containerCurrency[]' }
      : Object.fromEntries(['lengthCm', 'widthCm', 'heightCm', 'packageCount', 'weightKg', 'weightCount'].map((key) => [key, `cargo_${key}[]`]));
    const entries = state[kind === 'container' ? 'containers' : 'packages'];
    const rows = Array.isArray(entries) && entries.length ? entries : [kind === 'container' ? { currency: state.currency || currencyDefault('TRANSPORTATION') } : {}];
    if (collection.list && cargoRowTemplates[kind]) {
      collection.list.replaceChildren(...rows.map((entry) => {
        const row = cargoRowTemplates[kind].cloneNode(true);
        for (const [key, name] of Object.entries(fields)) byName(row, name).value = entry[key] ?? '';
        const total = row.querySelector('[data-cargo-container-total]');
        if (total) total.textContent = '—';
        return row;
      }));
    }
    if (type !== 'FCL') {
      for (const key of ['unitPrice', 'currency', 'manualChargeable', 'volumeDivisor']) {
        const field = byName(form, `cargo_${key}`);
        if (field) field.value = state[key] ?? '';
      }
      byName(form, 'cargo_method').value = state.method || (type === 'AIR' ? 'manual' : 'raw_max');
    }
  }
  function clearCargoRow(row) {
    row.querySelectorAll('input,select').forEach((input) => { input.value = ''; });
    const currency = byName(row, 'cargo_containerCurrency[]');
    if (currency) currency.value = currencyDefault('TRANSPORTATION');
    const total = row.querySelector('[data-cargo-container-total]');
    if (total) total.textContent = '—';
  }
  form.querySelectorAll('[data-cargo-add]').forEach((button) => button.addEventListener('click', () => {
    const collection = cargoRows[button.dataset.cargoAdd];
    const row = collection?.list.querySelector(collection.selector)?.cloneNode(true);
    if (!row) return;
    clearCargoRow(row); collection.list.append(row); recomputeAll(); row.querySelector('input')?.focus();
  }));
  Object.entries(cargoRows).forEach(([kind, { list, selector }]) => {
    const update = (event) => { clearCargoFieldErrors(event.target); recomputeAll(); };
    list?.addEventListener('input', update);
    list?.addEventListener('change', update);
    list?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cargo-remove]');
      if (!button) return;
      const row = button.closest(selector);
      const rows = [...list.querySelectorAll(selector)];
      clearCargoRowErrors(kind, rows.indexOf(row), rows.length > 1);
      if (rows.length > 1) row.remove(); else clearCargoRow(row);
      recomputeAll();
    });
  });
  ['cargo_unitPrice', 'cargo_currency', 'cargo_method', 'cargo_manualChargeable', 'cargo_volumeDivisor'].forEach((name) => {
    const update = (event) => { clearCargoFieldErrors(event.target); recomputeAll(); };
    byName(form, name)?.addEventListener('input', update);
    byName(form, name)?.addEventListener('change', update);
  });
  form.querySelector('[data-cargo-reset]')?.addEventListener('click', () => {
    if (!cargoTypes.includes(activeCargoType)) return;
    cargoStates[activeCargoType] = newCargoState(activeCargoType);
    if (Array.isArray(cargoStates._validationErrors)) cargoStates._validationErrors = cargoStates._validationErrors.filter((error) => error !== `cargoPricingByType:${activeCargoType}:invalid_state`);
    for (const type of cargoTypes) {
      if (Array.isArray(cargoStates[type]?.validationErrors)) cargoStates[type].validationErrors = cargoStates[type].validationErrors.filter((error) => error !== `cargoPricingByType:${activeCargoType}:invalid_state`);
    }
    restoreCargoState(activeCargoType, cargoStates[activeCargoType]);
    recomputeAll();
  });
  form.querySelector('[data-cargo-reset-all]')?.addEventListener('click', () => {
    Object.keys(cargoStates).forEach((key) => { delete cargoStates[key]; });
    if (cargoTypes.includes(activeCargoType)) {
      cargoStates[activeCargoType] = newCargoState(activeCargoType);
      restoreCargoState(activeCargoType, cargoStates[activeCargoType]);
    }
    recomputeAll();
  });
  const draftPicker = form.querySelector('[data-quote-draft-picker]');
  const openDraft = form.querySelector('[data-quote-open-draft]');
  draftPicker?.addEventListener('change', () => { if (openDraft) openDraft.disabled = !draftPicker.value; });
  openDraft?.addEventListener('click', () => {
    if (draftPicker?.value) window.location.assign('/workbench/quote?draft=' + encodeURIComponent(draftPicker.value));
  });
  form.addEventListener('submit', saveCargoState);

  const gdRows = form.querySelector('[data-gd-rows]');
  form.querySelector('[data-gd-add]')?.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'quote-extra-row'; row.dataset.gdRow = '';
    for (const [name, title, placeholder] of [['gd_label[]', labels.fieldName, labels.fieldExample], ['gd_value[]', labels.fieldValue, labels.valueExample]]) {
      const label = document.createElement('label'); label.className = 'quote-field';
      const caption = document.createElement('span'); caption.textContent = title;
      const input = document.createElement('input'); input.type = 'text'; input.name = name; input.placeholder = placeholder;
      label.append(caption, input); row.append(label);
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost-button compact-button';
    button.dataset.gdRemove = ''; button.textContent = '×'; button.setAttribute('aria-label', labels.remove || 'Remove');
    row.append(button); gdRows.append(row); row.querySelector('input').focus();
  });
  gdRows?.addEventListener('click', (event) => event.target.closest('[data-gd-remove]')?.closest('[data-gd-row]')?.remove());

  const remarkList = form.querySelector('[data-remark-list]');
  if (remarkList) {
    let dragging = null;
    remarkList.addEventListener('dragstart', (event) => { dragging = event.target.closest('[data-remark-item]'); if (dragging && event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
    remarkList.addEventListener('dragend', () => { dragging = null; });
    remarkList.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault(); const over = event.target.closest('[data-remark-item]');
      if (!over || over === dragging) return;
      const rect = over.getBoundingClientRect();
      remarkList.insertBefore(dragging, event.clientY > rect.top + rect.height / 2 ? over.nextSibling : over);
    });
  }
  if (cargoTypes.includes(activeCargoType) && cargoStates[activeCargoType]) restoreCargoState(activeCargoType, cargoStates[activeCargoType]);
  recomputeAll();
})();
