// Phase 2 (tarifas-save bug) — repair the legacy invalid demurrage day-sequences
// on MSC / WHAN HAI / OOCL so their rule sets pass the sequential-rule gate and
// operators (and José) can edit them normally again.
//
// IMPORTANT — what this DOES and does NOT decide:
//   * It NEVER invents money. Every billing tier's importe / currency / tax /
//     freeRule is COPIED verbatim from the carrier's current live rule (by index
//     into the existing rules array). Only the DAY boundaries are rebased.
//   * The day rebasing is a MECHANICAL proposal: free period kept as-is, then each
//     billing tier laid out at absolute days, preserving the original tier's span
//     and open/closed-endedness. The relative-vs-absolute and "last tier
//     open-ended vs bounded" calls are José's — the dry-run prints before/after so
//     he can confirm or correct PROPOSALS before any write.
//
// Storage: drives the real store facade in STORAGE_MODE=relational /
// STORAGE_DRIVER=postgres (per-entity store.saveCarrier — the same write path the
// app uses). assertProd guards the connection. NEVER writes the app_state blob.
//
//   node scripts/relational/fix-demurrage-rulesets.js                 # dry-run (default, read-only)
//   node scripts/relational/fix-demurrage-rulesets.js --apply --jose-confirmed   # write (double-gated)
//   node scripts/relational/fix-demurrage-rulesets.js --revert <backup.json>     # restore from backup
//
// Dry-run is READ-ONLY. --apply refuses unless BOTH --apply and --jose-confirmed
// are present (the second flag is the human gate that José signed off on the days).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";

const { assertProd } = require("./prod-guard");
const store = require("../../src/lib/store");
const { formatDemurrageRuleLabel } = store;

const TARGET_CARRIERS = ["msc", "oocl", "whan-hai"];
const BACKUP_DIR = path.join(__dirname, "../../backups");

// PROPOSALS — DRAFT day-sequences awaiting José's confirmation. Each tier:
//   { startDay, endDay (null = open-ended), copyFromIndex }
// copyFromIndex indexes the carrier's CURRENT (bad) rules array; the tier copies
// that rule's rateConfig/taxRate/freeRule verbatim. So importes are never guessed
// here — only the day boundaries are. Edit the day numbers (and the open/bounded
// choice) to match what José confirms against the real tarifa, then --apply.
const PROPOSALS = {
  // bad shape A — uniform-importe duplicates with a stale mid open-ended rule.
  // Every billing tier is the same importe, so the faithful canonical form is
  // "free N days, then <importe>/day open-ended". copyFromIndex 1 = the [6→∞] /
  // [4→∞] open-ended billing rule that carries the real importe.
  msc: {
    "imo-dry": [
      { startDay: 1, endDay: 5, copyFromIndex: 0 },
      { startDay: 6, endDay: null, copyFromIndex: 1 },
    ],
    "special-45": [
      { startDay: 1, endDay: 5, copyFromIndex: 0 },
      { startDay: 6, endDay: null, copyFromIndex: 1 },
    ],
    "imo-special-45": [
      { startDay: 1, endDay: 5, copyFromIndex: 0 },
      { startDay: 6, endDay: null, copyFromIndex: 1 },
    ],
    reefer: [
      { startDay: 1, endDay: 3, copyFromIndex: 0 },
      { startDay: 4, endDay: null, copyFromIndex: 1 },
    ],
    "imo-reefer": [
      { startDay: 1, endDay: 3, copyFromIndex: 0 },
      { startDay: 4, endDay: null, copyFromIndex: 1 },
    ],
  },
  // bad shape B — free tier then billing tiers entered with RELATIVE days. Rebased
  // to absolute, preserving each original tier's span. Last tier kept open-ended
  // where the original was open-ended.
  "whan-hai": {
    "gp-hc-sd": [
      { startDay: 1, endDay: 7, copyFromIndex: 0 }, // free 0-7
      { startDay: 8, endDay: 10, copyFromIndex: 1 }, // orig "1-3" (3d) -> 8-10
      { startDay: 11, endDay: null, copyFromIndex: 2 }, // orig open -> 11+
    ],
    "ot-fr-rf": [
      { startDay: 1, endDay: 3, copyFromIndex: 0 }, // free 0-3
      { startDay: 4, endDay: 6, copyFromIndex: 1 }, // orig "1-3" (3d) -> 4-6
      { startDay: 7, endDay: null, copyFromIndex: 2 }, // orig open -> 7+
    ],
  },
  oocl: {
    "gp-hq-dc": [
      { startDay: 1, endDay: 14, copyFromIndex: 0 }, // free 0-14
      { startDay: 15, endDay: 19, copyFromIndex: 1 }, // orig "1-5" (5d) -> 15-19
      { startDay: 20, endDay: null, copyFromIndex: 2 }, // orig "6-10" -> 20+ OPEN-ENDED (Chandler: demurrage标准最高档thereafter收到离场)
    ],
  },
};

