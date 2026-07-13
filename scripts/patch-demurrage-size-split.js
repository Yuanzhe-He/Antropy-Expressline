#!/usr/bin/env node
"use strict";

// Production demurrage patcher for the 2026-07-09 TARIFARIO update.
//
// Dry-run by default. Applies only the requested carrier when --apply is present.
// It uses the relational store facade (saveCarrier), never db:seed, and never
// prints secrets. Any --apply write is out-of-band for the live server cache:
// redeploy/restart the app immediately after a successful apply.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.SKIP_FX_REFRESH = "1";

const { loadLocalEnv } = require("../src/lib/env");
const { assertProd } = require("./relational/prod-guard");
const { closeDatabase } = require("../src/lib/db");
const store = require("../src/lib/store");
const { STANDARD_HANDOVER_CONTAINER_TYPES } = require("../src/lib/store/shared");
const { computeHandoverCalculator } = require("../src/lib/calculate");

const OUTPUT_DIR = "/Users/yuanzhehe/Desktop/Codex Project/Express Line - Antropy/outputs";
const BACKUP_DIR = path.join(__dirname, "..", "backups");
const EXPECTED_KEYS = STANDARD_HANDOVER_CONTAINER_TYPES.map((type) => type.key);

const ALIASES = {
  esl: "esl-emirates-shipping-line",
  snk: "sinokor",
  sinokor: "sinokor",
  sl: "sea-lead",
  "sea-lead": "sea-lead",
  tsl: "ts-lines",
  "ts-lines": "ts-lines",
  hmm: "hmm",
  snt: "sinotrans",
  sinotrans: "sinotrans",
};

const SIZE_MATRIX = Object.freeze({
  gp20: ["20GP", "20HC", "20NOR"],
  gp40: ["40GP", "40HC", "40NOR", "45HC"],
  ot20: ["20OT", "20FR", "20PL", "20TK"],
  ot40: ["40OT", "40FR", "40PL", "40TK", "45OT"],
  rf20: ["20RF", "20RHC"],
  rf40: ["40RF", "40RHC"],
});

const DRY_KEYS = [...SIZE_MATRIX.gp20, ...SIZE_MATRIX.gp40];
const OT_KEYS = [...SIZE_MATRIX.ot20, ...SIZE_MATRIX.ot40];
const RF_KEYS = [...SIZE_MATRIX.rf20, ...SIZE_MATRIX.rf40];
const SIX_LINE_IDS = [
  "esl-emirates-shipping-line",
  "sinokor",
  "sea-lead",
  "ts-lines",
  "hmm",
  "sinotrans",
];

function parseArgs(argv) {
  const args = { apply: false, audit: false, carrier: "", caliber: "" };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--audit-six-lines") args.audit = true;
    else if (arg.startsWith("--carrier=")) args.carrier = arg.slice("--carrier=".length).trim();
    else if (arg.startsWith("--caliber=")) args.caliber = arg.slice("--caliber=".length).trim().toLowerCase();
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/patch-demurrage-size-split.js --audit-six-lines",
    "  node scripts/patch-demurrage-size-split.js --carrier=ts-lines [--apply]",
    "  node scripts/patch-demurrage-size-split.js --carrier=sinotrans [--apply]",
    "  node scripts/patch-demurrage-size-split.js --carrier=sinokor --caliber=a|b [--apply]",
    "  node scripts/patch-demurrage-size-split.js --carrier=hmm --caliber=a|b [--apply]",
    "  node scripts/patch-demurrage-size-split.js --carrier=esl [--apply]",
  ].join("\n");
}

