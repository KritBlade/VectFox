/**
 * The keys LoreBase's model writes for each entry the user turns on (plan D17 and §5.6 of InternalProject/Vectfox/
 * plans/executed/lorebook-semantic-overhaul-passage-index.md): T20's prompt word for word (`LUNA_KEYS_SYSTEM` and
 * `LUNA_KEYS_PROMPT` in tools/lorebase-benchmark/segment_trials.py), on the entry's text, and its answer read as T20
 * read it (`read_luna_keys`); and the keys the user types in an entry's edit dialog. tests/lorebase-keys-core.test.js
 * holds the prompt to T20's own rendering. Pure: no SillyTavern, no network.
 */
import { THINKING_TOKEN_ALLOWANCE } from './lorebase-reply-core.js';
import { estimatedTokens, roundHalfEven } from './lorebase-splitter.js';

// About one key for every TOKENS_PER_KEY estimated tokens of the entry, never fewer than FEWEST_KEYS.
const TOKENS_PER_KEY = 150;
const FEWEST_KEYS = 6;

/** Room for the answer, and for a thinking model to reason before it, as T20 asked. */
export const KEYS_MAX_TOKENS = 3000 + THINKING_TOKEN_ALLOWANCE;
/** An answer that cannot be read is asked again, up to this many asks in all. */
export const KEYS_ASKS = 3;
/** The reasoning effort keys are written at: the model's default, as T20 sent none. */
export const KEYS_REASONING_EFFORT = null;
/** Entries keyed at once, from the WorldInfo page's Entries at once: by default as many as T20 ran, and at most. */
export const KEY_CALLS_AT_ONCE_DEFAULT = 6;
export const KEY_CALLS_AT_ONCE_MAX = 8;

/**
 * The entries LoreBase keys at once, from its saved Entries at once: a whole number from 1 to the most, or the default for
 * a setting that holds no number.
 * @param {unknown} value
 * @returns {number}
 */
export function keyCallsAtOnceOf(value) {
    const count = Number.parseInt(value, 10);
    return Number.isFinite(count) ? Math.min(KEY_CALLS_AT_ONCE_MAX, Math.max(1, count)) : KEY_CALLS_AT_ONCE_DEFAULT;
}

/**
 * The toast for the entries of a book whose keys or vectors a writing could not write: up to three named, how many
 * more, that they send nothing until they have them, what writes them again, and the first failure's detail.
 * @param {{what: string, bookName: string, failures: Array<{title: string, detail: string}>, remedy: string}} options -
 *   what: 'keys' or 'vectors'; at least one failure
 * @returns {string}
 */
export function writingFailuresMessage({ what, bookName, failures, remedy }) {
    const titles = failures.slice(0, 3).map(failure => `"${failure.title}"`).join(', ');
    const more = failures.length > 3 ? ` and ${failures.length - 3} more` : '';
    return `LoreBase could not write the ${what} of ${titles}${more} in lorebook "${bookName}", so they send nothing until they have them. `
        + `${remedy} Details: ${failures[0].detail.slice(0, 320)}`;
}

/**
 * The opening lines of a question about the selected entries without keys or vectors, as turning LoreBase on and
 * closing the selection screen ask it: what is written before an entry takes part, and how many entries lack it.
 * @param {number} count
 * @returns {Array<{icon?: string, text: string, name?: string}>} Popup lines (sillytavern/popup-core.js)
 */
export function missingKeysAndVectorsLines(count) {
    return [
        { icon: 'fa-key', text: "Before a selected entry takes part, it needs keys, one call to LoreBase's model each, and vectors from VectFox's embedding model." },
        { text: 'Selected entries without keys or vectors:', name: count.toLocaleString('en-US') },
    ];
}

const KEYS_SYSTEM_PROMPT = 'You write the keys of lorebook entries for a roleplay app, which picks the entries each reply needs by their '
    + 'titles and keys. Return JSON only.';

/**
 * The text keys are written from: the entry's content, its line ends made plain, as T20 read it.
 * @param {{content?: string}} entry
 * @returns {string}
 */
export function keyText(entry) {
    return String(entry?.content ?? '').replace(/\r\n/g, '\n');
}

/**
 * How many keys to ask for: one for every 150 estimated tokens, never fewer than 6.
 * @param {{content?: string}} entry
 * @returns {number}
 */
export function keyCount(entry) {
    return Math.max(FEWEST_KEYS, roundHalfEven(estimatedTokens(keyText(entry)) / TOKENS_PER_KEY));
}

/**
 * The messages that ask for one entry's keys.
 * @param {{content?: string}} entry
 * @returns {Array<{role: string, content: string}>}
 */
export function keysMessages(entry) {
    const prompt = `A lorebook entry's text:\n\n${keyText(entry)}\n\n`
        + `List up to ${keyCount(entry)} keys for it, most important first: the names of the people, places, groups, things and events it holds, `
        + 'and the topics it covers. Write each name as the text writes it, and keep each key to a few words. Write them in the entry\'s language.\n'
        + 'Return {"keys": ["...", ...]}';
    return [{ role: 'system', content: KEYS_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
}

/**
 * The keys in an answer: its `keys` strings, trimmed, each once, cut to the count asked. An empty list, or one of blank
 * strings, is the model saying the entry holds nothing to key, and reads as []; an answer with no `keys` list, or a
 * list of anything but strings, could not be read, and reads as null.
 * @param {unknown[]} items - The answer's records, as parseJsonArrayFromLlm reads them with `keys` marking a record
 * @param {number} count - From keyCount
 * @returns {string[]|null}
 */
export function readKeys(items, count) {
    const keys = Array.isArray(items) ? items[0]?.keys : undefined;
    if (!Array.isArray(keys)) return null;
    const strings = keys.filter(key => typeof key === 'string');
    if (keys.length && !strings.length) return null;
    return [...new Set(strings.map(key => key.trim()).filter(Boolean))].slice(0, count);
}

// What Similharity stores for one entry (its lorebase-keys.js): at most this many keys, each at most this long.
const MOST_KEYS = 200;
const LONGEST_KEY = 300;
// How much of a key too long to keep the problem names.
const QUOTED_KEY_CHARACTERS = 40;

/**
 * The keys the user typed for an entry in its edit dialog, one per line: trimmed, each once, in their order; or why
 * Similharity would not store them.
 * @param {string} text - The dialog's box
 * @returns {{keys: string[]}|{problem: string}}
 */
export function editedKeys(text) {
    const keys = [...new Set(String(text ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean))];
    if (!keys.length) return { problem: "An entry needs at least one key. Regenerate asks LoreBase's model for them." };
    if (keys.length > MOST_KEYS) return { problem: `An entry holds at most ${MOST_KEYS} keys, and these are ${keys.length}.` };
    const tooLong = keys.find(key => key.length > LONGEST_KEY);
    if (tooLong) {
        return { problem: `A key holds at most ${LONGEST_KEY} characters, and "${tooLong.slice(0, QUOTED_KEY_CHARACTERS)}…" holds ${tooLong.length}.` };
    }
    return { keys };
}
