#!/usr/bin/env node
"use strict";

// Golden regression for handover local charges / guarantee / demurrage.
//
// Locks the MONEY OUTPUTS and per-charge rate-group RESOLUTION RESULTS for every
// carrier × container type × scenario, so capability changes to the rate-group
// candidate arrays (shared.js RATE_GROUPS / normalize keys derivation) can be
// proven zero-behavior-change: candidate arrays may grow, but which key each
// charge resolves to — and every cent — must stay identical until a line's DATA
// opts into the new keys.
//
// Pure in-process: fixtures + normalizeShippingData + computeHandoverCalculator.
// No DB, no network; exchange rates are pinned inside the fixtures.
//
//   node scripts/golden-local-charges-test.js          # compare against baseline
//   node scripts/golden-local-charges-test.js --write  # (re)generate baseline
//
// Baseline: scripts/golden/local-charges.golden.json
//
// What is deliberately NOT captured: containerRows/rateGroupKeys arrays (the
// capability change grows them by design), i18n-heavy formula strings, and the
// exchangeRates echo. Captured instead: per-part/per-item scalars, category and
// grand totals, matchedTierLabels, and the resolution matrix (with fallback
// resolutions marked "!key" — the Object.keys()[0] fallback of calculate.js:99).

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { normalizeShippingData } = require("../src/lib/store/normalize-shipping-data");
const { computeHandoverCalculator } = require("../src/lib/calculate");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "golden", "fixtures");
// Gzipped: the raw JSON is ~6.5MB of highly repetitive structure (~170KB gzipped).
// On mismatch the test prints JSON-path diffs, so the blob never needs manual reading.
const BASELINE = path.join(__dirname, "golden", "local-charges.golden.json.gz");

const PINNED_FX = {
  provider: "golden-pin",
  asOfDate: "2026-07-10",
  pairs: [
    { base: "USD", quote: "MXN", rate: 17.5 },
    { base: "MXN", quote: "USD", rate: 0.0571428571 },
  ],
};

// Frozen prod census (2026-07-10 snapshot): every group-rate key that appears in
// any charge of the prod fixture. Guards against a normalize change silently
// dropping a key shape the sweep would then never exercise.
const EXPECTED_PROD_GROUP_KEYS = [
  "fr-20", "fr-40", "gp-hc-sd", "gp-hq-dc", "gp-hq-dc-20", "gp-hq-dc-20-40",
  "gp-hq-dc-40", "imo-dry", "imo-reefer", "imo-special-45", "ot-20", "ot-40",
  "ot-fl-pl", "ot-fr-rf", "ot-fr-rf-20", "ot-fr-rf-40", "reefer", "rf-20",
  "rf-40", "rf-rq", "special-45",
].sort();

// Frozen prod fallback matrix (2026-07-10): the ONLY (line, charge, type) combos
// that resolve through the first-key fallback today, and the key they land on.
// The fallback key is governed by jsonb canonical key order (shortest key first),
// which the fixture preserves. Any drift here is a behavior change.
const SPECIAL_TYPES_8 = ["20FR", "20OT", "20PL", "20TK", "40FR", "40OT", "40PL", "40TK"];
const EXPECTED_FALLBACK_COMBOS = [];
for (const chargeId of ["msc-3", "msc-4", "msc-5"]) {
  for (const typeKey of SPECIAL_TYPES_8) {
    EXPECTED_FALLBACK_COMBOS.push(`msc|${chargeId}|${typeKey}|reefer`);
  }
}
for (const chargeId of ["one-4", "one-5"]) {
  for (const typeKey of ["20TK", "40TK"]) {
    EXPECTED_FALLBACK_COMBOS.push(`one|${chargeId}|${typeKey}|fr-20`);
  }
}
EXPECTED_FALLBACK_COMBOS.sort();

// Expected rateGroup NAME per type for the legacy-signature fixture (entries
// carry only pre-change rateGroupKeys arrays; the signature lookup — plus the
// legacy-signature guard after the capability change — must recover these).
const EXPECTED_LEGACY_MASTER_NAMES = {
  "20FR": "flatrack20", "20GP": "dry", "20HC": "dry", "20NOR": "dry",
  "20OT": "openTop20", "20PL": "platform20", "20RF": "reefer20", "20RHC": "reefer20",
  "20TK": "tank", "40FR": "flatrack40", "40GP": "dry", "40HC": "dry",
  "40NOR": "dry", "40OT": "openTop40", "40PL": "platform40", "40RF": "reefer40",
  "40RHC": "reefer40", "40TK": "tank", "45HC": "fortyFiveDry", "45OT": "fortyFiveOpenTop",
};

