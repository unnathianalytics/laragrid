/**
 * What: The single source of client-side truth for a grid — columns, layout, footer, rows keyed
 *       by their stable `_k`, AND (M2) the interaction state: the active cell, the selection
 *       anchor, and the normalised selection rectangle. Pure data plus change notification; it
 *       does no DOM.
 * Why:  Plan §2.1/§2.4: "the only mutable state in the system." Rows live in a Map by `_k`
 *       (never index) so an op references a key that never shifts (G1). Selection/active state is
 *       *interaction* state, but it is still mutable state, so it belongs here too (plan D7) — the
 *       SelectionManager/KeyboardManager are the command surface that decides WHAT to set; the
 *       painter/statusbar/announcer are read-only subscribers to the change events. Movement math
 *       is done in index space by util/geometry against navigabilityMask(); the store stores the
 *       *result* as stable {rowKey,colKey} so it survives an M3 row replacement.
 * When: Built by GridCore from the @js() config at init; read by the Renderer and the M2 managers.
 */
import { evaluate as evalExpr } from '../formula/ExprEval.js';
import { cellMapKey } from '../util/dom.js';

/**
 * Type-aware cell comparison for the LOCAL sort path (in-memory display grids).
 *
 * Contract (pinned by tests/js/run-sort-vectors.mjs): numbers — and strings that are
 * cleanly numeric — compare numerically (consumers ship raw integer paise for money and
 * '2.000'-style quantity strings); everything else via localeCompare. Emptiness
 * (null/undefined/'') is NOT handled here — sortRowsLocally ranks empties last in BOTH
 * directions before this comparator ever runs, so they never sort as 0 or as a lexical "".
 *
 * @returns {number} negative / zero / positive
 */
export function compareCellValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        return a < b ? -1 : (a > b ? 1 : 0);
    }
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)
        && String(a).trim() !== '' && String(b).trim() !== '') {
        return an < bn ? -1 : (an > bn ? 1 : 0);
    }
    return String(a).localeCompare(String(b));
}

export default class StateStore {
    /**
     * @param {object} config the declarative config from ConfigSerializer
     * @param {import('./EventBus').default} bus
     */
    constructor(config, bus) {
        this.bus = bus;
        this.name = config.name || '';
        this.columns = config.columns || [];
        this.groups = config.groups || [];
        this.footer = config.footer || [];
        this.layout = config.layout || {};

        /** Rows in display order (array of row objects, each carrying `_k`). */
        this.rows = [];
        /** @type {Map<string, {row: object, index: number}>} keyed by `_k`. */
        this.rowByKey = new Map();

        /**
         * Interaction state (M2). `active` is the focus cell; `anchor` is the range origin (equal
         * to `active` for a single-cell selection). `selection` is the normalised inclusive
         * rectangle in (row, col) INDEX space plus a `kind` for painting/announcing. All null
         * until the first navigation/selection.
         * @type {{rowKey: string, colKey: string}|null}
         */
        this.active = null;
        /** @type {{rowKey: string, colKey: string}|null} */
        this.anchor = null;
        /** @type {{r0: number, r1: number, c0: number, c1: number, kind: string}|null} */
        this.selection = null;

        /**
         * Server-side (M3) pagination + query state, and the current page's/whole-set's totals.
         * `serverMeta` mirrors what the last page payload reported; `query` is the request that
         * produced the visible page (the PageSource's source of truth for the next fetch).
         */
        const server = config.server || {};
        const paginate = (this.layout && this.layout.paginate) || {};
        const defaultSort = (this.layout && this.layout.defaultSort) || null;
        this.serverSide = !!(this.layout && this.layout.serverSide);
        this.serverMeta = {
            total: server.total || 0,
            page: server.page || 1,
            perPage: server.perPage || paginate.perPage || 50,
            lastPage: server.lastPage || 1,
        };
        /**
         * Deferred initial payload (adaptive single-page): the mount shipped ZERO rows so
         * its HTML stayed small; GridCore fetches page 1 right after boot. Cleared by the
         * first setPage() — and read by the empty-state guard so "no rows" never flashes
         * while page 1 is in flight.
         */
        this.deferredInitial = !!server.deferred;

        /** The query signature currently displayed (sort/dir/search/filters/page/perPage). */
        this.query = {
            sort: defaultSort ? defaultSort.col : null,
            dir: defaultSort ? defaultSort.dir : 'asc',
            search: '',
            filters: {},
            page: this.serverMeta.page,
            perPage: this.serverMeta.perPage,
        };
        /** @type {Object<string, number>} per-page and whole-filtered-set column totals. */
        this.pageTotals = server.pageTotals || {};
        this.grandTotals = server.grandTotals || {};

        // ---- Operator layout state (M7) — resize + hide/show, fed by the LayoutStore ------
        /**
         * Per-column pixel width overrides from operator drag-resize. An overridden grow
         * column becomes fixed-width (Layout excludes it from the grow re-split).
         * @type {Object<string, number>}
         */
        this.widthOverrides = {};
        /**
         * Columns the OPERATOR hid (column chooser) — separate from the definition's static
         * `visible` flag so a reset can restore exactly the declared layout.
         * @type {Set<string>}
         */
        this.userHidden = new Set();

        // ---- Editable (M4) state ---------------------------------------------------------
        this.editable = !!(this.layout && this.layout.editable);

        /**
         * Whether this grid can sort at all — the ONE predicate both the header renderer
         * (draws the control) and GridCore (binds the handler) read, so an affordance
         * always implies a capability. Server-side grids sort in SQL via PageSource;
         * in-memory DISPLAY grids sort locally via cycleSort(); editable grids never
         * sort — their row order is domain-meaningful (line sequence).
         */
        this.canSort = this.serverSide || !this.editable;

        /**
         * The seed row order captured before the FIRST local sort — what the third click
         * of the asc → desc → clear cycle restores. Null until a local sort happens; any
         * EXTERNAL setRows() (a reseed handing in fresh data) drops it and clears the
         * sort state, because the new payload's order is the new truth.
         * @type {object[]|null}
         */
        this.localSeedRows = null;

        /**
         * Temporarily hidden rows (F9, display grids): `_k` → the row object. Strictly
         * VIEW state — Shift+F9 restores all at once, any external setRows() clears it,
         * and while the stash is non-empty the footer recomputes its aggregates over the
         * remaining visible rows (localAggregate) so the totals match what the operator
         * sees.
         * @type {Map<string, object>}
         */
        this.hiddenStash = new Map();
        /** Monotonic op sequence + the last server-acknowledged grid version. */
        this.seqCounter = 0;
        this.version = 0;
        /** @type {Set<string>} dirty cell keys (cellMapKey) awaiting server acknowledgement. */
        this.dirty = new Set();
        /** @type {Set<string>} pending cell keys with an op in flight. */
        this.pending = new Set();
        /** @type {Map<string, string>} error message by cellMapKey (or `${_k}_row` for row errors). */
        this.errors = new Map();
        /** @type {Array<object>} the recorded op log (the sync spine). */
        this.opLog = [];
        /**
         * The undo/redo recorder (§1.4, completed): GridCore points this at the UndoManager for
         * an editable grid; every optimistic mutator below reports its before/after through it.
         * Null on readonly/display grids — recording is a no-op there.
         * @type {{record: (entry: object) => void, clear: () => void}|null}
         */
        this.recorder = null;
        /** Bulk-checked row keys (the selector gutter, P7). */
        this.checked = new Set();
        /** Columns that are formulas, with their AST — recomputed client-side on every dependent set. */
        this.formulaColumns = this.columns.filter((c) => c && c.formula && c.formula.ast);

        this.setRows(config.rows || []);

        // ->defaultSort() on an IN-MEMORY grid: there is no SQL to carry it, so apply it
        // once right here — otherwise query.sort (and the header caret) would claim an
        // order the rows don't have, and cycleSort's first click would land on 'desc'
        // (query.dir pre-seeded 'asc' matches its opening branch). Restricted to a
        // sortable column exactly like the server path (AppliesSort.resolveSortColumn),
        // so the two modes never diverge on one definition — Grid::assertValid() makes
        // that misdeclaration loud at build time anyway. The rows:changed /
        // selection:changed emits inside sortRowsLocally fire with NO subscribers here
        // (GridCore wires them after construction) — deliberate, not a bug: the initial
        // paint reads store.rows directly, so the very first frame is already sorted with
        // no visible reflow. localSeedRows captures the HOST'S original order, so the
        // third click of the cycle restores it, NOT the defaultSort (pinned by
        // run-sort-vectors — do not "helpfully" change that contract).
        if (!this.serverSide) {
            const defaultCol = defaultSort && defaultSort.col
                ? this.columns.find((c) => c && c.key === defaultSort.col)
                : null;

            if (this.canSort && defaultCol && defaultCol.sortable) {
                this.sortRowsLocally(defaultSort.col, defaultSort.dir === 'desc' ? 'desc' : 'asc');
            } else if (this.query.sort !== null) {
                // The constructor pre-seeded query from defaultSort; an in-memory grid
                // that cannot honour it (editable mode / non-sortable column) must not
                // let the state — or the header caret painted from it — claim an order
                // that was never applied.
                this.query.sort = null;
                this.query.dir = 'asc';
            }
        }
    }

