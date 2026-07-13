#!/usr/bin/env node
"use strict";

// Batch 2A tarifario fixes — 2 confirmed changes (Estefani WhatsApp 2026-07-13,
// TARIFARIO 13.07.26), per docs/specs/20260713_estefani_feedback_tarifario1307_PLAN.md §4
// and docs/specs/20260713_batch2A_tarifario_TASK_PROMPT.md:
//
//   1. ZIM demoras special containers split by size (tickets P8 / LESSONS #3):
//      OT FR RF -> two sized sets, 20" $185/day and 40" $195/day from day 8
//      (1-7 free, IVA EX, USD). GP HQ DC tiers untouched. 13 special keys
//      reassigned 6 (20") / 7 (40", incl. 45OT). Was $0 past day 7.
//   2. MSC guarantee unwaive (ticket P3): benefitEnabled true -> false so the
//      already-configured $1,000 USD x 6 groups actually bills.
//
// rulesByGroup note (deviates from the TASK_PROMPT's assumed shape, verified
// against normalize-handover.js normalizeDemurrageRulesByGroup): normalization
// reprojects rulesByGroup onto the carrier's containerGroups keys, and ZIM's
// groups are the 4 sized keys — an unsized "gp-hq-dc"/"ot-fr-rf" key cannot
// survive a round-trip. Current prod shape is the 4 sized keys all []; the
// target keeps that projection and fills ot-fr-rf-20/-40 with the new rules.
//
// Discipline (patch-batch1-tarifario.js template): drift check vs the 20260712
// fixture state -> backup -> allowed-diff gate -> saveCarrier -> read-back with
// cent-exact quote assertions. Dry-run by default. After --apply: restart the
// Railway service (out-of-band write vs warm cache).

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.SKIP_FX_REFRESH = "1";

const fs = require("node:fs");
const path = require("node:path");

const { loadLocalEnv } = require("../src/lib/env");
const { assertProd } = require("./relational/prod-guard");
const { closeDatabase } = require("../src/lib/db");
const store = require("../src/lib/store");
const { STANDARD_HANDOVER_CONTAINER_TYPES } = require("../src/lib/store/shared");
const { computeHandoverCalculator } = require("../src/lib/calculate");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const TARGET_LINES = ["zim", "msc"];
const EXPECTED_KEYS = STANDARD_HANDOVER_CONTAINER_TYPES.map((type) => type.key);

const ZIM_GP_SET = "demurrage-set-gp-hq-dc";
const ZIM_OT_SET = "demurrage-set-ot-fr-rf";
const ZIM_OT40_SET = "demurrage-set-zim-ot-fr-rf-40";
const ZIM_DRY_KEYS = ["20GP", "20HC", "20NOR", "40GP", "40HC", "40NOR", "45HC"];
const ZIM_SPECIAL_20_KEYS = ["20OT", "20FR", "20PL", "20TK", "20RF", "20RHC"];
const ZIM_SPECIAL_40_KEYS = ["40OT", "40FR", "40PL", "40TK", "40RF", "40RHC", "45OT"];
const ZIM_SIZED_GROUP_KEYS = ["gp-hq-dc-20", "gp-hq-dc-40", "ot-fr-rf-20", "ot-fr-rf-40"];
const MSC_GROUP_KEYS = ["reefer", "imo-dry", "gp-hq-dc", "imo-reefer", "special-45", "imo-special-45"];

function money(n) {
  return Math.round(n * 100) / 100;
}

function rule(id, label, startDay, endDay, rate, groupLabel, freeRule = false) {
  return {
    id,
    label,
    note: null,
    startDay,
    endDay,
    freeRule,
    taxRate: 0,
    rateConfig: { rate, label: groupLabel, qtyHint: 1, currency: "USD" },
  };
}

// copied self-contained from scripts/patch-demurrage-size-split.js
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

// copied self-contained from scripts/patch-demurrage-size-split.js
function assertAllContainerKeys(assignments) {
  const keys = Object.keys(assignments || {}).sort();
  const expected = [...EXPECTED_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`assignments must contain all 20 container keys; got ${keys.length}`);
  }
}

