// November feedback: real isolated HTTP save/export routes, template rendering,
// naming, percentage roundtrips and tax/stamp scope. No live DB or network FX.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
process.env.STORAGE_DRIVER = "json";
process.env.SKIP_FX_REFRESH = "1";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quote-feedback-export-"));
process.env.DATA_DIR = temp;
const pdfModule = require("../src/lib/quote-pdf");
const renderHtml = pdfModule.renderQuoteHtml;
// Browser rendering is tested separately; exercise numbering and storage without
// a browser lifecycle or any disk/network output from the route renderer.
pdfModule.renderQuotePdf = async () => Buffer.from("%PDF-1.4 synthetic-test");
const { createApp } = require("../src/server");
const { BoundedSessionStore } = require("../src/lib/bounded-session-store");
const { getShippingData } = require("../src/lib/store");
const { normalizeQuoteHeader } = require("../src/lib/store/normalize-quote");
const { buildQuoteFormData, assembleQuoteView } = require("../src/lib/views");
const { buildQuoteFilename, filterTaxNotes, validateQuoteNaming, resolveQuoteNumber } = require("../src/lib/quote-export");
let count = 0;
const ok = (message) => { count++; console.log("  PASS " + message); };
const payload = {
  quoteFormPresent: "1", quoteType: "single", cargoType: "FCL", quoteLang: "EN",
  customerCode: "C001", salesCode: "S02", revision: "1", includeStamp: "1", taxTreatment: "mexico_included",
  li_id: ["test-agency"], li_category: ["CUSTOMS CLEARANCE"], li_conceptEn: ["Trade Agency Service Fee"],
  li_section: ["mexico"], li_chargeKind: ["fixed"], li_included: ["1"],
  li_unit: ["77"], li_uom: ["shipment"], li_unitPrice: [""], li_currency: ["USD"],
  li_priceType: ["percentage"], li_percentageRate: ["8"], li_cargoValue: ["10000"],
};