function clone(value) {
  return structuredClone(value);
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function targetCarrierId(input) {
  const key = String(input || "").toLowerCase();
  return ALIASES[key] || input;
}

function findCarrier(handover, input) {
  const wanted = targetCarrierId(input);
  return (handover.shippingLines || []).find((line) => {
    const code = String(line.notes?.code || "").toLowerCase();
    return (
      line.id === wanted ||
      String(line.id).toLowerCase() === String(wanted).toLowerCase() ||
      code === String(input || "").toLowerCase() ||
      String(line.name || "").toLowerCase() === String(input || "").toLowerCase()
    );
  });
}

function findSet(carrier, ...needles) {
  const lowered = needles.filter(Boolean).map((item) => String(item).toLowerCase());
  return (carrier.demurrage?.ruleSets || []).find((set) => {
    const haystack = [set.id, set.name, set.sourceGroupKey]
      .filter(Boolean)
      .map((item) => String(item).toLowerCase());
    return lowered.some((needle) => haystack.some((item) => item.includes(needle)));
  });
}

function rule(setId, setName, index, tier, existingRule) {
  const rate = Number(tier.rate || 0);
  const freeRule = rate === 0;
  return {
    id: existingRule?.id || `${setId}-rule-${index + 1}`,
    label: store.formatDemurrageRuleLabel(tier.startDay, tier.endDay, freeRule),
    note: existingRule?.note ?? null,
    startDay: tier.startDay,
    endDay: tier.endDay,
    freeRule,
    taxRate: tier.taxRate,
    rateConfig: {
      label: setName,
      qtyHint: 1,
      currency: tier.currency || "USD",
      rate,
    },
  };
}

function ruleSet({ id, name, sourceGroupKey = null, tiers, existingSet = null }) {
  const setId = existingSet?.id || id;
  const setName = name;
  return {
    id: setId,
    name: setName,
    sourceGroupKey: existingSet ? existingSet.sourceGroupKey || sourceGroupKey : sourceGroupKey,
    rules: tiers.map((tier, index) =>
      rule(setId, setName, index, tier, existingSet?.rules?.[index])
    ),
  };
}

function tiers(freeDays, paid, taxRate) {
  return [
    { startDay: 1, endDay: freeDays, rate: 0, taxRate: 0, currency: "USD" },
    ...paid.map((entry) => ({
      startDay: entry[0],
      endDay: entry[1],
      rate: entry[2],
      taxRate,
      currency: "USD",
    })),
  ];
}

function validateRuleSequence(set) {
  let nextStart = 1;
  for (const r of set.rules || []) {
    if (r.startDay !== nextStart) {
      throw new Error(`${set.name}: startDay ${r.startDay} != expected ${nextStart}`);
    }
    if (r.endDay !== null && r.endDay < nextStart) {
      throw new Error(`${set.name}: endDay ${r.endDay} < startDay ${nextStart}`);
    }
    if (r.endDay === null && r !== set.rules[set.rules.length - 1]) {
      throw new Error(`${set.name}: open-ended rule is not last`);
    }
    if (r.endDay !== null) nextStart = r.endDay + 1;
  }
}

function assertAllContainerKeys(assignments) {
  const keys = Object.keys(assignments || {}).sort();
  const expected = [...EXPECTED_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`assignments must contain all 20 container keys; got ${keys.length}`);
  }
}

function sizeAssignments(ids) {
  const out = {};
  for (const key of SIZE_MATRIX.gp20) out[key] = ids.gp20;
  for (const key of SIZE_MATRIX.gp40) out[key] = ids.gp40;
  for (const key of SIZE_MATRIX.ot20) out[key] = ids.ot20;
  for (const key of SIZE_MATRIX.ot40) out[key] = ids.ot40;
  for (const key of SIZE_MATRIX.rf20) out[key] = ids.rf20;
  for (const key of SIZE_MATRIX.rf40) out[key] = ids.rf40;
  assertAllContainerKeys(out);
  return out;
}

function caliberAAssignments(ids) {
  const out = {};
  for (const key of DRY_KEYS) out[key] = ids.gp;
  for (const key of OT_KEYS) out[key] = ids.ot;
  for (const key of RF_KEYS) out[key] = ids.rf;
  assertAllContainerKeys(out);
  return out;
}

function syncCarrierDemurrage(carrier, ruleSets, assignments) {
  for (const set of ruleSets) validateRuleSequence(set);
  assertAllContainerKeys(assignments);
  carrier.demurrage = carrier.demurrage || {};
  carrier.demurrage.calculationMode = "progressive";
  carrier.demurrage.ruleSets = ruleSets;
  carrier.demurrage.assignmentsByContainerType = assignments;
  carrier.demurrage.rulesByGroup = carrier.demurrage.rulesByGroup || {};
  for (const [groupKey, rules] of Object.entries(carrier.demurrage.rulesByGroup)) {
    if (!ruleSets.some((set) => set.sourceGroupKey === groupKey)) {
      delete carrier.demurrage.rulesByGroup[groupKey];
      continue;
    }
    carrier.demurrage.rulesByGroup[groupKey] = rules;
  }
  for (const set of ruleSets) {
    if (set.sourceGroupKey) carrier.demurrage.rulesByGroup[set.sourceGroupKey] = set.rules;
  }
  const daysByGroup = {};
  for (const set of ruleSets) {
    const free = (set.rules || []).find((r) => r.freeRule && r.endDay);
    if (free) daysByGroup[set.id] = free.endDay;
  }
  carrier.demurrage.freeDays = {
    defaultDays: Object.values(daysByGroup)[0] || 0,
    daysByGroup,
  };
  return carrier;
}

