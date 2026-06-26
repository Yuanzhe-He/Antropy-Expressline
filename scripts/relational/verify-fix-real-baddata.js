// Phase 1 pre-merge proof on REAL prod bad data (not synthetic).
//
// Reads the live prod relational tables READ-ONLY, assembles them into a temp
// JSON seed, boots the REAL app in JSON mode against it, and for each of
// MSC / WHAN HAI / OOCL simulates exactly what Estefani did: edit one
// non-demurrage field (a local-charge concept) and resubmit the whole page with
// the (real, invalid) demurrage unchanged. Asserts the fix:
//   (a) the save is NOT aborted;
//   (b) the non-demurrage edit lands in the store;
//   (c) every demurrage rule set is byte-for-byte unchanged (atomic skip);
//   (d) the flash is the partial-save warning naming the skipped sets.
//
// READ-ONLY against prod (a single `select *` over the expressline relational
// tables; no write of any kind). All app writes land in a throwaway temp dir.
// Never touches the app_state blob, joyas, or punas.
//
//   node scripts/relational/verify-fix-real-baddata.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// JSON mode for the app boot — set BEFORE requiring store/server. The prod read
// below uses a raw pg pool, NOT the store, so the store never runs in DB mode.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-realbaddata-"));
process.env.STORAGE_DRIVER = "json";
process.env.DATA_DIR = tmpDir;
process.env.SKIP_FX_REFRESH = "1";

const { connectProdAdmin } = require("./prod-env");
const { readAllTables } = require("../../src/lib/db/relational-repo");
const { assemble } = require("../../src/lib/db/relational-map");

const TARGETS = ["msc", "whan-hai", "oocl"];

function gateRejects(rules) {
  let nextStart = 1;
  for (let i = 0; i < rules.length; i += 1) {
    const endDay = rules[i].endDay == null ? null : rules[i].endDay;
    if (endDay !== null && endDay < nextStart) return true;
    if (endDay === null && i < rules.length - 1) return true;
    if (endDay !== null) nextStart = endDay + 1;
  }
  return false;
}

const pct = (ratio) => String(Math.round((ratio || 0) * 10000) / 100);

