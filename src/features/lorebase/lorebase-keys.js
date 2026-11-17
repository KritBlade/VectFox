/**
 * The keys LoreBase's model writes for each entry the user turns on (plan D15, D17 and §5.2 of InternalProject/
 * Vectfox/plans/lorebook-semantic-overhaul-passage-index.md), kept in Qdrant through Similharity's LoreBase key routes,
 * each SillyTavern user's own. Turning an entry on, turning LoreBase on, Generate all keys and Regenerate keys write
 * them, a few calls at a time; the user can also edit one entry's keys, or have the model write them again to read
 * first, and Delete all keys deletes every one; nothing rewrites them on its own. An entry takes part in a reply only once its keys exist, and while they are written or
 * after they fail, the selection screen says so for its row.
 */
import { log } from '../../sillytavern/log.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { loadWorldInfo } from '../../sillytavern/world-info.js';
import { getLoreBook, selectedLoreBookNames } from './lorebase-books.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { readErrorBody } from '../../shared/server-error-text.js';
import { askOnLoreBase, describeLoreBaseConnectionProblem, resolveLoreBaseLlmConfig } from './lorebase-connection.js';
import { KEYS_ASKS, KEYS_MAX_TOKENS, KEYS_REASONING_EFFORT, keyCount, keysMessages, readKeys } from './lorebase-keys-core.js';
import { decidedEntries } from './lorebase-reply-core.js';
import { entryTitle } from './lorebase-splitter.js';

const KEYS_ROUTE = '/api/plugins/similharity/lorebase/keys';
// As many key calls at once as T20 ran (PARALLEL_CALLS in lorebase_benchmark.py).
const KEY_CALLS_AT_ONCE = 6;
const QDRANT_BACKEND = 'qdrant';
const UNREADABLE_ANSWER = 'its answer held no keys';

// What Qdrant holds, as last read or written in this session: book name -> uid -> keys.
const storedKeys = new Map();
// Entries being written or whose writing failed: book name -> uid -> {status: 'writing'} | {status: 'failed', detail}.
const writeStates = new Map();
const stateListeners = new Set();
const queue = [];
let runningCalls = 0;

const mapOf = (maps, bookName) => {
    if (!maps.has(bookName)) maps.set(bookName, new Map());
    return maps.get(bookName);
};

function tellListeners(bookName) {
    for (const listener of stateListeners) {
        try {
            listener(bookName);
        } catch (error) {
            log.warn('LoreBase: a key state listener failed:', error);
        }
    }
}

/**
 * Call `listener` with a book's name each time one of its entries' keys is written, starts being written or fails.
 * @param {(bookName: string) => void} listener
 * @returns {() => void} Stops the calls
 */
export function onKeyStateChange(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
}

async function postKeysRoute(action, body) {
    const response = await fetch(`${KEYS_ROUTE}/${action}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) {
        const detail = await readErrorBody(response, response.statusText);
        throw new Error(`Similharity could not ${action} LoreBase's keys (HTTP ${response.status}): ${detail}`);
    }
    return response.json();
}

/**
 * Read the keys Qdrant holds for the entries of the named books, and keep them for the selection screen.
 * @param {string[]} bookNames
 * @returns {Promise<Record<string, Record<string, string[]>>>} {book: {uid: keys}}, every named book present
 * @throws {Error} When Similharity cannot read them
 */
export async function readBookKeys(bookNames) {
    if (!bookNames.length) return {};
    const { books } = await postKeysRoute('read', { books: bookNames });
    for (const bookName of bookNames) storedKeys.set(bookName, new Map(Object.entries(books?.[bookName] ?? {})));
    return Object.fromEntries(bookNames.map(bookName => [bookName, books?.[bookName] ?? {}]));
}

/**
 * Where an entry's keys stand, as this session knows them.
 * @param {string} bookName
 * @param {string} uid
 * @returns {{status: 'ready', keys: string[]}|{status: 'writing'}|{status: 'failed', detail: string}|{status: 'missing'}}
 */
export function keyStateOf(bookName, uid) {
    const state = writeStates.get(bookName)?.get(String(uid));
    if (state?.status === 'writing') return state;
    const keys = storedKeys.get(bookName)?.get(String(uid));
    if (keys) return { status: 'ready', keys };
    return state ?? { status: 'missing' };
}

