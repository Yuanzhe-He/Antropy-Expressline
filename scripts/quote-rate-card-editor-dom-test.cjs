const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// Optional DOM test dependency; kept outside production package.json.
// QUOTE_DOM_MODULES=/path/to/node_modules node scripts/quote-rate-card-editor-dom-test.cjs
let JSDOM;
try { ({ JSDOM } = require(process.env.QUOTE_DOM_MODULES ? path.join(process.env.QUOTE_DOM_MODULES, 'jsdom') : 'jsdom')); }
catch (_) { console.error('This DOM regression requires jsdom. Set QUOTE_DOM_MODULES to its node_modules directory.'); process.exit(1); }
const repo = path.resolve(__dirname, '..');
process.chdir(repo);
const ejs = require(path.join(repo, 'node_modules/ejs'));
const base = { pageTitle:'Quote',currentPath:'',currentArea:'',currentModuleKey:'quote',currentModule:{},user:{},userRoleLabel:'',flash:null,lang:'zh',t:s=>s,languageOptions:[],languageReturnTo:'',modules:[], selectedModule:{title:'报价'},
  formData:{header:{cargoType:'FCL',extraFields:[]},cargoPricing:{containers:[],packages:[],currency:'USD'},cargoPricingByType:{FCL:{containers:[],packages:[],currency:'USD'}},number:'QA',date:'2026-09-20',quoteMode:'mexico_only',noteIds:[],pullInputs:{},language:''},
  quoteView:{editableRows:[{id:'custom',category:'TRANSPORTATION',unit:1,unitOfMeasure:'custom-unit',unitPrice:10,currency:'MXN',conceptZh:'测试',included:true,chargeKind:'fixed'}],subtotals:[]},
  quoteNotes:[],selectorData:{},feeCodes:[],categoryOptions:['SHIPPING LINE','TRANSPORTATION'],uomOptions:['container','bill'],headerOptions:{cargoType:['FCL','LCL','BBK','AIR'].map(code=>({code,label:code})),department:['OCEAN','AIR','INLAND'],transportMode:['SEA','AIR'],incoterm:[]},feeCurrencyDefaults:{TRANSPORTATION:'USD'},quoteTemplates:[],pricingRules:{LCL:{method:'raw_max'},BBK:{method:'volumetric',volumeDivisor:5000},AIR:{method:'manual'}},drafts:[{id:'draft-1',number:'Draft1',date:'2026-09-20'}],safeJson:x=>JSON.stringify(x).replace(/</g,'\\u003c') };
