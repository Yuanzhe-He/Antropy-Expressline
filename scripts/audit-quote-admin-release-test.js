// Quote admin release regression: isolated JSON settings writes and strict
// validation. No production database, migration, seed mutation or network FX.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.STORAGE_DRIVER = "json";
process.env.SKIP_FX_REFRESH = "1";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-quote-admin-release-"));
process.env.DATA_DIR = tmpDir;
const { createApp } = require("../src/server");
const { BoundedSessionStore } = require("../src/lib/bounded-session-store");
const { getShippingData, normalizeShippingData } = require("../src/lib/store");
const { decompose, assemble } = require("../src/lib/db/relational-map");
const {
  DEFAULT_CARGO_PRICING_RULES, normalizeCargoPricingRules, validateCargoPricingRules,
  DEFAULT_QUOTE_FEE_TEMPLATES, normalizeQuoteFeeTemplates, validateQuoteFeeTemplates,
} = require("../src/lib/quote-config");
const dataFile = path.join(tmpDir, "shipping-lines.json");
const cookies = new Map();
let baseUrl;
let passed = 0;
const ok = (label) => { passed += 1; console.log(`  PASS ${label}`); };
const readQuote = async () => (await getShippingData()).modules.quote;

function feeForm(rows, includeCode = true) {
  const fields = {
    id: "id", code: "code", chargeKind: "chargeKind", category: "category", section: "section",
    en: "conceptEn", zh: "conceptZh", es: "conceptEs", unit: "defaultQuantity", uom: "unitOfMeasure",
    price: "unitPrice", max: "unitPriceMax", currency: "currency", remark: "remark", sourceNote: "sourceNote",
  };
  const form = { feeTemplatesPresent: "1" };
  for (const [field, key] of Object.entries(fields)) if (includeCode || field !== "code") form[`fee_${field}[]`] = rows.map((row) => row[key] ?? "");
  form["fee_active[]"] = rows.map((row) => row.enabled ? "1" : "0");
  form["fee_selectionRequired[]"] = rows.map((row) => row.selectionRequired ? "1" : "0");
  form["fee_modes[]"] = rows.map((row) => row.appliesTo.join(","));
  return form;
}

function rulesForm(rules) {
  return {
    cargoPricingRulesPresent: "1", "pricing_type[]": Object.keys(rules),
    "pricing_method[]": Object.values(rules).map((rule) => rule.method),
    "pricing_divisor[]": Object.values(rules).map((rule) => rule.volumeDivisor ?? ""),
  };
}

