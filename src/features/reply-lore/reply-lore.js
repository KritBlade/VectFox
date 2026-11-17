/**
 * The lore of the latest reply, for the wand menu's Selected lorebook: the lorebook entries SillyTavern's World
 * Info scan put in the reply's prompt, LoreBase's picks told from SillyTavern's own entries (reply-lore-core.js). Only a
 * reply's scan counts, by LoreBase's rule for a reply (isReplyGeneration): a normal send, a swipe, a regenerate, a
 * continue, or a quiet-to-loud generation, never a quiet or dry one, so another extension's background generation
 * leaves the list alone. SillyTavern says nothing of a scan that activated no entry, so a reply starts with an
 * empty list. The list lives in page memory only: a reload or a chat change clears it.
 */
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { noticePopup } from '../../sillytavern/popup.js';
import { entryTitle, isReplyGeneration, loreBasePicksCarriedBy } from '../lorebase/index.js';
import { replyLoreBooks } from './reply-lore-core.js';
import { replyLoreLines, replyLoreMarkup } from './reply-lore-markup.js';

// The latest reply's books, or null before one in this chat.
let latestBooks = null;
// Whether the next World Info scan is a reply's: from its generation's start until the scan or its end.
let isReplyScanDue = false;

function noteReplyLore(activatedEntries) {
    if (!isReplyScanDue) return;
    isReplyScanDue = false;
    try {
        latestBooks = replyLoreBooks(activatedEntries, loreBasePicksCarriedBy, entryTitle);
    } catch (error) {
        log.warn('VectFox: the lorebook entries of the latest reply could not be listed:', error);
    }
}

/** Follow each reply's World Info scan, from the start. */
export function initializeReplyLore() {
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, options, isDryRun) => {
        if (isDryRun) return;
        isReplyScanDue = isReplyGeneration(type, { type, isQuietToLoud: Boolean(options?.quietToLoud) });
        if (isReplyScanDue) latestBooks = [];
    });
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, noteReplyLore);
    const endReplyScan = () => { isReplyScanDue = false; };
    eventSource.on(event_types.GENERATION_ENDED, endReplyScan);
    eventSource.on(event_types.GENERATION_STOPPED, endReplyScan);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        latestBooks = null;
        isReplyScanDue = false;
    });
}

/** Show the latest reply's lorebook entries in a dialog: LoreBase's picks in blue, SillyTavern's own in green. */
export async function openReplyLore() {
    let body = null;
    if (latestBooks?.length) {
        body = document.createElement('div');
        body.innerHTML = replyLoreMarkup(latestBooks);
    }
    await noticePopup(replyLoreLines(latestBooks), { body });
}
