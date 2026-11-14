// features/lorebase — LoreBase (InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): for the
// lorebook entries the user selects, GPT-6 Luna picks the ones the next reply needs and keeps only the parts of each
// the moment needs. This folder holds the entry splitter, which cuts the parts the review numbers, and the per-book
// record of selections, pins and locks; the selection screen (B5), the pick and review (B6) and delivery (B7) build on
// them. Until B5 imports it from the app, knip reads this file as an entry (knip.jsonc).
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSelection } from './lorebase-books.js';
export { entryCategory, entryPassages, entryTitle, estimatedTokens } from './lorebase-splitter.js';
