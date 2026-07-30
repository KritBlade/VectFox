/**
 * Discovery-outage guards — a transient backend outage must never delete locks.
 *
 * THE FAILURE CHAIN THESE PIN (issue #11 "my lorebook unlocked out of the blue"):
 *   Qdrant hiccup → plugin /collections returns a vectra-only list with
 *   success:true and qdrantScanned:false → discovery pruned every qdrant
 *   registry entry as "stale" → the next DB-browser refresh fed the shrunken
 *   list to cleanupOrphanedMeta → the qdrant collections' metadata (chat and
 *   character LOCKS, triggers, scope, names) was deleted and persisted. The
 *   collection reappeared on the next healthy scan, but its lock did not.
 *
 * Three guards, one contract: absence is only proof of deletion when the
 * backend was actually scanned. Unverifiable ≠ deleted.
 *   1. discoverViaPlugin honors qdrantScanned (false/undefined → keep qdrant keys)
 *   2. cleanupOrphanedMeta refuses the zero-survivor mass wipe
 *   3. fallback discovery keeps qdrant keys (unverifiable without the plugin)
 *      and keeps any entry whose probe errored (unreachable ≠ missing)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
    getContext: vi.fn(() => ({ characterId: '0', name1: 'TestPersona', chatId: 'chat-1' })),
}));

vi.mock('../../../../../script.js', () => ({
    characters: [],
    getRequestHeaders: vi.fn(() => ({})),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: vi.fn(() => 'chat-1'),
}));

vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(),
    queryCollection: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

vi.mock('../core/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false },
}));

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes } from '../core/core-vector-api.js';
import { log } from '../core/log.js';
import { discoverExistingCollections, getCollectionRegistry, resetPluginAvailableCache } from '../core/collection-loader.js';
import { cleanupOrphanedMeta } from '../core/collection-metadata.js';

const QDRANT_KEY = 'qdrant:vf_lorebook_qdrant_testpersona_worldlore_1750000000000';
const VECTRA_KEY = 'standard:transformers:vf_lorebook_testpersona_oldbook_1740000000000';
const SETTINGS = { vector_backend: 'qdrant' };

/** A live vectra collection the plugin scan always finds (so the scan is never empty). */
const VECTRA_LIVE = { id: 'vf_chat_testpersona_alpha_1760000000000', backend: 'standard', source: 'transformers', chunkCount: 12, model: '' };

function seedRegistry(keys) {
    extension_settings.vectfox.vectfox_collection_registry = [...keys];
}

