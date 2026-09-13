const { Store } = require("express-session");

const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_TIMER_MS = 2147483647;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function reply(callback, error = null, value) {
  if (typeof callback === "function") setImmediate(callback, error, value);
}

// Keeps MemoryStore's JSON-copy semantics, with server-side inactivity expiry
// for browser-session cookies and a hard bound on retained entries. It remains
// process-local: a restart clears sessions just as the previous store did.
class BoundedSessionStore extends Store {
  constructor(options = {}) {
    super();
    this.ttlMs = positiveInteger(
      options.ttlMs ?? process.env.SESSION_IDLE_TTL_MS,
      DEFAULT_IDLE_TTL_MS
    );
    this.maxEntries = positiveInteger(
      options.maxEntries ?? process.env.SESSION_MAX_ENTRIES,
      DEFAULT_MAX_ENTRIES
    );
    this.cleanupIntervalMs = positiveInteger(
      options.cleanupIntervalMs ?? process.env.SESSION_CLEANUP_INTERVAL_MS,
      Math.min(this.ttlMs, DEFAULT_CLEANUP_INTERVAL_MS),
      MAX_TIMER_MS
    );
    this.now = options.now || Date.now;
    this.entries = new Map();
    this.cleanupTimer = setInterval(() => this.pruneExpired(), this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  expiresAt(session, now) {
    const cookieExpires = session.cookie?.expires;
    const cookieTime = cookieExpires ? new Date(cookieExpires).getTime() : NaN;
    return Number.isFinite(cookieTime)
      ? Math.min(now + this.ttlMs, cookieTime)
      : now + this.ttlMs;
  }

  pruneExpired() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  read(id) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return JSON.parse(entry.serialized);
  }

  retain(id, session) {
    // Serialize before changing the map, so a failed write preserves the old
    // value and is returned through the standard store callback.
    const serialized = JSON.stringify(session);
    const expiresAt = this.expiresAt(session, this.now());
    this.entries.delete(id);
    if (expiresAt <= this.now()) return;
    if (this.entries.size >= this.maxEntries) this.pruneExpired();
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(id, { serialized, expiresAt });
  }

  get(id, callback) {
    try {
      const session = this.read(id);
      if (session) this.retain(id, session);
      reply(callback, null, session);
    } catch (error) {
      reply(callback, error);
    }
  }

  set(id, session, callback) {
    try {
      this.retain(id, session);
      reply(callback);
    } catch (error) {
      reply(callback, error);
    }
  }

  touch(id, session, callback) {
    try {
      const current = this.read(id);
      if (current) {
        // express-session's touch refreshes the cookie, not other potentially
        // stale request fields. Never recreate a destroyed/expired session.
        current.cookie = session.cookie;
        this.retain(id, current);
      }
      reply(callback);
    } catch (error) {
      reply(callback, error);
    }
  }

  destroy(id, callback) {
    this.entries.delete(id);
    reply(callback);
  }

  clear(callback) {
    this.entries.clear();
    reply(callback);
  }

  length(callback) {
    this.pruneExpired();
    reply(callback, null, this.entries.size);
  }

  all(callback) {
    try {
      this.pruneExpired();
      const sessions = Object.create(null);
      for (const [id, entry] of this.entries) {
        sessions[id] = JSON.parse(entry.serialized);
      }
      reply(callback, null, sessions);
    } catch (error) {
      reply(callback, error);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = { BoundedSessionStore };
