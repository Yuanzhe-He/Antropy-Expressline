// Concurrency / no-clobber proof (subphase 2b). Demonstrates, against the sandbox:
//   (A) the HAZARD: two stale full-tables saves → the second clobbers the first's
//       edit to a DIFFERENT entity (the blob/full-overwrite clobber class).
//   (B) the FIX: two concurrent per-entity writes (saveCarrierEntity +
//       saveCustomsYardEntity) each touch only their own rows → both survive.
const fs = require("node:fs");
const path = require("node:path");

for (const line of fs.readFileSync(path.join(__dirname, "../../.env.sandbox"), "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0) {
    const k = line.slice(0, i).trim();
    if (k) process.env[k] = line.slice(i + 1).trim();
  }
}
process.env.STORAGE_DRIVER = "postgres";

const { assertSandbox } = require("../sandbox-guard");
const ref = assertSandbox();
const { connectSandbox } = require("./sandbox-env");
const repo = require("../../src/lib/db/relational-repo");
const { decompose } = require("../../src/lib/db/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

let passed = 0;
const assert = (cond, m) => {
  if (!cond) throw new Error("FAIL: " + m);
  passed += 1;
  console.log("  PASS ", m);
};
const findById = (arr, id) => arr.find((x) => x.id === id);

(async () => {
  const { pool: setup, schema } = connectSandbox();
  const seed = normalizeShippingData(
    JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/shipping-lines.json"), "utf8"))
  );

  async function reseed() {
    const c = await setup.connect();
    try {
      await c.query("begin");
      for (const s of repo.buildDropDDL(schema)) await c.query(s);
      for (const s of repo.buildSchemaDDL(schema)) await c.query(s);
      await c.query("commit");
      await c.query("begin");
      await repo.upsertAllTables(c, schema, decompose(seed));
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  async function read() {
    const tables = await repo.readAllTables(setup, schema);
    return normalizeShippingData(require("../../src/lib/db/relational-map").assemble(tables));
  }

  const carrierId = seed.modules.handover.shippingLines[0].id;
  const yardId = seed.modules.customs.yards[0].id;

  // ---- (A) HAZARD: two stale FULL-tables saves clobber each other ----------
  await reseed();
  const db = require("../../src/lib/db");
  const snapA = structuredClone(seed); // A's stale snapshot
  const snapB = structuredClone(seed); // B's stale snapshot (taken before A saved)
  snapA.modules.handover.shippingLines[0].name = "A-EDIT CARRIER";
  snapB.modules.customs.yards[0].note = "B-EDIT YARD";
  await db.saveShippingTables(snapA); // A persists (carrier renamed)
  await db.saveShippingTables(snapB); // B persists from its STALE snapshot → clobbers A
  let after = await read();
  assert(
    findById(after.modules.customs.yards, yardId).note === "B-EDIT YARD",
    "(hazard) B's yard edit landed"
  );
  assert(
    findById(after.modules.handover.shippingLines, carrierId).name !== "A-EDIT CARRIER",
    "(hazard) full-save B CLOBBERED A's carrier edit — the clobber class 2b fixes"
  );

  // ---- (B) FIX: concurrent PER-ENTITY writes do not clobber ----------------
  await reseed();
  const carrier = structuredClone(seed.modules.handover.shippingLines[0]);
  const yard = structuredClone(seed.modules.customs.yards[0]);
  carrier.name = "A-EDIT CARRIER";
  yard.note = "B-EDIT YARD";
  // fired concurrently from independent stale snapshots
  await Promise.all([db.saveCarrierEntity(carrier), db.saveCustomsYardEntity(yard)]);
  after = await read();
  assert(
    findById(after.modules.handover.shippingLines, carrierId).name === "A-EDIT CARRIER",
    "(fix) per-entity: A's carrier edit survived"
  );
  assert(
    findById(after.modules.customs.yards, yardId).note === "B-EDIT YARD",
    "(fix) per-entity: B's yard edit survived — NO clobber"
  );
  // and nothing else moved: the rest equals seed with just those edits. The
  // carrier name derives into the customs mirror name (mirror collapsed into the
  // carrier — Q4), so the expected projection sets both, as the app's rename does.
  const expected = structuredClone(seed);
  expected.modules.handover.shippingLines[0].name = "A-EDIT CARRIER";
  expected.modules.customs.shippingLines[0].name = "A-EDIT CARRIER";
  expected.modules.customs.yards[0].note = "B-EDIT YARD";
  assert(
    repo.canonicalJson(after) === repo.canonicalJson(normalizeShippingData(expected)),
    "(fix) per-entity writes changed ONLY the two target entities (+derived mirror name)"
  );

  await setup.end();
  await db.closeDatabase();
  console.log(`\n[concurrency-test] ref=${ref} — ${passed} assertions PASS ✅`);
})().catch((e) => {
  console.error("[concurrency-test]", e.message);
  process.exit(1);
});
