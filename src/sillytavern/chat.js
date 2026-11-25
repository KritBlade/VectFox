// chat.js — the open chat: SillyTavern's context, chat ID, chat metadata, characters, the open character card's
// fields and macro substitution; and saving one field of the open chat's metadata.
// The rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
import { chat_metadata, saveMetadata } from '../../../../../../script.js';

export { getContext } from '../../../../../extensions.js';
export { characters, chat_metadata, getCharacterCardFields, getCurrentChatId, substituteParams } from '../../../../../../script.js';

/**
 * Set one field of the open chat's metadata, or delete it when the value is undefined, and save the chat, as
 * SillyTavern's own chat settings do (saveMetadata): the field travels in the chat's file, a group chat's too, and a
 * branch copies it. SillyTavern's save logs a failure itself and tells no caller, so a save the server refused goes
 * unseen here too.
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function saveChatMetadataField(key, value) {
    if (value === undefined) delete chat_metadata[key];
    else chat_metadata[key] = value;
    await saveMetadata();
}
