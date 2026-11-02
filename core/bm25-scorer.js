/**
 * ============================================================================
 * BM25+ KEYWORD SCORING (ENHANCED)
 * ============================================================================
 * Enhanced implementation of BM25+ algorithm with:
 * - Porter Stemmer with LRU caching
 * - Comprehensive stop word filtering (190+ words)
 * - Sublinear term frequency: log(1 + tf)
 * - Coverage bonus: +10% when all query terms match
 * - Field boosting: Title (4x), Tags (4x), Content (1x)
 * - BM25+ IDF formula with delta smoothing
 *
 * Based on research showing BM25+ outperforms standard BM25 for long documents.
 *
 * @version 2.0.0
 * ============================================================================
 */

import TinySegmenter from './vendor/tiny-segmenter-0.2.0.js';
import { isStopWord } from './stop-words.js';
import { CJK_SPAN_RE, KANA_RE, NON_WORD_RE, getSegmenter } from './script-segmentation.js';
import { CJK_TOKENIZER_MODES, DEFAULT_CJK_TOKENIZER_MODE, stopLocalesForMode, tokenizerForMode } from './language-modes.js';
import { log } from '../src/sillytavern/log.js';

/**
 * Default BM25+ parameters
 * k1: Term frequency saturation parameter (1.2-2.0 typical)
 * b: Length normalization parameter (0.75 typical)
 * delta: BM25+ lower bound for term frequency (0.5 typical)
 */
const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const DEFAULT_DELTA = 0.5;

// CJK_TOKENIZER_MODES and DEFAULT_CJK_TOKENIZER_MODE are imported from language-modes.js
// and re-exported below for back-compat with existing importers.
const JIEBA_WASM_MODULE_URL = 'https://cdn.jsdelivr.net/gh/cxumol/jieba-wasm-html@gh-pages/jieba_rs_wasm.js';
// Jieba TW (Traditional Chinese) assets — fully vendored under core/vendor/jieba/ so
// the loader has zero network dependencies once the user picks `jieba_tw` mode.
// These files are still lazy-loaded: nothing fetches until cjk_tokenizer_mode='jieba_tw'.
//   - jieba_rs_wasm.js     (~14 KB, WASM module wrapper, from jieba-wasm@2.4.0)
//   - jieba_rs_wasm_bg.wasm (~4 MB, compiled tokenizer, from jieba-wasm@2.4.0)
//   - dict.txt             (~4 MB, Traditional Chinese dictionary)
const JIEBA_TW_WASM_MODULE_URL = new URL('./vendor/jieba/jieba_rs_wasm.js', import.meta.url).href;
const JIEBA_TW_WASM_BINARY_URL = new URL('./vendor/jieba/jieba_rs_wasm_bg.wasm', import.meta.url).href;
const JIEBA_TW_DICT_URL = new URL('./vendor/jieba/dict.txt', import.meta.url).href;

let cjkTokenizerMode = DEFAULT_CJK_TOKENIZER_MODE;
let jiebaCutFunction = null;
let jiebaLoadPromise = null;
let jiebaTwCutFunction = null;
let jiebaTwLoadPromise = null;
let tinySegmenterInstance = null;

/**
 * Set tokenizer mode used by extractCJKTokens.
 * @param {string} mode
 */
function setCjkTokenizerMode(mode) {
    if (!Object.values(CJK_TOKENIZER_MODES).includes(mode)) {
        log.warn(`[VectFox CJK] Unknown tokenizer mode "${mode}", falling back to ${DEFAULT_CJK_TOKENIZER_MODE}`);
        cjkTokenizerMode = DEFAULT_CJK_TOKENIZER_MODE;
        return;
    }
    cjkTokenizerMode = mode;
}

/**
 * Get current tokenizer mode.
 * @returns {string}
 */
function getCjkTokenizerMode() {
    return cjkTokenizerMode;
}

/**
 * Lazily load Jieba WASM tokenizer from CDN.
 * This is only called when mode is explicitly set to jieba.
 * @returns {Promise<boolean>}
 */
async function ensureJiebaTokenizerLoaded() {
    if (jiebaCutFunction) return true;
    if (jiebaLoadPromise) return jiebaLoadPromise;
    if (typeof window === 'undefined') return false;

    jiebaLoadPromise = (async () => {
        try {
            const mod = await import(JIEBA_WASM_MODULE_URL);
            if (typeof mod.default === 'function') {
                await mod.default();
            }
            if (typeof mod.cut !== 'function') {
                log.warn('[VectFox CJK] Jieba module loaded but cut() is unavailable');
                return false;
            }
            jiebaCutFunction = mod.cut;
            return true;
        } catch (error) {
            log.warn('[VectFox CJK] Failed to load Jieba WASM tokenizer:', error?.message || error);
            return false;
        }
    })();

    try {
        return await jiebaLoadPromise;
    } finally {
        jiebaLoadPromise = null;
    }
}

