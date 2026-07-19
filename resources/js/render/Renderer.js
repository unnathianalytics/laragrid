/**
 * What: Orchestrates the three sub-renderers (header, body, footer) into a full paint of the
 *       grid from the store.
 * Why:  A single conductor keeps the paint order and the "where does each piece live" mapping
 *       in one place (plan §2.4 Renderer). In M1 it paints once on init and repaints the body
 *       when the store's rows change (the seam PageSource/draft rows use at M3); header/footer
 *       are stable for a given definition so they paint once.
 * When: Constructed by GridCore; paint() runs inside $nextTick after the store + layout exist.
 */
import HeaderRenderer from './HeaderRenderer.js';
import BodyRenderer from './BodyRenderer.js';
import FooterRenderer from './FooterRenderer.js';

export default class Renderer {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('./Layout').default} layout
     * @param {{head: HTMLElement, body: HTMLElement, footer: HTMLElement}} refs
     * @param {import('../core/EventBus').default} bus
     */
    constructor(store, layout, refs, bus) {
        this.store = store;
        this.layout = layout;
        this.bus = bus;
        this.header = new HeaderRenderer(store, layout, refs.head);
        this.body = new BodyRenderer(store, layout, refs.body);
        this.footer = new FooterRenderer(store, layout, refs.footer);

        // Repaint the body when rows are replaced (initial load today; server pages M3+; and any
        // structural row op — insert/remove/dup/fill — in M4, which reuses this same seam).
        this.unsubscribe = bus.on('rows:changed', () => this.renderBody());
        // M4: repaint just the changed cells (a set + its formula write-backs) without a body
        // rebuild — the cell-level hot path. Each entry is {rowKey, colKey}. A changed cell
        // whose column CONTROLS sibling locks (lockedWhen) also repaints those siblings, so
        // their locked look tracks the controlling value (e.g. a D/C flip re-mutes the amounts)
        // — purely visual, no store/sync bookkeeping rides on the extra repaints.
        this.unsubscribeCells = bus.on('cells:changed', ({ cells }) => {
            (cells || []).forEach(({ rowKey, colKey }) => {
                this.body.repaintCell(rowKey, colKey);
                this.store.lockedDependentsOf(colKey).forEach((dependentKey) => {
                    this.body.repaintCell(rowKey, dependentKey);
                });
            });
        });
        // On a server page change (M3), refresh the footer totals + header sort indicators. The
        // body itself is repainted by the rows:changed above; here we only touch the chrome.
        this.unsubscribePage = bus.on('page:changed', () => {
            this.footer.render();
            this.header.updateSortIndicators();
            this.header.updateFilterIndicators();
        });

        // F9 hide / Shift+F9 restore (display grids): the body repaint rides rows:changed
        // as usual; the footer must ALSO repaint, because its aggregates switch between
        // the baked full-set values and the visible-rows recompute.
        this.unsubscribeHidden = bus.on('rows:hidden', () => this.footer.render());
    }

    paint() {
        this.header.render();
        this.header.updateSortIndicators();
        this.header.updateFilterIndicators();
        this.renderBody();
        this.footer.render();
    }

    /**
     * Render the body wrapped in will/did events so the dev-mode morph guard can distinguish our
     * own body mutations from an external Livewire morph leaking into the wire:ignore region (R3).
     */
    renderBody() {
        this.bus.emit('body:will-render');
        this.body.render();
        this.bus.emit('body:did-render');
    }

    /**
     * Resolve the cell element at a stable (rowKey, colKey) address — the O(1) seam the M2
     * SelectionPainter and active-cell scroller use to touch a single cell without a re-render.
     * @param {string} rowKey
     * @param {string} colKey
     * @returns {HTMLElement|null}
     */
    cellElFor(rowKey, colKey) {
        return this.body.cellElFor(rowKey, colKey);
    }

    /**
     * Repaint one cell in place (M4) — the O(1) seam the editor/store use after an optimistic set.
     * @param {string} rowKey
     * @param {string} colKey
     */
    repaintCell(rowKey, colKey) {
        return this.body.repaintCell(rowKey, colKey);
    }

    destroy() {
        if (this.unsubscribe) {
            this.unsubscribe();
        }
        if (this.unsubscribeCells) {
            this.unsubscribeCells();
        }
        if (this.unsubscribeHidden) {
            this.unsubscribeHidden();
        }
        if (this.unsubscribePage) {
            this.unsubscribePage();
        }
    }
}
