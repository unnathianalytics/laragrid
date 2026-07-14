/**
 * What: Tiny DOM construction/mutation helpers for the datagrid renderers.
 * Why:  The renderers build plain DOM under one `wire:ignore` region (never Blade/morph),
 *       so they need a terse element factory. Crucially these helpers accept only whole,
 *       stable class names (the semantic `lgrid-*` classes shipped in datagrid.css) and
 *       toggle them — they NEVER compose Tailwind utility strings, because Tailwind v4
 *       scans only `@source '../views'` and would purge any class assembled here (plan R8).
 * When: Imported by every render/* module.
 */

/**
 * Create an element with a class and optional text.
 *
 * @param {string} tag
 * @param {string} [className] a stable, whole class name (never a composed utility string)
 * @param {string} [text] textContent (XSS-safe; callers opt into innerHTML explicitly)
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text != null) {
        node.textContent = text;
    }
    return node;
}

/**
 * Toggle a single stable class on an element.
 *
 * @param {Element} node
 * @param {string} className
 * @param {boolean} on
 */
export function toggleClass(node, className, on) {
    if (!node) {
        return;
    }
    node.classList.toggle(className, !!on);
}

/**
 * Set (or clear) an element's textContent from a possibly-null value.
 *
 * @param {Element} node
 * @param {*} value
 */
export function setText(node, value) {
    if (node) {
        node.textContent = value == null ? '' : String(value);
    }
}

/**
 * The stable DOM id for a cell — `{grid}-{rowKey}-{colKey}`. Used as the cell element's `id`,
 * as the root's `aria-activedescendant` target (roving focus, no per-cell tabindex — plan
 * §1.2/§2.2), and by SelectionPainter/tests to resolve a cell without a DOM scan. Kept in one
 * place so the producer (BodyRenderer) and consumers agree by construction.
 *
 * @param {string} gridName
 * @param {string} rowKey
 * @param {string} colKey
 * @returns {string}
 */
export function cellDomId(gridName, rowKey, colKey) {
    return `${gridName}-${rowKey}-${colKey}`;
}

/**
 * The in-memory Map key for a (rowKey, colKey) pair — joined with the ASCII unit separator
 * (U+001F), which cannot appear in a column key or row `_k`, so distinct pairs never collide.
 * Used by BodyRenderer's cell-element index.
 * @param {string} rowKey
 * @param {string} colKey
 */
export function cellMapKey(rowKey, colKey) {
    return `${rowKey}${colKey}`;
}
