/**
 * Incremental edit-state painter and accessible validation navigator.
 *
 * Work is proportional to changed/errored/pending cells, never row-count × column-count. The
 * summary exposes the actual messages and every entry focuses its cell.
 */
import { toggleClass, cellMapKey, splitCellMapKey } from '../util/dom.js';

let errorPainterInstance = 0;

export default class ErrorPainter {
    constructor(store, renderer, bus, refs) {
        this.store = store;
        this.renderer = renderer;
        this.bus = bus;
        this.refs = refs;
        this.paintedErrors = new Set();
        this.paintedDirty = new Set();
        this.paintedPending = new Set();
        this.changedKeys = new Set();
        this.frame = null;
        this.errorEntries = [];
        this.errorIds = new Map();
        this.currentError = 0;
        this.lastErrorCount = 0;
        this.instanceId = ++errorPainterInstance;

        this.offErrors = bus.on('errors:changed', () => this.errorsChanged());
        this.offDirty = bus.on('dirty:changed', ({ rowKey, colKey }) => {
            this.schedule([cellMapKey(rowKey, colKey)]);
        });
        this.offSync = bus.on('sync-state', ({ cells = [] } = {}) => {
            this.schedule(cells.map(({ rowKey, colKey }) => cellMapKey(rowKey, colKey)));
        });
        this.offRows = bus.on('rows:changed', () => this.reassert());
        this.offWindow = bus.on('body:window-rendered', () => this.reassert());
        this.offEditor = bus.on('editor:opened', () => this.paintEditorError());

        this.onKeyDown = (event) => this.handleKey(event);
        this.onReview = () => this.togglePanel();
        this.onPrev = () => this.moveError(-1);
        this.onNext = () => this.moveError(1);
        this.onListClick = (event) => {
            const button = event.target.closest('[data-lgrid-error-index]');
            if (button) {
                this.focusError(Number(button.dataset.lgridErrorIndex));
            }
        };
        this.refs.root.addEventListener('keydown', this.onKeyDown);
        if (this.refs.errorReview) {
            this.refs.errorReview.addEventListener('click', this.onReview);
        }
        if (this.refs.errorPrev) {
            this.refs.errorPrev.addEventListener('click', this.onPrev);
        }
        if (this.refs.errorNext) {
            this.refs.errorNext.addEventListener('click', this.onNext);
        }
        if (this.refs.errorList) {
            this.refs.errorList.addEventListener('click', this.onListClick);
        }
        this.errorsChanged();
        this.reassert();
    }

    handleKey(event) {
        if ((event.ctrlKey || event.metaKey) && (event.key === 'e' || event.key === 'E')) {
            event.preventDefault();
            this.focusError(this.currentError);
        }
    }

    schedule(keys = []) {
        keys.forEach((key) => key && this.changedKeys.add(key));
        if (this.frame !== null) {
            return;
        }
        const request = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (callback) => setTimeout(callback, 0);
        this.frame = request(() => {
            this.frame = null;
            const changed = [...this.changedKeys];
            this.changedKeys.clear();
            changed.forEach((key) => this.paintKey(key));
        });
    }

    paintKey(key) {
        const address = splitCellMapKey(key);
        if (!address) {
            return;
        }
        const cell = this.renderer.cellElFor(address.rowKey, address.colKey);
        if (!cell) {
            return;
        }
        const error = this.store.errors.get(key) || null;
        const dirty = this.store.dirty.has(key);
        const pending = this.store.pending.has(key);
        toggleClass(cell, 'lgrid-cell--error', !!error);
        toggleClass(cell, 'lgrid-cell--dirty', dirty);
        toggleClass(cell, 'lgrid-cell--pending', pending);
        this.track(this.paintedErrors, key, !!error);
        this.track(this.paintedDirty, key, dirty);
        this.track(this.paintedPending, key, pending);

        if (error) {
            cell.setAttribute('aria-invalid', 'true');
            cell.setAttribute('title', error);
            const id = this.errorIds.get(key);
            if (id) {
                cell.setAttribute('aria-errormessage', id);
                cell.setAttribute('aria-describedby', id);
            }
        } else {
            cell.removeAttribute('aria-invalid');
            cell.removeAttribute('aria-errormessage');
            cell.removeAttribute('aria-describedby');
            cell.removeAttribute('title');
        }
    }

