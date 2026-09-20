// Quote workflow v2 regression contract. Pure calculations and real isolated
// JSON-backed routes only: no production DB, network FX, or browser required.
// `--pure` exercises domain/model contracts while route/view work is underway.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-quote-workflow-v2-"));
process.env.DATA_DIR = tmpDir;

const { createApp } = require("../src/server");
const { BoundedSessionStore } = require("../src/lib/bounded-session-store");
const { getShippingData, normalizeShippingData } = require("../src/lib/store");
const { normalizeQuoteModuleData } = require("../src/lib/store/normalize-quote");
const { decompose, assemble } = require("../src/lib/db/relational-map");
const { buildQuoteFormData, assembleQuoteView } = require("../src/lib/views");
const { renderQuoteHtml } = require("../src/lib/quote-pdf");
const { buildInitialLineItems, computeQuoteTotals } = require("../src/lib/quote");
const { parseCargoPricing, cargoCalculation, buildCargoChargeRows, activeQuoteRows } = require("../src/lib/quote-workflow");
const { normalizeCargoPricing, calculateCargoPricing } = require("../public/quote-pricing");
const {
  DEFAULT_QUOTE_FEE_TEMPLATES, DEFAULT_CURRENCY_BY_CATEGORY,
  normalizeQuoteFeeTemplates, validateQuoteFeeTemplates, getQuoteDefaultCurrency,
} = require("../src/lib/quote-config");

