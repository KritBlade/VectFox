/**
 * Story order, the order EventBase reads a chat in (§5.4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md): a
 * message the message sources answer for as a summary reads as the messages it stands for, each of them asked about in
 * turn, so summarizing messages and restoring them leave every message's place where it was. Only a message with text
 * takes a place, as EventBase's windows read text. No host imports: chat-messages.js reads the open chat and asks the
 * message sources.
 */

/** The most summaries within summaries story order opens: a summary deeper than that is read as it is. */
export const MAX_SUMMARY_DEPTH = 64;

/**
 * Whether a message holds text, which is what takes a place in story order and in EventBase's windows.
 * @param {object} message
 * @returns {boolean}
 */
export function hasText(message) {
    return typeof message?.mes === 'string' && message.mes.trim().length > 0;
}

/**
 * A chat in story order. Each of its messages is asked about once, and a summary's messages in turn, down to
 * MAX_SUMMARY_DEPTH summaries deep. A summary deeper than that, or a message that is one of the summaries it is read
 * inside, is read as it is, and onProblem hears of it. Something in the chat that is not a message takes no place.
 * @param {object[]} chat - The chat's messages, oldest first
 * @param {object} reading
 * @param {object} reading.chatMetadata - The chat's metadata, handed to the message sources with each message
 * @param {((message: object, asked: {chatMetadata: object}) => ({owner: string, originals: object[]}|null))|null}
 *   reading.askSources - What the message sources answer for a message: null for an ordinary one, else the owner of the
 *   source that answered and the messages the summary stands for, none for a summary read as nothing. Null while no
 *   source is set
 * @param {(problem: {kind: 'loop'|'depth', owner: string}) => void} [reading.onProblem] - Hears of each summary read
 *   as it is: one holding a summary it is read inside (loop), or one too deep (depth), with the source that answered
 * @returns {{messages: object[], places: Array<{isSummary: boolean, start: number, end: number}>}} messages: the
 *   messages with text, in story order; places: for each message of the chat, in order, whether a source answered for
 *   it as a summary, and the places in story order it fills, from start up to end
 */
export function storyOrderOf(chat, { chatMetadata, askSources, onProblem = () => {} }) {
    const messages = [];
    const asked = Object.freeze({ chatMetadata });

    /**
     * Reads one message into story order: its own text, or a summary's messages in its place.
     * @param {object} message
     * @param {object[]} summariesAbove - The summaries it is read inside, the outermost first
     * @param {string|null} answeredBy - The owner of the source that answered it as one of a summary's messages
     * @returns {boolean} Whether a source answered for it as a summary
     */
    const read = (message, summariesAbove, answeredBy) => {
        if (!message || typeof message !== 'object') return false;
        if (summariesAbove.includes(message)) {
            onProblem({ kind: 'loop', owner: answeredBy });
            if (hasText(message)) messages.push(message);
            return false;
        }
        const answer = askSources ? askSources(message, asked) : null;
        if (!answer) {
            if (hasText(message)) messages.push(message);
            return false;
        }
        if (summariesAbove.length >= MAX_SUMMARY_DEPTH) {
            onProblem({ kind: 'depth', owner: answer.owner });
            if (hasText(message)) messages.push(message);
            return true;
        }
        const summariesBelow = [...summariesAbove, message];
        for (const original of answer.originals) read(original, summariesBelow, answer.owner);
        return true;
    };

    const places = chat.map((message) => {
        const start = messages.length;
        const isSummary = read(message, [], null);
        return { isSummary, start, end: messages.length };
    });
    return { messages, places };
}
