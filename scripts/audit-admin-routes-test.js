// Admin-route coverage net (Phase 0 of the god-file refactor). Boots the real
// app over HTTP in JSON mode against an isolated temp DATA_DIR (never touches the
// repo's data/ or production), then exercises the admin CRUD routes that had no
// route-level test: customs ports/terminals/yards, inland origins/destinations/
// rate-entries, handover container-types, settings, exchange-rates/refresh — each
// create → read-back → delete with assertions. Plus a "no-500 wiring sweep" over
// the deeper sub-resource routes (storage-rule-sets, fixed-charges, terminal-mix,
// local-charges, demurrage-rule-sets, precise-points) so the upcoming refactor
// can't silently break a route's wiring without a test catching it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";
// Isolate writes to a temp dir BEFORE requiring store/server (DATA_DIR is read at
// module load). Reads fall back to the bundled seed; writes land in the temp dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-admin-test-"));
process.env.DATA_DIR = tmpDir;

const { createApp } = require("../src/server");
const { getShippingData, RATE_GROUP_NAMES } = require("../src/lib/store");

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
async function req(urlPath, { method = "POST", form } = {}) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) params.append(k, v == null ? "" : String(v));
    body = params;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(`${baseUrl}${urlPath}`, { method, headers, body, redirect: "manual" });
  jar.store(r.headers);
  return { status: r.status, location: r.headers.get("location") };
}

