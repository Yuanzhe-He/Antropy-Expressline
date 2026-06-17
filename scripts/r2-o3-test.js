// Focused test for O3 (customs fixedCharges: basis / required / flat amount).
// Verifies normalizer back-compat + calc honoring. Run: node scripts/r2-o3-test.js
const assert = require("node:assert/strict");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const { getShippingData } = require("../src/lib/store");
const { computeCustomsCalculator } = require("../src/lib/calculate");
const { buildTranslator } = require("../src/lib/i18n");

async function main() {
  const t = buildTranslator("zh");
  const data = await getShippingData();
  const customs = data.modules.customs;
  const port = customs.ports[0];
  const terminal = port.terminals[0];
  const charge = terminal.fixedCharges[0];
  const containerType = customs.containerTypes[0];

  // (1) normalizer back-compat: seed charges had no basis/required/amount fields.
  assert.ok(["per_day", "per_occurrence"].includes(charge.basis), "basis defaulted");
  assert.equal(typeof charge.required, "boolean", "required defaulted to boolean");
  assert.ok(charge.amount === null || typeof charge.amount === "number", "amount nullable");
  assert.ok(["MXN", "USD"].includes(charge.amountCurrency), "amountCurrency defaulted");

  const baseForm = {
    priceMode: "pretax",
    quoteCurrency: "MXN",
    storageDays: 3,
    portId: port.id,
    terminalId: terminal.id,
    shippingLineId: customs.shippingLines?.[0]?.id,
    containerRows: [{ containerGroupKey: containerType.key, quantity: 1 }],
    taxOverrides: {},
    businessNature: "customs_only",
  };

  // (2) required: a charge with no groupRates and no amount still renders when required.
  charge.groupRates = {};
  charge.amount = null;
  charge.required = true;
  charge.basis = "per_occurrence";
  let res = computeCustomsCalculator(customs, baseForm, { exchangeRates: data.exchangeRates }, { t });
  let item = res.terminalFixed.items.find((i) => i.itemId === `customs:fixed:${charge.id}`);
  assert.ok(item, "required charge renders even with no parts");
  assert.equal(item.pretaxAmount, 0, "required-but-empty charge totals 0");

  // (3) flat amount (per_occurrence) adds a non-container fee.
  charge.amount = 100;
  charge.amountCurrency = "MXN";
  res = computeCustomsCalculator(customs, baseForm, { exchangeRates: data.exchangeRates }, { t });
  item = res.terminalFixed.items.find((i) => i.itemId === `customs:fixed:${charge.id}`);
  assert.equal(item.pretaxAmount, 100, "per_occurrence flat amount = 100");

  // (4) per_day multiplies the flat amount by storage days (3).
  charge.basis = "per_day";
  res = computeCustomsCalculator(customs, baseForm, { exchangeRates: data.exchangeRates }, { t });
  item = res.terminalFixed.items.find((i) => i.itemId === `customs:fixed:${charge.id}`);
  assert.equal(item.pretaxAmount, 300, "per_day flat amount × 3 days = 300");

  // (5) not-required + empty + no amount -> skipped.
  charge.amount = null;
  charge.required = false;
  charge.basis = "per_occurrence";
  res = computeCustomsCalculator(customs, baseForm, { exchangeRates: data.exchangeRates }, { t });
  item = res.terminalFixed.items.find((i) => i.itemId === `customs:fixed:${charge.id}`);
  assert.ok(!item, "non-required empty charge is skipped");

  console.log("r2-o3-test-ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
