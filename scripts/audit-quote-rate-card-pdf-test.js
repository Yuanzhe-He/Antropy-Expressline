// The PDF renderer must preserve alternatives, blank rates and output audience
// even if stale single-shipment totals reach the template. No store or network.
const assert = require('node:assert/strict');
const { renderQuoteHtml } = require('../src/lib/quote-pdf');
const { buildRateCardView } = require('../public/quote-rate-card');

let passed = 0;
const ok = (message) => { passed++; console.log('  PASS ' + message); };
const body = (html) => html.slice(html.indexOf('<body>')).replace(/src="data:[^"]*"/g, 'src="[inlined asset]"');
const tables = (html) => [...html.matchAll(/<table class="charges rate-card">([\s\S]*?)<\/table>/g)].map(match => match[1]);

function card(count = 3, mode = 'FCL') {
  const variants = Array.from({ length: count }, (_, i) => ({ id: `v${i}`, label: `SPEC-${i + 1}` }));
  const cells = Object.fromEntries(variants.map((variant, i) => [variant.id, { unitPrice: 100 + i, unitPriceMax: null, isAtCost: false }]));
  return {
    variants,
    rows: [{
      id: 'matrix-fee', category: 'TRANSPORTATION', code: 'OFFICIAL-SECRET',
      conceptEn: 'Matrix service', conceptZh: '矩阵服务', conceptEs: 'Servicio matriz',
      section: 'mexico', chargeKind: 'fixed', included: true, unit: 99,
      unitOfMeasure: { FCL: 'container', LCL: 'cbm', BBK: 'ton', AIR: 'kg' }[mode],
      currency: 'MXN', remark: 'Validity and limits', cells,
    }],
    errors: [],
  };
}

function view(overrides = {}) {
  const row = {
    category: 'SINGLE CATEGORY', code: 'SINGLE-SECRET', conceptEn: 'SINGLE-CARGO-AUTO-CHARGE',
    included: true, unit: 2, unitOfMeasure: 'container', unitPriceLabel: '125.00',
    total: 250, totalLabel: '250.00', currency: 'USD', remark: '',
  };
  return {
    number: 'PDF-CONTRACT', date: '2026-09-22', language: 'EN',
    header: { cargoType: 'FCL', extraFields: [] }, quoteType: 'long_term',
    rateCard: card(), outputAudience: 'customer', notes: [],
    showTotals: true, showIndicativeConversion: true, taxTreatment: 'included',
    subtotals: [{ currency: 'USD', amountLabel: 'FORBIDDEN-SUBTOTAL' }],
    indicative: { currency: 'MXN', amountLabel: 'FORBIDDEN-FX' },
    dualTotals: { amountLabel: 'FORBIDDEN-VAT' }, cargoChargeRows: [row],
    chargeSections: [{ chargeKind: 'fixed', sections: [{ section: 'mexico', groups: [{ category: row.category, items: [row] }] }] }],
    ...overrides,
  };
}

