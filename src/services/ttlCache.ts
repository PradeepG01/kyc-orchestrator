/**
 * Small in-process TTL + LRU cache. Used to avoid paying for (and waiting on) identical vendor checks
 * repeated within a short window, e.g. a client retrying a signup with the same details.
 * For multiple replicas, swap for Redis behind the same get/set interface.
 */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.store.delete(key); // re-insert to mark as most recently used
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.ttlMs <= 0) return;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }
}
