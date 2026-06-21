// Audit 3 — new-carrier boundary/deep test over real HTTP routes + the 7-shells
// builder. Complements d-add-shipping-line-test.js (happy path) with edge cases.
// Backs up / restores data/shipping-lines.json.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const { createApp } = require("../src/server");
const { getShippingData, saveShippingData } = require("../src/lib/store");
const { buildNewCarrierShells } = require("./seed-new-carriers");

const dataFile = path.join(__dirname, "../data/shipping-lines.json");

class CookieJar {
  constructor() { this.c = new Map(); }
  store(h) {
    const s = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
    for (const ck of s) { const [p] = ck.split(";"); const i = p.indexOf("="); if (i > 0) this.c.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  }
  header() { return [...this.c.entries()].map(([n, v]) => `${n}=${v}`).join("; "); }
}
async function req(base, url, { method = "GET", formEntries, jar } = {}) {
  const headers = {};
  if (jar?.header()) headers.cookie = jar.header();
  let body;
  if (formEntries) { const p = new URLSearchParams(); for (const [k, v] of formEntries) p.append(k, v == null ? "" : String(v)); body = p; headers["content-type"] = "application/x-www-form-urlencoded"; }
  const r = await fetch(`${base}${url}`, { method, headers, body, redirect: "manual" });
  jar?.store(r.headers);
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}

async function main() {
  const backup = await fs.readFile(dataFile, "utf8");
  const app = createApp();
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new CookieJar();
  let passed = 0;
  const ok = (m) => { passed += 1; console.log("  PASS ", m); };

  try {
    await req(base, "/login", { jar });

    // --- B1: create with NAME ONLY (no code/rfc) ---
    let res = await req(base, "/admin/handover/shipping-lines/add", { method: "POST", jar, formEntries: [["line_name", "TS LINES"]] });
    assert.equal(res.status, 302, "name-only create 302");
    assert.match(res.location, /shipping-lines\/ts-lines$/, "slug from name");
    let data = await getShippingData();
    let line = data.modules.handover.shippingLines.find((l) => l.id === "ts-lines");
    assert.ok(line, "ts-lines created");
    assert.equal(line.notes.code, null, "code null when omitted");
    assert.equal(line.notes.rfc, null, "rfc null when omitted");
    assert.ok(line.containerGroups.length >= 1 && line.demurrage.ruleSets.length >= 1, "normalizer completed empty shell");
    ok("create with name only → valid shell, code/rfc null");

    // --- B2: DUPLICATE name → distinct deduped id ---
    res = await req(base, "/admin/handover/shipping-lines/add", { method: "POST", jar, formEntries: [["line_name", "TS LINES"]] });
    assert.equal(res.status, 302, "duplicate-name create 302");
    assert.match(res.location, /shipping-lines\/ts-lines-2$/, "duplicate name → deduped id ts-lines-2");
    data = await getShippingData();
    assert.ok(data.modules.handover.shippingLines.find((l) => l.id === "ts-lines-2"), "ts-lines-2 exists (distinct)");
    assert.equal(data.modules.handover.shippingLines.filter((l) => l.name === "TS LINES").length, 2, "two TS LINES with distinct ids");
    ok("duplicate name → distinct deduped id (no clobber)");

    // --- B3: empty/whitespace name rejected ---
    res = await req(base, "/admin/handover/shipping-lines/add", { method: "POST", jar, formEntries: [["line_name", "   "]] });
    assert.equal(res.status, 302, "blank name 302");
    assert.match(res.location, /shipping-lines$/, "blank name back to list (flash error)");
    ok("blank name rejected");

    // --- B4: delete a LOADED carrier (charge + yard ref) → clean cascade ---
    // load ts-lines: add a charge, map a CONTENTO yard to it, then delete.
    await req(base, "/admin/handover/shipping-lines/ts-lines/local-charges/add", { method: "POST", jar });
    data = await getShippingData();
    const aYard = data.modules.customs.yards.find((y) => y.id.startsWith("yard-mzo-contento-"));
    aYard.shippingLineIds = [...(aYard.shippingLineIds || []), "ts-lines"];
    await saveShippingData(data);
    res = await req(base, "/admin/handover/shipping-lines/ts-lines/delete", { method: "POST", jar });
    assert.equal(res.status, 302, "delete loaded carrier 302");
    data = await getShippingData();
    assert.ok(!data.modules.handover.shippingLines.find((l) => l.id === "ts-lines"), "removed from handover");
    assert.ok(!data.modules.customs.shippingLines.find((l) => l.id === "ts-lines"), "removed from customs mirror");
    assert.ok(!data.modules.customs.yards.some((y) => (y.shippingLineIds || []).includes("ts-lines")), "cascade: no yard references it");
    assert.ok(data.modules.handover.shippingLines.find((l) => l.id === "ts-lines-2"), "the duplicate survives delete of the first");
    ok("delete loaded carrier → clean cascade (handover + mirror + yard refs), sibling untouched");

    // --- B5: customs mirror sync on add (already created ts-lines-2) ---
    assert.ok(data.modules.customs.shippingLines.find((l) => l.id === "ts-lines-2"), "customs mirror exists for ts-lines-2");
    ok("customs mirror synced on create");

    // cleanup the leftover duplicate
    await req(base, "/admin/handover/shipping-lines/ts-lines-2/delete", { method: "POST", jar });

    // --- B6: 7 shells builder (idempotent) ---
    data = await getShippingData();
    const before = data.modules.handover.shippingLines.length;
    const r1 = buildNewCarrierShells(data.modules.handover, data.modules.customs);
    assert.equal(r1.created.length, 7, "7 shells created");
    assert.deepEqual(
      r1.created.sort(),
      ["esl-emirates-shipping-line", "hmm", "sea-lead", "sinokor", "sinotrans", "sl", "ts-lines"].sort(),
      "expected 7 shell ids"
    );
    // idempotent: feed result back, expect 0 new
    const applied = { ...data.modules.handover, shippingLines: r1.handoverLines };
    const r2 = buildNewCarrierShells(applied, { ...data.modules.customs, shippingLines: r1.customsMirrors });
    assert.equal(r2.created.length, 0, "re-run creates 0 (idempotent)");
    assert.equal(r2.skipped.length, 7, "re-run skips all 7");
    assert.equal(r1.handoverLines.length, before + 7, "handover grew by 7");
    assert.equal(r1.customsMirrors.length, data.modules.customs.shippingLines.length + 7, "mirror grew by 7");
    ok("7 new-carrier shells: built + idempotent (re-run skips)");

    console.log(`\naudit-new-carrier-test: ${passed}/${passed} passed`);
    console.log("audit-new-carrier-test-ok");
  } finally {
    server.close();
    await fs.writeFile(dataFile, backup, "utf8");
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