/**
 * Lazily load Traditional Chinese Jieba WASM tokenizer and TW dictionary from CDN.
 * Uses fengkx/jieba-wasm which supports with_dict() for full dictionary replacement.
 * @returns {Promise<boolean>}
 */
async function ensureJiebaTwLoaded() {
    if (jiebaTwCutFunction) return true;
    if (jiebaTwLoadPromise) return jiebaTwLoadPromise;
    if (typeof window === 'undefined') return false;

    jiebaTwLoadPromise = (async () => {
        // Per-stage timing so a slow/blocked network call tells us WHICH stage
        // is the choke point (WASM module JS / WASM binary / dict CDN fetch).
        // All four fail-paths go through this same try/catch and surface the
        // stage name in the warn so debugging is one log line, not three.
        const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const _ms = (start) => Math.round(_now() - start);
        const tStart = _now();
        let stage = 'init';
        try {
            // Stage 1 — fetch the jieba-wasm JS module (small, ~10KB)
            stage = `WASM module import (${JIEBA_TW_WASM_MODULE_URL})`;
            const tModStart = _now();
            const mod = await import(JIEBA_TW_WASM_MODULE_URL);
            log.lifecycle(`[VectFox CJK] Jieba TW: WASM module imported in ${_ms(tModStart)}ms`);

            if (typeof mod.default !== 'function') {
                log.warn('[VectFox CJK] Jieba TW module loaded but init() is unavailable');
                return false;
            }

            // Stage 2 — fetch + instantiate the WASM binary (large, ~2-3 MB)
            stage = `WASM binary init (${JIEBA_TW_WASM_BINARY_URL})`;
            const tWasmStart = _now();
            await mod.default({ module_or_path: JIEBA_TW_WASM_BINARY_URL });
            log.lifecycle(`[VectFox CJK] Jieba TW: WASM binary initialized in ${_ms(tWasmStart)}ms`);

            if (typeof mod.with_dict !== 'function' || typeof mod.cut !== 'function') {
                log.warn('[VectFox CJK] Jieba TW module missing with_dict() or cut()');
                return false;
            }

            // Stage 3 — fetch the TW dictionary text (large, ~5 MB). This was
            // the original timeout source; log start/finish + bytes so a slow
            // CDN is obvious from the log alone.
            stage = `dict fetch (${JIEBA_TW_DICT_URL})`;
            const tFetchStart = _now();
            log.lifecycle(`[VectFox CJK] Jieba TW: fetching TW dictionary from ${JIEBA_TW_DICT_URL} (30s timeout)…`);
            const resp = await fetch(JIEBA_TW_DICT_URL, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
            log.lifecycle(`[VectFox CJK] Jieba TW: dict HTTP response in ${_ms(tFetchStart)}ms (status=${resp.status})`);

            // Stage 4 — read the response body (streaming download time goes
            // here on slow networks; the HTTP status above can return quickly
            // while body bytes still trickle in).
            stage = 'dict body read';
            const tBodyStart = _now();
            const dictText = await resp.text();
            log.lifecycle(`[VectFox CJK] Jieba TW: dict body read in ${_ms(tBodyStart)}ms (${dictText.length.toLocaleString()} chars)`);

            // Stage 5 — apply dict to the loaded WASM tokenizer
            stage = 'with_dict() apply';
            const tApplyStart = _now();
            mod.with_dict(dictText);
            log.lifecycle(`[VectFox CJK] Jieba TW: with_dict() applied in ${_ms(tApplyStart)}ms`);

            jiebaTwCutFunction = mod.cut;
            log.lifecycle(`[VectFox CJK] Jieba TW tokenizer ready (total ${_ms(tStart)}ms)`);
            return true;
        } catch (error) {
            const msg = error?.message || String(error);
            const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /aborted|timeout|timed out/i.test(msg);
            const elapsed = _ms(tStart);
            if (isTimeout) {
                // All Jieba TW assets are vendored under core/vendor/jieba/ — the
                // loader never hits a CDN. A timeout here means the SillyTavern
                // static file server stalled the request, not a network issue.
                log.warn(`[VectFox CJK] Jieba TW: TIMED OUT during stage "${stage}" after ${elapsed}ms total. Falling back to Intl.Segmenter. All TW assets are served locally from core/vendor/jieba/ — a timeout here means the SillyTavern server stalled. Likely causes: (1) the Node event loop is choked by a long-running plugin request (e.g. a large chunk import or corpus-stats scan); (2) browser cache / Service Worker interference — try a hard reload (Ctrl+Shift+R); (3) endpoint security software intercepting the file read.`);
            } else {
                log.warn(`[VectFox CJK] Jieba TW: failed during stage "${stage}" after ${elapsed}ms total: ${msg}`);
            }
            return false;
        }
    })();

    try {
        return await jiebaTwLoadPromise;
    } finally {
        jiebaTwLoadPromise = null;
    }
}

function _getTinySegmenter() {
    if (!tinySegmenterInstance) {
        tinySegmenterInstance = new TinySegmenter();
    }
    return tinySegmenterInstance;
}

/**
 * Porter Stemmer cache (LRU-style with max size)
 */
const stemmerCache = new Map();
const STEMMER_CACHE_MAX = 10000;

/**
 * Porter Stemmer Algorithm
 * Reduces words to their root form for better matching
 * Examples: "running" → "run", "adventurers" → "adventur"
 *
 * @param {string} word - Word to stem
 * @returns {string} Stemmed word
 */
function porterStemmer(word) {
    if (!word || word.length <= 2) return word;

    // CJK characters: Porter stemming doesn't apply (no English morphology)
    if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(word)) return word;

    // Check cache first
    if (stemmerCache.has(word)) {
        return stemmerCache.get(word);
    }

    let stem = word.toLowerCase();
    let preserveE = false; // Track if we added 'e' via suffix rules

    // Step 1a: Remove plurals
    if (stem.endsWith('sses')) {
        stem = stem.slice(0, -2);
    } else if (stem.endsWith('ies')) {
        stem = stem.slice(0, -2);
    } else if (stem.endsWith('ss')) {
        // Keep as is
    } else if (stem.endsWith('s')) {
        stem = stem.slice(0, -1);
    }

    // Step 1b: Handle -ed and -ing
    const hasVowel = (s) => /[aeiou]/.test(s);

    if (stem.endsWith('eed')) {
        // Rule: EED → EE (simplified for better stemming)
        // Apply if there's any base remaining after removing 'eed'
        const base = stem.slice(0, -3); // Remove 'eed'
        if (base.length > 0) {
            stem = base + 'ee'; // agreed → agree, freed → free
            preserveE = true; // Preserve the double 'e'
        }
    } else if (stem.endsWith('ed')) {
        const base = stem.slice(0, -2);
        if (hasVowel(base)) {
            stem = base;
            // Handle double consonants
            if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) {
                stem += 'e';
                preserveE = true;
            } else if (/([^aeiouslz])\1$/.test(stem)) {
                stem = stem.slice(0, -1);
            }
        }
    } else if (stem.endsWith('ing')) {
        const base = stem.slice(0, -3);
        if (hasVowel(base)) {
            stem = base;
            if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) {
                stem += 'e';
                preserveE = true;
            } else if (/([^aeiouslz])\1$/.test(stem)) {
                stem = stem.slice(0, -1);
            }
        }
    }

    // Step 2: Common suffix replacements
    const step2Mappings = [
        ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
        ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
        ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
        ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
        ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
    ];

    for (const [suffix, replacement] of step2Mappings) {
        if (stem.endsWith(suffix) && stem.length > suffix.length + 2) {
            stem = stem.slice(0, -suffix.length) + replacement;
            if (replacement.endsWith('e')) preserveE = true;
            break;
        }
    }

    // Step 3: More suffix handling
    const step3Mappings = [
        ['icate', 'ic'], ['ative', ''], ['alize', 'al'],
        ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
    ];

    for (const [suffix, replacement] of step3Mappings) {
        if (stem.endsWith(suffix) && stem.length > suffix.length + 2) {
            stem = stem.slice(0, -suffix.length) + replacement;
            break;
        }
    }

    // Step 4: Remove final 'e' in certain cases
    // Skip if 'e' was intentionally added by suffix replacement rules
    if (stem.endsWith('e') && stem.length > 3 && !preserveE) {
        const base = stem.slice(0, -1);
        // Count vowel-consonant sequences (m)
        const vcCount = (base.match(/[aeiou]+[^aeiou]+/g) || []).length;
        // Remove 'e' only if m > 1, OR if m = 1 and it doesn't end with CVC pattern
        const isCVC = /[^aeiou][aeiou][^aeiouxwy]$/.test(base);
        if (vcCount > 1 || (vcCount === 1 && !isCVC)) {
            stem = base;
        }
    }

    // Cache the result (with LRU eviction)
    if (stemmerCache.size >= STEMMER_CACHE_MAX) {
        const firstKey = stemmerCache.keys().next().value;
        stemmerCache.delete(firstKey);
    }
    stemmerCache.set(word, stem);

    return stem;
}

