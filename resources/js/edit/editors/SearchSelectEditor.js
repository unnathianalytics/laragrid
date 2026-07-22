/**
 * What: The async combobox editor (SearchSelectColumn): a term input in the floating editor host,
 *       results in the grid's single popup. Typing debounces (column debounceMs) and — once the
 *       term reaches minChars — searches: client mode filters the embedded list locally; server
 *       mode calls the EditorManager's searchOptions bridge (gridOptions RPC behind a per-column
 *       LRU). A monotonic sequence discards stale responses (a slow reply for a superseded term
 *       never paints — the PageSource pattern). Arrows highlight, Enter/Tab/click pick-and-commit
 *       (value + LABEL staged for the op), Esc cancels. The single shared editor instance makes
 *       "≤ 1 in-flight search grid-wide" true by construction.
 * Why:  Master pickers are voucher entry's heart; every behaviour here is display/selection only —
 *       commit, ops, `_labels` and enrichment reconciliation all live in the shared pipeline +
 *       server hook (umbrella §2.5.3). Type-to-search with a small alphabetical page (user
 *       decision M5-Q4) keeps the wire cost per keystroke tiny and the list scannable.
 * When: Registered as editor id 'searchselect'.
 */
import { el, setText } from '../../util/dom.js';
import { endOfListOption, isEndOfListOption } from '../endOfList.js';

export default class SearchSelectEditor {
    /**
     * @param {HTMLElement} host
     * @param {object} ctx the EditorManager mount context (column/row/popup/searchOptions/…)
     */
    mount(host, ctx) {
        this.ctx = ctx;
        this.serverMode = ctx.column.optionsMode !== 'client';
        this.embedded = ctx.column.options || [];
        this.minChars = Math.max(0, Number(ctx.column.minChars) || 0);
        this.debounceMs = Math.max(0, Number(ctx.column.debounceMs) || 0);
        this.chosen = null;
        this.original = ctx.row[ctx.column.key];
        this.results = [];
        this.highlight = 0;
        this.seq = 0; // stale-response guard: only the latest term's results paint
        // The Busy exit option (endOfListOption), or null when this open isn't eligible. Pinned
        // FIRST in the rendered/pickable list on every search — including before minChars, where it
        // rides alongside the type-to-search hint so the operator can always end the list.
        this.endOfList = ctx.endOfListLabel ? endOfListOption(ctx.endOfListLabel) : null;

        this.input = el('input', 'lgrid-cell-editor-input');
        this.input.type = 'text';
        this.input.setAttribute('autocomplete', 'off');
        this.input.value = ctx.seed != null ? String(ctx.seed) : '';
        this.onInput = () => this.queueSearch(this.input.value);
        this.input.addEventListener('input', this.onInput);
        host.appendChild(this.input);

        this.openList();
        this.queueSearch(this.input.value, { immediate: true });
        this.focus(true);
    }

    openList() {
        this.popupEl = this.ctx.popup.open({
            anchorEl: this.ctx.cellEl,
            owner: 'searchselect:' + this.ctx.column.key,
            onRequestClose: () => {
                this.popupEl = null;
            },
        });
        this.onPick = (e) => {
            const row = e.target.closest('.lgrid-popup-option');
            if (row && this.popupEl && this.popupEl.contains(row)) {
                // Only commit a real pick; the exit sentinel already routed to the escape.
                if (this.pickIndex(Number(row.dataset.index))) {
                    this.ctx.requestCommit({ advance: null });
                }
            }
        };
        this.popupEl.addEventListener('click', this.onPick);
    }

    /** Debounce a term change; below minChars shows the type-to-search hint instead. */
    queueSearch(term, opts = {}) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const text = String(term || '').trim();

        if (text.length < this.minChars) {
            this.seq++; // invalidate any in-flight search for an earlier term
            this.results = [];
            this.highlight = 0; // pin the highlight on the exit option (rendered index 0) if present
            this.renderHint(this.minChars > 0 ? 'Type to search…' : 'No options');
            return;
        }

