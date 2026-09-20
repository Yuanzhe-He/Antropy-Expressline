// Pure release contracts: no server, database, credentials, or filesystem writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const pricing = require("../public/quote-pricing");
const workflow = require("../src/lib/quote-workflow");
const { normalizeCargoPricing, normalizeCargoPricingByType, calculateCargoPricing, cargoPricingAttempted } = pricing;
const { parseCargoPricing, parseCargoPricingByType, cargoCalculation, buildCargoChargeRows } = workflow;
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`PASS ${name}`); }
const box = { lengthCm: 100, widthCm: 100, heightCm: 100, packageCount: 2, weightKg: 100, weightCount: 2 };
const fcl = { containers: [{ containerType: "40HQ", quantity: 2, unitPrice: 100, currency: "USD" }] };
const lcl = { packages: [box], unitPrice: 2, currency: "MXN" };
const air = { method: "manual", manualChargeable: 725.5, unitPrice: 2.4, currency: "USD" };

test("AIR defaults to manual; legacy LCL and BBK retain raw numeric maximum", () => {
  assert.equal(normalizeCargoPricing({}, "AIR").method, "manual");
  for (const type of ["LCL", "BBK"]) {
    const result = cargoCalculation(type, lcl);
    assert.equal(result.method, "raw_max");
    assert.equal(result.valid, true);
    assert.equal(result.totalWeightKg, 200);
    assert.equal(result.totalVolumeCm3, 2000000);
    assert.equal(result.chargeableValue, 2000000);
    assert.equal(result.total, 4000000);
  }
  assert.equal(cargoCalculation("AIR", { ...air, method: undefined }).total, 1741.2);
});

test("FCL mixes container counts and currencies without adding unlike money", () => {
  const result = cargoCalculation("FCL", { containers: [
    ...fcl.containers, { containerType: "20GP", quantity: 3, unitPrice: 1.005, currency: "MXN" },
  ] });
  assert.equal(result.valid, true);
  assert.equal(result.attempted, true);
  assert.deepEqual(result.subtotals, [{ currency: "USD", amount: 200 }, { currency: "MXN", amount: 3.02 }]);
  assert.equal(result.total, undefined);
});

test("configured positive divisor computes weight from volume without an inferred constant", () => {
  for (const type of ["LCL", "BBK", "AIR"]) {
    const result = cargoCalculation(type, { ...lcl, method: "volumetric", volumeDivisor: 6000 });
    assert.equal(result.valid, true);
    assert.equal(result.chargeableValue, 2000000 / 6000);
    assert.equal(result.total, 666.67);
    assert.equal(result.basis, "volumetric_weight");
  }
  for (const volumeDivisor of [undefined, "", 0, -1, "wrong", Infinity]) {
    const result = cargoCalculation("AIR", { ...lcl, method: "volumetric", volumeDivisor });
    assert.equal(result.attempted, true);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.startsWith("volumeDivisor:")));
    assert.equal(result.total, undefined);
  }
});

test("manual chargeable mode requires quantity, price and currency only", () => {
  for (const type of ["LCL", "BBK", "AIR"]) {
    for (const packages of [undefined, [], [{ lengthCm: 20 }], [{ weightKg: "unreadable" }]]) {
      const result = cargoCalculation(type, { ...air, packages });
      assert.equal(result.valid, true);
      assert.equal(result.total, 1741.2);
      assert.equal(result.totalVolumeCm3, null);
    }
    for (const missing of ["manualChargeable", "unitPrice", "currency"]) {
      const result = cargoCalculation(type, { ...air, [missing]: "" });
      assert.equal(result.valid, false);
      assert.deepEqual(result.rows, []);
    }
  }
});

test("descriptive partial cargo with no price is never an attempted transport charge", () => {
  for (const [type, value] of [
    ["FCL", { containers: [{ containerType: "40HQ", quantity: 2 }] }],
    ["FCL", { containers: [{ quantity: -1 }] }],
    ["LCL", { packages: [{ weightKg: 10, weightCount: 2 }] }],
    ["BBK", { packages: [{ packageCount: 2 }] }],
    ["AIR", { manualChargeable: 50, packages: [{ lengthCm: 5 }] }],
  ]) {
    const result = cargoCalculation(type, value);
    assert.equal(result.attempted, false);
    assert.deepEqual(buildCargoChargeRows(type, result), []);
    assert.equal(cargoPricingAttempted(type, value), false);
  }
});

test("entering any price fully validates partial automatic cargo, including explicit zero", () => {
  for (const price of [0, 1, -1, "bad"]) {
    for (const type of ["LCL", "BBK"]) {
      const result = cargoCalculation(type, { packages: [{ weightKg: 10 }], unitPrice: price, currency: "MXN" });
      assert.equal(result.attempted, true);
      assert.equal(result.valid, false);
    }
    const result = cargoCalculation("FCL", { containers: [{ unitPrice: price, currency: "USD" }] });
    assert.equal(result.attempted, true);
    assert.equal(result.valid, false);
  }
  assert.equal(cargoCalculation("AIR", { ...air, unitPrice: 0 }).total, 0);
});

