// features/entity-lore — Entity-Lore (InternalProject/Vectfox/plans/entity-lore.md): a lorebook entry for each named
// character StoryArc counts often, written by LoreBase's model from the character's stored events into the chat's own
// book, which LoreBase's Add to this chat adds to that chat alone, and written again, whole, as their story grows.
// src/index.js tells it of each EventBase run that ends (onEventBaseRunEnded), after which it writes at most 5 entries;
// the WorldInfo page's Entity-Lore tab runs it now (runEntityLoreNow). It runs while its switch, StoryArc mode and
// LoreBase are on, and imports EventBase and LoreBase through their barrels, neither of which imports it.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { onEventBaseRunEnded, runEntityLoreNow } from './entity-lore.js';
export { ENTITY_LORE_SETTING, REWRITE_EVERY_EVENTS, WRITE_AT_EVENTS } from './entity-lore-core.js';
