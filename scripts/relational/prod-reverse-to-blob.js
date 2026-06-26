// PROD reverse migration (tables → blob) — the WRITE side of rollback, which until now
// existed only for the sandbox. Reads the live 18 entity tables, assembles+normalizes back
// to the shipping-data shape, and writes it to app_state. Uses postgres (admin) creds — the
// only role that can write app_state.
//
// SAFETY: by default writes ONLY the scratch key `shipping-data-rollback-test` (proof run).
// The real rollback writes the live `shipping-data` key, and that requires BOTH --apply AND
// --i-understand-this-overwrites-the-live-blob. This task runs WITHOUT --apply (scratch only).
//
// HARD GATE (proof run): the tables→blob→tables round-trip is lossless — per-table row counts
// of decompose(rebuilt) match the live tables AND normalize(assemble(decompose(rebuilt)))
// canonical-equals the rebuilt blob — plus José spot-checks pass; and the live shipping-data
// key is provably UNTOUCHED (same revision before/after).
const { connectProdAdmin } = require("./prod-env");
const { readBlob, writeBlob, readAllTables, tableCounts, canonicalJson } = require("../../src/lib/db/relational-repo");
const { assemble, decompose } = require("../../src/lib/db/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

const SHIPPING_KEY = "shipping-data";
const SCRATCH_KEY = "shipping-data-rollback-test";
const APPLY = process.argv.includes("--apply");
const CONFIRM = process.argv.includes("--i-understand-this-overwrites-the-live-blob");

(async () => {
  const { pool, ref, schema, role } = connectProdAdmin();
  const targetKey = APPLY ? SHIPPING_KEY : SCRATCH_KEY;
  console.log(`[reverse] ref=${ref} (PROD) schema=${schema} role=${role} → key=${targetKey}${APPLY ? " (--APPLY: REAL ROLLBACK)" : " (scratch proof)"}`);
  if (APPLY && !CONFIRM) {
    console.error("[reverse] REFUSING --apply without --i-understand-this-overwrites-the-live-blob");
    await pool.end();
    process.exit(1);
  }

  // 1) read the live tables → rebuild the blob
  const tables = await readAllTables(pool, schema);
  const liveCounts = await tableCounts(pool, schema);
  const rebuilt = normalizeShippingData(assemble(tables));

  // 2) lossless round-trip proof (all in-memory, coercion-free):
  //    decompose(rebuilt) must reproduce the SAME tables (row counts) and re-assemble to the
  //    SAME blob projection.
  const reDecomposed = decompose(rebuilt);
  const countMismatch = Object.keys(liveCounts).filter(
    (t) => (reDecomposed[t] || []).length !== liveCounts[t]
  );
  const A = canonicalJson(rebuilt);
  const B = canonicalJson(normalizeShippingData(assemble(reDecomposed)));
  const roundTripEqual = A === B;
  console.log(`[reverse] per-table row counts decompose(rebuilt) vs live tables: ${countMismatch.length === 0 ? "MATCH ✅" : "MISMATCH ❌ " + countMismatch.join(",")}`);
  console.log(`[reverse] normalize(assemble(decompose(rebuilt))) == rebuilt (canonical): ${roundTripEqual ? "YES ✅" : "NO ❌"}`);

  // 3) José spot-checks on the rebuilt blob
  const carriers = rebuilt.modules.handover.shippingLines || [];
  const yards = rebuilt.modules.customs.yards || [];
  const charge = (name, re) => {
    const c = carriers.find((x) => new RegExp(name, "i").test(x.name || "") || new RegExp(name, "i").test(x.id || ""));
    return c && (c.localCharges || []).find((ch) => re.test(ch.concept || "") || re.test(ch.id || ""));
  };
  const cma = charge("cma", /doc|docum/i);
  const kmtc = charge("kmtc", /isd/i);
  const spot = {
    carriers: carriers.length, yards: yards.length,
    cmaDocFee: cma ? cma.blRate?.rate : "?", kmtcIsd: kmtc ? Object.values(kmtc.groupRates || {})[0]?.rate : "?",
    zim: !!carriers.find((c) => /zim/i.test(c.name || "")), cosco: !!carriers.find((c) => /cosco/i.test(c.name || "")),
    selfBuiltYards: yards.filter((y) => /新场站/.test(y.name || "")).length,
    emptyShells: carriers.filter((c) => !(c.localCharges && c.localCharges.length)).length,
  };
  console.log("[reverse] José spot-checks on rebuilt blob:", JSON.stringify(spot));
  const joseOk = spot.carriers === 21 && spot.yards === 28 && spot.cmaDocFee === 50 && spot.kmtcIsd === 15 &&
    spot.zim && spot.cosco && spot.selfBuiltYards === 2 && spot.emptyShells === 7;

  // 4) write to the target key; prove shipping-data is UNTOUCHED when writing scratch
  const revBefore = (await pool.query(`select revision from ${schema}.app_state where key=$1`, [SHIPPING_KEY])).rows[0]?.revision;
  await writeBlob(pool, schema, rebuilt, targetKey);
  const back = await readBlob(pool, schema, targetKey);
  const writeReadEqual = canonicalJson(normalizeShippingData(back)) === A;
  const revAfter = (await pool.query(`select revision from ${schema}.app_state where key=$1`, [SHIPPING_KEY])).rows[0]?.revision;
  const shippingUntouched = revBefore === revAfter;
  console.log(`[reverse] wrote key=${targetKey}; read-back == rebuilt: ${writeReadEqual ? "YES ✅" : "NO ❌"}`);
  console.log(`[reverse] live shipping-data revision before=${revBefore} after=${revAfter} → UNTOUCHED: ${shippingUntouched ? "YES ✅" : "NO ❌"}`);

  // clean up the scratch key (leave app_state = {shipping-data, users})
  if (!APPLY) {
    await pool.query(`delete from ${schema}.app_state where key=$1`, [SCRATCH_KEY]);
    console.log(`[reverse] scratch key ${SCRATCH_KEY} deleted (app_state left clean).`);
  }

  const gatePass = countMismatch.length === 0 && roundTripEqual && joseOk && writeReadEqual && (APPLY || shippingUntouched);
  console.log(`\n[reverse] HARD GATE — lossless round-trip + José + shipping-data untouched: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  await pool.end();
  if (!gatePass) process.exit(2);
})().catch((e) => { console.error("[reverse] ERROR:", e.message); process.exit(1); });
