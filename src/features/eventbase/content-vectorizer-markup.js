/**
 * ============================================================================
 * VECTORIZE CONTENT: MARKUP
 * ============================================================================
 * The Vectorize Content dialog drawn with the GUI-DNA genes: a rail holding the
 * Chat row under From SillyTavern, and the Chat page of cards in order: Source,
 * Windows, Options, then Vectorize. Every control's id is the page's (cvId); the
 * painted parts are built here too. content-vectorizer.js wires it.
 * ============================================================================
 */

import {
    button,
    codeChip,
    controlRow,
    emptyState,
    field,
    fieldLabel,
    hint,
    input,
    notice,
    select,
    selectOption,
    stack,
    statusPill,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, navItem, pageHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtml as escape } from '../../shared/html-escape.js';
import { CHAT_FILE_FORMATS } from './content-vectorizer-core.js';

export const VECTORIZER_ROOT_ID = 'vectfox_content_vectorizer';

/** The page's one content type: every id and data-cv-type carries it. */
export const CHAT_TYPE_ID = 'chat';

/** A type's nav item. */
export const cvTabId = typeId => `vectfox_cv_tab_${typeId}`;

/** A type's page. */
export const cvPageId = typeId => `vectfox_cv_page_${typeId}`;

/** A control on a type's page. */
export const cvId = (typeId, name) => `vectfox_cv_${typeId}_${name}`;

const HIDDEN = ' hidden';

const RAIL_GROUP = 'From SillyTavern';

const CHAT_PAGE = Object.freeze({
    railTitle: 'Chat',
    title: 'Chat History',
    icon: 'fa-comments',
    description: 'Vectorize conversation history for semantic recall',
});

const formatCount = count => Number(count).toLocaleString('en-US');

const action = name => ({ 'cv-action': name });

/** A pill of a word and its value: the DNA pill shows one or the other, so the pair goes in as the value. */
const linePill = ({ text, name }, options = {}) => statusPill({ name: `${text}: ${name}`, ...options });

/** A part shown or hidden by the wiring, found by its name on its page. */
const shownPart = (name, content, isShown = true) => `<div data-cv-part="${name}"${isShown ? '' : HIDDEN}>${content}</div>`;

/** A region the wiring paints, found by its name on its page. */
const paintedRegion = (name, content = '') => `<div data-cv-region="${name}">${content}</div>`;

/** A hint whose words the wiring sets, so it carries no translation key. */
const dynamicHint = (text, hook) => `<p class="vfx-hint" data-cv-hint="${hook}">${escape(text)}</p>`;

const card = (id, header, body) => `<section class="vfx-card" id="${id}">${header}<div class="vfx-card-body">${body}</div></section>`;

