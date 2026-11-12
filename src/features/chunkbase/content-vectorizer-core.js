/**
 * ============================================================================
 * VECTORIZE CONTENT: RULES
 * ============================================================================
 * What content-vectorizer.js wires and content-vectorizer-markup.js draws, kept
 * free of the page: how the content types group in the rail, which chunking
 * controls a type and strategy show, and how an uploaded or fetched source
 * becomes data: chat files, lorebook and character files, PNG character cards,
 * YouTube IDs, wiki names and the text of a web page.
 * ============================================================================
 */

import { getChunkingStrategy } from './content-types.js';

/** The rail's groups, each with its content types in order. */
export const CONTENT_TYPE_GROUPS = Object.freeze([
    { title: 'From SillyTavern', typeIds: ['chat', 'lorebook', 'character'] },
    { title: 'From outside', typeIds: ['document', 'url', 'wiki', 'youtube'] },
]);

/** The content types Auto-Reformat can read. */
const REFORMAT_TYPE_IDS = ['document', 'url', 'wiki'];

/** The fields a character's stats count. */
const CHARACTER_STAT_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];

/** Whether Auto-Reformat can read this content type. */
export const isReformatType = typeId => REFORMAT_TYPE_IDS.includes(typeId);

/** Whether this content type runs through EventBase, which reads windows of messages instead of chunking. */
export const usesEventBaseWindows = typeId => typeId === 'chat';

/**
 * The chunking controls a page shows, and the line under its strategy: a chat shows EventBase's windows, an accepted
 * Auto-Reformat shows none, and any other source its strategy's chunk size or batch size when the strategy uses one.
 *
 * @param {string} typeId
 * @param {string} strategyId
 * @param {boolean} isReformatAccepted
 * @returns {{showsStrategy: boolean, showsSize: boolean, showsBatch: boolean, showsWindows: boolean, note: string}}
 */
export function chunkingControls(typeId, strategyId, isReformatAccepted) {
    if (isReformatType(typeId) && isReformatAccepted) {
        return { showsStrategy: false, showsSize: false, showsBatch: false, showsWindows: false, note: 'Auto-Reformat made the chunks: its entries are stored as reviewed.' };
    }
    if (usesEventBaseWindows(typeId)) {
        return { showsStrategy: false, showsSize: false, showsBatch: false, showsWindows: true, note: 'EventBase reads the chat in windows of messages and stores events.' };
    }
    const strategy = getChunkingStrategy(strategyId);
    return {
        showsStrategy: true,
        showsSize: Boolean(strategy?.needsSize),
        showsBatch: Boolean(strategy?.needsBatchSize),
        showsWindows: false,
        note: strategy?.description || '',
    };
}

/** The message a chat run starts from: a whole number from 1, and 1 for anything else. */
export function startFromMessageOf(text) {
    const message = parseInt(text, 10);
    return Number.isFinite(message) && message >= 1 ? message : 1;
}

/**
 * What the dialog does once an EventBase run ends: it closes after a clean read of something new, and otherwise stays
 * open, its page saying why where nothing else has. Windows left unread get a sticky notice of their own. hasReadNothing
 * marks a run that found nothing new, which Sync chat says itself, as no page of the dialog is open to say it.
 *
 * @param {{windowsProcessed: number}|null} result - The run's result; null when a stop threw before it had one
 * @param {{isStopped?: boolean, unfinishedWindowCount?: number}} ending
 * @returns {{shouldClose: boolean, message: string, hasReadNothing: boolean}}
 */
export function eventBaseRunEnding(result, { isStopped = false, unfinishedWindowCount = 0 } = {}) {
    if (isStopped) return { shouldClose: false, message: 'Stopped. Resume adds what EventBase has not read yet.', hasReadNothing: false };
    if (!result || unfinishedWindowCount > 0) return { shouldClose: false, message: '', hasReadNothing: false };
    if (result.windowsProcessed === 0) {
        return { shouldClose: false, message: 'Nothing new to read. A message that does not fill a window waits for the next one.', hasReadNothing: true };
    }
    return { shouldClose: true, message: '', hasReadNothing: false };
}

