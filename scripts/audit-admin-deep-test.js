// Deep admin sub-route coverage net (Phase 3a of the god-file refactor). This
// thickens the test net BEFORE the admin block is split out of server.js, so a
// pure-move that drops a helper, breaks an import, or mis-wires a closure turns
// RED here. It complements audit-admin-routes-test.js (which does the top-level
// CRUD + a no-500 sweep) by exercising the deep, tangled sub-routes with full
// add → edit → read-back → delete assertions:
//   - shipping-line sub-resources: local-charges / terminal-mix / demurrage
//     rule-sets (incl. the progressive rule engine + last-rule-delete guard)
//   - the big shipping-line edit handler (rate cells, tax, guarantee) + the
//     customs.shippingLines mirror sync (the "parallel list mirrors" lesson)
//   - customs terminal fixed-charges + storage rule-sets (add → add-rule →
//     delete-rule → delete-set) + the bulk "save all customs rules" handler
//   - quote remarks/notes library CRUD (the quote branch of /admin/:m/settings)
//   - every markRouteStale / refreshOneInlandRoute trigger path (route refresh,
//     destinations/save coord change, manual override, precise points)
//
// Boots the real app over HTTP in JSON mode against an isolated temp DATA_DIR
// (never touches the repo's data/ or production). OSRM is mocked at the global
// fetch boundary so route-cache writes are deterministic and hermetic (no
// network). SKIP_FX_REFRESH keeps FX offline.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";
process.env.OSRM_BASE_URL = "http://osrm.test";
// Isolate writes to a temp dir BEFORE requiring store/server (DATA_DIR is read at
// module load). Reads fall back to the bundled seed; writes land in the temp dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-admin-deep-test-"));
process.env.DATA_DIR = tmpDir;

// Hermetic OSRM: intercept the routing fetch so refreshOneInlandRoute populates
// the route cache deterministically without any network. Everything else (the
// test's own HTTP requests to the local server) delegates to the real fetch.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes("/route/v1/driving/")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: "Ok",
        routes: [{ geometry: "", distance: 120000, duration: 9000, legs: [] }],
      }),
    };
  }
  if (realFetch) return realFetch(url, opts);
  throw new Error(`unexpected fetch in test: ${url}`);
};

const { createApp } = require("../src/server");
const { getShippingData } = require("../src/lib/store");

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
// Form values may be arrays (repeated field names, e.g. note_id[]) — append each.
async function req(urlPath, { method = "POST", form } = {}) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) {
        for (const item of v) params.append(k, item == null ? "" : String(item));
      } else {
        params.append(k, v == null ? "" : String(v));
      }
    }
    body = params;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(`${baseUrl}${urlPath}`, { method, headers, body, redirect: "manual" });
  jar.store(r.headers);
  return { status: r.status, location: r.headers.get("location") };
}

const mod = (key) => getShippingData().then((d) => d.modules[key]);
const handover = () => mod("handover");
const customs = () => mod("customs");
const inland = () => mod("inland");
const quote = () => mod("quote");
const lineById = (m, id) => (m.shippingLines || []).find((l) => l.id === id);

