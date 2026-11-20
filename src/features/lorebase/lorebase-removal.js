/**
 * Remove from LoreBase (§3.6 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): the one confirm
 * and removal the Database Browser's lorebook row and the WorldInfo page's book row both run, so both name and delete
 * the same. The confirm names what the book holds now (loreBookHoldings, removalConfirmLines) and opens on Cancel;
 * Remove deletes its vectors, its keys and its record, with its selected entries, pinned sections and locks
 * (removeLoreBook). Each page says how it went, with describeRemovedLoreBook, and draws its list again.
 */
import { confirmPopup } from '../../sillytavern/popup.js';
import { removalConfirmLines } from './lorebase-files-core.js';
import { loreBookHoldings, removeLoreBook } from './lorebase-storage.js';

/**
 * Ask, naming what the book holds, then remove it from LoreBase.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @returns {Promise<{bookName: string, keysDeleted: number, partsDeleted: number}|null>} What was deleted, or null when
 *   the user cancelled
 * @throws {Error} While LoreBase writes, off Qdrant, or when Similharity cannot list or delete what the book holds
 */
export async function removeLoreBookAfterConfirm(bookName, settings) {
    const holdings = await loreBookHoldings(bookName, settings);
    const isConfirmed = await confirmPopup(removalConfirmLines(holdings), { okButton: 'Remove', isDestructive: true });
    if (!isConfirmed) return null;
    return removeLoreBook(bookName, settings);
}
