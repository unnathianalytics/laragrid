/**
 * What: Row move by dragging the serial gutter (plan F4, step 4). A press on a gutter cell of
 *       an editable grid that travels 4 px becomes a drag: an insertion line follows the
 *       pointer (`lgrid-row--drop-before` / `--drop-after` on the row under it) and the release
 *       moves the row there through GridCore.rowMoveTo — the same store move, `move` op and undo
 *       record as Alt+Up / Alt+Down. Escape cancels.
 * Why:  Line order is meaning on voucher and quotation screens; the keyboard moves one place at
 *       a time, the drag moves anywhere in one gesture. A press that does not travel stays a
 *       plain click, so the gutter still selects the row through SelectionManager.
 * When: Constructed by GridCore.installEditing for an editable grid.
 */

/** Pointer travel (px) before a gutter press becomes a drag. */
const DRAG_THRESHOLD = 4;

export default class RowDragger {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {{root: HTMLElement, body: HTMLElement}} refs
     * @param {(rowKey: string, toIndex: number) => boolean} moveTo GridCore.rowMoveTo
     */
    constructor(store, refs, moveTo) {
        this.store = store;
        this.refs = refs;
        this.moveTo = moveTo;
        /** {rowKey, x, y, dragging} for the current press, or null. */
        this.press = null;
        /** {rowEl, rowKey, position: 'before'|'after'} the insertion line marks, or null. */
        this.drop = null;
        this.onPointerDown = this.handlePointerDown.bind(this);
        this.onPointerMove = this.handlePointerMove.bind(this);
        this.onPointerUp = this.handlePointerUp.bind(this);
        this.onKeyDown = this.handleKeyDown.bind(this);
    }

    init() {
        this.refs.body.addEventListener('pointerdown', this.onPointerDown);
        if (this.refs.root && this.refs.root.classList) {
            this.refs.root.classList.add('lgrid--row-draggable');
        }
    }

    destroy() {
        this.refs.body.removeEventListener('pointerdown', this.onPointerDown);
        this.end();
    }

    /** A main-button press on a serial gutter cell of a real row arms a possible drag. */
    handlePointerDown(e) {
        if (e.button !== 0 || e.shiftKey || this.store.rowsDeferred) {
            return;
        }
        const cell = e.target && e.target.closest ? e.target.closest('.lgrid-cell') : null;
        const rowEl = cell ? cell.closest('.lgrid-row') : null;
        const rowKey = rowEl && rowEl.dataset ? rowEl.dataset.k : null;
        if (!rowKey || !this.isGutter(cell)) {
            return;
        }
        this.press = { rowKey, x: e.clientX, y: e.clientY, dragging: false };
        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
        window.addEventListener('keydown', this.onKeyDown, true);
    }

    handlePointerMove(e) {
        const press = this.press;
        if (!press) {
            return;
        }
        if (!press.dragging) {
            if (Math.abs(e.clientX - press.x) < DRAG_THRESHOLD && Math.abs(e.clientY - press.y) < DRAG_THRESHOLD) {
                return;
            }
            press.dragging = true;
            this.refs.root.classList.add('lgrid--row-dragging');
        }
        this.markDrop(this.dropAt(e.clientX, e.clientY));
    }

    handlePointerUp() {
        const press = this.press;
        const drop = this.drop;
        this.end();
        if (!press || !press.dragging || !drop || drop.rowKey === press.rowKey) {
            return;
        }
        const from = this.store.rowIndexOf(press.rowKey);
        const at = this.store.rowIndexOf(drop.rowKey);
        if (from < 0 || at < 0) {
            return;
        }
        this.moveTo(press.rowKey, RowDragger.targetIndex(from, at, drop.position));
    }

    handleKeyDown(e) {
        if (e.key === 'Escape' && this.press) {
            e.preventDefault();
            e.stopPropagation();
            this.end();
        }
    }

    /**
     * The final index of a row moved from `from` to before/after the row at `at` (both indexes
     * taken before the move).
     *
     * @param {number} from
     * @param {number} at
     * @param {'before'|'after'} position
     * @returns {number}
     */
    static targetIndex(from, at, position) {
        const slot = position === 'before' ? at : at + 1;
        return slot > from ? slot - 1 : slot;
    }

    /** The row under a viewport point and which half of it the point is in, or null. */
    dropAt(x, y) {
        const hit = document.elementFromPoint(x, y);
        const rowEl = hit && hit.closest ? hit.closest('.lgrid-row') : null;
        const rowKey = rowEl && rowEl.dataset ? rowEl.dataset.k : null;
        if (!rowKey || !this.refs.body.contains(rowEl)) {
            return null;
        }
        const rect = rowEl.getBoundingClientRect();
        return { rowEl, rowKey, position: y < rect.top + rect.height / 2 ? 'before' : 'after' };
    }

    /** Move the insertion line to `next` (null clears it). */
    markDrop(next) {
        const current = this.drop;
        if (current && next && current.rowEl === next.rowEl && current.position === next.position) {
            return;
        }
        if (current) {
            current.rowEl.classList.remove('lgrid-row--drop-before', 'lgrid-row--drop-after');
        }
        if (next) {
            next.rowEl.classList.add(next.position === 'before' ? 'lgrid-row--drop-before' : 'lgrid-row--drop-after');
        }
        this.drop = next;
    }

    /** Disarm the press: listeners off, insertion line and dragging class cleared. */
    end() {
        this.markDrop(null);
        this.press = null;
        if (this.refs.root && this.refs.root.classList) {
            this.refs.root.classList.remove('lgrid--row-dragging');
        }
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('keydown', this.onKeyDown, true);
    }

    /** Whether a body cell is the serial gutter (the row-number column). */
    isGutter(cell) {
        const colKey = cell && cell.dataset ? cell.dataset.c : null;
        const column = colKey ? this.store.columnByKey(colKey) : null;
        return !!(column && column.painter === 'serial');
    }
}