// ── Rail and page ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The dialog: the rail with the Chat row, then the Chat page.
 *
 * @param {{view: object}} options - view: what the page draws (the open chat, the cleaning presets, the chosen one and
 *   its note, presetDescription's text)
 * @returns {string}
 */
export function contentVectorizerMarkup({ view }) {
    const rail = `<div class="vfx-nav-group">${escape(RAIL_GROUP)}</div>`
        + navItem({ id: cvTabId(CHAT_TYPE_ID), icon: CHAT_PAGE.icon, title: CHAT_PAGE.railTitle, isActive: true });
    return `<div id="${VECTORIZER_ROOT_ID}" class="vfx-ui vfx-shell">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Vectorize Content')}${rail}</div></nav>`
        + `<main class="vfx-main">${chatPageMarkup(view)}</main>`
        + '</div>';
}

function chatPageMarkup(view) {
    const cards = [sourceCard(view), windowsCard(), optionsCard(view), runCard()];
    return `<div id="${cvPageId(CHAT_TYPE_ID)}" class="vfx-page" data-cv-type="${CHAT_TYPE_ID}">`
        + pageHeader({ icon: CHAT_PAGE.icon, eyebrow: `Vectorize Content / ${RAIL_GROUP}`, title: CHAT_PAGE.title, subtitle: CHAT_PAGE.description })
        + cards.join('')
        + '</div>';
}

// ── Source ──────────────────────────────────────────────────────────────────────────────────────────────

function sourceCard(view) {
    const chat = view.chat;
    const body = stack([
        field([
            fieldLabel({ text: 'Source', forId: cvId(CHAT_TYPE_ID, 'source_choice') }),
            select({ id: cvId(CHAT_TYPE_ID, 'source_choice'), options: [
                selectOption({ value: 'this', text: 'This chat', isSelected: Boolean(chat) }),
                selectOption({ value: 'file', text: 'A chat file', isSelected: !chat }),
            ] }),
        ]),
        shownPart('this', chat ? currentChatMarkup(chat) : emptyState({ icon: 'fa-comment-slash', text: 'No chat is open. Open one, or choose a chat file.' }), Boolean(chat)),
        shownPart('file', stack([
            controlRow([button({ text: 'Choose file', icon: 'fa-file-arrow-up', data: action('choose-file') })]),
            hint({ text: 'Or drop a file on this card.', chip: codeChip({ name: CHAT_FILE_FORMATS.join(' ') }) }),
            paintedRegion('file'),
        ]), !chat),
        field([
            fieldLabel({ text: 'Start from message', forId: cvId(CHAT_TYPE_ID, 'start_from') }),
            input({ id: cvId(CHAT_TYPE_ID, 'start_from'), type: 'number', value: 1, min: 1, step: 1 }),
            hint({ text: '1 reads the whole chat. 2000 starts at the window that holds message 2000.' }),
        ]),
        field([
            fieldLabel({ text: 'End at message', forId: cvId(CHAT_TYPE_ID, 'end_at') }),
            input({ id: cvId(CHAT_TYPE_ID, 'end_at'), type: 'number', value: '', placeholder: 'The chat\'s end', min: 1, step: 1 }),
            hint({ text: 'Empty reads to the chat\'s end. 2400 ends at the window that holds message 2400.' }),
        ]),
        shownPart('read-again', switchRow({
            id: cvId(CHAT_TYPE_ID, 'read_again'),
            title: 'Read windows already read again',
            description: 'Reads every window from Start to End again, replacing its events and their links.',
        }), Boolean(chat)),
    ]);
    const header = cardHeader({ icon: 'fa-inbox', title: 'Source', description: 'What this run reads.', isCollapsible: false });
    return card(cvId(CHAT_TYPE_ID, 'source_card'), header, body);
}

/**
 * The open chat: its messages, its character and its ID.
 *
 * @param {{messageCount: number, characterName: string, chatId: string}} chat
 * @returns {string}
 */
export function currentChatMarkup(chat) {
    return controlRow([
        linePill({ text: 'Messages', name: formatCount(chat.messageCount) }, { icon: 'fa-comments' }),
        linePill({ text: 'Character', name: chat.characterName }, { icon: 'fa-user' }),
        codeChip({ name: chat.chatId }),
    ]);
}

/**
 * What a chat file holds, as pills, or why it could not be read.
 *
 * @param {{state: 'busy'|'done'|'failed', busyText?: string, lines?: {text: string, name: string}[], reason?: string}} result
 * @returns {string}
 */
export function loadedSourceMarkup({ state, busyText = '', lines = [], reason = '' }) {
    if (state === 'busy') return hint({ text: busyText });
    if (state === 'failed') return notice({ status: 'danger', text: 'It could not be read', name: reason });
    return controlRow(lines.map(line => linePill(line, { status: 'success' })));
}

// ── Windows ─────────────────────────────────────────────────────────────────────────────────────────────

const sliderField = (name, { label, min, max, step, title, hintText }) => field([
    fieldLabel({ text: label, forId: cvId(CHAT_TYPE_ID, name) }),
    sliderNumber({ id: cvId(CHAT_TYPE_ID, name), min, max, step, title }),
    hint({ text: hintText }),
]);

function windowsCard() {
    const body = stack([
        sliderField('parallel_windows', { label: 'Windows at once', min: 1, max: 8, step: 1, title: 'Windows', hintText: 'How many windows EventBase reads at the same time.' }),
        sliderField('window_size', { label: 'Window size', min: 2, max: 20, step: 1, title: 'Messages', hintText: 'Messages per window, for a first read, New collection and Start over. Saved.' }),
        sliderField('window_overlap', { label: 'Window overlap', min: 0, max: 5, step: 1, title: 'Messages', hintText: 'Messages each window repeats from the one before. Saved.' }),
    ]);
    const header = cardHeader({ icon: 'fa-scissors', title: 'Windows', description: 'EventBase reads the chat in windows of messages and stores their events.' });
    return card(cvId(CHAT_TYPE_ID, 'windows_card'), header, body);
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────────────────

function optionsCard(view) {
    const body = stack([field([
        fieldLabel({ text: 'Text cleaning', forId: cvId(CHAT_TYPE_ID, 'cleaning_preset') }),
        controlRow([
            select({ id: cvId(CHAT_TYPE_ID, 'cleaning_preset'), options: view.cleaningPresets.map(preset => selectOption({ value: preset.id, name: preset.name, isSelected: preset.id === view.cleaningPreset })) }),
            button({ text: 'Patterns', icon: 'fa-gear', data: action('manage-cleaning') }),
        ]),
        dynamicHint(view.cleaningNote, 'cleaning-note'),
    ])]);
    const header = cardHeader({ icon: 'fa-sliders', title: 'Options', description: 'How the text is cleaned before EventBase reads it.' });
    return card(cvId(CHAT_TYPE_ID, 'options_card'), header, body);
}

// ── Vectorize ───────────────────────────────────────────────────────────────────────────────────────────

function runCard() {
    const actions = [
        button({ text: 'Resume', icon: 'fa-forward', data: action('resume') }),
        button({ text: 'Vectorize', icon: 'fa-bolt', kind: 'primary', data: action('vectorize') }),
        shownPart('stop', button({ text: 'Stop', icon: 'fa-stop', kind: 'danger', data: action('stop') }), false),
    ];
    const header = cardHeader({ icon: 'fa-bolt', title: 'Vectorize', description: 'Resume adds what EventBase has not read yet.', isCollapsible: false });
    return card(cvId(CHAT_TYPE_ID, 'run_card'), header, stack([
        // Opened on New collection (Collection in use here, the question's New collection), Vectorize makes one.
        shownPart('new-collection', hint({ text: 'Vectorize reads this chat into a new collection, from the Start from message.' }), false),
        controlRow([dynamicHint('', 'run-state'), ...actions]),
    ]));
}