// Replica of calculate.js resolveRateGroupKey (:93-100) with hit/fallback
// discrimination. Kept in sync by the resolution-vs-quote cross-check below:
// the golden quotes exercise the real resolver, so a divergence between the
// replica and calculate.js shows up as a resolution-matrix-vs-money mismatch.
function resolveReplica(row, rateMap = {}) {
  const candidates = [
    ...(Array.isArray(row.rateGroupKeys) ? row.rateGroupKeys : []),
    row.containerGroupKey,
  ].filter(Boolean);
  const hit = candidates.find((key) => rateMap?.[key]);
  if (hit) {
    return { key: hit, fallback: false };
  }
  const first = Object.keys(rateMap || {})[0] || "";
  return { key: first, fallback: true };
}

// Tight money+identity projection. Labels/formula strings are derived from these
// numbers and i18n keys — capturing them would triple the baseline size without
// adding diff sensitivity.
function pick(value, fields) {
  const out = {};
  for (const field of fields) {
    if (value[field] !== undefined) {
      out[field] = value[field];
    }
  }
  return out;
}

const PART_FIELDS = ["description", "currency", "unitRate", "sourcePretax", "exchangeRate", "pretaxAmount"];
const ITEM_FIELDS = ["itemId", "concept", "note", "taxRate", "pretaxAmount", "afterTaxAmount", "displayAmount"];
const CATEGORY_FIELDS = ["pretaxTotal", "taxTotal", "afterTaxTotal", "total", "displayTotal"];
const RESULT_FIELDS = ["blCount", "demurrageDays", "priceMode", "quoteCurrency", "activeGuarantee", "pretaxTotal", "afterTaxTotal", "total"];

function projectCategory(category) {
  return {
    ...pick(category, CATEGORY_FIELDS),
    items: (category.items || []).map((item) => ({
      ...pick(item, ITEM_FIELDS),
      parts: (item.parts || []).map((part) => pick(part, PART_FIELDS)),
    })),
  };
}

function projectResult(result) {
  return {
    ...pick(result, RESULT_FIELDS),
    matchedTierLabels: result.matchedTierLabels || [],
    localCharges: projectCategory(result.localCharges),
    guarantee: projectCategory(result.guarantee),
    demurrage: projectCategory(result.demurrage),
  };
}

function makeFormData(containerRows, { blCount = 1, demurrageDays = 0, quoteCurrency = "USD" } = {}) {
  return {
    shippingLineId: "",
    blCount,
    demurrageDays,
    priceMode: "pretax",
    quoteCurrency,
    businessNature: "handover_only",
    taxOverrides: {},
    containerRows,
  };
}

function quote(line, handover, exchangeRates, containerRows, opts) {
  const result = computeHandoverCalculator(
    line,
    makeFormData(containerRows, opts),
    { exchangeRates, settings: handover.settings, containerTypes: handover.containerTypes },
    {}
  );
  return projectResult(result);
}

function resolutionMatrix(handover) {
  const matrix = {};
  for (const line of handover.shippingLines) {
    const perLine = {};
    for (const charge of line.localCharges || []) {
      if (!charge.groupRates || !Object.keys(charge.groupRates).length) {
        continue;
      }
      const perCharge = {};
      for (const type of handover.containerTypes) {
        const row = { rateGroupKeys: type.rateGroupKeys, containerGroupKey: type.key };
        const { key, fallback } = resolveReplica(row, charge.groupRates);
        perCharge[type.key] = fallback ? `!${key}` : key;
      }
      perLine[charge.id] = perCharge;
    }
    matrix[line.id] = perLine;
  }
  return matrix;
}

