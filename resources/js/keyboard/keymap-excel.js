/**
 * What: The `excel` keymap — Enter moves DOWN one row (same column), Shift+Enter moves UP.
 *       Everything else (arrows, Tab wrap, Home/End, Ctrl-edges, paging, selection, Ctrl+A/C,
 *       Esc, row-op chords) comes from SHARED_KEYMAP.
 * Why:  Only Enter/Shift+Enter legitimately differ between presets (plan §1.3 G3); the shared
 *       chords live in keys.js so both presets are one source of truth for common behaviour and
 *       the preset diff is obvious.
 * When: Selected when config.layout.keymap === 'excel'.
 */
import { SHARED_KEYMAP } from './keys.js';

export const EXCEL_KEYMAP = {
    ...SHARED_KEYMAP,

    Enter: { action: 'move', intent: 'down' },
    'Shift+Enter': { action: 'move', intent: 'up' },
};
