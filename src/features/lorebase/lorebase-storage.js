/**
 * LoreBase's storage: the one module every page calls to count, write, export, import or delete the keys and vectors of
 * LoreBase's books (§3.1 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md), so a change to how one
 * kind is written or deleted reaches each page. The WorldInfo page's books card, the selection screen, turning LoreBase
 * on and the Database Browser all call it. It counts what the selected entries lack (selectedEntriesNotReady) and what
 * each book's selected entries have, are ready with, lack or failed to get (storedCountsOfBooks); runs the progress
 * panel's writing of keys, vectors or both (writeMissing), and Regenerate keys, one run at a time, brought to the front
 * with its Stop, which drops what is not yet sent, telling the books card the book it writes and how far it is
 * (onWritingProgress); and deletes every book's keys or vectors (deleteStored). For the Database Browser it reads a Keys row and
 * Vectors rows for each book, the list's and the leftovers' (loreBaseStorageRows, §3.2), exports a row as a file, finds
 * the row a file the global Import takes goes to (loreBaseImportRow), plans and writes a file's import onto what matches
 * (§3.3), and deletes one row. Remove from LoreBase, on the Database Browser's lorebook row and the WorldInfo page's
 * book row alike, reads what a book holds for its confirm (loreBookHoldings), then deletes all of it, its record last
 * (removeLoreBook). LoreBase's entry editor saves an entry through it and has its vectors written
 * (saveEntryWithVectors). One guard refuses a run, an import, a delete, a removal or an entry's save while LoreBase
 * writes. A run that writes missing keys locks each book it wrote keys for to the chat it started in (§6.1 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md); a run of vectors alone, Regenerate keys and an import lock
 * nothing. The keys and vectors themselves are written, read and kept for the session by lorebase-keys.js and
 * lorebase-vectors.js.
 */
import { log } from '../../sillytavern/log.js';
import { saveLorebookEntry, world_names } from '../../sillytavern/world-info.js';
import { counted } from '../../shared/counted.js';
import { exportFileHeader } from '../../shared/export-file-header.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import {
    decidedCountOf, deleteLoreBookRecord, getLoreBook, getLoreSelection, loadBookEntries, loadDecidableEntries, loadDecidedEntries,
    loreBookRecordCounts, selectedLoreBookNames,
} from './lorebase-books.js';
import { keyRunLockPlace, lockKeyedBooks } from './lorebase-chat-books.js';
import { keysFileOf, planKeysImport, planVectorsImport, vectorsFileOf } from './lorebase-files-core.js';
import {
    deleteAllKeys, deleteBookKeys, hasStoredKeys, isWritingKeys, keyStateOf, readBookKeys, readBookKeysWithTitles, stopKeyRun,
    writeImportedKeys, writeKeys,
} from './lorebase-keys.js';
import { isEntryReady } from './lorebase-readiness.js';
import { postLoreBaseRoute } from './lorebase-routes.js';
import { unionOfSelections } from './lorebase-selections-core.js';
import { qdrantProblem, writingProblem } from './lorebase-setup.js';
import {
    KEYS, VECTORS, emptyRowOf, hasLoreBaseHoldings, listedHoldingsOf, pendingOfKinds, storageRowsOf, storedCountsOf, writingPanelTitle, writtenSummary,
} from './lorebase-storage-core.js';
import { isLoreBaseBackend } from './lorebase-switch.js';
import {
    bookVectors, currentEmbeddingModelKey, deleteTenantPoints, entriesWithPoints, forgetBookVectors, forgetVectorWriteFailures, hasStoredCurrentVectors,
    importBookPoints, loreBaseVectorsCollection, readBookVectors, readTenantPoints, showVectorFailures, vectorStateOf, writeBookVectors,
} from './lorebase-vectors.js';

const uidOf = entry => String(entry.uid);
const runListeners = new Set();
const progressListeners = new Set();
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
 * Call `listener` as a writing run on the progress panel moves through its books, for the books card's rows (§7.1 of
 * lorebook-multi-vector.md): with the book it writes now, the kind, KEYS or VECTORS, and how many of the entries it
 * writes that kind for are done, as each starts and as each entry is done; then with null once the run ends.
 * @param {(progress: {bookName: string, kind: string, done: number, total: number}|null) => void} listener
 * @returns {() => void} Stops the calls
 */
export function onWritingProgress(listener) {
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
}

