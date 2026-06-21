// Audit 2 — CONTENTO post-pricing regression.
// (1) round-trip: 26 yards keep real maniobra + limpieza through normalize, keyed
//     by the 20 handover container types. (2) cost calc consumes the maniobra
//     (replicates calculate.js dropoff loop). (3) inert: empty shippingLineIds
//     excludes CONTENTO yards from availableYards when a line is selected.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../src/lib/store.js");

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "shipping-lines.json"), "utf8")
);
const norm = store.normalizeShippingData(structuredClone(raw));
const customs = norm.modules.customs;
const handoverTypes = norm.modules.handover.containerTypes.map((t) => t.key);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS ", m); };

// (1) round-trip
const contentoYards = customs.yards.filter((y) => y.id.startsWith("yard-mzo-contento-"));
assert.equal(contentoYards.length, 26, "26 CONTENTO yards");
let zeros = 0;
for (const y of contentoYards) {
  const mani = y.dropoffCharges.find((c) => /maniobra/i.test(c.id));
  const limp = y.dropoffCharges.find((c) => /limpieza/i.test(c.id));
  const keys = Object.keys(mani.groupRates);
  assert.deepEqual(keys.sort(), [...handoverTypes].sort(), `${y.id} maniobra keyed by 20 handover types`);
  const r = mani.groupRates["40GP"].rate;
  if (r === 0) zeros += 1;
  assert.equal(limp.groupRates["40GP"].rate, 550, `${y.id} limpieza 550`);
  assert.equal(mani.taxRate, 0.16, `${y.id} +IVA`);
  assert.equal(mani.groupRates["40GP"].currency, "MXN", `${y.id} MXN`);
}
assert.equal(zeros, 0, "no maniobra is 0");
const servim = contentoYards.find((y) => y.id === "yard-mzo-contento-servimaniobras");
const tep = contentoYards.find((y) => y.id === "yard-mzo-contento-tep");
assert.equal(servim.dropoffCharges.find((c) => /maniobra/i.test(c.id)).groupRates["40GP"].rate, 3800, "Servimaniobras 3800");
assert.equal(tep.dropoffCharges.find((c) => /maniobra/i.test(c.id)).groupRates["40GP"].rate, 5850, "TEP 5850");
ok("round-trip: 26 yards, real prices (3800–5850), 20-key, MXN +IVA, no zeros");

// (2) cost calc consumption (replicate calculate.js:867-888 dropoff loop)
function dropoffCost(yard, rows) {
  let total = 0;
  for (const charge of yard.dropoffCharges || []) {
    for (const row of rows) {
      const rc = charge.groupRates?.[row.containerGroupKey];
      if (!rc) continue;
      total += rc.rate * row.quantity;
    }
  }
  return total;
}
const rows = [{ containerGroupKey: "40GP", quantity: 2 }];
// Servimaniobras: (3800 maniobra + 550 limpieza) * 2 = 8700
assert.equal(dropoffCost(servim, rows), (3800 + 550) * 2, "Servimaniobras dropoff cost = (3800+550)*2");
ok("cost calc: maniobra+limpieza flow into dropoff cost (8700 for 2×40GP)");

// (3) inert: empty shippingLineIds -> excluded when a line is selected
const selectedShippingLine = { id: "cma-cgm" };
const availableWithLine = customs.yards.filter(
  (yard) => !selectedShippingLine || (yard.shippingLineIds || []).includes(selectedShippingLine.id)
);
const contentoAvailable = availableWithLine.filter((y) => y.id.startsWith("yard-mzo-contento-"));
assert.equal(contentoAvailable.length, 0, "CONTENTO yards not available under a selected line (inert)");
// and all CONTENTO yards have empty shippingLineIds (método B)
assert.ok(contentoYards.every((y) => (y.shippingLineIds || []).length === 0), "all CONTENTO shippingLineIds empty (método B)");
ok("inert: empty shippingLineIds excludes CONTENTO from availableYards under a line");

console.log(`\naudit-contento-test: ${passed}/${passed} passed`);
console.log("audit-contento-test-ok");
