/**
 * Deleting the collections Vectorize Content made from the sources it no longer reads (retired-content-collections-
 * core.js), once collection discovery has filled the registry. src/app/retired-collections.js runs it at start-up and
 * shows its notice lines beside the old lorebooks'. A collection that could not be deleted is tried again at the next
 * start.
 */
import { log } from '../../sillytavern/log.js';
import { deleteCollectionWhereDiscovered, getCollectionRegistry } from './collection-loader.js';
import { getCollectionMeta } from './collection-metadata.js';
import { retiredContentCollections, retiredContentNoticeLines } from './retired-content-collections-core.js';

/**
 * Delete the registry's collections from retired sources. Never throws.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<object[]>} The notice's lines, none when nothing was deleted
 */
export async function deleteRetiredContentCollections(settings) {
    try {
        // Metadata is keyed by the registry key, and by the bare ID in older versions.
        const contentTypeOf = (registryKey, collectionId) => getCollectionMeta(registryKey).contentType ?? getCollectionMeta(collectionId).contentType;
        const collections = retiredContentCollections([...getCollectionRegistry()], contentTypeOf);
        if (!collections.length) return [];
        const deleted = [];
        let failedCount = 0;
        for (const collection of collections) {
            if (await deleteCollectionWhereDiscovered(collection, settings, 'VectFox')) deleted.push(collection);
            else failedCount += 1;
        }
        log.lifecycle(`VectFox: deleted ${deleted.length} of ${collections.length} collection(s) from sources Vectorize Content no longer reads`);
        return deleted.length ? retiredContentNoticeLines({ deleted, failedCount }) : [];
    } catch (error) {
        log.error('VectFox: deleting the collections of sources Vectorize Content no longer reads failed:', error);
        return [];
    }
}
