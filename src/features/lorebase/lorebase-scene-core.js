/**
 * The scene LoreBase's pick and review read (plan §5.5 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): the chat's last 6 messages up to the user's last message, each as
 * "name: text", as the route trials showed them to GPT-6 Luna. Pure: no SillyTavern.
 */

// The pick and the review read the chat's last 6 messages, as in the trials.
const SCENE_MESSAGE_COUNT = 6;

/**
 * The scene's messages from the stored chat: the last 6 that hold text, up to and including the user's last message,
 * so a swipe, a regenerate or a continue leaves out the reply it replaces. Hidden messages are left out, each text is
 * as readText leaves it, and a message it leaves empty is dropped. Only the messages the scene needs are read.
 * @param {Array<{is_user?: boolean, is_system?: boolean, name?: string, mes?: string}>} chat - The stored chat, oldest first
 * @param {(text: string) => string} readText - A message's text as the prompts show it
 * @returns {Array<{name: string, text: string}>|null} Oldest first; null when the chat holds no user message, or the
 *   user's last message holds no text once read
 */
export function sceneMessages(chat, readText) {
    const lastUserIndex = chat.findLastIndex(message => message.is_user && !message.is_system);
    if (lastUserIndex < 0) return null;
    const messages = [];
    for (let index = lastUserIndex; index >= 0 && messages.length < SCENE_MESSAGE_COUNT; index -= 1) {
        const message = chat[index];
        if (message.is_system) continue;
        const text = readText(String(message.mes ?? ''));
        if (!text) {
            if (index === lastUserIndex) return null;
            continue;
        }
        messages.unshift({ name: message.name, text });
    }
    return messages;
}

/**
 * The scene as both prompts show it: the last 6 messages, each as "name: text", with a blank line between them.
 * @param {Array<{name: string, text: string}>} messages - The scene's messages, oldest first, the user's last
 * @returns {string}
 */
export function sceneText(messages) {
    return messages.slice(-SCENE_MESSAGE_COUNT).map(message => `${message.name}: ${message.text}`).join('\n\n');
}

/**
 * The opening both prompts share: the scene, and that the next reply answers the user's last message.
 * @param {string} scene - From sceneText
 * @returns {string}
 */
export function chatHead(scene) {
    return `The chat so far. The last message is the user's; the next reply answers it.\n\n${scene}\n\n`;
}