// --- drift expectations (20260712 fixture state; live prod must still match) ---

function expect(cond, problems, message) {
  if (!cond) {
    problems.push(message);
  }
}

function ruleTuple(r) {
  return [r.startDay, r.endDay, r.rateConfig?.rate, r.rateConfig?.currency, r.taxRate, !!r.freeRule];
}

const DRIFT_CHECKS = {
  zim(line, p) {
    const dem = line.demurrage || {};
    const sets = Object.fromEntries((dem.ruleSets || []).map((s) => [s.id, s]));
    expect((dem.ruleSets || []).length === 2, p, `ruleSets count != 2 (got ${(dem.ruleSets || []).length})`);
    expect(!sets[ZIM_OT40_SET], p, `${ZIM_OT40_SET} already exists`);

    const gp = sets[ZIM_GP_SET];
    expect(!!gp && gp.sourceGroupKey === "gp-hq-dc", p, "GP set missing or sourceGroupKey != gp-hq-dc");
    expect(
      JSON.stringify((gp?.rules || []).map(ruleTuple)) ===
        JSON.stringify([
          [1, 7, 0, "USD", 0, true],
          [8, 10, 120, "USD", 0, false],
          [11, 14, 150, "USD", 0, false],
          [15, null, 165, "USD", 0, false],
        ]),
      p,
      "GP rules drifted from 1-7 free / 8-10@120 / 11-14@150 / 15+@165 (USD, tax 0)"
    );

    // Re-pinned per CONTINUE_PROMPT §2 (Chandler ruling A, 2026-07-13): live OT
    // set carries a manual admin rule (>7 @ 195 flat for all specials, created
    // ~07-13 00:41) on top of the free rule. Estefani's written 185/195 split
    // supersedes it; the builder replaces the whole set and the prepatch backup
    // preserves the manual state.
    const ot = sets[ZIM_OT_SET];
    expect(!!ot && ot.sourceGroupKey === "ot-fr-rf", p, "OT set missing or sourceGroupKey != ot-fr-rf");
    expect((ot?.rules || []).length === 2, p, `OT set rules != 2 (got ${(ot?.rules || []).length})`);
    expect(
      JSON.stringify(ruleTuple(ot?.rules?.[0] || {})) === JSON.stringify([1, 7, 0, "USD", 0, true]),
      p,
      "OT rules[0] != free rule 1-7"
    );
    const manual = ot?.rules?.[1];
    expect(
      manual?.id === "zim-demurrage-set-ot-fr-rf-1783925143346-gay37k" &&
        manual?.startDay === 8 &&
        manual?.endDay === null &&
        manual?.rateConfig?.rate === 195 &&
        manual?.rateConfig?.currency === "USD",
      p,
      "OT rules[1] != the known manual admin rule (…gay37k, 8+ @195 USD)"
    );
    if (manual) {
      console.log(`  [drift-note] zim manual rule …gay37k taxRate=${manual.taxRate} (recorded, not pinned)`);
    }

    const asg = dem.assignmentsByContainerType || {};
    expect(Object.keys(asg).length === 20, p, `assignments count != 20 (got ${Object.keys(asg).length})`);
    for (const key of ZIM_DRY_KEYS) {
      expect(asg[key] === ZIM_GP_SET, p, `assignment ${key} != ${ZIM_GP_SET}`);
    }
    for (const key of [...ZIM_SPECIAL_20_KEYS, ...ZIM_SPECIAL_40_KEYS]) {
      expect(asg[key] === ZIM_OT_SET, p, `assignment ${key} != ${ZIM_OT_SET}`);
    }

    expect(dem.freeDays?.defaultDays === 7, p, "freeDays.defaultDays != 7");
    const dbg = dem.freeDays?.daysByGroup || {};
    expect(
      Object.keys(dbg).length === 2 && dbg[ZIM_GP_SET] === 7 && dbg[ZIM_OT_SET] === 7,
      p,
      "freeDays.daysByGroup != {GP:7, OT:7}"
    );

    const rbg = dem.rulesByGroup || {};
    expect(
      JSON.stringify(Object.keys(rbg).sort()) === JSON.stringify([...ZIM_SIZED_GROUP_KEYS].sort()),
      p,
      `rulesByGroup keys != 4 sized keys (got ${Object.keys(rbg).join(",")})`
    );
    for (const [key, rules] of Object.entries(rbg)) {
      expect(Array.isArray(rules) && rules.length === 0, p, `rulesByGroup[${key}] not empty`);
    }
  },
  msc(line, p) {
    const g = line.guarantee || {};
    expect(g.benefitEnabled === true, p, "benefitEnabled != true (already unwaived?)");
    expect(String(g.benefitNote || "").includes("No hay beneficio"), p, "benefitNote drifted");
    const keys = Object.keys(g.ratesByGroup || {}).sort();
    expect(
      JSON.stringify(keys) === JSON.stringify([...MSC_GROUP_KEYS].sort()),
      p,
      `ratesByGroup keys drifted (got ${keys.join(",")})`
    );
    for (const key of MSC_GROUP_KEYS) {
      const cell = g.ratesByGroup?.[key];
      expect(cell?.rate === 1000 && cell?.currency === "USD", p, `ratesByGroup[${key}] != 1000 USD`);
    }
  },
};

