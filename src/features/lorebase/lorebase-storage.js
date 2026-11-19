/**
 * LoreBase's storage: the one module every page calls to count, write, export, import or delete the keys and vectors of
 * LoreBase's books (§3.1 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md), so a change to how one
 * kind is written or deleted reaches each page. The WorldInfo page's books card, the selection screen, turning LoreBase
 * on and the Database Browser all call it. It counts what the selected entries lack (selectedEntriesNotReady) and what
 * each book's selected entries have (storedCountsOfBooks); runs the progress panel's writing of keys, vectors or both
 * (writeMissing), and Regenerate keys, one run at a time, brought to the front with its Stop, which drops what is not
 * yet sent; and deletes every book's keys or vectors (deleteStored). For the Database Browser it reads a Keys row and
 * Vectors rows for each book (loreBaseStorageRows, §3.2), exports a row as a file, plans and writes a file's import
 * onto what matches (§3.3), and deletes one row. One guard refuses a run, an import or a delete while LoreBase writes. A
 * run that writes missing keys locks each book it wrote keys for to the chat it started in (§6.1 of InternalProject/
 * Vectfox/plans/lorebook-multi-vector.md); a run of vectors alone, Regenerate keys and an import lock nothing. The keys
 * and vectors themselves are written, read and kept for the session by lorebase-keys.js and lorebase-vectors.js.
 */
import { log } from '../../sillytavern/log.js';
import { world_names } from '../../sillytavern/world-info.js';
import { counted } from '../../shared/counted.js';
import { exportFileHeader } from '../../shared/export-file-header.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { loadBookEntries, loadDecidedEntries, recordedLoreBookNames, selectedLoreBookNames } from './lorebase-books.js';
import { keyRunLockPlace, lockKeyedBooks } from './lorebase-chat-books.js';
import { keysFileOf, planKeysImport, planVectorsImport, vectorsFileOf } from './lorebase-files-core.js';
import {
    deleteAllKeys, deleteBookKeys, isWritingKeys, keyStateOf, keyWritingProblem, readBookKeys, readBookKeysWithTitles, stopKeyRun,
    writeImportedKeys, writeKeys,
} from './lorebase-keys.js';
import { postLoreBaseRoute } from './lorebase-routes.js';
import { KEYS, VECTORS, pendingOfKinds, storageRowsOf, storedCountsOf, writingPanelTitle, writtenSummary } from './lorebase-storage-core.js';
import { isLoreBaseBackend } from './lorebase-switch.js';
import {
    bookVectors, currentEmbeddingModelKey, deleteAllVectors, deleteTenantPoints, entriesWithPoints, importBookPoints,
    loreBaseVectorsCollection, readBookVectors, readTenantPoints, showVectorFailures, uidsWithCurrentVectors, writeBookVectors,
} from './lorebase-vectors.js';

const uidOf = entry => String(entry.uid);
const runListeners = new Set();
// The run the progress panel shows, while one goes: one at a time, as the panel shows one.
let panelRun = null;

/**
 * What a writing run did: the entries whose keys it wrote, those whose vectors it wrote, the entries that failed and
 * that it stopped before, each counted once, the books it could not read, and the chat it locked books to with those
 * books, or null when it locked none.
 * @typedef {{keysWritten: number, vectorsWritten: number, failed: number, stopped: number, unreadBooks: number,
 *   chatLock: {chatId: string, bookNames: string[]}|null}} WritingRunOutcome
 */

/**
 * Call `listener` as a writing run on the progress panel (Generate keys, Generate vectors, Generate all, turning
 * LoreBase on, closing the selection screen, Regenerate keys) starts, with `{count, outcome: null}`, and as it ends,
 * with `{count, outcome}`, the outcome the run returns. A run with nothing to write makes no call.
 * @param {(run: {count: number, outcome: WritingRunOutcome|null}) => void} listener
 * @returns {() => void} Stops the calls
 */
export function onWritingRunChange(listener) {
    runListeners.add(listener);
    return () => runListeners.delete(listener);
}

