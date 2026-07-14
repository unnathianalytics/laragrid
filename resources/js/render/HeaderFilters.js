/**
 * What: The in-header filter menus (M7) — a delegated click engine over the header funnel
 *       buttons: clicking one opens the PopupManager anchored to its header cell and renders
 *       the attached filter's control by `kind` ('select' → an option list with an "All" clear
 *       row; 'ternary' → All/Yes/No). Picking routes through PageSource.setFilter, the same
 *       server pipeline the toolbar bridge uses.
 * Why:  Filters were server-complete since M3 but had no grid-owned UI — hosts had to build
 *       toolbar controls. Anchoring them on the column header is the register idiom operators
 *       expect, and interpreting the DECLARATIVE {kind, options} fragment keeps the client
 *       type-agnostic (a new filter kind ships a renderer case, nothing more). The value state
 *       lives in store.query.filters — the PageSource's source of truth — so the funnel's
 *       active paint (HeaderRenderer.updateFilterIndicators) and the menu's current-value tick
 *       can never disagree with what the server actually filtered by.
 * When: Constructed by GridCore.installServerData for server-side grids with a popup ref.
 */
export default class HeaderFilters {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {{head: HTMLElement, popup: HTMLElement}} refs
     * @param {import('../popup/PopupManager').default} popup
     * @param {import('../sync/PageSource').default} pageSource
     */
    constructor(store, refs, popup, pageSource) {
        this.store = store;
        this.refs = refs;
        this.popup = popup;
        this.pageSource = pageSource;
    }

    init() {
        // Capture phase (the sort-control pattern): the funnel click must never fall through to
        // M2 whole-column selection on the same header cell.
        this.onPointerDown = (e) => {
            const btn = e.target.closest('.lgrid-filter');
            if (!btn || !this.refs.head.contains(btn)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            this.openMenu(btn);
        };
        this.refs.head.addEventListener('pointerdown', this.onPointerDown, true);
    }

    /** The current query value for a filter key (undefined when unset). */
    currentValue(filterKey) {
        return ((this.store.query && this.store.query.filters) || {})[filterKey];
    }

    openMenu(btn) {
        const column = this.store.columnByKey(btn.dataset.col);
        const filter = column && column.filter;
        if (!filter) {
            return;
        }

        const container = this.popup.open({
            anchorEl: btn.closest('.lgrid-headcell') || btn,
            owner: 'filter',
            className: 'lgrid-popup--filter',
        });

        if (filter.kind === 'ternary') {
            this.renderOptions(container, filter, [
                { value: '', label: 'All' },
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
            ]);
        } else {
            // 'select' (and the fallback for unknown kinds carrying an options map).
            const options = [{ value: '', label: 'All' }];
            for (const [value, label] of Object.entries(filter.options || {})) {
                options.push({ value: String(value), label: String(label) });
            }
            this.renderOptions(container, filter, options);
        }

        this.popup.position(); // re-measure now the list gives the popup its height
    }

    /**
     * Render a one-pick option list: the current value is ticked; a pick sets the filter (''
     * clears it via PageSource) and closes the menu.
     * @param {HTMLElement} container
     * @param {object} filter the declarative {key, label, kind, options} fragment
     * @param {Array<{value: string, label: string}>} options
     */
    renderOptions(container, filter, options) {
        const current = this.currentValue(filter.key);
        const currentNormalised = current === undefined || current === null ? '' : String(current);

        for (const option of options) {
            const row = document.createElement('div');
            row.className = 'lgrid-popup-option';
            if (option.value === currentNormalised) {
                row.classList.add('lgrid-popup-option--active');
            }
            row.textContent = option.label;
            row.addEventListener('click', () => {
                this.pageSource.setFilter(filter.key, option.value);
                this.popup.close('owner');
            });
            container.appendChild(row);
        }
    }

    destroy() {
        if (this.onPointerDown) {
            this.refs.head.removeEventListener('pointerdown', this.onPointerDown, true);
        }
    }
}