function tellProgressListeners(progress) {
    for (const listener of progressListeners) {
        try {
            listener(progress);
        } catch (error) {
            log.warn('LoreBase: a writing progress listener failed:', error);
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
 * Save one entry's title and text into its lorebook through SillyTavern, from LoreBase's entry editor, then write its
 * vectors when LoreBase decides it as saved: its changed parts embedded, and what no entry LoreBase decides holds
 * deleted (writeBookVectors), whether LoreBase is on or not. Its keys stay as they are. An entry LoreBase does not
 * decide is saved alone, its book's vectors left as they are. Refused while LoreBase writes, as that writing would race
 * this one.
 * @param {string} bookName
 * @param {string} uid - The entry's uid
 * @param {{comment: string, content: string}} fields - Its title and text
 * @param {object} settings - VectFox settings
 * @returns {Promise<{isDecided: boolean, failure: {title: string, detail: string}|null, vectorProblem: string|null}>}
 *   isDecided: whether LoreBase decides the entry as saved; failure: why its vectors were not written; vectorProblem:
 *   why no vectors can be written here, off Qdrant
 * @throws {Error} While LoreBase writes, or when SillyTavern has no such book or entry
 */
export async function saveEntryWithVectors(bookName, uid, fields, settings) {
    refuseWhileWriting();
    await saveLorebookEntry(bookName, uid, fields);
    const decidedEntries = await loadDecidedEntries(bookName);
    const entry = decidedEntries.find(candidate => uidOf(candidate) === String(uid));
    if (!entry) {
        log.lifecycle(`LoreBase: saved entry ${uid} of lorebook "${bookName}" from its editor; LoreBase does not decide it, so no vectors were written`);
        return { isDecided: false, failure: null, vectorProblem: null };
    }
    const vectorProblem = writingProblem(settings, [VECTORS]);
    if (vectorProblem) return { isDecided: true, failure: null, vectorProblem };
    const { failures } = await writeBookVectors(bookName, decidedEntries, [entry], settings);
    log.lifecycle(`LoreBase: saved entry ${uid} of lorebook "${bookName}" from its editor${failures.length ? '; its vectors failed' : ', and wrote its vectors'}`);
    return { isDecided: true, failure: failures[0] ?? null, vectorProblem: null };
}

/**
 * What the selected entries LoreBase decides lack, by book (§4.3, §4.4 of lorebook-multi-vector.md): every book with a
 * selection loaded, its keys read from Similharity now and its vectors as this session holds them, or read from Qdrant
 * now when `isRereading`, as turning LoreBase on and the Generate buttons ask, so edits made while SillyTavern was
 * closed are found. Each book with something to write names every entry LoreBase decides in it, those with no keys and
 * not being written, and those without vectors from the embedding model set now. `count` is every entry not ready
 * (isEntryReady), each once; `readyCount` those ready; `decidedCount` every selected entry LoreBase decides. A book that
 * cannot be loaded is logged and counted.
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
    await readBookKeys(bookNames);
    await (isRereading ? readBookVectors(bookNames, settings) : bookVectors(bookNames, settings));
    let count = 0;
    let readyCount = 0;
    const books = [];
    for (const { bookName, entries } of loaded) {
        const keyEntries = entries.filter(entry => !hasStoredKeys(bookName, uidOf(entry)) && keyStateOf(bookName, uidOf(entry)).status !== 'writing');
        const vectorEntries = entries.filter(entry => !hasStoredCurrentVectors(bookName, entry, settings));
        const bookReadyCount = entries.filter(entry => isEntryReady(bookName, entry, settings)).length;
        count += entries.length - bookReadyCount;
        readyCount += bookReadyCount;
        if (keyEntries.length || vectorEntries.length) books.push({ bookName, decidedEntries: entries, keyEntries, vectorEntries });
    }
    return { books, count, readyCount, decidedCount: loaded.reduce((sum, book) => sum + book.entries.length, 0), unreadBooks };
}

/**
 * Where each named book's selected entries LoreBase decides stand, for the books card's rows (storedCountsOf, §7.1 of
 * lorebook-multi-vector.md): those of the selection the row shows, in use in the open chat, or every entry the book's
 * selections hold while none is; the keys read from Similharity, the vectors as this session holds them, and the
 * failures of this session's writing. The card counts on every chat change, so while VectFox is off, and off Qdrant,
 * where LoreBase keeps neither, nothing is read and the map is empty; a book with no selection is left out.
 * @param {Array<{bookName: string, selectionId: string|null}>} books - Each book, with the selection its row shows
 * @param {object} settings - VectFox settings
 * @returns {Promise<Map<string, ReturnType<typeof storedCountsOf>>>}
 * @throws {Error} When a book cannot be loaded, has no selection of a row's ID, or Similharity cannot read its keys or
 *   vectors
 */
export async function storedCountsOfBooks(books, settings) {
    if (!isVectFoxEnabled(settings) || !isLoreBaseBackend(settings)) return new Map();
    const loaded = [];
    for (const { bookName, selectionId } of books) {
        const selection = selectionId ? getLoreSelection(bookName, selectionId) : unionOfSelections(getLoreBook(bookName));
        const entries = await loadDecidedEntries(bookName, selection);
        if (entries.length) loaded.push({ bookName, entries });
    }
    if (!loaded.length) return new Map();
    const names = loaded.map(book => book.bookName);
    await Promise.all([readBookKeys(names), bookVectors(names, settings)]);
    return new Map(loaded.map(({ bookName, entries }) => [bookName, storedCountsOf(entries.map(entry => {
        const keyState = keyStateOf(bookName, uidOf(entry));
        const vectorState = vectorStateOf(bookName, entry, settings);
        const failure = [keyState, vectorState].find(state => state.status === 'failed')?.detail ?? null;
        return {
            hasKeys: hasStoredKeys(bookName, uidOf(entry)),
            hasVectors: hasStoredCurrentVectors(bookName, entry, settings),
            isReady: isEntryReady(bookName, entry, settings),
            vectorStatus: vectorState.status,
            failure,
        };
    }))]));
}

/**
 * Write each book's keys, then its vectors, as `pending` names them, under VectFox's progress panel, brought to the
 * front with its Stop, which drops what is not yet sent; then lock each book it wrote keys for where `lockPlace` says
 * (lockKeyedBooks), and tell the run listeners as it starts and ends. An entry counts once on the panel, done when the
 * last of what it lacked is written or fails; one whose keys this run asked for gets vectors only once they are
 * written, so one whose keys failed or were stopped gets none. Each book's failures get its toasts and the panel's list.
 * Nothing to write shows no panel. Refused while LoreBase writes, even with nothing to write.
 * @param {object} settings - VectFox settings
 * @param {{books: Array<{bookName: string, decidedEntries?: object[], keyEntries?: object[], vectorEntries?: object[]}>,
 *   count: number, unreadBooks?: number}} pending - What to write
 * @param {{kinds: readonly string[], isRegenerating?: boolean, lockPlace?: ReturnType<typeof keyRunLockPlace>|null}} run
 *   kinds: what the run writes, for the panel's title
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} While LoreBase writes already, the panel brought to the front
 */
async function runOnPanel(settings, { books, count, unreadBooks = 0 }, { kinds, isRegenerating = false, lockPlace = null }) {
    refuseWhileWriting();
    const outcome = { keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks, chatLock: null };
    if (!count) return outcome;
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
                let keysDone = 0;
                tellProgressListeners({ bookName, kind: KEYS, done: 0, total: keyEntries.length });
                const result = await writeKeys(bookName, keyEntries, settings, {
                    isRegenerating,
                    run,
                    onEntryDone: (failure, entry) => {
                        keysDone += 1;
                        tellProgressListeners({ bookName, kind: KEYS, done: keysDone, total: keyEntries.length });
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
            let vectorsDone = 0;
            tellProgressListeners({ bookName, kind: VECTORS, done: 0, total: vectorsToWrite.length });
            const result = await writeBookVectors(bookName, decidedEntries, vectorsToWrite, settings, {
                run,
                onEntryDone: (_entry, failure) => {
                    vectorsDone += 1;
                    tellProgressListeners({ bookName, kind: VECTORS, done: vectorsDone, total: vectorsToWrite.length });
                    advance(failure);
                },
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
        tellProgressListeners(null);
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
 * not its keys. It locks no book.
 * @param {string} bookName
 * @param {object[]} entries - The book's entries, as loadWorldInfo returns them
 * @param {object} settings - VectFox settings
 * @returns {Promise<WritingRunOutcome>}
 * @throws {Error} While LoreBase writes already, these entries' keys included
 */
export async function regenerateKeysOfEntries(bookName, entries, settings) {
    return runOnPanel(settings, { books: [{ bookName, keyEntries: entries }], count: entries.length }, { kinds: [KEYS], isRegenerating: true });
}

/**
 * What Similharity lists of this SillyTavern user's LoreBase keys and vectors (`/lorebase/books`): each book's keys,
 * and every tenant of its vectors in either Qdrant collection. The one read of it: the Database Browser's rows, which
 * books have Remove from LoreBase, what it deletes, and Delete all.
 * @returns {Promise<{keys: Array<{book: string, entryCount: number}>, vectors: Array<{book: string|null, collection: string,
 *   tenant: string, pointCount: number}>}>}
 * @throws {Error} When Similharity cannot list them
 */
function listLoreBaseStorage() {
    return postLoreBaseRoute('books', {}, "list LoreBase's books");
}

/**
 * The named books LoreBase holds anything of (hasLoreBaseHoldings, the rule the Database Browser lists a book by): those
 * whose WorldInfo row gets Remove from LoreBase. Off Qdrant, where Remove is refused, none.
 * @param {string[]} bookNames
 * @param {object} settings - VectFox settings
 * @returns {Promise<Set<string>>}
 * @throws {Error} When Similharity cannot list what LoreBase holds
 */
export async function removableLoreBookNames(bookNames, settings) {
    if (!isLoreBaseBackend(settings)) return new Set();
    const listing = await listLoreBaseStorage();
    const here = loreBaseVectorsCollection(settings);
    return new Set(bookNames.filter(bookName => {
        const { keyCount, tenants } = listedHoldingsOf(listing, bookName);
        return hasLoreBaseHoldings({ hasRecord: getLoreBook(bookName) !== null, keyCount, hereTenantCount: tenants.filter(tenant => tenant.collection === here).length });
    }));
}

/**
 * Delete all (§4.3): every `kinds` Similharity lists for this SillyTavern user (listLoreBaseStorage), in every book and
 * either Qdrant collection, the entries turned off and books with no record included: each tenant of the vectors
 * first, which cost little to write again, by the delete Remove and a row's delete run (deleteTenantPoints), then the
 * keys. Selections stay, so the selected entries send nothing until both are written again. Refused while LoreBase
 * writes, which would put some back, and off Qdrant, as Remove is.
 * @param {readonly string[]} kinds - KEYS, VECTORS or BOTH_KINDS
 * @param {object} settings - VectFox settings
 * @returns {Promise<number>} How many entries' keys were deleted; 0 when keys are not among `kinds`
 * @throws {Error} While LoreBase writes, off Qdrant, or when Similharity cannot list or delete them; a tenant that
 *   would not go stops it before the keys
 */
export async function deleteStored(kinds, settings) {
    refuseWhileWriting();
    const offQdrant = qdrantProblem(settings);
    if (offQdrant) throw new Error(offQdrant);
    if (kinds.includes(VECTORS)) {
        const { vectors } = await listLoreBaseStorage();
        for (const { tenant, collection } of vectors) await deleteTenantPoints(tenant, collection, settings);
        forgetVectorWriteFailures();
        log.lifecycle(`LoreBase: Delete all deleted the vectors of ${vectors.length} tenants`);
    }
    return kinds.includes(KEYS) ? deleteAllKeys() : 0;
}

/**
 * The Database Browser's LoreBase rows (§3.2): this account's books with keys or vectors, from Similharity's listing
 * (listLoreBaseStorage), with every book that has a LoreBase record, the list's first, then the leftovers'; each knows
 * how many selected entries LoreBase decides in its book (decidedCountOf, as every LoreBase page counts them; a book
 * SillyTavern no longer has keeps its saved count) and whether SillyTavern still has the book (storageRowsOf). Off
 * Qdrant, where LoreBase keeps nothing, there are none.
 * @param {object} settings - VectFox settings
 * @returns {Promise<object[]>}
 * @throws {Error} When Similharity cannot list them
 */
export async function loreBaseStorageRows(settings) {
    if (!isLoreBaseBackend(settings)) return [];
    const listing = await listLoreBaseStorage();
    const recordCounts = loreBookRecordCounts();
    for (const bookName of Object.keys(recordCounts).filter(name => world_names.includes(name))) {
        recordCounts[bookName].selectedCount = await decidedCountOf(bookName);
    }
    return storageRowsOf({ listing, recordCounts, hereCollection: loreBaseVectorsCollection(settings), sillyTavernBookNames: world_names });
}

/**
 * The row the Database Browser's global Import plans a keys or vectors file against (§3.3): the book's own row in the
 * list, or, for a book SillyTavern has that shows none, the row it would have at 0, so the import brings the book back.
 * @param {string} kind - KEYS or VECTORS
 * @param {string} bookName - The book the file names
 * @param {object[]} rows - The rows last read, from loreBaseStorageRows
 * @param {object} settings - VectFox settings
 * @returns {object} A row planImport takes
 * @throws {Error} Off Qdrant, or when SillyTavern has no book of that name
 */
export function loreBaseImportRow(kind, bookName, rows, settings) {
    const problem = qdrantProblem(settings);
    if (problem) throw new Error(problem);
    const listed = rows.find(row => row.kind === kind && row.book === bookName && !row.isLeftover && (kind === KEYS || row.isHere));
    if (listed) return listed;
    if (!world_names.includes(bookName)) {
        throw new Error(`SillyTavern has no lorebook named "${bookName}". Bring the lorebook into SillyTavern first, or use `
            + `Import on the ${kind === KEYS ? 'keys' : 'vectors'} row of the lorebook you want this file in.`);
    }
    const counts = loreBookRecordCounts()[bookName];
    return emptyRowOf(kind, { book: bookName, hasRecord: Boolean(counts), selectedCount: counts?.selectedCount ?? 0, selectionCount: counts?.selectionCount ?? 0 },
        loreBaseVectorsCollection(settings));
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
 * number and title match, selected or not; for vectors, the parts of the entries LoreBase would decide in it now,
 * selected or not, read against what Qdrant holds now. The plan carries what writeImport needs, the book's selected
 * entries LoreBase decides among it.
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
    const decidableEntries = await loadDecidableEntries(row.book);
    const selectedUids = new Set(unionOfSelections(getLoreBook(row.book)).selectedUids);
    const decidedEntries = await loadDecidedEntries(row.book);
    const stored = (await readBookVectors([row.book], settings)).get(row.book);
    const plan = planVectorsImport(fileData, {
        candidates: entriesWithPoints(row.book, decidableEntries), selectedUids, stored, modelKey: currentEmbeddingModelKey(settings),
    });
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

/**
 * What a book holds in LoreBase, for the confirm of Remove from LoreBase and Unlink (removalConfirmLines in
 * lorebase-files-core.js): its selections, how many entries they hold together, their pinned sections, their locks on
 * chats and on characters, how many of its entries have keys, and each collection holding its vectors with their parts,
 * from Similharity's listing. Refused while LoreBase writes and off Qdrant, as the removal is, so no confirm offers what
 * would be refused.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @returns {Promise<{bookName: string, selectionCount: number, selectedCount: number, pinnedCount: number,
 *   chatLockCount: number, characterLockCount: number, keyCount: number,
 *   tenants: Array<{collection: string, tenant: string, pointCount: number}>}>}
 * @throws {Error} While LoreBase writes, off Qdrant, or when Similharity cannot list them
 */
export async function loreBookHoldings(bookName, settings) {
    refuseWhileWriting();
    const offQdrant = qdrantProblem(settings);
    if (offQdrant) throw new Error(offQdrant);
    const { keyCount, tenants } = listedHoldingsOf(await listLoreBaseStorage(), bookName);
    const record = getLoreBook(bookName);
    const selections = record?.selections ?? [];
    return {
        bookName,
        selectionCount: selections.length,
        selectedCount: unionOfSelections(record).selectedUids.length,
        pinnedCount: new Set(selections.flatMap(selection => selection.pinnedSections)).size,
        chatLockCount: selections.reduce((sum, selection) => sum + selection.lockedToChatIds.length, 0),
        characterLockCount: selections.reduce((sum, selection) => sum + selection.lockedToCharacterAvatars.length, 0),
        keyCount,
        tenants: tenants.map(({ collection, tenant, pointCount }) => ({ collection, tenant, pointCount })),
    };
}

/**
 * Remove a book from LoreBase (§3.6 of vectfox-multi-collection-per-chat.md), the one removal the Database Browser's
 * lorebook row and the WorldInfo page's book row both run, its Remove and its Unlink, through
 * removeLoreBookAfterConfirm: its vectors in every collection holding them, the cheapest to write again, then its keys,
 * those edited by hand included, then its record, with every selection's selected entries, pinned sections and locks,
 * so a delete that fails leaves the book listed with what it still holds. What this session knew of its keys and
 * vectors goes with them. The lorebook stays in SillyTavern.
 * @param {string} bookName
 * @param {object} settings - VectFox settings
 * @returns {Promise<{bookName: string, keysDeleted: number, partsDeleted: number}>}
 * @throws {Error} While LoreBase writes, off Qdrant, or when Similharity cannot list or delete them
 */
export async function removeLoreBook(bookName, settings) {
    const { tenants } = await loreBookHoldings(bookName, settings);
    for (const { tenant, collection } of tenants) await deleteTenantPoints(tenant, collection, settings);
    const keysDeleted = await deleteBookKeys([bookName]);
    forgetBookVectors(bookName);
    deleteLoreBookRecord(bookName);
    const partsDeleted = tenants.reduce((sum, tenant) => sum + tenant.pointCount, 0);
    log.lifecycle(`LoreBase: removed lorebook "${bookName}", with the keys of ${keysDeleted} entries and the vectors of ${partsDeleted} parts`);
    return { bookName, keysDeleted, partsDeleted };
}
