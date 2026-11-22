// features/lorebase — LoreBase (InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md and
// lorebook-multi-vector.md): for the lorebook entries the user selects, a model picks the ones the next reply needs. On
// Fast and Cheap [Jev], the default, Jev rates each entry, above 100 entries only a search's 100 best, and its picks go
// whole within the lore budget; on High Accuracy GPT-6 Luna picks, then keeps only the parts of each the moment needs.
// VectFox's generation interceptor asks it for each reply's lore beside its retrieval: the books taking part, the scene
// read from the stored chat, the search, the pick and the reviews as the trials asked them, and a toast for lore a
// failed call left out. The picks are held for SillyTavern's World Info scan, whose copy of the books LoreBase arms so
// that a selected entry goes in only when picked, with the parts its review kept. All of
// it waits for LoreBase's switch on the WorldInfo page, off by default, and never runs beside the World Info search of
// SillyTavern's Vector Storage: turning LoreBase on, or a reply that finds that search on again, asks the user which of
// the two to keep. A book holds one or more selections of its entries, a chat using one of them, the one locked to it or
// its character. The selection screen is where the user chooses a selection's entries, locks it to the chat or
// character, pins section names, and makes, renames and deletes selections; the WorldInfo page lists the open chat's
// books with the selection each uses here, which its switcher changes or makes anew, and their locks,
// adds a book the chat does not load through SillyTavern's own lists, locked where it was added (Add a lorebook),
// and opens the screen, and writes the keys, the vectors or both of every selected entry, or deletes them all, through
// LoreBase's storage module, which every page that counts, writes or deletes them calls; the Database Browser lists
// each book's keys and vectors as rows through it too, what LoreBase cannot use here among its leftovers, and exports,
// imports and deletes them a row at a time, a file its global Import takes going to the book the file names; Remove from
// LoreBase, on a lorebook's row there and on the WorldInfo page's book row, deletes all LoreBase holds of a book, its
// record of selections, pins and locks included, after the one confirm both pages share; its Chunk
// Visualizer shows a book's vectors read only, and its Edit entry opens LoreBase's entry editor, whose Save writes the
// entry's title and text into the lorebook through SillyTavern, then its vectors. Each
// selected entry's vectors, one point per part, live in Qdrant, every book of an account a tenant of one collection,
// and an entry takes part once it has its keys and vectors. The tester keeps this session's reports of each reply, the
// search, what was picked and why, what each review kept and left out, the tokens against what SillyTavern's keys would
// send, and the seconds, for the WorldInfo page's tester card. The folder also holds the entry splitter, which cuts the parts the
// review numbers; the per-book record of selections, pins, locks and seen entries, whose locks on chats and characters
// that no longer exist the Action page's Clean up locks removes; LoreBase's model connection, whose
// Test connection the WorldInfo page runs; the first thing LoreBase's setup lacks, which the page's model card names;
// and the start-up deletion of the old vectorized lorebook collections
// LoreBase replaced, whose locks move to their books, with a notice naming the books. Each armed scan keeps the picks
// its blocks carry, so the reply lore list (features/reply-lore) tells LoreBase's picks from SillyTavern's own entries.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { cleanUpLoreBookLocks, onLoreBookChatLocksMoved, selectedLoreBookNames } from './lorebase-books.js';
export { addLoreBookToChat, booksToAdd, chatBookLocks, newLoreSelectionHere, useLoreSelectionHere } from './lorebase-chat-books.js';
export { loreBasePicksCarriedBy } from './lorebase-delivery.js';
export { editLoreBookEntry } from './lorebase-entry-editor.js';
export { testLoreBaseConnection } from './lorebase-connection.js';
export { loreBaseSetupProblem, writingProblem } from './lorebase-setup.js';
export { JEV_PROFILE_SETTING, resolveJevConnection, testJevConnection } from './lorebase-jev.js';
export { KEY_CALLS_AT_ONCE_DEFAULT, keyCallsAtOnceOf } from './lorebase-keys-core.js';
export { deleteOldLorebookCollections } from './lorebase-old-collections.js';
export { LORE_BUDGET_DEFAULT, loreBudgetOf } from './lorebase-jev-core.js';
export { initializeLoreBase, prepareLoreBesideRetrieval, tryLoreBasePick } from './lorebase-reply.js';
export { FAST_AND_CHEAP, isReplyGeneration, loreBaseAccuracyOf } from './lorebase-reply-core.js';
export { openLoreBaseSelection } from './lorebase-selection-screen.js';
export {
    LOREBASE_KEYS_FILE_TYPE, LOREBASE_VECTORS_FILE_TYPE, describeDelete, describeExport, describeImport, describeImported, modelWords,
    describeRemovedLoreBook, nothingToImportText,
} from './lorebase-files-core.js';
export { deleteLoreSelectionAfterConfirm, removeLoreBookAfterConfirm } from './lorebase-removal.js';
export {
    deleteStored, deleteStoredRow, exportStored, loreBaseImportRow, loreBaseStorageRows, onWritingProgress, onWritingRunChange, planImport,
    removableLoreBookNames, storedCountsOfBooks, writeImport, writeMissing,
} from './lorebase-storage.js';
export { currentEmbeddingModel, tenantChunkSource } from './lorebase-vectors.js';
export { BOTH_KINDS, KEYS, VECTORS, kindsLacking } from './lorebase-storage-core.js';
export { entryTitle } from './lorebase-splitter.js';
export { isLoreBaseSwitchedOn, onLoreBaseSwitchChange, turnLoreBaseOff } from './lorebase-switch.js';
export { loreBaseReports, measureLoreBaseReport, onLoreBaseReportsChange } from './lorebase-tester.js';
export { turnLoreBaseOn } from './lorebase-vector-storage.js';
