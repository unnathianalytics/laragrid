/**
 * What: The embedded-options picker editor (SelectColumn): a filter input in the floating editor
 *       host + the option list in the grid's single popup. Typing filters (contains, case-
 *       insensitive), ArrowUp/Down move the highlight, Enter/Tab pick-and-commit, a mouse click
 *       picks (the popup preventDefaults pointerdown, so the click can't blur-commit — R4), Esc
 *       cancels. Typed-but-not-picked text is discarded (form-kit combobox parity): value()
 *       returns the picked id, else the cell's original value.
 * Why:  Small fixed lists (UoM, Dr/Cr) ship in config and never round-trip; the popup + shared
 *       commit pipeline mean this class only renders a list and picks from it — commit, ops,
 *       labels and advancing all belong to the EditorManager (M4 follow-up #1: no second commit
 *       path). Embedded options also let the painter map value→label with no `_labels` needed.
 * When: Registered as editor id 'select'.
 */
import { el, setText } from '../../util/dom.js';
import { endOfListOption, isEndOfListOption } from '../endOfList.js';

export default class SelectEditor {
    /**
     * @param {HTMLElement} host
     * @param {object} ctx the EditorManager mount context (column/row/popup/requestCommit/…)
     */
    mount(host, ctx) {
        this.ctx = ctx;
        this.options = ctx.column.options || [];
        this.chosen = null;
        this.original = ctx.row[ctx.column.key];
        // The Busy exit option (endOfListOption), or null when this open isn't eligible — pinned
        // above the data options and unaffected by the filter term (it's a control, not a match).
        this.endOfList = ctx.endOfListLabel ? endOfListOption(ctx.endOfListLabel) : null;

        this.input = el('input', 'lgrid-cell-editor-input');
        this.input.type = 'text';
        this.input.setAttribute('autocomplete', 'off');
        this.input.placeholder = '';
        // A type-through seed becomes the initial filter; F2/Enter opens unfiltered.
        this.input.value = ctx.seed != null ? String(ctx.seed) : '';
        this.onInput = () => this.applyFilter(this.input.value);
        this.input.addEventListener('input', this.onInput);
        host.appendChild(this.input);

        this.openList();
        this.applyFilter(this.input.value);
        this.focus(true);
    }

    /** Open (own) the grid popup under the cell. */
    openList() {
        this.popupEl = this.ctx.popup.open({
            anchorEl: this.ctx.cellEl,
            owner: 'select:' + this.ctx.column.key,
            // An outside/scroll close leaves the editor itself open; blur handles the rest.
            onRequestClose: () => {
                this.popupEl = null;
            },
        });
        // Delegated mouse pick — pointerdown was preventDefaulted, so this click never blurred us.
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

    /** Filter the embedded list (contains, case-insensitive) and repaint the popup. */
    applyFilter(term) {
        const needle = String(term || '').trim().toLowerCase();
        const data = needle === ''
            ? this.options.slice()
            : this.options.filter((o) => o.label.toLowerCase().includes(needle));

        // The exit option (when eligible) is pinned FIRST and always present — it is not filtered
        // by the search term. `filtered` is the single rendered/pickable list, so all index math
        // (highlight, pickIndex, handleKey) stays as-is.
        this.filtered = this.endOfList ? [this.endOfList, ...data] : data;

        // Highlight: the current value's option when unfiltered, else the first match.
        this.highlight = 0;
        if (needle === '' && this.original != null) {
            const at = this.filtered.findIndex((o) => !isEndOfListOption(o) && String(o.value) === String(this.original));
            this.highlight = at >= 0 ? at : 0;
        }
        this.renderList();
    }

    renderList() {
        if (!this.popupEl) {
            return;
        }
        this.popupEl.textContent = '';
        if (this.filtered.length === 0) {
            const empty = el('div', 'lgrid-popup-empty');
            setText(empty, 'No matches');
            this.popupEl.appendChild(empty);
        } else {
            this.filtered.forEach((option, index) => {
                let cls = 'lgrid-popup-option';
                if (index === this.highlight) {
                    cls += ' lgrid-popup-option--active';
                }
                if (isEndOfListOption(option)) {
                    cls += ' lgrid-popup-option--end-of-list';
                }
                const row = el('div', cls);
                row.dataset.index = String(index);
                setText(row, option.label);
                this.popupEl.appendChild(row);
            });
        }
        this.ctx.popup.position();
        this.scrollHighlightIntoView();
    }

    scrollHighlightIntoView() {
        if (!this.popupEl) {
            return;
        }
        const active = this.popupEl.querySelector('.lgrid-popup-option--active');
        if (active && typeof active.scrollIntoView === 'function') {
            active.scrollIntoView({ block: 'nearest' });
        }
    }

    moveHighlight(delta) {
        if (this.filtered.length === 0) {
            return;
        }
        this.highlight = Math.max(0, Math.min(this.filtered.length - 1, this.highlight + delta));
        this.renderList();
    }

    /**
     * Act on the option at a filtered index. The exit sentinel fires the end-of-list escape and
     * returns false (no value staged, caller must NOT commit); a real option stages value + label
     * and returns true (caller commits).
     *
     * @returns {boolean} true when a value was staged and the caller should commit.
     */
    pickIndex(index) {
        const option = this.filtered[index];
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
     * First-refusal key handling while the list is open (EditorManager consults this before its
     * own routing — the POPUP state of §2.6). Returns true when consumed.
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
            if (this.filtered.length === 0) {
                // Nothing to pick — swallow so garbage filter text can't commit.
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
        return false; // Esc and the rest: EditorManager's shared routing
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

    /** The committed value: the picked id, else the cell's original value (typed text discarded). */
    value() {
        return this.chosen !== null ? this.chosen : this.original;
    }

    destroy() {
        if (this.popupEl) {
            this.popupEl.removeEventListener('click', this.onPick);
        }
        if (this.input) {
            this.input.removeEventListener('input', this.onInput);
            this.input.remove();
        }
    }
}