function requireTwoSetShape(carrier, label) {
  const count = carrier.demurrage?.ruleSets?.length || 0;
  if (count !== 2) {
    throw new Error(`${label}: expected exactly 2 current rule sets, found ${count}; stop before writing`);
  }
}

function sameRuleSignature(set, expected) {
  return JSON.stringify((set.rules || []).map((r) => [r.startDay, r.endDay, r.rateConfig?.rate, r.taxRate, r.rateConfig?.currency])) ===
    JSON.stringify(expected);
}

function buildTslTarget(current) {
  const currentCount = current.demurrage?.ruleSets?.length || 0;
  if (![2, 6].includes(currentCount)) {
    throw new Error(`TSL: expected 2 pre-patch sets or 6 applied sets, found ${currentCount}`);
  }
  const gp20Existing =
    findSet(current, "gp hq dc 20", "gp hc sd", "gp-hc-sd") || current.demurrage.ruleSets[0];
  const ot20Existing =
    findSet(current, "ot fr 20", "ot-fr-rf", "ot fr") || current.demurrage.ruleSets[1];
  if (currentCount === 2) {
    const gpOk = sameRuleSignature(gp20Existing, [
      [1, 10, 0, 0, "USD"],
      [11, null, 140, 0.16, "USD"],
    ]);
    const otOk = sameRuleSignature(ot20Existing, [
      [1, 7, 0, 0, "USD"],
      [8, 17, 170, 0, "USD"],
      [18, null, 185, 0, "USD"],
    ]);
    if (!gpOk || !otOk) {
      throw new Error("TSL current values do not match the verified pre-patch assumption; stop before writing");
    }
  }

  const sets = [
    ruleSet({
      id: gp20Existing.id,
      name: 'GP HQ DC 20"',
      sourceGroupKey: gp20Existing.sourceGroupKey || "gp-hc-sd",
      tiers: tiers(10, [[11, null, 140]], 0.16),
      existingSet: gp20Existing,
    }),
    ruleSet({
      id: findSet(current, 'gp hq dc 40"')?.id || "demurrage-set-tsl-gp-hq-dc-40",
      name: 'GP HQ DC 40"',
      tiers: tiers(10, [[11, null, 160]], 0.16),
      existingSet: findSet(current, 'gp hq dc 40"'),
    }),
    ruleSet({
      id: ot20Existing.id,
      name: 'OT FR 20"',
      sourceGroupKey: ot20Existing.sourceGroupKey || "ot-fr-rf",
      tiers: tiers(7, [[8, 17, 170], [18, null, 190]], 0.16),
      existingSet: ot20Existing,
    }),
    ruleSet({
      id: findSet(current, 'ot fr 40"')?.id || "demurrage-set-tsl-ot-fr-40",
      name: 'OT FR 40"',
      tiers: tiers(7, [[8, 17, 185], [18, null, 210]], 0.16),
      existingSet: findSet(current, 'ot fr 40"'),
    }),
    ruleSet({
      id: findSet(current, 'reefer 20"')?.id || "demurrage-set-tsl-reefer-20",
      name: 'REEFER 20"',
      tiers: tiers(7, [[8, 17, 180], [18, null, 215]], 0.16),
      existingSet: findSet(current, 'reefer 20"'),
    }),
    ruleSet({
      id: findSet(current, 'reefer 40"')?.id || "demurrage-set-tsl-reefer-40",
      name: 'REEFER 40"',
      tiers: tiers(7, [[8, 17, 190], [18, null, 225]], 0.16),
      existingSet: findSet(current, 'reefer 40"'),
    }),
  ];
  const assignments = sizeAssignments({
    gp20: sets[0].id,
    gp40: sets[1].id,
    ot20: sets[2].id,
    ot40: sets[3].id,
    rf20: sets[4].id,
    rf40: sets[5].id,
  });
  return { target: syncCarrierDemurrage(clone(current), sets, assignments), note: "TSL size split, IVA 16%" };
}

