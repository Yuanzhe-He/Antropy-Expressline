// Pure domain/persistence contracts for independent long-term rate matrices.
// No production DB, server, browser, credentials, or filesystem writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const rates = require("../public/quote-rate-card");
const { normalizeQuoteHeader, normalizeQuoteModuleData } = require("../src/lib/store/normalize-quote");
const { normalizeShippingData } = require("../src/lib/store");
const { decompose, assemble } = require("../src/lib/db/relational-map");
const { normalizeQuoteType, normalizeRateCard, normalizeRateCardsByType, parseRateCardsByType,
  createDefaultRateCard, validateRateCard, validateRateCardsByType, buildRateCardView } = rates;
let checks = 0;
function test(name, fn) { fn(); checks += 1; console.log(`PASS ${name}`); }
const cell = (unitPrice, unitPriceMax = null, isAtCost = false) => ({ unitPrice, unitPriceMax, isAtCost });
const row = (id, cells, patch = {}) => ({
  id, category: "SHIPPING LINE", code: "OFFICIAL", conceptEn: "Handling", conceptZh: "操作费", conceptEs: "Manejo",
  section: "mexico", chargeKind: "fixed", included: true, currency: "USD", unitOfMeasure: "container", remark: "Agreed rate", cells, ...patch,
});
const card = (patch = {}) => ({ variants: [{ id: "20GP", label: "20GP" }, { id: "40GP", label: "40GP" }, { id: "40HQ", label: "40HQ" }],
  rows: [row("local", { "20GP": cell(null), "40GP": cell(0), "40HQ": cell(100, 150) }), row("at-cost", { "20GP": cell(null, null, true) })], ...patch });

test("legacy quotes remain single independently of geography and cargo type", () => {
  assert.equal(normalizeQuoteType(), "single");
  assert.equal(normalizeQuoteType("long_term"), "long_term");
  assert.equal(normalizeQuoteType("long_term;total=all"), "single");
  for (const cargoType of ["FCL", "LCL", "BBK", "AIR"]) {
    assert.equal(normalizeQuoteHeader({ cargoType }).quoteType, "single");
    assert.equal(normalizeQuoteHeader({ cargoType, quoteType: "long_term" }).quoteType, "long_term");
  }
});

test("blank, zero, ranges and AT COST remain distinct per variant", () => {
  const normalized = normalizeRateCard(card());
  assert.deepEqual(validateRateCard(normalized), []);
  const view = buildRateCardView(normalized, "mexico_only");
  assert.deepEqual(view.errors, []);
  assert.equal(view.rows[0].cells["20GP"].priceLabel, "—");
  assert.equal(view.rows[0].cells["20GP"].offered, false);
  assert.equal(view.rows[0].cells["40GP"].priceLabel, "0.00");
  assert.equal(view.rows[0].cells["40GP"].offered, true);
  assert.equal(view.rows[0].cells["40HQ"].priceLabel, "100.00–150.00");
  assert.equal(view.rows[1].cells["20GP"].priceLabel, "AT COST");
  assert.ok(view.rows.every((entry) => entry.unit === 1));
  for (const key of ["total", "subtotals", "indicative", "dualTotals"]) assert.equal(view[key], undefined);
  assert.ok(view.rows.every((entry) => entry.total === undefined));
});

test("malicious purchase quantities never multiply long-term prices", () => {
  const input = card({ rows: [row("huge-quantity", { "20GP": cell(200) }, { unit: 999999, quantity: 999999, subtotal: 999999 })] });
  const normalized = normalizeRateCard(input);
  assert.equal(normalized.rows[0].unit, undefined);
  const view = buildRateCardView(normalized, "mexico_only");
  assert.equal(view.rows[0].unit, 1);
  assert.equal(view.rows[0].cells["20GP"].priceLabel, "200.00");
  assert.equal(view.rows[0].subtotal, undefined);
});

test("geography and inclusion filter rates; contingent rows remain separate with no totals", () => {
  const input = card({ rows: [
    row("local", { "20GP": cell(10) }),
    row("foreign", { "20GP": cell(20) }, { section: "foreign", category: "OCEAN FREIGHT" }),
    row("contingent", { "20GP": cell(30, 50) }, { chargeKind: "contingent" }),
    row("excluded", { "20GP": cell(500) }, { included: false }),
  ] });
  assert.deepEqual(buildRateCardView(input, "mexico_only").rows.map((entry) => entry.id), ["local", "contingent"]);
  const all = buildRateCardView(input, "ocean_mexico");
  assert.deepEqual(all.rows.map((entry) => entry.id), ["local", "foreign", "contingent"]);
  assert.equal(all.chargeSections.find((section) => section.chargeKind === "contingent").sections[0].groups[0].items[0].id, "contingent");
});

