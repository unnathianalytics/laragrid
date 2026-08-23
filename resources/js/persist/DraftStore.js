/**
 * IndexedDB-backed recovery for opt-in editable grids.
 *
 * A draft is working state, not a successful database save: acknowledged edits remain here until
 * GridCore.markSaved()/commitAndSave() or an authoritative reseed clears them.
 */
export default class DraftStore {
    constructor(spec, store, sync, bus, refs, options = {}) {
        this.spec = spec && spec.mode === 'local' && spec.key ? spec : null;
        this.store = store;
        this.sync = sync;
        this.bus = bus;
        this.refs = refs;
        this.key = this.spec ? `lgrid:draft:${this.spec.key}` : null;
        this.dbName = options.dbName || 'laragrid';
        this.maxAge = options.maxAge || 30 * 24 * 60 * 60 * 1000;
        this.debounceMs = options.debounceMs || 150;
        this.backend = options.backend || null;
        this.timer = null;
        this.dbPromise = null;
        this.destroyed = false;
        this.restoring = false;
        this.candidate = null;
        this.subscriptions = [];

        this.onRestore = () => this.restoreCandidate();
        this.onDiscard = () => this.discardCandidate();
        this.onVisibility = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                this.saveNow();
            }
        };
        this.onPageHide = () => this.saveNow();
        this.onBeforeUnload = (event) => {
            if (!this.store.hasUnsavedChanges() && !this.sync.hasPending()) {
                return;
            }
            event.preventDefault();
            event.returnValue = '';
        };
    }

    async init() {
        // Every editable grid gets a last-resort navigation warning while dirty. IndexedDB
        // recovery remains opt-in because row data may be sensitive.
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this.onBeforeUnload);
            this.unloadInstalled = true;
        }
        if (!this.key || (!this.backend && typeof indexedDB === 'undefined')) {
            return false;
        }

        this.subscriptions = [
            this.bus.on('edit-state', () => this.schedule()),
            this.bus.on('rows:changed', () => this.schedule()),
            this.bus.on('errors:changed', () => this.schedule()),
            this.bus.on('sync-state', () => this.schedule()),
            this.bus.on('active:changed', () => this.schedule()),
        ];

        if (this.refs.draftRestore) {
            this.refs.draftRestore.addEventListener('click', this.onRestore);
        }
        if (this.refs.draftDiscard) {
            this.refs.draftDiscard.addEventListener('click', this.onDiscard);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', this.onPageHide);
        }

        try {
            const draft = await this.read();
            if (!draft) {
                return true;
            }
            if (draft.schema !== this.schemaFingerprint()
                || Date.now() - Number(draft.updatedAt || 0) > this.maxAge) {
                await this.remove();
                return true;
            }
            // Never replace edits made while IndexedDB was opening.
            if (this.store.hasUnsavedChanges() || this.sync.hasPending()) {
                this.schedule();
                return true;
            }
            this.candidate = draft;
            this.showCandidate(draft);
            return true;
        } catch (error) {
            this.bus.emit('draft-state', { status: 'unavailable', error: String(error) });
            return false;
        }
    }

    schemaFingerprint() {
        const shape = this.store.columns.map((column) => ({
            key: column.key,
            editable: !!column.editable,
            kind: column.parse && column.parse.kind,
        }));
        const input = JSON.stringify(shape);
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return `${this.store.name}:${(hash >>> 0).toString(16)}`;
    }

    snapshot() {
        return {
            key: this.key,
            schema: this.schemaFingerprint(),
            updatedAt: Date.now(),
            rows: this.store.rows.map((row) => ({
                ...row,
                _labels: row._labels ? { ...row._labels } : undefined,
            })),
            active: this.store.active ? { ...this.store.active } : null,
            dirty: [...this.store.dirty],
            modified: [...this.store.modified],
            structureModified: this.store.structureModified,
            errors: [...this.store.errors.entries()],
            cellRevisions: [...this.store.cellRevisions.entries()],
            seqCounter: this.store.seqCounter,
            version: this.store.version,
            queue: this.sync.snapshotQueue(),
        };
    }

    schedule() {
        if (!this.key || this.destroyed || this.restoring) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.saveNow();
        }, this.debounceMs);
    }

    async saveNow() {
        if (!this.key || this.destroyed || this.restoring) {
            return;
        }
        try {
            if (!this.store.hasUnsavedChanges() && !this.sync.hasPending()) {
                await this.remove();
                this.bus.emit('draft-state', { status: 'clear' });
                return;
            }
            const draft = this.snapshot();
            await this.write(draft);
            this.bus.emit('draft-state', { status: 'saved', updatedAt: draft.updatedAt });
        } catch (error) {
            this.bus.emit('draft-state', { status: 'failed', error: String(error) });
        }
    }

    async restoreCandidate() {
        const draft = this.candidate;
        if (!draft || draft.schema !== this.schemaFingerprint()) {
            return false;
        }
        this.restoring = true;
        const mountVersion = this.store.version;
        try {
            this.sync.reset();
            this.store.reseed(Array.isArray(draft.rows) ? draft.rows : []);
            this.store.dirty = new Set(draft.dirty || []);
            this.store.modified = new Set(draft.modified || []);
            this.store.structureModified = !!draft.structureModified;
            this.store.errors = new Map(draft.errors || []);
            this.store.cellRevisions = new Map(draft.cellRevisions || []);
            this.store.seqCounter = Number(draft.seqCounter) || 0;
            this.store.version = mountVersion;
            if (draft.active && this.store.rowByKey.has(draft.active.rowKey)) {
                this.store.setActive(draft.active);
            }
            this.bus.emit('errors:changed', { errors: this.store.errors, keys: [...this.store.errors.keys()] });
            this.store.emitEditState();
            this.candidate = null;
            this.hideCandidate();
            this.bus.emit('draft-state', { status: 'restored', updatedAt: draft.updatedAt });

            await this.sync.beginRecovery(async () => {
                if (!this.sync.wire || typeof this.sync.wire.gridRestoreDraft !== 'function') {
                    const error = new Error('The Livewire host does not expose gridRestoreDraft().');
                    error.retryable = false;
                    throw error;
                }
                const response = await this.sync.wire.gridRestoreDraft(this.store.name, {
                    baseVersion: this.store.version,
                    rows: draft.rows || [],
                });
                this.applyServerRestore(response || {}, draft);
            });
        } finally {
            this.restoring = false;
        }
        this.schedule();
        return true;
    }

    applyServerRestore(response, draft) {
        const rows = Array.isArray(response.rows) ? response.rows : (draft.rows || []);
        const active = this.store.active ? { ...this.store.active } : null;
        this.store.reseed(rows);
        this.store.version = Number(response.version) || 0;
        this.store.modified = new Set(draft.modified || []);
        this.store.structureModified = !!draft.structureModified;
        // Any draft — including a cell-only draft from an older build — remains unsaved.
        if (this.store.modified.size === 0 && !this.store.structureModified) {
            this.store.structureModified = true;
        }
        this.store.errors.clear();
        for (const result of response.results || []) {
            for (const [rowKey, columns] of Object.entries(result.errors || {})) {
                for (const [colKey, message] of Object.entries(columns || {})) {
                    this.store.errors.set(this.store.errorKey(rowKey, colKey), message);
                }
            }
        }
        if (active && this.store.rowByKey.has(active.rowKey)) {
            this.store.setActive(active);
        }
        this.bus.emit('errors:changed', { errors: this.store.errors, keys: [...this.store.errors.keys()] });
        if (response.footer) {
            this.bus.emit('footer:changed', { footer: response.footer });
        }
        this.store.emitEditState();
    }

    async discardCandidate() {
        this.candidate = null;
        this.hideCandidate();
        await this.remove();
        this.bus.emit('draft-state', { status: 'discarded' });
    }

    showCandidate(draft) {
        if (!this.refs.draftBar) {
            return;
        }
        const time = new Date(Number(draft.updatedAt) || Date.now()).toLocaleString();
        if (this.refs.draftMessage) {
            this.refs.draftMessage.textContent = `Unsaved grid changes from ${time} were found.`;
        }
        this.refs.draftBar.hidden = false;
    }

    hideCandidate() {
        if (this.refs.draftBar) {
            this.refs.draftBar.hidden = true;
        }
    }

    openDb() {
        if (this.dbPromise) {
            return this.dbPromise;
        }
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('drafts')) {
                    db.createObjectStore('drafts', { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Could not open draft storage.'));
        });
        return this.dbPromise;
    }

    async read() {
        if (this.backend) {
            return this.backend.get(this.key);
        }
        return this.transaction('readonly', (store) => store.get(this.key));
    }

    async write(draft) {
        if (this.backend) {
            return this.backend.put(this.key, draft);
        }
        return this.transaction('readwrite', (store) => store.put(draft));
    }

    async remove() {
        if (!this.key || (!this.backend && typeof indexedDB === 'undefined')) {
            return;
        }
        if (this.backend) {
            return this.backend.delete(this.key);
        }
        return this.transaction('readwrite', (store) => store.delete(this.key));
    }

    async transaction(mode, operation) {
        const db = await this.openDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('drafts', mode);
            const request = operation(transaction.objectStore('drafts'));
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('Draft storage operation failed.'));
            transaction.onabort = () => reject(transaction.error || new Error('Draft storage transaction aborted.'));
        });
    }

    async clear() {
        this.candidate = null;
        this.hideCandidate();
        await this.remove();
        this.bus.emit('draft-state', { status: 'clear' });
    }

    destroy() {
        this.destroyed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.subscriptions.forEach((off) => off());
        if (this.refs.draftRestore) {
            this.refs.draftRestore.removeEventListener('click', this.onRestore);
        }
        if (this.refs.draftDiscard) {
            this.refs.draftDiscard.removeEventListener('click', this.onDiscard);
        }
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', this.onPageHide);
            if (this.unloadInstalled) {
                window.removeEventListener('beforeunload', this.onBeforeUnload);
            }
        }
    }
}