function tellRunListeners(update) {
    for (const listener of runListeners) {
        try {
            listener(update);
        } catch (error) {
            log.warn('LoreBase: a writing run listener failed:', error);
        }
    }
}

/**
 * The one guard: refuse while LoreBase writes keys or vectors, a run or an import on the progress panel or keys still
 * being asked for, which a delete would leave half done and a second run would write twice. The panel is brought to the
 * front.
 * @throws {Error} While anything is being written
 */
function refuseWhileWriting() {
    if (!panelRun && !isWritingKeys()) return;
    progressTracker.reopen();
    throw new Error('LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.');
}

/**
 * Why `kinds` cannot be written now, or null: keys need Qdrant and LoreBase's model (keyWritingProblem); vectors need
 * Qdrant, where LoreBase keeps them, and VectFox's embedding model writes them.
 * @param {object} settings - VectFox settings
 * @param {readonly string[]} kinds - KEYS, VECTORS or BOTH_KINDS
 * @returns {string|null}
 */
export function writingProblem(settings, kinds) {
    if (kinds.includes(KEYS)) return keyWritingProblem(settings);
    return isLoreBaseBackend(settings) ? null : 'LoreBase keeps the vectors of each entry in Qdrant. Choose Qdrant as the vector backend first.';
}

/**
 * What the selected entries LoreBase decides lack, by book (§4.3, §4.4 of lorebook-multi-vector.md): every book with a
 * selection loaded, its keys read from Similharity now and its vectors as this session holds them, or read from Qdrant
 * now when `isRereading`, as turning LoreBase on and the Generate buttons ask, so edits made while SillyTavern was
 * closed are found. Each book names every entry LoreBase decides in it, those with no keys and not being written, and
 * those without vectors from the embedding model set now. `count` is every entry missing either, each once;
 * `readyCount` those with both; `decidedCount` every selected entry LoreBase decides. A book that cannot be loaded is
 * logged and counted.
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
        const keyEntries = entries.filter(entry => !hasKeys(entry) && keyStateOf(bookName, uidOf(entry)).status !== 'writing');
        const vectorEntries = entries.filter(entry => !withVectors.has(uidOf(entry)));
        const lacking = new Set([...keyEntries, ...vectorEntries].map(uidOf));
        count += lacking.size;
        readyCount += entries.filter(entry => hasKeys(entry) && withVectors.has(uidOf(entry))).length;
        if (lacking.size) books.push({ bookName, decidedEntries: entries, keyEntries, vectorEntries });
    }
    return { books, count, readyCount, decidedCount: loaded.reduce((sum, book) => sum + book.entries.length, 0), unreadBooks };
}

/**
 * How many of each named book's selected entries LoreBase decides have keys, and vectors from the embedding model set
 * now, for the books card's rows: the keys read from Similharity, the vectors as this session holds them. The card
 * counts on every chat change, so while VectFox is off, and off Qdrant, where LoreBase keeps neither, nothing is read
 * and the map is empty; a book with no selection is left out.
 * @param {string[]} bookNames
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<string, {keyCount: number, vectorCount: number}>>}
 * @throws {Error} When a book cannot be loaded, or Similharity cannot read its keys or vectors
 */
export async function storedCountsOfBooks(bookNames, settings) {
    if (!isVectFoxEnabled(settings) || !isLoreBaseBackend(settings)) return new Map();
    const loaded = [];
    for (const bookName of bookNames) {
        const entries = await loadDecidedEntries(bookName);
        if (entries.length) loaded.push({ bookName, entries });
    }
    if (!loaded.length) return new Map();
    const names = loaded.map(book => book.bookName);
    const [keys, vectors] = await Promise.all([readBookKeys(names), bookVectors(names, settings)]);
    return new Map(loaded.map(({ bookName, entries }) => [
        bookName,
        storedCountsOf(entries, keys[bookName], uidsWithCurrentVectors(bookName, entries, vectors.get(bookName), settings)),
    ]));
}

