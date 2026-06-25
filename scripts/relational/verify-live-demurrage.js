// PART C — post-fix LIVE demurrage editability test on prod.
// Proves MSC / WHAN HAI / OOCL now save demurrage cleanly (flash `lineSaved`,
// NOT the partial-save warning), because their rule sets are valid after the
// Phase 2 data fix.
//
//   * WHAN HAI / OOCL: bump one billing tier's rate by $1, save (expect
//     lineSaved + rate changed), then restore the rate (expect lineSaved + rate
//     back). Final state asserted byte-identical to the start (these sets are
//     already canonical — no gaps).
//   * MSC: a clean full-echo resubmit (expect lineSaved). This intentionally
//     re-sequences the *valid* gp-hq-dc set's stale day-18 gap to the canonical
//     [18-∞] (José informed; day 18 → $180). NOT reverted — that canonicalization
//     is the expected, correct outcome. All other MSC sets + charges + terminal
//     mix asserted unchanged.
//
// Full capture → edit → readback → (restore where applicable) with on-disk
// backup. assertProd guards every DB touch. Never writes app_state; never touches
// joyas/punas.
//
//   node scripts/relational/verify-live-demurrage.js

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
const REVERTIBLE = ["whan-hai", "oocl"]; // canonical sets — fully restored
const MSC = "msc"; // gp-hq-dc canonicalizes on save (kept)
const ALL = [...REVERTIBLE, MSC];
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

