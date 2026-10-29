'use strict';
// Tiny LRU cache with TTL. Keeps repeat searches instant (performance guard:
// a hot query never hits the network twice inside the TTL window).

class LRUCache {
  constructor(max = 200, ttlMs = 10 * 60 * 1000) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, ts }
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value); // evict oldest
    }
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

module.exports = { LRUCache };
