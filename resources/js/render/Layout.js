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
        this.resolvedWidths = new Map();
    }

    /** Whether the grid-level fit-to-width contract is active. */
    isFitColumns() {
        const layout = this.store.layout || {};
        return !!(layout.sizing && layout.sizing.fitColumns);
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

    /**
     * The preferred width before fit-to-grid scaling. In fit mode this is a proportional
     * weight, not a hard pixel constraint; a grow column uses its declared minimum/default.
     */
    preferredWidth(column) {
        const override = this.overrideFor(column);
        if (override !== null) {
            return override;
        }
        if (column.grow) {
            return column.minWidth || DEFAULT_WIDTH;
        }
        return column.width || DEFAULT_WIDTH;
    }

    /** The currently resolved pixel width used for a column. */
    columnWidth(column) {
        if (this.resolvedWidths.has(column.key)) {
            return this.resolvedWidths.get(column.key);
        }
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
        toggleClass(this.refs.root, 'lgrid--fit-columns', this.isFitColumns());
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

        // Keep resolved grow/fitted widths correct as the container resizes. Observing the scroll
        // box (not the window) covers responsive panels and parent-layout changes too.
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
        if (this.isFitColumns()) {
            this.setFittedTemplate(columns);
            return;
        }

        // A user-resized grow column is fixed at its override (M7) — it leaves the grow pool.
        const growCols = columns.filter((c) => c.grow && this.overrideFor(c) === null);
        const fixedTotal = columns
            .filter((c) => !growCols.includes(c))
            .reduce((sum, c) => sum + this.preferredWidth(c), 0);

        // Available width inside the scroll box (fall back to root, then a sane default pre-layout).
        const available = this.availableWidth();

        let growPx = 0;
        if (growCols.length > 0) {
            const slack = available - fixedTotal;
            const per = slack / growCols.length;
            const minGrow = Math.max(...growCols.map((c) => c.minWidth || DEFAULT_WIDTH));
            growPx = Math.max(minGrow, Math.floor(per));
        }

        const widths = columns.map((c) => (
            c.grow && this.overrideFor(c) === null ? growPx : this.preferredWidth(c)
        ));
        const tracks = widths.map((width) => `${width}px`);
        this.resolvedWidths = new Map(columns.map((c, index) => [c.key, widths[index]]));
        // Filler absorbs any sub-pixel/gutter remainder uniformly across all three grids.
        tracks.push('minmax(0, 1fr)');
        this.refs.root.style.setProperty('--lgrid-cols', tracks.join(' '));
    }

    /**
     * Resolve proportional column weights to integer tracks whose sum is exactly the scroll
     * viewport. Exact pixels keep the three independent CSS grids aligned and avoid fractional
     * rounding producing a one-pixel horizontal scrollbar.
     *
     * Individual width/min/max declarations cannot remain hard constraints here: a set of
     * minimums wider than the viewport is mathematically incompatible with the no-overflow
     * contract. Widths and resize overrides are retained as relative weights instead.
     */
    setFittedTemplate(columns) {
        const available = this.availableWidth();
        if (available <= 0 || columns.length === 0) {
            this.commitTemplate(columns, columns.map((c) => this.preferredWidth(c)));
            return;
        }

        const weights = columns.map((c) => Math.max(1, this.preferredWidth(c)));
        const total = weights.reduce((sum, width) => sum + width, 0);
        const raw = weights.map((weight) => (available * weight) / total);
        const widths = raw.map((width) => Math.floor(width));
        const remainder = available - widths.reduce((sum, width) => sum + width, 0);

        // Largest-remainder allocation is deterministic and preserves the requested ratios
        // while guaranteeing that the concrete tracks total exactly clientWidth.
        const order = raw
            .map((width, index) => ({ index, fraction: width - Math.floor(width) }))
            .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
        for (let i = 0; i < remainder; i++) {
            widths[order[i % order.length].index] += 1;
        }

        this.commitTemplate(columns, widths);
    }

    /** Current usable width of the shared header/body/footer scroll viewport. */
    availableWidth() {
        const scrollWidth = (this.refs.scroll && this.refs.scroll.clientWidth) || 0;
        const rootWidth = (this.refs.root && this.refs.root.clientWidth) || 0;
        return Math.max(0, Math.floor(scrollWidth || rootWidth));
    }

    /** Store resolved geometry and publish the one shared grid-template variable. */
    commitTemplate(columns, widths) {
        this.resolvedWidths = new Map(columns.map((c, index) => [c.key, widths[index]]));
        const tracks = widths.map((width) => `${width}px`);
        tracks.push('minmax(0, 1fr)');
        this.refs.root.style.setProperty('--lgrid-cols', tracks.join(' '));
    }

    /**
     * Rebalance fitted columns around a requested visible pixel width. All resulting widths
     * become overrides so the dragged column follows the pointer while every other column
     * gives/takes space proportionally and the total remains the viewport width.
     */
    resizeFittedColumn(column, requestedWidth) {
        if (!this.isFitColumns()) {
            return false;
        }

        const columns = this.store.visibleColumns();
        const available = this.availableWidth();
        if (available <= 0 || !columns.some((c) => c.key === column.key)) {
            return false;
        }

        if (columns.length === 1) {
            this.store.widthOverrides[column.key] = available;
            return true;
        }

        // Keep at least one pixel for every peer. On exceptionally narrow containers this may
        // relax ResizeManager's normal hard minimum, because fitting remains the stronger rule.
        const target = Math.min(
            Math.max(1, Math.round(requestedWidth)),
            Math.max(1, available - (columns.length - 1)),
        );
        const peers = columns.filter((c) => c.key !== column.key);
        const peerWidths = peers.map((c) => Math.max(0, this.columnWidth(c) || 0));
        const peerTotal = peerWidths.reduce((sum, width) => sum + width, 0);
        const peerSpace = available - target;

        peers.forEach((peer, index) => {
            const share = peerTotal > 0
                ? (peerWidths[index] / peerTotal) * peerSpace
                : peerSpace / peers.length;
            this.store.widthOverrides[peer.key] = Math.max(Number.EPSILON, share);
        });
        this.store.widthOverrides[column.key] = target;

        return true;
    }

    /**
     * Re-split grow or fitted widths when the scroll box resizes, so alignment survives a
     * window/panel resize.
     * @param {object[]} columns
     */
    installResizeSync(columns) {
        if (this.resizeObserver || typeof ResizeObserver === 'undefined') {
            return;
        }
        if (!this.isFitColumns() && !columns.some((c) => c.grow)) {
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
                this.refreshFrozen();
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