// rateOverride: { setId, ruleId, rate } to change one demurrage tier's rate.
function buildFullForm(carrier, containerTypes, rateOverride) {
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
  for (const ch of carrier.localCharges || []) {
    f[`charge_concept_${ch.id}`] = ch.concept ?? "";
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
  }
  for (const [gk, rc] of Object.entries(carrier.guarantee?.ratesByGroup || {})) {
    if (rc) {
      f[`guarantee_${gk}_rate`] = String(rc.rate);
      f[`guarantee_${gk}_currency`] = rc.currency || "USD";
    }
  }
  for (const m of carrier.terminalMix || []) {
    f[`terminal_mix_${m.id}_port`] = m.port || "";
    f[`terminal_mix_${m.id}_terminal`] = m.terminal || "";
    f[`terminal_mix_${m.id}_ratio`] = pct(m.ratio);
  }
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
      const overridden =
        rateOverride && rateOverride.setId === set.id && rateOverride.ruleId === r.id;
      f[`${p}_rate`] = String(overridden ? rateOverride.rate : r.rateConfig?.rate ?? 0);
      f[`${p}_currency`] = r.rateConfig?.currency || "USD";
    }
  }
  return f;
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
const flashOf = (html) => (html.match(/flash-success">([^<]*)</) || [])[1] || "";

const carrierKey = (c) => ({ demurrage: c.demurrage, localCharges: c.localCharges, terminalMix: c.terminalMix });
const deepEq = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

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

  const originals = {};
  for (const id of ALL) originals[id] = structuredClone(find(handover, id));
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const json = JSON.stringify(originals, null, 2);
  const sha = crypto.createHash("sha256").update(json).digest("hex");
  const backupFile = path.join(BACKUP_DIR, `live-demurrage-prebackup-${sha.slice(0, 12)}.json`);
  fs.writeFileSync(backupFile, json);
  console.log(`[backup] ${backupFile} sha256=${sha.slice(0, 16)}…`);

  await http(`/admin/handover/shipping-lines/${MSC}`); // session

  try {
    // WHAN HAI / OOCL — real demurrage edit + revert; lineSaved both times.
    for (const id of REVERTIBLE) {
      const c = find(handover, id);
      // first billing tier of the first set
      let target = null;
      for (const set of c.demurrage.ruleSets) {
        const r = (set.rules || []).find((x) => !x.freeRule && Number(x.rateConfig?.rate || 0) > 0);
        if (r) {
          target = { setId: set.id, setName: set.name, ruleId: r.id, rate: Number(r.rateConfig.rate) };
          break;
        }
      }
      assert.ok(target, `${id}: has a billing demurrage tier to edit`);

      // edit +1
      let res = await http(`/admin/handover/shipping-lines/${id}`, {
        form: buildFullForm(c, containerTypes, { setId: target.setId, ruleId: target.ruleId, rate: target.rate + 1 }),
      });
      assert.equal(res.status, 302, `${id}: demurrage edit POST redirects`);
      let flash = flashOf((await http(`/admin/handover/shipping-lines/${id}`)).text);
      assert.ok(!/excepto|未更新/.test(flash) && flash.length, `${id}: flash is lineSaved on demurrage edit (got: ${flash})`);
      let now = find(await read(), id);
      let nowRate = now.demurrage.ruleSets.find((s) => s.id === target.setId).rules.find((r) => r.id === target.ruleId).rateConfig.rate;
      assert.equal(nowRate, target.rate + 1, `${id}: demurrage rate edit landed ($${target.rate}→$${target.rate + 1})`);

      // revert to original rate
      res = await http(`/admin/handover/shipping-lines/${id}`, {
        form: buildFullForm(now, containerTypes, { setId: target.setId, ruleId: target.ruleId, rate: target.rate }),
      });
      assert.equal(res.status, 302, `${id}: revert POST redirects`);
      flash = flashOf((await http(`/admin/handover/shipping-lines/${id}`)).text);
      assert.ok(!/excepto|未更新/.test(flash) && flash.length, `${id}: flash is lineSaved on revert`);

      ok(`${id}: demurrage now editable — "${target.setName}" $${target.rate}→$${target.rate + 1}→$${target.rate}, lineSaved`);
    }

    // MSC — clean resubmit; lineSaved; gp-hq-dc canonicalizes (kept).
    {
      const c = find(handover, MSC);
      const res = await http(`/admin/handover/shipping-lines/${MSC}`, { form: buildFullForm(c, containerTypes, null) });
      assert.equal(res.status, 302, "msc: resubmit redirects");
      const flash = flashOf((await http(`/admin/handover/shipping-lines/${MSC}`)).text);
      assert.ok(!/excepto|未更新/.test(flash) && flash.length, `msc: flash is lineSaved (got: ${flash})`);
      ok(`msc: saves cleanly now — flash "${flash.trim()}"`);
    }
  } finally {
    // Restore WHAN HAI / OOCL exactly (MSC intentionally left canonicalized).
    console.log(`\n[restore] reverting ${REVERTIBLE.join(", ")} to pre-test state (MSC left canonical)…`);
    for (const id of REVERTIBLE) {
      try {
        await store.saveCarrier(structuredClone(originals[id]));
      } catch (e) {
        console.error(`[restore] saveCarrier(${id}) FAILED: ${e.message} — restore from ${backupFile}`);
      }
    }
    await read();
  }

  // Verify final state.
  const back = await read();
  for (const id of REVERTIBLE) {
    assert.ok(deepEq(carrierKey(find(back, id)), carrierKey(originals[id])), `${id}: restored byte-identical`);
  }
  // MSC: gp-hq-dc must now be canonical [.. 18-∞]; other sets + charges + mix unchanged.
  {
    const before = originals[MSC];
    const after = find(back, MSC);
    const gp = after.demurrage.ruleSets.find((s) => s.id === "demurrage-set-gp-hq-dc");
    assert.ok(gp && !gateRejects(gp.rules), "msc gp-hq-dc valid after save");
    const last = gp.rules[gp.rules.length - 1];
    assert.equal(last.endDay, null, "msc gp-hq-dc last tier open-ended");
    assert.equal(last.startDay, 18, "msc gp-hq-dc day-18 gap canonicalized to [18-∞]");
    // every OTHER set unchanged vs original
    const otherBefore = before.demurrage.ruleSets.filter((s) => s.id !== "demurrage-set-gp-hq-dc");
    const otherAfter = after.demurrage.ruleSets.filter((s) => s.id !== "demurrage-set-gp-hq-dc");
    const sig = (sets) => sets.map((s) => ({ id: s.id, rules: s.rules.map((r) => [r.startDay, r.endDay, r.rateConfig?.rate]) }));
    assert.ok(deepEq(sig(otherBefore), sig(otherAfter)), "msc other demurrage sets unchanged");
    assert.ok(deepEq(before.localCharges, after.localCharges), "msc local charges unchanged");
    assert.ok(deepEq(before.terminalMix, after.terminalMix), "msc terminal mix unchanged");
    ok("msc: gp-hq-dc canonicalized to [18-∞] (expected); everything else unchanged");
  }

  console.log(`\nverify-live-demurrage: ${passed}/${ALL.length} carriers proven`);
  console.log("verify-live-demurrage-ok");
  process.exit(0);
}

main().catch((e) => {
  console.error("[verify-live-demurrage] ERROR:", e.message, e.stack);
  process.exit(1);
});
