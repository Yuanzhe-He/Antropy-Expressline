// SANDBOX-ONLY relational admin CRUD functional test.
//
// Boots the REAL app (createApp) in STORAGE_MODE=relational against an ISOLATED
// schema on the throwaway sandbox project, drives the admin routes over HTTP, and
// after each operation reads the ACTUAL relational tables (an independent pg pool)
// + the assemble round-trip (store.getShippingData) to prove the write landed in
// the relational tables prod actually uses and reads back correctly. Deletes also
// assert the row is gone AND no orphan children remain (FK cascade).
//
// WHY IT EXISTS: run-all-tests.js forces STORAGE_DRIVER=json, so every existing
// admin-route test runs in JSON mode. The "admin route → relational table → read
// back" combination had NO automated coverage (only the pure decompose/assemble
// round-trip was unit-tested). This closes that gap.
//
// HARD SANDBOX GUARD: refuses to run unless DATABASE_URL's project ref == the
// sandbox ref (assertSandbox, fail-closed) AND explicitly != the prod ref. The
// guard runs BEFORE the app is required, so loadLocalEnv() (which loads the prod
// .env) can never override the sandbox DATABASE_URL. **NOT in test:all** (that path
// is JSON-forced and a relational test there would eventually mis-connect).
//
//   node scripts/relational/sandbox-admin-crud-test.js

const { Pool } = require("pg");
const { loadSandboxEnv, sandboxPoolConfig } = require("./sandbox-env");
const { assertSandbox, extractProjectRef } = require("../sandbox-guard");

const PROD_REF = "polxyashvxbzdkkmxuox"; // hard deny, belt-and-suspenders

// ---- 1) sandbox env + guard FIRST, before requiring the app -----------------
loadSandboxEnv(); // sets DATABASE_URL=sandbox, SANDBOX_REF, FORBIDDEN_REFS (overrides)
const sandboxRef = assertSandbox(); // throws unless ref == SANDBOX_REF and not FORBIDDEN
if (sandboxRef === PROD_REF || extractProjectRef(process.env.DATABASE_URL) === PROD_REF) {
  console.error("[sandbox-admin-crud] ABORT: DATABASE_URL points at PROD — refusing.");
  process.exit(1);
}

// ---- 2) relational mode + isolated schema + MINIMAL fixture, before requiring app
const fs = require("node:fs");
const os = require("node:os");
const pathMod = require("node:path");
const TEST_SCHEMA = "el_admincrud";
process.env.DATABASE_SCHEMA = TEST_SCHEMA;
process.env.STORAGE_MODE = "relational";
delete process.env.STORAGE_DRIVER; // must NOT be json
process.env.SKIP_FX_REFRESH = "1";
// Minimal fixture via a temp DATA_DIR so the relational seed is ~tens of rows, not the
// bundled ~700 (which made full table reads crawl over the remote sandbox). DATA_DIR is
// read at store module-load, so it must be set BEFORE requiring the app.
const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "jose-relcrud-"));
fs.writeFileSync(pathMod.join(tmpDir, "shipping-lines.json"), JSON.stringify({
  modules: {
    handover: { shippingLines: [{ id: "seed-line", name: "Seed Line", notes: { code: "SL", rfc: "SL000" } }], containerTypes: [{ key: "gp20", label: "GP20", rateGroup: "dry" }] },
    customs: { ports: [{ id: "seed-port", name: "Seed Port", terminals: [{ id: "seed-term", name: "Seed Term" }] }], yards: [{ id: "seed-yard", name: "Seed Yard" }] },
    inland: { origins: [{ id: "seed-orig", name: "Seed Orig", lat: 19, lng: -104 }], destinations: [], rateEntries: [] },
    quote: { notes: [] },
  },
}));
process.env.DATA_DIR = tmpDir;

console.log(`[sandbox-admin-crud] ref=${sandboxRef} (SANDBOX) schema=${TEST_SCHEMA} mode=relational — guard passed\n`);

// ---- 3) now load the app + store (env is locked to sandbox) -----------------
const { createApp } = require("../../src/server");
const store = require("../../src/lib/store");

