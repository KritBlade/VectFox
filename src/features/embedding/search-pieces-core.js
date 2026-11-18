/**
 * The pieces a search text is searched in (InternalProject/Vectfox/plans/executed/search-text-pieces.md). Text over
 * the embedding provider's piece size is cut at line ends, then sentence ends, then spaces, then into runs within the
 * size, and packed greedily up to the size, so each piece can be embedded and searched on its own and nothing is
 * dropped. Pure: no SillyTavern, no network.
 */
import { CJK_CHARACTER, CJK_RANGES, LATIN_WORD, lineAndSentenceParts, packWindows } from '../../shared/text-windows.js';

// A letter of any script but Latin and CJK: Cyrillic, Greek, Arabic, Thai and the rest.
const OTHER_SCRIPT_LETTER = new RegExp(`[^\\P{L}A-Za-z${CJK_RANGES}]`, 'gu');
const NON_SPACE = /\S/g;
const TOKENS_PER_LATIN_WORD = 1.3;
const CHARACTERS_PER_TOKEN = 4;

/**
 * A search text's size in tokens, erring high for every script: 1 per CJK character, 1.3 per Latin word, 1 per letter
 * of any other script, and never less than a quarter of its non-space characters, so a long link or code run counts
 * too. Additive, with no rounding, so parts packed within a size stay within it.
 * @param {string} text
 * @returns {number}
 */
export function searchTokens(text) {
    const count = pattern => (text.match(pattern) || []).length;
    const byScript = count(CJK_CHARACTER) + count(LATIN_WORD) * TOKENS_PER_LATIN_WORD + count(OTHER_SCRIPT_LETTER);
    return Math.max(byScript, count(NON_SPACE) / CHARACTERS_PER_TOKEN);
}

/**
 * A run with no spaces cut into runs within the size. A character counts at most as a Latin word does, so a run of
 * pieceTokens / 1.3 characters stays within it.
 * @param {string} run
 * @param {number} pieceTokens
 * @returns {string[]}
 */
function runsWithin(run, pieceTokens) {
    const characters = Array.from(run);
    const runLength = Math.max(1, Math.floor(pieceTokens / TOKENS_PER_LATIN_WORD));
    const runs = [];
    for (let start = 0; start < characters.length; start += runLength) runs.push(characters.slice(start, start + runLength).join(''));
    return runs;
}

/**
 * A part over the size cut at spaces, a word still over it into runs within it, the words packed back up to the size.
 * @param {string} part
 * @param {number} pieceTokens
 * @returns {string[]}
 */
function partsBySpaces(part, pieceTokens) {
    const words = part.split(/\s+/).filter(Boolean)
        .flatMap(word => (searchTokens(word) <= pieceTokens ? [word] : runsWithin(word, pieceTokens)));
    return packWindows(words, pieceTokens, ' ', searchTokens);
}

/**
 * A search text cut into pieces within pieceTokens by searchTokens: [text] when it fits, [] when it is empty.
 * @param {string} text
 * @param {number} pieceTokens - The provider's piece size; Infinity searches every text whole
 * @returns {string[]} The pieces, in the text's order
 */
export function splitSearchText(text, pieceTokens) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return [];
    if (searchTokens(trimmed) <= pieceTokens) return [trimmed];
    const parts = lineAndSentenceParts(trimmed, pieceTokens, searchTokens)
        .flatMap(part => (searchTokens(part) <= pieceTokens ? [part] : partsBySpaces(part, pieceTokens)));
    return packWindows(parts, pieceTokens, '\n', searchTokens).map(piece => piece.trim());
}
