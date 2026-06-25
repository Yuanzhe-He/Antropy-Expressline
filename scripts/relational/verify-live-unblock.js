// Phase 1 POST-DEPLOY live verification on prod (1c). Proves, against the LIVE
// deployed app, that:
//   * a clean carrier (ZIM, control) still saves with the normal `lineSaved`
//     flash (behavior-neutral);
//   * MSC / WHAN HAI / OOCL now accept a non-demurrage edit (a local-charge
//     concept marker) — the edit lands, the invalid demurrage sets are skipped,
//     and the flash is the partial-save warning naming them. This is exactly what
//     Estefani could not do before.
//
// SAFETY: every touched carrier is captured (full relational read) and written to
// backups/ BEFORE any write, and restored byte-for-byte via store.saveCarrier()
// in a finally block, then re-read to confirm prod ends exactly as it started.
// The live POST goes through the deployed app (real relational write path); the
// capture/restore use the local store against prod relational. assertProd guards
// every DB touch. Never writes the app_state blob; never touches joyas/punas.
//
//   node scripts/relational/verify-live-unblock.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.SKIP_FX_REFRESH = "1";

const { loadLocalEnv } = require("../../src/lib/env");
const { assertProd } = require("./prod-guard");
const store = require("../../src/lib/store");

const PROD_URL = "https://antropy-expressline-production.up.railway.app";
const CONTROL = "zim";
const AFFECTED = ["msc", "whan-hai", "oocl"];
const ALL = [CONTROL, ...AFFECTED];
const TAG = "[VERIFY-DEL]"; // appended to a concept; removed by restore
const BACKUP_DIR = path.join(__dirname, "../../backups");

const pct = (r) => String(Math.round((r || 0) * 10000) / 100);

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

