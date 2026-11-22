/**
 * The one question before LoreBase writes what its selected entries lack: keys and vectors (plan D17 and §5.2 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md, §4.3 and §4.4 of InternalProject/Vectfox/
 * plans/executed/lorebook-multi-vector.md). Turning LoreBase on and closing the selection screen while it is on both ask it here,
 * under one rule: LoreBase stays on while any selected entry is ready, with its keys and vectors, and a book whose
 * entries are not ready waits. So it may be on when nothing is missing, when the user says to write them, or when some
 * entry is ready whatever the answer; it is off when the keys or vectors cannot be read, and when no entry is ready and
 * the user declines or LoreBase cannot write what they lack yet (writingProblem in lorebase-setup.js, for the kinds
 * they lack). Each caller sets the switch from the answer. A writing
 * that does not start, as while another run is on the progress panel, says why in a notice.
 */
import { log } from '../../sillytavern/log.js';
import { confirmPopup, noticePopup } from '../../sillytavern/popup.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { missingKeysAndVectorsLines } from './lorebase-keys-core.js';
import { writingProblem } from './lorebase-setup.js';
import { selectedEntriesNotReady, writeMissing } from './lorebase-storage.js';
import { BOTH_KINDS, kindsLacking, missingCountsOf } from './lorebase-storage-core.js';

const readyEntries = count => `${count.toLocaleString('en-US')} ${count === 1 ? 'entry that is' : 'entries that are'} ready`;

/**
 * Read what the selected entries lack and, when any lack keys or vectors, ask to write them; say why when they cannot
 * be read or written. Turning LoreBase on reads the vectors from Qdrant again, so edits made while SillyTavern was
 * closed are found.
 * @param {{isTurningOn: boolean}} options - Whether LoreBase is being turned on, so it stays off without a ready entry,
 *   or is on, so it turns off without one
 * @returns {Promise<{canBeOn: boolean, shouldWrite: boolean, pending: Awaited<ReturnType<typeof selectedEntriesNotReady>>|null}>}
 *   Whether LoreBase may be on (nothing missing, the user said to write it, or some entry ready), whether to write what
 *   is missing, and what was read, null when it could not be
 */
export async function askToWriteMissingKeysAndVectors({ isTurningOn }) {
    const offWord = isTurningOn ? 'stays off' : 'turns off';
    let pending;
    try {
        pending = await selectedEntriesNotReady(extension_settings.vectfox, { isRereading: isTurningOn });
    } catch (error) {
        log.warn(`LoreBase: the keys and vectors of its selected entries could not be read, so it ${offWord}:`, error);
        await noticePopup([
            { icon: 'fa-key', text: `LoreBase could not read the keys and vectors of its selected entries, so it ${offWord}.` },
            { name: String(error?.message || error) },
        ]);
        return { canBeOn: false, shouldWrite: false, pending: null };
    }
    if (!pending.count) return { canBeOn: true, shouldWrite: false, pending };
    const isAnyReady = pending.readyCount > 0;
    const meanwhile = isAnyReady
        ? `Until they are written, LoreBase goes on with the ${readyEntries(pending.readyCount)}.`
        : `Without them, LoreBase ${offWord}.`;
    const problem = writingProblem(extension_settings.vectfox, kindsLacking(missingCountsOf(pending)));
    if (problem) {
        await noticePopup([
            ...missingKeysAndVectorsLines(pending.count),
            { text: `LoreBase cannot write them yet. ${meanwhile}` },
            { name: problem },
        ]);
        return { canBeOn: isAnyReady, shouldWrite: false, pending };
    }
    const shouldWrite = Boolean(await confirmPopup([
        ...missingKeysAndVectorsLines(pending.count),
        { text: `Write them ${isTurningOn ? 'and turn LoreBase on' : 'now'}? A progress panel shows the writing. ${meanwhile}` },
    ], { okButton: 'Write keys and vectors', cancelButton: isAnyReady ? 'Not now' : (isTurningOn ? 'Leave off' : 'Turn LoreBase off') }));
    return { canBeOn: shouldWrite || isAnyReady, shouldWrite, pending };
}

/**
 * Write the keys and vectors askToWriteMissingKeysAndVectors read as missing, under the progress panel, once LoreBase is
 * on; the books it writes keys for lock to the open chat (writeMissing). A writing that does not start says why in a
 * notice.
 * @param {Awaited<ReturnType<typeof selectedEntriesNotReady>>|null} pending
 * @param {{booksWithChosenLocks?: Iterable<string>}} [options] - booksWithChosenLocks: the books whose lock the user set
 *   on the selection screen whose closing asked, which keep the locks the user set
 * @returns {boolean} Whether a writing was started: false when nothing is missing
 */
export function writeMissingKeysAndVectors(pending, { booksWithChosenLocks = [] } = {}) {
    if (!pending?.count) return false;
    writeMissing(extension_settings.vectfox, BOTH_KINDS, { pending, booksWithChosenLocks }).catch(error => {
        log.warn("LoreBase: the selected entries' keys and vectors were not written:", error);
        void noticePopup([{ icon: 'fa-key', text: String(error?.message || error) }]);
    });
    return true;
}