function sweepFixture(doc, { fullSweep }) {
  const normalized = normalizeShippingData(doc);
  const handover = normalized.modules.handover;
  const exchangeRates = normalized.exchangeRates;
  const out = {
    masterNames: Object.fromEntries(handover.containerTypes.map((t) => [t.key, t.rateGroup])),
    resolution: resolutionMatrix(handover),
    quotes: {},
  };

  const currencies = ["USD", "MXN"];
  const fullDays = fullSweep ? [0, 7, 12, 25] : [12];
  const mixedPairs = [
    ["20GP", "40HC"],
    ["20FR", "40FR"],
    ["20RF", "40RF"],
  ];
  const typeKeys = handover.containerTypes.map((t) => t.key);

  for (const line of handover.shippingLines) {
    const perLine = {};
    for (const typeKey of typeKeys) {
      for (const currency of currencies) {
        for (const days of fullDays) {
          const key = `1x${typeKey}+1BL|d${days}|${currency}`;
          const result = quote(line, handover, exchangeRates, [{ containerGroupKey: typeKey, quantity: 1 }], {
            blCount: 1,
            demurrageDays: days,
            quoteCurrency: currency,
          });
          // Days beyond the primary point only vary demurrage — store a slim
          // demurrage-only projection there to keep the baseline reviewable.
          perLine[key] = days === 12 || !fullSweep
            ? result
            : {
                pretaxTotal: result.pretaxTotal,
                total: result.total,
                demurragePretax: result.demurrage.pretaxTotal,
                matchedTierLabels: result.matchedTierLabels,
              };
        }
        if (fullSweep) {
          const key = `2x${typeKey}|d0|${currency}`;
          perLine[key] = quote(line, handover, exchangeRates, [{ containerGroupKey: typeKey, quantity: 2 }], {
            blCount: 1,
            demurrageDays: 0,
            quoteCurrency: currency,
          });
        }
      }
    }
    if (fullSweep) {
      for (const [a, b] of mixedPairs) {
        if (!typeKeys.includes(a) || !typeKeys.includes(b)) {
          continue;
        }
        for (const currency of currencies) {
          const key = `mixed:${a}+${b}|d12|${currency}`;
          perLine[key] = quote(
            line,
            handover,
            exchangeRates,
            [
              { containerGroupKey: a, quantity: 1 },
              { containerGroupKey: b, quantity: 1 },
            ],
            { blCount: 1, demurrageDays: 12, quoteCurrency: currency }
          );
        }
      }
    }
    out.quotes[line.id] = perLine;
  }
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function buildGolden() {
  const golden = {};

  // 1. Sanitized prod snapshot — full sweep.
  const prodDoc = loadJson(path.join(FIXTURES, "prod-snapshot-20260711-postpatch.json"));
  golden.prod = sweepFixture(prodDoc, { fullSweep: true });

  // 2. Repo seed (JSON-mode reality: master version missing → reseeded from the
  //    STANDARD list; locks that path too) — reduced sweep.
  const seedDoc = loadJson(path.join(ROOT, "data", "shipping-lines.json"));
  seedDoc.exchangeRates = structuredClone(PINNED_FX);
  golden.seed = sweepFixture(seedDoc, { fullSweep: false });

  // 3. Legacy-signature master (version>=1, entries WITHOUT rateGroup names,
  //    frozen pre-change rateGroupKeys arrays): the signature lookup — and after
  //    the capability change, the legacy-signature guard — must recover the same
  //    group names and resolutions.
  const legacyDoc = loadJson(path.join(FIXTURES, "legacy-signature-master.json"));
  golden.legacySignature = sweepFixture(legacyDoc, { fullSweep: false });

  // 4. Missing demurrage assignments: locks the runtime derivation that walks
  //    STANDARD_HANDOVER_CONTAINER_TYPES rateGroupKeys (normalize-handover.js:204-214).
  const noAssignDoc = structuredClone(prodDoc);
  noAssignDoc.modules.handover.shippingLines = noAssignDoc.modules.handover.shippingLines
    .filter((line) => line.id === "zim")
    .map((line) => {
      delete line.demurrage.assignmentsByContainerType;
      return line;
    });
  const noAssignNormalized = normalizeShippingData(noAssignDoc);
  golden.missingAssignments = {
    derivedAssignments:
      noAssignNormalized.modules.handover.shippingLines[0].demurrage.assignmentsByContainerType,
    quotes: sweepFixture(noAssignDoc, { fullSweep: false }).quotes,
  };

  // 5. Custom container type without a size prefix. Two locked behaviors:
  //    - on a line that still has generic columns (cma-cgm): resolves the
  //      generic column, same as before the size split;
  //    - on a 4-sized-column line (zim, post-payload): falls back to the jsonb
  //      first key — the documented SOP #8 risk (custom types need a size
  //      prefix, and non-standard types need an explicit demurrage assignment).
  const customDoc = structuredClone(prodDoc);
  customDoc.modules.handover.containerTypes.push({
    key: "GPX",
    label: "GPX - custom dry type without size prefix",
    rateGroup: "dry",
  });
  customDoc.modules.handover.shippingLines = customDoc.modules.handover.shippingLines.filter(
    (line) => line.id === "zim" || line.id === "cma-cgm"
  );
  golden.customType = sweepFixture(customDoc, { fullSweep: false });

  return golden;
}

function assertHardInvariants(golden) {
  const failures = [];

  // Census: group-rate keys present in the prod fixture.
  const seen = new Set();
  const prodDoc = loadJson(path.join(FIXTURES, "prod-snapshot-20260711-postpatch.json"));
  for (const line of prodDoc.modules.handover.shippingLines) {
    for (const charge of line.localCharges || []) {
      for (const key of Object.keys(charge.groupRates || {})) {
        seen.add(key);
      }
    }
  }
  const census = [...seen].sort();
  if (JSON.stringify(census) !== JSON.stringify(EXPECTED_PROD_GROUP_KEYS)) {
    failures.push(
      `census mismatch:\n  expected ${EXPECTED_PROD_GROUP_KEYS.join(",")}\n  actual   ${census.join(",")}`
    );
  }

  // Fallback matrix: exactly the frozen combos, no more, no fewer.
  const fallbacks = [];
  for (const [lineId, charges] of Object.entries(golden.prod.resolution)) {
    for (const [chargeId, types] of Object.entries(charges)) {
      for (const [typeKey, resolved] of Object.entries(types)) {
        if (resolved.startsWith("!")) {
          fallbacks.push(`${lineId}|${chargeId}|${typeKey}|${resolved.slice(1)}`);
        }
      }
    }
  }
  fallbacks.sort();
  if (JSON.stringify(fallbacks) !== JSON.stringify(EXPECTED_FALLBACK_COMBOS)) {
    failures.push(
      `fallback matrix mismatch (${fallbacks.length} vs expected ${EXPECTED_FALLBACK_COMBOS.length}):\n` +
        `  unexpected: ${fallbacks.filter((c) => !EXPECTED_FALLBACK_COMBOS.includes(c)).join(", ") || "-"}\n` +
        `  missing:    ${EXPECTED_FALLBACK_COMBOS.filter((c) => !fallbacks.includes(c)).join(", ") || "-"}`
    );
  }

  // Legacy-signature master must recover every group name.
  for (const [typeKey, expected] of Object.entries(EXPECTED_LEGACY_MASTER_NAMES)) {
    const actual = golden.legacySignature.masterNames[typeKey];
    if (actual !== expected) {
      failures.push(`legacy-signature master: ${typeKey} resolved rateGroup '${actual}' != '${expected}'`);
    }
  }

  // Custom no-prefix type: generic column on a generic-column line; documented
  // first-key fallback on the 4-sized-column line (SOP #8).
  for (const [chargeId, types] of Object.entries(golden.customType.resolution["cma-cgm"] || {})) {
    if (types.GPX !== "gp-hq-dc") {
      failures.push(`custom type GPX on cma-cgm charge ${chargeId}: resolved '${types.GPX}' != 'gp-hq-dc'`);
    }
  }
  for (const [chargeId, types] of Object.entries(golden.customType.resolution.zim || {})) {
    if (types.GPX !== "!gp-hq-dc-20") {
      failures.push(`custom type GPX on zim charge ${chargeId}: resolved '${types.GPX}' != '!gp-hq-dc-20' (SOP #8 fallback)`);
    }
  }

  return failures;
}

function diffPaths(expected, actual, base, out, limit) {
  if (out.length >= limit) {
    return;
  }
  if (typeof expected !== typeof actual || expected === null || actual === null || typeof expected !== "object") {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push(`${base}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`);
    }
    return;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    diffPaths(expected[key], actual[key], `${base}.${key}`, out, limit);
    if (out.length >= limit) {
      return;
    }
  }
}

