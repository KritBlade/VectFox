// features/lorebase — LoreBase (InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): for the
// lorebook entries the user selects, GPT-6 Luna picks the ones the next reply needs and keeps only the parts of each
// the moment needs. VectFox's generation interceptor asks it for each reply's lore: the books taking part, the scene
// read from the stored chat, the pick and one review per pick as the route trials asked them, and a toast for lore a
// failed call left out. The selection screen is where the user chooses a book's entries, locks the book to the chat
// or character, and pins section names. The folder also holds the entry splitter, which cuts the parts the review
// numbers; the per-book record of selections, pins, locks and seen entries; and LoreBase's model connection, whose
// Test connection the WorldInfo page runs. Delivery (B7) builds on them. Until the WorldInfo page imports the rest,
// knip reads this file as an entry (knip.jsonc).
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSelection } from './lorebase-books.js';
export { testLoreBaseConnection } from './lorebase-connection.js';
export { initializeLoreBase, prepareLoreForReply } from './lorebase-reply.js';
export { openLoreBaseSelection } from './lorebase-selection-screen.js';
export { entryCategory, entryPassages, entryTitle, estimatedTokens } from './lorebase-splitter.js';
