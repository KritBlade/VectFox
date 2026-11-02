/**
 * Unit tests for src/shared/string-list.js — the list cleanup the EventBase and
 * Auto-Reformat schemas apply to every string-list field of an LLM's output.
 */

import { describe, it, expect } from 'vitest';
import { normalizeStringList } from '../src/shared/string-list.js';

describe('normalizeStringList', () => {
    it('trims, dedupes, and drops empties', () => {
        expect(normalizeStringList([' a ', 'a', '', 'b', '  '])).toEqual(['a', 'b']);
    });
    it('returns [] for non-arrays', () => {
        expect(normalizeStringList(null)).toEqual([]);
        expect(normalizeStringList('x')).toEqual([]);
        expect(normalizeStringList(undefined)).toEqual([]);
    });
    it('coerces non-string members via String()', () => {
        expect(normalizeStringList([1, 2, 2, null])).toEqual(['1', '2']);
    });
});