function main() {
  const write = process.argv.includes("--write");
  const golden = buildGolden();

  const hardFailures = assertHardInvariants(golden);
  if (hardFailures.length) {
    console.error("golden-local-charges: HARD INVARIANT FAILURES");
    for (const failure of hardFailures) {
      console.error(`  ✗ ${failure}`);
    }
    process.exit(1);
  }

  if (write) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, zlib.gzipSync(JSON.stringify(golden), { level: 9 }));
    const scenarios = Object.values(golden.prod.quotes).reduce((n, per) => n + Object.keys(per).length, 0);
    console.log(
      `golden-local-charges: baseline written (${scenarios} prod scenarios, ` +
        `${(fs.statSync(BASELINE).size / 1024).toFixed(0)}KB gzipped)`
    );
    return;
  }

  if (!fs.existsSync(BASELINE)) {
    console.error("golden-local-charges: baseline missing — run with --write first");
    process.exit(1);
  }
  const baseline = JSON.parse(zlib.gunzipSync(fs.readFileSync(BASELINE)).toString("utf8"));
  const expectedStr = JSON.stringify(baseline);
  const actualStr = JSON.stringify(golden);
  if (expectedStr === actualStr) {
    const scenarios = Object.values(golden.prod.quotes).reduce((n, per) => n + Object.keys(per).length, 0);
    console.log(`golden-local-charges: OK — ${scenarios} prod scenarios + seed/legacy/assign/custom fixtures, diff=0`);
    return;
  }
  const diffs = [];
  diffPaths(baseline, golden, "$", diffs, 20);
  console.error(`golden-local-charges: BASELINE DIFF (first ${diffs.length} paths)`);
  for (const diff of diffs) {
    console.error(`  ✗ ${diff}`);
  }
  process.exit(1);
}

main();