/**
 * Enhanced tokenizer with stemming and stop word removal
 * @param {string} text - Text to tokenize
 * @param {object} options - Tokenization options
 * @param {boolean} options.stem - Apply Porter stemming (default: true)
 * @param {boolean} options.removeStopWords - Remove stop words (default: true)
 * @param {number} options.minLength - Minimum token length (default: 2)
 * @param {boolean} options.dedupe - Deduplicate tokens (default: true). Set to false to preserve term frequency for sparse-vector encoding.
 * @returns {string[]} Array of processed tokens
 */
function tokenize(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    const {
        stem = true,
        removeStopWords = true,
        minLength = 2,
        dedupe = true
    } = options;

    // Extract CJK word tokens using Intl.Segmenter (falls back to character-level)
    const cjkTokens = extractCJKTokens(text);

    // Strip segmented-script spans (CJK/Kana/Hangul/Thai/...) before Latin
    // tokenization; extractCJKTokens already handled them, so removing them
    // here prevents double-counting and keeps Latin tokens clean.
    const latinText = text.replace(CJK_SPAN_RE, ' ');

    // Normalize and split Latin
    let tokens = latinText
        .toLowerCase()
        .replace(NON_WORD_RE, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(token => token.length >= minLength);

    // Combine: CJK single chars are valid tokens (skip minLength filter)
    tokens = tokens.concat(cjkTokens);

    // Remove stop words — only for the locales this collection's mode actually uses.
    if (removeStopWords) {
        const locales = stopLocalesForMode(cjkTokenizerMode);
        tokens = tokens.filter(token => !isStopWord(token, locales));
    }

    // Apply Porter stemming (CJK tokens are returned unchanged by porterStemmer)
    if (stem) {
        tokens = tokens.map(token => {
            // Don't stem very short words or numbers
            if (token.length <= 3 || /^\d+$/.test(token)) return token;
            return porterStemmer(token);
        });
    }

    // Deduplicate (preserve order). Skip when caller needs raw TF (sparse-vector encoder).
    return dedupe ? [...new Set(tokens)] : tokens;
}

/**
 * Calculate term frequency (TF) for a document
 * @param {string[]} tokens - Document tokens
 * @returns {Map<string, number>} Map of term -> frequency
 */
function calculateTermFrequency(tokens) {
    const tf = new Map();
    for (const token of tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
    }
    return tf;
}

/**
 * Calculate inverse document frequency (IDF) for all terms
 * BM25+ IDF formula: max(0, log((N - df + 0.5) / (df + 0.5))) + delta
 * where N = total documents, df = documents containing term, delta = 0.5
 *
 * @param {Array<Map<string, number>>} documentTermFreqs - TF maps for all documents
 * @param {number} totalDocs - Total number of documents
 * @param {number} delta - BM25+ delta smoothing (default: 0.5)
 * @returns {Map<string, number>} Map of term -> IDF score
 */
function calculateIDF(documentTermFreqs, totalDocs, delta = DEFAULT_DELTA) {
    const documentFrequency = new Map();

    // Count how many documents contain each term
    for (const tfMap of documentTermFreqs) {
        const uniqueTerms = new Set(tfMap.keys());
        for (const term of uniqueTerms) {
            documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        }
    }

    return _idfFromDocumentFrequencies(documentFrequency, totalDocs, delta);
}

/**
 * Build the IDF map directly from a pre-computed {term -> df} map. Used when
 * corpus statistics are supplied externally (full-corpus IDF mode) so the
 * scorer skips the local-candidate df pass.
 */
function _idfFromDocumentFrequencies(documentFrequency, totalDocs, delta = DEFAULT_DELTA) {
    const idf = new Map();
    for (const [term, df] of documentFrequency.entries()) {
        const rawIdf = Math.log((totalDocs - df + 0.5) / (df + 0.5));
        const idfScore = Math.max(0, rawIdf) + delta;
        idf.set(term, idfScore);
    }
    return idf;
}

/**
 * BM25+ Scorer class (Enhanced)
 * Maintains corpus statistics for efficient scoring
 *
 * Enhancements over standard BM25:
 * - Sublinear TF: log(1 + tf) prevents frequent terms from dominating
 * - Coverage bonus: +10% when all query terms match
 * - Field boosting: Title (4x), Tags (4x), Content (1x)
 * - BM25+ IDF with delta smoothing
 */
export class BM25Scorer {
    /**
     * @param {object} options - BM25+ parameters
     * @param {number} options.k1 - Term frequency saturation (default: 1.5)
     * @param {number} options.b - Length normalization (default: 0.75)
     * @param {number} options.delta - BM25+ IDF smoothing (default: 0.5)
     * @param {boolean} options.sublinearTf - Use sublinear TF: log(1+tf) (default: true)
     * @param {boolean} options.coverageBonus - Apply coverage bonus (default: true)
     * @param {boolean} options.fieldBoosting - Enable field boosting (default: false)
     */
    constructor(options = {}) {
        this.k1 = options.k1 ?? DEFAULT_K1;
        this.b = options.b ?? DEFAULT_B;
        this.delta = options.delta ?? DEFAULT_DELTA;
        this.sublinearTf = options.sublinearTf ?? true;
        this.coverageBonus = options.coverageBonus ?? true;
        this.fieldBoosting = options.fieldBoosting ?? false;

        // Corpus statistics
        this.documents = [];
        this.documentTermFreqs = [];
        this.documentLengths = [];
        this.avgDocLength = 0;
        this.idf = new Map();
        this.totalDocs = 0;
    }

    /**
     * Index a corpus of documents
     * @param {Array<{text: string, title?: string, tags?: string[], id?: any}>} documents - Documents to index
     * @param {object} [opts]
     * @param {{totalDocs: number, documentFrequencies: Map<string, number>, avgDocLength?: number}} [opts.corpusStats]
     *   When supplied, IDF and avgDocLength are computed from these external stats
     *   (full-corpus mode) instead of from the candidate set. Used by the A1/A2
     *   bm25_use_corpus_idf path — see core/corpus-stats.js.
     */
    indexDocuments(documents, opts = {}) {
        const corpusStats = opts.corpusStats || null;
        this.documents = documents;
        this.totalDocs = documents.length;
        this.documentTermFreqs = [];
        this.documentLengths = [];

        // Tokenize and calculate TF for each document
        let totalLength = 0;
        for (const doc of documents) {
            let allTokens = [];
            let contentLength = 0; // Track only content tokens for length normalization

            // Field boosting: duplicate title/tag tokens for higher weight
            // Note: Boosted tokens count for TF but NOT for document length
            // This prevents length normalization from penalizing field-boosted docs
            if (this.fieldBoosting) {
                // Title tokens (4x weight)
                if (doc.title) {
                    const titleTokens = tokenize(doc.title);
                    for (let i = 0; i < 4; i++) {
                        allTokens.push(...titleTokens);
                    }
                }
                // Tag tokens (4x weight) - high weight since tags are curated keywords
                if (doc.tags && Array.isArray(doc.tags)) {
                    const tagTokens = doc.tags.flatMap(tag => tokenize(tag));
                    for (let i = 0; i < 4; i++) {
                        allTokens.push(...tagTokens);
                    }
                }
            }

            // Content tokens (1x weight)
            const contentTokens = tokenize(doc.text);
            allTokens.push(...contentTokens);
            contentLength = contentTokens.length;

            const tf = calculateTermFrequency(allTokens);

            this.documentTermFreqs.push(tf);
            // Use content length for normalization, not total tokens
            this.documentLengths.push(contentLength);
            totalLength += contentLength;
        }

        // Length normalization and IDF: prefer external corpus stats when supplied
        // (full-corpus mode). This makes "rare globally" terms keep high IDF even
        // when the candidate set is topically clustered around them.
        if (corpusStats && Number.isFinite(corpusStats.totalDocs) && corpusStats.totalDocs > 0 && corpusStats.documentFrequencies) {
            this.corpusN = corpusStats.totalDocs;
            this.avgDocLength = Number.isFinite(corpusStats.avgDocLength) && corpusStats.avgDocLength > 0
                ? corpusStats.avgDocLength
                : (this.totalDocs > 0 ? totalLength / this.totalDocs : 0);
            this.idf = _idfFromDocumentFrequencies(corpusStats.documentFrequencies, this.corpusN, this.delta);
            log.verbose(`[BM25+] Indexed ${this.totalDocs} candidates with FULL-CORPUS IDF (corpusN=${this.corpusN}, terms=${corpusStats.documentFrequencies.size}, avgLen=${this.avgDocLength.toFixed(1)})`);
        } else {
            this.corpusN = this.totalDocs;
            this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0;
            this.idf = calculateIDF(this.documentTermFreqs, this.totalDocs, this.delta);
            log.verbose(`[BM25+] Indexed ${this.totalDocs} documents, avg length: ${this.avgDocLength.toFixed(1)} tokens, sublinearTf=${this.sublinearTf}, fieldBoosting=${this.fieldBoosting}`);
        }
    }

    /**
     * Score a single document against a query
     * BM25+ formula with sublinear TF:
     * tf_smart = log(1 + raw_tf)
     * score = Σ(IDF(qi) * (tf_smart(qi, D) * (k1 + 1)) / (tf_smart(qi, D) + k1 * lengthNorm))
     *
     * @param {string[]} queryTokens - Query tokens
     * @param {number} docIndex - Document index in corpus
     * @returns {number} BM25+ score
     */
    scoreDocument(queryTokens, docIndex) {
        if (this.avgDocLength === 0) return 0; // Avoid division by zero
        if (!queryTokens || queryTokens.length === 0) return 0;
        if (docIndex < 0 || docIndex >= this.totalDocs) return 0;

        const docTF = this.documentTermFreqs[docIndex];
        const docLength = this.documentLengths[docIndex];

        // Critical null checks to prevent crash with empty/invalid data
        if (!docTF || docLength === undefined || docLength === null) return 0;

        let score = 0;
        let matchedTerms = 0;

        for (const token of queryTokens) {
            const rawTf = docTF.get(token) || 0;
            if (rawTf === 0) continue; // Term not in document

            matchedTerms++;

            // Sublinear TF: log(1 + tf) prevents frequent terms from dominating
            const tf = this.sublinearTf ? Math.log(1 + rawTf) : rawTf;

            const idf = this.idf.get(token) || 0;

            // Length normalization factor
            const lengthNorm = 1 - this.b + this.b * (docLength / this.avgDocLength);

            // BM25+ term score
            const termScore = idf * (tf * (this.k1 + 1)) / (tf + this.k1 * lengthNorm);

            score += termScore;
        }

        // Coverage bonus: +10% when all query terms match
        if (this.coverageBonus && queryTokens.length > 0) {
            const coverage = matchedTerms / queryTokens.length;
            const bonus = coverage * 0.1; // Up to 10% bonus
            score *= (1 + bonus);
        }

        return score;
    }

    /**
     * Score all documents against a query and return ranked results
     * @param {string} query - Search query
     * @param {number} topK - Number of top results to return
     * @returns {Array<{index: number, score: number, document: object}>} Ranked results
     */
    search(query, topK = 10) {
        const queryTokens = tokenize(query);

        if (queryTokens.length === 0) {
            log.warn('[BM25] Empty query, returning empty results');
            return [];
        }

        // Score all documents
        const scores = [];
        for (let i = 0; i < this.totalDocs; i++) {
            const score = this.scoreDocument(queryTokens, i);
            scores.push({
                index: i,
                score: score,
                document: this.documents[i]
            });
        }

        // Sort by score descending and take topK
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK);
    }

    /**
     * Score specific documents (by indices) against a query
     * Useful when you already have candidates from vector search
     *
     * @param {string} query - Search query
     * @param {Array<number>} indices - Document indices to score
     * @returns {Map<number, number>} Map of index -> BM25 score
     */
    scoreDocumentSubset(query, indices) {
        const queryTokens = tokenize(query);
        const scores = new Map();

        if (queryTokens.length === 0) {
            return scores;
        }

        for (const idx of indices) {
            if (idx >= 0 && idx < this.totalDocs) {
                const score = this.scoreDocument(queryTokens, idx);
                scores.set(idx, score);
            }
        }

        return scores;
    }
}

