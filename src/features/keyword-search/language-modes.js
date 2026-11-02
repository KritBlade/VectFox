/**
 * ============================================================================
 * LANGUAGE MODES — single source of truth for CJK tokenizer modes
 * ============================================================================
 * One record per selectable mode. All four previously-duplicated mode
 * definitions (enum, dropdown HTML, tokenizer switch, stop-word selection)
 * now derive from this array.
 *
 * To add a language:
 *   1. Add ITS_STOP_WORDS = [...] in stop-words.js
 *   2. Add  xx: ITS_STOP_WORDS  to STOP_WORDS_BY_LOCALE in stop-words.js
 *   3. Add ONE record here (Latin langs: tokenizer:'intl'; special segmenters also
 *      wire the tokenizer value in extractCJKTokens — rare).
 *   Nothing else changes — dropdown, enum, and stop-word selection all derive
 *   from this array.
 * ============================================================================
 */

export const LANGUAGE_MODES = [
    { value: 'intl',           label: 'Intl.Segmenter (English / Latin)', tokenizer: 'intl',           stopLocales: ['en'] },
    { value: 'jieba',          label: 'Simplified Chinese (Jieba WASM)',  tokenizer: 'jieba',          stopLocales: ['en', 'zh-Hans'] },
    { value: 'jieba_tw',       label: 'Traditional Chinese (Jieba WASM)', tokenizer: 'jieba_tw',       stopLocales: ['en', 'zh-Hant'] },
    { value: 'tiny_segmenter', label: 'Japanese (TinySegmenter)',         tokenizer: 'tiny_segmenter', stopLocales: ['en', 'ja'] },
    { value: 'korean',         label: 'Korean (Intl.Segmenter)',          tokenizer: 'intl',           stopLocales: ['en', 'ko'] },
    { value: 'others',         label: 'Others (Intl.Segmenter)',          tokenizer: 'intl',           stopLocales: ['en'] },
];

/** Frozen enum of all valid mode values — identical shape to the old local definition. */
export const CJK_TOKENIZER_MODES = Object.freeze(
    Object.fromEntries(LANGUAGE_MODES.map(m => [m.value, m.value])));

export const DEFAULT_CJK_TOKENIZER_MODE = 'intl';

const _byValue = new Map(LANGUAGE_MODES.map(m => [m.value, m]));
const _fallback = _byValue.get('intl');

/** Returns the stopLocales array for a mode; falls back to ['en'] for unknown/null. */
export function stopLocalesForMode(mode) { return (_byValue.get(mode) || _fallback).stopLocales; }

/** Returns the tokenizer string for a mode; falls back to 'intl' for unknown/null. */
export function tokenizerForMode(mode) { return (_byValue.get(mode) || _fallback).tokenizer; }
