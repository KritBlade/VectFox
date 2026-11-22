/**
 * The keys LoreBase's model writes for each entry the user turns on (plan D15, D17 and §5.2 of InternalProject/
 * Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md), kept in Qdrant through Similharity's LoreBase key routes
 * (lorebase-routes.js), each SillyTavern user's own, every entry's with its title (D11 of InternalProject/Vectfox/
 * plans/executed/vectfox-multi-collection-per-chat.md). A book's keys are written as many calls at once as the WorldInfo page's
 * Entries at once (1 to 8), each entry's state kept for this session and told to the key listeners. lorebase-storage.js
 * runs them on the progress panel, whose Stop drops the calls not yet sent (stopKeyRun), stores a keys file's keys
 * (writeImportedKeys), and deletes one book's keys or every book's (deleteBookKeys, deleteAllKeys). The user can also
 * edit one entry's keys, or have the model write them again to read first; nothing rewrites keys on its own. While an
 * entry's keys are written or after they fail, the selection screen says so for its row.
 */
import { log } from '../../sillytavern/log.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { PLUGIN_UPDATE_INSTRUCTIONS, similharityStanding } from '../../shared/similharity-plugin.js';
import { askOnLoreBase, resolveLoreBaseLlmConfig } from './lorebase-connection.js';
import {
    KEYS_ASKS, KEYS_MAX_TOKENS, KEYS_REASONING_EFFORT, keyCallsAtOnceOf, keyCount, keysMessages, readKeys, writingFailuresMessage,
} from './lorebase-keys-core.js';
import { postLoreBaseRoute } from './lorebase-routes.js';
import { keyWritingProblem } from './lorebase-setup.js';
import { entryTitle } from './lorebase-splitter.js';

// Similharity takes at most this many entries in one write (MOST_ENTRIES_PER_WRITE in its lorebase-keys.js).
const ENTRIES_PER_WRITE = 2000;
const UNREADABLE_ANSWER = 'its answer held no list of keys';

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
            log.warn('LoreBase: a key listener failed:', error);
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