function buildSinotransTarget(current) {
  requireTwoSetShape(current, "SINOTRANS");
  const gp = current.demurrage.ruleSets[0];
  const ot = current.demurrage.ruleSets[1];
  const sets = [
    ruleSet({
      id: gp.id,
      name: gp.name || "GP HC SD",
      sourceGroupKey: gp.sourceGroupKey || "gp-hc-sd",
      tiers: tiers(7, [[8, null, 160]], 0),
      existingSet: gp,
    }),
    ruleSet({
      id: ot.id,
      name: ot.name || "OT FR RF",
      sourceGroupKey: ot.sourceGroupKey || "ot-fr-rf",
      tiers: tiers(7, [[8, null, 160]], 0),
      existingSet: ot,
    }),
  ];
  return {
    target: syncCarrierDemurrage(clone(current), sets, current.demurrage.assignmentsByContainerType || {}),
    note: "SINOTRANS free-day correction to 7 days",
  };
}

function buildSnkTarget(current, caliber) {
  if (!["a", "b"].includes(caliber)) throw new Error("SINOKOR requires --caliber=a|b");
  const gpExisting = findSet(current, "gp") || current.demurrage?.ruleSets?.[0];
  const otExisting = findSet(current, "ot") || current.demurrage?.ruleSets?.[1];
  if (!gpExisting || !otExisting) throw new Error("SINOKOR: missing expected current GP/OT sets");
  if (caliber === "a") {
    const sets = [
      ruleSet({ id: gpExisting.id, name: "GP", sourceGroupKey: gpExisting.sourceGroupKey || "gp-hc-sd", tiers: tiers(10, [[11, 20, 140], [21, null, 160]], 0), existingSet: gpExisting }),
      ruleSet({ id: otExisting.id, name: "OT FR", sourceGroupKey: otExisting.sourceGroupKey || "ot-fr-rf", tiers: tiers(7, [[8, 14, 170], [15, null, 190]], 0), existingSet: otExisting }),
      ruleSet({ id: findSet(current, "reefer")?.id || "demurrage-set-snk-reefer", name: "REEFER", tiers: tiers(7, [[8, 14, 180], [15, null, 210]], 0), existingSet: findSet(current, "reefer") }),
    ];
    return { target: syncCarrierDemurrage(clone(current), sets, caliberAAssignments({ gp: sets[0].id, ot: sets[1].id, rf: sets[2].id })), note: "SINOKOR caliber A preset" };
  }
  const sets = [
    ruleSet({ id: gpExisting.id, name: 'GP 20"', sourceGroupKey: gpExisting.sourceGroupKey || "gp-hc-sd", tiers: tiers(10, [[11, null, 140]], 0), existingSet: gpExisting }),
    ruleSet({ id: findSet(current, 'gp 40"')?.id || "demurrage-set-snk-gp-40", name: 'GP 40"', tiers: tiers(10, [[11, null, 160]], 0), existingSet: findSet(current, 'gp 40"') }),
    ruleSet({ id: otExisting.id, name: 'OT FR 20"', sourceGroupKey: otExisting.sourceGroupKey || "ot-fr-rf", tiers: tiers(7, [[8, null, 170]], 0), existingSet: otExisting }),
    ruleSet({ id: findSet(current, 'ot fr 40"')?.id || "demurrage-set-snk-ot-fr-40", name: 'OT FR 40"', tiers: tiers(7, [[8, null, 190]], 0), existingSet: findSet(current, 'ot fr 40"') }),
    ruleSet({ id: findSet(current, 'reefer 20"')?.id || "demurrage-set-snk-reefer-20", name: 'REEFER 20"', tiers: tiers(7, [[8, null, 180]], 0), existingSet: findSet(current, 'reefer 20"') }),
    ruleSet({ id: findSet(current, 'reefer 40"')?.id || "demurrage-set-snk-reefer-40", name: 'REEFER 40"', tiers: tiers(7, [[8, null, 210]], 0), existingSet: findSet(current, 'reefer 40"') }),
  ];
  return { target: syncCarrierDemurrage(clone(current), sets, sizeAssignments({ gp20: sets[0].id, gp40: sets[1].id, ot20: sets[2].id, ot40: sets[3].id, rf20: sets[4].id, rf40: sets[5].id })), note: "SINOKOR caliber B preset" };
}

