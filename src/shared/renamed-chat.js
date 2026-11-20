/**
 * A renamed chat's ID before and after (SillyTavern's CHAT_RENAMED), for the locks that follow the rename: a collection's
 * chat locks and a lorebook selection's. A chat lock holds the chat's ID, its file name without `.jsonl`.
 */
const chatIdOfFile = fileName => String(fileName ?? '').replace(/\.jsonl$/u, '');

/**
 * The chat's ID before the rename, and the one its file was saved under. SillyTavern's event carries the new name as
 * typed, but its server drops what a file name cannot hold (a colon, a question mark, quotes) before saving, so the same
 * server cleaner is asked what it saved.
 * @param {{oldFileName?: string, newFileName?: string}} renamed - CHAT_RENAMED's data
 * @returns {Promise<{oldChatId: string, newChatId: string}>}
 * @throws {Error} When the server cannot say the name it saved
 */
export async function renamedChatIds({ oldFileName, newFileName } = {}) {
    // Loaded when a chat is renamed, so the collection and lorebook modules that import this load no host module.
    const { getSanitizedFilename } = await import('../sillytavern/identifiers.js');
    const savedFileName = await getSanitizedFilename(String(newFileName ?? ''));
    return { oldChatId: chatIdOfFile(oldFileName), newChatId: chatIdOfFile(savedFileName) };
}