function postKeysRoute(action, body) {
    return postLoreBaseRoute(`keys/${action}`, body, `${action} LoreBase's keys`);
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
 * Read one book's keys with the title stored beside each, for its keys file, and keep the keys for the selection
 * screen. Keys written before Similharity 3.4.14 have no title.
 * @param {string} bookName
 * @returns {Promise<{keys: Record<string, string[]>, titles: Record<string, string>}>} uid -> keys, and uid -> title
 * @throws {Error} When Similharity cannot read them
 */
export async function readBookKeysWithTitles(bookName) {
    const { books, titles } = await postKeysRoute('read', { books: [bookName] });
    const keys = books?.[bookName] ?? {};
    storedKeys.set(bookName, new Map(Object.entries(keys)));
    return { keys, titles: titles?.[bookName] ?? {} };
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
 * Whether an entry's keys are stored, as this session last read or wrote them, while they are written anew too: half of
 * whether it is ready (isEntryReady in lorebase-readiness.js). "No keys found" counts as stored.
 * @param {string} bookName
 * @param {string|number} uid
 * @returns {boolean}
 */
export function hasStoredKeys(bookName, uid) {
    return storedKeys.get(bookName)?.has(String(uid)) ?? false;
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

async function writeOne({ bookName, entry, ask, failures, onEntryDone }) {
    const uid = String(entry.uid);
    let failure = null;
    try {
        const keys = await askForKeys(entry, ask);
        // The model found nothing in the entry to key: kept as an empty list, so it is not asked again.
        if (!keys.length) log.verbose(`LoreBase: the model found nothing to key in "${entryTitle(entry)}" of lorebook "${bookName}"`);
        await postKeysRoute('write', { book: bookName, entries: [{ uid, keys, title: entryTitle(entry) }] });
        mapOf(storedKeys, bookName).set(uid, keys);
        mapOf(writeStates, bookName).delete(uid);
    } catch (error) {
        log.warn(`LoreBase: the keys of "${entryTitle(entry)}" in lorebook "${bookName}" could not be written:`, error);
        if (error?.kind === 'model_config') notifyInvalidModel(error.message);
        failure = { title: entryTitle(entry), detail: String(error?.message || error) };
        mapOf(writeStates, bookName).set(uid, { status: 'failed', detail: failure.detail });
        failures.push(failure);
    }
    tellListeners(bookName);
    onEntryDone?.(failure, entry);
}

/** Send queued entries while fewer than Entries at once are running; read each time, so a change applies as calls end. */
function runQueue() {
    while (runningCalls < keyCallsAtOnceOf(extension_settings.vectfox?.lorebase_key_calls_at_once) && queue.length) {
        const job = queue.shift();
        runningCalls += 1;
        void writeOne(job).finally(() => {
            runningCalls -= 1;
            job.done();
            runQueue();
        });
    }
}

/**
 * Whether any entry's keys are still being asked for or wait to be, which a delete would leave half done.
 * @returns {boolean}
 */
export function isWritingKeys() {
    return runningCalls + queue.length > 0;
}

/**
 * Stop a run: its keys not yet asked for leave the queue, their entries back to having no keys, each counted as
 * stopped, and `run.isStopped` tells its vector batches not yet sent to stay unsent (writeBookVectors).
 * @param {{isStopped: boolean}} run - The run writeKeys was given
 */
export function stopKeyRun(run) {
    run.isStopped = true;
    const dropped = queue.filter(job => job.run === run);
    if (!dropped.length) return;
    queue.splice(0, queue.length, ...queue.filter(job => job.run !== run));
    for (const job of dropped) {
        mapOf(writeStates, job.bookName).delete(String(job.entry.uid));
        job.stopTally.stopped += 1;
        job.done();
    }
    for (const bookName of new Set(dropped.map(job => job.bookName))) tellListeners(bookName);
}

function showKeyFailures(bookName, failures) {
    if (!failures.length) return;
    const message = writingFailuresMessage({ what: 'keys', bookName, failures, remedy: 'Open Choose entries, tick them and use Regenerate keys.' });
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(message, 'VectFox — LoreBase keys', { timeOut: 30000, extendedTimeOut: 10000 });
}

/**
 * Write the keys of a book's entries, Entries at once calls at a time: those with none, or every one given when `isRegenerating`.
 * A bulk run passes its `run`, whose stop drops the entries not yet sent, and `onEntryDone`, called with null or the
 * failure, and the entry, as each entry is done.
 * Entries already being written are left to that writing. Never throws: a failed entry is marked failed, logged, and
 * named in one toast for the book once its writing is done.
 * @param {string} bookName
 * @param {object[]} entries - The book's entries, as loadWorldInfo returns them
 * @param {object} settings - VectFox settings
 * @param {{isRegenerating?: boolean, run?: {isStopped: boolean}, onEntryDone?: (failure: object|null, entry: object) => void}} [options]
 *   isRegenerating: Regenerate keys, which rewrites hand-edited keys too
 * @returns {Promise<{written: number, failed: number, stopped: number}>} Once every entry given is written, failed or stopped
 */
export async function writeKeys(bookName, entries, settings, { isRegenerating = false, run = null, onEntryDone = null } = {}) {
    const problem = keyWritingProblem(settings);
    if (problem) {
        log.warn(`LoreBase: no keys written in lorebook "${bookName}": ${problem}`);
        return { written: 0, failed: 0, stopped: 0 };
    }
    if (!isRegenerating && !storedKeys.has(bookName)) {
        try {
            await readBookKeys([bookName]);
        } catch (error) {
            log.warn(`LoreBase: the keys of lorebook "${bookName}" could not be read, so none were written:`, error);
            showKeyFailures(bookName, entries.map(entry => ({ title: entryTitle(entry), detail: String(error?.message || error) })));
            return { written: 0, failed: entries.length, stopped: 0 };
        }
    }
    const states = mapOf(writeStates, bookName);
    const stored = mapOf(storedKeys, bookName);
    const wanted = entries.filter(entry => states.get(String(entry.uid))?.status !== 'writing' && (isRegenerating || !stored.has(String(entry.uid))));
    if (!wanted.length) return { written: 0, failed: 0, stopped: 0 };
    for (const entry of wanted) states.set(String(entry.uid), { status: 'writing' });
    tellListeners(bookName);
    const ask = askOnLoreBase(resolveLoreBaseLlmConfig(settings));
    const failures = [];
    const stopTally = { stopped: 0 };
    await Promise.all(wanted.map(entry => new Promise(done => {
        queue.push({ bookName, entry, ask, failures, done, run, stopTally, onEntryDone });
        runQueue();
    })));
    showKeyFailures(bookName, failures);
    const written = wanted.length - failures.length - stopTally.stopped;
    log.lifecycle(`LoreBase: wrote the keys of ${written} of ${wanted.length} entries in lorebook "${bookName}"`
        + (stopTally.stopped ? `, ${stopTally.stopped} stopped` : ''));
    return { written, failed: failures.length, stopped: stopTally.stopped };
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
 * Store the keys the user edited for one entry, with its title, replacing any it had, so its row shows them (D17).
 * @param {string} bookName
 * @param {object} entry - The book's entry, as loadWorldInfo returns it
 * @param {string[]} keys - From editedKeys
 * @returns {Promise<void>}
 * @throws {Error} When Similharity cannot store them
 */
export async function saveEditedKeys(bookName, entry, keys) {
    const uid = String(entry.uid);
    await postKeysRoute('write', { book: bookName, entries: [{ uid, keys, title: entryTitle(entry) }] });
    mapOf(storedKeys, bookName).set(uid, keys);
    mapOf(writeStates, bookName).delete(uid);
    tellListeners(bookName);
}

/**
 * Store the keys a keys file holds for some of a book's entries, each with its title, replacing any they had, and keep
 * them for the selection screen, telling the key listeners. No LLM call.
 * @param {string} bookName
 * @param {Array<{uid: string, title: string, keys: string[]}>} entries - From planKeysImport
 * @returns {Promise<number>} How many entries' keys were written
 * @throws {Error} When Similharity cannot store them; those written before it stay written
 */
export async function writeImportedKeys(bookName, entries) {
    const stored = mapOf(storedKeys, bookName);
    const states = mapOf(writeStates, bookName);
    let written = 0;
    try {
        for (let start = 0; start < entries.length; start += ENTRIES_PER_WRITE) {
            const batch = entries.slice(start, start + ENTRIES_PER_WRITE);
            await postKeysRoute('write', { book: bookName, entries: batch.map(({ uid, title, keys }) => ({ uid, title, keys })) });
            for (const { uid, keys } of batch) {
                stored.set(uid, keys);
                states.delete(uid);
            }
            written += batch.length;
        }
    } finally {
        tellListeners(bookName);
    }
    log.lifecycle(`LoreBase: wrote the keys of ${written} entries in lorebook "${bookName}" from a keys file`);
    return written;
}

/**
 * Delete the LoreBase keys of the named books' entries, of this SillyTavern user, and forget those this session knew,
 * telling the key listeners. lorebase-storage.js calls it once no keys are being written. A Similharity older than the
 * floor in manifest.json does not read the books named and would delete every book's keys, so nothing is sent to one.
 * @param {string[]} bookNames
 * @returns {Promise<number>} How many entries' keys were deleted
 * @throws {Error} When Similharity is older than the floor, or cannot delete them
 */
export async function deleteBookKeys(bookNames) {
    const { isCurrent, version, requiredVersion } = similharityStanding();
    if (!isCurrent) {
        throw new Error(`Deleting one lorebook's keys needs Similharity ${requiredVersion} or later${version ? `, and ${version} is installed` : ''},`
            + ` so nothing was deleted. ${PLUGIN_UPDATE_INSTRUCTIONS}`);
    }
    const { deleted } = await postKeysRoute('delete', { books: bookNames });
    for (const bookName of bookNames) {
        storedKeys.set(bookName, new Map());
        writeStates.delete(bookName);
        tellListeners(bookName);
    }
    log.lifecycle(`LoreBase: deleted the keys of ${deleted} entries in ${bookNames.length} lorebooks`);
    return deleted;
}

/**
 * Delete every LoreBase key of this SillyTavern user, in every book, and forget those this session knew, telling the
 * key listeners. deleteStored in lorebase-storage.js calls it once no keys are being written.
 * @returns {Promise<number>} How many entries' keys were deleted
 * @throws {Error} When Similharity cannot delete them
 */
export async function deleteAllKeys() {
    const { deleted } = await postKeysRoute('delete', {});
    const bookNames = [...new Set([...storedKeys.keys(), ...writeStates.keys()])];
    storedKeys.clear();
    writeStates.clear();
    for (const bookName of bookNames) tellListeners(bookName);
    log.lifecycle(`LoreBase: deleted the keys of ${deleted} entries`);
    return deleted;
}
