// D2 verification — new-carrier onboarding end-to-end over real HTTP routes.
// Boots the app, logs in, then: create SINOKOR -> edit (name/code/rfc + guarantee)
// -> add a local charge -> add a demurrage rule set -> save -> read back ->
// confirm selectable in quote + customs -> delete -> confirm cascade -> old 14
// carriers intact. Backs up / restores data/shipping-lines.json.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const { createApp } = require("../src/server");
const { getShippingData } = require("../src/lib/store");

const dataFile = path.join(__dirname, "../data/shipping-lines.json");

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

async function request(baseUrl, urlPath, { method = "GET", formEntries, jar } = {}) {
  const headers = {};
  if (jar?.header()) headers.cookie = jar.header();
  let body;
  if (formEntries) {
    const params = new URLSearchParams();
    for (const [k, v] of formEntries) params.append(k, v == null ? "" : String(v));
    body = params;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${baseUrl}${urlPath}`, { method, headers, body, redirect: "manual" });
  jar?.store(response.headers);
  const text = await response.text();
  return { status: response.status, location: response.headers.get("location"), text };
}

async function main() {
  const backup = await fs.readFile(dataFile, "utf8");
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jar = new CookieJar();
  let passed = 0;
  const ok = (msg) => { passed += 1; console.log("  PASS ", msg); };

  try {
    // login
    await request(baseUrl, "/login", { jar });

    // baseline: 14 handover carriers
    const before = await getShippingData();
    const beforeCount = before.modules.handover.shippingLines.length;
    assert.equal(beforeCount, 14, "baseline 14 carriers");
    ok("baseline 14 handover carriers");

    // --- CREATE ---
    let res = await request(baseUrl, "/admin/handover/shipping-lines/add", {
      method: "POST",
      jar,
      formEntries: [
        ["line_name", "SINOKOR"],
        ["line_code", "SINOKOR_MX"],
        ["line_rfc", "SKR250101ABC"],
      ],
    });
    assert.equal(res.status, 302, "create redirects");
    assert.match(res.location, /\/admin\/handover\/shipping-lines\/sinokor$/, "redirect to edit page");
    ok("create SINOKOR -> 302 to its edit page");

    // empty name rejected
    res = await request(baseUrl, "/admin/handover/shipping-lines/add", {
      method: "POST",
      jar,
      formEntries: [["line_name", "   "]],
    });
    assert.equal(res.status, 302, "empty name redirects (flash error)");
    assert.match(res.location, /\/admin\/handover\/shipping-lines$/, "empty name back to list");
    ok("empty name rejected");

    // --- data: handover + customs mirror present ---
    let data = await getShippingData();
    const created = data.modules.handover.shippingLines.find((l) => l.id === "sinokor");
    assert.ok(created, "sinokor in handover");
    assert.equal(created.name, "SINOKOR");
    assert.equal(created.notes.code, "SINOKOR_MX");
    assert.equal(created.notes.rfc, "SKR250101ABC");
    assert.ok(created.containerGroups.length >= 1, "has container groups");
    assert.ok(created.demurrage.ruleSets.length >= 1, "demurrage rule sets seeded");
    const mirror = data.modules.customs.shippingLines.find((l) => l.id === "sinokor");
    assert.ok(mirror, "sinokor mirrored into customs");
    assert.equal(mirror.name, "SINOKOR");
    ok("sinokor present in handover + customs mirror, normalized complete");

    // --- edit page renders identity inputs ---
    res = await request(baseUrl, "/admin/handover/shipping-lines/sinokor", { jar });
    assert.equal(res.status, 200, "edit page 200");
    assert.ok(res.text.includes('name="line_name"'), "name input");
    assert.ok(res.text.includes("SINOKOR_MX"), "code prefilled");
    assert.ok(res.text.includes("SKR250101ABC"), "rfc prefilled");
    assert.ok(res.text.includes("/admin/handover/shipping-lines/sinokor/delete"), "delete button");
    ok("edit page shows identity inputs + delete button");

    // --- selectable in quote (handover-derived selector) ---
    res = await request(baseUrl, "/workbench/quote", { jar });
    assert.equal(res.status, 200, "quote page 200");
    assert.ok(res.text.includes("SINOKOR"), "SINOKOR appears in quote selector data");
    ok("SINOKOR selectable in quote");

    // --- selectable in customs yard mapping ---
    res = await request(baseUrl, "/admin/customs/shipping-lines", { jar });
    assert.equal(res.status, 200, "customs page 200");
    assert.ok(res.text.includes("SINOKOR"), "SINOKOR appears in customs page");
    ok("SINOKOR selectable in customs yard mapping");

    // --- add a local charge ---
    res = await request(baseUrl, "/admin/handover/shipping-lines/sinokor/local-charges/add", {
      method: "POST",
      jar,
    });
    assert.equal(res.status, 302, "add local charge 302");
    data = await getShippingData();
    let line = data.modules.handover.shippingLines.find((l) => l.id === "sinokor");
    assert.equal(line.localCharges.length, 1, "one local charge added");
    ok("add local charge");

    // --- save line: edit name/code/rfc + guarantee (押金) rate + the local
    // charge. Default demurrage rule sets only (a freshly-added rule set needs
    // its rule day-fields, which the real form supplies; tested separately). ---
    const charge = line.localCharges[0];
    const grp = line.containerGroups[0].key;
    const saveEntries = [
      ["line_name", "SINOKOR LINE"],
      ["line_code", "SINOKOR_MX2"],
      ["line_rfc", "SKR250101XYZ"],
      ["invoiceNote", "Factura Express"],
      ["demurrageCutoffHandledBy", line.demurrageCutoffHandledBy],
      ["guaranteeTaxRate", "0"],
      [`guarantee_${grp}_rate`, "1500"],
      [`guarantee_${grp}_currency`, "USD"],
      [`charge_concept_${charge.id}`, "Doc Fee SINOKOR"],
      [`charge_tax_${charge.id}`, "0.16"],
      [`charge_bl_${charge.id}_rate`, "85"],
      [`charge_bl_${charge.id}_currency`, "USD"],
    ];
    for (const g of line.containerGroups) {
      saveEntries.push([`charge_${charge.id}_${g.key}_rate`, "35"]);
      saveEntries.push([`charge_${charge.id}_${g.key}_currency`, "USD"]);
    }
    for (const type of data.modules.handover.containerTypes) {
      saveEntries.push([`demurrage_assignment_${type.key}`, line.demurrage.ruleSets[0].id]);
    }
    res = await request(baseUrl, "/admin/handover/shipping-lines/sinokor", {
      method: "POST",
      jar,
      formEntries: saveEntries,
    });
    assert.equal(res.status, 302, "save line 302");
    data = await getShippingData();
    line = data.modules.handover.shippingLines.find((l) => l.id === "sinokor");
    assert.equal(line.name, "SINOKOR LINE", "name updated");
    assert.equal(line.notes.code, "SINOKOR_MX2", "code updated");
    assert.equal(line.notes.rfc, "SKR250101XYZ", "rfc updated");
    assert.equal(line.localCharges[0].concept, "Doc Fee SINOKOR", "charge concept saved");
    assert.equal(line.localCharges[0].blRate.rate, 85, "charge bl rate saved");
    assert.equal(line.guarantee.ratesByGroup[grp].rate, 1500, "guarantee (押金) rate saved");
    const mirror2 = data.modules.customs.shippingLines.find((l) => l.id === "sinokor");
    assert.equal(mirror2.name, "SINOKOR LINE", "customs mirror name synced on edit");
    ok("edit save: identity + charge + guarantee persisted, mirror synced");

    // --- add a demurrage rule set (滞期) — the add route persists it immediately ---
    const ruleSetsBefore = line.demurrage.ruleSets.length;
    res = await request(baseUrl, "/admin/handover/shipping-lines/sinokor/demurrage-rule-sets/add", {
      method: "POST",
      jar,
    });
    assert.equal(res.status, 302, "add demurrage rule set 302");
    data = await getShippingData();
    line = data.modules.handover.shippingLines.find((l) => l.id === "sinokor");
    assert.ok(line.demurrage.ruleSets.length > ruleSetsBefore, "demurrage rule set added");
    ok("add demurrage rule set (滞期)");

    // --- map a CONTENTO yard to this carrier then DELETE (cascade check) ---
    const yard = data.modules.customs.yards[0];
    yard.shippingLineIds = [...(yard.shippingLineIds || []), "sinokor"];
    const { saveShippingData } = require("../src/lib/store");
    await saveShippingData(data);

    res = await request(baseUrl, "/admin/handover/shipping-lines/sinokor/delete", {
      method: "POST",
      jar,
    });
    assert.equal(res.status, 302, "delete 302");
    assert.match(res.location, /\/admin\/handover\/shipping-lines$/, "delete back to list");
    data = await getShippingData();
    assert.ok(!data.modules.handover.shippingLines.find((l) => l.id === "sinokor"), "removed from handover");
    assert.ok(!data.modules.customs.shippingLines.find((l) => l.id === "sinokor"), "removed from customs mirror");
    assert.ok(
      !data.modules.customs.yards.some((y) => (y.shippingLineIds || []).includes("sinokor")),
      "cascade: no yard references sinokor"
    );
    ok("delete cascades handover + customs mirror + yard refs");

    // --- old 14 intact ---
    assert.equal(data.modules.handover.shippingLines.length, 14, "back to 14 carriers");
    assert.ok(data.modules.handover.shippingLines.find((l) => l.id === "kmtc"), "kmtc intact");
    assert.ok(data.modules.handover.shippingLines.find((l) => l.id === "cma-cgm"), "cma-cgm intact");
    ok("old 14 carriers intact after add+delete");

    console.log(`\nd-add-shipping-line-test: ${passed}/${passed} passed`);
    console.log("d-add-shipping-line-test-ok");
  } finally {
    server.close();
    await fs.writeFile(dataFile, backup, "utf8");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
