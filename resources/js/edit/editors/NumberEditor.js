/**
 * What: The numeric floating editor — a right-aligned text input constrained to numeric entry
 *       (digits, one decimal point, a leading minus, and grouping commas the parser strips). Used
 *       for Integer/Decimal/Qty/Amount columns; the column's parse spec (int/decimal/paise) decides
 *       the final cast in the EditorManager.
 * Why:  Numbers are typed as text (a masked <input type=text>, not type=number) so grouping commas,
 *       partial input, and paste behave predictably and the SAME parse.js path casts them — the
 *       type=number spinner + locale parsing would fight the Indian grouping + paise model (plan G2).
 *       Arrows commit-and-move (a number cell has no caret navigation worth keeping), matching Excel.
 * When: Registered as editor id 'number'.
 */
import { el } from '../../util/dom.js';

export default class NumberEditor {
    /**
     * @param {HTMLElement} host
     * @param {{column: object, initialText: string, caretAtEnd: boolean}} ctx
     */
    mount(host, ctx) {
        this.column = ctx.column;
        this.input = el('input', 'lgrid-cell-editor-input lgrid-cell-editor-input--right');
        this.input.type = 'text';
        this.input.inputMode = 'decimal';
        this.input.setAttribute('autocomplete', 'off');
        this.input.value = ctx.initialText != null ? String(ctx.initialText) : '';

        // Reject characters that can't be part of a number-with-grouping as they're typed.
        this.onBeforeInput = (e) => {
            if (e.data == null) {
                return; // deletions/compositions
            }
            if (!/^[0-9.,\-]+$/.test(e.data)) {
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
     * A number editor keeps no caret navigation: all arrows commit-and-move (Excel parity).
     * @param {KeyboardEvent} e
     * @returns {'caret'|'commit-move'|null}
     */
    keyPolicy(e) {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
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
