/**
 * ============================================================================
 * SPARSE VECTOR ENCODER
 * ============================================================================
 * Encodes text into Qdrant-native sparse vector format `{indices, values}`
 * for use with Qdrant's `modifier: "idf"` BM25 scoring.
 *
 * Reuses tokenize() from bm25-scorer.js so the CJK tokenizer pipeline
 * (Intl.Segmenter / Jieba / Jieba-TW / TinySegmenter / bigram fallback)
 * is identical at ingest and query time.
 *
 * Token → index mapping: 32-bit FNV-1a hash. Hash collisions at ~50k unique
 * tokens are statistically negligible.
 *
 * @author VectFox
 * @since Phase 1 — Qdrant native sparse vectors
 * ============================================================================
 */

import { tokenize } from '../keyword-search/index.js';

/**
 * FNV-1a 32-bit hash. Deterministic, fast, no dependencies.
 * Returns an unsigned 32-bit integer suitable for Qdrant sparse vector indices.
 *
 * @param {string} str
 * @returns {number} uint32
 */
export function hashToken(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Tokenize text and return a sparse vector `{indices, values}` in Qdrant format.
 * Same tokenizer for ingest and query; caller is responsible for ensuring
 * the active CJK tokenizer mode matches the collection's locked mode.
 *
 * Values are raw term frequencies. Qdrant computes IDF server-side via
 * `modifier: "idf"` when the collection was created with that modifier.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.stem=true]            Apply Porter stemming for Latin tokens
 * @param {boolean} [options.removeStopWords=true] Strip stop words
 * @returns {{indices: number[], values: number[]}}
 */
export function encodeSparseVector(text, options = {}) {
    if (!text || typeof text !== 'string') {
        return { indices: [], values: [] };
    }

    // dedupe: false so repeated tokens accumulate into real term frequency for BM25.
    const tokens = tokenize(text, { ...options, dedupe: false });
    if (tokens.length === 0) {
        return { indices: [], values: [] };
    }

    // Accumulate term frequencies keyed by hash (handles collisions by summing).
    const freq = new Map();
    for (const token of tokens) {
        const idx = hashToken(token);
        freq.set(idx, (freq.get(idx) || 0) + 1);
    }

    const indices = new Array(freq.size);
    const values = new Array(freq.size);
    let i = 0;
    for (const [idx, tf] of freq) {
        indices[i] = idx;
        values[i] = tf;
        i++;
    }

    return { indices, values };
}

/**
 * Tokenize a query and return a sparse vector for Qdrant `/query` prefetch.
 *
 * Functionally identical to encodeSparseVector — queries are typically short
 * enough that TF ≈ 1 for each unique token, but we still emit accumulated TF
 * to stay symmetric with the indexed side (so a query like "Aragorn Aragorn"
 * weights that token more).
 *
 * Kept as a separate exported function so future divergence (e.g. query-side
 * weighting from importance/recency) has a clear hook.
 *
 * @param {string} text
 * @param {object} [options]
 * @returns {{indices: number[], values: number[]}}
 */
export function encodeSparseQuery(text, options = {}) {
    return encodeSparseVector(text, options);
}