async function main() {
  for (const mode of ['FCL', 'LCL', 'BBK', 'AIR']) {
    const html = await renderQuoteHtml(view({ header: { cargoType: mode }, rateCard: card(3, mode) }));
    const content = body(html);
    assert.match(html, /@page \{ size: A4 landscape;/);
    assert.match(content, /Long-term rate card/);
    assert.match(content, /<td class="quantity">1<\/td>/);
    assert.match(content, /<td class="cur">MXN<\/td>/);
    assert.match(content, /Validity and limits/);
    assert.doesNotMatch(content, /OFFICIAL-SECRET|INTERNAL CODE|SINGLE-SECRET|SINGLE-CARGO-AUTO-CHARGE/);
    assert.doesNotMatch(content, /FORBIDDEN-|class="(?:subtotals|indicative|dual-totals)"|FIXED SUBTOTAL|TOTAL PRICE|>99<|quotation subtotal/);
    assert.match(content, /Entered prices include tax/);
  }
  ok('all four cargo modes render a quantity-1 rate matrix without single-cargo fees, codes, totals, FX or extra VAT');

  for (const count of [1, 3, 4, 7, 12]) {
    const html = await renderQuoteHtml(view({ rateCard: card(count), outputAudience: 'internal' }));
    const matrixTables = tables(html);
    assert.equal(matrixTables.length, Math.ceil(count / 3));
    assert.equal((body(html).match(/class="rate-card-panel"/g) || []).length, Math.ceil(count / 3));
    for (const [index, table] of matrixTables.entries()) {
      const headings = table.match(/<thead>([\s\S]*?)<\/thead>/)[1];
      assert.equal((headings.match(/class="specification"/g) || []).length, Math.min(3, count - index * 3));
      assert.match(headings, /CHARGE CATEGORY/);
      assert.match(headings, /QTY/);
      assert.match(headings, /CURRENCY/);
      assert.match(table, /TRANSPORTATION/);
      assert.match(table, /OFFICIAL-SECRET/);
      assert.match(table, /Validity and limits/);
      assert.doesNotMatch(table, /rowspan/);
      const columnHeaders = [...headings.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map(match => match[1]);
      assert.deepEqual(columnHeaders.slice(0, 3), ['CHARGE CATEGORY', 'INTERNAL CODE', 'CONCEPT']);
    }
    for (let i = 1; i <= count; i++) {
      assert.equal((html.match(new RegExp(`>SPEC-${i}<`, 'g')) || []).length, 1);
    }
    assert.match(html, /\.rate-card-panel \+ \.rate-card-panel \{ break-before: page; page-break-before: always; \}/);
    assert.match(html, /thead \{ display: table-header-group;/);
  }
  ok('1–12 specifications split into at most 3 per panel with repeated descriptors and internal code in column 2');

  const special = card(4);
  special.rows[0].cells = {
    v0: { unitPrice: null, unitPriceMax: null, isAtCost: false },
    v1: { unitPrice: 0, unitPriceMax: null, isAtCost: false },
    v2: { unitPrice: 100, unitPriceMax: 200, isAtCost: false },
    v3: { unitPrice: null, unitPriceMax: null, isAtCost: true },
  };
  let html = await renderQuoteHtml(view({ rateCard: special }));
  let matrixTables = tables(html);
  const numericCells = (table) => [...table.matchAll(/<td class="num [^"]*">([^<]*)<\/td>/g)].map(match => match[1]);
  assert.deepEqual(numericCells(matrixTables[0]), ['—', '0.00', '100.00–200.00']);
  assert.deepEqual(numericCells(matrixTables[1]), ['AT COST']);
  special.rows[0].cells.v0 = { priceLabel: '—', offered: false, unitPrice: null };
  special.rows[0].cells.v1 = { priceLabel: '0.00', offered: true, unitPrice: 0 };
  html = await renderQuoteHtml(view({ rateCard: special }));
  assert.deepEqual(numericCells(tables(html)[0]), ['—', '0.00', '100.00–200.00']);
  const domainCard = buildRateCardView(special, 'mexico_only');
  assert.deepEqual(domainCard.errors, []);
  html = await renderQuoteHtml(view({ rateCard: domainCard }));
  assert.deepEqual(numericCells(tables(html)[0]), ['—', '0.00', '100.00–200.00']);
  assert.deepEqual(numericCells(tables(html)[1]), ['AT COST']);
  ok('blank, free, range and AT COST prices remain distinct, including the domain view labels');

  const malicious = card(1);
  malicious.variants[0].label = '<img src=x onerror=alert(1)>';
  for (const field of ['category', 'conceptEn', 'code', 'remark']) malicious.rows[0][field] = `<script>${field}</script>`;
  html = await renderQuoteHtml(view({ rateCard: malicious, outputAudience: 'internal' }));
  assert.doesNotMatch(body(html), /<script>|<img src=x/);
  assert.match(body(html), /&lt;img src=x onerror=alert\(1\)&gt;/);
  for (const field of ['category', 'conceptEn', 'code', 'remark']) assert.match(body(html), new RegExp(`&lt;script&gt;${field}&lt;\/script&gt;`));
  ok('editable specification labels, official codes, concepts and remarks are escaped');

  const sections = card(1);
  sections.rows.push({ ...sections.rows[0], id: 'contingent', conceptEn: 'Contingent service', chargeKind: 'contingent', currency: 'USD' });
  sections.rows.push({ ...sections.rows[0], id: 'foreign', conceptEn: 'Origin service', section: 'foreign' });
  sections.rows.push({ ...sections.rows[0], id: 'excluded', conceptEn: 'EXCLUDED-RATE', included: false });
  html = await renderQuoteHtml(view({ rateCard: sections }));
  assert.equal(tables(html).length, 3);
  assert.match(body(html), /CHARGES IF INCURRED/);
  assert.match(body(html), /NO MEXICO CHARGES/);
  assert.match(body(html), /MEXICO LOCAL CHARGES/);
  assert.match(body(html), /These unit rates apply only if the stated event occurs/);
  assert.doesNotMatch(body(html), /EXCLUDED-RATE|quotation subtotal|excluded from the subtotal/);
  assert.equal((body(html).match(/class="quantity">1</g) || []).length, 3);
  ok('fixed, contingent and geography sections preserve row currency, quantity and inclusion without misleading subtotal hints');

  for (const [language, expected] of [['ZH', '长期报价'], ['ES', 'Tarifario de largo plazo'], ['', 'Long-term rate card / 长期报价']]) {
    html = await renderQuoteHtml(view({ language }));
    assert.ok(body(html).includes(expected));
    assert.ok(body(html).includes(language === 'ES' ? 'Servicio matriz' : '矩阵服务'));
  }
  ok('long-term quotation type, matrix descriptors and rates support all output languages');

  for (const mode of ['FCL', 'LCL', 'BBK', 'AIR']) {
    const singleView = view({ quoteType: 'single', header: { cargoType: mode }, showTotals: false });
    html = await renderQuoteHtml(singleView);
    assert.match(html, /@page \{ size: A4;/);
    assert.match(body(html), /Single shipment/);
    assert.match(body(html), /SINGLE-CARGO-AUTO-CHARGE/);
    assert.match(body(html), /<td class="num">2<\/td>/);
    assert.match(body(html), /250.00/);
    assert.doesNotMatch(body(html), /class="rate-card-panel"|FORBIDDEN-|SINGLE-SECRET/);
    html = await renderQuoteHtml({ ...singleView, showTotals: true, outputAudience: 'internal' });
    assert.match(body(html), /FORBIDDEN-SUBTOTAL/);
    assert.match(body(html), /FORBIDDEN-FX/);
    assert.match(body(html), /SINGLE-SECRET/);
  }
  html = await renderQuoteHtml(view({ quoteType: undefined, header: { cargoType: 'FCL' }, showTotals: false }));
  assert.match(body(html), /Single shipment/);
  html = await renderQuoteHtml(view({ quoteType: undefined, header: { cargoType: 'FCL', quoteType: 'long_term' } }));
  assert.match(body(html), /Long-term rate card/);
  assert.doesNotMatch(body(html), /FORBIDDEN-/);
  ok('single shipments and legacy headers keep portrait layout, quantities, optional totals and audience behavior');

  console.log(`audit-quote-rate-card-pdf-test: ${passed} passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