// --- target builders ----------------------------------------------------------

const BUILDERS = {
  zim(line) {
    const free20 = rule("zim-ot-fr-rf-20-free", "1-7", 1, 7, 0, 'OT FR RF 20"', true);
    const paid20 = rule("zim-demurrage-1-ot-fr-rf-20", ">7", 8, null, 185, 'OT FR RF 20"');
    const free40 = rule("zim-ot-fr-rf-40-free", "1-7", 1, 7, 0, 'OT FR RF 40"', true);
    const paid40 = rule("zim-demurrage-1-ot-fr-rf-40", ">7", 8, null, 195, 'OT FR RF 40"');

    const dem = line.demurrage;
    const gp = dem.ruleSets.find((s) => s.id === ZIM_GP_SET);
    const set20 = { id: ZIM_OT_SET, name: 'OT FR RF 20"', sourceGroupKey: "ot-fr-rf-20", rules: [free20, paid20] };
    const set40 = { id: ZIM_OT40_SET, name: 'OT FR RF 40"', sourceGroupKey: "ot-fr-rf-40", rules: [free40, paid40] };
    for (const set of [gp, set20, set40]) validateRuleSequence(set);
    dem.ruleSets = [gp, set20, set40];

    const assignments = {};
    for (const key of ZIM_DRY_KEYS) assignments[key] = ZIM_GP_SET;
    for (const key of ZIM_SPECIAL_20_KEYS) assignments[key] = ZIM_OT_SET;
    for (const key of ZIM_SPECIAL_40_KEYS) assignments[key] = ZIM_OT40_SET;
    assertAllContainerKeys(assignments);
    dem.assignmentsByContainerType = assignments;

    dem.freeDays = {
      defaultDays: 7,
      daysByGroup: { [ZIM_GP_SET]: 7, [ZIM_OT_SET]: 7, [ZIM_OT40_SET]: 7 },
    };

    // Projection-stable shape: normalize keeps only containerGroups keys (ZIM's
    // 4 sized columns), so the GP sized keys stay [] and the special sized keys
    // carry the new rules. An unsized key would be dropped on round-trip.
    dem.rulesByGroup = {
      "gp-hq-dc-20": [],
      "gp-hq-dc-40": [],
      "ot-fr-rf-20": [free20, paid20],
      "ot-fr-rf-40": [free40, paid40],
    };
  },
  msc(line) {
    line.guarantee.benefitEnabled = false;
  },
};

const ALLOWED_PREFIXES = {
  zim: [
    "zim.demurrage.ruleSets",
    "zim.demurrage.assignmentsByContainerType",
    "zim.demurrage.freeDays",
    "zim.demurrage.rulesByGroup",
  ],
  msc: ["msc.guarantee.benefitEnabled"],
};

