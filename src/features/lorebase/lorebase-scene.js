/**
 * This turn's scene, read from SillyTavern's stored chat (plan §5.5 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md), never the interceptor's working copy, which ghosting edits. It
 * reads the chat as the model does, a summary as itself.
 */
import { substituteParams } from '../../sillytavern/chat.js';
import { chatMessages } from '../../shared/chat-messages.js';
import { cleanText, stripGameSystemBlocks, stripReasoningBlocks } from '../text-cleaning/index.js';
import { sceneMessages } from './lorebase-scene-core.js';

/**
 * A message's text as the scene shows it: macros substituted, then the user's Text Cleaning, then the reasoning and
 * game-system blocks stripped, in the order the route trials cleaned their chats (vectfox_clean_turns.mjs).
 * @param {string} text
 * @returns {string}
 */
function sceneMessageText(text) {
    return stripGameSystemBlocks(stripReasoningBlocks(cleanText(substituteParams(text)))).trim();
}

/**
 * The open chat's scene for the pick and the review.
 * @returns {Array<{name: string, text: string}>|null} Null when the chat holds no user message with text
 */
export function sceneMessagesFromChat() {
    return sceneMessages(chatMessages(), sceneMessageText);
}
