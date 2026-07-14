/**
 * What: The checkbox "editor" — a pure MARKER class. `static instant = true` tells the
 *       EditorManager that opening this editor means "toggle the value through the shared commit
 *       pipeline NOW" (optimistic apply + op), never mounting a floating input or entering EDIT
 *       mode. Space in NAV, Enter-open and double-click all route here.
 * Why:  A checkbox has two states; an input round-trip is pure friction (umbrella §2.6:
 *       "Checkbox cells toggle in NAV directly"). Keeping the toggle INSIDE EditorManager.
 *       commitCell — not in this class — preserves the single write path (M4 follow-up #1).
 * When: Registered as editor id 'checkbox'; consulted (never instantiated) by EditorManager.open
 *       and by KeyboardManager's instant-column checks.
 */
export default class CheckboxInline {
    /** Marks the editor as an in-place toggle: open() flips the value instead of mounting. */
    static instant = true;

    /* The class is never instantiated — EditorManager short-circuits on `instant`. The stubs
       document the editor contract for anyone extending from this file. */

    mount() {}

    value() {
        return null;
    }

    destroy() {}
}
