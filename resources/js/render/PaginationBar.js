/**
 * What: The readonly grid's pagination chrome (M3) — First / Prev / "Page N of M · T rows" /
 *       Next / Last plus an optional page-size select. Client-rendered inside the mount, below
 *       the scroll region; it reads the store's server meta and drives the PageSource.
 * Why:  Server-side pagination needs a control, but it must live in JS-owned DOM (inside the
 *       wire:ignore mount) so a page change never morphs the body (R3). Rendering it from the
 *       store's serverMeta and re-rendering on page:changed keeps it in lockstep with the data
 *       with no Livewire round-trip of its own. Chrome only — all data logic is in PageSource.
 * When: Constructed by GridCore for a server-side grid when a `pagination` ref exists.
 */
import { el, setText } from '../util/dom.js';

export default class PaginationBar {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../core/EventBus').default} bus
     * @param {import('../sync/PageSource').default} source
     * @param {HTMLElement} rootEl the x-ref="pagination" container
     */
    constructor(store, bus, source, rootEl) {
        this.store = store;
        this.bus = bus;
        this.source = source;
        this.rootEl = rootEl;
        this.onPageChanged = () => this.render();
        this.onLoading = ({ loading }) => this.setBusy(loading);
        this.unsub = [bus.on('page:changed', this.onPageChanged), bus.on('loading:changed', this.onLoading)];
    }

    render() {
        const meta = this.store.serverMeta;
        this.rootEl.textContent = '';

        // Adaptive single-page: everything fit on one page — chrome-free by design
        // (->singlePageUpTo). Also covers the deferred-mount placeholder meta.
        if (meta.lastPage <= 1) {
            this.rootEl.hidden = true;
            return;
        }
        this.rootEl.hidden = false;

        // Left: row count + page position.
        const info = el('div', 'lgrid-pg-info');
        setText(
            info,
            meta.total === 0
                ? '0 rows'
                : `Page ${meta.page} of ${meta.lastPage} · ${meta.total.toLocaleString()} rows`,
        );
        this.rootEl.appendChild(info);

        // Right: nav buttons + optional perPage select.
        const nav = el('div', 'lgrid-pg-nav');
        const atFirst = meta.page <= 1;
        const atLast = meta.page >= meta.lastPage;

        nav.appendChild(this.button('«', 'First page', atFirst, () => this.source.goToPage(1)));
        nav.appendChild(this.button('‹', 'Previous page', atFirst, () => this.source.prevPage()));
        nav.appendChild(this.button('›', 'Next page', atLast, () => this.source.nextPage()));
        nav.appendChild(this.button('»', 'Last page', atLast, () => this.source.goToPage(meta.lastPage)));

        const options = ((this.store.layout && this.store.layout.paginate) || {}).options || [];
        if (options.length > 0) {
            nav.appendChild(this.perPageSelect(options, meta.perPage));
        }

        this.rootEl.appendChild(nav);
    }

    /** A single nav button. */
    button(label, title, disabled, onClick) {
        const btn = el('button', 'lgrid-pg-btn', label);
        btn.type = 'button';
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.disabled = !!disabled;
        if (!disabled) {
            btn.addEventListener('click', onClick);
        }
        return btn;
    }

    /** The page-size <select>. */
    perPageSelect(options, current) {
        const select = el('select', 'lgrid-pg-perpage');
        select.setAttribute('aria-label', 'Rows per page');
        for (const size of options) {
            const opt = el('option', undefined, `${size} / page`);
            opt.value = String(size);
            if (Number(size) === Number(current)) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }
        select.addEventListener('change', (e) => this.source.setPerPage(Number(e.target.value)));
        return select;
    }

    setBusy(on) {
        this.rootEl.classList.toggle('lgrid-pg--busy', !!on);
    }

    destroy() {
        this.unsub.forEach((off) => off());
        this.rootEl.textContent = '';
    }
}
