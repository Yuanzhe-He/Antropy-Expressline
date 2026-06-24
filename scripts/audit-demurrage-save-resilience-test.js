// Regression net for the "PAGINA TARIFAS no guarda" production bug (2026-06-24).
//
// Legacy carriers (MSC / WHAN HAI / OOCL) held demurrage rule sets whose stored
// day-sequence violates the sequential invariant (a mid-position open-ended rule,
// or a billing tier that restarts day counting after a free tier). The big
// per-line edit handler validated EVERY rule set before its single saveModule()
// call; any invalid set made it redirect with an error BEFORE the save, silently
// discarding every other edit on the page (local charges, terminal mix,
// conceptos, header) — the operator saw "nothing saves".
//
// This suite boots the real app over HTTP in JSON mode against an isolated temp
// DATA_DIR, seeds a carrier carrying BOTH bad shapes plus one editable local
// charge and one terminal-mix row, then POSTs the big edit handler and asserts:
//   (a) the save is NOT aborted (the request still persists);
//   (b) the local-charge + terminal-mix edits landed in the store;
//   (c) both invalid rule sets are kept at their stored state (skipped, not lost);
//   (d) the flash warning names the skipped sets;
//   (e) ATOMICITY — the skipped sets are not left half-mutated (every rule's
//       startDay/endDay is byte-identical to the pre-edit state).
//
// Wired into `npm run test:all` (run-all-tests picks up every *-test.js).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";
// Long cache TTL is irrelevant in JSON mode (reads always re-read the file), but
// set DATA_DIR BEFORE requiring the store/server so all reads+writes are isolated
// to the temp dir and never touch the repo's data/ or production.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-demoras-resil-"));
process.env.DATA_DIR = tmpDir;

const CARRIER_ID = "zt-resilience";
const OPEN_SET = "zt-set-open"; // bad shape A: mid-position open-ended rule
const REL_SET = "zt-set-rel"; // bad shape B: billing tier restarts after free tier

// Seed a shipping-lines.json into the temp DATA_DIR: the bundled seed with one
// carrier rewritten to carry both invalid demurrage shapes + a single editable
// local charge and terminal-mix row (single rows so the form body is explicit and
// no unrelated rate cell gets cleared by an incomplete submit).
function seedTempStore() {
  const seed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../data/shipping-lines.json"), "utf8")
  );
  const handover = seed.modules.handover;
  const base = structuredClone(handover.shippingLines[0]);

  base.id = CARRIER_ID;
  base.name = "ZT Resilience";
  base.notes = { code: null, rfc: null };
  base.localCharges = [
    {
      id: "ztc-1",
      concept: "ZT Doc Fee",
      note: null,
      taxRate: 0,
      groupRates: {},
      blRate: { qtyHint: 1, currency: "USD", rate: 45 },
    },
  ];
  base.terminalMix = [
    { id: "ztm-1", port: "MANZANILLO", terminal: "CONTECON", ratio: 0.5 },
  ];
  base.guarantee = {
    benefitEnabled: false,
    benefitExpiresAt: null,
    benefitNote: null,
    taxRate: 0,
    ratesByGroup: {},
  };
  base.demurrage = {
    calculationMode: base.demurrage?.calculationMode || "progressive",
    freeDays: { defaultDays: 0, daysByGroup: {} },
    rulesByGroup: {},
    assignmentsByContainerType: {},
    ruleSets: [
      {
        id: OPEN_SET,
        name: "ZT Open Tier",
        sourceGroupKey: null,
        rules: [
          mkRule("zo0", 1, 5, true, 0),
          mkRule("zo1", 6, null, false, 200), // open-ended but NOT last -> reject
          mkRule("zo2", 8, 14, false, 200),
        ],
      },
      {
        id: REL_SET,
        name: "ZT Relative Tier",
        sourceGroupKey: null,
        rules: [
          mkRule("zr0", 1, 7, true, 0), // free 0-7
          mkRule("zr1", 8, 3, false, 140), // end 3 < running nextStart 8 -> reject
          mkRule("zr2", 9, null, false, 155),
        ],
      },
    ],
  };

  handover.shippingLines = [base, ...handover.shippingLines.slice(1)];
  fs.writeFileSync(
    path.join(tmpDir, "shipping-lines.json"),
    JSON.stringify(seed, null, 2)
  );
}

function mkRule(id, startDay, endDay, freeRule, rate) {
  return {
    id,
    label: "",
    note: null,
    startDay,
    endDay,
    freeRule,
    taxRate: 0,
    rateConfig: { label: "", qtyHint: 1, currency: "USD", rate },
  };
}

// Mirror of applySequentialRuleUpdates' validation on an unchanged resubmit (the
// form pre-fills each end input from rule.endDay). Pure read; mutates nothing.
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