async function request(form) {
  const headers = {};
  if (cookies.size) headers.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  let body;
  if (form) {
    body = new URLSearchParams();
    for (const [key, values] of Object.entries(form)) for (const value of Array.isArray(values) ? values : [values]) body.append(key, String(value ?? ""));
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${baseUrl}/admin/quote/settings`, {
    method: form ? "POST" : "GET", body, headers, redirect: "manual", signal: AbortSignal.timeout(15000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return { status: response.status, html: await response.text() };
}

async function main() {
  const sessionStore = new BoundedSessionStore();
  let server;
  try {
    const defaults = normalizeCargoPricingRules();
    assert.deepEqual(defaults, DEFAULT_CARGO_PRICING_RULES);
    assert.equal(defaults.AIR.method, "manual");
    assert.ok(Object.values(defaults).every((rule) => rule.volumeDivisor === null));
    assert.equal(validateCargoPricingRules(defaults), "");
    for (const invalid of [null, [], {}, { ...defaults, FCL: { method: "manual" } }]) assert.equal(validateCargoPricingRules(invalid), "invalid_cargo_pricing_rules");
    for (const invalid of [0, -1, "NaN", "Infinity", "1e3", "6000kg", true, {}, ""]) {
      assert.equal(validateCargoPricingRules({ ...defaults, AIR: { method: "volumetric", volumeDivisor: invalid } }), "invalid_cargo_pricing_divisor");
    }
    assert.equal(validateCargoPricingRules({ ...defaults, AIR: { method: "made_up", volumeDivisor: null } }), "invalid_cargo_pricing_method");
    assert.equal(validateCargoPricingRules({ ...defaults, AIR: { method: "manual", volumeDivisor: -1 } }), "invalid_cargo_pricing_divisor");
    ok("defaults invent no divisor and rules reject missing, unknown, nonnumeric or nonpositive values");

    const airFee = { ...DEFAULT_QUOTE_FEE_TEMPLATES[0], id: "air-extra", code: "", appliesTo: ["AIR"], unitOfMeasure: "kg" };
    assert.equal(validateQuoteFeeTemplates([airFee]), "");
    assert.equal(normalizeQuoteFeeTemplates([airFee])[0].code, "");
    assert.equal(DEFAULT_QUOTE_FEE_TEMPLATES.find((row) => row.id === "delivery-order").conceptEn, "Shipping line local charge");
    assert.ok(DEFAULT_QUOTE_FEE_TEMPLATES.every((row) => row.code === ""));
    for (const code of ["X".repeat(101), "F02\nF03", {}]) assert.equal(validateQuoteFeeTemplates([{ ...airFee, code }]), "invalid_fee_template_code");
    ok("AIR fees and optional official codes validate without generating company codes");

    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/shipping-lines.json"), "utf8"));
    seed.modules.quote = { settings: { cargoPricingRules: defaults }, drafts: [] };
    fs.writeFileSync(dataFile, JSON.stringify(normalizeShippingData(seed)));
    const app = createApp({ sessionStore });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const page = await request();
    assert.equal(page.status, 200);
    assert.match(page.html, /name="fee_code\[\]"/);
    assert.match(page.html, /data-fee-mode="AIR"/);
    assert.match(page.html, /name="cargoPricingRulesPresent"/);
    assert.match(page.html, /data-pricing-divisor/);
    ok("real admin renders official codes, four fee modes and per-type pricing rules");

    const before = await readQuote();
    const configured = { ...defaults, LCL: { method: "volumetric", volumeDivisor: 5000 }, AIR: { method: "manual", volumeDivisor: null } };
    const fees = [...before.settings.feeTemplates.map((row) => row.id === "delivery-order" ? { ...row, code: "F02", unitOfMeasure: "shipment" } : row), airFee];
    assert.equal((await request({ ...rulesForm(configured), ...feeForm(fees) })).status, 302);
    const saved = await readQuote();
    assert.deepEqual(saved.settings.cargoPricingRules, configured);
    assert.equal(saved.settings.feeTemplates.find((row) => row.id === "delivery-order").code, "F02");
    assert.equal(saved.settings.feeTemplates.find((row) => row.id === "delivery-order").unitOfMeasure, "shipment");
    assert.equal(saved.settings.feeTemplates.find((row) => row.id === "air-extra").code, "");
    assert.deepEqual(saved.notes, before.notes);
    assert.deepEqual(saved.settings.defaultCurrencyByCategory, before.settings.defaultCurrencyByCategory);
    const roundtrip = normalizeShippingData(assemble(decompose(await getShippingData())));
    assert.deepEqual(roundtrip.modules.quote.settings.cargoPricingRules, configured);
    const reopened = await request();
    assert.equal(reopened.status, 200);
    assert.match(reopened.html, /name="fee_code\[\]" value="F02"/);
    assert.match(reopened.html, /name="pricing_divisor\[\]"[^>]*value="5000"/);
    ok("codes, units, AIR applicability and rules survive save/reopen and relational serialization");

    const invalidForms = [
      rulesForm({ ...configured, AIR: { method: "volumetric", volumeDivisor: "" } }),
      rulesForm({ ...configured, LCL: { method: "volumetric", volumeDivisor: 0 } }),
      { ...rulesForm(configured), "pricing_type[]": ["LCL", "LCL", "AIR"] },
      { ...rulesForm(configured), "pricing_method[]": ["manual"] },
      { ...rulesForm(configured), "pricing_type[]": ["LCL", "BBK", "FCL"] },
      feeForm(fees.map((row) => ({ ...row, code: "X".repeat(101) }))),
      { ...feeForm(fees), "fee_code[]": ["F02"] },
      feeForm(fees.map((row) => ({ ...row, appliesTo: [] }))),
    ];
    for (const invalid of invalidForms) {
      const diskBefore = fs.readFileSync(dataFile, "utf8");
      const response = await request(invalid);
      assert.equal(response.status, 400);
      assert.match(response.html, /role="alert"/);
      assert.equal(fs.readFileSync(dataFile, "utf8"), diskBefore, "invalid form must not persist any partial settings");
    }
    ok("invalid/malformed rules and official code submissions reject atomically");

    assert.equal((await request({ quoteNumberPrefix: "ADMIN-" })).status, 302);
    assert.deepEqual((await readQuote()).settings.cargoPricingRules, configured);
    assert.equal((await request(feeForm(fees, false))).status, 302);
    assert.equal((await readQuote()).settings.feeTemplates.find((row) => row.id === "delivery-order").code, "F02");
    const cleared = fees.map((row) => ({ ...row, code: "" }));
    assert.equal((await request(feeForm(cleared))).status, 302);
    assert.ok((await readQuote()).settings.feeTemplates.every((row) => row.code === ""));
    ok("partial/older forms preserve settings and current forms can explicitly clear official codes");
    console.log(`audit-quote-admin-release-test: ${passed}/${passed} passed`);
  } finally {
    if (server) {
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    sessionStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
