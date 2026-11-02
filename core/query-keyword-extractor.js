// Source of truth for query-time keyword extraction (runs client-side; the
// similharity server only receives the pre-computed sparse vector). Shares its
// script/locale/Latin primitives with the ingest path via script-segmentation.js.

import { isStopWord } from './stop-words.js';
import { CJK_SPAN_RE, CJK_CHAR_RE, LATIN_TOKEN_RE, getSegmenter } from './script-segmentation.js';
import { stopLocalesForMode } from './language-modes.js';
import { log } from './log.js';

export const RETRIEVAL_KEYWORD_LEVELS = {
    minimal: { label: 'Minimal — 30 keywords', maxKeywords: 30 },
    balance: { label: 'Balance — 50 keywords', maxKeywords: 50 },
    maximum: { label: 'Maximum — 70 keywords', maxKeywords: 70 },
};

/**
 * Extract search keywords from a mixed Latin/CJK query string.
 *
 * CJK tokens take priority. If CJK fills the primary budget (maxKeywords),
 * +10 overflow slots are given to Latin tokens. Frequency-ranked within
 * separate anchor (first 240 chars) and context (full text) budgets.
 *
 * @param {string} searchText
 * @param {number} [maxKeywords=50]
 * @returns {string[]}
 */
export function extractQueryKeywords(searchText, maxKeywords = 50, mode = null) {
    const locales = stopLocalesForMode(mode);
    const text = searchText.toLowerCase();

    function tallyTokens(sourceText) {
        const cjkFreq = new Map();
        const latinFreq = new Map();

        const spans = sourceText.match(CJK_SPAN_RE) || [];
        for (const span of spans) {
            let usedSegmenter = false;

            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                try {
                    const seg = getSegmenter(span);
                    if (!seg) throw new Error('no segmenter');
                    const segs = Array.from(seg.segment(span));
                    const multiChar = segs.filter(s => s.isWordLike && s.segment.length >= 2);
                    if (multiChar.length > 0) {
                        for (const { segment } of multiChar) {
                            if (!isStopWord(segment, locales)) {
                                cjkFreq.set(segment, (cjkFreq.get(segment) || 0) + 1);
                            }
                        }
                        usedSegmenter = true;
                    }
                } catch (_) { /* fallthrough */ }
            }

            if (!usedSegmenter) {
                for (let i = 0; i + 1 < span.length; i++) {
                    const bigram = span.slice(i, i + 2);
                    if (!isStopWord(bigram, locales)) {
                        cjkFreq.set(bigram, (cjkFreq.get(bigram) || 0) + 1);
                    }
                }
            }
        }

        const latinMatches = sourceText.match(LATIN_TOKEN_RE) || [];
        for (const tok of latinMatches) {
            if (!isStopWord(tok, locales)) {
                latinFreq.set(tok, (latinFreq.get(tok) || 0) + 1);
            }
        }

        return { cjkFreq, latinFreq };
    }

    function sortFreqMap(freqMap) {
        return [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
    }

    const anchorCharBudget = Math.min(text.length, 240);
    const anchorText = text.slice(0, anchorCharBudget);
    const anchorCJKBudget = Math.min(15, maxKeywords);
    const contextCJKBudget = Math.max(0, maxKeywords - anchorCJKBudget);

    const { cjkFreq: anchorCJKFreq, latinFreq: anchorLatinFreq } = tallyTokens(anchorText);
    const { cjkFreq: fullCJKFreq, latinFreq: fullLatinFreq } = tallyTokens(text);

    const sortedAnchorCJK = sortFreqMap(anchorCJKFreq);
    const sortedFullCJK = sortFreqMap(fullCJKFreq);

    const anchorCJKTokens = sortedAnchorCJK.slice(0, anchorCJKBudget).map(([t]) => t);
    const seenCJK = new Set(anchorCJKTokens);
    const contextCJKTokens = [];
    for (const [token] of sortedFullCJK) {
        if (!seenCJK.has(token)) {
            contextCJKTokens.push(token);
            seenCJK.add(token);
            if (contextCJKTokens.length >= contextCJKBudget) break;
        }
    }
    const cjkTokens = [...anchorCJKTokens, ...contextCJKTokens];

    const mergedLatinFreq = new Map(fullLatinFreq);
    for (const [token, count] of anchorLatinFreq) {
        mergedLatinFreq.set(token, (mergedLatinFreq.get(token) || 0) + count);
    }
    const sortedLatin = sortFreqMap(mergedLatinFreq);

    const fullCJK = cjkTokens.length >= maxKeywords;
    const latinBudget = fullCJK ? 10 : (maxKeywords - cjkTokens.length);
    const latinTokens = sortedLatin.slice(0, latinBudget).map(([t]) => t);

    const result = [...cjkTokens, ...latinTokens];

    log.trace(`[VectFox] extractQueryKeywords anchor CJK -> ${sortedAnchorCJK.length} unique (top ${anchorCJKTokens.length}): ${anchorCJKTokens.join(', ') || '(none)'}`);
    log.trace(`[VectFox] extractQueryKeywords context CJK -> ${sortedFullCJK.length} unique (top ${contextCJKTokens.length}): ${contextCJKTokens.join(', ') || '(none)'}`);
    log.trace(`[VectFox] extractQueryKeywords Latin -> ${sortedLatin.length} unique (top ${latinTokens.length}): ${latinTokens.join(', ') || '(none)'}`);
    log.trace(`[VectFox] extractQueryKeywords final -> ${result.length} tokens (fullCJK=${fullCJK}): ${result.join(', ')}`);

    return result;
}

/**
 * Returns true if the token contains CJK/Kana/Hangul characters.
 * @param {string} token
 * @returns {boolean}
 */
export function isCJKToken(token) {
    return CJK_CHAR_RE.test(token);
}
