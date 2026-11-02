/**
 * Tests for remapCollectionIdToHandle + sanitizeHandleId (core/collection-ids.js).
 *
 * These exercise the REAL implementation, so the SillyTavern host modules that
 * collection-ids.js imports must be stubbed. The deep relative specifiers below
 * resolve to the same module ids from /tests/ as from /core/ (both are direct
 * children of the repo root) — same trick used by world-info-integration.test.js.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    getContext: vi.fn(() => ({ name1: 'user' })),
}));
vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => null),
    chat_metadata: {},
}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: new Proxy({}, { get: () => () => {} }),
}));

import { remapCollectionIdToHandle, sanitizeHandleId, sanitizeNameSegment, sanitizeIdSegment } from '../src/shared/collection-ids.js';

describe('sanitizeIdSegment (primitive)', () => {
    it('does not edge-trim or apply fallback by default', () => {
        expect(sanitizeIdSegment('!hello!', { maxLen: 50 })).toBe('_hello_');
        expect(sanitizeIdSegment('', { maxLen: 50 })).toBe('');
    });
    it('edge-trims and applies fallback when asked', () => {
        expect(sanitizeIdSegment('!hello!', { maxLen: 50, trim: true })).toBe('hello');
        expect(sanitizeIdSegment('!!!', { maxLen: 50, trim: true, fallback: 'x' })).toBe('x');
    });
    it('sanitizeHandleId === sanitizeIdSegment(name, {maxLen:30, trim, fallback:user})', () => {
        for (const n of ['Crit Blade', '  Rabbit!  ', '', '創世域', 'a'.repeat(40)]) {
            expect(sanitizeHandleId(n)).toBe(sanitizeIdSegment(n, { maxLen: 30, trim: true, fallback: 'user' }));
        }
    });
});

describe('sanitizeNameSegment', () => {
    it('keeps positional underscores (no edge-trim) and caps length', () => {
        expect(sanitizeNameSegment('  My Lorebook  ', 50)).toBe('_my_lorebook_');
        expect(sanitizeNameSegment('x'.repeat(80), 50)).toBe('x'.repeat(50));
    });
    it('returns empty string for empty input (no word fallback)', () => {
        expect(sanitizeNameSegment('', 50)).toBe('');
        expect(sanitizeNameSegment(null, 50)).toBe('');
    });
});

describe('sanitizeHandleId', () => {
    it('lowercases, joins non-alphanumerics with underscore, trims edges', () => {
        expect(sanitizeHandleId('Crit Blade')).toBe('crit_blade');
        expect(sanitizeHandleId('  Rabbit!  ')).toBe('rabbit');
    });
    it('falls back to "user" for empty/nullish input', () => {
        expect(sanitizeHandleId('')).toBe('user');
        expect(sanitizeHandleId(null)).toBe('user');
        expect(sanitizeHandleId(undefined)).toBe('user');
    });
    it('preserves non-latin scripts (NFC) and caps at 30 chars', () => {
        expect(sanitizeHandleId('創世域')).toBe('創世域');
        expect(sanitizeHandleId('a'.repeat(40))).toBe('a'.repeat(30));
    });
});

describe('remapCollectionIdToHandle', () => {
    it('rewrites the handle segment after a backend segment', () => {
        expect(
            remapCollectionIdToHandle('vf_eventbase_qdrant_critblade_artificrealm_uuid123', 'rabbit'),
        ).toBe('vf_eventbase_qdrant_rabbit_artificrealm_uuid123');
    });

    it('rewrites the handle segment in a legacy (no-backend) ID', () => {
        expect(
            remapCollectionIdToHandle('vf_eventbase_critblade_artificrealm_uuid123', 'rabbit'),
        ).toBe('vf_eventbase_rabbit_artificrealm_uuid123');
    });

    it('sanitizes the target handle before substituting', () => {
        expect(
            remapCollectionIdToHandle('vf_lorebook_standard_critblade_world_123', 'Rabbit King!'),
        ).toBe('vf_lorebook_standard_rabbit_king_world_123');
    });

    it('is a no-op when the handle already matches', () => {
        const id = 'vf_eventbase_qdrant_rabbit_artificrealm_uuid123';
        expect(remapCollectionIdToHandle(id, 'rabbit')).toBe(id);
    });

    it('leaves unknown-format IDs untouched', () => {
        expect(remapCollectionIdToHandle('legacy_collection_42', 'rabbit')).toBe('legacy_collection_42');
        expect(remapCollectionIdToHandle('', 'rabbit')).toBe('');
    });

    it('does not corrupt the char/uuid tail when remapping', () => {
        // char name itself contains underscores — only the handle segment must change
        const out = remapCollectionIdToHandle('vf_character_qdrant_critblade_my_long_char_name_999', 'rabbit');
        expect(out).toBe('vf_character_qdrant_rabbit_my_long_char_name_999');
    });
});