/**
 * Sync chat's answer for a chat that is up to date, as the AutoSync page calls it: how far EventBase has read, and why
 * the newest messages wait, when some do.
 *
 * @param {{readCount: number|null, messageCount: number}} counts - readCount, the messages EventBase has read, null
 *   when it is not known
 * @returns {object[]} noticePopup lines
 */
export function syncUpToDateLines({ readCount, messageCount }) {
    const isCounted = typeof readCount === 'number';
    const shownReadCount = isCounted ? Math.min(readCount, messageCount) : 0;
    return [
        { icon: 'fa-circle-check', text: 'This chat is up to date.' },
        ...(isCounted ? [{ parts: [{ text: 'EventBase has read ' }, { name: String(shownReadCount) }, { text: ' of its ' }, { name: String(messageCount) }, { text: ' messages.' }] }] : []),
        ...(isCounted && shownReadCount < messageCount
            ? [{ text: 'The rest wait until the chat goes on. EventBase reads a window only once it is full, and the latest turn only once it settles.' }]
            : []),
    ];
}

/** A file's name without its extension. */
export const fileStem = name => String(name).replace(/\.[^/.]+$/, '');

/** A file's extension, lowercase and without its dot. */
export const fileExtension = name => String(name).split('.').pop().toLowerCase();

// ── Chat files ──────────────────────────────────────────────────────────────────────────────────────────

/** One message of a chat file, as EventBase reads it: its speaker, words, side and date, and the reasoning that may date it. */
function chatMessageOf(entry, fallbackName) {
    return {
        name: entry.name || fallbackName || (entry.is_user ? 'User' : 'Assistant'),
        mes: entry.mes || entry.text || entry.content || '',
        is_user: entry.is_user || false,
        send_date: entry.send_date,
        reasoning: entry.extra?.reasoning || '',
    };
}

const hasWords = entry => Boolean(entry && !entry.is_system && (entry.mes || entry.text || entry.content));

/**
 * The messages of a chat file and its header: a SillyTavern .jsonl (its first line the header), a .json array, export
 * object or single message, or a .txt log of "Name: words" lines, else one block of text. System messages are left out.
 * Throws on a file that does not parse.
 *
 * @param {string} text
 * @param {string} extension - jsonl, json or txt
 * @returns {{messages: object[], metadata: object|null}}
 */
export function parseChatFile(text, extension) {
    if (extension === 'jsonl') {
        const lines = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        const first = lines[0];
        const metadata = first && (first.chat_metadata || first.user_name || first.character_name) ? first : null;
        const entries = metadata ? lines.slice(1) : lines;
        return { messages: entries.filter(hasWords).map(entry => chatMessageOf(entry)), metadata };
    }
    if (extension === 'json') {
        const data = JSON.parse(text);
        if (Array.isArray(data)) return { messages: data.filter(hasWords).map(entry => chatMessageOf(entry)), metadata: null };
        if (data.chat || data.messages) {
            return {
                messages: (data.chat || data.messages).filter(hasWords).map(entry => chatMessageOf(entry)),
                metadata: { user_name: data.user_name, character_name: data.character_name },
            };
        }
        return { messages: hasWords(data) ? [chatMessageOf(data, 'Message')] : [], metadata: null };
    }
    const lines = [...text.matchAll(/^(.+?):\s*(.+)$/gm)];
    if (lines.length > 2) {
        return {
            messages: lines.map(([, name, words]) => ({ name: name.trim(), mes: words.trim(), is_user: /^(you|user|me|myself)$/i.test(name.trim()) })),
            metadata: null,
        };
    }
    return { messages: [{ mes: text, name: 'Document', is_user: false }], metadata: null };
}

