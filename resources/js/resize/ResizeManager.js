/**
 * What: Column drag-resize (M7) — a delegated pointer engine over the header's resize handles:
 *       drag sets a live width, double-click autofits to content, both clamp to the column's
 *       declared min/max (with hard floors), persist through the LayoutStore, and announce via
 *       the `lgrid:column-resized` event (umbrella §3.5).
 * Why:  Resize is pure client geometry — no server round-trip, no store row state. During the
 *       drag only the ONE `--lgrid-cols` template var updates per frame (O(1), the M1 layout
 *       invariant), and the frozen sticky offsets — the only other geometry that depends on
 *       widths — are recomputed once on commit via Layout.refreshFrozen, never per move. A
 *       user-resized grow column becomes fixed (Layout excludes overrides from the grow
 *       re-split), matching every desktop grid operators know.
 * When: Constructed by GridCore after the first paint; listeners are DELEGATED on the header
 *       element so they survive header re-renders (sort indicator updates etc.).
 */

/** Hard clamp floors/ceilings applied on top of the column's declared minWidth/maxWidth. */
const HARD_MIN = 36;
const HARD_MAX = 2000;

/** Autofit measures at most this many body rows (content-visibility rows off-screen measure 0). */
const AUTOFIT_SAMPLE = 200;

/** Slack added to the autofit measurement so content doesn't kiss the cell border. */
const AUTOFIT_SLACK = 12;

export default class ResizeManager {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('./../render/Layout').default} layout
     * @param {{root: HTMLElement, head: HTMLElement, body: HTMLElement}} refs
     * @param {import('../core/EventBus').default} bus
     * @param {import('../persist/LayoutStore').default} layoutStore
     */
    constructor(store, layout, refs, bus, layoutStore) {
        this.store = store;
        this.layout = layout;
        this.refs = refs;
        this.bus = bus;
        this.layoutStore = layoutStore;
    }

    init() {
        // Capture phase, like the sort control: a grab on the handle must never fall through to
        // M2 whole-column selection on the same header cell.
        this.onPointerDown = (e) => {
            const handle = e.target.closest('.lgrid-resize');
            if (!handle || !this.refs.head.contains(handle)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            this.startDrag(handle, e);
        };
        this.refs.head.addEventListener('pointerdown', this.onPointerDown, true);

        this.onDblClick = (e) => {
            const handle = e.target.closest('.lgrid-resize');
            if (!handle || !this.refs.head.contains(handle)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            this.autofit(handle.dataset.col);
        };
        this.refs.head.addEventListener('dblclick', this.onDblClick, true);
    }

    /**
     * Begin a drag: remember the anchor, track pointermove on the WINDOW (capture may be
     * unavailable for synthetic pointers in tests — window listeners work for both), apply the
     * clamped width live, commit on pointerup/cancel.
     */
    startDrag(handle, e) {
        const colKey = handle.dataset.col;
        const column = this.store.columnByKey(colKey);
        if (!column) {
            return;
        }
        const cell = handle.closest('.lgrid-headcell');
        const startWidth = cell
            ? cell.getBoundingClientRect().width
            : this.layout.columnWidth(column) || 120;
        const startX = e.clientX;

        try {
            handle.setPointerCapture(e.pointerId);
        } catch {
            // Synthetic pointer (browser test) has no active pointer to capture — window
            // listeners below carry the drag regardless.
        }

        this.refs.root.classList.add('lgrid--resizing');

        const onMove = (ev) => {
            this.applyWidth(column, startWidth + (ev.clientX - startX));
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            this.refs.root.classList.remove('lgrid--resizing');
            this.commit(column);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    /** Clamp a candidate width to the column's declared min/max within the hard floors. */
    clamp(column, width) {
        const min = Math.max(column.minWidth || 0, HARD_MIN);
        const max = Math.min(column.maxWidth || HARD_MAX, HARD_MAX);
        return Math.round(Math.min(Math.max(width, min), max));
    }

    /** Apply a clamped width override and re-set the ONE template var (the per-move hot path). */
    applyWidth(column, width) {
        this.store.widthOverrides[column.key] = this.clamp(column, width);
        this.layout.setTemplate(this.store.visibleColumns());
    }

    /**
     * Commit a finished resize: fix the frozen sticky offsets, persist, and announce — the
     * once-per-gesture work kept off the pointermove path.
     */
    commit(column) {
        this.layout.refreshFrozen();
        this.persist();

        const width = this.store.widthOverrides[column.key];
        this.bus.emit('column:resized', { col: column.key, width });
        this.refs.root.dispatchEvent(
            new CustomEvent('lgrid:column-resized', {
                detail: { grid: this.store.name, col: column.key, width },
                bubbles: true,
            }),
        );
    }

    /**
     * Double-click autofit: size the column to its widest painted content (header label + a
     * bounded sample of body cells), clamped like a drag. Rows skipped by content-visibility
     * measure 0 and simply don't contribute — the visible content is what the operator is
     * fitting to.
     */
    autofit(colKey) {
        const column = this.store.columnByKey(colKey);
        const colIndex = this.store.colIndexOf(colKey);
        if (!column || colIndex < 0) {
            return;
        }

        let widest = 0;
        let padding = 0;
        const handle = this.refs.head.querySelector(`.lgrid-resize[data-col="${colKey}"]`);
        const headCell = handle ? handle.closest('.lgrid-headcell') : null;
        if (headCell) {
            widest = this.measureContent(headCell);
        }

        const rows = this.refs.body.querySelectorAll('.lgrid-row');
        const sample = Math.min(rows.length, AUTOFIT_SAMPLE);
        for (let i = 0; i < sample; i++) {
            const cellEl = rows[i].children[colIndex];
            if (!cellEl) {
                continue;
            }
            if (padding === 0) {
                const style = window.getComputedStyle(cellEl);
                padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
            }
            const content = this.measureContent(cellEl);
            if (content > widest) {
                widest = content;
            }
        }

        if (widest <= 0) {
            return;
        }
        this.applyWidth(column, widest + padding + AUTOFIT_SLACK);
        this.commit(column);
    }

    /**
     * The true laid-out content width of a cell, independent of clipping AND alignment.
     * `scrollWidth` misses left-side overflow (a right-aligned numeric cell overflows LEFT in
     * LTR, which scrollable overflow never counts), so text nodes are measured with a Range —
     * the anonymous flex item keeps its natural width, and the range reports it even when the
     * cell clips it. Element children (sort button, checkbox pill) add their border boxes; the
     * resize handle is absolute chrome and excluded.
     */
    measureContent(cellEl) {
        let width = 0;
        for (const node of cellEl.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(node);
                width += range.getBoundingClientRect().width;
            } else if (
                node.nodeType === Node.ELEMENT_NODE
                && !node.classList.contains('lgrid-resize')
            ) {
                width += node.getBoundingClientRect().width;
            }
        }
        return Math.ceil(width);
    }

    /** Write the full layout state through the (possibly disabled no-op) LayoutStore. */
    persist() {
        this.layoutStore.save(this.store.widthOverrides, [...this.store.userHidden]);
    }

    destroy() {
        if (this.onPointerDown) {
            this.refs.head.removeEventListener('pointerdown', this.onPointerDown, true);
        }
        if (this.onDblClick) {
            this.refs.head.removeEventListener('dblclick', this.onDblClick, true);
        }
    }
}