/**
 * Create a BM25 scorer from search results
 * Helper function for quick BM25 scoring without pre-indexing
 *
 * @param {Array<{text: string, hash?: number}>} results - Search results
 * @param {object} options - BM25 parameters
 * @returns {BM25Scorer} Initialized BM25 scorer
 */
export function createBM25Scorer(results, options = {}) {
    const { corpusStats, ...scorerOptions } = options;
    const scorer = new BM25Scorer(scorerOptions);
    scorer.indexDocuments(results, { corpusStats });
    return scorer;
}

/**
 * Apply BM25 scores to search results and re-rank
 * Combines vector similarity with BM25 keyword relevance
 *
 * @param {Array} results - Vector search results [{text, score, hash, ...}]
 * @param {string} query - Search query
 * @param {object} options - Scoring options
 * @param {number} options.k1 - BM25 k1 parameter
 * @param {number} options.b - BM25 b parameter
 * @param {number} options.alpha - Weight for vector score (default: 0.5)
 * @param {number} options.beta - Weight for BM25 score (default: 0.5)
 * @returns {Array} Re-ranked results with BM25 scores
 */
export function applyBM25Scoring(results, query, options = {}) {
    if (!results || results.length === 0) return [];
    if (!query || typeof query !== 'string') return results;

    const {
        k1 = DEFAULT_K1,
        b = DEFAULT_B,
        alpha = 0.5,  // Weight for vector similarity
        beta = 0.5,   // Weight for BM25 score
        queryTokens: preTokenized = null,  // Pre-computed tokens (CJK-aware); bypasses internal tokenize()
        corpusStats = null  // When provided, IDF uses full-corpus N + df (see core/corpus-stats.js)
    } = options;

    const idfMode = corpusStats ? 'corpus' : 'local';
    log.verbose(`[BM25] Applying BM25 scoring to ${results.length} results (k1=${k1}, b=${b}, α=${alpha}, β=${beta}, idf=${idfMode})`);

    // Create BM25 scorer
    const scorer = createBM25Scorer(results, { k1, b, corpusStats });

    // Score all results — use pre-tokenized tokens when available (caller handles CJK + stemming)
    const queryTokens = preTokenized && preTokenized.length > 0 ? preTokenized : tokenize(query);
    if (queryTokens.length === 0) {
        log.warn('[BM25] Empty query after tokenization, returning original results');
        return results;
    }
    
    const bm25Scores = results.map((_, idx) => scorer.scoreDocument(queryTokens, idx));
    const maxBM25Score = bm25Scores.length > 0 ? Math.max(...bm25Scores, 0.0001) : 0.0001;

    // Combine scores
    const scoredResults = results.map((result, idx) => {
        const bm25Score = scorer.scoreDocument(queryTokens, idx);
        const normalizedBM25 = maxBM25Score > 0 ? bm25Score / maxBM25Score : 0;

        // Normalize vector score to [0, 1] range (assuming it's already in [0, 1])
        const normalizedVector = result.originalScore ?? result.score;

        // Combined score: weighted sum of vector and BM25 scores
        const combinedScore = alpha * normalizedVector + beta * normalizedBM25;

        return {
            ...result,
            score: combinedScore,
            vectorScore: normalizedVector,
            bm25Score: bm25Score,
            normalizedBM25: normalizedBM25,
            originalScore: result.originalScore ?? result.score
        };
    });

    // Sort by combined score
    scoredResults.sort((a, b) => b.score - a.score);

    log.verbose(`[BM25] Top result: vector=${scoredResults[0].vectorScore.toFixed(4)}, bm25=${scoredResults[0].bm25Score.toFixed(4)}, combined=${scoredResults[0].score.toFixed(4)}`);

    return scoredResults;
}

