"use strict";
// Real browser regression with an isolated synthetic JSON store. Never reads a live DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-feedback-ui-'));
Object.assign(process.env, { STORAGE_DRIVER: 'json', DATABASE_URL: '', SKIP_FX_REFRESH: '1', DATA_DIR: temp });
const puppeteer = require('puppeteer');
const { createApp } = require('../src/server');
const { BoundedSessionStore } = require('../src/lib/bounded-session-store');
const { getShippingData, saveModule } = require('../src/lib/store');
const { closeQuoteBrowser } = require('../src/lib/quote-pdf');
const qa = process.env.QUOTE_FEEDBACK_QA_DIR;
const field = name => `[name="${name}"]`;

async function main() {
  const store = new BoundedSessionStore();
  let browser, server;
  try {
    const data = await getShippingData();
    data.modules.quote.drafts = [];
    data.modules.quote.settings.lastQuoteSeq = 0;
    data.modules.quote.notes = [
      { id: 'qa-tax', en: 'The above prices are exclusive of VAT. A 16% VAT will be added at invoicing.', zh: '上述价格均不含税，开票时另加16%增值税。' },
      { id: 'qa-terms', en: 'Demonstration only. No commercial commitment.', zh: '演示数据，不构成商业报价。' },
    ];
    await saveModule('quote', data);
    server = createApp({ sessionStore: store }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({headless:true, args:['--no-sandbox']});
    const page = await browser.newPage();
    await page.setViewport({width:1600,height:1100,deviceScaleFactor:1});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/workbench/quote?lang=zh',{waitUntil:'networkidle0'});
    const put = async (selector,value) => page.$eval(selector,(el,v)=>{ el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); },value);
    assert.equal(await page.$eval(field('taxTreatment'),el=>el.value),'mexico_included');
    assert.equal(await page.$eval(field('includeStamp'),el=>el.checked),true);
    assert.match(await page.$eval('[data-cargo-panel="FCL"]',el=>el.textContent).catch(()=>page.$eval('body',el=>el.textContent)),/每柜运输费/);
    await page.evaluate(()=>document.querySelectorAll('[data-quote-row]').forEach(el=>el.remove()));
    await page.click('[data-quote-add="fixed"]');
    const row='[data-quote-rows="fixed"] [data-quote-row]';
    await put(`${row} ${field('li_category[]')}`,'CUSTOMS CLEARANCE');
    await put(`${row} ${field('li_conceptEn[]')}`,'Trade Agency Service Fee');
    await put(`${row} ${field('li_conceptZh[]')}`,'贸易代理费');
    await put(`${row} ${field('li_uom[]')}`,'shipment');
    await put(`${row} ${field('li_unit[]')}`,'5');
    await put(`${row} ${field('li_currency[]')}`,'MXN');
    await put(`${row} [data-quote-price-type]`,'percentage');
    await put(`${row} [data-quote-percentage-rate]`,'8');
    await put(`${row} [data-quote-cargo-value]`,'100000');
    assert.match(await page.$eval(`${row} [data-quote-rowtotal]`,el=>el.textContent),/8,000\.00/);
    await put(`${row} [data-quote-cargo-value]`,'');
    assert.doesNotMatch(await page.$eval(`${row} [data-quote-rowtotal]`,el=>el.textContent),/^0(?:\.00)?$/);
    await put(`${row} [data-quote-cargo-value]`,'0');
    assert.match(await page.$eval(`${row} [data-quote-rowtotal]`,el=>el.textContent),/0\.00/);
    await put(`${row} [data-quote-cargo-value]`,'100000');
    await put(`${row} ${field('li_remark[]')}`,'QA edited remark');
    const id=await page.$eval(`${row} ${field('li_id[]')}`,el=>el.value);
    await page.click(`${row} [data-quote-remove]`);
    assert.equal(await page.$$eval(row,els=>els.length),0);
    await page.click('[data-quote-undo="fixed"]');
    assert.equal(await page.$eval(`${row} ${field('li_id[]')}`,el=>el.value),id);
    assert.equal(await page.$eval(`${row} ${field('li_remark[]')}`,el=>el.value),'QA edited remark');
    assert.equal(await page.$eval(`${row} [data-quote-cargo-value]`,el=>el.value),'100000');
    console.log('PASS browser percentage/blank/zero/no-quantity-multiply and exact undo');
    await put(field('customerCode'),'C001'); await put(field('salesCode'),'S02'); await put(field('revision'),'1');
    await page.$eval(field('showTotals'),el=>{el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});
    if(qa){
      fs.mkdirSync(qa,{recursive:true});
      await (await page.$(`${row} .quote-price-cell`)).screenshot({path:path.join(qa,'percentage-controls.png')}).catch(async()=>{await(await page.$(row)).screenshot({path:path.join(qa,'percentage-controls.png')});});
      await(await page.$('.quote-output-options')).screenshot({path:path.join(qa,'export-settings.png')});
    }
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('[name="action"][value="saveDraft"]')]);
    assert.equal(await page.$eval(field('customerCode'),el=>el.value),'C001');
    assert.equal(await page.$eval(`${row} [data-quote-percentage-rate]`,el=>el.value),'8');
    const drafts=(await getShippingData()).modules.quote.drafts;
    const draft=drafts.find(d=>d.header.customerCode==='C001');
    assert.ok(draft); assert.equal(draft.lineItems[0].cargoValue,100000);
    await page.goto(base+'/workbench/quote?draft='+encodeURIComponent(draft.id),{waitUntil:'networkidle0'});
    assert.equal(await page.$eval(field('salesCode'),el=>el.value),'S02');
    assert.equal(await page.$eval(`${row} [data-quote-price-type]`,el=>el.value),'percentage');
    const exportPdf=async()=>page.evaluate(async()=>{
      const form=document.querySelector('[data-quote-form]');
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      const response=await fetch('/workbench/quote/pdf',{method:'POST',body:new URLSearchParams(new FormData(form))});
      const array=new Uint8Array(await response.arrayBuffer());
      let binary=''; for(let i=0;i<array.length;i+=32768)binary+=String.fromCharCode(...array.subarray(i,i+32768));
      return {status:response.status,type:response.headers.get('content-type'),name:response.headers.get('content-disposition'),data:btoa(binary)};
    });
    const pdf=await exportPdf();
    assert.equal(pdf.status,200); assert.match(pdf.type,/application\/pdf/); assert.match(pdf.name,/C001-S02-\d+-v01\.pdf/);
    const repeat=await exportPdf(); assert.equal(repeat.name,pdf.name);
    assert.equal((await getShippingData()).modules.quote.settings.lastQuoteSeq,1);
    if(qa)fs.writeFileSync(path.join(qa,'quote-feedback-demo.pdf'),Buffer.from(pdf.data,'base64'));
    console.log('PASS native save/reopen and stable named PDF with sequence reserved once');
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    assert.ok(await page.$eval('body',el=>el.scrollWidth)<=392,'mobile document must not overflow outside scrolling tables');
    if(qa) await page.screenshot({path:path.join(qa,'mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS mobile containment and no browser runtime errors');
  } finally {
    if(browser)await browser.close();
    await closeQuoteBrowser();
    if(server)await new Promise(resolve=>server.close(resolve));
    store.shutdown?.();
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
