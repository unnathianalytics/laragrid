/**
 * What: The plain-text floating editor — a single <input type="text"> the EditorManager moves over
 *       the active cell. It honours the column's maxLength + case transform for live typing.
 * Why:  One reusable editor element (never an input per cell) is the MSFlexGrid/Excel model the
 *       brief mandates and the reason 5k rows stay light (plan §2.1/§2.7). The editor is a thin
 *       input wrapper: it owns only the raw typed text + caret; the EditorManager owns parse →
 *       validate → commit → advance so every editor type shares that pipeline.
 * When: Registered as editor id 'text'; opened for TextColumn cells.
 */
import { el } from '../../util/dom.js';

export default class TextEditor {
    /**
     * Build the input into the host element.
     * @param {HTMLElement} host the floating editor host (positioned by EditorManager)
     * @param {{column: object, initialText: string, caretAtEnd: boolean}} ctx
     */
    mount(host, ctx) {
        this.column = ctx.column;
        this.input = el('input', 'lgrid-cell-editor-input');
        this.input.type = 'text';
        this.input.setAttribute('autocomplete', 'off');
        this.input.setAttribute('spellcheck', 'false');
        if (this.column.maxLength) {
            this.input.maxLength = this.column.maxLength;
        }
        if (this.column.align === 'right') {
            this.input.classList.add('lgrid-cell-editor-input--right');
        }
        this.input.value = ctx.initialText != null ? String(ctx.initialText) : '';

        // Live case transform so the operator sees UPPER/lower as they type.
        this.onInput = () => {
            const t = this.column.case;
            if (t === 'upper') {
                this.setValuePreservingCaret(this.input.value.toUpperCase());
            } else if (t === 'lower') {
                this.setValuePreservingCaret(this.input.value.toLowerCase());
            }
        };
        this.input.addEventListener('input', this.onInput);

        host.appendChild(this.input);
        this.focus(ctx.caretAtEnd);
    }

    /** Set the value while keeping the caret position (case transform doesn't jump the cursor). */
    setValuePreservingCaret(next) {
        const pos = this.input.selectionStart;
        this.input.value = next;
        this.input.setSelectionRange(pos, pos);
    }

    /** Focus the input; place the caret at the end (F2) or select-all (type-through replaces). */
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
        // Re-assert on the next frame: focus() called inside the opening keydown can be clawed back
        // by the browser as the event settles (the form-kit focus-advance lesson). One rAF re-focus
        // makes the editor reliably own focus without a retry storm.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (this.input && this.input.isConnected && document.activeElement !== this.input) {
                    place();
                }
            });
        }
    }

    /** The raw typed text (the EditorManager parses it via the column's parse spec). */
    value() {
        return this.input.value;
    }

    /**
     * Editor-owned key policy: which nav keys the editor consumes vs. lets bubble to commit-and-move.
     * A text editor keeps Left/Right/Home/End for caret movement; arrows Up/Down commit-and-move.
     * @param {KeyboardEvent} e
     * @returns {'caret'|'commit-move'|null} 'caret' = editor keeps it; 'commit-move' = commit then move
     */
    keyPolicy(e) {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            return 'caret';
        }
        if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
            return 'commit-move';
        }
        return null;
    }

    destroy() {
        if (this.input) {
            this.input.removeEventListener('input', this.onInput);
            this.input.remove();
        }
    }
}
