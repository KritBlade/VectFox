/**
 * ============================================================================
 * VECTFOX CLEANUP — EventBase's window records, trimmed once to what their collections cannot show
 * ============================================================================
 * EventBase's window record (each collection's eventbaseProgress.extractedWindows) keeps only the windows read that the
 * collection's events do not show (InternalProject/Vectfox/plans/eventbase-window-record.md). Records written before
 * list every window read: still right, only bigger than needed. This one-time cleanup (§3.6) loads the events of every
 * EventBase and archive collection on the backend in use whose record lists windows, and loading trims the record of
 * the windows they show. Once every one of them read, or came back without payload, which no later start changes,
 * `eventbase_window_records_trimmed` is set; a start where any listing failed tries again.
 *
 * Not one of the settings-migration-* files: those make no network call, and this one reads each collection's events,
 * so network-startup.js runs it once collection discovery has filled the registry, as it runs retired-collections.js.
 * A collection on another backend is trimmed when it is first used there. Covered by
 * tests/eventbase-window-record-cleanup.test.js.
 * ============================================================================
 */

import { getCollectionRegistry } from '../features/collections/index.js';
import { loadEventWindows, readEventBaseProgress } from '../features/eventbase/index.js';
import { COLLECTION_PREFIXES, getRegistryBackend, parseRegistryKey } from '../shared/collection-ids.js';
import { log } from '../sillytavern/log.js';
import { saveSettingsDebounced } from '../sillytavern/settings.js';

/** Whether a collection ID is an EventBase or archive collection's. */
const isEventBaseCollection = collectionId => collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)
    || collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT);

/**
 * Trim, once, every window record on the backend in use of the windows its collection's events show.
 *
 * @param {object} settings - extension_settings.vectfox
 * @returns {Promise<{trimmedCount: number, failedCount: number, collectionCount: number}|null>} How many of the
 *   collections read had windows trimmed and how many could not be read; null once the flag is set
 */
export async function trimEventBaseWindowRecords(settings) {
    if (settings.eventbase_window_records_trimmed) return null;
    const backend = getRegistryBackend(settings.vector_backend);
    const registryKeys = getCollectionRegistry().filter(registryKey => {
        const parsed = parseRegistryKey(registryKey);
        return parsed.backend === backend && isEventBaseCollection(parsed.collectionId || '')
            && (readEventBaseProgress(registryKey).extractedWindows?.length ?? 0) > 0;
    });
    let trimmedCount = 0;
    let failedCount = 0;
    for (const registryKey of registryKeys) {
        const windowsBefore = readEventBaseProgress(registryKey).extractedWindows?.length ?? 0;
        const answer = await loadEventWindows(registryKey, settings);
        if (!answer.isRead && !answer.isWithoutPayload) failedCount += 1;
        if ((readEventBaseProgress(registryKey).extractedWindows?.length ?? 0) < windowsBefore) trimmedCount += 1;
    }
    const outcome = { trimmedCount, failedCount, collectionCount: registryKeys.length };
    if (failedCount > 0) {
        log.warn(`[VectFox] EventBase window record cleanup: ${failedCount} of ${registryKeys.length} collection(s) could not be read; the next start tries again`);
        return outcome;
    }
    settings.eventbase_window_records_trimmed = true;
    saveSettingsDebounced();
    log.lifecycle(`[VectFox] EventBase window record cleanup on ${backend}: ${trimmedCount} of ${registryKeys.length} record(s) trimmed`);
    return outcome;
}
