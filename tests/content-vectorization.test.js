/**
 * Unit tests for prepareLorebookContent (src/features/chunkbase/lorebook-content-preparer.js)
 *
 * Focus: per_entry title inclusion (PR #2 fix). Tests the four minimum cases
 * from InternalProject/Vectfox/plans/executed/semantic-wi-activation-pr1-followups.md §Follow-up 4, plus
 * combined-strategy regression guards.
 *
 * The function is tested directly from its extracted module (no ST globals
 * needed). cleanText is mocked as a passthrough so assertions are not
 * sensitive to cleaning rules.
 */

import { describe, it, expect, vi } from 'vitest';

// text-cleaning.js imports ST globals; mock the whole module so we never
// touch ../../../../extensions.js or any other SillyTavern path.
vi.mock('../src/features/text-cleaning/text-cleaning.js', () => ({
    cleanText: vi.fn((t) => (t ?? '').trim()),
    cleanContentOrNull: vi.fn((t) => {
        const trimmed = (t ?? '').trim();
        return trimmed ? trimmed : null;
    }),
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them.
vi.mock('../../../../extensions.js', () => ({}));
vi.mock('../../../../../script.js', () => ({}));

import { prepareLorebookContent } from '../src/features/chunkbase/lorebook-content-preparer.js';

// ============================================================================
// HELPERS
// ============================================================================

function bare(content) {
    return { content };
}
function withComment(comment, content) {
    return { comment, content };
}
function withName(name, content) {
    return { name, content };
}
function withKey(keys, content) {
    return { key: keys, content };
}

// ============================================================================
// per_entry — title inclusion (PR #2 regression guard)
// ============================================================================

describe('prepareLorebookContent — per_entry strategy', () => {
    const settings = { strategy: 'per_entry' };

    it('prepends # comment when entry has comment', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('Dragon Queen', 'A fearsome ruler.')] },
            settings,
        );
        expect(result.type).toBe('per_entry');
        expect(result.text[0]).toBe('# Dragon Queen\nA fearsome ruler.');
    });

    it('prepends # name when entry has name but no comment', () => {
        const result = prepareLorebookContent(
            { entries: [withName('Crystal Cave', 'A glittering cavern.')] },
            settings,
        );
        expect(result.type).toBe('per_entry');
        expect(result.text[0]).toBe('# Crystal Cave\nA glittering cavern.');
    });

    it('prepends # key[0] when entry has only key, no comment or name', () => {
        const result = prepareLorebookContent(
            { entries: [withKey(['dragon', 'fire'], 'Breathes fire.')] },
            settings,
        );
        expect(result.type).toBe('per_entry');
        expect(result.text[0]).toBe('# dragon\nBreathes fire.');
    });

    it('returns bare content when entry has no comment, name, or key', () => {
        const result = prepareLorebookContent(
            { entries: [bare('Just raw lore text.')] },
            settings,
        );
        expect(result.type).toBe('per_entry');
        expect(result.text[0]).toBe('Just raw lore text.');
    });

    it('comment takes priority over name and key', () => {
        const result = prepareLorebookContent(
            { entries: [{ comment: 'CommentTitle', name: 'NameTitle', key: ['KeyTitle'], content: 'Body.' }] },
            settings,
        );
        expect(result.text[0]).toMatch('# CommentTitle\n');
    });

    it('name takes priority over key when no comment', () => {
        const result = prepareLorebookContent(
            { entries: [{ name: 'NameTitle', key: ['KeyTitle'], content: 'Body.' }] },
            settings,
        );
        expect(result.text[0]).toMatch('# NameTitle\n');
    });

    it('returns one text item per entry', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('A', 'Alpha.'), withComment('B', 'Beta.'), withComment('C', 'Gamma.')] },
            settings,
        );
        expect(result.text).toHaveLength(3);
        expect(result.entryCount).toBe(3);
    });

    it('filters entries with no content', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('HasContent', 'Some text.'), { comment: 'Empty', content: '' }, { comment: 'Null' }] },
            settings,
        );
        expect(result.text).toHaveLength(1);
        expect(result.text[0]).toBe('# HasContent\nSome text.');
    });

    it('returns empty type for empty entries array', () => {
        const result = prepareLorebookContent({ entries: [] }, settings);
        expect(result.type).toBe('empty');
    });

    it('accepts entries via content field instead of entries field', () => {
        const result = prepareLorebookContent(
            { content: [withComment('Via content', 'Body.')] },
            settings,
        );
        expect(result.type).toBe('per_entry');
        expect(result.text[0]).toBe('# Via content\nBody.');
    });

    it('accepts entries as object and converts to array', () => {
        const result = prepareLorebookContent(
            { entries: { 0: withComment('Obj entry', 'Body.') } },
            settings,
        );
        expect(result.type).toBe('per_entry');
        expect(result.text[0]).toBe('# Obj entry\nBody.');
    });
});

// ============================================================================
// combined strategy — regression guard (title inclusion already worked here)
// ============================================================================

describe('prepareLorebookContent — combined strategy', () => {
    const settings = { strategy: 'combined' };

    it('prepends title before each entry content', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('Nora', 'A travelling healer.')] },
            settings,
        );
        expect(result.type).toBe('combined');
        expect(result.text).toContain('# Nora\nA travelling healer.');
    });

    it('joins multiple entries with separator', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('Nora', 'Content A.'), withComment('Rin', 'Content B.')] },
            settings,
        );
        expect(result.type).toBe('combined');
        expect(result.text).toContain('\n\n---\n\n');
        expect(result.text).toContain('# Nora\n');
        expect(result.text).toContain('# Rin\n');
    });

    it('omits separator when only one entry', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('Solo', 'Only entry.')] },
            settings,
        );
        expect(result.text).not.toContain('---');
    });

    it('falls back to bare content when entry has no header', () => {
        const result = prepareLorebookContent(
            { entries: [bare('Headerless lore.')] },
            settings,
        );
        expect(result.text).toBe('Headerless lore.');
    });

    it('entryCount reflects number of valid entries', () => {
        const result = prepareLorebookContent(
            { entries: [withComment('A', 'Content A.'), withComment('B', 'Content B.')] },
            settings,
        );
        expect(result.entryCount).toBe(2);
    });
});
