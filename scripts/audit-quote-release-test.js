// Release contract: real quote form/draft routes + rendered PDF HTML, isolated
// JSON storage, no production writes, no database or network FX dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.STORAGE_DRIVER = 'json';
process.env.SKIP_FX_REFRESH = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-release-'));
process.env.DATA_DIR = temp;
const { createApp } = require('../src/server');
const { BoundedSessionStore } = require('../src/lib/bounded-session-store');
const { getShippingData, normalizeShippingData, saveModule } = require('../src/lib/store');
const { normalizeQuoteModuleData, normalizeQuoteHeader } = require('../src/lib/store/normalize-quote');
const { buildQuoteFormData, assembleQuoteView, selectQuoteNotes } = require('../src/lib/views');
const { renderQuoteHtml } = require('../src/lib/quote-pdf');
const { decompose, assemble } = require('../src/lib/db/relational-map');
const { historicalQuoteCargoType } = require('../src/lib/quote-workflow');

let passed = 0;
const ok = (s) => { passed++; console.log('  PASS ' + s); };
const all = ['FCL', 'LCL', 'BBK', 'AIR'];
const fee = {
  quoteFormPresent: '1', cargoType: 'LCL', quotationNumber: 'RELEASE-001',
  li_id: ['manual-release'], li_category: ['TRANSPORTATION'], li_code: ['OFFICIAL-TEST'],
  li_conceptEn: ['Transport'], li_conceptZh: ['运输'], li_unit: ['2'],
  li_uom: ['shipment'], li_unitPrice: ['925'], li_currency: ['USD'],
  li_appliesTo: [all.join(',')], li_included: ['1'], li_chargeKind: ['fixed'],
};
const states = {
  FCL: { containers: [{ containerType: '40HQ', quantity: 2, unitPrice: 100, currency: 'USD' }] },
  LCL: { method: 'manual', manualChargeable: 600, currency: 'USD', unitPrice: '' },
  BBK: { method: 'raw_max', packages: [{ weightKg: 200, weightCount: 9 }], currency: 'MXN', unitPrice: '' },
  AIR: { method: 'manual', manualChargeable: 120, unitPrice: 5, currency: 'USD' },
};

