/**
 * The WorldInfo page's LoreBase books card (plan §5.2 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): draws the open chat's books with their selected counts and locks, and
 * opens LoreBase's selection screen on the book a row names, or on the chat's first book from the card's own button,
 * drawing the list again once the screen closes.
 */
import { log } from '../../sillytavern/log.js';
import { chatBookLocks, openLoreBaseSelection } from '../lorebase/index.js';
import { loreBaseBooksMarkup } from './worldinfo-page-markup.js';

/** Draw the open chat's LoreBase books, once the panel is mounted. */
export function refreshLoreBaseBooks() {
    const list = document.getElementById('VectFox_lorebase_books');
    if (list) list.innerHTML = loreBaseBooksMarkup(chatBookLocks());
}

/** Open the selection screen from the card's buttons. Called once, as the panel is mounted. */
export function bindLoreBaseBooksCard() {
    document.getElementById('VectFox_lorebase_books_card')?.addEventListener('click', async event => {
        const opener = event.target.closest('[data-lorebase-choose]');
        if (!opener) return;
        try {
            await openLoreBaseSelection({ bookName: opener.dataset.lorebaseChoose });
        } catch (error) {
            log.error('LoreBase: the selection screen failed:', error);
        }
        refreshLoreBaseBooks();
    });
}