    /** The next monotonic op sequence number. */
    nextSeq() {
        return ++this.seqCounter;
    }

    /**
     * Replace the full row set. The single entry point for row data — initial payload today,
     * and (M3+) server pages / draft-store rows tomorrow, so callers never mutate rows directly.
     *
     * @param {object[]} rows
     * @param {{localSort?: boolean}} [opts] internal flag — a local-sort reorder must NOT
     *     reset the local sort state it is itself maintaining
     */
    setRows(rows, opts = {}) {
        if (!opts.localSort && (this.localSeedRows !== null
            || (this.hiddenStash && this.hiddenStash.size > 0))) {
            // External data replacement while local VIEW state (a local sort and/or
            // F9-hidden rows) is active: the new payload is authoritative — drop the
            // stale seed copy, clear the sort state, and un-hide everything so neither
            // the caret nor the totals claim a view the data no longer has.
            this.localSeedRows = null;
            this.query.sort = null;
            this.query.dir = 'asc';
            if (this.hiddenStash && this.hiddenStash.size > 0) {
                this.hiddenStash.clear();
                this.bus.emit('rows:hidden', { count: 0 });
            }
        }
        this.rows = rows;
        this.rowByKey.clear();
        for (let i = 0; i < rows.length; i++) {
            this.rowByKey.set(rows[i]._k, { row: rows[i], index: i });
        }
        this.bus.emit('rows:changed', { rows });
    }

    /**
     * Apply a server page (M3): replace rows, update pagination meta + totals, remember the query
     * that produced it, then emit page:changed. Rows go through setRows, so the renderer's
     * rows:changed repaint + the SelectionPainter re-anchor path (M2 follow-up #1) fire unchanged —
     * NO parallel repaint path. `query` is the request signature this page answers.
     *
     * @param {{rows: object[], total: number, page: number, perPage: number, lastPage: number, pageTotals: Object, grandTotals: Object}} page
     * @param {object} query the request that produced this page
     */
    setPage(page, query) {
        this.deferredInitial = false; // page 1 (or any page) arrived — the deferral is over
        this.serverMeta = {
            total: page.total || 0,
            page: page.page || 1,
            perPage: page.perPage || this.serverMeta.perPage,
            lastPage: page.lastPage || 1,
        };
        this.pageTotals = page.pageTotals || {};
        this.grandTotals = page.grandTotals || {};
        if (query) {
            this.query = { ...query, page: this.serverMeta.page, perPage: this.serverMeta.perPage };
        }
        this.setRows(page.rows || []);
        this.bus.emit('page:changed', { meta: this.serverMeta, query: this.query });
    }

