/**
 * ============================================================================
 * SCRIPT SEGMENTATION — shared tokenization primitives
 * ============================================================================
 * Single source of truth for script detection, locale mapping, segmenter
 * resolution, and Latin word matching. Imported by both the ingest path
 * (bm25-scorer.js -> encodeSparseVector) and the query path
 * (query-keyword-extractor.js), so the two CANNOT drift apart — which is how
 * the accent-stripping bug previously slipped into one path but not the other.
 *
 * To add a new language: add its Unicode range to CJK_SPAN_RE / CJK_CHAR_RE
 * and a [/range/, 'locale'] entry to SCRIPT_LOCALE_MAP. Nothing else changes.
 *
 * NOTE: similharity/index.js keeps its own mirror copy on purpose — it is a
 * separate server-side repo/package and cannot import from here.
 * ============================================================================
 */

// Scripts that are written without inter-word spaces and therefore need
// segmentation: CJK Han, Japanese Kana, Korean Hangul, Thai, Lao, Myanmar, Khmer.
const _SEGMENTED_RANGES = '\\u3400-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF\\u0E00-\\u0E7F\\u0E80-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF';

/** Matches runs of segmented-script characters. Global — use with .match()/.replace(). */
export const CJK_SPAN_RE = new RegExp('[' + _SEGMENTED_RANGES + ']+', 'g');

/** Single-character variant (no /g, safe for .test()). Used by isCJKToken(). */
export const CJK_CHAR_RE = new RegExp('[' + _SEGMENTED_RANGES + ']');

/** Kana presence — routes Jieba (skip kana) vs TinySegmenter (kana only). */
export const KANA_RE = /[぀-ゟ゠-ヿ]/;

/**
 * Latin/alphabetic word matcher (accent-preserving). For .match()-based
 * extraction. \p{L} keeps accented letters (é, ñ, ç, ü, ...) and any other
 * Unicode script's letters. Global + Unicode flags.
 */
// \p{M} keeps combining marks (Indic matras/virama, Arabic harakat, etc.)
// so Indic/Arabic words tokenize as whole units instead of broken fragments.
export const LATIN_TOKEN_RE = /[\p{L}\p{M}][\p{L}\p{M}\d'_-]{2,}/gu;

/**
 * Non-word character class (accent-preserving) for strip-and-split
 * tokenization. Keeps Unicode letters, numbers and underscore; replaces
 * everything else with a space. Drop-in Unicode-aware replacement for the
 * old ASCII-only /[^\w\s]/g — identical output for ASCII text, but no longer
 * strips accents.
 */
export const NON_WORD_RE = /[^\p{L}\p{M}\p{N}_\s]/gu;

/** Maps a Unicode script range to its BCP-47 locale for Intl.Segmenter. */
const SCRIPT_LOCALE_MAP = [
    [/[぀-ゟ゠-ヿ]/, 'ja'],            // Japanese Kana
    [/[가-힯]/, 'ko'],                          // Korean Hangul
    [/[฀-๿]/, 'th'],                          // Thai
    [/[຀-໿]/, 'lo'],                          // Lao
    [/[က-႟]/, 'my'],                          // Myanmar
    [/[ក-៿]/, 'km'],                          // Khmer
    [/[一-鿿㐀-䶿豈-﫿]/, 'zh'], // CJK Han
];

/**
 * Detect the BCP-47 locale for a segmented-script span by Unicode range.
 * Returns 'und' (undetermined) for input outside the known ranges — this is
 * only reached if called on a non-segmented span, which the callers never do.
 * @param {string} span
 * @returns {string}
 */
export function localeForSpan(span) {
    return SCRIPT_LOCALE_MAP.find(([re]) => re.test(span))?.[1] ?? 'und';
}

const _segmenterCache = new Map();

/**
 * Return a cached Intl.Segmenter for the span's detected locale, or null if
 * the API is unavailable (caller falls back to bigram tokenization).
 * @param {string} span
 * @returns {Intl.Segmenter|null}
 */
export function getSegmenter(span) {
    const locale = localeForSpan(span);
    if (!_segmenterCache.has(locale)) {
        try { _segmenterCache.set(locale, new Intl.Segmenter(locale, { granularity: 'word' })); }
        catch (_) { _segmenterCache.set(locale, null); }
    }
    return _segmenterCache.get(locale);
}
