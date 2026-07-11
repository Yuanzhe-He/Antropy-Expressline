#!/usr/bin/env node
"use strict";

// ZIM local-charges size-split production patcher — payloads #1 + #2 of the
// approved spec (outputs/20260710_local_charges_size_split_spec.md §6).
//
//   #1  containerGroups 2 -> 4 sized columns; ICMF merged into zim-6 with
//       per-size rates (fixes the double-billing pair zim-6+zim-7); zim-3 /
//       zim-8 / guarantee re-keyed onto the 4 columns with unchanged amounts;
//       zim-4 / zim-5 (BL fees) untouched.
//   #2  demurrage assignments: the five dry-family keys mis-assigned to the
//       charge-less OT FR RF set (40GP/40HC/40NOR/20NOR/45HC) repointed to
//       demurrage-set-gp-hq-dc. Tier values and free days untouched.
//
// Discipline (patch-demurrage-size-split.js precedent):
//   - dry-run by default; --apply writes via store.saveCarrier (single line).
//   - backup of the full pre-patch ZIM line lands in backups/ first.
//   - pre-flight DRIFT CHECK against the spec §2 snapshot: any mismatch aborts.
//   - blob rollback-anchor master shape is inspected read-only (spec §9).
//   - read-back hard assertions (§6.4): explicit-hit matrix, demurrage
//     invariants, quote recomputation to the cent, jsonb fallback first-key.
//   - Any --apply write is out-of-band for the live server cache: restart the
//     Railway service immediately after a successful apply.

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.SKIP_FX_REFRESH = "1";

const fs = require("node:fs");
const path = require("node:path");

const { loadLocalEnv } = require("../src/lib/env");
const { assertProd } = require("./relational/prod-guard");
const { closeDatabase, getAppState } = require("../src/lib/db");
const store = require("../src/lib/store");
const { computeHandoverCalculator } = require("../src/lib/calculate");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const GP_SET = "demurrage-set-gp-hq-dc";
const OT_SET = "demurrage-set-ot-fr-rf";
const REPOINT_TO_GP = ["40GP", "40HC", "40NOR", "20NOR", "45HC"];

const COLUMNS = [
  { key: "gp-hq-dc-20", label: "GP HQ DC 20'" },
  { key: "gp-hq-dc-40", label: "GP HQ DC 40'" },
  { key: "ot-fr-rf-20", label: "OT FR RF 20'" },
  { key: "ot-fr-rf-40", label: "OT FR RF 40'" },
];

// Expected explicit-hit column per container type after the patch (spec §6.2).
const EXPECTED_HIT = {
  "20GP": "gp-hq-dc-20", "20HC": "gp-hq-dc-20", "20NOR": "gp-hq-dc-20",
  "40GP": "gp-hq-dc-40", "40HC": "gp-hq-dc-40", "40NOR": "gp-hq-dc-40", "45HC": "gp-hq-dc-40",
  "20FR": "ot-fr-rf-20", "20OT": "ot-fr-rf-20", "20PL": "ot-fr-rf-20",
  "20RF": "ot-fr-rf-20", "20RHC": "ot-fr-rf-20", "20TK": "ot-fr-rf-20",
  "40FR": "ot-fr-rf-40", "40OT": "ot-fr-rf-40", "40PL": "ot-fr-rf-40",
  "40RF": "ot-fr-rf-40", "40RHC": "ot-fr-rf-40", "40TK": "ot-fr-rf-40", "45OT": "ot-fr-rf-40",
};

