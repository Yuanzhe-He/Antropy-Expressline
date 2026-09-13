const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createIdleBrowser, readIdleTimeout, DEFAULT_IDLE_TIMEOUT_MS } = require("../src/lib/idle-browser");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    timers,
    setTimer(fn, delay) {
      const timer = { fn, at: now + delay, unreferenced: false, unref() { this.unreferenced = true; } };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
    async advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now && timers.delete(timer)) timer.fn();
      }
      await flush();
    },
  };
}

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.closes = 0;
  }
  isConnected() { return this.connected; }
  async close() {
    this.closes += 1;
    this.connected = false;
    this.emit("disconnected");
  }
}

function setup(launch) {
  const clock = fakeClock();
  const browsers = [];
  const pool = createIdleBrowser({
    launch: launch || (() => { const browser = new FakeBrowser(); browsers.push(browser); return browser; }),
    idleTimeoutMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { pool, clock, browsers };
}

async function main() {
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 180000);
  for (const input of [undefined, "", "0", "-1", "NaN", "Infinity", "1.5", "999", "3600001"]) {
    assert.equal(readIdleTimeout(input), 180000, `invalid timeout ${input} uses safe default`);
  }
  assert.equal(readIdleTimeout("1000"), 1000);
  assert.equal(readIdleTimeout("300000"), 300000);

  // Sequential jobs reuse a browser; the full idle interval begins again after
  // each job. Timers must not keep the server or a completed script alive.
  {
    const { pool, clock, browsers } = setup();
    await pool.run(async () => "PDF");
    assert.equal(clock.timers.size, 1);
    assert.equal([...clock.timers][0].unreferenced, true);
    await clock.advance(999);
    const first = await pool.run(async (browser) => browser);
    assert.equal(first, browsers[0]);
    await clock.advance(999);
    assert.equal(first.closes, 0);
    await clock.advance(1);
    assert.equal(first.closes, 1);
    const next = await pool.run(async (browser) => browser);
    assert.notEqual(next, first);
    await pool.close();
    assert.equal(next.closes, 1);
  }

  // Reservations exist while launch is still pending and while exports overlap.
  {
    const launch = deferred();
    let launchCount = 0;
    const { pool, clock } = setup(() => { launchCount += 1; return launch.promise; });
    const firstJob = deferred();
    const secondJob = deferred();
    const browser = new FakeBrowser();
    const first = pool.run(async (received) => { assert.equal(received, browser); await firstJob.promise; });
    const second = pool.run(async (received) => { assert.equal(received, browser); await secondJob.promise; });
    await flush();
    assert.equal(launchCount, 1);
    await clock.advance(5000);
    assert.equal(clock.timers.size, 0);
    launch.resolve(browser);
    firstJob.resolve();
    await first;
    await clock.advance(5000);
    assert.equal(browser.closes, 0, "finishing one export cannot close another export's browser");
    secondJob.resolve();
    await second;
    await clock.advance(1000);
    assert.equal(browser.closes, 1);
  }

  // A synchronous or asynchronous launch failure is never cached forever.
  for (const synchronous of [true, false]) {
    let attempts = 0;
    const browser = new FakeBrowser();
    const { pool, clock } = setup(() => {
      attempts += 1;
      if (attempts === 1) {
        if (synchronous) throw new Error("launch failed");
        return Promise.reject(new Error("launch failed"));
      }
      return browser;
    });
    await assert.rejects(pool.run(() => assert.fail("failed launch cannot run job")), /launch failed/);
    assert.equal(clock.timers.size, 0);
    assert.equal(await pool.run((received) => received), browser);
    assert.equal(attempts, 2);
    await pool.close();
  }

  // Page creation and rendering errors release reservations and still clean up.
  for (const message of ["newPage failed", "PDF render failed", "page close failed"]) {
    const { pool, clock, browsers } = setup();
    await assert.rejects(pool.run(async () => { throw new Error(message); }), new RegExp(message));
    await clock.advance(1000);
    assert.equal(browsers[0].closes, 1);
  }

  // A disconnected generation must not be returned to a future export.
  {
    const { pool, clock } = setup();
    const first = await pool.run((browser) => browser);
    first.connected = false;
    first.emit("disconnected");
    await flush();
    assert.equal(clock.timers.size, 0);
    const next = await pool.run((browser) => browser);
    assert.notEqual(next, first);
    await pool.close();
  }

  // A transport disconnect can leave the owned child alive. Wait for an
  // already-running export to finish, then clean up that detached generation.
  {
    const browser = new FakeBrowser();
    const job = deferred();
    let signal = null;
    browser.close = async () => { throw new Error("transport disconnected"); };
    browser.process = () => ({ exitCode: null, kill(value) { signal = value; } });
    const { pool } = setup(() => browser);
    const running = pool.run(async () => { await job.promise; });
    await flush();
    browser.connected = false;
    browser.emit("disconnected");
    await flush();
    assert.equal(signal, null, "disconnect cleanup waits for current export to drain");
    job.resolve();
    await running;
    await pool.close();
    assert.equal(signal, "SIGTERM", "detached child is still owned and cleaned up");
  }

  // Even a browser returned already disconnected needs child cleanup, despite
  // the rejected launch promise. A later export must still be able to launch.
  {
    const browser = new FakeBrowser();
    browser.connected = false;
    let signal = null;
    browser.close = async () => { throw new Error("transport disconnected"); };
    browser.process = () => ({ exitCode: null, kill(value) { signal = value; } });
    let attempts = 0;
    const { pool } = setup(() => ++attempts === 1 ? browser : new FakeBrowser());
    await assert.rejects(pool.run(() => assert.fail("disconnected launch cannot run job")), /disconnected during launch/);
    await pool.close();
    assert.equal(signal, "SIGTERM");
    await pool.run(() => "PDF");
    assert.equal(attempts, 2);
    await pool.close();
  }

  // Explicit close waits for an in-flight export (including pending launch),
  // while a new export gets an independent generation instead of the old one.
  {
    const pendingLaunch = deferred();
    const oldBrowser = new FakeBrowser();
    const newBrowser = new FakeBrowser();
    let launchCount = 0;
    const { pool } = setup(() => ++launchCount === 1 ? pendingLaunch.promise : newBrowser);
    const pendingJob = deferred();
    const oldJob = pool.run(async (browser) => { assert.equal(browser, oldBrowser); await pendingJob.promise; });
    const close = pool.close();
    let closeFinished = false;
    close.then(() => { closeFinished = true; });
    const fresh = await pool.run((browser) => browser);
    assert.equal(fresh, newBrowser);
    assert.equal(closeFinished, false);
    pendingLaunch.resolve(oldBrowser);
    await flush();
    assert.equal(oldBrowser.closes, 0);
    pendingJob.resolve();
    await oldJob;
    await close;
    assert.equal(oldBrowser.closes, 1);
    assert.equal(newBrowser.closes, 0, "old close cannot close the new generation");
    await pool.close();
    assert.equal(newBrowser.closes, 1);
  }

  // A request arriving during an asynchronous idle close cannot acquire the
  // closing browser. Repeated explicit close also awaits pending cleanup.
  {
    const { pool, clock } = setup();
    const oldBrowser = await pool.run((browser) => browser);
    const closing = deferred();
    oldBrowser.close = async () => { oldBrowser.closes += 1; await closing.promise; oldBrowser.emit("disconnected"); };
    await clock.advance(1000);
    assert.equal(oldBrowser.closes, 1);
    const fresh = await pool.run((browser) => browser);
    assert.notEqual(fresh, oldBrowser);
    const close = pool.close();
    let closeFinished = false;
    close.then(() => { closeFinished = true; });
    await flush();
    assert.equal(closeFinished, false);
    closing.resolve();
    await close;
    assert.equal(fresh.closes, 1);
  }

  // If protocol shutdown fails, terminate only the unused owned child.
  {
    const browser = new FakeBrowser();
    let signal = null;
    browser.close = async () => { throw new Error("protocol unavailable"); };
    browser.process = () => ({ exitCode: null, kill(value) { signal = value; } });
    const { pool, clock } = setup(() => browser);
    await pool.run(() => "PDF");
    await clock.advance(1000);
    assert.equal(signal, "SIGTERM");
    await pool.close();
  }

  // An unresponsive protocol close is bounded; its deadline is unreferenced
  // and the old child's shutdown does not block a new browser generation.
  {
    const oldBrowser = new FakeBrowser();
    oldBrowser.close = () => new Promise(() => {});
    let signal = null;
    oldBrowser.process = () => ({ exitCode: null, kill(value) { signal = value; } });
    let launches = 0;
    const { pool, clock } = setup(() => ++launches === 1 ? oldBrowser : new FakeBrowser());
    await pool.run(() => "PDF");
    await clock.advance(1000);
    assert.equal([...clock.timers][0].unreferenced, true, "close deadline must not keep Node alive");
    await pool.run(() => "next PDF");
    assert.equal(launches, 2);
    await clock.advance(9999);
    assert.equal(signal, null);
    await clock.advance(1);
    assert.equal(signal, "SIGTERM");
    await pool.close();
    assert.equal(clock.timers.size, 0, "close deadlines are cleared after cleanup");
  }

  console.log("[audit-pdf-lifecycle] PASS: timeout validation, reuse, concurrent exports, idle cleanup, launch and render failures, disconnect, explicit/idle close races, child cleanup");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
