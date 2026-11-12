/**
 * What VectFox's key boxes do. A pasted key is saved in each of SillyTavern's slots the provider uses, and a trash
 * button deletes the key the provider uses now. Neither SillyTavern call reports a failure the usual way: writeSecret
 * answers the saved key's ID, or null when it did not save the key, and deleteSecret answers nothing at all. So each
 * save is checked by its answer and each delete by reading SillyTavern's key list again, and a box never reads as
 * saved or deleted when it is not.
 */

import { deleteSecret, readSecretState, secret_state, writeSecret, SECRET_KEYS } from '../../sillytavern/secrets.js';
import { confirmPopup } from '../../sillytavern/popup.js';
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

/**
 * The key SillyTavern uses now in a slot: its entry in SillyTavern 1.19.0's list, `{ id: null }` for a SillyTavern
 * whose list names no IDs, or null when no key is saved.
 */
function keyInUse(slot) {
    const listed = secret_state?.[slot];
    if (Array.isArray(listed)) return listed.find(secret => secret?.active) ?? null;
    return listed ? { id: null } : null;
}

/**
 * Whether a deleted key is still saved. SillyTavern makes the first key left in a slot the one in use, so a slot that
 * still holds a key proves nothing: the deleted key's ID still listed does. A list with no IDs holds one key at most.
 */
function isStillSaved(slot, deletedKey) {
    const listed = secret_state?.[slot];
    if (Array.isArray(listed)) return listed.some(secret => secret?.id === deletedKey.id);
    return Boolean(listed);
}

/**
 * The trash button of a key box: after a confirm, delete the key the provider uses now in each of its slots, and tell
 * the user when SillyTavern did not delete it. Each slot is also the one SillyTavern's own chat reads, so the confirm
 * says so, and every box of the provider re-renders from what SillyTavern holds afterwards.
 *
 * @param {KeyBox} keyBox
 * @returns {Promise<'nothingSaved'|'kept'|'deleted'|'partlyDeleted'|'notDeleted'>}
 */
export async function clearKeyBox({ label, slots, changedEvent }) {
    const saved = slots.map(entry => ({ ...entry, key: keyInUse(entry.slot) })).filter(entry => entry.key);
    if (saved.length === 0) {
        log.lifecycle(`VectFox: no ${label} API key is saved, so there is nothing to delete.`);
        return 'nothingSaved';
    }
    const isConfirmed = await confirmPopup([
        { text: 'Delete the saved key?' },
        { text: 'Provider:', name: label },
        { text: 'Lost: the key VectFox\'s embedding, EventBase model and Agent Mode send, and SillyTavern\'s own chat on the same provider.' },
        { text: 'Delete key deletes it. Cancel keeps it.' },
    ], { okButton: 'Delete key', isDestructive: true });
    if (!isConfirmed) return 'kept';
    // By its ID, so a key that became the one in use meanwhile is not the one deleted.
    for (const { slot, key } of saved) await deleteSecret(slot, key.id ?? undefined);
    await readSecretState();
    const keptUses = saved.filter(({ slot, key }) => isStillSaved(slot, key)).map(({ use }) => use);
    const deletedUses = saved.filter(({ use }) => !keptUses.includes(use)).map(({ use }) => use);
    $(document).trigger(changedEvent);
    if (keptUses.length === 0) {
        log.lifecycle(`VectFox: ${label} API key deleted.`);
        return 'deleted';
    }
    log.warn(`VectFox: SillyTavern did not delete the ${label} key for ${keptUses.join(' and ')}.`);
    if (deletedUses.length === 0) {
        toastr.error(`SillyTavern did not delete your ${label} key. It is still saved. Try again.`, 'Key not deleted');
        return 'notDeleted';
    }
    toastr.warning(`SillyTavern deleted your ${label} key for ${deletedUses.join(' and ')}, but not for ${keptUses.join(' and ')}. Try again to delete it for both.`, 'Key partly deleted');
    return 'partlyDeleted';
}
