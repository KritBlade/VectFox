/**
 * ============================================================================
 * WORLDINFO PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's WorldInfo page on GUI-DNA: LoreBase's books for the
 * open chat, with the door to its selection screen, and LoreBase's model with
 * its Accuracy. Every control keeps the id settings-panel.js,
 * lorebase-books-card.js or connection-rows.js wires it by. The LoreBase book
 * list is built here as well. Pure: builds strings.
 * ============================================================================
 */

import { chatProviderOptions, connectionProfileRows, testConnectionButton } from '../../shared/connection-profile-rows-markup.js';
import {
    button, controlRow, detail, emptyState, field, fieldLabel, hint, iconButton, listRow, select, selectOption, statusPill,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader } from '../../shared/gui-dna/panel-page-genes.js';

const formatCount = count => Number(count).toLocaleString('en-US');

// LoreBase's books (plan §5.2): the list loreBaseBooksMarkup draws for the open chat, and the selection screen's door.
function loreBaseBooksCard() {
    return `<section id="VectFox_lorebase_books_card" class="vfx-card">
        ${cardHeader({ icon: 'fa-book-open', title: 'LoreBase books', description: 'The lorebooks this chat loads. LoreBase decides selected entries in books locked here.' })}
        <div class="vfx-card-body vfx-stack">
            <div id="VectFox_lorebase_books" aria-live="polite"></div>
            ${controlRow([button({ text: 'Choose entries', icon: 'fa-list-check', kind: 'primary', data: { 'lorebase-choose': '' } })])}
            ${hint({ text: "Choose any lorebook's entries for LoreBase, and lock the book to this chat or character." })}
        </div>
    </section>`;
}

// LoreBase's own model (plan §5.6), and its Accuracy: the review at low reasoning effort, or at the model's default (D6).
function loreBaseModelCard() {
    const accuracy = select({
        id: 'VectFox_lorebase_accuracy',
        options: [selectOption({ value: 'default', text: 'Default Accuracy' }), selectOption({ value: 'high', text: 'High Accuracy' })],
    });
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-plug', title: 'LoreBase model', description: 'The model that picks the selected entries a reply needs, and trims each one.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([fieldLabel({ text: 'Provider', forId: 'VectFox_lorebase_provider' }), select({ id: 'VectFox_lorebase_provider', options: chatProviderOptions() })])}
            ${field([
                fieldLabel({ text: 'Model', forId: 'VectFox_lorebase_model' }),
                '<input type="text" id="VectFox_lorebase_model" class="vfx-input" placeholder="openai/gpt-6-luna">',
                hint({ text: 'LoreBase was tested on GPT-6 Luna.' }),
            ])}
            ${connectionProfileRows('VectFox_lorebase', { hintText: 'LoreBase was tested on GPT-6 Luna. The profile\'s model, URL and key are used.' })}
            ${field([
                fieldLabel({ text: 'Accuracy', forId: 'VectFox_lorebase_accuracy' }),
                accuracy,
                hint({ text: 'Default Accuracy answers a few seconds sooner; High Accuracy leaves out less lore.' }),
                detail({ text: 'Each picked entry is reviewed at low reasoning effort on Default Accuracy, and at the model\'s own effort on High Accuracy.' }),
            ], { isSpan: true })}
            ${testConnectionButton('VectFox_lorebase', { hintText: 'Sends one short fixed message, never your chat, and shows the reply.' })}
        </div>
    </section>`;
}

/**
 * The WorldInfo page's cards: LoreBase books, then LoreBase model.
 *
 * @returns {string}
 */
export function worldInfoPageMarkup() {
    return loreBaseBooksCard() + loreBaseModelCard();
}

const LOCK_PILLS = {
    chat: statusPill({ text: 'Locked to this chat', icon: 'fa-lock', status: 'success' }),
    character: statusPill({ text: 'Locked to this character', icon: 'fa-lock', status: 'success' }),
    none: statusPill({ text: 'Not locked', icon: 'fa-lock-open' }),
};

function loreBaseBookRow({ bookName, selectedCount, isLockedToChat, isLockedToCharacter }) {
    const locks = [isLockedToChat ? LOCK_PILLS.chat : '', isLockedToCharacter ? LOCK_PILLS.character : ''].filter(Boolean);
    return listRow({
        icon: 'fa-book',
        name: bookName,
        sub: selectedCount ? { name: `${formatCount(selectedCount)} selected` } : { text: 'Nothing selected' },
        pills: locks.length ? locks : [LOCK_PILLS.none],
        actions: [iconButton({ icon: 'fa-list-check', title: 'Choose entries', data: { 'lorebase-choose': bookName } })],
    });
}

/**
 * The LoreBase books card's list for the open chat: each book SillyTavern loads here, how many entries are selected
 * in it, and whether it is locked to this chat or its character, where LoreBase decides them (D11).
 *
 * @param {{hasChat: boolean, books: Array<{bookName: string, selectedCount: number, isLockedToChat: boolean,
 *   isLockedToCharacter: boolean}>}} status - LoreBase's chatBookLocks
 * @returns {string}
 */
export function loreBaseBooksMarkup({ hasChat, books }) {
    if (!hasChat) return emptyState({ icon: 'fa-comments', text: 'Open a chat to see the lorebooks it loads.' });
    if (!books.length) return emptyState({ icon: 'fa-book', text: 'This chat loads no lorebook.' });
    return `<div class="vfx-list">${books.map(loreBaseBookRow).join('')}</div>`;
}
