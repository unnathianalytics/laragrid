/**
 * What: The readonly server-data driver (M3). It turns query intents — sort, search, filter,
 *       page, perPage — into $wire.gridFetch(name, query) RPCs, caches the resulting pages by
 *       query signature (LRU), discards stale responses (a monotonic sequence guards against a
 *       late reply for a superseded query), and applies the winning page to the store via
 *       store.setPage (which repaints through the existing rows:changed seam). It also prefetches
 *       the next page on idle so Page Down feels instant, and toggles the loading state.
 * Why:  Plan §2.3/§2.5.4: sort/search/filter/pagination are server-authoritative in readonly mode;
 *       the client never re-sorts or re-filters locally. Keeping ALL of that behind one module
 *       (with the cache + stale-guard) means the renderer/selection layers stay unaware of the
 *       network — they only ever see a new row set arrive (the same event an in-memory grid uses),
 *       so the grid body is repainted, never morphed (R3), and selection re-anchors via M2's path.
 * When: Constructed by GridCore only for a server-side grid (layout.serverSide); its methods are
 *       called by the header sort control and the pagination chrome.
 */
import Lru from '../util/lru.js';

export default class PageSource {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../core/EventBus').default} bus
     * @param {object} wire the Livewire $wire proxy (has async gridFetch)
     * @param {{cacheSize?: number}} [opts]
     */
    constructor(store, bus, wire, opts = {}) {
        this.store = store;
        this.bus = bus;
        this.wire = wire;
        this.cache = new Lru(opts.cacheSize || 24);
        /** Monotonic request id; a response is applied only if it's still the latest. */
        this.seq = 0;
        /** The seq of the most recent request we intend to display. */
        this.latest = 0;
        /** True while a fetch that will change the visible page is in flight. */
        this.loading = false;
        this.idleHandle = null;

        // Seed the cache with the config's first page so paging back to it is a cache hit and the
        // signature bookkeeping matches what's already on screen.
        this.cache.set(this.signatureOf(this.store.query), this.pageFromStore());
    }

    /** The page payload equivalent for what the store currently displays (for the seed entry). */
    pageFromStore() {
        return {
            rows: this.store.rows,
            total: this.store.serverMeta.total,
            page: this.store.serverMeta.page,
            perPage: this.store.serverMeta.perPage,
            lastPage: this.store.serverMeta.lastPage,
            pageTotals: this.store.pageTotals,
            grandTotals: this.store.grandTotals,
        };
    }

    /** A stable string signature for a query (order-independent for filters). */
    signatureOf(query) {
        const filters = query.filters || {};
        const orderedFilters = Object.keys(filters)
            .sort()
            .reduce((acc, k) => {
                acc[k] = filters[k];
                return acc;
            }, {});
        return JSON.stringify({
            sort: query.sort || null,
            dir: query.dir || 'asc',
            search: query.search || '',
            filters: orderedFilters,
            page: query.page || 1,
            perPage: query.perPage || this.store.serverMeta.perPage,
        });
    }

    // ---- Public query intents -------------------------------------------------------------

    /** Cycle a column's sort (asc → desc → clear-to-default) and reload page 1. */
    sort(colKey) {
        const q = { ...this.store.query };
        if (q.sort !== colKey) {
            q.sort = colKey;
            q.dir = 'asc';
        } else if (q.dir === 'asc') {
            q.dir = 'desc';
        } else {
            // Third click clears back to the grid's default sort.
            const def = (this.store.layout && this.store.layout.defaultSort) || null;
            q.sort = def ? def.col : null;
            q.dir = def ? def.dir : 'asc';
        }
        q.page = 1;
        this.load(q);
    }

    /** Set the global search term and reload page 1. */
    search(term) {
        this.load({ ...this.store.query, search: term || '', page: 1 });
    }

    /** Set a filter value (undefined/'' clears it) and reload page 1. */
    setFilter(key, value) {
        const filters = { ...(this.store.query.filters || {}) };
        if (value === undefined || value === null || value === '') {
            delete filters[key];
        } else {
            filters[key] = value;
        }
        this.load({ ...this.store.query, filters, page: 1 });
    }

    /** Go to an explicit page (clamped by the server). */
    goToPage(page) {
        const target = Math.max(1, Math.min(page, this.store.serverMeta.lastPage));
        if (target === this.store.serverMeta.page) {
            return;
        }
        this.load({ ...this.store.query, page: target });
    }

