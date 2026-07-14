/**
 * What: The selection/navigation COMMAND surface. It interprets high-level intents (move, extend,
 *       select row/column/all, collapse, click, shift-click) into concrete active-cell + selection
 *       mutations on the StateStore, doing the index arithmetic through util/geometry against the
 *       store's navigability mask. It also owns the delegated `pointerdown` on the grid root for
 *       mouse selection (cell click, shift-click range, header→column, gutter→row).
 * Why:  Plan §2.4/D7: the StateStore is the single mutable state and only emits changes; the
 *       manager decides WHAT to set so KeyboardManager and the mouse both funnel through one
 *       place. Keeping the geometry in util/geometry (vector-tested) means this file is pure
 *       orchestration — no boundary/skip math inline.
 * When: Constructed by GridCore; KeyboardManager calls its move/extend/select methods; the root
 *       pointerdown listener it installs handles mouse selection.
 */
import { resolveMove, firstNavigable, lastNavigable } from '../util/geometry.js';

export default class SelectionManager {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {{root: HTMLElement, scroll: HTMLElement, body: HTMLElement, head: HTMLElement}} refs
     */
    constructor(store, refs) {
        this.store = store;
        this.refs = refs;
        this.onPointerDown = this.handlePointerDown.bind(this);
    }

    /** Install the delegated mouse-selection listener. */
    init() {
        this.refs.root.addEventListener('pointerdown', this.onPointerDown);
    }

    destroy() {
        this.refs.root.removeEventListener('pointerdown', this.onPointerDown);
    }

    // ---- Active-cell bootstrap -----------------------------------------------------------

    /** True once an active cell exists. */
    hasActive() {
        return !!this.store.active;
    }

    /**
     * Ensure there is an active cell — used when the grid first gains focus with no selection.
     * Lands on the first navigable cell of the first row.
     */
    ensureActive() {
        if (this.store.active) {
            return;
        }
        const mask = this.store.navigabilityMask();
        const col = firstNavigable(mask);
        if (col < 0 || this.store.rowCount() === 0) {
            return;
        }
        const addr = this.store.addressAt(0, col);
        if (addr) {
            this.store.setActive(addr);
        }
    }

    // ---- Keyboard-driven commands --------------------------------------------------------

    /**
     * Intents whose landing must HOP OVER per-row locked cells (lockedWhen): the horizontal/
     * serpentine entry flow. Vertical and jump intents may still land on a locked cell — it is
     * inert (no editor), not invisible, so arrows/clicks can inspect it.
     * @type {Set<string>}
     */
    static LOCK_SKIPPING_INTENTS = new Set(['left', 'right', 'nextWrap', 'prevWrap']);

    /**
     * Move the active cell by a geometry intent, collapsing any range to the new single cell.
     * Horizontal/wrap intents re-resolve past locked landings (the D/C-gated amount cell is
     * never a serpentine stop), staying put when no unlocked landing exists.
     * @param {string} intent
     * @returns {'next'|'prev'|null} a boundary-escape signal (Tab/Enter off the grid edge), else null
     */
    move(intent) {
        this.ensureActive();
        if (!this.store.active) {
            return null;
        }
        let next = this.resolve(intent);
        if (SelectionManager.LOCK_SKIPPING_INTENTS.has(intent)) {
            next = this.skipLocked(intent, next);
            if (!next) {
                return null; // pinned at a boundary behind locked cells — stay put
            }
        }
        if (next.escape) {
            return next.escape;
        }
        const addr = this.store.addressAt(next.row, next.col);
        if (addr) {
            this.store.setActive(addr);
        }
        return null;
    }

    /**
     * Re-resolve a movement past locked landings: while the landing cell is locked for its row,
     * step again with the same intent FROM the landing. Terminates on an unlocked cell, a
     * boundary escape, or no progress (returns null — the caller should not move at all rather
     * than park the operator on an untypable cell).
     *
     * @param {string} intent
     * @param {{row: number, col: number, escape?: string}} next the first resolved landing
     * @returns {{row: number, col: number, escape?: string}|null}
     */
    skipLocked(intent, next) {
        let guard = this.store.rowCount() * this.store.visibleColumns().length + 1;
        let landing = next;
        while (guard-- > 0) {
            if (landing.escape) {
                return landing;
            }
            const row = this.store.rowAt(landing.row);
            const column = this.store.columnAt(landing.col);
            if (!row || !column || !this.store.cellLocked(row, column)) {
                return landing;
            }
            const following = this.resolveFrom(intent, landing.row, landing.col);
            if (!following.escape && following.row === landing.row && following.col === landing.col) {
                return null; // blocked at the edge on a locked cell
            }
            landing = following;
        }
        return landing;
    }

    /**
     * Extend the selection to a new active cell (Shift+arrows) — anchor stays put.
     * @param {string} intent
     */
    extend(intent) {
        this.ensureActive();
        if (!this.store.active) {
            return;
        }
        const next = this.resolve(intent);
        // Extension ignores boundary-escape: it just clamps (Shift+Right at the edge stays put).
        const addr = this.store.addressAt(next.row, next.col);
        if (addr) {
            this.store.setActive(addr, { keepAnchor: true, kind: 'range' });
        }
    }

