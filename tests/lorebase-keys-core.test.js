/**
 * The keys LoreBase's model writes for each entry turned on (plan D17 and §5.6 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md) are asked with T20's prompt word for word, for as many keys as T20 asked,
 * and read as T20 read them. The fixture holds made-up entries and the prompts segment_trials.py itself renders from
 * them; InternalProject/Vectfox/tools/lorebase-benchmark/export_trial_prompts.py writes it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    KEY_CALLS_AT_ONCE_DEFAULT, KEY_CALLS_AT_ONCE_MAX, editedKeys, keyCallsAtOnceOf, keyCount, keysMessages, readKeys,
} from '../src/features/lorebase/lorebase-keys-core.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lorebase-trial-prompts.json', import.meta.url), 'utf8'));
const entriesByUid = new Map([...fixture.entries, fixture.keys.longEntry].map(entry => [entry.uid, entry]));

describe("T20's keys prompt, word for word", () => {
    it('asks for each made-up entry as segment_trials.py renders it, its count included', () => {
        expect(fixture.keys.entries.length).toBe(5);
        for (const { uid, count, prompt } of fixture.keys.entries) {
            const entry = entriesByUid.get(uid);
            expect(keyCount(entry)).toBe(count);
            expect(keysMessages(entry)).toEqual([
                { role: 'system', content: fixture.keys.system },
                { role: 'user', content: prompt },
            ]);
        }
    });

    it('asks a long entry for one key every 150 tokens, and a short one for 6', () => {
        expect(fixture.keys.entries.find(item => item.uid === 9).count).toBe(8);
        expect(keyCount({ content: 'A short entry.' })).toBe(6);
        expect(keyCount({})).toBe(6);
    });
});

describe('reading the keys', () => {
    it('keeps the strings of keys, trimmed, each once, up to the count', () => {
        expect(readKeys([{ keys: [' lighthouse ', 'keeper', 'lighthouse', '', 7, 'harbor', 'tide'] }], 3)).toEqual(['lighthouse', 'keeper', 'harbor']);
    });

    it('reads an empty list of keys, or one of blank strings, as the model finding nothing to key', () => {
        expect(readKeys([{ keys: [] }], 6)).toEqual([]);
        expect(readKeys([{ keys: ['  ', ''] }], 6)).toEqual([]);
    });

    it('reads an answer with no list of keys, or a list of anything but strings, as unreadable, so it is asked again', () => {
        expect(readKeys([{ names: ['harbor'] }], 6)).toBeNull();
        expect(readKeys([{ keys: 'harbor' }], 6)).toBeNull();
        expect(readKeys([{ keys: [42, null] }], 6)).toBeNull();
        expect(readKeys([], 6)).toBeNull();
        expect(readKeys(null, 6)).toBeNull();
    });
});

describe('Entries at once', () => {
    it('keys 6 entries at once by default, as T20 ran, and at most 8', () => {
        expect([KEY_CALLS_AT_ONCE_DEFAULT, KEY_CALLS_AT_ONCE_MAX]).toEqual([6, 8]);
    });

    it('holds a saved value to a whole number from 1 to 8, and takes the default for one that holds no number', () => {
        expect([3, '5', 0, -2, 9, 40, 2.7].map(keyCallsAtOnceOf)).toEqual([3, 5, 1, 1, 8, 8, 2]);
        expect([undefined, null, '', 'many'].map(keyCallsAtOnceOf)).toEqual([6, 6, 6, 6]);
    });
});

describe('the keys the user types', () => {
    it('takes one key per line, trimmed, each once, in order, commas kept inside a key', () => {
        expect(editedKeys(' lighthouse \r\n\nkeeper, the old\nlighthouse\n灯塔')).toEqual({ keys: ['lighthouse', 'keeper, the old', '灯塔'] });
    });

    it('refuses what Similharity would not store: no key, more than 200, or a key over 300 characters', () => {
        expect(editedKeys(' \n ')).toEqual({ problem: "An entry needs at least one key. Regenerate asks LoreBase's model for them." });
        expect(editedKeys(Array.from({ length: 201 }, (_, index) => `key ${index}`).join('\n'))).toEqual({ problem: 'An entry holds at most 200 keys, and these are 201.' });
        expect(editedKeys(`harbor\n${'b'.repeat(301)}`).problem).toBe(`A key holds at most 300 characters, and "${'b'.repeat(40)}…" holds 301.`);
        expect(editedKeys(Array.from({ length: 200 }, (_, index) => `key ${index}`).join('\n')).keys).toHaveLength(200);
    });
});
