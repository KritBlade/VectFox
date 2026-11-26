// features/entity-lore — Entity-Lore (InternalProject/Vectfox/plans/entity-lore.md): a lorebook entry for each named
// character StoryArc counts often, written by LoreBase's model from the character's stored events into the chat's own
// book, which LoreBase's Add to this chat adds to that chat alone, and written again, whole, as their story grows.
// src/index.js tells it of each EventBase run that ends (onEventBaseRunEnded), after which it writes at most 5 entries.
// The WorldInfo page's Entity-Lore card turns it on, sets its two counts, runs it now (runEntityLoreNow), and lists the
// open chat's characters (readEntityLoreCharacters), each row drawn here (entity-lore-ui.js) with its state and the
// buttons that state offers: one entry written now (writeEntityLoreEntryNow), Allow again (allowEntityLoreAgain). It
// runs while its switch, StoryArc mode and LoreBase are on (entityLoreBlocker), and imports EventBase and LoreBase
// through their barrels, neither of which imports it.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    allowEntityLoreAgain, entityLoreBlocker, lastEntityLoreRun, onEntityLoreRunEnded, onEventBaseRunEnded, readEntityLoreCharacters,
    runEntityLoreNow, writeEntityLoreEntryNow,
} from './entity-lore.js';
export {
    ENTITY_LORE_FIX_AT, ENTITY_LORE_SETTING, REWRITE_EVERY_EVENTS, WRITE_AT_EVENTS, isEntityLoreOn, rewriteEveryEventsOf, writeAtEventsOf,
} from './entity-lore-core.js';
export {
    ENTITY_LORE_ACTION, entityLoreBookLine, entityLoreLastRunText, entityLoreListMarkup, entityLoreNoticeMarkup, entityLoreProblemMarkup,
    isSwitchGatedBy,
} from './entity-lore-ui.js';