    /**
     * Cycle a column's LOCAL sort — asc → desc → restore seed order — for an in-memory
     * DISPLAY grid. The client-side counterpart of PageSource.sort() with the same
     * three-click contract. No-ops on server-side grids (PageSource owns those) and on
     * editable grids (row order is domain state).
     */
    cycleSort(colKey) {
        if (this.serverSide || this.editable) {
            return;
        }
        if (this.query.sort === colKey && this.query.dir === 'asc') {
            this.sortRowsLocally(colKey, 'desc');
            return;
        }
        if (this.query.sort === colKey && this.query.dir === 'desc') {
            // Third click: restore the untouched seed order and clear the sort state —
            // MINUS any F9-hidden rows: a sort-clear must never resurrect them (Shift+F9
            // is the only restore). While rows stay hidden the seed copy is KEPT, because
            // restoreHiddenRows() still needs it for the no-sort insertion order.
            const seedAll = this.localSeedRows || this.rows;
            const seed = this.hiddenStash.size > 0
                ? seedAll.filter((row) => !this.hiddenStash.has(row._k))
                : seedAll;
            this.localSeedRows = this.hiddenStash.size > 0 ? seedAll : null;
            this.query.sort = null;
            this.query.dir = 'asc';
            this.selection = null;
            this.setRows(seed, { localSort: true });
            this.bus.emit('selection:changed', { selection: null });
            return;
        }
        this.sortRowsLocally(colKey, 'asc');
    }

    /**
     * Reorder the rows by one column's values and repaint (setRows → rows:changed drives
     * the full body render — no parallel paint path, so the SerialColumn gutter renumbers
     * and the footer stays untouched exactly as on a server sort).
     *
     * Guarantees (pinned by tests/js/run-sort-vectors.mjs): explicitly STABLE (index
     * tiebreak — equal keys keep their current order, so asc ↔ desc round trips are
     * lossless); empties (null/undefined/'') rank LAST in BOTH directions (a Trial
     * Balance ships '' for a zero side so the cell paints blank — that must never sort
     * as 0 or as a lexical ""); values compare via compareCellValues (numeric-aware).
     * The index-space selection rectangle is cleared — a rectangle over rows that just
     * moved is meaningless — while active/anchor survive by design (stable rowKey).
     */
    sortRowsLocally(colKey, dir) {
        if (this.serverSide || this.editable) {
            return;
        }
        if (this.localSeedRows === null) {
            this.localSeedRows = this.rows.slice();
        }
        const mul = dir === 'desc' ? -1 : 1;
        const isEmpty = (v) => v === null || v === undefined || v === '';
        const decorated = this.rows.map((row, index) => ({ row, index }));
        decorated.sort((a, b) => {
            const va = a.row[colKey];
            const vb = b.row[colKey];
            const ea = isEmpty(va);
            const eb = isEmpty(vb);
            if (ea || eb) {
                return ea && eb ? a.index - b.index : (ea ? 1 : -1);
            }
            const cmp = compareCellValues(va, vb);
            return cmp !== 0 ? mul * cmp : a.index - b.index;
        });
        this.query.sort = colKey;
        this.query.dir = dir;
        this.selection = null;
        this.setRows(decorated.map((d) => d.row), { localSort: true });
        this.bus.emit('selection:changed', { selection: null });
    }

    /**
     * Temporarily hide one row from a DISPLAY grid's view (F9) — the accountant's
     * what-if. Strictly view state: the row moves to hiddenStash, the seed order is
     * captured (shared with the local sort's third-click contract), and the footer's
     * aggregates recompute over what remains (localAggregate via FooterRenderer). No-op
     * on server-side and editable grids.
     *
     * @returns {boolean} whether a row was hidden
     */
    hideRowLocally(rowKey) {
        if (this.serverSide || this.editable) {
            return false;
        }
        const hit = this.rowByKey.get(rowKey);
        if (!hit) {
            return false;
        }
        if (this.localSeedRows === null) {
            this.localSeedRows = this.rows.slice();
        }
        this.hiddenStash.set(rowKey, hit.row);
        this.selection = null;
        this.setRows(this.rows.filter((row) => row._k !== rowKey), { localSort: true });
        this.bus.emit('rows:hidden', { count: this.hiddenStash.size });
        this.bus.emit('selection:changed', { selection: null });
        return true;
    }

    /**
     * Restore ALL F9-hidden rows (Shift+F9). With a local sort active the restored set is
     * re-sorted under the current sort; otherwise rows return to the captured seed order.
     *
     * @returns {boolean} whether anything was restored
     */
    restoreHiddenRows() {
        if (this.serverSide || this.editable || this.hiddenStash.size === 0) {
            return false;
        }
        const all = this.rows.concat(Array.from(this.hiddenStash.values()));
        this.hiddenStash.clear();

        if (this.query.sort) {
            this.rows = all;
            this.sortRowsLocally(this.query.sort, this.query.dir);
        } else {
            const seed = this.localSeedRows || all;
            const present = new Set(all.map((row) => row._k));
            this.localSeedRows = null; // nothing hidden + no sort → fresh view state
            this.setRows(seed.filter((row) => present.has(row._k)), { localSort: true });
        }

        this.bus.emit('rows:hidden', { count: 0 });
        return true;
    }

