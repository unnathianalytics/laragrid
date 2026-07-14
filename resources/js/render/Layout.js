/**
 * What: Owns the geometry of the grid — turns column widths into a single
 *       `grid-template-columns` custom property, applies the layout modifier classes
 *       (sticky header, striped, density, theme, content-visibility), and computes the
 *       cumulative left offsets that make the first N columns freeze.
 * Why:  Every row is a CSS grid sharing ONE template var on the root, so layout is O(1) to
 *       change and never per-cell (plan §2.4 Layout). Frozen columns are pure `position:
 *       sticky` + a `left` offset (cumulative width of the columns before them), which is
 *       why M1 supports left-freeze only. All classes toggled here are the stable semantic
 *       `lgrid-*` names from datagrid.css — never composed utilities (R8).
 * When: Called once by GridCore after the store is built and the root refs exist.
 */
import { toggleClass } from '../util/dom.js';

/** Fallback width (px) for a column that declares neither a fixed width nor grow. */
const DEFAULT_WIDTH = 120;

export default class Layout {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {{root: HTMLElement, scroll: HTMLElement, head: HTMLElement, body: HTMLElement}} refs
     */
    constructor(store, refs) {
        this.store = store;
        this.refs = refs;
    }

    /**
     * An operator width override for a column (drag-resize, M7), or null. An override wins
     * over everything — including grow, which the override converts to a fixed track.
     */
    overrideFor(column) {
        const overrides = this.store.widthOverrides || {};
        const width = overrides[column.key];
        return Number.isFinite(width) && width > 0 ? width : null;
    }

    /** The pixel width used for a column, honouring override/width/grow/default. */
    columnWidth(column) {
        const override = this.overrideFor(column);
        if (override !== null) {
            return override;
        }
        if (column.grow) {
            return null; // grow columns take a resolved slack track, not a fixed px width
        }
        return column.width || DEFAULT_WIDTH;
    }

    /**
     * Apply the whole layout to the grid root: template var, chrome classes, frozen offsets.
     */
    apply() {
        const columns = this.store.visibleColumns();
        const layout = this.store.layout || {};

        this.setTemplate(columns);

        // Layout modifier classes (stable semantic classes only).
        toggleClass(this.refs.root, 'lgrid--sticky-head', layout.stickyHeader !== false && layout.stickyHeader);
        toggleClass(this.refs.root, 'lgrid--striped', !!layout.striped);
        toggleClass(this.refs.root, 'lgrid--compact', layout.density === 'compact');
        toggleClass(this.refs.root, 'lgrid--comfortable', layout.density === 'comfortable');
        if (layout.themeClass) {
            this.refs.root.classList.add(layout.themeClass);
        }

        // content-visibility on rows from day one (near-virtual perf; plan §1.4).
        this.refs.body.classList.add('lgrid-rows--cv');

        this.frozen = this.computeFrozen(columns, layout.freeze || 0);

        // Keep the resolved grow width correct as the container resizes — a fresh apply on width
        // change re-splits the slack. Observing the scroll box (not the window) covers panel/layout
        // changes too. (M7 adds full column resize; this is the minimal alignment guarantee.)
        this.installResizeSync(columns);
    }

    /**
     * Build --lgrid-cols. Every track is a CONCRETE px value: fixed columns use their width, and
     * grow columns are resolved to `max(minWidth, (container − fixed) / growCount)` px here in JS —
     * never a CSS `1fr`. Why: the header, body and footer are three separate CSS grids; a `1fr`
     * track resolves against each grid's OWN width, and when the body is wider than the viewport
     * (long content) its `1fr` stretches more than the header's, drifting the columns a whole column
     * out of alignment. Concrete px tracks are identical in all three grids by construction. A
     * trailing `minmax(0, 1fr)` filler still absorbs any leftover gutter uniformly.
     *
     * @param {object[]} columns visible columns
     */
    setTemplate(columns) {
        // A user-resized grow column is fixed at its override (M7) — it leaves the grow pool.
        const growCols = columns.filter((c) => c.grow && this.overrideFor(c) === null);
        const fixedTotal = columns
            .filter((c) => !growCols.includes(c))
            .reduce((sum, c) => sum + (this.columnWidth(c) || DEFAULT_WIDTH), 0);

        // Available width inside the scroll box (fall back to root, then a sane default pre-layout).
        const box = this.refs.scroll || this.refs.root;
        const available = (box && box.clientWidth) || 0;

        let growPx = 0;
        if (growCols.length > 0) {
            const slack = available - fixedTotal;
            const per = slack / growCols.length;
            const minGrow = Math.max(...growCols.map((c) => c.minWidth || DEFAULT_WIDTH));
            growPx = Math.max(minGrow, Math.floor(per));
        }

        const tracks = columns.map((c) => {
            const width = this.columnWidth(c);
            return width !== null ? `${width}px` : `${growPx}px`;
        });
        // Filler absorbs any sub-pixel/gutter remainder uniformly across all three grids.
        tracks.push('minmax(0, 1fr)');
        this.refs.root.style.setProperty('--lgrid-cols', tracks.join(' '));
    }