async function main() {
  const sessionStore = new BoundedSessionStore();
  let server;
  try {
    const data = await getShippingData();
    const quote = data.modules.quote;
    let form = buildQuoteFormData(quote, fee);
    let view = assembleQuoteView(quote, form, data);
    let html = await renderQuoteHtml(view);
    assert.equal(form.showTotals, false);
    assert.equal(form.outputAudience, 'customer');
    assert.doesNotMatch(html, /<div class="(?:subtotals|indicative|dual-totals)"/);
    assert.doesNotMatch(html, /OFFICIAL-TEST|INTERNAL CODE/);
    assert.match(html, /1,850.00/); // row amount stays visible
    ok('customer PDF defaults hide all aggregate blocks and official codes, preserving line prices');

    form = buildQuoteFormData(quote, { ...fee, showTotals: '1', taxTreatment: 'included' });
    view = assembleQuoteView(quote, form, data);
    html = await renderQuoteHtml(view);
    assert.match(html, /<div class="subtotals">/);
    assert.equal(view.subtotals[0].amount, 1850);
    assert.equal(view.dualTotals, null);
    assert.equal(view.indicative, null);
    assert.doesNotMatch(html, /2,146.00|<div class="dual-totals"/);
    assert.match(html, /Entered prices include tax/);
    ok('opt-in customer subtotal preserves entered tax-inclusive amount without extra VAT or FX');

    const conversionQuote = { ...quote, settings: { ...quote.settings, showIndicativeConversion: true, indicativeCurrency: 'MXN' } };
    const conversionData = { ...data, exchangeRates: { pairs: [{ base: 'USD', quote: 'MXN', rate: 20 }], asOfDate: '2026-09-20' } };
    for (const showTotals of ['', '1']) {
      const conversionView = assembleQuoteView(conversionQuote, buildQuoteFormData(conversionQuote, { ...fee, showTotals, taxTreatment: 'included' }), conversionData);
      assert.equal(conversionView.indicative.amount, 37000);
      assert.equal(conversionView.subtotals[0].amount, 1850);
      const conversionHtml = await renderQuoteHtml(conversionView);
      if (showTotals) {
        assert.match(conversionHtml, /<p class="indicative">/);
        assert.match(conversionHtml, /37,000.00/);
      } else assert.doesNotMatch(conversionHtml, /<p class="indicative">|37,000.00|<div class="subtotals">/);
    }
    ok('configured indicative conversion is opt-in with PDF totals and never changes original-currency tax-inclusive amounts');

    html = await renderQuoteHtml(assembleQuoteView(quote, buildQuoteFormData(quote, {
      ...fee, outputAudience: 'internal', li_code: ['OFFICIAL-<TEST>'],
    }), data));
    assert.match(html, /INTERNAL COPY/);
    assert.match(html, /OFFICIAL-&lt;TEST&gt;/);
    assert.ok(html.indexOf('CHARGE CATEGORY') < html.indexOf('INTERNAL CODE'));
    assert.ok(html.indexOf('INTERNAL CODE') < html.indexOf('>CONCEPT<'));
    assert.doesNotMatch(html, /<div class="subtotals">/);
    ok('internal export alone adds the escaped company code immediately after category');

    for (const type of ['LCL', 'BBK', 'AIR']) {
      const draft = buildQuoteFormData(quote, { ...fee, cargoType: type, cargo_weightKg: [600], cargoPricingByType: JSON.stringify(states) });
      assert.equal(assembleQuoteView(quote, draft, data).cargoCalculation.attempted, false);
      assert.equal(assembleQuoteView(quote, draft, data).subtotals[0].amount, 1850);
    }
    assert.deepEqual(selectQuoteNotes(quote.notes, []), []);
    ok('descriptive cargo without transport price does not block manually priced fees; deselecting all notes stays empty');

    form = buildQuoteFormData(quote, {
      ...fee, cargoType: 'AIR', showTotals: '1', outputAudience: 'internal', taxTreatment: 'included',
      cargoPricingByType: JSON.stringify(states), cargo_method: 'manual',
      cargo_manualChargeable: '120', cargo_unitPrice: '5', cargo_currency: 'USD',
    });
    data.modules.quote.drafts = [{ id: 'roundtrip', number: 'ROUNDTRIP', header: form.header, lineItems: form.lineItems, noteIds: [] }];
    const roundtrip = normalizeShippingData(assemble(decompose(data))).modules.quote.drafts[0];
    assert.deepEqual(roundtrip.header, normalizeQuoteHeader(form.header));
    assert.equal(roundtrip.header.cargoPricingByType.FCL.containers[0].quantity, 2);
    assert.equal(roundtrip.header.cargoPricingByType.LCL.manualChargeable, 600);
    assert.equal(roundtrip.header.cargoPricingByType.BBK.packages[0].weightCount, 9);
    assert.equal(roundtrip.header.cargoPricingByType.AIR.manualChargeable, 120);
    assert.equal(roundtrip.header.showTotals, true);
    assert.equal(roundtrip.header.taxTreatment, 'included');
    assert.equal(roundtrip.header.outputAudience, 'internal');
    ok('all mode states and PDF preferences survive the existing relational JSONB roundtrip');

    const legacyFee = { ...quote.settings.feeTemplates.find(r => r.id === 'delivery-order'), conceptEn: 'Delivery Order Fee', conceptZh: '船公司 LOCAL' };
    const migrate = normalizeQuoteModuleData({ settings: { cargoTypes: [{ code: 'FCL', label: '整柜', enabled: true }], cargoTypePolicyVersion: 1, feeTemplates: [legacyFee], feeTemplateConfigVersion: 1 } });
    assert.equal(migrate.settings.feeTemplates[0].conceptEn, 'Shipping line local charge');
    assert.deepEqual(migrate.settings.cargoTypes.map(r => r.code), ['FCL', 'AIR']);
    migrate.settings.feeTemplates[0].conceptEn = 'Delivery Order Fee';
    migrate.settings.cargoTypes = migrate.settings.cargoTypes.filter(r => r.code !== 'AIR');
    const again = normalizeQuoteModuleData(migrate);
    assert.equal(again.settings.feeTemplates[0].conceptEn, 'Delivery Order Fee');
    assert.deepEqual(again.settings.cargoTypes.map(r => r.code), ['FCL']);
    const noModes = normalizeQuoteModuleData({ settings: { cargoTypes: [] } });
    assert.deepEqual(noModes.settings.cargoTypes, []);
    const disabled = normalizeQuoteModuleData({ settings: { cargoTypes: [{code:'FCL',label:'FCL',enabled:true},{code:'AIR',label:'Air pending review',enabled:false}] } });
    assert.deepEqual(disabled.settings.cargoTypes[1], {code:'AIR',label:'Air pending review',enabled:false});
    ok('one-time defaults migration respects later edits, removed AIR, and explicitly empty lists');

    server = createApp({ sessionStore }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(url, body) {
      const encoded = new URLSearchParams();
      for (const [name, value] of Object.entries(body || {})) {
        if (Array.isArray(value)) value.forEach(v => encoded.append(name + '[]', String(v)));
        else encoded.append(name, String(value));
      }
      const response = await fetch(base + url, body ? { method: 'POST', body: encoded } : {});
      return { status: response.status, text: await response.text() };
    }
    const payload = { ...fee, action: 'saveDraft', cargoType: 'AIR', cargoPricingByType: JSON.stringify(states), cargo_method: 'manual', cargo_manualChargeable: '120', cargo_unitPrice: '5', cargo_currency: 'USD', showTotals: '1', outputAudience: 'internal', taxTreatment: 'included' };
    let response = await request('/workbench/quote', payload);
    assert.equal(response.status, 200);
    let saved = (await getShippingData()).modules.quote.drafts;
    const latest = saved.at(-1);
    response = await request('/workbench/quote?draft=' + encodeURIComponent(latest.id));
    assert.equal(response.status, 200);
    assert.match(response.text, /name="showTotals"[^>]*checked/);
    assert.match(response.text, /value="internal"[^>]*selected/);
    assert.match(response.text, /value="included"[^>]*selected/);
    assert.match(response.text, /name="cargo_manualChargeable"[^>]*value="120"/);
    assert.match(response.text, /name="draftId"[^>]*value="[^"]+"/);
    const count = saved.length;
    response = await request('/workbench/quote', { ...payload, draftId: latest.id, showTotals: '', outputAudience: 'customer' });
    assert.equal(response.status, 200);
    saved = (await getShippingData()).modules.quote.drafts;
    assert.equal(saved.length, count);
    assert.equal(saved.find(d => d.id === latest.id).header.showTotals, false);
    assert.equal(saved.find(d => d.id === latest.id).header.outputAudience, 'customer');
    ok('real HTTP draft create/reopen/update persists output choices and updates without duplicating');

    const changed = await getShippingData();
    changed.modules.quote.settings.cargoTypes.find(r => r.code === 'AIR').enabled = false;
    changed.modules.quote.drafts.push({id:'legacy-notes', number:'LEGACY-NOTES', header:{cargoType:'FCL'},lineItems:[],noteIds:[]});
    changed.modules.quote.drafts.push({
      id: 'legacy-ror', number: 'LEGACY-ROR', header: { cargoType: 'ROR', cargoTypeLabel: 'Historical ROR' },
      quoteMode: 'mexico_only', noteIds: [], lineItems: [
        { id: 'old-ror-fee', category: 'TRANSPORTATION', conceptEn: 'Historical vehicle fee', unit: 1, unitPrice: 100, currency: 'USD' },
        { id: 'old-ror-foreign', category: 'OCEAN FREIGHT', section: 'foreign', conceptEn: 'Foreign fee', unit: 1, unitPrice: 50, currency: 'USD' },
      ],
    });
    await saveModule('quote', changed);
    response = await request('/workbench/quote?draft=' + encodeURIComponent(latest.id));
    assert.match(response.text, /value="AIR"[^>]*selected/);
    assert.match(response.text, /已停用|历史/);
    const historical = buildQuoteFormData(changed.modules.quote, {...payload,draftId:latest.id});
    assert.equal(historical.header.cargoType, 'AIR');
    assert.equal(assembleQuoteView(changed.modules.quote,historical,changed).cargoChargeRows[0].unitPrice, 5);
    assert.equal(buildQuoteFormData(changed.modules.quote, payload).header.cargoType, '');
    response = await request('/workbench/quote?draft=legacy-notes');
    assert.match(response.text, /name="note_sel\[\]"[^>]*checked/);
    response = await request('/workbench/quote?draft=' + encodeURIComponent(latest.id));
    assert.doesNotMatch(response.text, /name="note_sel\[\]"[^>]*checked/);
    ok('disabled modes remain available only to their original draft; legacy versus explicitly cleared notes retain intent');

    response = await request('/workbench/quote?draft=legacy-ror');
    assert.equal(response.status, 200);
    assert.match(response.text, /value="ROR"[^>]*selected/);
    assert.match(response.text, /"historicalCargoType":"ROR"/);
    assert.match(response.text, /data-quote-subtotal-usd>100.00/);
    const historicalQuote = (await getShippingData()).modules.quote;
    const legacyDraft = historicalQuote.drafts.find(d => d.id === 'legacy-ror');
    const legacyView = assembleQuoteView(historicalQuote, { ...legacyDraft, draftId: legacyDraft.id }, data);
    assert.equal(legacyView.rows.length, 1, 'historical fallback keeps the quote geography filter');
    assert.equal(legacyView.rows[0].conceptEn, 'Historical vehicle fee');
    assert.equal(legacyView.subtotals[0].amount, 100);
    assert.match(await renderQuoteHtml(legacyView), /Historical ROR/);
    const legacyPayload = { ...fee, action: 'saveDraft', draftId: 'legacy-ror', cargoType: 'ROR', quotationNumber: 'LEGACY-ROR',
      li_id: ['old-ror-fee'], li_conceptEn: ['Historical vehicle fee'], li_unit: ['1'], li_unitPrice: ['100'], cargoPricingByType: '{}' };
    const legacyForm = buildQuoteFormData(historicalQuote, legacyPayload);
    assert.equal(legacyForm.header.cargoType, 'ROR');
    assert.ok(!Object.hasOwn(legacyForm.header.cargoPricingByType, 'ROR'), 'retired types do not contaminate the four-mode pricing state');
    assert.equal(assembleQuoteView(historicalQuote, legacyForm, data).subtotals[0].amount, 100);
    for (const forged of [
      { ...legacyPayload, draftId: '' },
      { ...legacyPayload, draftId: 'not-a-draft' },
      { ...legacyPayload, draftId: latest.id },
      { ...legacyPayload, cargoType: 'ARBITRARY', historicalCargoType: 'ARBITRARY' },
    ]) assert.equal(buildQuoteFormData(historicalQuote, forged).header.cargoType, '', 'new or mismatched retired types remain invalid');
    assert.equal(historicalQuoteCargoType(historicalQuote, 'not-a-draft'), '');
    const tamperedView = assembleQuoteView(historicalQuote, { ...legacyForm, draftId: 'not-a-draft', historicalCargoType: 'ROR' }, data);
    assert.equal(tamperedView.rows.length, 0, 'a forged form flag cannot bypass the verified draft lookup');
    response = await request('/workbench/quote', legacyPayload);
    assert.equal(response.status, 200);
    const persistedLegacy = (await getShippingData()).modules.quote.drafts.find(d => d.id === 'legacy-ror');
    assert.equal(persistedLegacy.header.cargoType, 'ROR');
    assert.equal(persistedLegacy.lineItems[0].unitPrice, 100);
    assert.deepEqual(persistedLegacy.header.cargoPricingByType, {});
    response = await request('/workbench/quote?draft=legacy-ror');
    assert.match(response.text, /data-quote-subtotal-usd>100.00/);
    ok('retired ROR draft fees survive reopen/save/PDF while new, forged and mismatched retired types get no exception');
    console.log(`audit-quote-release-test: ${passed}/${passed} passed`);
  } finally {
    if (server) { server.closeIdleConnections?.(); await new Promise(resolve => server.close(resolve)); }
    sessionStore.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