function collectDiff(before, after, base, out) {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return;
  }
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") {
    out.push(`${base}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    collectDiff(before?.[key], after?.[key], `${base}.${key}`, out);
  }
}

// --- read-back quote assertions (task §2.5, 14 cases, cent-exact) --------------

function quote(line, handover, fx, rows, opts = {}) {
  return computeHandoverCalculator(
    line,
    {
      shippingLineId: line.id,
      blCount: opts.blCount ?? 1,
      demurrageDays: opts.demurrageDays ?? 0,
      priceMode: "pretax",
      quoteCurrency: "USD",
      businessNature: "handover_only",
      taxOverrides: {},
      containerRows: rows,
    },
    { exchangeRates: fx, settings: handover.settings, containerTypes: handover.containerTypes },
    {}
  );
}

function item(result, conceptPart) {
  return result.localCharges.items.find((i) => i.concept.includes(conceptPart));
}

function readBackAssertions(byId, handover, fx) {
  const failures = [];
  const check = (name, actual, expected) => {
    if (money(actual) === money(expected)) {
      console.log(`  ✓ ${name} = ${money(expected)}`);
    } else {
      failures.push(`${name}: ${actual} != ${expected}`);
    }
  };
  const row = (t, q = 1) => [{ containerGroupKey: t, quantity: q }];

  // ZIM
  const zim = byId.zim;
  const zim20ot12 = quote(zim, handover, fx, row("20OT"), { demurrageDays: 12 });
  check("1 ZIM 20OT 12d demoras (pretax)", zim20ot12.demurrage.pretaxTotal, 925);
  check("2 ZIM 20OT 12d demoras (aftertax=EX)", zim20ot12.demurrage.afterTaxTotal, 925);
  check("3 ZIM 40FR 12d demoras", quote(zim, handover, fx, row("40FR"), { demurrageDays: 12 }).demurrage.pretaxTotal, 975);
  check("4 ZIM 20RF 8d demoras (RF -> special 20\")", quote(zim, handover, fx, row("20RF"), { demurrageDays: 8 }).demurrage.pretaxTotal, 185);
  check("5 ZIM 45OT 10d demoras (45 -> special 40\")", quote(zim, handover, fx, row("45OT"), { demurrageDays: 10 }).demurrage.pretaxTotal, 585);
  check("6 ZIM 40OT 7d demoras (free window)", quote(zim, handover, fx, row("40OT"), { demurrageDays: 7 }).demurrage.pretaxTotal, 0);
  check("7 ZIM 40HC 12d demoras (GP regression)", quote(zim, handover, fx, row("40HC"), { demurrageDays: 12 }).demurrage.pretaxTotal, 660);
  check(
    "8 ZIM 20GP+40OT 12d demoras (mixed)",
    quote(zim, handover, fx, [...row("20GP"), ...row("40OT")], { demurrageDays: 12 }).demurrage.pretaxTotal,
    1635
  );
  check("9 ZIM 20GP locales (regression)", quote(zim, handover, fx, row("20GP")).localCharges.pretaxTotal, 175);
  check("10 ZIM 40GP locales (regression)", quote(zim, handover, fx, row("40GP")).localCharges.pretaxTotal, 195);

  // MSC
  const msc = byId.msc;
  check("11 MSC 20GP garantia (unwaived)", quote(msc, handover, fx, row("20GP")).guarantee.pretaxTotal, 1000);
  check("12 MSC 2x40FR garantia", quote(msc, handover, fx, row("40FR", 2)).guarantee.pretaxTotal, 2000);
  check("13 MSC 40FR Protection (regression)", item(quote(msc, handover, fx, row("40FR")), "Protection").pretaxAmount, 60);
  check("14 MSC 20GP Protection (regression)", item(quote(msc, handover, fx, row("20GP")), "Protection").pretaxAmount, 50);

  return failures;
}

// --- main -----------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes("--apply");
  loadLocalEnv();
  const ref = assertProd(process.env.DATABASE_URL);
  console.log(`prod ref verified: ${ref} — mode: ${apply ? "APPLY" : "dry-run"}\n`);

  store.invalidateShippingDataCache();
  const data = await store.getShippingData();
  const handover = data.modules.handover;
  const byId = Object.fromEntries(handover.shippingLines.map((l) => [l.id, l]));

  const targets = {};
  let anyDrift = false;
  for (const id of TARGET_LINES) {
    const line = byId[id];
    if (!line) {
      console.error(`✗ ${id}: carrier not found — SKIPPING`);
      anyDrift = true;
      continue;
    }
    const problems = [];
    DRIFT_CHECKS[id](line, problems);
    if (problems.length) {
      console.error(`✗ ${id}: DRIFT vs 20260712 fixture state — SKIPPING this line:`);
      for (const problem of problems) console.error(`    - ${problem}`);
      anyDrift = true;
      continue;
    }
    const target = structuredClone(line);
    BUILDERS[id](target);

    const diff = [];
    collectDiff(line, target, id, diff);
    const offenders = diff.filter((d) => !ALLOWED_PREFIXES[id].some((prefix) => d.startsWith(prefix)));
    console.log(`${id}: drift OK, planned diff ${diff.length} leaf changes`);
    for (const d of diff) console.log(`    · ${d.slice(0, 220)}`);
    if (offenders.length) {
      console.error(`✗ ${id}: OUT-OF-SCOPE diff — SKIPPING:`);
      for (const d of offenders) console.error(`    ! ${d.slice(0, 220)}`);
      anyDrift = true;
      continue;
    }
    targets[id] = target;
    console.log("");
  }

  if (!apply) {
    console.log(`dry-run complete — ${Object.keys(targets).length}/${TARGET_LINES.length} lines ready, nothing written.`);
    if (anyDrift) process.exitCode = 1;
    await closeDatabase();
    return;
  }
  if (anyDrift) {
    console.error("refusing --apply while any line has drift/scope failures");
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const id of TARGET_LINES) {
    const backupFile = path.join(BACKUP_DIR, `${id}-prepatch-batch2-${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(byId[id], null, 2));
    await store.saveCarrier(targets[id]);
    console.log(`✓ ${id} written (backup: ${path.basename(backupFile)})`);
  }

  store.invalidateShippingDataCache();
  const after = await store.getShippingData();
  const afterHandover = after.modules.handover;
  const afterById = Object.fromEntries(afterHandover.shippingLines.map((l) => [l.id, l]));

  console.log("\nstructural read-back:");
  const zimAfter = afterById.zim;
  const zimSets = (zimAfter.demurrage?.ruleSets || []).map((s) => s.id);
  console.log(`  zim ruleSets: ${zimSets.join(", ")}`);
  const structuralProblems = [];
  expect(
    JSON.stringify(zimSets) === JSON.stringify([ZIM_GP_SET, ZIM_OT_SET, ZIM_OT40_SET]),
    structuralProblems,
    "zim ruleSets != [GP, OT-20, OT-40]"
  );
  expect(
    Object.keys(zimAfter.demurrage?.assignmentsByContainerType || {}).length === 20,
    structuralProblems,
    "zim assignments != 20 keys"
  );
  expect(afterById.msc.guarantee?.benefitEnabled === false, structuralProblems, "msc benefitEnabled != false");
  for (const problem of structuralProblems) console.error(`  ✗ ${problem}`);

  console.log("\nread-back assertions:");
  const failures = readBackAssertions(afterById, afterHandover, after.exchangeRates);
  if (failures.length || structuralProblems.length) {
    console.error("\nREAD-BACK FAILURES — restore affected lines from backups and investigate:");
    for (const failure of [...structuralProblems, ...failures]) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ ALL 14 ASSERTIONS PASSED.");
    console.log("→ NOW RESTART the Railway service, then re-verify /healthz + spot quotes.");
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