test("method-specific malformed inputs and arithmetic overflow stay rejected after repeated normalization", () => {
  const cases = [
    ["AIR", { ...air, method: "invented" }],
    ["AIR", { ...air, manualChargeable: -1 }],
    ["AIR", { ...air, currency: "EUR" }],
    ["AIR", { ...air, unitPrice: "bad" }],
    ["LCL", { ...lcl, packages: [{ ...box, packageCount: 1.5 }] }],
    ["BBK", { ...lcl, packages: [{ ...box, widthCm: -2 }] }],
    ["AIR", { ...lcl, method: "volumetric", volumeDivisor: 1e-300 }],
    ["AIR", { ...air, manualChargeable: Number.MAX_SAFE_INTEGER }],
  ];
  for (const [type, input] of cases) {
    let value = input;
    for (let round = 0; round < 3; round += 1) {
      const result = cargoCalculation(type, value);
      assert.equal(result.attempted, true);
      assert.equal(result.valid, false);
      assert.deepEqual(result.rows, []);
      assert.equal(result.total, undefined);
      value = normalizeCargoPricing(value, type);
    }
  }
});

test("four independent modes roundtrip and updating AIR does not change sea modes", () => {
  const states = { FCL: fcl, LCL: lcl, BBK: { ...lcl, method: "volumetric", volumeDivisor: 5000 }, AIR: air };
  const normalized = normalizeCargoPricingByType(states);
  assert.deepEqual(normalizeCargoPricingByType(JSON.parse(JSON.stringify(normalized))), normalized);
  const parsed = parseCargoPricingByType({
    cargoPricingByType: JSON.stringify(states), cargo_method: "manual",
    cargo_manualChargeable: "900", cargo_unitPrice: "3", cargo_currency: "USD",
  }, "AIR");
  assert.deepEqual(parsed.FCL, normalized.FCL);
  assert.deepEqual(parsed.LCL, normalized.LCL);
  assert.deepEqual(parsed.BBK, normalized.BBK);
  assert.equal(parsed.AIR.manualChargeable, 900);
  assert.equal(cargoCalculation("AIR", parsed.AIR).total, 2700);
  assert.equal(parseCargoPricingByType({ cargoPricingByType: JSON.stringify(states) }, "AIR").AIR.manualChargeable, 725.5);
});

test("invalid hidden JSON, types and state shapes remain explicit active errors", () => {
  for (const state of ["{", "null", "[]", "42", JSON.stringify({ LQD: {} }), JSON.stringify({ BBK: null })]) {
    const result = parseCargoPricingByType({
      cargoPricingByType: state, cargo_method: "manual", cargo_manualChargeable: 10, cargo_unitPrice: 1, cargo_currency: "MXN",
    }, "AIR");
    assert.ok(result._validationErrors.length);
    assert.equal(cargoCalculation("AIR", result.AIR).valid, false);
    assert.equal(cargoCalculation("AIR", result.AIR).attempted, true);
    assert.ok(normalizeCargoPricingByType(result)._validationErrors.length);
  }
  const nested = parseCargoPricingByType({ cargoPricingByType: { AIR: air } }, "AIR");
  assert.ok(nested._validationErrors.includes("cargoPricingByType:invalid_json"));
});

test("each mode is capped at 100 rows and oversize states are not silently accepted", () => {
  const full = { containers: Array.from({ length: 100 }, () => fcl.containers[0]) };
  assert.equal(cargoCalculation("FCL", full).total, 20000);
  const oversize = { containers: [...full.containers, fcl.containers[0]] };
  const normalized = normalizeCargoPricing(oversize, "FCL");
  assert.equal(normalized.containers.length, 100);
  assert.equal(cargoCalculation("FCL", normalized).valid, false);
  const reopened = parseCargoPricingByType({
    cargoPricingByType: JSON.stringify(normalizeCargoPricingByType({ FCL: normalized })),
    cargo_containerType: normalized.containers.map((row) => row.containerType),
    cargo_containerQuantity: normalized.containers.map((row) => row.quantity),
    cargo_containerPrice: normalized.containers.map((row) => row.unitPrice),
    cargo_containerCurrency: normalized.containers.map((row) => row.currency),
  }, "FCL");
  assert.ok(reopened.FCL.validationErrors.includes("containers:too_many_rows"));
  assert.equal(cargoCalculation("FCL", reopened.FCL).valid, false, "reopening the truncated 100-row view cannot remove its original limit error");
  for (const activeType of ["FCL", "AIR"]) {
    const states = parseCargoPricingByType({ cargoPricingByType: JSON.stringify({ FCL: oversize }), cargo_unitPrice: 2 }, activeType);
    assert.ok(states._validationErrors.length);
    assert.equal(cargoCalculation(activeType, states[activeType]).valid, false);
  }
  const posted = parseCargoPricing({ cargo_weightKg: Array(101).fill(1) }, "LCL");
  assert.ok(posted.validationErrors.includes("packages:too_many_rows"));
  assert.equal(cargoCalculation("LCL", posted).attempted, true);
});