async function main() {
  const sessions = new BoundedSessionStore();
  let server;
  try {
    let data = await getShippingData();
    const quote = data.modules.quote;
    const fresh = buildQuoteFormData(quote, {});
    assert.equal(fresh.includeStamp, true);
    assert.equal(fresh.taxTreatment, "mexico_included");
    const historical = normalizeQuoteHeader({});
    assert.equal(historical.includeStamp, false);
    assert.equal(historical.taxTreatment, "unspecified");
    ok("fresh defaults apply only to new quotes, with historical stamp/tax preserved");

    let form = buildQuoteFormData(quote, payload);
    let view = assembleQuoteView(quote, form, data);
    assert.equal(view.rows[0].total, 800);
    assert.equal(view.rows[0].unitPriceLabel, "8%");
    assert.equal(view.rows[0].unit, 77);
    assert.equal(view.subtotals[0].amount, 800);
    let html = await renderHtml(view);
    assert.match(html, /8%/);
    assert.match(html, /Goods value: 10,000 USD/);
    assert.match(html, /Mexico segment include applicable Mexican VAT/);
    assert.equal((html.match(/class="company-stamp"/g) || []).length, 1);
    assert.match(html, /<td class="num">1<\/td>/);
    ok("percentage is charged once and exports its base, scope and one supplied stamp");

    form = buildQuoteFormData(quote, { ...payload, li_cargoValue: [""], showTotals: "1" });
    view = assembleQuoteView(quote, form, data);
    assert.equal(view.pendingPercentage, true);
    assert.equal(view.rows[0].total, null);
    html = await renderHtml(view);
    assert.match(html, /Pending/);
    assert.match(html, /not the complete final amount/);
    assert.doesNotMatch(html, /FIXED SUBTOTAL: <b>0.00/);
    ok("missing goods value remains pending and cannot masquerade as a complete zero subtotal");

    const notes = [
      { id: "old", en: "All prices exclude VAT. 16% VAT is added at invoicing.", zh: "上述价格均不含税，另加16% VAT。" },
      { id: "old-included", en: "All prices include VAT." },
      { id: "insurance", en: "The transport fee excludes cargo insurance. Insurance is 0.25% plus 16% VAT." },
    ];
    assert.deepEqual(filterTaxNotes(notes, "mexico_included").map((n) => n.id), ["insurance"]);
    const mixedTax = filterTaxNotes([{ en: "Prices are shown in two currencies: MXN prices exclude VAT; USD prices include 16% VAT." }], "excluded");
    assert.doesNotMatch(mixedTax.map((note) => note.en).join(" "), /USD prices include/);
    const foreign = "Origin prices exclude local taxes.";
    const insurance = "Our prices exclude insurance. Insurance is available at 0.25% plus VAT.";
    assert.equal(filterTaxNotes([{ en: foreign }], "mexico_included")[0].en, foreign);
    assert.equal(filterTaxNotes([{ en: insurance }], "mexico_included")[0].en, insurance);
    assert.equal(filterTaxNotes([{ en: "All prices exclude VAT. Insurance is available at 0.25% plus VAT. Payment is due in 30 days." }], "mexico_included")[0].en, "Insurance is available at 0.25% plus VAT. Payment is due in 30 days.");
    assert.equal(notes.length, 3);
    assert.equal(filterTaxNotes(notes, "unspecified"), notes);
    assert.deepEqual(filterTaxNotes(notes, "excluded").map((n) => n.id), ["old", "insurance"]);
    ok("explicit tax scope filters contradictory blanket clauses without deleting saved notes or insurance terms");

    assert.equal(buildQuoteFilename({ number: "ELCMEX-SI-007E", header: { customerCode: "C001", salesCode: "S02", revision: 2 } }), "C001-S02-007-v02.pdf");
    assert.equal(buildQuoteFilename({ number: "Legacy quote", header: {} }), "Legacy_quote.pdf");
    assert.ok(validateQuoteNaming({ customerCode: "../bad", salesCode: "S02", revision: 1 }).length);
    const occupied = { settings: { lastQuoteSeq: 4 }, drafts: [{ id: "earlier", number: "ELCMEX-SI-005E" }, { id: "future", number: "ELCMEX-SI-006E" }] };
    const next = resolveQuoteNumber(occupied, { header: {}, draftId: "" }, { quotationNumber: "ELCMEX-SI-005E", quoteNumberSuggestion: "ELCMEX-SI-005E" });
    assert.equal(next.number, "ELCMEX-SI-007E");
    assert.equal(next.advanceTo, 7);
    assert.equal(resolveQuoteNumber(occupied, { header: {}, draftId: "" }, { quotationNumber: "ELCMEX-SI-006E" }).error, "duplicate_number");
    ok("structured filenames preserve legacy fallback, reject unsafe codes and skip occupied automatic serials");

    const card = { variants: [{ id: "hq40", label: "40HQ" }], rows: [{ id: "agency", category: "CUSTOMS CLEARANCE", conceptEn: "Agency", section: "mexico", chargeKind: "fixed", included: true, unitOfMeasure: "shipment", currency: "USD", cells: { hq40: { priceType: "percentage", percentageRate: 8 } } }] };
    form = buildQuoteFormData(quote, { ...payload, quoteType: "long_term", rateCardsByType: JSON.stringify({ FCL: card }) });
    view = assembleQuoteView(quote, form, data);
    assert.deepEqual(view.rateCard.errors, []);
    html = await renderHtml(view);
    assert.match(html, /8%/);
    assert.match(html, /Percentage of the entered commercial-invoice goods value/);
    assert.doesNotMatch(html, /class="subtotals"/);
    ok("long-term percentage alternatives export descriptive rates without shipment totals");

    server = createApp({ sessionStore: sessions }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function post(route, fields) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) (Array.isArray(value) ? value : [value]).forEach((v) => params.append(Array.isArray(value) ? `${key}[]` : key, String(v)));
      const response = await fetch(base + route, { method: "POST", body: params });
      return { status: response.status, filename: response.headers.get("content-disposition"), text: await response.text() };
    }
    const editorA = randomUUID(), editorB = randomUUID();
    const suggestion = fresh.number;
    const fields = { ...payload, quotationNumber: suggestion, quoteNumberSuggestion: suggestion, action: "saveDraft" };
    const seqBefore = Number(quote.settings.lastQuoteSeq || 0);
    const results = await Promise.all([
      post("/workbench/quote", { ...fields, quoteEditorId: editorA }),
      post("/workbench/quote", { ...fields, quoteEditorId: editorB }),
    ]);
    results.forEach((result) => assert.equal(result.status, 200));
    data = await getShippingData();
    const savedA = data.modules.quote.drafts.find((draft) => draft.header.quoteEditorId === editorA);
    const savedB = data.modules.quote.drafts.find((draft) => draft.header.quoteEditorId === editorB);
    assert.ok(savedA && savedB);
    assert.notEqual(savedA.number, savedB.number);
    assert.equal(data.modules.quote.settings.lastQuoteSeq, seqBefore + 2);
    assert.equal(savedA.lineItems[0].percentageRate, 8);
    assert.equal(savedA.lineItems[0].cargoValue, 10000);
    assert.equal(savedA.header.customerCode, "C001");
    assert.equal(savedA.header.includeStamp, true);
    ok("two simultaneous editors with the same suggestion receive different persisted numbers");

    const exportFields = { ...fields, quoteEditorId: editorB };
    const pdf1 = await post("/workbench/quote/pdf", exportFields);
    const pdf2 = await post("/workbench/quote/pdf", exportFields);
    assert.equal(pdf1.status, 200);
    assert.equal(pdf1.filename, pdf2.filename);
    assert.match(pdf1.filename, /C001-S02-\d+-v01.pdf/);
    const pdfRevision = await post("/workbench/quote/pdf", { ...exportFields, revision: "2" });
    assert.equal(pdfRevision.status, 200);
    assert.equal(pdfRevision.filename, pdf1.filename.replace("v01", "v02"));
    assert.equal((await getShippingData()).modules.quote.settings.lastQuoteSeq, seqBefore + 2);
    ok("same-editor re-export preserves serial/version; explicit revision changes only vNN");

    assert.equal((await post("/workbench/quote/pdf", { ...exportFields, customerCode: "../bad" })).status, 400);
    const rejected = await post("/workbench/quote/pdf", { ...exportFields, li_percentageRate: ["8%"] });
    assert.equal(rejected.status, 400);
    assert.match(rejected.text, /name="li_percentageRate\[\]" value="8%"/);
    assert.match(rejected.text, /name="li_pricingErrors\[\]" value="[^"]*percentageRate:invalid_number/);
    // Persisted normalized errors are retained even when the raw number is no
    // longer available. Untouched resubmission must not become a valid blank.
    const retained = JSON.stringify(["percentageRate:invalid_number"]);
    assert.equal((await post("/workbench/quote/pdf", { ...exportFields, li_percentageRate: [""], li_pricingErrors: [retained] })).status, 400);
    assert.equal((await post("/workbench/quote/pdf", { ...exportFields, li_pricingErrors: ["not json"] })).status, 400);
    assert.equal((await post("/workbench/quote", { ...exportFields, action: "saveDraft", li_percentageRate: [""], li_pricingErrors: [retained] })).status, 200);
    const retainedDraft = (await getShippingData()).modules.quote.drafts.find((draft) => draft.header.quoteEditorId === editorB);
    assert.deepEqual(retainedDraft.lineItems[0].pricingErrors, ["percentageRate:invalid_number"]);
    const reopened = await fetch(base + "/workbench/quote?draft=" + retainedDraft.id);
    assert.match(await reopened.text(), /name="li_pricingErrors\[\]" value="[^"]*percentageRate:invalid_number/);
    assert.equal((await post("/workbench/quote/pdf", { ...exportFields, li_percentageRate: ["8"], li_pricingErrors: ["[]"] })).status, 200);
    assert.equal((await post("/workbench/quote/pdf", { ...exportFields, li_cargoValue: [""] })).status, 200);
    assert.equal((await post("/workbench/quote", { ...fields, quoteEditorId: randomUUID(), quotationNumber: savedA.number, quoteNumberSuggestion: "" })).status, 400);
    ok("invalid naming/pricing/duplicate number blocked; rate-only pending export remains supported");
    console.log(`quote-feedback-export: ${count} checks passed`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    sessions.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