    /**
     * One footer aggregate computed over the VISIBLE rows — used by FooterRenderer while
     * hiddenStash is non-empty, so the totals track the what-if view instead of the baked
     * full-set values. sum skips empties (null/'' — the blank-cell convention), count is
     * the visible row count; any other op falls back to the baked value upstream.
     */
    localAggregate(agg) {
        if (agg.op === 'count') {
            return this.rows.length;
        }
        let sum = 0;
        for (const row of this.rows) {
            const value = row[agg.column];
            if (value === null || value === undefined || value === '') {
                continue;
            }
            const n = Number(value);
            if (!Number.isNaN(n)) {
                sum += n;
            }
        }
        return sum;
    }

    /** @returns {number} */
    rowCount() {
        return this.rows.length;
    }

    /**
     * The value a column reads for a row: its resolved `key` from the row object.
     * @param {object} row
     * @param {object} column
     */
    cellValue(row, column) {
        return row[column.key];
    }

    /** Visible columns in display order (the definition's `visible` flag AND operator hides). */
    visibleColumns() {
        return this.columns.filter((c) => c.visible !== false && !this.userHidden.has(c.key));
    }

    /**
     * Header groups with start/span RECOMPUTED over the visible columns (M7): the serialized
     * start/span were resolved against the full column list, so hiding a column would draw a
     * group over the wrong tracks. Groups whose members are all hidden drop out entirely.
     * @returns {Array<object>}
     */
    visibleGroups() {
        const indexByKey = new Map(this.visibleColumns().map((c, i) => [c.key, i]));
        const out = [];
        for (const group of this.groups || []) {
            const indexes = (group.columns || [])
                .filter((key) => indexByKey.has(key))
                .map((key) => indexByKey.get(key))
                .sort((a, b) => a - b);
            if (indexes.length === 0) {
                continue;
            }
            out.push({ ...group, start: indexes[0], span: indexes.length });
        }
        return out;
    }

    // ---- Cell addressing (index <-> key) --------------------------------------------------

    /**
     * Navigability mask over the VISIBLE columns, in display order — true where the active cell
     * may land (a column's serialized `navigable`; false for the serial gutter / hidden columns).
     * This is the ONE skip predicate util/geometry consumes; M4 widens `navigable` upstream.
     * @returns {boolean[]}
     */
    navigabilityMask() {
        return this.visibleColumns().map((c) => c.navigable !== false);
    }

    /** The visible column index for a column key, or -1. */
    colIndexOf(colKey) {
        return this.visibleColumns().findIndex((c) => c.key === colKey);
    }

    /** The visible column at an index, or null. */
    columnAt(colIndex) {
        return this.visibleColumns()[colIndex] || null;
    }

    /** The row index for a row key, or -1. */
    rowIndexOf(rowKey) {
        const hit = this.rowByKey.get(rowKey);
        return hit ? hit.index : -1;
    }

    /** The row object at an index, or null. */
    rowAt(rowIndex) {
        return this.rows[rowIndex] || null;
    }

    /**
     * Resolve an {rowKey,colKey} address to {row, col} indices (both -1 if not found).
     * @param {{rowKey: string, colKey: string}|null} addr
     */
    indexOf(addr) {
        if (!addr) {
            return { row: -1, col: -1 };
        }
        return { row: this.rowIndexOf(addr.rowKey), col: this.colIndexOf(addr.colKey) };
    }

    /**
     * Resolve {row,col} indices back to a stable {rowKey,colKey} address, or null if out of range.
     * @param {number} rowIndex
     * @param {number} colIndex
     */
    addressAt(rowIndex, colIndex) {
        const row = this.rowAt(rowIndex);
        const column = this.columnAt(colIndex);
        if (!row || !column) {
            return null;
        }
        return { rowKey: row._k, colKey: column.key };
    }

    // ---- Cell values for clipboard / status bar ------------------------------------------

    /**
     * The RAW model value at an address (decimal string, int, ISO date, app-cast value, etc.).
     * Used by the status bar's numeric aggregation. Null when the cell doesn't resolve.
     */
    rawValueAt(rowIndex, colIndex) {
        const row = this.rowAt(rowIndex);
        const column = this.columnAt(colIndex);
        if (!row || !column) {
            return null;
        }
        return row[column.key];
    }

    /**
     * The current selection as a 2D grid of cells: an array of rows, each an array of
     * `{column, value}` in column order. 'all' expands to the full navigable rectangle. Empty
     * when there is no selection. The one shape both the clipboard (TSV) and the status bar
     * (numeric aggregate) read, so they never re-derive the rectangle.
     *
     * @returns {Array<Array<{column: object, value: *}>>}
     */
    selectedCells() {
        const sel = this.selection;
        if (!sel) {
            // No range: fall back to the single active cell if any.
            const a = this.indexOf(this.active);
            if (a.row < 0 || a.col < 0) {
                return [];
            }
            const column = this.columnAt(a.col);
            const row = this.rowAt(a.row);
            return column && row ? [[{ column, value: row[column.key] }]] : [];
        }

        const out = [];
        for (let r = sel.r0; r <= sel.r1; r++) {
            const row = this.rowAt(r);
            if (!row) {
                continue;
            }
            const cells = [];
            for (let c = sel.c0; c <= sel.c1; c++) {
                const column = this.columnAt(c);
                if (column) {
                    cells.push({ column, value: row[column.key] });
                }
            }
            out.push(cells);
        }
        return out;
    }

    // ---- Interaction-state setters (called by the M2 command surface) --------------------