/**
 * Write each book's keys, then its vectors, as `pending` names them, under VectFox's progress panel, brought to the
 * front with its Stop, which drops what is not yet sent; then lock each book it wrote keys for where `lockPlace` says
 * (lockKeyedBooks), and tell the run listeners as it starts and ends. An entry counts once on the panel, done when the
 * last of what it lacked is written or fails; one whose keys this run asked for gets vectors only once they are
 * written, so one whose keys failed or were stopped gets none. Each book's failures get its toasts and the panel's list.
 * Nothing to write shows no panel.
 * @param {object} settings - VectFox settings
 * @param {{books: Array<{bookName: string, decidedEntries?: object[], keyEntries?: object[], vectorEntries?: object[]}>,
 *   count: number, unreadBooks?: number}} pending - What to write
 * @param {{kinds: readonly string[], isRegenerating?: boolean, lockPlace?: ReturnType<typeof keyRunLockPlace>|null}} run
 *   kinds: what the run writes, for the panel's title
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} While LoreBase writes already, the panel brought to the front
 */
async function runOnPanel(settings, { books, count, unreadBooks = 0 }, { kinds, isRegenerating = false, lockPlace = null }) {
    const outcome = { keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks, chatLock: null };
    if (!count) return outcome;
    refuseWhileWriting();
    const run = { isStopped: false };
    panelRun = run;
    try {
        let done = 0;
        const advance = failure => {
            done += 1;
            if (failure) progressTracker.addError(`${failure.title}: ${failure.detail.slice(0, 200)}`);
            progressTracker.updateProgress(done);
        };
        const keyedBookNames = [];
        progressTracker.show(writingPanelTitle(kinds), count, 'Entries', { unitLabel: 'Entries' });
        progressTracker.setCancelHandler(() => stopKeyRun(run));
        tellRunListeners({ count, outcome: null });
        for (const { bookName, decidedEntries = [], keyEntries = [], vectorEntries = [] } of books) {
            if (run.isStopped) {
                outcome.stopped += new Set([...keyEntries, ...vectorEntries].map(uidOf)).size;
                continue;
            }
            progressTracker.updateCurrentItem(bookName);
            const needsVectors = new Set(vectorEntries.map(uidOf));
            const keysAsked = new Set(keyEntries.map(uidOf));
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
            const vectorsToWrite = vectorEntries.filter(entry => !keysAsked.has(uidOf(entry)) || keyStateOf(bookName, uidOf(entry)).status === 'ready');
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
        tellRunListeners({ count, outcome: { ...outcome } });
    } finally {
        panelRun = null;
    }
    return outcome;
}

/**
 * Write what the selected entries LoreBase decides lack, of `kinds`, in every book with a selection, under the progress
 * panel: Generate keys, Generate vectors and Generate all, and with both kinds turning LoreBase on and closing the
 * selection screen (§4.3 of lorebook-multi-vector.md). Vectors are written for every entry lacking them, keys or not,
 * but in a run of both kinds an entry whose keys fail gets none. A run that writes keys reads where to lock as it
 * starts, and locks each book it wrote keys for to the chat open then (keyRunLockPlace, §6.1); a run of vectors alone
 * locks nothing.
 * @param {object} settings - VectFox settings
 * @param {readonly string[]} kinds - KEYS, VECTORS or BOTH_KINDS
 * @param {{pending?: Awaited<ReturnType<typeof selectedEntriesNotReady>>|null, booksWithChosenLocks?: Iterable<string>}} [options]
 *   pending: what the caller read, else read now, the vectors from Qdrant; booksWithChosenLocks: the books whose lock
 *   the user set on the selection screen that started the run, which keep the locks the user set
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} When Similharity cannot read the keys or vectors, or while LoreBase writes already
 */
export async function writeMissing(settings, kinds, { pending = null, booksWithChosenLocks = [] } = {}) {
    const lockPlace = kinds.includes(KEYS) ? keyRunLockPlace(booksWithChosenLocks) : null;
    const missing = pending ?? await selectedEntriesNotReady(settings, { isRereading: true });
    return runOnPanel(settings, pendingOfKinds(missing, kinds), { kinds, lockPlace });
}

/**
 * Regenerate keys: write the given entries' keys anew, hand-edited ones included, under the progress panel (D17 of
 * lorebook-semantic-overhaul-passage-index.md). Their vectors stay as they are: they hold the entry's title and text,
 * not its keys. Entries already being written are left to that writing. It locks no book.
 * @param {string} bookName
 * @param {object[]} entries - The book's entries, as loadWorldInfo returns them
 * @param {object} settings - VectFox settings
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} While LoreBase writes already
 */
export async function regenerateKeysOfEntries(bookName, entries, settings) {
    const wanted = entries.filter(entry => keyStateOf(bookName, uidOf(entry)).status !== 'writing');
    return runOnPanel(settings, { books: [{ bookName, keyEntries: wanted }], count: wanted.length }, { kinds: [KEYS], isRegenerating: true });
}

/**
 * Delete every book's stored `kinds` of this SillyTavern user, the entries turned off included: the vectors first,
 * which cost little to write again, then the keys. Selections stay, so the selected entries send nothing until both are
 * written again. Refused while LoreBase writes, which would put some back.
 * @param {readonly string[]} kinds - KEYS, VECTORS or BOTH_KINDS
 * @param {object} settings - VectFox settings
 * @returns {Promise<number>} How many entries' keys were deleted; 0 when keys are not among `kinds`
 * @throws {Error} While LoreBase writes, or when Similharity cannot delete them
 */
export async function deleteStored(kinds, settings) {
    refuseWhileWriting();
    if (kinds.includes(VECTORS)) await deleteAllVectors(recordedLoreBookNames(), settings);
    return kinds.includes(KEYS) ? deleteAllKeys() : 0;
}

/**
 * The Database Browser's LoreBase rows (§3.2): this account's books with keys or vectors, from Similharity's listing
 * (`/lorebase/books`), with every book that has a LoreBase record, each knowing whether SillyTavern still has the book
 * (storageRowsOf). Off Qdrant, where LoreBase keeps nothing, there are none.
 * @param {object} settings - VectFox settings
 * @returns {Promise<object[]>}
 * @throws {Error} When Similharity cannot list them
 */
export async function loreBaseStorageRows(settings) {
    if (!isLoreBaseBackend(settings)) return [];
    const listing = await postLoreBaseRoute('books', {}, "list LoreBase's books");
    return storageRowsOf({
        listing,
        recordedBookNames: recordedLoreBookNames(),
        hereCollection: loreBaseVectorsCollection(settings),
        sillyTavernBookNames: world_names,
    });
}

/**
 * A row's file (§3.3), with how much it holds and how much it left out: a book's keys, each entry's title from
 * SillyTavern's book or the one stored with its keys, or one tenant's points with their vectors, from whichever
 * collection holds them. Reads only.
 * @param {object} row - From loreBaseStorageRows
 * @param {object} settings - VectFox settings
 * @returns {Promise<{file: object, count: number, leftOutCount: number}>}
 * @throws {Error} When Similharity cannot read them, or SillyTavern cannot load the book
 */
export async function exportStored(row, settings) {
    if (row.kind === KEYS) {
        const { keys, titles } = await readBookKeysWithTitles(row.book);
        const entries = row.isInSillyTavern ? await loadBookEntries(row.book) : [];
        return keysFileOf({ book: row.book, header: exportFileHeader(), keys, titles, entries });
    }
    const points = row.tenant ? await readTenantPoints(row.tenant, row.collection, settings) : [];
    return vectorsFileOf({ book: row.book, header: exportFileHeader(), points });
}

/**
 * What a file would write to a row's book, without writing it (§3.3): for keys, the entries of SillyTavern's book whose
 * number and title match, selected or not; for vectors, the parts of its selected entries LoreBase decides now, read
 * against what Qdrant holds now. The plan carries what writeImport needs.
 * @param {object} row - A row of a book SillyTavern has; a Vectors row in the collection LoreBase reads now
 * @param {unknown} fileData - Parsed JSON
 * @param {object} settings - VectFox settings
 * @returns {Promise<object>} planKeysImport's or planVectorsImport's plan, with the row
 * @throws {Error} When the file is not of the row's kind, or the book, its keys or its vectors cannot be read
 */
export async function planImport(row, fileData, settings) {
    if (row.kind === KEYS) {
        const entries = await loadBookEntries(row.book);
        const storedKeys = (await readBookKeys([row.book]))[row.book] ?? {};
        return { row, ...planKeysImport(fileData, { entries, storedKeys }) };
    }
    const decidedEntries = await loadDecidedEntries(row.book);
    const stored = (await readBookVectors([row.book], settings)).get(row.book);
    const plan = planVectorsImport(fileData, { decided: entriesWithPoints(row.book, decidedEntries), stored, modelKey: currentEmbeddingModelKey(settings) });
    return { row, decidedEntries, ...plan };
}

/**
 * Store a vectors file's points with its vectors, under the progress panel. No embedding call, and no Stop: nothing
 * waits on a model.
 * @param {object} plan - From planImport, its file of the embedding model set now
 * @param {object} settings - VectFox settings
 * @returns {Promise<{written: number, failed: number, isEmbedded: boolean}>}
 * @throws {Error} When Similharity cannot store them
 */
async function storeFilePointsOnPanel(plan, settings) {
    panelRun = { isStopped: false };
    try {
        progressTracker.show(writingPanelTitle([VECTORS]), plan.writes.length, 'Parts', { unitLabel: 'Parts' });
        progressTracker.updateCurrentItem(plan.row.book);
        try {
            await importBookPoints(plan.row.book, plan.writes, settings, done => progressTracker.updateProgress(done));
        } catch (error) {
            progressTracker.addError(String(error?.message || error).slice(0, 200));
            progressTracker.complete(false, 'Wrote not every part; the console says why');
            throw error;
        }
        progressTracker.complete(true, `Wrote the vectors of ${counted(plan.writes.length, 'part')}`);
        return { written: plan.writes.length, failed: 0, isEmbedded: false };
    } finally {
        panelRun = null;
    }
}

/**
 * Write what planImport planned, behind the guard: a keys file's keys, with no LLM call; a vectors file's vectors under
 * the progress panel with no embedding call or, when its embedding model is not the one set now, the matched entries
 * embedded again as Generate vectors embeds them. It locks nothing.
 * @param {object} plan - From planImport, with something to write
 * @param {object} settings - VectFox settings
 * @returns {Promise<{written: number, failed: number, isEmbedded: boolean}>} written: entries' keys, or parts, or the
 *   entries embedded again; failed: those not written
 * @throws {Error} While LoreBase writes already, or when Similharity cannot store them
 */
export async function writeImport(plan, settings) {
    refuseWhileWriting();
    const { row } = plan;
    if (row.kind === KEYS) {
        panelRun = { isStopped: false };
        try {
            return { written: await writeImportedKeys(row.book, plan.writes), failed: 0, isEmbedded: false };
        } finally {
            panelRun = null;
        }
    }
    if (!plan.needsEmbedding) return storeFilePointsOnPanel(plan, settings);
    const uids = new Set(plan.uids);
    const vectorEntries = plan.decidedEntries.filter(entry => uids.has(uidOf(entry)));
    const outcome = await runOnPanel(settings, {
        books: [{ bookName: row.book, decidedEntries: plan.decidedEntries, vectorEntries }],
        count: vectorEntries.length,
    }, { kinds: [VECTORS] });
    return { written: outcome.vectorsWritten, failed: outcome.failed + outcome.stopped, isEmbedded: true };
}

/**
 * Delete one row's keys or vectors (§3.2), behind the guard: a book's keys, or every point of one of its tenants in
 * whichever collection holds it. Selections and LoreBase's switch stay as they are.
 * @param {object} row - From loreBaseStorageRows, holding something
 * @param {object} settings - VectFox settings
 * @returns {Promise<number>} How many entries' keys, or points, were deleted
 * @throws {Error} While LoreBase writes, or when Similharity cannot delete them
 */
export async function deleteStoredRow(row, settings) {
    refuseWhileWriting();
    if (row.kind === KEYS) return deleteBookKeys([row.book]);
    await deleteTenantPoints(row.tenant, row.collection, settings);
    return row.pointCount;
}
