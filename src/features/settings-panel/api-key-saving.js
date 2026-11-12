/**
 * What a VectFox key box does with a pasted key: it saves the key in each of SillyTavern's slots the provider uses, and
 * says so when SillyTavern did not save it. SillyTavern's writeSecret never throws. It answers the saved key's ID, or
 * null when it did not save the key, so each answer is checked, and a box never reads as saved when it is not.
 */

import { readSecretState, writeSecret, SECRET_KEYS } from '../../sillytavern/secrets.js';
import { log } from '../../sillytavern/log.js';

/**
 * @typedef {{ slot: string, use: string }} KeySlot - A SillyTavern key slot, and what VectFox sends its key for
 * @typedef {{ label: string, slots: readonly KeySlot[], changedEvent: string, shouldReadSecretState?: boolean }} KeyBox
 *          label names the provider in messages; every box of the provider re-renders on changedEvent;
 *          shouldReadSecretState refreshes which keys SillyTavern holds, which Qdrant's own slot never appears in
 */

/** One OpenRouter key serves embedding, EventBase and Agent Mode, in SillyTavern's own OpenRouter slot. */
export const OPENROUTER_KEY_BOX = Object.freeze({
    label: 'OpenRouter',
    slots: Object.freeze([{ slot: SECRET_KEYS.OPENROUTER, use: 'embedding, EventBase and Agent Mode' }]),
    changedEvent: 'vectfox:openrouter-key-changed',
});

/** One vLLM key goes to two slots: chat calls read Custom, and embedding reads vLLM. */
export const VLLM_KEY_BOX = Object.freeze({
    label: 'vLLM',
    slots: Object.freeze([
        { slot: SECRET_KEYS.CUSTOM, use: 'EventBase and Agent Mode' },
        { slot: SECRET_KEYS.VLLM, use: 'embedding' },
    ]),
    changedEvent: 'vectfox:vllm-key-changed',
});

/** Qdrant's key has a slot of its own, which Similharity reads on SillyTavern's server. */
export const QDRANT_KEY_BOX = Object.freeze({
    label: 'Qdrant',
    slots: Object.freeze([{ slot: 'api_key_qdrant', use: 'Qdrant' }]),
    changedEvent: 'vectfox:qdrant-key-changed',
    shouldReadSecretState: false,
});

/** What a key box shows after a save SillyTavern did not finish. */
export const UNSAVED_KEY_PLACEHOLDER = Object.freeze({
    notSaved: 'Not saved. Paste the key again',
    partlySaved: 'Partly saved. Paste the key again',
});

/**
 * Save a pasted key in each slot of its box, and tell the user when SillyTavern did not save it.
 *
 * @param {string} value - The key, trimmed
 * @param {KeyBox} keyBox
 * @returns {Promise<'saved'|'partlySaved'|'notSaved'>}
 */
export async function saveKeyInSillyTavern(value, { label, slots, shouldReadSecretState = true }) {
    const savedUses = [];
    const unsavedUses = [];
    for (const { slot, use } of slots) {
        // Only null means not saved: SillyTavern 1.19.0 answers null for every failure, and a SillyTavern that answers
        // nothing at all is treated as before, as saved.
        const savedId = await writeSecret(slot, value);
        if (savedId === null) {
            log.warn(`VectFox: SillyTavern did not save the ${label} key in ${slot}.`);
            unsavedUses.push(use);
        } else {
            savedUses.push(use);
        }
    }
    if (shouldReadSecretState) await readSecretState();
    if (unsavedUses.length === 0) {
        log.lifecycle(`VectFox: ${label} API key saved.`);
        return 'saved';
    }
    if (savedUses.length === 0) {
        toastr.error(`SillyTavern did not save your ${label} key. Paste it again to try once more.`, 'Key not saved');
        return 'notSaved';
    }
    toastr.warning(`SillyTavern saved your ${label} key for ${savedUses.join(' and ')}, but not for ${unsavedUses.join(' and ')}. Paste it again to save it for both.`, 'Key partly saved');
    return 'partlySaved';
}

/**
 * Wire a key box: a pasted key is saved, the box is emptied so the same key can be pasted again, every box of the
 * provider re-renders when any slot saved it, and the box says when SillyTavern did not save it.
 *
 * @param {string} selector
 * @param {KeyBox} keyBox
 */
export function wireKeyBox(selector, keyBox) {
    $(selector).on('change', async function() {
        const value = String($(this).val()).trim();
        if (!value) return;
        const saveOutcome = await saveKeyInSillyTavern(value, keyBox);
        $(this).val('');
        if (saveOutcome !== 'notSaved') $(document).trigger(keyBox.changedEvent);
        if (saveOutcome !== 'saved') $(this).attr('placeholder', UNSAVED_KEY_PLACEHOLDER[saveOutcome]);
    });
}
