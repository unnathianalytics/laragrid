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
import { cellMapKey, splitClasses, NO_CLASSES } from '../util/dom.js';

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

/**
 * Move an inclusive row span [r0, r1] across one in-place insert or remove so it keeps covering
 * the same rows: rows inserted at or above r0 push it down, rows inserted inside it widen it,
 * removed rows above pull it up and removed rows inside shrink it. Shared by the store's
 * selection and SelectionPainter's painted rectangle, so the two always move together.
 *
 * @param {{r0: number, r1: number}} span
 * @param {{inserted?: {keys: string[], index: number}, removed?: {keys: string[], index: number}}} change
 * @returns {{r0: number, r1: number}|null} null when every row of the span was removed
 */
export function shiftRowSpan(span, change) {
    let { r0, r1 } = span;
    if (change.inserted) {
        const { index, keys } = change.inserted;
        if (index <= r0) {
            r0 += keys.length;
            r1 += keys.length;
        } else if (index <= r1) {
            r1 += keys.length;
        }
    }
    if (change.removed) {
        const lo = change.removed.index;
        const hi = lo + change.removed.keys.length - 1;
        if (hi < r0) {
            r0 -= change.removed.keys.length;
            r1 -= change.removed.keys.length;
        } else if (lo <= r1) {
            const above = Math.max(0, r0 - lo);
            const inside = Math.min(hi, r1) - Math.max(lo, r0) + 1;
            r0 -= above;
            r1 -= above + inside;
            if (r1 < r0) {
                return null;
            }
        }
    }
    return { r0, r1 };
}

const NO_DEPENDENTS = Object.freeze([]);
const NO_CLASS_DEPENDENTS = Object.freeze({ cells: NO_DEPENDENTS, row: false });

/**
 * The class tokens of every declarative rule ({column, in, class}) the row matches.
 *
 * @param {Array<{column: string, in: string[], class: string}>|undefined} rules
 * @param {object|null} row
 * @returns {string[]}
 */
function matchClassRules(rules, row) {
    if (!rules || rules.length === 0 || !row) {
        return NO_CLASSES;
    }
    let out = null;
    for (const rule of rules) {
        const value = row[rule.column];
        const current = value == null ? '' : String(value);
        if ((rule.in || []).some((candidate) => String(candidate) === current)) {
            out = (out || []).concat(splitClasses(rule.class));
        }
    }
    return out || NO_CLASSES;
}

/**
 * The operator-hidden column set: a Set whose in-place mutations (ColumnChooser.setHidden adds
 * and deletes keys directly) drop the store's visible-column memo, so a wholesale replacement
 * and an in-place edit both invalidate without the call sites knowing a memo exists.
 */
class HiddenColumnSet extends Set {
    constructor(store, keys) {
        super();
        this.store = store;
        for (const key of keys || []) {
            super.add(key);
        }
    }

    add(key) {
        super.add(key);
        this.store.invalidateColumns();
        return this;
    }

    delete(key) {
        const hit = super.delete(key);
        this.store.invalidateColumns();
        return hit;
    }

    clear() {
        super.clear();
        this.store.invalidateColumns();
    }
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

        /**
         * Column lookup memos: the visible list, its key → visible-index map and the key →
         * definition map. Every per-cell reader (navigation, selection paint, status bar)
         * goes through these; invalidateColumns() drops them all whenever the hidden set
         * or the column list changes.
         */
        this._visibleCache = null;
        this._visibleIndex = null;
        this._byKey = null;
        /** @type {Map<string, string[]>|null} lockedWhen controller key → dependent column keys. */
        this._lockDependents = null;
        /** @type {Map<string, {cells: string[], row: boolean}>|null} classWhen controller key → dependents. */
        this._classDependents = null;

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

        /**
         * Deferred rows (perf plan P1): an editable mount booted from a SHELL config — a host
         * re-render of a grid the browser already held, which ships no rows. GridCore fetches
         * them through gridReseedRows right after boot. Cleared by reseed() (that fetch, a
         * host lgrid:reseed or a draft restore — whichever lands first) and read by the
         * empty-state guard and the row-op guards while the rows are in flight.
         */
        this.rowsDeferred = !!config.rowsDeferred;

