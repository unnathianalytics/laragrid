/**
 * Reliable optimistic-operation transport for editable grids.
 *
 * The manager owns queueing, one in-flight request, bounded retry/backoff, offline pausing and
 * acknowledgement context. A response is reconciled with the exact submitted cells; an empty
 * server patch is therefore still a complete acknowledgement of a normal SET.
 */
export default class SyncManager {
    constructor(store, bus, wire, options = {}) {
        this.store = store;
        this.bus = bus;
        this.wire = wire;
        this.policy = (store.layout && store.layout.sync) || 'per-cell';
        this.queue = [];
        this.inFlight = false;
        this.inFlightBatch = [];
        this.flushPromise = null;
        this.retryTimer = null;
        this.retryAttempts = 0;
        this.retryDelay = 0;
        this.retryBaseDelay = options.retryBaseDelay || 300;
        this.retryMaxDelay = options.retryMaxDelay || 5000;
        this.maxRetryAttempts = options.maxRetryAttempts || 5;
        this.random = options.random || Math.random;
        this.setTimer = options.setTimer || ((fn, delay) => setTimeout(fn, delay));
        this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
        this.isOnline = options.isOnline || (() => (
            typeof navigator === 'undefined' || navigator.onLine !== false
        ));
        this.status = 'idle';
        this.blocked = false;
        this.lastError = null;
        this.destroyed = false;
        this.epoch = 0;
        this.waiters = [];
        this.recoveryTask = null;

        this.onOffline = () => this.pauseOffline();
        this.onOnline = () => this.retryNow();
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('offline', this.onOffline);
            window.addEventListener('online', this.onOnline);
        }
    }

    enqueue(op, cells = [], opts = {}) {
        this.queue.push({ op, cells });
        this.store.opLog.push(op);
        if (cells.length) {
            this.store.markPending(cells, op.seq);
        }
        this.emitState();

        // Per-row is deliberately held until GridCore observes the active row changing.
        if (opts.flush || this.policy === 'per-cell') {
            this.flush();
        }
    }

    enqueueBatch(items) {
        for (const { op, cells = [] } of items) {
            this.queue.push({ op, cells });
            this.store.opLog.push(op);
            if (cells.length) {
                this.store.markPending(cells, op.seq);
            }
        }
        this.emitState();
        if (items.length) {
            this.flush();
        }
    }

    /** Flush once. Further ops drain only after this request succeeds. */
    flush(options = {}) {
        const force = options.force === true;
        if (this.destroyed || !this.wire) {
            return Promise.resolve(false);
        }
        if (this.recoveryTask) {
            return this.runRecovery();
        }
        if (this.inFlight) {
            return this.flushPromise || Promise.resolve(false);
        }
        if ((this.blocked || this.retryTimer) && !force) {
            return this.flushPromise || Promise.resolve(false);
        }
        if (!this.isOnline()) {
            this.status = 'offline';
            this.emitState();
            return Promise.resolve(false);
        }
        if (this.queue.length === 0) {
            this.status = 'idle';
            this.emitState();
            this.notifyWaiters();
            return Promise.resolve(true);
        }

        if (force) {
            this.clearRetryTimer();
            this.blocked = false;
        }

        const batchItems = this.queue.splice(0, this.queue.length);
        const ops = batchItems.map((item) => item.op);
        const epoch = this.epoch;
        this.inFlight = true;
        this.inFlightBatch = batchItems;
        this.status = 'syncing';
        this.emitState();

        const run = (async () => {
            let succeeded = false;
            try {
                const response = await this.wire.gridOps(this.store.name, {
                    baseVersion: this.store.version,
                    ops,
                });
                if (epoch !== this.epoch) {
                    return false;
                }

                const results = (response && response.results) || [];
                const returned = new Set(results.map((result) => result.seq));
                const missing = ops.find((op) => !returned.has(op.seq));
                if (missing) {
                    const protocolError = new Error(`Grid sync response omitted operation ${missing.seq}.`);
                    protocolError.retryable = false;
                    throw protocolError;
                }
                if (results.some((result) => result.conflict === true)) {
                    this.store.version = Number(response.version) || this.store.version;
                    const conflict = new Error('Grid changed in another request. Review and retry your changes.');
                    conflict.status = 409;
                    conflict.retryable = false;
                    throw conflict;
                }

                succeeded = true;
                this.retryAttempts = 0;
                this.retryDelay = 0;
                this.lastError = null;
                this.blocked = false;
                this.store.reconcile(
                    response || { version: this.store.version, results: [], footer: {} },
                    batchItems,
                );

                const rollback = results.find((result) => !result.ok && Array.isArray(result.rows));
                if (rollback) {
                    this.reset();
                    this.store.reseed(rollback.rows);
                    this.store.version = Number(response.version) || 0;
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
                return true;
            } catch (error) {
                if (epoch !== this.epoch) {
                    return false;
                }
                this.queue.unshift(...batchItems);
                this.lastError = error instanceof Error ? error : new Error(String(error));

                if (!this.isOnline()) {
                    this.status = 'offline';
                } else if (this.isRetryable(this.lastError) && this.retryAttempts < this.maxRetryAttempts) {
                    this.retryAttempts += 1;
                    this.retryDelay = this.nextRetryDelay();
                    this.status = 'retrying';
                    this.scheduleRetry();
                } else {
                    this.status = 'failed';
                    this.blocked = true;
                }
                return false;
            } finally {
                this.inFlight = false;
                this.inFlightBatch = [];
                this.flushPromise = null;
                if (succeeded) {
                    this.status = this.queue.length ? 'syncing' : 'idle';
                }
                this.emitState();

                // Only success drains newly queued work. A failure is owned exclusively by the
                // retry timer/manual retry, preventing the old zero-delay recursive flush storm.
                if (succeeded && this.queue.length && !this.destroyed) {
                    this.flush();
                } else {
                    this.notifyWaiters();
                }
            }
        })();

        this.flushPromise = run;
        return run;
    }

    isRetryable(error) {
        if (error && typeof error.retryable === 'boolean') {
            return error.retryable;
        }
        const status = Number(
            (error && (error.status || error.statusCode))
            || (error && error.response && error.response.status)
            || 0,
        );
        if (status === 0) {
            return true;
        }
        return [408, 425, 429, 502, 503, 504].includes(status);
    }

    nextRetryDelay() {
        const raw = Math.min(
            this.retryBaseDelay * (2 ** Math.max(0, this.retryAttempts - 1)),
            this.retryMaxDelay,
        );
        return Math.max(1, Math.round(raw * (0.8 + (this.random() * 0.4))));
    }

    scheduleRetry() {
        if (this.destroyed || this.retryTimer) {
            return;
        }
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            if (this.recoveryTask) {
                this.runRecovery();
            } else {
                this.flush({ force: true });
            }
        }, this.retryDelay);
    }

    clearRetryTimer() {
        if (this.retryTimer) {
            this.clearTimer(this.retryTimer);
            this.retryTimer = null;
        }
    }

    pauseOffline() {
        if (this.destroyed || !this.hasPending()) {
            return;
        }
        this.clearRetryTimer();
        this.status = 'offline';
        this.emitState();
    }

    retryNow() {
        if (this.destroyed || (!this.hasPending() && !this.blocked)) {
            return Promise.resolve(true);
        }
        this.clearRetryTimer();
        this.retryAttempts = 0;
        this.retryDelay = 0;
        this.blocked = false;
        this.lastError = null;
        if (this.recoveryTask) {
            return this.runRecovery();
        }
        return this.flush({ force: true });
    }

    /** Run a non-op synchronization task (currently authoritative IndexedDB draft hydration). */
    beginRecovery(task) {
        this.recoveryTask = task;
        this.blocked = false;
        this.lastError = null;
        return this.runRecovery();
    }

    runRecovery() {
        if (!this.recoveryTask || this.inFlight || this.destroyed) {
            return this.flushPromise || Promise.resolve(false);
        }
        if (!this.isOnline()) {
            this.status = 'offline';
            this.emitState();
            return Promise.resolve(false);
        }
        this.inFlight = true;
        this.status = 'syncing';
        this.emitState();
        const task = this.recoveryTask;
        const run = (async () => {
            let succeeded = false;
            try {
                await task();
                succeeded = true;
                this.recoveryTask = null;
                this.retryAttempts = 0;
                this.retryDelay = 0;
                this.blocked = false;
                this.lastError = null;
                this.status = 'idle';
                return true;
            } catch (error) {
                this.lastError = error instanceof Error ? error : new Error(String(error));
                if (!this.isOnline()) {
                    this.status = 'offline';
                } else if (this.isRetryable(this.lastError) && this.retryAttempts < this.maxRetryAttempts) {
                    this.retryAttempts += 1;
                    this.retryDelay = this.nextRetryDelay();
                    this.status = 'retrying';
                    this.scheduleRetry();
                } else {
                    this.status = 'failed';
                    this.blocked = true;
                }
                return false;
            } finally {
                this.inFlight = false;
                this.flushPromise = null;
                this.emitState();
                if (succeeded && this.queue.length) {
                    this.flush();
                } else {
                    this.notifyWaiters();
                }
            }
        })();
        this.flushPromise = run;
        return run;
    }

    onActiveRowChanged() {
        if (this.policy === 'per-row') {
            this.flush();
        }
    }

    hasPending() {
        return this.queue.length > 0 || this.inFlight || this.retryTimer !== null || !!this.recoveryTask;
    }

    canSave() {
        return !this.hasPending() && !this.blocked && this.store.errors.size === 0;
    }

    /** Resolve only when every queued/in-flight operation is acknowledged and no errors remain. */
    whenSettled() {
        if (this.blocked) {
            return Promise.reject(this.lastError || new Error('Grid synchronization failed.'));
        }
        if (this.status === 'offline') {
            return Promise.reject(new Error('Grid is offline. Changes are kept locally until connectivity returns.'));
        }
        if (!this.hasPending()) {
            return this.store.errors.size
                ? Promise.reject(new Error(`${this.store.errors.size} grid error(s) must be corrected.`))
                : Promise.resolve(this.state());
        }
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    notifyWaiters() {
        if (!this.waiters.length) {
            return;
        }
        if (this.blocked) {
            const waiters = this.waiters.splice(0);
            waiters.forEach(({ reject }) => reject(this.lastError || new Error('Grid synchronization failed.')));
            return;
        }
        if (this.hasPending()) {
            return;
        }
        const waiters = this.waiters.splice(0);
        if (this.store.errors.size) {
            const error = new Error(`${this.store.errors.size} grid error(s) must be corrected.`);
            waiters.forEach(({ reject }) => reject(error));
        } else {
            const state = this.state();
            waiters.forEach(({ resolve }) => resolve(state));
        }
    }

    state() {
        return {
            status: this.status,
            queued: this.queue.length,
            inFlight: this.inFlightBatch.length,
            pending: this.store.pending.size,
            dirty: this.store.dirty.size,
            modified: this.store.modifiedCount ? this.store.modifiedCount() : 0,
            errors: this.store.errors.size,
            attempts: this.retryAttempts,
            retryIn: this.retryTimer ? this.retryDelay : 0,
            canSave: this.canSave(),
            error: this.lastError ? this.lastError.message : null,
        };
    }

    emitState() {
        this.bus.emit('sync-state', this.state());
    }

    /** Serializable unacknowledged work for DraftStore (includes the request currently in flight). */
    snapshotQueue() {
        const bySeq = new Map();
        [...this.inFlightBatch, ...this.queue].forEach((item) => bySeq.set(item.op.seq, item));
        return [...bySeq.values()].map((item) => ({
            op: { ...item.op },
            cells: (item.cells || []).map((cell) => ({ ...cell })),
        }));
    }

    /** Restore draft ops without duplicating already-live sequences. */
    restoreQueue(items = []) {
        const existing = new Set(this.snapshotQueue().map((item) => item.op.seq));
        for (const item of items) {
            if (!item || !item.op || existing.has(item.op.seq)) {
                continue;
            }
            const cells = Array.isArray(item.cells) ? item.cells : [];
            this.queue.push({ op: { ...item.op }, cells: cells.map((cell) => ({ ...cell })) });
            this.store.opLog.push({ ...item.op });
            this.store.seqCounter = Math.max(this.store.seqCounter, Number(item.op.seq) || 0);
            if (cells.length) {
                this.store.markPending(cells, item.op.seq);
            }
        }
        this.emitState();
    }

    reset() {
        this.epoch += 1;
        this.queue = [];
        this.inFlightBatch = [];
        this.recoveryTask = null;
        this.retryAttempts = 0;
        this.retryDelay = 0;
        this.blocked = false;
        this.lastError = null;
        this.status = 'idle';
        this.clearRetryTimer();
        this.emitState();
        this.notifyWaiters();
    }

    destroy() {
        this.destroyed = true;
        this.clearRetryTimer();
        if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('offline', this.onOffline);
            window.removeEventListener('online', this.onOnline);
        }
        const waiters = this.waiters.splice(0);
        waiters.forEach(({ reject }) => reject(new Error('Grid was destroyed before synchronization completed.')));
    }
}
