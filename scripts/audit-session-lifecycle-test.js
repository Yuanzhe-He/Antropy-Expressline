const assert = require("node:assert/strict");
const { BoundedSessionStore } = require("../src/lib/bounded-session-store");

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    let returned = false;
    store[method](...args, (error, result) => {
      try {
        assert.equal(returned, true, `${method} callback must be asynchronous`);
        if (error) reject(error);
        else resolve(result);
      } catch (failure) {
        reject(failure);
      }
    });
    returned = true;
  });
}

function fixture(options = {}) {
  let time = 1000;
  const store = new BoundedSessionStore({
    ttlMs: 100,
    maxEntries: 3,
    now: () => time,
    ...options,
  });
  return { store, advance(ms) { time += ms; }, now: () => time };
}

async function auditStore() {
  const { store, advance, now } = fixture();
  try {
    assert.equal(store.cleanupTimer.hasRef(), false, "cleanup must not keep Node alive");
    const original = { cookie: {}, user: { id: "synthetic" }, language: "es" };
    await call(store, "set", "a", original);
    original.user.id = "caller-only-mutation";
    const loaded = await call(store, "get", "a");
    assert.equal(loaded.user.id, "synthetic", "set must isolate the stored payload");
    loaded.user.id = "request-only-mutation";
    assert.equal((await call(store, "get", "a")).user.id, "synthetic");
    advance(90);
    assert.ok(await call(store, "get", "a"), "a read renews inactivity expiry");
    advance(90);
    await call(store, "touch", "a", { cookie: {}, language: "zh" });
    advance(90);
    assert.equal((await call(store, "get", "a")).language, "es", "touch keeps existing fields");
    advance(100);
    assert.equal(await call(store, "get", "a"), undefined, "expiry applies at its boundary");
    await call(store, "touch", "a", { cookie: {} });
    assert.equal(await call(store, "length"), 0, "touch never resurrects an expired session");

    await call(store, "set", "cookie-expiry", {
      cookie: { expires: new Date(now() + 20) },
    });
    advance(15);
    assert.ok(await call(store, "get", "cookie-expiry"));
    advance(5);
    assert.equal(await call(store, "get", "cookie-expiry"), undefined, "cookie expiry still wins");
    await call(store, "set", "already-expired", {
      cookie: { expires: new Date(now() - 1).toISOString() },
    });
    assert.equal(await call(store, "length"), 0);

    for (const id of ["a", "b", "c"]) await call(store, "set", id, { cookie: {}, id });
    await call(store, "get", "a");
    await call(store, "set", "d", { cookie: {}, id: "d" });
    assert.equal(await call(store, "get", "b"), undefined, "get updates eviction recency");
    await call(store, "touch", "c", { cookie: {} });
    await call(store, "set", "e", { cookie: {}, id: "e" });
    assert.equal(await call(store, "get", "a"), undefined, "touch updates eviction recency");
    await call(store, "set", "d", { cookie: {}, id: "d-updated" });
    await call(store, "set", "f", { cookie: {}, id: "f" });
    assert.equal(await call(store, "get", "c"), undefined, "set updates eviction recency");
    assert.equal(await call(store, "length"), 3, "store never exceeds its cap");

    const all = await call(store, "all");
    all.d.id = "listing-only-mutation";
    assert.equal((await call(store, "get", "d")).id, "d-updated", "all returns isolated payloads");
    const circular = { cookie: {} };
    circular.self = circular;
    await assert.rejects(call(store, "set", "d", circular), /circular/i);
    assert.equal((await call(store, "get", "d")).id, "d-updated", "failed writes preserve data");
    await call(store, "destroy", "d");
    await call(store, "touch", "d", { cookie: {} });
    assert.equal(await call(store, "get", "d"), undefined, "touch cannot undo logout");
    await call(store, "clear");
    assert.equal(await call(store, "length"), 0);

    await call(store, "set", "expires", { cookie: {} });
    advance(100);
    assert.equal(Object.keys(await call(store, "all")).length, 0, "all excludes expired entries");
    await call(store, "set", "expires", { cookie: {} });
    advance(100);
    assert.equal(await call(store, "length"), 0, "length excludes expired entries");
    await call(store, "set", "expires", { cookie: {} });
    advance(100);
    store.pruneExpired();
    assert.equal(store.entries.size, 0, "cleanup removes expired payloads without traffic");

    // Store methods accept omitted callbacks, as the default MemoryStore does.
    store.set("optional", { cookie: {} });
    store.get("optional");
    store.touch("optional", { cookie: {} });
    store.all();
    store.length();
    store.destroy("optional");
    store.clear();
  } finally {
    store.close();
  }

  const staggered = fixture({ maxEntries: 2 });
  try {
    await call(staggered.store, "set", "old", { cookie: {} });
    staggered.advance(50);
    await call(staggered.store, "set", "live", { cookie: {} });
    staggered.advance(50);
    await call(staggered.store, "set", "new", { cookie: {} });
    assert.ok(await call(staggered.store, "get", "live"), "expired entries are removed before eviction");
    assert.equal(await call(staggered.store, "length"), 2);
  } finally {
    staggered.store.close();
  }

  const invalid = new BoundedSessionStore({
    ttlMs: "invalid",
    maxEntries: -1,
    cleanupIntervalMs: Infinity,
  });
  try {
    assert.equal(invalid.ttlMs, 86400000);
    assert.equal(invalid.maxEntries, 10000);
    assert.equal(invalid.cleanupIntervalMs, 60000);
  } finally {
    invalid.close();
  }
  console.log("PASS session store: expiry, cookie lifetime, touch, LRU, isolation, callbacks and cleanup");
}