    track(set, key, on) {
        if (on) {
            set.add(key);
        } else {
            set.delete(key);
        }
    }

    errorsChanged() {
        const next = new Set([...this.store.errors.keys()].filter((key) => splitCellMapKey(key)));
        this.renderErrorPanel();
        this.schedule(new Set([...this.paintedErrors, ...next]));
        this.updateFooterCount();
        this.paintEditorError();
    }

    orderedErrors() {
        const entries = [];
        for (const [key, message] of this.store.errors) {
            const address = splitCellMapKey(key);
            if (address) {
                const hit = this.store.rowByKey.get(address.rowKey);
                const column = this.store.columnByKey(address.colKey);
                entries.push({
                    key,
                    rowKey: hit ? address.rowKey : null,
                    colKey: hit && column ? address.colKey : null,
                    row: hit ? hit.index + 1 : '?',
                    rowIndex: hit ? hit.index : Number.MAX_SAFE_INTEGER,
                    colIndex: column ? this.store.colIndexOf(address.colKey) : Number.MAX_SAFE_INTEGER,
                    column: column ? (column.label || column.key) : address.colKey,
                    message,
                });
                continue;
            }
            const rowKey = key.endsWith('_row') ? key.slice(0, -4) : null;
            const hit = rowKey ? this.store.rowByKey.get(rowKey) : null;
            const first = this.store.visibleColumns()[0];
            entries.push({
                key,
                rowKey: hit ? rowKey : null,
                colKey: hit && first ? first.key : null,
                row: hit ? hit.index + 1 : '?',
                rowIndex: hit ? hit.index : Number.MAX_SAFE_INTEGER,
                colIndex: -1,
                column: hit ? 'Row' : 'Grid',
                message,
            });
        }
        return entries.sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
    }

    renderErrorPanel() {
        this.errorEntries = this.orderedErrors();
        this.errorIds.clear();
        if (!this.refs.errorList) {
            return;
        }
        const fragment = document.createDocumentFragment();
        this.errorEntries.forEach((entry, index) => {
            const item = document.createElement('li');
            const button = document.createElement('button');
            const id = this.errorId(entry.key);
            button.type = 'button';
            button.id = id;
            button.dataset.lgridErrorIndex = String(index);
            button.className = 'lgrid-error-item';
            button.textContent = 'Row ' + entry.row + ' · ' + entry.column + ' — ' + entry.message;
            item.appendChild(button);
            fragment.appendChild(item);
            this.errorIds.set(entry.key, id);
        });
        this.refs.errorList.textContent = '';
        this.refs.errorList.appendChild(fragment);
        if (this.refs.errorPanel && !this.refs.errorPanel.id) {
            this.refs.errorPanel.id = 'lgrid-errors-' + this.instanceId + '-' + this.safeId(this.store.name);
        }
        if (this.refs.errorReview && this.refs.errorPanel) {
            this.refs.errorReview.setAttribute('aria-controls', this.refs.errorPanel.id);
        }
        this.currentError = Math.min(this.currentError, Math.max(0, this.errorEntries.length - 1));
    }

    errorId(key) {
        return 'lgrid-error-' + this.instanceId + '-' + this.safeId(this.store.name + '-' + key);
    }

