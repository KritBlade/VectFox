/**
 * The collections Vectorize Content made from the sources it no longer reads: character cards, documents, web pages,
 * wikis and YouTube transcripts (D12 and §4.5 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-
 * index.md). Nothing in VectFox reads them, so they are deleted at start-up and an export of one is refused at import.
 * Pure: no SillyTavern, no network.
 */
import { COLLECTION_PREFIXES, parseRegistryKey } from '../../shared/collection-ids.js';

/** Stored content types of a character card, with the older name a stored type can carry. */
const CHARACTER_TYPES = new Set(['character', 'persona']);

/** Stored content types of the outside sources, with the older names a stored type can carry. */
const OUTSIDE_TYPES = new Set(['document', 'url', 'wiki', 'youtube', 'file', 'doc', 'paste', 'select', 'current']);

/** Collections VectFox still reads, whatever type their metadata stores: chat memory, and old lorebooks (B10's). */
const KEPT_PREFIXES = [COLLECTION_PREFIXES.VECTFOX_EVENTBASE, COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT, COLLECTION_PREFIXES.VECTFOX_LOREBOOK];

/**
 * Which retired source a collection came from: `character`, `outside` (documents, web pages, wikis and YouTube, which
 * all took the document prefix), or null for any other collection.
 *
 * @param {string} collectionId - The bare ID
 * @param {string|undefined} contentType - The type its metadata stores, when it stores one
 * @returns {'character'|'outside'|null}
 */
export function retiredContentKindOf(collectionId, contentType) {
    const id = String(collectionId ?? '');
    if (KEPT_PREFIXES.some(prefix => id.startsWith(prefix))) return null;
    const type = String(contentType ?? '');
    if (id.startsWith(COLLECTION_PREFIXES.VECTFOX_CHARACTER) || CHARACTER_TYPES.has(type)) return 'character';
    if (id.startsWith(COLLECTION_PREFIXES.VECTFOX_DOCUMENT) || OUTSIDE_TYPES.has(type)) return 'outside';
    return null;
}

/**
 * The registry's collections from retired sources.
 *
 * @param {string[]} registryKeys - The collection registry, "backend:id" or a bare ID
 * @param {(registryKey: string, collectionId: string) => string|undefined} contentTypeOf - The type a collection's
 *     metadata stores
 * @returns {Array<{registryKey: string, collectionId: string, backend: string|null, kind: 'character'|'outside'}>}
 */
export function retiredContentCollections(registryKeys, contentTypeOf) {
    return registryKeys.flatMap((registryKey) => {
        const { backend, collectionId } = parseRegistryKey(registryKey);
        const kind = retiredContentKindOf(collectionId, contentTypeOf(registryKey, collectionId));
        return kind ? [{ registryKey, collectionId, backend, kind }] : [];
    });
}

/**
 * The notice once some are deleted: why, how many from character cards and how many from the outside sources, that
 * chat memory is untouched, and how many others could not be deleted.
 *
 * @param {{deleted: Array<{kind: 'character'|'outside'}>, failedCount: number}} outcome
 * @returns {object[]} The dialog's lines (sillytavern/popup-core.js)
 */
export function retiredContentNoticeLines({ deleted, failedCount }) {
    const characterCount = deleted.filter(collection => collection.kind === 'character').length;
    const outsideCount = deleted.length - characterCount;
    const lines = [{ icon: 'fa-circle-info', text: 'Vectorize Content now reads only chats, so VectFox deleted the collections it had made from other sources.' }];
    if (characterCount) lines.push({ parts: [{ text: 'From character cards: ' }, { name: characterCount }] });
    if (outsideCount) lines.push({ parts: [{ text: 'From documents, web pages, wikis and YouTube: ' }, { name: outsideCount }] });
    lines.push({ text: 'Chat memory is untouched: EventBase keeps every event.' });
    if (failedCount) {
        lines.push({
            icon: 'fa-triangle-exclamation',
            parts: [{ text: 'VectFox could not delete ' }, { name: failedCount }, { text: ' others. It tries again at the next start.' }],
        });
    }
    return lines;
}
