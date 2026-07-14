/**
 * What: The client half of the actions system (P7) — runs row / bulk / toolbar actions:
 *       button clicks in the actions cell, the keyboard actions menu (ContextMenu /
 *       Shift+F10), the bulk selector gutter, confirms, and the gridAction RPC round trip
 *       with its refetch (readonly) / reseed (editable) follow-up.
 *
 * Why:  The client never builds a URL and never names a method — it echoes the action NAME
 *       (+ row keys) to the host, which re-authorizes and re-resolves everything. URL actions
 *       navigate to the server-baked `_actions` URL; call actions round-trip; a `confirm`
 *       rides the grid's own PopupManager so the flow stays keyboard-first.
 *
 * When: Constructed by GridCore when the config declares any actions.
 */
import { el } from '../util/dom.js';

export default class ActionRunner {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../render/Renderer').default} renderer
     * @param {import('../core/EventBus').default} bus
     * @param {{root: HTMLElement, body: HTMLElement}} refs
     * @param {{wire: object|null, popup: object|null, pageSource: object|null, sync: object|null, announcer: object|null, actions: object}} deps
     */
    constructor(store, renderer, bus, refs, deps) {
        this.store = store;
        this.renderer = renderer;
        this.bus = bus;
        this.refs = refs;
        this.deps = deps;
        this.actions = deps.actions || {};
        this.offs = [];
    }

    init() {
        // One delegated click serves the action buttons AND the bulk selector gutter.
        this.onClick = (e) => {
            const button = e.target.closest('.lgrid-action');
            if (button && this.refs.body.contains(button)) {
                e.preventDefault();
                e.stopPropagation();
                this.runRow(button.dataset.action, button.dataset.row, button);
                return;
            }
            const selectCell = e.target.closest('.lgrid-cell[data-col="_select"]');
            if (selectCell && this.refs.body.contains(selectCell) && selectCell.dataset.row) {
                e.preventDefault();
                this.store.toggleChecked(selectCell.dataset.row);
            }
        };
        this.refs.body.addEventListener('click', this.onClick);

        // Checked visuals survive full body repaints.
        this.offs.push(this.bus.on('checked:changed', () => this.paintChecked()));
        this.offs.push(this.bus.on('body:did-render', () => this.paintChecked()));
    }

    /** Reflect the checked set as cell classes on the selector gutter. */
    paintChecked() {
        for (const row of this.store.rows) {
            const cell = this.renderer.cellElFor(row._k, '_select');
            if (cell) {
                cell.classList.toggle('lgrid-cell--checked', this.store.checked.has(row._k));
            }
        }
    }

    /** Meta for a named row action. */
    rowMeta(name) {
        return (this.actions.row || []).find((a) => a.name === name) || null;
    }

    /** Run a row action from its button (or the menu): url → navigate, call → confirm + RPC. */
    runRow(name, rowKey, anchorEl) {
        const meta = this.rowMeta(name);
        const hit = this.store.rowByKey && this.store.rowByKey.get(rowKey);
        const bag = hit && hit.row._actions ? hit.row._actions : {};
        if (!meta || !(name in bag)) {
            return;
        }

        if (meta.kind === 'url') {
            const url = bag[name];
            if (typeof url === 'string' && url !== '') {
                window.location.assign(url);
            }
            return;
        }

        this.confirmThen(meta, anchorEl, () => this.call(name, [rowKey]));
    }

    /** Run a toolbar action (no row context). */
    runToolbar(meta, anchorEl) {
        if (meta.kind === 'url') {
            if (typeof meta.url === 'string' && meta.url !== '') {
                window.location.assign(meta.url);
            }
            return;
        }
        this.confirmThen(meta, anchorEl, () => this.call(meta.name, []));
    }

    /** Run a bulk action over the checked keys. */
    runBulk(meta, anchorEl) {
        const keys = [...this.store.checked];
        if (!keys.length) {
            return;
        }
        this.confirmThen(meta, anchorEl, () => this.call(meta.name, keys, { clearChecked: true }));
    }

    /** Show the action's confirm in the shared popup (Enter = confirm, Esc = cancel), else run now. */
    confirmThen(meta, anchorEl, run) {
        if (!meta.confirm || !this.deps.popup) {
            run();
            return;
        }
        const popup = this.deps.popup;
        const container = popup.open({
            anchorEl: anchorEl || this.refs.root,
            owner: 'actions-confirm',
            className: 'lgrid-popup--confirm',
            onRequestClose: () => popup.close('owner'),
        });
        container.appendChild(el('div', 'lgrid-confirm-text', meta.confirm));
        const bar = el('div', 'lgrid-confirm-actions');
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'lgrid-confirm-btn';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => popup.close('owner'));
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'lgrid-confirm-btn lgrid-confirm-btn--primary';
        ok.textContent = meta.label || 'Confirm';
        ok.addEventListener('click', () => {
            popup.close('owner');
            run();
        });
        bar.appendChild(cancel);
        bar.appendChild(ok);
        container.appendChild(bar);
        ok.focus();
    }

    /**
     * The gridAction RPC + follow-up: refetch the current page (readonly), adopt the reseed
     * payload (editable), announce refusals.
     */
    call(name, keys, opts = {}) {
        if (!this.deps.wire || typeof this.deps.wire.gridAction !== 'function') {
            return Promise.resolve();
        }
        return this.deps.wire.gridAction(this.store.name, name, keys).then((response) => {
            const r = response || {};
            if (!r.ok) {
                this.announce(r.message || 'Action refused.');
                return;
            }
            if (opts.clearChecked) {
                this.store.clearChecked();
            }
            if (r.refetch && this.deps.pageSource) {
                this.deps.pageSource.refresh();
            }
            if (Array.isArray(r.rows)) {
                if (this.deps.sync) {
                    this.deps.sync.reset();
                }
                this.store.reseed(r.rows);
                this.bus.emit('footer:changed', { footer: r.footer || {} });
            }
        }).catch(() => {
            this.announce('Action failed.');
        });
    }

    /** The keyboard actions menu for the ACTIVE row (ContextMenu / Shift+F10). */
    openMenu() {
        const active = this.store.active;
        if (!active || !this.deps.popup) {
            return;
        }
        const hit = this.store.rowByKey.get(active.rowKey);
        const bag = hit && hit.row._actions ? hit.row._actions : {};
        const available = (this.actions.row || []).filter((meta) => meta.name in bag);
        if (!available.length) {
            return;
        }

        const anchor = this.renderer.cellElFor(active.rowKey, active.colKey) || this.refs.root;
        const popup = this.deps.popup;
        const container = popup.open({
            anchorEl: anchor,
            owner: 'actions-menu',
            className: 'lgrid-popup--actions',
            onRequestClose: () => popup.close('owner'),
        });
        for (const meta of available) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'lgrid-popup-option';
            item.textContent = (meta.icon ? meta.icon + ' ' : '') + meta.label;
            item.addEventListener('click', () => {
                popup.close('owner');
                this.runRow(meta.name, active.rowKey, anchor);
            });
            container.appendChild(item);
        }
        const first = container.querySelector('button');
        if (first) {
            first.focus();
        }
    }

    announce(message) {
        if (this.deps.announcer) {
            this.deps.announcer.message(message);
        }
    }

    destroy() {
        if (this.onClick) {
            this.refs.body.removeEventListener('click', this.onClick);
        }
        for (const off of this.offs) {
            off();
        }
        this.offs = [];
    }
}