    safeId(value) {
        return encodeURIComponent(String(value)).replace(/%/g, '').replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    updateFooterCount() {
        const count = this.store.errors.size;
        this.refs.root.classList.toggle('lgrid--has-errors', count > 0);
        if (this.refs.errorCount) {
            this.refs.errorCount.textContent = String(count);
        }
        if (this.refs.errorReview) {
            this.refs.errorReview.hidden = count === 0;
            this.refs.errorReview.setAttribute(
                'aria-label',
                count + (count === 1 ? ' grid error. Review error.' : ' grid errors. Review errors.'),
            );
        }
        if (this.refs.errorPrev) {
            this.refs.errorPrev.disabled = count === 0;
        }
        if (this.refs.errorNext) {
            this.refs.errorNext.disabled = count === 0;
        }
        if (count === 0 && this.refs.errorPanel) {
            this.refs.errorPanel.hidden = true;
        }
        if (count > this.lastErrorCount && this.refs.announcer) {
            this.refs.announcer.textContent = count + (count === 1
                ? ' validation error. Open Review errors for details.'
                : ' validation errors. Open Review errors for details.');
        }
        this.lastErrorCount = count;
    }

    togglePanel() {
        if (!this.refs.errorPanel || !this.errorEntries.length) {
            return;
        }
        const opening = this.refs.errorPanel.hidden;
        this.refs.errorPanel.hidden = !opening;
        if (this.refs.errorReview) {
            this.refs.errorReview.setAttribute('aria-expanded', opening ? 'true' : 'false');
        }
        if (opening) {
            const first = this.refs.errorList && this.refs.errorList.querySelector('button');
            if (first) {
                first.focus();
            }
        }
    }

    moveError(delta) {
        if (!this.errorEntries.length) {
            return;
        }
        this.currentError = (
            this.currentError + delta + this.errorEntries.length
        ) % this.errorEntries.length;
        this.focusError(this.currentError);
    }

    focusError(index = 0) {
        if (!this.errorEntries.length) {
            return;
        }
        this.currentError = Math.max(0, Math.min(index, this.errorEntries.length - 1));
        const entry = this.errorEntries[this.currentError];
        if (entry.rowKey && entry.colKey) {
            this.store.setActive({ rowKey: entry.rowKey, colKey: entry.colKey });
            this.refs.root.focus({ preventScroll: true });
        }
    }

    jumpToFirstError() {
        this.focusError(0);
    }

    paintEditorError() {
        if (!this.refs.editor || this.refs.editor.hidden) {
            return;
        }
        const key = cellMapKey(this.store.active?.rowKey || '', this.store.active?.colKey || '');
        const message = this.store.errors.get(key);
        const input = this.refs.editor.querySelector('input, select, textarea, [contenteditable="true"]');
        const old = this.refs.editor.querySelector('.lgrid-cell-editor-error');
        if (old) {
            old.remove();
        }
        if (!input) {
            return;
        }
        if (!message) {
            input.removeAttribute('aria-invalid');
            input.removeAttribute('aria-describedby');
            return;
        }
        const error = document.createElement('div');
        error.className = 'lgrid-cell-editor-error';
        error.id = this.errorId(key) + '-editor';
        error.textContent = message;
        this.refs.editor.appendChild(error);
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', error.id);
    }

    /** Re-apply state after BodyRenderer replaces cell DOM, touching state keys only. */
    reassert() {
        this.paintedErrors.clear();
        this.paintedDirty.clear();
        this.paintedPending.clear();
        this.schedule(new Set([
            ...this.store.errors.keys(),
            ...this.store.dirty,
            ...this.store.pending,
        ]));
    }

    destroy() {
        this.refs.root.removeEventListener('keydown', this.onKeyDown);
        if (this.refs.errorReview) this.refs.errorReview.removeEventListener('click', this.onReview);
        if (this.refs.errorPrev) this.refs.errorPrev.removeEventListener('click', this.onPrev);
        if (this.refs.errorNext) this.refs.errorNext.removeEventListener('click', this.onNext);
        if (this.refs.errorList) this.refs.errorList.removeEventListener('click', this.onListClick);
        [this.offErrors, this.offDirty, this.offSync, this.offRows, this.offWindow, this.offEditor]
            .filter(Boolean)
            .forEach((off) => off());
        if (this.frame !== null) {
            const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
            cancel(this.frame);
        }
    }
}
