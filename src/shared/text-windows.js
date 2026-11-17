/**
 * Cutting text into windows of about a given size, by a given measure: a text's lines, the sentences of a line over
 * the size, and greedy packing that never splits a part. LoreBase's splitter (features/lorebase/lorebase-splitter.js)
 * packs an entry's passages with it, and the embedding feature (features/embedding/search-pieces-core.js) a search
 * text's pieces. Pure: no SillyTavern, no network.
 */

// Kana, CJK ideographs, Hangul and CJK compatibility ideographs, as a character class's ranges.
export const CJK_RANGES = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff';
/** One CJK character. Global: count with String.prototype.match. */
export const CJK_CHARACTER = new RegExp(`[${CJK_RANGES}]`, 'gu');
/** A run of Latin letters and digits, counted as one word. Global: count with String.prototype.match. */
export const LATIN_WORD = /[A-Za-z0-9]+/g;
// Where a line splits into sentences: the space after . ! ? 。 ！ ？ …, or straight after a CJK sentence end.
const SENTENCE_END = /(?<=[.!?。！？…])\s+|(?<=[。！？])/u;

/**
 * A text's lines, and the sentences of a line the measure puts over longLineTokens, as the smallest parts a window
 * may hold. Empty lines stay, so packing keeps paragraph breaks.
 * @param {string} text
 * @param {number} longLineTokens - A line over this is cut into its sentences
 * @param {(text: string) => number} measure - The size of a text in tokens
 * @returns {string[]}
 */
export function lineAndSentenceParts(text, longLineTokens, measure) {
    const parts = [];
    for (const line of text.split('\n')) {
        if (measure(line) <= longLineTokens) {
            parts.push(line);
            continue;
        }
        parts.push(...line.split(SENTENCE_END).filter(part => part));
    }
    return parts;
}

/**
 * Greedy packing of parts into windows of about windowTokens by the measure, never splitting a part. A window holds
 * parts while their sizes add up to windowTokens; a part over it fills a window alone. Blank windows are dropped.
 * @param {string[]} parts
 * @param {number} windowTokens
 * @param {string} joiner - Put between the parts of one window
 * @param {(text: string) => number} measure - The size of a text in tokens
 * @returns {string[]}
 */
export function packWindows(parts, windowTokens, joiner, measure) {
    const windows = [];
    let current = [];
    let currentTokens = 0;
    for (const part of parts) {
        const partTokens = measure(part);
        if (current.length && currentTokens + partTokens > windowTokens) {
            windows.push(current.join(joiner));
            current = [];
            currentTokens = 0;
        }
        current.push(part);
        currentTokens += partTokens;
    }
    if (current.length) windows.push(current.join(joiner));
    return windows.filter(window => window.trim());
}
