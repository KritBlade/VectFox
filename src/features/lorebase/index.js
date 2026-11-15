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
// and opens the screen. The folder also holds the entry splitter, which cuts the parts the review numbers; the
// per-book record of selections, pins, locks and seen entries; and LoreBase's model connection, whose Test connection
// the WorldInfo page runs.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { chatBookLocks } from './lorebase-chat-books.js';
export { testLoreBaseConnection } from './lorebase-connection.js';
export { initializeLoreBase, prepareLoreBesideRetrieval } from './lorebase-reply.js';
export { openLoreBaseSelection } from './lorebase-selection-screen.js';
export { isLoreBaseSwitchedOn, onLoreBaseSwitchChange, turnLoreBaseOff } from './lorebase-switch.js';
export { turnLoreBaseOn } from './lorebase-vector-storage.js';
