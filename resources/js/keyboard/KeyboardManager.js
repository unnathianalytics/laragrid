/**
 * What: The NAV-mode keyboard dispatcher. One delegated `keydown` on the grid root normalises
 *       the event to a chord (keys.js), looks up the intent in the active keymap preset
 *       (entry/excel), and routes it: movement/selection → SelectionManager, Ctrl+C → the copy
 *       callback, Ctrl+A → select-all, Esc → collapse, row-ops → a no-op in readonly (M4 wires
 *       them). It preventDefaults ONLY when it handled the key, and deliberately lets Tab/Enter
 *       escape the grid at the first/last cell so focus moves out (form-kit boundary parity).
 * Why:  Plan §2.4/§2.6: KeyboardManager is "mode-aware key dispatch against a keymap table".
 *       Keeping the presets as data (keys.js + keymap-*.js) and the geometry in util/geometry
 *       makes this file pure routing — the two keymaps differ in a table, not in code. Handling
 *       keys only when the grid root owns focus keeps Ctrl+A / Ctrl+C from stealing the browser
 *       defaults elsewhere on the page (R-B).
 * When: Constructed by GridCore; the listener is live whenever the grid is mounted, but each
 *       keydown is ignored unless focus is within the grid root.
 */
import { chordFor } from './keys.js';
import { ENTRY_KEYMAP } from './keymap-entry.js';
import { EXCEL_KEYMAP } from './keymap-excel.js';
import { editorFor } from '../edit/EditorRegistry.js';

/** Resolve a keymap object by preset name; default (and unknown) → 'entry'. */
function keymapFor(name) {
    return name === 'excel' ? EXCEL_KEYMAP : ENTRY_KEYMAP;
}

