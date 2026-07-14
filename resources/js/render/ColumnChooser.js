/**
 * What: The hide/show column chooser (M7) — a small grid-owned "⚙" button at the grid's
 *       top-right opening a PopupManager checklist of columns, plus the "Reset layout" action
 *       that clears every operator override (widths + hidden) and the persisted entry.
 * Why:  Visibility is operator layout state, exactly like widths: it lives in the store
 *       (`userHidden`, separate from the definition's static `visible` flag so reset restores
 *       the declared layout precisely), persists through the same LayoutStore entry, and rides
 *       the same single relayout path (GridCore.onColumnLayoutChanged). Frozen columns and the
 *       serial gutter are shown but locked — hiding a frozen column would silently reshuffle
 *       the sticky offsets operators anchor on.
 * When: Constructed by GridCore whenever the grid has a popup ref; works in every mode.
 */
export default class ColumnChooser {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {{root: HTMLElement, popup: HTMLElement}} refs
     * @param {import('../popup/PopupManager').default} popup
     * @param {import('../persist/LayoutStore').default} layoutStore
     * @param {{onChange: () => void, container?: HTMLElement}} hooks GridCore's relayout
     *        callback + an optional mount container (the toolbar's chooser slot); defaults
     *        to the grid root (the classic floating top-right button).
     */
    constructor(store, refs, popup, layoutStore, hooks) {
        this.store = store;
        this.refs = refs;
        this.popup = popup;
        this.layoutStore = layoutStore;
        this.onChange = hooks.onChange;
        this.hooksContainer = hooks.container || null;
        this.closedByOutsideAt = 0;
    }

    init() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lgrid-chooser-btn';
        button.textContent = '⚙';
        button.title = 'Columns';
        button.setAttribute('aria-label', 'Choose columns');
        button.setAttribute('aria-haspopup', 'true');
        this.button = button;
        (this.hooksContainer || this.refs.root).appendChild(button);

        // Own the pointerdown (the sort/filter-control idiom): preventDefault keeps focus off
        // the button, so the grid root never gains focus through it — a focusin would seed the
        // active cell, whose scroll-into-view fires the scroll event that CLOSES the popup
        // (the flake the full-suite run exposed). stopPropagation keeps M2 selection out too.
        this.onPointerDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.pointerHandledAt = Date.now();
            // The document capture listener already closed an open popup as an 'outside'
            // pointerdown — treat that as the toggle-close, don't instantly reopen.
            if (Date.now() - this.closedByOutsideAt < 300) {
                return;
            }
            if (this.isOpen()) {
                this.popup.close('owner');
                return;
            }
            this.open();
        };
        button.addEventListener('pointerdown', this.onPointerDown);

        // Keyboard activation (Tab + Enter/Space) arrives as a click with no preceding
        // pointerdown of ours — serve it; ignore the synthetic click that trails a handled
        // pointerdown.
        this.onClick = () => {
            if (Date.now() - (this.pointerHandledAt || 0) < 300) {
                return;
            }
            if (Date.now() - this.closedByOutsideAt < 300) {
                return;
            }
            this.open();
        };
        button.addEventListener('click', this.onClick);

        this.onKeydown = (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                e.stopPropagation();
                this.popup.close('owner');
            }
        };
        button.addEventListener('keydown', this.onKeydown);
    }

    isOpen() {
        return this.popup.isOpen() && this.popup.openFor === 'chooser';
    }

    open() {
        const container = this.popup.open({
            anchorEl: this.button,
            owner: 'chooser',
            className: 'lgrid-popup--chooser',
            onRequestClose: (reason) => {
                if (reason === 'outside') {
                    this.closedByOutsideAt = Date.now();
                }
            },
        });
        this.renderList(container);
        this.popup.position(); // re-measure now the checklist gives the popup its height
    }

    /** Build (or rebuild, after reset) the checklist + reset action into the popup. */
    renderList(container) {
        container.textContent = '';

        const list = document.createElement('div');
        list.className = 'lgrid-chooser';

        for (const column of this.store.columns) {
            if (column.visible === false) {
                continue; // definition-hidden — never offered to the operator
            }
            const lockedReason = column.type === 'serial' || column.frozen;

            const item = document.createElement('label');
            item.className = 'lgrid-chooser-item' + (lockedReason ? ' lgrid-chooser-item--locked' : '');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = !this.store.userHidden.has(column.key);
            checkbox.disabled = lockedReason;
            checkbox.dataset.col = column.key;
            checkbox.addEventListener('change', () => this.setHidden(column.key, !checkbox.checked));

            const label = document.createElement('span');
            label.textContent = column.label || column.key;

            item.append(checkbox, label);
            list.appendChild(item);
        }

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'lgrid-chooser-reset';
        reset.textContent = 'Reset layout';
        reset.addEventListener('click', () => this.reset());

        container.append(list, reset);
    }

    /** Hide/show one column, persist, and relayout through the single GridCore path. */
    setHidden(colKey, hidden) {
        if (hidden) {
            this.store.userHidden.add(colKey);
        } else {
            this.store.userHidden.delete(colKey);
        }
        this.applyChange();
        this.layoutStore.save(this.store.widthOverrides, [...this.store.userHidden]);
        this.emitVisibility();
    }

    /** Clear every operator layout override (widths + hidden) and the persisted entry. */
    reset() {
        this.store.userHidden.clear();
        this.store.widthOverrides = {};
        this.layoutStore.reset();
        this.applyChange();
        this.emitVisibility();
        if (this.isOpen()) {
            this.renderList(this.refs.popup); // reflect the reset in the open checklist
        }
    }

    /** Drop a now-unresolvable active cell, then hand relayout+repaint to GridCore. */
    applyChange() {
        const active = this.store.active;
        if (active && this.store.colIndexOf(active.colKey) < 0) {
            this.store.active = null;
            this.store.anchor = null;
            this.store.selection = null;
            this.store.bus.emit('active:changed', { active: null });
            this.store.bus.emit('selection:changed', { selection: null });
        }
        this.onChange();
    }

    emitVisibility() {
        this.refs.root.dispatchEvent(
            new CustomEvent('lgrid:column-visibility', {
                detail: { grid: this.store.name, hidden: [...this.store.userHidden] },
                bubbles: true,
            }),
        );
    }

    destroy() {
        if (this.button) {
            this.button.removeEventListener('pointerdown', this.onPointerDown);
            this.button.removeEventListener('click', this.onClick);
            this.button.removeEventListener('keydown', this.onKeydown);
            this.button.remove();
        }
    }
}
