/**
 * What: The single floating-editor host + the NAV↔EDIT state machine (plan §2.6). It opens one
 *       reusable editor over the active cell (type-through / F2 / double-click / Enter), runs the
 *       commit pipeline (parse → client-validate → optimistic store apply → enqueue op → advance),
 *       cancels on Esc, and commits on blur — for every editable column type via the registry.
 *       M5 adds the picker seams: editors may consume keys first (handleKey — popup navigation),
 *       mount with a popup/search context, record a pick's label, and "instant" editors
 *       (checkbox) toggle through the SAME pipeline without entering EDIT. The pipeline core is
 *       commitCell(), which the floating commit, the Space toggle AND paste all call — one write
 *       path, never a second (M4 follow-up #1).
 * Why:  One editor moved over the active cell is the MSFlexGrid/Excel model the brief mandates and
 *       the reason large grids stay light (plan §2.1/§2.7). Concentrating the lifecycle in one
 *       explicit state machine is the R4 mitigation: blur-vs-commit, IME, and Esc-during-validation
 *       races are handled in ONE place, not scattered per editor — and popup clicks can't blur the
 *       editor at all (PopupManager preventDefaults pointerdown). The editor host lives inside the
 *       grid's wire:ignore region, so opening/closing it never involves Livewire.
 * When: Constructed by GridCore for an editable grid; KeyboardManager routes open intents to it.
 */
import { editorFor } from './EditorRegistry.js';
import { parseValue, editTextFor, parseBool } from '../format/parse.js';
import { firstNavigable } from '../util/geometry.js';
import Lru from '../util/lru.js';

export default class EditorManager {
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
        /** @type {Map<string, Lru>} per-column option LRU — outlives editor instances. */
        this.optionCaches = new Map();
        /** NAV | EDIT. */
        this.mode = 'NAV';
        this.editor = null;
        this.editorCol = null;
        this.editorRow = null;
        /** The picked option's display label staged for the next commit (pickers). */
        this.pickLabel = null;
        this.composing = false; // IME guard

