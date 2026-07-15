/**
 * What: The Y/N "editor" — an instant MARKER class like CheckboxInline, plus `static chars`: the
 *       NAV-mode typed keys it maps to direct value commits (y → true, n → false, case-folded by
 *       the dispatcher). Typing one both answers the cell AND advances (EditorManager.setInstant
 *       — the same Enter-commit advance), Space/double-click keep the checkbox's stay-put toggle,
 *       and every other printable stays ignored — the cell accepts only Y or N.
 * Why:  The Tally Yes/No field: one keystroke answers and moves on — a checkbox can't do that
 *       (instant columns are excluded from type-through, and Space deliberately doesn't advance).
 *       Declaring the keys as data on the editor class keeps KeyboardManager/EditorManager
 *       type-agnostic: any future instant editor gets typed commits by declaring its own map.
 * When: Registered as editor id 'yesno'; consulted (never instantiated) by EditorManager.open
 *       and by KeyboardManager's instant-column checks.
 */
export default class YesNoInline {
    /** Marks the editor as an in-place toggle: open() without a mapped seed flips the value. */
    static instant = true;

    /** NAV typed chars (lower-cased) → the value committed + advanced through the shared pipeline. */
    static chars = { y: true, n: false };

    /* The class is never instantiated — EditorManager short-circuits on `instant`. The stubs
       document the editor contract for anyone extending from this file. */

    mount() {}

    value() {
        return null;
    }

    destroy() {}
}
