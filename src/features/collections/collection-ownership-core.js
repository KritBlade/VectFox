/**
 * Which collections are this SillyTavern account's. Collection discovery registers every collection on the server,
 * other accounts' too, and a chat imported from another account keeps its chat UUID, so neither the registry nor a
 * collection's chat UUID says whose a collection is. A collection's ID names the persona it was made under
 * (buildEventBaseCollectionId), its metadata carries the creatorHandle registerCollection stamps under that persona,
 * and the account's chats lock the collections they use. Pure: reads only the settings and names it is given.
 * Covered by tests/collection-ownership-core.test.js.
 */

import { isCollectionIdOfHandle, parseRegistryKey, sanitizeHandleId } from '../../shared/collection-ids.js';
import { chatLocksOf } from './collection-lock-cleanup-core.js';

/**
 * The persona handles of an account, from its persona names: the handle each one's collection IDs name (sanitizeHandleId).
 *
 * @param {string[]} personaNames
 * @returns {Set<string>}
 */
export function accountHandlesOf(personaNames) {
    return new Set(personaNames.filter(name => typeof name === 'string' && name.trim()).map(name => sanitizeHandleId(name)));
}

/**
 * Whether a collection is this account's: its ID names one of the account's persona handles as the one it was made
 * under, or its metadata, under the registry key or the bare ID, carries a creatorHandle (stamped only under a persona
 * whose handle the ID holds, so by this account) or a lock to one of the account's chats.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {string} registryKey - "backend:id", or a bare ID from older versions
 * @param {Set<string>} accountHandles - accountHandlesOf the account's persona names
 * @returns {boolean}
 */
export function isCollectionOfAccount(settings, registryKey, accountHandles) {
    const { collectionId } = parseRegistryKey(registryKey);
    if ([...accountHandles].some(handle => isCollectionIdOfHandle(collectionId, handle))) return true;
    return [registryKey, collectionId].some(key => {
        const meta = settings?.collections?.[key];
        return Boolean(meta?.creatorHandle) || chatLocksOf(meta).length > 0;
    });
}
