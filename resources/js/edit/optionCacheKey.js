/**
 * What: The cache key for one server option search of a SearchSelect column — the typed term,
 *       plus the row values the column declares through ->optionsDependOn().
 * Why:  EditorManager caches option lists per column. Keyed by term alone, the first row's list
 *       would be reused for every later row searching the same term, even when the server answers
 *       differently per row (a D/C side, a party, a material centre). Folding the declared
 *       dependency values into the key keeps one fetch per term per dependency value. A column
 *       without dependencies keeps the plain term key, so existing caches behave exactly as before.
 * When: EditorManager.searchOptions() before it reads or writes its per-column LRU.
 */

/**
 * @param {{optionsDependOn?: string[]}} column the serialized column config
 * @param {Record<string, unknown>|null|undefined} row the row the picker is editing
 * @param {unknown} term the typed search term
 * @returns {string}
 */
export function optionCacheKey(column, row, term) {
    const base = String(term == null ? '' : term);
    const dependencies = Array.isArray(column && column.optionsDependOn) ? column.optionsDependOn : [];

    if (dependencies.length === 0) {
        return base;
    }

    const values = dependencies.map((key) => {
        const value = row ? row[key] : undefined;

        return value == null ? '' : String(value);
    });

    return JSON.stringify([base, ...values]);
}