/** fetch stub: /health ok, /collections returns the given payload (or rejects). */
function mockPluginFetch(collectionsPayload) {
    global.fetch = vi.fn(async (url) => {
        if (String(url).includes('/health')) {
            return { ok: true, json: async () => ({ status: 'ok', version: 'test' }) };
        }
        if (String(url).includes('/collections')) {
            return { ok: true, json: async () => collectionsPayload };
        }
        throw new Error(`unexpected fetch in test: ${url}`);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    extension_settings.vectfox = { collections: {}, vectfox_collection_registry: [] };
    resetPluginAvailableCache();
    delete global.fetch;
});

// ---------------------------------------------------------------------------
// Guard 1 — plugin discovery honors qdrantScanned
// ---------------------------------------------------------------------------
describe('discoverViaPlugin × qdrantScanned', () => {
    it('keeps qdrant registry entries when the scan reports qdrantScanned:false', async () => {
        seedRegistry([QDRANT_KEY, VECTRA_KEY]);
        // Qdrant down: scan finds only the live vectra collection.
        mockPluginFetch({ success: true, qdrantScanned: false, collections: [VECTRA_LIVE] });

        await discoverExistingCollections(SETTINGS);

        const registry = getCollectionRegistry();
        expect(registry).toContain(QDRANT_KEY);                    // survived the outage
        expect(registry).not.toContain(VECTRA_KEY);                // vectra WAS scanned → genuinely stale → pruned
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Qdrant was not reachable'));
    });

    it('treats a missing qdrantScanned field (older plugin) as not-scanned', async () => {
        seedRegistry([QDRANT_KEY]);
        mockPluginFetch({ success: true, collections: [VECTRA_LIVE] }); // no qdrantScanned at all

        await discoverExistingCollections(SETTINGS);

        expect(getCollectionRegistry()).toContain(QDRANT_KEY);
    });

    it('still prunes a genuinely deleted qdrant collection when qdrantScanned:true', async () => {
        seedRegistry([QDRANT_KEY]);
        mockPluginFetch({ success: true, qdrantScanned: true, collections: [VECTRA_LIVE] });

        await discoverExistingCollections(SETTINGS);

        expect(getCollectionRegistry()).not.toContain(QDRANT_KEY);
    });
});

// ---------------------------------------------------------------------------
// Guard 2 — cleanupOrphanedMeta refuses the mass wipe
// ---------------------------------------------------------------------------
describe('cleanupOrphanedMeta outage refusal', () => {
    it('refuses to delete anything when discovery returned zero collections', () => {
        extension_settings.vectfox.collections = {
            [QDRANT_KEY]: { lockedToChatIds: ['chat-1'], triggers: ['dragon'] },
            [VECTRA_KEY]: { lockedToCharacterIds: ['2'] },
        };

        const result = cleanupOrphanedMeta([]);

        expect(result.refused).toBe(true);
        expect(result.removed).toBe(0);
        // The locks — the irreplaceable part — are untouched.
        expect(extension_settings.vectfox.collections[QDRANT_KEY].lockedToChatIds).toEqual(['chat-1']);
        expect(extension_settings.vectfox.collections[VECTRA_KEY].lockedToCharacterIds).toEqual(['2']);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
    });

    it('still prunes a real orphan when survivors exist, and names it in the log', () => {
        extension_settings.vectfox.collections = {
            [QDRANT_KEY]: { lockedToChatIds: ['chat-1'] },
            'standard:vf_document_gone_123': { name: 'deleted doc' },
        };

        const result = cleanupOrphanedMeta([QDRANT_KEY]);

        expect(result.refused).toBe(false);
        expect(result.removed).toBe(1);
        expect(result.orphanedIds).toEqual(['standard:vf_document_gone_123']);
        expect(extension_settings.vectfox.collections[QDRANT_KEY]).toBeDefined();
        expect(extension_settings.vectfox.collections['standard:vf_document_gone_123']).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('standard:vf_document_gone_123'));
    });

    it('no-ops cleanly when nothing is orphaned', () => {
        extension_settings.vectfox.collections = { [QDRANT_KEY]: { lockedToChatIds: ['chat-1'] } };

        const result = cleanupOrphanedMeta([QDRANT_KEY]);

        expect(result).toEqual({ removed: 0, orphanedIds: [], refused: false });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Guard 3 — fallback discovery (plugin unavailable)
// ---------------------------------------------------------------------------
describe('discoverViaFallback outage handling', () => {
    beforeEach(() => {
        // Plugin health check fails → discovery takes the fallback path.
        global.fetch = vi.fn(async () => { throw new Error('plugin not installed'); });
    });

    it('keeps qdrant entries without probing them — qdrant is unreachable without the plugin', async () => {
        seedRegistry([QDRANT_KEY]);

        await discoverExistingCollections(SETTINGS);

        expect(getCollectionRegistry()).toContain(QDRANT_KEY);
        // Never probed down the standard path — that probe would "find nothing" by construction.
        expect(getSavedHashes).not.toHaveBeenCalledWith(expect.stringContaining('worldlore'), expect.anything());
    });

    it('keeps a standard entry whose probe errored (unreachable ≠ deleted)', async () => {
        seedRegistry([VECTRA_KEY]);
        getSavedHashes.mockRejectedValue(new Error('ECONNREFUSED'));

        await discoverExistingCollections(SETTINGS);

        expect(getCollectionRegistry()).toContain(VECTRA_KEY);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not verify'));
    });

    it('still prunes a standard entry that verifiably has no data', async () => {
        seedRegistry([VECTRA_KEY]);
        getSavedHashes.mockResolvedValue([]); // probe succeeded, collection truly empty/absent

        await discoverExistingCollections(SETTINGS);

        expect(getCollectionRegistry()).not.toContain(VECTRA_KEY);
    });
});
