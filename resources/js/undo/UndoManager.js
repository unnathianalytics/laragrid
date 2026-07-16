/**
 * What: The undo/redo engine for an editable grid (Ctrl+Z / Ctrl+Y). It records every optimistic
 *       store mutation as a typed before/after record (the recorder seam StateStore exposes),
 *       groups the records of one synchronous task into ONE undo step (a paste of 200 cells, a
 *       fill-down, a commit plus its whenFilled sibling mirrors — each undoes as a single step),
 *       and replays inverses through the SAME op pipeline every ordinary edit uses.
 * Why:  The op log was always "the undo/redo spine" (plan §1.4) — this module completes it.
 *       Undo must never become a second write channel: an undone cell is just a new `set` op
 *       carrying the before value, an undone insert is a `remove`, an undone remove is an
 *       `insert` (positioned via the op's `before` key) plus `set`s for the writable snapshot
 *       values — so the server re-validates, re-runs hooks and recomputes formulas exactly as
 *       if the operator had typed the restoration. Server-derived write-backs reconcile on top,
 *       and a structural refusal still triggers the standard rollback (which clears history via
 *       the reseed seam — entries describing dead rows are never replayed).
 * When: Constructed by GridCore.installEditing for an editable grid; StateStore.recorder points
 *       here; KeyboardManager routes the undo/redo chords to undo()/redo().
 */
import { cellMapKey } from '../util/dom.js';

export default class UndoManager {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../sync/SyncManager').default} sync
     * @param {{announce?: (msg: string) => void, limit?: number}} [hooks]
     */
    constructor(store, sync, hooks = {}) {
        this.store = store;
        this.sync = sync;
        this.announce = hooks.announce || (() => {});
        /** Max retained undo steps — beyond it the oldest step falls off. */
        this.limit = hooks.limit || 100;
        /** @type {Array<Array<object>>} sealed batches, oldest first. */
        this.undoStack = [];
        /** @type {Array<Array<object>>} batches undone and re-applicable, newest last. */
        this.redoStack = [];
        /** The batch currently accumulating this task's records (sealed on microtask end). */
        this.batch = null;
        /** True while replaying — replay mutations must never record themselves. */
        this.applying = false;
    }

    /**
     * Record one store mutation (the StateStore recorder seam). Records arriving within one
     * synchronous task coalesce into a single undo step; the microtask boundary seals it.
     *
     * Record shapes:
     *   {t:'set',    rowKey, colKey, before, after}
     *   {t:'label',  rowKey, colKey, before, after}   (picker display labels)
     *   {t:'insert', rowKey, index, snapshot}         (row created — blank or dup clone)
     *   {t:'remove', rowKey, index, snapshot}         (row deleted, full copy incl. _labels)
     *
     * @param {object} entry
     */
    record(entry) {
        if (this.applying) {
            return;
        }
        if (!this.batch) {
            this.batch = [];
            queueMicrotask(() => this.seal());
        }
        this.batch.push(entry);
    }

    /** Seal the open batch into an undo step; any new user edit invalidates the redo stack. */
    seal() {
        if (!this.batch || this.batch.length === 0) {
            this.batch = null;
            return;
        }
        this.undoStack.push(this.batch);
        if (this.undoStack.length > this.limit) {
            this.undoStack.shift();
        }
        this.batch = null;
        this.redoStack = [];
    }

    /** Drop all history — a reseed/rollback replaced the rows these records describe. */
    clear() {
        this.batch = null;
        this.undoStack = [];
        this.redoStack = [];
    }

    canUndo() {
        this.seal();
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }

    /** Undo the most recent step. Returns true when a step was applied. */
    undo() {
        this.seal();
        const batch = this.undoStack.pop();
        if (!batch) {
            this.announce('Nothing to undo.');
            return false;
        }
        const focus = this.applyBatch(batch, true);
        this.redoStack.push(batch);
        this.focusAfter(focus);
        this.announce('Undid the last change.');
        return true;
    }

    /** Re-apply the most recently undone step. Returns true when a step was applied. */
    redo() {
        this.seal();
        const batch = this.redoStack.pop();
        if (!batch) {
            this.announce('Nothing to redo.');
            return false;
        }
        const focus = this.applyBatch(batch, false);
        this.undoStack.push(batch);
        this.focusAfter(focus);
        this.announce('Redid the change.');
        return true;
    }

