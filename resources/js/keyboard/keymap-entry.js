/**
 * What: The `entry` keymap — the DEFAULT preset. Reproduces the form-kit grid's serpentine
 *       flow: Enter advances RIGHT and wraps to the next row's first cell (Enter behaves like
 *       Tab), Shift+Enter reverses it. Everything else comes from SHARED_KEYMAP.
 * Why:  Operators are trained on the serpentine left-to-right, row-by-row fill of the existing
 *       <x-uf.grid> (resources/js/form-kit/grid.js); the umbrella confirms `entry` as the
 *       default so navigation matches muscle memory (plan §1.3 G3, open-Q 3). Differences from
 *       `excel` are confined to Enter/Shift+Enter.
 * When: Selected when config.layout.keymap === 'entry' (the default).
 */
import { SHARED_KEYMAP } from './keys.js';

export const ENTRY_KEYMAP = {
    ...SHARED_KEYMAP,

    Enter: { action: 'move', intent: 'nextWrap' },
    'Shift+Enter': { action: 'move', intent: 'prevWrap' },
};
