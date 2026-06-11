// response-cache.mjs — tiny TTL cache for expensive web UI responses.
// Pure in-memory by design: fast warm loads, no native SQLite dependency.

export class ResponseCache {
  constructor({ defaultTtlMs = 30_000, maxEntries = 250 } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      if (!firstKey) break;
      this.entries.delete(firstKey);
    }
    return value;
  }

  clear(prefix = '') {
    if (!prefix) {
      this.entries.clear();
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

export const responseCache = new ResponseCache();
