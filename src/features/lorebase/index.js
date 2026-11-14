// features/lorebase — LoreBase, the lorebook passage index (InternalProject/Vectfox/plans/
// lorebook-semantic-overhaul-passage-index.md): each picked entry cut into passages at the author's markers, one
// index per book kept in step with the book by a diff, the picks and locks kept per book, and one pooled hybrid
// search per turn. Its review screen (B5) and its two jobs, Activate (B6) and Trim (B7), are built on it; until B5
// imports it from the app, knip reads this file as an entry (knip.jsonc).
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { ACTIVATION, getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPicks } from './lorebase-books.js';
export { searchLoreBooks } from './lorebase-search.js';
export { entryCategory, entryPassages, entryTitle, estimatedTokens } from './lorebase-splitter.js';
export { MODEL_CHANGED, syncLoreBook } from './lorebase-sync.js';