function buildHmmTarget(current, caliber) {
  if (!["a", "b"].includes(caliber)) throw new Error("HMM requires --caliber=a|b");
  const gpExisting = findSet(current, "gp") || current.demurrage?.ruleSets?.[0];
  const otExisting = findSet(current, "ot") || current.demurrage?.ruleSets?.[1];
  if (!gpExisting || !otExisting) throw new Error("HMM: missing expected current GP/OT sets");
  if (caliber === "a") {
    const sets = [
      ruleSet({ id: gpExisting.id, name: "GP", sourceGroupKey: gpExisting.sourceGroupKey || "gp-hc-sd", tiers: tiers(5, [[6, 10, 160], [11, null, 170]], 0.16), existingSet: gpExisting }),
      ruleSet({ id: otExisting.id, name: "OT FR", sourceGroupKey: otExisting.sourceGroupKey || "ot-fr-rf", tiers: tiers(5, [[6, 10, 210], [11, null, 220]], 0.16), existingSet: otExisting }),
      ruleSet({ id: findSet(current, "reefer")?.id || "demurrage-set-hmm-reefer", name: "REEFER", tiers: tiers(5, [[6, 10, 210], [11, null, 220]], 0.16), existingSet: findSet(current, "reefer") }),
    ];
    return { target: syncCarrierDemurrage(clone(current), sets, caliberAAssignments({ gp: sets[0].id, ot: sets[1].id, rf: sets[2].id })), note: "HMM caliber A preset" };
  }
  const sets = [
    ruleSet({ id: gpExisting.id, name: 'GP 20"', sourceGroupKey: gpExisting.sourceGroupKey || "gp-hc-sd", tiers: tiers(5, [[6, null, 160]], 0.16), existingSet: gpExisting }),
    ruleSet({ id: findSet(current, 'gp 40"')?.id || "demurrage-set-hmm-gp-40", name: 'GP 40"', tiers: tiers(5, [[6, null, 170]], 0.16), existingSet: findSet(current, 'gp 40"') }),
    ruleSet({ id: otExisting.id, name: 'OT FR 20"', sourceGroupKey: otExisting.sourceGroupKey || "ot-fr-rf", tiers: tiers(5, [[6, null, 210]], 0.16), existingSet: otExisting }),
    ruleSet({ id: findSet(current, 'ot fr 40"')?.id || "demurrage-set-hmm-ot-fr-40", name: 'OT FR 40"', tiers: tiers(5, [[6, null, 220]], 0.16), existingSet: findSet(current, 'ot fr 40"') }),
    ruleSet({ id: findSet(current, 'reefer 20"')?.id || "demurrage-set-hmm-reefer-20", name: 'REEFER 20"', tiers: tiers(5, [[6, null, 210]], 0.16), existingSet: findSet(current, 'reefer 20"') }),
    ruleSet({ id: findSet(current, 'reefer 40"')?.id || "demurrage-set-hmm-reefer-40", name: 'REEFER 40"', tiers: tiers(5, [[6, null, 220]], 0.16), existingSet: findSet(current, 'reefer 40"') }),
  ];
  return { target: syncCarrierDemurrage(clone(current), sets, sizeAssignments({ gp20: sets[0].id, gp40: sets[1].id, ot20: sets[2].id, ot40: sets[3].id, rf20: sets[4].id, rf40: sets[5].id })), note: "HMM caliber B preset" };
}

function buildEslTarget(current) {
  requireTwoSetShape(current, "ESL");
  const gpExisting = findSet(current, "gp") || current.demurrage.ruleSets[0];
  const otExisting = findSet(current, "ot", "fr", "rf") || current.demurrage.ruleSets[1];
  const sets = [
    ruleSet({
      id: gpExisting.id,
      name: gpExisting.name || "GP HC SD",
      sourceGroupKey: gpExisting.sourceGroupKey || "gp-hc-sd",
      tiers: tiers(7, [[8, 10, 165], [11, 14, 175], [15, null, 185]], 0),
      existingSet: gpExisting,
    }),
    ruleSet({
      id: otExisting.id,
      name: otExisting.name || "OT FR RF",
      sourceGroupKey: otExisting.sourceGroupKey || "ot-fr-rf",
      tiers: tiers(7, [[8, null, 220]], 0),
      existingSet: otExisting,
    }),
  ];
  return {
    target: syncCarrierDemurrage(clone(current), sets, current.demurrage.assignmentsByContainerType || {}),
    note: "ESL Estefani verbal correction: GP HC SD 7 free days; OT/FR/RF 220 from day 8",
  };
}