/**
 * Why keys cannot be written now, or null: LoreBase keeps them in Qdrant (D15), and its model writes them (D17).
 * @param {object} settings - VectFox settings
 * @returns {string|null}
 */
export function keyWritingProblem(settings) {
    if (settings?.vector_backend !== QDRANT_BACKEND) {
        return 'LoreBase keeps the keys its model writes for each entry in Qdrant. Choose Qdrant as the vector backend first.';
    }
    const connection = resolveLoreBaseLlmConfig(settings);
    return connection.ok ? null : describeLoreBaseConnectionProblem(connection.reason, connection.problem);
}

async function askForKeys(entry, ask) {
    const count = keyCount(entry);
    let lastProblem = UNREADABLE_ANSWER;
    for (let asks = 1; asks <= KEYS_ASKS; asks += 1) {
        try {
            const keys = readKeys(await ask(keysMessages(entry), { maxTokens: KEYS_MAX_TOKENS, reasoningEffort: KEYS_REASONING_EFFORT, identKeys: ['keys'] }), count);
            if (keys) return keys;
            lastProblem = UNREADABLE_ANSWER;
        } catch (error) {
            // A model the provider refuses fails every ask the same way.
            if (error?.kind === 'model_config') throw error;
            lastProblem = String(error?.message || error).replace(/\s+/g, ' ').trim();
            log.warn(`LoreBase: ask ${asks} of ${KEYS_ASKS} for the keys of "${entryTitle(entry)}" failed:`, error);
        }
    }
    throw new Error(lastProblem);
}

async function writeOne({ bookName, entry, ask, failures }) {
    const uid = String(entry.uid);
    try {
        const keys = await askForKeys(entry, ask);
        await postKeysRoute('write', { book: bookName, entries: [{ uid, keys }] });
        mapOf(storedKeys, bookName).set(uid, keys);
        mapOf(writeStates, bookName).delete(uid);
    } catch (error) {
        log.warn(`LoreBase: the keys of "${entryTitle(entry)}" in lorebook "${bookName}" could not be written:`, error);
        if (error?.kind === 'model_config') notifyInvalidModel(error.message);
        const detail = String(error?.message || error);
        mapOf(writeStates, bookName).set(uid, { status: 'failed', detail });
        failures.push({ title: entryTitle(entry), detail });
    }
    tellListeners(bookName);
}

function runQueue() {
    while (runningCalls < KEY_CALLS_AT_ONCE && queue.length) {
        const job = queue.shift();
        runningCalls += 1;
        void writeOne(job).finally(() => {
            runningCalls -= 1;
            job.done();
            runQueue();
        });
    }
}

function showKeyFailures(bookName, failures) {
    if (!failures.length) return;
    const titles = failures.slice(0, 3).map(failure => `"${failure.title}"`).join(', ');
    const more = failures.length > 3 ? ` and ${failures.length - 3} more` : '';
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(
        `LoreBase could not write the keys of ${titles}${more} in lorebook "${bookName}", so they send nothing until they have keys. `
        + `Open Choose entries, tick them and use Regenerate keys. Details: ${failures[0].detail.slice(0, 320)}`,
        'VectFox — LoreBase keys', { timeOut: 30000, extendedTimeOut: 10000 });
}

/**
 * Write the keys of a book's entries, a few calls at a time: those with none, or every one given when `isRegenerating`.
 * Entries already being written are left to that writing. Never throws: a failed entry is marked failed, logged, and
 * named in one toast for the book once its writing is done.
 * @param {string} bookName
 * @param {object[]} entries - The book's entries, as loadWorldInfo returns them
 * @param {object} settings - VectFox settings
 * @param {{isRegenerating?: boolean}} [options] - isRegenerating: Regenerate keys, which rewrites hand-edited keys too
 * @returns {Promise<{written: number, failed: number}>} Once every entry given is written or failed
 */