function fail(message) {
  console.error(`\n✗ ABORT: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function rateOf(map, key) {
  return map?.[key]?.rate;
}

function cell(rate, label, extra = {}) {
  return { rate, label, qtyHint: 1, currency: "USD", ...extra };
}

function fourColumns(rate20, rate40, extra = {}) {
  return {
    "gp-hq-dc-20": cell(rate20, COLUMNS[0].label, extra),
    "gp-hq-dc-40": cell(rate40, COLUMNS[1].label, extra),
    "ot-fr-rf-20": cell(rate20, COLUMNS[2].label, extra),
    "ot-fr-rf-40": cell(rate40, COLUMNS[3].label, extra),
  };
}

// --- pre-flight -------------------------------------------------------------

function driftCheck(zim) {
  const problems = [];
  const charges = Object.fromEntries((zim.localCharges || []).map((c) => [c.id, c]));

  const groupKeys = (zim.containerGroups || []).map((g) => g.key).join(",");
  if (groupKeys !== "gp-hq-dc,ot-fr-rf") {
    problems.push(`containerGroups = [${groupKeys}] != [gp-hq-dc,ot-fr-rf]`);
  }
  const ids = (zim.localCharges || []).map((c) => c.id).join(",");
  if (ids !== "zim-3,zim-4,zim-5,zim-6,zim-7,zim-8") {
    problems.push(`charge ids = [${ids}] != expected zim-3..zim-8`);
  }
  const expectRates = { "zim-3": 30, "zim-6": 20, "zim-7": 40, "zim-8": 35 };
  for (const [id, rate] of Object.entries(expectRates)) {
    for (const key of ["gp-hq-dc", "ot-fr-rf"]) {
      if (rateOf(charges[id]?.groupRates, key) !== rate) {
        problems.push(`${id}.groupRates[${key}].rate = ${rateOf(charges[id]?.groupRates, key)} != ${rate}`);
      }
    }
  }
  if (charges["zim-4"]?.blRate?.rate !== 30) problems.push("zim-4 blRate != 30");
  if (charges["zim-5"]?.blRate?.rate !== 60) problems.push("zim-5 blRate != 60");

  for (const key of ["gp-hq-dc", "ot-fr-rf"]) {
    if (rateOf(zim.guarantee?.ratesByGroup, key) !== 0) problems.push(`guarantee.ratesByGroup[${key}] != 0`);
    if (rateOf(zim.guarantee?.fallbackRatesByGroup, key) !== 1000) problems.push(`guarantee.fallbackRatesByGroup[${key}] != 1000`);
  }

  const sets = Object.fromEntries((zim.demurrage?.ruleSets || []).map((s) => [s.id, s]));
  if (!sets[GP_SET] || (sets[GP_SET].rules || []).length !== 4) {
    problems.push(`${GP_SET} missing or rules != 4`);
  }
  if (!sets[OT_SET] || (sets[OT_SET].rules || []).length !== 1) {
    problems.push(`${OT_SET} missing or rules != 1 (free only)`);
  }
  const assignments = zim.demurrage?.assignmentsByContainerType || {};
  const gpMembers = Object.keys(assignments).filter((k) => assignments[k] === GP_SET).sort().join(",");
  if (gpMembers !== "20GP,20HC") {
    problems.push(`GP-set members = [${gpMembers}] != [20GP,20HC] (spec §2.2 snapshot)`);
  }
  for (const key of REPOINT_TO_GP) {
    if (assignments[key] !== OT_SET) {
      problems.push(`assignments[${key}] = ${assignments[key]} != ${OT_SET} (pre-patch expectation)`);
    }
  }
  return problems;
}

async function blobAnchorCheck() {
  const blob = await getAppState("shipping-data");
  if (!blob) {
    console.log("blob anchor: app_state.shipping-data ABSENT (retired) — signature guard not exercised by rollback path");
    return;
  }
  const entries = blob?.modules?.handover?.containerTypes || [];
  const total = entries.length;
  const named = entries.filter((t) => t && t.rateGroup).length;
  const version = blob?.modules?.handover?.settings?.containerTypeMasterVersion;
  console.log(
    `blob anchor: master entries=${total}, with rateGroup name=${named}, version=${JSON.stringify(version)}` +
      (total && named < total
        ? "  ← name-less entries present: legacy-signature guard IS load-bearing for blob restore"
        : "  (names present or empty: guard is defensive only)")
  );
}

// --- payload ----------------------------------------------------------------

function buildTarget(zim) {
  const target = structuredClone(zim);

  target.containerGroups = COLUMNS.map((column) => ({ ...column }));

  const charges = [];
  for (const charge of target.localCharges) {
    if (charge.id === "zim-7") {
      continue; // merged into zim-6
    }
    if (charge.id === "zim-3") {
      charge.groupRates = fourColumns(30, 30);
    } else if (charge.id === "zim-6") {
      charge.concept = "Import Cont Management Fee";
      charge.note = "20'/40' según tarifario 09.07.26";
      charge.groupRates = fourColumns(20, 40);
    } else if (charge.id === "zim-8") {
      charge.note = "20' 40'";
      charge.groupRates = fourColumns(35, 35);
    }
    charges.push(charge);
  }
  target.localCharges = charges;

  target.guarantee.ratesByGroup = fourColumns(0, 0, { taxMultiplier: 1 });
  target.guarantee.fallbackRatesByGroup = fourColumns(1000, 1000, { taxMultiplier: 1 });

  // payload #2 — repoint the mis-assigned dry-family keys.
  for (const key of REPOINT_TO_GP) {
    target.demurrage.assignmentsByContainerType[key] = GP_SET;
  }

  return target;
}

// --- diff / assertions ------------------------------------------------------

function collectDiff(before, after, base, out) {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return;
  }
  if (
    before === null || after === null ||
    typeof before !== "object" || typeof after !== "object"
  ) {
    out.push(`${base}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    collectDiff(before?.[key], after?.[key], `${base}.${key}`, out);
  }
}

