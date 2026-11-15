// features/lorebase — LoreBase (InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): for the
// lorebook entries the user selects, GPT-6 Luna picks the ones the next reply needs and keeps only the parts of each
// the moment needs. VectFox's generation interceptor asks it for each reply's lore: the books taking part, the scene
// read from the stored chat, the pick and one review per pick as the route trials asked them, and a toast for lore a
// failed call left out. The folder also holds the entry splitter, which cuts the parts the review numbers; the
// per-book record of selections, pins and locks; and LoreBase's model connection, whose Test connection the WorldInfo
// page runs. The selection screen (B5) and delivery (B7) build on them. Until B5 imports the rest from the app, knip
// reads this file as an entry (knip.jsonc).
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSelection } from './lorebase-books.js';
export { testLoreBaseConnection } from './lorebase-connection.js';
export { initializeLoreBase, prepareLoreForReply } from './lorebase-reply.js';
export { entryCategory, entryPassages, entryTitle, estimatedTokens } from './lorebase-splitter.js';