    /**
     * Set the active cell to an address and collapse the selection to that single cell (unless
     * `keepAnchor` is true, in which case the anchor is preserved so a range can be extended).
     * Emits active:changed and selection:changed.
     *
     * @param {{rowKey: string, colKey: string}} addr
     * @param {object} [opts]
     * @param {boolean} [opts.keepAnchor] preserve the existing anchor (range extension)
     * @param {string} [opts.kind] selection kind label when keepAnchor (e.g. 'range')
     */
    setActive(addr, opts = {}) {
        if (!addr) {
            return;
        }
        this.active = addr;
        if (!opts.keepAnchor || !this.anchor) {
            this.anchor = addr;
        }
        this.recomputeSelection(opts.kind || 'cell');
        this.bus.emit('active:changed', { active: this.active });
    }

    /**
     * Set an explicit selection rectangle (row/column/all selection) and place the active cell.
     * @param {{r0: number, r1: number, c0: number, c1: number}} rect
     * @param {string} kind 'row' | 'col' | 'all'
     * @param {{rowKey: string, colKey: string}} activeAddr the cell to mark active within it
     * @param {{rowKey: string, colKey: string}} anchorAddr the range origin
     */
    setSelectionRect(rect, kind, activeAddr, anchorAddr) {
        this.anchor = anchorAddr;
        this.active = activeAddr;
        this.selection = { ...rect, kind };
        this.bus.emit('active:changed', { active: this.active });
        this.bus.emit('selection:changed', { selection: this.selection });
    }

    /** Collapse the selection to the active cell (Esc). */
    collapseSelection() {
        if (!this.active) {
            return;
        }
        this.anchor = this.active;
        this.recomputeSelection('cell');
    }

    /**
     * Recompute the normalised selection rectangle from anchor + active and emit selection:changed.
     * @param {string} kind
     */
    recomputeSelection(kind) {
        const a = this.indexOf(this.anchor);
        const b = this.indexOf(this.active);
        if (a.row < 0 || b.row < 0) {
            this.selection = null;
        } else {
            this.selection = {
                r0: Math.min(a.row, b.row),
                r1: Math.max(a.row, b.row),
                c0: Math.min(a.col, b.col),
                c1: Math.max(a.col, b.col),
                kind,
            };
        }
        this.bus.emit('selection:changed', { selection: this.selection });
    }

    // ---- Editable mutators (M4) — optimistic, keyed by `_k`; the SyncManager flushes ops ----

    /**
     * Column definition by key, or null.
     * @param {string} colKey
     */
    columnByKey(colKey) {
        return this.columns.find((c) => c && c.key === colKey) || null;
    }

    /**
     * Whether a cell is LOCKED for this row by its column's declarative `lockedWhen`
     * ({column, in} — serialized only when declared, e.g. the voucher Debit under dc='C').
     * A locked cell refuses the editor, is skipped by horizontal/wrap navigation, and paints
     * muted — evaluated instantly against the row's own value, so the client never has to
     * guess a server-only per-row readonly verdict.
     *
     * @param {object|null} row the row object (not the key)
     * @param {object|null} column the serialized column config
     * @returns {boolean}
     */
    cellLocked(row, column) {
        const lock = column && column.lockedWhen;
        if (!lock || !row) {
            return false;
        }
        const value = row[lock.column];
        const current = value == null ? '' : String(value);
        return (lock.in || []).some((candidate) => String(candidate) === current);
    }

    /**
     * The column keys whose `lockedWhen` is CONTROLLED by `colKey` — the sibling cells whose
     * locked look must repaint when a `colKey` cell changes (e.g. dc → [dr, cr]).
     *
     * @param {string} colKey
     * @returns {string[]}
     */
    lockedDependentsOf(colKey) {
        return this.columns
            .filter((c) => c && c.lockedWhen && c.lockedWhen.column === colKey)
            .map((c) => c.key);
    }

    /**
     * Whether a cell is REQUIRED for this row — statically (`required: true`) or by its
     * column's declarative `requiredWhen` ({column, in} — e.g. the voucher Debit under dc='D').
     * Consumed by the NAV-Enter blank-required block (G7): an engaged row's active-side amount
     * must be filled before Enter flows on. A per-row 'dynamic' (closure) required stays a
     * server-only verdict and never blocks here.
     *
     * @param {object|null} row the row object (not the key)
     * @param {object|null} column the serialized column config
     * @returns {boolean}
     */
    cellRequired(row, column) {
        if (!column) {
            return false;
        }
        if (column.required === true) {
            return true;
        }
        const rule = column.requiredWhen;
        if (!rule || !row) {
            return false;
        }
        const value = row[rule.column];
        const current = value == null ? '' : String(value);
        return (rule.in || []).some((candidate) => String(candidate) === current);
    }

    /**
     * Whether the grid's declared complete guard (layout.complete) is satisfied. The only kind
     * is 'balanced': the two named amount columns sum equal and above zero (compared in fixed-point
     * hundredths, so '500' and '500.00' agree). False when no guard is declared — auto-append never stops.
     *
     * Why: consulted at the auto-append decision point (EditorManager.moveOrAppend) and the
     * blank-row Enter (KeyboardManager): a COMPLETE grid stops growing and signals the host
     * instead, the Busy "entry ends at Save" contract. Evaluated over the OPTIMISTIC rows, so
     * the commit that balances the grid is already visible when the advance runs.
     *
     * @returns {boolean}
     */
    isComplete() {
        const spec = this.layout && this.layout.complete;
        if (!spec || spec.kind !== 'balanced' || !Array.isArray(spec.columns)) {
            return false;
        }
        const [a, b] = spec.columns;
        if (!a || !b) {
            return false;
        }
        const sumA = this.sumMinorUnits(a);
        return sumA > 0 && sumA === this.sumMinorUnits(b);
    }

