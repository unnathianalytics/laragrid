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
        let count = 0;
        let numericCount = 0;
        let sum = 0;
        let format = null;

        // Walk the selection rectangle in place (no 2-D cell array): a 700 x 10 range is read
        // on every Shift+Arrow, so the per-cell work is one property read.
        const sel = this.store.selection;
        let r0;
        let r1;
        let c0;
        let c1;
        if (sel) {
            ({ r0, r1, c0, c1 } = sel);
        } else {
            const a = this.store.indexOf(this.store.active);
            if (a.row < 0 || a.col < 0) {
                return { count, numericCount, sum, format };
            }
            r0 = a.row;
            r1 = a.row;
            c0 = a.col;
            c1 = a.col;
        }
        const rows = this.store.rows;
        const cols = this.store.visibleColumns();
        r1 = Math.min(r1, rows.length - 1);
        c1 = Math.min(c1, cols.length - 1);

        for (let r = Math.max(0, r0); r <= r1; r++) {
            const row = rows[r];
            for (let c = Math.max(0, c0); c <= c1; c++) {
                const column = cols[c];
                count++;
                if (!column.selectableNumeric) {
                    continue;
                }
                const value = row[column.key];
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
