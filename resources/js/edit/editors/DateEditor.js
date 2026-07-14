/**
 * What: The date floating editor — a text input constrained to date characters (digits and the
 *       / . - space separators). The operator types Busy-style fuzzy dates (`31/12`, `31.12.26`,
 *       `311226`); the COMMIT resolves them through the shared parser (parse.js kind 'date' →
 *       shared/date.js) to canonical ISO with FY-aware year inference. Unparseable non-empty
 *       text refuses the commit (the parse sentinel → cell error, editor stays open) — the same
 *       forced-entry discipline as the form-kit date field. No calendar panel: keyboard-first.
 * Why:  One fuzzy parser for the whole app (M5 decision 1) — this editor adds zero date logic,
 *       only input hygiene. Arrows Up/Down commit-and-move (Excel), Left/Right keep the caret
 *       (dates are edited mid-string).
 * When: Registered as editor id 'date'.
 */
import { el } from '../../util/dom.js';

export default class DateEditor {
    /**
     * @param {HTMLElement} host
     * @param {{column: object, initialText: string, caretAtEnd: boolean}} ctx
     */
    mount(host, ctx) {
        this.column = ctx.column;
        this.input = el('input', 'lgrid-cell-editor-input');
        this.input.type = 'text';
        this.input.inputMode = 'numeric';
        this.input.setAttribute('autocomplete', 'off');
        this.input.placeholder = 'dd-mm-yyyy';
        this.input.value = ctx.initialText != null ? String(ctx.initialText) : '';

        // Only digits + accepted separators can be typed (the parser accepts any of them).
        this.onBeforeInput = (e) => {
            if (e.data == null) {
                return; // deletions/compositions
            }
            if (!/^[0-9/.\- ]+$/.test(e.data)) {
                e.preventDefault();
            }
        };
        this.input.addEventListener('beforeinput', this.onBeforeInput);

        host.appendChild(this.input);
        this.focus(ctx.caretAtEnd);
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
        // Re-assert next frame (focus set inside the opening keydown can be clawed back).
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (this.input && this.input.isConnected && document.activeElement !== this.input) {
                    place();
                }
            });
        }
    }

    value() {
        return this.input.value;
    }

    /**
     * Up/Down commit-and-move; Left/Right stay with the caret (mid-string date edits).
     * @param {KeyboardEvent} e
     * @returns {'caret'|'commit-move'|null}
     */
    keyPolicy(e) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            return 'commit-move';
        }
        return null;
    }

    destroy() {
        if (this.input) {
            this.input.removeEventListener('beforeinput', this.onBeforeInput);
            this.input.remove();
        }
    }
}
