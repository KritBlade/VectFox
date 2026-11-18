/**
 * The keys LoreBase's model writes for each entry the user turns on (plan D15, D17 and §5.2 of InternalProject/
 * Vectfox/plans/lorebook-semantic-overhaul-passage-index.md), kept in Qdrant through Similharity's LoreBase key routes,
 * each SillyTavern user's own, and the run that writes them with the same entries' vectors (§4.3 of InternalProject/
 * Vectfox/plans/lorebook-multi-vector.md, lorebase-vectors.js). Turning LoreBase on, closing the selection screen (each
 * after asking), Generate all and Regenerate keys run it under VectFox's progress panel, brought to the front with its
 * Stop, which drops what is not yet sent; one run at a time. A book's keys go first, as many calls at once as the
 * WorldInfo page's Entries at once (1 to 8), then its vectors in batches. A run that writes missing keys then locks each
 * book it wrote keys for to the chat it started in, as §6.1 of lorebook-multi-vector.md says; Regenerate keys writes
 * keys alone and locks nothing. The user can also edit one entry's keys, or have the model write them again to read
 * first, and Delete all deletes every key and vector; nothing rewrites keys on its own. An entry takes part in a reply
 * only once it has its keys and vectors, and while its keys are written or after they fail, the selection screen says
 * so for its row.
 */