export async function writeKeys(bookName, entries, settings, { isRegenerating = false } = {}) {
    const problem = keyWritingProblem(settings);
    if (problem) {
        log.warn(`LoreBase: no keys written in lorebook "${bookName}": ${problem}`);
        return { written: 0, failed: 0 };
    }
    if (!isRegenerating && !storedKeys.has(bookName)) {
        try {
            await readBookKeys([bookName]);
        } catch (error) {
            log.warn(`LoreBase: the keys of lorebook "${bookName}" could not be read, so none were written:`, error);
            showKeyFailures(bookName, entries.map(entry => ({ title: entryTitle(entry), detail: String(error?.message || error) })));
            return { written: 0, failed: entries.length };
        }
    }
    const states = mapOf(writeStates, bookName);
    const stored = mapOf(storedKeys, bookName);
    const wanted = entries.filter(entry => states.get(String(entry.uid))?.status !== 'writing' && (isRegenerating || !stored.has(String(entry.uid))));
    if (!wanted.length) return { written: 0, failed: 0 };
    for (const entry of wanted) states.set(String(entry.uid), { status: 'writing' });
    tellListeners(bookName);
    const ask = askOnLoreBase(resolveLoreBaseLlmConfig(settings));
    const failures = [];
    await Promise.all(wanted.map(entry => new Promise(done => {
        queue.push({ bookName, entry, ask, failures, done });
        runQueue();
    })));
    showKeyFailures(bookName, failures);
    log.lifecycle(`LoreBase: wrote the keys of ${wanted.length - failures.length} of ${wanted.length} entries in lorebook "${bookName}"`);
    return { written: wanted.length - failures.length, failed: failures.length };
}

/**
 * The keys LoreBase's model writes for one entry now, stored nowhere: the edit dialog's Regenerate, which shows them to
 * the user before Save keys stores them.
 * @param {object} entry - The book's entry, as loadWorldInfo returns it
 * @param {object} settings - VectFox settings
 * @returns {Promise<string[]>}
 * @throws {Error} Why keys cannot be written now, or what the last of the model's asks reported; a model the provider
 *   refuses keeps its kind, model_config
 */
export async function regenerateKeys(entry, settings) {
    const problem = keyWritingProblem(settings);
    if (problem) throw new Error(problem);
    return askForKeys(entry, askOnLoreBase(resolveLoreBaseLlmConfig(settings)));
}

/**
 * Store the keys the user edited for one entry, replacing any it had, so its row shows them (D17).
 * @param {string} bookName
 * @param {string|number} uid
 * @param {string[]} keys - From editedKeys
 * @returns {Promise<void>}
 * @throws {Error} When Similharity cannot store them
 */
export async function saveEditedKeys(bookName, uid, keys) {
    await postKeysRoute('write', { book: bookName, entries: [{ uid: String(uid), keys }] });
    mapOf(storedKeys, bookName).set(String(uid), keys);
    mapOf(writeStates, bookName).delete(String(uid));
    tellListeners(bookName);
}

/**
 * Write the keys of every selected entry LoreBase decides, in every book with a selection, that has none, as turning
 * LoreBase on and Generate all keys ask (§5.2, §5.9). Never throws: a book that cannot be read is logged and counted,
 * and each book's failures get its toast.
 * @param {object} settings - VectFox settings
 * @returns {Promise<{written: number, failed: number, unreadBooks: number}>}
 */
export async function writeKeysOfSelections(settings) {
    const totals = { written: 0, failed: 0, unreadBooks: 0 };
    for (const bookName of selectedLoreBookNames()) {
        let book;
        try {
            book = await loadWorldInfo(bookName);
        } catch (error) {
            log.warn(`LoreBase: lorebook "${bookName}" could not be read, so its selected entries' keys were not written:`, error);
            totals.unreadBooks += 1;
            continue;
        }
        const entries = decidedEntries(book, getLoreBook(bookName));
        if (!entries.length) continue;
        const { written, failed } = await writeKeys(bookName, entries, settings);
        totals.written += written;
        totals.failed += failed;
    }
    return totals;
}

/**
 * Delete all keys: every LoreBase key of this SillyTavern user, in every book, the entries turned off included.
 * Selections stay, so the selected entries send nothing until their keys are written again. Refused while keys are
 * being written, which would put some back.
 * @returns {Promise<number>} How many entries' keys were deleted
 * @throws {Error} While keys are being written, or when Similharity cannot delete them
 */
export async function deleteAllKeys() {
    if (runningCalls || queue.length) throw new Error('LoreBase is writing keys. Delete them once it is done.');
    const { deleted } = await postKeysRoute('delete', {});
    const bookNames = [...new Set([...storedKeys.keys(), ...writeStates.keys()])];
    storedKeys.clear();
    writeStates.clear();
    for (const bookName of bookNames) tellListeners(bookName);
    log.lifecycle(`LoreBase: deleted the keys of ${deleted} entries`);
    return deleted;
}