function buildTarget(current, requestedId, caliber) {
  if (requestedId === "ts-lines") return buildTslTarget(current);
  if (requestedId === "sinotrans") return buildSinotransTarget(current);
  if (requestedId === "sinokor") return buildSnkTarget(current, caliber);
  if (requestedId === "hmm") return buildHmmTarget(current, caliber);
  if (requestedId === "esl-emirates-shipping-line") return buildEslTarget(current);
  throw new Error(`no patch payload for ${requestedId}`);
}

function ruleSummary(set) {
  return {
    id: set.id,
    name: set.name,
    sourceGroupKey: set.sourceGroupKey,
    rules: (set.rules || []).map((r) => ({
      startDay: r.startDay,
      endDay: r.endDay,
      taxRate: r.taxRate,
      rate: r.rateConfig?.rate,
      currency: r.rateConfig?.currency,
    })),
  };
}

function carrierSummary(carrier) {
  return {
    id: carrier.id,
    name: carrier.name,
    code: carrier.notes?.code || null,
    ruleSets: (carrier.demurrage?.ruleSets || []).map(ruleSummary),
    assignmentsByContainerType: carrier.demurrage?.assignmentsByContainerType || {},
    freeDays: carrier.demurrage?.freeDays || {},
    containerGroups: carrier.containerGroups || [],
  };
}

function assignmentGroups(assignments) {
  const grouped = {};
  for (const [key, setId] of Object.entries(assignments || {})) {
    (grouped[setId] ||= []).push(key);
  }
  return grouped;
}

function targetDiff(current, target) {
  const before = carrierSummary(current);
  const after = carrierSummary(target);
  return {
    setCount: [before.ruleSets.length, after.ruleSets.length],
    before,
    after,
    assignmentGroupsBefore: assignmentGroups(before.assignmentsByContainerType),
    assignmentGroupsAfter: assignmentGroups(after.assignmentsByContainerType),
  };
}

function approxEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

function demurrageTotal(carrier, typeKey, qty, days) {
  const fixture = clone(carrier);
  fixture.localCharges = [];
  fixture.guarantee = { benefitEnabled: true, taxRate: 0, ratesByGroup: {} };
  const result = computeHandoverCalculator(
    fixture,
    {
      businessNature: "handover_only",
      blCount: 1,
      demurrageDays: days,
      priceMode: "aftertax",
      quoteCurrency: "USD",
      containerRows: [{ containerGroupKey: typeKey, quantity: qty }],
    },
    {
      containerTypes: STANDARD_HANDOVER_CONTAINER_TYPES,
      settings: { defaultQuoteCurrency: "USD" },
      exchangeRates: { pairs: [] },
    },
    { t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }
  );
  return result.demurrage.afterTaxTotal;
}

