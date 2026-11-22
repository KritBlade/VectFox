/**
 * Similharity's LoreBase routes, the one door every LoreBase call to them goes through (§3.1 and §3.5 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): its keys, read, written and deleted
 * (lorebase-keys.js), and its listing of this account's books with their keys and vectors (lorebase-storage.js). Each
 * call gets Similharity's Qdrant connection ready first, through the vector backend as every vector call does: after a
 * SillyTavern restart Similharity holds none until a VectFox sends it one, which a VectFox turned off never does.
 */
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { readErrorBody } from '../../shared/server-error-text.js';
import { getBackend } from '../vector-backend/index.js';

const LOREBASE_ROUTE = '/api/plugins/similharity/lorebase';
// LoreBase keeps its keys and vectors in Qdrant alone (D15 of lorebook-semantic-overhaul-passage-index.md).
const QDRANT_BACKEND = 'qdrant';

/**
 * Post to one of Similharity's LoreBase routes, once its Qdrant connection is ready.
 * @param {string} path - Under /lorebase, as 'keys/read' or 'books'
 * @param {object} body
 * @param {string} what - What the call does, for its error, as "read LoreBase's keys"
 * @returns {Promise<object>} The route's answer
 * @throws {Error} When Qdrant cannot be reached, or the route refuses the call
 */
export async function postLoreBaseRoute(path, body, what) {
    await getBackend(extension_settings.vectfox, QDRANT_BACKEND);
    const response = await fetch(`${LOREBASE_ROUTE}/${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) {
        const detail = await readErrorBody(response, response.statusText);
        throw new Error(`Similharity could not ${what} (HTTP ${response.status}): ${detail}`);
    }
    return response.json();
}
