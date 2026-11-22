/**
 * LoreBase and SillyTavern's Vector Storage (plan §5.9 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md). Vector Storage's World Info search force-activates lorebook entries by
 * similarity, so a selected entry would go in whole even when Luna leaves it out, and LoreBase cannot take those
 * entries back; so the two never run together. Turning LoreBase on needs the model that picks each reply's entries, then
 * asks to write the keys and vectors the selected entries lack (D17, §4.3 of lorebook-multi-vector.md), then asks to
 * turn that search off; LoreBase stays off when that model cannot run, when the user keeps the search, or when the user
 * declines the writing with no entry ready (§4.4). When the search is on again at a reply, from its checkbox, its command or another session's
 * settings, the same question comes before any interceptor runs, so once it is off Vector Storage forces nothing into
 * that reply; until it is answered LoreBase sits out (isLoreBaseActive). Vector Storage's chat-message and file search
 * are never touched.
 */
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { log } from '../../sillytavern/log.js';
import { choicePopup, confirmPopup, noticePopup } from '../../sillytavern/popup.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { isVectorStorageWorldInfoOn, turnOffVectorStorageWorldInfo } from '../../sillytavern/vector-storage.js';
import { askToWriteMissingKeysAndVectors, writeMissingKeysAndVectors } from './lorebase-keys-question.js';
import { replyModelProblem } from './lorebase-setup.js';
import { missingSummaryOf } from './lorebase-storage-core.js';
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
 * Turn LoreBase on: only on Qdrant, which keeps its keys and vectors (D15); only while the model that picks each reply's
 * entries can run (replyModelProblem), which is checked before any question, as every reply would go without lore;
 * once the selected entries' missing keys and vectors are settled (askToWriteMissingKeysAndVectors, the question
 * closing the selection screen asks too): the user has them written, or some entry is ready already; and after asking
 * to turn off Vector Storage's World Info search when it is on. Once on, what the user agreed to is written under
 * VectFox's progress panel.
 * @returns {Promise<{isOn: boolean, missing: ReturnType<typeof missingSummaryOf>|null}>} isOn: whether LoreBase is on
 *   afterwards: not off Qdrant, not while that model cannot run, not when keys and vectors cannot be read, not when no
 *   entry is ready and none will be written, not when the user keeps that search, and not when it would not turn off;
 *   missing: what the selected entries lack, as read before the question, or null when they were not read
 */
export async function turnLoreBaseOn() {
    if (!isLoreBaseBackend()) {
        await noticePopup([
            { icon: 'fa-database', text: 'LoreBase needs Qdrant: it keeps the keys and vectors of each entry there.' },
            { text: 'Choose Qdrant as the vector backend, then turn LoreBase on.' },
        ]);
        return { isOn: false, missing: null };
    }
    const replyProblem = replyModelProblem(extension_settings.vectfox);
    if (replyProblem) {
        await noticePopup([
            { icon: 'fa-plug', text: "LoreBase stays off: the model that picks each reply's entries cannot run yet." },
            { name: replyProblem },
        ]);
        return { isOn: false, missing: null };
    }
    const { canBeOn, shouldWrite, pending } = await askToWriteMissingKeysAndVectors({ isTurningOn: true });
    const offOutcome = { isOn: false, missing: pending && missingSummaryOf(pending, false) };
    if (!canBeOn) return offOutcome;
    if (isVectorStorageWorldInfoOn()) {
        const isAgreed = await confirmPopup([
            { icon: 'fa-triangle-exclamation', text: "SillyTavern's Vector Storage has World Info on, and it conflicts with LoreBase." },
            WHY_THEY_CONFLICT,
            { text: "Turn it off? Vector Storage's chat and file search stay on. Keep it on, and LoreBase stays off." },
        ], { okButton: 'Turn it off', cancelButton: 'Keep it on' });
        if (!isAgreed) return offOutcome;
        if (!await turnOffVectorStorageWorldInfo()) {
            showNotTurnedOffToast();
            return offOutcome;
        }
    }
    saveLoreBaseSwitch(true);
    const isWriting = shouldWrite && writeMissingKeysAndVectors(pending);
    return { isOn: true, missing: missingSummaryOf(pending, isWriting) };
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