    /** Resolve a geometry intent from the current active cell. */
    resolve(intent) {
        const { row, col } = this.store.indexOf(this.store.active);
        return this.resolveFrom(intent, row, col);
    }

    /** Resolve a geometry intent from an explicit position (the lock-skip re-resolve seam). */
    resolveFrom(intent, row, col) {
        return resolveMove({
            intent,
            row,
            col,
            rowCount: this.store.rowCount(),
            mask: this.store.navigabilityMask(),
            page: this.pageSize(),
        });
    }

    /** Rows per PgUp/PgDn — the visible row count in the scroll viewport (min 1). */
    pageSize() {
        const scroll = this.refs.scroll;
        const rowH = scroll
            ? parseFloat(getComputedStyle(this.refs.root).getPropertyValue('--lgrid-row-h')) || 0
            : 0;
        // --lgrid-row-h is in rem; convert via root font-size. Fall back to a sane page.
        const px = rowH * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
        if (scroll && px > 0) {
            return Math.max(1, Math.floor(scroll.clientHeight / px) - 1);
        }
        return 20;
    }

    /** Select every navigable cell (Ctrl+A). Active stays where it is (or first cell). */
    selectAll() {
        this.ensureActive();
        const mask = this.store.navigabilityMask();
        const c0 = firstNavigable(mask);
        const c1 = lastNavigable(mask);
        const lastRow = Math.max(0, this.store.rowCount() - 1);
        if (c0 < 0 || this.store.rowCount() === 0) {
            return;
        }
        const anchor = this.store.addressAt(0, c0);
        const active = this.store.active || anchor;
        this.store.setSelectionRect({ r0: 0, r1: lastRow, c0, c1 }, 'all', active, anchor);
    }

    /** Collapse a range back to the single active cell (Esc). */
    collapse() {
        this.store.collapseSelection();
    }

    // ---- Mouse selection -----------------------------------------------------------------

    /**
     * Delegated pointerdown: a body cell click sets/【shift-】extends the active cell; a header
     * cell click selects the whole column; a serial-gutter cell click selects the whole row.
     */
    handlePointerDown(e) {
        // Header cell → column selection.
        const headCell = e.target.closest('.lgrid-headcell');
        if (headCell && this.refs.head.contains(headCell)) {
            const colKey = this.columnKeyFromHeadCell(headCell);
            if (colKey) {
                this.selectColumn(colKey);
            }
            return;
        }

        const cell = e.target.closest('.lgrid-cell');
        if (!cell || !this.refs.body.contains(cell)) {
            return;
        }
        const rowEl = cell.closest('.lgrid-row');
        if (!rowEl) {
            return;
        }
        const rowKey = rowEl.dataset.k;
        const colKey = cell.dataset.c;
        const column = this.store.visibleColumns().find((c) => c.key === colKey);

        // Serial gutter (non-navigable) → row selection.
        if (!column || column.navigable === false) {
            this.selectRow(rowKey);
            return;
        }

        const addr = { rowKey, colKey };
        if (e.shiftKey && this.store.active) {
            // Extend the current selection to the clicked cell.
            this.store.setActive(addr, { keepAnchor: true, kind: 'range' });
        } else {
            this.store.setActive(addr);
        }
    }

    /** The column key a header cell represents (by its position among header cells). */
    columnKeyFromHeadCell(headCell) {
        const cells = Array.from(this.refs.head.querySelectorAll('.lgrid-headcell'));
        const pos = cells.indexOf(headCell);
        // Header cells are the column headers in visible order (group labels use .lgrid-headgroup).
        const column = this.store.visibleColumns()[pos];
        return column ? column.key : null;
    }

    /** Select an entire row (all navigable columns of that row). */
    selectRow(rowKey) {
        const row = this.store.rowIndexOf(rowKey);
        const mask = this.store.navigabilityMask();
        const c0 = firstNavigable(mask);
        const c1 = lastNavigable(mask);
        if (row < 0 || c0 < 0) {
            return;
        }
        const anchor = this.store.addressAt(row, c0);
        const active = this.store.addressAt(row, c0);
        this.store.setSelectionRect({ r0: row, r1: row, c0, c1 }, 'row', active, anchor);
    }

    /** Select an entire column (all rows of that column). */
    selectColumn(colKey) {
        const col = this.store.colIndexOf(colKey);
        const mask = this.store.navigabilityMask();
        if (col < 0 || !mask[col]) {
            return; // non-navigable columns (serial) aren't column-selectable
        }
        const lastRow = Math.max(0, this.store.rowCount() - 1);
        if (this.store.rowCount() === 0) {
            return;
        }
        const anchor = this.store.addressAt(0, col);
        const active = this.store.addressAt(0, col);
        this.store.setSelectionRect({ r0: 0, r1: lastRow, c0: col, c1: col }, 'col', active, anchor);
    }
}