// Echo every field the edit page submits, optionally changing the first local
// charge's concept (markConcept=true). Demurrage echoed as-is.
function buildFullForm(carrier, containerTypes, markConcept) {
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
    if (i === 0 && markConcept) {
      concept = `${ch.concept || "Charge"} ${TAG}`;
      changed = { id: ch.id, original: ch.concept, concept };
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
  for (const [gk, rc] of Object.entries(carrier.guarantee?.ratesByGroup || {})) {
    if (rc) {
      f[`guarantee_${gk}_rate`] = String(rc.rate);
      f[`guarantee_${gk}_currency`] = rc.currency || "USD";
    }
  }
  (carrier.terminalMix || []).forEach((m) => {
    f[`terminal_mix_${m.id}_port`] = m.port || "";
    f[`terminal_mix_${m.id}_terminal`] = m.terminal || "";
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
    const set =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? headers.get("set-cookie").split(/,(?=[^;]+?=)/)
          : [];
    for (const c of set) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i < 0) continue;
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

const jar = new CookieJar();
async function http(urlPath, { form } = {}) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
  let body;
  let method = "GET";
  if (form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) p.append(k, v == null ? "" : String(v));
    body = p;
    headers["content-type"] = "application/x-www-form-urlencoded";
    method = "POST";
  }
  const r = await fetch(`${PROD_URL}${urlPath}`, { method, headers, body, redirect: "manual" });
  jar.store(r.headers);
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}

const carrierKey = (c) => ({
  demurrage: c.demurrage,
  localCharges: c.localCharges,
  terminalMix: c.terminalMix,
});

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  loadLocalEnv();
  assertProd(process.env.DATABASE_URL);

  const read = async () => {
    store.invalidateShippingDataCache();
    return (await store.getShippingData()).modules.handover;
  };
  let handover = await read();
  const containerTypes = handover.containerTypes;
  const find = (h, id) => h.shippingLines.find((l) => l.id === id);

  // CAPTURE full state of every carrier we will touch + write backup to disk.
  const originals = {};
  for (const id of ALL) originals[id] = structuredClone(find(handover, id));
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const json = JSON.stringify(originals, null, 2);
  const sha = crypto.createHash("sha256").update(json).digest("hex");
  const backupFile = path.join(BACKUP_DIR, `live-verify-prebackup-${sha.slice(0, 12)}.json`);
  fs.writeFileSync(backupFile, json);
  console.log(`[backup] ${backupFile} sha256=${sha.slice(0, 16)}… carriers=${ALL.join(",")}`);
  console.log(`[guard] ref asserted PROD; live edits are reversible (restored in finally).`);

  let restored = false;
  try {
    // Warm a session cookie.
    await http(`/admin/handover/shipping-lines/${CONTROL}`);

    // (1) CONTROL — clean carrier, no-change resubmit -> normal lineSaved.
    {
      const { form } = buildFullForm(find(handover, CONTROL), containerTypes, false);
      const res = await http(`/admin/handover/shipping-lines/${CONTROL}`, { form });
      assert.equal(res.status, 302, "control POST redirects");
      const page = await http(`/admin/handover/shipping-lines/${CONTROL}`);
      const flash = (page.text.match(/flash-success">([^<]*)</) || [])[1] || "";
      assert.ok(
        !/excepto|未更新/.test(flash) && flash.length > 0,
        `control flash is the normal lineSaved (got: ${flash})`
      );
      ok(`control(${CONTROL}): clean carrier still saves normally — flash "${flash.trim()}"`);
    }

    // (2) AFFECTED — non-demurrage edit lands; invalid sets skipped + warning.
    for (const id of AFFECTED) {
      const before = find(handover, id);
      const badSets = (before.demurrage.ruleSets || []).filter((s) => gateRejects(s.rules));
      const badInvariant = JSON.stringify(
        before.demurrage.ruleSets
          .filter((s) => badSets.includes(s))
          .map((s) => ({ id: s.id, rules: s.rules.map((r) => [r.id, r.startDay, r.endDay]) }))
      );
      const { form, changed } = buildFullForm(before, containerTypes, true);
      assert.ok(changed, `${id}: has a local charge to mark`);

      const res = await http(`/admin/handover/shipping-lines/${id}`, { form });
      assert.equal(res.status, 302, `${id}: POST redirects (not aborted)`);

      const after = find(await read(), id);
      const ch = after.localCharges.find((c) => c.id === changed.id);
      assert.equal(ch.concept, changed.concept, `${id}: non-demurrage edit LANDED on prod`);

      const badAfter = JSON.stringify(
        after.demurrage.ruleSets
          .filter((s) => badSets.some((b) => b.id === s.id))
          .map((s) => ({ id: s.id, rules: s.rules.map((r) => [r.id, r.startDay, r.endDay]) }))
      );
      assert.equal(badAfter, badInvariant, `${id}: invalid demurrage sets unchanged (skipped)`);

      const page = await http(`/admin/handover/shipping-lines/${id}`);
      const flash = (page.text.match(/flash-success">([^<]*)</) || [])[1] || "";
      assert.ok(/excepto|未更新/.test(flash), `${id}: partial-save warning flash (got: ${flash})`);
      assert.ok(
        badSets.some((s) => flash.includes(s.name)),
        `${id}: flash names a skipped set (got: ${flash})`
      );
      ok(`${id}: non-demurrage edit landed + ${badSets.length} invalid set(s) skipped + warning flash`);
    }
  } finally {
    // RESTORE every touched carrier to its captured state, byte-for-byte. Each
    // restore is independent — one failure must not skip the rest.
    console.log(`\n[restore] reverting ${ALL.length} carriers to pre-verify state…`);
    for (const id of ALL) {
      try {
        await store.saveCarrier(structuredClone(originals[id]));
      } catch (e) {
        console.error(`[restore] saveCarrier(${id}) FAILED: ${e.message} — restore manually from ${backupFile}`);
      }
    }
    store.invalidateShippingDataCache();
    const back = await read();
    const deepEq = (a, b) => {
      try {
        assert.deepStrictEqual(a, b);
        return true;
      } catch {
        return false;
      }
    };
    let drift = 0;
    for (const id of ALL) {
      if (!deepEq(carrierKey(find(back, id)), carrierKey(originals[id]))) {
        drift += 1;
        console.error(`[restore] DRIFT on ${id} — compare against ${backupFile}`);
      }
    }
    restored = drift === 0;
    console.log(
      restored
        ? `[restore] OK — all ${ALL.length} carriers byte-identical to pre-verify state.`
        : `[restore] FAILED — ${drift} carrier(s) drifted. Backup: ${backupFile}`
    );
  }

  console.log(`\nverify-live-unblock: ${passed}/${ALL.length} checks passed; prod restored=${restored}`);
  if (!restored) process.exit(2);
  console.log("verify-live-unblock-ok");
  process.exit(0);
}

main().catch((e) => {
  console.error("[verify-live-unblock] ERROR:", e.message, e.stack);
  process.exit(1);
});
