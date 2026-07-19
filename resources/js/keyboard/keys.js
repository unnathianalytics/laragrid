/**
 * What: Normalises a raw `keydown` into a stable **keychord** string — a keymap-independent
 *       token like `ArrowDown`, `Shift+Tab`, `Ctrl+a`, `Ctrl+Home` — that the keymaps then map
 *       to a grid intent.
 * Why:  Keeping "what did the user press" (this file) separate from "what does that mean in this
 *       grid" (the keymaps) is what lets `entry` and `excel` differ in ONE table without the
 *       dispatcher re-parsing modifiers per preset (plan §2.4 KeyboardManager, §1.3 G3). The
 *       chord form is deterministic and unit-testable in Node, and is exactly the key the shared
 *       `navigation.json` vectors are written against.
 * When: Called by KeyboardManager on every keydown while the grid root owns focus.
 */

/**
 * Printable single characters (letters/digits) are lower-cased so `A` and `a` share a chord;
 * named keys (ArrowDown, Home, Enter, Tab, Escape, PageUp…) pass through as-is.
 */
function keyToken(key) {
    if (typeof key === 'string' && key.length === 1) {
        return key.toLowerCase();
    }
    return key;
}

/**
 * Build the canonical chord for an event. Modifier order is fixed (Ctrl, Alt, Shift) so the
 * chord is stable regardless of how the OS reports the event. Meta (⌘) is treated as Ctrl so
 * mac Cmd+C / Cmd+A behave like their Windows/Linux counterparts.
 *
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} e
 * @returns {string} e.g. "Ctrl+Home", "Shift+ArrowDown", "Ctrl+a", "Enter"
 */
export function chordFor(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) {
        parts.push('Ctrl');
    }
    if (e.altKey) {
        parts.push('Alt');
    }
    if (e.shiftKey) {
        parts.push('Shift');
    }
    parts.push(keyToken(e.key));
    return parts.join('+');
}

/**
 * The chords common to every keymap preset (only Enter/Shift+Enter differ between presets, so
 * they are added in keymap-entry.js / keymap-excel.js). Living here — the neutral base both
 * presets already import for chordFor — keeps the keymap files free of a circular import.
 *
 * Intent shape: { action, intent?, kind? }
 *   action: 'move' | 'select' | 'selectAll' | 'copy' | 'clearSelection' | 'rowop'
 *   intent: a geometry intent passed to resolveMove (for move/select)
 *   kind:   a row-op name (for rowop) — no-op in readonly, wired at M4
 *
 * Selection chords (Shift+…) reuse the movement intents; KeyboardManager tells move from
 * extend-selection by the `action`. Tab uses the wrapping intents so it escapes the grid at the
 * boundary (form-kit parity) rather than trapping focus.
 */
export const SHARED_KEYMAP = {
    ArrowUp: { action: 'move', intent: 'up' },
    ArrowDown: { action: 'move', intent: 'down' },
    ArrowLeft: { action: 'move', intent: 'left' },
    ArrowRight: { action: 'move', intent: 'right' },

    'Shift+ArrowUp': { action: 'select', intent: 'up' },
    'Shift+ArrowDown': { action: 'select', intent: 'down' },
    'Shift+ArrowLeft': { action: 'select', intent: 'left' },
    'Shift+ArrowRight': { action: 'select', intent: 'right' },

    Tab: { action: 'move', intent: 'nextWrap' },
    'Shift+Tab': { action: 'move', intent: 'prevWrap' },

    Home: { action: 'move', intent: 'rowStart' },
    End: { action: 'move', intent: 'rowEnd' },
    'Ctrl+Home': { action: 'move', intent: 'gridStart' },
    'Ctrl+End': { action: 'move', intent: 'gridEnd' },

    // Ctrl+Arrow = jump to the data edge in that direction (readonly = first/last row or col).
    'Ctrl+ArrowUp': { action: 'move', intent: 'colStart' },
    'Ctrl+ArrowDown': { action: 'move', intent: 'colEnd' },
    'Ctrl+ArrowLeft': { action: 'move', intent: 'rowStart' },
    'Ctrl+ArrowRight': { action: 'move', intent: 'rowEnd' },

    PageUp: { action: 'move', intent: 'pageUp' },
    PageDown: { action: 'move', intent: 'pageDown' },

    'Ctrl+a': { action: 'selectAll' },
    'Ctrl+c': { action: 'copy' },
    Escape: { action: 'clearSelection' },

    // Undo/redo (editable grids) — recognised everywhere, handled only where GridCore wired
    // an UndoManager (readonly/display grids leave the keys to the browser).
    'Ctrl+z': { action: 'undo' },
    'Ctrl+y': { action: 'redo' },
    'Ctrl+Shift+z': { action: 'redo' },

    // Row/cell-op chords — recognised, but no-op in readonly (wired to editable handlers).
    // Excel-trained operators expect Delete to CLEAR content, never to remove the row;
    // row removal sits behind the deliberate Shift+Delete (or F8 — moved off F7 by
    // consumer request, 2026-07-19; F7 is free again for host apps).
    Insert: { action: 'rowop', kind: 'insert' },
    Delete: { action: 'rowop', kind: 'clear' },
    'Shift+Delete': { action: 'rowop', kind: 'delete' },
    F8: { action: 'rowop', kind: 'delete' },
    'Ctrl+d': { action: 'rowop', kind: 'fillDown' },

    // Temporary row hide (F9, DISPLAY grids only) — the accountant's what-if: a Trial
    // Balance minus one row, footer sums recomputed over what remains. Strictly VIEW
    // state: Shift+F9 restores everything, an external reseed clears it, and a
    // sort-clear never resurrects hidden rows. No-op on server-side grids (grand totals
    // span pages the client cannot see) and editable grids (row content is domain state).
    F9: { action: 'rowHide' },
    'Shift+F9': { action: 'rowRestore' },

    // The row-actions menu (P7) — works in every mode that declares row actions.
    ContextMenu: { action: 'actionsMenu' },
    'Shift+F10': { action: 'actionsMenu' },
};
