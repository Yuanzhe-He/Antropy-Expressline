(function rateCardEditor(global) {
  'use strict';
  const instances = new Map();
  const TYPES = ['FCL', 'LCL', 'BBK', 'AIR'];
  const GROUPS = ['OCEAN FREIGHT', 'PORT OF ORIGIN', 'SHIPPING LINE', 'PORT FEES', 'CUSTOMS CLEARANCE', 'TRANSPORTATION', 'DUTY'];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const safeVariant = (value) => object(value) && typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.id) && ![...Object.getOwnPropertyNames(Object.prototype).map((key) => key.toLowerCase()), 'prototype'].includes(value.id.toLowerCase());
  const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  function mount(element, supplied = {}) {
    const root = typeof element === 'string' ? document.getElementById(element) : element;
    if (!root) return null;
    if (instances.has(root.id)) return instances.get(root.id);
    let config = {};
    try { config = JSON.parse(root.querySelector('[data-rate-card-config]')?.textContent || '{}'); } catch (_) { config.value = { _validationErrors: ['rateCardsByType:invalid_json'] }; }
    config = { ...config, ...supplied };
    const model = global.QuoteRateCard;
    if (!model) return null;
    const zh = config.language !== 'es';
    const text = (cn, es) => zh ? cn : es;
    let cards = clone(config.value || {});
    let currentType = TYPES.includes(config.cargoType) ? config.cargoType : (config.adminMode ? 'FCL' : '');
    let quoteMode = 'mexico_only';
    let enabled = Boolean(config.adminMode);
    let exportValidation = false;
    const hidden = root.querySelector('[data-rate-card-value]');
    const toolbar = root.querySelector('[data-rate-card-toolbar]');
    const content = root.querySelector('[data-rate-card-content]');
    const empty = root.querySelector('[data-rate-card-empty]');
    const errorsBox = root.querySelector('[data-rate-card-errors]');
    const node = (tag, className, value) => {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (value !== undefined) el.textContent = value;
      return el;
    };
    function button(label, action, className = 'ghost-button compact-button') {
      const el = node('button', className, label); el.type = 'button'; el.addEventListener('click', action); return el;
    }
    function fieldLabel(label, input) { const el = node('label', 'quote-field'); el.append(node('span', '', label), input); return el; }
    function input(value, label, handler, opts = {}) {
      const el = document.createElement('input'); el.type = opts.checkbox ? 'checkbox' : 'text';
      if (opts.checkbox) el.checked = Boolean(value); else el.value = value == null ? '' : String(value);
      el.setAttribute('aria-label', label);
      if (opts.decimal) { el.inputMode = 'decimal'; el.placeholder = '—'; }
      if (opts.placeholder) el.placeholder = opts.placeholder;
      if (opts.maxLength) el.maxLength = opts.maxLength;
      el.addEventListener(opts.checkbox ? 'change' : 'input', () => handler(opts.checkbox ? el.checked : el.value));
      return el;
    }
    function select(value, choices, label, handler) {
      const el = document.createElement('select'); el.setAttribute('aria-label', label);
      for (const [code, caption] of choices) { const option = node('option', '', caption); option.value = code; el.append(option); }
      if (value && !choices.some(([code]) => code === value)) { const option = node('option', '', value); option.value = value; el.append(option); }
      el.value = value || ''; el.addEventListener('change', () => handler(el.value)); return el;
    }
    function currentCard(initialize = enabled) {
      if (!TYPES.includes(currentType)) return null;
      if (!hasOwn(cards, currentType) && initialize) {
        cards[currentType] = hasOwn(config.defaults, currentType) ? clone(config.defaults[currentType]) : model.createDefaultRateCard(currentType, config.templates || []);
      }
      return cards[currentType] || null;
    }
    function clearErrors(paths, matching = () => false) {
      const card = currentCard(false);
      if (!Array.isArray(card?.validationErrors)) return;
      card.validationErrors = card.validationErrors.filter((error) => !paths.some((path) => error.startsWith(path + ':')) && !matching(error));
    }
    function changed(paths = [], matching) {
      clearErrors(paths, matching);
      sync(); showErrors();
      root.dispatchEvent(new CustomEvent('ratecardchange', { bubbles: true, detail: { cargoType: currentType } }));
    }
    function sync() { hidden.value = JSON.stringify(cards); return cards; }
    function validate(options = {}) {
      if (config.adminMode) return model.validateRateCardsByType(cards);
      const card = currentCard(false);
      const globalErrors = Array.isArray(cards._validationErrors) ? cards._validationErrors : [];
      if (!card) return globalErrors;
      return [...globalErrors, ...(options.forExport ? model.buildRateCardView(card, quoteMode).errors : model.validateRateCard(card, options))];
    }
    function errorText(error) {
      const location = String(error).split(':')[0];
      const row = location.match(/rows\.(\d+)/);
      const variant = location.match(/variants\.(\d+)/);
      const type = String(error).match(/^(FCL|LCL|BBK|AIR)\./);
      const prefix = (type ? type[1] + ' · ' : '') + (row ? text(`第 ${Number(row[1]) + 1} 行：`, `Fila ${Number(row[1]) + 1}: `) : variant ? text(`第 ${Number(variant[1]) + 1} 个规格：`, `Especificación ${Number(variant[1]) + 1}: `) : '');
      if (/too_many_variants/.test(error)) return text('最多支持 12 个规格列；请删除多余规格后保存。', 'Máximo 12 especificaciones; elimine las sobrantes.');
      if (/too_many_rows/.test(error)) return text('每种装载方式最多 100 个费用行；请删除多余行后保存。', 'Máximo 100 cargos por modalidad; elimine las filas sobrantes.');
      if (/duplicate_label/.test(error)) return prefix + text('规格名称重复，请改为不同名称。', 'El nombre de la especificación está repetido.');
      if (/variants:at_least_one/.test(error)) return text('至少保留一个规格列。', 'Conserve al menos una especificación.');
      if (/label/.test(location)) return prefix + text('请填写有效的规格名称。', 'Indique un nombre válido.');
      if (/concept/.test(location)) return prefix + text('请填写费用名称。', 'Indique el concepto del cargo.');
      if (/category/.test(location)) return prefix + text('请在费用分类中选择有效分类。', 'Seleccione un grupo válido.');
      if (/unitPriceMax|invalid_range/.test(error)) return prefix + text('区间上限须为有效金额，且不小于单价。', 'El límite superior debe ser válido y no menor que el precio.');
      if (/unitPrice/.test(error)) return prefix + text('单价须为非负数字；不报价请留空。', 'El precio debe ser un número no negativo; déjelo vacío si no se ofrece.');
      if (/currency/.test(error)) return prefix + text('请选择 USD 或 MXN。', 'Seleccione USD o MXN.');
      if (/no_offered|no_prices|empty_offer|offered/.test(error)) return text('至少填写一个已选费用的规格价格或 AT COST。', 'Capture al menos un precio o AT COST en un cargo seleccionado.');
      return prefix + text('保存的数据包含无效字段，请核对该行或规格；不会自动删除数据。', 'Los datos guardados contienen un campo no válido. Revise la fila o especificación; no se borrarán datos automáticamente.');
    }
    function showErrors() {
      const errors = enabled ? validate({ forExport: exportValidation }) : [];
      errorsBox.replaceChildren(); errorsBox.hidden = !errors.length;
      if (!errors.length) return;
      errorsBox.append(node('strong', '', text('请检查价格表', 'Revise el tarifario')));
      const list = node('ul');
      [...new Set(errors.map(errorText))].slice(0, 8).forEach((message) => list.append(node('li', '', message)));
      errorsBox.append(list);
      const card = currentCard(false);
      if (TYPES.includes(currentType) && (card?.validationErrors || []).some((error) => /^(?:card:|rows:invalid_rows|variants:invalid_variants)/.test(error))) {
        errorsBox.append(button(text('清空本类型价格表后重填', 'Vaciar este tarifario y volver a capturar'), () => {
          cards[currentType] = model.createDefaultRateCard(currentType, []); changed(); render();
        }));
      }
      if ((cards._validationErrors || []).length) {
        errorsBox.append(node('p', '', text('损坏缓存的恢复操作会清空所有装载方式的长期报价数据，单票报价不受影响。', 'La recuperación vacía los tarifarios de todas las modalidades; las cotizaciones por embarque se conservan.')));
        errorsBox.append(button(text('清空损坏的长期报价缓存', 'Vaciar los tarifarios dañados'), () => {
          cards = {}; if (TYPES.includes(currentType)) cards[currentType] = model.createDefaultRateCard(currentType, []); changed(); render();
        }));
      }
    }
    function setDisabled() {
      root.querySelectorAll('input:not([type="hidden"]), select, button').forEach((el) => { el.disabled = !enabled || el.dataset.limitDisabled === 'true'; });
    }
    function reindexErrors(collection, index) {
      const card = currentCard(false);
      if (!Array.isArray(card?.validationErrors)) return;
      card.validationErrors = card.validationErrors.flatMap((error) => {
        const match = error.match(/^(rows|variants)\.(\d+)([.:].*)$/);
        if (!match || match[1] !== collection) return [error];
        const oldIndex = Number(match[2]);
        if (oldIndex === index) return [];
        return [oldIndex > index ? `${collection}.${oldIndex - 1}${match[3]}` : error];
      });
    }
    function metadataInput(row, index, key, label, opts = {}) {
      const el = input(row[key], label, (value) => { row[key] = value; changed([`rows.${index}.${key}`, ...(key.startsWith('concept') ? [`rows.${index}.concept`] : [])]); }, opts); el.dataset.rateRowField = key; return el;
    }
    function priceCell(row, rowIndex, variant) {
      if (!safeVariant(variant)) return node('td', '', text('无效规格，请删除', 'Especificación inválida; elimínela'));
      if (row.cells === undefined) row.cells = {};
      if (!row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) return node('td', '', text('无效价格数据', 'Datos de precio no válidos'));
      if (!hasOwn(row.cells, variant.id) || row.cells[variant.id] == null) row.cells[variant.id] = { unitPrice: '', unitPriceMax: '', isAtCost: false };
      const cell = row.cells[variant.id];
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return node('td', '', text('无效价格数据', 'Datos de precio no válidos'));
      const td = node('td', 'quote-rate-price'); td.dataset.rateVariant = variant.id;
      const path = `rows.${rowIndex}.cells.${variant.id}`;
      const price = input(cell.unitPrice, variant.label + text(' 单价', ' Precio'), (value) => {
        cell.unitPrice = value; changed([path + '.unitPrice'], (error) => error === path + '.unitPriceMax:invalid_range');
      }, { decimal: true }); price.dataset.rateCellPrice = variant.id; price.readOnly = Boolean(cell.isAtCost);
      const detail = node('details', 'quote-translations'); const summary = node('summary'); detail.append(summary);
      const refreshPrice = () => { price.value = cell.isAtCost ? 'AT COST' : (cell.unitPrice ?? ''); summary.textContent = cell.isAtCost ? 'AT COST' : (cell.unitPriceMax != null && String(cell.unitPriceMax).trim() !== '' ? '– ' + cell.unitPriceMax : text('区间 / 实报实销', 'Rango / AT COST')); };
      refreshPrice();
      const max = input(cell.unitPriceMax, variant.label + text(' 区间上限', ' Límite superior'), (value) => { cell.unitPriceMax = value; refreshPrice(); changed([path + '.unitPriceMax']); }, { decimal: true }); max.dataset.rateCellMax = variant.id; max.readOnly = Boolean(cell.isAtCost);
      const costToggle = input(cell.isAtCost, variant.label + ' AT COST', (value) => { cell.isAtCost = value; price.readOnly = value; max.readOnly = value; refreshPrice(); changed([path + '.isAtCost']); }, { checkbox: true }); costToggle.dataset.rateCellAtcost = variant.id;
      const costLabel = node('label', 'quote-inclusion'); costLabel.append(costToggle, node('span', '', 'AT COST'));
      detail.append(fieldLabel(text('上限（可选）', 'Máximo (opcional)'), max), costLabel);
      td.append(price, detail); return td;
    }
    function renderRow(row, index, variants) {
      if (!object(row)) {
        const invalid = node('tr'); invalid.dataset.rateInvalidRow = String(index);
        const message = node('td', '', text('无效费用行；请核对原始内容后删除并重新添加。', 'Fila de cargo inválida; coteje la fuente, elimínela y vuelva a agregarla.')); message.colSpan = variants.length + 8;
        const action = node('td'); const remove = button(text('删除此行', 'Eliminar fila'), () => { const card = currentCard(); card.rows.splice(index, 1); reindexErrors('rows', index); changed([], (error) => card.rows.length <= 100 && error === 'rows:too_many_rows'); render(); }); remove.dataset.rateRemoveRow = ''; action.append(remove); invalid.append(message, action); return invalid;
      }
      const tr = node('tr'); tr.dataset.rateRow = row.id || String(index);
      if (!config.adminMode && quoteMode !== 'ocean_mexico' && row.section === 'foreign') tr.hidden = true;
      const cell = (el, className) => { const td = node('td', className); td.append(el); tr.append(td); return td; };
      const section = select(row.section || 'mexico', [['mexico', text('墨西哥', 'México')], ['foreign', text('国际段', 'Tramo internacional')]], text('区段', 'Tramo'), (value) => { row.section = value; changed([`rows.${index}.section`]); render(); }); section.dataset.rateRowField = 'section'; cell(section);
      cell(metadataInput(row, index, 'code', text('内部费用代码', 'Código interno')));
      const concepts = node('div', 'concept-cell');
      const active = zh ? 'conceptZh' : 'conceptEs';
      concepts.append(metadataInput(row, index, active, text('费用名称', 'Concepto')));
      const translations = node('details', 'quote-translations'); translations.append(node('summary', '', text('其他语言 / 分类', 'Idiomas / grupo')));
      for (const [key, caption] of [['conceptEn', 'English'], ['conceptZh', '中文'], ['conceptEs', 'Español']]) if (key !== active) translations.append(fieldLabel(caption, metadataInput(row, index, key, caption)));
      translations.append(fieldLabel(text('费用分类', 'Grupo'), select(row.category || 'SHIPPING LINE', GROUPS.map((value) => [value, value]), text('费用分类', 'Grupo'), (value) => { row.category = value; changed([`rows.${index}.category`]); })));
      translations.append(fieldLabel(text('收费板块', 'Tipo de cargo'), select(row.chargeKind || 'fixed', [['fixed', text('固定费用', 'Fijo')], ['contingent', text('发生才收取', 'Si se genera')]], text('收费板块', 'Tipo de cargo'), (value) => { row.chargeKind = value; changed([`rows.${index}.chargeKind`]); render(); })));
      concepts.append(translations); cell(concepts, 'quote-rate-concept');
      variants.forEach((variant) => tr.append(priceCell(row, index, variant)));
      cell(node('span', 'quote-rate-quantity', '1'));
      cell(metadataInput(row, index, 'unitOfMeasure', text('计费单位', 'Unidad'), { placeholder: currentType === 'FCL' ? 'container' : 'shipment' }));
      cell(select(row.currency || '', [['', '—'], ['USD', 'USD'], ['MXN', 'MXN']], text('币种', 'Moneda'), (value) => { row.currency = value; changed([`rows.${index}.currency`]); }));
      cell(metadataInput(row, index, 'remark', text('备注', 'Observación')));
      const included = node('label', 'quote-inclusion'); const check = input(row.included !== false, text('显示此费用', 'Mostrar cargo'), (value) => { row.included = value; changed([`rows.${index}.included`]); }, { checkbox: true }); check.dataset.rateRowIncluded = ''; included.append(check, node('span', '', text('显示', 'Mostrar'))); cell(included);
      const remove = button('×', () => { const card = currentCard(); card.rows.splice(index, 1); reindexErrors('rows', index); changed([], (error) => card.rows.length <= 100 && error === 'rows:too_many_rows'); render(); }); remove.setAttribute('aria-label', text('删除费用行', 'Eliminar cargo')); remove.dataset.rateRemoveRow = ''; cell(remove);
      return tr;
    }
    function addRow(kind, source = {}) {
      const card = currentCard(); if (!card || !Array.isArray(card.rows) || card.rows.length >= 100) return;
      const category = source.category || 'SHIPPING LINE';
      card.rows.push({ id: uid('rate-row'), category, code: source.code || '', conceptEn: source.conceptEn || '', conceptZh: source.conceptZh || '', conceptEs: source.conceptEs || '', section: source.section || 'mexico', chargeKind: kind, included: source.included !== false && !source.selectionRequired, unitOfMeasure: source.unitOfMeasure || (currentType === 'FCL' ? 'container' : 'shipment'), currency: source.currency || (category === 'SHIPPING LINE' ? 'USD' : 'MXN'), remark: source.remark || '', cells: Object.fromEntries(card.variants.filter(safeVariant).map((variant) => [variant.id, { unitPrice: '', unitPriceMax: '', isAtCost: false }])) });
      changed(); render();
    }
    function removeVariant(index) {
      const card = currentCard();
      const id = card.variants[index]?.id;
      card.variants.splice(index, 1);
      if (typeof id === 'string' && !card.variants.some((entry) => entry?.id === id)) {
        card.rows.forEach((row) => { if (object(row?.cells)) delete row.cells[id]; });
        clearErrors([], (error) => error.includes(`.cells.${id}.`) || error.startsWith(`rows.`) && error.includes(`.cells.${id}:`));
      }
      reindexErrors('variants', index);
      changed([], (error) => (card.variants.length <= 12 && error === 'variants:too_many_variants') || /^variants\.\d+\.(?:id|label):duplicate_(?:id|label)$/.test(error)); render();
    }
    function render() {
      toolbar.replaceChildren(); content.replaceChildren();
      if (config.adminMode) toolbar.append(fieldLabel(text('配置装载方式', 'Configurar modalidad'), select(currentType, TYPES.map((type) => [type, type]), text('配置装载方式', 'Configurar modalidad'), (value) => { currentType = value; exportValidation = false; render(); })));
      const card = currentCard();
      empty.hidden = Boolean(card); empty.textContent = text('请先选择装载方式，再编辑对应的长期价格表。', 'Seleccione una modalidad para editar su tarifario.');
      if (!card || !Array.isArray(card.variants) || !Array.isArray(card.rows)) { sync(); showErrors(); setDisabled(); return; }
      const variantsBar = node('div', 'quote-rate-variants');
      variantsBar.append(node('strong', '', text('规格列 · 数量均为 1', 'Especificaciones · cantidad 1')));
      card.variants.forEach((variant, index) => {
        if (!object(variant)) {
          const invalid = node('div', 'quote-rate-variant'); invalid.dataset.rateInvalidVariant = String(index);
          invalid.append(node('span', '', text('无效规格', 'Especificación inválida')), button(text('删除', 'Eliminar'), () => removeVariant(index))); variantsBar.append(invalid); return;
        }
        const item = node('div', 'quote-rate-variant'); const label = input(variant.label, text('规格名称', 'Nombre de especificación'), (value) => {
          variant.label = value; changed([`variants.${index}.label`], (error) => /^variants\.\d+\.label:duplicate_label$/.test(error));
          root.querySelectorAll('[data-rate-variant-heading]').forEach((heading) => { if (heading.dataset.rateVariantHeading === variant.id) heading.textContent = value; });
        }, { maxLength: 120 }); label.dataset.rateVariantLabel = variant.id;
        const remove = button('×', () => removeVariant(index)); remove.dataset.rateRemoveVariant = variant.id; remove.setAttribute('aria-label', text('删除规格列 ', 'Eliminar especificación ') + variant.label);
        item.append(label, remove); variantsBar.append(item);
      });
      const add = button(text('＋ 新增规格', '＋ Agregar especificación'), () => {
        if (card.variants.length >= 12) return;
        let n = card.variants.length + 1; let label;
        do { label = text(`规格 ${n}`, `Especificación ${n}`); n += 1; } while (card.variants.some((variant) => variant?.label === label));
        card.variants.push({ id: uid('variant'), label }); changed(); render();
      }); add.dataset.rateAddVariant = ''; add.dataset.limitDisabled = String(card.variants.length >= 12); variantsBar.append(add); toolbar.append(variantsBar);
      content.append(node('p', 'quote-hint', text('每列是一个独立规格的单价，数量固定为 1；不同规格之间不合计。空白表示未报价，0 表示零价。', 'Cada columna es una tarifa independiente con cantidad fija de 1; no se suman alternativas. Vacío significa sin cotizar y 0 significa precio cero.')));
      for (const kind of ['fixed', 'contingent']) {
        const section = node('section', 'quote-rate-section'); section.dataset.rateSection = kind;
        section.append(node('h4', '', kind === 'fixed' ? text('固定费用', 'Cargos fijos') : text('发生才收取的费用', 'Cargos si se generan')));
        const wrap = node('div', 'quote-table-wrap'); const table = node('table', 'quote-table quote-rate-table'); table.dataset.rateMatrix = kind;
        const head = node('thead'); const header = node('tr');
        [text('区段', 'Tramo'), text('内部代码', 'Código interno'), text('费用名称', 'Concepto')].forEach((label) => header.append(node('th', '', label)));
        card.variants.forEach((variant) => { const th = node('th', '', variant?.label || text('无效规格', 'Especificación inválida')); if (variant?.id) th.dataset.rateVariantHeading = variant.id; header.append(th); });
        [text('数量', 'Cantidad'), text('单位', 'Unidad'), text('币种', 'Moneda'), text('备注', 'Observación'), text('输出', 'Salida'), ''].forEach((label) => header.append(node('th', '', label)));
        head.append(header); const body = node('tbody');
        card.rows.forEach((row, index) => { if ((row?.chargeKind === 'contingent' ? 'contingent' : 'fixed') === kind) body.append(renderRow(row, index, card.variants)); });
        table.append(head, body); wrap.append(table); section.append(wrap);
        const actions = node('div', 'quote-actions'); const addFee = button(text('＋ 新增费用', '＋ Agregar cargo'), () => addRow(kind)); addFee.dataset.rateAddRow = kind; addFee.dataset.limitDisabled = String(card.rows.length >= 100); actions.append(addFee);
        const available = (config.templates || []).filter((entry) => entry.enabled === true && (entry.chargeKind === 'contingent' ? 'contingent' : 'fixed') === kind && (!entry.appliesTo?.length || entry.appliesTo.includes(currentType)) && (config.adminMode || quoteMode === 'ocean_mexico' || entry.section !== 'foreign'));
        if (available.length) {
          const picker = select('', [['', text('从费用库添加（价格留空）', 'Agregar del catálogo (sin precios)')], ...available.map((entry, index) => [String(index), (zh ? entry.conceptZh : entry.conceptEs) || entry.conceptEn || entry.code || entry.id])], text('费用库', 'Catálogo de cargos'), (value) => { if (value !== '') addRow(kind, available[Number(value)]); }); picker.dataset.rateTemplate = kind; actions.append(picker);
        }
        section.append(actions); content.append(section);
      }
      sync(); showErrors(); setDisabled();
    }
    const api = {
      setCargoType(type) { if (currentType !== type) { currentType = TYPES.includes(type) ? type : ''; exportValidation = false; render(); } },
      setQuoteMode(mode) { if (quoteMode !== mode) { quoteMode = mode; render(); } },
      setEnabled(value) { const next = Boolean(value); if (enabled !== next) { enabled = next; exportValidation = false; render(); } else setDisabled(); },
      sync,
      getValue() { return clone(cards); },
      validate(options = {}) { exportValidation = Boolean(options.forExport); const errors = validate(options); showErrors(); return errors; },
    };
    instances.set(root.id, api); render(); return api;
  }
  global.QuoteRateCardEditors = { mount, get: (id) => instances.get(id), initAll: () => document.querySelectorAll('[data-rate-card-editor]').forEach((root) => mount(root)) };
  global.QuoteRateCardEditors.initAll();
})(window);
