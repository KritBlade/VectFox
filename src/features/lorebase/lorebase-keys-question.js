/**
 * The one question before LoreBase writes the keys of its selected entries that have none (plan D17 and §5.2 of
 * InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md). Turning LoreBase on and closing the
 * selection screen while it is on both ask it here, under one rule: LoreBase is on only while every selected entry it
 * decides has its keys or is having them written. So it may be on when none are missing or when the user says Write
 * keys, and is off when the keys cannot be read, when LoreBase's model cannot write them yet, or when the user declines;
 * each caller sets the switch from the answer. A writing that does not start, as while another run is on the progress
 * panel, says why in a notice.
 */
import { log } from '../../sillytavern/log.js';
import { confirmPopup, noticePopup } from '../../sillytavern/popup.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { missingKeysLines } from './lorebase-keys-core.js';
import { keyWritingProblem, selectedEntriesWithoutKeys, writeKeysOfSelections } from './lorebase-keys.js';

/**
 * Read the selected entries with no keys and, when there are any, ask to write them; say why when they cannot be read
 * or written.
 * @param {{isTurningOn: boolean}} options - Whether LoreBase is being turned on, so it stays off without the keys, or is
 *   on, so it turns off
 * @returns {Promise<{canBeOn: boolean, pending: Awaited<ReturnType<typeof selectedEntriesWithoutKeys>>|null}>}
 *   Whether LoreBase may be on (none missing, or the user said Write keys), and what was read, null when it could not be
 */
export async function askToWriteMissingKeys({ isTurningOn }) {
    const offWord = isTurningOn ? 'stays off' : 'turns off';
    let pending;
    try {
        pending = await selectedEntriesWithoutKeys();
    } catch (error) {
        log.warn(`LoreBase: the keys of its selected entries could not be read, so it ${offWord}:`, error);
        await noticePopup([
            { icon: 'fa-key', text: `LoreBase could not read the keys of its selected entries, so it ${offWord}.` },
            { name: String(error?.message || error) },
        ]);
        return { canBeOn: false, pending: null };
    }
    if (!pending.count) return { canBeOn: true, pending };
    const problem = keyWritingProblem(extension_settings.vectfox);
    if (problem) {
        await noticePopup([
            ...missingKeysLines(pending.count),
            { text: `LoreBase's model cannot write them yet, so LoreBase ${offWord}.` },
            { name: problem },
        ]);
        return { canBeOn: false, pending };
    }
    const canBeOn = await confirmPopup([
        ...missingKeysLines(pending.count),
        { text: `Write them ${isTurningOn ? 'and turn LoreBase on' : 'now'}? A progress panel shows the writing. Without them, LoreBase ${offWord}.` },
    ], { okButton: 'Write keys', cancelButton: isTurningOn ? 'Leave off' : 'Turn LoreBase off' });
    return { canBeOn, pending };
}

/**
 * Write the keys askToWriteMissingKeys read as missing, under the progress panel, once LoreBase is on. A writing that
 * does not start says why in a notice.
 * @param {Awaited<ReturnType<typeof selectedEntriesWithoutKeys>>|null} pending
 * @returns {boolean} Whether a writing was started: false when none are missing
 */
export function writeMissingKeys(pending) {
    if (!pending?.count) return false;
    writeKeysOfSelections(extension_settings.vectfox, pending).catch(error => {
        log.warn("LoreBase: the selected entries' keys were not written:", error);
        void noticePopup([{ icon: 'fa-key', text: String(error?.message || error) }]);
    });
    return true;
}
