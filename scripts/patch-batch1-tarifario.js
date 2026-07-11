#!/usr/bin/env node
"use strict";

// Batch 1 tarifario reconciliation fixes — 9 unambiguous mispricings on 8 carriers,
// per outputs/20260712_fleet_tarifario_reconciliation.md §3 batch 1 (data only).
//
//   1. MSC msc-5 Protection Fee: 5 special columns 50 -> 60 USD (gp-hq-dc stays 50)
//   2. MAERSK maersk-6 Equipment Handling: ot-fr-rf 30 -> 90 USD
//   3. WHAN HAI whan-hai-3 ISP: per-container -> per-BL $12 EX
//   4. WHAN HAI demoras rebuild (caliber A shift + free days 7/3 + IVA EX)
//   5. OOCL demoras rebuild (free days 14/3, GP 15-19@150/20-24@160, NO open tier
//      past day 24 per ticket P5 — no invented numbers; OT 4+@210; 45HC -> GP set)
//   6. ONE new charge IFD Inland Fuel $25/container EX, 7 columns
//   7. SNK Destination doc fee: per-container -> per-BL $60 (IVA 0.16 kept)
//   8. HMM Flete Maritimo: taxRate 0 -> 0.16
//   9. TSL guarantee ot-fr-rf 1500 -> 2500 USD
//
// Discipline (patch-zim-local-charges.js template): per-carrier drift check vs the
// 2026-07-12 reconciliation snapshot -> backup -> allowed-diff gate -> saveCarrier
// -> single read-back with cent-exact quote assertions. Dry-run by default.
// After --apply: restart the Railway service (out-of-band write vs warm cache).

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
const { computeHandoverCalculator } = require("../src/lib/calculate");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const TARGET_LINES = ["msc", "maersk", "whan-hai", "oocl", "one", "sinokor", "hmm", "ts-lines"];

function money(n) {
  return Math.round(n * 100) / 100;
}