function render(data) {
 const html = ejs.render(fs.readFileSync('views/workbench-quote.ejs','utf8'), data, {filename:path.join(repo,'views/workbench-quote.ejs'),includer:(name,file)=>/partials\/(header|footer)$/.test(name)?{template:''}:{filename:file}});
 const dom = new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/workbench/quote'});
 for(const file of ['quote-pricing.js','quote-rate-card.js','quote-rate-card-editor.js','quote.js']) dom.window.eval(fs.readFileSync('public/'+file,'utf8'));
 return dom;
}
base.quoteTemplates=[{id:'ship-fee',enabled:true,appliesTo:['FCL','LCL','BBK','AIR'],category:'SHIPPING LINE',conceptZh:'船司费用',conceptEn:'Shipping fee',unitOfMeasure:'container',currency:'USD',unitPrice:999,defaultQuantity:9,section:'mexico',chargeKind:'fixed'}, {id:'if-fee',enabled:true,appliesTo:['FCL'],category:'PORT FEES',conceptZh:'或有费用',unitOfMeasure:'container',currency:'MXN',section:'mexico',chargeKind:'contingent'}];
const dom=render(base),w=dom.window,d=w.document,f=d.querySelector('[data-quote-form]');
const field=name=>f.querySelector(`[name="${name}"]`);
const enter=(el,value,event='input')=>{assert.ok(el);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event(event,{bubbles:true}));};
const input=(name,value,event='input')=>enter(field(name),value,event);
const card=()=>JSON.parse(field('rateCardsByType').value);
const matrix=()=>d.querySelector('#quote-rate-card');
const rateInput=(variant,kind='Price')=>matrix().querySelector(`[data-rate-cell-${kind.toLowerCase()}="${variant}"]`);
assert.deepEqual(card(),{},'single mode does not silently initialize rate cards');
input('li_unit[]','3');input('li_unitPrice[]','20');input('cargo_containerType[]','40HQ');input('cargo_containerQuantity[]','2');input('cargo_containerPrice[]','100');
input('quoteType','long_term','change');
assert.equal(d.querySelector('[data-cargo-panel="FCL"]').hidden,true);assert.equal(field('cargo_containerQuantity[]').disabled,true);
assert.equal(d.querySelector('[data-fee-section="fixed"]').hidden,true);assert.equal(field('li_unit[]').disabled,true);assert.equal(d.querySelector('[data-quote-long-term]').hidden,false);
assert.deepEqual(card().FCL.variants.map(v=>v.label),['20GP','40GP','40HQ']);
assert.equal(card().FCL.rows[0].cells['20GP'].unitPrice,null,'template price 999 must never fill variant price');
assert.equal(matrix().querySelectorAll('[data-rate-matrix="fixed"] tbody tr').length,1);assert.equal(matrix().querySelector('.quote-rate-quantity').textContent,'1');
enter(rateInput('20GP'),'100');enter(rateInput('40GP'),'200');enter(rateInput('40GP','Max'),'250');enter(rateInput('40HQ'),'0');
assert.equal(card().FCL.rows[0].cells['40HQ'].unitPrice,'0');
matrix().querySelector('[data-rate-add-variant]').click();let extra=card().FCL.variants.at(-1);enter(matrix().querySelector(`[data-rate-variant-label="${extra.id}"]`),'Custom 45');
enter(rateInput(extra.id,'Atcost'),true,'change');assert.equal(rateInput(extra.id).value,'AT COST');
assert.equal(card().FCL.rows[0].cells[extra.id].isAtCost,true);
let post=new w.FormData(f);assert.deepEqual(post.getAll('li_unit[]'),['3']);assert.deepEqual(post.getAll('li_unitPrice[]'),['20']);assert.equal(JSON.parse(post.get('cargoPricingByType')).FCL.containers[0].quantity,'2');
assert.ok(!post.has('cargo_containerQuantity[]'),'disabled single autocharge legacy fields not posted in long term');
input('cargoType','LCL','change');assert.equal(card().LCL.variants.length,1);assert.equal(card().LCL.rows[0].cells.standard.unitPrice,null);enter(rateInput('standard'),'500');
input('cargoType','FCL','change');assert.equal(rateInput('20GP').value,'100');assert.equal(rateInput('40HQ').value,'0');assert.equal(rateInput(extra.id).value,'AT COST');
input('quoteType','single','change');assert.equal(field('li_unit[]').value,'3');assert.equal(field('li_unit[]').disabled,false);assert.equal(field('cargo_containerQuantity[]').value,'2');assert.equal(field('cargo_containerPrice[]').value,'100');assert.equal(matrix().querySelector('input[data-rate-cell-price]').disabled,true);assert.equal(new w.FormData(f).getAll('li_unit[]').length,1);
input('quoteType','long_term','change');assert.equal(rateInput('20GP').value,'100');
enter(rateInput('20GP'),'-3');assert.equal(matrix().querySelector('[data-rate-card-errors]').hidden,false);input('quoteType','single','change');assert.equal(f.checkValidity(),true,'invalid matrix raw string never blocks a single quote');input('quoteType','long_term','change');enter(rateInput('20GP'),'110');assert.equal(matrix().querySelector('[data-rate-card-errors]').hidden,true);
const reopen=structuredClone({...base,t:undefined,safeJson:undefined});reopen.t=base.t;reopen.safeJson=base.safeJson;reopen.formData={...reopen.formData,header:{...reopen.formData.header,quoteType:'long_term'},quoteType:'long_term',cargoPricingByType:JSON.parse(field('cargoPricingByType').value),rateCardsByType:card()};reopen.rateCardDefaults={FCL:{variants:[{id:'new',label:'ADMIN CHANGED'}],rows:[]}};const re=render(reopen).window.document;assert.equal(re.querySelector('[data-rate-cell-price="20GP"]').value,'110','saved quote is snapshot not overwritten by changed admin defaults');
const adminHtml=ejs.render(fs.readFileSync('views/partials/quote-rate-card-editor.ejs','utf8'),{editorId:'admin-rate',language:'es',adminMode:true,value:{FCL:{variants:[{id:'a',label:'A'}],rows:[]}},defaults:{},templates:base.quoteTemplates,cargoType:'FCL'});const ad=new JSDOM('<form>'+adminHtml+'</form>',{runScripts:'outside-only'});ad.window.eval(fs.readFileSync('public/quote-rate-card.js','utf8'));ad.window.eval(fs.readFileSync('public/quote-rate-card-editor.js','utf8'));const ar=ad.window.document;
assert.equal(ar.querySelectorAll('[data-rate-row]').length,0,'explicit empty preset rows remain empty');assert.equal(ar.querySelector('[name="rateCardDefaultsPresent"]').value,'1');assert.ok(ar.querySelector('[name="rateCardDefaults"]'));ar.querySelector('[data-rate-add-row="fixed"]').click();let row=ar.querySelector('[data-rate-row]');row.querySelector('[data-rate-row-field="conceptEs"]').value='Cargo nuevo';row.querySelector('[data-rate-row-field="conceptEs"]').dispatchEvent(new ad.window.Event('input',{bubbles:true}));assert.equal(ad.window.QuoteRateCardEditors.get('admin-rate').validate().length,0);
console.log('PASS: single/rate-card isolation, all pricing cell kinds, Qty1, defaults only fresh, hidden legacy mirrors, switching and snapshot reload, editable independent admin presets.');