/** The character a chat file is with: its header's, else the first speaker who is not the user. */
export function chatCharacterName(messages, metadata) {
    if (metadata?.character_name) return metadata.character_name;
    return messages.find(message => !message.is_user)?.name || 'Unknown';
}

/**
 * The character's name in a SillyTavern chat export's filename, "{Character} - YYYY-MM-DD@HHhMMmSSs.jsonl", else the
 * whole name without its extension.
 */
export function extractCharNameFromArchiveFilename(filename) {
    const stem = String(filename).replace(/\.(jsonl|json|txt)$/i, '');
    const match = stem.match(/^(.*?)\s+-\s+\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s$/);
    return (match ? match[1] : stem).trim();
}

// ── Lorebook and character files ────────────────────────────────────────────────────────────────────────

/**
 * The entries of a lorebook file that hold text. Throws on a file with no entries.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseLorebookFile(text) {
    const data = JSON.parse(text);
    if (!data?.entries) throw new Error('This is not a lorebook: it has no entries.');
    return Object.values(data.entries).filter(entry => entry?.content);
}

/** A character from a JSON card, V2 cards unwrapped. Throws on a file that holds no character. */
export function parseCharacterJson(text) {
    const data = JSON.parse(text);
    const character = data?.spec && data.data ? data.data : data;
    if (!character?.name && !character?.description && !character?.personality) {
        throw new Error('This is not a character card: it has no name or description.');
    }
    return character;
}

/** Base64 of UTF-8 text, decoded: atob alone turns every non-ASCII letter of a name into several wrong ones. */
function decodeBase64Text(base64) {
    const binary = atob(base64);
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
}

/**
 * The character a PNG card carries in its tEXt chunk, "ccv3" (V3) before "chara" (V2), unwrapped from its `data`.
 * Null for a PNG with neither; throws for a file that is not a PNG or a chunk that does not parse.
 *
 * @param {Uint8Array} bytes
 * @returns {object|null}
 */
export function extractCharaFromPng(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)) throw new Error('This is not a PNG file.');
    const cards = {};
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
        const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
        const start = offset + 8;
        const end = start + length;
        if (type === 'tEXt') {
            const keywordEnd = bytes.indexOf(0, start);
            const keyword = new TextDecoder().decode(bytes.slice(start, keywordEnd));
            if (keyword === 'chara' || keyword === 'ccv3') cards[keyword] = new TextDecoder().decode(bytes.slice(keywordEnd + 1, end));
        }
        if (type === 'IEND') break;
        offset = end + 4;
    }
    const encoded = cards.ccv3 ?? cards.chara;
    if (encoded === undefined) return null;
    let card;
    try {
        card = JSON.parse(decodeBase64Text(encoded));
    } catch (error) {
        throw new Error(`The character in this PNG does not parse: ${error.message}`, { cause: error });
    }
    return card?.data && card.spec ? card.data : card;
}

/** Entries, enabled entries and characters of text in a lorebook. */
export function lorebookStats(entries) {
    return {
        entryCount: entries.length,
        enabledCount: entries.filter(entry => !entry.disable).length,
        textLength: entries.reduce((sum, entry) => sum + (entry.content?.length || 0), 0),
    };
}

/** Of a character's five main fields, how many hold text, and its characters of text. */
export function characterStats(character) {
    return {
        filledCount: CHARACTER_STAT_FIELDS.filter(field => character?.[field]?.trim()).length,
        fieldCount: CHARACTER_STAT_FIELDS.length,
        textLength: CHARACTER_STAT_FIELDS.reduce((sum, field) => sum + (character?.[field]?.length || 0), 0),
    };
}

// ── Fetched sources ─────────────────────────────────────────────────────────────────────────────────────

/** A YouTube video's ID from a link of any form or the bare ID, or null. */
export function parseYouTubeId(text) {
    const value = String(text ?? '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
    const match = value.match(/^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]*).*/);
    return match?.[1] || null;
}

