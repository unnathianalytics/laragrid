/**
 * What: Read-only subscriber that paints the edit-state chrome — per-cell error ring + corner
 *       marker, per-cell dirty/pending shimmer, and a footer error count with a jump-to-first-error
 *       (Ctrl+E) — by toggling semantic state classes on the affected cells only (never a re-render).
 * Why:  Error/dirty feedback must be instant and cheap (plan G7). Like the SelectionPainter, this
 *       diffs the store's error/dirty/pending sets and toggles `lgrid-cell--error/--dirty/--pending`
 *       on just the changed cells, so 5k rows stay light. Errors block SAVE, not navigation
 *       (Excel-style) — this only visualises them; the host's save() consults the store. Ctrl+E
 *       jumps to the first errored cell so the operator can fix a batch quickly.
 * When: Constructed by GridCore for an editable grid; subscribes to the store's error/dirty events.
 */
import { toggleClass } from '../util/dom.js';
import { cellMapKey } from '../util/dom.js';

export default class ErrorPainter {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../render/Renderer').default} renderer
     * @param {import('../core/EventBus').default} bus
     * @param {{root: HTMLElement, errorCount?: HTMLElement}} refs
     */
    constructor(store, renderer, bus, refs) {
        this.store = store;
        this.renderer = renderer;
        this.bus = bus;
        this.refs = refs;

        this.offErrors = bus.on('errors:changed', () => this.paintErrors());
        this.offDirty = bus.on('dirty:changed', ({ rowKey, colKey }) => this.paintDirty(rowKey, colKey));
        this.offSync = bus.on('sync-state', () => this.paintPending());
        // Rows repainted (structural op / reconcile) → re-assert error/dirty classes on survivors.
        this.offRows = bus.on('rows:changed', () => this.reassert());

        this.onKeyDown = (e) => this.handleKey(e);
        this.refs.root.addEventListener('keydown', this.onKeyDown);
    }

    /** Ctrl+E → jump to the first errored cell. */
    handleKey(e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
            e.preventDefault();
            this.jumpToFirstError();
        }
    }

    /**
     * Toggle the error ring/corner on each cell from the store's error map. Iterates the visible
     * grid directly (the same shape paintPending uses) rather than reverse-deriving a cell from a
     * mapKey — the store owns the truth (errorFor), the painter just reflects it onto the cells.
     */
    paintErrors() {
        for (const row of this.store.rows) {
            for (const col of this.store.visibleColumns()) {
                const el = this.renderer.cellElFor(row._k, col.key);
                if (el) {
                    toggleClass(el, 'lgrid-cell--error', !!this.store.errorFor(row._k, col.key));
                }
            }
        }
        this.updateFooterCount();
    }

    paintDirty(rowKey, colKey) {
        const el = this.renderer.cellElFor(rowKey, colKey);
        if (el) {
            toggleClass(el, 'lgrid-cell--dirty', this.store.dirty.has(cellMapKey(rowKey, colKey)));
        }
    }

    /** Toggle pending shimmer on cells with an op in flight. */
    paintPending() {
        for (const row of this.store.rows) {
            for (const col of this.store.visibleColumns()) {
                const key = cellMapKey(row._k, col.key);
                const el = this.renderer.cellElFor(row._k, col.key);
                if (el) {
                    toggleClass(el, 'lgrid-cell--pending', this.store.pending.has(key));
                    toggleClass(el, 'lgrid-cell--dirty', this.store.dirty.has(key));
                }
            }
        }
    }

    /** Re-apply error/dirty classes after a full body repaint (rows:changed). */
    reassert() {
        this.paintErrors();
        this.paintPending();
    }

    updateFooterCount() {
        const count = this.store.errors.size;
        this.refs.root.classList.toggle('lgrid--has-errors', count > 0);
        if (this.refs.errorCount) {
            this.refs.errorCount.textContent = count > 0 ? String(count) : '';
            this.refs.errorCount.hidden = count === 0;
        }
    }

    /** Focus the first errored cell (Ctrl+E). */
    jumpToFirstError() {
        for (const row of this.store.rows) {
            for (const col of this.store.visibleColumns()) {
                if (this.store.errors.has(cellMapKey(row._k, col.key))) {
                    this.store.setActive({ rowKey: row._k, colKey: col.key });
                    return;
                }
            }
        }
    }

    destroy() {
        this.refs.root.removeEventListener('keydown', this.onKeyDown);
        if (this.offErrors) {
            this.offErrors();
        }
        if (this.offDirty) {
            this.offDirty();
        }
        if (this.offSync) {
            this.offSync();
        }
        if (this.offRows) {
            this.offRows();
        }
    }
}