test("drafts may be blank but export needs an offered included in-scope cell", () => {
  assert.deepEqual(validateRateCard({ variants: [], rows: [] }), []);
  const blank = createDefaultRateCard("FCL", []);
  assert.deepEqual(validateRateCard(blank), []);
  assert.ok(validateRateCard(blank, { forExport: true }).includes("rows:at_least_one_offered_cell_required"));
  const onlyForeign = card({ rows: [row("foreign", { "20GP": cell(1) }, { section: "foreign" })] });
  assert.ok(buildRateCardView(onlyForeign, "mexico_only").errors.length);
  assert.deepEqual(buildRateCardView(onlyForeign, "ocean_mexico").errors, []);
  const excluded = card({ rows: [row("excluded", { "20GP": cell(1) }, { included: false })] });
  assert.ok(buildRateCardView(excluded, "ocean_mexico").errors.length);
});

test("negative, nonfinite, malformed and reversed prices retain rejection across repeated normalization", () => {
  for (const invalid of [cell(-1), cell(Infinity), cell("not a number"), cell(100, 99), cell(null, 100), cell(Number.MAX_SAFE_INTEGER)]) {
    let value = card({ rows: [row("invalid", { "20GP": invalid })] });
    for (let round = 0; round < 3; round += 1) {
      value = normalizeRateCard(value);
      assert.ok(validateRateCard(value).length);
      assert.ok(buildRateCardView(value, "mexico_only").errors.length);
    }
  }
  assert.equal(buildRateCardView(card({ rows: [row("small", { "20GP": cell(0.000000001) })] }), "mexico_only").rows[0].cells["20GP"].priceLabel, "1e-9");
});

test("safe identifiers, unique labels, known cell columns and row currencies are enforced", () => {
  const inputs = [
    card({ variants: [{ id: "x", label: "Size" }, { id: "x", label: "Other" }] }),
    card({ variants: [{ id: "x", label: "Size" }, { id: "y", label: " size " }] }),
    card({ variants: [{ id: "constructor", label: "Unsafe" }] }),
    card({ variants: [{ id: "toString", label: "Unsafe" }] }),
    card({ rows: [row("same", {}), row("same", {})] }),
    card({ rows: [row("bad-id[]", {})] }),
    card({ rows: [row("unknown-col", { unknown: cell(1) })] }),
    card({ rows: [row("bad-currency", { "20GP": cell(1) }, { currency: "EUR" })] }),
    card({ rows: [row("blank-name", {}, { conceptEn: "", conceptZh: "", conceptEs: "" })] }),
    JSON.parse('{"variants":[{"id":"20GP","label":"20GP"}],"rows":[],"__proto__":{"polluted":true}}'),
  ];
  for (const value of inputs) assert.ok(validateRateCard(value).length);
  assert.equal({}.polluted, undefined);
});

test("over-limit rows and columns are preserved for explicit deletion and never partially exported", () => {
  for (const value of [
    card({ variants: Array.from({ length: 13 }, (_, index) => ({ id: `v${index}`, label: `Size ${index}` })) }),
    card({ rows: Array.from({ length: 101 }, (_, index) => row(`row-${index}`, {})) }),
  ]) {
    const normalized = normalizeRateCard(value);
    assert.equal(normalized.variants.length, value.variants.length);
    assert.equal(normalized.rows.length, value.rows.length);
    assert.ok(validateRateCard(normalized).length);
    const view = buildRateCardView(normalized, "ocean_mexico");
    assert.equal(view.rows.length, 0);
    assert.ok(view.errors.length);
  }
});

test("JSON parser rejects malformed shape, extra types, prototype keys and UTF-8 over 1 MiB", () => {
  for (const value of [null, {}, "{", "null", "[]", "3", '{"OTHER":{}}', '{"__proto__":{}}']) {
    assert.ok(parseRateCardsByType(value)._validationErrors?.length);
  }
  const oversizedUnicode = JSON.stringify({ FCL: { variants: [], rows: [], note: "中".repeat(350000) } });
  assert.ok(oversizedUnicode.length < 1024 * 1024);
  assert.deepEqual(parseRateCardsByType(oversizedUnicode)._validationErrors, ["rateCardsByType:too_large"]);
  assert.deepEqual(parseRateCardsByType(undefined), {});
});