export default class KeyboardManager {
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
        this.keymap = keymapFor((store.layout && store.layout.keymap) || 'entry');
        this.onKeyDown = this.handleKeyDown.bind(this);
        this.onFocus = this.handleFocus.bind(this);
    }

    init() {
        this.refs.root.addEventListener('keydown', this.onKeyDown);
        // Landing focus on the grid (Tab-in or click) seeds the active cell if none yet.
        this.refs.root.addEventListener('focus', this.onFocus, true);
    }

    destroy() {
        this.refs.root.removeEventListener('keydown', this.onKeyDown);
        this.refs.root.removeEventListener('focus', this.onFocus, true);
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
        // While the editor owns EDIT mode, it handles its own keys (Enter/Tab/Esc/arrows) — the
        // KeyboardManager stays out of the way (the editor stops propagation for the ones it uses).
        if (this.editor && this.editor.isEditing()) {
            return;
        }
        if (!this.ownsFocus()) {
            return;
        }

        // Edit-open intents (editable grids), checked before the keymap:
        //  - F2 opens the editor with the caret at end (preserve content);
        //  - Space on a CHECKBOX cell toggles it inline (M5, §2.6 — no editor round-trip);
        //  - a printable char (no modifiers) type-through opens the editor seeded with that char.
        // Enter NEVER opens the editor (M5 verification refinement, form-kit/Tally parity):
        // under the entry keymap it advances through a FILLED cell (auto-appending at the grid's
        // end, G4) and is BLOCKED with a flash on a blank required cell (G7); under excel it
        // falls through to the keymap's move-down. Typing / F2 / double-click are the edit
        // gestures. Instant (checkbox) columns are likewise excluded from type-through — Space
        // (and double-click) are the deliberate toggle gestures — EXCEPT the chars the instant
        // editor itself maps (YesNoInline: y/n), which commit that value directly and advance.
        if (this.editor) {
            if (e.key === 'F2') {
                e.preventDefault();
                this.editor.open({ caretAtEnd: true });
                return;
            }
            if (e.key === ' ' && this.activeCellEditable() && this.activeCellInstant()) {
                e.preventDefault();
                this.editor.open({});
                return;
            }
            if (this.isPrintable(e) && (!this.activeCellInstant() || this.instantCharCommits(e.key))) {
                e.preventDefault();
                this.editor.open({ seed: e.key });
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey && this.handleNavEnter(e)) {
                return;
            }
        }

        // Readonly row activation (no editor): plain Enter on an activatable row dispatches
        // `lgrid:activate` and stops here. A non-activatable row (no `_activateUrl`) returns false,
        // so Enter falls through to the keymap — the excel move-down stays the default. Shift+Enter
        // is left to the keymap (move-up), so activation never hijacks the up gesture.
        if (!this.editor && this.rowActivate && e.key === 'Enter' && !e.shiftKey
            && !e.ctrlKey && !e.metaKey && !e.altKey && this.rowActivate()) {
            e.preventDefault();
            return;
        }

        const binding = this.keymap[chordFor(e)];
        if (!binding) {
            return;
        }

        switch (binding.action) {
            case 'move': {
                const escape = this.selection.move(binding.intent);
                if (escape) {
                    // Let the browser move focus out of the grid (don't preventDefault).
                    return;
                }
                e.preventDefault();
                break;
            }
            case 'select':
                this.selection.extend(binding.intent);
                e.preventDefault();
                break;
            case 'selectAll':
                this.selection.selectAll();
                e.preventDefault();
                break;
            case 'clearSelection':
                this.selection.collapse();
                e.preventDefault();
                break;
            case 'copy':
                if (this.hooks.onCopy) {
                    this.hooks.onCopy();
                }
                e.preventDefault();
                break;
            case 'actionsMenu':
                e.preventDefault();
                if (this.hooks.actionsMenu) {
                    this.hooks.actionsMenu();
                }
                break;
            case 'rowop':
                // Editable grids: route to the op handlers; readonly: swallow (no-op) so Insert/
                // Delete/Ctrl+D don't trigger browser behaviour on the grid.
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
        return typeof e.key === 'string' && e.key.length === 1 && e.key !== ' ';
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
        const keymapName = (this.store.layout && this.store.layout.keymap) || 'entry';
        if (keymapName !== 'entry') {
            return false; // excel: Enter is the keymap's move-down, never blocked (G7)
        }
        const addr = this.store.active;
        if (!addr) {
            return false;
        }

        e.preventDefault();

        // The complete-guard escape: on a COMPLETE grid (layout.complete satisfied, e.g. the
        // voucher balanced) a fully blank row means the operator is done — Enter forwards to
        // the host (Save) instead of opening a picker dropdown or flash-blocking on a blank
        // required cell. Checked FIRST: on a blank row the active cell is usually the leading
        // picker (the voucher's D/C), whose empty-picker-opens rule would otherwise win. A
        // PARTIALLY filled row keeps the normal rules: it holds real work to finish or clear.
        if (this.store.isComplete() && this.rowIsBlank(addr.rowKey)) {
            if (this.hooks.onComplete) {
                this.hooks.onComplete();
            }
            return true;
        }

        if (this.isEmptyCell(addr) && this.isPickerCell(addr) && this.activeCellEditable()) {
            this.editor.open({ caretAtEnd: true }); // summon the lookup list on an empty picker
            return true;
        }

        if (this.isBlankRequired(addr)) {
            if (this.hooks.onRequiredBlock) {
                this.hooks.onRequiredBlock(addr);
            }
            return true; // stay put — the operator must fill the cell (or Esc/arrow away)
        }

        // A FILLED cell advances serpentine — but if its column hands off to a host panel
        // (opensPanel, e.g. Rate → the "Item description" popup) the panel opens instead, exactly
        // as it does when the cell is edited. Re-entering the cell and pressing Enter (no value
        // change) must still open the popup, so this lives on the NAV advance too, not only in
        // the editor's commit path.
        const column = this.store.columnByKey(addr.colKey);
        this.editor.panelOrAdvance(column, addr.rowKey, 'enter');
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
        return value == null || value === '';
    }

    /** Whether the cell's column is a picker (select/searchselect — parse kind 'select'). */
    isPickerCell(addr) {
        const column = this.store.columnByKey(addr.colKey);
        return !!(column && column.parse && column.parse.kind === 'select');
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
     * The active cell's INSTANT editor class (checkbox/yesno), or null — a registry lookup, so the
     * dispatcher stays type-agnostic (any future instant editor gets the same Space/Enter rules).
     */
    activeInstantClass() {
        const addr = this.store.active;
        if (!addr) {
            return null;
        }
        const column = this.store.columnByKey(addr.colKey);
        const EditorClass = column && column.editor ? editorFor(column.editor) : null;
        return EditorClass && EditorClass.instant ? EditorClass : null;
    }

    /** True when the active cell's editor is an INSTANT one (checkbox/yesno). */
    activeCellInstant() {
        return !!this.activeInstantClass();
    }

    /**
     * True when the active instant editor maps this typed key to a direct value commit
     * (YesNoInline.chars: y/n) — the one type-through allowed on an instant column; the
     * EditorManager's open() applies the mapping.
     */
    instantCharCommits(key) {
        const EditorClass = this.activeInstantClass();
        const chars = EditorClass ? EditorClass.chars : null;
        return !!chars && Object.prototype.hasOwnProperty.call(chars, String(key).toLowerCase());
    }
}
