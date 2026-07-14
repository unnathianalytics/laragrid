var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/core/EventBus.js
var EventBus = class {
  constructor() {
    this.listeners = /* @__PURE__ */ new Map();
  }
  /**
   * Subscribe to an event; returns an unsubscribe function.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void}
   */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, /* @__PURE__ */ new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }
  /**
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }
  /**
   * @param {string} event
   * @param {*} [payload]
   */
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const handler of [...set]) {
      handler(payload);
    }
  }
  /** Drop all listeners (grid teardown). */
  clear() {
    this.listeners.clear();
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/formula/ExprEval.js
function roundHalfUp(value, scale) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = Math.pow(10, scale);
  const shifted = value * factor;
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted) + 1e-9);
  return rounded / factor;
}
function toNumber(value) {
  if (value === null || value === void 0 || value === "") {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  const normalised = String(value).replace(/[,\s]/g, "");
  const n = Number(normalised);
  return Number.isNaN(n) ? 0 : n;
}
function evaluate(node, scope) {
  switch (node.t) {
    case "num":
      return node.v;
    case "col":
      return toNumber(scope[node.k]);
    case "un":
      return node.op === "-" ? -evaluate(node.x, scope) : evaluate(node.x, scope);
    case "bin":
      return binary(node, scope);
    case "call":
      return call(node, scope);
    default:
      throw new Error(`Unknown expression node [${node.t}].`);
  }
}
function binary(node, scope) {
  const l = evaluate(node.l, scope);
  const r = evaluate(node.r, scope);
  switch (node.op) {
    case "+":
      return l + r;
    case "-":
      return l - r;
    case "*":
      return l * r;
    case "/":
      return r === 0 ? 0 : l / r;
    case "%":
      return r === 0 ? 0 : l % r;
    case "==":
      return l === r ? 1 : 0;
    case "!=":
      return l !== r ? 1 : 0;
    case "<":
      return l < r ? 1 : 0;
    case "<=":
      return l <= r ? 1 : 0;
    case ">":
      return l > r ? 1 : 0;
    case ">=":
      return l >= r ? 1 : 0;
    default:
      throw new Error(`Unknown operator [${node.op}].`);
  }
}
function call(node, scope) {
  const args = node.args.map((a) => evaluate(a, scope));
  switch (node.fn) {
    case "round":
      return roundHalfUp(args[0], args.length > 1 ? Math.trunc(args[1]) : 0);
    case "min":
      return args.length === 0 ? 0 : Math.min(...args);
    case "max":
      return args.length === 0 ? 0 : Math.max(...args);
    case "abs":
      return Math.abs(args[0]);
    case "ceil":
      return Math.ceil(args[0]);
    case "floor":
      return Math.floor(args[0]);
    case "if":
      return args[0] !== 0 ? args[1] : args[2];
    default:
      throw new Error(`Unknown function [${node.fn}].`);
  }
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/util/dom.js
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}
function toggleClass(node, className, on) {
  if (!node) {
    return;
  }
  node.classList.toggle(className, !!on);
}
function setText(node, value) {
  if (node) {
    node.textContent = value == null ? "" : String(value);
  }
}
function cellDomId(gridName, rowKey, colKey) {
  return `${gridName}-${rowKey}-${colKey}`;
}
function cellMapKey(rowKey, colKey) {
  return `${rowKey}${colKey}`;
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/core/StateStore.js
var StateStore = class {
  /**
   * @param {object} config the declarative config from ConfigSerializer
   * @param {import('./EventBus').default} bus
   */
  constructor(config, bus) {
    this.bus = bus;
    this.name = config.name || "";
    this.columns = config.columns || [];
    this.groups = config.groups || [];
    this.footer = config.footer || [];
    this.layout = config.layout || {};
    this.rows = [];
    this.rowByKey = /* @__PURE__ */ new Map();
    this.active = null;
    this.anchor = null;
    this.selection = null;
    const server = config.server || {};
    const paginate = this.layout && this.layout.paginate || {};
    const defaultSort = this.layout && this.layout.defaultSort || null;
    this.serverSide = !!(this.layout && this.layout.serverSide);
    this.serverMeta = {
      total: server.total || 0,
      page: server.page || 1,
      perPage: server.perPage || paginate.perPage || 50,
      lastPage: server.lastPage || 1
    };
    this.query = {
      sort: defaultSort ? defaultSort.col : null,
      dir: defaultSort ? defaultSort.dir : "asc",
      search: "",
      filters: {},
      page: this.serverMeta.page,
      perPage: this.serverMeta.perPage
    };
    this.pageTotals = server.pageTotals || {};
    this.grandTotals = server.grandTotals || {};
    this.widthOverrides = {};
    this.userHidden = /* @__PURE__ */ new Set();
    this.editable = !!(this.layout && this.layout.editable);
    this.seqCounter = 0;
    this.version = 0;
    this.dirty = /* @__PURE__ */ new Set();
    this.pending = /* @__PURE__ */ new Set();
    this.errors = /* @__PURE__ */ new Map();
    this.opLog = [];
    this.checked = /* @__PURE__ */ new Set();
    this.formulaColumns = this.columns.filter((c) => c && c.formula && c.formula.ast);
    this.setRows(config.rows || []);
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
   */
  setRows(rows) {
    this.rows = rows;
    this.rowByKey.clear();
    for (let i = 0; i < rows.length; i++) {
      this.rowByKey.set(rows[i]._k, { row: rows[i], index: i });
    }
    this.bus.emit("rows:changed", { rows });
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
    this.serverMeta = {
      total: page.total || 0,
      page: page.page || 1,
      perPage: page.perPage || this.serverMeta.perPage,
      lastPage: page.lastPage || 1
    };
    this.pageTotals = page.pageTotals || {};
    this.grandTotals = page.grandTotals || {};
    if (query) {
      this.query = { ...query, page: this.serverMeta.page, perPage: this.serverMeta.perPage };
    }
    this.setRows(page.rows || []);
    this.bus.emit("page:changed", { meta: this.serverMeta, query: this.query });
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
      const indexes = (group.columns || []).filter((key) => indexByKey.has(key)).map((key) => indexByKey.get(key)).sort((a, b) => a - b);
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
    this.recomputeSelection(opts.kind || "cell");
    this.bus.emit("active:changed", { active: this.active });
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
    this.bus.emit("active:changed", { active: this.active });
    this.bus.emit("selection:changed", { selection: this.selection });
  }
  /** Collapse the selection to the active cell (Esc). */
  collapseSelection() {
    if (!this.active) {
      return;
    }
    this.anchor = this.active;
    this.recomputeSelection("cell");
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
        kind
      };
    }
    this.bus.emit("selection:changed", { selection: this.selection });
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
    const current = value == null ? "" : String(value);
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
    return this.columns.filter((c) => c && c.lockedWhen && c.lockedWhen.column === colKey).map((c) => c.key);
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
    const current = value == null ? "" : String(value);
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
    if (!spec || spec.kind !== "balanced" || !Array.isArray(spec.columns)) {
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
    return this.visibleColumns().every((column) => {
      if (!column.editable) {
        return true;
      }
      const value = hit.row[column.key];
      return value == null || value === "";
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
      if (value == null || value === "") {
        continue;
      }
      const parsed = parseFloat(String(value).replace(/[,\s]/g, ""));
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
    hit.row[colKey] = value;
    const changed = [{ rowKey, colKey }];
    this.markDirty(rowKey, colKey);
    for (const fc of this.formulaColumns) {
      const next = evaluate(fc.formula.ast, hit.row);
      if (hit.row[fc.key] !== next) {
        hit.row[fc.key] = next;
        changed.push({ rowKey, colKey: fc.key });
      }
    }
    this.bus.emit("cells:changed", { cells: changed });
    return changed;
  }
  /**
   * Insert a fresh blank row (all editable columns null) after `afterKey` (or appended), keyed by
   * the client-generated `newKey`. Structural → full body repaint via rows:changed.
   * @param {string} newKey
   * @param {string|null} afterKey
   */
  insertRow(newKey, afterKey = null) {
    const blank = { _k: newKey };
    for (const c of this.columns) {
      if (c && c.key && !c.key.startsWith("_")) {
        blank[c.key] = null;
      }
    }
    const at = afterKey !== null ? this.rowIndexOf(afterKey) : -1;
    if (at < 0) {
      this.rows.push(blank);
    } else {
      this.rows.splice(at + 1, 0, blank);
    }
    this.reindex();
    this.bus.emit("rows:changed", { rows: this.rows });
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
    this.rows.splice(at, 1);
    this.clearRowState(rowKey);
    this.reindex();
    this.bus.emit("rows:changed", { rows: this.rows });
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
    this.bus.emit("rows:changed", { rows: this.rows });
    return clone;
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
    this.bus.emit("checked:changed", { checked: this.checked });
  }
  /** Check every current row (the bulk bar's Select all). */
  checkAll() {
    for (const row of this.rows) {
      this.checked.add(row._k);
    }
    this.bus.emit("checked:changed", { checked: this.checked });
  }
  /** Clear the bulk selection. */
  clearChecked() {
    if (this.checked.size === 0) {
      return;
    }
    this.checked.clear();
    this.bus.emit("checked:changed", { checked: this.checked });
  }
  reseed(rows) {
    this.clearChecked();
    this.dirty.clear();
    this.pending.clear();
    this.errors.clear();
    this.opLog = [];
    this.version = 0;
    this.setRows(rows || []);
    if (this.active && this.rowByKey.has(this.active.rowKey)) {
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
        this.bus.emit("active:changed", { active: null });
        this.bus.emit("selection:changed", { selection: null });
      }
    }
    this.bus.emit("errors:changed", { errors: this.errors });
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
    const labels = { ...hit.row._labels || {} };
    if (label == null) {
      delete labels[colKey];
    } else {
      labels[colKey] = label;
    }
    hit.row._labels = labels;
    this.bus.emit("cells:changed", { cells: [{ rowKey, colKey }] });
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
    const column = this.columnByKey(colKey);
    const isPicker = !!(column && column.parse && column.parse.kind === "select");
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
    this.bus.emit("dirty:changed", { rowKey, colKey, dirty: true });
  }
  /** Mark cells as having an op in flight (SyncManager flush). */
  markPending(cells) {
    for (const { rowKey, colKey } of cells) {
      this.pending.add(cellMapKey(rowKey, colKey));
    }
    this.bus.emit("sync-state", { pending: this.pending.size, dirty: this.dirty.size });
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
    if (typeof response.version === "number") {
      this.version = response.version;
    }
    for (const result of response.results || []) {
      for (const [rowKey, cols] of Object.entries(result.errors || {})) {
        for (const [colKey, message] of Object.entries(cols)) {
          this.errors.set(this.errorKey(rowKey, colKey), message);
        }
      }
      for (const [rowKey, patch] of Object.entries(result.patch || {})) {
        const hit = this.rowByKey.get(rowKey);
        if (!hit) {
          continue;
        }
        for (const [colKey, value] of Object.entries(patch)) {
          if (colKey === "_labels") {
            hit.row._labels = { ...hit.row._labels || {}, ...value || {} };
            for (const labelled of Object.keys(value || {})) {
              repaint.push({ rowKey, colKey: labelled });
            }
            continue;
          }
          const ck = cellMapKey(rowKey, colKey);
          if (this.dirty.has(ck) && this.pending.has(ck) === false) {
            continue;
          }
          hit.row[colKey] = value;
          repaint.push({ rowKey, colKey });
        }
      }
    }
    for (const result of response.results || []) {
      if (result.ok) {
        this.settleOp(result);
      }
    }
    if (repaint.length) {
      this.bus.emit("cells:changed", { cells: repaint });
    }
    this.bus.emit("errors:changed", { errors: this.errors });
    this.bus.emit("sync-state", { pending: this.pending.size, dirty: this.dirty.size });
  }
  /** Clear dirty/pending/error for the cells an acknowledged op covered. */
  settleOp(result) {
    const rowKeys = /* @__PURE__ */ new Set([
      ...Object.keys(result.patch || {}),
      ...Object.keys(result.errors || {})
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
    return colKey === "_row" ? `${rowKey}_row` : cellMapKey(rowKey, colKey);
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
    this.bus.emit("errors:changed", { errors: this.errors });
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/Layout.js
var DEFAULT_WIDTH = 120;
var Layout = class {
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
      return null;
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
    toggleClass(this.refs.root, "lgrid--sticky-head", layout.stickyHeader !== false && layout.stickyHeader);
    toggleClass(this.refs.root, "lgrid--striped", !!layout.striped);
    toggleClass(this.refs.root, "lgrid--compact", layout.density === "compact");
    toggleClass(this.refs.root, "lgrid--comfortable", layout.density === "comfortable");
    if (layout.themeClass) {
      this.refs.root.classList.add(layout.themeClass);
    }
    this.refs.body.classList.add("lgrid-rows--cv");
    this.frozen = this.computeFrozen(columns, layout.freeze || 0);
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
    const growCols = columns.filter((c) => c.grow && this.overrideFor(c) === null);
    const fixedTotal = columns.filter((c) => !growCols.includes(c)).reduce((sum, c) => sum + (this.columnWidth(c) || DEFAULT_WIDTH), 0);
    const box = this.refs.scroll || this.refs.root;
    const available = box && box.clientWidth || 0;
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
    tracks.push("minmax(0, 1fr)");
    this.refs.root.style.setProperty("--lgrid-cols", tracks.join(" "));
  }
  /**
   * Re-split grow width when the scroll box resizes, so alignment survives a window/panel resize.
   * @param {object[]} columns
   */
  installResizeSync(columns) {
    if (this.resizeObserver || typeof ResizeObserver === "undefined") {
      return;
    }
    if (!columns.some((c) => c.grow)) {
      return;
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
    cellEl.classList.add("lgrid-cell--frozen");
    cellEl.style.left = `${hit.left}px`;
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
    this.refs.root.querySelectorAll("[data-fz]").forEach((cellEl) => {
      const left = leftByIndex.get(Number(cellEl.dataset.fz));
      if (left !== void 0) {
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
    const node = document.createElement("div");
    node.className = `lgrid-${variant} lgrid-filler`;
    node.setAttribute("aria-hidden", "true");
    return node;
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/HeaderRenderer.js
var HeaderRenderer = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('./Layout').default} layout
   * @param {HTMLElement} headEl
   */
  constructor(store, layout, headEl) {
    this.store = store;
    this.layout = layout;
    this.headEl = headEl;
  }
  render() {
    const columns = this.store.visibleColumns();
    const groups = this.store.visibleGroups();
    this.headEl.textContent = "";
    if (groups.length > 0) {
      this.renderGrouped(columns, groups);
    } else {
      this.renderFlat(columns);
    }
  }
  /** Single-row header: one cell per column + trailing filler. */
  renderFlat(columns) {
    const row = el("div", "lgrid-headrow");
    columns.forEach((column, index) => {
      row.appendChild(this.columnCell(column, index));
    });
    row.appendChild(this.layout.fillerCell("headcell"));
    this.headEl.appendChild(row);
  }
  /**
   * Two-row header as a SINGLE grid: group labels span their members on row 1; ungrouped
   * column headers span both rows; grouped members sit on row 2.
   */
  renderGrouped(columns, groups) {
    const grid = el("div", "lgrid-headrow lgrid-headrow--grouped");
    grid.style.gridTemplateRows = "repeat(2, auto)";
    const groupByIndex = /* @__PURE__ */ new Map();
    for (const group of groups) {
      for (let i = group.start; i < group.start + group.span; i++) {
        groupByIndex.set(i, group);
      }
    }
    for (const group of groups) {
      const cell = el("div", "lgrid-headgroup", group.label);
      cell.style.gridColumn = `${group.start + 1} / span ${group.span}`;
      cell.style.gridRow = "1";
      this.layout.applyFrozenTo(cell, group.start);
      grid.appendChild(cell);
    }
    columns.forEach((column, index) => {
      const cell = this.columnCell(column, index);
      cell.style.gridColumn = `${index + 1}`;
      if (groupByIndex.has(index)) {
        cell.style.gridRow = "2";
      } else {
        cell.style.gridRow = "1 / span 2";
      }
      grid.appendChild(cell);
    });
    const filler = this.layout.fillerCell("headcell");
    filler.style.gridColumn = `${columns.length + 1}`;
    filler.style.gridRow = "1 / span 2";
    grid.appendChild(filler);
    this.headEl.appendChild(grid);
  }
  /** A single column-header cell with alignment + frozen state applied. */
  columnCell(column, index) {
    const cell = el("div", "lgrid-headcell", column.label);
    toggleClass(cell, "lgrid-cell--right", column.align === "right");
    toggleClass(cell, "lgrid-cell--center", column.align === "center");
    this.layout.applyFrozenTo(cell, index);
    if (column.sortable) {
      cell.classList.add("lgrid-headcell--sortable");
      const sort = el("button", "lgrid-sort");
      sort.type = "button";
      sort.dataset.sort = column.key;
      sort.setAttribute("aria-label", `Sort by ${column.label}`);
      const icon = el("span", "lgrid-sort-icon");
      sort.appendChild(icon);
      cell.appendChild(sort);
    }
    if (column.filter && this.store.serverSide) {
      const filterBtn = el("button", "lgrid-filter");
      filterBtn.type = "button";
      filterBtn.dataset.col = column.key;
      filterBtn.setAttribute("aria-label", `Filter by ${column.filter.label || column.label}`);
      filterBtn.setAttribute("aria-haspopup", "true");
      filterBtn.appendChild(el("span", "lgrid-filter-icon"));
      cell.appendChild(filterBtn);
    }
    if (column.resizable !== false) {
      const handle = el("span", "lgrid-resize");
      handle.dataset.col = column.key;
      handle.setAttribute("aria-hidden", "true");
      cell.appendChild(handle);
    }
    return cell;
  }
  /**
   * Reflect the current query's filter values on the header funnel controls (M7): a funnel
   * whose filter carries an ACTIVE value paints filled. Called on paint + page:changed.
   */
  updateFilterIndicators() {
    const filters = this.store.query && this.store.query.filters || {};
    this.headEl.querySelectorAll(".lgrid-filter").forEach((btn) => {
      const column = this.store.columnByKey(btn.dataset.col);
      const key = column && column.filter ? column.filter.key : null;
      const value = key !== null ? filters[key] : void 0;
      const active = value !== void 0 && value !== null && value !== "" && value !== "any";
      btn.classList.toggle("lgrid-filter--active", active);
    });
  }
  /**
   * Reflect the store's current sort on the header sort controls (asc/desc/none), and the
   * matching aria-sort on the head cell. Called on paint + page:changed (server sort).
   */
  updateSortIndicators() {
    const query = this.store.query || {};
    const cells = this.headEl.querySelectorAll(".lgrid-headcell");
    const columns = this.store.visibleColumns();
    cells.forEach((cell, i) => {
      const column = columns[i];
      if (!column || !column.sortable) {
        return;
      }
      const active = query.sort === column.key;
      const dir = active ? query.dir || "asc" : null;
      cell.classList.toggle("lgrid-headcell--sorted", active);
      cell.classList.toggle("lgrid-headcell--asc", dir === "asc");
      cell.classList.toggle("lgrid-headcell--desc", dir === "desc");
      cell.setAttribute("aria-sort", active ? dir === "desc" ? "descending" : "ascending" : "none");
    });
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/format/formatters.js
function arg(args, key, fallback) {
  if (args == null) {
    return fallback;
  }
  const value = args[key];
  return value === void 0 ? fallback : value;
}
function toFixedString(value, scale) {
  return Number(value).toFixed(scale);
}
function textFormatter(value, args) {
  if (value === null || value === void 0) {
    return "";
  }
  let text = typeof value === "boolean" ? value ? "true" : "false" : String(value);
  const transform = arg(args, "transform", null);
  if (transform === "upper") {
    text = text.toUpperCase();
  } else if (transform === "lower") {
    text = text.toLowerCase();
  }
  return text;
}
function numberFormatter(value, args) {
  if (value === null || value === void 0 || value === "") {
    return "";
  }
  const scale = Math.max(0, parseInt(arg(args, "scale", 0), 10) || 0);
  const group = arg(args, "group", true);
  const fixed = toFixedString(value, scale);
  const negative = fixed.startsWith("-");
  const abs = negative ? fixed.slice(1) : fixed;
  const [intPart, fracPart] = scale > 0 ? abs.split(".") : [abs, ""];
  const grouped = group ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  return (negative ? "-" : "") + grouped + (scale > 0 ? "." + fracPart : "");
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateFormatter(value, args) {
  if (value === null || value === void 0 || value === "") {
    return "";
  }
  const display = String(arg(args, "display", "d-m-Y"));
  const raw = String(value);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let year;
  let month;
  let day;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return raw;
    }
    year = parsed.getFullYear();
    month = parsed.getMonth() + 1;
    day = parsed.getDate();
  }
  const pad22 = (n) => String(n).padStart(2, "0");
  return display.replace(/d|m|M|Y/g, (token) => {
    switch (token) {
      case "d":
        return pad22(day);
      case "m":
        return pad22(month);
      case "M":
        return MONTHS[month - 1] || "";
      case "Y":
        return String(year);
      default:
        return token;
    }
  });
}
var FORMATTERS = {
  text: textFormatter,
  number: numberFormatter,
  date: dateFormatter
};
function registerFormatter(name, fn) {
  FORMATTERS[name] = fn;
}
function formatValue(format, value) {
  if (!format || !format.name) {
    return textFormatter(value, {});
  }
  const fn = FORMATTERS[format.name] || textFormatter;
  return fn(value, format.args || {});
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/shared/date.js
function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}
function pad2(value) {
  return String(value).padStart(2, "0");
}
function parseFreeform(raw, fyStartMonth, fyStartYear) {
  const text = String(raw ?? "").trim();
  if (text === "") {
    return null;
  }
  let day;
  let month;
  let year = null;
  if (/\D/.test(text)) {
    const parts = text.split(/\D+/).filter((token) => token !== "");
    if (parts.length < 2 || parts.length > 3) {
      return null;
    }
    if (parts.some((token) => !/^\d+$/.test(token))) {
      return null;
    }
    day = Number(parts[0]);
    month = Number(parts[1]);
    if (parts.length === 3) {
      year = normalizeYear(parts[2]);
      if (year === null) {
        return null;
      }
    }
  } else {
    if (text.length === 8) {
      day = Number(text.slice(0, 2));
      month = Number(text.slice(2, 4));
      year = Number(text.slice(4, 8));
    } else if (text.length === 6) {
      day = Number(text.slice(0, 2));
      month = Number(text.slice(2, 4));
      year = normalizeYear(text.slice(4, 6));
    } else if (text.length === 4) {
      day = Number(text.slice(0, 2));
      month = Number(text.slice(2, 4));
    } else {
      return null;
    }
  }
  if (year === null) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return null;
    }
    year = month >= fyStartMonth ? fyStartYear : fyStartYear + 1;
  }
  return validate(day, month, year);
}
function normalizeYear(token) {
  if (token.length === 2) {
    return 2e3 + Number(token);
  }
  if (token.length === 4) {
    return Number(token);
  }
  return null;
}
function validate(day, month, year) {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return null;
  }
  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(month, year)) {
    return null;
  }
  return { d: day, m: month, y: year };
}
function formatValue2(parts, valueFormat) {
  const dd = pad2(parts.d);
  const mm = pad2(parts.m);
  const yyyy = String(parts.y).padStart(4, "0");
  if (valueFormat === "Y-m-d") {
    return `${yyyy}-${mm}-${dd}`;
  }
  return `${dd}-${mm}-${yyyy}`;
}
function formatDisplay(parts) {
  return `${pad2(parts.d)}-${pad2(parts.m)}-${String(parts.y).padStart(4, "0")}`;
}
function partsFromValue(value) {
  const text = String(value ?? "").trim();
  if (text === "") {
    return null;
  }
  let isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return validate(Number(isoMatch[3]), Number(isoMatch[2]), Number(isoMatch[1]));
  }
  let dmyMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmyMatch) {
    return validate(Number(dmyMatch[1]), Number(dmyMatch[2]), Number(dmyMatch[3]));
  }
  return null;
}
function formatIso(parts) {
  return formatValue2(parts, "Y-m-d");
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/format/parse.js
function stripGrouping(raw) {
  return String(raw == null ? "" : raw).replace(/[,\s]/g, "");
}
function roundHalfUp2(value, scale) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = Math.pow(10, scale);
  const shifted = value * factor;
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted) + 1e-9);
  return rounded / factor;
}
function parseText(raw, transform) {
  let text = raw == null ? "" : String(raw).trim();
  if (transform === "upper") {
    text = text.toUpperCase();
  } else if (transform === "lower") {
    text = text.toLowerCase();
  }
  return text;
}
function parseInt10(raw) {
  const normalised = stripGrouping(raw);
  if (normalised === "" || Number.isNaN(Number(normalised))) {
    return 0;
  }
  return Math.round(Number(normalised));
}
function parseDecimal(raw, scale) {
  const normalised = stripGrouping(raw);
  const number = normalised === "" || Number.isNaN(Number(normalised)) ? 0 : Number(normalised);
  return roundHalfUp2(number, scale).toFixed(scale);
}
function parseSelect(raw) {
  const text = raw == null ? "" : String(raw).trim();
  return text === "" ? null : text;
}
function parseBool(raw) {
  if (raw === true) {
    return true;
  }
  const text = String(raw == null ? "" : raw).trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(text);
}
function parseDate(raw, spec) {
  const text = raw == null ? "" : String(raw).trim();
  if (text === "") {
    return null;
  }
  const direct = partsFromValue(text);
  if (direct) {
    return formatIso(direct);
  }
  const parts = parseFreeform(
    text,
    Number(spec && spec.fyStartMonth) || 1,
    Number(spec && spec.fyStartYear) || (/* @__PURE__ */ new Date()).getFullYear()
  );
  return parts ? formatIso(parts) : void 0;
}
var CASTS = {
  text: {
    parse: (raw, spec) => parseText(raw, spec ? spec.case : null)
  },
  int: {
    parse: (raw) => parseInt10(raw)
  },
  decimal: {
    parse: (raw, spec) => parseDecimal(raw, Math.max(0, parseInt(spec && spec.scale, 10) || 0))
  },
  select: {
    parse: (raw) => parseSelect(raw)
  },
  bool: {
    parse: (raw) => parseBool(raw),
    editText: (value) => parseBool(value) ? "1" : "0"
  },
  date: {
    parse: (raw, spec) => parseDate(raw, spec || {}),
    editText: (value) => {
      const parts = partsFromValue(String(value));
      return parts ? formatDisplay(parts) : "";
    }
  }
};
function registerCast(kind, cast) {
  CASTS[kind] = cast;
}
function parseValue(spec, raw) {
  const kind = spec && spec.kind || "text";
  const cast = CASTS[kind] || CASTS.text;
  return cast.parse(raw, spec || {});
}
function editTextFor(column, value) {
  const spec = column && column.parse || {};
  if (value == null || value === "") {
    return "";
  }
  const cast = CASTS[spec.kind];
  if (cast && cast.editText) {
    return cast.editText(value, spec);
  }
  return String(value);
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/CellPainters.js
function paintText(cellEl, ctx) {
  const display = formatValue(ctx.column.format, ctx.value);
  if (ctx.column.html) {
    cellEl.innerHTML = display;
  } else {
    setText(cellEl, display);
  }
}
function paintSerial(cellEl, ctx) {
  setText(cellEl, ctx.index + 1);
}
function paintFormula(cellEl, ctx) {
  cellEl.classList.add("lgrid-cell--formula");
  setText(cellEl, formatValue(ctx.column.format, ctx.value));
}
function paintSelect(cellEl, ctx) {
  const value = ctx.value;
  let label = "";
  if (value != null && value !== "") {
    const options = ctx.column.options || [];
    const hit = options.find((o) => String(o.value) === String(value));
    label = hit ? hit.label : ctx.row && ctx.row._labels && ctx.row._labels[ctx.column.key] || String(value);
  }
  setText(cellEl, label);
}
function paintCheckbox(cellEl, ctx) {
  const on = parseBool(ctx.value);
  cellEl.textContent = "";
  cellEl.appendChild(el("span", "lgrid-check" + (on ? " lgrid-check--on" : "")));
  cellEl.setAttribute("aria-checked", on ? "true" : "false");
}
function paintActions(cellEl, ctx) {
  cellEl.textContent = "";
  cellEl.dataset.col = "_actions";
  cellEl.dataset.row = ctx.row._k;
  const bag = ctx.row._actions || {};
  for (const meta of ctx.column.actions || []) {
    if (!(meta.name in bag)) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lgrid-action";
    button.dataset.action = meta.name;
    button.dataset.row = ctx.row._k;
    button.title = meta.label;
    button.setAttribute("aria-label", meta.label);
    button.textContent = meta.icon || meta.label;
    cellEl.appendChild(button);
  }
}
function paintRowselect(cellEl, ctx) {
  cellEl.textContent = "";
  cellEl.dataset.col = "_select";
  cellEl.dataset.row = ctx.row._k;
  cellEl.setAttribute("role", "checkbox");
  cellEl.appendChild(el("span", "lgrid-check"));
}
var PAINTERS = {
  text: paintText,
  serial: paintSerial,
  formula: paintFormula,
  select: paintSelect,
  checkbox: paintCheckbox,
  actions: paintActions,
  rowselect: paintRowselect
};
function painterFor(painterId) {
  return PAINTERS[painterId] || paintText;
}
function registerPainter(painterId, fn) {
  PAINTERS[painterId] = fn;
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/BodyRenderer.js
var BodyRenderer = class {
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
    this.rowElByKey = /* @__PURE__ */ new Map();
    this.cellElByKey = /* @__PURE__ */ new Map();
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
    const padTo = this.store.layout && this.store.layout.padRows || 0;
    for (let p = rows.length; p < padTo; p++) {
      frag.appendChild(this.buildPadRow(p, columns));
    }
    this.bodyEl.textContent = "";
    this.bodyEl.appendChild(frag);
  }
  buildRow(row, index, columns) {
    const rowEl = el("div", "lgrid-row");
    rowEl.dataset.k = row._k;
    rowEl.setAttribute("role", "row");
    rowEl.setAttribute("aria-rowindex", String(index + 2));
    toggleClass(rowEl, "lgrid-row--stripe", this.striped && index % 2 === 1);
    if (row._rowClass) {
      rowEl.classList.add(row._rowClass);
    }
    const cellClasses = row._cellClass || null;
    columns.forEach((column, colIndex) => {
      const cellEl = el("div", "lgrid-cell");
      cellEl.setAttribute("role", "gridcell");
      cellEl.setAttribute("aria-colindex", String(colIndex + 1));
      cellEl.setAttribute("aria-readonly", column.editable ? "false" : "true");
      if (column.editable) {
        cellEl.classList.add("lgrid-cell--editable");
      }
      toggleClass(cellEl, "lgrid-cell--locked", this.store.cellLocked(row, column));
      cellEl.dataset.c = column.key;
      cellEl.id = cellDomId(this.store.name, row._k, column.key);
      toggleClass(cellEl, "lgrid-cell--right", column.align === "right");
      toggleClass(cellEl, "lgrid-cell--center", column.align === "center");
      if (cellClasses && cellClasses[column.key]) {
        cellEl.classList.add(cellClasses[column.key]);
      }
      this.layout.applyFrozenTo(cellEl, colIndex);
      const painter = painterFor(column.painter);
      painter(cellEl, {
        value: this.store.cellValue(row, column),
        column,
        row,
        index
      });
      rowEl.appendChild(cellEl);
      this.cellElByKey.set(cellMapKey(row._k, column.key), cellEl);
    });
    rowEl.appendChild(this.layout.fillerCell("cell"));
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
    const rowEl = el("div", "lgrid-row lgrid-row--pad");
    rowEl.setAttribute("aria-hidden", "true");
    toggleClass(rowEl, "lgrid-row--stripe", this.striped && index % 2 === 1);
    columns.forEach((column, colIndex) => {
      const cellEl = el("div", "lgrid-cell lgrid-cell--pad");
      toggleClass(cellEl, "lgrid-cell--right", column.align === "right");
      toggleClass(cellEl, "lgrid-cell--center", column.align === "center");
      this.layout.applyFrozenTo(cellEl, colIndex);
      if (column.painter === "serial") {
        cellEl.textContent = String(index + 1);
      }
      rowEl.appendChild(cellEl);
    });
    rowEl.appendChild(this.layout.fillerCell("cell"));
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
      index: hit.index
    });
    toggleClass(cellEl, "lgrid-cell--locked", this.store.cellLocked(hit.row, column));
    return cellEl;
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/FooterRenderer.js
var FooterRenderer = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('./Layout').default} layout
   * @param {HTMLElement} footerEl
   */
  constructor(store, layout, footerEl) {
    this.store = store;
    this.layout = layout;
    this.footerEl = footerEl;
  }
  render() {
    const footer = this.store.footer || [];
    this.footerEl.textContent = "";
    if (footer.length === 0) {
      this.footerEl.hidden = true;
      return;
    }
    this.footerEl.hidden = false;
    const byColumn = /* @__PURE__ */ new Map();
    for (const agg of footer) {
      byColumn.set(agg.column, agg);
    }
    this.store.visibleColumns().forEach((column, colIndex) => {
      const cellEl = el("div", "lgrid-footcell");
      toggleClass(cellEl, "lgrid-cell--right", column.align === "right");
      toggleClass(cellEl, "lgrid-cell--center", column.align === "center");
      this.layout.applyFrozenTo(cellEl, colIndex);
      const agg = byColumn.get(column.key);
      if (agg) {
        let value;
        if (this.store.serverSide) {
          value = this.store.grandTotals[column.key] ?? 0;
        } else if (column.key in (this.store.pageTotals || {})) {
          value = this.store.pageTotals[column.key];
        } else {
          value = agg.value;
        }
        setText(cellEl, formatValue(agg.format, value));
      }
      this.footerEl.appendChild(cellEl);
    });
    this.footerEl.appendChild(this.layout.fillerCell("footcell"));
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/Renderer.js
var Renderer = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('./Layout').default} layout
   * @param {{head: HTMLElement, body: HTMLElement, footer: HTMLElement}} refs
   * @param {import('../core/EventBus').default} bus
   */
  constructor(store, layout, refs, bus) {
    this.store = store;
    this.layout = layout;
    this.bus = bus;
    this.header = new HeaderRenderer(store, layout, refs.head);
    this.body = new BodyRenderer(store, layout, refs.body);
    this.footer = new FooterRenderer(store, layout, refs.footer);
    this.unsubscribe = bus.on("rows:changed", () => this.renderBody());
    this.unsubscribeCells = bus.on("cells:changed", ({ cells }) => {
      (cells || []).forEach(({ rowKey, colKey }) => {
        this.body.repaintCell(rowKey, colKey);
        this.store.lockedDependentsOf(colKey).forEach((dependentKey) => {
          this.body.repaintCell(rowKey, dependentKey);
        });
      });
    });
    this.unsubscribePage = bus.on("page:changed", () => {
      this.footer.render();
      this.header.updateSortIndicators();
      this.header.updateFilterIndicators();
    });
  }
  paint() {
    this.header.render();
    this.header.updateSortIndicators();
    this.header.updateFilterIndicators();
    this.renderBody();
    this.footer.render();
  }
  /**
   * Render the body wrapped in will/did events so the dev-mode morph guard can distinguish our
   * own body mutations from an external Livewire morph leaking into the wire:ignore region (R3).
   */
  renderBody() {
    this.bus.emit("body:will-render");
    this.body.render();
    this.bus.emit("body:did-render");
  }
  /**
   * Resolve the cell element at a stable (rowKey, colKey) address — the O(1) seam the M2
   * SelectionPainter and active-cell scroller use to touch a single cell without a re-render.
   * @param {string} rowKey
   * @param {string} colKey
   * @returns {HTMLElement|null}
   */
  cellElFor(rowKey, colKey) {
    return this.body.cellElFor(rowKey, colKey);
  }
  /**
   * Repaint one cell in place (M4) — the O(1) seam the editor/store use after an optimistic set.
   * @param {string} rowKey
   * @param {string} colKey
   */
  repaintCell(rowKey, colKey) {
    return this.body.repaintCell(rowKey, colKey);
  }
  destroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (this.unsubscribeCells) {
      this.unsubscribeCells();
    }
    if (this.unsubscribePage) {
      this.unsubscribePage();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/util/geometry.js
function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
function firstNavigable(mask) {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      return i;
    }
  }
  return -1;
}
function lastNavigable(mask) {
  for (let i = mask.length - 1; i >= 0; i--) {
    if (mask[i]) {
      return i;
    }
  }
  return -1;
}
function nextNavigableInRow(mask, col, dir) {
  for (let i = col + dir; i >= 0 && i < mask.length; i += dir) {
    if (mask[i]) {
      return i;
    }
  }
  return col;
}
function resolveMove(p) {
  const { intent, row, col, rowCount, mask } = p;
  const page = p.page || 1;
  const lastRow = Math.max(0, rowCount - 1);
  const firstCol = firstNavigable(mask);
  const lastCol = lastNavigable(mask);
  switch (intent) {
    case "left":
      return { row, col: nextNavigableInRow(mask, col, -1) };
    case "right":
      return { row, col: nextNavigableInRow(mask, col, 1) };
    case "up":
      return { row: clamp(row - 1, 0, lastRow), col };
    case "down":
      return { row: clamp(row + 1, 0, lastRow), col };
    case "pageUp":
      return { row: clamp(row - page, 0, lastRow), col };
    case "pageDown":
      return { row: clamp(row + page, 0, lastRow), col };
    case "rowStart":
      return { row, col: firstCol };
    case "rowEnd":
      return { row, col: lastCol };
    case "colStart":
      return { row: 0, col };
    case "colEnd":
      return { row: lastRow, col };
    case "gridStart":
      return { row: 0, col: firstCol };
    case "gridEnd":
      return { row: lastRow, col: lastCol };
    case "nextWrap": {
      const right = nextNavigableInRow(mask, col, 1);
      if (right !== col) {
        return { row, col: right };
      }
      if (row < lastRow) {
        return { row: row + 1, col: firstCol };
      }
      return { row, col, escape: "next" };
    }
    case "prevWrap": {
      const left = nextNavigableInRow(mask, col, -1);
      if (left !== col) {
        return { row, col: left };
      }
      if (row > 0) {
        return { row: row - 1, col: lastCol };
      }
      return { row, col, escape: "prev" };
    }
    default:
      return { row, col };
  }
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/selection/SelectionManager.js
var _SelectionManager = class _SelectionManager {
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
    this.refs.root.addEventListener("pointerdown", this.onPointerDown);
  }
  destroy() {
    this.refs.root.removeEventListener("pointerdown", this.onPointerDown);
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
    if (_SelectionManager.LOCK_SKIPPING_INTENTS.has(intent)) {
      next = this.skipLocked(intent, next);
      if (!next) {
        return null;
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
        return null;
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
    const addr = this.store.addressAt(next.row, next.col);
    if (addr) {
      this.store.setActive(addr, { keepAnchor: true, kind: "range" });
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
      page: this.pageSize()
    });
  }
  /** Rows per PgUp/PgDn — the visible row count in the scroll viewport (min 1). */
  pageSize() {
    const scroll = this.refs.scroll;
    const rowH = scroll ? parseFloat(getComputedStyle(this.refs.root).getPropertyValue("--lgrid-row-h")) || 0 : 0;
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
    this.store.setSelectionRect({ r0: 0, r1: lastRow, c0, c1 }, "all", active, anchor);
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
    const headCell = e.target.closest(".lgrid-headcell");
    if (headCell && this.refs.head.contains(headCell)) {
      const colKey2 = this.columnKeyFromHeadCell(headCell);
      if (colKey2) {
        this.selectColumn(colKey2);
      }
      return;
    }
    const cell = e.target.closest(".lgrid-cell");
    if (!cell || !this.refs.body.contains(cell)) {
      return;
    }
    const rowEl = cell.closest(".lgrid-row");
    if (!rowEl) {
      return;
    }
    const rowKey = rowEl.dataset.k;
    const colKey = cell.dataset.c;
    const column = this.store.visibleColumns().find((c) => c.key === colKey);
    if (!column || column.navigable === false) {
      this.selectRow(rowKey);
      return;
    }
    const addr = { rowKey, colKey };
    if (e.shiftKey && this.store.active) {
      this.store.setActive(addr, { keepAnchor: true, kind: "range" });
    } else {
      this.store.setActive(addr);
    }
  }
  /** The column key a header cell represents (by its position among header cells). */
  columnKeyFromHeadCell(headCell) {
    const cells = Array.from(this.refs.head.querySelectorAll(".lgrid-headcell"));
    const pos = cells.indexOf(headCell);
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
    this.store.setSelectionRect({ r0: row, r1: row, c0, c1 }, "row", active, anchor);
  }
  /** Select an entire column (all rows of that column). */
  selectColumn(colKey) {
    const col = this.store.colIndexOf(colKey);
    const mask = this.store.navigabilityMask();
    if (col < 0 || !mask[col]) {
      return;
    }
    const lastRow = Math.max(0, this.store.rowCount() - 1);
    if (this.store.rowCount() === 0) {
      return;
    }
    const anchor = this.store.addressAt(0, col);
    const active = this.store.addressAt(0, col);
    this.store.setSelectionRect({ r0: 0, r1: lastRow, c0: col, c1: col }, "col", active, anchor);
  }
};
// ---- Keyboard-driven commands --------------------------------------------------------
/**
 * Intents whose landing must HOP OVER per-row locked cells (lockedWhen): the horizontal/
 * serpentine entry flow. Vertical and jump intents may still land on a locked cell — it is
 * inert (no editor), not invisible, so arrows/clicks can inspect it.
 * @type {Set<string>}
 */
__publicField(_SelectionManager, "LOCK_SKIPPING_INTENTS", /* @__PURE__ */ new Set(["left", "right", "nextWrap", "prevWrap"]));
var SelectionManager = _SelectionManager;

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/selection/SelectionPainter.js
var SelectionPainter = class {
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
    this.activeEl = null;
    this.paintedSelected = /* @__PURE__ */ new Set();
    this.allSelected = false;
    this.subs = [
      bus.on("active:changed", () => this.paintActive()),
      bus.on("selection:changed", () => this.paintSelection()),
      // A row replacement (M3 pages) wipes cell DOM — re-assert active/selection onto it.
      bus.on("rows:changed", () => this.reassert())
    ];
  }
  destroy() {
    this.subs.forEach((off) => off());
  }
  // ---- Active cell ---------------------------------------------------------------------
  paintActive() {
    const addr = this.store.active;
    if (this.activeEl) {
      toggleClass(this.activeEl, "lgrid-cell--active", false);
      this.activeEl = null;
    }
    if (!addr) {
      this.refs.root.removeAttribute("aria-activedescendant");
      return;
    }
    const cell = this.renderer.cellElFor(addr.rowKey, addr.colKey);
    if (!cell) {
      return;
    }
    toggleClass(cell, "lgrid-cell--active", true);
    this.activeEl = cell;
    this.refs.root.setAttribute("aria-activedescendant", cell.id);
    this.scrollIntoView(cell);
  }
  /**
   * Keep the active cell visible after PgDn/Ctrl+End etc. `nearest` avoids yanking the whole
   * grid; the sticky header/frozen columns keep their band, so the cell isn't occluded (R-A).
   */
  scrollIntoView(cell) {
    if (typeof cell.scrollIntoView === "function") {
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  // ---- Selection -----------------------------------------------------------------------
  paintSelection() {
    const sel = this.store.selection;
    if (sel && sel.kind === "all") {
      this.clearPartial();
      this.setAll(true);
      return;
    }
    this.setAll(false);
    if (!sel || sel.r0 === sel.r1 && sel.c0 === sel.c1) {
      this.clearPartial();
      return;
    }
    const next = /* @__PURE__ */ new Set();
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
    for (const id of this.paintedSelected) {
      if (!next.has(id)) {
        this.toggleSelectedById(id, false);
      }
    }
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
      toggleClass(cell, "lgrid-cell--selected", on);
      if (on) {
        cell.setAttribute("aria-selected", "true");
      } else {
        cell.removeAttribute("aria-selected");
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
    toggleClass(this.refs.root, "lgrid--all-selected", on);
    this.allSelected = on;
  }
  /** Re-apply active + selection after the body was re-rendered (row replacement). */
  reassert() {
    this.activeEl = null;
    this.paintedSelected = /* @__PURE__ */ new Set();
    this.paintActive();
    this.paintSelection();
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/keyboard/keys.js
function keyToken(key) {
  if (typeof key === "string" && key.length === 1) {
    return key.toLowerCase();
  }
  return key;
}
function chordFor(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) {
    parts.push("Ctrl");
  }
  if (e.altKey) {
    parts.push("Alt");
  }
  if (e.shiftKey) {
    parts.push("Shift");
  }
  parts.push(keyToken(e.key));
  return parts.join("+");
}
var SHARED_KEYMAP = {
  ArrowUp: { action: "move", intent: "up" },
  ArrowDown: { action: "move", intent: "down" },
  ArrowLeft: { action: "move", intent: "left" },
  ArrowRight: { action: "move", intent: "right" },
  "Shift+ArrowUp": { action: "select", intent: "up" },
  "Shift+ArrowDown": { action: "select", intent: "down" },
  "Shift+ArrowLeft": { action: "select", intent: "left" },
  "Shift+ArrowRight": { action: "select", intent: "right" },
  Tab: { action: "move", intent: "nextWrap" },
  "Shift+Tab": { action: "move", intent: "prevWrap" },
  Home: { action: "move", intent: "rowStart" },
  End: { action: "move", intent: "rowEnd" },
  "Ctrl+Home": { action: "move", intent: "gridStart" },
  "Ctrl+End": { action: "move", intent: "gridEnd" },
  // Ctrl+Arrow = jump to the data edge in that direction (readonly = first/last row or col).
  "Ctrl+ArrowUp": { action: "move", intent: "colStart" },
  "Ctrl+ArrowDown": { action: "move", intent: "colEnd" },
  "Ctrl+ArrowLeft": { action: "move", intent: "rowStart" },
  "Ctrl+ArrowRight": { action: "move", intent: "rowEnd" },
  PageUp: { action: "move", intent: "pageUp" },
  PageDown: { action: "move", intent: "pageDown" },
  "Ctrl+a": { action: "selectAll" },
  "Ctrl+c": { action: "copy" },
  Escape: { action: "clearSelection" },
  // Row/cell-op chords — recognised, but no-op in readonly (wired to editable handlers).
  // Excel-trained operators expect Delete to CLEAR content, never to remove the row;
  // row removal sits behind the deliberate Shift+Delete (or the classic F7).
  Insert: { action: "rowop", kind: "insert" },
  Delete: { action: "rowop", kind: "clear" },
  "Shift+Delete": { action: "rowop", kind: "delete" },
  F7: { action: "rowop", kind: "delete" },
  "Ctrl+d": { action: "rowop", kind: "fillDown" },
  // The row-actions menu (P7) — works in every mode that declares row actions.
  ContextMenu: { action: "actionsMenu" },
  "Shift+F10": { action: "actionsMenu" }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/keyboard/keymap-entry.js
var ENTRY_KEYMAP = {
  ...SHARED_KEYMAP,
  Enter: { action: "move", intent: "nextWrap" },
  "Shift+Enter": { action: "move", intent: "prevWrap" }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/keyboard/keymap-excel.js
var EXCEL_KEYMAP = {
  ...SHARED_KEYMAP,
  Enter: { action: "move", intent: "down" },
  "Shift+Enter": { action: "move", intent: "up" }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/EditorRegistry.js
var EDITORS = {};
function registerEditor(id, EditorClass) {
  EDITORS[id] = EditorClass;
}
function editorFor(id) {
  return EDITORS[id] || null;
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/keyboard/KeyboardManager.js
function keymapFor(name) {
  return name === "excel" ? EXCEL_KEYMAP : ENTRY_KEYMAP;
}
var KeyboardManager = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../selection/SelectionManager').default} selection
   * @param {{root: HTMLElement}} refs
   * @param {object} [hooks]
   * @param {() => void} [hooks.onCopy] invoked for the copy intent (Ctrl+C)
   * @param {object} [hooks.editor] the EditorManager (editable grids) — open/isEditing
   * @param {object} [hooks.rowOps] row-op handlers {insert, delete, fillDown} (editable grids)
   * @param {(() => boolean)} [hooks.rowActivate] activate the active row (readonly grids); returns
   *        true when it dispatched (Enter handled), false to fall through to the keymap move-down
   */
  constructor(store, selection, refs, hooks = {}) {
    this.store = store;
    this.selection = selection;
    this.refs = refs;
    this.hooks = hooks;
    this.editor = hooks.editor || null;
    this.rowOps = hooks.rowOps || null;
    this.rowActivate = hooks.rowActivate || null;
    this.keymap = keymapFor(store.layout && store.layout.keymap || "entry");
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onFocus = this.handleFocus.bind(this);
  }
  init() {
    this.refs.root.addEventListener("keydown", this.onKeyDown);
    this.refs.root.addEventListener("focus", this.onFocus, true);
  }
  destroy() {
    this.refs.root.removeEventListener("keydown", this.onKeyDown);
    this.refs.root.removeEventListener("focus", this.onFocus, true);
  }
  /** Seed the active cell when the grid first receives focus. */
  handleFocus() {
    this.selection.ensureActive();
  }
  /** True when focus is inside the grid root (so we own the key). */
  ownsFocus() {
    const active = document.activeElement;
    return active === this.refs.root || this.refs.root.contains(active);
  }
  handleKeyDown(e) {
    if (this.editor && this.editor.isEditing()) {
      return;
    }
    if (!this.ownsFocus()) {
      return;
    }
    if (this.editor) {
      if (e.key === "F2") {
        e.preventDefault();
        this.editor.open({ caretAtEnd: true });
        return;
      }
      if (e.key === " " && this.activeCellEditable() && this.activeCellInstant()) {
        e.preventDefault();
        this.editor.open({});
        return;
      }
      if (this.isPrintable(e) && !this.activeCellInstant()) {
        e.preventDefault();
        this.editor.open({ seed: e.key });
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && this.handleNavEnter(e)) {
        return;
      }
    }
    if (!this.editor && this.rowActivate && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && this.rowActivate()) {
      e.preventDefault();
      return;
    }
    const binding = this.keymap[chordFor(e)];
    if (!binding) {
      return;
    }
    switch (binding.action) {
      case "move": {
        const escape = this.selection.move(binding.intent);
        if (escape) {
          return;
        }
        e.preventDefault();
        break;
      }
      case "select":
        this.selection.extend(binding.intent);
        e.preventDefault();
        break;
      case "selectAll":
        this.selection.selectAll();
        e.preventDefault();
        break;
      case "clearSelection":
        this.selection.collapse();
        e.preventDefault();
        break;
      case "copy":
        if (this.hooks.onCopy) {
          this.hooks.onCopy();
        }
        e.preventDefault();
        break;
      case "actionsMenu":
        e.preventDefault();
        if (this.hooks.actionsMenu) {
          this.hooks.actionsMenu();
        }
        break;
      case "rowop":
        e.preventDefault();
        if (this.rowOps && this.rowOps[binding.kind]) {
          this.rowOps[binding.kind]();
        }
        break;
      default:
        break;
    }
  }
  /**
   * A printable single character with no command modifiers — a type-through edit trigger. Space
   * is excluded (it toggles a checkbox / is reserved) and so are modifier combos.
   */
  isPrintable(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return false;
    }
    return typeof e.key === "string" && e.key.length === 1 && e.key !== " ";
  }
  /**
   * NAV-mode Enter on an editable grid under the ENTRY keymap (Busy/Tally semantics):
   *   - a FILLED cell advances serpentine (with auto-append past the last editable cell — the
   *     same G4 growth the commit advance uses);
   *   - an EMPTY PICKER cell (select/searchselect) OPENS its dropdown — Enter is how an
   *     operator summons a lookup list on an unfilled field;
   *   - an empty statically-REQUIRED non-picker cell BLOCKS with a flash (form-kit's
   *     blank-required Enter-block, G7);
   *   - an empty optional cell advances.
   * Returns true when handled; excel keymaps (and a missing active cell) return false so the
   * keymap's own Enter binding (move-down, never blocked — G7) applies.
   */
  handleNavEnter(e) {
    const keymapName = this.store.layout && this.store.layout.keymap || "entry";
    if (keymapName !== "entry") {
      return false;
    }
    const addr = this.store.active;
    if (!addr) {
      return false;
    }
    e.preventDefault();
    if (this.store.isComplete() && this.rowIsBlank(addr.rowKey)) {
      if (this.hooks.onComplete) {
        this.hooks.onComplete();
      }
      return true;
    }
    if (this.isEmptyCell(addr) && this.isPickerCell(addr) && this.activeCellEditable()) {
      this.editor.open({ caretAtEnd: true });
      return true;
    }
    if (this.isBlankRequired(addr)) {
      if (this.hooks.onRequiredBlock) {
        this.hooks.onRequiredBlock(addr);
      }
      return true;
    }
    const column = this.store.columnByKey(addr.colKey);
    this.editor.panelOrAdvance(column, addr.rowKey, "enter");
    return true;
  }
  /** Whether every editable cell of a row is blank (the complete-guard leftover-row test). */
  rowIsBlank(rowKey) {
    return this.store.rowIsBlankByKey(rowKey);
  }
  /** The active-cell's current model value (null when the row/cell doesn't resolve). */
  cellValueOf(addr) {
    const hit = this.store.rowByKey.get(addr.rowKey);
    return hit ? hit.row[addr.colKey] : null;
  }
  /** Blank in the Enter-flow sense: no committed value (null/'') — a false checkbox is filled. */
  isEmptyCell(addr) {
    const value = this.cellValueOf(addr);
    return value == null || value === "";
  }
  /** Whether the cell's column is a picker (select/searchselect — parse kind 'select'). */
  isPickerCell(addr) {
    const column = this.store.columnByKey(addr.colKey);
    return !!(column && column.parse && column.parse.kind === "select");
  }
  /**
   * Whether the active cell is blank on a required column — statically required, or required
   * per row by the declarative `requiredWhen` (store.cellRequired — e.g. the voucher's
   * active-side amount under its D/C selector). A per-row 'dynamic' (closure) required stays
   * a server-only verdict the client can't resolve, so those never block (the server verdict
   * arrives on commit instead).
   */
  isBlankRequired(addr) {
    const column = this.store.columnByKey(addr.colKey);
    const hit = this.store.rowByKey.get(addr.rowKey);
    if (!this.store.cellRequired(hit ? hit.row : null, column)) {
      return false;
    }
    return this.isEmptyCell(addr);
  }
  /** True when the active cell's column is editable (so type-through/F2 opens the editor there). */
  activeCellEditable() {
    const addr = this.store.active;
    if (!addr) {
      return false;
    }
    const column = this.store.columnByKey(addr.colKey);
    return !!(column && column.editable);
  }
  /**
   * True when the active cell's editor is an INSTANT one (checkbox) — a registry lookup, so the
   * dispatcher stays type-agnostic (any future instant editor gets the same Space/Enter rules).
   */
  activeCellInstant() {
    const addr = this.store.active;
    if (!addr) {
      return false;
    }
    const column = this.store.columnByKey(addr.colKey);
    const EditorClass = column && column.editor ? editorFor(column.editor) : null;
    return !!(EditorClass && EditorClass.instant);
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/clipboard/ClipboardManager.js
function parseTsv(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => line.split("	"));
}
var _ClipboardManager = class _ClipboardManager {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {object} [hooks]
   * @param {(msg: string) => void} [hooks.announce] a11y announcement callback
   */
  constructor(store, hooks = {}) {
    this.store = store;
    this.hooks = hooks;
  }
  /**
   * Serialize the current selection to a TSV string — display values (readonly) or canonical
   * edit text (editable), so an editable copy → paste round-trips to identical model values.
   */
  selectionToTsv() {
    const grid = this.store.selectedCells();
    const editable = this.store.editable;
    return grid.map((cells) => cells.map((cell) => editable ? editTextFor(cell.column, cell.value) : formatValue(cell.column.format, cell.value)).join("	")).join("\n");
  }
  /** Copy the current selection to the clipboard; announce the shape. */
  copy() {
    const grid = this.store.selectedCells();
    if (grid.length === 0) {
      return;
    }
    const tsv = this.selectionToTsv();
    this.write(tsv);
    const rows = grid.length;
    const cols = grid[0] ? grid[0].length : 0;
    this.announce(`Copied ${rows} ${rows === 1 ? "row" : "rows"} by ${cols} ${cols === 1 ? "column" : "columns"}.`);
  }
  // ---- Paste (M5) -------------------------------------------------------------------------
  /**
   * Paste TSV text at the anchor (active) cell of an editable grid.
   *
   * @param {string} text the clipboard text/plain payload
   * @param {object} ctx GridCore-provided services
   * @param {import('../edit/EditorManager').default} ctx.editor
   * @param {import('../sync/SyncManager').default} ctx.sync
   * @param {import('../popup/PopupManager').default|null} ctx.popup
   * @param {() => HTMLElement|null} ctx.anchorCellEl the active cell's element (confirm anchor)
   */
  paste(text, ctx) {
    const anchor = this.store.active;
    if (!this.store.editable || !anchor || !ctx.editor || !ctx.sync) {
      return;
    }
    const matrix = parseTsv(text);
    if (matrix.length === 0) {
      return;
    }
    const plan = this.buildPastePlan(anchor, matrix);
    if (plan.cells.length === 0) {
      this.announce("Nothing to paste here.");
      return;
    }
    if (plan.cells.length > _ClipboardManager.CONFIRM_THRESHOLD && ctx.popup) {
      this.confirmLargePaste(plan, ctx);
      return;
    }
    this.applyPaste(plan, ctx);
  }
  /**
   * Map the TSV matrix onto grid cells: fields land on consecutive EDITABLE visible columns
   * starting at the anchor's column (non-editable columns are skipped, surplus fields dropped);
   * rows land on consecutive grid rows, growing the grid when auto-append allows (else clamped).
   *
   * @returns {{cells: Array<{rowKey: string, colKey: string, column: object, raw: string}>,
   *            newRowKeys: string[], clampedRows: number}}
   */
  buildPastePlan(anchor, matrix) {
    const cols = this.store.visibleColumns();
    const startCol = this.store.colIndexOf(anchor.colKey);
    const targetCols = [];
    for (let c = startCol; c >= 0 && c < cols.length; c++) {
      if (cols[c].editable) {
        targetCols.push(cols[c]);
      }
    }
    const startRow = this.store.rowIndexOf(anchor.rowKey);
    const autoAppend = !!(this.store.layout && this.store.layout.autoAppend);
    const rowCount = this.store.rowCount();
    const cells = [];
    const newRowKeys = [];
    let clampedRows = 0;
    for (let i = 0; i < matrix.length; i++) {
      const rowIndex = startRow + i;
      let rowKey;
      if (rowIndex < rowCount) {
        rowKey = this.store.rowAt(rowIndex)._k;
      } else if (autoAppend) {
        const overflow = rowIndex - rowCount;
        while (newRowKeys.length <= overflow) {
          newRowKeys.push("r" + this.store.nextSeq() + Math.random().toString(36).slice(2, 6));
        }
        rowKey = newRowKeys[overflow];
      } else {
        clampedRows++;
        continue;
      }
      const fields = matrix[i];
      for (let j = 0; j < fields.length && j < targetCols.length; j++) {
        cells.push({ rowKey, colKey: targetCols[j].key, column: targetCols[j], raw: fields[j] });
      }
    }
    return { cells, newRowKeys, clampedRows };
  }
  /**
   * Apply a paste plan: append the needed blank rows (optimistic + insert ops), stage every
   * cell through EditorManager.pasteCell (parse + validate + optimistic apply), flag + skip
   * failures, and flush everything as ONE batch.
   */
  applyPaste(plan, ctx) {
    const items = [];
    for (const key of plan.newRowKeys) {
      this.store.insertRow(key);
      items.push({ op: { seq: this.store.nextSeq(), t: "insert", as: key }, cells: [] });
    }
    let applied = 0;
    let skipped = 0;
    for (const cell of plan.cells) {
      const result = ctx.editor.pasteCell(cell.rowKey, cell.colKey, cell.column, cell.raw);
      if (result.ok) {
        items.push({ op: result.op, cells: result.cells });
        applied++;
      } else {
        this.store.setError(cell.rowKey, cell.colKey, result.message);
        skipped++;
      }
    }
    if (items.length) {
      ctx.sync.enqueueBatch(items);
    }
    let message = `Pasted ${applied} ${applied === 1 ? "cell" : "cells"}.`;
    if (skipped) {
      message += ` ${skipped} skipped.`;
    }
    if (plan.clampedRows) {
      message += ` ${plan.clampedRows} ${plan.clampedRows === 1 ? "row" : "rows"} beyond the grid dropped.`;
    }
    this.announce(message);
  }
  /** Oversize paste: ask first via the grid popup (keyboard: Enter confirms, Esc cancels). */
  confirmLargePaste(plan, ctx) {
    const anchorEl = ctx.anchorCellEl ? ctx.anchorCellEl() : null;
    if (!anchorEl) {
      return;
    }
    const popupEl = ctx.popup.open({ anchorEl, owner: "paste-confirm" });
    const wrap = el("div", "lgrid-confirm");
    const message = el("div");
    setText(message, `Paste ${plan.cells.length} cells${plan.newRowKeys.length ? ` (adding ${plan.newRowKeys.length} rows)` : ""}?`);
    const actions = el("div", "lgrid-confirm-actions");
    const cancel = el("button", "lgrid-confirm-btn");
    cancel.type = "button";
    setText(cancel, "Cancel");
    const confirm = el("button", "lgrid-confirm-btn lgrid-confirm-btn--primary");
    confirm.type = "button";
    setText(confirm, "Paste");
    confirm.addEventListener("click", () => {
      ctx.popup.close("owner");
      this.applyPaste(plan, ctx);
    });
    cancel.addEventListener("click", () => ctx.popup.close("owner"));
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ctx.popup.close("owner");
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    wrap.appendChild(message);
    wrap.appendChild(actions);
    popupEl.appendChild(wrap);
    ctx.popup.position();
    confirm.focus();
  }
  announce(message) {
    if (this.hooks.announce) {
      this.hooks.announce(message);
    }
  }
  /** Write text to the clipboard, preferring the async API, falling back to execCommand. */
  write(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).catch(() => this.fallbackWrite(text));
      return;
    }
    this.fallbackWrite(text);
  }
  fallbackWrite(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("aria-hidden", "true");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
    }
    document.body.removeChild(ta);
  }
};
/** Cell count above which a paste asks for confirmation first (plan G15). */
__publicField(_ClipboardManager, "CONFIRM_THRESHOLD", 500);
var ClipboardManager = _ClipboardManager;

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/statusbar/StatusBar.js
var StatusBar = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../core/EventBus').default} bus
   * @param {HTMLElement} barEl the x-ref="statusbar" container
   */
  constructor(store, bus, barEl) {
    this.store = store;
    this.bus = bus;
    this.barEl = barEl;
    this.sub = bus.on("selection:changed", () => this.render());
  }
  destroy() {
    if (this.sub) {
      this.sub();
    }
  }
  /**
   * Aggregate the selection: total selected cells, and Sum/Avg over the numeric ones.
   * @returns {{count: number, numericCount: number, sum: number, format: object|null}}
   */
  aggregate() {
    const grid = this.store.selectedCells();
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let format = null;
    for (const cells of grid) {
      for (const { column, value } of cells) {
        count++;
        if (!column.selectableNumeric) {
          continue;
        }
        const num = Number(value);
        if (value === null || value === void 0 || value === "" || Number.isNaN(num)) {
          continue;
        }
        if (format === null) {
          format = column.format || null;
        }
        sum += num;
        numericCount++;
      }
    }
    return { count, numericCount, sum, format };
  }
  render() {
    const { count, numericCount, sum, format } = this.aggregate();
    this.barEl.textContent = "";
    if (count === 0) {
      this.barEl.hidden = true;
      return;
    }
    this.barEl.hidden = false;
    this.barEl.appendChild(this.segment("Count", String(count)));
    if (numericCount > 0) {
      this.barEl.appendChild(this.segment("Sum", formatValue(format, sum)));
      const avg = sum / numericCount;
      this.barEl.appendChild(this.segment("Avg", formatValue(format, avg)));
    }
  }
  /** One labelled status-bar segment (semantic classes only). */
  segment(label, value) {
    const seg = el("div", "lgrid-status-seg");
    seg.appendChild(el("span", "lgrid-status-label", label));
    const v = el("span", "lgrid-status-value");
    setText(v, value);
    seg.appendChild(v);
    return seg;
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/a11y/Announcer.js
var Announcer = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../core/EventBus').default} bus
   * @param {HTMLElement} regionEl the aria-live region
   */
  constructor(store, bus, regionEl) {
    this.store = store;
    this.bus = bus;
    this.regionEl = regionEl;
    this.timer = null;
    this.subs = [
      bus.on("active:changed", () => this.scheduleActive()),
      bus.on("selection:changed", () => this.scheduleSelection())
    ];
  }
  destroy() {
    this.subs.forEach((off) => off());
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
  /** Announce a message immediately (e.g. "Copied 2 rows by 3 columns."). */
  message(text) {
    setText(this.regionEl, text);
  }
  /** Debounced active-cell announcement (settled cell only). */
  scheduleActive() {
    this.schedule(() => {
      const addr = this.store.active;
      if (!addr) {
        return "";
      }
      const column = this.store.visibleColumns().find((c) => c.key === addr.colKey);
      const rowIndex = this.store.rowIndexOf(addr.rowKey);
      const value = this.store.rawValueAt(rowIndex, this.store.colIndexOf(addr.colKey));
      const label = column ? column.label : addr.colKey;
      const shown = column ? formatValue(column.format, value) : String(value ?? "");
      return `${label}, row ${rowIndex + 1}${shown ? ", " + shown : ""}`;
    });
  }
  /** Debounced selection announcement (only for real ranges). */
  scheduleSelection() {
    this.schedule(() => {
      const sel = this.store.selection;
      if (!sel || sel.r0 === sel.r1 && sel.c0 === sel.c1) {
        return "";
      }
      const rows = sel.r1 - sel.r0 + 1;
      const cols = sel.c1 - sel.c0 + 1;
      return `${rows} by ${cols} selected`;
    });
  }
  /** Trailing debounce (~120ms) so a burst of moves announces only the final state. */
  schedule(build) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      const text = build();
      if (text) {
        this.message(text);
      }
    }, 120);
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/util/lru.js
var Lru = class {
  /**
   * @param {number} capacity max entries kept (>=1)
   */
  constructor(capacity = 24) {
    this.capacity = Math.max(1, capacity);
    this.map = /* @__PURE__ */ new Map();
  }
  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.map.has(key);
  }
  /**
   * Read a value, marking it most-recently-used. Returns undefined on a miss.
   * @param {string} key
   */
  get(key) {
    if (!this.map.has(key)) {
      return void 0;
    }
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  /**
   * Store a value as most-recently-used, evicting the LRU entry if over capacity.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  /** Drop all entries. */
  clear() {
    this.map.clear();
  }
  /** Current entry count. */
  get size() {
    return this.map.size;
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/sync/PageSource.js
var PageSource = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../core/EventBus').default} bus
   * @param {object} wire the Livewire $wire proxy (has async gridFetch)
   * @param {{cacheSize?: number}} [opts]
   */
  constructor(store, bus, wire, opts = {}) {
    this.store = store;
    this.bus = bus;
    this.wire = wire;
    this.cache = new Lru(opts.cacheSize || 24);
    this.seq = 0;
    this.latest = 0;
    this.loading = false;
    this.idleHandle = null;
    this.cache.set(this.signatureOf(this.store.query), this.pageFromStore());
  }
  /** The page payload equivalent for what the store currently displays (for the seed entry). */
  pageFromStore() {
    return {
      rows: this.store.rows,
      total: this.store.serverMeta.total,
      page: this.store.serverMeta.page,
      perPage: this.store.serverMeta.perPage,
      lastPage: this.store.serverMeta.lastPage,
      pageTotals: this.store.pageTotals,
      grandTotals: this.store.grandTotals
    };
  }
  /** A stable string signature for a query (order-independent for filters). */
  signatureOf(query) {
    const filters = query.filters || {};
    const orderedFilters = Object.keys(filters).sort().reduce((acc, k) => {
      acc[k] = filters[k];
      return acc;
    }, {});
    return JSON.stringify({
      sort: query.sort || null,
      dir: query.dir || "asc",
      search: query.search || "",
      filters: orderedFilters,
      page: query.page || 1,
      perPage: query.perPage || this.store.serverMeta.perPage
    });
  }
  // ---- Public query intents -------------------------------------------------------------
  /** Cycle a column's sort (asc → desc → clear-to-default) and reload page 1. */
  sort(colKey) {
    const q = { ...this.store.query };
    if (q.sort !== colKey) {
      q.sort = colKey;
      q.dir = "asc";
    } else if (q.dir === "asc") {
      q.dir = "desc";
    } else {
      const def = this.store.layout && this.store.layout.defaultSort || null;
      q.sort = def ? def.col : null;
      q.dir = def ? def.dir : "asc";
    }
    q.page = 1;
    this.load(q);
  }
  /** Set the global search term and reload page 1. */
  search(term) {
    this.load({ ...this.store.query, search: term || "", page: 1 });
  }
  /** Set a filter value (undefined/'' clears it) and reload page 1. */
  setFilter(key, value) {
    const filters = { ...this.store.query.filters || {} };
    if (value === void 0 || value === null || value === "") {
      delete filters[key];
    } else {
      filters[key] = value;
    }
    this.load({ ...this.store.query, filters, page: 1 });
  }
  /** Go to an explicit page (clamped by the server). */
  goToPage(page) {
    const target = Math.max(1, Math.min(page, this.store.serverMeta.lastPage));
    if (target === this.store.serverMeta.page) {
      return;
    }
    this.load({ ...this.store.query, page: target });
  }
  nextPage() {
    this.goToPage(this.store.serverMeta.page + 1);
  }
  prevPage() {
    this.goToPage(this.store.serverMeta.page - 1);
  }
  /** Change page size and reload from page 1. */
  setPerPage(perPage) {
    this.load({ ...this.store.query, perPage, page: 1 });
  }
  // ---- Fetch + reconcile ----------------------------------------------------------------
  /**
   * Load a query: serve from cache instantly if present, else fetch. A monotonic seq guards
   * against a stale response for a query the user has since moved past.
   * @param {object} query
   */
  /**
   * Cache-busting reload of the CURRENT query (P7): a call action changed data server-side,
   * so every cached page is stale — drop them all and refetch in place.
   */
  refresh() {
    this.cache.clear();
    this.load({ ...this.store.query });
  }
  load(query) {
    this.cancelPrefetch();
    const sig = this.signatureOf(query);
    const mySeq = ++this.seq;
    this.latest = mySeq;
    const cached = this.cache.get(sig);
    if (cached) {
      this.apply(cached, query, mySeq);
      return;
    }
    this.setLoading(true);
    this.fetch(query).then((page) => {
      this.cache.set(sig, page);
      this.apply(page, query, mySeq);
    }).catch((err) => {
      if (mySeq === this.latest) {
        this.setLoading(false);
        this.bus.emit("fetch:error", { error: err, query });
      }
    });
  }
  /** The raw RPC — resolves to the page payload. */
  fetch(query) {
    return this.wire.gridFetch(this.store.name, query);
  }
  /**
   * Apply a page only if it's still the latest request (else it's stale — discard). Applying
   * updates the store (which repaints via rows:changed) and schedules an idle prefetch of the
   * next page.
   */
  apply(page, query, mySeq) {
    if (mySeq !== this.latest) {
      return;
    }
    this.setLoading(false);
    this.store.setPage(page, query);
    this.schedulePrefetch();
  }
  setLoading(on) {
    if (this.loading === on) {
      return;
    }
    this.loading = on;
    this.bus.emit("loading:changed", { loading: on });
  }
  // ---- Idle prefetch of the next page ---------------------------------------------------
  schedulePrefetch() {
    this.cancelPrefetch();
    const nextPage = this.store.serverMeta.page + 1;
    if (nextPage > this.store.serverMeta.lastPage) {
      return;
    }
    const query = { ...this.store.query, page: nextPage };
    const sig = this.signatureOf(query);
    if (this.cache.has(sig)) {
      return;
    }
    const run = () => {
      this.idleHandle = null;
      this.fetch(query).then((page) => this.cache.set(sig, page)).catch(() => {
      });
    };
    this.idleHandle = typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 1200 }) : setTimeout(run, 400);
  }
  cancelPrefetch() {
    if (this.idleHandle == null) {
      return;
    }
    if (typeof cancelIdleCallback === "function") {
      cancelIdleCallback(this.idleHandle);
    } else {
      clearTimeout(this.idleHandle);
    }
    this.idleHandle = null;
  }
  destroy() {
    this.cancelPrefetch();
    this.cache.clear();
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/PaginationBar.js
var PaginationBar = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../core/EventBus').default} bus
   * @param {import('../sync/PageSource').default} source
   * @param {HTMLElement} rootEl the x-ref="pagination" container
   */
  constructor(store, bus, source, rootEl) {
    this.store = store;
    this.bus = bus;
    this.source = source;
    this.rootEl = rootEl;
    this.onPageChanged = () => this.render();
    this.onLoading = ({ loading }) => this.setBusy(loading);
    this.unsub = [bus.on("page:changed", this.onPageChanged), bus.on("loading:changed", this.onLoading)];
  }
  render() {
    const meta = this.store.serverMeta;
    this.rootEl.textContent = "";
    this.rootEl.hidden = false;
    const info = el("div", "lgrid-pg-info");
    setText(
      info,
      meta.total === 0 ? "0 rows" : `Page ${meta.page} of ${meta.lastPage} \xB7 ${meta.total.toLocaleString()} rows`
    );
    this.rootEl.appendChild(info);
    const nav = el("div", "lgrid-pg-nav");
    const atFirst = meta.page <= 1;
    const atLast = meta.page >= meta.lastPage;
    nav.appendChild(this.button("\xAB", "First page", atFirst, () => this.source.goToPage(1)));
    nav.appendChild(this.button("\u2039", "Previous page", atFirst, () => this.source.prevPage()));
    nav.appendChild(this.button("\u203A", "Next page", atLast, () => this.source.nextPage()));
    nav.appendChild(this.button("\xBB", "Last page", atLast, () => this.source.goToPage(meta.lastPage)));
    const options = (this.store.layout && this.store.layout.paginate || {}).options || [];
    if (options.length > 0) {
      nav.appendChild(this.perPageSelect(options, meta.perPage));
    }
    this.rootEl.appendChild(nav);
  }
  /** A single nav button. */
  button(label, title, disabled, onClick) {
    const btn = el("button", "lgrid-pg-btn", label);
    btn.type = "button";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.disabled = !!disabled;
    if (!disabled) {
      btn.addEventListener("click", onClick);
    }
    return btn;
  }
  /** The page-size <select>. */
  perPageSelect(options, current) {
    const select = el("select", "lgrid-pg-perpage");
    select.setAttribute("aria-label", "Rows per page");
    for (const size of options) {
      const opt = el("option", void 0, `${size} / page`);
      opt.value = String(size);
      if (Number(size) === Number(current)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }
    select.addEventListener("change", (e) => this.source.setPerPage(Number(e.target.value)));
    return select;
  }
  setBusy(on) {
    this.rootEl.classList.toggle("lgrid-pg--busy", !!on);
  }
  destroy() {
    this.unsub.forEach((off) => off());
    this.rootEl.textContent = "";
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/sync/SyncManager.js
var SyncManager = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../core/EventBus').default} bus
   * @param {object} wire the Livewire $wire proxy (async gridOps)
   */
  constructor(store, bus, wire) {
    this.store = store;
    this.bus = bus;
    this.wire = wire;
    this.policy = store.layout && store.layout.sync || "per-cell";
    this.queue = [];
    this.inFlight = false;
    this.retryDelay = 0;
    this.destroyed = false;
    this.epoch = 0;
  }
  /**
   * Enqueue an op (recorded in the store's op log too — the undo/redo spine) and trigger a flush
   * per policy. `cells` are the cell addresses this op marks pending, for reconciliation.
   *
   * @param {object} op the wire op ({seq, t, row?, col?, v?, after?, as?, rows?})
   * @param {Array<{rowKey: string, colKey: string}>} [cells]
   * @param {{flush?: boolean}} [opts] force a flush regardless of policy (row ops flush now)
   */
  enqueue(op, cells = [], opts = {}) {
    this.queue.push({ op, cells });
    this.store.opLog.push(op);
    if (cells.length) {
      this.store.markPending(cells);
    }
    if (opts.flush || this.policy === "per-cell" || this.policy === "per-row") {
      this.flush();
    }
  }
  /**
   * Enqueue MANY staged ops as one unit (a TSV paste: row inserts + cell sets) and flush them
   * in a single round-trip. Each item is {op, cells} exactly as enqueue() takes; the batch
   * always flushes immediately (like the M4 row ops) — a paste is a deliberate bulk action,
   * not a keystroke to defer.
   *
   * @param {Array<{op: object, cells: Array<{rowKey: string, colKey: string}>}>} items
   */
  enqueueBatch(items) {
    for (const { op, cells } of items) {
      this.queue.push({ op, cells });
      this.store.opLog.push(op);
      if (cells && cells.length) {
        this.store.markPending(cells);
      }
    }
    if (items.length) {
      this.flush();
    }
  }
  /**
   * Flush all queued ops as one batch to gridOps and reconcile the response. Coalesces rapid
   * calls: if a request is already in flight, the new ops stay queued for the next flush.
   */
  async flush() {
    if (this.destroyed || this.inFlight || this.queue.length === 0 || !this.wire) {
      return;
    }
    const batchItems = this.queue.splice(0, this.queue.length);
    const ops = batchItems.map((b) => b.op);
    const epoch = this.epoch;
    this.inFlight = true;
    this.bus.emit("sync-state", { flushing: true, pending: this.store.pending.size });
    try {
      const response = await this.wire.gridOps(this.store.name, {
        baseVersion: this.store.version,
        ops
      });
      if (epoch !== this.epoch) {
        return;
      }
      this.retryDelay = 0;
      this.store.reconcile(response || { version: this.store.version, results: [], footer: {} });
      const rollback = (response && response.results || []).find(
        (result) => !result.ok && Array.isArray(result.rows)
      );
      if (rollback) {
        this.reset();
        this.store.reseed(rollback.rows);
        let message = "Change refused \u2014 grid resynced.";
        for (const cols of Object.values(rollback.errors || {})) {
          const first = Object.values(cols || {})[0];
          if (first) {
            message = first;
            break;
          }
        }
        this.bus.emit("rows:rolled-back", { message });
      }
      if (response && response.footer) {
        this.bus.emit("footer:changed", { footer: response.footer });
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.queue.unshift(...batchItems);
      this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 300, 5e3);
      this.bus.emit("sync-state", { error: true });
      if (!this.destroyed) {
        this.retryTimer = setTimeout(() => this.flush(), this.retryDelay);
      }
    } finally {
      this.inFlight = false;
      this.bus.emit("sync-state", { flushing: false, pending: this.store.pending.size });
      if (this.queue.length && !this.destroyed) {
        this.flush();
      }
    }
  }
  /**
   * Called when the active ROW changes (PerRow policy) — flushes the queue so a completed row's
   * edits reach the server together. A no-op under PerCell (already flushed) / Deferred (waits).
   */
  onActiveRowChanged() {
    if (this.policy === "per-row") {
      this.flush();
    }
  }
  /** True when there are unsynced ops (dirty). Used by the host to decide whether to flush pre-save. */
  hasPending() {
    return this.queue.length > 0 || this.inFlight;
  }
  /**
   * Drop every queued (unflushed) op and orphan any in-flight batch (epoch bump): a host
   * reseed (`lgrid:reseed`) supersedes the rows those ops describe, so applying — or
   * retrying — them against the reseeded store would only manufacture "row no longer
   * exists" errors.
   */
  reset() {
    this.epoch++;
    this.queue = [];
    this.retryDelay = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.bus.emit("sync-state", { flushing: false, pending: 0 });
  }
  destroy() {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/EditorManager.js
var EditorManager = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../render/Renderer').default} renderer
   * @param {import('../selection/SelectionManager').default} selection
   * @param {import('../sync/SyncManager').default} sync
   * @param {import('../validate/ClientValidator').default} validator
   * @param {import('../core/EventBus').default} bus
   * @param {{root: HTMLElement, editor: HTMLElement}} refs the floating editor host
   * @param {object} [picker] M5 picker services (editable grids with a live $wire)
   * @param {import('../popup/PopupManager').default} [picker.popup]
   * @param {(colKey: string, term: string, row: object) => Promise<Array>} [picker.search]
   *        the gridOptions RPC bridge (tenant-scoped, server-capped)
   */
  constructor(store, renderer, selection, sync, validator, bus, refs, picker = {}) {
    this.store = store;
    this.renderer = renderer;
    this.selection = selection;
    this.sync = sync;
    this.validator = validator;
    this.bus = bus;
    this.refs = refs;
    this.popup = picker.popup || null;
    this.search = picker.search || null;
    this.optionCaches = /* @__PURE__ */ new Map();
    this.mode = "NAV";
    this.editor = null;
    this.editorCol = null;
    this.editorRow = null;
    this.pickLabel = null;
    this.composing = false;
    this.offActiveChanged = bus.on("active:changed", ({ active }) => this.maybeAutofillBalance(active));
  }
  isEditing() {
    return this.mode === "EDIT";
  }
  /**
   * Open the editor over the active cell. An `instant` editor class (checkbox) short-circuits
   * into a value toggle through the shared pipeline — no EDIT mode, no floating input.
   *
   * @param {{seed?: string, caretAtEnd?: boolean}} [opts]
   *   seed = a printable char that pre-seeds a type-through edit (replaces content);
   *   caretAtEnd = F2 mode (keep content, caret at end).
   */
  open(opts = {}) {
    if (this.mode === "EDIT") {
      return;
    }
    const addr = this.store.active;
    if (!addr) {
      return;
    }
    const column = this.store.columnByKey(addr.colKey);
    if (!column || !column.editable) {
      return;
    }
    const hit = this.store.rowByKey.get(addr.rowKey);
    if (!hit || this.isReadonlyCell(column, hit.row)) {
      return;
    }
    const EditorClass = editorFor(column.editor);
    if (!EditorClass) {
      return;
    }
    const cellEl = this.renderer.cellElFor(addr.rowKey, addr.colKey);
    if (!cellEl) {
      return;
    }
    if (EditorClass.instant) {
      this.toggleInstant(addr, column, hit.row);
      return;
    }
    this.mode = "EDIT";
    this.editorRow = addr.rowKey;
    this.editorCol = addr.colKey;
    this.pickLabel = null;
    this.positionOver(cellEl);
    this.refs.editor.hidden = false;
    const initialText = opts.seed != null ? opts.seed : this.currentText(hit.row, column);
    this.editor = new EditorClass();
    this.editor.mount(this.refs.editor, {
      column,
      row: hit.row,
      initialText,
      seed: opts.seed != null ? opts.seed : null,
      caretAtEnd: !!opts.caretAtEnd || opts.seed != null,
      // M5 picker services — plain-input editors simply ignore these.
      popup: this.popup,
      cellEl,
      requestCommit: (commitOpts = {}) => this.commit(commitOpts),
      requestCancel: () => this.cancel(),
      setLabel: (label) => {
        this.pickLabel = label;
      },
      searchOptions: (term) => this.searchOptions(column, hit.row, term),
      // Busy "End of List" exit option (endOfListOption): the resolved label to inject at the
      // top of the dropdown, or null when this open isn't eligible (column didn't declare it,
      // the grid holds no real row yet, or this isn't a blank trailing row). `endOfList` fires
      // the escape. Resolved HERE so the picker editors stay store-agnostic.
      endOfListLabel: this.endOfListLabelFor(column, addr.rowKey),
      endOfList: () => this.endOfList()
    });
    this.bindEditorEvents();
    this.bus.emit("editor:opened", { rowKey: addr.rowKey, colKey: addr.colKey });
  }
  /**
   * The current EDITING text for the cell (F2 / dblclick preserve): the canonical interchange
   * text per parse kind — paise → rupees, ISO date → d-m-Y — so re-committing what the editor
   * shows reproduces the same model value (the M4 F2-on-Amount 100× defect is fixed here).
   */
  currentText(row, column) {
    return editTextFor(column, row[column.key]);
  }
  isReadonlyCell(column, row) {
    if (column.readonly === true) {
      return true;
    }
    if (this.store.cellLocked(row, column)) {
      return true;
    }
    return false;
  }
  /**
   * Instant toggle for a checkbox cell (Space / Enter-open / dblclick): flip the current value
   * through the SHARED commit pipeline (optimistic apply + op) without entering EDIT mode.
   */
  toggleInstant(addr, column, row) {
    const next = !parseBool(row[column.key]);
    this.commitCell(addr.rowKey, addr.colKey, column, {
      parsed: next,
      wireValue: next
    });
  }
  /**
   * Search a column's server options for a term, through a per-column LRU. The monotonic-seq
   * stale-discard lives in the CALLER (the editor owns "which term am I showing"); this layer
   * only avoids re-fetching a term it has already resolved. The single shared editor means at
   * most one search editor exists at a time — ≤ 1 in-flight search grid-wide by construction.
   *
   * @returns {Promise<Array<{value: string, label: string}>>}
   */
  searchOptions(column, row, term) {
    if (!this.search) {
      return Promise.resolve([]);
    }
    let cache = this.optionCaches.get(column.key);
    if (!cache) {
      cache = new Lru(32);
      this.optionCaches.set(column.key, cache);
    }
    const key = String(term == null ? "" : term);
    if (cache.has(key)) {
      return Promise.resolve(cache.get(key));
    }
    return this.search(column.key, key, row).then((options) => {
      const list = Array.isArray(options) ? options : [];
      cache.set(key, list);
      return list;
    });
  }
  /** Position the editor host exactly over a cell (both inside the scroll container). */
  positionOver(cellEl) {
    const host = this.refs.editor;
    const rect = cellEl.getBoundingClientRect();
    const ref = host.parentElement.getBoundingClientRect();
    host.style.left = `${rect.left - ref.left + host.parentElement.scrollLeft}px`;
    host.style.top = `${rect.top - ref.top + host.parentElement.scrollTop}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
  }
  bindEditorEvents() {
    const host = this.refs.editor;
    this.onKeyDown = (e) => this.handleEditorKey(e);
    this.onBlur = () => {
      if (this.mode !== "EDIT") {
        return;
      }
      this.blurTimer = setTimeout(() => {
        if (this.mode === "EDIT") {
          this.commit({ advance: null });
        }
      }, 0);
    };
    this.onCompositionStart = () => {
      this.composing = true;
    };
    this.onCompositionEnd = () => {
      this.composing = false;
    };
    host.addEventListener("keydown", this.onKeyDown);
    host.addEventListener("focusout", this.onBlur);
    host.addEventListener("compositionstart", this.onCompositionStart);
    host.addEventListener("compositionend", this.onCompositionEnd);
  }
  /**
   * Editor-mode key handling. The EDITOR gets first refusal (handleKey — a popup editor owns
   * arrows/Enter/Esc while its list is open, R4/§2.6 POPUP state); unconsumed keys fall through
   * to the shared routing: Enter/Tab commit + advance; Esc cancels; arrows per editor policy.
   */
  handleEditorKey(e) {
    if (this.composing) {
      return;
    }
    if (this.editor && typeof this.editor.handleKey === "function" && this.editor.handleKey(e)) {
      return;
    }
    const key = e.key;
    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }
    if (key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.commit({ advance: e.shiftKey ? "enterBack" : "enter" });
      return;
    }
    if (key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.commit({ advance: e.shiftKey ? "prev" : "next" });
      return;
    }
    const policy = this.editor.keyPolicy ? this.editor.keyPolicy(e) : null;
    if (policy === "commit-move") {
      e.preventDefault();
      e.stopPropagation();
      const advance = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "prevCell" : "nextCell";
      this.commit({ advance });
    }
  }
  /**
   * Commit the open editor: read raw text → parse via the column's spec → client-validate →
   * hand off to the shared pipeline → close + advance. A parse refusal (the date sentinel) or a
   * client validation failure keeps the editor open + flags the cell (the operator fixes it in
   * place).
   *
   * @param {{advance: string|null}} opts
   */
  commit(opts) {
    if (this.mode !== "EDIT" || !this.editor) {
      return;
    }
    const rowKey = this.editorRow;
    const colKey = this.editorCol;
    const column = this.store.columnByKey(colKey);
    const raw = this.editor.value();
    const parsed = parseValue(column.parse, raw);
    if (parsed === void 0) {
      this.store.setError(rowKey, colKey, "Not a recognisable date.");
      this.editor.focus(true);
      return;
    }
    const clientRules = column.validate && column.validate.client || [];
    const message = this.validator.validate(clientRules, parsed, column.label || colKey);
    if (message) {
      this.store.setError(rowKey, colKey, message);
      this.editor.focus(true);
      return;
    }
    const label = this.pickLabel;
    this.pickLabel = null;
    this.commitCell(rowKey, colKey, column, {
      parsed,
      wireValue: this.wireValueFor(column, raw, parsed),
      label
    });
    this.close();
    if (opts.advance) {
      this.panelOrAdvance(column, rowKey, opts.advance);
    }
  }
  /**
   * Either hand this forward advance off to a HOST panel (the column's opensPanel) or perform the
   * plain advance. A FORWARD advance (Enter / Tab) off a column that declares a panel dispatches
   * `grid:panel` (→ GridCore's bubbling `lgrid:panel`) INSTEAD of moving the cursor; the host runs
   * the panel and resumes the grid (`lgrid:panel-done`) so the deferred advance fires then. A
   * backward/arrow advance never triggers the panel — it just moves.
   *
   * Called from BOTH commit paths — the editor's commit() AND the NAV-mode Enter advance over an
   * already-filled cell (KeyboardManager.handleNavEnter) — so re-entering a filled Rate cell and
   * pressing Enter opens the popup exactly like editing it does (the value need not change).
   *
   * @param {object} column the serialized column config of the cell being left
   * @param {string} rowKey
   * @param {string} direction the advance intent (enter/next/enterBack/…)
   */
  panelOrAdvance(column, rowKey, direction) {
    if (column && column.opensPanel && this.isForwardAdvance(direction)) {
      this.bus.emit("grid:panel", { panel: column.opensPanel, rowKey, advance: direction });
      return;
    }
    this.advance(direction);
  }
  /** Whether an advance direction moves the cursor FORWARD (Enter / Tab) vs back/arrow. */
  isForwardAdvance(direction) {
    return direction === "enter" || direction === "next";
  }
  /**
   * THE shared commit pipeline core — optimistic store apply (+ label bookkeeping) + op
   * enqueue. Every write goes through here: the floating editor's commit, the checkbox instant
   * toggle, and TSV paste. Callers have already parsed/validated.
   *
   * @param {string} rowKey
   * @param {string} colKey
   * @param {object} column the serialized column config
   * @param {{parsed: *, wireValue: *, label?: string|null}} payload
   * @param {{enqueue?: boolean}} [opts] paste batches ops itself (enqueue: false)
   * @returns {{op: object, cells: Array<{rowKey: string, colKey: string}>}}
   */
  commitCell(rowKey, colKey, column, payload, opts = {}) {
    let changed = this.store.applyLocalSet(rowKey, colKey, payload.parsed);
    if (this.isPickerColumn(column)) {
      this.store.setRowLabel(rowKey, colKey, payload.label != null ? payload.label : null);
    }
    const wf = column.whenFilled;
    const filled = payload.parsed !== "" && payload.parsed != null && payload.parsed !== false;
    if (wf && filled) {
      const hit = this.store.rowByKey.get(rowKey);
      for (const [key, value] of Object.entries(wf.sets || {})) {
        if (hit && hit.row[key] !== value) {
          changed = changed.concat(this.store.applyLocalSet(rowKey, key, value));
        }
      }
      for (const key of wf.clears || []) {
        if (hit && hit.row[key] != null && hit.row[key] !== "") {
          changed = changed.concat(this.store.applyLocalSet(rowKey, key, null));
        }
      }
    }
    const op = { seq: this.store.nextSeq(), t: "set", row: rowKey, col: colKey, v: payload.wireValue };
    if (payload.label != null) {
      op.label = payload.label;
    }
    const cells = changed.length ? changed : [{ rowKey, colKey }];
    if (opts.enqueue !== false) {
      this.sync.enqueue(op, cells);
    }
    return { op, cells };
  }
  /**
   * Parse + validate + stage ONE pasted cell through the shared pipeline (enqueue deferred —
   * the ClipboardManager batches the whole paste into one flush). An embedded select accepts a
   * pasted LABEL or value (reverse lookup); a searchselect accepts the value id only (no
   * client-side reverse map — v1 limitation). Returns {ok, op?, cells?} or {ok:false, message}.
   *
   * @param {string} rowKey
   * @param {string} colKey
   * @param {object} column
   * @param {string} raw one TSV field
   */
  pasteCell(rowKey, colKey, column, raw) {
    let text = raw;
    let label = null;
    if (this.isPickerColumn(column) && Array.isArray(column.options) && column.options.length) {
      const needle = String(raw == null ? "" : raw).trim().toLowerCase();
      if (needle === "") {
        text = "";
      } else {
        const hit = column.options.find((o) => String(o.value).toLowerCase() === needle) || column.options.find((o) => o.label.toLowerCase() === needle);
        if (!hit) {
          return { ok: false, message: "Not one of the options." };
        }
        text = hit.value;
        label = hit.label;
      }
    }
    const parsed = parseValue(column.parse, text);
    if (parsed === void 0) {
      return { ok: false, message: "Not a recognisable date." };
    }
    const clientRules = column.validate && column.validate.client || [];
    const message = this.validator.validate(clientRules, parsed, column.label || colKey);
    if (message) {
      return { ok: false, message };
    }
    const staged = this.commitCell(rowKey, colKey, column, {
      parsed,
      wireValue: this.wireValueFor(column, text, parsed),
      label
    }, { enqueue: false });
    return { ok: true, op: staged.op, cells: staged.cells };
  }
  /**
   * What rides the wire as the op's `v`: picker kinds send the RESOLVED value (the picked id /
   * canonical ISO / boolean — the raw editor text is a filter term or fuzzy input, not a value);
   * text/number kinds keep the M4 raw-text convention (the server cast is authoritative).
   */
  wireValueFor(column, raw, parsed) {
    const kind = column.parse && column.parse.kind || "text";
    return kind === "select" || kind === "date" || kind === "bool" ? parsed : raw;
  }
  /** Whether a column is a picker (its cells carry a display label in the row's _labels bag). */
  isPickerColumn(column) {
    return !!(column.parse && column.parse.kind === "select");
  }
  /**
   * The resolved end-of-list exit-option label to inject at the top of this open's dropdown, or
   * null when it should NOT appear. Shown only when the column declares `endOfListOption` and THIS
   * is a blank trailing row (nothing being edited). By default it also requires the grid to hold
   * ≥1 real row (Busy's item-entry: an exit control on the empty row of a grid that has lines);
   * a column that declares `endOfListAllowOnEmpty` (an OPTIONAL entry grid — bill sundries) drops
   * that requirement so the exit shows from the very first blank row.
   *
   * @param {object} column the serialized column config
   * @param {string} rowKey
   * @returns {string|null}
   */
  endOfListLabelFor(column, rowKey) {
    if (!column.endOfListOption) {
      return null;
    }
    if (!this.store.rowIsBlankByKey(rowKey)) {
      return null;
    }
    if (!column.endOfListAllowOnEmpty && !this.store.hasAnyFilledRow()) {
      return null;
    }
    return column.endOfListOption;
  }
  /** Cancel the edit (Esc): discard the input, keep the stored value, stay on the cell. */
  cancel() {
    this.close();
    this.bus.emit("editor:closed", { cancelled: true });
    this.refs.root.focus();
  }
  /**
   * The Busy "End of List" exit: the operator picked the synthetic exit option in a picker's
   * dropdown. Tear the editor down WITHOUT committing (no value, no op, no advance), then fire the
   * grid's complete-guard escape (grid:complete → GridCore's bubbling `lgrid:complete`) so the host
   * forwards focus out of the grid — the same seam completeWhenBalanced uses. Kept a distinct hook
   * (not `cancel`) so the escape intent is explicit and never confused with an Esc discard.
   */
  endOfList() {
    this.close();
    this.bus.emit("editor:closed", { cancelled: true });
    this.bus.emit("grid:complete", {});
  }
  /** Tear down the editor element + listeners (and any popup it owned) and return to NAV. */
  close() {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
    }
    if (this.popup && this.popup.isOpen()) {
      this.popup.close("owner");
    }
    const host = this.refs.editor;
    host.removeEventListener("keydown", this.onKeyDown);
    host.removeEventListener("focusout", this.onBlur);
    host.removeEventListener("compositionstart", this.onCompositionStart);
    host.removeEventListener("compositionend", this.onCompositionEnd);
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    host.hidden = true;
    this.mode = "NAV";
    this.pickLabel = null;
    this.bus.emit("editor:closed", {});
    if (document.activeElement === document.body || host.contains(document.activeElement)) {
      this.refs.root.focus();
    }
  }
  /**
   * Advance the active cell after a commit, honouring the keymap for enter/tab and plain
   * direction for arrow-commit. Auto-append: an Enter past the last editable cell grows the grid.
   *
   * The movement intents passed to selection.move() must be the geometry module's vocabulary
   * ('nextWrap'/'prevWrap' for serpentine wrap, 'left'/'right'/'up'/'down' for directional) —
   * an unknown intent is a silent no-op in resolveMove, which reads as "Enter does nothing".
   * @param {string} direction
   */
  advance(direction) {
    const keymap = this.store.layout && this.store.layout.keymap || "entry";
    switch (direction) {
      case "enter":
        this.advanceOnEnter(keymap, false);
        break;
      case "enterBack":
        this.advanceOnEnter(keymap, true);
        break;
      case "next":
        this.moveOrAppend();
        break;
      case "prev":
        this.selection.move("prevWrap");
        break;
      case "down":
        this.selection.move("down");
        break;
      case "up":
        this.selection.move("up");
        break;
      case "nextCell":
        this.selection.move("right");
        break;
      case "prevCell":
        this.selection.move("left");
        break;
      default:
        break;
    }
  }
  /** Enter advance: serpentine wrap under the entry keymap; straight down/up under excel. */
  advanceOnEnter(keymap, back) {
    if (keymap === "excel") {
      this.selection.move(back ? "up" : "down");
      return;
    }
    if (back) {
      this.selection.move("prevWrap");
      return;
    }
    this.moveOrAppend();
  }
  /**
   * Serpentine-advance forward (nextWrap); if we're on the last row's last EDITABLE cell and
   * auto-append is on, insert a blank row and land on its first navigable cell instead
   * (Tally growth, G4) — UNLESS the grid's complete guard is satisfied (layout.complete,
   * e.g. the voucher balanced): then the entry is done, so instead of growing the grid the
   * host is signalled (grid:complete → the root's `lgrid:complete` DOM event) to take focus
   * forward (Save). While unbalanced the append keeps firing — rows grow until matched.
   */
  moveOrAppend() {
    if (this.atLastEditableCellOfLastRow() && this.store.layout.autoAppend) {
      if (this.store.isComplete()) {
        this.bus.emit("grid:complete", {});
        return;
      }
      const newKey = "r" + this.store.nextSeq() + Math.random().toString(36).slice(2, 6);
      this.store.insertRow(newKey);
      this.sync.enqueue({ seq: this.store.nextSeq(), t: "insert", as: newKey }, [], { flush: true });
      const col = firstNavigable(this.store.navigabilityMask());
      const addr = this.store.addressAt(this.store.rowIndexOf(newKey), col);
      if (addr) {
        this.store.setActive(addr);
      }
      return;
    }
    this.selection.move("nextWrap");
  }
  /**
   * Pre-fill the BALANCING amount when the active cell lands on an empty deficit-side amount
   * column of a balanced-entry grid (layout.complete, autofill on) — the Busy suggestion: after
   * Cr 1000, the next Dr cell offers 1000.00; if the operator overtypes 400, the following Dr
   * cell offers 600.00. The fill goes through the ONE commit pipeline (optimistic apply + op),
   * exactly as if typed, and the cursor STAYS on the cell — Enter accepts, typing replaces.
   *
   * Guards: only the declared pair columns; the cell must be editable, unlocked and empty with
   * its sibling amount empty too (a row that already carries an amount is the operator's own);
   * and only when the OTHER column's total exceeds this one's (a positive deficit) — a balanced
   * or leading side never fills, so fresh grids and arrow-wandering stay write-free.
   *
   * @param {{rowKey: string, colKey: string}|null} addr the new active cell
   */
  maybeAutofillBalance(addr) {
    if (!addr || this.mode === "EDIT") {
      return;
    }
    const selection = this.store.selection;
    if (selection && selection.kind !== "cell") {
      return;
    }
    const spec = this.store.layout && this.store.layout.complete;
    if (!spec || spec.kind !== "balanced" || spec.autofill === false) {
      return;
    }
    const columns = spec.columns || [];
    if (!columns.includes(addr.colKey)) {
      return;
    }
    const column = this.store.columnByKey(addr.colKey);
    const hit = this.store.rowByKey.get(addr.rowKey);
    if (!column || !column.editable || !hit || this.isReadonlyCell(column, hit.row)) {
      return;
    }
    for (const key of columns) {
      const value = hit.row[key];
      if (!(value == null || value === "")) {
        return;
      }
    }
    const other = columns.find((key) => key !== addr.colKey);
    const deficit = this.store.sumMinorUnits(other) - this.store.sumMinorUnits(addr.colKey);
    if (deficit <= 0) {
      return;
    }
    const text = (deficit / 100).toFixed(2);
    this.commitCell(addr.rowKey, addr.colKey, column, { parsed: text, wireValue: text });
  }
  /**
   * True when the active cell is the last EDITABLE cell of the last row. Auto-append triggers on
   * advancing past the last cell the operator can type into — trailing display/formula columns
   * (e.g. a computed Amount) don't count, so Enter on the last editable cell grows the grid rather
   * than parking on a read-only tail.
   */
  atLastEditableCellOfLastRow() {
    const { row, col } = this.store.indexOf(this.store.active);
    const cols = this.store.visibleColumns();
    let lastEditableCol = -1;
    for (let c = 0; c < cols.length; c++) {
      if (cols[c].editable) {
        lastEditableCol = c;
      }
    }
    return row === this.store.rowCount() - 1 && col >= lastEditableCol;
  }
  destroy() {
    if (this.mode === "EDIT") {
      this.close();
    }
    if (this.offActiveChanged) {
      this.offActiveChanged();
    }
    this.optionCaches.clear();
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/validate/ClientValidator.js
var ClientValidator = class {
  /**
   * Validate a value against a column's compiled `validate.client` rules.
   *
   * @param {Array<{rule: string, value?: *}>} rules
   * @param {*} value the parsed model value (paise int, decimal string, text, …)
   * @param {string} [label] the column label for messages
   * @returns {string|null} the first violation message, or null if it passes
   */
  validate(rules, value, label = "This field") {
    if (!Array.isArray(rules)) {
      return null;
    }
    for (const spec of rules) {
      const message = this.check(spec, value, label);
      if (message) {
        return message;
      }
    }
    return null;
  }
  /** @returns {string|null} */
  check(spec, value, label) {
    switch (spec.rule) {
      case "required":
        return this.isBlank(value) ? `${label} is required.` : null;
      case "maxLength":
        return String(value ?? "").length > spec.value ? `${label} must be at most ${spec.value} characters.` : null;
      case "min":
        return !this.isBlank(value) && this.toNumber(value) < spec.value ? `${label} must be at least ${spec.value}.` : null;
      case "max":
        return !this.isBlank(value) && this.toNumber(value) > spec.value ? `${label} must be at most ${spec.value}.` : null;
      case "regex":
        return !this.isBlank(value) && !this.matches(spec.value, value) ? `${label} is invalid.` : null;
      case "numeric":
      case "integer":
        return !this.isBlank(value) && Number.isNaN(this.toNumber(value)) ? `${label} must be a number.` : null;
      default:
        return null;
    }
  }
  isBlank(value) {
    return value === null || value === void 0 || value === "";
  }
  toNumber(value) {
    return Number(String(value).replace(/[,\s]/g, ""));
  }
  /** Evaluate a Laravel-style regex rule payload ("/pattern/flags" or a bare pattern). */
  matches(pattern, value) {
    try {
      const m = String(pattern).match(/^\/(.*)\/([a-z]*)$/i);
      const re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
      return re.test(String(value));
    } catch {
      return true;
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/ErrorPainter.js
var ErrorPainter = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../render/Renderer').default} renderer
   * @param {import('../core/EventBus').default} bus
   * @param {{root: HTMLElement, errorCount?: HTMLElement}} refs
   */
  constructor(store, renderer, bus, refs) {
    this.store = store;
    this.renderer = renderer;
    this.bus = bus;
    this.refs = refs;
    this.offErrors = bus.on("errors:changed", () => this.paintErrors());
    this.offDirty = bus.on("dirty:changed", ({ rowKey, colKey }) => this.paintDirty(rowKey, colKey));
    this.offSync = bus.on("sync-state", () => this.paintPending());
    this.offRows = bus.on("rows:changed", () => this.reassert());
    this.onKeyDown = (e) => this.handleKey(e);
    this.refs.root.addEventListener("keydown", this.onKeyDown);
  }
  /** Ctrl+E → jump to the first errored cell. */
  handleKey(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      this.jumpToFirstError();
    }
  }
  /**
   * Toggle the error ring/corner on each cell from the store's error map. Iterates the visible
   * grid directly (the same shape paintPending uses) rather than reverse-deriving a cell from a
   * mapKey — the store owns the truth (errorFor), the painter just reflects it onto the cells.
   */
  paintErrors() {
    for (const row of this.store.rows) {
      for (const col of this.store.visibleColumns()) {
        const el2 = this.renderer.cellElFor(row._k, col.key);
        if (el2) {
          toggleClass(el2, "lgrid-cell--error", !!this.store.errorFor(row._k, col.key));
        }
      }
    }
    this.updateFooterCount();
  }
  paintDirty(rowKey, colKey) {
    const el2 = this.renderer.cellElFor(rowKey, colKey);
    if (el2) {
      toggleClass(el2, "lgrid-cell--dirty", this.store.dirty.has(cellMapKey(rowKey, colKey)));
    }
  }
  /** Toggle pending shimmer on cells with an op in flight. */
  paintPending() {
    for (const row of this.store.rows) {
      for (const col of this.store.visibleColumns()) {
        const key = cellMapKey(row._k, col.key);
        const el2 = this.renderer.cellElFor(row._k, col.key);
        if (el2) {
          toggleClass(el2, "lgrid-cell--pending", this.store.pending.has(key));
          toggleClass(el2, "lgrid-cell--dirty", this.store.dirty.has(key));
        }
      }
    }
  }
  /** Re-apply error/dirty classes after a full body repaint (rows:changed). */
  reassert() {
    this.paintErrors();
    this.paintPending();
  }
  updateFooterCount() {
    const count = this.store.errors.size;
    this.refs.root.classList.toggle("lgrid--has-errors", count > 0);
    if (this.refs.errorCount) {
      this.refs.errorCount.textContent = count > 0 ? String(count) : "";
      this.refs.errorCount.hidden = count === 0;
    }
  }
  /** Focus the first errored cell (Ctrl+E). */
  jumpToFirstError() {
    for (const row of this.store.rows) {
      for (const col of this.store.visibleColumns()) {
        if (this.store.errors.has(cellMapKey(row._k, col.key))) {
          this.store.setActive({ rowKey: row._k, colKey: col.key });
          return;
        }
      }
    }
  }
  destroy() {
    this.refs.root.removeEventListener("keydown", this.onKeyDown);
    if (this.offErrors) {
      this.offErrors();
    }
    if (this.offDirty) {
      this.offDirty();
    }
    if (this.offSync) {
      this.offSync();
    }
    if (this.offRows) {
      this.offRows();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/popup/PopupManager.js
var PopupManager = class {
  /**
   * @param {{root: HTMLElement, scroll: HTMLElement, popup: HTMLElement}} refs
   */
  constructor(refs) {
    this.refs = refs;
    this.openFor = null;
    this.onRequestClose = null;
    this.onPopupPointerDown = (e) => {
      e.preventDefault();
    };
    this.refs.popup.addEventListener("pointerdown", this.onPopupPointerDown, true);
    this.onDocPointerDown = (e) => {
      if (!this.refs.popup.contains(e.target)) {
        this.close("outside");
      }
    };
    this.onScroll = () => this.close("scroll");
  }
  isOpen() {
    return this.openFor !== null;
  }
  /**
   * Open (or re-own) the popup anchored to a cell element. Returns the popup element for the
   * owner to fill — the content is cleared on every open.
   *
   * @param {{anchorEl: HTMLElement, owner: string, className?: string, onRequestClose?: (reason: string) => void}} opts
   * @returns {HTMLElement}
   */
  open(opts) {
    if (this.isOpen()) {
      this.close("reopen");
    }
    const popup = this.refs.popup;
    popup.textContent = "";
    popup.className = "lgrid-popup" + (opts.className ? " " + opts.className : "");
    popup.hidden = false;
    this.openFor = opts.owner || "anon";
    this.onRequestClose = opts.onRequestClose || null;
    this.anchorEl = opts.anchorEl;
    this.position();
    document.addEventListener("pointerdown", this.onDocPointerDown, true);
    this.refs.scroll.addEventListener("scroll", this.onScroll, { passive: true });
    return popup;
  }
  /**
   * (Re)position below the anchor, flipping above when the space below the anchor inside the
   * viewport can't fit the popup but the space above can. Call again after filling content —
   * the height isn't known until then.
   */
  position() {
    if (!this.isOpen() || !this.anchorEl || !this.anchorEl.isConnected) {
      return;
    }
    const popup = this.refs.popup;
    const rootRect = this.refs.root.getBoundingClientRect();
    const anchor = this.anchorEl.getBoundingClientRect();
    popup.style.minWidth = `${Math.ceil(anchor.width)}px`;
    const left = Math.max(0, Math.min(anchor.left - rootRect.left, rootRect.width - popup.offsetWidth));
    popup.style.left = `${left}px`;
    const height = popup.offsetHeight;
    const spaceBelow = window.innerHeight - anchor.bottom;
    const openAbove = spaceBelow < height + 8 && anchor.top - rootRect.top > height + 8;
    popup.style.top = openAbove ? `${anchor.top - rootRect.top - height}px` : `${anchor.bottom - rootRect.top}px`;
  }
  /**
   * Close the popup (if open) and notify the owner. `reason` ∈ 'outside' | 'scroll' |
   * 'reopen' | 'owner' | 'destroy' — owners use it to decide whether to also cancel the edit.
   */
  close(reason = "owner") {
    if (!this.isOpen()) {
      return;
    }
    const notify = this.onRequestClose;
    this.openFor = null;
    this.onRequestClose = null;
    this.anchorEl = null;
    const popup = this.refs.popup;
    popup.hidden = true;
    popup.textContent = "";
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    this.refs.scroll.removeEventListener("scroll", this.onScroll);
    if (notify) {
      notify(reason);
    }
  }
  destroy() {
    this.close("destroy");
    this.refs.popup.removeEventListener("pointerdown", this.onPopupPointerDown, true);
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/persist/LayoutStore.js
var SCHEMA_VERSION = 1;
var LayoutStore = class {
  /**
   * @param {{mode: string, key: string}|null} persist the serialized layout.persist fragment
   */
  constructor(persist) {
    this.key = persist && persist.mode === "local" && persist.key ? `lgrid:${persist.key}` : null;
  }
  /** Whether this grid persists layout at all. */
  enabled() {
    return this.key !== null;
  }
  /**
   * Load the persisted layout state, validated against the grid's real column keys.
   * @param {string[]} validKeys the definition's column keys — anything else is dropped
   * @returns {{widths: Object<string, number>, hidden: string[]}|null} null when disabled,
   *          absent, corrupt, or from another schema version
   */
  load(validKeys) {
    if (!this.key) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) {
        return null;
      }
      const data = JSON.parse(raw);
      if (!data || data.v !== SCHEMA_VERSION) {
        return null;
      }
      const widths = {};
      for (const [colKey, width] of Object.entries(data.widths || {})) {
        if (validKeys.includes(colKey) && Number.isFinite(width) && width > 0) {
          widths[colKey] = Math.round(width);
        }
      }
      const hidden = (Array.isArray(data.hidden) ? data.hidden : []).filter(
        (colKey) => validKeys.includes(colKey)
      );
      return { widths, hidden };
    } catch {
      return null;
    }
  }
  /**
   * Persist the current layout state (whole-entry write; quota/privacy failures are silent —
   * persistence is a convenience, never a requirement).
   * @param {Object<string, number>} widths column width overrides by key
   * @param {string[]} hidden hidden column keys
   */
  save(widths, hidden) {
    if (!this.key) {
      return;
    }
    try {
      window.localStorage.setItem(
        this.key,
        JSON.stringify({ v: SCHEMA_VERSION, widths: widths || {}, hidden: hidden || [] })
      );
    } catch {
    }
  }
  /** Clear the persisted entry (the column chooser's "Reset layout"). */
  reset() {
    if (!this.key) {
      return;
    }
    try {
      window.localStorage.removeItem(this.key);
    } catch {
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/resize/ResizeManager.js
var HARD_MIN = 36;
var HARD_MAX = 2e3;
var AUTOFIT_SAMPLE = 200;
var AUTOFIT_SLACK = 12;
var ResizeManager = class {
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
    this.onPointerDown = (e) => {
      const handle = e.target.closest(".lgrid-resize");
      if (!handle || !this.refs.head.contains(handle)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.startDrag(handle, e);
    };
    this.refs.head.addEventListener("pointerdown", this.onPointerDown, true);
    this.onDblClick = (e) => {
      const handle = e.target.closest(".lgrid-resize");
      if (!handle || !this.refs.head.contains(handle)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.autofit(handle.dataset.col);
    };
    this.refs.head.addEventListener("dblclick", this.onDblClick, true);
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
    const cell = handle.closest(".lgrid-headcell");
    const startWidth = cell ? cell.getBoundingClientRect().width : this.layout.columnWidth(column) || 120;
    const startX = e.clientX;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
    }
    this.refs.root.classList.add("lgrid--resizing");
    const onMove = (ev) => {
      this.applyWidth(column, startWidth + (ev.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      this.refs.root.classList.remove("lgrid--resizing");
      this.commit(column);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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
    this.bus.emit("column:resized", { col: column.key, width });
    this.refs.root.dispatchEvent(
      new CustomEvent("lgrid:column-resized", {
        detail: { grid: this.store.name, col: column.key, width },
        bubbles: true
      })
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
    const headCell = handle ? handle.closest(".lgrid-headcell") : null;
    if (headCell) {
      widest = this.measureContent(headCell);
    }
    const rows = this.refs.body.querySelectorAll(".lgrid-row");
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
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains("lgrid-resize")) {
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
      this.refs.head.removeEventListener("pointerdown", this.onPointerDown, true);
    }
    if (this.onDblClick) {
      this.refs.head.removeEventListener("dblclick", this.onDblClick, true);
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/ColumnChooser.js
var ColumnChooser = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {{root: HTMLElement, popup: HTMLElement}} refs
   * @param {import('../popup/PopupManager').default} popup
   * @param {import('../persist/LayoutStore').default} layoutStore
   * @param {{onChange: () => void, container?: HTMLElement}} hooks GridCore's relayout
   *        callback + an optional mount container (the toolbar's chooser slot); defaults
   *        to the grid root (the classic floating top-right button).
   */
  constructor(store, refs, popup, layoutStore, hooks) {
    this.store = store;
    this.refs = refs;
    this.popup = popup;
    this.layoutStore = layoutStore;
    this.onChange = hooks.onChange;
    this.hooksContainer = hooks.container || null;
    this.closedByOutsideAt = 0;
  }
  init() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lgrid-chooser-btn";
    button.textContent = "\u2699";
    button.title = "Columns";
    button.setAttribute("aria-label", "Choose columns");
    button.setAttribute("aria-haspopup", "true");
    this.button = button;
    (this.hooksContainer || this.refs.root).appendChild(button);
    this.onPointerDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pointerHandledAt = Date.now();
      if (Date.now() - this.closedByOutsideAt < 300) {
        return;
      }
      if (this.isOpen()) {
        this.popup.close("owner");
        return;
      }
      this.open();
    };
    button.addEventListener("pointerdown", this.onPointerDown);
    this.onClick = () => {
      if (Date.now() - (this.pointerHandledAt || 0) < 300) {
        return;
      }
      if (Date.now() - this.closedByOutsideAt < 300) {
        return;
      }
      this.open();
    };
    button.addEventListener("click", this.onClick);
    this.onKeydown = (e) => {
      if (e.key === "Escape" && this.isOpen()) {
        e.stopPropagation();
        this.popup.close("owner");
      }
    };
    button.addEventListener("keydown", this.onKeydown);
  }
  isOpen() {
    return this.popup.isOpen() && this.popup.openFor === "chooser";
  }
  open() {
    const container = this.popup.open({
      anchorEl: this.button,
      owner: "chooser",
      className: "lgrid-popup--chooser",
      onRequestClose: (reason) => {
        if (reason === "outside") {
          this.closedByOutsideAt = Date.now();
        }
      }
    });
    this.renderList(container);
    this.popup.position();
  }
  /** Build (or rebuild, after reset) the checklist + reset action into the popup. */
  renderList(container) {
    container.textContent = "";
    const list = document.createElement("div");
    list.className = "lgrid-chooser";
    for (const column of this.store.columns) {
      if (column.visible === false) {
        continue;
      }
      const lockedReason = column.type === "serial" || column.frozen;
      const item = document.createElement("label");
      item.className = "lgrid-chooser-item" + (lockedReason ? " lgrid-chooser-item--locked" : "");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !this.store.userHidden.has(column.key);
      checkbox.disabled = lockedReason;
      checkbox.dataset.col = column.key;
      checkbox.addEventListener("change", () => this.setHidden(column.key, !checkbox.checked));
      const label = document.createElement("span");
      label.textContent = column.label || column.key;
      item.append(checkbox, label);
      list.appendChild(item);
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "lgrid-chooser-reset";
    reset.textContent = "Reset layout";
    reset.addEventListener("click", () => this.reset());
    container.append(list, reset);
  }
  /** Hide/show one column, persist, and relayout through the single GridCore path. */
  setHidden(colKey, hidden) {
    if (hidden) {
      this.store.userHidden.add(colKey);
    } else {
      this.store.userHidden.delete(colKey);
    }
    this.applyChange();
    this.layoutStore.save(this.store.widthOverrides, [...this.store.userHidden]);
    this.emitVisibility();
  }
  /** Clear every operator layout override (widths + hidden) and the persisted entry. */
  reset() {
    this.store.userHidden.clear();
    this.store.widthOverrides = {};
    this.layoutStore.reset();
    this.applyChange();
    this.emitVisibility();
    if (this.isOpen()) {
      this.renderList(this.refs.popup);
    }
  }
  /** Drop a now-unresolvable active cell, then hand relayout+repaint to GridCore. */
  applyChange() {
    const active = this.store.active;
    if (active && this.store.colIndexOf(active.colKey) < 0) {
      this.store.active = null;
      this.store.anchor = null;
      this.store.selection = null;
      this.store.bus.emit("active:changed", { active: null });
      this.store.bus.emit("selection:changed", { selection: null });
    }
    this.onChange();
  }
  emitVisibility() {
    this.refs.root.dispatchEvent(
      new CustomEvent("lgrid:column-visibility", {
        detail: { grid: this.store.name, hidden: [...this.store.userHidden] },
        bubbles: true
      })
    );
  }
  destroy() {
    if (this.button) {
      this.button.removeEventListener("pointerdown", this.onPointerDown);
      this.button.removeEventListener("click", this.onClick);
      this.button.removeEventListener("keydown", this.onKeydown);
      this.button.remove();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/HeaderFilters.js
var HeaderFilters = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {{head: HTMLElement, popup: HTMLElement}} refs
   * @param {import('../popup/PopupManager').default} popup
   * @param {import('../sync/PageSource').default} pageSource
   */
  constructor(store, refs, popup, pageSource) {
    this.store = store;
    this.refs = refs;
    this.popup = popup;
    this.pageSource = pageSource;
  }
  init() {
    this.onPointerDown = (e) => {
      const btn = e.target.closest(".lgrid-filter");
      if (!btn || !this.refs.head.contains(btn)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.openMenu(btn);
    };
    this.refs.head.addEventListener("pointerdown", this.onPointerDown, true);
  }
  /** The current query value for a filter key (undefined when unset). */
  currentValue(filterKey) {
    return (this.store.query && this.store.query.filters || {})[filterKey];
  }
  openMenu(btn) {
    const column = this.store.columnByKey(btn.dataset.col);
    const filter = column && column.filter;
    if (!filter) {
      return;
    }
    const container = this.popup.open({
      anchorEl: btn.closest(".lgrid-headcell") || btn,
      owner: "filter",
      className: "lgrid-popup--filter"
    });
    if (filter.kind === "ternary") {
      this.renderOptions(container, filter, [
        { value: "", label: "All" },
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" }
      ]);
    } else {
      const options = [{ value: "", label: "All" }];
      for (const [value, label] of Object.entries(filter.options || {})) {
        options.push({ value: String(value), label: String(label) });
      }
      this.renderOptions(container, filter, options);
    }
    this.popup.position();
  }
  /**
   * Render a one-pick option list: the current value is ticked; a pick sets the filter (''
   * clears it via PageSource) and closes the menu.
   * @param {HTMLElement} container
   * @param {object} filter the declarative {key, label, kind, options} fragment
   * @param {Array<{value: string, label: string}>} options
   */
  renderOptions(container, filter, options) {
    const current = this.currentValue(filter.key);
    const currentNormalised = current === void 0 || current === null ? "" : String(current);
    for (const option of options) {
      const row = document.createElement("div");
      row.className = "lgrid-popup-option";
      if (option.value === currentNormalised) {
        row.classList.add("lgrid-popup-option--active");
      }
      row.textContent = option.label;
      row.addEventListener("click", () => {
        this.pageSource.setFilter(filter.key, option.value);
        this.popup.close("owner");
      });
      container.appendChild(row);
    }
  }
  destroy() {
    if (this.onPointerDown) {
      this.refs.head.removeEventListener("pointerdown", this.onPointerDown, true);
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/render/Toolbar.js
var Toolbar = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {{toolbar: HTMLElement}} refs
   * @param {object|null} pageSource server-side driver (null on in-memory grids)
   * @param {Array<object>} filters the grid-level filter configs ({key, label, kind, options})
   */
  constructor(store, refs, pageSource, filters, bus = null, runner = null, actions = {}) {
    this.store = store;
    this.refs = refs;
    this.pageSource = pageSource;
    this.filters = Array.isArray(filters) ? filters : [];
    this.bus = bus;
    this.runner = runner;
    this.actions = actions || {};
    this.chooserSlot = null;
    this.searchTimer = null;
    this.offChecked = null;
  }
  /** Build the enabled controls; leaves the container hidden when nothing rendered. */
  render() {
    const spec = this.store.layout.toolbar;
    const host = this.refs.toolbar;
    if (!spec || !host) {
      return;
    }
    host.textContent = "";
    let any = false;
    if (spec.search && this.pageSource) {
      host.appendChild(this.buildSearch());
      any = true;
    }
    if (spec.filters && this.pageSource && this.filters.length) {
      for (const filter of this.filters) {
        host.appendChild(this.buildFilter(filter));
      }
      any = true;
    }
    if (this.runner && (this.actions.bulk || []).length) {
      this.bulkBar = el("span", "lgrid-toolbar-bulk");
      this.bulkBar.hidden = true;
      host.appendChild(this.bulkBar);
      if (this.bus) {
        this.offChecked = this.bus.on("checked:changed", () => this.renderBulkBar());
      }
      any = true;
    }
    if (this.runner && (this.actions.toolbar || []).length) {
      for (const meta of this.actions.toolbar) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lgrid-toolbar-btn";
        button.textContent = (meta.icon ? meta.icon + " " : "") + meta.label;
        button.addEventListener("click", () => this.runner.runToolbar(meta, button));
        host.appendChild(button);
      }
      any = true;
    }
    host.appendChild(el("div", "lgrid-toolbar-spacer"));
    if (spec.chooser) {
      this.chooserSlot = el("span", "lgrid-toolbar-chooser");
      host.appendChild(this.chooserSlot);
      any = true;
    }
    host.hidden = !any;
  }
  /** Debounced global search → PageSource.search (same channel as `lgrid:toolbar`). */
  buildSearch() {
    const input = document.createElement("input");
    input.type = "search";
    input.className = "lgrid-toolbar-search";
    input.placeholder = "Search\u2026";
    input.setAttribute("aria-label", "Search grid");
    input.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.pageSource.search(input.value), 300);
    });
    this.searchInput = input;
    return input;
  }
  /**
   * One declared filter as a labelled select — 'select' kind lists its options behind an
   * "All" blank; 'ternary' offers All/Yes/No. Changes route through PageSource.setFilter,
   * the same whitelisted server pipeline as the header funnels.
   */
  buildFilter(filter) {
    const wrap = el("label", "lgrid-toolbar-filter");
    wrap.appendChild(el("span", "lgrid-toolbar-filter-label", filter.label || filter.key));
    const select = document.createElement("select");
    select.className = "lgrid-toolbar-select";
    select.setAttribute("aria-label", filter.label || filter.key);
    const add = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    if (filter.kind === "ternary") {
      add("", "All");
      add("yes", "Yes");
      add("no", "No");
    } else {
      add("", "All");
      const raw = filter.options || {};
      const entries = Array.isArray(raw) ? raw.map((o) => o && typeof o === "object" ? [o.value, o.label] : [o, o]) : Object.entries(raw);
      for (const [value, label] of entries) {
        add(String(value), String(label));
      }
    }
    select.addEventListener("change", () => {
      this.pageSource.setFilter(filter.key, select.value === "" ? null : select.value);
    });
    wrap.appendChild(select);
    return wrap;
  }
  /** Repaint the bulk bar from the checked set. */
  renderBulkBar() {
    if (!this.bulkBar) {
      return;
    }
    const count = this.store.checked.size;
    this.bulkBar.hidden = count === 0;
    this.bulkBar.textContent = "";
    if (count === 0) {
      return;
    }
    this.bulkBar.appendChild(el("span", "lgrid-toolbar-bulk-count", count + " selected"));
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lgrid-toolbar-btn";
      b.textContent = label;
      b.addEventListener("click", fn);
      this.bulkBar.appendChild(b);
      return b;
    };
    mk("Select all", () => this.store.checkAll());
    mk("Clear", () => this.store.clearChecked());
    for (const meta of this.actions.bulk || []) {
      const b = mk((meta.icon ? meta.icon + " " : "") + meta.label, () => this.runner.runBulk(meta, b));
      b.classList.add("lgrid-toolbar-btn--bulk");
    }
  }
  destroy() {
    if (this.offChecked) {
      this.offChecked();
    }
    clearTimeout(this.searchTimer);
    if (this.refs.toolbar) {
      this.refs.toolbar.textContent = "";
      this.refs.toolbar.hidden = true;
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/interact/RowActivator.js
var RowActivator = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../render/Renderer').default} renderer
   * @param {import('../selection/SelectionManager').default} selection
   * @param {{root: HTMLElement, body: HTMLElement}} refs
   */
  constructor(store, renderer, selection, refs) {
    this.store = store;
    this.renderer = renderer;
    this.selection = selection;
    this.refs = refs;
    this.enabled = !!(store.layout && store.layout.rowActivate);
    this.onDblClick = this.handleDblClick.bind(this);
  }
  /** True once GridCore should route Enter here — i.e. a readonly, row-activate grid. */
  isEnabled() {
    return this.enabled;
  }
  init() {
    if (!this.enabled) {
      return;
    }
    this.refs.body.addEventListener("dblclick", this.onDblClick);
  }
  destroy() {
    this.refs.body.removeEventListener("dblclick", this.onDblClick);
  }
  /**
   * Double-click on a data cell → activate that row. Resolve the clicked row from the DOM (a
   * click on row padding / the header / empty space resolves to nothing and is ignored); pad
   * rows (Busy dedicated blanks) are inert. The click already set the active cell via
   * SelectionManager's pointerdown, so `activate()` reads the same row.
   */
  handleDblClick(e) {
    const cell = e.target.closest(".lgrid-cell");
    if (!cell || !this.refs.body.contains(cell)) {
      return;
    }
    const rowEl = cell.closest(".lgrid-row");
    if (!rowEl || rowEl.classList.contains("lgrid-row--pad")) {
      return;
    }
    this.activate(rowEl.dataset.k);
  }
  /**
   * Activate the given row key (or the active row when omitted — the Enter path): dispatch
   * `lgrid:activate` when that row carries a non-null `_activateUrl`. Returns true when an event
   * was dispatched, so KeyboardManager knows Enter was handled (else it falls through to the
   * keymap's move-down).
   *
   * @param {string} [rowKey]
   * @returns {boolean}
   */
  activate(rowKey) {
    if (!this.enabled) {
      return false;
    }
    const key = rowKey != null ? rowKey : this.store.active && this.store.active.rowKey;
    if (key == null) {
      return false;
    }
    const hit = this.store.rowByKey.get(key);
    const row = hit ? hit.row : null;
    const url = row ? row._activateUrl : null;
    if (!url) {
      return false;
    }
    this.refs.root.dispatchEvent(new CustomEvent("lgrid:activate", {
      bubbles: true,
      detail: { grid: this.store.name, row, url }
    }));
    return true;
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/interact/ActionRunner.js
var ActionRunner = class {
  /**
   * @param {import('../core/StateStore').default} store
   * @param {import('../render/Renderer').default} renderer
   * @param {import('../core/EventBus').default} bus
   * @param {{root: HTMLElement, body: HTMLElement}} refs
   * @param {{wire: object|null, popup: object|null, pageSource: object|null, sync: object|null, announcer: object|null, actions: object}} deps
   */
  constructor(store, renderer, bus, refs, deps) {
    this.store = store;
    this.renderer = renderer;
    this.bus = bus;
    this.refs = refs;
    this.deps = deps;
    this.actions = deps.actions || {};
    this.offs = [];
  }
  init() {
    this.onClick = (e) => {
      const button = e.target.closest(".lgrid-action");
      if (button && this.refs.body.contains(button)) {
        e.preventDefault();
        e.stopPropagation();
        this.runRow(button.dataset.action, button.dataset.row, button);
        return;
      }
      const selectCell = e.target.closest('.lgrid-cell[data-col="_select"]');
      if (selectCell && this.refs.body.contains(selectCell) && selectCell.dataset.row) {
        e.preventDefault();
        this.store.toggleChecked(selectCell.dataset.row);
      }
    };
    this.refs.body.addEventListener("click", this.onClick);
    this.offs.push(this.bus.on("checked:changed", () => this.paintChecked()));
    this.offs.push(this.bus.on("body:did-render", () => this.paintChecked()));
  }
  /** Reflect the checked set as cell classes on the selector gutter. */
  paintChecked() {
    for (const row of this.store.rows) {
      const cell = this.renderer.cellElFor(row._k, "_select");
      if (cell) {
        cell.classList.toggle("lgrid-cell--checked", this.store.checked.has(row._k));
      }
    }
  }
  /** Meta for a named row action. */
  rowMeta(name) {
    return (this.actions.row || []).find((a) => a.name === name) || null;
  }
  /** Run a row action from its button (or the menu): url → navigate, call → confirm + RPC. */
  runRow(name, rowKey, anchorEl) {
    const meta = this.rowMeta(name);
    const hit = this.store.rowByKey && this.store.rowByKey.get(rowKey);
    const bag = hit && hit.row._actions ? hit.row._actions : {};
    if (!meta || !(name in bag)) {
      return;
    }
    if (meta.kind === "url") {
      const url = bag[name];
      if (typeof url === "string" && url !== "") {
        window.location.assign(url);
      }
      return;
    }
    this.confirmThen(meta, anchorEl, () => this.call(name, [rowKey]));
  }
  /** Run a toolbar action (no row context). */
  runToolbar(meta, anchorEl) {
    if (meta.kind === "url") {
      if (typeof meta.url === "string" && meta.url !== "") {
        window.location.assign(meta.url);
      }
      return;
    }
    this.confirmThen(meta, anchorEl, () => this.call(meta.name, []));
  }
  /** Run a bulk action over the checked keys. */
  runBulk(meta, anchorEl) {
    const keys = [...this.store.checked];
    if (!keys.length) {
      return;
    }
    this.confirmThen(meta, anchorEl, () => this.call(meta.name, keys, { clearChecked: true }));
  }
  /** Show the action's confirm in the shared popup (Enter = confirm, Esc = cancel), else run now. */
  confirmThen(meta, anchorEl, run) {
    if (!meta.confirm || !this.deps.popup) {
      run();
      return;
    }
    const popup = this.deps.popup;
    const container = popup.open({
      anchorEl: anchorEl || this.refs.root,
      owner: "actions-confirm",
      className: "lgrid-popup--confirm",
      onRequestClose: () => popup.close("owner")
    });
    container.appendChild(el("div", "lgrid-confirm-text", meta.confirm));
    const bar = el("div", "lgrid-confirm-actions");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "lgrid-confirm-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => popup.close("owner"));
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "lgrid-confirm-btn lgrid-confirm-btn--primary";
    ok.textContent = meta.label || "Confirm";
    ok.addEventListener("click", () => {
      popup.close("owner");
      run();
    });
    bar.appendChild(cancel);
    bar.appendChild(ok);
    container.appendChild(bar);
    ok.focus();
  }
  /**
   * The gridAction RPC + follow-up: refetch the current page (readonly), adopt the reseed
   * payload (editable), announce refusals.
   */
  call(name, keys, opts = {}) {
    if (!this.deps.wire || typeof this.deps.wire.gridAction !== "function") {
      return Promise.resolve();
    }
    return this.deps.wire.gridAction(this.store.name, name, keys).then((response) => {
      const r = response || {};
      if (!r.ok) {
        this.announce(r.message || "Action refused.");
        return;
      }
      if (opts.clearChecked) {
        this.store.clearChecked();
      }
      if (r.refetch && this.deps.pageSource) {
        this.deps.pageSource.refresh();
      }
      if (Array.isArray(r.rows)) {
        if (this.deps.sync) {
          this.deps.sync.reset();
        }
        this.store.reseed(r.rows);
        this.bus.emit("footer:changed", { footer: r.footer || {} });
      }
    }).catch(() => {
      this.announce("Action failed.");
    });
  }
  /** The keyboard actions menu for the ACTIVE row (ContextMenu / Shift+F10). */
  openMenu() {
    const active = this.store.active;
    if (!active || !this.deps.popup) {
      return;
    }
    const hit = this.store.rowByKey.get(active.rowKey);
    const bag = hit && hit.row._actions ? hit.row._actions : {};
    const available = (this.actions.row || []).filter((meta) => meta.name in bag);
    if (!available.length) {
      return;
    }
    const anchor = this.renderer.cellElFor(active.rowKey, active.colKey) || this.refs.root;
    const popup = this.deps.popup;
    const container = popup.open({
      anchorEl: anchor,
      owner: "actions-menu",
      className: "lgrid-popup--actions",
      onRequestClose: () => popup.close("owner")
    });
    for (const meta of available) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "lgrid-popup-option";
      item.textContent = (meta.icon ? meta.icon + " " : "") + meta.label;
      item.addEventListener("click", () => {
        popup.close("owner");
        this.runRow(meta.name, active.rowKey, anchor);
      });
      container.appendChild(item);
    }
    const first = container.querySelector("button");
    if (first) {
      first.focus();
    }
  }
  announce(message) {
    if (this.deps.announcer) {
      this.deps.announcer.message(message);
    }
  }
  destroy() {
    if (this.onClick) {
      this.refs.body.removeEventListener("click", this.onClick);
    }
    for (const off of this.offs) {
      off();
    }
    this.offs = [];
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/editors/TextEditor.js
var TextEditor = class {
  /**
   * Build the input into the host element.
   * @param {HTMLElement} host the floating editor host (positioned by EditorManager)
   * @param {{column: object, initialText: string, caretAtEnd: boolean}} ctx
   */
  mount(host, ctx) {
    this.column = ctx.column;
    this.input = el("input", "lgrid-cell-editor-input");
    this.input.type = "text";
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    if (this.column.maxLength) {
      this.input.maxLength = this.column.maxLength;
    }
    if (this.column.align === "right") {
      this.input.classList.add("lgrid-cell-editor-input--right");
    }
    this.input.value = ctx.initialText != null ? String(ctx.initialText) : "";
    this.onInput = () => {
      const t = this.column.case;
      if (t === "upper") {
        this.setValuePreservingCaret(this.input.value.toUpperCase());
      } else if (t === "lower") {
        this.setValuePreservingCaret(this.input.value.toLowerCase());
      }
    };
    this.input.addEventListener("input", this.onInput);
    host.appendChild(this.input);
    this.focus(ctx.caretAtEnd);
  }
  /** Set the value while keeping the caret position (case transform doesn't jump the cursor). */
  setValuePreservingCaret(next) {
    const pos = this.input.selectionStart;
    this.input.value = next;
    this.input.setSelectionRange(pos, pos);
  }
  /** Focus the input; place the caret at the end (F2) or select-all (type-through replaces). */
  focus(caretAtEnd) {
    const place = () => {
      this.input.focus();
      if (caretAtEnd) {
        const len = this.input.value.length;
        this.input.setSelectionRange(len, len);
      } else {
        this.input.select();
      }
    };
    place();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (this.input && this.input.isConnected && document.activeElement !== this.input) {
          place();
        }
      });
    }
  }
  /** The raw typed text (the EditorManager parses it via the column's parse spec). */
  value() {
    return this.input.value;
  }
  /**
   * Editor-owned key policy: which nav keys the editor consumes vs. lets bubble to commit-and-move.
   * A text editor keeps Left/Right/Home/End for caret movement; arrows Up/Down commit-and-move.
   * @param {KeyboardEvent} e
   * @returns {'caret'|'commit-move'|null} 'caret' = editor keeps it; 'commit-move' = commit then move
   */
  keyPolicy(e) {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      return "caret";
    }
    if (["ArrowUp", "ArrowDown"].includes(e.key)) {
      return "commit-move";
    }
    return null;
  }
  destroy() {
    if (this.input) {
      this.input.removeEventListener("input", this.onInput);
      this.input.remove();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/editors/NumberEditor.js
var NumberEditor = class {
  /**
   * @param {HTMLElement} host
   * @param {{column: object, initialText: string, caretAtEnd: boolean}} ctx
   */
  mount(host, ctx) {
    this.column = ctx.column;
    this.input = el("input", "lgrid-cell-editor-input lgrid-cell-editor-input--right");
    this.input.type = "text";
    this.input.inputMode = "decimal";
    this.input.setAttribute("autocomplete", "off");
    this.input.value = ctx.initialText != null ? String(ctx.initialText) : "";
    this.onBeforeInput = (e) => {
      if (e.data == null) {
        return;
      }
      if (!/^[0-9.,\-]+$/.test(e.data)) {
        e.preventDefault();
      }
    };
    this.input.addEventListener("beforeinput", this.onBeforeInput);
    host.appendChild(this.input);
    this.focus(ctx.caretAtEnd);
  }
  focus(caretAtEnd) {
    const place = () => {
      this.input.focus();
      if (caretAtEnd) {
        const len = this.input.value.length;
        this.input.setSelectionRange(len, len);
      } else {
        this.input.select();
      }
    };
    place();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (this.input && this.input.isConnected && document.activeElement !== this.input) {
          place();
        }
      });
    }
  }
  value() {
    return this.input.value;
  }
  /**
   * A number editor keeps no caret navigation: all arrows commit-and-move (Excel parity).
   * @param {KeyboardEvent} e
   * @returns {'caret'|'commit-move'|null}
   */
  keyPolicy(e) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      return "commit-move";
    }
    return null;
  }
  destroy() {
    if (this.input) {
      this.input.removeEventListener("beforeinput", this.onBeforeInput);
      this.input.remove();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/endOfList.js
var END_OF_LIST_VALUE = "__lgrid_end_of_list__";
function endOfListOption(label) {
  return { value: END_OF_LIST_VALUE, label, __endOfList: true };
}
function isEndOfListOption(option) {
  return !!(option && option.__endOfList === true);
}

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/editors/SelectEditor.js
var SelectEditor = class {
  /**
   * @param {HTMLElement} host
   * @param {object} ctx the EditorManager mount context (column/row/popup/requestCommit/…)
   */
  mount(host, ctx) {
    this.ctx = ctx;
    this.options = ctx.column.options || [];
    this.chosen = null;
    this.original = ctx.row[ctx.column.key];
    this.endOfList = ctx.endOfListLabel ? endOfListOption(ctx.endOfListLabel) : null;
    this.input = el("input", "lgrid-cell-editor-input");
    this.input.type = "text";
    this.input.setAttribute("autocomplete", "off");
    this.input.placeholder = "";
    this.input.value = ctx.seed != null ? String(ctx.seed) : "";
    this.onInput = () => this.applyFilter(this.input.value);
    this.input.addEventListener("input", this.onInput);
    host.appendChild(this.input);
    this.openList();
    this.applyFilter(this.input.value);
    this.focus(true);
  }
  /** Open (own) the grid popup under the cell. */
  openList() {
    this.popupEl = this.ctx.popup.open({
      anchorEl: this.ctx.cellEl,
      owner: "select:" + this.ctx.column.key,
      // An outside/scroll close leaves the editor itself open; blur handles the rest.
      onRequestClose: () => {
        this.popupEl = null;
      }
    });
    this.onPick = (e) => {
      const row = e.target.closest(".lgrid-popup-option");
      if (row && this.popupEl && this.popupEl.contains(row)) {
        if (this.pickIndex(Number(row.dataset.index))) {
          this.ctx.requestCommit({ advance: null });
        }
      }
    };
    this.popupEl.addEventListener("click", this.onPick);
  }
  /** Filter the embedded list (contains, case-insensitive) and repaint the popup. */
  applyFilter(term) {
    const needle = String(term || "").trim().toLowerCase();
    const data = needle === "" ? this.options.slice() : this.options.filter((o) => o.label.toLowerCase().includes(needle));
    this.filtered = this.endOfList ? [this.endOfList, ...data] : data;
    this.highlight = 0;
    if (needle === "" && this.original != null) {
      const at = this.filtered.findIndex((o) => !isEndOfListOption(o) && String(o.value) === String(this.original));
      this.highlight = at >= 0 ? at : 0;
    }
    this.renderList();
  }
  renderList() {
    if (!this.popupEl) {
      return;
    }
    this.popupEl.textContent = "";
    if (this.filtered.length === 0) {
      const empty = el("div", "lgrid-popup-empty");
      setText(empty, "No matches");
      this.popupEl.appendChild(empty);
    } else {
      this.filtered.forEach((option, index) => {
        let cls = "lgrid-popup-option";
        if (index === this.highlight) {
          cls += " lgrid-popup-option--active";
        }
        if (isEndOfListOption(option)) {
          cls += " lgrid-popup-option--end-of-list";
        }
        const row = el("div", cls);
        row.dataset.index = String(index);
        setText(row, option.label);
        this.popupEl.appendChild(row);
      });
    }
    this.ctx.popup.position();
    this.scrollHighlightIntoView();
  }
  scrollHighlightIntoView() {
    if (!this.popupEl) {
      return;
    }
    const active = this.popupEl.querySelector(".lgrid-popup-option--active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }
  moveHighlight(delta) {
    if (this.filtered.length === 0) {
      return;
    }
    this.highlight = Math.max(0, Math.min(this.filtered.length - 1, this.highlight + delta));
    this.renderList();
  }
  /**
   * Act on the option at a filtered index. The exit sentinel fires the end-of-list escape and
   * returns false (no value staged, caller must NOT commit); a real option stages value + label
   * and returns true (caller commits).
   *
   * @returns {boolean} true when a value was staged and the caller should commit.
   */
  pickIndex(index) {
    const option = this.filtered[index];
    if (!option) {
      return false;
    }
    if (isEndOfListOption(option)) {
      this.ctx.endOfList();
      return false;
    }
    this.chosen = option.value;
    this.ctx.setLabel(option.label);
    return true;
  }
  /**
   * First-refusal key handling while the list is open (EditorManager consults this before its
   * own routing — the POPUP state of §2.6). Returns true when consumed.
   * @param {KeyboardEvent} e
   */
  handleKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.moveHighlight(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.filtered.length === 0) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!this.pickIndex(this.highlight)) {
        return true;
      }
      const advance = e.key === "Tab" ? e.shiftKey ? "prev" : "next" : e.shiftKey ? "enterBack" : "enter";
      this.ctx.requestCommit({ advance });
      return true;
    }
    return false;
  }
  focus(caretAtEnd) {
    const place = () => {
      this.input.focus();
      if (caretAtEnd) {
        const len = this.input.value.length;
        this.input.setSelectionRange(len, len);
      } else {
        this.input.select();
      }
    };
    place();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (this.input && this.input.isConnected && document.activeElement !== this.input) {
          place();
        }
      });
    }
  }
  /** The committed value: the picked id, else the cell's original value (typed text discarded). */
  value() {
    return this.chosen !== null ? this.chosen : this.original;
  }
  destroy() {
    if (this.popupEl) {
      this.popupEl.removeEventListener("click", this.onPick);
    }
    if (this.input) {
      this.input.removeEventListener("input", this.onInput);
      this.input.remove();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/editors/SearchSelectEditor.js
var SearchSelectEditor = class {
  /**
   * @param {HTMLElement} host
   * @param {object} ctx the EditorManager mount context (column/row/popup/searchOptions/…)
   */
  mount(host, ctx) {
    this.ctx = ctx;
    this.serverMode = ctx.column.optionsMode !== "client";
    this.embedded = ctx.column.options || [];
    this.minChars = Math.max(0, Number(ctx.column.minChars) || 0);
    this.debounceMs = Math.max(0, Number(ctx.column.debounceMs) || 0);
    this.chosen = null;
    this.original = ctx.row[ctx.column.key];
    this.results = [];
    this.highlight = 0;
    this.seq = 0;
    this.endOfList = ctx.endOfListLabel ? endOfListOption(ctx.endOfListLabel) : null;
    this.input = el("input", "lgrid-cell-editor-input");
    this.input.type = "text";
    this.input.setAttribute("autocomplete", "off");
    this.input.value = ctx.seed != null ? String(ctx.seed) : "";
    this.onInput = () => this.queueSearch(this.input.value);
    this.input.addEventListener("input", this.onInput);
    host.appendChild(this.input);
    this.openList();
    this.queueSearch(this.input.value, { immediate: true });
    this.focus(true);
  }
  openList() {
    this.popupEl = this.ctx.popup.open({
      anchorEl: this.ctx.cellEl,
      owner: "searchselect:" + this.ctx.column.key,
      onRequestClose: () => {
        this.popupEl = null;
      }
    });
    this.onPick = (e) => {
      const row = e.target.closest(".lgrid-popup-option");
      if (row && this.popupEl && this.popupEl.contains(row)) {
        if (this.pickIndex(Number(row.dataset.index))) {
          this.ctx.requestCommit({ advance: null });
        }
      }
    };
    this.popupEl.addEventListener("click", this.onPick);
  }
  /** Debounce a term change; below minChars shows the type-to-search hint instead. */
  queueSearch(term, opts = {}) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const text = String(term || "").trim();
    if (text.length < this.minChars) {
      this.seq++;
      this.results = [];
      this.highlight = 0;
      this.renderHint(this.minChars > 0 ? "Type to search\u2026" : "No options");
      return;
    }
    const run = () => this.runSearch(text);
    if (opts.immediate || this.debounceMs === 0) {
      run();
    } else {
      this.timer = setTimeout(run, this.debounceMs);
    }
  }
  runSearch(term) {
    const mySeq = ++this.seq;
    this.termIsEmpty = String(term || "").trim() === "";
    if (!this.serverMode) {
      const needle = term.toLowerCase();
      this.adoptResults(mySeq, this.embedded.filter(
        (o) => needle === "" || o.label.toLowerCase().includes(needle)
      ));
      return;
    }
    this.setLoading(true);
    this.ctx.searchOptions(term).then((options) => this.adoptResults(mySeq, options)).catch(() => {
      if (mySeq === this.seq) {
        this.setLoading(false);
        this.renderHint("Search failed \u2014 try again");
      }
    });
  }
  /** Apply results only if they answer the LATEST term (stale replies are discarded). */
  adoptResults(mySeq, options) {
    if (mySeq !== this.seq) {
      return;
    }
    this.setLoading(false);
    this.results = options || [];
    const typedWithResults = !this.termIsEmpty && this.results.length > 0;
    this.highlight = this.endOfList && typedWithResults ? 1 : 0;
    this.renderList();
  }
  setLoading(on) {
    if (this.popupEl) {
      this.popupEl.classList.toggle("lgrid-popup--loading", !!on);
    }
    if (on && this.popupEl && this.results.length === 0) {
      this.popupEl.textContent = "";
      const row = el("div", "lgrid-popup-loading");
      setText(row, "Searching\u2026");
      this.popupEl.appendChild(row);
      this.ctx.popup.position();
    }
  }
  renderHint(message) {
    if (!this.popupEl) {
      return;
    }
    this.popupEl.textContent = "";
    if (this.endOfList) {
      const cls = "lgrid-popup-option lgrid-popup-option--end-of-list" + (this.highlight === 0 ? " lgrid-popup-option--active" : "");
      const row = el("div", cls);
      row.dataset.index = "0";
      setText(row, this.endOfList.label);
      this.popupEl.appendChild(row);
    }
    const hint = el("div", "lgrid-popup-hint");
    setText(hint, message);
    this.popupEl.appendChild(hint);
    this.ctx.popup.position();
  }
  /**
   * The full rendered/pickable list: the pinned exit option (when eligible) followed by the
   * search results. The single list every index (highlight, pickIndex, handleKey) refers to, so
   * the sentinel and the results share one coordinate space.
   */
  rendered() {
    return this.endOfList ? [this.endOfList, ...this.results] : this.results;
  }
  renderList() {
    if (!this.popupEl) {
      return;
    }
    this.popupEl.textContent = "";
    const rendered = this.rendered();
    if (rendered.length === 0) {
      const empty = el("div", "lgrid-popup-empty");
      setText(empty, "No matches");
      this.popupEl.appendChild(empty);
    } else {
      rendered.forEach((option, index) => {
        let cls = "lgrid-popup-option";
        if (index === this.highlight) {
          cls += " lgrid-popup-option--active";
        }
        if (isEndOfListOption(option)) {
          cls += " lgrid-popup-option--end-of-list";
        }
        const row = el("div", cls);
        row.dataset.index = String(index);
        setText(row, option.label);
        this.popupEl.appendChild(row);
      });
    }
    this.ctx.popup.position();
    const active = this.popupEl.querySelector(".lgrid-popup-option--active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }
  moveHighlight(delta) {
    const count = this.rendered().length;
    if (count === 0) {
      return;
    }
    this.highlight = Math.max(0, Math.min(count - 1, this.highlight + delta));
    this.renderList();
  }
  /**
   * Act on the rendered option at an index. The exit sentinel fires the end-of-list escape and
   * returns false (no value staged, caller must NOT commit); a real result stages value + label
   * and returns true (caller commits).
   *
   * @returns {boolean} true when a value was staged and the caller should commit.
   */
  pickIndex(index) {
    const option = this.rendered()[index];
    if (!option) {
      return false;
    }
    if (isEndOfListOption(option)) {
      this.ctx.endOfList();
      return false;
    }
    this.chosen = option.value;
    this.ctx.setLabel(option.label);
    return true;
  }
  /**
   * First-refusal key handling (EditorManager consults before its own routing — §2.6 POPUP).
   * @param {KeyboardEvent} e
   */
  handleKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.moveHighlight(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.rendered().length === 0) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!this.pickIndex(this.highlight)) {
        return true;
      }
      const advance = e.key === "Tab" ? e.shiftKey ? "prev" : "next" : e.shiftKey ? "enterBack" : "enter";
      this.ctx.requestCommit({ advance });
      return true;
    }
    return false;
  }
  focus(caretAtEnd) {
    const place = () => {
      this.input.focus();
      if (caretAtEnd) {
        const len = this.input.value.length;
        this.input.setSelectionRange(len, len);
      } else {
        this.input.select();
      }
    };
    place();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (this.input && this.input.isConnected && document.activeElement !== this.input) {
          place();
        }
      });
    }
  }
  /** The committed value: the picked id, else the original (a typed term is never a value). */
  value() {
    return this.chosen !== null ? this.chosen : this.original;
  }
  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.seq++;
    if (this.popupEl) {
      this.popupEl.removeEventListener("click", this.onPick);
    }
    if (this.input) {
      this.input.removeEventListener("input", this.onInput);
      this.input.remove();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/editors/DateEditor.js
var DateEditor = class {
  /**
   * @param {HTMLElement} host
   * @param {{column: object, initialText: string, caretAtEnd: boolean}} ctx
   */
  mount(host, ctx) {
    this.column = ctx.column;
    this.input = el("input", "lgrid-cell-editor-input");
    this.input.type = "text";
    this.input.inputMode = "numeric";
    this.input.setAttribute("autocomplete", "off");
    this.input.placeholder = "dd-mm-yyyy";
    this.input.value = ctx.initialText != null ? String(ctx.initialText) : "";
    this.onBeforeInput = (e) => {
      if (e.data == null) {
        return;
      }
      if (!/^[0-9/.\- ]+$/.test(e.data)) {
        e.preventDefault();
      }
    };
    this.input.addEventListener("beforeinput", this.onBeforeInput);
    host.appendChild(this.input);
    this.focus(ctx.caretAtEnd);
  }
  focus(caretAtEnd) {
    const place = () => {
      this.input.focus();
      if (caretAtEnd) {
        const len = this.input.value.length;
        this.input.setSelectionRange(len, len);
      } else {
        this.input.select();
      }
    };
    place();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (this.input && this.input.isConnected && document.activeElement !== this.input) {
          place();
        }
      });
    }
  }
  value() {
    return this.input.value;
  }
  /**
   * Up/Down commit-and-move; Left/Right stay with the caret (mid-string date edits).
   * @param {KeyboardEvent} e
   * @returns {'caret'|'commit-move'|null}
   */
  keyPolicy(e) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      return "commit-move";
    }
    return null;
  }
  destroy() {
    if (this.input) {
      this.input.removeEventListener("beforeinput", this.onBeforeInput);
      this.input.remove();
    }
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/editors/CheckboxInline.js
var CheckboxInline = class {
  /* The class is never instantiated — EditorManager short-circuits on `instant`. The stubs
     document the editor contract for anyone extending from this file. */
  mount() {
  }
  value() {
    return null;
  }
  destroy() {
  }
};
/** Marks the editor as an in-place toggle: open() flips the value instead of mounting. */
__publicField(CheckboxInline, "instant", true);

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/edit/builtin.js
registerEditor("text", TextEditor);
registerEditor("number", NumberEditor);
registerEditor("select", SelectEditor);
registerEditor("searchselect", SearchSelectEditor);
registerEditor("date", DateEditor);
registerEditor("checkbox", CheckboxInline);

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/core/GridCore.js
var GridCore = class {
  /**
   * @param {object} config the @js() config from ConfigSerializer
   * @param {{root: HTMLElement, scroll: HTMLElement, head: HTMLElement, body: HTMLElement, footer: HTMLElement, announcer?: HTMLElement, statusbar?: HTMLElement}} refs
   */
  constructor(config, refs) {
    this.config = config || {};
    this.refs = refs;
    this.bus = new EventBus();
    this.store = new StateStore(this.config, this.bus);
  }
  /**
   * Build layout + renderer + interaction and paint. Called by the boot module once the
   * mount's child refs are in the DOM.
   */
  init() {
    const initT0 = typeof performance !== "undefined" ? performance.now() : 0;
    this.layoutStore = new LayoutStore(this.store.layout.persist || null);
    const savedLayout = this.layoutStore.load(this.store.columns.map((c) => c.key));
    if (savedLayout) {
      this.store.widthOverrides = savedLayout.widths;
      this.store.userHidden = new Set(savedLayout.hidden);
    }
    this.applySizing();
    this.layout = new Layout(this.store, this.refs);
    this.layout.apply();
    this.renderer = new Renderer(this.store, this.layout, this.refs, this.bus);
    this.renderer.paint();
    this.setAriaGrid();
    this.selection = new SelectionManager(this.store, this.refs);
    this.painter = new SelectionPainter(this.store, this.renderer, this.bus, this.refs);
    this.announcer = this.refs.announcer ? new Announcer(this.store, this.bus, this.refs.announcer) : null;
    this.clipboard = new ClipboardManager(this.store, {
      announce: (msg) => this.announcer && this.announcer.message(msg)
    });
    this.statusBar = this.store.layout.statusBar && this.refs.statusbar ? new StatusBar(this.store, this.bus, this.refs.statusbar) : null;
    this.popupManager = this.refs.popup ? new PopupManager(this.refs) : null;
    this.installEditing();
    this.rowActivator = new RowActivator(this.store, this.renderer, this.selection, this.refs);
    this.rowActivator.init();
    this.keyboard = new KeyboardManager(this.store, this.selection, this.refs, {
      actionsMenu: () => this.actionRunner && this.actionRunner.openMenu(),
      onCopy: () => this.clipboard.copy(),
      editor: this.editorManager || null,
      rowOps: this.rowOps || null,
      onRequiredBlock: (addr) => this.flashRequiredCell(addr),
      onComplete: () => this.dispatchComplete(),
      rowActivate: this.rowActivator.isEnabled() ? () => this.rowActivator.activate() : null
    });
    this.offComplete = this.bus.on("grid:complete", () => this.dispatchComplete());
    this.pendingPanelAdvance = null;
    this.offPanel = this.bus.on("grid:panel", (d) => this.dispatchPanel(d));
    this.selection.init();
    this.keyboard.init();
    this.installFocusBehaviors();
    this.offRolledBack = this.bus.on("rows:rolled-back", ({ message }) => {
      if (this.announcer) {
        this.announcer.message(message);
      }
    });
    this.resizeManager = new ResizeManager(this.store, this.layout, this.refs, this.bus, this.layoutStore);
    this.resizeManager.init();
    this.installServerData();
    this.installToolbar();
    this.installReseed();
    this.offEmptyState = this.bus.on("rows:changed", () => this.renderEmptyState());
    this.renderEmptyState();
    this.installMorphGuard();
    this.initMs = typeof performance !== "undefined" ? performance.now() - initT0 : 0;
  }
  /**
   * Build the readonly server-data layer for a server-side grid: PageSource (the RPC/cache/stale
   * driver), the sort-click listener on header sort controls, the pagination chrome, and the
   * loading/empty state wiring. All optional refs absent → no-op.
   */
  installServerData() {
    if (!this.store.serverSide || !this.refs.wire) {
      return;
    }
    this.pageSource = new PageSource(this.store, this.bus, this.refs.wire);
    this.onSortClick = (e) => {
      const sortBtn = e.target.closest(".lgrid-sort");
      if (sortBtn && this.refs.head.contains(sortBtn)) {
        e.preventDefault();
        e.stopPropagation();
        this.pageSource.sort(sortBtn.dataset.sort);
      }
    };
    this.refs.head.addEventListener("pointerdown", this.onSortClick, true);
    if (this.refs.pagination) {
      this.pagination = new PaginationBar(this.store, this.bus, this.pageSource, this.refs.pagination);
      this.pagination.render();
    }
    if (this.popupManager) {
      this.headerFilters = new HeaderFilters(this.store, this.refs, this.popupManager, this.pageSource);
      this.headerFilters.init();
    }
    this.bus.on("loading:changed", ({ loading }) => this.setLoading(loading));
    this.bus.on("fetch:error", ({ error }) => {
      if (this.announcer) {
        this.announcer.message("Failed to load rows.");
      }
      console.error("[laragrid:" + this.store.name + "] gridFetch failed:", error);
    });
    this.onToolbar = (e) => {
      const d = e.detail || {};
      if (d.grid !== this.store.name) {
        return;
      }
      if (d.kind === "search") {
        this.pageSource.search(d.value);
      } else if (d.kind === "filter") {
        this.pageSource.setFilter(d.key, d.value);
      } else if (d.kind === "perPage") {
        this.pageSource.setPerPage(Number(d.value));
      }
    };
    document.addEventListener("lgrid:toolbar", this.onToolbar);
  }
  /**
   * Build the editing layer for an editable grid: the SyncManager (op queue), the ClientValidator,
   * the EditorManager (floating editor + EDIT state machine), the ErrorPainter, and the row-op
   * handlers the KeyboardManager routes Insert/Delete/Ctrl+D to. All gated on an editable grid
   * with a live $wire — otherwise a no-op (in-memory display + readonly grids never construct it).
   */
  installEditing() {
    if (!this.store.editable || !this.refs.wire || !this.refs.editor) {
      return;
    }
    this.sync = new SyncManager(this.store, this.bus, this.refs.wire);
    this.validator = new ClientValidator();
    const wire = this.refs.wire;
    const picker = {
      popup: this.popupManager,
      // The RPC returns an {options: [...]} envelope; editors consume the bare list.
      search: (colKey, term, row) => wire.gridOptions(this.store.name, colKey, term, row).then((response) => response && response.options || [])
    };
    this.editorManager = new EditorManager(
      this.store,
      this.renderer,
      this.selection,
      this.sync,
      this.validator,
      this.bus,
      this.refs,
      picker
    );
    this.errorPainter = new ErrorPainter(this.store, this.renderer, this.bus, this.refs);
    this.onDblClick = (e) => {
      const cell = e.target.closest(".lgrid-cell");
      if (cell && this.refs.body.contains(cell) && !cell.closest(".lgrid-row--pad")) {
        this.editorManager.open({ caretAtEnd: true });
      }
    };
    this.refs.body.addEventListener("dblclick", this.onDblClick);
    this.onPaste = (e) => {
      if (this.editorManager.isEditing()) {
        return;
      }
      const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      if (!text) {
        return;
      }
      e.preventDefault();
      this.clipboard.paste(text, {
        editor: this.editorManager,
        sync: this.sync,
        popup: this.popupManager,
        anchorCellEl: () => {
          const active = this.store.active;
          return active ? this.renderer.cellElFor(active.rowKey, active.colKey) : null;
        }
      });
    };
    this.refs.root.addEventListener("paste", this.onPaste);
    this.offActiveRow = this.bus.on("active:changed", () => this.onActiveCellChanged());
    this.lastActiveRow = null;
    this.rowOps = {
      insert: () => this.rowInsert(),
      delete: () => this.rowDelete(),
      fillDown: () => this.rowFillDown(),
      clear: () => this.clearSelectedCells()
    };
    this.offFooter = this.bus.on("footer:changed", ({ footer }) => this.applyFooter(footer));
    this.onPanelDone = (e) => {
      const d = e.detail || {};
      if (d.grid !== this.store.name) {
        return;
      }
      this.resumeAfterPanel();
    };
    window.addEventListener("lgrid:panel-done", this.onPanelDone);
  }
  /**
   * Apply the declarative sizing chains (P6): ->height() fixes the root box (flex mode so the
   * pagination/status chrome keeps its place), ->maxHeight() re-caps the scroll box via the
   * --lgrid-max-h token, ->fillParent() fills a sized ancestor.
   */
  applySizing() {
    const sizing = this.store.layout.sizing;
    if (!sizing) {
      return;
    }
    if (sizing.height) {
      this.refs.root.style.height = sizing.height;
      this.refs.root.classList.add("lgrid--fill");
    }
    if (sizing.maxHeight && this.refs.scroll) {
      this.refs.scroll.style.setProperty("--lgrid-max-h", sizing.maxHeight);
    }
    if (sizing.fill) {
      this.refs.root.classList.add("lgrid--fill");
    }
  }
  /**
   * Build the package toolbar (P6) from layout.toolbar, then the column chooser — into the
   * toolbar's slot when it rendered one, else floating on the root (the pre-toolbar layout).
   */
  installToolbar() {
    if (this.config.actions) {
      this.actionRunner = new ActionRunner(this.store, this.renderer, this.bus, this.refs, {
        wire: this.refs.wire || null,
        popup: this.popupManager,
        pageSource: this.pageSource || null,
        sync: this.sync || null,
        announcer: this.announcer,
        actions: this.config.actions
      });
      this.actionRunner.init();
    }
    const spec = this.store.layout.toolbar;
    if (spec && this.refs.toolbar) {
      this.toolbar = new Toolbar(
        this.store,
        this.refs,
        this.pageSource || null,
        this.config.filters || [],
        this.bus,
        this.actionRunner || null,
        this.config.actions || {}
      );
      this.toolbar.render();
    }
    if (this.popupManager) {
      this.columnChooser = new ColumnChooser(this.store, this.refs, this.popupManager, this.layoutStore, {
        onChange: () => this.onColumnLayoutChanged(),
        container: this.toolbar && this.toolbar.chooserSlot || null
      });
      if (!spec || spec.chooser) {
        this.columnChooser.init();
      }
    }
  }
  /**
   * The declarative focus chains (P6): ->focusOnMount() activates the first cell now;
   * ->focusOutTo() intercepts forward-Tab at the LAST navigable cell and sends focus to the
   * host's selector instead of the browser's natural next element. onCompleteFocus rides
   * dispatchComplete(); the reseed focus-return lives in installReseed.
   */
  installFocusBehaviors() {
    const focus = this.store.layout.focus || {};
    if (focus.onMount) {
      requestAnimationFrame(() => {
        this.selection.ensureActive();
        this.refs.root.focus();
      });
    }
    if (focus.outTo) {
      this.onFocusOutKey = (e) => {
        if (e.key !== "Tab" || e.shiftKey || e.defaultPrevented) {
          return;
        }
        if (this.editorManager && this.editorManager.isEditing()) {
          return;
        }
        if (this.isAtLastNavigableCell()) {
          e.preventDefault();
          this.focusSelector(focus.outTo);
        }
      };
      this.refs.root.addEventListener("keydown", this.onFocusOutKey);
    }
  }
  /** Whether the active cell is the grid's last navigable cell (Tab would escape). */
  isAtLastNavigableCell() {
    const active = this.store.active;
    if (!active) {
      return false;
    }
    const rows = this.store.rowCount();
    const lastRow = rows > 0 ? this.store.rowAt(rows - 1) : null;
    if (!lastRow || lastRow._k !== active.rowKey) {
      return false;
    }
    const columns = this.store.visibleColumns().filter((c) => c.navigable !== false);
    const last = columns[columns.length - 1];
    return !!last && last.key === active.colKey;
  }
  /** Focus a host selector, retrying briefly (a button may re-enable a tick later). */
  focusSelector(selector, tries = 40) {
    const target = document.querySelector(selector);
    if (target && !target.disabled) {
      target.focus();
      return;
    }
    if (tries > 0) {
      setTimeout(() => this.focusSelector(selector, tries - 1), 50);
    }
  }
  /**
   * Clear the selected (or active) editable, unlocked cells — the Excel Delete (P6). Each
   * cell runs the shared paste pipeline with an empty value (parse → validate → optimistic
   * store write), then the whole clear flushes as ONE batch.
   */
  clearSelectedCells() {
    if (!this.editorManager || !this.sync) {
      return;
    }
    const cells = this.store.selectedCells();
    const items = [];
    let cleared = 0;
    for (const { rowKey, colKey } of cells) {
      const column = this.store.columnByKey(colKey);
      if (!column || !column.editable || this.store.cellLocked(rowKey, colKey)) {
        continue;
      }
      const result = this.editorManager.pasteCell(rowKey, colKey, column, "");
      if (result.ok && result.op) {
        items.push({ op: result.op, cells: result.cells || [] });
        cleared += 1;
      }
    }
    if (items.length) {
      this.sync.enqueueBatch(items);
    }
    if (this.announcer && cleared) {
      this.announcer.message(cleared === 1 ? "Cell cleared." : cleared + " cells cleared.");
    }
  }
  /**
   * Host→client reseed — EVERY mode (P5). The host mutated its rows outside the op protocol
   * (an editable save() exit path, or a display grid's data source changing) and dispatched
   * `lgrid:reseed` {grid, rows, footer} (a Livewire dispatch(), so it fires on WINDOW).
   * Close the editor/popup first (they hold cell references into the old rows), drop the op
   * queue (a reseed supersedes the rows those ops describe), then replace the store's rows
   * wholesale and repaint the footer totals — the editing-only managers are simply absent on
   * a display grid, hence the guards.
   */
  installReseed() {
    this.onReseed = (e) => {
      const d = e.detail || {};
      if (d.grid !== this.store.name || !Array.isArray(d.rows)) {
        return;
      }
      const hadFocus = this.refs.root.contains(document.activeElement);
      if (this.editorManager && this.editorManager.isEditing()) {
        this.editorManager.cancel();
      }
      if (this.popupManager && this.popupManager.isOpen()) {
        this.popupManager.close("owner");
      }
      if (this.sync) {
        this.sync.reset();
      }
      this.store.reseed(d.rows);
      this.applyFooter(d.footer || {});
      if (hadFocus) {
        this.refs.root.focus();
      }
    };
    window.addEventListener("lgrid:reseed", this.onReseed);
  }
  /**
   * Announce the complete-guard firing to the host: a bubbling `lgrid:complete` CustomEvent
   * from the grid root ({grid} detail, so a page with several grids can discriminate). The
   * grid keeps its active cell — whether focus leaves (and to where) is the host's decision.
   */
  dispatchComplete() {
    this.refs.root.dispatchEvent(new CustomEvent("lgrid:complete", {
      bubbles: true,
      detail: { grid: this.store.name }
    }));
    const focus = this.store.layout.focus || {};
    if (focus.complete) {
      this.focusSelector(focus.complete);
    }
  }
  /**
   * Hand this cell's forward advance off to a HOST panel (a column's opensPanel). Stash the
   * deferred advance, then announce it to the host as a bubbling `lgrid:panel` CustomEvent
   * ({grid, panel, rowKey} detail, so a page with several grids/panels can discriminate). The
   * host opens its modal and resumes the grid via `lgrid:panel-done`; the advance runs then. The
   * grid keeps its active cell in the meantime, so the resume lands the cursor correctly.
   *
   * @param {{panel: string, rowKey: string, advance: string}} d
   */
  dispatchPanel(d) {
    this.pendingPanelAdvance = d.advance;
    this.refs.root.dispatchEvent(new CustomEvent("lgrid:panel", {
      bubbles: true,
      detail: { grid: this.store.name, panel: d.panel, rowKey: d.rowKey }
    }));
  }
  /**
   * Resume the grid after a host panel closes (`lgrid:panel-done` for THIS grid): re-focus the
   * grid root (so NAV keys resume) and run the advance the panel deferred. Always advances — the
   * panel's fields are optional, so a cancel (Esc / click-away) still moves the cursor forward,
   * exactly as the plain Enter would have. A no-op if nothing was pending (defensive).
   */
  resumeAfterPanel() {
    const advance = this.pendingPanelAdvance;
    this.pendingPanelAdvance = null;
    this.refs.root.focus();
    if (advance && this.editorManager) {
      this.editorManager.advance(advance);
    }
  }
  /**
   * The single relayout path after an operator column-layout change (hide/show, reset):
   * geometry (template var + frozen offsets + modifier classes), a full repaint (visibility
   * is structural — header/body/footer all change shape), and the ARIA counts.
   */
  onColumnLayoutChanged() {
    this.layout.apply();
    this.renderer.paint();
    this.setAriaGrid();
  }
  /** Under PerRow sync, flush the queue when the active cell moves to a different row. */
  onActiveCellChanged() {
    const active = this.store.active;
    const row = active ? active.rowKey : null;
    if (this.lastActiveRow !== null && row !== this.lastActiveRow && this.sync) {
      this.sync.onActiveRowChanged();
    }
    this.lastActiveRow = row;
  }
  /** Insert a blank row after the active row (Insert key). */
  rowInsert() {
    const after = this.store.active ? this.store.active.rowKey : null;
    const newKey = "r" + this.store.nextSeq() + Math.random().toString(36).slice(2, 6);
    this.store.insertRow(newKey, after);
    this.sync.enqueue(
      { seq: this.store.nextSeq(), t: "insert", after, as: newKey },
      [],
      { flush: true }
    );
  }
  /** Delete the active row (Shift+Delete / F7) — pre-checked against minRows (P6). */
  rowDelete() {
    const active = this.store.active;
    if (!active) {
      return;
    }
    const rowKey = active.rowKey;
    const minRows = this.store.layout.minRows || 0;
    if (minRows > 0) {
      const blankTarget = this.store.rowIsBlankByKey(rowKey);
      const remaining = this.store.nonBlankRowCount() - (blankTarget ? 0 : 1);
      if (remaining < minRows) {
        if (this.announcer) {
          this.announcer.message("At least " + minRows + " line(s) required.");
        }
        return;
      }
    }
    this.store.removeRow(rowKey);
    this.sync.enqueue({ seq: this.store.nextSeq(), t: "remove", row: rowKey }, [], { flush: true });
  }
  /** Fill the active cell's column down across the current selection (Ctrl+D). */
  rowFillDown() {
    const sel = this.store.selection;
    const active = this.store.active;
    if (!active) {
      return;
    }
    const colKey = active.colKey;
    const r0 = sel ? sel.r0 : this.store.rowIndexOf(active.rowKey);
    const r1 = sel ? sel.r1 : r0;
    const rowKeys = [];
    for (let r = r0; r <= r1; r++) {
      const row = this.store.rowAt(r);
      if (row) {
        rowKeys.push(row._k);
      }
    }
    if (rowKeys.length < 2) {
      return;
    }
    this.store.fillDown(colKey, rowKeys);
    this.sync.enqueue(
      { seq: this.store.nextSeq(), t: "fill", col: colKey, rows: rowKeys },
      rowKeys.slice(1).map((rowKey) => ({ rowKey, colKey })),
      { flush: true }
    );
  }
  /**
   * Flash a blank-required cell whose Enter-advance was blocked (entry keymap, G7 — the
   * form-kit red-flash parity) and announce it for AT. The class restarts its animation on
   * consecutive blocks and is dropped after it plays out.
   */
  flashRequiredCell(addr) {
    const cell = this.renderer ? this.renderer.cellElFor(addr.rowKey, addr.colKey) : null;
    if (cell) {
      cell.classList.remove("lgrid-cell--blocked");
      void cell.offsetWidth;
      cell.classList.add("lgrid-cell--blocked");
      setTimeout(() => cell.classList.remove("lgrid-cell--blocked"), 450);
    }
    if (this.announcer) {
      const column = this.store.columnByKey(addr.colKey);
      this.announcer.message(`${column && column.label || addr.colKey} is required.`);
    }
  }
  /** Apply reconciled footer totals from an op response to the footer chrome. */
  applyFooter(footer) {
    this.store.pageTotals = footer || {};
    if (this.renderer) {
      this.renderer.footer.render();
    }
  }
  /** Force-flush queued ops (host calls this before save() under SyncPolicy::Deferred). */
  flush() {
    if (this.sync) {
      return this.sync.flush();
    }
  }
  /** Toggle the loading overlay (server fetch in flight). */
  setLoading(on) {
    if (this.refs.loading) {
      this.refs.loading.hidden = !on;
    }
    this.refs.root.classList.toggle("lgrid--loading", !!on);
  }
  /** Show/hide the empty-state message from the mount's <template> when there are zero rows. */
  renderEmptyState() {
    const tpl = this.refs.emptyTemplate;
    const hasRows = this.store.rowCount() > 0;
    this.refs.root.classList.toggle("lgrid--empty", !hasRows);
    if (!this.emptyEl && tpl && "content" in tpl && tpl.content.firstElementChild) {
      this.emptyEl = tpl.content.firstElementChild.cloneNode(true);
      if (this.store.layout.emptyState) {
        this.emptyEl.textContent = this.store.layout.emptyState;
      }
      this.refs.body.after(this.emptyEl);
    }
    if (this.emptyEl) {
      this.emptyEl.hidden = hasRows;
    }
  }
  /** Stamp the ARIA grid roles/counts on the root (rows/cells are stamped by BodyRenderer). */
  setAriaGrid() {
    const root = this.refs.root;
    root.setAttribute("role", "grid");
    root.setAttribute("aria-readonly", this.store.editable ? "false" : "true");
    const totalRows = this.store.serverSide ? this.store.serverMeta.total : this.store.rowCount();
    root.setAttribute("aria-rowcount", String(totalRows + 1));
    root.setAttribute("aria-colcount", String(this.store.visibleColumns().length));
  }
  /**
   * Dev-only guard: the body lives inside `wire:ignore` and must be mutated ONLY by our
   * renderer. The observer is DISCONNECTED around our own body renders (body:will-render →
   * disconnect; body:did-render → drop our pending records, reconnect), so anything it observes
   * while connected is an external mutation — a Livewire morph leaking into sovereign territory
   * (R3). Stripped from production builds (import.meta.env.DEV is statically false in prod, so
   * the whole block is dead-code-eliminated).
   */
  installMorphGuard() {
    if (typeof import.meta === "undefined" || !import.meta.env || true) {
      return;
    }
    const opts = { childList: true, subtree: true, characterData: true };
    this.morphObserver = new MutationObserver((records) => {
      console.error(
        `[uf-datagrid:${this.store.name}] body DOM mutated outside a render pass \u2014 a Livewire morph may have leaked into the wire:ignore region (R3).`,
        records
      );
    });
    this.bus.on("body:will-render", () => this.morphObserver.disconnect());
    this.bus.on("body:did-render", () => {
      this.morphObserver.takeRecords();
      this.morphObserver.observe(this.refs.body, opts);
    });
    this.morphObserver.observe(this.refs.body, opts);
  }
  /** Tear down subscriptions + listeners (mount removal, observed by the boot module). */
  destroy() {
    if (this.morphObserver) {
      this.morphObserver.disconnect();
    }
    if (this.onDblClick) {
      this.refs.body.removeEventListener("dblclick", this.onDblClick);
    }
    if (this.onPaste) {
      this.refs.root.removeEventListener("paste", this.onPaste);
    }
    if (this.popupManager) {
      this.popupManager.destroy();
    }
    if (this.offActiveRow) {
      this.offActiveRow();
    }
    if (this.offFooter) {
      this.offFooter();
    }
    if (this.offComplete) {
      this.offComplete();
    }
    if (this.offEmptyState) {
      this.offEmptyState();
    }
    if (this.offRolledBack) {
      this.offRolledBack();
    }
    if (this.onFocusOutKey) {
      this.refs.root.removeEventListener("keydown", this.onFocusOutKey);
    }
    if (this.toolbar) {
      this.toolbar.destroy();
    }
    if (this.actionRunner) {
      this.actionRunner.destroy();
    }
    if (this.offPanel) {
      this.offPanel();
    }
    if (this.editorManager) {
      this.editorManager.destroy();
    }
    if (this.errorPainter) {
      this.errorPainter.destroy();
    }
    if (this.sync) {
      this.sync.destroy();
    }
    if (this.onSortClick) {
      this.refs.head.removeEventListener("pointerdown", this.onSortClick, true);
    }
    if (this.onToolbar) {
      document.removeEventListener("lgrid:toolbar", this.onToolbar);
    }
    if (this.onReseed) {
      window.removeEventListener("lgrid:reseed", this.onReseed);
    }
    if (this.onPanelDone) {
      window.removeEventListener("lgrid:panel-done", this.onPanelDone);
    }
    if (this.pagination) {
      this.pagination.destroy();
    }
    if (this.pageSource) {
      this.pageSource.destroy();
    }
    if (this.headerFilters) {
      this.headerFilters.destroy();
    }
    if (this.columnChooser) {
      this.columnChooser.destroy();
    }
    if (this.resizeManager) {
      this.resizeManager.destroy();
    }
    if (this.keyboard) {
      this.keyboard.destroy();
    }
    if (this.rowActivator) {
      this.rowActivator.destroy();
    }
    if (this.selection) {
      this.selection.destroy();
    }
    if (this.painter) {
      this.painter.destroy();
    }
    if (this.statusBar) {
      this.statusBar.destroy();
    }
    if (this.announcer) {
      this.announcer.destroy();
    }
    if (this.renderer) {
      this.renderer.destroy();
    }
    if (this.layout) {
      this.layout.destroy();
    }
    this.bus.clear();
  }
};

// ../sessions/affectionate-cool-bell/mnt/laragrid/resources/js/index.js
var cores = /* @__PURE__ */ new Map();
var observer = null;
function resolveRefs(root) {
  const ref = (name) => root.querySelector(`[data-lgrid-ref="${name}"]`) || void 0;
  return {
    root,
    toolbar: ref("toolbar"),
    scroll: ref("scroll"),
    head: ref("head"),
    body: ref("body"),
    footer: ref("footer"),
    announcer: ref("announcer"),
    statusbar: ref("statusbar"),
    pagination: ref("pagination"),
    loading: ref("loading"),
    emptyTemplate: ref("emptyTemplate"),
    editor: ref("editor"),
    errorCount: ref("errorCount"),
    popup: ref("popup"),
    wire: resolveWire(root)
  };
}
function resolveWire(root) {
  const host = root.closest("[wire\\:id]");
  if (!host) {
    return null;
  }
  const wireFor = (method) => {
    const candidates = [host.__livewire];
    const livewire = window.Livewire;
    if (livewire && typeof livewire.find === "function") {
      try {
        candidates.push(livewire.find(host.getAttribute("wire:id")));
      } catch (e) {
      }
    }
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      if (candidate.$wire && typeof candidate.$wire[method] === "function") {
        return candidate.$wire;
      }
      if (typeof candidate[method] === "function") {
        return candidate;
      }
    }
    return null;
  };
  const call2 = (method) => (...args) => {
    try {
      const wire = wireFor(method);
      if (!wire) {
        return Promise.reject(new Error(
          'LaraGrid: could not resolve a Livewire $wire exposing "' + method + '" (is Livewire loaded and the WithLaraGrid trait applied?).'
        ));
      }
      return Promise.resolve(wire[method](...args));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return {
    gridFetch: call2("gridFetch"),
    gridOps: call2("gridOps"),
    gridOptions: call2("gridOptions"),
    gridAction: call2("gridAction")
  };
}
function readConfig(root) {
  const holder = root.querySelector('script[type="application/json"][data-lgrid-config]');
  if (!holder) {
    console.error("LaraGrid: mount has no [data-lgrid-config] JSON block.", root);
    return null;
  }
  try {
    return JSON.parse(holder.textContent);
  } catch (e) {
    console.error("LaraGrid: invalid JSON in [data-lgrid-config].", root, e);
    return null;
  }
}
function mount(root) {
  if (cores.has(root)) {
    return cores.get(root);
  }
  const config = readConfig(root);
  if (!config) {
    return null;
  }
  const core = new GridCore(config, resolveRefs(root));
  cores.set(root, core);
  core.init();
  return core;
}
function unmount(root) {
  const core = cores.get(root);
  if (core) {
    core.destroy();
    cores.delete(root);
  }
}
function find(el2) {
  const root = el2 && el2.closest ? el2.closest("[data-lgrid]") : null;
  return root ? cores.get(root) || null : null;
}
function scan(node) {
  if (!(node instanceof Element)) {
    return;
  }
  if (node.matches && node.matches("[data-lgrid]")) {
    mount(node);
  }
  node.querySelectorAll && node.querySelectorAll("[data-lgrid]").forEach((el2) => mount(el2));
}
function reap(node) {
  if (!(node instanceof Element)) {
    return;
  }
  for (const [root] of cores) {
    if (node === root || node.contains(root)) {
      unmount(root);
    }
  }
}
function boot() {
  if (observer) {
    return;
  }
  const start = () => {
    scan(document.documentElement);
    observer = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => reap(node));
        record.addedNodes.forEach((node) => scan(node));
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
    observer = /** @type {any} */
    { pending: true };
    return;
  }
  start();
}
var LaraGrid = {
  boot,
  mount,
  unmount,
  find,
  registerPainter,
  registerEditor,
  registerFormatter,
  registerCast
};
if (typeof window !== "undefined") {
  window.LaraGrid = Object.assign(window.LaraGrid || {}, LaraGrid);
  boot();
}
var index_default = LaraGrid;
export {
  LaraGrid,
  boot,
  index_default as default,
  find,
  mount,
  unmount
};
//# sourceMappingURL=laragrid.esm.js.map
