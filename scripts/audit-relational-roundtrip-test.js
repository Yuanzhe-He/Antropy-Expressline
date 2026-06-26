// Relational write-path round-trip net — closes the CI gap that let the tarifas
// bug class through. `npm run test:all` forces STORAGE_DRIVER=json, so until now
// NO suite exercised the relational read→edit→save→read cycle the production app
// actually runs (STORAGE_MODE=relational). The integration-test that does needs a
// live sandbox Postgres (.env.sandbox), so it never ran in CI.
//
// This suite drives the REAL store facade (src/lib/store) in relational mode
// against an in-memory db mock built on the real decompose()/assemble() mapping —
// no Postgres required, so it always runs in CI. It proves that a carrier holding
// the legacy invalid demurrage shapes (the MSC/WHAN HAI/OOCL data) plus local
// charges and a terminal mix survives a full relational round-trip with zero
// drift, and that a normal edit persists through saveModule + reads back.
//
// (decompose stores demurrage + terminalMix as opaque jsonb on the carrier row
// and decomposes localCharges into carrier_local_charges rows; this asserts all
// three survive the table mapping.)

const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0"; // force a fresh assemble on every read

const { decompose, assemble } = require("../src/lib/db/relational-map");

const CARRIER_ID = "zt-rel-roundtrip";

function mkRule(id, startDay, endDay, freeRule, rate) {
  return {
    id,
    label: "",
    note: null,
    startDay,
    endDay,
    freeRule,
    taxRate: 0,
    rateConfig: { label: "", qtyHint: 1, currency: "USD", rate },
  };
}

// A carrier carrying BOTH legacy invalid demurrage shapes + an editable local
// charge and terminal-mix row, grafted onto the bundled seed.
function buildSeed() {
  const seed = JSON.parse(
    require("node:fs").readFileSync(
      path.join(__dirname, "../data/shipping-lines.json"),
      "utf8"
    )
  );
  const handover = seed.modules.handover;
  const carrier = structuredClone(handover.shippingLines[0]);
  carrier.id = CARRIER_ID;
  carrier.name = "ZT Rel Roundtrip";
  carrier.localCharges = [
    {
      id: "ztr-c1",
      concept: "ZT Doc Fee",
      note: null,
      taxRate: 0,
      groupRates: {},
      blRate: { qtyHint: 1, currency: "USD", rate: 45 },
    },
  ];
  carrier.terminalMix = [
    { id: "ztr-m1", port: "MANZANILLO", terminal: "CONTECON", ratio: 0.5 },
  ];
  carrier.guarantee = {
    benefitEnabled: false,
    benefitExpiresAt: null,
    benefitNote: null,
    taxRate: 0,
    ratesByGroup: {},
  };
  carrier.demurrage = {
    calculationMode: carrier.demurrage?.calculationMode || "progressive",
    freeDays: { defaultDays: 0, daysByGroup: {} },
    rulesByGroup: {},
    assignmentsByContainerType: {},
    ruleSets: [
      {
        id: "zt-open",
        name: "ZT Open Tier",
        sourceGroupKey: null,
        rules: [
          mkRule("zo0", 1, 5, true, 0),
          mkRule("zo1", 6, null, false, 200), // open-ended but not last
          mkRule("zo2", 8, 14, false, 200),
        ],
      },
      {
        id: "zt-rel",
        name: "ZT Relative Tier",
        sourceGroupKey: null,
        rules: [
          mkRule("zr0", 1, 7, true, 0),
          mkRule("zr1", 8, 3, false, 140), // end 3 < running nextStart 8
          mkRule("zr2", 9, null, false, 155),
        ],
      },
    ],
  };
  handover.shippingLines = [carrier, ...handover.shippingLines.slice(1)];
  return seed;
}

// Mirror of the sequential gate (pure read).
function gateRejects(rules) {
  let nextStart = 1;
  for (let i = 0; i < rules.length; i += 1) {
    const endDay = rules[i].endDay == null ? null : rules[i].endDay;
    if (endDay !== null && endDay < nextStart) return true;
    if (endDay === null && i < rules.length - 1) return true;
    if (endDay !== null) nextStart = endDay + 1;
  }
  return false;
}

const ruleSeq = (set) =>
  set.rules.map((r) => ({ id: r.id, startDay: r.startDay, endDay: r.endDay }));

// --- in-memory relational store, backed by the REAL decompose/assemble -------
let tables = null; // { tableName: [rows] }
const blob = {}; // app_state key -> payload

