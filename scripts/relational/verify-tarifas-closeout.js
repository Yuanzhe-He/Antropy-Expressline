// Closeout PART C — doc-by-doc acceptance against the original complaint
// (ERRORES PAGINA TARIFAS v2). For MSC / WHAN HAI / OOCL, proves the page now
// SAVES every category that was being discarded: naviera header, terminal mix
// (PROBABILIDAD TERMINAL), cargos locales / conceptos — all in one reversible
// edit that flashes `lineSaved` (which also proves demoras now validates, since
// a single invalid set would force the partial-save warning instead).
//
// Cache-safe by design: BOTH the edit and the restore go through the live app
// (two POSTs), so the app's in-process cache ends consistent with the DB (the
// earlier clobber came from restoring via a direct DB write that left the app
// cache stale). Leaves no test changes — every marker is restored and verified
// byte-identical. (Demoras editability itself was already proven reversibly in
// verify-live-demurrage; here the lineSaved flash reconfirms demoras validates.)
//
//   node scripts/relational/verify-tarifas-closeout.js

const assert = require("node:assert/strict");

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.SKIP_FX_REFRESH = "1";

const { loadLocalEnv } = require("../../src/lib/env");
const { assertProd } = require("./prod-guard");
const store = require("../../src/lib/store");

const PROD_URL = "https://antropy-expressline-production.up.railway.app";
const CARRIERS = ["msc", "whan-hai", "oocl"];
const TAG = "ZZ-CLOSEOUT";
const pct = (r) => String(Math.round((r || 0) * 10000) / 100);

// markers: { rfc, conceptId, conceptVal, mixId, mixVal } to apply edits.
function buildFullForm(carrier, containerTypes, markers) {
  const f = {};
  f.line_name = carrier.name || "";
  f.line_code = carrier.notes?.code ?? "";
  f.line_rfc = markers?.rfc != null ? markers.rfc : carrier.notes?.rfc ?? "";
  if (carrier.invoiceToConsigneeOnly) f.invoiceToConsigneeOnly = "on";
  f.invoiceNote = carrier.invoiceNote ?? "";
  f.demurrageCutoffHandledBy = carrier.demurrageCutoffHandledBy ?? "";
  if (carrier.guarantee?.benefitEnabled) f.benefitEnabled = "on";
  f.benefitExpiresAt = carrier.guarantee?.benefitExpiresAt ?? "";
  f.benefitNote = carrier.guarantee?.benefitNote ?? "";
  f.guaranteeTaxRate = String(carrier.guarantee?.taxRate ?? 0);
  for (const ch of carrier.localCharges || []) {
    const concept =
      markers && markers.conceptId === ch.id ? markers.conceptVal : ch.concept;
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
  }
  for (const [gk, rc] of Object.entries(carrier.guarantee?.ratesByGroup || {})) {
    if (rc) {
      f[`guarantee_${gk}_rate`] = String(rc.rate);
      f[`guarantee_${gk}_currency`] = rc.currency || "USD";
    }
  }
  for (const m of carrier.terminalMix || []) {
    f[`terminal_mix_${m.id}_port`] = m.port || "";
    f[`terminal_mix_${m.id}_terminal`] =
      markers && markers.mixId === m.id ? markers.mixVal : m.terminal || "";
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
      f[`${p}_rate`] = String(r.rateConfig?.rate ?? 0);
      f[`${p}_currency`] = r.rateConfig?.currency || "USD";
    }
  }
  return f;
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  store(h) {
    const set =
      typeof h.getSetCookie === "function"
        ? h.getSetCookie()
        : h.get("set-cookie")
          ? h.get("set-cookie").split(/,(?=[^;]+?=)/)
          : [];
    for (const c of set) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      if (i > 0) this.cookies.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}
