/**
 * What: The screen-reader announcer. Owns the grid's aria-live="polite" region and speaks the
 *       settled active cell ("{label}, row {n}, {value}") and selection changes ("{r} by {c}
 *       selected"), plus ad-hoc messages (e.g. clipboard copy). Announcements are throttled so a
 *       fast arrow-key run announces only where the cursor settles, not every intermediate cell.
 * Why:  Plan §1.3 G20 / R6: the ARIA grid pattern and a live announcer are acceptance criteria,
 *       not an afterthought. A trailing debounce keeps rapid navigation from flooding AT (R-D).
 * When: Constructed by GridCore with the x-ref="announcer" region; subscribes to active/selection
 *       change events; message() is also called directly by the clipboard hook.
 */
import { setText } from '../util/dom.js';
import { formatValue } from '../format/formatters.js';

export default class Announcer {
    /**
     * @param {import('../core/StateStore').default} store
     * @param {import('../core/EventBus').default} bus
     * @param {HTMLElement} regionEl the aria-live region
     */
    constructor(store, bus, regionEl) {
        this.store = store;
        this.bus = bus;
        this.regionEl = regionEl;
        this.timer = null;
        this.subs = [
            bus.on('active:changed', () => this.scheduleActive()),
            bus.on('selection:changed', () => this.scheduleSelection()),
        ];
    }

    destroy() {
        this.subs.forEach((off) => off());
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    /** Announce a message immediately (e.g. "Copied 2 rows by 3 columns."). */
    message(text) {
        setText(this.regionEl, text);
    }

    /** Debounced active-cell announcement (settled cell only). */
    scheduleActive() {
        this.schedule(() => {
            const addr = this.store.active;
            if (!addr) {
                return '';
            }
            const column = this.store.visibleColumns().find((c) => c.key === addr.colKey);
            const rowIndex = this.store.rowIndexOf(addr.rowKey);
            const value = this.store.rawValueAt(rowIndex, this.store.colIndexOf(addr.colKey));
            const label = column ? column.label : addr.colKey;
            const shown = column ? formatValue(column.format, value) : String(value ?? '');
            return `${label}, row ${rowIndex + 1}${shown ? ', ' + shown : ''}`;
        });
    }

    /** Debounced selection announcement (only for real ranges). */
    scheduleSelection() {
        this.schedule(() => {
            const sel = this.store.selection;
            if (!sel || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) {
                return '';
            }
            const rows = sel.r1 - sel.r0 + 1;
            const cols = sel.c1 - sel.c0 + 1;
            return `${rows} by ${cols} selected`;
        });
    }

    /** Trailing debounce (~120ms) so a burst of moves announces only the final state. */
    schedule(build) {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            const text = build();
            if (text) {
                this.message(text);
            }
        }, 120);
    }
}
