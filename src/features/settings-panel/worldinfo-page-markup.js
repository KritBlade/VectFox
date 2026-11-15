/**
 * ============================================================================
 * WORLDINFO PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's WorldInfo page on GUI-DNA: LoreBase's books for the
 * open chat, with the door to its selection screen; LoreBase's model with its
 * Accuracy; and semantic activation of the chat's vectorized lorebooks, with
 * how their entries are matched. Every control keeps the id settings-panel.js,
 * lorebase-books-card.js or connection-rows.js wires it by, and the card the
 * wiring shows and hides keeps its id too. The LoreBase book list and the
 * status line under the activation switch are built here as well. Pure:
 * builds strings.
 * ============================================================================
 */

import { chatProviderOptions, connectionProfileRows, testConnectionButton } from '../../shared/connection-profile-rows-markup.js';
import {
    button, controlRow, detail, emptyState, field, fieldLabel, hint, iconButton, listRow, resultList, select, selectOption, statusPill,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

const HIDDEN = ' style="display:none;"';

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

function activationCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-globe', title: 'Semantic activation', description: 'Pulls in lorebook entries by meaning, beside SillyTavern\'s keyword matching.' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: 'VectFox_enabled_world_info', title: 'Use in this chat', description: 'Needs a vectorized lorebook locked to this chat. Off unlocks the active ones.', isSpan: true })}
            <div id="VectFox_wi_status" class="vfx-span" aria-live="polite"></div>
        </div>
    </section>`;
}

function matchingCard() {
    return `<section id="VectFox_world_info_settings" class="vfx-card"${HIDDEN}>
        ${cardHeader({ icon: 'fa-sliders', title: 'Matching', description: 'How entries are matched. Action → Query Tester shows what a message pulls in.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Entries per lorebook', forId: 'VectFox_world_info_top_k' }),
                sliderNumber({ id: 'VectFox_world_info_top_k', min: 1, max: 20, step: 1, title: 'Entries' }),
                hint({ text: 'The most entries one lorebook may add per reply.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Query depth', forId: 'VectFox_world_info_query_depth' }),
                sliderNumber({ id: 'VectFox_world_info_query_depth', min: 1, max: 10, step: 1, title: 'Messages' }),
                hint({ text: 'Recent messages read to find matching entries.' }),
            ])}
            ${switchRow({ id: 'VectFox_world_info_retrieval_popup', title: 'Toast on retrieval', description: 'Shows a toast each time lorebook entries are pulled in.' })}
        </div>
    </section>`;
}

/**
 * The WorldInfo page's cards: LoreBase books; LoreBase model; Semantic activation; and Matching, which shows while
 * activation is on.
 *
 * @returns {string}
 */
export function worldInfoPageMarkup() {
    return loreBaseBooksCard() + loreBaseModelCard() + activationCard() + matchingCard();
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

/**
 * Semantic activation's status for the open chat.
 *
 * @param {{state: 'no-lorebooks'|'none-active'|'active', names?: string[]}} status - `names` are the active lorebooks
 * @returns {string}
 */
export function worldInfoStatusMarkup({ state, names = [] }) {
    if (state === 'no-lorebooks') {
        return resultList({ lines: [{ status: 'warning', text: 'No lorebook vectorized yet. Vectorize Content on the Action page stores one.' }] });
    }
    if (state === 'none-active') {
        return resultList({ lines: [{ status: 'warning', text: 'No lorebook is locked to this chat. Lock one in Database Browser → Collection Settings.' }] });
    }
    return resultList({ lines: [{ status: 'success', name: `Active for this chat: ${names.join(', ')}` }] });
}
