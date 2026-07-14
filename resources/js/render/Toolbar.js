/**
 * What: The package-rendered toolbar (P6) — global search box, grid-level filter controls and
 *       the column-chooser slot, built INSIDE the wire:ignore mount from `layout.toolbar`.
 *
 * Why:  The zero-blade-config rule: a host declares ->searchable()/->filters() on the Grid and
 *       gets working controls with no page wiring (the old pattern — host-rendered inputs
 *       dispatching `lgrid:toolbar` events — still works and stays supported for custom chrome;
 *       hosts using it chain ->toolbar(false)). Controls render only when both the config
 *       enables them AND the grid has the capability: search/filters need a server-side grid
 *       (they drive the QueryPipeline through PageSource); the chooser slot works everywhere.
 *       Per-page selection stays in the PaginationBar — rendering it twice would be noise.
 *
 * When: Constructed by GridCore after installServerData (it needs the PageSource); hidden
 *       entirely when nothing qualifies.
 */
import { el } from '../util/dom.js';

export default class Toolbar {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {{toolbar: HTMLElement}} refs
     * @param {object|null} pageSource server-side driver (null on in-memory grids)
     * @param {Array<object>} filters the grid-level filter configs ({key, label, kind, options})
     */
    constructor(store, refs, pageSource, filters, bus = null, runner = null, actions = {}) {
        this.store = store;
        this.refs = refs;
        this.pageSource = pageSource;
        this.filters = Array.isArray(filters) ? filters : [];
        this.bus = bus;
        this.runner = runner;
        this.actions = actions || {};
        this.chooserSlot = null;
        this.searchTimer = null;
        this.offChecked = null;
    }

    /** Build the enabled controls; leaves the container hidden when nothing rendered. */
    render() {
        const spec = this.store.layout.toolbar;
        const host = this.refs.toolbar;
        if (!spec || !host) {
            return;
        }
        host.textContent = '';
        let any = false;

        if (spec.search && this.pageSource) {
            host.appendChild(this.buildSearch());
            any = true;
        }

        if (spec.filters && this.pageSource && this.filters.length) {
            for (const filter of this.filters) {
                host.appendChild(this.buildFilter(filter));
            }
            any = true;
        }

        // Bulk bar (P7): appears while any row is checked; hosts the count, select-all/clear
        // and the bulk action buttons.
        if (this.runner && (this.actions.bulk || []).length) {
            this.bulkBar = el('span', 'lgrid-toolbar-bulk');
            this.bulkBar.hidden = true;
            host.appendChild(this.bulkBar);
            if (this.bus) {
                this.offChecked = this.bus.on('checked:changed', () => this.renderBulkBar());
            }
            any = true;
        }

        // Toolbar action buttons (P7): url actions navigate, call actions round-trip.
        if (this.runner && (this.actions.toolbar || []).length) {
            for (const meta of this.actions.toolbar) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'lgrid-toolbar-btn';
                button.textContent = (meta.icon ? meta.icon + ' ' : '') + meta.label;
                button.addEventListener('click', () => this.runner.runToolbar(meta, button));
                host.appendChild(button);
            }
            any = true;
        }

        host.appendChild(el('div', 'lgrid-toolbar-spacer'));

        if (spec.chooser) {
            // The ColumnChooser mounts its own button here (GridCore passes this slot).
            this.chooserSlot = el('span', 'lgrid-toolbar-chooser');
            host.appendChild(this.chooserSlot);
            any = true;
        }

        host.hidden = !any;
    }

    /** Debounced global search → PageSource.search (same channel as `lgrid:toolbar`). */
    buildSearch() {
        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'lgrid-toolbar-search';
        input.placeholder = 'Search…';
        input.setAttribute('aria-label', 'Search grid');
        input.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.pageSource.search(input.value), 300);
        });
        this.searchInput = input;
        return input;
    }

    /**
     * One declared filter as a labelled select — 'select' kind lists its options behind an
     * "All" blank; 'ternary' offers All/Yes/No. Changes route through PageSource.setFilter,
     * the same whitelisted server pipeline as the header funnels.
     */
    buildFilter(filter) {
        const wrap = el('label', 'lgrid-toolbar-filter');
        wrap.appendChild(el('span', 'lgrid-toolbar-filter-label', filter.label || filter.key));

        const select = document.createElement('select');
        select.className = 'lgrid-toolbar-select';
        select.setAttribute('aria-label', filter.label || filter.key);

        const add = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        };

        if (filter.kind === 'ternary') {
            add('', 'All');
            add('yes', 'Yes');
            add('no', 'No');
        } else {
            add('', 'All');
            // PHP serializes options as EITHER a {value: label} map (assoc array — the pluck()
            // idiom) or a list of {value, label} objects / scalars. Normalise all three.
            const raw = filter.options || {};
            const entries = Array.isArray(raw)
                ? raw.map((o) => (o && typeof o === 'object' ? [o.value, o.label] : [o, o]))
                : Object.entries(raw);
            for (const [value, label] of entries) {
                add(String(value), String(label));
            }
        }

        select.addEventListener('change', () => {
            this.pageSource.setFilter(filter.key, select.value === '' ? null : select.value);
        });

        wrap.appendChild(select);
        return wrap;
    }

    /** Repaint the bulk bar from the checked set. */
    renderBulkBar() {
        if (!this.bulkBar) {
            return;
        }
        const count = this.store.checked.size;
        this.bulkBar.hidden = count === 0;
        this.bulkBar.textContent = '';
        if (count === 0) {
            return;
        }
        this.bulkBar.appendChild(el('span', 'lgrid-toolbar-bulk-count', count + ' selected'));

        const mk = (label, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lgrid-toolbar-btn';
            b.textContent = label;
            b.addEventListener('click', fn);
            this.bulkBar.appendChild(b);
            return b;
        };
        mk('Select all', () => this.store.checkAll());
        mk('Clear', () => this.store.clearChecked());
        for (const meta of this.actions.bulk || []) {
            const b = mk((meta.icon ? meta.icon + ' ' : '') + meta.label, () => this.runner.runBulk(meta, b));
            b.classList.add('lgrid-toolbar-btn--bulk');
        }
    }

    destroy() {
        if (this.offChecked) {
            this.offChecked();
        }
        clearTimeout(this.searchTimer);
        if (this.refs.toolbar) {
            this.refs.toolbar.textContent = '';
            this.refs.toolbar.hidden = true;
        }
    }
}
