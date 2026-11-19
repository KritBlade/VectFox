// features/lorebase — LoreBase (InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): for the
// lorebook entries the user selects, GPT-6 Luna picks the ones the next reply needs and keeps only the parts of each
// the moment needs. VectFox's generation interceptor asks it for each reply's lore beside its retrieval: the books
// taking part, the scene read from the stored chat, the pick and one review per pick as the route trials asked them,
// and a toast for lore a failed call left out. The picks are held for SillyTavern's World Info scan, whose copy of the
// books LoreBase arms so that a selected entry goes in only when Luna picks it, with the parts its review kept. All of
// it waits for LoreBase's switch on the WorldInfo page, off by default, and never runs beside the World Info search of
// SillyTavern's Vector Storage: turning LoreBase on, or a reply that finds that search on again, asks the user which of
// the two to keep. The selection screen is where the user chooses a book's entries, locks the book to the chat or
// character, and pins section names; the WorldInfo page lists the open chat's books with their selections and locks,
// and opens the screen, and writes the keys, the vectors or both of every selected entry, or deletes them all, through
// LoreBase's storage module, which every page that counts, writes or deletes them calls. Each selected entry's vectors,
// one point per part, live in Qdrant, every book of an account a tenant of one collection, and an entry takes part once
// it has its keys and vectors. The tester keeps this session's reports of each reply, what Luna picked and why, what
// each review kept and left out, the tokens against what SillyTavern's keys would send, and the seconds, for the
// WorldInfo page's tester card. The folder also holds the entry splitter, which cuts the parts the review numbers; the
// per-book record of selections, pins, locks and seen entries; LoreBase's model connection, whose Test connection the
// WorldInfo page runs; and the start-up deletion of the old vectorized lorebook collections LoreBase replaced, whose
// locks move to their books, with a notice naming the books. Each armed scan keeps the picks its blocks carry, so the
// reply lore list (features/reply-lore) tells LoreBase's picks from SillyTavern's own entries.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { selectedLoreBookNames } from './lorebase-books.js';
export { chatBookLocks } from './lorebase-chat-books.js';
export { loreBasePicksCarriedBy } from './lorebase-delivery.js';
export { testLoreBaseConnection } from './lorebase-connection.js';
export { JEV_PROFILE_SETTING, resolveJevConnection, testJevConnection } from './lorebase-jev.js';
export { KEY_CALLS_AT_ONCE_DEFAULT, keyCallsAtOnceOf } from './lorebase-keys-core.js';
export { deleteOldLorebookCollections } from './lorebase-old-collections.js';
export { initializeLoreBase, prepareLoreBesideRetrieval, tryLoreBasePick } from './lorebase-reply.js';
export { FAST_AND_CHEAP, isReplyGeneration, loreBaseAccuracyOf } from './lorebase-reply-core.js';
export { openLoreBaseSelection } from './lorebase-selection-screen.js';
export { deleteStored, onWritingRunChange, storedCountsOfBooks, writeMissing, writingProblem } from './lorebase-storage.js';
export { BOTH_KINDS, KEYS, VECTORS } from './lorebase-storage-core.js';
export { entryTitle } from './lorebase-splitter.js';
export { isLoreBaseSwitchedOn, onLoreBaseSwitchChange, turnLoreBaseOff } from './lorebase-switch.js';
export { loreBaseReports, measureLoreBaseReport, onLoreBaseReportsChange } from './lorebase-tester.js';
export { turnLoreBaseOn } from './lorebase-vector-storage.js';
