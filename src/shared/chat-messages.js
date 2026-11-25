/**
 * The one place VectFox reads the open chat's messages (§5.4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md),
 * two ways. As SillyTavern holds them, a summary as itself, which is what the model reads: the search text, LoreBase's
 * scene and Agent Mode's planner read the chat so. In story order, each summary as the messages it stands for
 * (chat-messages-core.js): EventBase's reads and the counts on VectFox's pages, so its message numbers stay put when a
 * summarizer replaces messages and when it restores them. src/index.js sets what story order asks about each message,
 * the message sources other extensions register through the public API (setMessageSource).
 */
import { getContext } from '../sillytavern/chat.js';
import { log } from '../sillytavern/log.js';
import { MAX_SUMMARY_DEPTH, storyOrderOf } from './chat-messages-core.js';

/** What story order asks about each message; null until src/index.js sets it, and every message reads as itself. */
let askSources = null;

/** Each kind of summary read as it is, by the owner of the source that answered it, said in the console once. */
const problemsSaid = new Set();

/**
 * Sets what story order asks about each message. Called once, when src/index.js is evaluated.
 * @param {(message: object, asked: {chatMetadata: object}) => ({owner: string, originals: object[]}|null)} ask
 */
export function setMessageSource(ask) {
    askSources = ask;
}

/**
 * Says once in the console that a summary was read as it is: one holding a summary it is read inside, or one too deep.
 * Once for each owner and kind, as story order is read on every turn: each time after the first would repeat the line.
 * @param {{kind: 'loop'|'depth', owner: string}} problem
 */
function sayProblemOnce({ kind, owner }) {
    const said = `${kind}:${owner}`;
    if (problemsSaid.has(said)) return;
    problemsSaid.add(said);
    log.warn(kind === 'loop'
        ? `VectFox public API: ${owner}'s message source answered a summary with a summary it is read inside, so VectFox reads that one as it is`
        : `VectFox public API: ${owner}'s message source answered summaries more than ${MAX_SUMMARY_DEPTH} deep, so VectFox reads the deepest as it is`);
}

/**
 * The open chat's messages as SillyTavern holds them, a summary as itself: what the model reads.
 * @returns {object[]} The chat itself, oldest first; none while no chat is open
 */
export function chatMessages() {
    const chat = getContext()?.chat;
    return Array.isArray(chat) ? chat : [];
}

/**
 * The open chat in story order, with the places each of its messages fills: what ghosting maps the tip back to the chat
 * by.
 * @returns {{messages: object[], places: Array<{isSummary: boolean, start: number, end: number}>}}
 */
export function openChatStoryOrder() {
    return storyOrderOf(chatMessages(), { chatMetadata: getContext()?.chatMetadata ?? {}, askSources, onProblem: sayProblemOnce });
}

/**
 * The messages EventBase reads in the open chat: those with text, in story order. A message's number in EventBase, its
 * windows and its events' message numbers, is its place here.
 * @returns {object[]}
 */
export function storyMessages() {
    return openChatStoryOrder().messages;
}
