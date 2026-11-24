/**
 * The lore of the latest reply, for the wand menu's Last reply's lore: the lorebook entries SillyTavern's World Info
 * scan put in the reply's prompt, LoreBase's picks told from SillyTavern's own entries (reply-lore-core.js), each of
 * SillyTavern's with what fired it, read from the scan as it runs (world-info-activations.js). Only a reply's scan
 * counts, by LoreBase's rule for a reply (isReplyGeneration): a normal send, a swipe, a regenerate, a continue, or a
 * quiet-to-loud generation, never a quiet or dry one, so another extension's background generation leaves the list
 * alone. SillyTavern says nothing of a scan that activated no entry, so a reply starts with an empty list. The list
 * lives in page memory only: a reload or a chat change clears it.
 */
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { noticePopup } from '../../sillytavern/popup.js';
import { activationOf, startReadingActivations, stopReadingActivations } from '../../sillytavern/world-info-activations.js';
import { generationPastCommands } from '../../shared/last-generation-core.js';
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
        latestBooks = replyLoreBooks(activatedEntries, loreBasePicksCarriedBy, entryTitle, activationOf);
    } catch (error) {
        log.warn('VectFox: the lorebook entries of the latest reply could not be listed:', error);
    } finally {
        stopReadingActivations();
    }
}

function endReplyScan() {
    isReplyScanDue = false;
    stopReadingActivations();
}

/** Follow each reply's World Info scan, from the start. */
export function initializeReplyLore() {
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, options, isDryRun) => {
        if (isDryRun) return;
        isReplyScanDue = isReplyGeneration(type, generationPastCommands(type, options));
        if (!isReplyScanDue) {
            stopReadingActivations();
            return;
        }
        latestBooks = [];
        startReadingActivations();
    });
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, noteReplyLore);
    eventSource.on(event_types.GENERATION_ENDED, endReplyScan);
    eventSource.on(event_types.GENERATION_STOPPED, endReplyScan);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        latestBooks = null;
        endReplyScan();
    });
}

/**
 * Show the latest reply's lorebook entries in a dialog: LoreBase's picks in blue, SillyTavern's own in green, each with
 * what brought it in, as far as it is known.
 */
export async function openReplyLore() {
    let body = null;
    if (latestBooks?.length) {
        body = document.createElement('div');
        body.innerHTML = replyLoreMarkup(latestBooks);
    }
    await noticePopup(replyLoreLines(latestBooks), { body });
}
