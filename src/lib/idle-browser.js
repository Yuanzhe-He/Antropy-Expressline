const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 10 * 1000;

function readIdleTimeout(value) {
  if (value === undefined || value === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 3600000
    ? timeout
    : DEFAULT_IDLE_TIMEOUT_MS;
}

// Each generation owns its reservations and close operation. Detaching a
// generation before closing means a new job can never receive a closing browser.
function createIdleBrowser({
  launch,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let current = null;
  const pendingCloses = new Set();

  function cancelIdle(generation) {
    if (generation.idleTimer) clearTimer(generation.idleTimer);
    generation.idleTimer = null;
  }

  function detach(generation) {
    cancelIdle(generation);
    if (current === generation) current = null;
  }

  function startClose(generation) {
    if (generation.closing || generation.jobs > 0) return;
    generation.closing = true;
    (async () => {
      try {
        // Keep the returned browser separately: its launch promise may reject
        // after we discover that its transport already disconnected.
        const browser = generation.browser || await generation.promise;
        let closeTimer;
        try {
          await Promise.race([
            Promise.resolve().then(() => browser.close()),
            new Promise((_resolve, reject) => {
              closeTimer = setTimer(() => reject(new Error("PDF browser close timed out")), CLOSE_TIMEOUT_MS);
              closeTimer.unref?.();
            }),
          ]);
        } catch (_error) {
          // A failed protocol close must not leave an idle child alive. This
          // only applies to this generation, which has no active export jobs.
          const child = browser.process?.();
          if (child && child.exitCode === null) child.kill("SIGTERM");
        } finally {
          if (closeTimer) clearTimer(closeTimer);
        }
      } catch (_error) {
        // A launch failure or already-disconnected browser needs no cleanup.
      } finally {
        generation.resolveClosed();
      }
    })();
  }

  function requestClose(generation) {
    detach(generation);
    if (!generation.closed) {
      generation.closed = new Promise((resolve) => {
        generation.resolveClosed = resolve;
      });
      pendingCloses.add(generation.closed);
      generation.closed.then(() => pendingCloses.delete(generation.closed));
    }
    startClose(generation);
    return generation.closed;
  }

  function newGeneration() {
    const generation = { jobs: 0, idleTimer: null, failed: false };
    // Deferring launch also converts synchronous launch errors into rejections.
    generation.promise = Promise.resolve().then(launch).then((browser) => {
      generation.browser = browser;
      // Losing the protocol connection does not guarantee the child exited.
      // Detach now, but only clean up this browser once its exports have drained.
      browser.once("disconnected", () => requestClose(generation));
      if (!browser.isConnected()) {
        requestClose(generation);
        throw new Error("PDF browser disconnected during launch");
      }
      return browser;
    }).catch((error) => {
      generation.failed = true;
      detach(generation);
      throw error;
    });
    return generation;
  }

  async function run(job) {
    if (!current) current = newGeneration();
    const generation = current;
    cancelIdle(generation);
    generation.jobs += 1; // Reserve before the first await, including launch.
    try {
      return await job(await generation.promise);
    } finally {
      generation.jobs -= 1;
      if (generation.jobs === 0) {
        if (generation.closed) {
          startClose(generation);
        } else if (!generation.failed && current === generation) {
          generation.idleTimer = setTimer(() => {
            generation.idleTimer = null;
            if (generation.jobs === 0 && current === generation) requestClose(generation);
          }, idleTimeoutMs);
          generation.idleTimer.unref?.();
        }
      }
    }
  }

  function close() {
    if (current) requestClose(current);
    return Promise.all([...pendingCloses]).then(() => undefined);
  }

  return { run, close };
}

module.exports = { createIdleBrowser, readIdleTimeout, DEFAULT_IDLE_TIMEOUT_MS };