    /**
     * Replay a batch against the store + stage the equivalent wire ops, flushed as ONE server
     * round-trip. `reverse` = undo (records walked backwards, each inverted); forward = redo.
     *
     * @param {Array<object>} records
     * @param {boolean} reverse
     * @returns {{rowKey: string, colKey: string}|null} the first affected cell (focus target)
     */
    applyBatch(records, reverse) {
        this.applying = true;
        try {
            /** @type {Array<{op: object, cells: Array<{rowKey: string, colKey: string}>}>} */
            const items = [];
            /** Staged set ops by cell, so label records can ride their set op's `label` field. */
            const setOps = new Map();
            /** @type {Array<{key: string, label: string|null}>} */
            const labels = [];
            let focus = null;

            const list = reverse ? [...records].reverse() : records;
            for (const rec of list) {
                switch (rec.t) {
                    case 'set': {
                        const hit = this.store.rowByKey.get(rec.rowKey);
                        if (!hit) {
                            break; // the row is gone — a later (already-undone) step owned it
                        }
                        const value = reverse ? rec.before : rec.after;
                        this.store.applyLocalSet(rec.rowKey, rec.colKey, value);
                        const op = {
                            seq: this.store.nextSeq(),
                            t: 'set',
                            row: rec.rowKey,
                            col: rec.colKey,
                            v: value,
                        };
                        items.push({ op, cells: [{ rowKey: rec.rowKey, colKey: rec.colKey }] });
                        setOps.set(cellMapKey(rec.rowKey, rec.colKey), op);
                        focus = focus || { rowKey: rec.rowKey, colKey: rec.colKey };
                        break;
                    }
                    case 'label': {
                        if (!this.store.rowByKey.has(rec.rowKey)) {
                            break;
                        }
                        const label = reverse ? rec.before : rec.after;
                        this.store.setRowLabel(rec.rowKey, rec.colKey, label == null ? null : label);
                        labels.push({ key: cellMapKey(rec.rowKey, rec.colKey), label });
                        break;
                    }
                    case 'insert':
                        if (reverse) {
                            this.dropRow(rec, items);
                        } else {
                            focus = this.restoreRow(rec, items) || focus;
                        }
                        break;
                    case 'remove':
                        if (reverse) {
                            focus = this.restoreRow(rec, items) || focus;
                        } else {
                            this.dropRow(rec, items);
                        }
                        break;
                    default:
                        break;
                }
            }

            // Attach restored labels to their cell's staged set op (order-independent: under
            // reverse iteration the label record precedes its set record).
            for (const { key, label } of labels) {
                const op = setOps.get(key);
                if (op && label != null) {
                    op.label = label;
                }
            }

            if (items.length) {
                this.sync.enqueueBatch(items);
            }
            return focus;
        } finally {
            this.applying = false;
        }
    }

    /**
     * Remove a recorded row (undo of an insert / redo of a remove) — optimistic removal plus a
     * `remove` op. Missing row → already gone, nothing to do (idempotent, like the server side).
     */
    dropRow(rec, items) {
        if (!this.store.rowByKey.has(rec.rowKey)) {
            return;
        }
        this.store.removeRow(rec.rowKey);
        items.push({ op: { seq: this.store.nextSeq(), t: 'remove', row: rec.rowKey }, cells: [] });
    }

    /**
     * Restore a recorded row snapshot at its original index (undo of a remove / redo of an
     * insert). The client repaints the FULL snapshot; the wire carries an `insert` (positioned
     * with `before` so a row deleted from the top returns to the top) plus one `set` per
     * writable column that must converge — so the server re-validates and re-derives exactly
     * as if the row had been re-entered. Non-writable carriers (formula/readonly/hidden values)
     * stay client-painted and are re-derived server-side by the hooks those sets fire.
     *
     * @returns {{rowKey: string, colKey: string}|null} focus target on the restored row
     */
    restoreRow(rec, items) {
        if (this.store.rowByKey.has(rec.rowKey)) {
            return null; // defensive — never duplicate a live key
        }
        const index = Math.max(0, Math.min(rec.index, this.store.rowCount()));
        const anchor = this.store.rowAt(index);
        const op = { seq: this.store.nextSeq(), t: 'insert', as: rec.rowKey };
        if (anchor) {
            op.before = anchor._k;
        }
        items.push({ op, cells: [] });

        const snapshot = { ...rec.snapshot, _labels: { ...(rec.snapshot._labels || {}) } };
        this.store.restoreRow(snapshot, index);

        const template = (this.store.layout && this.store.layout.newRow) || {};
        let focus = null;
        for (const column of this.store.columns) {
            if (!column || !column.key || column.key.startsWith('_') || !column.writable) {
                continue;
            }
            const value = snapshot[column.key];
            const preset = template[column.key];
            const blank = value == null || value === '';
            if (blank && (preset == null || preset === '')) {
                continue; // a fresh server row is already blank here — nothing to converge
            }
            const setOp = {
                seq: this.store.nextSeq(),
                t: 'set',
                row: rec.rowKey,
                col: column.key,
                v: blank ? null : value,
            };
            const label = snapshot._labels[column.key];
            if (!blank && label != null) {
                setOp.label = label;
            }
            items.push({ op: setOp, cells: [{ rowKey: rec.rowKey, colKey: column.key }] });
            focus = focus || { rowKey: rec.rowKey, colKey: column.key };
        }
        return focus || { rowKey: rec.rowKey, colKey: (this.store.visibleColumns()[0] || {}).key };
    }

    /** Land the active cell on the (first) affected address, when it still resolves. */
    focusAfter(addr) {
        if (!addr || !addr.colKey) {
            return;
        }
        const { row, col } = this.store.indexOf(addr);
        if (row >= 0 && col >= 0) {
            this.store.setActive(addr);
        }
    }
}
