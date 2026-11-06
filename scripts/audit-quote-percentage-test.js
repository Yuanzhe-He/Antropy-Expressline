"use strict";

// Pure model regressions only: no store/database, network, PDF or generated files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const charge = require("../public/quote-charge-pricing");
const { computeQuoteTotals } = require("../src/lib/quote");
const { normalizeQuoteLineItem, normalizeQuoteHeader, normalizeQuoteModuleData } = require("../src/lib/store/normalize-quote");
const { normalizeQuoteFeeTemplates, upgradeQuoteFeeTemplates, validateQuoteFeeTemplates, NOVEMBER_QUOTE_FEE_TEMPLATES } = require("../src/lib/quote-config");
const rateCards = require("../public/quote-rate-card");

const freshModule = normalizeQuoteModuleData({});
assert.equal(JSON.stringify(normalizeQuoteModuleData(freshModule)), JSON.stringify(freshModule),
  "first-time default rate cards must be byte-idempotent for targeted cache writes");

const pct = (overrides = {}) => ({ priceType: "percentage", percentageRate: 8, cargoValue: 100000,
  unit: 25, unitPrice: "", unitPriceMax: null, isAtCost: false, currency: "MXN", included: true, ...overrides });

assert.equal(charge.calculateCharge(pct()).total, 8000, "percentage fee charges cargo value once, regardless of containers");
assert.equal(charge.calculateCharge(pct({ unit: "" })).total, 8000, "percentage does not require a quantity");
for (const blank of [undefined, null, "", "   "]) {
  const result = charge.calculateCharge(pct({ cargoValue: blank }));
  assert.equal(result.total, null); assert.equal(result.status, "pending");
  assert.equal(result.rateLabel, "8%");
}
assert.equal(charge.calculateCharge(pct({ cargoValue: 0 })).total, 0);
assert.equal(charge.calculateCharge(pct({ percentageRate: 0 })).total, 0);
assert.equal(charge.calculateCharge(pct({ percentageRate: "0.25", cargoValue: "1000" })).total, 2.5);
assert.equal(charge.calculateCharge(pct({ percentageRate: "" })).status, "pending");
for (const fields of [{ percentageRate: "8%" }, { cargoValue: "1,000" }, { cargoValue: -2 },
  { percentageRate: Infinity }, { isAtCost: true }, { unitPrice: "AT COST" }, { unitPriceMax: 0 },
  { cargoValue: 9e13, percentageRate: 200 }, { priceType: "bad" }]) {
  const result = charge.calculateCharge(pct(fields));
  assert.equal(result.status, "invalid", JSON.stringify(fields)); assert.equal(result.total, null);
  assert.ok(result.errors.length);
}
assert.equal(charge.calculateCharge({ unit: 3, unitPrice: 100 }).total, 300);
assert.equal(charge.calculateCharge({ unit: 3, unitPrice: 100, unitPriceMax: 200 }).totalMax, 600);
assert.equal(charge.calculateCharge({ unit: 3, unitPrice: "AT COST" }).status, "atcost");
for (const [value, expected] of [[1.005, 1.01], [10.075, 10.08], [2.675, 2.68]]) {
  assert.equal(charge.calculateCharge({ unit: 1, unitPrice: value }).total, expected);
}

const badSaved = normalizeQuoteLineItem(pct({ id: "bad", cargoValue: "not-a-value" }), "bad");
assert.equal(charge.calculateCharge(normalizeQuoteLineItem(badSaved, "bad")).status, "invalid", "invalid data cannot become a usable zero after roundtrip");
const saved = normalizeQuoteLineItem(pct({ id: "trade", cargoValue: 0 }), "trade");
assert.equal(saved.cargoValue, 0); assert.equal(saved.percentageRate, 8);
assert.equal(charge.calculateCharge(saved).total, 0);

const totals = computeQuoteTotals([pct(), pct({ chargeKind: "contingent" }), pct({ included: false }), pct({ cargoValue: "" })]);
assert.equal(totals.subtotals.find((row) => row.currency === "MXN").amount, 8000);
assert.equal(totals.rows[0].unitPriceLabel, "8%"); assert.equal(totals.rows[0].totalLabel, "8,000.00");
assert.equal(totals.rows[3].pricingStatus, "pending"); assert.equal(totals.rows[3].totalLabel, "—");

