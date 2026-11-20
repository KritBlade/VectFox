/**
 * Remove from LoreBase (§3.6 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): the one confirm
 * and removal the Database Browser's lorebook row and the WorldInfo page's book row both run, so both name and delete
 * the same. The confirm names what the book holds now (loreBookHoldings, removalConfirmLines) and opens on Cancel;
 * Remove deletes its vectors, its keys and its record, with its selected entries, pinned sections and locks
 * (removeLoreBook). On the WorldInfo page it then takes the book out of the open chat's lists Add a lorebook links
 * books through, the character's Additional Lorebooks and the global list, which the confirm names too
 * (takeLoreBookOutOfChat). Each page says how it went, with describeRemovedLoreBook, and draws its list again.
 */
import { confirmPopup } from '../../sillytavern/popup.js';
import { chatBookLinks, takeLoreBookOutOfChat } from './lorebase-chat-books.js';
import { removalConfirmLines } from './lorebase-files-core.js';
import { loreBookHoldings, removeLoreBook } from './lorebase-storage.js';

/**
 * Ask, naming what the book holds, then remove it from LoreBase; with `isTakenOutOfChat`, as the WorldInfo page asks,
 * take it out of the open chat's lists as well, once LoreBase holds nothing of it.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @param {{isTakenOutOfChat?: boolean}} [options]
 * @returns {Promise<{bookName: string, keysDeleted: number, partsDeleted: number, takenOutOf?: string[],
 *   stillLoadedBy?: string[]}|null>} What was deleted, and the chat's lists the book went from and those still loading
 *   it; null when the user cancelled
 * @throws {Error} While LoreBase writes, off Qdrant, or when Similharity cannot list or delete what the book holds;
 *   then no list is changed
 */
export async function removeLoreBookAfterConfirm(bookName, settings, { isTakenOutOfChat = false } = {}) {
    const holdings = await loreBookHoldings(bookName, settings);
    const links = isTakenOutOfChat ? chatBookLinks(bookName) : null;
    const isConfirmed = await confirmPopup(removalConfirmLines(holdings, links), { okButton: 'Remove', isDestructive: true });
    if (!isConfirmed) return null;
    const removed = await removeLoreBook(bookName, settings);
    return isTakenOutOfChat ? { ...removed, ...takeLoreBookOutOfChat(bookName) } : removed;
}
