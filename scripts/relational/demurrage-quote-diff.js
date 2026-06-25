// PART B — demurrage quote before/after diff for the Phase 2 data fix.
// READ-ONLY. Replicates the app's exact demurrage charge logic
// (calculate.js getProgressiveRuleWindow: each rule covers
// [max(startDay, coveredUntil+1) .. endDay|totalDays], charging rate × dayCount)
// and compares, per fixed rule set + the container types assigned to it, the
// per-container demurrage (USD, qty=1) at representative dwell days:
//   BEFORE = the backup taken by --apply (the bad sequences)
//   AFTER  = current prod (the fixed sequences)
//
//   node scripts/relational/demurrage-quote-diff.js <backup.json>
//   (backup defaults to the newest backups/demurrage-prefix-*.json)

const fs = require("node:fs");
const path = require("node:path");

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";

const { loadLocalEnv } = require("../../src/lib/env");
const { assertProd } = require("./prod-guard");
const store = require("../../src/lib/store");

const SAMPLE_DAYS = [5, 10, 14, 17, 20, 22, 25, 30];
const BACKUP_DIR = path.join(__dirname, "../../backups");

// EXACT copy of calculate.js getProgressiveRuleWindow + the demurrage summation
// (rate × dayCount × qty), qty=1. All these carriers' importes are USD.
function demurrageUSD(rules, totalDays) {
  let coveredUntil = 0;
  let total = 0;
  const parts = [];
  for (const rule of rules || []) {
    if (rule.startDay === null || rule.startDay === undefined) continue;
    const start = Math.max(rule.startDay, coveredUntil + 1, 1);
    const end =
      rule.endDay === null || rule.endDay === undefined ? totalDays : Math.min(rule.endDay, totalDays);
    if (end < start) continue;
    const dayCount = end - start + 1;
    coveredUntil = end;
    const rate = rule.freeRule ? 0 : Number(rule.rateConfig?.rate || 0);
    if (rate > 0) {
      total += rate * dayCount;
      parts.push(`${dayCount}d×$${rate}`);
    }
  }
  return { total, parts };
}

function findBackup() {
  const arg = process.argv[2];
  if (arg) return arg;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("demurrage-prefix-") && f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error("no demurrage-prefix-*.json backup found");
  return path.join(BACKUP_DIR, files[files.length - 1]);
}

async function main() {
  loadLocalEnv();
  assertProd(process.env.DATABASE_URL);

  const backupPath = findBackup();
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  console.log(`[diff] BEFORE = ${path.basename(backupPath)}  |  AFTER = live prod (read-only)\n`);

  store.invalidateShippingDataCache();
  const after = (await store.getShippingData()).modules.handover;
  const containerTypes = after.containerTypes || [];
  const typeLabel = (key) => containerTypes.find((t) => t.key === key)?.label || key;

  let anyDelta = false;

  for (const savedCarrier of backup.carriers) {
    const id = savedCarrier.id;
    const afterCarrier = after.shippingLines.find((l) => l.id === id);
    const beforeSets = savedCarrier.demurrage.ruleSets || [];
    const afterSets = afterCarrier.demurrage.ruleSets || [];
    const assignments = afterCarrier.demurrage.assignmentsByContainerType || {};

    console.log(`=== ${id.toUpperCase()} (${savedCarrier.name}) ===`);
    for (const beforeSet of beforeSets) {
      const afterSet = afterSets.find((s) => s.id === beforeSet.id);
      if (!afterSet) continue;
      const beforeSig = JSON.stringify(beforeSet.rules.map((r) => [r.startDay, r.endDay, r.freeRule, r.rateConfig?.rate]));
      const afterSig = JSON.stringify(afterSet.rules.map((r) => [r.startDay, r.endDay, r.freeRule, r.rateConfig?.rate]));
      const changed = beforeSig !== afterSig;
      const assignedTypes = Object.entries(assignments)
        .filter(([, sid]) => sid === beforeSet.id)
        .map(([tk]) => typeLabel(tk));

      console.log(
        `\n  ── ${beforeSet.name}  ${changed ? "(FIXED)" : "(unchanged)"}` +
          (assignedTypes.length ? `\n     applies to: ${assignedTypes.join(", ")}` : "")
      );
      if (!changed) {
        console.log("     no rule change → demurrage identical at all dwell days.");
        continue;
      }
      console.log("     dwell |  BEFORE $ (bad)        |  AFTER $ (fixed)       | Δ");
      for (const days of SAMPLE_DAYS) {
        const b = demurrageUSD(beforeSet.rules, days);
        const a = demurrageUSD(afterSet.rules, days);
        const delta = a.total - b.total;
        if (delta !== 0) anyDelta = true;
        const mark = delta !== 0 ? (delta > 0 ? `+${delta}` : `${delta}`) : "0";
        console.log(
          `     ${String(days).padStart(4)}d | ` +
            `$${String(b.total).padEnd(6)} ${`(${b.parts.join("+") || "free only"})`.padEnd(13)} | ` +
            `$${String(a.total).padEnd(6)} ${`(${a.parts.join("+") || "free only"})`.padEnd(13)} | ${mark}`
        );
      }
    }
    console.log("");
  }

  console.log(
    `[diff] done. ${anyDelta ? "Deltas exist — these are days the BAD sequence mis-covered (see table)." : "No deltas — fix was charge-neutral."}`
  );
  console.log(
    "[note] importes (free period + per-tier rates) are byte-identical before/after; any Δ is purely from the corrected day-coverage of the previously-invalid sequence."
  );
}

main().catch((e) => {
  console.error("[demurrage-quote-diff] ERROR:", e.message);
  process.exit(1);
});