test("all four rate cards stay independent and ordinary inactive cell errors do not become global corruption", () => {
  const input = Object.fromEntries(["FCL", "LCL", "BBK", "AIR"].map((type, index) => [type, card({ rows: [row(type, { "20GP": cell(index + 1) })] })]));
  input.BBK.rows[0].cells["20GP"].unitPrice = -1;
  const normalized = normalizeRateCardsByType(input);
  assert.equal(normalized._validationErrors, undefined);
  assert.ok(validateRateCardsByType(normalized).some((error) => error.startsWith("BBK.")));
  assert.deepEqual(buildRateCardView(normalized.AIR, "mexico_only").errors, []);
  assert.equal(buildRateCardView(normalized.AIR, "mexico_only").rows[0].cells["20GP"].unitPrice, 4);
  assert.deepEqual(normalizeRateCardsByType(JSON.parse(JSON.stringify(normalized))), normalized);
});

test("defaults copy only eligible metadata and never replicate a template price across specifications", () => {
  const templates = [
    { ...row("active", {}), enabled: true, appliesTo: ["FCL"], unitPrice: 500, unitPriceMax: 700, isAtCost: true },
    { ...row("disabled", {}), enabled: false, appliesTo: ["FCL"] },
    { ...row("air-only", {}), enabled: true, appliesTo: ["AIR"] },
  ];
  const fcl = createDefaultRateCard("FCL", templates);
  assert.deepEqual(fcl.variants.map((entry) => entry.label), ["20GP", "40GP", "40HQ"]);
  assert.deepEqual(fcl.rows.map((entry) => entry.id), ["active"]);
  assert.ok(Object.values(fcl.rows[0].cells).every((entry) => entry.unitPrice === null && entry.unitPriceMax === null && !entry.isAtCost));
  assert.equal(fcl.rows[0].code, "OFFICIAL");
  for (const type of ["LCL", "BBK", "AIR"]) assert.equal(createDefaultRateCard(type, templates).variants.length, 1);
});

test("settings defaults and saved rate matrices remain independent snapshots and explicit empty rows stay empty", () => {
  const initial = normalizeQuoteModuleData({ settings: { headerDefaults: { quoteType: "long_term" }, rateCardDefaults: { FCL: card({ rows: [] }) } },
    drafts: [{ id: "saved", header: { quoteType: "long_term", cargoType: "FCL", rateCardsByType: { FCL: card() } }, lineItems: [{ id: "single", unit: 7, unitPrice: 200 }] }] });
  assert.equal(initial.settings.headerDefaults.quoteType, "long_term");
  assert.equal(initial.settings.rateCardDefaults.FCL.rows.length, 0);
  assert.equal(initial.drafts[0].header.rateCardsByType.FCL.rows[0].cells["40HQ"].unitPrice, 100);
  assert.equal(initial.drafts[0].lineItems[0].unit, 7);
  const updated = normalizeQuoteModuleData({ ...initial, settings: { ...initial.settings, rateCardDefaults: { FCL: card({ rows: [row("new", { "20GP": cell(999) })] }) } } });
  assert.deepEqual(updated.drafts, initial.drafts);
  assert.deepEqual(normalizeQuoteModuleData(initial), initial);
});

test("header matrices roundtrip through relational JSONB mapping with exact quote type and zero prices", () => {
  const data = normalizeShippingData({ modules: { quote: { drafts: [{ id: "matrix", header: { quoteType: "long_term", cargoType: "AIR", rateCardsByType: { AIR: card() } }, lineItems: [] }] } } });
  const rebuilt = normalizeShippingData(assemble(decompose(data)));
  assert.deepEqual(rebuilt.modules.quote.drafts[0].header, data.modules.quote.drafts[0].header);
  assert.equal(rebuilt.modules.quote.drafts[0].header.rateCardsByType.AIR.rows[0].cells["40GP"].unitPrice, 0);
});

test("excluded-row ordinary invalid prices do not block a different active row", () => {
  const input = card({ rows: [row("off", { "20GP": cell(-1) }, { included: false }), row("on", { "20GP": cell(10) })] });
  assert.ok(validateRateCard(input).length);
  assert.deepEqual(buildRateCardView(input, "mexico_only").errors, []);
});

test("browser UMD and Node use the same normalization, view and Unicode-safe parsing", () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/quote-rate-card.js"), "utf8"), context);
  const browser = context.QuoteRateCard;
  assert.deepEqual(JSON.parse(JSON.stringify(browser.normalizeRateCard(card()))), normalizeRateCard(card()));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.buildRateCardView(card(), "ocean_mexico"))), buildRateCardView(card(), "ocean_mexico"));
  const raw = JSON.stringify({ AIR: card({ variants: [{ id: "standard", label: "标准规格" }], rows: [] }) });
  assert.deepEqual(JSON.parse(JSON.stringify(browser.parseRateCardsByType(raw))), parseRateCardsByType(raw));
});
console.log(`\nRate-card domain: ${checks} checks passed.`);