const ALLOWED_DIFF_PREFIXES = [
  "zim.containerGroups",
  "zim.localCharges",
  "zim.guarantee.ratesByGroup",
  "zim.guarantee.fallbackRatesByGroup",
  "zim.demurrage.assignmentsByContainerType",
  // normalize rebuilds this legacy map from the NEW containerGroups; ruleSets
  // stay the sole authority (spec §6.4 assertion 2 — expected, declared drop).
  "zim.demurrage.rulesByGroup",
  // freeDays.daysByGroup is keyed by rule-set id and untouched; defaultDays untouched.
];

function resolveReplica(row, rateMap = {}) {
  const candidates = [
    ...(Array.isArray(row.rateGroupKeys) ? row.rateGroupKeys : []),
    row.containerGroupKey,
  ].filter(Boolean);
  const hit = candidates.find((key) => rateMap?.[key]);
  return hit ? { key: hit, fallback: false } : { key: Object.keys(rateMap || {})[0] || "", fallback: true };
}

function quoteZim(zim, handover, exchangeRates, rows, opts = {}) {
  return computeHandoverCalculator(
    zim,
    {
      shippingLineId: zim.id,
      blCount: opts.blCount ?? 1,
      demurrageDays: opts.demurrageDays ?? 0,
      priceMode: "pretax",
      quoteCurrency: "USD",
      businessNature: "handover_only",
      taxOverrides: {},
      containerRows: rows,
    },
    { exchangeRates, settings: handover.settings, containerTypes: handover.containerTypes },
    {}
  );
}

function readBackAssertions(zim, handover, exchangeRates, preDemurrage) {
  const failures = [];
  const chargesById = Object.fromEntries(zim.localCharges.map((c) => [c.id, c]));

  // 1. explicit-hit matrix — every type × every per-container rate map.
  const rateMaps = {
    "zim-3": chargesById["zim-3"].groupRates,
    "zim-6": chargesById["zim-6"].groupRates,
    "zim-8": chargesById["zim-8"].groupRates,
    "guarantee.ratesByGroup": zim.guarantee.ratesByGroup,
  };
  for (const type of handover.containerTypes) {
    const expected = EXPECTED_HIT[type.key];
    if (!expected) {
      continue; // non-standard/custom type — none exist on prod today
    }
    for (const [mapName, rateMap] of Object.entries(rateMaps)) {
      const { key, fallback } = resolveReplica(
        { rateGroupKeys: type.rateGroupKeys, containerGroupKey: type.key },
        rateMap
      );
      if (fallback || key !== expected) {
        failures.push(`hit-matrix: ${type.key} × ${mapName} -> ${fallback ? "FALLBACK " : ""}${key} != ${expected}`);
      }
    }
  }

  // 2. demurrage invariants.
  if (JSON.stringify(zim.demurrage.ruleSets) !== JSON.stringify(preDemurrage.ruleSets)) {
    failures.push("demurrage.ruleSets changed (must be byte-identical)");
  }
  if (JSON.stringify(zim.demurrage.freeDays) !== JSON.stringify(preDemurrage.freeDays)) {
    failures.push("demurrage.freeDays changed (must be byte-identical)");
  }
  const assignments = zim.demurrage.assignmentsByContainerType;
  const expectedGp = ["20GP", "20HC", "20NOR", "40GP", "40HC", "40NOR", "45HC"].sort().join(",");
  const actualGp = Object.keys(assignments).filter((k) => assignments[k] === GP_SET).sort().join(",");
  if (actualGp !== expectedGp) {
    failures.push(`GP-set members after #2 = [${actualGp}] != [${expectedGp}]`);
  }
  for (const [key, setId] of Object.entries(assignments)) {
    if (!actualGp.includes(key) && setId !== OT_SET) {
      failures.push(`assignments[${key}] = ${setId} != ${OT_SET}`);
    }
  }

  // 3. quote recomputation to the cent (spec §7).
  const cases = [
    ["S1 local 1x20GP+1BL", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "20GP", quantity: 1 }]).localCharges.pretaxTotal, 175],
    ["S2 local 1x40HC+1BL", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "40HC", quantity: 1 }]).localCharges.pretaxTotal, 195],
    ["S3 local 2x40HC+1BL", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "40HC", quantity: 2 }]).localCharges.pretaxTotal, 300],
    ["S4 local 20GP+40HC+1BL", () => quoteZim(zim, handover, exchangeRates, [
      { containerGroupKey: "20GP", quantity: 1 },
      { containerGroupKey: "40HC", quantity: 1 },
    ]).localCharges.pretaxTotal, 280],
    ["S5 local 1x40FR+1BL", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "40FR", quantity: 1 }]).localCharges.pretaxTotal, 195],
    ["S8 demurrage 20GP 12d", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "20GP", quantity: 1 }], { demurrageDays: 12 }).demurrage.pretaxTotal, 660],
    ["S9 demurrage 40HC 12d", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "40HC", quantity: 1 }], { demurrageDays: 12 }).demurrage.pretaxTotal, 660],
    ["S10 demurrage 45HC 25d", () => quoteZim(zim, handover, exchangeRates, [{ containerGroupKey: "45HC", quantity: 1 }], { demurrageDays: 25 }).demurrage.pretaxTotal, 2775],
  ];
  for (const [name, run, expected] of cases) {
    const actual = run();
    if (actual !== expected) {
      failures.push(`${name}: ${actual} != ${expected}`);
    } else {
      console.log(`  ✓ ${name} = ${expected}`);
    }
  }

  // 4. jsonb canonical first key (fallback target if a cell is ever cleared).
  for (const id of ["zim-3", "zim-6", "zim-8"]) {
    const first = Object.keys(chargesById[id].groupRates)[0];
    if (first !== "gp-hq-dc-20") {
      failures.push(`${id} groupRates first key = ${first} != gp-hq-dc-20`);
    }
  }

  return failures;
}

