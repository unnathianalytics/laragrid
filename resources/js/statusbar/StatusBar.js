/**
 * What: The Excel-style status bar — shows Count, Sum and Avg for the numeric cells in the
 *       current selection, formatted with the same formatter the cells use. Count always
 *       reflects the number of selected cells; Sum/Avg appear only when the selection contains
 *       summable-numeric cells (columns flagged selectableNumeric server-side).
 * Why:  Accountants verify a register by eye-summing a column constantly; giving them a live
 *       Sum·Count·Avg with zero round-trips is the §1.4 improvement the plan folds into M2. It
 *       reuses format/formatters.js so a Sum reads in INR exactly like the cells above it — no
 *       new formatting logic, no drift surface.
 * When: Constructed by GridCore only when config.layout.statusBar is true; subscribes to
 *       selection:changed.
 *
 * NOTE: A selection spanning columns of different units (e.g. paise amounts AND scale-3 qty)
 * has no single meaningful Sum; the bar sums all numeric cells and formats the total with the
 * FIRST numeric column's format. In practice a status-bar sum is used on one column at a time,
 * where this is exactly correct.
 */
import { formatValue } from '../format/formatters.js';
import { el, setText } from '../util/dom.js';

export default class StatusBar {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../core/EventBus').default} bus
     * @param {HTMLElement} barEl the x-ref="statusbar" container
     */
    constructor(store, bus, barEl) {
        this.store = store;
        this.bus = bus;
        this.barEl = barEl;
        this.sub = bus.on('selection:changed', () => this.render());
    }

    destroy() {
        if (this.sub) {
            this.sub();
        }
    }

    /**
     * Aggregate the selection: total selected cells, and Sum/Avg over the numeric ones.
     * @returns {{count: number, numericCount: number, sum: number, format: object|null}}
     */
    aggregate() {
        const grid = this.store.selectedCells();
        let count = 0;
        let numericCount = 0;
        let sum = 0;
        let format = null;

        for (const cells of grid) {
            for (const { column, value } of cells) {
                count++;
                if (!column.selectableNumeric) {
                    continue;
                }
                const num = Number(value);
                if (value === null || value === undefined || value === '' || Number.isNaN(num)) {
                    continue;
                }
                if (format === null) {
                    format = column.format || null;
                }
                sum += num;
                numericCount++;
            }
        }
        return { count, numericCount, sum, format };
    }

    render() {
        const { count, numericCount, sum, format } = this.aggregate();

        this.barEl.textContent = '';
        if (count === 0) {
            this.barEl.hidden = true;
            return;
        }
        this.barEl.hidden = false;

        // Count is always meaningful.
        this.barEl.appendChild(this.segment('Count', String(count)));

        if (numericCount > 0) {
            this.barEl.appendChild(this.segment('Sum', formatValue(format, sum)));
            const avg = sum / numericCount;
            // Avg of paise is fractional paise; formatValue truncates paise for inr, which is
            // acceptable for a glance figure. Qty/number formats round to their scale.
            this.barEl.appendChild(this.segment('Avg', formatValue(format, avg)));
        }
    }

    /** One labelled status-bar segment (semantic classes only). */
    segment(label, value) {
        const seg = el('div', 'lgrid-status-seg');
        seg.appendChild(el('span', 'lgrid-status-label', label));
        const v = el('span', 'lgrid-status-value');
        setText(v, value);
        seg.appendChild(v);
        return seg;
    }
}