import { log } from '../../sillytavern/log.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { loadDecidedEntries, recordedLoreBookNames, selectedLoreBookNames } from './lorebase-books.js';
import { keyRunLockPlace, lockKeyedBooks } from './lorebase-chat-books.js';
import { notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { readErrorBody } from '../../shared/server-error-text.js';
import { askOnLoreBase, describeLoreBaseConnectionProblem, resolveLoreBaseLlmConfig } from './lorebase-connection.js';
import {
    KEYS_ASKS, KEYS_MAX_TOKENS, KEYS_REASONING_EFFORT, keyCallsAtOnceOf, keyCount, keysMessages, readKeys, writingFailuresMessage,
} from './lorebase-keys-core.js';
import { entryTitle } from './lorebase-splitter.js';
import {
    bookVectors, deleteAllVectors, readBookVectors, showVectorFailures, uidsWithCurrentVectors, writeBookVectors,
} from './lorebase-vectors.js';

const KEYS_ROUTE = '/api/plugins/similharity/lorebase/keys';
const QDRANT_BACKEND = 'qdrant';
const UNREADABLE_ANSWER = 'its answer held no list of keys';

// What Qdrant holds, as last read or written in this session: book name -> uid -> keys.
const storedKeys = new Map();
// Entries being written or whose writing failed: book name -> uid -> {status: 'writing'} | {status: 'failed', detail}.
const writeStates = new Map();
const stateListeners = new Set();
const runListeners = new Set();
const queue = [];
let runningCalls = 0;

const mapOf = (maps, bookName) => {
    if (!maps.has(bookName)) maps.set(bookName, new Map());
    return maps.get(bookName);
};
const uidOf = entry => String(entry.uid);

function callEach(listeners, update) {
    for (const listener of listeners) {
        try {
            listener(update);
        } catch (error) {
            log.warn('LoreBase: a key listener failed:', error);
        }
    }
}

const tellListeners = bookName => callEach(stateListeners, bookName);

/**
 * Call `listener` with a book's name each time one of its entries' keys is written, starts being written or fails.
 * @param {(bookName: string) => void} listener
 * @returns {() => void} Stops the calls
 */
export function onKeyStateChange(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
}

/**
 * What a writing run did: the entries whose keys it wrote, those whose vectors it wrote, the entries that failed and
 * that it stopped before, each counted once, the books it could not read, and the chat it locked books to with those
 * books, or null when it locked none.
 * @typedef {{keysWritten: number, vectorsWritten: number, failed: number, stopped: number, unreadBooks: number,
 *   chatLock: {chatId: string, bookNames: string[]}|null}} WritingRunOutcome
 */

/**
 * Call `listener` as a writing run on the progress panel (Generate all, turning LoreBase on, closing the selection
 * screen, Regenerate keys) starts, with `{count, outcome: null}`, and as it ends, with `{count, outcome}`, the outcome
 * the run returns. A run with nothing to write makes no call.
 * @param {(run: {count: number, outcome: WritingRunOutcome|null}) => void} listener
 * @returns {() => void} Stops the calls
 */
export function onWritingRunChange(listener) {
    runListeners.add(listener);
    return () => runListeners.delete(listener);
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

async function writeOne({ bookName, entry, ask, failures, onEntryDone }) {
    const uid = String(entry.uid);
    let failure = null;
    try {
        const keys = await askForKeys(entry, ask);
        // The model found nothing in the entry to key: kept as an empty list, so it is not asked again.
        if (!keys.length) log.verbose(`LoreBase: the model found nothing to key in "${entryTitle(entry)}" of lorebook "${bookName}"`);
        await postKeysRoute('write', { book: bookName, entries: [{ uid, keys }] });
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
 * Stop a run: its keys not yet asked for leave the queue, their entries back to having no keys, each counted as
 * stopped, and its vector batches not yet sent stay unsent (writeBookVectors).
 */
function stopRun(run) {
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
 * What the selected entries LoreBase decides lack, by book (§4.3, §4.4): every book with a selection loaded, its keys
 * read from Similharity now and its vectors as this session holds them, or read from Qdrant now when `isRereading`, as
 * turning LoreBase on and Generate all ask, so edits made while SillyTavern was closed are found. Each book names every
 * entry LoreBase decides in it, those with no keys and not being written, and those without vectors from the embedding
 * model set now. `count` is every entry missing either, each once; `readyCount` those with both; `decidedCount` every
 * selected entry LoreBase decides. A book that cannot be loaded is logged and counted.
 * @param {object} settings - VectFox settings
 * @param {{isRereading?: boolean}} [options]
 * @returns {Promise<{books: Array<{bookName: string, decidedEntries: object[], keyEntries: object[], vectorEntries: object[]}>,
 *   count: number, readyCount: number, decidedCount: number, unreadBooks: number}>}
 * @throws {Error} When Similharity cannot read the keys or the vectors
 */
export async function selectedEntriesNotReady(settings, { isRereading = false } = {}) {
    const loaded = [];
    let unreadBooks = 0;
    for (const bookName of selectedLoreBookNames()) {
        try {
            const entries = await loadDecidedEntries(bookName);
            if (entries.length) loaded.push({ bookName, entries });
        } catch (error) {
            log.warn(`LoreBase: lorebook "${bookName}" could not be read, so its selected entries' keys and vectors were not counted:`, error);
            unreadBooks += 1;
        }
    }
    const bookNames = loaded.map(book => book.bookName);
    const keys = await readBookKeys(bookNames);
    const vectors = isRereading ? await readBookVectors(bookNames, settings) : await bookVectors(bookNames, settings);
    let count = 0;
    let readyCount = 0;
    const books = [];
    for (const { bookName, entries } of loaded) {
        const withVectors = uidsWithCurrentVectors(bookName, entries, vectors.get(bookName), settings);
        const hasKeys = entry => Boolean(keys[bookName]?.[uidOf(entry)]);
        const keyEntries = entries.filter(entry => !hasKeys(entry) && writeStates.get(bookName)?.get(uidOf(entry))?.status !== 'writing');
        const vectorEntries = entries.filter(entry => !withVectors.has(uidOf(entry)));
        const lacking = new Set([...keyEntries, ...vectorEntries].map(uidOf));
        count += lacking.size;
        readyCount += entries.filter(entry => hasKeys(entry) && withVectors.has(uidOf(entry))).length;
        if (lacking.size) books.push({ bookName, decidedEntries: entries, keyEntries, vectorEntries });
    }
    return { books, count, readyCount, decidedCount: loaded.reduce((sum, book) => sum + book.entries.length, 0), unreadBooks };
}

const entriesOf = count => `${count} ${count === 1 ? 'entry' : 'entries'}`;

function writtenSummary({ keysWritten, vectorsWritten, failed, stopped }) {
    const written = [keysWritten ? `the keys of ${entriesOf(keysWritten)}` : '', vectorsWritten ? `the vectors of ${entriesOf(vectorsWritten)}` : '']
        .filter(Boolean).join(' and ');
    const parts = [written ? `Wrote ${written}` : 'Wrote nothing'];
    if (failed) parts.push(`${failed} failed`);
    if (stopped) parts.push(`${stopped} stopped`);
    return parts.join('; ');
}

// The run the progress panel shows, while one goes: one at a time, as the panel shows one.
let panelRun = null;

/**
 * Write each book's keys, then its vectors, under VectFox's progress panel, brought to the front with its Stop, which
 * drops what is not yet sent; then lock each book it wrote keys for where `lockPlace` says (lockKeyedBooks), and tell
 * the run listeners as it starts and ends. An entry counts once on the panel, done when the last of what it lacked is
 * written or fails; one whose keys fail or are stopped gets no vectors. Each book's failures get its toasts and the
 * panel's list. Nothing to write shows no panel.
 * @param {object} settings - VectFox settings
 * @param {{books: Array<{bookName: string, decidedEntries?: object[], keyEntries?: object[], vectorEntries?: object[]}>,
 *   count: number, unreadBooks?: number}} pending - What to write
 * @param {{isRegenerating?: boolean, lockPlace?: ReturnType<typeof keyRunLockPlace>}} [options]
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} While another run is on the panel, which is brought to the front
 */
async function writeOnPanel(settings, { books, count, unreadBooks = 0 }, { isRegenerating = false, lockPlace = null } = {}) {
    const outcome = { keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks, chatLock: null };
    if (!count) return outcome;
    if (panelRun) {
        progressTracker.reopen();
        throw new Error('LoreBase is already writing keys or vectors on the progress panel. Wait for it, or press Stop there.');
    }
    const run = { isStopped: false, vectorProblem: null };
    panelRun = run;
    try {
        let done = 0;
        const advance = failure => {
            done += 1;
            if (failure) progressTracker.addError(`${failure.title}: ${failure.detail.slice(0, 200)}`);
            progressTracker.updateProgress(done);
        };
        const keyedBookNames = [];
        progressTracker.show(isRegenerating ? 'LoreBase keys' : 'LoreBase keys and vectors', count, 'Entries', { unitLabel: 'Entries' });
        progressTracker.setCancelHandler(() => stopRun(run));
        callEach(runListeners, { count, outcome: null });
        for (const { bookName, decidedEntries = [], keyEntries = [], vectorEntries = [] } of books) {
            if (run.isStopped) {
                outcome.stopped += new Set([...keyEntries, ...vectorEntries].map(uidOf)).size;
                continue;
            }
            progressTracker.updateCurrentItem(bookName);
            const needsVectors = new Set(vectorEntries.map(uidOf));
            if (keyEntries.length) {
                const result = await writeKeys(bookName, keyEntries, settings, {
                    isRegenerating,
                    run,
                    onEntryDone: (failure, entry) => {
                        if (failure || !needsVectors.has(uidOf(entry))) advance(failure);
                    },
                });
                outcome.keysWritten += result.written;
                outcome.failed += result.failed;
                outcome.stopped += result.stopped;
                if (result.written) keyedBookNames.push(bookName);
            }
            // An entry whose keys failed or were stopped is counted already, and gets no vectors.
            const keyed = storedKeys.get(bookName);
            const vectorsToWrite = vectorEntries.filter(entry => keyed?.has(uidOf(entry)));
            if (!vectorsToWrite.length) continue;
            const result = await writeBookVectors(bookName, decidedEntries, vectorsToWrite, settings, {
                run,
                onEntryDone: (_entry, failure) => advance(failure),
            });
            outcome.vectorsWritten += result.written;
            outcome.failed += result.failures.length;
            outcome.stopped += result.stopped;
            showVectorFailures(bookName, result.failures);
        }
        outcome.chatLock = lockKeyedBooks(lockPlace, keyedBookNames);
        progressTracker.complete(!outcome.failed && !outcome.stopped, writtenSummary(outcome));
        callEach(runListeners, { count, outcome: { ...outcome } });
    } finally {
        panelRun = null;
    }
    return outcome;
}

/**
 * Write the keys and vectors every selected entry LoreBase decides lacks, in every book with a selection, as turning
 * LoreBase on, closing the selection screen and Generate all ask (§4.3 of lorebook-multi-vector.md), under the
 * progress panel. Once written, each book it wrote keys for is locked to the chat open as it started, where §6.1 says
 * (lockKeyedBooks).
 * @param {object} settings - VectFox settings
 * @param {Awaited<ReturnType<typeof selectedEntriesNotReady>>} [pending] - What to write, when the caller read it; else
 *   read now, the vectors from Qdrant (Generate all)
 * @param {{booksWithChosenLocks?: Iterable<string>}} [options] - booksWithChosenLocks: the books whose lock the user set
 *   on the selection screen that started the run, which keep the locks the user set
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} When Similharity cannot read the keys or vectors, or while another run is on the panel
 */
export async function writeKeysAndVectorsOfSelections(settings, pending = null, { booksWithChosenLocks = [] } = {}) {
    const lockPlace = keyRunLockPlace(booksWithChosenLocks);
    return writeOnPanel(settings, pending ?? await selectedEntriesNotReady(settings, { isRereading: true }), { lockPlace });
}

/**
 * Regenerate keys: write the given entries' keys anew, hand-edited ones included, under the progress panel (D17). Their
 * vectors stay as they are: they hold the entry's title and text, not its keys. Entries already being written are left
 * to that writing. It locks no book.
 * @param {string} bookName
 * @param {object[]} entries - The book's entries, as loadWorldInfo returns them
 * @param {object} settings - VectFox settings
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} While another run is on the panel
 */
export async function regenerateKeysOfEntries(bookName, entries, settings) {
    const wanted = entries.filter(entry => writeStates.get(bookName)?.get(String(entry.uid))?.status !== 'writing');
    return writeOnPanel(settings, { books: [{ bookName, keyEntries: wanted }], count: wanted.length }, { isRegenerating: true });
}

/**
 * Delete all: every LoreBase vector and key of this SillyTavern user, in every book, the entries turned off included,
 * the vectors first, which cost little to write again. Selections stay, so the selected entries send nothing until both
 * are written again. Refused while a run writes, which would put some back; the progress panel showing it is brought
 * to the front.
 * @param {object} settings - VectFox settings
 * @returns {Promise<number>} How many entries' keys were deleted
 * @throws {Error} While a run writes, or when Similharity cannot delete them
 */
export async function deleteAllKeysAndVectors(settings) {
    const unwritten = runningCalls + queue.length;
    if (panelRun || unwritten) {
        progressTracker.reopen();
        throw new Error('LoreBase is still writing keys or vectors; the progress panel shows them. Press Stop there, or delete once it is done.');
    }
    await deleteAllVectors(recordedLoreBookNames(), settings);
    const { deleted } = await postKeysRoute('delete', {});
    const bookNames = [...new Set([...storedKeys.keys(), ...writeStates.keys()])];
    storedKeys.clear();
    writeStates.clear();
    for (const bookName of bookNames) tellListeners(bookName);
    log.lifecycle(`LoreBase: deleted the keys of ${deleted} entries`);
    return deleted;
}