const jar = new CookieJar();
async function http(urlPath, form) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
  let body, method = "GET";
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
const flashOf = (h) => (h.match(/flash-success">([^<]*)</) || [])[1] || "";
// Canonical projection of the MEANINGFUL fields (stable order; ignores recomputed
// derived bookkeeping like freeDays.daysByGroup key order) — so "restored" means
// the rules/charges/mix/header a human cares about are byte-identical.
const key = (c) =>
  JSON.stringify({
    rfc: c.notes?.rfc ?? null,
    code: c.notes?.code ?? null,
    charges: (c.localCharges || []).map((x) => [x.id, x.concept, x.taxRate, x.blRate?.rate ?? null, x.blRate?.currency ?? null]),
    mix: (c.terminalMix || []).map((m) => [m.id, m.port, m.terminal, m.ratio]),
    sets: (c.demurrage?.ruleSets || []).map((s) => [s.id, s.rules.map((r) => [r.id, r.startDay, r.endDay, r.freeRule, r.rateConfig?.rate ?? null, r.rateConfig?.currency ?? null])]),
  });

let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS ", m); };

async function main() {
  loadLocalEnv();
  assertProd(process.env.DATABASE_URL);
  const read = async () => {
    store.invalidateShippingDataCache();
    return (await store.getShippingData()).modules.handover;
  };
  const h0 = await read();
  const containerTypes = h0.containerTypes;
  const find = (h, id) => h.shippingLines.find((l) => l.id === id);

  await http(`/admin/handover/shipping-lines/${CARRIERS[0]}`); // session

  for (const id of CARRIERS) {
    const before = structuredClone(find(await read(), id));
    const ch0 = (before.localCharges || [])[0];
    const mx0 = (before.terminalMix || [])[0];
    assert.ok(ch0 && mx0, `${id}: has a local charge + terminal mix to edit`);

    const markers = {
      rfc: `${before.notes?.rfc || ""}${TAG}`.slice(0, 60),
      conceptId: ch0.id,
      conceptVal: `${ch0.concept || "Charge"} ${TAG}`,
      mixId: mx0.id,
      mixVal: `${mx0.terminal || "T"} ${TAG}`,
    };

    // EDIT via the app — header(rfc) + cargos/conceptos + terminalMix at once.
    let res = await http(`/admin/handover/shipping-lines/${id}`, buildFullForm(before, containerTypes, markers));
    assert.equal(res.status, 302, `${id}: edit POST redirects`);
    const flash = flashOf((await http(`/admin/handover/shipping-lines/${id}`)).text);
    assert.ok(!/excepto|未更新/.test(flash) && flash.length, `${id}: flash is lineSaved (demoras validates) — got "${flash}"`);

    const mid = find(await read(), id);
    assert.ok(String(mid.notes?.rfc || "").includes(TAG), `${id}: naviera header (RFC) saved`);
    assert.ok(mid.localCharges.find((c) => c.id === ch0.id).concept.includes(TAG), `${id}: cargos locales / conceptos saved`);
    assert.ok(mid.terminalMix.find((m) => m.id === mx0.id).terminal.includes(TAG), `${id}: terminal mix (PROBABILIDAD TERMINAL) saved`);

    // RESTORE via the app (keeps app cache consistent with DB).
    res = await http(`/admin/handover/shipping-lines/${id}`, buildFullForm(before, containerTypes, null));
    assert.equal(res.status, 302, `${id}: restore POST redirects`);
    const after = find(await read(), id);
    assert.ok(key(after) === key(before), `${id}: restored byte-identical (no test residue)`);
    ok(`${id}: header + terminalMix + cargos/conceptos all SAVE (lineSaved); restored clean`);
  }

  console.log(`\nverify-tarifas-closeout: ${passed}/${CARRIERS.length} carriers — every complained category now saves`);
  console.log("verify-tarifas-closeout-ok");
  process.exit(0);
}

main().catch((e) => { console.error("[verify-tarifas-closeout] ERROR:", e.message, e.stack); process.exit(1); });