const dataFile = path.join(tmpDir, "shipping-lines.json");
const cookies = new Map();
const pureOnly = process.argv.includes("--pure");
let baseUrl;
let passed = 0;
let failed = 0;
const ok = (message) => { passed += 1; console.log("  PASS ", message); };
const readQuote = async () => (await getShippingData()).modules.quote;
const diskContents = () => fs.readFileSync(dataFile, "utf8");
function pure(name, fn) {
  try { fn(); ok(name); }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${error.message}`); }
}

const FCL_PRICING = {
  containers: [
    { containerType: "20GP", quantity: 2, unitPrice: 125.25, currency: "USD" },
    { containerType: "40HQ", quantity: 1, unitPrice: 37.5, currency: "USD" },
    { containerType: "40RF", quantity: 3, unitPrice: 100, currency: "MXN" },
  ],
};
const PACKAGE = { lengthCm: 10, widthCm: 20, heightCm: 30, packageCount: 2, weightKg: 5, weightCount: 7 };
const LCL_PRICING = {
  packages: [PACKAGE, { lengthCm: 2, widthCm: 5, heightCm: 10, packageCount: 20, weightKg: 100, weightCount: 2 }],
  unitPrice: 0.15, currency: "MXN",
};
const FX = { pairs: [{ base: "USD", quote: "MXN", rate: 20 }], asOfDate: "2026-09-13" };
const CUSTOMS = {
  importerQualification: "trading_company", specialImportQualification: "yes",
  nomCertification: "no", ministryRegistration: "unknown",
};

function cargoBody(pricing) {
  const normalized = normalizeCargoPricing(pricing);
  return {
    cargo_containerType: normalized.containers.map((row) => row.containerType),
    cargo_containerQuantity: normalized.containers.map((row) => row.quantity),
    cargo_containerPrice: normalized.containers.map((row) => row.unitPrice),
    cargo_containerCurrency: normalized.containers.map((row) => row.currency),
    cargo_lengthCm: normalized.packages.map((row) => row.lengthCm),
    cargo_widthCm: normalized.packages.map((row) => row.widthCm),
    cargo_heightCm: normalized.packages.map((row) => row.heightCm),
    cargo_packageCount: normalized.packages.map((row) => row.packageCount),
    cargo_weightKg: normalized.packages.map((row) => row.weightKg),
    cargo_weightCount: normalized.packages.map((row) => row.weightCount),
    cargo_unitPrice: normalized.unitPrice,
    cargo_currency: normalized.currency || "MXN",
  };
}

function lineBody(rows) {
  const mapping = {
    id: "id", section: "section", chargeKind: "chargeKind", category: "category",
    code: "code", conceptEn: "conceptEn", conceptZh: "conceptZh", conceptEs: "conceptEs",
    unit: "unit", uom: "unitOfMeasure", unitPrice: "unitPrice", unitPriceMax: "unitPriceMax",
    currency: "currency", remark: "remark", source: "source",
  };
  const result = { quoteFormPresent: "1" };
  for (const [field, key] of Object.entries(mapping)) result[`li_${field}`] = rows.map((row) => row[key] ?? "");
  result.li_atCost = rows.map((row) => row.isAtCost ? "1" : "0");
  result.li_included = rows.map((row) => row.included === false ? "0" : "1");
  result.li_appliesTo = rows.map((row) => (row.appliesTo || ["FCL", "LCL", "BBK"]).join(","));
  return result;
}

function feeBody(rows, extra = {}) {
  const mapping = {
    id: "id", chargeKind: "chargeKind", category: "category", section: "section",
    en: "conceptEn", zh: "conceptZh", es: "conceptEs", unit: "defaultQuantity",
    uom: "unitOfMeasure", price: "unitPrice", max: "unitPriceMax", currency: "currency",
    remark: "remark", sourceNote: "sourceNote",
  };
  const result = { feeTemplatesPresent: "1", ...extra };
  for (const [field, key] of Object.entries(mapping)) result[`fee_${field}`] = rows.map((row) => row[key] ?? "");
  result.fee_active = rows.map((row) => row.enabled ? "1" : "0");
  result.fee_modes = rows.map((row) => row.appliesTo.join(","));
  result.fee_selectionRequired = rows.map((row) => row.selectionRequired ? "1" : "0");
  return result;
}

async function request(urlPath, { method = "GET", form } = {}) {
  const headers = {};
  if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  let body;
  if (form) {
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (Array.isArray(value)) value.forEach((entry) => body.append(`${key}[]`, String(entry ?? "")));
      else body.append(key, String(value ?? ""));
    }
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const separator = pair.indexOf("=");
    if (separator >= 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return { status: response.status, html: await response.text(), contentType: response.headers.get("content-type") };
}

function selectValues(html, name) {
  const select = html.match(new RegExp(`<select\\b[^>]*\\bname=["']${name}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  assert.ok(select, `select ${name} exists`);
  return [...select[1].matchAll(/<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>/gi)].map((match) => match[1]).filter(Boolean);
}

function runPure(shippingData) {
  const quote = shippingData.modules.quote;
  pure("one-time cargo migration retires other codes but preserves historical draft snapshots", () => {
    assert.deepEqual(quote.settings.cargoTypes.map((row) => row.code), ["FCL", "LCL", "BBK", "AIR"]);
    assert.equal(quote.settings.cargoTypePolicyVersion, 2);
    assert.equal(quote.drafts[0].header.cargoType, "ROR");
    assert.equal(quote.drafts[0].header.cargoTypeLabel, "Historical roll-on cargo");
    const empty = normalizeQuoteModuleData({ settings: { cargoTypes: [], cargoTypePolicyVersion: 1 } });
    assert.deepEqual(normalizeQuoteModuleData(empty).settings.cargoTypes, []);
  });
  pure("26 editable templates preserve 14 screenshot rows, 12 foreign rows, ranges and explicit currencies", () => {
    assert.equal(quote.settings.feeTemplates.length, 26);
    assert.equal(quote.settings.feeTemplates.filter((row) => row.section === "foreign").length, 12);
    assert.equal(DEFAULT_QUOTE_FEE_TEMPLATES.length, 14);
    assert.equal(DEFAULT_QUOTE_FEE_TEMPLATES.filter((row) => row.chargeKind === "contingent").length, 6);
    const cleaning = quote.settings.feeTemplates.find((row) => row.id === "container-cleaning");
    assert.deepEqual([cleaning.unitPrice, cleaning.unitPriceMax, cleaning.currency], [800, 2000, "MXN"]);
    const inspection = quote.settings.feeTemplates.find((row) => row.id === "customs-inspection");
    assert.deepEqual([inspection.unitPrice, inspection.unitPriceMax], [8000, 10000]);
    assert.equal(quote.settings.feeTemplates.find((row) => row.id === "destination-handling").currency, "MXN");
    assert.equal(quote.settings.feeTemplates.find((row) => row.id === "transport-full").defaultQuantity, 2);
    assert.equal(validateQuoteFeeTemplates(quote.settings.feeTemplates), "");
    assert.deepEqual(normalizeQuoteFeeTemplates([]), []);
  });
  pure("default currencies apply by category and respect a saved override", () => {
    assert.equal(getQuoteDefaultCurrency("SHIPPING LINE"), "USD");
    for (const category of Object.keys(DEFAULT_CURRENCY_BY_CATEGORY).filter((category) => category !== "SHIPPING LINE")) {
      assert.equal(getQuoteDefaultCurrency(category), "MXN");
    }
    assert.equal(getQuoteDefaultCurrency("SHIPPING LINE", { "SHIPPING LINE": "MXN" }), "MXN");
  });
  pure("FCL prices mixed container types per currency and never sums unlike currencies", () => {
    const result = calculateCargoPricing("FCL", FCL_PRICING);
    assert.equal(result.valid, true);
    assert.deepEqual(result.rows.map((row) => row.total), [250.5, 37.5, 300]);
    assert.deepEqual(result.subtotals, [{ currency: "USD", amount: 288 }, { currency: "MXN", amount: 300 }]);
    assert.equal(result.total, undefined);
  });
  pure("decimal unit-price midpoints round consistently to cents", () => {
    for (const [price, expected] of [[1.005, 1.01], [10.075, 10.08], [2.675, 2.68]]) {
      const pricing = { containers: [{ containerType: "20GP", quantity: 1, unitPrice: price, currency: "USD" }] };
      const result = cargoCalculation("FCL", pricing);
      assert.equal(result.total, expected);
      const form = buildQuoteFormData(quote, { quoteFormPresent: "1", cargoType: "FCL", ...cargoBody(pricing) });
      const view = assembleQuoteView(quote, form, shippingData);
      assert.equal(view.subtotals.find((row) => row.currency === "USD").amount, expected);
    }
  });
  pure("LCL and BBK use independently counted raw kg/cm³ totals without a divisor", () => {
    for (const type of ["LCL", "BBK"]) {
      const result = calculateCargoPricing(type, LCL_PRICING);
      assert.equal(result.valid, true);
      assert.deepEqual([result.totalWeightKg, result.totalVolumeCm3, result.chargeableValue, result.total], [235, 14000, 14000, 2100]);
      const heavy = calculateCargoPricing(type, { packages: [{ ...PACKAGE, lengthCm: 1, widthCm: 1, heightCm: 1 }], unitPrice: 2, currency: "USD" });
      assert.deepEqual([heavy.totalWeightKg, heavy.totalVolumeCm3, heavy.chargeableValue, heavy.total], [35, 2, 35, 70]);
    }
  });
  pure("an explicit zero price is valid; missing price previews quantities but cannot price", () => {
    const zero = calculateCargoPricing("LCL", { ...LCL_PRICING, unitPrice: 0 });
    assert.equal(zero.valid, true); assert.equal(zero.total, 0);
    const blank = calculateCargoPricing("LCL", { ...LCL_PRICING, unitPrice: "" });
    assert.equal(blank.valid, false); assert.equal(blank.chargeableValue, 14000);
    assert.equal(blank.total, undefined); assert.deepEqual(blank.rows, []); assert.deepEqual(blank.subtotals, []);
    assert.equal(normalizeCargoPricing({}).unitPrice, "");
  });
  pure("incomplete, negative, malformed, fractional-count and overflow inputs remain unpriced after normalization", () => {
    const invalid = [
      ["LCL", { ...LCL_PRICING, packages: [{ ...PACKAGE, heightCm: "" }] }],
      ["LCL", { ...LCL_PRICING, packages: [{ ...PACKAGE, packageCount: 1.5 }] }],
      ["BBK", { ...LCL_PRICING, packages: [{ ...PACKAGE, weightKg: -1 }] }],
      ["BBK", { ...LCL_PRICING, packages: [{ ...PACKAGE, lengthCm: Number.MAX_SAFE_INTEGER }] }],
      ["LCL", { ...LCL_PRICING, unitPrice: Infinity }],
      ["LCL", { ...LCL_PRICING, unitPrice: "not a number" }],
      ["LCL", { ...LCL_PRICING, currency: "EUR" }],
      ["FCL", { containers: [{ containerType: "20GP", quantity: 1, unitPrice: Number.MAX_SAFE_INTEGER, currency: "USD" }] }],
      ["FCL", { containers: [{ containerType: "20GP", quantity: 0, unitPrice: 5, currency: "USD" }] }],
      ["FCL", { containers: [{ quantity: -1 }] }],
      ["FCL", { containers: Array(101).fill({ containerType: "20GP", quantity: 1, unitPrice: 1, currency: "USD" }) }],
    ];
    for (const [type, input] of invalid) {
      for (const pricing of [input, normalizeCargoPricing(input), normalizeCargoPricing(normalizeCargoPricing(input))]) {
        const result = calculateCargoPricing(type, pricing);
        assert.equal(result.valid, false); assert.ok(result.errors.length);
        assert.deepEqual(result.rows, []); assert.deepEqual(result.subtotals, []); assert.equal(result.total, undefined);
      }
    }
  });
  pure("inactive cargo inputs survive mode switches without affecting active calculations", () => {
    const combined = { ...FCL_PRICING, ...LCL_PRICING };
    assert.equal(calculateCargoPricing("FCL", combined).subtotals[0].amount, 288);
    assert.equal(calculateCargoPricing("LCL", combined).total, 2100);
    assert.equal(calculateCargoPricing("FCL", { ...combined, packages: [{ weightKg: -1 }] }).valid, true);
    assert.equal(calculateCargoPricing("LCL", { ...combined, containers: [{ quantity: -1 }] }).valid, true);
    assert.equal(cargoCalculation("FCL", { packages: [{ weightKg: -1 }] }).attempted, false);
    assert.equal(cargoCalculation("LCL", { containers: [{ quantity: -1 }] }).attempted, false);
    assert.equal(cargoCalculation("", combined).attempted, false);
  });
  pure("partial array submissions retain quantity/weight inputs even when type/dimension anchors are missing", () => {
    for (const [type, body, attempted] of [
      ["FCL", { cargo_containerQuantity: [2] }, false],
      ["FCL", { cargo_containerQuantity: [-1] }, false],
      ["LCL", { cargo_weightKg: [10], cargo_weightCount: [2] }, false],
      ["BBK", { cargo_packageCount: [2] }, false],
    ]) {
      const calculation = cargoCalculation(type, parseCargoPricing(body));
      assert.equal(calculation.attempted, attempted);
      assert.equal(calculation.valid, false);
      assert.deepEqual(calculation.rows, []);
    }
  });
  pure("an explicitly cleared LCL/BBK currency cannot silently become MXN on server parsing", () => {
    for (const type of ["LCL", "BBK"]) {
      const parsed = parseCargoPricing({ ...cargoBody(LCL_PRICING), cargo_currency: "" });
      assert.equal(parsed.currency, "");
      const calculation = cargoCalculation(type, parsed);
      assert.equal(calculation.attempted, true);
      assert.equal(calculation.valid, false);
      assert.deepEqual(buildCargoChargeRows(type, calculation), []);
    }
  });
  pure("browser UMD and server require calculate the same raw quantity result", () => {
    const context = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/quote-pricing.js"), "utf8"), context);
    const browserResult = context.QuotePricing.calculateCargoPricing("BBK", LCL_PRICING);
    assert.deepEqual(JSON.parse(JSON.stringify(browserResult)), calculateCargoPricing("BBK", LCL_PRICING));
  });
  pure("contingent fixed/range references and excluded alternatives add zero to subtotal, FX and tax totals", () => {
    const source = buildInitialLineItems("mexico_only", quote.settings.feeTemplates);
    const contingent = source.filter((row) => row.chargeKind === "contingent");
    const excluded = source.filter((row) => row.selectionRequired);
    assert.equal(excluded.length, 4); assert.ok(excluded.every((row) => row.included === false));
    const references = computeQuoteTotals([...contingent, ...excluded], { exchangeRates: FX, dualCurrency: true, showIndicativeConversion: true });
    assert.deepEqual(references.subtotals, []);
    assert.equal(references.dualTotals.mxn.shown, 0); assert.equal(references.dualTotals.usd.shown, 0);
    assert.equal(references.indicative, null);
    assert.ok(references.rows.some((row) => row.total > 0), "reference prices remain visible");
    const fixed = { ...source[0], chargeKind: "fixed", included: true, currency: "USD", unit: 2, unitPrice: 100 };
    const withFixed = computeQuoteTotals([...contingent, ...excluded, fixed], { exchangeRates: FX, dualCurrency: true, showIndicativeConversion: true });
    assert.deepEqual(withFixed.subtotals.map(({ currency, amount }) => ({ currency, amount })), [{ currency: "USD", amount: 200 }]);
    assert.equal(withFixed.indicative.amount, 4000);
    assert.equal(withFixed.dualTotals.mxn.shown, 4000); assert.equal(withFixed.dualTotals.usd.shown, 232);
  });
  pure("blank fee prices/quantities remain unpriced across calculation and draft roundtrips; explicit zero remains valid", () => {
    const base = { ...quote.settings.feeTemplates.find((row) => row.id === "destination-handling"), included: true };
    const missing = [
      { ...base, id: "blank-price", unit: 1, unitPrice: "" },
      { ...base, id: "blank-quantity", unit: "", unitPrice: 100 },
    ];
    const totals = computeQuoteTotals(missing, { exchangeRates: FX, dualCurrency: true });
    assert.deepEqual(totals.subtotals, []);
    assert.ok(totals.rows.every((row) => row.total === null));
    assert.ok(totals.rows.every((row) => row.totalLabel !== "0.00" && row.totalLabel !== "AT COST"));
    const zero = computeQuoteTotals([{ ...base, unit: 1, unitPrice: 0 }]);
    assert.equal(zero.rows[0].total, 0);
    const saved = normalizeQuoteModuleData({ ...quote, drafts: [{ id: "missing-fee-values", number: "WF-MISSING", header: {}, lineItems: missing }] });
    const reread = normalizeQuoteModuleData(JSON.parse(JSON.stringify(saved)));
    const items = reread.drafts[0].lineItems;
    assert.ok(items[0].unitPrice == null || items[0].unitPrice === "", "blank price is not persisted as zero");
    assert.ok(items[1].unit == null || items[1].unit === "", "blank quantity is not persisted as zero");
    assert.deepEqual(computeQuoteTotals(items).subtotals, []);
  });
  pure("geographic and cargo filters preserve hidden operator edits across mode changes", () => {
    const base = quote.settings.feeTemplates[0];
    const rows = [
      { ...base, id: "foreign-fcl", section: "foreign", appliesTo: ["FCL"], unitPrice: 111.23 },
      { ...base, id: "foreign-lcl", section: "foreign", appliesTo: ["LCL"], unitPrice: 222.34 },
      { ...base, id: "mex-fcl", section: "mexico", appliesTo: ["FCL"], unitPrice: 333.45 },
      { ...base, id: "mex-lcl", section: "mexico", appliesTo: ["LCL"], unitPrice: 444.56 },
    ];
    const body = { ...lineBody(rows), cargoType: "LCL", quoteMode: "mexico_only" };
    const mex = buildQuoteFormData(quote, body);
    assert.equal(mex.lineItems.length, 4);
    assert.deepEqual(activeQuoteRows(mex.lineItems, mex.quoteMode, mex.header.cargoType).map((row) => row.id), ["mex-lcl"]);
    const ocean = buildQuoteFormData(quote, { ...body, cargoType: "FCL", quoteMode: "ocean_mexico" });
    assert.equal(ocean.lineItems.length, 4);
    assert.equal(Number(ocean.lineItems.find((row) => row.id === "foreign-fcl").unitPrice), 111.23);
    assert.deepEqual(activeQuoteRows(ocean.lineItems, ocean.quoteMode, ocean.header.cargoType).map((row) => row.id), ["foreign-fcl", "mex-fcl"]);
  });
  pure("explicit removal of all quoted fees remains empty in ocean mode after postback", () => {
    const empty = buildQuoteFormData(quote, { quoteFormPresent: "1", cargoType: "FCL", quoteMode: "ocean_mexico" });
    assert.deepEqual(empty.lineItems, []);
    const local = { ...quote.settings.feeTemplates.find((row) => row.id === "destination-handling"), id: "kept-local" };
    const localOnly = buildQuoteFormData(quote, { ...lineBody([local]), cargoType: "FCL", quoteMode: "ocean_mexico" });
    assert.deepEqual(localOnly.lineItems.map((row) => row.id), ["kept-local"]);
  });
  pure("automatic cargo charges are recomputed once by server and posted automatic rows cannot be trusted", () => {
    const calculation = cargoCalculation("FCL", FCL_PRICING);
    const generated = buildCargoChargeRows("FCL", calculation);
    assert.equal(generated.length, 3);
    assert.ok(generated.every((row) => row.isCargoCharge === true && row.source === "cargo_pricing"));
    const stale = generated.map((row) => ({ ...row, unitPrice: 999999 }));
    const form = buildQuoteFormData(quote, { ...lineBody(stale), ...cargoBody(FCL_PRICING), cargoType: "FCL" });
    const view = assembleQuoteView(quote, form, shippingData);
    assert.equal(view.cargoChargeRows.length, 3);
    assert.equal(view.rows.length, 3, "only server-calculated cargo rows are present");
    assert.deepEqual(view.subtotals.map(({ currency, amount }) => ({ currency, amount })), [{ currency: "USD", amount: 288 }, { currency: "MXN", amount: 300 }]);
  });
  pure("customs choices and all cargo pricing inputs survive JSON and relational header roundtrips", () => {
    const form = buildQuoteFormData(quote, { quoteFormPresent: "1", cargoType: "LCL", ...cargoBody(LCL_PRICING), ...CUSTOMS });
    assert.deepEqual(form.header.cargoPricing, form.cargoPricing);
    const candidate = structuredClone(shippingData);
    candidate.modules.quote.drafts.push({ id: "workflow-roundtrip", number: "WF-ROUNDTRIP", date: "2026-09-13", header: form.header, lineItems: [], quoteMode: "mexico_only" });
    const normalized = normalizeShippingData(candidate);
    const json = normalizeShippingData(JSON.parse(JSON.stringify(normalized)));
    const tables = decompose(json);
    const relational = normalizeShippingData(assemble(tables));
    for (const copy of [json, relational]) {
      const draft = copy.modules.quote.drafts.find((row) => row.id === "workflow-roundtrip");
      for (const [key, value] of Object.entries(CUSTOMS)) assert.equal(draft.header[key], value);
      assert.deepEqual(draft.header.cargoPricing, form.cargoPricing);
      assert.equal(calculateCargoPricing(draft.header.cargoType, draft.header.cargoPricing).total, 2100);
      assert.deepEqual(copy.modules.quote.settings.feeTemplates, json.modules.quote.settings.feeTemplates);
    }
    assert.deepEqual(decompose(relational), tables);
  });
  pure("customs unknown/blank answers stay distinct and unsupported answers do not become yes", () => {
    const own = buildQuoteFormData(quote, { quoteFormPresent: "1", importerQualification: "own", specialImportQualification: "unknown", nomCertification: "", ministryRegistration: "unsupported" });
    assert.equal(own.header.importerQualification, "own");
    assert.equal(own.header.specialImportQualification, "unknown");
    assert.equal(own.header.nomCertification, "");
    assert.equal(own.header.ministryRegistration, "");
    assert.equal(quote.notes.length, 5, "existing five clauses remain intact");
  });
}

async function runHttp(shippingData, sessionStore) {
  const app = createApp({ sessionStore });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const front = await request("/workbench/quote");
    assert.equal(front.status, 200);
    assert.deepEqual(selectValues(front.html, "cargoType"), ["FCL", "LCL", "BBK", "AIR"]);
    for (const key of Object.keys(CUSTOMS)) assert.match(front.html, new RegExp(`name="${key}"`));
    const admin = await request("/admin/quote/settings");
    assert.equal(admin.status, 200);
    assert.match(admin.html, /name="feeTemplatesPresent"/);
    assert.match(admin.html, /name="currencyDefaultsPresent"/);
    ok("real frontend and admin render four cargo choices, four customs questions and fee/currency editors");

    const before = await readQuote();
    const modified = before.settings.feeTemplates.map((row) => row.id === "container-cleaning"
      ? { ...row, conceptZh: "集装箱清洁费（核对版）", unitPrice: 900, unitPriceMax: 2100 }
      : row.id === "transport-full" ? { ...row, enabled: false } : row);
    modified.push({ ...DEFAULT_QUOTE_FEE_TEMPLATES[0], id: "bill-extra", conceptEn: "Bill review fee <script>alert(1)</script>", conceptZh: "新增核对费用", chargeKind: "contingent", selectionRequired: false });
    const edited = await request("/admin/quote/settings", {
      method: "POST", form: feeBody(modified, {
        currencyDefaultsPresent: "1", currency_category: Object.keys(DEFAULT_CURRENCY_BY_CATEGORY),
        currency_value: Object.keys(DEFAULT_CURRENCY_BY_CATEGORY).map((category) => category === "CUSTOMS CLEARANCE" ? "USD" : "MXN"),
      }),
    });
    assert.equal(edited.status, 302);
    const persisted = await readQuote();
    assert.equal(persisted.settings.feeTemplates.length, 27);
    assert.equal(persisted.settings.feeTemplates.find((row) => row.id === "container-cleaning").unitPriceMax, 2100);
    assert.equal(persisted.settings.feeTemplates.find((row) => row.id === "transport-full").enabled, false);
    assert.equal(getQuoteDefaultCurrency("SHIPPING LINE", persisted.settings.defaultCurrencyByCategory), "MXN");
    assert.equal(getQuoteDefaultCurrency("CUSTOMS CLEARANCE", persisted.settings.defaultCurrencyByCategory), "USD");
    assert.deepEqual(persisted.notes, before.notes);
    assert.deepEqual(persisted.settings.cargoTypes, before.settings.cargoTypes);
    const reloaded = await request("/admin/quote/settings");
    assert.equal(reloaded.status, 200);
    assert.ok(!reloaded.html.includes("Bill review fee <script>"));
    assert.ok(reloaded.html.includes("Bill review fee &lt;script&gt;"));
    ok("fee CRUD, disable, range and currency defaults persist; labels escape HTML and unrelated settings survive");

    const invalid = [
      ["duplicate id", [...modified, modified[0]]],
      ["reversed range", modified.map((row) => row.id === "container-cleaning" ? { ...row, unitPriceMax: 1 } : row)],
      ["blank names", modified.map((row) => row.id === "bill-extra" ? { ...row, conceptEn: " ", conceptZh: " " } : row)],
      ["negative price", modified.map((row) => row.id === "bill-extra" ? { ...row, unitPrice: -1 } : row)],
    ];
    for (const [description, rows] of invalid) {
      const diskBefore = diskContents();
      const response = await request("/admin/quote/settings", { method: "POST", form: feeBody(rows, { quoteNumberPrefix: "MUST-NOT-SAVE" }) });
      assert.equal(response.status, 400, description);
      assert.equal(diskContents(), diskBefore, `${description} never partially writes`);
    }
    const badCurrencyBefore = diskContents();
    const badCurrency = await request("/admin/quote/settings", { method: "POST", form: {
      currencyDefaultsPresent: "1", currency_category: Object.keys(DEFAULT_CURRENCY_BY_CATEGORY),
      currency_value: Object.keys(DEFAULT_CURRENCY_BY_CATEGORY).map((category) => category === "SHIPPING LINE" ? "EUR" : "MXN"),
      quoteNumberPrefix: "MUST-NOT-SAVE",
    } });
    assert.equal(badCurrency.status, 400); assert.equal(diskContents(), badCurrencyBefore);
    ok("duplicate/range/blank-name/negative-price/invalid-currency failures return 400 with no partial writes");

    const allDisabled = modified.map((row) => ({ ...row, enabled: false }));
    assert.equal((await request("/admin/quote/settings", { method: "POST", form: feeBody(allDisabled) })).status, 302);
    assert.ok((await readQuote()).settings.feeTemplates.every((row) => !row.enabled));
    assert.deepEqual(buildQuoteFormData(await readQuote()).lineItems, []);
    assert.equal((await request("/admin/quote/settings", { method: "POST", form: feeBody([]) })).status, 302);
    assert.deepEqual((await readQuote()).settings.feeTemplates, []);
    await request("/workbench/quote"); await request("/admin/quote/settings");
    assert.deepEqual((await readQuote()).settings.feeTemplates, []);
    assert.equal((await request("/admin/quote/settings", { method: "POST", form: { quoteNumberPrefix: "WF-" } })).status, 302);
    assert.deepEqual((await readQuote()).settings.feeTemplates, []);
    assert.equal((await request("/admin/quote/settings", { method: "POST", form: feeBody(before.settings.feeTemplates) })).status, 302);
    ok("all-disabled, explicit empty and marker-omitted configurations remain intentional across fresh reads");

    for (const [name, type, pricing] of [["FCL", "FCL", FCL_PRICING], ["LCL", "LCL", LCL_PRICING], ["BBK", "BBK", LCL_PRICING]]) {
      const number = `WF-${name}`;
      const form = { quoteFormPresent: "1", quotationNumber: number, action: "saveDraft", cargoType: type, ...CUSTOMS, ...cargoBody(pricing) };
      assert.equal((await request("/workbench/quote", { method: "POST", form })).status, 200);
      const draft = (await readQuote()).drafts.find((row) => row.number === number);
      assert.ok(draft);
      for (const [key, value] of Object.entries(CUSTOMS)) assert.equal(draft.header[key], value);
      assert.deepEqual(draft.header.cargoPricing, parseCargoPricing(form));
      assert.equal(calculateCargoPricing(type, draft.header.cargoPricing).valid, true);
      assert.ok(!draft.lineItems.some((row) => row.source === "cargo_pricing"), "generated charge is derived, not persisted twice");
    }
    const actualData = await getShippingData();
    const actualTables = decompose(actualData);
    const actualRoundtrip = normalizeShippingData(assemble(actualTables));
    assert.deepEqual(actualRoundtrip.modules.quote.drafts, actualData.modules.quote.drafts);
    assert.deepEqual(actualRoundtrip.modules.quote.settings.feeTemplates, actualData.modules.quote.settings.feeTemplates);
    ok("real JSON draft saves preserve customs/cargo fields for FCL/LCL/BBK and survive relational serialization");

    const partialBody = { quoteFormPresent: "1", quotationNumber: "WF-PARTIAL", cargoType: "LCL", ...cargoBody({ ...LCL_PRICING, packages: [{ ...PACKAGE, heightCm: "" }] }) };
    const partialSave = await request("/workbench/quote", { method: "POST", form: { ...partialBody, action: "saveDraft" } });
    assert.equal(partialSave.status, 200, "incomplete draft is allowed");
    assert.ok((await readQuote()).drafts.some((row) => row.number === "WF-PARTIAL"));
    const diskBeforePdf = diskContents();
    const rejected = await request("/workbench/quote/pdf", { method: "POST", form: partialBody });
    assert.equal(rejected.status, 400, "incomplete active pricing blocks PDF");
    assert.equal(diskContents(), diskBeforePdf, "rejected PDF does not advance numbering or write a draft");
    const negative = { quoteFormPresent: "1", quotationNumber: "WF-NEGATIVE", cargoType: "FCL", cargo_containerType: ["40HQ"], cargo_containerQuantity: [1], cargo_containerPrice: [-1], cargo_containerCurrency: ["USD"] };
    assert.equal((await request("/workbench/quote/pdf", { method: "POST", form: negative })).status, 400);
    const unset = await request("/workbench/quote", { method: "POST", form: { quoteFormPresent: "1", quotationNumber: "WF-UNSET", action: "saveDraft", cargoType: "" } });
    assert.equal(unset.status, 200);
    ok("partial drafts save, but incomplete/negative active pricing rejects PDF without a write; unset mode remains draftable");

    const quote = await readQuote();
    const form = buildQuoteFormData(quote, { cargoType: "LCL", quoteLang: "EN", ...cargoBody(LCL_PRICING), ...CUSTOMS });
    const view = assembleQuoteView(quote, form, actualData);
    const stripDataUris = (html) => html.replace(/data:[^"'\s>]+/g, "data:omitted");
    const html = stripDataUris(await renderQuoteHtml(view));
    assert.match(html, /NOM/i);
    assert.match(html, /trading|贸易|comercializadora/i);
    assert.match(html, /special|特殊|especial/i);
    assert.match(html, /ministry|经济部|econom[ií]a/i);
    assert.match(html, /14,?000/);
    for (const [label, answer] of [
      ["IMPORT QUALIFICATION", "Import via a trading company"],
      ["SPECIAL IMPORT QUALIFICATION REQUIRED", "Yes"],
      ["NOM CERTIFICATION REQUIRED", "No"],
      ["ECONOMY MINISTRY REGISTRATION REQUIRED", "To be confirmed"],
    ]) assert.match(html, new RegExp(`${label}</td>\\s*<td\\b[^>]*>${answer}</td>`));
    assert.ok(view.chargeSections.some((section) => section.chargeKind === "contingent"));
    const fclForm = buildQuoteFormData(quote, { cargoType: "FCL", quoteLang: "EN", ...cargoBody(FCL_PRICING) });
    const fclHtml = stripDataUris(await renderQuoteHtml(assembleQuoteView(quote, fclForm, actualData)));
    assert.match(fclHtml, /FIXED CHARGES/);
    assert.match(fclHtml, /CHARGES IF INCURRED/);
    assert.match(fclHtml, /800\.00–2,000\.00/);
    const historical = stripDataUris(await renderQuoteHtml({ ...view, header: { ...view.header, cargoType: "ROR", cargoTypeLabel: "Historical roll-on cargo" } }));
    assert.match(historical, /Historical roll-on cargo/);
    ok("real PDF HTML contains customs answers, raw cargo calculation, charge sections and historical cargo labels");
  } finally {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const sessionStore = new BoundedSessionStore();
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/shipping-lines.json"), "utf8"));
    seed.modules.quote = {
      settings: { quoteNumberPrefix: "WF-", lastQuoteSeq: 10 },
      drafts: [{ id: "legacy-ror", number: "LEGACY-ROR", header: { cargoType: "ROR", cargoTypeLabel: "Historical roll-on cargo" }, lineItems: [] }],
    };
    seed.exchangeRates = FX;
    const shippingData = normalizeShippingData(seed);
    fs.writeFileSync(dataFile, JSON.stringify(shippingData, null, 2));
    runPure(shippingData);
    if (!pureOnly) await runHttp(shippingData, sessionStore);
    console.log(`\naudit-quote-workflow-v2-test: ${passed}/${passed + failed} passed${pureOnly ? " (pure only)" : ""}`);
    if (failed) process.exitCode = 1;
    else console.log("audit-quote-workflow-v2-test-ok");
  } finally {
    sessionStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
