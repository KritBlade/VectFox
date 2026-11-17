/**
 * What a backend stores for a chunk (src/features/vector-backend/stored-chunk.js): the keyword suffix Qdrant storage
 * appends to its text, and the payload, which keeps every field a chunk carries in its metadata, as when the Chunk
 * Visualizer stores an event again or an import brings one in.
 */

import { describe, expect, it } from 'vitest';
import { chunkPayload, keywordTexts, textWithKeywordSuffix, textWithoutKeywordSuffix } from '../src/features/vector-backend/stored-chunk.js';

describe('the keyword suffix Qdrant storage appends', () => {
    it('reads keywords stored as words or as objects', () => {
        expect(keywordTexts(['harbor', { text: 'key', weight: 1.5 }, { text: ' ' }, null, 7])).toEqual(['harbor', 'key']);
        expect(keywordTexts(undefined)).toEqual([]);
    });

    it('appends the keywords once, replacing a suffix the text already carries', () => {
        expect(textWithKeywordSuffix('The gate stood open.', [{ text: 'gate', weight: 1.5 }, 'harbor'])).toBe('The gate stood open. [KEYWORDS: gate harbor]');
        expect(textWithKeywordSuffix('The gate stood open. [KEYWORDS: gate harbor]', ['gate', 'harbor'])).toBe('The gate stood open. [KEYWORDS: gate harbor]');
        expect(textWithKeywordSuffix('The gate stood open. [KEYWORDS: gate]', ['tide'])).toBe('The gate stood open. [KEYWORDS: tide]');
        expect(textWithKeywordSuffix('The gate stood open. [KEYWORDS: gate]', [])).toBe('The gate stood open.');
    });

    it('strips only a suffix at the end of the text', () => {
        expect(textWithoutKeywordSuffix('The gate stood open. [KEYWORDS: gate harbor]')).toBe('The gate stood open.');
        expect(textWithoutKeywordSuffix('[KEYWORDS: gate] opens the log.')).toBe('[KEYWORDS: gate] opens the log.');
        expect(textWithoutKeywordSuffix(undefined)).toBe('');
    });
});

describe('the payload a backend stores with a chunk', () => {
    it('keeps the fields its metadata carries when the item does not carry them', () => {
        const item = {
            hash: 1,
            text: 'The gate stood open.',
            metadata: { name: 'Gate', keywords: [{ text: 'gate', weight: 1.5 }], importance: 7, event_type: 'discovery', window_event_order: 2 },
        };
        expect(chunkPayload(item)).toEqual({ name: 'Gate', keywords: [{ text: 'gate', weight: 1.5 }], importance: 7, event_type: 'discovery', window_event_order: 2 });
    });

    it('takes the item\'s own fields first', () => {
        const item = { keywords: ['tide'], importance: 3, metadata: { keywords: ['gate'], importance: 7 } };
        expect(chunkPayload(item)).toMatchObject({ keywords: ['tide'], importance: 3 });
    });

    it('stores a chunk with no keywords with an empty list', () => {
        expect(chunkPayload({ metadata: {} }).keywords).toEqual([]);
    });
});