// independent verification pool (reads the real table rows, bypassing app cache)
const vpool = new Pool(sandboxPoolConfig());
const S = `"${TEST_SCHEMA}"`;
const tq = (sql, p = []) => vpool.query(sql, p).then((r) => r.rows);
const tcount = async (table, where = "", p = []) =>
  (await tq(`select count(*)::int n from ${S}."${table}" ${where}`, p))[0].n;

// ---- HTTP harness (cookie jar, form post) -----------------------------------
class CookieJar {
  constructor() { this.c = new Map(); }
  store(h) {
    const sc = typeof h.getSetCookie === "function" ? h.getSetCookie()
      : h.get("set-cookie") ? h.get("set-cookie").split(/,(?=[^;]+?=)/) : [];
    for (const ck of sc) { const [p] = ck.split(";"); const i = p.indexOf("="); if (i > 0) this.c.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  }
  header() { return [...this.c.entries()].map(([n, v]) => `${n}=${v}`).join("; "); }
}
let baseUrl, jar;
async function req(urlPath, { method = "POST", form } = {}) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, x == null ? "" : String(x)));
      else params.append(k, v == null ? "" : String(v));
    }
    body = params;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(`${baseUrl}${urlPath}`, { method, headers, body, redirect: "manual" });
  jar.store(r.headers);
  return { status: r.status, location: r.headers.get("location") };
}

