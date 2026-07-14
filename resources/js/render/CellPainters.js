/**
 * What: The per-column paint dispatch — a registry of painter functions keyed by the
 *       column's `painter` id (set server-side by Column::painterId()).
 * Why:  The body renderer must stay type-agnostic: it asks "which painter?" and calls it,
 *       so a new column type ships a new painter without the renderer knowing types
 *       (plan §3.8, the extension seam). M1 needs just two — `serial` (row ordinal) and
 *       `text` (formatted display value) — but the registry shape is what M2+ editors/pickers
 *       extend. All painters write `textContent` unless the column opts into `html` (G13/XSS).
 * When: Used by BodyRenderer for every cell.
 */
import { formatValue } from '../format/formatters.js';
import { parseBool } from '../format/parse.js';
import { el, setText } from '../util/dom.js';

/**
 * Paint a formatted display value into a cell.
 * @param {HTMLElement} cellEl
 * @param {object} ctx {value, column, row, index}
 */
function paintText(cellEl, ctx) {
    const display = formatValue(ctx.column.format, ctx.value);
    if (ctx.column.html) {
        // Explicit, caller-sanitised opt-in (G13). Default path never touches innerHTML.
        cellEl.innerHTML = display;
    } else {
        setText(cellEl, display);
    }
}

/**
 * Paint the 1-based row ordinal into a serial gutter cell (value comes from position).
 * @param {HTMLElement} cellEl
 * @param {object} ctx {index}
 */
function paintSerial(cellEl, ctx) {
    setText(cellEl, ctx.index + 1);
}

/**
 * Paint a computed FormulaColumn cell (M4): the display of its formatted value, plus a marker
 * class so themes can distinguish a derived cell. Identical value path to text — the value is the
 * server-authoritative (or optimistic) computed number already in the row.
 * @param {HTMLElement} cellEl
 * @param {object} ctx
 */
function paintFormula(cellEl, ctx) {
    cellEl.classList.add('lgrid-cell--formula');
    setText(cellEl, formatValue(ctx.column.format, ctx.value));
}

/**
 * Paint a picker cell's LABEL (M5): embedded options map value→label; otherwise the row's
 * `_labels` bag (the pick's echoed label / a hook enrichment) — so painting NEVER queries.
 * Falls back to the raw value (visible data beats a blank) when no label is known.
 * @param {HTMLElement} cellEl
 * @param {object} ctx {value, column, row}
 */
function paintSelect(cellEl, ctx) {
    const value = ctx.value;
    let label = '';
    if (value != null && value !== '') {
        const options = ctx.column.options || [];
        const hit = options.find((o) => String(o.value) === String(value));
        label = hit
            ? hit.label
            : (ctx.row && ctx.row._labels && ctx.row._labels[ctx.column.key]) || String(value);
    }
    setText(cellEl, label);
}

/**
 * Paint a checkbox cell (M5): a CSS-drawn mark (no HTML string — G13) + aria-checked.
 * @param {HTMLElement} cellEl
 * @param {object} ctx {value, column}
 */
function paintCheckbox(cellEl, ctx) {
    const on = parseBool(ctx.value);
    cellEl.textContent = '';
    cellEl.appendChild(el('span', 'lgrid-check' + (on ? ' lgrid-check--on' : '')));
    cellEl.setAttribute('aria-checked', on ? 'true' : 'false');
}

/**
 * Paint the per-row action buttons (P7). Buttons render ONLY for actions present in the
 * row's server-baked `_actions` bag (visibility/permission already resolved); each carries
 * its name + row key as data attributes for the ActionRunner's delegated click.
 * @param {HTMLElement} cellEl
 * @param {object} ctx
 */
function paintActions(cellEl, ctx) {
    cellEl.textContent = '';
    cellEl.dataset.col = '_actions';
    cellEl.dataset.row = ctx.row._k;
    const bag = ctx.row._actions || {};
    for (const meta of ctx.column.actions || []) {
        if (!(meta.name in bag)) {
            continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lgrid-action';
        button.dataset.action = meta.name;
        button.dataset.row = ctx.row._k;
        button.title = meta.label;
        button.setAttribute('aria-label', meta.label);
        button.textContent = meta.icon || meta.label;
        cellEl.appendChild(button);
    }
}

/**
 * Paint the bulk selector gutter (P7): a static box the ActionRunner toggles; the checked
 * state paints as the cell's `lgrid-cell--checked` class (reasserted after body renders).
 * @param {HTMLElement} cellEl
 * @param {object} ctx
 */
function paintRowselect(cellEl, ctx) {
    cellEl.textContent = '';
    cellEl.dataset.col = '_select';
    cellEl.dataset.row = ctx.row._k;
    cellEl.setAttribute('role', 'checkbox');
    cellEl.appendChild(el('span', 'lgrid-check'));
}

const PAINTERS = {
    text: paintText,
    serial: paintSerial,
    formula: paintFormula,
    select: paintSelect,
    checkbox: paintCheckbox,
    actions: paintActions,
    rowselect: paintRowselect,
};

/**
 * Resolve the painter for a column, falling back to text.
 * @param {string} painterId
 * @returns {(cellEl: HTMLElement, ctx: object) => void}
 */
export function painterFor(painterId) {
    return PAINTERS[painterId] || paintText;
}

/**
 * Register (or override) a painter — the public extension point for custom column types.
 * @param {string} painterId
 * @param {(cellEl: HTMLElement, ctx: object) => void} fn
 */
export function registerPainter(painterId, fn) {
    PAINTERS[painterId] = fn;
}
