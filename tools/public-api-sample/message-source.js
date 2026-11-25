/**
 * A message source for InlineSummary: the worked example of the Message sources section of VectFox's developer page
 * (Doc/public-api.md). It tells VectFox which messages each InlineSummary summary stands for, so VectFox reads a
 * summarized chat as the story it was. It uses only the VectFox object, so it can go in InlineSummary itself, a fork of
 * it, or a small extension of your own that runs beside it.
 *
 * InlineSummary replaces a range of messages with one summary message and keeps the originals in one of three places:
 * on the summary itself (`ILS_Data.OriginalMessages`, since InlineSummary 1.2.0), in its `extra` (before 1.2.0), or,
 * in brasen56's fork, in the chat's metadata (`chat_metadata.ILS_Originals`), under the `Ref` the summary holds.
 */

/**
 * The messages an InlineSummary summary stands for.
 * @param {object} message - A message of the chat, or one a summary stands for
 * @param {{chatMetadata: object}} asked - The chat's metadata as it is now
 * @returns {object[]|null} The originals, or null for an ordinary message, and for a summary whose originals are gone,
 *   which VectFox then reads as it is
 */
export function inlineSummaryOriginals(message, { chatMetadata }) {
    const data = message.ILS_Data ?? message.extra?.ILS_Data;
    if (!data) return null;                                 // an ordinary message
    if (Array.isArray(data.OriginalMessages)) return data.OriginalMessages;
    const kept = chatMetadata?.ILS_Originals?.[data.Ref];   // brasen56's fork keeps them here
    return Array.isArray(kept) ? kept : null;               // originals gone: read the summary as it is
}

/**
 * Registers inlineSummaryOriginals with VectFox: right away when VectFox's object is there, else once VectFox says it
 * is ready. A VectFox too old to take message sources is left alone, and so is a page without VectFox.
 */
export function registerInlineSummarySource() {
    const register = (VectFox) => {
        if (!VectFox?.capabilities.includes('chat.messageSource')) return;
        VectFox.chat.registerMessageSource({ owner: 'InlineSummary message source', originalsOf: inlineSummaryOriginals });
    };
    if (globalThis.VectFox) {
        register(globalThis.VectFox);
    } else {
        SillyTavern.getContext().eventSource.on('vectfox_ready', () => register(globalThis.VectFox));
    }
}
