/**
 * LoreBase's delivery through SillyTavern's World Info scan, the pure rules (plan §5.7 and D14 of InternalProject/
 * Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): what each picked entry sends, and how a scan is armed with
 * it. In the scan's copy of the books, every entry LoreBase decides loses its keys, so SillyTavern's keyword step skips
 * it, and the picks go in as one <VectLorebook> block for each place in the prompt they take, so the prompt shows what
 * LoreBase sent: each pick inside a tag of its own, and the block force-activated as its most needed pick, which
 * SillyTavern loaded, so it goes where that entry goes. The book file is never changed. Pure: no SillyTavern, no
 * network.
 */
import { withoutDecoratorLines } from './lorebase-decorators-core.js';
import { isDecidedEntry } from './lorebase-reply-core.js';

/** The tag LoreBase's block of picks goes inside, in the prompt. */
export const LOREBOOK_TAG = 'VectLorebook';

/** The lists of the books a scan loads, as SillyTavern's WORLDINFO_ENTRIES_LOADED carries them. */
const SCAN_LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
// SillyTavern's World Info positions that take more than the position to place an entry: at a depth, by its depth and
// role, and an outlet, by its name.
const AT_DEPTH_POSITION = 4;
const OUTLET_POSITION = 7;

/**
 * How SillyTavern's scan names an entry, in its forced activations and in what it activated.
 * @param {string} bookName
 * @param {number|string} uid
 * @returns {string}
 */
export function scanKey(bookName, uid) {
    return `${bookName}.${uid}`;
}

/**
 * What each picked entry sends, keyed by scanKey, most needed first (§5.6): the whole entry, as the scan loads it, when
 * its review kept every part, as it always does for an entry with template code (D9); otherwise the parts it kept, in
 * the entry's order, one to a line, inside the entry's wrapper tags when it has them. Each keeps its title and whether
 * it has wrapper tags, for its place in the block, and Jev's chance of yes, for the reply lore list. A pick whose review
 * kept no part sends nothing, so it has no delivery.
 * @param {Array<{bookName: string, uid: number, title: string, frame: {open: string, close: string}|null,
 *   passages: Array<{text: string}>, sentParts: number[], jevChance?: number}>} reviewedPicks - From loreForReply, or
 *   loreForReplyByJev, whose picks alone carry Jev's chance
 * @returns {Map<string, {isWhole: boolean, text: string, title: string, hasFrame: boolean, jevChance: number|null}>}
 */
export function scanDeliveries(reviewedPicks) {
    const deliveries = new Map();
    for (const { bookName, uid, title, frame, passages, sentParts, jevChance = null } of reviewedPicks) {
        if (!sentParts.length) continue;
        const hasFrame = Boolean(frame);
        if (sentParts.length === passages.length) {
            deliveries.set(scanKey(bookName, uid), { isWhole: true, text: '', title, hasFrame, jevChance });
            continue;
        }
        const kept = sentParts.map(number => passages[number - 1].text);
        deliveries.set(scanKey(bookName, uid), {
            isWhole: false, text: (frame ? [frame.open, ...kept, frame.close] : kept).join('\n'), title, hasFrame, jevChance,
        });
    }
    return deliveries;
}

/** Where SillyTavern puts an entry in the prompt: its position, with the depth and role, or outlet, that position reads. */
function placementOf(entry) {
    const isAtDepth = entry.position === AT_DEPTH_POSITION;
    return JSON.stringify([
        entry.position ?? null,
        isAtDepth ? entry.depth ?? null : null,
        isAtDepth ? entry.role ?? null : null,
        entry.position === OUTLET_POSITION ? entry.outletName ?? null : null,
    ]);
}

/**
 * A pick's tag in its block: the words of its title joined by underscores, as Lighthouse_of_Vell, with no apostrophe,
 * so the tag that opens it also closes it; entry_ and the uid when the title has no word, entry_ before a name that
 * starts with a digit, and a number after a name the block already holds.
 * @param {string} title
 * @param {number|string} uid
 * @param {Set<string>} taken - The names the block holds so far; the new one is added
 * @returns {string}
 */
