/**
 * What: The shared Busy "End of List" synthetic option — a sentinel the picker editors
 *       (Select/SearchSelect) prepend to their dropdown when eligible, plus the helpers to build
 *       and recognise it.
 * Why:  Both picker editors inject the SAME exit control and must agree on how to tell it apart
 *       from a real master option (its `value` must never collide with a real id, and pick-time
 *       interception must be exact). Concentrating the sentinel here keeps that contract in one
 *       place — the editors only render + route it.
 * When: Imported by SelectEditor/SearchSelectEditor when `ctx.endOfListLabel` is set (resolved by
 *       EditorManager.endOfListLabelFor). Picking it fires `ctx.endOfList()` — no value commit.
 */

/** A value that can never be a real master id — the sentinel option's `value`. */
export const END_OF_LIST_VALUE = '__lgrid_end_of_list__';

/** Build the sentinel option for a resolved label. */
export function endOfListOption(label) {
    return { value: END_OF_LIST_VALUE, label, __endOfList: true };
}

/** True when an option object is the end-of-list sentinel. */
export function isEndOfListOption(option) {
    return !!(option && option.__endOfList === true);
}
