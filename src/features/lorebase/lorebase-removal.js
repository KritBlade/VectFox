/**
 * Remove from LoreBase and Unlink (§3.6 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): the
 * one confirm and removal the Database Browser's lorebook row and the WorldInfo page's book row both run as Remove, so
 * both name and delete the same, and the WorldInfo page's Unlink runs too. The confirm names what the book holds now
 * (loreBookHoldings, removalConfirmLines) and whether SillyTavern still has it, and opens on Cancel; then its vectors,
 * its keys and its record go, with its selected entries, pinned sections and locks (removeLoreBook). Remove leaves the
 * book where SillyTavern loads it. Unlink's confirm says it deletes all of that too and names the open chat's lists it
 * takes the book out of, the chat's books added through LoreBase, the character's Additional Lorebooks, the global list
 * and the chat's Chat Lorebook, which it does once LoreBase holds nothing of the book (unlinkLoreBookFromChat). Each page
 * says how it went, with describeRemovedLoreBook, and draws its list again. And the one delete of a single selection
 * (§3.7), which Choose entries' Delete and the WorldInfo page's trash on a book row showing one of several selections
 * both run (deleteLoreSelectionAfterConfirm).
 */
import { confirmPopup } from '../../sillytavern/popup.js';
import { world_names } from '../../sillytavern/world-info.js';
import { deleteLoreSelection, getLoreSelection } from './lorebase-books.js';
import { chatBookLinks, unlinkLoreBookFromChat } from './lorebase-chat-books.js';
import { removalConfirmLines } from './lorebase-files-core.js';
import { deleteSelectionLines } from './lorebase-selection-markup.js';
import { loreBookHoldings, removeLoreBook } from './lorebase-storage.js';
import { isLoreBaseBackend } from './lorebase-switch.js';
import { pruneBookVectors } from './lorebase-vectors.js';

/**
 * Ask, naming what the book holds and whether SillyTavern still has it, then remove it from LoreBase; with
 * `shouldUnlink`, the WorldInfo page's Unlink, ask naming the open chat's lists too, and once LoreBase holds nothing of
 * the book, take it out of them.
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
    const lines = removalConfirmLines(holdings, links, { isInSillyTavern: world_names.includes(bookName) });
    const isConfirmed = await confirmPopup(lines, { okButton: shouldUnlink ? 'Unlink' : 'Remove', isDestructive: true });
    if (!isConfirmed) return null;
    const removed = await removeLoreBook(bookName, settings);
    return shouldUnlink ? { ...removed, ...(await unlinkLoreBookFromChat(bookName)) } : removed;
}

/**
 * Ask with Choose entries' words (deleteSelectionLines), opening on Cancel, then delete one selection of a book with
 * its selected entries, pinned sections and locks (deleteLoreSelection), and on Qdrant the vectors of the entries no
 * other selection holds (pruneBookVectors). The book's keys stay, for the entries its other selections hold or may
 * turn on again; the book itself stays in LoreBase.
 * @param {string} bookName
 * @param {string} selectionId
 * @param {object} settings - VectFox settings
 * @returns {Promise<{bookName: string, selectionName: string}|null>} The selection deleted; null when the user cancelled
 * @throws {Error} With no such selection, before the confirm; for the book's last selection, which Remove from
 *   LoreBase removes with the book
 */
export async function deleteLoreSelectionAfterConfirm(bookName, selectionId, settings) {
    const { name } = getLoreSelection(bookName, selectionId);
    if (!await confirmPopup(deleteSelectionLines(name), { okButton: 'Delete', isDestructive: true })) return null;
    deleteLoreSelection(bookName, selectionId);
    if (isLoreBaseBackend(settings)) await pruneBookVectors(bookName, settings);
    return { bookName, selectionName: name };
}