// Build the demurrage portion of the form body exactly as the edit page would on
// an UNCHANGED resubmit: every rule's end/tax/rate/currency echoed from its
// current (bad) stored values, which is what triggers the validation gate.
function demurrageFormFields(carrier) {
  const form = {};
  for (const set of carrier.demurrage.ruleSets) {
    form[`demurrage_set_${set.id}_name`] = set.name;
    for (const rule of set.rules) {
      const p = `rule_set_${set.id}_${rule.id}`;
      form[`${p}_end`] = rule.endDay == null ? "" : String(rule.endDay);
      form[`${p}_tax`] = String(rule.taxRate ?? 0);
      form[`${p}_rate`] = String(rule.rateConfig?.rate ?? 0);
      form[`${p}_currency`] = rule.rateConfig?.currency || "USD";
    }
  }
  return form;
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
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
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
    for (const [k, v] of Object.entries(form))
      params.append(k, v == null ? "" : String(v));
    body = params;
    headers["content-type"] = "application/x-www-form-urlencoded";
    if (method === "GET") method = "POST";
  }
  const r = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  jar.store(r.headers);
  const text = await r.text();
  return { status: r.status, location: r.headers.get("location"), text };
}

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  seedTempStore();

  const { createApp } = require("../src/server");
  const { getShippingData } = require("../src/lib/store");
  const findCarrier = async () =>
    (await getShippingData()).modules.handover.shippingLines.find(
      (l) => l.id === CARRIER_ID
    );

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  jar = new CookieJar();

  try {
    // Establish a session + confirm the seed survived normalization with BOTH
    // sets still invalid (self-check: the test is meaningless otherwise).
    await request(`/admin/handover/shipping-lines/${CARRIER_ID}`);
    const before = await findCarrier();
    assert.ok(before, "seeded test carrier is present");
    const openBefore = before.demurrage.ruleSets.find((s) => s.id === OPEN_SET);
    const relBefore = before.demurrage.ruleSets.find((s) => s.id === REL_SET);
    assert.ok(
      gateRejects(openBefore.rules),
      "pre-edit: open-ended-mid set is rejected by the gate"
    );
    assert.ok(
      gateRejects(relBefore.rules),
      "pre-edit: relative-restart set is rejected by the gate"
    );
    const snap = (rules) =>
      rules.map((r) => ({ id: r.id, startDay: r.startDay, endDay: r.endDay }));
    const openSnap = snap(openBefore.rules);
    const relSnap = snap(relBefore.rules);
    ok("seed: both invalid demurrage sets survive normalization (gate rejects)");

    // Operator edits a local charge + a terminal-mix row and saves; the demurrage
    // fields are resubmitted unchanged (and are invalid).
    const form = {
      line_name: before.name,
      "charge_concept_ztc-1": "ZT NUEVO CONCEPTO",
      "charge_tax_ztc-1": "0",
      "charge_bl_ztc-1_rate": "77",
      "charge_bl_ztc-1_currency": "USD",
      "terminal_mix_ztm-1_port": "MANZANILLO",
      "terminal_mix_ztm-1_terminal": "ZT TERMINAL",
      "terminal_mix_ztm-1_ratio": "60",
      ...demurrageFormFields(before),
    };
    const res = await request(
      `/admin/handover/shipping-lines/${CARRIER_ID}`,
      { method: "POST", form }
    );

    // (a) the save was NOT aborted — it redirected back to the edit page (302).
    assert.equal(res.status, 302, "edit POST redirects (not aborted)");
    assert.ok(
      (res.location || "").includes(`/shipping-lines/${CARRIER_ID}`),
      "redirect lands back on the carrier edit page"
    );
    ok("(a) save is not aborted by the invalid demurrage sets");

    const after = await findCarrier();

    // (b) the non-demurrage edits persisted.
    const charge = after.localCharges.find((c) => c.id === "ztc-1");
    assert.equal(charge.concept, "ZT NUEVO CONCEPTO", "local charge concept saved");
    assert.equal(charge.blRate.rate, 77, "local charge BL rate saved");
    const mix = after.terminalMix.find((m) => m.id === "ztm-1");
    assert.equal(mix.terminal, "ZT TERMINAL", "terminal-mix terminal saved");
    ok("(b) local-charge + terminal-mix edits landed in the store");

    // (c)+(e) both invalid sets are kept, and ATOMICALLY unchanged (no rule left
    // half-mutated — startDay/endDay byte-identical to the pre-edit snapshot).
    const openAfter = after.demurrage.ruleSets.find((s) => s.id === OPEN_SET);
    const relAfter = after.demurrage.ruleSets.find((s) => s.id === REL_SET);
    assert.ok(openAfter && relAfter, "both invalid sets still present (not lost)");
    assert.deepEqual(
      snap(openAfter.rules),
      openSnap,
      "open-ended-mid set rules unchanged (atomic skip)"
    );
    assert.deepEqual(
      snap(relAfter.rules),
      relSnap,
      "relative-restart set rules unchanged (atomic skip)"
    );
    ok("(c)+(e) invalid sets kept byte-for-byte (atomic skip, no half-update)");

    // (d) the flash warning names the skipped sets.
    const page = await request(`/admin/handover/shipping-lines/${CARRIER_ID}`);
    const flashMatch = page.text.match(/flash-success">([^<]*)</);
    assert.ok(flashMatch, "a success flash is rendered");
    const flash = flashMatch[1];
    assert.ok(
      /excepto|未更新/.test(flash),
      `flash carries the partial-save warning (got: ${flash})`
    );
    assert.ok(
      flash.includes("ZT Open Tier") && flash.includes("ZT Relative Tier"),
      `flash names both skipped sets (got: ${flash})`
    );
    ok("(d) flash warning names the skipped demurrage sets");

    console.log(`\naudit-demurrage-save-resilience: ${passed}/5 checks passed`);
    console.log("audit-demurrage-save-resilience-ok");
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