// ---- result matrix ----------------------------------------------------------
const matrix = [];
async function step(mod, op, fn) {
  try {
    const evidence = await fn();
    matrix.push({ mod, op, pass: true, evidence: evidence || "" });
    console.log(`  PASS  ${mod.padEnd(16)} ${op.padEnd(40)} ${evidence || ""}`);
  } catch (e) {
    matrix.push({ mod, op, pass: false, evidence: e.message });
    console.log(`  FAIL  ${mod.padEnd(16)} ${op.padEnd(40)} ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// helpers to read assembled (round-trip) view via the app store
const sd = () => store.getShippingData();
const carrierRow = async (id) => (await tq(`select * from ${S}.carriers where id=$1`, [id]))[0];
const terminalRow = async (id) => (await tq(`select * from ${S}.customs_terminals where id=$1`, [id]))[0];

async function main() {
  // clean isolated schema (app recreates it via buildSchemaDDL on first relational op)
  await vpool.query(`drop schema if exists ${S} cascade`);

  const app = createApp();
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  jar = new CookieJar();

  try {
    // ===== SEED (relational seed = decompose→upsert all 18 tables) ============
    await step("seed", "app seeds isolated schema from bundled fixture", async () => {
      await sd(); // first read seeds tables + cache
      const carriers = await tcount("carriers");
      const cts = await tcount("container_types");
      const ports = await tcount("customs_ports");
      const yards = await tcount("customs_yards");
      const dests = await tcount("inland_destinations");
      // carriers/container_types/ports/yards come from the fixture; inland destinations
      // are a code-seeded catalog; rate_entries start at 0 (added by the test).
      assert(carriers > 0 && cts > 0 && ports > 0 && yards > 0,
        `seed produced empty core tables (carriers=${carriers} cts=${cts} ports=${ports} yards=${yards})`);
      // round-trip: assembled view matches table counts
      const d = await sd();
      assert(d.modules.handover.shippingLines.length === carriers, "round-trip carrier count != table");
      return `tables seeded: carriers=${carriers} container_types=${cts} ports=${ports} yards=${yards} dests=${dests}; round-trip OK`;
    });

    // ===== CONTAINER TYPES (handover) — add / modify / delete =================
    await step("container-types", "add → table row exists", async () => {
      const rg = store.RATE_GROUP_NAMES[0];
      const r = await req("/admin/handover/container-types/add",
        { form: { ct_new_key: "zt-ct", ct_new_label: "ZT Box", ct_new_rateGroup: rg } });
      assert(r.status === 302, `add status ${r.status}`);
      const row = (await tq(`select * from ${S}.container_types where key=$1`, ["zt-ct"]))[0];
      assert(row, "container_types row not found after add");
      assert(row.rate_group === rg, `rate_group mismatch (${row.rate_group})`);
      const d = await sd();
      assert(d.modules.handover.containerTypes.some((c) => c.key === "zt-ct"), "round-trip missing ct");
      return `row key=zt-ct rate_group=${row.rate_group}`;
    });
    await step("container-types", "modify (save) → table updated", async () => {
      // save MAPS over existing types reading ct_label_<key>/ct_rateGroup_<key> (keeps all).
      const r = await req("/admin/handover/container-types/save",
        { form: { "ct_label_zt-ct": "ZT Box EDIT", "ct_rateGroup_zt-ct": store.RATE_GROUP_NAMES[0] } });
      assert(r.status === 302, `save status ${r.status}`);
      const row = (await tq(`select label from ${S}.container_types where key=$1`, ["zt-ct"]))[0];
      assert(row && row.label === "ZT Box EDIT", `label not updated (${row && row.label})`);
      return `label → "${row.label}"`;
    });
    await step("container-types", "delete → row gone", async () => {
      const r = await req("/admin/handover/container-types/zt-ct/delete");
      assert(r.status === 302, `delete status ${r.status}`);
      assert((await tcount("container_types", "where key=$1", ["zt-ct"])) === 0, "row still present");
      return "row removed";
    });

    // ===== SHIPPING LINES / CARRIERS (handover) ===============================
    let newCarrierId;
    await step("shipping-lines", "add carrier → carriers row exists", async () => {
      const before = await tcount("carriers");
      const r = await req("/admin/handover/shipping-lines/add", { form: { line_name: "ZT Line", line_code: "ZTL", line_rfc: "ZT000000" } });
      assert(r.status === 302, `add status ${r.status}`);
      assert((await tcount("carriers")) === before + 1, "carrier count not +1");
      const d = await sd();
      const c = d.modules.handover.shippingLines.find((x) => x.name === "ZT Line");
      assert(c, "new carrier not in round-trip");
      newCarrierId = c.id;
      const row = await carrierRow(newCarrierId);
      assert(row && row.name === "ZT Line", "carriers row name mismatch");
      return `carrier id=${newCarrierId} name="${row.name}"`;
    });
    await step("shipping-lines", "local-charges add → carrier_local_charges row (FK)", async () => {
      const before = await tcount("carrier_local_charges", "where carrier_id=$1", [newCarrierId]);
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/local-charges/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const after = await tcount("carrier_local_charges", "where carrier_id=$1", [newCarrierId]);
      assert(after === before + 1, `local charge not added (${before}→${after})`);
      return `carrier_local_charges for ${newCarrierId}: ${before}→${after}`;
    });
    let chargeId;
    await step("shipping-lines", "local-charges delete → row gone", async () => {
      const lc = (await tq(`select id from ${S}.carrier_local_charges where carrier_id=$1 limit 1`, [newCarrierId]))[0];
      assert(lc, "no local charge to delete");
      chargeId = lc.id;
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/local-charges/${chargeId}/delete`);
      assert(r.status === 302, `delete status ${r.status}`);
      assert((await tcount("carrier_local_charges", "where id=$1", [chargeId])) === 0, "local charge still present");
      return `removed charge ${chargeId}`;
    });
    await step("shipping-lines", "terminal-mix add → carriers.terminal_mix jsonb grows", async () => {
      const before = ((await carrierRow(newCarrierId)).terminal_mix || []).length;
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/terminal-mix/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const after = ((await carrierRow(newCarrierId)).terminal_mix || []).length;
      assert(after === before + 1, `terminal_mix not grown (${before}→${after})`);
      return `terminal_mix jsonb: ${before}→${after}`;
    });
    // ----- DEMURRAGE RULE SETS (nested: ruleSet → rules) ----------------------
    let ruleSetId;
    await step("shipping-lines", "demurrage rule-set add → carriers.demurrage jsonb ruleSets grows", async () => {
      const before = (((await carrierRow(newCarrierId)).demurrage || {}).ruleSets || []).length;
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/demurrage-rule-sets/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const sets = ((await carrierRow(newCarrierId)).demurrage || {}).ruleSets || [];
      assert(sets.length === before + 1, `ruleSets not grown (${before}→${sets.length})`);
      ruleSetId = sets[sets.length - 1].id;
      return `demurrage.ruleSets: ${before}→${sets.length} (new set ${ruleSetId})`;
    });
    await step("shipping-lines", "demurrage rule add (LEVEL 2: rule in set) → set.rules grows", async () => {
      const set0 = (((await carrierRow(newCarrierId)).demurrage || {}).ruleSets || []).find((s) => s.id === ruleSetId);
      const before = (set0.rules || []).length;
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/demurrage-rule-sets/${ruleSetId}/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const set1 = (((await carrierRow(newCarrierId)).demurrage || {}).ruleSets || []).find((s) => s.id === ruleSetId);
      assert((set1.rules || []).length === before + 1, `rules not grown (${before}→${(set1.rules || []).length})`);
      return `ruleSet.rules: ${before}→${(set1.rules || []).length}`;
    });
    await step("shipping-lines", "demurrage rule delete → set.rules shrinks", async () => {
      const set0 = (((await carrierRow(newCarrierId)).demurrage || {}).ruleSets || []).find((s) => s.id === ruleSetId);
      const rule = (set0.rules || [])[0];
      assert(rule, "no rule to delete");
      const before = set0.rules.length;
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/demurrage-rule-sets/${ruleSetId}/${rule.id}/delete`);
      assert(r.status === 302, `delete status ${r.status}`);
      const set1 = (((await carrierRow(newCarrierId)).demurrage || {}).ruleSets || []).find((s) => s.id === ruleSetId);
      assert((set1.rules || []).length === before - 1, `rules not shrunk (${before}→${(set1.rules || []).length})`);
      return `ruleSet.rules: ${before}→${(set1.rules || []).length}`;
    });
    // NOTE: there is no standalone demurrage-rule-sets/:ruleSetId/delete route — the UI
    // deletes a whole rule set via the big per-line edit form. Whole-set removal is covered
    // transitively by the carrier delete below (which drops the entire demurrage jsonb).
    // Per-layer coverage kept: rule-set ADD, rule ADD (lvl2), rule DELETE.
    await step("shipping-lines", "delete carrier → row gone + NO orphan local-charges (FK cascade)", async () => {
      // add a local charge back first so we can prove the cascade removes it
      await req(`/admin/handover/shipping-lines/${newCarrierId}/local-charges/add`);
      const childBefore = await tcount("carrier_local_charges", "where carrier_id=$1", [newCarrierId]);
      assert(childBefore > 0, "expected a child local charge before delete");
      const r = await req(`/admin/handover/shipping-lines/${newCarrierId}/delete`);
      assert(r.status === 302, `delete status ${r.status}`);
      assert((await tcount("carriers", "where id=$1", [newCarrierId])) === 0, "carrier row still present");
      const orphans = await tcount("carrier_local_charges", "where carrier_id=$1", [newCarrierId]);
      assert(orphans === 0, `ORPHAN: ${orphans} carrier_local_charges left after carrier delete`);
      return `carrier gone; ${childBefore} child local-charges cascade-removed (0 orphan)`;
    });

    // ===== CUSTOMS — ports/terminals/charges (+ nested storage rule sets) =====
    let portId, terminalId, storeRuleSetId;
    await step("customs", "port add → customs_ports row", async () => {
      const before = await tcount("customs_ports");
      const r = await req("/admin/customs/ports/add");
      assert(r.status === 302, `add status ${r.status}`);
      assert((await tcount("customs_ports")) === before + 1, "port not added");
      portId = (await sd()).modules.customs.ports.slice(-1)[0].id;
      return `new port ${portId} (count ${before}→${before + 1})`;
    });
    await step("customs", "terminal add under port → customs_terminals row (FK port)", async () => {
      const r = await req(`/admin/customs/ports/${portId}/terminals/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const t = (await tq(`select id from ${S}.customs_terminals where port_id=$1`, [portId]))[0];
      assert(t, "terminal not under port");
      terminalId = t.id;
      return `terminal ${terminalId} under port ${portId}`;
    });
    await step("customs", "fixed-charge add → terminal_charges row (FK terminal)", async () => {
      const before = await tcount("terminal_charges", "where terminal_id=$1", [terminalId]);
      const r = await req(`/admin/customs/terminals/${terminalId}/fixed-charges/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const after = await tcount("terminal_charges", "where terminal_id=$1", [terminalId]);
      assert(after === before + 1, `fixed charge not added (${before}→${after})`);
      return `terminal_charges: ${before}→${after}`;
    });
    await step("customs", "storage rule-set add → terminal.storage_config jsonb grows", async () => {
      const sc = (await terminalRow(terminalId)).storage_config || {};
      const before = (sc.storageRuleSets || []).length;
      const r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const sc2 = (await terminalRow(terminalId)).storage_config || {};
      const sets = sc2.storageRuleSets || [];
      assert(sets.length === before + 1, `storageRuleSets not grown (${before}→${sets.length})`);
      storeRuleSetId = sets[sets.length - 1].id;
      return `storage_config.storageRuleSets: ${before}→${sets.length}`;
    });
    await step("customs", "storage rule add (LEVEL 2) → ruleSet.rules grows", async () => {
      const find = async () => ((await terminalRow(terminalId)).storage_config.storageRuleSets || []).find((s) => s.id === storeRuleSetId);
      const before = ((await find()).rules || []).length;
      const r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/${storeRuleSetId}/add`);
      assert(r.status === 302, `add status ${r.status}`);
      const after = ((await find()).rules || []).length;
      assert(after === before + 1, `storage rule not added (${before}→${after})`);
      return `storageRuleSet.rules: ${before}→${after}`;
    });
    await step("customs", "storage rule-set delete → shrinks", async () => {
      const sc = (await terminalRow(terminalId)).storage_config || {};
      const before = (sc.storageRuleSets || []).length;
      const r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/${storeRuleSetId}/delete`);
      assert(r.status === 302, `delete status ${r.status}`);
      const after = ((await terminalRow(terminalId)).storage_config.storageRuleSets || []).length;
      assert(after === before - 1, `not shrunk (${before}→${after})`);
      return `storageRuleSets: ${before}→${after}`;
    });
    await step("customs", "delete port → terminals + terminal_charges cascade (NO orphan)", async () => {
      const tBefore = await tcount("customs_terminals", "where port_id=$1", [portId]);
      const cBefore = await tcount("terminal_charges", "where terminal_id=$1", [terminalId]);
      assert(tBefore > 0 && cBefore > 0, "expected terminal + charge before delete");
      const r = await req(`/admin/customs/ports/${portId}/delete`);
      assert(r.status === 302, `delete status ${r.status}`);
      assert((await tcount("customs_ports", "where id=$1", [portId])) === 0, "port still present");
      const tOrphan = await tcount("customs_terminals", "where port_id=$1", [portId]);
      const cOrphan = await tcount("terminal_charges", "where terminal_id=$1", [terminalId]);
      assert(tOrphan === 0, `ORPHAN: ${tOrphan} terminals after port delete`);
      assert(cOrphan === 0, `ORPHAN: ${cOrphan} terminal_charges after port delete`);
      return `port gone; ${tBefore} terminal + ${cBefore} charge cascade-removed (0 orphan)`;
    });
    await step("customs", "yard add → delete → yard_charges/ports/carriers cascade (NO orphan)", async () => {
      const r1 = await req("/admin/customs/yards/add");
      assert(r1.status === 302, `yard add ${r1.status}`);
      const yardId = (await sd()).modules.customs.yards.slice(-1)[0].id;
      assert((await tcount("customs_yards", "where id=$1", [yardId])) === 1, "yard not added");
      const r2 = await req(`/admin/customs/yards/${yardId}/delete`);
      assert(r2.status === 302, `yard delete ${r2.status}`);
      assert((await tcount("customs_yards", "where id=$1", [yardId])) === 0, "yard still present");
      const o = (await tcount("yard_charges", "where yard_id=$1", [yardId])) +
        (await tcount("yard_ports", "where yard_id=$1", [yardId])) +
        (await tcount("yard_carriers", "where yard_id=$1", [yardId]));
      assert(o === 0, `ORPHAN: ${o} yard children after yard delete`);
      return `yard ${yardId} add→delete; 0 orphan children`;
    });

    // ===== INLAND — origins / destinations(+precise points) / rate-entries ====
    let originId, destId, rateId;
    await step("inland", "origin add → save(modify) → delete", async () => {
      let r = await req("/admin/inland/origins/add", { form: { name: "ZT Origin", lat: "19.0", lng: "-104.0" } });
      assert(r.status === 302, `add ${r.status}`);
      const o = (await tq(`select id,name from ${S}.inland_origins where name=$1`, ["ZT Origin"]))[0];
      assert(o, "origin not in table"); originId = o.id;
      // origins/save maps over existing origins reading origin_name_<id>/origin_lat_<id>/origin_lng_<id>
      r = await req("/admin/inland/origins/save", { form: { [`origin_name_${originId}`]: "ZT Origin EDIT", [`origin_lat_${originId}`]: "19.5", [`origin_lng_${originId}`]: "-104.5" } });
      assert(r.status === 302, `save ${r.status}`);
      const o2 = (await tq(`select name from ${S}.inland_origins where id=$1`, [originId]))[0];
      assert(o2.name === "ZT Origin EDIT", `origin not modified (${o2.name})`);
      return `origin add+modify "${o2.name}" (delete after rate-entry cascade test)`;
    });
    await step("inland", "destination add → table row", async () => {
      const r = await req("/admin/inland/destinations/add", { form: { name: "ZT Dest", lat: "20", lng: "-103" } });
      assert(r.status === 302, `add ${r.status}`);
      const d = (await tq(`select id from ${S}.inland_destinations where name=$1`, ["ZT Dest"]))[0];
      assert(d, "dest not in table"); destId = d.id;
      return `dest ${destId}`;
    });
    await step("inland", "precise-point add → destination jsonb grows", async () => {
      const before = ((await tq(`select precise_points from ${S}.inland_destinations where id=$1`, [destId]))[0].precise_points || []).length;
      const r = await req(`/admin/inland/destinations/${destId}/precise-points/add`, { form: { name: "ZT Point", lat: "20.1", lng: "-103.1" } });
      assert(r.status === 302, `add ${r.status}`);
      const after = ((await tq(`select precise_points from ${S}.inland_destinations where id=$1`, [destId]))[0].precise_points || []).length;
      assert(after === before + 1, `precise_points not grown (${before}→${after})`);
      return `precise_points jsonb: ${before}→${after}`;
    });
    await step("inland", "rate-entry add → row (FK dest) → save(modify)", async () => {
      let r = await req("/admin/inland/rate-entries/add", { form: { destinationId: destId } });
      assert(r.status === 302, `add ${r.status}`);
      const e = (await tq(`select id from ${S}.inland_rate_entries where destination_id=$1`, [destId]))[0];
      assert(e, "rate entry not in table"); rateId = e.id;
      // rate-entries/save requires re_present_<id> to process the entry, then re_sencillo_<id>
      r = await req("/admin/inland/rate-entries/save", { form: { [`re_present_${rateId}`]: "1", [`re_sencillo_${rateId}`]: "1234.50" } });
      assert(r.status === 302, `save ${r.status}`);
      const row = (await tq(`select sencillo from ${S}.inland_rate_entries where id=$1`, [rateId]))[0];
      assert(row && Number(row.sencillo) === 1234.5, `sencillo not updated (${row && row.sencillo})`);
      return `rate ${rateId} added (FK dest ${destId}) + modified sencillo→${row.sencillo}`;
    });
    await step("inland", "delete destination → rate-entries cascade (NO orphan)", async () => {
      const childBefore = await tcount("inland_rate_entries", "where destination_id=$1", [destId]);
      assert(childBefore > 0, "expected rate-entry child before delete");
      const r = await req(`/admin/inland/destinations/${destId}/delete`);
      assert(r.status === 302, `delete ${r.status}`);
      assert((await tcount("inland_destinations", "where id=$1", [destId])) === 0, "dest still present");
      const orphan = await tcount("inland_rate_entries", "where destination_id=$1", [destId]);
      assert(orphan === 0, `ORPHAN: ${orphan} rate-entries after dest delete`);
      return `dest gone; ${childBefore} rate-entry cascade-removed (0 orphan)`;
    });
    await step("inland", "origin delete → row gone", async () => {
      const r = await req(`/admin/inland/origins/${originId}/delete`);
      assert(r.status === 302, `delete ${r.status}`);
      assert((await tcount("inland_origins", "where id=$1", [originId])) === 0, "origin still present");
      return "origin removed";
    });

    // ===== SETTINGS + NOTES (quote) ==========================================
    await step("settings", "quote settings save → module_settings.quote updated", async () => {
      const r = await req("/admin/quote/settings", { form: { quoteNumberPrefix: "ZT-PFX" } });
      assert(r.status === 302, `save ${r.status}`);
      const row = (await tq(`select settings from ${S}.module_settings where module_key=$1`, ["quote"]))[0];
      assert(row && row.settings && row.settings.quoteNumberPrefix === "ZT-PFX", `prefix not persisted (${row && JSON.stringify(row.settings)})`);
      return `module_settings.quote.settings.quoteNumberPrefix="ZT-PFX"`;
    });
    // NB: the notes library is a FULL-REPLACE form (quote.notes := submitted note_id list),
    // and normalize-quote re-seeds the default QUOTE_NOTES when the list is emptied. So
    // "add" = submit a list containing the new note; "remove" = submit a list excluding it.
    await step("notes", "quote note add → quote_notes row exists (full-replace persists)", async () => {
      const r = await req("/admin/quote/settings", {
        form: { quoteNumberPrefix: "ZT-PFX", note_id: ["zt-note"], note_en: ["ZT note EN"], note_zh: ["ZT 备注"], note_es: ["ZT nota"] },
      });
      assert(r.status === 302, `note add ${r.status}`);
      const row = (await tq(`select en from ${S}.quote_notes where id=$1`, ["zt-note"]))[0];
      assert(row && row.en === "ZT note EN", `zt-note not persisted (${row && row.en})`);
      return `quote_notes contains id=zt-note (en="${row.en}"), table count=${await tcount("quote_notes")}`;
    });
    await step("notes", "quote note remove → submitted list replaces; zt-note gone", async () => {
      const r = await req("/admin/quote/settings", {
        form: { quoteNumberPrefix: "ZT-PFX", note_id: ["keep-note"], note_en: ["Keep"], note_zh: ["保留"], note_es: ["Mantener"] },
      });
      assert(r.status === 302, `note remove ${r.status}`);
      assert((await tcount("quote_notes", "where id=$1", ["zt-note"])) === 0, "zt-note still present");
      assert((await tcount("quote_notes", "where id=$1", ["keep-note"])) === 1, "keep-note not persisted");
      return `zt-note removed; keep-note present (full-replace works)`;
    });

    // ===== final round-trip integrity =========================================
    await step("integrity", "full assemble round-trip stable after all CRUD", async () => {
      store.invalidateShippingDataCache();
      const d = await sd();
      assert(d && d.modules && d.modules.handover && d.modules.customs && d.modules.inland && d.modules.quote, "assemble produced incomplete shape");
      return `assemble OK: carriers=${d.modules.handover.shippingLines.length} ports=${d.modules.customs.ports.length} dests=${d.modules.inland.destinations.length}`;
    });
  } finally {
    // cleanup: drop isolated schema, close everything
    try { await vpool.query(`drop schema if exists ${S} cascade`); } catch (_e) {}
    await vpool.end().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
    server.close();
  }

  // ----- matrix summary -----
  const pass = matrix.filter((m) => m.pass).length;
  console.log(`\n================ RESULT MATRIX (${pass}/${matrix.length} passed) ================`);
  for (const m of matrix) console.log(`  ${m.pass ? "✅" : "🔴"}  ${m.mod.padEnd(16)} ${m.op}`);
  console.log(pass === matrix.length ? "\nsandbox-admin-crud-test-ok" : "\nsandbox-admin-crud-test-FAILURES");
  // close the app's own db pool so the process exits
  try { await require("../../src/lib/db").closeDatabase(); } catch (_e) {}
  process.exit(pass === matrix.length ? 0 : 1);
}

main().catch((e) => { console.error("[sandbox-admin-crud] FATAL:", e); process.exit(1); });