async function auditHttp() {
  process.env.STORAGE_DRIVER = "json";
  const { createApp } = require("../src/server");
  const store = new BoundedSessionStore();
  const app = createApp({ sessionStore: store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let batch = 0; batch < 40; batch++) {
      await Promise.all(Array.from({ length: 25 }, async () => {
        const response = await fetch(`${base}/healthz`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal((await response.json()).status, "ok");
      }));
    }
    assert.equal(await call(store, "length"), 0, "1,000 health probes retain no sessions");
    const asset = await fetch(`${base}/styles.css`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("set-cookie"), null);
    await asset.text();
    assert.equal(await call(store, "length"), 0, "static middleware still precedes sessions");

    const first = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(first.status, 302);
    const setCookie = first.headers.get("set-cookie");
    assert.match(setCookie, /^connect\.sid=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Path=\//i);
    assert.doesNotMatch(setCookie, /Expires=|Max-Age=/i, "cookie remains a browser-session cookie");
    await first.text();
    const cookie = setCookie.split(";")[0];
    const sessions = await call(store, "all");
    const [id] = Object.keys(sessions);
    assert.equal(Object.keys(sessions).length, 1);
    assert.equal(sessions[id].user.id, "public-demo", "ordinary demo-user behavior is preserved");

    const preference = await fetch(`${base}/preferences/language`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "language=es&returnTo=%2F",
    });
    assert.equal(preference.status, 302);
    await preference.text();
    const current = await call(store, "get", id);
    assert.equal(current.language, "es", "language preference persists in the same session");
    current.flash = { type: "success", message: "synthetic lifecycle test" };
    current.lastCalculatorForms = { handover: { containerCount: "2" } };
    await call(store, "set", id, current);
    const next = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    await next.text();
    const after = await call(store, "get", id);
    assert.equal(after.flash, undefined, "flash remains one-use");
    assert.deepEqual(after.lastCalculatorForms, current.lastCalculatorForms, "saved forms survive requests");
    assert.equal(after.language, "es");
    const logout = await fetch(`${base}/logout`, {
      method: "POST", headers: { cookie }, redirect: "manual",
    });
    assert.equal(logout.status, 302);
    await logout.text();
    assert.equal(await call(store, "length"), 0, "logout destroys the stored session");
    console.log("PASS HTTP: 1,000 health probes retain zero sessions; static, cookie, user, language, flash, forms and logout preserved");
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  await auditStore();
  await auditHttp();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