function pickTagName(title, uid, taken) {
    const words = String(title ?? '').replace(/['’]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
    const joined = words.join('_');
    const name = !joined ? `entry_${uid}` : /^\p{N}/u.test(joined) ? `entry_${joined}` : joined;
    let unique = name;
    for (let count = 2; taken.has(unique); count += 1) unique = `${name}_${count}`;
    taken.add(unique);
    return unique;
}

/**
 * A block's text: the LOREBOOK_TAG around the picks, most needed first, each inside a tag named by its title, or
 * inside its own wrapper tags when it has them.
 * @param {Array<{text: string, title: string, uid: number|string, hasFrame: boolean}>} picks
 * @returns {string}
 */
function lorebookBlock(picks) {
    const taken = new Set();
    const lines = picks.map(({ text, title, uid, hasFrame }) => {
        if (hasFrame) return text;
        const tag = pickTagName(title, uid, taken);
        return `<${tag}>\n${text}\n</${tag}>`;
    });
    return [`<${LOREBOOK_TAG}>`, ...lines, `</${LOREBOOK_TAG}>`].join('\n');
}

/**
 * Arm one scan: blank the keys of every entry LoreBase decides in it, and return the forced activations of the picks
 * it holds. Keys are blanked by giving the entry a new empty list, as the scan's entries share their key lists with
 * SillyTavern's cached book. The picks go in as one block for each place in the prompt they take (lorebookBlock),
 * most needed first: a block is its most needed pick as the scan loaded it, its own keys, position, depth, role and
 * order kept, so it goes where that entry goes, with the block as its content, and no inclusion group or chance, so
 * the block goes in whole (§5.7). A delivery whose entry the scan does not hold, or no longer decides, is not sent.
 * @param {{[list: string]: object[]}} loaded - WORLDINFO_ENTRIES_LOADED's data; its entries are changed in place
 * @param {object} lore
 * @param {(bookName: string) => Set<string>|null} lore.selectedUidsOf - A book's selected uids where it takes part in
 *   this scan (D11), or null where LoreBase decides none of its entries
 * @param {Map<string, {isWhole: boolean, text: string, title: string, hasFrame: boolean, jevChance?: number|null}>|null}
 *   lore.deliveries - From scanDeliveries, for this scan's reply, or null for a scan that is not one
 * @returns {{forced: object[], sentCount: number, blocks: Array<{key: string, picks: Array<{bookName: string,
 *   uid: number|string, title: string, isWhole: boolean, jevChance: number|null}>}>}} The blocks' forced activations, for
 *   WORLDINFO_FORCE_ACTIVATE; how many picks they carry; and each block's picks, most needed first, by the scan key of
 *   the entry that carries it, for the reply lore list
 */
export function armScan(loaded, { selectedUidsOf, deliveries }) {
    const sent = new Map();
    for (const list of SCAN_LISTS) {
        for (const entry of loaded[list] ?? []) {
            const selectedUids = selectedUidsOf(entry.world);
            if (!selectedUids || !isDecidedEntry(entry, selectedUids)) continue;
            const key = scanKey(entry.world, entry.uid);
            const delivery = deliveries?.get(key);
            // Copied before its keys are blanked, so the block keeps the entry as the scan loaded it.
            if (delivery) sent.set(key, { entry: { ...entry }, delivery });
            entry.key = [];
        }
    }
    const blocks = new Map();
    for (const key of deliveries?.keys() ?? []) {
        const pick = sent.get(key);
        if (!pick) continue;
        const placement = placementOf(pick.entry);
        if (!blocks.has(placement)) blocks.set(placement, []);
        blocks.get(placement).push(pick);
    }
    const forced = [...blocks.values()].map(picks => ({
        ...picks[0].entry,
        content: lorebookBlock(picks.map(({ entry, delivery }) => ({
            text: withoutDecoratorLines(delivery.isWhole ? entry.content : delivery.text), title: delivery.title, uid: entry.uid, hasFrame: delivery.hasFrame,
        }))),
        group: '',
        useProbability: false,
    }));
    const carried = [...blocks.values()].map(picks => ({
        key: scanKey(picks[0].entry.world, picks[0].entry.uid),
        picks: picks.map(({ entry, delivery }) => ({
            bookName: entry.world, uid: entry.uid, title: delivery.title, isWhole: delivery.isWhole, jevChance: delivery.jevChance ?? null,
        })),
    }));
    return { forced, sentCount: sent.size, blocks: carried };
}