const fakeDb = {
  shouldUseDatabase: () => true,
  getShippingTablesAssembled: async () => (tables ? assemble(tables) : null),
  // saveModuleTables receives the fully-normalized whole document; decomposing it
  // and replacing the table set is equivalent to syncing every table (the rows are
  // the new authoritative set), which is what the real module save converges to.
  saveModuleTables: async (_moduleKey, normalized) => {
    tables = decompose(normalized);
  },
  saveShippingTables: async (normalized) => {
    tables = decompose(normalized);
  },
  saveCarrierEntity: async (carrier) => {
    const next = decompose({
      modules: { handover: { shippingLines: [carrier] }, customs: { shippingLines: [] } },
    });
    const row = next.carriers[0];
    tables.carriers = tables.carriers.map((r) => (r.id === row.id ? row : r));
    tables.carrier_local_charges = [
      ...tables.carrier_local_charges.filter((r) => r.carrier_id !== carrier.id),
      ...next.carrier_local_charges,
    ];
  },
  getAppState: async (key) => (blob[key] ? structuredClone(blob[key]) : null),
  saveAppState: async (key, payload) => {
    blob[key] = structuredClone(payload);
  },
  patchAppStateField: async () => 1,
  saveCustomsYardEntity: async () => undefined,
  saveExchangeRatesTable: async () => undefined,
  saveInlandRateEntryEntity: async () => undefined,
};

const dbPath = require.resolve(path.join(__dirname, "../src/lib/db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const store = require("../src/lib/store");
const { normalizeShippingData } = require("../src/lib/store");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  const seed = buildSeed();
  const normalized = normalizeShippingData(seed);
  tables = decompose(normalized); // initial relational state

  const findCarrier = (data) =>
    data.modules.handover.shippingLines.find((l) => l.id === CARRIER_ID);

  // (1) Pure decompose↔assemble fidelity for the demurrage-bearing carrier.
  {
    const reNorm = normalizeShippingData(assemble(decompose(normalized)));
    const a = findCarrier(normalized);
    const b = findCarrier(reNorm);
    assert.deepEqual(
      b.demurrage.ruleSets.map(ruleSeq),
      a.demurrage.ruleSets.map(ruleSeq),
      "demurrage day-sequences survive decompose→assemble"
    );
    assert.deepEqual(
      b.localCharges.map((c) => ({ id: c.id, concept: c.concept, bl: c.blRate?.rate })),
      a.localCharges.map((c) => ({ id: c.id, concept: c.concept, bl: c.blRate?.rate })),
      "local charges survive decompose→assemble"
    );
    assert.deepEqual(
      b.terminalMix.map((m) => ({ id: m.id, terminal: m.terminal })),
      a.terminalMix.map((m) => ({ id: m.id, terminal: m.terminal })),
      "terminal mix survives decompose→assemble"
    );
    ok("(1) decompose↔assemble preserves demurrage + charges + terminal mix");
  }

  // (2) Relational READ through the store facade returns the invalid sets intact.
  const d1 = await store.getShippingData();
  const c1 = findCarrier(d1);
  assert.ok(c1, "carrier readable in relational mode");
  const openBefore = c1.demurrage.ruleSets.find((s) => s.id === "zt-open");
  const relBefore = c1.demurrage.ruleSets.find((s) => s.id === "zt-rel");
  assert.ok(gateRejects(openBefore.rules), "open-ended-mid set still invalid after read");
  assert.ok(gateRejects(relBefore.rules), "relative-restart set still invalid after read");
  const openSeq = ruleSeq(openBefore);
  const relSeq = ruleSeq(relBefore);
  ok("(2) relational read preserves the legacy invalid demurrage sets");

  // (3) Edit → saveModule → read back: a normal edit persists; the invalid sets
  // are untouched by the relational write/read cycle.
  c1.localCharges[0].concept = "ZT REL NUEVO";
  c1.localCharges[0].blRate.rate = 88;
  c1.terminalMix[0].terminal = "ZT REL TERMINAL";
  await store.saveModule("handover", d1);
  store.invalidateShippingDataCache();

  const d2 = await store.getShippingData();
  const c2 = findCarrier(d2);
  assert.equal(c2.localCharges[0].concept, "ZT REL NUEVO", "edited concept persisted");
  assert.equal(c2.localCharges[0].blRate.rate, 88, "edited BL rate persisted");
  assert.equal(c2.terminalMix[0].terminal, "ZT REL TERMINAL", "edited terminal persisted");
  assert.deepEqual(
    ruleSeq(c2.demurrage.ruleSets.find((s) => s.id === "zt-open")),
    openSeq,
    "open-ended-mid set unchanged through relational round-trip"
  );
  assert.deepEqual(
    ruleSeq(c2.demurrage.ruleSets.find((s) => s.id === "zt-rel")),
    relSeq,
    "relative-restart set unchanged through relational round-trip"
  );
  ok("(3) relational edit→save→readback persists edits + preserves demurrage");

  console.log(`\naudit-relational-roundtrip: ${passed}/3 checks passed`);
  console.log("audit-relational-roundtrip-ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
