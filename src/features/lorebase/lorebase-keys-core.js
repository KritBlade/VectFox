/**
 * The keys LoreBase's model writes for each entry the user turns on (plan D17 and §5.6 of InternalProject/Vectfox/
 * plans/lorebook-semantic-overhaul-passage-index.md): T20's prompt word for word (`LUNA_KEYS_SYSTEM` and
 * `LUNA_KEYS_PROMPT` in tools/lorebase-benchmark/segment_trials.py), on the entry's text, and its answer read as T20
 * read it (`read_luna_keys`). tests/lorebase-keys-core.test.js holds the prompt to T20's own rendering. Pure: no
 * SillyTavern, no network.
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
 * The keys in an answer: its `keys` strings, trimmed, each once, cut to the count asked; null when it holds none.
 * @param {unknown[]} items - The answer's records, as parseJsonArrayFromLlm reads them with `keys` marking a record
 * @param {number} count - From keyCount
 * @returns {string[]|null}
 */
export function readKeys(items, count) {
    const keys = Array.isArray(items) ? items[0]?.keys : undefined;
    if (!Array.isArray(keys)) return null;
    const cleaned = [...new Set(keys.filter(key => typeof key === 'string').map(key => key.trim()).filter(Boolean))];
    return cleaned.length ? cleaned.slice(0, count) : null;
}
