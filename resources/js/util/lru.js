/**
 * What: A tiny bounded least-recently-used map. get()/set() move a key to most-recent; when the
 *       map exceeds its capacity, the least-recently-used key is evicted.
 * Why:  PageSource caches fetched pages by query signature so paging back and forth (or re-sorting
 *       to a prior state) is instant, but an unbounded cache would grow without limit over a long
 *       session. A small LRU keeps the hot pages and drops the cold ones (plan §2.4 PageSource,
 *       util/lru). Pure data, no DOM — Node-testable like the nav/format vectors.
 * When: Instantiated by PageSource; unit-vectored by tests/js/run-lru-vectors.mjs.
 */
export default class Lru {
    /**
     * @param {number} capacity max entries kept (>=1)
     */
    constructor(capacity = 24) {
        this.capacity = Math.max(1, capacity);
        /** @type {Map<string, *>} insertion order === recency order (Map preserves it). */
        this.map = new Map();
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.map.has(key);
    }

    /**
     * Read a value, marking it most-recently-used. Returns undefined on a miss.
     * @param {string} key
     */
    get(key) {
        if (!this.map.has(key)) {
            return undefined;
        }
        const value = this.map.get(key);
        // Re-insert to move to the most-recent end.
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    /**
     * Store a value as most-recently-used, evicting the LRU entry if over capacity.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, value);
        if (this.map.size > this.capacity) {
            // The first key in insertion order is the least-recently-used.
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }

    /** Drop all entries. */
    clear() {
        this.map.clear();
    }

    /** Current entry count. */
    get size() {
        return this.map.size;
    }
}
