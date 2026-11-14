// features/lorebase — LoreBase (InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): for the
// lorebook entries the user selects, GPT-6 Luna picks the ones the next reply needs and keeps only the parts of each
// the moment needs. This folder holds the entry splitter, which cuts the parts the review numbers; the per-book record
// of selections, pins and locks; the scene both calls read from the stored chat; and the pick and the review's
// prompts, as the route trials asked them, with the reading of their answers. The calls each turn (B6), the selection
// screen (B5) and delivery (B7) build on them. Until B5 imports it from the app, knip reads this file as an entry
// (knip.jsonc).
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { getLoreBook, isLoreBookLocked, setLoreBookLock, setLoreBookPins, setLoreBookSelection } from './lorebase-books.js';
export { pickMessages, readPicks, tableOfContents } from './lorebase-pick-core.js';
export { partsToSend, readReview, reviewMessages } from './lorebase-review-core.js';
export { sceneText } from './lorebase-scene-core.js';
export { sceneMessagesFromChat } from './lorebase-scene.js';
export { entryCategory, entryPassages, entryTitle, estimatedTokens } from './lorebase-splitter.js';