const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/quote-charge-pricing.js"), "utf8"), sandbox);
for (const input of [pct(), pct({ cargoValue: "" }), pct({ cargoValue: 0 }), pct({ unitPriceMax: 5 }), { unit: 2, unitPrice: 5 }]) {
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.QuoteChargePricing.calculateCharge(input))), JSON.parse(JSON.stringify(charge.calculateCharge(input))), "browser and server use identical charge math");
}

const oldCustom = { ...NOVEMBER_QUOTE_FEE_TEMPLATES[1], id: "custom-trade", enabled: false, unitPrice: 321,
  priceType: "amount", percentageRate: null, conceptEn: "Trade Agency Service Fee" };
const upgraded = upgradeQuoteFeeTemplates([oldCustom], 2);
assert.equal(upgraded.length, 3); assert.equal(upgraded[0].enabled, false); assert.equal(upgraded[0].unitPrice, 321);
assert.ok(!upgraded.some((row) => row.id === "trade-agency-service"));
assert.deepEqual(upgradeQuoteFeeTemplates(upgraded, 3), upgraded, "upgrade is idempotent");
assert.deepEqual(upgradeQuoteFeeTemplates([], 2), [], "explicitly emptied catalog stays empty");
assert.equal(upgradeQuoteFeeTemplates(upgraded.slice(0, 1), 3).length, 1, "post-upgrade deletions are not resurrected");
assert.equal(validateQuoteFeeTemplates(normalizeQuoteFeeTemplates(NOVEMBER_QUOTE_FEE_TEMPLATES)), "");
assert.equal(validateQuoteFeeTemplates([{ ...oldCustom, priceType: "percentage", percentageRate: "8%" }]), "invalid_fee_template_percentage");
const historic = normalizeQuoteModuleData({ settings: { feeTemplates: [oldCustom], feeTemplateConfigVersion: 2, rateCardDefaults: { FCL: { variants: [], rows: [] } } },
  drafts: [{ id: "historic", header: {}, lineItems: [{ id: "old", unit: 1, unitPrice: 12, currency: "MXN" }] }] });
assert.equal(historic.settings.feeTemplates.length, 3);
assert.equal(historic.drafts[0].lineItems.length, 1); assert.equal(historic.drafts[0].lineItems[0].unitPrice, 12);
assert.equal(historic.settings.rateCardDefaults.FCL.rows.length, 0, "existing empty rate card is not reseeded");

const card = { variants: [{ id: "standard", label: "Standard" }], rows: [{ id: "agency", category: "CUSTOMS CLEARANCE", section: "mexico", chargeKind: "fixed",
  conceptEn: "Agency", currency: "MXN", included: true, cells: { standard: { priceType: "percentage", percentageRate: 8 } } }] };
const cardView = rateCards.buildRateCardView(card, "mexico_only");
assert.deepEqual(cardView.errors, []); assert.equal(cardView.rows[0].cells.standard.priceLabel, "8%");
assert.equal(cardView.rows[0].cells.standard.offered, true); assert.ok(!("total" in cardView));
const zeroCard = JSON.parse(JSON.stringify(card)); zeroCard.rows[0].cells.standard.percentageRate = 0;
assert.equal(rateCards.buildRateCardView(zeroCard, "mexico_only").rows[0].cells.standard.priceLabel, "0%");
for (const conflict of [{ isAtCost: true }, { unitPriceMax: 100 }, { percentageRate: "8%" }]) {
  const invalid = JSON.parse(JSON.stringify(card)); Object.assign(invalid.rows[0].cells.standard, conflict);
  assert.ok(rateCards.buildRateCardView(invalid, "mexico_only").errors.length);
}

const header = normalizeQuoteHeader({ customerCode: "C001", salesCode: "S02", revision: 3, includeStamp: true, taxTreatment: "mexico_included", quoteEditorId: "test-editor-1" });
assert.equal(header.customerCode, "C001"); assert.equal(header.salesCode, "S02"); assert.equal(header.revision, 3);
assert.equal(header.includeStamp, true); assert.equal(header.taxTreatment, "mexico_included"); assert.equal(header.quoteEditorId, "test-editor-1");
const oldHeader = normalizeQuoteHeader({}); assert.equal(oldHeader.includeStamp, false); assert.equal(oldHeader.taxTreatment, "unspecified");
assert.equal(normalizeQuoteHeader({ customerCode: "../bad" }).customerCode, "");
console.log("audit-quote-percentage-test: passed (pure shared math, persistence, templates, rate cards and header compatibility)");
