/**
 * LoreBase and SillyTavern's Vector Storage (plan §5.9 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). Vector Storage's World Info search force-activates lorebook entries by
 * similarity, so a selected entry would go in whole even when Luna leaves it out, and LoreBase cannot take those
 * entries back; so the two never run together. Turning LoreBase on first asks to have the selected entries with no keys
 * keyed (D17), then asks to turn that search off, and LoreBase stays off when the user declines either. When the search is on again at a reply, from its checkbox, its command or another session's
 * settings, the same question comes before any interceptor runs, so once it is off Vector Storage forces nothing into
 * that reply; until it is answered LoreBase sits out (isLoreBaseActive). Vector Storage's chat-message and file search
 * are never touched.
 */
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { log } from '../../sillytavern/log.js';
import { choicePopup, confirmPopup, noticePopup } from '../../sillytavern/popup.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { isVectorStorageWorldInfoOn, turnOffVectorStorageWorldInfo } from '../../sillytavern/vector-storage.js';
import { missingKeysLines } from './lorebase-keys-core.js';
import { keyWritingProblem, selectedEntriesWithoutKeys, writeKeysOfSelections } from './lorebase-keys.js';
import { isLoreBaseBackend, isLoreBaseSwitchedOn, saveLoreBaseSwitch, turnLoreBaseOff } from './lorebase-switch.js';

const WHY_THEY_CONFLICT = {
    text: 'Vector Storage sends lorebook entries by its own search, so an entry you select for LoreBase would go in whole, even when LoreBase leaves it out.',
};

function showNotTurnedOffToast() {
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(
        "Vector Storage's World Info did not turn off, so LoreBase stays out of replies. Untick Enabled for World Info in Vector Storage's settings.",
        'VectFox — LoreBase',
        { timeOut: 15000 },
    );
}

/**
 * Whether the user agrees to have the selected entries with no keys keyed now (D17): said when keys cannot be read or
 * written, which leaves LoreBase off; asked when there are any, no leaving LoreBase off; true when there are none.
 * @param {Awaited<ReturnType<typeof selectedEntriesWithoutKeys>>|null} pending - null when the keys could not be read
 * @param {string} readProblem - Why they could not be read
 * @returns {Promise<boolean>}
 */
async function isKeyingAgreed(pending, readProblem) {
    if (!pending) {
        await noticePopup([
            { icon: 'fa-key', text: 'LoreBase could not read the keys of its selected entries, so it stays off.' },
            { name: readProblem },
        ]);
        return false;
    }
    if (!pending.count) return true;
    const problem = keyWritingProblem(extension_settings.vectfox);
    if (problem) {
        await noticePopup([
            { icon: 'fa-key', text: "LoreBase stays off: its model writes the keys of the selected entries that have none, and it can't yet." },
            { name: problem },
        ]);
        return false;
    }
    return confirmPopup([
        ...missingKeysLines(pending.count),
        { text: 'Write them and turn LoreBase on? A progress panel shows the writing. No leaves LoreBase off.' },
    ], { okButton: 'Write keys', cancelButton: 'Leave off' });
}

/**
 * Turn LoreBase on: only on Qdrant, which keeps its keys (D15), after the user agrees to have the selected entries
 * with no keys keyed (D17), and after asking to turn off Vector Storage's World Info search when it is on. Once on,
 * those keys are written under VectFox's progress panel.
 * @returns {Promise<boolean>} Whether LoreBase is on afterwards: not off Qdrant, not when keys cannot be read or
 *   written or the user leaves it off, not when the user keeps that search, and not when it would not turn off
 */
export async function turnLoreBaseOn() {
    if (!isLoreBaseBackend()) {
        await noticePopup([
            { icon: 'fa-database', text: 'LoreBase needs Qdrant: it keeps the keys its model writes for each entry there.' },
            { text: 'Choose Qdrant as the vector backend, then turn LoreBase on.' },
        ]);
        return false;
    }
    let pending = null;
    let readProblem = '';
    try {
        pending = await selectedEntriesWithoutKeys();
    } catch (error) {
        log.warn('LoreBase: the keys of its selected entries could not be read, so it stays off:', error);
        readProblem = String(error?.message || error);
    }
    if (!await isKeyingAgreed(pending, readProblem)) return false;
    if (isVectorStorageWorldInfoOn()) {
        const isAgreed = await confirmPopup([
            { icon: 'fa-triangle-exclamation', text: "SillyTavern's Vector Storage has World Info on, and it conflicts with LoreBase." },
            WHY_THEY_CONFLICT,
            { text: "Turn it off? Vector Storage's chat and file search stay on. Keep it on, and LoreBase stays off." },
        ], { okButton: 'Turn it off', cancelButton: 'Keep it on' });
        if (!isAgreed) return false;
        if (!await turnOffVectorStorageWorldInfo()) {
            showNotTurnedOffToast();
            return false;
        }
    }
    saveLoreBaseSwitch(true);
    if (pending.count) {
        writeKeysOfSelections(extension_settings.vectfox, pending)
            .catch(error => log.warn('LoreBase: the selected entries\' keys could not be written:', error));
    }
    return true;
}

/**
 * Before a reply's interceptors run: when Vector Storage's World Info search is on again while LoreBase is on, ask which
 * of the two to turn off. Closing the question leaves both on, so LoreBase sits out this reply and asks at the next.
 */
export async function settleVectorStorageConflict() {
    if (!isVectFoxEnabled() || !isLoreBaseSwitchedOn() || !isVectorStorageWorldInfoOn()) return;
    const choice = await choicePopup([
        { icon: 'fa-triangle-exclamation', text: "Vector Storage's World Info is on again, and it conflicts with LoreBase." },
        WHY_THEY_CONFLICT,
        { text: 'Close this, and the reply goes without LoreBase; you are asked again at the next one.' },
    ], {
        choices: [{ text: 'Turn its World Info off', value: 'vector-storage' }, { text: 'Turn LoreBase off', value: 'lorebase' }],
        cancelButton: false,
    });
    if (choice === 'vector-storage') {
        if (!await turnOffVectorStorageWorldInfo()) showNotTurnedOffToast();
    } else if (choice === 'lorebase') {
        turnLoreBaseOff();
    } else {
        log.verbose('LoreBase: the question about Vector Storage was closed, so this reply goes without LoreBase');
    }
}
