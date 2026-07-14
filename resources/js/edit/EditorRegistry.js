/**
 * What: The public registry mapping a column's `editor` id to its editor class — the extension
 *       seam (plan §3.8): a new editable column type registers an editor id → class here and the
 *       EditorManager resolves it without knowing types.
 * Why:  Keeping editor resolution a registry (not a switch) is what makes "adding a RatingColumn
 *       without touching core" true — the app or a consuming project registers custom editors at
 *       boot. M4 ships text + number; M5 adds select/searchselect/date/checkbox against the same seam.
 * When: Editors register on module load (below); GridCore/EditorManager read editorFor().
 */
const EDITORS = {};

/**
 * Register (or override) an editor class under an id.
 * @param {string} id
 * @param {Function} EditorClass a class implementing {mount, value, commit, cancel, keys}
 */
export function registerEditor(id, EditorClass) {
    EDITORS[id] = EditorClass;
}

/**
 * Resolve the editor class for an id, or null when none is registered (column not editable here).
 * @param {string} id
 * @returns {Function|null}
 */
export function editorFor(id) {
    return EDITORS[id] || null;
}
