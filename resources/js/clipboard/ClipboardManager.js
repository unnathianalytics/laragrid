/**
 * What: Clipboard interchange. Ctrl+C copies the current selection as TSV — DISPLAY values on a
 *       readonly grid, canonical EDIT text on an editable grid (editTextFor: rupees not paise,
 *       d-m-Y dates, 1/0 booleans, option ids — the values a paste parses back to the same model,
 *       G15). M5 adds paste: TSV from the grid's paste event, mapped from the ANCHOR cell across
 *       the visible EDITABLE columns only, each field parsed + client-validated through the
 *       EditorManager's shared pipeline, applied optimistically and flushed as ONE op batch.
 *       Rows past the end grow via insert ops when the grid auto-appends (user decision M5-Q3);
 *       failed cells are flagged + skipped; > 500 cells asks first via the grid popup.
 * Why:  Accountants live in spreadsheets; block copy in and out of the grid must round-trip
 *       exactly. Parsing/validating each pasted field through the SAME pipeline as typing (M4
 *       follow-up #1) means paste can never write a value typing couldn't. One batch = one
 *       round-trip = one reconcile.
 * When: KeyboardManager invokes copy() on Ctrl+C; GridCore routes the root `paste` event (NAV
 *       mode only — an open editor keeps native input paste) to paste().
 */
import { formatValue } from '../format/formatters.js';
import { editTextFor } from '../format/parse.js';
import { el, setText } from '../util/dom.js';

/** Split TSV text into a field matrix (normalised newlines, trailing newline dropped). */
function parseTsv(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines.map((line) => line.split('\t'));
}

export default class ClipboardManager {
    /** Cell count above which a paste asks for confirmation first (plan G15). */
    static CONFIRM_THRESHOLD = 500;

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
        return grid
            .map((cells) => cells
                .map((cell) => editable
                    ? editTextFor(cell.column, cell.value)
                    : formatValue(cell.column.format, cell.value))
                .join('\t'))
            .join('\n');
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
        this.announce(`Copied ${rows} ${rows === 1 ? 'row' : 'rows'} by ${cols} ${cols === 1 ? 'column' : 'columns'}.`);
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
            this.announce('Nothing to paste here.');
            return;
        }

        if (plan.cells.length > ClipboardManager.CONFIRM_THRESHOLD && ctx.popup) {
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
                    newRowKeys.push('r' + this.store.nextSeq() + Math.random().toString(36).slice(2, 6));
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
            items.push({ op: { seq: this.store.nextSeq(), t: 'insert', as: key }, cells: [] });
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

        let message = `Pasted ${applied} ${applied === 1 ? 'cell' : 'cells'}.`;
        if (skipped) {
            message += ` ${skipped} skipped.`;
        }
        if (plan.clampedRows) {
            message += ` ${plan.clampedRows} ${plan.clampedRows === 1 ? 'row' : 'rows'} beyond the grid dropped.`;
        }
        this.announce(message);
    }

    /** Oversize paste: ask first via the grid popup (keyboard: Enter confirms, Esc cancels). */
    confirmLargePaste(plan, ctx) {
        const anchorEl = ctx.anchorCellEl ? ctx.anchorCellEl() : null;
        if (!anchorEl) {
            return;
        }
        const popupEl = ctx.popup.open({ anchorEl, owner: 'paste-confirm' });

        const wrap = el('div', 'lgrid-confirm');
        const message = el('div');
        setText(message, `Paste ${plan.cells.length} cells${plan.newRowKeys.length ? ` (adding ${plan.newRowKeys.length} rows)` : ''}?`);
        const actions = el('div', 'lgrid-confirm-actions');
        const cancel = el('button', 'lgrid-confirm-btn');
        cancel.type = 'button';
        setText(cancel, 'Cancel');
        const confirm = el('button', 'lgrid-confirm-btn lgrid-confirm-btn--primary');
        confirm.type = 'button';
        setText(confirm, 'Paste');

        confirm.addEventListener('click', () => {
            ctx.popup.close('owner');
            this.applyPaste(plan, ctx);
        });
        cancel.addEventListener('click', () => ctx.popup.close('owner'));
        wrap.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                ctx.popup.close('owner');
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
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).catch(() => this.fallbackWrite(text));
            return;
        }
        this.fallbackWrite(text);
    }

    fallbackWrite(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('aria-hidden', 'true');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
        } catch {
            // Nothing more we can do without user gesture / permission; silently ignore.
        }
        document.body.removeChild(ta);
    }
}