    nextPage() {
        this.goToPage(this.store.serverMeta.page + 1);
    }

    prevPage() {
        this.goToPage(this.store.serverMeta.page - 1);
    }

    /** Change page size and reload from page 1. */
    setPerPage(perPage) {
        this.load({ ...this.store.query, perPage, page: 1 });
    }

    /**
     * Download the CURRENT view (sort/search/filters — the whole filtered set, never the
     * page window) in one of the grid's enabled export formats. The server re-authorizes
     * and re-whitelists everything; we only echo the format name + the query intents.
     * Livewire turns the streamed response into a browser download; bus events let the
     * toolbar disable its control (and the announcer speak) while one is in flight.
     */
    export(format) {
        if (this.exporting || typeof this.wire.gridExport !== 'function') {
            return Promise.resolve();
        }
        const query = { ...this.store.query };
        delete query.page;
        delete query.perPage;

        this.exporting = true;
        this.bus.emit('export:started', { format });
        return this.wire
            .gridExport(this.store.name, format, query)
            .then(() => {
                this.exporting = false;
                this.bus.emit('export:done', { format });
            })
            .catch((error) => {
                this.exporting = false;
                this.bus.emit('export:error', { format, error });
            });
    }

    // ---- Fetch + reconcile ----------------------------------------------------------------

    /**
     * Load a query: serve from cache instantly if present, else fetch. A monotonic seq guards
     * against a stale response for a query the user has since moved past.
     * @param {object} query
     */
    /**
     * Cache-busting reload of the CURRENT query (P7): a call action changed data server-side,
     * so every cached page is stale — drop them all and refetch in place.
     */
    refresh() {
        this.cache.clear();
        this.load({ ...this.store.query });
    }


    load(query) {
        this.cancelPrefetch();
        const sig = this.signatureOf(query);
        const mySeq = ++this.seq;
        this.latest = mySeq;

        const cached = this.cache.get(sig);
        if (cached) {
            this.apply(cached, query, mySeq);
            return;
        }

        this.setLoading(true);
        this.fetch(query)
            .then((page) => {
                this.cache.set(sig, page);
                this.apply(page, query, mySeq);
            })
            .catch((err) => {
                if (mySeq === this.latest) {
                    this.setLoading(false);
                    this.bus.emit('fetch:error', { error: err, query });
                }
            });
    }

    /** The raw RPC — resolves to the page payload. */
    fetch(query) {
        return this.wire.gridFetch(this.store.name, query);
    }

    /**
     * Apply a page only if it's still the latest request (else it's stale — discard). Applying
     * updates the store (which repaints via rows:changed) and schedules an idle prefetch of the
     * next page.
     */
    apply(page, query, mySeq) {
        if (mySeq !== this.latest) {
            return; // a newer request superseded this one — drop the stale response
        }
        this.setLoading(false);
        this.store.setPage(page, query);
        this.schedulePrefetch();
    }

    setLoading(on) {
        if (this.loading === on) {
            return;
        }
        this.loading = on;
        this.bus.emit('loading:changed', { loading: on });
    }

    // ---- Idle prefetch of the next page ---------------------------------------------------

    schedulePrefetch() {
        this.cancelPrefetch();
        const nextPage = this.store.serverMeta.page + 1;
        if (nextPage > this.store.serverMeta.lastPage) {
            return;
        }
        const query = { ...this.store.query, page: nextPage };
        const sig = this.signatureOf(query);
        if (this.cache.has(sig)) {
            return;
        }
        const run = () => {
            this.idleHandle = null;
            // Prefetch silently into the cache; never touches the visible page or the seq.
            this.fetch(query)
                .then((page) => this.cache.set(sig, page))
                .catch(() => {});
        };
        this.idleHandle =
            typeof requestIdleCallback === 'function'
                ? requestIdleCallback(run, { timeout: 1200 })
                : setTimeout(run, 400);
    }

    cancelPrefetch() {
        if (this.idleHandle == null) {
            return;
        }
        if (typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(this.idleHandle);
        } else {
            clearTimeout(this.idleHandle);
        }
        this.idleHandle = null;
    }

    destroy() {
        this.cancelPrefetch();
        this.cache.clear();
    }
}