function buildHandoverAdminForm(moduleData, line) {
  const form = {
    line_name: line.name || "",
    line_code: line.notes?.code || "",
    line_rfc: line.notes?.rfc || "",
    invoiceNote: line.invoiceNote || "",
    demurrageCutoffHandledBy: line.demurrageCutoffHandledBy || "",
    benefitExpiresAt: line.guarantee?.benefitExpiresAt || "",
    benefitNote: line.guarantee?.benefitNote || "",
    guaranteeTaxRate: String(line.guarantee?.taxRate ?? 0),
  };
  if (line.invoiceToConsigneeOnly) form.invoiceToConsigneeOnly = "on";
  if (line.guarantee?.benefitEnabled) form.benefitEnabled = "on";

  for (const charge of line.localCharges || []) {
    form[`charge_concept_${charge.id}`] = charge.concept || "";
    form[`charge_tax_${charge.id}`] = String(charge.taxRate ?? 0);
    if (charge.blRate) {
      form[`charge_bl_${charge.id}_rate`] = String(charge.blRate.rate ?? 0);
      form[`charge_bl_${charge.id}_currency`] = charge.blRate.currency || "USD";
    }
    for (const [groupKey, rate] of Object.entries(charge.groupRates || {})) {
      if (!rate) continue;
      form[`charge_${charge.id}_${groupKey}_rate`] = String(rate.rate ?? 0);
      form[`charge_${charge.id}_${groupKey}_currency`] = rate.currency || "USD";
    }
  }

  for (const [groupKey, rate] of Object.entries(line.guarantee?.ratesByGroup || {})) {
    if (!rate) continue;
    form[`guarantee_${groupKey}_rate`] = String(rate.rate ?? 0);
    form[`guarantee_${groupKey}_currency`] = rate.currency || "USD";
  }

  for (const entry of line.terminalMix || []) {
    form[`terminal_mix_${entry.id}_port`] = entry.port || "";
    form[`terminal_mix_${entry.id}_terminal`] = entry.terminal || "";
    form[`terminal_mix_${entry.id}_ratio`] = String(Math.round((entry.ratio || 0) * 10000) / 100);
  }

  for (const type of moduleData.containerTypes || []) {
    form[`demurrage_assignment_${type.key}`] =
      line.demurrage?.assignmentsByContainerType?.[type.key] ||
      line.demurrage?.ruleSets?.[0]?.id ||
      "";
  }

  for (const ruleSet of line.demurrage?.ruleSets || []) {
    form[`demurrage_set_${ruleSet.id}_name`] = ruleSet.name || "";
    for (const rule of ruleSet.rules || []) {
      const prefix = `rule_set_${ruleSet.id}_${rule.id}`;
      form[`${prefix}_end`] =
        rule.endDay === null || rule.endDay === undefined ? "" : String(rule.endDay);
      form[`${prefix}_tax`] = String(rule.taxRate ?? 0);
      form[`${prefix}_rate`] = String(rule.rateConfig?.rate ?? 0);
      form[`${prefix}_currency`] = rule.rateConfig?.currency || "USD";
    }
  }

  return form;
}

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  jar = new CookieJar();

  try {
    const lineId = (await handover()).shippingLines[0].id;

    // === A) shipping-line sub-resources: full add → read-back → delete ========

    // A1: terminal-mix add → delete
    {
      const before = (lineById(await handover(), lineId).terminalMix || []).length;
      let r = await req(`/admin/handover/shipping-lines/${lineId}/terminal-mix/add`);
      assert.equal(r.status, 302, "terminal-mix add redirects");
      let line = lineById(await handover(), lineId);
      assert.equal(line.terminalMix.length, before + 1, "terminal-mix +1");
      const mixId = line.terminalMix[line.terminalMix.length - 1].id;
      r = await req(`/admin/handover/shipping-lines/${lineId}/terminal-mix/${mixId}/delete`);
      assert.equal(r.status, 302, "terminal-mix delete redirects");
      line = lineById(await handover(), lineId);
      assert.ok(!line.terminalMix.some((e) => e.id === mixId), "terminal-mix entry removed");
      assert.equal(line.terminalMix.length, before, "terminal-mix count restored");
      ok("shipping-line terminal-mix: add → read-back → delete");
    }

    // A2: local-charges add → delete
    {
      const before = (lineById(await handover(), lineId).localCharges || []).length;
      let r = await req(`/admin/handover/shipping-lines/${lineId}/local-charges/add`);
      assert.equal(r.status, 302, "local-charge add redirects");
      let line = lineById(await handover(), lineId);
      assert.equal(line.localCharges.length, before + 1, "local-charge +1");
      const charge = line.localCharges[line.localCharges.length - 1];
      assert.equal(charge.taxRate, 0, "new local-charge taxRate 0");
      assert.ok(charge.blRate && charge.blRate.qtyHint === 1, "new local-charge has blRate");
      r = await req(`/admin/handover/shipping-lines/${lineId}/local-charges/${charge.id}/delete`);
      assert.equal(r.status, 302, "local-charge delete redirects");
      line = lineById(await handover(), lineId);
      assert.ok(!line.localCharges.some((c) => c.id === charge.id), "local-charge removed");
      assert.equal(line.localCharges.length, before, "local-charge count restored");
      ok("shipping-line local-charges: add → read-back → delete");
    }

    // A3: demurrage rule-set add → add rule → delete rule → last-rule guard → delete set
    {
      const setsBefore = (lineById(await handover(), lineId).demurrage?.ruleSets || []).length;
      let r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/add`);
      assert.equal(r.status, 302, "demurrage rule-set add redirects");
      let line = lineById(await handover(), lineId);
      assert.equal(line.demurrage.ruleSets.length, setsBefore + 1, "rule-set +1");
      const ruleSet = line.demurrage.ruleSets[line.demurrage.ruleSets.length - 1];
      const setId = ruleSet.id;
      assert.equal(ruleSet.rules.length, 1, "new rule-set seeds exactly 1 rule");

      // add a rule (progressive engine: appendProgressiveRule + resequenceRules)
      r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/${setId}/add`);
      assert.equal(r.status, 302, "demurrage add-rule redirects");
      line = lineById(await handover(), lineId);
      let rs = line.demurrage.ruleSets.find((s) => s.id === setId);
      assert.equal(rs.rules.length, 2, "rule-set now has 2 rules");
      const ruleToDelete = rs.rules[rs.rules.length - 1].id;

      // delete a non-last rule → succeeds (removeProgressiveRule + resequence)
      r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/${setId}/${ruleToDelete}/delete`);
      assert.equal(r.status, 302, "demurrage delete-rule redirects");
      line = lineById(await handover(), lineId);
      rs = line.demurrage.ruleSets.find((s) => s.id === setId);
      assert.equal(rs.rules.length, 1, "rule-set back to 1 rule");

      // delete the LAST remaining rule → blocked (no change)
      const lastRuleId = rs.rules[0].id;
      r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/${setId}/${lastRuleId}/delete`);
      assert.equal(r.status, 302, "demurrage last-rule delete still redirects");
      line = lineById(await handover(), lineId);
      rs = line.demurrage.ruleSets.find((s) => s.id === setId);
      assert.equal(rs.rules.length, 1, "last-rule delete is blocked (rules unchanged)");

      // Assign one concrete container to the added set, then delete the whole set.
      // The delete route must repoint that assignment to the first remaining set.
      const handoverModule = await handover();
      line = lineById(handoverModule, lineId);
      const firstTypeKey = handoverModule.containerTypes[0].key;
      const fallbackSetId = line.demurrage.ruleSets[0].id;
      const form = buildHandoverAdminForm(handoverModule, line);
      form[`demurrage_assignment_${firstTypeKey}`] = setId;
      r = await req(`/admin/handover/shipping-lines/${lineId}`, { form });
      assert.equal(r.status, 302, "assign new rule-set redirects");
      line = lineById(await handover(), lineId);
      assert.equal(
        line.demurrage.assignmentsByContainerType[firstTypeKey],
        setId,
        "test setup: container assignment points at added set"
      );

      r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/${setId}/delete`);
      assert.equal(r.status, 302, "demurrage rule-set delete redirects");
      line = lineById(await handover(), lineId);
      assert.equal(line.demurrage.ruleSets.length, setsBefore, "rule-set count restored");
      assert.ok(!line.demurrage.ruleSets.some((s) => s.id === setId), "deleted rule-set removed");
      assert.equal(
        line.demurrage.assignmentsByContainerType[firstTypeKey],
        fallbackSetId,
        "assignment repointed to first remaining set"
      );
      assert.equal(
        Object.keys(line.demurrage.assignmentsByContainerType || {}).length,
        handoverModule.containerTypes.length,
        "assignments remain explicit for all container types"
      );

      while (line.demurrage.ruleSets.length > 1) {
        const removableSetId = line.demurrage.ruleSets[line.demurrage.ruleSets.length - 1].id;
        r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/${removableSetId}/delete`);
        assert.equal(r.status, 302, "reduce to one demurrage rule-set redirects");
        line = lineById(await handover(), lineId);
      }
      const lastSetId = line.demurrage.ruleSets[0].id;
      r = await req(`/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/${lastSetId}/delete`);
      assert.equal(r.status, 302, "last demurrage rule-set delete still redirects");
      line = lineById(await handover(), lineId);
      assert.equal(line.demurrage.ruleSets.length, 1, "last-set delete is blocked");
      ok("shipping-line demurrage: rule-set add → add-rule → delete-rule → delete-set reassignment → last-set guard");
    }

    // === B) big shipping-line edit handler + customs mirror sync ==============
    {
      // add a fresh handover line (also creates the customs mirror)
      let r = await req("/admin/handover/shipping-lines/add", {
        form: { line_name: "ZT EditLine", line_code: "ZTC", line_rfc: "ZTRFC123" },
      });
      assert.equal(r.status, 302, "shipping-line add redirects");
      const newId = lineById(await handover(), "zt-editline")?.id || "zt-editline";
      assert.ok(lineById(await handover(), newId), "new handover line present");
      assert.ok(
        (await customs()).shippingLines.some((l) => l.id === newId),
        "customs mirror created for new line"
      );

      // give it a local charge so the rate-cell path is exercised by the edit
      r = await req(`/admin/handover/shipping-lines/${newId}/local-charges/add`);
      assert.equal(r.status, 302, "add local-charge to new line redirects");
      const freshLine = lineById(await handover(), newId);
      const cId = freshLine.localCharges[freshLine.localCharges.length - 1].id;
      const hasGuarantee = Boolean(freshLine.guarantee);

      // big edit: rename, set charge tax + a group rate cell, guarantee tax
      const form = {
        line_name: "ZT EditLine v2",
        [`charge_tax_${cId}`]: "8",
        [`charge_${cId}_gp-hc-sd_rate`]: "123",
        [`charge_${cId}_gp-hc-sd_currency`]: "USD",
        guaranteeTaxRate: "16",
      };
      r = await req(`/admin/handover/shipping-lines/${newId}`, { form });
      assert.equal(r.status, 302, "big edit redirects");
      const edited = lineById(await handover(), newId);
      assert.equal(edited.name, "ZT EditLine v2", "line name updated");
      const editedCharge = edited.localCharges.find((c) => c.id === cId);
      assert.equal(editedCharge.taxRate, 8, "charge taxRate updated via parseNumber");
      assert.equal(editedCharge.groupRates["gp-hc-sd"].rate, 123, "group rate cell updated");
      assert.equal(editedCharge.groupRates["gp-hc-sd"].currency, "USD", "group rate currency updated");
      if (hasGuarantee) {
        assert.equal(edited.guarantee.taxRate, 16, "guarantee taxRate updated");
      }
      // mirror sync (parallel list mirrors): customs mirror name follows handover
      const mirror = (await customs()).shippingLines.find((l) => l.id === newId);
      assert.equal(mirror.name, "ZT EditLine v2", "customs mirror name synced on edit");

      // delete → cascades out of handover AND customs mirror + yard refs
      r = await req(`/admin/handover/shipping-lines/${newId}/delete`);
      assert.equal(r.status, 302, "shipping-line delete redirects");
      assert.ok(!lineById(await handover(), newId), "handover line removed");
      assert.ok(
        !(await customs()).shippingLines.some((l) => l.id === newId),
        "customs mirror removed on delete"
      );
      ok("shipping-line big edit: rename + rate cells + tax + customs mirror sync + cascade delete");
    }

    // === C) customs terminal fixed-charges + storage rule engine + bulk save ==
    {
      const c0 = await customs();
      const portId = c0.ports[0].id;
      const terminalId = c0.ports[0].terminals[0].id;
      const findTerminal = async () => {
        const c = await customs();
        for (const p of c.ports) {
          const t = (p.terminals || []).find((x) => x.id === terminalId);
          if (t) return t;
        }
        return null;
      };

      // C1: fixed-charges add → delete
      {
        const before = ((await findTerminal()).fixedCharges || []).length;
        let r = await req(`/admin/customs/terminals/${terminalId}/fixed-charges/add`);
        assert.equal(r.status, 302, "fixed-charge add redirects");
        let t = await findTerminal();
        assert.equal(t.fixedCharges.length, before + 1, "fixed-charge +1");
        const charge = t.fixedCharges[t.fixedCharges.length - 1];
        assert.equal(charge.basis, "per_occurrence", "fixed-charge default basis");
        assert.equal(charge.required, false, "fixed-charge default required false");
        r = await req(`/admin/customs/terminals/${terminalId}/fixed-charges/${charge.id}/delete`);
        assert.equal(r.status, 302, "fixed-charge delete redirects");
        t = await findTerminal();
        assert.ok(!t.fixedCharges.some((c) => c.id === charge.id), "fixed-charge removed");
        assert.equal(t.fixedCharges.length, before, "fixed-charge count restored");
        ok("customs fixed-charges: add → read-back → delete");
      }

      // C2: storage rule-set add → add rule → delete rule → delete set
      let ruleSetId;
      {
        const setsBefore = ((await findTerminal()).storageRuleSets || []).length;
        let r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/add`);
        assert.equal(r.status, 302, "storage rule-set add redirects");
        let t = await findTerminal();
        assert.equal(t.storageRuleSets.length, setsBefore + 1, "storage rule-set +1");
        const ruleSet = t.storageRuleSets[t.storageRuleSets.length - 1];
        ruleSetId = ruleSet.id;
        const rulesBefore = ruleSet.rules.length;
        assert.ok(rulesBefore >= 1, "new storage rule-set seeds >=1 rule");

        r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/${ruleSetId}/add`);
        assert.equal(r.status, 302, "storage add-rule redirects");
        t = await findTerminal();
        let rs = t.storageRuleSets.find((s) => s.id === ruleSetId);
        assert.equal(rs.rules.length, rulesBefore + 1, "storage rule +1");
        const ruleId = rs.rules[rs.rules.length - 1].id;

        r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/${ruleSetId}/${ruleId}/delete`);
        assert.equal(r.status, 302, "storage delete-rule redirects");
        t = await findTerminal();
        rs = t.storageRuleSets.find((s) => s.id === ruleSetId);
        assert.equal(rs.rules.length, rulesBefore, "storage rule back to baseline");
        ok("customs storage rule-set: add → add-rule → delete-rule (progressive engine)");
      }

      // C3: bulk "save all customs rules" — rename the rule-set via the bulk handler.
      // The real admin form submits an `_end` field for EVERY storage rule (empty
      // string for the open-ended last rule). Omitting them makes
      // applySequentialRuleUpdates coerce a null endDay to 0 → invalidRuleRange and
      // the whole save early-returns without persisting. So reconstruct the full
      // form faithfully (all rules' `_end`, preserving current values) + the rename.
      {
        const cm = await customs();
        const form = {};
        for (const p of cm.ports || []) {
          for (const t of p.terminals || []) {
            for (const rsSet of t.storageRuleSets || []) {
              for (const rule of rsSet.rules || []) {
                form[`terminal_storage_set_${t.id}_${rsSet.id}_${rule.id}_end`] =
                  rule.endDay === null || rule.endDay === undefined ? "" : String(rule.endDay);
              }
            }
          }
        }
        form[`terminal_storage_set_${terminalId}_${ruleSetId}_name`] = "ZT Renamed Set";
        const r = await req("/admin/customs/shipping-lines", { form });
        assert.equal(r.status, 302, "bulk customs save redirects");
        assert.ok(
          !String(r.location || "").includes("#customs-terminal-"),
          "bulk save succeeded (no validation error redirect)"
        );
        const t = await findTerminal();
        const rs = t.storageRuleSets.find((s) => s.id === ruleSetId);
        assert.equal(rs.name, "ZT Renamed Set", "bulk save renamed storage rule-set");
        ok("customs bulk save: applySequentialRuleUpdates + syncTerminalStorageRulesByContainer path");
      }

      // C4: delete the rule-set we added (cleanup + covers delete-set route)
      {
        const r = await req(`/admin/customs/terminals/${terminalId}/storage-rule-sets/${ruleSetId}/delete`);
        assert.equal(r.status, 302, "storage rule-set delete redirects");
        const t = await findTerminal();
        assert.ok(!t.storageRuleSets.some((s) => s.id === ruleSetId), "storage rule-set removed");
        ok("customs storage rule-set: delete-set (unassign + resync)");
      }
    }

    // === D) quote remarks/notes library CRUD =================================
    {
      const q0 = await quote();
      const before = (q0.settings.headerDefaults) || {};
      const existing = q0.notes || [];
      const note_id = [...existing.map((n) => n.id), "zt-new", "zt-empty"];
      const note_en = [...existing.map((n) => n.en || ""), "ZT EN", ""];
      const note_zh = [...existing.map((n) => n.zh || ""), "ZT ZH", ""];
      const note_es = [...existing.map((n) => n.es || ""), "ZT ES", ""];
      // preserve existing header defaults so the rebuild doesn't clobber them
      const r = await req("/admin/quote/settings", {
        form: {
          note_id,
          note_en,
          note_zh,
          note_es,
          hd_department: before.department || "",
          hd_transportMode: before.transportMode || "",
          hd_incoterm: before.incoterm || "",
          hd_cargoType: before.cargoType || "",
          hd_quoteMode: before.quoteMode || "",
        },
      });
      assert.equal(r.status, 302, "quote settings (notes) redirects");
      const q1 = await quote();
      assert.equal(q1.notes.length, existing.length + 1, "notes: +1 valid, empty dropped");
      const added = q1.notes.find((n) => n.id === "zt-new");
      assert.ok(added && added.en === "ZT EN" && added.zh === "ZT ZH" && added.es === "ZT ES", "new note persisted trilingual");
      assert.ok(!q1.notes.some((n) => n.id === "zt-empty"), "all-empty note dropped");
      ok("quote notes library: add (trilingual) + drop-empty via /admin/quote/settings");
    }

    // === E) inland: markRouteStale / refreshOneInlandRoute / override / precise ==
    {
      // add a destination with coords
      let r = await req("/admin/inland/destinations/add", {
        form: { name: "ZT StaleDest", state: "ZT", lat: "20.5", lng: "-103.2" },
      });
      assert.equal(r.status, 302, "dest add redirects");
      const did = (await inland()).destinations.find((d) => d.name === "ZT StaleDest")?.id;
      assert.ok(did, "dest added + read back");

      const destRc = async () =>
        ((await inland()).routeCache || []).find(
          (rc) => rc.destinationId === did && rc.targetType === "destination"
        );

      // routes/refresh → refreshOneInlandRoute populates the route cache (OSRM mock)
      r = await req("/admin/inland/routes/refresh", { form: { destinationId: did } });
      assert.equal(r.status, 302, "routes/refresh redirects");
      let rc = await destRc();
      assert.ok(rc, "route cache entry created for dest (refreshOneInlandRoute)");
      assert.equal(rc.stale, false, "fresh route is not stale");
      assert.equal(rc.engine, "osrm", "route engine recorded");
      ok("inland routes/refresh: refreshOneInlandRoute writes route cache (hermetic OSRM)");

      // destinations/save with changed coords → markRouteStale fires
      r = await req("/admin/inland/destinations/save", {
        form: {
          [`dest_present_${did}`]: "1",
          [`dest_name_${did}`]: "ZT StaleDest",
          [`dest_lat_${did}`]: "21.0",
          [`dest_lng_${did}`]: "-104.0",
        },
      });
      assert.equal(r.status, 302, "destinations/save redirects");
      rc = await destRc();
      assert.equal(rc.stale, true, "markRouteStale set stale=true after coord change");
      const savedDest = (await inland()).destinations.find((d) => d.id === did);
      assert.equal(savedDest.lat, 21.0, "dest lat updated on save");
      ok("inland destinations/save: markRouteStale trigger on coord change");

      // manual override → set, then clear
      r = await req(`/admin/inland/routes/${did}/override`, {
        form: { ovr_km: "150", ovr_min: "120", ovr_via: "CityA, CityB" },
      });
      assert.equal(r.status, 302, "route override redirects");
      rc = await destRc();
      assert.equal(rc.manualOverride.distanceKm, 150, "override km");
      assert.equal(rc.manualOverride.durationMin, 120, "override min");
      assert.deepEqual(rc.manualOverride.viaCities, ["CityA", "CityB"], "override via cities");

      r = await req(`/admin/inland/routes/${did}/clear-override`);
      assert.equal(r.status, 302, "route clear-override redirects");
      rc = await destRc();
      assert.equal(rc.manualOverride, null, "override cleared");
      ok("inland route override: set → clear");

      // precise points: add (auto route fetch) → save flatPrice → delete
      r = await req(`/admin/inland/destinations/${did}/precise-points/add`, {
        form: { name: "ZT PP", lat: "21.1", lng: "-104.1", flatPrice: "5000" },
      });
      assert.equal(r.status, 302, "precise-point add redirects");
      let dest = (await inland()).destinations.find((d) => d.id === did);
      const pp = dest.precisePoints.find((p) => p.name === "ZT PP");
      assert.ok(pp, "precise point added");
      assert.equal(pp.flatPrice, 5000, "precise point flatPrice");
      assert.equal(pp.source, "manual", "precise point source manual");
      const ppRc = ((await inland()).routeCache || []).find(
        (rc2) => rc2.targetType === "precisePoint" && rc2.targetId === pp.id
      );
      assert.ok(ppRc, "precise point route cached (refreshOneInlandRoute)");

      r = await req(`/admin/inland/destinations/${did}/precise-points/${pp.id}/save`, {
        form: { flatPrice: "7500" },
      });
      assert.equal(r.status, 302, "precise-point save redirects");
      dest = (await inland()).destinations.find((d) => d.id === did);
      assert.equal(dest.precisePoints.find((p) => p.id === pp.id).flatPrice, 7500, "precise point flatPrice updated");

      r = await req(`/admin/inland/destinations/${did}/precise-points/${pp.id}/delete`);
      assert.equal(r.status, 302, "precise-point delete redirects");
      dest = (await inland()).destinations.find((d) => d.id === did);
      assert.ok(!dest.precisePoints.some((p) => p.id === pp.id), "precise point removed");
      assert.ok(
        !((await inland()).routeCache || []).some(
          (rc2) => rc2.targetType === "precisePoint" && rc2.targetId === pp.id
        ),
        "precise point route cache pruned"
      );
      ok("inland precise points: add (auto-route) → save flatPrice → delete (prunes cache)");

      // origins/save (add temp origin, rename + edit coords, delete)
      r = await req("/admin/inland/origins/add", { form: { name: "ZT Origin2", lat: "19.2", lng: "-104.2" } });
      assert.equal(r.status, 302, "origin add redirects");
      const oid2 = (await inland()).origins.find((o) => o.name === "ZT Origin2")?.id;
      assert.ok(oid2, "temp origin added");
      r = await req("/admin/inland/origins/save", {
        form: { [`origin_name_${oid2}`]: "ZT Origin2 Renamed", [`origin_lat_${oid2}`]: "19.25" },
      });
      assert.equal(r.status, 302, "origins/save redirects");
      let org = (await inland()).origins.find((o) => o.id === oid2);
      assert.equal(org.name, "ZT Origin2 Renamed", "origin name saved");
      assert.equal(org.lat, 19.25, "origin lat saved");
      r = await req(`/admin/inland/origins/${oid2}/delete`);
      assert.equal(r.status, 302, "origin delete redirects");
      assert.ok(!(await inland()).origins.some((o) => o.id === oid2), "temp origin deleted");
      ok("inland origins/save: add → rename + edit coords → delete");

      // rate-entries/save (add → save fields with currency-style parsing → delete)
      r = await req("/admin/inland/rate-entries/add", { form: { destinationId: did } });
      assert.equal(r.status, 302, "rate-entry add redirects");
      const re = (await inland()).rateEntries.find((e) => e.destinationId === did);
      assert.ok(re, "rate entry added");
      r = await req("/admin/inland/rate-entries/save", {
        form: {
          [`re_present_${re.id}`]: "1",
          [`re_proveedor_${re.id}`]: "ZT Prov",
          [`re_sencillo_${re.id}`]: "$1,200",
          [`re_full_${re.id}`]: "2000",
          [`re_enabled_${re.id}`]: "1",
        },
      });
      assert.equal(r.status, 302, "rate-entries/save redirects");
      const savedRe = (await inland()).rateEntries.find((e) => e.id === re.id);
      assert.equal(savedRe.proveedor, "ZT Prov", "rate entry proveedor saved");
      assert.equal(savedRe.sencillo, 1200, "rate entry sencillo parsed ($1,200 → 1200)");
      assert.equal(savedRe.full, 2000, "rate entry full saved");
      r = await req(`/admin/inland/rate-entries/${re.id}/delete`);
      assert.equal(r.status, 302, "rate-entry delete redirects");
      assert.ok(!(await inland()).rateEntries.some((e) => e.id === re.id), "rate entry deleted");
      ok("inland rate-entries/save: add → save (currency parse) → delete");

      // cleanup the destination (cascades rateEntries + routeCache)
      r = await req(`/admin/inland/destinations/${did}/delete`);
      assert.equal(r.status, 302, "dest delete redirects");
      assert.ok(!(await inland()).destinations.some((d) => d.id === did), "dest deleted");
      assert.ok(
        !((await inland()).routeCache || []).some((rc2) => rc2.destinationId === did),
        "dest route cache cleared on delete"
      );
      ok("inland destinations/delete: cascade rateEntries + routeCache");
    }

    console.log(`\naudit-admin-deep-test: ${passed}/${passed} passed`);
    console.log("audit-admin-deep-test-ok");
  } finally {
    server.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
