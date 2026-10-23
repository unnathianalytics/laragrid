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
import { toggleClass } from '../util/dom.js';
import { shiftRowSpan } from '../core/StateStore.js';

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
        /**
         * The LOGICAL rectangle whose cells currently carry the selected class (partial ranges
         * only; null when nothing partial is painted). Index space, unclamped — painting
         * clamps to the mounted row window, so a window shift only has to paint the rows that
         * entered (see reassert).
         * @type {{r0: number, r1: number, c0: number, c1: number}|null}
         */
        this.paintedRect = null;
        /** True while the root fast-path 'all' class is on. */
        this.allSelected = false;

        this.subs = [
            bus.on('active:changed', () => this.paintActive(true)),
            bus.on('selection:changed', () => this.paintSelection()),
            // A row replacement (M3 pages) wipes cell DOM — re-assert active/selection onto it.
            // An insert/remove the body applied in place keeps the DOM: shift the painted
            // rectangle's indexes to follow the rows that moved, then diff as usual. One the
            // body declined (virtual, pad rows) was a rebuild, so it re-asserts like any other.
            bus.on('rows:changed', (payload) => {
                if (payload && payload.incremental && this.renderer.bodyKept) {
                    this.shiftPainted(payload);
                    this.paintActive(true, false);
                    this.paintSelection();
                    return;
                }
                this.reassert();
            }),
            // A virtual scroll swaps only the mounted row window. Do not force the off-screen
            // active row back into view; simply repaint it when it belongs to this window. The
            // payload (when present) names the rows that entered, so only those are painted.
            bus.on('body:window-rendered', (delta) => this.reassert(false, delta)),
        ];
    }

    destroy() {
        this.subs.forEach((off) => off());
    }

    // ---- Active cell ---------------------------------------------------------------------

    /**
     * @param {boolean} ensure mount the active row first when the body is virtual
     * @param {boolean} scroll bring the cell into view (a window repaint must NOT fight the
     *        operator's scroll — it only re-marks the cell)
     */
    paintActive(ensure = false, scroll = true) {
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
        if (scroll) {
            this.scrollIntoView(cell);
        }
    }

    /**
     * Keep the active cell visible inside the grid's scroll container after movement.
     * Container-bounded: adjusts container.scrollTop and container.scrollLeft ONLY when
     * the cell is out of view. The cell's box comes from geometry the grid already holds —
     * row index × the cached row pitch below the sticky header, and the prefix sum of the
     * resolved column widths right of the frozen block — so no element box is measured
     * right after the class writes above. Never calls native
     * Element.prototype.scrollIntoView to prevent unwanted window/document page jumping.
     *
     * @param {HTMLElement|null} cell the active cell element (locates the container)
     * @param {{rowKey: string, colKey: string}|null} [addr]
     */
    scrollIntoView(cell, addr = this.store.active) {
        const container = (this.refs && this.refs.scroll) || (cell && cell.closest('.lgrid-scroll'));
        const body = this.renderer.body;
        const layout = this.renderer.layout;
        if (!container || !addr || !body || !layout) {
            return;
        }
        const { row, col } = this.store.indexOf(addr);
        const viewH = container.clientHeight;
        const viewW = container.clientWidth;
        if (row < 0 || col < 0 || viewH <= 0 || viewW <= 0) {
            return;
        }

        // Vertical: the sticky header covers the top of the viewport, the sticky footer (when
        // shown) the bottom.
        const pitch = body.rowHeightPx();
        const headH = this.refs.head ? this.refs.head.offsetHeight || 0 : 0;
        const footer = this.refs.footer;
        const footH = footer && !footer.hidden ? footer.offsetHeight || 0 : 0;
        const top = headH + (row * pitch);
        const scrollTop = container.scrollTop;
        if (top < scrollTop + headH) {
            container.scrollTop = top - headH;
        } else if (top + pitch > scrollTop + viewH - footH) {
            container.scrollTop = top + pitch - viewH + footH;
        }

        // Horizontal: a frozen cell is always in view; any other must clear the frozen block.
        const freeze = (this.store.layout && this.store.layout.freeze) || 0;
        if (col < freeze) {
            return;
        }
        const cols = this.store.visibleColumns();
        let left = 0;
        let frozenWidth = 0;
        for (let c = 0; c < col; c++) {
            const width = layout.columnWidth(cols[c]) || 0;
            left += width;
            if (c < freeze) {
                frozenWidth += width;
            }
        }
        const right = left + (layout.columnWidth(cols[col]) || 0);
        const scrollLeft = container.scrollLeft;
        if (left < scrollLeft + frozenWidth) {
            container.scrollLeft = left - frozenWidth;
        } else if (right > scrollLeft + viewW) {
            container.scrollLeft = right - viewW;
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

        // Diff the previous and next rectangles ARITHMETICALLY: the cells that leave are the
        // strips of the old rect outside the new one, the cells that enter are the strips of
        // the new rect outside the old one. A Shift+Down over 700 x 10 cells then touches one
        // row strip, never a 7,000-entry set.
        const next = { r0: sel.r0, r1: sel.r1, c0: sel.c0, c1: sel.c1 };
        const prev = this.paintedRect;
        if (!prev) {
            this.paintRect(next, true);
        } else if (!SelectionPainter.sameRect(prev, next)) {
            SelectionPainter.stripsOutside(prev, next).forEach((strip) => this.paintRect(strip, false));
            SelectionPainter.stripsOutside(next, prev).forEach((strip) => this.paintRect(strip, true));
        }
        this.paintedRect = next;
    }

    static sameRect(a, b) {
        return a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1;
    }

    /**
     * Keep paintedRect true to the DOM after an in-place row insert/remove: the painted cells
     * kept their classes but their row indexes moved. The store moved its selection with the
     * same shiftRowSpan arithmetic, so the diff that follows only has work for whole-column
     * selections. Rows inserted INSIDE the rectangle are fresh, unpainted elements — paint them
     * so the rectangle stays solid.
     *
     * @param {{inserted?: {keys: string[], index: number}, removed?: {keys: string[], index: number}}} change
     */
    shiftPainted(change) {
        const rect = this.paintedRect;
        if (!rect) {
            return;
        }
        const span = shiftRowSpan(rect, change);
        this.paintedRect = span ? { ...rect, ...span } : null;
        if (span && change.inserted) {
            const { index, keys } = change.inserted;
            if (index > rect.r0 && index <= rect.r1) {
                this.paintRect({ r0: index, r1: index + keys.length - 1, c0: rect.c0, c1: rect.c1 }, true);
            }
        }
    }

    /**
     * The (at most four) rectangles covering the cells of `a` that are NOT inside `b`: the row
     * bands above and below `b`, then the column bands left and right of `b` within the shared
     * rows. Pure index arithmetic — no cell is visited.
     *
     * @returns {Array<{r0: number, r1: number, c0: number, c1: number}>}
     */
    static stripsOutside(a, b) {
        const out = [];
        const push = (r0, r1, c0, c1) => {
            if (r0 <= r1 && c0 <= c1) {
                out.push({ r0, r1, c0, c1 });
            }
        };
        push(a.r0, Math.min(a.r1, b.r0 - 1), a.c0, a.c1);
        push(Math.max(a.r0, b.r1 + 1), a.r1, a.c0, a.c1);
        const r0 = Math.max(a.r0, b.r0);
        const r1 = Math.min(a.r1, b.r1);
        push(r0, r1, a.c0, Math.min(a.c1, b.c0 - 1));
        push(r0, r1, Math.max(a.c0, b.c1 + 1), a.c1);
        return out;
    }

    /**
     * Toggle the selected class over one index rectangle, clamped to the rows the body has
     * mounted (the virtual window; every row when the body is not virtual) and to the
     * visible columns. Cells resolve through the renderer's O(1) element index.
     */
    paintRect(rect, on, rowLo = null, rowHi = null) {
        const body = this.renderer.body;
        const rows = this.store.rows;
        const cols = this.store.visibleColumns();
        let r0 = Math.max(0, rect.r0);
        let r1 = Math.min(rect.r1, rows.length - 1);
        if (body && body.windowStart >= 0) {
            r0 = Math.max(r0, body.windowStart);
            r1 = Math.min(r1, body.windowEnd - 1);
        }
        if (rowLo !== null) {
            r0 = Math.max(r0, rowLo);
            r1 = Math.min(r1, rowHi);
        }
        const c0 = Math.max(0, rect.c0);
        const c1 = Math.min(rect.c1, cols.length - 1);
        for (let r = r0; r <= r1; r++) {
            const rowKey = rows[r]._k;
            for (let c = c0; c <= c1; c++) {
                this.toggleSelected(this.renderer.cellElFor(rowKey, cols[c].key), on);
            }
        }
    }

    toggleSelected(cell, on) {
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
        if (this.paintedRect) {
            this.paintRect(this.paintedRect, false);
            this.paintedRect = null;
        }
    }

    setAll(on) {
        if (on === this.allSelected) {
            return;
        }
        toggleClass(this.refs.root, 'lgrid--all-selected', on);
        this.allSelected = on;
    }

    /**
     * Re-apply active + selection after the body changed under us. Without a delta the body was
     * rebuilt (row replacement): every class is gone, so repaint from scratch. With a window
     * delta ({added} row keys from BodyRenderer.shiftWindow) the kept rows still carry their
     * classes and only the rows that entered need painting — and the cell is never scrolled
     * into view, because the operator's scroll is what moved the window.
     *
     * @param {boolean} ensure mount the active row when virtual (rows:changed path)
     * @param {{added?: string[], removed?: string[]}|null} [delta]
     */
    reassert(ensure = true, delta = null) {
        if (delta && Array.isArray(delta.added)) {
            this.reassertRows(delta.added);
            return;
        }
        this.activeEl = null;
        this.paintedRect = null;
        this.paintActive(ensure, ensure);
        this.paintSelection();
    }

    /** Paint the active ring and the selected strip onto rows that just mounted. */
    reassertRows(keys) {
        const active = this.store.active;
        const cell = active ? this.renderer.cellElFor(active.rowKey, active.colKey) : null;
        if (cell !== this.activeEl) {
            // The active row entered (fresh element: mark it, no scroll) or left (its element
            // is detached: forget it).
            if (cell) {
                this.paintActive(false, false);
            } else {
                this.activeEl = null;
            }
        }
        const rect = this.paintedRect;
        if (!rect || this.allSelected) {
            return;
        }
        for (const key of keys) {
            const r = this.store.rowIndexOf(key);
            if (r >= rect.r0 && r <= rect.r1) {
                this.paintRect(rect, true, r, r);
            }
        }
    }
}