        const run = () => this.runSearch(text);
        if (opts.immediate || this.debounceMs === 0) {
            run();
        } else {
            this.timer = setTimeout(run, this.debounceMs);
        }
    }

    runSearch(term) {
        const mySeq = ++this.seq;
        // Remember whether this search carries an actual term — an EMPTY-term open (minChars 0)
        // must keep the exit option as the default highlight; a typed term hands it to the first
        // result. Read by adoptResults, which runs after the (possibly async) search resolves.
        this.termIsEmpty = String(term || '').trim() === '';

        if (!this.serverMode) {
            // Client mode: the embedded list, contains-filtered locally (small sets only).
            const needle = term.toLowerCase();
            this.adoptResults(mySeq, this.embedded.filter(
                (o) => needle === '' || o.label.toLowerCase().includes(needle),
            ));
            return;
        }

        this.setLoading(true);
        this.ctx.searchOptions(term)
            .then((options) => this.adoptResults(mySeq, options))
            .catch(() => {
                if (mySeq === this.seq) {
                    this.setLoading(false);
                    this.renderHint('Search failed — try again');
                }
            });
    }

    /** Apply results only if they answer the LATEST term (stale replies are discarded). */
    adoptResults(mySeq, options) {
        if (mySeq !== this.seq) {
            return;
        }
        this.setLoading(false);
        this.results = options || [];
        // Default highlight when the exit option is pinned at index 0:
        //  - a TYPED term with results → the first real result (index 1), so a search lands on a
        //    master and Enter picks it;
        //  - an EMPTY-term open (minChars 0, the operator hasn't typed) → the exit stays the default
        //    (index 0), so Enter on a blank row ENDS the list instead of grabbing the first item;
        //  - no results → the exit (index 0).
        const typedWithResults = !this.termIsEmpty && this.results.length > 0;
        this.highlight = this.endOfList && typedWithResults ? 1 : 0;
        this.renderList();
    }

    setLoading(on) {
        if (this.popupEl) {
            this.popupEl.classList.toggle('lgrid-popup--loading', !!on);
        }
        if (on && this.popupEl && this.results.length === 0) {
            this.popupEl.textContent = '';
            const row = el('div', 'lgrid-popup-loading');
            setText(row, 'Searching…');
            this.popupEl.appendChild(row);
            this.ctx.popup.position();
        }
    }

    renderHint(message) {
        if (!this.popupEl) {
            return;
        }
        this.popupEl.textContent = '';
        // The exit option stays available even while the hint shows (below minChars / no matches),
        // so the operator can always end the list. It occupies rendered() index 0, matching the
        // highlight/pick coordinate space.
        if (this.endOfList) {
            const cls = 'lgrid-popup-option lgrid-popup-option--end-of-list'
                + (this.highlight === 0 ? ' lgrid-popup-option--active' : '');
            const row = el('div', cls);
            row.dataset.index = '0';
            setText(row, this.endOfList.label);
            this.popupEl.appendChild(row);
        }
        const hint = el('div', 'lgrid-popup-hint');
        setText(hint, message);
        this.popupEl.appendChild(hint);
        this.ctx.popup.position();
    }

    /**
     * The full rendered/pickable list: the pinned exit option (when eligible) followed by the
     * search results. The single list every index (highlight, pickIndex, handleKey) refers to, so
     * the sentinel and the results share one coordinate space.
     */
    rendered() {
        return this.endOfList ? [this.endOfList, ...this.results] : this.results;
    }

    renderList() {
        if (!this.popupEl) {
            return;
        }
        this.popupEl.textContent = '';
        const rendered = this.rendered();
        if (rendered.length === 0) {
            const empty = el('div', 'lgrid-popup-empty');
            setText(empty, 'No matches');
            this.popupEl.appendChild(empty);
        } else {
            rendered.forEach((option, index) => {
                let cls = 'lgrid-popup-option';
                if (index === this.highlight) {
                    cls += ' lgrid-popup-option--active';
                }
                if (isEndOfListOption(option)) {
                    cls += ' lgrid-popup-option--end-of-list';
                }
                const row = el('div', cls);
                row.dataset.index = String(index);
                // Label + optional right-aligned meta (e.g. stock on hand) as separate spans —
                // setText only (no HTML), so option content can never inject markup. Clicks
                // still route through closest('.lgrid-popup-option'), spans included.
                const label = el('span', 'lgrid-popup-option-label');
                setText(label, option.label);
                row.appendChild(label);
                if (option.meta) {
                    const meta = el('span', 'lgrid-popup-option-meta');
                    setText(meta, String(option.meta));
                    row.appendChild(meta);
                }
                this.popupEl.appendChild(row);
            });
        }
        this.ctx.popup.position();
        const active = this.popupEl.querySelector('.lgrid-popup-option--active');
        if (active && typeof active.scrollIntoView === 'function') {
            active.scrollIntoView({ block: 'nearest' });
        }
    }

    moveHighlight(delta) {
        const count = this.rendered().length;
        if (count === 0) {
            return;
        }
        this.highlight = Math.max(0, Math.min(count - 1, this.highlight + delta));
        this.renderList();
    }

    /**
     * Act on the rendered option at an index. The exit sentinel fires the end-of-list escape and
     * returns false (no value staged, caller must NOT commit); a real result stages value + label
     * and returns true (caller commits).
     *
     * @returns {boolean} true when a value was staged and the caller should commit.
     */
    pickIndex(index) {
        const option = this.rendered()[index];
        if (!option) {
            return false;
        }
        if (isEndOfListOption(option)) {
            this.ctx.endOfList();
            return false;
        }
        this.chosen = option.value;
        this.ctx.setLabel(option.label);
        return true;
    }

    /**
     * First-refusal key handling (EditorManager consults before its own routing — §2.6 POPUP).
     * @param {KeyboardEvent} e
     */
    handleKey(e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            this.moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            if (this.rendered().length === 0) {
                // Nothing picked/pickable — swallow so a search term can't commit as a value.
                e.preventDefault();
                e.stopPropagation();
                return true;
            }
            e.preventDefault();
            e.stopPropagation();
            // The exit sentinel routes to the escape and must NOT commit/advance.
            if (!this.pickIndex(this.highlight)) {
                return true;
            }
            const advance = e.key === 'Tab'
                ? (e.shiftKey ? 'prev' : 'next')
                : (e.shiftKey ? 'enterBack' : 'enter');
            this.ctx.requestCommit({ advance });
            return true;
        }
        return false;
    }

    focus(caretAtEnd) {
        const place = () => {
            this.input.focus();
            if (caretAtEnd) {
                const len = this.input.value.length;
                this.input.setSelectionRange(len, len);
            } else {
                this.input.select();
            }
        };
        place();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (this.input && this.input.isConnected && document.activeElement !== this.input) {
                    place();
                }
            });
        }
    }

    /** The committed value: the picked id, else the original (a typed term is never a value). */
    value() {
        return this.chosen !== null ? this.chosen : this.original;
    }

    destroy() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.seq++; // orphan any in-flight search
        if (this.popupEl) {
            this.popupEl.removeEventListener('click', this.onPick);
        }
        if (this.input) {
            this.input.removeEventListener('input', this.onInput);
            this.input.remove();
        }
    }
}
