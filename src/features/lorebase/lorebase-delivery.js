/**
 * LoreBase's delivery through SillyTavern's World Info scan (plan §5.7, §6.6 and §6.8 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). The generation interceptor holds a reply's picks for the scan that
 * follows it; at WORLDINFO_ENTRIES_LOADED, before SillyTavern scans, every entry LoreBase decides loses its keys in
 * the scan's copy, and the held picks are force-activated, so a selected entry goes in only when Luna picks it (D14).
 * A scan with nothing held, such as a quiet generation's or a dry run's, sends no selected entry. While LoreBase does
 * not act (lorebase-switch.js), every scan is left to SillyTavern.
 *
 * SillyTavern gives a scan no identity, so the picks go to the next scan in the same chat, whichever it is (§6.8).
 * The listener runs after every other one, so it reads the books as other extensions leave them, such as
 * ST-Prompt-Template, which drops, disables or renders entries at the same event: it is made SillyTavern's last once
 * the app is ready, and again each time the interceptor holds, as a listener added later, such as a TavernHelper
 * script's when its chat loads, would otherwise run after it and could give a selected entry its keys back.
 *
 * The tester (§5.10) scans as SillyTavern alone, dry, to learn what SillyTavern's keys would send: that scan is left
 * alone, and what is held stays held. It runs only while no generation's scan is due, from an interceptor run to the
 * scan that follows it, and counts only when no interceptor ran meanwhile; any scan after one is armed as ever.
 */
import { getCurrentChatId } from '../../sillytavern/chat.js';
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { getLoreBook, isLoreBookLocked } from './lorebase-books.js';
import { lockTarget } from './lorebase-chat-books.js';
import { armScan, scanDeliveries } from './lorebase-delivery-core.js';
import { isLoreBaseActive } from './lorebase-switch.js';

// The picks of the last reply's interceptor, until a scan takes them: {chatId, deliveries}, or null.
let heldLore = null;
// Whether scans are armed: from the moment the app is ready, when the listener is first made the last.
let isArmingScans = false;
// Interceptor runs so far: each holds a reply's picks or none, and a World Info scan follows it.
let holdCount = 0;
// Whether an interceptor has held since the last scan, so a generation's scan is due.
let isScanDue = false;
// While the tester scans as SillyTavern alone: the hold count when it began; null otherwise.
let scanAloneAtHold = null;

/** Make the scan listener SillyTavern's last, after every listener added before now. */
function makeScanListenerLast() {
    eventSource.makeLast(event_types.WORLDINFO_ENTRIES_LOADED, armLoadedScan);
}

/**
 * Hold a reply's picks for the scan that follows, or hold none. Each interceptor run replaces what the last one held,
 * and makes the scan listener the last again, after any listener added since.
 * @param {{reviewedPicks: object[]}|null} lore - From loreForReply, or null for a generation that gets no pick
 */
export function holdLoreForNextScan(lore) {
    const deliveries = lore ? scanDeliveries(lore.reviewedPicks) : null;
    heldLore = deliveries?.size ? { chatId: getCurrentChatId() ?? null, deliveries } : null;
    holdCount += 1;
    isScanDue = true;
    if (isArmingScans) makeScanListenerLast();
}

/**
 * Run the tester's dry scan as SillyTavern alone: LoreBase leaves it unarmed, so every entry fires by its keys. Not
 * while a generation's scan is due, so that scan is never left unarmed.
 * @template T
 * @param {() => Promise<T>} scan - Runs the scan
 * @returns {Promise<T|null>} The scan's result, or null when it did not run alone: a generation's scan was due, or an
 *   interceptor ran during it, after which its scan may have been armed
 */
export async function scanLeftToSillyTavern(scan) {
    if (isScanDue || scanAloneAtHold !== null) return null;
    const startedAtHold = holdCount;
    scanAloneAtHold = startedAtHold;
    try {
        const result = await scan();
        return holdCount === startedAtHold ? result : null;
    } finally {
        scanAloneAtHold = null;
    }
}

/** Each book's selected uids where it takes part in this scan: locked to the chat or its character (D11). */
function takingPartLookup() {
    const where = lockTarget();
    const lookups = new Map();
    return bookName => {
        if (!lookups.has(bookName)) {
            const record = getLoreBook(bookName);
            const isTakingPart = Boolean(record?.selectedUids.length) && isLoreBookLocked(bookName, where);
            lookups.set(bookName, isTakingPart ? new Set(record.selectedUids) : null);
        }
        return lookups.get(bookName);
    };
}

/** Arm the scan that fired WORLDINFO_ENTRIES_LOADED, taking the picks held for it. */
async function armLoadedScan(loaded) {
    // The tester's scan as SillyTavern alone, with no interceptor run since it began: left as SillyTavern loaded it.
    if (scanAloneAtHold !== null && scanAloneAtHold === holdCount) return;
    isScanDue = false;
    const held = heldLore;
    heldLore = null;
    if (!isLoreBaseActive()) return;
    // A chat changed since the picks were made loads another chat's books: the picks are not for it.
    const deliveries = held && held.chatId === (getCurrentChatId() ?? null) ? held.deliveries : null;
    let forced;
    try {
        forced = armScan(loaded, { selectedUidsOf: takingPartLookup(), deliveries });
    } catch (error) {
        log.error('LoreBase: arming the World Info scan failed, so this scan may send entries selected for LoreBase by their keys:', error);
        return;
    }
    if (deliveries && forced.length < deliveries.size) {
        log.verbose(`LoreBase: ${deliveries.size - forced.length} of ${deliveries.size} picks are not in this scan's books, so they are not sent`);
    }
    if (!forced.length) return;
    await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, forced);
    log.verbose(`LoreBase: ${forced.length} picked entries go to this scan`);
}

/** Arm every World Info scan from now on, after the listeners SillyTavern's extensions added as they loaded. */
export function initializeLoreBaseDelivery() {
    eventSource.once(event_types.APP_READY, () => {
        isArmingScans = true;
        makeScanListenerLast();
    });
}
