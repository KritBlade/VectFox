/**
 * Tests: backend-first read of per-chunk metadata (plugin / Qdrant paths).
 *
 * Design: the vector backend (Vectra-via-plugin / Qdrant) is the source of truth for
 * per-chunk fields (name, context, xmlTag, position, depth, keywords, conditions,
 * enabled, chunkLinks). extension_settings is a legacy read-time fallback only.
 * See plans/chunk-metadata-read-source-fix.md.
 *
 * Coverage:
 *  - getChunkData merge precedence (replicated from ui/chunk-visualizer.js — that module
 *    can't be imported under vitest due to heavy UI deps; the merge logic is mirrored here
 *    1:1 and must be kept in sync).
 *  - processChunkLinks with the unified visualizer shape (chunkLinks / { targetHash, mode })
 *    — imported REAL from core/conditional-activation.js.
 */

import { describe, it, expect, vi } from 'vitest';

const mockSettings = vi.hoisted(() => ({ vectfox: {} }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: mockSettings }));
vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: vi.fn() }));

import { processChunkLinks } from '../src/features/collections/conditional-activation.js';

// ---------------------------------------------------------------------------
// Mirror of getChunkData()'s field merge (ui/chunk-visualizer.js). Keep in sync.
// pick: first non-null wins. pickStr: also treats '' as absent.
// ---------------------------------------------------------------------------
const pick = (a, b) => (a !== undefined && a !== null ? a : b);
const pickStr = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);

function mergeChunkRead(chunk) {
    const stored = chunk._stored || {};        // stands in for getChunkMetadata(hash)
    const dbMeta = chunk.metadata || {};
    const keywords = (Array.isArray(dbMeta.keywords) && dbMeta.keywords.length > 0)
        ? dbMeta.keywords
        : (stored.keywords !== undefined ? stored.keywords : (chunk.keywords || []));
    return {
        enabled: pick(dbMeta.enabled, stored.enabled) !== false,
        keywords,
        conditions: dbMeta.conditions || stored.conditions || { enabled: false, logic: 'AND', rules: [] },
        chunkLinks: dbMeta.chunkLinks || stored.chunkLinks || [],
        name: pickStr(dbMeta.name, stored.name) ?? null,
        context: pickStr(dbMeta.context, stored.context) ?? '',
        xmlTag: pickStr(dbMeta.xmlTag, stored.xmlTag) ?? '',
        position: pick(dbMeta.position, stored.position) ?? null,
        depth: pick(dbMeta.depth, stored.depth) ?? null,
    };
}