test("cleared active fields replace the old active state while inactive values survive", () => {
  const state = parseCargoPricingByType({ cargoPricingByType: JSON.stringify({ AIR: air, LCL: lcl }), cargo_unitPrice: "", cargo_manualChargeable: "", cargo_method: "manual" }, "AIR");
  assert.equal(state.AIR.unitPrice, "");
  assert.equal(cargoCalculation("AIR", state.AIR).attempted, false);
  assert.equal(cargoCalculation("LCL", state.LCL).total, 4000000);
});

test("re-rendered fallback values cannot silently erase an active method rejection", () => {
  const bad = normalizeCargoPricing({ ...lcl, method: "unsupported" }, "LCL");
  assert.equal(bad.method, "raw_max");
  const body = {
    cargoPricingByType: JSON.stringify({ LCL: bad }), cargo_method: "raw_max",
    cargo_lengthCm: [100], cargo_widthCm: [100], cargo_heightCm: [100],
    cargo_packageCount: [2], cargo_weightKg: [100], cargo_weightCount: [2],
    cargo_unitPrice: 2, cargo_currency: "MXN",
  };
  const unchanged = parseCargoPricingByType(body, "LCL");
  assert.equal(cargoCalculation("LCL", unchanged.LCL).valid, false);
  assert.ok(unchanged.LCL.validationErrors.includes("method:invalid_method"));
  const corrected = { ...bad };
  delete corrected.validationErrors;
  const edited = parseCargoPricingByType({ ...body, cargoPricingByType: JSON.stringify({ LCL: corrected }) }, "LCL");
  assert.equal(cargoCalculation("LCL", edited.LCL).valid, true);
});

test("one damaged mode never causes derived corruption in healthy modes and can be explicitly reset", () => {
  let state = parseCargoPricingByType({ cargoPricingByType: JSON.stringify({ FCL: fcl, BBK: { packages: [{}].concat(Array(100).fill({})) }, AIR: air }) }, "FCL");
  for (const active of ["AIR", "FCL", "AIR", "FCL"]) {
    state = parseCargoPricingByType({ cargoPricingByType: JSON.stringify(state) }, active);
    assert.deepEqual(state._validationErrors, ["cargoPricingByType:BBK:invalid_state"]);
    assert.equal(cargoCalculation(active, state[active]).valid, false);
    assert.ok(!state._validationErrors.some((error) => /:(?:FCL|AIR):/.test(error)));
  }
  state.BBK = normalizeCargoPricing({}, "BBK");
  // A stale derived map marker is recomputed from local evidence rather than
  // blocking forever after the user has explicitly reset the damaged mode.
  state = parseCargoPricingByType({ cargoPricingByType: JSON.stringify(state) }, "FCL");
  assert.equal(state._validationErrors, undefined);
  assert.equal(cargoCalculation("FCL", state.FCL).total, 200);
  state = parseCargoPricingByType({ cargoPricingByType: JSON.stringify(state) }, "AIR");
  assert.equal(cargoCalculation("AIR", state.AIR).total, 1741.2);
  const global = parseCargoPricingByType({ cargoPricingByType: JSON.stringify({ FCL: fcl, _validationErrors: ["cargoPricingByType:invalid_json"] }) }, "FCL");
  assert.equal(cargoCalculation("FCL", global.FCL).valid, false);
  assert.deepEqual(global._validationErrors, ["cargoPricingByType:invalid_json"]);
});

test("generated lines describe the actual method and retain editable unit/currency quantities", () => {
  const manual = buildCargoChargeRows("AIR", cargoCalculation("AIR", air))[0];
  assert.equal(manual.code, "", "generated transport charges do not invent an official business code");
  assert.ok(buildCargoChargeRows("FCL", cargoCalculation("FCL", fcl)).every((row) => row.code === ""));
  assert.equal(manual.unit, 725.5);
  assert.equal(manual.currency, "USD");
  assert.match(manual.remark, /Manual chargeable quantity = 725.5/);
  assert.doesNotMatch(manual.remark, /max\(/);
  const volumetric = buildCargoChargeRows("BBK", cargoCalculation("BBK", { ...lcl, method: "volumetric", volumeDivisor: 6000 }))[0];
  assert.match(volumetric.remark, /6000 cm³\/kg/);
  const raw = buildCargoChargeRows("LCL", cargoCalculation("LCL", lcl))[0];
  assert.match(raw.remark, /max\(200 kg, 2000000 cm³\)/);
});

test("browser UMD shares identical calculations, attempted rules and four-mode state", () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/quote-pricing.js"), "utf8"), context);
  const browser = context.QuotePricing;
  for (const [type, value] of [["FCL", fcl], ["LCL", lcl], ["BBK", { ...lcl, method: "volumetric", volumeDivisor: 6000 }], ["AIR", air]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(browser.calculateCargoPricing(type, value))), calculateCargoPricing(type, value));
    assert.equal(browser.cargoPricingAttempted(type, value), cargoPricingAttempted(type, value));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(browser.normalizeCargoPricingByType({ FCL: fcl, AIR: air }))), normalizeCargoPricingByType({ FCL: fcl, AIR: air }));
});
console.log(`\nCargo pricing release: ${passed} checks passed.`);