    /**
     * Whether EVERY editable cell of the row named by `rowKey` is blank (null/''). The shared
     * definition of "a blank entry row" used by the KeyboardManager complete-guard escape AND the
     * picker editors' end-of-list eligibility, so the two never diverge. A missing row is not blank.
     *
     * @param {string} rowKey
     * @returns {boolean}
     */
    rowIsBlankByKey(rowKey) {
        const hit = this.rowByKey.get(rowKey);
        if (!hit) {
            return false;
        }
        const template = (this.layout && this.layout.newRow) || {};
        return this.visibleColumns().every((column) => {
            if (!column.editable) {
                return true;
            }
            const value = hit.row[column.key];
            const preset = template[column.key];
            if (preset !== undefined && preset !== null) {
                // A factory default is not operator data (mirrors the server's
                // template-aware blank check); loose compare bridges '1' vs 1.
                return value == null || value === '' || String(value) === String(preset);
            }
            return value == null || value === '';
        });
    }

    /**
     * The number of rows with at least one filled editable cell — the client mirror of the
     * server's minRows accounting (blank auto-append rows never count).
     *
     * @returns {number}
     */
    nonBlankRowCount() {
        let count = 0;
        for (const row of this.rows) {
            if (!this.rowIsBlankByKey(row._k)) {
                count += 1;
            }
        }
        return count;
    }

