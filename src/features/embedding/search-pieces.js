/**
 * The pieces a search text is searched in, at the embedding provider's piece size (search-pieces-core.js; plan:
 * InternalProject/Vectfox/plans/executed/search-text-pieces.md). Every search that embeds text a person or a chat
 * wrote runs its text through searchPieces, searches each piece, and merges the pieces' results as it merges its other
 * searches.
 */
import { log } from '../../sillytavern/log.js';
import { getProviderConfig } from './providers.js';
import { searchTokens, splitSearchText } from './search-pieces-core.js';

/**
 * The provider's piece size, from EMBEDDING_PROVIDERS. A provider missing from the table, as an old setting can name,
 * has none, and its text is searched whole, as before pieces existed.
 * @param {object} settings - VectFox settings; an unset provider is Local (Transformers), as the embedding requests read it
 * @returns {number}
 */
export function searchPieceTokensOf(settings) {
    return getProviderConfig(settings?.embedding_provider || 'transformers')?.searchPieceTokens ?? Infinity;
}

/**
 * @param {string} text
 * @param {object} settings - VectFox settings; the size comes from settings.embedding_provider
 * @returns {string[]} The pieces, in the text's order: [text] when it fits, [] when it is empty
 */
export function searchPieces(text, settings) {
    const pieceTokens = searchPieceTokensOf(settings);
    const pieces = splitSearchText(text, pieceTokens);
    if (pieces.length > 1) {
        log.verbose(`VectFox: a search text of about ${Math.round(searchTokens(String(text)))} tokens is searched in ${pieces.length} pieces of at most ${pieceTokens} ('${settings?.embedding_provider || 'transformers'}')`);
    }
    return pieces;
}