// Resolve a rule set's PROPOSALS entry by trying its id, sourceGroupKey, and a
// slugified name (rule-set ids in prod look like "demurrage-set-gp-hq-dc").
function proposalFor(carrierId, set) {
  const table = PROPOSALS[carrierId];
  if (!table) return null;
  const candidates = [
    set.id,
    set.sourceGroupKey,
    String(set.id || "").replace(/^demurrage-set-/, ""),
    String(set.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  ].filter(Boolean);
  for (const key of candidates) {
    if (table[key]) return table[key];
  }
  return null;
}

// The exact gate the edit handler applies (pure, read-only). Returns null if ok,
// else a short reason — used to flag BEFORE state and to verify AFTER state.
function gateReason(rules) {
  let nextStart = 1;
  for (let i = 0; i < rules.length; i += 1) {
    const endDay = rules[i].endDay == null ? null : rules[i].endDay;
    if (endDay !== null && endDay < nextStart) {
      return `invalidRuleRange (rule[${i}] end=${endDay} < ${nextStart})`;
    }
    if (endDay === null && i < rules.length - 1) {
      return `openEndedRuleMustBeLast (rule[${i}])`;
    }
    if (endDay !== null) nextStart = endDay + 1;
  }
  return null;
}

// Build the corrected rules array from a proposal, copying importes verbatim from
// the carrier's current rules. Pure — returns new rule objects.
function buildFixedRules(currentRules, proposal) {
  return proposal.map((tier) => {
    const src = currentRules[tier.copyFromIndex];
    if (!src) {
      throw new Error(`proposal references missing rule index ${tier.copyFromIndex}`);
    }
    const rateConfig = structuredClone(src.rateConfig || {});
    const freeRule = Number(rateConfig.rate || 0) === 0;
    return {
      id: src.id,
      label: formatDemurrageRuleLabel(tier.startDay, tier.endDay, freeRule),
      note: src.note ?? null,
      startDay: tier.startDay,
      endDay: tier.endDay,
      freeRule,
      taxRate: src.taxRate ?? 0,
      rateConfig,
    };
  });
}

const money = (r) =>
  r.freeRule ? "free" : `${r.rateConfig?.rate ?? "?"}${r.rateConfig?.currency || ""}`;
const span = (r) =>
  `[${r.startDay ?? "?"}-${r.endDay == null ? "∞" : r.endDay} ${money(r)}]`;

function printSet(setName, before, after, warnings) {
  console.log(`\n  ── ${setName}`);
  console.log(`     BEFORE  ${before.map(span).join(" ")}`);
  console.log(`     AFTER   ${after.map(span).join(" ")}`);
  const reason = gateReason(after);
  console.log(`     gate(after): ${reason ? "STILL INVALID -> " + reason : "OK"}`);
  for (const w of warnings) console.log(`     ! ${w}`);
}

// Importe-preservation check: the multiset of (rate,currency,free) across AFTER
// must be a subset of BEFORE's (we only drop duplicate tiers / rebase days, never
// introduce a new importe).
function importesPreserved(before, after) {
  const key = (r) => `${r.freeRule ? "free" : r.rateConfig?.rate}|${r.rateConfig?.currency || ""}`;
  const pool = before.map(key);
  for (const r of after) {
    const idx = pool.indexOf(key(r));
    if (idx < 0) return false;
    pool.splice(idx, 1);
  }
  return true;
}

async function loadProdCarriers() {
  // assertProd on the app's configured DATABASE_URL before any read.
  const { loadLocalEnv } = require("../../src/lib/env");
  loadLocalEnv();
  assertProd(process.env.DATABASE_URL);
  store.invalidateShippingDataCache();
  const data = await store.getShippingData();
  return data.modules.handover.shippingLines;
}

// Returns { plan: [{carrier, set, before, after, warnings}], scannedBad: [...] }
function buildPlan(carriers) {
  const plan = [];
  const scannedBad = [];
  for (const carrier of carriers) {
    for (const set of carrier.demurrage?.ruleSets || []) {
      const reason = gateReason(set.rules || []);
      if (reason) scannedBad.push(`${carrier.id}/${set.name || set.id}: ${reason}`);
      const proposal = carrier.id && proposalFor(carrier.id, set);
      if (!proposal) continue;
      const before = structuredClone(set.rules || []);
      const after = buildFixedRules(set.rules || [], proposal);
      const warnings = [];
      if (gateReason(after)) warnings.push("AFTER still fails the gate — fix PROPOSALS");
      if (!importesPreserved(before, after))
        warnings.push("importe set changed vs BEFORE — review copyFromIndex");
      if (after.length && after[after.length - 1].endDay !== null)
        warnings.push(
          `last tier is BOUNDED (${span(after[after.length - 1])}) — days beyond it are unbilled; José confirm open-ended vs bounded`
        );
      plan.push({ carrier, set, before, after, warnings });
    }
  }
  return { plan, scannedBad };
}

async function dryRun() {
  const carriers = await loadProdCarriers();
  console.log(`[fix-demurrage] DRY-RUN (read-only). carriers=${carriers.length}`);
  const { plan, scannedBad } = buildPlan(carriers);

  console.log(`\n[scan] rule sets currently failing the gate (all carriers):`);
  if (!scannedBad.length) console.log("  (none)");
  for (const b of scannedBad) console.log(`  - ${b}`);
  const badCarriers = [...new Set(scannedBad.map((s) => s.split("/")[0]))].sort();
  console.log(`  badCarriers = ${badCarriers.join(",") || "none"}  (expected: ${TARGET_CARRIERS.join(",")})`);

  console.log(`\n[proposal] before/after (importes copied from live data; days = DRAFT for José):`);
  let blocked = 0;
  const byCarrier = {};
  for (const item of plan) (byCarrier[item.carrier.id] ||= []).push(item);
  for (const [carrierId, items] of Object.entries(byCarrier)) {
    console.log(`\n=== ${carrierId} (${items[0].carrier.name}) ===`);
    for (const item of items) {
      printSet(item.set.name || item.set.id, item.before, item.after, item.warnings);
      if (item.warnings.some((w) => w.includes("STILL") || w.includes("importe set changed"))) blocked += 1;
    }
  }
  console.log(
    `\n[fix-demurrage] dry-run complete. proposed sets=${plan.length} blocking-issues=${blocked}.`
  );
  console.log(
    blocked
      ? "  -> FIX PROPOSALS before --apply."
      : "  -> proposals validate. Send before/after to José; --apply only after he confirms the days."
  );
}

async function apply() {
  if (!process.argv.includes("--jose-confirmed")) {
    console.error(
      "[fix-demurrage] REFUSING --apply without --jose-confirmed. The day-sequences are José's call; pass both flags only after he signs off on the before/after."
    );
    process.exit(2);
  }
  const carriers = await loadProdCarriers();
  const { plan } = buildPlan(carriers);
  if (!plan.length) {
    console.log("[fix-demurrage] nothing to apply.");
    return;
  }
  for (const item of plan) {
    if (item.warnings.some((w) => w.includes("STILL") || w.includes("importe set changed"))) {
      console.error(`[fix-demurrage] ABORT — blocking issue on ${item.carrier.id}/${item.set.name}. Fix PROPOSALS.`);
      process.exit(2);
    }
  }

  // Backup the affected carriers' full demurrage state BEFORE any write.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = process.env.FIX_STAMP || "manual";
  const affected = [...new Set(plan.map((p) => p.carrier.id))];
  const backup = {
    takenAt: new Date().toISOString(),
    carriers: affected.map((id) => {
      const c = carriers.find((x) => x.id === id);
      return { id: c.id, name: c.name, demurrage: structuredClone(c.demurrage) };
    }),
  };
  const json = JSON.stringify(backup, null, 2);
  const sha = crypto.createHash("sha256").update(json).digest("hex");
  const backupFile = path.join(BACKUP_DIR, `demurrage-prefix-${stamp}.json`);
  fs.writeFileSync(backupFile, json);
  console.log(`[backup] ${backupFile} sha256=${sha.slice(0, 16)}… carriers=${affected.join(",")}`);

  // Apply per carrier via the per-entity store facade (relational write path).
  for (const id of affected) {
    const carrier = carriers.find((x) => x.id === id);
    for (const item of plan.filter((p) => p.carrier.id === id)) {
      const set = carrier.demurrage.ruleSets.find((s) => s.id === item.set.id);
      set.rules = item.after;
      if (set.sourceGroupKey) carrier.demurrage.rulesByGroup[set.sourceGroupKey] = item.after;
      // keep freeDays consistent with the new free tier
      const free = item.after.find((r) => r.freeRule && r.endDay);
      if (free) carrier.demurrage.freeDays.daysByGroup[set.id] = free.endDay;
    }
    await store.saveCarrier(carrier);
    console.log(`[applied] ${id}: ${plan.filter((p) => p.carrier.id === id).length} set(s) rewritten`);
  }

  // Read back and verify.
  store.invalidateShippingDataCache();
  const after = await loadProdCarriers();
  let failures = 0;
  for (const item of plan) {
    const c = after.find((x) => x.id === item.carrier.id);
    const set = c.demurrage.ruleSets.find((s) => s.id === item.set.id);
    const reason = gateReason(set.rules);
    const importesOk = importesPreserved(item.before, set.rules);
    if (reason || !importesOk) {
      failures += 1;
      console.error(`[verify] FAIL ${item.carrier.id}/${item.set.name}: gate=${reason || "ok"} importes=${importesOk}`);
    }
  }
  console.log(
    `\n[fix-demurrage] APPLY ${failures ? "FAILED" : "OK"} — verified ${plan.length - failures}/${plan.length} sets. Backup: ${backupFile}`
  );
  if (failures) {
    console.error(`  -> revert with: node scripts/relational/fix-demurrage-rulesets.js --revert ${backupFile}`);
    process.exit(2);
  }
}

async function revert() {
  const file = process.argv[process.argv.indexOf("--revert") + 1];
  if (!file || !fs.existsSync(file)) {
    console.error("[fix-demurrage] --revert needs a backup file path");
    process.exit(2);
  }
  const carriers = await loadProdCarriers();
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const saved of backup.carriers) {
    const carrier = carriers.find((x) => x.id === saved.id);
    if (!carrier) continue;
    carrier.demurrage = structuredClone(saved.demurrage);
    await store.saveCarrier(carrier);
    console.log(`[revert] restored ${saved.id} demurrage from backup`);
  }
  store.invalidateShippingDataCache();
  console.log("[fix-demurrage] revert complete.");
}

async function main() {
  if (process.argv.includes("--revert")) return revert();
  if (process.argv.includes("--apply")) return apply();
  return dryRun();
}

main().catch((e) => {
  console.error("[fix-demurrage] ERROR:", e.message);
  process.exit(1);
});
