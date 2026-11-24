/**
 * ============================================================================
 * VECTORIZE CONTENT: RULES
 * ============================================================================
 * What content-vectorizer.js wires and content-vectorizer-markup.js draws, kept
 * free of the page: the messages a run starts from and ends at, how a run ends,
 * Sync chat's up-to-date answer, and how an uploaded chat file becomes messages.
 * ============================================================================
 */

/** The chat files the Chat page takes. */
export const CHAT_FILE_FORMATS = Object.freeze(['.txt', '.jsonl', '.json']);

/** The message a chat run starts from: a whole number from 1, and 1 for anything else. */
export function startFromMessageOf(text) {
    const message = parseInt(text, 10);
    return Number.isFinite(message) && message >= 1 ? message : 1;
}

/** The message a chat run ends at: a whole number from 1, and null, the chat's end, for anything else. */
export function endAtMessageOf(text) {
    const message = parseInt(text, 10);
    return Number.isFinite(message) && message >= 1 ? message : null;
}

/**
 * The messages a run reads, as a question names them: from its first, and to its last when it has one.
 *
 * @param {{startFromMessage: number, endAtMessage: number|null}} run
 * @returns {string}
 */
export function stretchWords({ startFromMessage, endAtMessage }) {
    return `from message ${startFromMessage}${endAtMessage == null ? '' : ` to message ${endAtMessage}`}`;
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