        // Balance autofill (layout.complete.autofill): landing on an empty deficit-side amount
        // cell pre-fills the balancing amount. Subscribed here because the fill must ride the
        // ONE commit pipeline (commitCell) this manager owns.
        this.offActiveChanged = bus.on('active:changed', ({ active }) => this.maybeAutofillBalance(active));
    }

    isEditing() {
        return this.mode === 'EDIT';
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
        if (this.mode === 'EDIT') {
            return;
        }
        const addr = this.store.active;
        if (!addr) {
            return;
        }
        const column = this.store.columnByKey(addr.colKey);
        if (!column || !column.editable) {
            return; // display-only cell — no editor
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

        this.mode = 'EDIT';
        this.editorRow = addr.rowKey;
        this.editorCol = addr.colKey;
        this.pickLabel = null;
        this.positionOver(cellEl);
        this.refs.editor.hidden = false;

        // Seed text: a type-through char replaces; F2/dblclick keep the current EDIT text
        // (editTextFor — e.g. an Amount cell seeds "125.00" rupees, never its raw paise digits).
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
            endOfList: () => this.endOfList(),
        });

        this.bindEditorEvents();
        this.bus.emit('editor:opened', { rowKey: addr.rowKey, colKey: addr.colKey });
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
        // Declarative per-row lock (lockedWhen): unlike a 'dynamic' readonly closure this IS
        // client-evaluable, so the editor refuses up front — no optimistic paint-then-error.
        if (this.store.cellLocked(row, column)) {
            return true;
        }
        // A per-row 'dynamic' readonly is decided server-side; the client optimistically allows the
        // edit and lets the server reject it (an op error), consistent with dynamic required.
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
            wireValue: next,
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
        const key = String(term == null ? '' : term);
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
            // Deferred blur: PopupManager preventDefaults pointerdown inside the popup, so a popup
            // click never blurs us at all; this fires only for a true focus departure (outside
            // click / tab-out), where committing is the right outcome. The tick keeps parity with
            // M4 (and gives any same-tick close() a chance to win).
            if (this.mode !== 'EDIT') {
                return;
            }
            this.blurTimer = setTimeout(() => {
                if (this.mode === 'EDIT') {
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
        host.addEventListener('keydown', this.onKeyDown);
        host.addEventListener('focusout', this.onBlur);
        host.addEventListener('compositionstart', this.onCompositionStart);
        host.addEventListener('compositionend', this.onCompositionEnd);
    }

    /**
     * Editor-mode key handling. The EDITOR gets first refusal (handleKey — a popup editor owns
     * arrows/Enter/Esc while its list is open, R4/§2.6 POPUP state); unconsumed keys fall through
     * to the shared routing: Enter/Tab commit + advance; Esc cancels; arrows per editor policy.
     */
    handleEditorKey(e) {
        if (this.composing) {
            return; // never commit mid-IME-composition (R4)
        }

        if (this.editor && typeof this.editor.handleKey === 'function' && this.editor.handleKey(e)) {
            return; // consumed by the editor (popup navigation / pick / staged close)
        }

        const key = e.key;

        if (key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.cancel();
            return;
        }
        if (key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            this.commit({ advance: e.shiftKey ? 'enterBack' : 'enter' });
            return;
        }
        if (key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            this.commit({ advance: e.shiftKey ? 'prev' : 'next' });
            return;
        }

        const policy = this.editor.keyPolicy ? this.editor.keyPolicy(e) : null;
        if (policy === 'commit-move') {
            e.preventDefault();
            e.stopPropagation();
            const advance = key === 'ArrowUp' ? 'up' : key === 'ArrowDown' ? 'down'
                : key === 'ArrowLeft' ? 'prevCell' : 'nextCell';
            this.commit({ advance });
        }
        // policy === 'caret' (or null): let the input handle the key (caret movement / typing).
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
        if (this.mode !== 'EDIT' || !this.editor) {
            return;
        }
        const rowKey = this.editorRow;
        const colKey = this.editorCol;
        const column = this.store.columnByKey(colKey);
        const raw = this.editor.value();
        const parsed = parseValue(column.parse, raw);

        // The one refusing parse outcome: an unparseable non-empty date (shared-parser sentinel).
        if (parsed === undefined) {
            this.store.setError(rowKey, colKey, 'Not a recognisable date.');
            this.editor.focus(true);
            return;
        }

        // Client-side instant validation (a strict subset; server is authoritative).
        const clientRules = (column.validate && column.validate.client) || [];
        const message = this.validator.validate(clientRules, parsed, column.label || colKey);
        if (message) {
            this.store.setError(rowKey, colKey, message);
            this.editor.focus(true);
            return; // stay in EDIT; the operator fixes the value
        }

        const label = this.pickLabel;
        this.pickLabel = null;
        this.commitCell(rowKey, colKey, column, {
            parsed,
            wireValue: this.wireValueFor(column, raw, parsed),
            label,
        });

        this.close();

        if (opts.advance) {
            // Host-panel hand-off (opensPanel) instead of a plain advance when the committed
            // column declares one and the advance is forward — see panelOrAdvance().
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
            this.bus.emit('grid:panel', { panel: column.opensPanel, rowKey, advance: direction });
            return;
        }
        this.advance(direction);
    }

    /** Whether an advance direction moves the cursor FORWARD (Enter / Tab) vs back/arrow. */
    isForwardAdvance(direction) {
        return direction === 'enter' || direction === 'next';
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

        // Picker labels: a pick stages one; a cleared pick — or a value written WITHOUT a label
        // (a pasted raw id) — drops the stale label rather than mislabel (mirrors applyPickLabel).
        if (this.isPickerColumn(column)) {
            this.store.setRowLabel(rowKey, colKey, payload.label != null ? payload.label : null);
        }

        // Declarative sibling mirror (whenFilled): a NON-BLANK commit optimistically applies the
        // column's declared fixed sets + clears on the same row, so dependent cells update the
        // instant the operator commits (e.g. the voucher D/C flip: a Debit entry sets dc='D' and
        // blanks Credit) instead of waiting a round-trip. No sibling ops ride the wire — the
        // server's afterCellChange hook is authoritative and its write-backs reconcile these
        // same cells (matching values, so no flicker).
        const wf = column.whenFilled;
        const filled = payload.parsed !== '' && payload.parsed != null && payload.parsed !== false;
        if (wf && filled) {
            const hit = this.store.rowByKey.get(rowKey);
            for (const [key, value] of Object.entries(wf.sets || {})) {
                if (hit && hit.row[key] !== value) {
                    changed = changed.concat(this.store.applyLocalSet(rowKey, key, value));
                }
            }
            for (const key of wf.clears || []) {
                if (hit && hit.row[key] != null && hit.row[key] !== '') {
                    changed = changed.concat(this.store.applyLocalSet(rowKey, key, null));
                }
            }
        }

        const op = { seq: this.store.nextSeq(), t: 'set', row: rowKey, col: colKey, v: payload.wireValue };
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

        // Embedded options: map a pasted label or value onto the whitelist; anything else refuses.
        if (this.isPickerColumn(column) && Array.isArray(column.options) && column.options.length) {
            const needle = String(raw == null ? '' : raw).trim().toLowerCase();
            if (needle === '') {
                text = '';
            } else {
                const hit = column.options.find((o) => String(o.value).toLowerCase() === needle)
                    || column.options.find((o) => o.label.toLowerCase() === needle);
                if (!hit) {
                    return { ok: false, message: 'Not one of the options.' };
                }
                text = hit.value;
                label = hit.label;
            }
        }

        const parsed = parseValue(column.parse, text);
        if (parsed === undefined) {
            return { ok: false, message: 'Not a recognisable date.' };
        }

        const clientRules = (column.validate && column.validate.client) || [];
        const message = this.validator.validate(clientRules, parsed, column.label || colKey);
        if (message) {
            return { ok: false, message };
        }

        const staged = this.commitCell(rowKey, colKey, column, {
            parsed,
            wireValue: this.wireValueFor(column, text, parsed),
            label,
        }, { enqueue: false });

        return { ok: true, op: staged.op, cells: staged.cells };
    }

    /**
     * What rides the wire as the op's `v`: picker kinds send the RESOLVED value (the picked id /
     * canonical ISO / boolean — the raw editor text is a filter term or fuzzy input, not a value);
     * text/number kinds keep the M4 raw-text convention (the server cast is authoritative).
     */
    wireValueFor(column, raw, parsed) {
        const kind = (column.parse && column.parse.kind) || 'text';
        return kind === 'select' || kind === 'date' || kind === 'bool' ? parsed : raw;
    }

    /** Whether a column is a picker (its cells carry a display label in the row's _labels bag). */
    isPickerColumn(column) {
        return !!(column.parse && column.parse.kind === 'select');
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
        this.bus.emit('editor:closed', { cancelled: true });
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
        this.bus.emit('editor:closed', { cancelled: true });
        this.bus.emit('grid:complete', {});
    }

    /** Tear down the editor element + listeners (and any popup it owned) and return to NAV. */
    close() {
        if (this.blurTimer) {
            clearTimeout(this.blurTimer);
        }
        if (this.popup && this.popup.isOpen()) {
            this.popup.close('owner');
        }
        const host = this.refs.editor;
        host.removeEventListener('keydown', this.onKeyDown);
        host.removeEventListener('focusout', this.onBlur);
        host.removeEventListener('compositionstart', this.onCompositionStart);
        host.removeEventListener('compositionend', this.onCompositionEnd);
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
        host.hidden = true;
        this.mode = 'NAV';
        this.pickLabel = null;
        this.bus.emit('editor:closed', {});
        // Return focus to the grid root so NAV keys resume.
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
        const keymap = (this.store.layout && this.store.layout.keymap) || 'entry';

        switch (direction) {
            case 'enter':
                this.advanceOnEnter(keymap, false);
                break;
            case 'enterBack':
                this.advanceOnEnter(keymap, true);
                break;
            case 'next': // Tab: serpentine wrap forward (with auto-append at the grid's end)
                this.moveOrAppend();
                break;
            case 'prev': // Shift+Tab: serpentine wrap backward
                this.selection.move('prevWrap');
                break;
            case 'down':
                this.selection.move('down');
                break;
            case 'up':
                this.selection.move('up');
                break;
            case 'nextCell': // ArrowRight commit-and-move (number editor)
                this.selection.move('right');
                break;
            case 'prevCell': // ArrowLeft commit-and-move (number editor)
                this.selection.move('left');
                break;
            default:
                break;
        }
    }

    /** Enter advance: serpentine wrap under the entry keymap; straight down/up under excel. */
    advanceOnEnter(keymap, back) {
        if (keymap === 'excel') {
            this.selection.move(back ? 'up' : 'down');
            return;
        }
        if (back) {
            this.selection.move('prevWrap');
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
                this.bus.emit('grid:complete', {});
                return;
            }
            const newKey = 'r' + this.store.nextSeq() + Math.random().toString(36).slice(2, 6);
            this.store.insertRow(newKey);
            this.sync.enqueue({ seq: this.store.nextSeq(), t: 'insert', as: newKey }, [], { flush: true });
            const col = firstNavigable(this.store.navigabilityMask());
            const addr = this.store.addressAt(this.store.rowIndexOf(newKey), col);
            if (addr) {
                this.store.setActive(addr);
            }
            return;
        }
        this.selection.move('nextWrap');
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
        if (!addr || this.mode === 'EDIT') {
            return;
        }
        // Never write while the operator is SELECTING (shift+arrows / row / column / all):
        // a range sweep over an empty amount cell is not an entry landing.
        const selection = this.store.selection;
        if (selection && selection.kind !== 'cell') {
            return;
        }
        const spec = this.store.layout && this.store.layout.complete;
        if (!spec || spec.kind !== 'balanced' || spec.autofill === false) {
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
            if (!(value == null || value === '')) {
                return; // the row already carries an amount — never overwrite operator work
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
        if (this.mode === 'EDIT') {
            this.close();
        }
        if (this.offActiveChanged) {
            this.offActiveChanged();
        }
        this.optionCaches.clear();
    }
}