// ---------------------------------------------------------------------------
// Script detection, locale mapping and segmenter resolution live in
// ./script-segmentation.js (shared with query-keyword-extractor.js so the
// ingest and query paths cannot drift). CJK_SPAN_RE / KANA_RE / getSegmenter
// are imported above.

/**
 * Tokenize a single segmented span using the run-merging strategy.
 *
 * The segmenter often returns ALL single-char segments for unknown proper names
 * (e.g. character names like 偲雅伶绪). But when a name appears adjacent to a
 * known word in the same span (e.g. 向偲雅伶绪问候), the "all single" check
 * used previously failed and fragmented the name.
 *
 * Run-merging fix: accumulate consecutive single-char word-like segments into a
 * "run". Flush the run as one compound token when a multi-char word interrupts it
 * or the span ends. This preserves known words (聚餐, 问候) as individual tokens
 * while keeping unknown proper names intact.
 *
 * @param {Intl.Segmenter} segmenter
 * @param {string} span
 * @returns {string[]}
 */
function _segmentSpan(segmenter, span) {
    const wordSegs = [...segmenter.segment(span)].filter(s => s.isWordLike);
    if (wordSegs.length === 0) return span.length >= 2 ? [span] : [];

    const tokens = [];
    let singleRun = '';

    for (const seg of wordSegs) {
        if (seg.segment.length === 1) {
            // Accumulate single-char segments into a run (potential proper name)
            singleRun += seg.segment;
        } else {
            // Multi-char known word encountered — flush accumulated run first
            if (singleRun.length >= 2) tokens.push(singleRun);
            else if (singleRun.length === 1) tokens.push(singleRun); // keep solo chars
            singleRun = '';
            tokens.push(seg.segment);
        }
    }
    // Flush any remaining run.
    // If other multi-char tokens were already produced in this span, a final
    // solo char is a trailing suffix (e.g. '村' from '瞭望村') — drop it.
    // If this is the only output so far, keep it (e.g. '劍' as a standalone span).
    if (singleRun.length >= 2) {
        tokens.push(singleRun);
    } else if (singleRun.length === 1 && tokens.length === 0) {
        tokens.push(singleRun); // solo char span — preserve (e.g. '劍', '龍')
    }
    // else: trailing single char after known words — discard (e.g. '瞭望' + '村')

    // Safety: if nothing produced (e.g. all filtered), emit whole span
    return tokens.length > 0 ? tokens : (span.length >= 2 ? [span] : []);
}