    /**
     * Re-split grow width when the scroll box resizes, so alignment survives a window/panel resize.
     * @param {object[]} columns
     */
    installResizeSync(columns) {
        if (this.resizeObserver || typeof ResizeObserver === 'undefined') {
            return;
        }
        if (!columns.some((c) => c.grow)) {
            return; // no grow column → tracks are static, nothing to re-split
        }
        const box = this.refs.scroll || this.refs.root;
        if (!box) {
            return;
        }
        let last = box.clientWidth;
        this.resizeObserver = new ResizeObserver(() => {
            if (box.clientWidth !== last) {
                last = box.clientWidth;
                this.setTemplate(this.store.visibleColumns());
            }
        });
        this.resizeObserver.observe(box);
    }

    /** Tear down the resize observer (grid destroy). */
    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    /**
     * Compute cumulative left offsets for the first `freeze` columns.
     * @returns {Array<{index: number, left: number} >}
     */
    computeFrozen(columns, freeze) {
        const frozen = [];
        let left = 0;
        for (let i = 0; i < Math.min(freeze, columns.length); i++) {
            frozen.push({ index: i, left });
            left += this.columnWidth(columns[i]) || DEFAULT_WIDTH;
        }
        return frozen;
    }

    /**
     * Apply the frozen sticky offset + class to a cell element at a column index (used by
     * the header and body renderers as they build cells).
     * @param {HTMLElement} cellEl
     * @param {number} colIndex
     */
    applyFrozenTo(cellEl, colIndex) {
        const hit = this.frozen && this.frozen.find((f) => f.index === colIndex);
        if (!hit) {
            return;
        }
        cellEl.classList.add('lgrid-cell--frozen');
        cellEl.style.left = `${hit.left}px`;
        // Stamp the column index so refreshFrozen (a resize of a frozen-or-earlier column moves
        // every sticky offset after it) can retarget existing cells without a full repaint.
        cellEl.dataset.fz = String(colIndex);
    }

    /**
     * Recompute the frozen sticky offsets after a column width change (M7 resize) and update
     * every already-painted frozen cell in place — header, body and footer alike — via the
     * data-fz stamp. O(frozen cells), no repaint, so the editor/selection/focus are untouched.
     */
    refreshFrozen() {
        const layout = this.store.layout || {};
        this.frozen = this.computeFrozen(this.store.visibleColumns(), layout.freeze || 0);
        const leftByIndex = new Map(this.frozen.map((f) => [f.index, f.left]));
        this.refs.root.querySelectorAll('[data-fz]').forEach((cellEl) => {
            const left = leftByIndex.get(Number(cellEl.dataset.fz));
            if (left !== undefined) {
                cellEl.style.left = `${left}px`;
            }
        });
    }

    /**
     * Build the trailing filler cell that occupies the `1fr` filler track. Every grid row
     * (header tiers, body rows, footer) must append exactly one so cell count matches track
     * count and the columns stay aligned. The variant class picks the right background.
     * @param {'headcell'|'cell'|'footcell'} variant
     * @returns {HTMLElement}
     */
    fillerCell(variant) {
        const node = document.createElement('div');
        node.className = `lgrid-${variant} lgrid-filler`;
        node.setAttribute('aria-hidden', 'true');
        return node;
    }
}