function validationMatrix(carrier) {
  const matrix = [];
  const add = (label, typeKey, qty, days, expected) => {
    const actual = demurrageTotal(carrier, typeKey, qty, days);
    matrix.push({ label, typeKey, qty, days, expected, actual, ok: approxEqual(actual, expected) });
  };
  if (carrier.id === "ts-lines") {
    add("TSL 1x40HC 15 days", "40HC", 1, 15, 928);
    add("TSL 1x40FR 20 days", "40FR", 1, 20, 2876.8);
    add("TSL 2x20GP 12 days", "20GP", 2, 12, 649.6);
    add("TSL 1x20RHC 18 days", "20RHC", 1, 18, 2337.4);
  } else if (carrier.id === "sinokor") {
    add("SNK 1x40GP 25 days", "40GP", 1, 25, 2200);
    add("SNK 1x20FR 16 days", "20FR", 1, 16, 1570);
    add("SNK 1x20GP 15 days", "20GP", 1, 15, 700);
  } else if (carrier.id === "hmm") {
    add("HMM 1x40HC 12 days", "40HC", 1, 12, 1322.4);
    add("HMM 1x40RF 12 days", "40RF", 1, 12, 1728.4);
  } else if (carrier.id === "esl-emirates-shipping-line") {
    add("ESL 1x20OT 10 days", "20OT", 1, 10, 660);
    add("ESL 1x40GP 16 days", "40GP", 1, 16, 1565);
  }
  return matrix;
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function markdownReport(payload) {
  const lines = [];
  lines.push(`# Demurrage Patch Report ${payload.stamp}`);
  lines.push("");
  lines.push(`- mode: ${payload.apply ? "APPLY" : "DRY-RUN"}`);
  lines.push(`- carrier: ${payload.carrier.id} (${payload.carrier.name})`);
  lines.push(`- note: ${payload.note}`);
  lines.push(`- backup: ${payload.backupFile || "not written (dry-run)"}`);
  lines.push(`- applyConfirmed: ${payload.applyConfirmedFile || "not written (dry-run)"}`);
  lines.push("");
  lines.push("## Set Count");
  lines.push("");
  lines.push(`- before: ${payload.diff.setCount[0]}`);
  lines.push(`- after: ${payload.diff.setCount[1]}`);
  lines.push("");
  lines.push("## Target Rule Sets");
  for (const set of payload.diff.after.ruleSets) {
    lines.push("");
    lines.push(`### ${set.name} (${set.id})`);
    lines.push(`- sourceGroupKey: ${set.sourceGroupKey || "null"}`);
    for (const r of set.rules) {
      lines.push(`- ${r.startDay}-${r.endDay == null ? "open" : r.endDay}: ${r.rate} ${r.currency}, tax ${r.taxRate}`);
    }
  }
  lines.push("");
  lines.push("## Assignment Groups");
  for (const [setId, keys] of Object.entries(payload.diff.assignmentGroupsAfter)) {
    lines.push(`- ${setId}: ${keys.join(", ")}`);
  }
  if (payload.validation?.length) {
    lines.push("");
    lines.push("## Validation Matrix");
    for (const row of payload.validation) {
      lines.push(`- ${row.ok ? "PASS" : "FAIL"} ${row.label}: actual ${row.actual.toFixed(2)} / expected ${Number(row.expected).toFixed(2)}`);
    }
  }
  lines.push("");
  lines.push("## Restart Discipline");
  lines.push("");
  lines.push("After any APPLY, redeploy/restart the Railway app before admin writes or app-side spot checks, because this script is an out-of-band writer relative to the live process cache.");
  return lines.join("\n");
}

function writePatchReport(payload) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = `${payload.stamp}_${payload.carrier.id}_${payload.apply ? "apply" : "dryrun"}`;
  const jsonFile = path.join(OUTPUT_DIR, `${base}.json`);
  const mdFile = path.join(OUTPUT_DIR, `${base}.md`);
  writeJson(jsonFile, payload);
  fs.writeFileSync(mdFile, markdownReport(payload));
  return { jsonFile, mdFile };
}

function writeBackup(carrier, stamp) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const payload = { takenAt: new Date().toISOString(), carriers: [carrierSummary(carrier)] };
  const json = JSON.stringify(payload, null, 2);
  const sha = crypto.createHash("sha256").update(json).digest("hex");
  const file = path.join(BACKUP_DIR, `live-demurrage-prebackup-${sha.slice(0, 12)}.json`);
  fs.writeFileSync(file, json);
  return { file, sha };
}

function writeApplyConfirmed(currentAfter, beforeSummary, stamp) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const payload = {
    appliedAt: new Date().toISOString(),
    before: beforeSummary,
    after: carrierSummary(currentAfter),
  };
  const file = path.join(BACKUP_DIR, `demurrage-size-split-${stamp}-applyconfirmed.json`);
  writeJson(file, payload);
  return file;
}