    /**
     * Whether at least one row is NOT blank — i.e. the grid already holds real entered data.
     * Guards the end-of-list exit option: there is nothing to "end" on a wholly empty grid.
     *
     * @returns {boolean}
     */
    hasAnyFilledRow() {
        for (const row of this.rows) {
            if (!this.rowIsBlankByKey(row._k)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Sum a column's operator-typed amount strings across all rows, in integer minor units
     * (fixed-point hundredths; comma/space tolerant; blanks and non-numbers count 0) so
     * '500' and '500.00' agree exactly. A UI guard only — the server stays the authority.
     *
     * @param {string} colKey
     * @returns {number}
     */
    sumMinorUnits(colKey) {
        let total = 0;
        for (const row of this.rows) {
            const value = row[colKey];
            if (value == null || value === '') {
                continue;
            }
            const parsed = parseFloat(String(value).replace(/[,\s]/g, ''));
            if (!Number.isNaN(parsed)) {
                total += Math.round(parsed * 100);
            }
        }
        return total;
    }

    /**
     * Apply a cell edit to the client store OPTIMISTICALLY: write the parsed value, recompute any
     * dependent formulas, mark the touched cells dirty, and emit cells:changed so the Renderer
     * repaints just those cells. Returns the changed cell addresses (for the caller/painter).
     *
     * @param {string} rowKey
     * @param {string} colKey
     * @param {*} value the PARSED model value (parse.js already ran)
     * @returns {Array<{rowKey: string, colKey: string}>}
     */
    applyLocalSet(rowKey, colKey, value) {
        const hit = this.rowByKey.get(rowKey);
        if (!hit) {
            return [];
        }
        if (this.recorder && hit.row[colKey] !== value) {
            this.recorder.record({ t: 'set', rowKey, colKey, before: hit.row[colKey], after: value });
        }
        hit.row[colKey] = value;

        const changed = [{ rowKey, colKey }];
        this.markDirty(rowKey, colKey);

        // Recompute formulas that may depend on this column (cheap: re-evaluate all formulas over
        // the row; the server is authoritative and reconciles). Each changed formula repaints too.
        for (const fc of this.formulaColumns) {
            const next = evalExpr(fc.formula.ast, hit.row);
            if (hit.row[fc.key] !== next) {
                hit.row[fc.key] = next;
                changed.push({ rowKey, colKey: fc.key });
            }
        }

        this.bus.emit('cells:changed', { cells: changed });
        return changed;
    }

    /**
     * Insert a fresh blank row (all editable columns null) after `afterKey` (or appended), keyed by
     * the client-generated `newKey`. Structural → full body repaint via rows:changed.
     * @param {string} newKey
     * @param {string|null} afterKey
     */
    insertRow(newKey, afterKey = null) {
        const template = (this.layout && this.layout.newRow) || {};
        const blank = { _k: newKey };
        for (const c of this.columns) {
            if (c && c.key && !c.key.startsWith('_')) {
                // Seed factory defaults (layout.newRow) so the optimistic row matches the
                // server's makeNewRow — otherwise the client shows empties while the host
                // property already carries the defaults (drift at save).
                blank[c.key] = template[c.key] !== undefined ? template[c.key] : null;
            }
        }
        const at = afterKey !== null ? this.rowIndexOf(afterKey) : -1;
        if (at < 0) {
            this.rows.push(blank);
        } else {
            this.rows.splice(at + 1, 0, blank);
        }
        this.reindex();
        if (this.recorder) {
            this.recorder.record({
                t: 'insert', rowKey: newKey, index: this.rowIndexOf(newKey), snapshot: { ...blank },
            });
        }
        this.bus.emit('rows:changed', { rows: this.rows });
        return blank;
    }

    /**
     * Remove a row by key. Structural → full body repaint.
     * @param {string} rowKey
     */
    removeRow(rowKey) {
        const at = this.rowIndexOf(rowKey);
        if (at < 0) {
            return;
        }
        if (this.recorder) {
            const row = this.rows[at];
            this.recorder.record({
                t: 'remove', rowKey, index: at,
                snapshot: { ...row, _labels: { ...(row._labels || {}) } },
            });
        }
        this.rows.splice(at, 1);
        this.clearRowState(rowKey);
        this.reindex();
        this.bus.emit('rows:changed', { rows: this.rows });
    }

    /**
     * Duplicate a row's values under a new key, placed right after the source.
     * @param {string} rowKey
     * @param {string} newKey
     */
    dupRow(rowKey, newKey) {
        const at = this.rowIndexOf(rowKey);
        if (at < 0) {
            return null;
        }
        const clone = { ...this.rows[at], _k: newKey };
        this.rows.splice(at + 1, 0, clone);
        this.reindex();
        if (this.recorder) {
            this.recorder.record({
                t: 'insert', rowKey: newKey, index: at + 1,
                snapshot: { ...clone, _labels: { ...(clone._labels || {}) } },
            });
        }
        this.bus.emit('rows:changed', { rows: this.rows });
        return clone;
    }

    /**
     * Re-insert a previously removed row snapshot at an index (the UndoManager's restore path —
     * undo of a remove / redo of an insert). Structural → full body repaint. Deliberately NOT
     * recorded: only replay calls it, and replay never records itself.
     *
     * @param {object} row the full row snapshot (carrying `_k` and `_labels`)
     * @param {number} index
     */
    restoreRow(row, index) {
        const at = Math.max(0, Math.min(index, this.rows.length));
        this.rows.splice(at, 0, row);
        this.reindex();
        this.bus.emit('rows:changed', { rows: this.rows });
        return row;
    }

    /**
     * Host-initiated wholesale row replacement (`lgrid:reseed`, Phase 2 reseed seam): the host's
     * save() mutated the bound rows OUTSIDE the op protocol (blank trailing row dropped on a
     * failure; a fresh seed after a successful post), so every piece of editing bookkeeping here
     * describes rows that may no longer exist. Drop it all, adopt the authoritative rows through
     * the setRows repaint seam (rows:changed → body repaint + painter/error re-asserts), and
     * re-anchor the active cell: kept if its row survived (a failure reseed preserves kept-row
     * keys), else the first navigable cell so the keyboard flow never dies with the old rows.
     *
     * @param {object[]} rows the server-serialized rows (`config.rows` shape — _k + _labels intact)
     */
    /**
     * Toggle a row's bulk-selection check (the selector gutter, P7). Emits checked:changed
     * for the gutter visuals and the toolbar bulk bar.
     * @param {string} rowKey
     */
    toggleChecked(rowKey) {
        if (this.checked.has(rowKey)) {
            this.checked.delete(rowKey);
        } else {
            this.checked.add(rowKey);
        }
        this.bus.emit('checked:changed', { checked: this.checked });
    }

    /** Check every current row (the bulk bar's Select all). */
    checkAll() {
        for (const row of this.rows) {
            this.checked.add(row._k);
        }
        this.bus.emit('checked:changed', { checked: this.checked });
    }

    /** Clear the bulk selection. */
    clearChecked() {
        if (this.checked.size === 0) {
            return;
        }
        this.checked.clear();
        this.bus.emit('checked:changed', { checked: this.checked });
    }


    reseed(rows) {
        this.clearChecked();
        this.dirty.clear();
        this.pending.clear();
        this.errors.clear();
        this.opLog = [];
        this.version = 0;
        if (this.recorder) {
            // The reseed replaced the rows wholesale — every undo record describes rows that
            // may no longer exist, so the history must die with them.
            this.recorder.clear();
        }
        this.setRows(rows || []);

        if (this.active && this.rowByKey.has(this.active.rowKey)) {
            // Same key, possibly a different index — setActive re-collapses the selection rect.
            this.setActive(this.active);
        } else {
            const colIndex = this.navigabilityMask().indexOf(true);
            const addr = colIndex >= 0 ? this.addressAt(0, colIndex) : null;
            if (addr) {
                this.setActive(addr);
            } else {
                this.active = null;
                this.anchor = null;
                this.selection = null;
                this.bus.emit('active:changed', { active: null });
                this.bus.emit('selection:changed', { selection: null });
            }
        }

        this.bus.emit('errors:changed', { errors: this.errors });
    }

    /**
     * Set (or clear with a null/undefined label) a picker cell's display label in the row's
     * `_labels` bag (M5). Display-only: painting a searchselect cell reads this so it NEVER
     * queries for a label; RowSerializer strips the bag at save. Emits cells:changed so the
     * select painter repaints the one cell.
     *
     * @param {string} rowKey
     * @param {string} colKey
     * @param {string|null} label
     */
    setRowLabel(rowKey, colKey, label) {
        const hit = this.rowByKey.get(rowKey);
        if (!hit) {
            return;
        }
        if (this.recorder) {
            const before = (hit.row._labels || {})[colKey] ?? null;
            const after = label ?? null;
            if (before !== after) {
                this.recorder.record({ t: 'label', rowKey, colKey, before, after });
            }
        }
        const labels = { ...(hit.row._labels || {}) };
        if (label == null) {
            delete labels[colKey];
        } else {
            labels[colKey] = label;
        }
        hit.row._labels = labels;
        this.bus.emit('cells:changed', { cells: [{ rowKey, colKey }] });
    }

    /**
     * Fill-down: copy the first key's column value into the rest, recomputing their formulas.
     * @param {string} colKey
     * @param {string[]} rowKeys ordered; rowKeys[0] is the source
     */
    fillDown(colKey, rowKeys) {
        if (!rowKeys || rowKeys.length < 2) {
            return [];
        }
        const source = this.rowByKey.get(rowKeys[0]);
        if (!source) {
            return [];
        }
        const value = source.row[colKey];
        // A picker column's fill carries the source's display label too (a copied id with the
        // target's old label left behind would mislabel it — mirrors OpApplier::applyFill).
        const column = this.columnByKey(colKey);
        const isPicker = !!(column && column.parse && column.parse.kind === 'select');
        const sourceLabel = (source.row._labels || {})[colKey] || null;

        let changed = [];
        for (const key of rowKeys.slice(1)) {
            changed = changed.concat(this.applyLocalSet(key, colKey, value));
            if (isPicker) {
                this.setRowLabel(key, colKey, value != null ? sourceLabel : null);
            }
        }
        return changed;
    }

    /** Re-map rowByKey after a structural change (indices shift; keys are stable). */
    reindex() {
        this.rowByKey.clear();
        for (let i = 0; i < this.rows.length; i++) {
            this.rowByKey.set(this.rows[i]._k, { row: this.rows[i], index: i });
        }
    }

    // ---- Dirty / pending / error bookkeeping ---------------------------------------------

    markDirty(rowKey, colKey) {
        this.dirty.add(cellMapKey(rowKey, colKey));
        this.bus.emit('dirty:changed', { rowKey, colKey, dirty: true });
    }

    /** Mark cells as having an op in flight (SyncManager flush). */
    markPending(cells) {
        for (const { rowKey, colKey } of cells) {
            this.pending.add(cellMapKey(rowKey, colKey));
        }
        this.bus.emit('sync-state', { pending: this.pending.size, dirty: this.dirty.size });
    }

    /**
     * Reconcile a server op response: clear dirty/pending for acknowledged cells, apply the
     * authoritative write-back patch (unless a newer local edit supersedes it), set/clear errors,
     * and adopt the server version. Emits cells:changed for repainted cells + errors:changed.
     *
     * @param {{version: number, results: Array<object>, footer: object}} response
     */
    reconcile(response) {
        const repaint = [];
        if (typeof response.version === 'number') {
            this.version = response.version;
        }

        for (const result of response.results || []) {
            // Errors: set the cell/row error; a failed op leaves the cell dirty (unsaved) + errored.
            for (const [rowKey, cols] of Object.entries(result.errors || {})) {
                for (const [colKey, message] of Object.entries(cols)) {
                    this.errors.set(this.errorKey(rowKey, colKey), message);
                }
            }
            // Write-backs: adopt authoritative values (formula results, hook enrichments).
            for (const [rowKey, patch] of Object.entries(result.patch || {})) {
                const hit = this.rowByKey.get(rowKey);
                if (!hit) {
                    continue;
                }
                for (const [colKey, value] of Object.entries(patch)) {
                    // The `_labels` bag (M5): a hook-labelled enrichment — merge and repaint the
                    // labelled cells (there is no cellMapKey for the bag itself).
                    if (colKey === '_labels') {
                        hit.row._labels = { ...(hit.row._labels || {}), ...(value || {}) };
                        for (const labelled of Object.keys(value || {})) {
                            repaint.push({ rowKey, colKey: labelled });
                        }
                        continue;
                    }
                    // Skip a cell the user has since re-edited (a newer local dirty flag) or is
                    // actively editing — the server value is stale relative to the client (R4/reconcile).
                    const ck = cellMapKey(rowKey, colKey);
                    if (this.dirty.has(ck) && this.pending.has(ck) === false) {
                        continue;
                    }
                    hit.row[colKey] = value;
                    repaint.push({ rowKey, colKey });
                }
            }
        }

        // Clear pending/dirty for cells that succeeded (no error survived on them).
        for (const result of response.results || []) {
            if (result.ok) {
                // Clear any cells this op marked pending; success removes dirty + error.
                this.settleOp(result);
            }
        }

        if (repaint.length) {
            this.bus.emit('cells:changed', { cells: repaint });
        }
        this.bus.emit('errors:changed', { errors: this.errors });
        this.bus.emit('sync-state', { pending: this.pending.size, dirty: this.dirty.size });
    }

    /** Clear dirty/pending/error for the cells an acknowledged op covered. */
    settleOp(result) {
        // For a set/fill, the patch/error keys name the touched cells; clear their state.
        const rowKeys = new Set([
            ...Object.keys(result.patch || {}),
            ...Object.keys(result.errors || {}),
        ]);
        for (const rowKey of rowKeys) {
            for (const colKey of Object.keys((result.patch || {})[rowKey] || {})) {
                const ck = cellMapKey(rowKey, colKey);
                this.pending.delete(ck);
                this.dirty.delete(ck);
                this.errors.delete(ck);
            }
        }
    }

    /** Clear all edit bookkeeping for a removed row. */
    clearRowState(rowKey) {
        const prefix = rowKey;
        for (const key of [...this.dirty]) {
            if (key.startsWith(prefix)) {
                this.dirty.delete(key);
            }
        }
        for (const key of [...this.pending]) {
            if (key.startsWith(prefix)) {
                this.pending.delete(key);
            }
        }
        for (const key of [...this.errors.keys()]) {
            if (key.startsWith(prefix)) {
                this.errors.delete(key);
            }
        }
    }

    /** The current error for a cell (or `${rowKey}_row`), or null. */
    errorFor(rowKey, colKey) {
        return this.errors.get(this.errorKey(rowKey, colKey)) || null;
    }

    /** The canonical error-map key for a cell (or a row-level error when colKey === '_row'). */
    errorKey(rowKey, colKey) {
        return colKey === '_row' ? `${rowKey}_row` : cellMapKey(rowKey, colKey);
    }

    /**
     * Set (or clear when message is falsy) a client-side cell error and emit errors:changed so the
     * ErrorPainter repaints. The single seam callers use so the error key format lives in one place
     * (it must match cellMapKey, or the painter can't find the cell).
     */
    setError(rowKey, colKey, message) {
        const key = this.errorKey(rowKey, colKey);
        if (message) {
            this.errors.set(key, message);
        } else {
            this.errors.delete(key);
        }
        this.bus.emit('errors:changed', { errors: this.errors });
    }
}