// --- main -------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes("--apply");
  loadLocalEnv();
  const ref = assertProd(process.env.DATABASE_URL);
  console.log(`prod ref verified: ${ref} — mode: ${apply ? "APPLY" : "dry-run"}\n`);

  await blobAnchorCheck();

  store.invalidateShippingDataCache();
  const data = await store.getShippingData();
  const handover = data.modules.handover;
  const zim = handover.shippingLines.find((line) => line.id === "zim");
  if (!zim) {
    fail("carrier 'zim' not found");
  }

  const drift = driftCheck(zim);
  if (drift.length) {
    console.error("pre-flight DRIFT vs spec §2 snapshot:");
    for (const problem of drift) console.error(`  ✗ ${problem}`);
    fail("production ZIM drifted from the spec snapshot — re-audit before patching");
  }
  console.log("pre-flight drift check: OK (prod ZIM matches spec §2 snapshot)\n");

  const target = buildTarget(zim);

  // Structured diff of the raw (pre-save) mutation, restricted to allowed paths.
  const diff = [];
  collectDiff(zim, target, "zim", diff);
  const offenders = diff.filter((d) => !ALLOWED_DIFF_PREFIXES.some((p) => d.startsWith(p)));
  console.log(`planned diff: ${diff.length} leaf changes`);
  for (const line of diff.slice(0, 60)) console.log(`  · ${line}`);
  if (diff.length > 60) console.log(`  · … ${diff.length - 60} more`);
  if (offenders.length) {
    for (const line of offenders) console.error(`  ✗ OUT-OF-SCOPE: ${line}`);
    fail("diff touches paths outside the approved payload");
  }

  if (!apply) {
    console.log("\ndry-run complete — nothing written. Re-run with --apply inside the maintenance window.");
    await closeDatabase();
    return;
  }

  // Backup, then write.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `zim-prepatch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(zim, null, 2));
  console.log(`\nbackup written: ${backupFile}`);

  const preDemurrage = structuredClone(zim.demurrage);
  await store.saveCarrier(target);
  store.invalidateShippingDataCache();

  const afterData = await store.getShippingData();
  const afterHandover = afterData.modules.handover;
  const afterZim = afterHandover.shippingLines.find((line) => line.id === "zim");

  console.log("\nread-back assertions:");
  const failures = readBackAssertions(afterZim, afterHandover, afterData.exchangeRates, preDemurrage);
  if (failures.length) {
    console.error("\nREAD-BACK FAILURES — restore from backup and investigate:");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error(`  rollback: node -e 'require("./scripts/...")' — or saveCarrier(${path.basename(backupFile)}) via patch-restore`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ ALL ASSERTIONS PASSED.");
    console.log("→ NOW RESTART the Railway service (out-of-band write vs warm cache), then re-verify /healthz + spot quotes.");
  }

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try {
    await closeDatabase();
  } catch {}
  process.exit(1);
});
