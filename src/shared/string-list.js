// string-list.js — cleans a list of strings, such as the name lists in an LLM's extraction output.

/**
 * Trim every member and drop the empty ones and the duplicates, keeping the first of each in order.
 * A member that is not a string goes through String() first (null and undefined become empty and
 * are dropped). A value that is not an array gives [].
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map(member => (typeof member === 'string' ? member.trim() : String(member ?? '').trim()))
        .filter(Boolean))];
}