// ---------------------------------------------------------------------------
// Read-merge precedence
// ---------------------------------------------------------------------------
describe('getChunkData merge — backend-first with ext_settings fallback', () => {
    it('backend payload wins over ext_settings', () => {
        const r = mergeChunkRead({
            metadata: { name: 'backend', context: 'B-ctx', position: 5 },
            _stored: { name: 'ext', context: 'E-ctx', position: 9 },
        });
        expect(r.name).toBe('backend');
        expect(r.context).toBe('B-ctx');
        expect(r.position).toBe(5);
    });

    it('falls back to ext_settings when the backend lacks the field (legacy chunk)', () => {
        const r = mergeChunkRead({
            metadata: {},                                 // backend payload missing fields
            _stored: { name: 'legacy', context: 'legacy-ctx', depth: 3 },
        });
        expect(r.name).toBe('legacy');
        expect(r.context).toBe('legacy-ctx');
        expect(r.depth).toBe(3);
    });

    it('position/depth: 0 is a valid value, not treated as absent', () => {
        const r = mergeChunkRead({ metadata: { position: 0, depth: 0 }, _stored: { position: 4, depth: 4 } });
        expect(r.position).toBe(0);
        expect(r.depth).toBe(0);
    });

    it('empty string in backend falls through to ext_settings (pickStr)', () => {
        const r = mergeChunkRead({ metadata: { context: '' }, _stored: { context: 'use-me' } });
        expect(r.context).toBe('use-me');
    });

    it('enabled: explicit false from the backend survives', () => {
        expect(mergeChunkRead({ metadata: { enabled: false }, _stored: {} }).enabled).toBe(false);
    });

    it('enabled: explicit false from ext_settings survives when backend has no opinion', () => {
        expect(mergeChunkRead({ metadata: {}, _stored: { enabled: false } }).enabled).toBe(false);
    });

    it('enabled: defaults to true when neither store sets it', () => {
        expect(mergeChunkRead({ metadata: {}, _stored: {} }).enabled).toBe(true);
    });

    it('keywords: non-empty backend array wins', () => {
        const r = mergeChunkRead({ metadata: { keywords: [{ text: 'b' }] }, _stored: { keywords: [{ text: 'e' }] } });
        expect(r.keywords).toEqual([{ text: 'b' }]);
    });

    it('keywords: empty backend array falls back to ext_settings', () => {
        const r = mergeChunkRead({ metadata: { keywords: [] }, _stored: { keywords: [{ text: 'e' }] } });
        expect(r.keywords).toEqual([{ text: 'e' }]);
    });

    it('conditions/chunkLinks fall back to ext_settings then to defaults', () => {
        const cond = { enabled: true, logic: 'AND', rules: [] };
        const links = [{ targetHash: '1', mode: 'soft' }];
        const r = mergeChunkRead({ metadata: {}, _stored: { conditions: cond, chunkLinks: links } });
        expect(r.conditions).toBe(cond);
        expect(r.chunkLinks).toBe(links);

        const empty = mergeChunkRead({ metadata: {}, _stored: {} });
        expect(empty.conditions).toEqual({ enabled: false, logic: 'AND', rules: [] });
        expect(empty.chunkLinks).toEqual([]);
    });

    it('missing fields default to null/empty', () => {
        const r = mergeChunkRead({ metadata: {}, _stored: {} });
        expect(r.name).toBeNull();
        expect(r.context).toBe('');
        expect(r.position).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Links: unified shape (chunkLinks / { targetHash, mode }) — REAL function
// ---------------------------------------------------------------------------
describe('processChunkLinks — unified visualizer shape (chunkLinks/{targetHash,mode})', () => {
    it('soft link boosts the target chunk', () => {
        const chunks = [{ hash: 1001, score: 0.8 }, { hash: 1002, score: 0.6 }];
        const map = { 1001: { chunkLinks: [{ targetHash: '1002', mode: 'soft' }] }, 1002: {} };
        const res = processChunkLinks(chunks, map, 0.15);
        const target = res.chunks.find(c => c.hash === 1002);
        expect(target.softLinked).toBe(true);
        expect(target.score).toBeGreaterThan(0.6);
    });

    it('force link surfaces a missing target', () => {
        const chunks = [{ hash: 2001, score: 0.8 }];
        const map = { 2001: { chunkLinks: [{ targetHash: '2002', mode: 'force' }] } };
        const res = processChunkLinks(chunks, map, 0.15);
        expect(res.missingHardLinks).toContain(2002);
    });

    it('ignores the OLD shape (links/{target,type}) — confirms the migration took effect', () => {
        const chunks = [{ hash: 3001, score: 0.8 }, { hash: 3002, score: 0.6 }];
        const map = { 3001: { links: [{ target: '3002', type: 'soft' }] }, 3002: {} };
        const res = processChunkLinks(chunks, map, 0.15);
        const target = res.chunks.find(c => c.hash === 3002);
        expect(target.softLinked).toBeFalsy();
        expect(target.score).toBe(0.6);
    });

    it('no links → chunks pass through unchanged', () => {
        const chunks = [{ hash: 4001, score: 0.5 }];
        const res = processChunkLinks(chunks, {}, 0.15);
        expect(res.chunks[0].score).toBe(0.5);
        expect(res.missingHardLinks).toEqual([]);
    });
});
