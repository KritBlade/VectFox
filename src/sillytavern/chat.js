// chat.js — the open chat: SillyTavern's context, chat ID, chat metadata, characters, the open character card's
// fields and macro substitution.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getContext } from '../../../../../extensions.js';
export { characters, chat_metadata, getCharacterCardFields, getCurrentChatId, substituteParams } from '../../../../../../script.js';