function auditSixLines(handover, stamp) {
  const carriers = SIX_LINE_IDS.map((id) => findCarrier(handover, id)).filter(Boolean);
  const rows = carriers.map((carrier) => {
    let status = "report-only";
    let target = null;
    let issue = "";
    try {
      if (carrier.id === "ts-lines") {
        target = buildTslTarget(carrier).target;
        status = stableStringify(carrierSummary(carrier)) === stableStringify(carrierSummary(target))
          ? "matches applied TSL target"
          : "fixable-now";
      } else if (carrier.id === "sinotrans") {
        target = buildSinotransTarget(carrier).target;
        status = stableStringify(carrierSummary(carrier)) === stableStringify(carrierSummary(target))
          ? "matches applied SINOTRANS target"
          : "fixable-now";
      } else if (carrier.id === "sea-lead") {
        status = "closed: SL sheet confirmed as Sea Lead";
      } else if (carrier.id === "esl-emirates-shipping-line") {
        target = buildEslTarget(carrier).target;
        status = "Estefani-confirmed ESL target";
      } else if (carrier.id === "sinokor" || carrier.id === "hmm") {
        target = carrier.id === "sinokor" ? buildSnkTarget(carrier, "a").target : buildHmmTarget(carrier, "a").target;
        status = "Estefani-confirmed caliber A target";
      }
    } catch (error) {
      issue = error.message;
    }
    return {
      carrier: carrierSummary(carrier),
      status,
      issue,
      target: target ? carrierSummary(target) : null,
    };
  });
  const payload = { stamp, mode: "READ-ONLY", rows };
  const jsonFile = path.join(OUTPUT_DIR, `${stamp}_six_line_audit.json`);
  const mdFile = path.join(OUTPUT_DIR, `${stamp}_six_line_audit.md`);
  writeJson(jsonFile, payload);
  const lines = [`# Six-Line Demurrage Audit ${stamp}`, ""];
  for (const row of rows) {
    lines.push(`## ${row.carrier.id} - ${row.carrier.name}`);
    lines.push(`- status: ${row.status}`);
    if (row.issue) lines.push(`- issue: ${row.issue}`);
    lines.push(`- current sets: ${row.carrier.ruleSets.length}`);
    for (const set of row.carrier.ruleSets) {
      lines.push(`  - ${set.name}: ${set.rules.map((r) => `${r.startDay}-${r.endDay == null ? "open" : r.endDay} $${r.rate} tax ${r.taxRate}`).join("; ")}`);
    }
    lines.push("");
  }
  fs.writeFileSync(mdFile, lines.join("\n"));
  return { jsonFile, mdFile };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  loadLocalEnv();
  const ref = assertProd(process.env.DATABASE_URL);
  store.invalidateShippingDataCache();
  const data = await store.getShippingData();
  const handover = data.modules.handover;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

  if (args.audit) {
    const report = auditSixLines(handover, stamp);
    console.log(`[audit] ref=${ref} wrote ${report.mdFile}`);
    return;
  }

  if (!args.carrier) {
    console.log(usage());
    throw new Error("--carrier is required unless --audit-six-lines is used");
  }
  const requestedId = targetCarrierId(args.carrier);
  const current = findCarrier(handover, requestedId);
  if (!current) throw new Error(`carrier not found: ${args.carrier}`);

  const { target, note } = buildTarget(current, requestedId, args.caliber);
  const diff = targetDiff(current, target);
  const validation = validationMatrix(target);
  const failedValidation = validation.filter((row) => !row.ok);
  if (failedValidation.length) {
    throw new Error(`validation failed: ${failedValidation.map((row) => row.label).join(", ")}`);
  }

  let backupFile = "";
  let applyConfirmedFile = "";
  if (args.apply) {
    const backup = writeBackup(current, stamp);
    backupFile = backup.file;
    await store.saveCarrier(target);
    store.invalidateShippingDataCache();
    const afterData = await store.getShippingData();
    const afterCarrier = findCarrier(afterData.modules.handover, requestedId);
    const expected = stableStringify(carrierSummary(target));
    const actual = stableStringify(carrierSummary(afterCarrier));
    if (expected !== actual) {
      throw new Error(`post-apply verification mismatch; backup is ${backupFile}`);
    }
    applyConfirmedFile = writeApplyConfirmed(afterCarrier, carrierSummary(current), stamp);
  }

  const payload = {
    stamp,
    apply: args.apply,
    ref,
    carrier: { id: current.id, name: current.name, code: current.notes?.code || null },
    note,
    backupFile,
    applyConfirmedFile,
    diff,
    validation,
  };
  const report = writePatchReport(payload);
  console.log(`[${args.apply ? "apply" : "dry-run"}] ref=${ref} carrier=${current.id} ${note}`);
  console.log(`[report] ${report.mdFile}`);
  if (backupFile) console.log(`[backup] ${backupFile}`);
  if (applyConfirmedFile) console.log(`[apply-confirmed] ${applyConfirmedFile}`);
  if (args.apply) console.log("[restart-required] redeploy/restart the Railway app before admin writes or app-side spot checks.");
}

main()
  .catch((error) => {
    console.error(`[patch-demurrage-size-split] ERROR: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
