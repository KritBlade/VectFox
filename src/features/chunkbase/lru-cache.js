// lru-cache.js — a fixed-size cache that evicts the least recently used entry; chat-vectorization.js
// keeps message-text hashes in one.

/**
 * A Map whose insertion order is the recency order: reading or writing a key moves it to the end,
 * so the first key is always the least recently used, and it is the one evicted when the cache is
 * over capacity.
 */
export class LRUCache {
    /**
     * @param {number} capacity - most entries kept
     */
    constructor(capacity) {
        this.capacity = capacity;
        this.cache = new Map();
    }

    /**
     * Read a value and mark its key the most recently used.
     *
     * @param {*} key
     * @returns {*} the cached value, or undefined when the key is absent
     */
    get(key) {
        if (!this.cache.has(key)) {
            return undefined;
        }

        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);

        return value;
    }

    /**
     * Store a value as the most recently used, then evict the least recently used entry if the
     * cache is over capacity.
     *
     * @param {*} key
     * @param {*} value
     * @returns {LRUCache} this cache
     */
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        this.cache.set(key, value);

        if (this.cache.size > this.capacity) {
            const leastRecentlyUsedKey = this.cache.keys().next().value;
            this.cache.delete(leastRecentlyUsedKey);
        }

        return this;
    }
}
