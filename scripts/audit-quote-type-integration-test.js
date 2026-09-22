// Single shipment vs long-term rate-card integration: isolated JSON runtime,
// real HTTP draft/admin routes, existing relational JSONB roundtrip. No live DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.STORAGE_DRIVER = 'json';
process.env.SKIP_FX_REFRESH = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-type-integration-'));
process.env.DATA_DIR = temp;
const { createApp } = require('../src/server');
const { BoundedSessionStore } = require('../src/lib/bounded-session-store');
const { getShippingData, normalizeShippingData } = require('../src/lib/store');
const { normalizeQuoteHeader } = require('../src/lib/store/normalize-quote');
const { buildQuoteFormData, assembleQuoteView } = require('../src/lib/views');
const { decompose, assemble } = require('../src/lib/db/relational-map');
const { renderQuoteHtml } = require('../src/lib/quote-pdf');
let passed = 0;
const ok = (name) => { passed++; console.log('  PASS ' + name); };
const card = () => ({
  variants: [{id:'gp20',label:'20GP'}, {id:'gp40',label:'40GP'}, {id:'hq40',label:'40HQ'}],
  rows: [{id:'preinspection',category:'CUSTOMS CLEARANCE',code:'CODE-QA',conceptEn:'Pre-inspection',conceptZh:'预检费',conceptEs:'Inspección',section:'mexico',chargeKind:'fixed',included:true,unitOfMeasure:'container',currency:'USD',remark:'QA ONLY',unit:999,
    cells:{gp20:{unitPrice:100},gp40:{unitPrice:200},hq40:{unitPrice:300}}}]
});
const singlePayload = {
  quoteFormPresent:'1',quoteType:'single',cargoType:'FCL',quotationNumber:'QA-TYPE',
  'cargo_containerType[]':['40HQ','20GP'],'cargo_containerQuantity[]':['3','5'],
  'cargo_containerPrice[]':['20','10'],'cargo_containerCurrency[]':['USD','USD'],
};
const bodyForView = (p) => Object.fromEntries(Object.entries(p).map(([k,v])=>[k.replace(/\[\]$/, ''),v]));
async function main() {
  const sessionStore = new BoundedSessionStore();
  let server;
  try {
    let data = await getShippingData();
    let quote = data.modules.quote;
    assert.equal(normalizeQuoteHeader({}).quoteType,'single');
    assert.equal(buildQuoteFormData(quote,{}).quoteType,'single');
    const original = buildQuoteFormData(quote,bodyForView(singlePayload));
    let view = assembleQuoteView(quote,original,data);
    assert.equal(view.subtotals.find(x=>x.currency==='USD').amount,110);
    assert.equal(view.cargoChargeRows[0].unit,3);
    assert.equal(view.cargoChargeRows[1].unit,5);
    ok('legacy/new single quote retains actual quantities and previous totals');

    const maps = Object.fromEntries(['FCL','LCL','BBK','AIR'].map(t=>[t,card()]));
    const longPayload = {...singlePayload,quoteType:'long_term',showTotals:'1',rateCardsByType:JSON.stringify(maps)};
    for (const type of ['FCL','LCL','BBK','AIR']) {
      const form = buildQuoteFormData(quote,bodyForView({...longPayload,cargoType:type}));
      view=assembleQuoteView(quote,form,data);
      assert.equal(view.quoteType,'long_term');
      assert.equal(view.showTotals,false);
      assert.equal(view.cargoCalculation.attempted,false);
      assert.equal(view.cargoChargeRows.length,0);
      assert.deepEqual(view.subtotals,[]);
      assert.equal(view.rateCard.rows[0].unit,1);
      assert.equal(view.rateCard.rows[0].cells.hq40.unitPrice,300);
      assert.deepEqual(view.rateCard.errors,[]);
    }
    const damagedSingle = buildQuoteFormData(quote,bodyForView({...longPayload,'cargo_containerPrice[]':['-5']}));
    assert.equal(assembleQuoteView(quote,damagedSingle,data).cargoCalculation.attempted,false);
    ok('all four long-term modes use quantity1, suppress summaries and ignore single automatic pricing');

    const form = buildQuoteFormData(quote,bodyForView(longPayload));
    quote.drafts=[{id:'roundtrip',number:'ROUNDTRIP',header:form.header,lineItems:form.lineItems,noteIds:[]}];
    const restored=normalizeShippingData(assemble(decompose(data))).modules.quote.drafts[0];
    assert.equal(restored.header.quoteType,'long_term');
    assert.equal(restored.header.cargoPricingByType.FCL.containers[0].quantity,3);
    assert.equal(restored.header.cargoPricingByType.FCL.containers[1].quantity,5);
    assert.equal(restored.header.rateCardsByType.BBK.rows[0].cells.gp40.unitPrice,200);
    assert.equal(restored.header.rateCardsByType.AIR.variants[2].label,'40HQ');
    ok('separate single and rate-card state survives existing relational JSONB normalization');

    server=createApp({sessionStore}).listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    async function request(url,body) {
      const values=new URLSearchParams();
      for(const[k,v]of Object.entries(body||{})) (Array.isArray(v)?v:[v]).forEach(x=>values.append(k,String(x)));
      const r=await fetch(base+url,body?{method:'POST',body:values}:{});
      return{status:r.status,text:await r.text()};
    }
    let r=await request('/workbench/quote',{...longPayload,action:'saveDraft'});
    assert.equal(r.status,200);
    let saved=(await getShippingData()).modules.quote.drafts.find(d=>d.number==='QA-TYPE');
    assert.ok(saved);
    assert.equal(saved.header.quoteType,'long_term');
    assert.equal(saved.header.cargoPricingByType.FCL.containers[0].quantity,3);
    r=await request('/workbench/quote?draft='+saved.id);
    assert.equal(r.status,200);
    assert.match(r.text,/rateCardsByType/);
    assert.match(r.text,/long_term/);
    const edited=card();edited.rows[0].cells.hq40.unitPrice=350;
    r=await request('/workbench/quote',{...longPayload,action:'saveDraft',draftId:saved.id,rateCardsByType:JSON.stringify({...maps,FCL:edited})});
    assert.equal(r.status,200);
    saved=(await getShippingData()).modules.quote.drafts.find(d=>d.id===saved.id);
    assert.equal(saved.header.rateCardsByType.FCL.rows[0].cells.hq40.unitPrice,350);
    assert.equal(saved.header.cargoPricingByType.FCL.containers[1].quantity,5);
    ok('real HTTP save/reopen/update preserves independent single quantities and rate-card cell edits');

    const defaults={...maps,FCL:card()};defaults.FCL.rows[0].cells.hq40.unitPrice=900;
    r=await request('/admin/quote/settings',{rateCardDefaultsPresent:'1',rateCardDefaults:JSON.stringify(defaults),hd_quoteType:'long_term',hd_cargoType:'FCL'});
    assert.equal(r.status,200);
    quote=(await getShippingData()).modules.quote;
    assert.equal(quote.settings.headerDefaults.quoteType,'long_term');
    assert.equal(quote.settings.rateCardDefaults.FCL.rows[0].cells.hq40.unitPrice,900);
    assert.equal(quote.drafts.find(d=>d.id===saved.id).header.rateCardsByType.FCL.rows[0].cells.hq40.unitPrice,350);
    const fresh=buildQuoteFormData(quote,{});
    assert.equal(fresh.quoteType,'long_term');
    assert.equal(fresh.rateCardsByType.FCL.rows[0].cells.hq40.unitPrice,900);
    const settingsRoundtrip=normalizeShippingData(assemble(decompose(await getShippingData()))).modules.quote.settings;
    assert.deepEqual(settingsRoundtrip.rateCardDefaults,quote.settings.rateCardDefaults);
    ok('admin presets/default quote type persist and affect only newly initialized quotations');

    const before=JSON.stringify(quote.settings);
    const bad=card();bad.variants[1].label='20GP';bad.rows[0].cells.gp20.unitPrice=-1;
    r=await request('/admin/quote/settings',{rateCardDefaultsPresent:'1',rateCardDefaults:JSON.stringify({FCL:bad}),quoteNumberPrefix:'SHOULD-NOT-SAVE'});
    assert.equal(r.status,400);
    assert.equal(JSON.stringify((await getShippingData()).modules.quote.settings),before);
    r=await request('/admin/quote/settings',{rateCardDefaultsPresent:'1',rateCardDefaults:'{broken'});
    assert.equal(r.status,400);
    assert.equal(JSON.stringify((await getShippingData()).modules.quote.settings),before);
    for (const malformed of [{rateCardDefaultsPresent:'1'}, {rateCardDefaultsPresent:'1',rateCardDefaults:['{}','{}']}]) {
      r=await request('/admin/quote/settings',malformed);
      assert.equal(r.status,400);
      assert.equal(JSON.stringify((await getShippingData()).modules.quote.settings),before);
    }
    r=await request('/workbench/quote',{...longPayload,action:'saveDraft',rateCardsByType:JSON.stringify({FCL:bad})});
    assert.equal(r.status,400);
    r=await request('/workbench/quote/pdf',{...longPayload,rateCardsByType:JSON.stringify({FCL:bad})});
    assert.equal(r.status,400);
    r=await request('/workbench/quote/pdf',{...longPayload,cargoType:''});
    assert.equal(r.status,400);
    ok('malformed/negative/duplicate rate cards fail atomically; invalid PDF never reaches rendering');

    r=await request('/workbench/quote',{...singlePayload,action:'saveDraft',draftId:saved.id,rateCardsByType:JSON.stringify({...maps,FCL:edited})});
    assert.equal(r.status,200);
    saved=(await getShippingData()).modules.quote.drafts.find(d=>d.id===saved.id);
    assert.equal(saved.header.quoteType,'single');
    assert.equal(saved.header.rateCardsByType.FCL.rows[0].cells.hq40.unitPrice,350);
    const reopened={...saved,draftId:saved.id,cargoPricing:saved.header.cargoPricing};
    const singleAgain=assembleQuoteView(quote,reopened,data);
    assert.equal(singleAgain.subtotals.find(x=>x.currency==='USD').amount,110);
    const html=await renderQuoteHtml(singleAgain);
    assert.match(html,/60.00/);assert.match(html,/50.00/);
    ok('switching back to single retains 3 and 5 quantities and the separate long-term prices');
    console.log(`quote-type-integration: ${passed}/${passed} passed`);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    sessionStore.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