/**
 * Fallback tokenizer used when Intl.Segmenter is unavailable.
 * Produces overlapping bigrams from each CJK span — a standard degraded-mode
 * approach for CJK BM25 that performs far better than single characters and
 * works equally well for Chinese and Japanese.
 *
 * Example: "聚餐问候" → ["聚餐", "餐问", "问候"]
 * @param {string} span
 * @returns {string[]}
 */
function _bigramFallback(span) {
    if (span.length < 2) return span.length === 1 ? [span] : [];
    const bigrams = [];
    for (let i = 0; i < span.length - 1; i++) {
        bigrams.push(span[i] + span[i + 1]);
    }
    return bigrams;
}

function _segmentWithJieba(span) {
    if (typeof jiebaCutFunction !== 'function') return null;
    try {
        const result = jiebaCutFunction(span, true);
        if (!Array.isArray(result) || result.length === 0) return null;
        const tokens = result
            .map(t => String(t).trim())
            .filter(t => t.length > 0);
        return tokens.length > 0 ? tokens : null;
    } catch (error) {
        log.warn('[VectFox CJK] Jieba tokenization failed, falling back:', error?.message || error);
        return null;
    }
}

function _segmentWithJiebaTw(span) {
    if (typeof jiebaTwCutFunction !== 'function') return null;
    try {
        const result = jiebaTwCutFunction(span, true);
        if (!Array.isArray(result) || result.length === 0) return null;
        const tokens = result
            .map(t => String(t).trim())
            .filter(t => t.length > 0);
        return tokens.length > 0 ? tokens : null;
    } catch (error) {
        log.warn('[VectFox CJK] Jieba TW tokenization failed, falling back:', error?.message || error);
        return null;
    }
}