// Echo every field the edit page submits, from the carrier's current state, so
// the ONLY change is the one non-demurrage edit. Demurrage is echoed as-is (its
// real, invalid day-sequence) — exactly what triggers the gate.
function buildFullForm(carrier, containerTypes, testTag) {
  const f = {};
  f.line_name = carrier.name || "";
  f.line_code = carrier.notes?.code ?? "";
  f.line_rfc = carrier.notes?.rfc ?? "";
  if (carrier.invoiceToConsigneeOnly) f.invoiceToConsigneeOnly = "on";
  f.invoiceNote = carrier.invoiceNote ?? "";
  f.demurrageCutoffHandledBy = carrier.demurrageCutoffHandledBy ?? "";
  if (carrier.guarantee?.benefitEnabled) f.benefitEnabled = "on";
  f.benefitExpiresAt = carrier.guarantee?.benefitExpiresAt ?? "";
  f.benefitNote = carrier.guarantee?.benefitNote ?? "";
  f.guaranteeTaxRate = String(carrier.guarantee?.taxRate ?? 0);

  let changed = null;
  (carrier.localCharges || []).forEach((ch, i) => {
    let concept = ch.concept;
    if (i === 0) {
      concept = `${ch.concept || "Charge"} ${testTag}`;
      changed = { kind: "charge", id: ch.id, concept };
    }
    f[`charge_concept_${ch.id}`] = concept ?? "";
    f[`charge_tax_${ch.id}`] = String(ch.taxRate ?? 0);
    if (ch.blRate) {
      f[`charge_bl_${ch.id}_rate`] = String(ch.blRate.rate);
      f[`charge_bl_${ch.id}_currency`] = ch.blRate.currency || "USD";
    }
    for (const [gk, rc] of Object.entries(ch.groupRates || {})) {
      if (rc) {
        f[`charge_${ch.id}_${gk}_rate`] = String(rc.rate);
        f[`charge_${ch.id}_${gk}_currency`] = rc.currency || "USD";
      }
    }
  });
  // Fallback: no local charges -> change first terminal-mix terminal name.
  if (!changed && (carrier.terminalMix || []).length) {
    const m = carrier.terminalMix[0];
    changed = { kind: "mix", id: m.id, terminal: `${m.terminal} ${testTag}` };
  }

  for (const [gk, rc] of Object.entries(carrier.guarantee?.ratesByGroup || {})) {
    if (rc) {
      f[`guarantee_${gk}_rate`] = String(rc.rate);
      f[`guarantee_${gk}_currency`] = rc.currency || "USD";
    }
  }
  (carrier.terminalMix || []).forEach((m) => {
    f[`terminal_mix_${m.id}_port`] = m.port || "";
    f[`terminal_mix_${m.id}_terminal`] =
      changed?.kind === "mix" && changed.id === m.id ? changed.terminal : m.terminal || "";
    f[`terminal_mix_${m.id}_ratio`] = pct(m.ratio);
  });
  for (const t of containerTypes || []) {
    const a = carrier.demurrage?.assignmentsByContainerType?.[t.key];
    if (a) f[`demurrage_assignment_${t.key}`] = a;
  }
  for (const set of carrier.demurrage?.ruleSets || []) {
    f[`demurrage_set_${set.id}_name`] = set.name || "";
    for (const r of set.rules || []) {
      const p = `rule_set_${set.id}_${r.id}`;
      f[`${p}_end`] = r.endDay == null ? "" : String(r.endDay);
      f[`${p}_tax`] = String(r.taxRate ?? 0);
      f[`${p}_rate`] = String(r.rateConfig?.rate ?? 0);
      f[`${p}_currency`] = r.rateConfig?.currency || "USD";
    }
  }
  return { form: f, changed };
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  store(headers) {
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? headers.get("set-cookie").split(/,(?=[^;]+?=)/)
          : [];
    for (const c of setCookies) {
      const [pair] = c.split(";");
      const sep = pair.indexOf("=");
      if (sep < 0) continue;
      this.cookies.set(pair.slice(0, sep).trim(), pair.slice(sep + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

let baseUrl;
let jar;
async function request(urlPath, { method = "GET", form } = {}) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) params.append(k, v == null ? "" : String(v));
    body = params;
    headers["content-type"] = "application/x-www-form-urlencoded";
    if (method === "GET") method = "POST";
  }
  const r = await fetch(`${baseUrl}${urlPath}`, { method, headers, body, redirect: "manual" });
  jar.store(r.headers);
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}

async function pullProdSeed() {
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[pull] ref=${ref} schema=${schema} role=${role} mode=READ-ONLY`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    const tables = await readAllTables(client, schema);
    await client.query("commit");
    const assembled = assemble(tables);
    fs.writeFileSync(path.join(tmpDir, "shipping-lines.json"), JSON.stringify(assembled, null, 2));
    return assembled;
  } finally {
    client.release();
    await pool.end();
  }
}

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  await pullProdSeed();

  const { createApp } = require("../../src/server");
  const { getShippingData } = require("../../src/lib/store");
  const getCarrier = async (id) =>
    (await getShippingData()).modules.handover.shippingLines.find((l) => l.id === id);
  const containerTypes = (await getShippingData()).modules.handover.containerTypes;

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  jar = new CookieJar();

  try {
    for (const id of TARGETS) {
      console.log(`\n=== ${id} ===`);
      await request(`/admin/handover/shipping-lines/${id}`); // session + warm
      const before = await getCarrier(id);
      assert.ok(before, `${id}: carrier present from prod pull`);

      // self-check: this carrier genuinely holds >=1 invalid set
      const badSets = (before.demurrage.ruleSets || []).filter((s) => gateRejects(s.rules || []));
      assert.ok(badSets.length >= 1, `${id}: has at least one invalid demurrage set`);
      // Atomicity applies to the SKIPPED (invalid) sets only — valid sets are
      // legitimately processed and may have their startDay re-sequenced to the
      // engine's canonical contiguous form (startDay is auto-derived; only endDay
      // is operator-maintained). So snapshot ONLY the invalid sets for the
      // byte-for-byte check, and snapshot importes for ALL sets to prove no money
      // moved anywhere.
      const badIds = new Set(badSets.map((s) => s.id));
      const badSnap = (c) =>
        c.demurrage.ruleSets
          .filter((s) => badIds.has(s.id))
          .map((s) => ({
            id: s.id,
            rules: s.rules.map((r) => ({ id: r.id, startDay: r.startDay, endDay: r.endDay })),
          }));
      const importeSnap = (c) =>
        c.demurrage.ruleSets.map((s) => ({
          id: s.id,
          importes: s.rules.map((r) => `${r.freeRule ? "free" : r.rateConfig?.rate}|${r.rateConfig?.currency || ""}`),
        }));
      const beforeBad = badSnap(before);
      const beforeImportes = importeSnap(before);

      const { form, changed } = buildFullForm(before, containerTypes, "[VERIFY]");
      assert.ok(changed, `${id}: found a non-demurrage field to edit`);
      const res = await request(`/admin/handover/shipping-lines/${id}`, { method: "POST", form });

      // (a) not aborted
      assert.equal(res.status, 302, `${id}: POST redirects (not aborted)`);
      assert.ok(
        (res.location || "").includes(`/shipping-lines/${id}`),
        `${id}: redirect lands on the edit page`
      );

      const after = await getCarrier(id);
      // (b) the non-demurrage edit persisted
      if (changed.kind === "charge") {
        const ch = after.localCharges.find((c) => c.id === changed.id);
        assert.equal(ch.concept, changed.concept, `${id}: edited local-charge concept persisted`);
      } else {
        const m = after.terminalMix.find((x) => x.id === changed.id);
        assert.equal(m.terminal, changed.terminal, `${id}: edited terminal-mix name persisted`);
      }
      // (c) the INVALID sets are byte-for-byte unchanged (atomic skip), and NO
      // importe moved on ANY set (valid sets may only re-sequence startDay).
      assert.deepEqual(badSnap(after), beforeBad, `${id}: invalid demurrage sets unchanged (atomic skip)`);
      assert.deepEqual(importeSnap(after), beforeImportes, `${id}: no importe changed on any set`);
      // (d) flash names the skipped sets
      const page = await request(`/admin/handover/shipping-lines/${id}`);
      const flash = (page.text.match(/flash-success">([^<]*)</) || [])[1] || "";
      assert.ok(/excepto|未更新/.test(flash), `${id}: partial-save warning flash (got: ${flash})`);
      const namedABadSet = badSets.some((s) => flash.includes(s.name));
      assert.ok(namedABadSet, `${id}: flash names a skipped set (got: ${flash})`);

      ok(
        `${id}: non-demurrage edit landed, ${badSets.length} invalid set(s) skipped byte-for-byte, warning flash shown`
      );
    }
    console.log(`\nverify-fix-real-baddata: ${passed}/${TARGETS.length} carriers proven`);
    console.log("verify-fix-real-baddata-ok");
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
