// Phase 0 (tarifas-save bug) — READ-ONLY confirmation.
// Dumps the demurrage ruleSets for msc/whan-hai/oocl from prod
// `expressline.carriers`, then simulates the EXACT validation gate the big edit
// handler applies on an unchanged resubmit (src/lib/rule-engine.js
// applySequentialRuleUpdates: endDay<nextStart -> invalidRuleRange; non-last
// endDay=null -> openEndedRuleMustBeLast). Proves WHICH invariant each carrier
// violates and WHY a save of any field on that carrier is rejected before
// saveModule() ever runs.
//
// HARD read-only transaction. Touches ONLY expressline.carriers (3 rows).
// No write of any kind. Safe to run against prod.
//
//   node scripts/relational/prod-read-demurrage.js            # the 3 affected
//   node scripts/relational/prod-read-demurrage.js --all      # all 21 carriers

const { connectProdAdmin } = require("./prod-env");

const TARGET_IDS = ["msc", "whan-hai", "oocl"];

// Mirror of applySequentialRuleUpdates' validation on an UNCHANGED resubmit:
// the form pre-fills each rule's end input from rule.endDay (views/admin-module.ejs
// `value="<%= rule.endDay ?? '' %>"`), so the effective end-sequence equals the
// stored rule.endDay sequence. Pure read; mutates nothing.
function simulateGate(rules) {
  let nextStart = 1;
  for (let i = 0; i < rules.length; i += 1) {
    const endDay = rules[i].endDay === undefined ? null : rules[i].endDay;
    if (endDay !== null && endDay < nextStart) {
      return { ok: false, reason: "invalidRuleRange", at: i, nextStart, endDay };
    }
    if (endDay === null && i < rules.length - 1) {
      return { ok: false, reason: "openEndedRuleMustBeLast", at: i };
    }
    if (endDay !== null) nextStart = endDay + 1;
  }
  return { ok: true };
}

function fmtRule(r) {
  const start = r.startDay === null || r.startDay === undefined ? "?" : r.startDay;
  const end = r.endDay === null || r.endDay === undefined ? "∞" : r.endDay;
  const money = r.freeRule
    ? "free"
    : `${r.rateConfig?.rate ?? "?"}${r.rateConfig?.currency || ""}`;
  return `[${start}-${end} ${money}]`;
}

async function main() {
  const all = process.argv.includes("--all");
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[prod-read-demurrage] ref=${ref} schema=${schema} role=${role} mode=READ-ONLY`);

  const client = await pool.connect();
  let badSets = 0;
  let badCarriers = new Set();
  try {
    await client.query("begin");
    await client.query("set transaction read only");

    const where = all ? "" : `where id = any($1)`;
    const params = all ? [] : [TARGET_IDS];
    const res = await client.query(
      `select id, name, demurrage->'ruleSets' as rule_sets
         from "${schema}".carriers
         ${where}
         order by id`,
      params
    );

    for (const row of res.rows) {
      console.log(`\n=== ${row.id} (${row.name}) ===`);
      for (const set of row.rule_sets || []) {
        const rules = set.rules || [];
        const gate = simulateGate(rules);
        const line = rules.map(fmtRule).join(" ");
        const verdict = gate.ok
          ? "OK"
          : `REJECT ${gate.reason}` +
            (gate.reason === "invalidRuleRange"
              ? ` (rule[${gate.at}] end=${gate.endDay} < nextStart=${gate.nextStart})`
              : ` (rule[${gate.at}] open-ended but not last)`);
        if (!gate.ok) {
          badSets += 1;
          badCarriers.add(row.id);
        }
        console.log(`  ${(set.name || set.id).padEnd(40)} ${line}`);
        console.log(`  ${"".padEnd(40)} -> ${verdict}`);
      }
    }

    await client.query("commit");
  } finally {
    client.release();
    await pool.end();
  }

  console.log(
    `\n[prod-read-demurrage] carriers scanned=${all ? "all" : TARGET_IDS.length}` +
      ` badRuleSets=${badSets} badCarriers=${[...badCarriers].sort().join(",") || "none"}`
  );
}

main().catch((e) => {
  console.error("[prod-read-demurrage] ERROR:", e.message);
  process.exit(1);
});
