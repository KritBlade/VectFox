/**
 * Remove from LoreBase and Unlink (§3.6 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): the
 * one confirm and removal the Database Browser's lorebook row and the WorldInfo page's book row both run as Remove, so
 * both name and delete the same, and the WorldInfo page's Unlink runs too. The confirm names what the book holds now
 * (loreBookHoldings, removalConfirmLines) and opens on Cancel; then its vectors, its keys and its record go, with its
 * selected entries, pinned sections and locks (removeLoreBook). Remove leaves the book where SillyTavern loads it.
 * Unlink's confirm says it deletes all of that too and names the open chat's lists it takes the book out of, the
 * character's Additional Lorebooks, the global list and the chat's Chat Lorebook, which it does once LoreBase holds
 * nothing of the book (unlinkLoreBookFromChat). Each page says how it went, with describeRemovedLoreBook, and draws its
 * list again.
 */
import { confirmPopup } from '../../sillytavern/popup.js';
import { chatBookLinks, unlinkLoreBookFromChat } from './lorebase-chat-books.js';
import { removalConfirmLines } from './lorebase-files-core.js';
import { loreBookHoldings, removeLoreBook } from './lorebase-storage.js';

/**
 * Ask, naming what the book holds, then remove it from LoreBase; with `shouldUnlink`, the WorldInfo page's Unlink, ask
 * naming the open chat's lists too, and once LoreBase holds nothing of the book, take it out of them.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @param {{shouldUnlink?: boolean}} [options]
 * @returns {Promise<{bookName: string, keysDeleted: number, partsDeleted: number, unlinkedFrom?: string[],
 *   stillLoadedBy?: string[]}|null>} What was deleted, and with Unlink the chat's lists the book went from and the
 *   places still loading it; null when the user cancelled
 * @throws {Error} While LoreBase writes, off Qdrant, or when Similharity cannot list or delete what the book holds;
 *   then no list is changed
 */
export async function removeLoreBookAfterConfirm(bookName, settings, { shouldUnlink = false } = {}) {
    const holdings = await loreBookHoldings(bookName, settings);
    const links = shouldUnlink ? chatBookLinks(bookName) : null;
    const isConfirmed = await confirmPopup(removalConfirmLines(holdings, links), { okButton: shouldUnlink ? 'Unlink' : 'Remove', isDestructive: true });
    if (!isConfirmed) return null;
    const removed = await removeLoreBook(bookName, settings);
    return shouldUnlink ? { ...removed, ...(await unlinkLoreBookFromChat(bookName)) } : removed;
}