function _segmentWithTinySegmenter(span) {
    try {
        const result = _getTinySegmenter().segment(span);
        if (!Array.isArray(result) || result.length === 0) return null;
        const tokens = result
            .map(t => String(t).trim())
            .filter(t => t.length > 0);
        return tokens.length > 0 ? tokens : null;
    } catch (error) {
        log.warn('[VectFox CJK] TinySegmenter failed, falling back:', error?.message || error);
        return null;
    }
}

/**
 * Extract CJK word tokens from text.
 *
 * Uses Intl.Segmenter with run-merging to preserve proper names while still
 * splitting known compound words. Falls back to overlapping bigrams when the
 * Segmenter API is unavailable (older environments / SillyTavern).
 *
 * Handles all scripts in CJK_SPAN_RE (CJK, Kana, Hangul, Thai, Lao, Myanmar,
 * Khmer). getSegmenter() routes each span to the right locale. To add a new
 * language, edit ./script-segmentation.js (CJK_SPAN_RE + SCRIPT_LOCALE_MAP).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractCJKTokens(text) {
    const spans = text.match(CJK_SPAN_RE);
    if (!spans) return [];

    const tokens = [];
    const _tokenizer = tokenizerForMode(cjkTokenizerMode);
    for (const span of spans) {
        // jieba mode: Chinese-only spans use Jieba if preloaded.
        // Japanese kana spans intentionally stay on Intl/tiny paths.
        if (_tokenizer === 'jieba' && !KANA_RE.test(span)) {
            const jiebaTokens = _segmentWithJieba(span);
            if (jiebaTokens) {
                for (const tok of jiebaTokens) tokens.push(tok);
                continue;
            }
        }

        // jieba_tw mode: Traditional Chinese spans use Jieba with TW dictionary if preloaded.
        if (_tokenizer === 'jieba_tw' && !KANA_RE.test(span)) {
            const twTokens = _segmentWithJiebaTw(span);
            if (twTokens) {
                for (const tok of twTokens) tokens.push(tok);
                continue;
            }
        }

        // tiny-segmenter mode: only route kana-containing spans.
        if (_tokenizer === 'tiny_segmenter' && KANA_RE.test(span)) {
            const tinyTokens = _segmentWithTinySegmenter(span);
            if (tinyTokens) {
                for (const tok of tinyTokens) tokens.push(tok);
                continue;
            }
        }

        const segmenter = getSegmenter(span);
        if (segmenter) {
            for (const tok of _segmentSpan(segmenter, span)) tokens.push(tok);
        } else {
            for (const tok of _bigramFallback(span)) tokens.push(tok);
        }
    }
    return tokens;
}

/**
 * Export Porter Stemmer for use by other modules
 */
export {
    porterStemmer,
    tokenize,
    extractCJKTokens,
    CJK_TOKENIZER_MODES,
    setCjkTokenizerMode,
    getCjkTokenizerMode,
    ensureJiebaTokenizerLoaded,
    ensureJiebaTwLoaded,
};
