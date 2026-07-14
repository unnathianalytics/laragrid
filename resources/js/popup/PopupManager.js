/**
 * What: The single layered popup per grid (plan §2.4, stack-of-one): one absolutely-positioned
 *       element anchored to a cell rect, holding whatever the current owner renders into it —
 *       a select option list, an async search result list, or a paste confirm. Opening it closes
 *       whatever was open; it closes itself on outside pointerdown, on grid scroll, and on
 *       destroy.
 * Why:  The R4 lesson, systematized: a mouse click into a popup used to race the editor's
 *       blur-commit (blur fires before click — the form-kit combobox fought this with a 100 ms
 *       deferred close). Here the popup OWNS `pointerdown` and calls preventDefault(), so focus
 *       never leaves the editor input and blur never fires for popup interactions — the click
 *       then lands on the option normally. One popup element (never one per cell/editor) keeps
 *       the DOM flat and guarantees at most one popup exists, matching the single floating
 *       editor. It is a child of the grid ROOT (position:relative), not the scroll container,
 *       so the scroll clip can't cut it off.
 * When: Constructed by GridCore for editable grids; owned per-open by the picker editors and
 *       the paste confirm.
 */
export default class PopupManager {
    /**
     * @param {{root: HTMLElement, scroll: HTMLElement, popup: HTMLElement}} refs
     */
    constructor(refs) {
        this.refs = refs;
        this.openFor = null; // opaque owner token while open
        this.onRequestClose = null;

        // Own pointerdown before blur (R4): preventDefault keeps focus on the editor input, so
        // no blur-commit races the option click. Capture phase so it beats any inner handler.
        this.onPopupPointerDown = (e) => {
            e.preventDefault();
        };
        this.refs.popup.addEventListener('pointerdown', this.onPopupPointerDown, true);

        // Outside pointerdown closes the popup (the editor's own blur/commit flow then proceeds
        // naturally for wherever the user clicked). Bound only while open.
        this.onDocPointerDown = (e) => {
            if (!this.refs.popup.contains(e.target)) {
                this.close('outside');
            }
        };

        // Grid scroll invalidates the anchor rect — close rather than chase it (Excel behaviour).
        this.onScroll = () => this.close('scroll');
    }

    isOpen() {
        return this.openFor !== null;
    }

    /**
     * Open (or re-own) the popup anchored to a cell element. Returns the popup element for the
     * owner to fill — the content is cleared on every open.
     *
     * @param {{anchorEl: HTMLElement, owner: string, className?: string, onRequestClose?: (reason: string) => void}} opts
     * @returns {HTMLElement}
     */
    open(opts) {
        if (this.isOpen()) {
            this.close('reopen');
        }

        const popup = this.refs.popup;
        popup.textContent = '';
        popup.className = 'lgrid-popup' + (opts.className ? ' ' + opts.className : '');
        popup.hidden = false;

        this.openFor = opts.owner || 'anon';
        this.onRequestClose = opts.onRequestClose || null;
        this.anchorEl = opts.anchorEl;

        this.position();

        document.addEventListener('pointerdown', this.onDocPointerDown, true);
        this.refs.scroll.addEventListener('scroll', this.onScroll, { passive: true });

        return popup;
    }

    /**
     * (Re)position below the anchor, flipping above when the space below the anchor inside the
     * viewport can't fit the popup but the space above can. Call again after filling content —
     * the height isn't known until then.
     */
    position() {
        if (!this.isOpen() || !this.anchorEl || !this.anchorEl.isConnected) {
            return;
        }
        const popup = this.refs.popup;
        const rootRect = this.refs.root.getBoundingClientRect();
        const anchor = this.anchorEl.getBoundingClientRect();

        // Width: at least the anchor cell, capped by CSS max-width.
        popup.style.minWidth = `${Math.ceil(anchor.width)}px`;

        // Horizontal: align to the anchor's left edge, clamped inside the root.
        const left = Math.max(0, Math.min(anchor.left - rootRect.left, rootRect.width - popup.offsetWidth));
        popup.style.left = `${left}px`;

        // Vertical: below by default; flip above when below overflows the viewport and above fits.
        const height = popup.offsetHeight;
        const spaceBelow = window.innerHeight - anchor.bottom;
        const openAbove = spaceBelow < height + 8 && anchor.top - rootRect.top > height + 8;
        popup.style.top = openAbove
            ? `${anchor.top - rootRect.top - height}px`
            : `${anchor.bottom - rootRect.top}px`;
    }

    /**
     * Close the popup (if open) and notify the owner. `reason` ∈ 'outside' | 'scroll' |
     * 'reopen' | 'owner' | 'destroy' — owners use it to decide whether to also cancel the edit.
     */
    close(reason = 'owner') {
        if (!this.isOpen()) {
            return;
        }
        const notify = this.onRequestClose;
        this.openFor = null;
        this.onRequestClose = null;
        this.anchorEl = null;

        const popup = this.refs.popup;
        popup.hidden = true;
        popup.textContent = '';

        document.removeEventListener('pointerdown', this.onDocPointerDown, true);
        this.refs.scroll.removeEventListener('scroll', this.onScroll);

        if (notify) {
            notify(reason);
        }
    }

    destroy() {
        this.close('destroy');
        this.refs.popup.removeEventListener('pointerdown', this.onPopupPointerDown, true);
    }
}
