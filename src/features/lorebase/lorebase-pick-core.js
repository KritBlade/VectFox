/**
 * LoreBase's pick (plan §5.6 and D6 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md):
 * GPT-6 Luna reads the scene and the titles of the selected entries, each followed by the keys LoreBase's model wrote
 * for it (D17), and picks the entries the next reply needs. The prompt is the route trials' toc_focus word for word
 * (InternalProject/Vectfox/tools/lorebase-benchmark/route_trials.py), with the table of contents at the end of the
 * system prompt as T28's luna_keys_table_in_system asked it, its lines T20's luna_keys lines (segment_trials.py);
 * tests/lorebase-pick-and-review.test.js holds it to the trials' own rendering. Pure: no SillyTavern, no network.
 */
import { chatHead } from './lorebase-scene-core.js';
import { entryTitle } from './lorebase-splitter.js';

// At most 6 picks a turn, as in the trials.
const MAX_PICKS = 6;

const PICK_SYSTEM_PROMPT = 'You help a roleplay app look things up in its lorebook before the next reply. '
    + "You never see the lorebook's text. Treat the world as one you do not know: use only what the chat says, "
    + 'and add no facts of your own. Return JSON only.';

const PICK_INSTRUCTIONS = [
    `Pick the entries the next reply needs, most needed first, at most ${MAX_PICKS}. `
        + "The reply answers the user's last message: pick what that message names or is about. "
        + "Pick an entry named only in earlier messages when the user's last message is still about it, not because it was mentioned. "
        + 'Pick none when it needs none.',
    'For each pick, give:',
    '- basis: why you picked it, one of "named in the chat", "in the scene, not named", '
        + '"the character speaking or spoken to", "background for the reply", "other";',
    '- certain: true when the next reply will certainly draw on it, false when it only might;',
    '- why: one sentence on why the next reply needs it;',
    '- needs: what in that entry the reply needs, in a few words.',
    'Write why and needs in English.',
    'Return {"entries": [{"number": <number>, "basis": "...", "certain": true, "why": "...", "needs": "..."}, ...]}',
].join('\n');

/**
 * The table of contents the pick reads: every selected entry of the books taking part this turn, numbered across
 * books in book order, each with its keys.
 * @param {Array<{bookName: string, entries: Array<{uid: number, comment?: string}>, keysByUid?: Record<string, string[]>}>} books -
 *   In book order, each with its selected entries in the book's own order and their keys by uid
 * @returns {Array<{number: number, bookName: string, uid: number, title: string, keys: string[]}>}
 */
export function tableOfContents(books) {
    const contents = [];
    for (const { bookName, entries, keysByUid = {} } of books) {
        for (const entry of entries) {
            contents.push({ number: contents.length + 1, bookName, uid: entry.uid, title: entryTitle(entry), keys: keysByUid[String(entry.uid)] ?? [] });
        }
    }
    return contents;
}

/**
 * One line of the table of contents: its title, then its keys in brackets, as T20's luna_keys arm wrote it.
 * @param {{title: string, keys?: string[]}} item
 * @returns {string}
 */
export function contentsLine({ title, keys = [] }) {
    return keys.length ? `${title} (${keys.join(', ')})` : title;
}

/**
 * The pick's messages for a turn: the system prompt ending with the table of contents, one line per entry, its number,
 * title and keys; then the scene and the instructions. The table stays the same from turn to turn while the selection,
 * the titles and the keys do, and a provider reads its cache back only for text at the end of the system message, so
 * every turn after the first reads the table from the cache (T28, T30, plan §3 of InternalProject/Vectfox/plans/
 * executed/lorebook-multi-vector.md).
 * @param {string} scene - From sceneText
 * @param {Array<{number: number, title: string, keys?: string[]}>} contents - From tableOfContents
 * @returns {Array<{role: string, content: string}>}
 */
export function pickMessages(scene, contents) {
    const lines = contents.map(item => `${item.number}. ${contentsLine(item)}`).join('\n');
    const system = `${PICK_SYSTEM_PROMPT}\n\nThe lorebook's table of contents, one entry per line: its number and title.\n\n${lines}`.replace(/\n+$/, '');
    return [{ role: 'system', content: system }, { role: 'user', content: `${chatHead(scene)}${PICK_INSTRUCTIONS}` }];
}

const textOf = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The picks in the pick's answer, most needed first: at most 6, each entry once, each named by a whole number in the
 * table of contents, as the trials read them. An item that names no entry of the table is not read, and counted.
 * @param {unknown[]} items - The answer's entries, as parseJsonArrayFromLlm reads them
 * @param {Array<{number: number, bookName: string, uid: number, title: string}>} contents - The table the pick read
 * @returns {{picks: Array<{number: number, bookName: string, uid: number, title: string, basis: string, why: string,
 *   needs: string, certain: boolean|null}>, unreadItemCount: number}}
 */
export function readPicks(items, contents) {
    const picks = [];
    let unreadItemCount = 0;
    for (const item of items) {
        const number = item?.number;
        if (!Number.isInteger(number) || number < 1 || number > contents.length) {
            unreadItemCount += 1;
            continue;
        }
        if (picks.some(pick => pick.number === number)) continue;
        picks.push({
            ...contents[number - 1],
            basis: textOf(item.basis).toLowerCase(),
            why: textOf(item.why),
            needs: textOf(item.needs),
            certain: typeof item.certain === 'boolean' ? item.certain : null,
        });
    }
    return { picks: picks.slice(0, MAX_PICKS), unreadItemCount };
}