/** A Fandom wiki's ID from its link ("baldursgate" from https://baldursgate.fandom.com/), or the text as typed. */
export function extractFandomId(text) {
    try {
        return new URL(text).hostname.split('.')[0] || text;
    } catch {
        // EXPECTED: a bare ID such as "baldursgate" is not a URL, and is the ID.
        return text;
    }
}

/** The name a scraped wiki's collection takes: a Fandom wiki's ID, or a MediaWiki page's last path part or host. */
export function extractWikiName(text, wikiType) {
    if (wikiType === 'fandom') return extractFandomId(text);
    try {
        const url = new URL(text);
        return url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    } catch {
        // EXPECTED: a typed page name is not a URL; its first 50 characters name the collection.
        return String(text).substring(0, 50);
    }
}

const NON_TEXT_ELEMENTS = 'script, style, noscript, template, svg, canvas, iframe, nav, footer, aside, form, button';
const BLOCK_ELEMENTS = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL']);

/**
 * A web page's title and readable text: its article or main part, else its body, without scripts, styles, menus and
 * forms; each block on its own line and each heading as a Markdown one, so By Section Headers can split on it.
 *
 * @param {string} html
 * @param {(html: string) => Document} parseHtml - DOMParser's parseFromString as text/html
 * @returns {{title: string, text: string}}
 */
export function pageTextFromHtml(html, parseHtml) {
    const page = parseHtml(String(html ?? ''));
    const title = (page.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
    for (const element of page.querySelectorAll(NON_TEXT_ELEMENTS)) element.remove();
    const root = page.querySelector('article') || page.querySelector('main') || page.body;
    if (!root) return { title, text: '' };
    const parts = [];
    const read = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) parts.push(child.nodeValue);
            if (child.nodeType !== 1) continue;
            const isBlock = BLOCK_ELEMENTS.has(child.tagName);
            const level = /^H([1-6])$/.exec(child.tagName)?.[1];
            if (isBlock) parts.push('\n');
            if (level) parts.push(`${'#'.repeat(Number(level))} `);
            read(child);
            if (isBlock) parts.push('\n');
        }
    };
    read(root);
    const text = parts.join('').split('\n')
        .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
        .filter((line, index, lines) => line !== '#' && !(line === '' && lines[index - 1] === ''))
        .join('\n')
        .replace(/^#+ $/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { title, text };
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────────────────

/** How many chunks Preview lists. */
export const PREVIEW_CHUNK_COUNT = 10;

/**
 * The rows Preview lists: the first chunks' numbers, opening words and lengths, an Auto-Reformat entry's type and name
 * before its words; and how many chunks there are in all, with their average length.
 *
 * @param {(string|{text: string, metadata?: object})[]} chunks
 * @param {number} textLength - The source's characters, for the average
 * @returns {{count: number, averageLength: number, rows: {number: number, text: string, length: number}[], moreCount: number}}
 */
export function previewOf(chunks, textLength) {
    const rows = chunks.slice(0, PREVIEW_CHUNK_COUNT).map((chunk, index) => {
        const words = typeof chunk === 'string' ? chunk : String(chunk?.text ?? '');
        const entry = typeof chunk === 'object' && chunk?.metadata?.strategy === 'llm_reformat' ? `[${chunk.metadata.entry_type || 'entry'}] ${chunk.metadata.name || ''}: ` : '';
        const opening = `${entry}${words.substring(0, 150)}${words.length > 150 ? '…' : ''}`;
        return { number: index + 1, text: opening, length: words.length };
    });
    return {
        count: chunks.length,
        averageLength: chunks.length ? Math.round(textLength / chunks.length) : 0,
        rows,
        moreCount: Math.max(0, chunks.length - PREVIEW_CHUNK_COUNT),
    };
}
