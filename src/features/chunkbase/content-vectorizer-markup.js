/**
 * ============================================================================
 * VECTORIZE CONTENT: MARKUP
 * ============================================================================
 * The Vectorize Content dialog drawn with the GUI-DNA genes: a rail of the
 * content types, in two groups, and a page for each type of cards in order:
 * Source, Auto-Reformat (Document, URL and Wiki), Chunking, Options, then
 * Preview and vectorize. Every control's id is its page's (cvId), so the pages
 * live side by side and each keeps what was typed or loaded on it; the
 * painted parts are built here too. content-vectorizer.js wires it.
 * ============================================================================
 */

import {
    button,
    checkList,
    codeChip,
    controlRow,
    emptyState,
    field,
    fieldLabel,
    hint,
    input,
    listRow,
    notice,
    select,
    selectOption,
    stack,
    statusPill,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, navBrand, navItem, pageHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtml as escape } from '../../shared/html-escape.js';
import { CHARACTER_FIELDS, getChunkingStrategies, getContentType, getContentTypeDefaults, hasFeature } from './content-types.js';
import { CONTENT_TYPE_GROUPS, isReformatType, usesEventBaseWindows } from './content-vectorizer-core.js';

export const VECTORIZER_ROOT_ID = 'vectfox_content_vectorizer';

/** A type's nav item. */
export const cvTabId = typeId => `vectfox_cv_tab_${typeId}`;

/** A type's page. */
export const cvPageId = typeId => `vectfox_cv_page_${typeId}`;

/** A control on a type's page. */
export const cvId = (typeId, name) => `vectfox_cv_${typeId}_${name}`;

const HIDDEN = ' hidden';

/** A page the rail does not show: the DNA displays .vfx-page itself, so the hidden attribute would not hide it. */
const PAGE_HIDDEN = ' style="display:none;"';

/** The rail's short name for each type; the page's header gives the full one. */
const RAIL_TITLES = { chat: 'Chat', lorebook: 'Lorebook', character: 'Character', document: 'Document', url: 'Web page', wiki: 'Wiki', youtube: 'YouTube' };

/** A type's icon in the rail and its header: Font Awesome solid, so YouTube's brand icon gives way to captions. */
const typeIcon = type => (type.iconBrand ? 'fa-closed-captioning' : type.icon);

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

