/**
 * What: Builds the grid header. With no column groups it is a single row of column headers.
 *       With groups it is a two-ROW grid (not two sibling grids): a grouped column's members
 *       sit in the bottom row under a group-label cell that spans them in the top row, while
 *       an UNGROUPED column's header spans both rows (grid-row: span 2) so it reads as one
 *       tall cell — e.g. "Tax" over CGST/SGST/IGST, with #, GSTIN, Date, Taxable, Total each
 *       a single full-height header.
 * Why:  GST/register headers need grouping (plan §1.4). Building the whole header as ONE CSS
 *       grid sharing the same --lgrid-cols tracks as the body guarantees the header columns
 *       line up exactly with the values below — the earlier two-sibling-grid approach left an
 *       empty spacer cell above each ungrouped column, which visually shoved the labels out of
 *       alignment. One grid + explicit row/column placement removes that class of bug.
 * When: Called once by Renderer on paint.
 */
import { el, toggleClass } from '../util/dom.js';

export default class HeaderRenderer {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('./Layout').default} layout
     * @param {HTMLElement} headEl
     */
    constructor(store, layout, headEl) {
        this.store = store;
        this.layout = layout;
        this.headEl = headEl;
    }

    render() {
        const columns = this.store.visibleColumns();
        // Groups come with start/span recomputed over the VISIBLE columns (M7 hide/show) —
        // the serialized indexes assumed the full column list.
        const groups = this.store.visibleGroups();
        this.headEl.textContent = '';

        if (groups.length > 0) {
            this.renderGrouped(columns, groups);
        } else {
            this.renderFlat(columns);
        }
    }

    /** Single-row header: one cell per column + trailing filler. */
    renderFlat(columns) {
        const row = el('div', 'lgrid-headrow');
        columns.forEach((column, index) => {
            row.appendChild(this.columnCell(column, index));
        });
        row.appendChild(this.layout.fillerCell('headcell'));
        this.headEl.appendChild(row);
    }

    /**
     * Two-row header as a SINGLE grid: group labels span their members on row 1; ungrouped
     * column headers span both rows; grouped members sit on row 2.
     */
    renderGrouped(columns, groups) {
        const grid = el('div', 'lgrid-headrow lgrid-headrow--grouped');
        // Two equal header rows; the tracks come from the shared --lgrid-cols.
        grid.style.gridTemplateRows = 'repeat(2, auto)';

        // Map each column index to the group that owns it (if any).
        const groupByIndex = new Map();
        for (const group of groups) {
            for (let i = group.start; i < group.start + group.span; i++) {
                groupByIndex.set(i, group);
            }
        }

        // Group-label cells on row 1, spanning their members.
        for (const group of groups) {
            const cell = el('div', 'lgrid-headgroup', group.label);
            // grid-column is 1-based; tracks are the visible column order.
            cell.style.gridColumn = `${group.start + 1} / span ${group.span}`;
            cell.style.gridRow = '1';
            this.layout.applyFrozenTo(cell, group.start);
            grid.appendChild(cell);
        }

        // Column-header cells.
        columns.forEach((column, index) => {
            const cell = this.columnCell(column, index);
            cell.style.gridColumn = `${index + 1}`;
            if (groupByIndex.has(index)) {
                // Grouped member: sits on row 2, under its group label.
                cell.style.gridRow = '2';
            } else {
                // Ungrouped: one tall header spanning both rows.
                cell.style.gridRow = '1 / span 2';
            }
            grid.appendChild(cell);
        });

        // Trailing filler spans both rows so the 1fr track stays aligned with body/footer.
        const filler = this.layout.fillerCell('headcell');
        filler.style.gridColumn = `${columns.length + 1}`;
        filler.style.gridRow = '1 / span 2';
        grid.appendChild(filler);

        this.headEl.appendChild(grid);
    }

    /** A single column-header cell with alignment + frozen state applied. */
    columnCell(column, index) {
        const cell = el('div', 'lgrid-headcell', column.label);
        toggleClass(cell, 'lgrid-cell--right', column.align === 'right');
        toggleClass(cell, 'lgrid-cell--center', column.align === 'center');
        this.layout.applyFrozenTo(cell, index);

        // Sortable columns (M3): a dedicated sort control so a click on IT re-sorts, while a click
        // on the rest of the header cell still selects the whole column (M2) — the two coexist.
        // Gated on store.canSort, the SAME predicate GridCore binds the handler from: an
        // affordance must imply a capability (an editable grid never gets an inert button).
        if (column.sortable && this.store.canSort) {
            cell.classList.add('lgrid-headcell--sortable');
            const sort = el('button', 'lgrid-sort');
            sort.type = 'button';
            sort.dataset.sort = column.key;
            sort.setAttribute('aria-label', `Sort by ${column.label}`);
            const icon = el('span', 'lgrid-sort-icon');
            sort.appendChild(icon);
            cell.appendChild(sort);
        }

        // Header filter control (M7): a funnel button for a column carrying an attached filter
        // (serialized only when declared) on a server-side grid. Like the sort control, it is a
        // dedicated hit target so the rest of the cell still column-selects; the HeaderFilters
        // manager's delegated listener drives the menu.
        if (column.filter && this.store.serverSide) {
            const filterBtn = el('button', 'lgrid-filter');
            filterBtn.type = 'button';
            filterBtn.dataset.col = column.key;
            filterBtn.setAttribute('aria-label', `Filter by ${column.filter.label || column.label}`);
            filterBtn.setAttribute('aria-haspopup', 'true');
            filterBtn.appendChild(el('span', 'lgrid-filter-icon'));
            cell.appendChild(filterBtn);
        }

        // Resize handle (M7): a grab strip on the trailing edge; the ResizeManager's delegated
        // listeners on the header element drive it, so re-rendering the header is always safe.
        // Columns default resizable; only an explicit ->resizable(false) serializes the opt-out.
        if (column.resizable !== false) {
            const handle = el('span', 'lgrid-resize');
            handle.dataset.col = column.key;
            handle.setAttribute('aria-hidden', 'true');
            cell.appendChild(handle);
        }

        return cell;
    }

    /**
     * Reflect the current query's filter values on the header funnel controls (M7): a funnel
     * whose filter carries an ACTIVE value paints filled. Called on paint + page:changed.
     */
    updateFilterIndicators() {
        const filters = (this.store.query && this.store.query.filters) || {};
        this.headEl.querySelectorAll('.lgrid-filter').forEach((btn) => {
            const column = this.store.columnByKey(btn.dataset.col);
            const key = column && column.filter ? column.filter.key : null;
            const value = key !== null ? filters[key] : undefined;
            const active = value !== undefined && value !== null && value !== '' && value !== 'any';
            btn.classList.toggle('lgrid-filter--active', active);
        });
    }

    /**
     * Reflect the store's current sort on the header sort controls (asc/desc/none), and the
     * matching aria-sort on the head cell. Called on paint + page:changed (server sort).
     */
    updateSortIndicators() {
        const query = this.store.query || {};
        const cells = this.headEl.querySelectorAll('.lgrid-headcell');
        const columns = this.store.visibleColumns();
        cells.forEach((cell, i) => {
            const column = columns[i];
            if (!column || !column.sortable || !this.store.canSort) {
                return;
            }
            const active = query.sort === column.key;
            const dir = active ? query.dir || 'asc' : null;
            cell.classList.toggle('lgrid-headcell--sorted', active);
            cell.classList.toggle('lgrid-headcell--asc', dir === 'asc');
            cell.classList.toggle('lgrid-headcell--desc', dir === 'desc');
            cell.setAttribute('aria-sort', active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none');
        });
    }
}
