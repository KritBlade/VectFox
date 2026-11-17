// features/reply-lore — the lore of the latest reply, for the wand menu's Selected lorebook: the lorebook entries
// SillyTavern's World Info scan put in the reply's prompt, by book, LoreBase's picks in blue and SillyTavern's own
// entries in green, kept in page memory only.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { initializeReplyLore, openReplyLore } from './reply-lore.js';
