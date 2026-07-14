/**
 * What: The op queue for an editable grid — enqueues ops from the store's optimistic mutations,
 *       flushes them to the server per the grid's SyncPolicy, and reconciles the authoritative
 *       response (write-backs, errors, footer, version) back into the store.
 * Why:  "Optimistic client, authoritative server" (plan §2.1): the store already painted the edit;
 *       this module is the ONLY write channel to the server (§2.5.1). It batches ops (so rapid
 *       typing is one round-trip, not N), flushes on the policy's trigger (PerCell / PerRow /
 *       Deferred), marks cells pending while in flight, and hands the response to store.reconcile
 *       — which skips cells the user has since re-edited (by dirty flag) so a slow reply never
 *       clobbers newer input (R4). The body is repainted through the store's cell/rows events,
 *       never morphed (R3). Failures retry with backoff; the op stays queued until acknowledged.
 * When: Constructed by GridCore for an editable grid with a live $wire; the EditorManager +
 *       KeyboardManager enqueue through it; the host calls flush() before save() under Deferred.
 */
export default class SyncManager {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../core/EventBus').default} bus
     * @param {object} wire the Livewire $wire proxy (async gridOps)
     */
    constructor(store, bus, wire) {
        this.store = store;
        this.bus = bus;
        this.wire = wire;
        this.policy = (store.layout && store.layout.sync) || 'per-cell';
        /** @type {Array<object>} ops awaiting flush. */
        this.queue = [];
        /** True while a gridOps request is in flight. */
        this.inFlight = false;
        this.retryDelay = 0;
        this.destroyed = false;
        /** Bumped by reset(): a response from an earlier epoch is discarded, never reconciled. */
        this.epoch = 0;
    }

    /**
     * Enqueue an op (recorded in the store's op log too — the undo/redo spine) and trigger a flush
     * per policy. `cells` are the cell addresses this op marks pending, for reconciliation.
     *
     * @param {object} op the wire op ({seq, t, row?, col?, v?, after?, as?, rows?})
     * @param {Array<{rowKey: string, colKey: string}>} [cells]
     * @param {{flush?: boolean}} [opts] force a flush regardless of policy (row ops flush now)
     */
    enqueue(op, cells = [], opts = {}) {
        this.queue.push({ op, cells });
        this.store.opLog.push(op);
        if (cells.length) {
            this.store.markPending(cells);
        }

        if (opts.flush || this.policy === 'per-cell' || this.policy === 'per-row') {
            // PerCell + PerRow both flush eagerly here; a PerRow caller only enqueues on row change,
            // so the trigger is the same call site — the policy governs WHEN callers enqueue-flush.
            this.flush();
        }
        // Deferred: hold until flush() is called explicitly (host save / row op).
    }

    /**
     * Enqueue MANY staged ops as one unit (a TSV paste: row inserts + cell sets) and flush them
     * in a single round-trip. Each item is {op, cells} exactly as enqueue() takes; the batch
     * always flushes immediately (like the M4 row ops) — a paste is a deliberate bulk action,
     * not a keystroke to defer.
     *
     * @param {Array<{op: object, cells: Array<{rowKey: string, colKey: string}>}>} items
     */
    enqueueBatch(items) {
        for (const { op, cells } of items) {
            this.queue.push({ op, cells });
            this.store.opLog.push(op);
            if (cells && cells.length) {
                this.store.markPending(cells);
            }
        }
        if (items.length) {
            this.flush();
        }
    }

    /**
     * Flush all queued ops as one batch to gridOps and reconcile the response. Coalesces rapid
     * calls: if a request is already in flight, the new ops stay queued for the next flush.
     */
    async flush() {
        if (this.destroyed || this.inFlight || this.queue.length === 0 || !this.wire) {
            return;
        }
        const batchItems = this.queue.splice(0, this.queue.length);
        const ops = batchItems.map((b) => b.op);
        const epoch = this.epoch;
        this.inFlight = true;
        this.bus.emit('sync-state', { flushing: true, pending: this.store.pending.size });

        try {
            const response = await this.wire.gridOps(this.store.name, {
                baseVersion: this.store.version,
                ops,
            });
            if (epoch !== this.epoch) {
                // A reseed superseded this batch mid-flight: its write-backs/errors describe
                // rows the store no longer holds — discard, never reconcile.
                return;
            }
            this.retryDelay = 0;
            this.store.reconcile(response || { version: this.store.version, results: [], footer: {} });

            // Structural-failure rollback (P6): a failed insert/remove/dup/stale-row op carries
            // the server's authoritative rows snapshot — the client applied the op optimistically,
            // so its row STRUCTURE has drifted. Adopt the snapshot wholesale (reset drops the op
            // queue: those ops describe rows that no longer exist) and tell the host layer so it
            // can announce the refusal.
            const rollback = ((response && response.results) || []).find(
                (result) => !result.ok && Array.isArray(result.rows),
            );
            if (rollback) {
                this.reset();
                this.store.reseed(rollback.rows);
                let message = 'Change refused — grid resynced.';
                for (const cols of Object.values(rollback.errors || {})) {
                    const first = Object.values(cols || {})[0];
                    if (first) {
                        message = first;
                        break;
                    }
                }
                this.bus.emit('rows:rolled-back', { message });
            }

            if (response && response.footer) {
                this.bus.emit('footer:changed', { footer: response.footer });
            }
        } catch (error) {
            if (epoch !== this.epoch) {
                return; // superseded by a reseed — the ops are moot, don't requeue
            }
            // Requeue the failed batch (front) and retry with capped backoff; typing continues.
            this.queue.unshift(...batchItems);
            this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 300, 5000);
            this.bus.emit('sync-state', { error: true });
            if (!this.destroyed) {
                this.retryTimer = setTimeout(() => this.flush(), this.retryDelay);
            }
        } finally {
            this.inFlight = false;
            this.bus.emit('sync-state', { flushing: false, pending: this.store.pending.size });
            // Drain any ops enqueued while this batch was in flight.
            if (this.queue.length && !this.destroyed) {
                this.flush();
            }
        }
    }

    /**
     * Called when the active ROW changes (PerRow policy) — flushes the queue so a completed row's
     * edits reach the server together. A no-op under PerCell (already flushed) / Deferred (waits).
     */
    onActiveRowChanged() {
        if (this.policy === 'per-row') {
            this.flush();
        }
    }

    /** True when there are unsynced ops (dirty). Used by the host to decide whether to flush pre-save. */
    hasPending() {
        return this.queue.length > 0 || this.inFlight;
    }

    /**
     * Drop every queued (unflushed) op and orphan any in-flight batch (epoch bump): a host
     * reseed (`lgrid:reseed`) supersedes the rows those ops describe, so applying — or
     * retrying — them against the reseeded store would only manufacture "row no longer
     * exists" errors.
     */
    reset() {
        this.epoch++;
        this.queue = [];
        this.retryDelay = 0;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.bus.emit('sync-state', { flushing: false, pending: 0 });
    }

    destroy() {
        this.destroyed = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
    }
}
