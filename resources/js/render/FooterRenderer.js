/**
 * What: Builds the footer aggregate row — one cell per column, filled with the formatted
 *       pre-computed total for any column that has an aggregate, blank otherwise.
 * Why:  Footers are how accountants verify a register at a glance, so totals sit directly
 *       under their column and read in the same format as the cells above. The values were
 *       computed authoritatively server-side (Aggregate::compute) and shipped in config;
 *       this renderer only formats + places them, sharing the same formatter table as the
 *       body (so a footer INR total looks identical to the cells). Frozen offsets are applied
 *       so the footer's first columns stay pinned with the body's.
 * When: Called by Renderer on paint when the grid declares any footer aggregate.
 */
import { formatValue } from '../format/formatters.js';
import { el, toggleClass, setText } from '../util/dom.js';

export default class FooterRenderer {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('./Layout').default} layout
     * @param {HTMLElement} footerEl
     */
    constructor(store, layout, footerEl) {
        this.store = store;
        this.layout = layout;
        this.footerEl = footerEl;
    }

    render() {
        const footer = this.store.footer || [];
        this.footerEl.textContent = '';

        if (footer.length === 0) {
            this.footerEl.hidden = true;
            return;
        }
        this.footerEl.hidden = false;

        const byColumn = new Map();
        for (const agg of footer) {
            byColumn.set(agg.column, agg);
        }

        this.store.visibleColumns().forEach((column, colIndex) => {
            const cellEl = el('div', 'lgrid-footcell');
            toggleClass(cellEl, 'lgrid-cell--right', column.align === 'right');
            toggleClass(cellEl, 'lgrid-cell--center', column.align === 'center');
            this.layout.applyFrozenTo(cellEl, colIndex);

            const agg = byColumn.get(column.key);
            if (agg) {
                // Server-side (M3): the authoritative grand total for the current filter set lives
                // in the store (refreshed on each page:changed). Editable (M4): the store's live
                // totals, reconciled from each op response (GridCore.applyFooter), falling back to
                // the config value before the first edit. In-memory display: the config value.
                let value;
                if (this.store.serverSide) {
                    value = this.store.grandTotals[column.key] ?? 0;
                } else if (this.store.hiddenStash && this.store.hiddenStash.size > 0
                    && (agg.op === 'sum' || agg.op === 'count')) {
                    // Rows are temporarily hidden (F9): baked/live totals describe the
                    // FULL set — recompute over the visible rows so the footer matches
                    // the operator's what-if view (the whole point of the hide).
                    value = this.store.localAggregate(agg);
                } else if (column.key in (this.store.pageTotals || {})) {
                    // Any in-memory grid: live totals from op responses (editable) or a
                    // host reseed (display) win over the initial config value.
                    value = this.store.pageTotals[column.key];
                } else {
                    value = agg.value;
                }
                setText(cellEl, formatValue(agg.format, value));
            }

            this.footerEl.appendChild(cellEl);
        });

        this.footerEl.appendChild(this.layout.fillerCell('footcell'));
    }
}
