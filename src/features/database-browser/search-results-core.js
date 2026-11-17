/**
 * The Database Browser's search results when its query is searched in pieces (features/embedding searchPieces): per
 * collection, each hash once at its best score, closest first, cut to topK, as one search returns them. A collection
 * shows an error only when every piece failed there; a piece that failed beside others is in the console already.
 * Pure: no SillyTavern, no network.
 */

const scoreOf = meta => (typeof meta?.score === 'number' ? meta.score : -Infinity);

/**
 * @param {Array<Record<string, {hashes: number[], metadata: object[], error?: string}>>} pieceResults - One
 *     queryMultipleCollections answer per piece
 * @param {number} topK
 * @returns {Record<string, {hashes: number[], metadata: object[], error?: string}>}
 */
export function mergeSearchPieceResults(pieceResults, topK) {
    if (pieceResults.length === 1) return pieceResults[0];
    const merged = {};
    for (const collectionId of new Set(pieceResults.flatMap(results => Object.keys(results)))) {
        const answers = pieceResults.map(results => results[collectionId]).filter(Boolean);
        const searched = answers.filter(answer => !answer.error);
        if (!searched.length) {
            merged[collectionId] = answers[0];
            continue;
        }
        const bestByHash = new Map();
        for (const { hashes = [], metadata = [] } of searched) {
            hashes.forEach((hash, index) => {
                const meta = metadata[index] || {};
                if (!bestByHash.has(hash) || scoreOf(meta) > scoreOf(bestByHash.get(hash))) bestByHash.set(hash, meta);
            });
        }
        const kept = [...bestByHash].sort(([, first], [, second]) => scoreOf(second) - scoreOf(first)).slice(0, topK);
        merged[collectionId] = { hashes: kept.map(([hash]) => hash), metadata: kept.map(([, meta]) => meta) };
    }
    return merged;
}
