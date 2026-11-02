// chat.js — the open chat: SillyTavern's context, chat ID, chat metadata, characters and macro substitution.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getContext } from '../../../../../extensions.js';
export { characters, chat_metadata, getCurrentChatId, substituteParams } from '../../../../../../script.js';