        /**
         * The operator's restored query (->persistQuery()): the server already BUILT the page
         * above from this exact state, so adopting it here is not a re-application — it is
         * telling the client the truth about what it is already showing. Without it the client
         * would believe it was displaying an unfiltered default and would paint cleared filter
         * controls over filtered rows. Absent for every grid that does not persist.
         */
        const restored = config.query || null;

        /** The query signature currently displayed (sort/dir/search/filters/page/perPage). */
        this.query = {
            sort: restored ? (restored.sort || null) : (defaultSort ? defaultSort.col : null),
            dir: restored ? (restored.dir === 'desc' ? 'desc' : 'asc') : (defaultSort ? defaultSort.dir : 'asc'),
            search: (restored && restored.search) || '',
            filters: restored && restored.filters ? { ...restored.filters } : {},
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
         * Chooser-eligible columns declared hidden on first paint. Kept separately so Reset
         * Layout restores the definition instead of making every column visible.
         * @type {Set<string>}
         */
        this.defaultHidden = new Set(this.columns
            .filter((column) => column.visible !== false && column.hiddenByDefault === true)
            .map((column) => column.key));
        /**
         * Columns currently hidden through chooser layout state. It begins with the definition's
         * defaults; a persisted layout or saved view may subsequently replace it wholesale (the
         * `userHidden` setter below wraps whatever Set is assigned).
         * @type {Set<string>}
         */
        this._userHidden = new HiddenColumnSet(this, this.defaultHidden);

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
        this.version = Number(config.version) || 0;
        /** @type {Set<string>} dirty cell keys (cellMapKey) awaiting server acknowledgement. */
        this.dirty = new Set();
        /** @type {Set<string>} pending cell keys with a queued or in-flight op. */
        this.pending = new Set();
        /** @type {Map<string, Set<number>>} exact unacknowledged op sequences per cell. */
        this.pendingSeqs = new Map();
        /** @type {Map<string, number>} newest optimistic op sequence touching each cell. */
        this.cellRevisions = new Map();
        /** Cells changed since the host last saved/reseeded; server acknowledgement does not clear it. */
        this.modified = new Set();
        /** True when row insertion/removal/reordering changed since the last host save/reseed. */
        this.structureModified = false;
        /** @type {Map<string, string>} error message by cellMapKey (or `${_k}_row` for row errors). */
        this.errors = new Map();
        /**
         * Cells whose value is a pasted picker LABEL the server has not resolved yet (F3):
         * cellMapKey → the lookup op's seq. A draft snapshot carries the keys so a reload
         * re-resolves them instead of storing the label as an id.
         * @type {Map<string, number>}
         */
        this.lookups = new Map();
        /**
         * Error keys set by the last grid-level validation result (`scope: 'rows'`, F5). The
         * next such result replaces them wholesale — an op-level settle never clears them.
         * @type {Set<string>}
         */
        this.rowsScopedErrors = new Set();
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
     * Temporarily hide one row from a non-editable grid's view (F9) — the accountant's
     * what-if. Strictly view state: the row moves to hiddenStash, the seed order is
     * captured (shared with the local sort's third-click contract), and the footer's
     * aggregates recompute over what remains (localAggregate via FooterRenderer). No-op
     * on server-side and editable grids.
     *
     * @returns {boolean} whether a row was hidden
     */
    hideRowLocally(rowKey) {
        if (this.editable) {
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
        if (this.editable || this.hiddenStash.size === 0) {
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

    /** @returns {Set<string>} the operator-hidden column keys (mutate in place or assign a Set). */
    get userHidden() {
        return this._userHidden;
    }

    set userHidden(keys) {
        this._userHidden = new HiddenColumnSet(this, keys);
        this.invalidateColumns();
    }

    /** Drop the column memos — after a hidden-set change or a column-list replacement. */
    invalidateColumns() {
        this._visibleCache = null;
        this._visibleIndex = null;
        this._byKey = null;
        this._lockDependents = null;
        this._classDependents = null;
    }

    /**
     * Visible columns in display order (the definition's `visible` flag AND operator hides).
     * Memoized: callers may read it per cell; they must not mutate the returned array.
     */
    visibleColumns() {
        if (this._visibleCache === null) {
            this._visibleCache = this.columns.filter((c) => c.visible !== false && !this._userHidden.has(c.key));
        }
        return this._visibleCache;
    }

    /** Visible-index by column key (memoized alongside visibleColumns). */
    visibleIndexMap() {
        if (this._visibleIndex === null) {
            this._visibleIndex = new Map(this.visibleColumns().map((c, i) => [c.key, i]));
        }
        return this._visibleIndex;
    }

    /**
     * Header groups with start/span RECOMPUTED over the visible columns (M7): the serialized
     * start/span were resolved against the full column list, so hiding a column would draw a
     * group over the wrong tracks. Groups whose members are all hidden drop out entirely.
     * @returns {Array<object>}
     */
    visibleGroups() {
        const indexByKey = this.visibleIndexMap();
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
        return this.visibleColumns().map((c) => c.navigable !== false && c.focusMode !== 'manual' && c.focusMode !== 'never');
    }

    /** The visible column index for a column key, or -1. */
    colIndexOf(colKey) {
        const index = this.visibleIndexMap().get(colKey);
        return index === undefined ? -1 : index;
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
        const cols = this.visibleColumns();
        for (let r = sel.r0; r <= sel.r1; r++) {
            const row = this.rowAt(r);
            if (!row) {
                continue;
            }
            const cells = [];
            for (let c = sel.c0; c <= sel.c1; c++) {
                const column = cols[c];
                if (column) {
                    cells.push({ column, value: row[column.key] });
                }
            }
            out.push(cells);
        }
        return out;
    }

    /**
     * The current selection as a flat list of stable `{rowKey, colKey}` addresses in row-major
     * order — the shape the mutating commands (Delete clear) need, as opposed to the
     * `{column, value}` grid selectedCells() hands the readers. Falls back to the active cell
     * when there is no range; empty when there is neither.
     *
     * @returns {Array<{rowKey: string, colKey: string}>}
     */
    selectedCellAddresses() {
        const sel = this.selection;
        if (!sel) {
            const a = this.indexOf(this.active);
            return a.row < 0 || a.col < 0 ? [] : [{ ...this.active }];
        }
        const out = [];
        const cols = this.visibleColumns();
        for (let r = sel.r0; r <= sel.r1; r++) {
            const row = this.rowAt(r);
            if (!row) {
                continue;
            }
            for (let c = sel.c0; c <= sel.c1; c++) {
                const column = cols[c];
                if (column) {
                    out.push({ rowKey: row._k, colKey: column.key });
                }
            }
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
        if (this._byKey === null) {
            this._byKey = new Map();
            for (const c of this.columns) {
                if (c && c.key && !this._byKey.has(c.key)) {
                    this._byKey.set(c.key, c);
                }
            }
        }
        return this._byKey.get(colKey) || null;
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
     * locked look must repaint when a `colKey` cell changes (e.g. dc → [dr, cr]). Built once
     * for all columns (the Renderer asks per changed cell per frame); callers must not mutate
     * the returned array.
     *
     * @param {string} colKey
     * @returns {string[]}
     */
    lockedDependentsOf(colKey) {
        if (this._lockDependents === null) {
            this._lockDependents = new Map();
            for (const c of this.columns) {
                if (c && c.lockedWhen) {
                    const dependents = this._lockDependents.get(c.lockedWhen.column) || [];
                    dependents.push(c.key);
                    this._lockDependents.set(c.lockedWhen.column, dependents);
                }
            }
        }
        return this._lockDependents.get(colKey) || NO_DEPENDENTS;
    }

    /**
     * The declarative host classes (`classWhen`, {column, in, class} — serialized only when
     * declared) this row's cell carries: evaluated against the row's own values, so the class
     * follows the controlling cell the instant it changes.
     *
     * @param {object|null} row
     * @param {object|null} column the serialized column config
     * @returns {string[]} class tokens (callers must not mutate)
     */
    cellClasses(row, column) {
        return matchClassRules(column && column.classWhen, row);
    }

    /**
     * The declarative host classes (`layout.rowClassWhen`) this row's element carries.
     *
     * @param {object|null} row
     * @returns {string[]} class tokens (callers must not mutate)
     */
    rowClasses(row) {
        return matchClassRules(this.layout && this.layout.rowClassWhen, row);
    }

    /**
     * What a change to `colKey` must repaint for the declarative classes: the column keys whose
     * `classWhen` reads it, and whether a `rowClassWhen` rule reads it. Built once (the Renderer
     * asks per changed cell per frame); callers must not mutate the result.
     *
     * @param {string} colKey
     * @returns {{cells: string[], row: boolean}}
     */
    classDependentsOf(colKey) {
        if (this._classDependents === null) {
            const map = new Map();
            const entryFor = (key) => {
                let entry = map.get(key);
                if (!entry) {
                    entry = { cells: [], row: false };
                    map.set(key, entry);
                }
                return entry;
            };
            for (const c of this.columns) {
                for (const rule of (c && c.classWhen) || []) {
                    const entry = entryFor(rule.column);
                    if (!entry.cells.includes(c.key)) {
                        entry.cells.push(c.key);
                    }
                }
            }
            for (const rule of (this.layout && this.layout.rowClassWhen) || []) {
                entryFor(rule.column).row = true;
            }
            this._classDependents = map;
        }
        return this._classDependents.get(colKey) || NO_CLASS_DEPENDENTS;
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
     * @param {{lookup?: boolean}} [opts] `lookup`: the value is a pasted picker label the server
     *        resolves (F3) — the undo record keeps the flag so a redo resolves it again
     * @returns {Array<{rowKey: string, colKey: string}>}
     */
    applyLocalSet(rowKey, colKey, value, opts) {
        const hit = this.rowByKey.get(rowKey);
        if (!hit) {
            return [];
        }
        if (this.recorder && hit.row[colKey] !== value) {
            const entry = { t: 'set', rowKey, colKey, before: hit.row[colKey], after: value };
            if (opts && opts.lookup) {
                entry.lookup = true;
            }
            this.recorder.record(entry);
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
     * Build the optimistic twin of Grid::makeNewRow(): every declared data column receives its
     * serialized new-row-template value (or null), under the client-generated stable key.
     * Insert, auto-append, paste growth and the last-row replacement all share this shape.
     *
     * @param {string} newKey
     * @returns {object}
     */
    makeDraftRow(newKey) {
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

        return blank;
    }

    /**
     * Insert a fresh blank row after `afterKey` (or appended), keyed by the client-generated
     * `newKey`. Structural — see insertRows for the repaint contract.
     * @param {string} newKey
     * @param {string|null} afterKey
     */
    insertRow(newKey, afterKey = null) {
        return this.insertRows([newKey], afterKey)[0];
    }

    /**
     * Insert several fresh blank rows in ONE structural pass (a multi-row paste): one splice,
     * one reindex, one undo record per row (all inside the same microtask batch, so they undo
     * as one step), one rows:changed, one markStructureModified. The rows land after
     * `afterKey`, or are appended.
     *
     * @param {string[]} keys client-generated row keys, in order
     * @param {string|null} afterKey
     * @returns {object[]} the blank rows
     */
    insertRows(keys, afterKey = null) {
        if (!keys || keys.length === 0) {
            return [];
        }
        const blanks = keys.map((key) => this.makeDraftRow(key));
        const at = afterKey !== null ? this.rowIndexOf(afterKey) : -1;
        const index = at < 0 ? this.rows.length : at + 1;
        this.rows.splice(index, 0, ...blanks);
        this.reindex();
        if (this.recorder) {
            blanks.forEach((blank, i) => this.recorder.record({
                t: 'insert', rowKey: blank._k, index: index + i, snapshot: { ...blank },
            }));
        }
        this.emitStructural({ inserted: { keys: blanks.map((blank) => blank._k), index } });
        return blanks;
    }

    /**
     * Publish a row insert/remove. The Renderer applies the structural delta from the dedicated
     * rows:inserted / rows:removed event, then sees `incremental: true` on the rows:changed
     * that follows and skips its full body rebuild (every other rows:changed subscriber —
     * painters, draft store, empty state — behaves as for any row change). A non-incremental
     * rows:changed (setRows) stays the full-rebuild seam.
     *
     * The index-space selection is moved with the rows first (silently — no selection:changed),
     * so copy, Delete and fill-down keep acting on the rows the operator selected and the
     * painter's diff on rows:changed finds nothing to repaint.
     *
     * @param {{inserted?: {keys: string[], index: number}, removed?: {keys: string[], index: number}, moved?: {key: string, from: number, to: number}}} change
     */
    emitStructural(change) {
        this.shiftSelection(change);
        if (change.inserted) {
            this.bus.emit('rows:inserted', change.inserted);
        }
        if (change.removed) {
            this.bus.emit('rows:removed', change.removed);
        }
        if (change.moved) {
            this.bus.emit('rows:moved', change.moved);
        }
        this.bus.emit('rows:changed', { rows: this.rows, incremental: true, ...change });
        this.markStructureModified();
    }

    /**
     * Keep the selection rectangle on its rows across an in-place insert/remove (active and
     * anchor are keys and follow on their own). Whole-column and select-all selections keep
     * spanning every row, appended rows included.
     */
    shiftSelection(change) {
        const sel = this.selection;
        if (!sel) {
            return;
        }
        // A row move scatters a rectangle: collapse it onto the active cell, which follows its
        // row by key.
        if (change.moved) {
            const at = this.active ? this.indexOf(this.active) : { row: -1, col: -1 };
            this.anchor = this.active;
            this.selection = at.row < 0 ? null : { r0: at.row, r1: at.row, c0: at.col, c1: at.col, kind: 'cell' };
            return;
        }
        if (sel.kind === 'all' || sel.kind === 'col') {
            this.selection = this.rows.length ? { ...sel, r0: 0, r1: this.rows.length - 1 } : null;
            return;
        }
        const span = shiftRowSpan(sel, change);
        this.selection = span ? { ...sel, ...span } : null;
    }

    /**
     * Replace one physical row with a fresh draft in ONE structural repaint. This is the
     * zero-logical-row auto-append invariant: deleting the final physical row must never expose
     * a zero-row editable surface, but the replacement remains template-blank and therefore does
     * not count toward minRows/totals/save rows. The paired recorder entries deliberately share
     * the current task, so undo/redo owns the swap as one step with no duplicate draft.
     *
     * @param {string} rowKey the sole row being removed
     * @param {string} newKey the unique key for its replacement draft
     * @returns {object|null}
     */
    replaceRowWithDraft(rowKey, newKey) {
        const at = this.rowIndexOf(rowKey);
        if (at < 0 || newKey === rowKey || this.rowByKey.has(newKey)) {
            return null;
        }

        const removed = this.rows[at];
        const draft = this.makeDraftRow(newKey);
        if (this.recorder) {
            this.recorder.record({
                t: 'remove', rowKey, index: at,
                snapshot: { ...removed, _labels: { ...(removed._labels || {}) } },
            });
            this.recorder.record({
                t: 'insert', rowKey: newKey, index: at, snapshot: { ...draft },
            });
        }

        this.rows.splice(at, 1, draft);
        this.clearRowState(rowKey);
        this.reindex();
        this.bus.emit('rows:changed', { rows: this.rows });
        this.markStructureModified();

        return draft;
    }

    /**
     * Remove a row by key. Structural (incremental repaint — see emitStructural).
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
        this.emitStructural({ removed: { keys: [rowKey], index: at } });
    }

    /**
     * Move a row to a new index (F4: Alt+Up / Alt+Down, the gutter drag, undo of a move).
     * Structural and incremental like insert/remove: one splice, one reindex, one undo record,
     * `rows:moved` then an incremental `rows:changed`. A move onto the current index is a no-op.
     *
     * @param {string} rowKey
     * @param {number} toIndex clamped to the row range
     * @returns {boolean} whether the row moved
     */
    moveRow(rowKey, toIndex) {
        const from = this.rowIndexOf(rowKey);
        if (from < 0) {
            return false;
        }
        const to = Math.max(0, Math.min(toIndex, this.rows.length - 1));
        if (to === from) {
            return false;
        }
        const [row] = this.rows.splice(from, 1);
        this.rows.splice(to, 0, row);
        if (this.recorder) {
            this.recorder.record({ t: 'move', rowKey, from, to });
        }
        this.reindex();
        this.emitStructural({ moved: { key: rowKey, from, to } });
        return true;
    }

    /**
     * The wire op that places `rowKey` where it now is: `before` the next row, else `after` the
     * previous row (the server resolves the anchor among the other rows, like insert).
     *
     * @param {string} rowKey
     * @returns {{seq: number, t: 'move', row: string, before?: string, after?: string}}
     */
    moveOpFor(rowKey) {
        const at = this.rowIndexOf(rowKey);
        const op = { seq: this.nextSeq(), t: 'move', row: rowKey };
        const next = this.rows[at + 1];
        const prev = at > 0 ? this.rows[at - 1] : null;
        if (next) {
            op.before = next._k;
        } else if (prev) {
            op.after = prev._k;
        }
        return op;
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
        this.emitStructural({ inserted: { keys: [newKey], index: at + 1 } });
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
        this.emitStructural({ inserted: { keys: [row._k], index: at } });
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
        this.rowsDeferred = false;
        this.clearChecked();
        this.dirty.clear();
        this.pending.clear();
        this.pendingSeqs.clear();
        this.cellRevisions.clear();
        this.modified.clear();
        this.structureModified = false;
        this.errors.clear();
        this.lookups.clear();
        this.rowsScopedErrors.clear();
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

        this.bus.emit('errors:changed', { errors: this.errors, keys: [] });
        this.emitEditState();
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
            // cellLocked() wants the row OBJECT and the column config — a key pair would read
            // the lock off `undefined` and never skip anything.
            const target = this.rowByKey.get(key);
            if (!target || this.cellLocked(target.row, column)) {
                continue;
            }
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
        const key = cellMapKey(rowKey, colKey);
        this.dirty.add(key);
        this.modified.add(key);
        this.bus.emit('dirty:changed', { rowKey, colKey, dirty: true });
        this.emitEditState();
    }

    /** Mark cells as covered by a queued op and remember its exact revision. */
    markPending(cells, seq = 0) {
        this.markPendingBatch([{ cells, seq }]);
    }

    /**
     * markPending for several queued ops at once (a paste or fill batch): every cell is marked
     * first, then ONE sync-state carrying all of them and ONE edit-state go out.
     *
     * @param {Array<{cells: Array<{rowKey: string, colKey: string}>, seq: number}>} items
     */
    markPendingBatch(items) {
        if (items.length === 0) {
            return;
        }
        const all = items.length === 1 ? items[0].cells : [];
        for (const { cells, seq = 0 } of items) {
            for (const cell of cells) {
                const key = cellMapKey(cell.rowKey, cell.colKey);
                this.pending.add(key);
                if (!this.pendingSeqs.has(key)) {
                    this.pendingSeqs.set(key, new Set());
                }
                this.pendingSeqs.get(key).add(seq);
                this.cellRevisions.set(key, Math.max(seq, this.cellRevisions.get(key) || 0));
                if (all !== cells) {
                    all.push(cell);
                }
            }
        }
        this.bus.emit('sync-state', {
            pending: this.pending.size,
            dirty: this.dirty.size,
            modified: this.modified.size,
            cells: all,
        });
        this.emitEditState();
    }

    /**
     * Reconcile a server op response: clear dirty/pending for acknowledged cells, apply the
     * authoritative write-back patch (unless a newer local edit supersedes it), set/clear errors,
     * and adopt the server version. Emits cells:changed for repainted cells + errors:changed.
     *
     * `batchItems` is the client-side acknowledgement context. A successful direct SET normally
     * has an empty server patch, so result.patch can never be used to infer which cells settled.
     *
     * @param {{version: number, results: Array<object>, footer: object}} response
     * @param {Array<{op: object, cells: Array<{rowKey: string, colKey: string}>}>} [batchItems]
     */
    reconcile(response, batchItems = []) {
        const repaint = [];
        const changedErrors = new Set();
        const changedState = new Map();
        const bySeq = new Map(batchItems.map((item) => [item.op.seq, item]));
        if (typeof response.version === 'number') {
            this.version = response.version;
        }

        for (const result of response.results || []) {
            // A grid-level validation result (`scope: 'rows'`, appended after the op results)
            // replaces the previous one's messages; it carries no patch and settles no cells.
            if (result.scope === 'rows') {
                this.applyRowsScopedErrors(result, changedErrors);
                continue;
            }
            const item = bySeq.get(result.seq);
            // Errors: accept only when a newer optimistic edit has not superseded this result.
            for (const [rowKey, cols] of Object.entries(result.errors || {})) {
                for (const [colKey, message] of Object.entries(cols)) {
                    const key = this.errorKey(rowKey, colKey);
                    const revisionKey = colKey === '_row' ? null : cellMapKey(rowKey, colKey);
                    if (revisionKey && (this.cellRevisions.get(revisionKey) || 0) > result.seq) {
                        continue;
                    }
                    if (this.errors.get(key) !== message) {
                        this.errors.set(key, message);
                        changedErrors.add(key);
                    }
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
                    // Refreshed closure classes (rowClass()/cellClass() grids): `_rowClass` is
                    // the row's new class (null = none) and repaints the row element through the
                    // `_rowClass` pseudo-cell; `_cellClass` replaces the row's whole map and
                    // repaints every cell whose class came or went.
                    if (colKey === '_rowClass') {
                        if (value == null || value === '') {
                            delete hit.row._rowClass;
                        } else {
                            hit.row._rowClass = value;
                        }
                        repaint.push({ rowKey, colKey: '_rowClass' });
                        continue;
                    }
                    if (colKey === '_cellClass') {
                        const next = value && !Array.isArray(value) ? value : {};
                        const previous = hit.row._cellClass || {};
                        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
                            if (previous[key] !== next[key]) {
                                repaint.push({ rowKey, colKey: key });
                            }
                        }
                        if (Object.keys(next).length === 0) {
                            delete hit.row._cellClass;
                        } else {
                            hit.row._cellClass = next;
                        }
                        continue;
                    }
                    // A per-cell sequence, rather than a boolean dirty/pending pair, makes this
                    // safe when edit N+1 is queued while response N is still in flight.
                    const ck = cellMapKey(rowKey, colKey);
                    if ((this.cellRevisions.get(ck) || 0) > result.seq) {
                        continue;
                    }
                    hit.row[colKey] = value;
                    repaint.push({ rowKey, colKey });
                }
            }

            // Every acknowledged result settles its exact submitted cells. Failed validation
            // clears pending but deliberately keeps dirty + error so it remains fixable. Only
            // an error the settle actually cleared counts as an error change.
            const cells = (item && item.cells) || [];
            const errored = cells
                .map((cell) => this.errorKey(cell.rowKey, cell.colKey))
                .filter((key) => this.errors.has(key));
            for (const cell of this.settleOp(result, cells)) {
                changedState.set(cellMapKey(cell.rowKey, cell.colKey), cell);
            }
            for (const key of errored) {
                if (!this.errors.has(key)) {
                    changedErrors.add(key);
                }
            }
        }

        if (repaint.length) {
            this.bus.emit('cells:changed', { cells: repaint });
        }
        // The error panel re-sorts and rebuilds on errors:changed: skip it when no error was
        // set or cleared (the common case — a clean edit acknowledged).
        if (changedErrors.size > 0) {
            this.bus.emit('errors:changed', { errors: this.errors, keys: [...changedErrors] });
        }
        this.bus.emit('sync-state', {
            pending: this.pending.size,
            dirty: this.dirty.size,
            modified: this.modified.size,
            cells: [...changedState.values()],
        });
        this.emitEditState();
    }

    /**
     * Replace the grid-level validation messages (F5) with a `scope: 'rows'` result's errors.
     * The previous scoped keys are dropped first; a message lands unless a newer local edit of
     * that cell superseded the result, or an op-level error already holds the key (that one is
     * cleared by its own settle). Row and grid messages always land.
     *
     * @param {{seq: number, errors?: Object<string, Object<string, string>>}} result
     * @param {Set<string>} changedErrors collects every key set or cleared
     */
    applyRowsScopedErrors(result, changedErrors) {
        for (const key of this.rowsScopedErrors) {
            if (this.errors.delete(key)) {
                changedErrors.add(key);
            }
        }
        this.rowsScopedErrors.clear();
        for (const [rowKey, cols] of Object.entries(result.errors || {})) {
            for (const [colKey, message] of Object.entries(cols || {})) {
                const key = this.errorKey(rowKey, colKey);
                const revisionKey = colKey === '_row' ? null : cellMapKey(rowKey, colKey);
                if (revisionKey && (this.cellRevisions.get(revisionKey) || 0) > result.seq) {
                    continue;
                }
                if (this.errors.has(key)) {
                    continue;
                }
                this.errors.set(key, message);
                this.rowsScopedErrors.add(key);
                changedErrors.add(key);
            }
        }
    }

    /**
     * Track (seq) or forget (null) a cell's unresolved paste-by-label lookup. A later plain
     * write to the cell supersedes the lookup, so every commit calls this.
     *
     * @param {string} rowKey
     * @param {string} colKey
     * @param {number|null} seq the lookup op's seq, or null when the newest write is not one
     */
    trackLookup(rowKey, colKey, seq) {
        if (seq != null) {
            this.lookups.set(cellMapKey(rowKey, colKey), seq);
        } else if (this.lookups.size > 0) {
            this.lookups.delete(cellMapKey(rowKey, colKey));
        }
    }

    /** Clear the acknowledged sequence for exact client-known cells. */
    settleOp(result, cells = []) {
        for (const { rowKey, colKey } of cells) {
            const ck = cellMapKey(rowKey, colKey);
            const seqs = this.pendingSeqs.get(ck);
            if (seqs) {
                seqs.delete(result.seq);
                if (seqs.size === 0) {
                    this.pendingSeqs.delete(ck);
                    this.pending.delete(ck);
                }
            }

            // Only the latest edit may clear dirty/error. An older acknowledgement still removes
            // its own pending sequence but otherwise leaves the newer optimistic state alone.
            const cellFailed = !!(
                (result.errors || {})[rowKey]
                && ((result.errors || {})[rowKey][colKey] || (result.errors || {})[rowKey]._row)
            );
            if (!cellFailed && (this.cellRevisions.get(ck) || 0) <= result.seq) {
                this.dirty.delete(ck);
                this.errors.delete(this.errorKey(rowKey, colKey));
            }
            // A resolved paste-by-label lookup is done. A refused one stays tracked while the
            // pasted text is still the cell's value: a reload must resolve it again, never
            // store the label as an id.
            const lookupSeq = this.lookups.get(ck);
            if (lookupSeq !== undefined && lookupSeq <= result.seq && !cellFailed) {
                this.lookups.delete(ck);
            }
        }
        return cells;
    }

    /** Publish the public, save-gating edit state from one canonical place. */
    emitEditState() {
        this.bus.emit('edit-state', {
            dirty: this.dirty.size,
            pending: this.pending.size,
            modified: this.modifiedCount(),
            errors: this.errors.size,
        });
    }

    markStructureModified() {
        this.structureModified = true;
        this.emitEditState();
    }

    modifiedCount() {
        return this.modified.size + (this.structureModified ? 1 : 0);
    }

    hasUnsavedChanges() {
        return this.modifiedCount() > 0;
    }

    /** Mark the current acknowledged rows as durably saved by the host. */
    markSaved() {
        this.modified.clear();
        this.structureModified = false;
        this.emitEditState();
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
        for (const key of [...this.modified]) {
            if (key.startsWith(prefix)) {
                this.modified.delete(key);
            }
        }
        for (const key of [...this.pendingSeqs.keys()]) {
            if (key.startsWith(prefix)) {
                this.pendingSeqs.delete(key);
                this.cellRevisions.delete(key);
            }
        }
        for (const key of [...this.errors.keys()]) {
            if (key.startsWith(prefix)) {
                this.errors.delete(key);
            }
        }
        for (const key of [...this.lookups.keys()]) {
            if (key.startsWith(prefix)) {
                this.lookups.delete(key);
            }
        }
        for (const key of [...this.rowsScopedErrors]) {
            if (key.startsWith(prefix)) {
                this.rowsScopedErrors.delete(key);
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
        this.bus.emit('errors:changed', { errors: this.errors, keys: [key] });
        this.emitEditState();
    }
}