// Recovery is explicit: loading or switching never turns rejected data into a price.
const rateModel = require(path.join(repo, 'public/quote-rate-card.js'));
function mountAdmin(value) {
 const html=ejs.render(fs.readFileSync('views/partials/quote-rate-card-editor.ejs','utf8'),{editorId:'recovery-rate',language:'zh',adminMode:true,value,defaults:{},templates:[],cargoType:'FCL'});
 const runtime=new JSDOM('<form>'+html+'</form>',{runScripts:'outside-only'});
 for(const file of ['quote-rate-card.js','quote-rate-card-editor.js']) runtime.window.eval(fs.readFileSync('public/'+file,'utf8'));
 return {doc:runtime.window.document,win:runtime.window,api:runtime.window.QuoteRateCardEditors.get('recovery-rate')};
}
const validRow=(id='fee')=>({id,category:'SHIPPING LINE',conceptZh:'费用',section:'mexico',chargeKind:'fixed',included:true,currency:'USD',unitOfMeasure:'container',cells:{a:{unitPrice:12,unitPriceMax:null,isAtCost:false}}});
const rejected=mountAdmin({FCL:{variants:[{id:'a',label:'A'},{id:'b',label:'B'}],rows:[validRow()],validationErrors:['rows.0.cells.a.unitPrice:invalid_number','rows.0.cells.b:invalid_cell']}});
assert.equal(rejected.api.getValue().FCL.validationErrors.length,2);
let repairPrice=rejected.doc.querySelector('[data-rate-cell-price="a"]');repairPrice.value='15';repairPrice.dispatchEvent(new rejected.win.Event('input',{bubbles:true}));assert.deepEqual(Array.from(rejected.api.getValue().FCL.validationErrors),['rows.0.cells.b:invalid_cell']);rejected.doc.querySelector('[data-rate-remove-variant="b"]').click();assert.deepEqual(Array.from(rejected.api.getValue().FCL.validationErrors),[],'deleted variant clears both field errors and invalid_cell marker');
const badStructure=mountAdmin({FCL:rateModel.normalizeRateCard({variants:[{id:'a',label:'A'}],rows:'invalid'})});assert.ok(badStructure.api.validate().length);badStructure.doc.querySelector('[data-rate-card-errors] button').click();assert.equal(badStructure.api.validate().length,0);assert.equal(badStructure.api.getValue().FCL.rows.length,0);
const badCache=mountAdmin({FCL:{variants:[{id:'a',label:'A'}],rows:[validRow()]},_validationErrors:['rateCardsByType:invalid_json']});assert.ok(badCache.api.getValue()._validationErrors.length);badCache.doc.querySelector('[data-rate-card-errors] button').click();assert.equal(badCache.api.getValue()._validationErrors,undefined);assert.equal(badCache.api.getValue().FCL.rows.length,0);
const tooManyVariants=mountAdmin({FCL:rateModel.normalizeRateCard({variants:[null,...Array.from({length:12},(_,i)=>({id:'v'+i,label:'V'+i}))],rows:[]})});assert.equal(tooManyVariants.doc.querySelectorAll('[data-rate-invalid-variant]').length,1);tooManyVariants.doc.querySelector('[data-rate-invalid-variant] button').click();assert.equal(tooManyVariants.api.getValue().FCL.variants.length,12);assert.equal(tooManyVariants.api.validate().length,0);
const tooManyRows=mountAdmin({FCL:rateModel.normalizeRateCard({variants:[{id:'a',label:'A'}],rows:[null,...Array.from({length:100},(_,i)=>validRow('row-'+i))]})});assert.equal(tooManyRows.doc.querySelectorAll('[data-rate-invalid-row]').length,1);tooManyRows.doc.querySelector('[data-rate-invalid-row] button').click();assert.equal(tooManyRows.api.getValue().FCL.rows.length,100);assert.equal(tooManyRows.api.validate().length,0);
input('quoteType','single','change');field('showTotals').checked=true;input('quoteType','long_term','change');assert.equal(new w.FormData(f).get('showTotals'),'1','single summary preference survives long-term saves');assert.equal(d.querySelector('[name="showTotals"][type="checkbox"]').disabled,true);
const blankExport=render({...base,formData:{...base.formData,quoteType:'long_term'}});const blankForm=blankExport.window.document.querySelector('[data-quote-form]');const pdfButton=blankForm.querySelector('[formaction="/workbench/quote/pdf"]');const submit=new blankExport.window.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:pdfButton});blankForm.dispatchEvent(submit);assert.equal(submit.defaultPrevented,true,'empty matrix stops PDF export with visible errors');
console.log('PASS: rejected field/cell recovery, explicit corrupt-card/cache reset, safe over-limit null placeholders, preference preservation and empty-export feedback.');