const customs = () => getShippingData().then((d) => d.modules.customs);
const inland = () => getShippingData().then((d) => d.modules.inland);
const handover = () => getShippingData().then((d) => d.modules.handover);

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
    // --- settings (quote): save number prefix + read back -----------------
    {
      const r = await req("/admin/quote/settings", { form: { quoteNumberPrefix: "ZTEST" } });
      assert.ok(r.status === 302, `settings POST redirects (got ${r.status})`);
      const q = (await getShippingData()).modules.quote;
      assert.equal(q.settings.quoteNumberPrefix, "ZTEST", "settings persisted quoteNumberPrefix");
      ok("settings: POST /admin/quote/settings persists + reads back");
    }

    // --- container-types: add → read back → delete ------------------------
    {
      const rg = RATE_GROUP_NAMES[0];
      let r = await req("/admin/handover/container-types/add", {
        form: { ct_new_key: "zt-ct", ct_new_label: "ZT Container", ct_new_rateGroup: rg },
      });
      assert.equal(r.status, 302, "container-type add redirects");
      assert.ok((await handover()).containerTypes.some((c) => c.key === "zt-ct"), "container-type added");
      r = await req("/admin/handover/container-types/zt-ct/delete");
      assert.equal(r.status, 302, "container-type delete redirects");
      assert.ok(!(await handover()).containerTypes.some((c) => c.key === "zt-ct"), "container-type deleted");
      ok("container-types: add → read-back → delete");
    }

    // --- customs port → terminal → yard lifecycle -------------------------
    let portId;
    let terminalId;
    {
      const before = (await customs()).ports.length;
      let r = await req("/admin/customs/ports/add");
      assert.equal(r.status, 302, "port add redirects");
      let c = await customs();
      assert.equal(c.ports.length, before + 1, "port count +1");
      portId = c.ports[c.ports.length - 1].id;

      r = await req(`/admin/customs/ports/${portId}/terminals/add`);
      assert.equal(r.status, 302, "terminal add redirects");
      c = await customs();
      const port = c.ports.find((p) => p.id === portId);
      assert.ok((port.terminals || []).length >= 1, "terminal added under port");
      terminalId = port.terminals[port.terminals.length - 1].id;
      ok("customs: port add + terminal add (read-back)");

      const yBefore = (await customs()).yards.length;
      r = await req("/admin/customs/yards/add");
      assert.equal(r.status, 302, "yard add redirects");
      let yardId = (await customs()).yards.slice(-1)[0].id;
      assert.equal((await customs()).yards.length, yBefore + 1, "yard count +1");
      r = await req(`/admin/customs/yards/${yardId}/delete`);
      assert.equal(r.status, 302, "yard delete redirects");
      assert.equal((await customs()).yards.length, yBefore, "yard count restored");
      ok("customs: yard add → read-back → delete (count restored)");
    }

    // --- inland origin / destination / rate-entry lifecycle ---------------
    {
      let r = await req("/admin/inland/origins/add", { form: { name: "ZT Origin", lat: "19.0", lng: "-104.0" } });
      assert.equal(r.status, 302, "origin add redirects");
      const oid = (await inland()).origins.find((o) => o.name === "ZT Origin")?.id;
      assert.ok(oid, "origin added + read back");

      r = await req("/admin/inland/destinations/add", { form: { name: "ZT Dest", lat: "20", lng: "-103" } });
      assert.equal(r.status, 302, "dest add redirects");
      const did = (await inland()).destinations.find((d) => d.name === "ZT Dest")?.id;
      assert.ok(did, "destination added + read back");

      r = await req("/admin/inland/rate-entries/add", { form: { destinationId: did } });
      assert.equal(r.status, 302, "rate-entry add redirects");
      const rate = (await inland()).rateEntries.find((e) => e.destinationId === did);
      assert.ok(rate, "rate-entry added for new dest");

      r = await req(`/admin/inland/rate-entries/${rate.id}/delete`);
      assert.equal(r.status, 302, "rate-entry delete redirects");
      assert.ok(!(await inland()).rateEntries.some((e) => e.id === rate.id), "rate-entry deleted");

      r = await req(`/admin/inland/origins/${oid}/delete`);
      assert.equal(r.status, 302, "origin delete redirects");
      assert.ok(!(await inland()).origins.some((o) => o.id === oid), "origin deleted");

      r = await req(`/admin/inland/destinations/${did}/delete`);
      assert.equal(r.status, 302, "dest delete redirects");
      assert.ok(!(await inland()).destinations.some((d) => d.id === did), "destination deleted");
      ok("inland: origin/destination/rate-entry full CRUD (read-back each)");
    }

    // --- exchange-rates/refresh (SKIP_FX_REFRESH → no network) -------------
    {
      const r = await req("/admin/handover/exchange-rates/refresh");
      assert.equal(r.status, 302, "exchange-rates/refresh redirects");
      ok("exchange-rates/refresh: route responds 302 (no crash)");
    }

    // --- no-500 wiring sweep over deeper sub-resource routes --------------
    {
      const lineId = (await handover()).shippingLines[0].id;
      const sweep = [
        ["POST", `/admin/customs/terminals/${terminalId}/fixed-charges/add`, {}],
        ["POST", `/admin/customs/terminals/${terminalId}/storage-rule-sets/add`, {}],
        ["POST", `/admin/${"handover"}/shipping-lines/${lineId}/local-charges/add`, {}],
        ["POST", `/admin/handover/shipping-lines/${lineId}/terminal-mix/add`, {}],
        ["POST", `/admin/handover/shipping-lines/${lineId}/demurrage-rule-sets/add`, {}],
        ["POST", "/admin/inland/routes/refresh", {}],
        ["GET", "/admin/customs/shipping-lines", null],
        ["GET", `/admin/customs/ports/${portId}`, null],
        ["GET", "/workbench/handover", null],
        ["GET", "/workbench/customs", null],
        ["GET", "/workbench/inland", null],
        ["GET", "/workbench/quote", null],
      ];
      let swept = 0;
      for (const [method, p, form] of sweep) {
        const r = await req(p, { method, form: form || undefined });
        assert.ok(r.status < 500, `${method} ${p} did not 5xx (got ${r.status})`);
        swept += 1;
      }
      ok(`no-500 wiring sweep: ${swept} deeper routes respond without 5xx`);
    }

    // port delete last (cleanup + covers the delete route)
    {
      const before = (await customs()).ports.length;
      const r = await req(`/admin/customs/ports/${portId}/delete`);
      assert.equal(r.status, 302, "port delete redirects");
      assert.equal((await customs()).ports.length, before - 1, "port count restored");
      ok("customs: port delete (cascade terminals) → read-back");
    }

    console.log(`\naudit-admin-routes-test: ${passed}/${passed} passed`);
    console.log("audit-admin-routes-test-ok");
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