function cell(rate, label, currency = "USD") {
  return { rate, label, qtyHint: 1, currency };
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

// --- drift expectations (2026-07-12 reconciliation snapshot) -----------------

function expect(cond, problems, message) {
  if (!cond) {
    problems.push(message);
  }
}

function chargeById(line, id) {
  return (line.localCharges || []).find((c) => c.id === id);
}

const DRIFT_CHECKS = {
  msc(line, p) {
    const c = chargeById(line, "msc-5");
    expect(!!c && c.concept.includes("Protection"), p, "msc-5 Protection missing");
    for (const k of ["gp-hq-dc", "reefer", "imo-dry", "imo-reefer", "special-45", "imo-special-45"]) {
      expect(c?.groupRates?.[k]?.rate === 50, p, `msc-5[${k}] != 50`);
    }
  },
  maersk(line, p) {
    const c = chargeById(line, "maersk-6");
    expect(c?.groupRates?.["gp-hq-dc"]?.rate === 30, p, "maersk-6[gp] != 30");
    expect(c?.groupRates?.["ot-fr-rf"]?.rate === 30, p, "maersk-6[ot] != 30");
  },
  "whan-hai"(line, p) {
    const c = chargeById(line, "whan-hai-3");
    expect(c?.concept === "ISP", p, "whan-hai-3 concept != ISP");
    expect(c?.groupRates?.["gp-hc-sd"]?.rate === 12 && c?.groupRates?.["ot-fr-rf"]?.rate === 12, p, "whan-hai-3 not per-container 12/12");
    expect(!c?.blRate, p, "whan-hai-3 already has blRate");
    const sets = Object.fromEntries((line.demurrage?.ruleSets || []).map((s) => [s.id, s]));
    const gp = sets["demurrage-set-gp-hc-sd"], ot = sets["demurrage-set-ot-fr-rf"];
    expect(gp?.rules?.length === 2 && gp.rules[0].startDay === 1 && gp.rules[0].rateConfig.rate === 150 && gp.rules[0].taxRate === 0.16, p, "whan-hai GP rules drifted");
    expect(ot?.rules?.length === 2 && ot.rules[0].rateConfig.rate === 195, p, "whan-hai OT rules drifted");
    expect((line.demurrage?.freeDays?.defaultDays || 0) === 0, p, "whan-hai freeDays already set");
  },
  oocl(line, p) {
    const sets = Object.fromEntries((line.demurrage?.ruleSets || []).map((s) => [s.id, s]));
    const gp = sets["demurrage-set-gp-hq-dc"], ot = sets["demurrage-set-ot-fr-rf"];
    expect(gp?.rules?.length === 3 && gp.rules[0].rateConfig.rate === 150 && gp.rules[2].rateConfig.rate === 170, p, "oocl GP rules drifted");
    expect(ot?.rules?.length === 3 && ot.rules.every((r) => r.rateConfig.rate === 210), p, "oocl OT rules drifted");
    expect(line.demurrage?.assignmentsByContainerType?.["45HC"] === "demurrage-set-ot-fr-rf", p, "oocl 45HC assignment drifted");
    expect((line.demurrage?.freeDays?.defaultDays || 0) === 0, p, "oocl freeDays already set");
  },
  one(line, p) {
    expect((line.localCharges || []).length === 2, p, "one charges != 2");
    expect(!(line.localCharges || []).some((c) => /IFD|Inland Fuel/i.test(c.concept)), p, "one IFD already exists");
  },
  sinokor(line, p) {
    const c = chargeById(line, "sinokor-local-charge-1783566786224-26hm32");
    expect(c?.concept === "Destination doc fee", p, "snk doc fee id/concept drifted");
    expect(c?.groupRates?.["gp-hc-sd"]?.rate === 60 && c?.groupRates?.["ot-fr-rf"]?.rate === 60, p, "snk doc fee not per-container 60/60");
    expect((c?.blRate?.rate || 0) === 0, p, "snk doc fee blRate != 0");
  },
  hmm(line, p) {
    const c = chargeById(line, "hmm-local-charge-1783577923389-tps0jx");
    expect(!!c && c.concept.includes("Flete"), p, "hmm Flete id drifted");
    expect(c?.taxRate === 0 && c?.blRate?.rate === 45, p, "hmm Flete shape drifted");
  },
  "ts-lines"(line, p) {
    expect(line.guarantee?.ratesByGroup?.["ot-fr-rf"]?.rate === 1500, p, "tsl guarantee ot != 1500");
    expect(line.guarantee?.ratesByGroup?.["gp-hc-sd"]?.rate === 1000, p, "tsl guarantee gp != 1000");
    expect(line.guarantee?.benefitEnabled === false, p, "tsl benefitEnabled != false");
  },
};

// --- target builders ----------------------------------------------------------

const BUILDERS = {
  msc(line) {
    const c = chargeById(line, "msc-5");
    for (const k of ["reefer", "imo-dry", "imo-reefer", "special-45", "imo-special-45"]) {
      c.groupRates[k].rate = 60;
    }
  },
  maersk(line) {
    chargeById(line, "maersk-6").groupRates["ot-fr-rf"].rate = 90;
  },
  "whan-hai"(line) {
    const c = chargeById(line, "whan-hai-3");
    c.blRate = { rate: 12, qtyHint: 1, currency: "USD" };
    c.groupRates = {};
    c.taxRate = 0;

    const sets = Object.fromEntries(line.demurrage.ruleSets.map((s) => [s.id, s]));
    sets["demurrage-set-gp-hc-sd"].rules = [
      rule("whan-hai-gp-hc-sd-free", "1-7", 1, 7, 0, "GP HC SD", true),
      rule("whan-hai-demurrage-1-gp-hc-sd", "8-10", 8, 10, 150, "GP HC SD"),
      rule("whan-hai-demurrage-2-gp-hc-sd", ">10", 11, null, 165, "GP HC SD"),
    ];
    sets["demurrage-set-ot-fr-rf"].rules = [
      rule("whan-hai-ot-fr-rf-free", "1-3", 1, 3, 0, "OT FR RF", true),
      rule("whan-hai-demurrage-1-ot-fr-rf", "4-6", 4, 6, 195, "OT FR RF"),
      rule("whan-hai-demurrage-2-ot-fr-rf", ">6", 7, null, 205, "OT FR RF"),
    ];
    line.demurrage.freeDays = {
      defaultDays: 7,
      daysByGroup: { "demurrage-set-gp-hc-sd": 7, "demurrage-set-ot-fr-rf": 3 },
    };
  },
  oocl(line) {
    const sets = Object.fromEntries(line.demurrage.ruleSets.map((s) => [s.id, s]));
    sets["demurrage-set-gp-hq-dc"].rules = [
      rule("oocl-gp-hq-dc-free", "1-14", 1, 14, 0, "GP HQ DC", true),
      rule("oocl-demurrage-1-gp-hq-dc", "15-19", 15, 19, 150, "GP HQ DC"),
      // Tariff GP column has NO rate past its "6-10" (absolute 20-24) window —
      // ticket P5: do not invent a number; days >= 25 stay uncharged until OOCL
      // publishes the open tier.
      rule("oocl-demurrage-2-gp-hq-dc", "20-24", 20, 24, 160, "GP HQ DC"),
    ];
    sets["demurrage-set-ot-fr-rf"].rules = [
      rule("oocl-ot-fr-rf-free", "1-3", 1, 3, 0, "OT FR RF", true),
      rule("oocl-demurrage-1-ot-fr-rf", ">3", 4, null, 210, "OT FR RF"),
    ];
    line.demurrage.assignmentsByContainerType["45HC"] = "demurrage-set-gp-hq-dc";
    line.demurrage.freeDays = {
      defaultDays: 14,
      daysByGroup: { "demurrage-set-gp-hq-dc": 14, "demurrage-set-ot-fr-rf": 3 },
    };
  },
  one(line) {
    const labels = Object.fromEntries(line.containerGroups.map((g) => [g.key, g.label]));
    const groupRates = {};
    for (const key of ["gp-hq-dc-20-40", "ot-20", "ot-40", "fr-20", "fr-40", "rf-20", "rf-40"]) {
      groupRates[key] = cell(25, labels[key]);
    }
    line.localCharges.push({
      id: "one-6",
      concept: "IFD Inland Fuel",
      note: null,
      taxRate: 0,
      groupRates,
      blRate: null,
    });
  },
  sinokor(line) {
    const c = chargeById(line, "sinokor-local-charge-1783566786224-26hm32");
    c.blRate = { rate: 60, qtyHint: 1, currency: "USD" };
    c.groupRates = {};
  },
  hmm(line) {
    chargeById(line, "hmm-local-charge-1783577923389-tps0jx").taxRate = 0.16;
  },
  "ts-lines"(line) {
    line.guarantee.ratesByGroup["ot-fr-rf"].rate = 2500;
  },
};

const ALLOWED_PREFIXES = {
  msc: ["msc.localCharges"],
  maersk: ["maersk.localCharges"],
  "whan-hai": ["whan-hai.localCharges", "whan-hai.demurrage.ruleSets", "whan-hai.demurrage.freeDays", "whan-hai.demurrage.rulesByGroup"],
  oocl: ["oocl.demurrage.ruleSets", "oocl.demurrage.freeDays", "oocl.demurrage.assignmentsByContainerType.45HC", "oocl.demurrage.rulesByGroup"],
  one: ["one.localCharges"],
  sinokor: ["sinokor.localCharges"],
  hmm: ["hmm.localCharges"],
  "ts-lines": ["ts-lines.guarantee.ratesByGroup"],
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

// --- read-back quote assertions (task §4, cent-exact) --------------------------

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

  // WHAN HAI
  const wh = byId["whan-hai"];
  check("WHAN HAI 40GP 12d demoras (pretax)", quote(wh, handover, fx, row("40GP"), { demurrageDays: 12 }).demurrage.pretaxTotal, 780);
  check("WHAN HAI 40GP 12d demoras (aftertax=EX)", quote(wh, handover, fx, row("40GP"), { demurrageDays: 12 }).demurrage.afterTaxTotal, 780);
  check("WHAN HAI 20OT 5d demoras", quote(wh, handover, fx, row("20OT"), { demurrageDays: 5 }).demurrage.pretaxTotal, 390);
  const isp = item(quote(wh, handover, fx, row("40GP")), "ISP");
  check("WHAN HAI ISP per-BL pretax", isp ? isp.pretaxAmount : NaN, 12);
  const isp2 = item(quote(wh, handover, fx, row("40GP", 3)), "ISP");
  check("WHAN HAI ISP invariant vs 3 containers", isp2 ? isp2.pretaxAmount : NaN, 12);

  // OOCL
  const oo = byId.oocl;
  check("OOCL 40HC 22d", quote(oo, handover, fx, row("40HC"), { demurrageDays: 22 }).demurrage.pretaxTotal, 1230);
  check("OOCL 45HC 22d (reassigned)", quote(oo, handover, fx, row("45HC"), { demurrageDays: 22 }).demurrage.pretaxTotal, 1230);
  check("OOCL 40HC 30d (open tier absent past 24)", quote(oo, handover, fx, row("40HC"), { demurrageDays: 30 }).demurrage.pretaxTotal, 1550);

  // MSC
  const msc = byId.msc;
  check("MSC 40FR Protection", item(quote(msc, handover, fx, row("40FR")), "Protection").pretaxAmount, 60);
  check("MSC 20GP Protection (regression)", item(quote(msc, handover, fx, row("20GP")), "Protection").pretaxAmount, 50);

  // MAERSK
  const mk = byId.maersk;
  check("MAERSK 40OT Equipment Handling", item(quote(mk, handover, fx, row("40OT")), "Equipment Handling").pretaxAmount, 90);
  check("MAERSK 20GP Equipment Handling (regression)", item(quote(mk, handover, fx, row("20GP")), "Equipment Handling").pretaxAmount, 30);

  // ONE
  const one = byId.one;
  check("ONE 20GP locales total", quote(one, handover, fx, row("20GP")).localCharges.pretaxTotal, 105);
  check("ONE 40FR 25d demoras (S11 invariant)", quote(one, handover, fx, row("40FR"), { demurrageDays: 25 }).demurrage.pretaxTotal, 3045);

  // SNK
  const snk = byId.sinokor;
  const doc = item(quote(snk, handover, fx, row("20GP", 2)), "Destination doc fee");
  check("SNK doc fee 2x20GP+1BL pretax", doc ? doc.pretaxAmount : NaN, 60);
  check("SNK doc fee aftertax", doc ? doc.afterTaxAmount : NaN, 69.6);

  // HMM
  const flete = item(quote(byId.hmm, handover, fx, row("20GP")), "Flete");
  check("HMM Flete pretax", flete ? flete.pretaxAmount : NaN, 45);
  check("HMM Flete aftertax (IVA 16%)", flete ? flete.afterTaxAmount : NaN, 52.2);

  // TSL
  const tsl = byId["ts-lines"];
  check("TSL 40FR garantia", quote(tsl, handover, fx, row("40FR")).guarantee.pretaxTotal, 2500);
  check("TSL 40GP 15d demoras (regression, aftertax)", quote(tsl, handover, fx, row("40GP"), { demurrageDays: 15 }).demurrage.afterTaxTotal, 928.0);
  check("TSL 40OT 20d demoras (regression)", quote(tsl, handover, fx, row("40OT"), { demurrageDays: 20 }).demurrage.afterTaxTotal, 2876.8);
  check("TSL 20GP 14d demoras (regression)", quote(tsl, handover, fx, row("20GP"), { demurrageDays: 14 }).demurrage.afterTaxTotal, 649.6);
  check("TSL 20RF 18d demoras (regression)", quote(tsl, handover, fx, row("20RF"), { demurrageDays: 18 }).demurrage.afterTaxTotal, 2337.4);

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
      console.error(`✗ ${id}: DRIFT vs reconciliation snapshot — SKIPPING this line:`);
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
    const backupFile = path.join(BACKUP_DIR, `${id}-prepatch-batch1-${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(byId[id], null, 2));
    await store.saveCarrier(targets[id]);
    console.log(`✓ ${id} written (backup: ${path.basename(backupFile)})`);
  }

  store.invalidateShippingDataCache();
  const after = await store.getShippingData();
  const afterHandover = after.modules.handover;
  const afterById = Object.fromEntries(afterHandover.shippingLines.map((l) => [l.id, l]));

  console.log("\nread-back assertions:");
  const failures = readBackAssertions(afterById, afterHandover, after.exchangeRates);
  if (failures.length) {
    console.error("\nREAD-BACK FAILURES — restore affected lines from backups and investigate:");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ ALL ASSERTIONS PASSED.");
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
