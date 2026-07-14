/**
 * What: Pure grid-geometry math — no DOM, no state. Given a navigability mask over the visible
 *       columns and a row count, it resolves the next active cell for a movement intent
 *       (arrows / Home / End / Ctrl-edges / paging / row-wrap), and normalises two cell
 *       addresses into a selection rectangle.
 * Why:  The tricky part of keyboard navigation is index arithmetic with skip logic and
 *       boundaries; isolating it as pure functions makes it independently vector-testable
 *       (the shared `navigation.json` lock, mirroring how `formatters.js` is proven) and keeps
 *       KeyboardManager/SelectionManager as thin orchestration (plan §2.4, "small modules,
 *       hard edges"). The ONE skip predicate is `mask[colIndex] === true` (a column's serialized
 *       `navigable`); M4 widens navigability upstream without touching this file.
 * When: Imported by KeyboardManager (movement) and SelectionManager (rectangles).
 */

/** Clamp n into [lo, hi]. */
export function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
}

/**
 * The first navigable column index (>= 0), or -1 if the mask has none.
 * @param {boolean[]} mask
 */
export function firstNavigable(mask) {
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) {
            return i;
        }
    }
    return -1;
}

/** The last navigable column index, or -1. */
export function lastNavigable(mask) {
    for (let i = mask.length - 1; i >= 0; i--) {
        if (mask[i]) {
            return i;
        }
    }
    return -1;
}

/**
 * Step from `col` in `dir` (+1 / -1) to the next navigable column, WITHIN the same row.
 * Stops at the boundary (does not wrap) — returns the current col if none found ahead.
 * @param {boolean[]} mask
 * @param {number} col
 * @param {1|-1} dir
 * @returns {number} the next navigable column index, or `col` if blocked at the edge
 */
export function nextNavigableInRow(mask, col, dir) {
    for (let i = col + dir; i >= 0 && i < mask.length; i += dir) {
        if (mask[i]) {
            return i;
        }
    }
    return col;
}

/**
 * Resolve a movement to a new {row, col}. Rows are 0..rowCount-1; columns are masked.
 *
 * Directional intents ('up'/'down'/'left'/'right') move one navigable step and clamp at the
 * grid edge (no wrap). Row-wrapping intents ('nextWrap'/'prevWrap' — Enter/Tab in the entry
 * keymap) move right/left and wrap onto the adjacent row's first/last navigable cell, clamping
 * at the grid's first/last cell. 'rowStart'/'rowEnd' jump within the row; 'gridStart'/'gridEnd'
 * jump to the very first/last navigable cell; 'pageUp'/'pageDown' move by `page` rows.
 *
 * @param {object} p
 * @param {'up'|'down'|'left'|'right'|'nextWrap'|'prevWrap'|'rowStart'|'rowEnd'|'colStart'|'colEnd'|'gridStart'|'gridEnd'|'pageUp'|'pageDown'} p.intent
 * @param {number} p.row current row index
 * @param {number} p.col current column index
 * @param {number} p.rowCount total rows
 * @param {boolean[]} p.mask column navigability
 * @param {number} [p.page] page size in rows (for pageUp/pageDown)
 * @returns {{row: number, col: number, escape?: 'next'|'prev'}}
 *          `escape` is set when a wrap intent runs off the grid's last/first cell so the caller
 *          can let focus leave the grid (form-kit boundary behaviour); position stays put.
 */
export function resolveMove(p) {
    const { intent, row, col, rowCount, mask } = p;
    const page = p.page || 1;
    const lastRow = Math.max(0, rowCount - 1);
    const firstCol = firstNavigable(mask);
    const lastCol = lastNavigable(mask);

    switch (intent) {
        case 'left':
            return { row, col: nextNavigableInRow(mask, col, -1) };
        case 'right':
            return { row, col: nextNavigableInRow(mask, col, +1) };
        case 'up':
            return { row: clamp(row - 1, 0, lastRow), col };
        case 'down':
            return { row: clamp(row + 1, 0, lastRow), col };
        case 'pageUp':
            return { row: clamp(row - page, 0, lastRow), col };
        case 'pageDown':
            return { row: clamp(row + page, 0, lastRow), col };
        case 'rowStart':
            return { row, col: firstCol };
        case 'rowEnd':
            return { row, col: lastCol };
        case 'colStart':
            return { row: 0, col };
        case 'colEnd':
            return { row: lastRow, col };
        case 'gridStart':
            return { row: 0, col: firstCol };
        case 'gridEnd':
            return { row: lastRow, col: lastCol };
        case 'nextWrap': {
            const right = nextNavigableInRow(mask, col, +1);
            if (right !== col) {
                return { row, col: right };
            }
            // At the last navigable column: wrap to the next row's first navigable cell.
            if (row < lastRow) {
                return { row: row + 1, col: firstCol };
            }
            // Last cell of the grid: signal boundary escape; position unchanged.
            return { row, col, escape: 'next' };
        }
        case 'prevWrap': {
            const left = nextNavigableInRow(mask, col, -1);
            if (left !== col) {
                return { row, col: left };
            }
            if (row > 0) {
                return { row: row - 1, col: lastCol };
            }
            return { row, col, escape: 'prev' };
        }
        default:
            return { row, col };
    }
}

/**
 * Normalise two cell addresses into an inclusive rectangle in (row, col) index space.
 * @param {{row: number, col: number}} a anchor
 * @param {{row: number, col: number}} b active
 * @returns {{r0: number, r1: number, c0: number, c1: number}}
 */
export function normaliseRect(a, b) {
    return {
        r0: Math.min(a.row, b.row),
        r1: Math.max(a.row, b.row),
        c0: Math.min(a.col, b.col),
        c1: Math.max(a.col, b.col),
    };
}
