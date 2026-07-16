/**
 * What: The saved-views client service (readonly ->query() grids with ->savedViews()) —
 *       captures the operator's CURRENT view state (search, filters, sort, per-page, column
 *       width overrides + hidden set), applies a recalled view, and bridges the three
 *       gridViews* RPCs for the toolbar's Views menu.
 * Why:  Applying a view must never invent a second data path: the query half goes through
 *       PageSource.load (the same whitelisted fetch/cache/stale pipeline as every sort or
 *       filter change), and the layout half rides the store's operator-layout state + the
 *       single GridCore relayout callback the column chooser already uses. The state shape is
 *       server-sanitized on save, so whatever comes back is replayable as-is.
 * When: Constructed by GridCore.installToolbar when layout.views is set and the grid has a
 *       live $wire + PageSource; consumed by Toolbar's Views control.
 */
export default class ViewsManager {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {object} wire the Livewire facade (gridViews/gridViewSave/gridViewDelete)
     * @param {import('../sync/PageSource').default} pageSource
     * @param {import('../persist/LayoutStore').default|null} layoutStore
     * @param {{onLayoutChanged?: () => void, announce?: (msg: string) => void}} [hooks]
     */
    constructor(store, wire, pageSource, layoutStore, hooks = {}) {
        this.store = store;
        this.wire = wire;
        this.pageSource = pageSource;
        this.layoutStore = layoutStore || null;
        this.onLayoutChanged = hooks.onLayoutChanged || (() => {});
        this.announce = hooks.announce || (() => {});
    }

    /** The operator's current view state — exactly the whitelisted shape the server stores. */
    capture() {
        const query = this.store.query || {};
        return {
            search: query.search || '',
            sort: query.sort || null,
            dir: query.dir === 'desc' ? 'desc' : 'asc',
            filters: { ...(query.filters || {}) },
            perPage: query.perPage || this.store.serverMeta.perPage,
            widths: { ...this.store.widthOverrides },
            hidden: [...this.store.userHidden],
        };
    }

    /**
     * Apply a saved state: column layout first (widths/hidden adopt wholesale, persisted so a
     * reload keeps them, then the one relayout path), then the query through PageSource — a
     * normal page-1 load, so caching, the stale-guard and the loading overlay all behave as
     * for any filter change.
     *
     * @param {object} state the server-sanitized view state
     */
    apply(state) {
        const s = state || {};

        this.store.widthOverrides = { ...(s.widths || {}) };
        this.store.userHidden = new Set(Array.isArray(s.hidden) ? s.hidden : []);
        if (this.layoutStore && this.layoutStore.enabled()) {
            this.layoutStore.save(this.store.widthOverrides, [...this.store.userHidden]);
        }
        this.onLayoutChanged();

        const def = (this.store.layout && this.store.layout.defaultSort) || null;
        this.pageSource.load({
            sort: s.sort || (def ? def.col : null),
            dir: s.sort ? (s.dir === 'desc' ? 'desc' : 'asc') : (def ? def.dir : 'asc'),
            search: s.search || '',
            filters: { ...(s.filters || {}) },
            page: 1,
            perPage: s.perPage || this.store.query.perPage,
        });
    }

    /** @returns {Promise<Array<{id: string, name: string, state: object}>>} */
    list() {
        return this.wire.gridViews(this.store.name).then((r) => (r && r.views) || []);
    }

    /**
     * Save the CURRENT view under a name (same name = overwrite). Resolves to the refreshed list.
     * @param {string} name
     */
    save(name) {
        return this.wire
            .gridViewSave(this.store.name, name, this.capture())
            .then((r) => (r && r.views) || []);
    }

    /**
     * Delete a view by id. Resolves to the refreshed list.
     * @param {string} id
     */
    remove(id) {
        return this.wire
            .gridViewDelete(this.store.name, String(id))
            .then((r) => (r && r.views) || []);
    }
}