// ── Rail and pages ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The dialog: the rail of content types, then a page for each, the one for `activeTypeId` shown.
 *
 * @param {{activeTypeId: string, view: object}} options - view: what the pages draw (sourceView's input)
 * @returns {string}
 */
export function contentVectorizerMarkup({ activeTypeId, view }) {
    const items = [];
    for (const group of CONTENT_TYPE_GROUPS) {
        items.push(`<div class="vfx-nav-group">${escape(group.title)}</div>`);
        for (const typeId of group.typeIds) {
            items.push(navItem({ id: cvTabId(typeId), icon: typeIcon(getContentType(typeId)), title: RAIL_TITLES[typeId], isActive: typeId === activeTypeId }));
        }
    }
    const pages = CONTENT_TYPE_GROUPS.flatMap(group => group.typeIds.map(typeId => typePageMarkup(typeId, group.title, typeId === activeTypeId, view)));
    return `<div id="${VECTORIZER_ROOT_ID}" class="vfx-ui vfx-shell">`
        + `<nav class="vfx-nav"><div class="vfx-nav-inner">${navBrand('Vectorize Content')}${items.join('')}</div></nav>`
        + `<main class="vfx-main">${pages.join('')}</main>`
        + '</div>';
}

function typePageMarkup(typeId, groupTitle, isShown, view) {
    const type = getContentType(typeId);
    const cards = [
        sourceCard(type, view),
        isReformatType(typeId) ? reformatCard(typeId) : '',
        chunkingCard(type),
        optionsCard(type, view),
        runCard(typeId),
    ];
    return `<div id="${cvPageId(typeId)}" class="vfx-page" data-cv-type="${typeId}"${isShown ? '' : PAGE_HIDDEN}>`
        + pageHeader({ icon: typeIcon(type), eyebrow: `Vectorize Content / ${groupTitle}`, title: type.name, subtitle: type.description })
        + cards.join('')
        + '</div>';
}

// ── Source ──────────────────────────────────────────────────────────────────────────────────────────────

const choiceField = (typeId, options) => field([
    fieldLabel({ text: 'Source', forId: cvId(typeId, 'source_choice') }),
    select({ id: cvId(typeId, 'source_choice'), options: options.map(option => selectOption(option)) }),
]);

const fileChooser = (typeId, formats) => stack([
    controlRow([button({ text: 'Choose file', icon: 'fa-file-arrow-up', data: action('choose-file') })]),
    hint({ text: 'Or drop a file on this card.', chip: codeChip({ name: formats.join(' ') }) }),
    paintedRegion('file'),
]);

function sourceCard(type, view) {
    const typeId = type.id;
    const bodies = {
        chat: () => chatSource(type, view),
        select: () => selectSource(type),
        input: () => documentSource(type),
        url: () => urlSource(type),
        wiki: () => wikiSource(type),
        youtube: () => youtubeSource(type),
    };
    const header = cardHeader({ icon: 'fa-inbox', title: 'Source', description: 'What this run reads.', isCollapsible: false });
    return card(cvId(typeId, 'source_card'), header, bodies[type.sourceType]());
}

function chatSource(type, view) {
    const typeId = type.id;
    const chat = view.chat;
    return stack([
        choiceField(typeId, [
            { value: 'this', text: 'This chat', isSelected: Boolean(chat) },
            { value: 'file', text: 'A chat file', isSelected: !chat },
        ]),
        shownPart('this', chat ? currentChatMarkup(chat) : emptyState({ icon: 'fa-comment-slash', text: 'No chat is open. Open one, or choose a chat file.' }), Boolean(chat)),
        shownPart('file', fileChooser(typeId, type.sourceOptions.uploadFormats), !chat),
        field([
            fieldLabel({ text: 'Start from message', forId: cvId(typeId, 'start_from') }),
            input({ id: cvId(typeId, 'start_from'), type: 'number', value: 1, min: 1, step: 1 }),
            hint({ text: '1 reads the whole chat; 2000 starts at message 2000.' }),
        ]),
    ]);
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

function selectSource(type) {
    const typeId = type.id;
    const label = typeId === 'lorebook' ? 'Lorebook' : 'Character';
    return stack([
        choiceField(typeId, [
            { value: 'existing', text: 'From SillyTavern', isSelected: true },
            { value: 'file', text: 'A file' },
        ]),
        shownPart('existing', stack([
            field([
                fieldLabel({ text: label, forId: cvId(typeId, 'source_select') }),
                select({ id: cvId(typeId, 'source_select'), options: [selectOption({ value: '', text: 'Loading…' })] }),
            ]),
            paintedRegion('stats'),
        ])),
        shownPart('file', fileChooser(typeId, type.sourceOptions.uploadFormats), false),
    ]);
}

/**
 * The lorebooks or characters SillyTavern has, for the source select: the open character first.
 *
 * @param {{value: string, name: string, isCurrent?: boolean}[]} sources
 * @param {string} emptyText - The option shown when there are none
 * @returns {string}
 */
export function sourceOptionsMarkup(sources, emptyText) {
    if (!sources.length) return selectOption({ value: '', text: emptyText });
    return [selectOption({ value: '', text: 'Choose one' })]
        .concat(sources.map(source => selectOption({ value: source.value, name: source.isCurrent ? `${source.name} (open now)` : source.name, isSelected: Boolean(source.isCurrent) })))
        .join('');
}

function documentSource(type) {
    const typeId = type.id;
    const formats = type.sourceOptions.methods.find(method => method.id === 'upload')?.formats || [];
    return stack([
        choiceField(typeId, [
            { value: 'paste', text: 'Pasted text', isSelected: true },
            { value: 'file', text: 'A file' },
        ]),
        shownPart('paste', field([
            fieldLabel({ text: 'Text', forId: cvId(typeId, 'paste_text') }),
            textarea({ id: cvId(typeId, 'paste_text'), rows: 8, title: 'Text to vectorize' }),
        ])),
        shownPart('file', fileChooser(typeId, formats), false),
        field([
            fieldLabel({ text: 'Collection name', forId: cvId(typeId, 'doc_name') }),
            input({ id: cvId(typeId, 'doc_name'), placeholder: 'My Document' }),
        ]),
    ]);
}

function fetchRow(typeId, inputId, placeholder, buttonText) {
    return controlRow([
        input({ id: cvId(typeId, inputId), placeholder }),
        button({ text: buttonText, icon: 'fa-download', data: action('fetch') }),
    ]);
}

function urlSource(type) {
    const typeId = type.id;
    return stack([
        field([
            fieldLabel({ text: 'Page address', forId: cvId(typeId, 'url_input') }),
            fetchRow(typeId, 'url_input', type.sourceOptions?.placeholder || 'https://example.com/article', 'Fetch'),
            hint({ text: 'SillyTavern fetches the page, and its readable text is kept.' }),
        ]),
        paintedRegion('fetched'),
    ]);
}

function wikiSource(type) {
    const typeId = type.id;
    const wikiTypes = type.sourceOptions.types;
    return stack([
        paintedRegion('plugin', hint({ text: 'Looking for the Fandom Scraper plugin…' })),
        field([
            fieldLabel({ text: 'Wiki', forId: cvId(typeId, 'wiki_type') }),
            select({ id: cvId(typeId, 'wiki_type'), options: wikiTypes.map((wiki, index) => selectOption({ value: wiki.id, text: wiki.name, isSelected: index === 0 })) }),
        ]),
        field([
            fieldLabel({ text: 'Wiki address or ID', forId: cvId(typeId, 'wiki_url') }),
            input({ id: cvId(typeId, 'wiki_url'), placeholder: wikiTypes[0].placeholder }),
        ]),
        field([
            fieldLabel({ text: 'Pages', forId: cvId(typeId, 'wiki_filter') }),
            input({ id: cvId(typeId, 'wiki_filter'), placeholder: type.sourceOptions.filterPlaceholder }),
            hint({ text: 'Empty scrapes one page; page names, comma-separated, scrape each.' }),
        ]),
        controlRow([button({ text: 'Scrape', icon: 'fa-download', data: action('fetch') })]),
        paintedRegion('fetched'),
    ]);
}

function youtubeSource(type) {
    const typeId = type.id;
    return stack([
        field([
            fieldLabel({ text: 'Video address or ID', forId: cvId(typeId, 'youtube_url') }),
            fetchRow(typeId, 'youtube_url', type.sourceOptions.placeholder, 'Fetch'),
        ]),
        field([
            fieldLabel({ text: 'Language', forId: cvId(typeId, 'youtube_lang') }),
            input({ id: cvId(typeId, 'youtube_lang'), placeholder: 'en' }),
            hint({ text: 'A two-letter code such as en or ja; empty takes the video\'s own.' }),
        ]),
        paintedRegion('fetched'),
    ]);
}

/**
 * A wiki's plugin state: found, or missing with where to get it.
 *
 * @param {{isAvailable: boolean, wikiName: string, pluginUrl: string}} state
 * @returns {string}
 */
export function wikiPluginMarkup({ isAvailable, wikiName, pluginUrl }) {
    if (isAvailable) return statusPill({ name: `${wikiName} scraper ready`, status: 'success', icon: 'fa-circle-check' });
    const install = `<a class="vfx-btn" href="${escape(pluginUrl)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>Get the plugin</span></a>`;
    return notice({ status: 'warning', text: 'Scraping a wiki needs SillyTavern\'s Fandom Scraper plugin, which this server lacks.', action: install });
}

/**
 * What a fetch, scrape or file load holds, as pills, or why it failed.
 *
 * @param {{state: 'busy'|'done'|'failed', busyText?: string, lines?: {text: string, name: string}[], reason?: string}} result
 * @returns {string}
 */
export function loadedSourceMarkup({ state, busyText = '', lines = [], reason = '' }) {
    if (state === 'busy') return hint({ text: busyText });
    if (state === 'failed') return notice({ status: 'danger', text: 'It could not be read', name: reason });
    return controlRow(lines.map(line => linePill(line, { status: 'success' })));
}

// ── Auto-Reformat ───────────────────────────────────────────────────────────────────────────────────────

function reformatCard(typeId) {
    const header = cardHeader({ icon: 'fa-wand-magic-sparkles', title: 'Auto-Reformat', description: 'An LLM rewrites the source as clean entries; optional.' });
    return card(cvId(typeId, 'reformat_card'), header, paintedRegion('reformat', reformatMarkup({ state: 'idle' })));
}

/**
 * Auto-Reformat's card body: what it does and its button; the batch it is on; its accepted entries, with the way
 * back to chunking by strategy; or why it produced nothing.
 *
 * @param {{state: 'idle'|'busy'|'accepted'|'failed'|'empty', progressText?: string, entryCount?: number, reason?: string}} view
 * @returns {string}
 */
export function reformatMarkup({ state, progressText = '', entryCount = 0, reason = '' }) {
    const run = text => button({ text, icon: 'fa-wand-magic-sparkles', kind: 'primary', data: action('reformat') });
    if (state === 'busy') return hint({ text: progressText });
    if (state === 'accepted') {
        return stack([
            notice({ status: 'success', text: 'Auto-Reformat accepted. Its entries are the chunks', name: formatCount(entryCount) }),
            controlRow([
                button({ text: 'Chunk by strategy', icon: 'fa-rotate-left', data: action('reformat-discard') }),
                button({ text: 'Run again', icon: 'fa-arrows-rotate', data: action('reformat') }),
            ]),
        ]);
    }
    const intro = [
        hint({ text: 'One entry per character, place or topic, each reviewed before anything is stored.' }),
        controlRow([run('Run Auto-Reformat')]),
    ];
    if (state === 'failed') return stack([notice({ status: 'danger', text: 'Auto-Reformat failed', name: reason }), ...intro]);
    if (state === 'empty') return stack([notice({ status: 'warning', text: 'Auto-Reformat made no entries', name: reason }), ...intro]);
    return stack(intro);
}

// ── Chunking ────────────────────────────────────────────────────────────────────────────────────────────

const sliderField = (typeId, name, { label, min, max, step, title, hintText }) => field([
    fieldLabel({ text: label, forId: cvId(typeId, name) }),
    sliderNumber({ id: cvId(typeId, name), min, max, step, title }),
    hint({ text: hintText }),
]);

function chunkingCard(type) {
    const typeId = type.id;
    const defaults = getContentTypeDefaults(typeId);
    const strategies = getChunkingStrategies(typeId);
    const parts = [];
    if (strategies.length && !usesEventBaseWindows(typeId)) {
        parts.push(shownPart('strategy', field([
            fieldLabel({ text: 'Strategy', forId: cvId(typeId, 'strategy') }),
            select({ id: cvId(typeId, 'strategy'), options: strategies.map(strategy => selectOption({ value: strategy.id, text: strategy.name, isSelected: strategy.id === defaults.strategy })) }),
        ])));
    }
    parts.push(dynamicHint('', 'strategy-note'));
    if (strategies.some(strategy => strategy.needsSize)) {
        parts.push(shownPart('size', sliderField(typeId, 'chunk_size', { label: 'Chunk size', min: 100, max: 1000, step: 50, title: 'Characters', hintText: 'Characters per chunk: fewer finds more exactly, more keeps context.' })));
    }
    if (strategies.some(strategy => strategy.needsBatchSize)) {
        parts.push(shownPart('batch', sliderField(typeId, 'batch_size', { label: 'Messages per batch', min: 1, max: 20, step: 1, title: 'Messages', hintText: 'How many messages each chunk holds.' })));
    }
    if (usesEventBaseWindows(typeId)) {
        parts.push(shownPart('windows', stack([
            sliderField(typeId, 'parallel_windows', { label: 'Windows at once', min: 1, max: 8, step: 1, title: 'Windows', hintText: 'How many windows EventBase reads at the same time.' }),
            sliderField(typeId, 'window_size', { label: 'Window size', min: 2, max: 20, step: 1, title: 'Messages', hintText: 'Messages per window. Saved; a new size reads the chat again.' }),
            sliderField(typeId, 'window_overlap', { label: 'Window overlap', min: 0, max: 5, step: 1, title: 'Messages', hintText: 'Messages each window repeats from the one before. Saved.' }),
        ])));
    }
    const header = cardHeader({ icon: 'fa-scissors', title: 'Chunking', description: 'How the source is cut into chunks.' });
    return card(cvId(typeId, 'chunking_card'), header, stack(parts));
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────────────────

const KEYWORD_LEVELS = [
    { value: 'off', text: 'Off: trigger keys only' },
    { value: 'minimal', text: 'Minimal: the opening, 5 at most' },
    { value: 'balanced', text: 'Balanced: the header, 12 at most' },
    { value: 'aggressive', text: 'Aggressive: the whole text, 15 at most' },
];

function optionsCard(type, view) {
    const typeId = type.id;
    const defaults = getContentTypeDefaults(typeId);
    const parts = [];
    if (hasFeature(typeId, 'scopeControl')) {
        parts.push(field([
            fieldLabel({ text: 'Scope', forId: cvId(typeId, 'scope') }),
            select({ id: cvId(typeId, 'scope'), options: scopeOptions(view, defaults.scope || 'character') }),
            hint({ text: 'Where retrieval uses this collection.' }),
        ]));
    }
    if (hasFeature(typeId, 'fieldSelection')) {
        parts.push(field([
            fieldLabel({ text: 'Fields' }),
            checkList({ items: CHARACTER_FIELDS.map(characterField => ({ name: characterField.name, isChecked: Boolean(defaults.fields?.[characterField.id]), data: { 'cv-field': characterField.id } })) }),
        ]));
    }
    parts.push(field([
        fieldLabel({ text: 'Text cleaning', forId: cvId(typeId, 'cleaning_preset') }),
        controlRow([
            select({ id: cvId(typeId, 'cleaning_preset'), options: view.cleaningPresets.map(preset => selectOption({ value: preset.id, name: preset.name, isSelected: preset.id === view.cleaningPreset })) }),
            button({ text: 'Patterns', icon: 'fa-gear', data: action('manage-cleaning') }),
        ]),
        dynamicHint(view.cleaningPresets.find(preset => preset.id === view.cleaningPreset)?.description || '', 'cleaning-note'),
    ]));
    if (hasFeature(typeId, 'keywordExtraction')) {
        parts.push(field([
            fieldLabel({ text: 'Keywords', forId: cvId(typeId, 'keyword_level') }),
            select({ id: cvId(typeId, 'keyword_level'), options: KEYWORD_LEVELS.map(level => selectOption({ ...level, isSelected: level.value === 'balanced' })) }),
            hint({ text: typeId === 'lorebook' ? 'Trigger keys always count; the level adds words from the text.' : 'The level picks words from the text, the most frequent first.' }),
        ]));
    }
    if (hasFeature(typeId, 'respectDisabled')) {
        parts.push(switchRow({ id: cvId(typeId, 'include_disabled'), title: 'Include disabled entries', description: 'Off skips the entries switched off in World Info.' }));
    }
    const header = cardHeader({ icon: 'fa-sliders', title: 'Options', description: 'What the chunks carry and where they are used.' });
    return card(cvId(typeId, 'options_card'), header, stack(parts));
}

function scopeOptions(view, defaultScope) {
    const character = view.characterName;
    const chat = view.chat;
    return [
        selectOption({ value: 'character', name: character ? `Character: ${character}` : 'Character (none open)', isSelected: defaultScope === 'character' }),
        selectOption({ value: 'chat', name: chat ? 'This chat' : 'This chat (none open)', isSelected: defaultScope === 'chat' }),
    ];
}

// ── Preview and vectorize ───────────────────────────────────────────────────────────────────────────────

function runCard(typeId) {
    const isChat = usesEventBaseWindows(typeId);
    const actions = [
        isChat ? '' : button({ text: 'Preview chunks', icon: 'fa-eye', data: action('preview') }),
        isChat ? button({ text: 'Resume', icon: 'fa-forward', data: action('resume') }) : '',
        button({ text: 'Vectorize', icon: 'fa-bolt', kind: 'primary', data: action('vectorize') }),
        shownPart('stop', button({ text: 'Stop', icon: 'fa-stop', kind: 'danger', data: action('stop') }), false),
    ].filter(Boolean);
    const header = cardHeader({ icon: 'fa-bolt', title: isChat ? 'Vectorize' : 'Preview and vectorize', description: isChat ? 'Resume adds what EventBase has not read yet.' : 'Preview shows the first chunks; nothing is stored until Vectorize.', isCollapsible: false });
    return card(cvId(typeId, 'run_card'), header, stack([
        paintedRegion('preview', isChat ? hint({ text: 'EventBase writes events from the chat, so there are no chunks to preview.' }) : emptyState({ icon: 'fa-eye', text: 'Preview chunks lists the first ten.' })),
        controlRow([dynamicHint('', 'run-state'), ...actions]),
    ]));
}

/**
 * Preview's list: how many chunks and their average length, the first ones with their opening words, and how many
 * more there are.
 *
 * @param {ReturnType<typeof import('./content-vectorizer-core.js').previewOf>} preview
 * @param {boolean} isReformat - The chunks are Auto-Reformat's entries
 * @returns {string}
 */
export function previewMarkup(preview, isReformat) {
    const rows = preview.rows.map(row => listRow({
        icon: 'fa-puzzle-piece',
        name: `${row.number}. ${row.text}`,
        pills: [statusPill({ name: `${formatCount(row.length)} characters` })],
    }));
    return stack([
        controlRow([
            linePill({ text: isReformat ? 'Entries' : 'Chunks', name: formatCount(preview.count) }, { status: 'success' }),
            linePill({ text: 'Average', name: `${formatCount(preview.averageLength)} characters` }),
        ]),
        `<div class="vfx-list">${rows.join('')}</div>`,
        preview.moreCount ? hint({ text: `And ${formatCount(preview.moreCount)} more.` }) : '',
    ]);
}

/** Why Preview could not read or chunk the source. */
export function previewFailedMarkup(reason) {
    return notice({ status: 'danger', text: 'Preview failed', name: reason });
}

/** While Preview reads the source. */
export function previewBusyMarkup() {
    return hint({ text: 'Reading the source…' });
}
