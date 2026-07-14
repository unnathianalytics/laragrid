/**
 * What: Builds the row/cell DOM for the grid body from the store, dispatching each cell to
 *       its column painter, applying stripe/frozen/alignment classes and any server-resolved
 *       row/cell classes. Each cell carries a stable id + address dataset + ARIA grid roles so
 *       the M2 keyboard/selection layer can address a cell without a DOM scan.
 * Why:  This is the client-rendered body that lives inside `wire:ignore` — Livewire never
 *       renders or morphs a cell (plan §2.1, R3 solved by avoidance, proven in M0). Building
 *       into a DocumentFragment and one append keeps the 1k-row paint a single layout pass
 *       (the M0 spike's measured pattern). Cells are `textContent` by default; `html` is an
 *       explicit per-column opt-in (G13). The cell-element index (by rowKey+colKey) is the O(1)
 *       lookup SelectionPainter uses to toggle state classes on individual cells without a
 *       re-render (plan §2.4 Renderer / §1.3 G20 ARIA grid pattern).
 * When: Called by Renderer on paint (and on setRows via the store's change event, M3+).
 */
import { el, toggleClass, cellDomId, cellMapKey } from '../util/dom.js';
import { painterFor } from './CellPainters.js';

export default class BodyRenderer {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('./Layout').default} layout
     * @param {HTMLElement} bodyEl
     */
    constructor(store, layout, bodyEl) {
        this.store = store;
        this.layout = layout;
        this.bodyEl = bodyEl;
        this.striped = !!(store.layout && store.layout.striped);
        /** @type {Map<string, HTMLElement>} row element by `_k` (row-level addressing). */
        this.rowElByKey = new Map();
        /** @type {Map<string, HTMLElement>} cell element by cellMapKey(rowKey,colKey). */
        this.cellElByKey = new Map();
    }

    render() {
        const columns = this.store.visibleColumns();
        const rows = this.store.rows;
        const frag = document.createDocumentFragment();
        this.rowElByKey.clear();
        this.cellElByKey.clear();

        for (let r = 0; r < rows.length; r++) {
            frag.appendChild(this.buildRow(rows[r], r, columns));
        }

        // Busy-style dedicated entry rows (layout.padRows): pad the body to at least N visible
        // rows with inert blanks so editor popups open over grid space, not the page chrome
        // below a short grid. Recomputed on every body render, so the pad shrinks as real rows
        // grow (auto-append keeps the visible row count constant until rows exceed the pad).
        const padTo = (this.store.layout && this.store.layout.padRows) || 0;
        for (let p = rows.length; p < padTo; p++) {
            frag.appendChild(this.buildPadRow(p, columns));
        }

        this.bodyEl.textContent = '';
        this.bodyEl.appendChild(frag);
    }

    buildRow(row, index, columns) {
        const rowEl = el('div', 'lgrid-row');
        rowEl.dataset.k = row._k;
        rowEl.setAttribute('role', 'row');
        // 1-based, and offset by the header row so AT reads a stable document position.
        rowEl.setAttribute('aria-rowindex', String(index + 2));
        toggleClass(rowEl, 'lgrid-row--stripe', this.striped && index % 2 === 1);
        if (row._rowClass) {
            rowEl.classList.add(row._rowClass);
        }

        const cellClasses = row._cellClass || null;

        columns.forEach((column, colIndex) => {
            const cellEl = el('div', 'lgrid-cell');
            cellEl.setAttribute('role', 'gridcell');
            cellEl.setAttribute('aria-colindex', String(colIndex + 1));
            // Editable cells (M4) announce as editable; display/readonly cells stay read-only.
            cellEl.setAttribute('aria-readonly', column.editable ? 'false' : 'true');
            if (column.editable) {
                cellEl.classList.add('lgrid-cell--editable');
            }
            // Per-row declarative lock (lockedWhen): painted muted; the class tracks the
            // controlling value via repaintCell (Renderer repaints lock dependents).
            toggleClass(cellEl, 'lgrid-cell--locked', this.store.cellLocked(row, column));
            cellEl.dataset.c = column.key;
            cellEl.id = cellDomId(this.store.name, row._k, column.key);

            toggleClass(cellEl, 'lgrid-cell--right', column.align === 'right');
            toggleClass(cellEl, 'lgrid-cell--center', column.align === 'center');
            if (cellClasses && cellClasses[column.key]) {
                cellEl.classList.add(cellClasses[column.key]);
            }
            this.layout.applyFrozenTo(cellEl, colIndex);

            const painter = painterFor(column.painter);
            painter(cellEl, {
                value: this.store.cellValue(row, column),
                column,
                row,
                index,
            });

            rowEl.appendChild(cellEl);
            this.cellElByKey.set(cellMapKey(row._k, column.key), cellEl);
        });

        rowEl.appendChild(this.layout.fillerCell('cell'));

        this.rowElByKey.set(row._k, rowEl);
        return rowEl;
    }

    /**
     * One inert pad row (Busy's dedicated blank entry rows): the continued serial ordinal and
     * empty cells with the same stripe/frozen/alignment paint as a real row. Deliberately
     * carries NO row key, NO grid ARIA role, and is never registered in rowElByKey/cellElByKey —
     * the keyboard, selection, editing and clipboard layers address rows only through the store
     * and those maps, so a pad row is unreachable by construction (clicks resolve to an
     * undefined row key, which SelectionManager already treats as a no-op).
     * @param {number} index overall body position (continues the real rows' stripe/serial run)
     * @param {Array<object>} columns visible columns
     * @returns {HTMLElement}
     */
    buildPadRow(index, columns) {
        const rowEl = el('div', 'lgrid-row lgrid-row--pad');
        rowEl.setAttribute('aria-hidden', 'true');
        toggleClass(rowEl, 'lgrid-row--stripe', this.striped && index % 2 === 1);

        columns.forEach((column, colIndex) => {
            const cellEl = el('div', 'lgrid-cell lgrid-cell--pad');
            toggleClass(cellEl, 'lgrid-cell--right', column.align === 'right');
            toggleClass(cellEl, 'lgrid-cell--center', column.align === 'center');
            this.layout.applyFrozenTo(cellEl, colIndex);
            if (column.painter === 'serial') {
                cellEl.textContent = String(index + 1);
            }
            rowEl.appendChild(cellEl);
        });

        rowEl.appendChild(this.layout.fillerCell('cell'));
        return rowEl;
    }

    /**
     * Resolve the cell element at a (rowKey, colKey) address, or null. The O(1) seam the
     * SelectionPainter toggles state classes through without touching the rest of the grid.
     * @param {string} rowKey
     * @param {string} colKey
     * @returns {HTMLElement|null}
     */
    cellElFor(rowKey, colKey) {
        return this.cellElByKey.get(cellMapKey(rowKey, colKey)) || null;
    }

    /**
     * Repaint ONE cell's value in place (M4 hot path): re-run its column painter over the current
     * store value. O(1) — no row/body rebuild, so a cell edit + its formula write-backs touch only
     * the changed cells (plan §2.4 "cell-level repaint"). Returns the cell element (or null).
     * @param {string} rowKey
     * @param {string} colKey
     * @returns {HTMLElement|null}
     */
    repaintCell(rowKey, colKey) {
        const cellEl = this.cellElFor(rowKey, colKey);
        const hit = this.store.rowByKey.get(rowKey);
        const column = this.store.visibleColumns().find((c) => c.key === colKey);
        if (!cellEl || !hit || !column) {
            return null;
        }
        const painter = painterFor(column.painter);
        painter(cellEl, {
            value: this.store.cellValue(hit.row, column),
            column,
            row: hit.row,
            index: hit.index,
        });
        // Re-evaluate the per-row lock: the repaint may have been triggered by a change to the
        // CONTROLLING column (e.g. dc), which is exactly when the muted look must flip.
        toggleClass(cellEl, 'lgrid-cell--locked', this.store.cellLocked(hit.row, column));
        return cellEl;
    }
}
