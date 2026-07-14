/**
 * What: Row activation for a readonly grid — Enter (via the KeyboardManager's onActivate hook) or
 *       a double-click on a data row dispatches a bubbling `lgrid:activate` CustomEvent from the
 *       grid root ({grid, row, url}). The host (outside wire:ignore) handles it — typically a
 *       full-page navigation to the row's edit screen.
 * Why:  Master lists (Items/Accounts/…) need a keyboard- and mouse-friendly "open this row" gesture
 *       that a readonly grid never had (the editor's dblclick handler is editable-only). Routing
 *       stays host-owned: the URL is resolved server-side per row (`_activateUrl`, baked by
 *       RowSerializer) and this engine only relays it — it never builds a URL or knows what it
 *       means. Mirrors the established `lgrid:complete`/`lgrid:toolbar`/`lgrid:reseed` event seams.
 * When: Constructed by GridCore.init() for every grid; a no-op unless `layout.rowActivate` is set.
 *       Enter is wired through KeyboardManager (so the excel keymap's move-down still wins for a
 *       non-activatable row); double-click is owned here.
 */
export default class RowActivator {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../render/Renderer').default} renderer
     * @param {import('../selection/SelectionManager').default} selection
     * @param {{root: HTMLElement, body: HTMLElement}} refs
     */
    constructor(store, renderer, selection, refs) {
        this.store = store;
        this.renderer = renderer;
        this.selection = selection;
        this.refs = refs;
        this.enabled = !!(store.layout && store.layout.rowActivate);
        this.onDblClick = this.handleDblClick.bind(this);
    }

    /** True once GridCore should route Enter here — i.e. a readonly, row-activate grid. */
    isEnabled() {
        return this.enabled;
    }

    init() {
        if (!this.enabled) {
            return;
        }
        this.refs.body.addEventListener('dblclick', this.onDblClick);
    }

    destroy() {
        this.refs.body.removeEventListener('dblclick', this.onDblClick);
    }

    /**
     * Double-click on a data cell → activate that row. Resolve the clicked row from the DOM (a
     * click on row padding / the header / empty space resolves to nothing and is ignored); pad
     * rows (Busy dedicated blanks) are inert. The click already set the active cell via
     * SelectionManager's pointerdown, so `activate()` reads the same row.
     */
    handleDblClick(e) {
        const cell = e.target.closest('.lgrid-cell');
        if (!cell || !this.refs.body.contains(cell)) {
            return;
        }
        const rowEl = cell.closest('.lgrid-row');
        if (!rowEl || rowEl.classList.contains('lgrid-row--pad')) {
            return;
        }
        this.activate(rowEl.dataset.k);
    }

    /**
     * Activate the given row key (or the active row when omitted — the Enter path): dispatch
     * `lgrid:activate` when that row carries a non-null `_activateUrl`. Returns true when an event
     * was dispatched, so KeyboardManager knows Enter was handled (else it falls through to the
     * keymap's move-down).
     *
     * @param {string} [rowKey]
     * @returns {boolean}
     */
    activate(rowKey) {
        if (!this.enabled) {
            return false;
        }
        const key = rowKey != null ? rowKey : this.store.active && this.store.active.rowKey;
        if (key == null) {
            return false;
        }
        const hit = this.store.rowByKey.get(key);
        const row = hit ? hit.row : null;
        const url = row ? row._activateUrl : null;
        if (!url) {
            return false;
        }
        this.refs.root.dispatchEvent(new CustomEvent('lgrid:activate', {
            bubbles: true,
            detail: { grid: this.store.name, row, url },
        }));
        return true;
    }
}
