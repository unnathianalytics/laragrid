/**
 * What: The read-only painter for interaction state. It subscribes to the store's active:changed
 *       / selection:changed events and toggles the semantic state classes (lgrid-cell--active,
 *       --selected) on ONLY the cells that changed, keeps the root's aria-activedescendant and
 *       each cell's aria-selected in sync, and scrolls the active cell into view.
 * Why:  Plan §2.4 (SelectionManager emits diffs; painter toggles classes on affected cells only)
 *       and §1.4/§2.7 performance: a selection change must never re-render the body. It touches
 *       the symmetric difference of the previous and next selected sets. Ctrl+A (kind 'all') uses
 *       a single root class fast-path (lgrid--all-selected) instead of tagging thousands of cells
 *       (R-E), so selecting a 1000×8 grid stays O(1). All classes are the stable semantic names
 *       from datagrid.css — never composed utilities (R8).
 * When: Constructed and subscribed by GridCore after the Renderer exists.
 */
import { toggleClass, cellDomId } from '../util/dom.js';

export default class SelectionPainter {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../render/Renderer').default} renderer
     * @param {import('../core/EventBus').default} bus
     * @param {{root: HTMLElement}} refs
     */
    constructor(store, renderer, bus, refs) {
        this.store = store;
        this.renderer = renderer;
        this.bus = bus;
        this.refs = refs;
        /** The currently-painted active cell element (so we can clear it on the next move). */
        this.activeEl = null;
        /** @type {Set<string>} currently-painted selected cell dom ids (partial ranges only). */
        this.paintedSelected = new Set();
        /** True while the root fast-path 'all' class is on. */
        this.allSelected = false;

        this.subs = [
            bus.on('active:changed', () => this.paintActive(true)),
            bus.on('selection:changed', () => this.paintSelection()),
            // A row replacement (M3 pages) wipes cell DOM — re-assert active/selection onto it.
            bus.on('rows:changed', () => this.reassert()),
            // A virtual scroll swaps only the mounted row window. Do not force the off-screen
            // active row back into view; simply repaint it when it belongs to this window.
            bus.on('body:window-rendered', () => this.reassert(false)),
        ];
    }

    destroy() {
        this.subs.forEach((off) => off());
    }

    // ---- Active cell ---------------------------------------------------------------------

    paintActive(ensure = false) {
        const addr = this.store.active;
        // Clear the previous active cell.
        if (this.activeEl) {
            toggleClass(this.activeEl, 'lgrid-cell--active', false);
            this.activeEl = null;
        }
        if (!addr) {
            this.refs.root.removeAttribute('aria-activedescendant');
            return;
        }
        const cell = ensure && this.renderer.ensureCellElFor
            ? this.renderer.ensureCellElFor(addr.rowKey, addr.colKey)
            : this.renderer.cellElFor(addr.rowKey, addr.colKey);
        if (!cell) {
            return;
        }
        toggleClass(cell, 'lgrid-cell--active', true);
        this.activeEl = cell;
        this.refs.root.setAttribute('aria-activedescendant', cell.id);
        this.scrollIntoView(cell);
    }

    /**
     * Keep the active cell visible inside the grid's scroll container after movement.
     * Container-bounded: adjusts container.scrollTop and container.scrollLeft ONLY when
     * the cell is out of view, taking frozen columns into account. Never calls native
     * Element.prototype.scrollIntoView to prevent unwanted window/document page jumping.
     */
    scrollIntoView(cell) {
        if (!cell) {
            return;
        }
        const container = (this.refs && this.refs.scroll) || cell.closest('.lgrid-scroll');
        if (!container) {
            return;
        }

        const cRect = container.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();

        if (cRect.width <= 0 || cRect.height <= 0) {
            return;
        }

        // Calculate left boundary offset reserved by frozen sticky columns on the row
        let frozenLeftOffset = 0;
        const rowEl = cell.closest('.lgrid-row');
        if (rowEl) {
            const frozenCells = rowEl.querySelectorAll('.lgrid-cell--frozen');
            for (const fc of frozenCells) {
                if (fc !== cell) {
                    const fcRect = fc.getBoundingClientRect();
                    frozenLeftOffset = Math.max(frozenLeftOffset, fcRect.right - cRect.left);
                }
            }
        }

        const visibleLeft = cRect.left + frozenLeftOffset;

        // Vertical adjustment
        if (cellRect.top < cRect.top) {
            container.scrollTop -= (cRect.top - cellRect.top);
        } else if (cellRect.bottom > cRect.bottom) {
            container.scrollTop += (cellRect.bottom - cRect.bottom);
        }

        // Horizontal adjustment
        if (cellRect.left < visibleLeft) {
            container.scrollLeft -= (visibleLeft - cellRect.left);
        } else if (cellRect.right > cRect.right) {
            container.scrollLeft += (cellRect.right - cRect.right);
        }
    }

    // ---- Selection -----------------------------------------------------------------------

    paintSelection() {
        const sel = this.store.selection;

        // Fast path: 'all' toggles one root class, no per-cell work (R-E).
        if (sel && sel.kind === 'all') {
            this.clearPartial();
            this.setAll(true);
            return;
        }
        this.setAll(false);

        // A single-cell selection paints nothing extra (the active ring is enough).
        if (!sel || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) {
            this.clearPartial();
            return;
        }

        // Build the next selected id set from the rectangle, then diff against the painted set.
        const next = new Set();
        if (this.renderer.body && this.renderer.body.virtual) {
            // Only mounted cells need classes; the logical selection remains the full store rect.
            for (const cell of this.renderer.body.cellElByKey.values()) {
                const rowEl = cell.closest('.lgrid-row');
                const row = rowEl ? this.store.rowIndexOf(rowEl.dataset.k) : -1;
                const col = this.store.colIndexOf(cell.dataset.c);
                if (row >= sel.r0 && row <= sel.r1 && col >= sel.c0 && col <= sel.c1) {
                    next.add(cell.id);
                }
            }
        } else {
            for (let r = sel.r0; r <= sel.r1; r++) {
                const row = this.store.rowAt(r);
                if (!row) {
                    continue;
                }
                for (let c = sel.c0; c <= sel.c1; c++) {
                    const column = this.store.columnAt(c);
                    if (!column) {
                        continue;
                    }
                    next.add(cellDomId(this.store.name, row._k, column.key));
                }
            }
        }

        // Remove cells no longer selected.
        for (const id of this.paintedSelected) {
            if (!next.has(id)) {
                this.toggleSelectedById(id, false);
            }
        }
        // Add newly-selected cells.
        for (const id of next) {
            if (!this.paintedSelected.has(id)) {
                this.toggleSelectedById(id, true);
            }
        }
        this.paintedSelected = next;
    }

    toggleSelectedById(id, on) {
        const cell = document.getElementById(id);
        if (cell) {
            toggleClass(cell, 'lgrid-cell--selected', on);
            if (on) {
                cell.setAttribute('aria-selected', 'true');
            } else {
                cell.removeAttribute('aria-selected');
            }
        }
    }

    clearPartial() {
        for (const id of this.paintedSelected) {
            this.toggleSelectedById(id, false);
        }
        this.paintedSelected.clear();
    }

    setAll(on) {
        if (on === this.allSelected) {
            return;
        }
        toggleClass(this.refs.root, 'lgrid--all-selected', on);
        this.allSelected = on;
    }

    /** Re-apply active + selection after the body was re-rendered (row replacement). */
    reassert(ensure = true) {
        this.activeEl = null;
        this.paintedSelected = new Set();
        this.paintActive(ensure);
        this.paintSelection();
    }
}
