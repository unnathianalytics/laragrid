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
import { el, toggleClass, cellDomId, cellMapKey, setText } from '../util/dom.js';
import { painterFor } from './CellPainters.js';

export default class BodyRenderer {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('./Layout').default} layout
     * @param {HTMLElement} bodyEl
     * @param {import('../core/EventBus').default} bus
     */
    constructor(store, layout, bodyEl, bus) {
        this.store = store;
        this.layout = layout;
        this.bodyEl = bodyEl;
        this.bus = bus;
        this.striped = !!(store.layout && store.layout.striped);
        const virtualizeAbove = store.layout && store.layout.virtualizeAbove;
        this.virtualThreshold = virtualizeAbove === 0 ? Number.POSITIVE_INFINITY
            : (Number(virtualizeAbove) || 750);
        this.overscan = 20;
        this.virtual = false;
        /** The mounted row window [windowStart, windowEnd) — every row when not virtual. */
        this.windowStart = -1;
        this.windowEnd = -1;
        this.scrollFrame = null;
        this.printing = false;
        /**
         * Cached row pitch in px (rowHeightPx reads two computed styles). Dropped whenever the
         * Layout reports a metrics change (density/theme class write, container resize).
         * @type {number|null}
         */
        this.rowHeight = null;
        /** The virtual spacers above and below the mounted window (null when absent). */
        this.topSpacer = null;
        this.bottomSpacer = null;
        /** @type {Map<string, HTMLElement>} row element by `_k` (row-level addressing). */
        this.rowElByKey = new Map();
        /** @type {Map<string, HTMLElement>} cell element by cellMapKey(rowKey,colKey). */
        this.cellElByKey = new Map();

        this.onScroll = () => this.scheduleVirtualWindow();
        if (typeof this.layout.onMetricsChanged === 'function') {
            this.offMetrics = this.layout.onMetricsChanged(() => this.invalidateRowHeight());
        }
        this.onBeforePrint = () => {
            if (this.virtual) {
                this.printing = true;
                this.render();
            }
        };
        this.onAfterPrint = () => {
            if (this.printing) {
                this.printing = false;
                this.render();
            }
        };
        if (this.layout.refs.scroll) {
            this.layout.refs.scroll.addEventListener('scroll', this.onScroll, { passive: true });
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeprint', this.onBeforePrint);
            window.addEventListener('afterprint', this.onAfterPrint);
        }
    }

    render() {
        const columns = this.store.visibleColumns();
        const rows = this.store.rows;
        this.virtual = !this.printing && rows.length > this.virtualThreshold;
        if (this.virtual) {
            const bounds = this.virtualBounds();
            this.renderRange(bounds.start, bounds.end, columns);
            return;
        }

        const frag = document.createDocumentFragment();
        this.rowElByKey.clear();
        this.cellElByKey.clear();
        this.windowStart = 0;
        this.windowEnd = rows.length;
        this.topSpacer = null;
        this.bottomSpacer = null;

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

    rowHeightPx() {
        if (this.rowHeight !== null) {
            return this.rowHeight;
        }
        this.rowHeight = this.measureRowHeight();
        return this.rowHeight;
    }

    measureRowHeight() {
        if (typeof getComputedStyle !== 'function') {
            return 24;
        }
        const rootStyle = getComputedStyle(this.layout.refs.root);
        const token = rootStyle.getPropertyValue('--lgrid-row-h').trim();
        const amount = parseFloat(token) || 1.5;
        if (token.endsWith('px')) {
            return amount;
        }
        const font = typeof document !== 'undefined'
            ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
            : 16;
        return amount * font;
    }

    /** Forget the cached row pitch (density/theme class change, container resize). */
    invalidateRowHeight() {
        this.rowHeight = null;
    }

    /**
     * The viewport in row terms: the first row index under the scroll position, how many rows
     * fit, and the metrics that produced them.
     */
    viewportRows() {
        const height = this.rowHeightPx();
        const scroll = this.layout.refs.scroll;
        const viewport = scroll ? scroll.clientHeight : height * 30;
        const visible = Math.max(1, Math.ceil(viewport / height));
        const headHeight = this.layout.refs.head ? this.layout.refs.head.offsetHeight || 0 : 0;
        const top = Math.max(0, (scroll ? scroll.scrollTop : 0) - headHeight);
        const first = Math.floor(top / height);
        return { first, last: first + visible - 1, visible, height, viewport, headHeight };
    }

    /**
     * The row window the CURRENT scroll position produces (overscan on both sides). With a
     * `centerIndex` (no scroll box to position — tests, detached mounts) the window is centred
     * on that row instead.
     */
    virtualBounds(centerIndex = null) {
        const rows = this.store.rows.length;
        const { first, visible } = this.viewportRows();
        const from = centerIndex !== null ? centerIndex - Math.floor(visible / 2) : first;
        const start = Math.max(0, Math.min(rows, from - this.overscan));
        const end = Math.min(rows, start + visible + (this.overscan * 2));
        return { start, end };
    }

    /**
     * Position the scroll box so row `index` sits mid-viewport. Set BEFORE the window is
     * computed, so the window built is the one this scroll position produces — the scroll
     * event that follows then finds its window already mounted (one render per jump).
     */
    scrollToRow(index) {
        const scroll = this.layout.refs.scroll;
        if (!scroll) {
            return false;
        }
        const { height, viewport, headHeight } = this.viewportRows();
        const centre = Math.max(0, Math.floor((viewport - height) / 2));
        scroll.scrollTop = Math.max(0, headHeight + (index * height) - centre);
        return true;
    }

    /** Full build of rows [start, end) between two spacers (the initial virtual paint). */
    renderRange(start, end, columns = this.store.visibleColumns()) {
        const frag = document.createDocumentFragment();
        const height = this.rowHeightPx();
        this.rowElByKey.clear();
        this.cellElByKey.clear();
        this.windowStart = start;
        this.windowEnd = end;
        this.topSpacer = null;
        this.bottomSpacer = null;

        if (start > 0) {
            this.topSpacer = this.spacer(start * height);
            frag.appendChild(this.topSpacer);
        }
        for (let index = start; index < end; index++) {
            frag.appendChild(this.buildRow(this.store.rows[index], index, columns));
        }
        if (end < this.store.rows.length) {
            this.bottomSpacer = this.spacer((this.store.rows.length - end) * height);
            frag.appendChild(this.bottomSpacer);
        }
        this.bodyEl.textContent = '';
        this.bodyEl.appendChild(frag);
    }

    /**
     * Move the mounted window to [start, end) by DELTA: rows that leave are removed, rows that
     * enter are built and inserted before/after the kept block, the two spacers are resized.
     * rowElByKey / cellElByKey receive only the delta and stay sized to the mounted rows. A
     * kept row's aria-rowindex and stripe class are already right (its index did not change).
     *
     * @returns {{added: string[], removed: string[]}} the row keys that entered and left
     */
    shiftWindow(start, end, columns = this.store.visibleColumns()) {
        const rows = this.store.rows;
        const oldStart = this.windowStart;
        const oldEnd = this.windowEnd;
        if (oldStart < 0 || oldEnd <= oldStart || end <= oldStart || start >= oldEnd) {
            // No window yet, or no overlap: a full range build is the delta.
            const before = new Set(this.rowElByKey.keys());
            this.renderRange(start, end, columns);
            const added = [];
            const removed = [];
            for (const key of this.rowElByKey.keys()) {
                if (!before.delete(key)) {
                    added.push(key);
                }
            }
            for (const key of before) {
                removed.push(key);
            }
            return { added, removed };
        }

        const height = this.rowHeightPx();
        const removed = [];
        const added = [];
        const drop = (index) => {
            const row = rows[index];
            const key = row && row._k;
            const rowEl = key !== undefined ? this.rowElByKey.get(key) : null;
            if (!rowEl) {
                return;
            }
            this.unregisterRow(key, columns);
            this.bodyEl.removeChild(rowEl);
            removed.push(key);
        };
        for (let index = oldStart; index < Math.min(oldEnd, start); index++) {
            drop(index);
        }
        for (let index = Math.max(oldStart, end); index < oldEnd; index++) {
            drop(index);
        }

        if (start < oldStart) {
            const frag = document.createDocumentFragment();
            for (let index = start; index < oldStart; index++) {
                frag.appendChild(this.buildRow(rows[index], index, columns));
                added.push(rows[index]._k);
            }
            const firstKept = this.rowElByKey.get(rows[oldStart]._k) || this.bottomSpacer || null;
            this.bodyEl.insertBefore(frag, firstKept);
        }
        if (end > oldEnd) {
            const frag = document.createDocumentFragment();
            for (let index = Math.max(oldEnd, start); index < end; index++) {
                frag.appendChild(this.buildRow(rows[index], index, columns));
                added.push(rows[index]._k);
            }
            this.bodyEl.insertBefore(frag, this.bottomSpacer || null);
        }

        this.windowStart = start;
        this.windowEnd = end;
        this.setSpacers(start, end, height);
        return { added, removed };
    }

    /** Size (create/remove) the two spacers for a window [start, end). */
    setSpacers(start, end, height) {
        const rows = this.store.rows.length;
        if (start > 0) {
            if (!this.topSpacer) {
                this.topSpacer = this.spacer(0);
                this.bodyEl.insertBefore(this.topSpacer, this.bodyEl.firstChild || null);
            }
            this.topSpacer.style.height = (start * height) + 'px';
        } else if (this.topSpacer) {
            this.bodyEl.removeChild(this.topSpacer);
            this.topSpacer = null;
        }
        if (end < rows) {
            if (!this.bottomSpacer) {
                this.bottomSpacer = this.spacer(0);
                this.bodyEl.appendChild(this.bottomSpacer);
            }
            this.bottomSpacer.style.height = ((rows - end) * height) + 'px';
        } else if (this.bottomSpacer) {
            this.bodyEl.removeChild(this.bottomSpacer);
            this.bottomSpacer = null;
        }
    }

    /**
     * Whether a row insert/remove can be applied to the mounted DOM in place. Not while virtual
     * (the window shift owns that DOM), not with pad rows (they are recomputed per render), not
     * before the first render, and not when the row count crosses the virtual threshold.
     */
    canMutateInPlace() {
        const padTo = (this.store.layout && this.store.layout.padRows) || 0;
        return !this.virtual && !this.printing && padTo === 0 && this.windowStart >= 0
            && this.store.rows.length <= this.virtualThreshold;
    }

    /**
     * Insert the rows now at store indexes [index, index + keys.length) into the DOM, then
     * restamp the rows after them (aria-rowindex, stripe, serial ordinal).
     * @returns {boolean} false when the body declined (caller falls back to a full render)
     */
    insertRowsAt(keys, index) {
        if (!this.canMutateInPlace()) {
            return false;
        }
        const rows = this.store.rows;
        const columns = this.store.visibleColumns();
        const frag = document.createDocumentFragment();
        for (let i = 0; i < keys.length; i++) {
            const row = rows[index + i];
            if (!row || row._k !== keys[i]) {
                return false; // the store and the delta disagree — rebuild instead
            }
            frag.appendChild(this.buildRow(row, index + i, columns));
        }
        const after = rows[index + keys.length];
        const ref = after ? this.rowElByKey.get(after._k) || null : null;
        this.bodyEl.insertBefore(frag, ref);
        this.restampRows(index + keys.length, columns);
        return true;
    }

    /**
     * Remove rows by key from the DOM (they are already gone from the store), then restamp
     * the rows from the first removed index on.
     * @returns {boolean}
     */
    removeRows(keys, index) {
        if (!this.canMutateInPlace()) {
            return false;
        }
        const columns = this.store.visibleColumns();
        for (const key of keys) {
            const rowEl = this.rowElByKey.get(key);
            if (rowEl) {
                this.unregisterRow(key, columns);
                this.bodyEl.removeChild(rowEl);
            }
        }
        this.restampRows(index, columns);
        return true;
    }

    /** Re-stamp index-derived row state (aria-rowindex, stripe, serial cell) from `from` on. */
    restampRows(from, columns) {
        const rows = this.store.rows;
        const serials = columns.filter((column) => column.painter === 'serial');
        for (let i = from; i < rows.length; i++) {
            const key = rows[i]._k;
            const rowEl = this.rowElByKey.get(key);
            if (!rowEl) {
                continue;
            }
            rowEl.setAttribute('aria-rowindex', String(i + 2));
            toggleClass(rowEl, 'lgrid-row--stripe', this.striped && i % 2 === 1);
            for (const column of serials) {
                setText(this.cellElByKey.get(cellMapKey(key, column.key)), i + 1);
            }
        }
        this.windowEnd = rows.length;
    }

    /** Drop a row (and its cells) from the element indexes. */
    unregisterRow(key, columns = this.store.visibleColumns()) {
        this.rowElByKey.delete(key);
        for (const column of columns) {
            this.cellElByKey.delete(cellMapKey(key, column.key));
        }
    }

    spacer(height) {
        const spacer = el('div', 'lgrid-virtual-spacer');
        spacer.style.height = height + 'px';
        spacer.setAttribute('aria-hidden', 'true');
        return spacer;
    }

    /**
     * Scroll handler (one rAF per burst): shift the window only when the viewport nears the
     * edge of the buffer — the inner half of the overscan on each side is a dead band, so a
     * one-row scroll builds nothing.
     */
    scheduleVirtualWindow() {
        if (!this.virtual || this.scrollFrame !== null) {
            return;
        }
        const request = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (callback) => setTimeout(callback, 0);
        this.scrollFrame = request(() => {
            this.scrollFrame = null;
            if (!this.virtual) {
                return;
            }
            const { first, last } = this.viewportRows();
            const margin = Math.floor(this.overscan / 2);
            const rows = this.store.rows.length;
            const nearTop = first < this.windowStart + margin && this.windowStart > 0;
            const nearBottom = last > this.windowEnd - 1 - margin && this.windowEnd < rows;
            if (!nearTop && !nearBottom) {
                return;
            }
            const { start, end } = this.virtualBounds();
            if (start === this.windowStart && end === this.windowEnd) {
                return;
            }
            this.bus.emit('body:will-render');
            const delta = this.shiftWindow(start, end);
            this.bus.emit('body:did-render');
            this.bus.emit('body:window-rendered', delta);
        });
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

    ensureCellElFor(rowKey, colKey) {
        const cell = this.cellElFor(rowKey, colKey);
        if (cell || !this.virtual) {
            return cell;
        }
        const hit = this.store.rowByKey.get(rowKey);
        if (!hit) {
            return null;
        }
        // Jump: scroll first, then build the window that scroll position produces — so the
        // scroll event this raises finds its window already mounted (one render per jump).
        const { start, end } = this.scrollToRow(hit.index)
            ? this.virtualBounds()
            : this.virtualBounds(hit.index);
        this.bus.emit('body:will-render');
        const delta = this.shiftWindow(start, end);
        this.bus.emit('body:did-render');
        this.bus.emit('body:window-rendered', delta);
        return this.cellElFor(rowKey, colKey);
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

    destroy() {
        if (this.layout.refs.scroll) {
            this.layout.refs.scroll.removeEventListener('scroll', this.onScroll);
        }
        if (this.offMetrics) {
            this.offMetrics();
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeprint', this.onBeforePrint);
            window.removeEventListener('afterprint', this.onAfterPrint);
        }
        if (this.scrollFrame !== null) {
            const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
            cancel(this.scrollFrame);
        }
    }
}
