/**
 * What a backend stores for a chunk: its payload, and on Qdrant its text with its keywords appended as
 * " [KEYWORDS: harbor key]", so the sparse (BM25) vector built from that text, and a vector the plugin embeds from it,
 * carry the keywords. The live insert, the import with vectors and the Chunk Visualizer share these, so the suffix has
 * one format and a chunk stored again keeps its fields.
 */

const KEYWORD_SUFFIX = / \[KEYWORDS: [^\]]*\]$/;

/**
 * Each keyword's text, whether it is stored as a word (EventBase) or as an object with a `text` field (ChunkBase).
 *
 * @param {unknown} keywords
 * @returns {string[]}
 */
export function keywordTexts(keywords) {
    return (Array.isArray(keywords) ? keywords : [])
        .map(keyword => (typeof keyword === 'string' ? keyword : keyword?.text))
        .filter(text => typeof text === 'string' && text.trim() !== '');
}

/**
 * A chunk's text without the keyword suffix Qdrant storage appended to it.
 *
 * @param {string} text
 * @returns {string}
 */
export function textWithoutKeywordSuffix(text) {
    return String(text ?? '').replace(KEYWORD_SUFFIX, '');
}

/**
 * A chunk's text with its keywords appended, replacing a suffix the text already carries, or the bare text when it has
 * no keywords.
 *
 * @param {string} text
 * @param {unknown} keywords
 * @returns {string}
 */
export function textWithKeywordSuffix(text, keywords) {
    const bare = textWithoutKeywordSuffix(text);
    const words = keywordTexts(keywords);
    return words.length > 0 ? `${bare} [KEYWORDS: ${words.join(' ')}]` : bare;
}

/**
 * The payload a backend stores with a chunk: its metadata, with the fields VectFox keeps on every chunk (keywords,
 * importance, the summary flag and its parent) taken from the item, or from its metadata when the item does not carry
 * them, as when the Chunk Visualizer stores a chunk again or an import brings one in.
 *
 * @param {{keywords?: unknown[], importance?: number, isSummaryChunk?: boolean, parentHash?: string|number, metadata?: object}} item
 * @returns {object}
 */
export function chunkPayload(item) {
    const metadata = item.metadata || {};
    return {
        ...metadata,
        keywords: item.keywords ?? metadata.keywords ?? [],
        importance: item.importance ?? metadata.importance,
        isSummaryChunk: item.isSummaryChunk ?? metadata.isSummaryChunk,
        parentHash: item.parentHash ?? metadata.parentHash,
    };
}
