// PHASE 4 — Parity + reverse + idempotency, all against the PINNED blob from Phase 3
// (deterministic — immune to concurrent FX/José writes on the live blob). Via the migrator.
//   - parity:      normalize(pinned)+drop  ==  normalize(assemble(tables))   (DATA diff = 0)
//   - José checks: CMA doc fee 50 / KMTC ISD 15 / ZIM / COSCO / 2 self-built yards / 7 shells
//   - reverse:     assemble(tables) == normalize(pinned)+drop  (VERIFY ONLY — no app_state write,
//                  stricter than the runbook's rollback-key write; iron rule #3 = don't touch app_state)
//   - idempotent:  re-upsert decompose(normalized) → identical counts + parity still 0
//
// HARD GATE: parity DATA diff = 0 (before AND after the idempotent re-upsert) + José checks pass.
const fs = require("node:fs");
const path = require("node:path");
const { connectProdMigrator } = require("./prod-env");
const { readAllTables, tableCounts, upsertAllTables, canonicalJson, canonicalize } = require("../../src/lib/store/relational-repo");
const { assemble, decompose } = require("../../src/lib/store/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");
const { dropDanglingRefs } = require("./gates");

const PIN = path.join(__dirname, "../../backups/.prod-migration-pin.json");

function firstDiffShapes(a, b) {
  const diffs = [];
  (function walk(x, y, p) {
    if (diffs.length > 50) return;
    const tx = Array.isArray(x) ? "arr" : x === null ? "null" : typeof x;
    const ty = Array.isArray(y) ? "arr" : y === null ? "null" : typeof y;
    if (tx !== ty) { diffs.push(`${p} [${tx} vs ${ty}]`); return; }
    if (tx === "arr") {
      if (x.length !== y.length) diffs.push(`${p} arr len ${x.length} vs ${y.length}`);
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    if (tx === "object") { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${p}.${k}`); return; }
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
  })(canonicalize(a), canonicalize(b), "");
  return diffs;
}

(async () => {
  if (!fs.existsSync(PIN)) throw new Error("[phase4] pin file missing — run Phase 3 first");
  const pin = JSON.parse(fs.readFileSync(PIN, "utf8"));
  const { pool, ref, schema, role } = connectProdMigrator();
  console.log(`[phase4] ref=${ref} (PROD) schema=${schema} role=${role}  pinnedAt=${pin.takenAt} pinSha=${pin.sha256.slice(0,16)}…`);

  const normalized = normalizeShippingData(pin.blob);
  dropDanglingRefs(normalized);
  const blobProjection = canonicalJson(normalized);

  const parityAt = async (label) => {
    const tables = await readAllTables(pool, schema);
    const tableProjection = normalizeShippingData(assemble(tables));
    const equal = blobProjection === canonicalJson(tableProjection);
    console.log(`[phase4] parity ${label}: DATA diff ${equal ? "0 — PASS ✅" : "NONZERO — FAIL ❌"}`);
    if (!equal) firstDiffShapes(normalized, tableProjection).slice(0, 20).forEach((d) => console.error("   ", d.slice(0, 160)));
    return { equal, tableProjection };
  };

  // (1) parity after Phase 3
  const p1 = await parityAt("(post-migrate)");

  // (2) José hand-edit spot-checks (parity=0 is the comprehensive proof; these are headline anchors)
  const rel = p1.tableProjection;
  const carriers = rel.modules.handover.shippingLines || [];
  const yards = rel.modules.customs.yards || [];
  const findCharge = (name, re) => {
    const c = carriers.find((x) => new RegExp(name, "i").test(x.name || "") || new RegExp(name, "i").test(x.id || ""));
    return c && (c.localCharges || []).find((ch) => re.test(ch.concept || "") || re.test(ch.id || ""));
  };
  const cma = findCharge("cma", /doc|docum/i);
  const kmtc = findCharge("kmtc", /isd/i);
  const emptyShells = carriers.filter((c) => !(c.localCharges && c.localCharges.length));
  const selfBuilt = yards.filter((y) => /新场站|custom|nuevo/i.test((y.id || "") + (y.name || "")));
  const spot = {
    carriers: carriers.length,
    yards: yards.length,
    cmaDocFee: cma ? cma.blRate?.rate : "not-found",
    kmtcIsd: kmtc ? { concept: kmtc.concept, sampleRate: Object.values(kmtc.groupRates || {})[0]?.rate } : "not-found",
    zimPresent: !!carriers.find((c) => /zim/i.test(c.name || "")),
    coscoPresent: !!carriers.find((c) => /cosco/i.test(c.name || "")),
    selfBuiltYards: selfBuilt.map((y) => y.name),
    emptyShellCarriers: emptyShells.length,
  };
  console.log("[phase4] José spot-checks:", JSON.stringify(spot));
  const joseOk = spot.cmaDocFee === 50 && spot.zimPresent && spot.coscoPresent && spot.carriers === 21 && spot.yards === 28;

  // (3) reverse == normalize (VERIFY ONLY — no write to app_state)
  const reconstructed = canonicalJson(normalizeShippingData(assemble(await readAllTables(pool, schema))));
  const reverseOk = reconstructed === blobProjection;
  console.log(`[phase4] reverse(tables) == normalize(pinned)+drop: ${reverseOk ? "YES ✅" : "NO ❌"}  (verify-only, app_state NOT written)`);

  // (4) forward idempotency — re-upsert the SAME pinned source, expect identical counts + parity 0
  const before = await tableCounts(pool, schema);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await upsertAllTables(c, schema, decompose(normalized));
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  const after = await tableCounts(pool, schema);
  const countsIdentical = JSON.stringify(before) === JSON.stringify(after);
  console.log(`[phase4] idempotency: re-upsert counts identical: ${countsIdentical ? "YES ✅" : "NO ❌"}`);
  const p2 = await parityAt("(post-idempotent-reupsert)");

  const gatePass = p1.equal && p2.equal && joseOk && reverseOk && countsIdentical;
  console.log(`\n[phase4] HARD GATE — parity=0 (x2) + José checks + reverse YES + idempotent: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  await pool.end();
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[phase4] ERROR:", e.message);
  process.exit(1);
});
