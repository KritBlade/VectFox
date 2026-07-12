/**
 * Unit tests for core/reformat-schema.js
 *
 * Covers the Auto-Reformat schema validator, hallucination guardrail
 * (computeNameVerification), and prompt builder. Pure module, no ST globals
 * — no mocking required (same convention as glossary-extractor.test.js).
 */

import { describe, it, expect } from 'vitest';
import {
    REFORMAT_ENTRY_TYPES,
    validateReformattedChunk,
    computeNameVerification,
    buildReformatPrompt,
} from '../core/reformat-schema.js';

describe('validateReformattedChunk', () => {
    it('accepts a well-formed record and normalizes array fields', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'character',
            name: '  Bulwark  ',
            aliases: ['Eleanor Graves', 'Eleanor Graves', '  '],
            affiliation: 'Ironclad Agency',
            traits: ['Transformation-type Spark'],
            relationships: [],
            keywords: ['Ironclad', 'Fortress'],
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });

        expect(ok).toBe(true);
        expect(errors).toEqual([]);
        expect(chunk).toEqual({
            entry_type: 'character',
            name: 'Bulwark',
            aliases: ['Eleanor Graves'], // deduped + trimmed + empties dropped
            affiliation: 'Ironclad Agency',
            traits: ['Transformation-type Spark'],
            relationships: [],
            keywords: ['Ironclad', 'Fortress'],
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });
    });

    it('rejects a non-object input', () => {
        const { ok, errors } = validateReformattedChunk('not an object');
        expect(ok).toBe(false);
        expect(errors[0]).toMatch(/not an object/);
    });

    it('rejects a record with no name', () => {
        const { ok, errors } = validateReformattedChunk({ entry_type: 'concept', body: 'Some lore.' });
        expect(ok).toBe(false);
        expect(errors).toEqual(['name is empty or missing']);
    });

    it('rejects a record with no body', () => {
        const { ok, errors } = validateReformattedChunk({ entry_type: 'concept', name: 'Spark Classification' });
        expect(ok).toBe(false);
        expect(errors).toEqual(['body is empty or missing']);
    });

    it('coerces an unknown entry_type to "other" and reports it', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'villain_org', // not in vocabulary
            name: 'The Daughters of the Awakening',
            body: 'A female supremacist paramilitary organization.',
        });

        expect(ok).toBe(true);
        expect(chunk.entry_type).toBe('other');
        expect(errors.some(e => /not in vocabulary/.test(e))).toBe(true);
    });

    it('every declared entry_type round-trips without coercion', () => {
        for (const entry_type of REFORMAT_ENTRY_TYPES) {
            const { ok, errors, chunk } = validateReformattedChunk({ entry_type, name: 'X', body: 'Y' });
            expect(ok).toBe(true);
            expect(chunk.entry_type).toBe(entry_type);
            expect(errors).toEqual([]);
        }
    });

    it('defaults affiliation to an empty string when missing', () => {
        const { chunk } = validateReformattedChunk({ entry_type: 'concept', name: 'X', body: 'Y' });
        expect(chunk.affiliation).toBe('');
        expect(chunk.aliases).toEqual([]);
        expect(chunk.traits).toEqual([]);
        expect(chunk.relationships).toEqual([]);
        expect(chunk.keywords).toEqual([]);
    });
});

describe('computeNameVerification', () => {
    const source = 'Bulwark (Eleanor Graves) leads Ironclad Agency. Her Spark is called Fortress.';

    it('grounds a name that appears verbatim in the source', () => {
        const [result] = computeNameVerification([{ name: 'Bulwark', aliases: [] }], source);
        expect(result.nameGrounded).toBe(true);
        expect(result.ungroundedAliases).toEqual([]);
    });

    it('grounds a name regardless of case/punctuation differences', () => {
        const [result] = computeNameVerification([{ name: 'ELEANOR, GRAVES' }], source);
        expect(result.nameGrounded).toBe(true);
    });

    it('flags a name that does not appear anywhere in the source', () => {
        const [result] = computeNameVerification([{ name: 'Solaris', aliases: [] }], source);
        expect(result.nameGrounded).toBe(false);
    });

    it('flags only the ungrounded aliases, not the grounded ones', () => {
        const [result] = computeNameVerification(
            [{ name: 'Bulwark', aliases: ['Eleanor Graves', 'Steel Maiden'] }],
            source,
        );
        expect(result.nameGrounded).toBe(true);
        expect(result.ungroundedAliases).toEqual(['Steel Maiden']);
    });

    it('treats every chunk as grounded when sourceText is empty (nothing to check against)', () => {
        const result = computeNameVerification([{ name: 'Anyone' }], '');
        expect(result).toEqual([{ nameGrounded: true, ungroundedAliases: [] }]);
    });

    it('returns an empty array for non-array input', () => {
        expect(computeNameVerification(null, source)).toEqual([]);
    });
});

describe('buildReformatPrompt', () => {
    it('substitutes {{text}} into the default template', () => {
        const prompt = buildReformatPrompt('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('entry_type');
        expect(prompt).not.toContain('{{text}}');
    });

    it('has no continuation note when batchContext is not provided', () => {
        const prompt = buildReformatPrompt('body text');
        expect(prompt).not.toMatch(/continuation of section/i);
    });

    it('injects a continuation note listing already-extracted names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'Notable US Hero Agencies', alreadyExtractedNames: ['Columbia', 'Bulwark'] },
        });
        expect(prompt).toMatch(/continuation of section "Notable US Hero Agencies"/);
        expect(prompt).toContain('Columbia, Bulwark');
        expect(prompt).toMatch(/Do NOT re-emit them/);
    });

    it('shows "(none yet)" when the continuation has no prior names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'The Daughters of the Awakening', alreadyExtractedNames: [] },
        });
        expect(prompt).toContain('(none yet)');
    });

    it('uses a customPrompt override instead of the default template', () => {
        const prompt = buildReformatPrompt('MY TEXT', { customPrompt: 'Custom instructions.\n\n{{text}}' });
        expect(prompt).toBe('Custom instructions.\n\nMY TEXT');
    });
});
