/**
 * Unit tests for countUnfinishedWindows — the answer both run-reporting callers
 * need, and both used to skip.
 *
 * Issue #14 turned out to be two layers of the same silence. The inner layer
 * (eventbase-workflow) counted an errored window as "processed", so an all-failed
 * run finished green. The outer layer (chat-vectorization / content-vectorizer)
 * then called progressTracker.complete(true, …) unconditionally, overwriting even
 * a correct complete(false, …) underneath it. Fixing only the inner layer would
 * have left the green tick exactly where the user sees it.
 */

import { describe, it, expect, vi } from 'vitest';

// eventbase-workflow.js transitively imports ST modules that don't resolve under
// vitest, so the whole graph is stubbed — the pure helper under test uses none of
// it. Same harness as eventbase-settle-lag.test.js, which covers this module's
// other pure helpers.
vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: vi.fn(), substituteParams: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: {}, getContext: vi.fn(() => ({ chat: [] })) }));
vi.mock('../core/collection-ids.js', () => ({ getChatUUID: vi.fn(), parseRegistryKey: vi.fn(), COLLECTION_PREFIXES: {}, buildRegistryKey: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn(), getSavedHashes: vi.fn() }));
vi.mock('../core/constants.js', () => ({ EXTENSION_PROMPT_TAG: '3_vectfox' }));
vi.mock('../core/eventbase-schema.js', () => ({ EventBaseFatalError: class {}, EventBaseExtractionError: class {} }));
vi.mock('../core/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: {} }));
vi.mock('../core/eventbase-store.js', () => ({
    insertEvents: vi.fn(), isWindowAlreadyExtracted: vi.fn(), markWindowExtracted: vi.fn(),
    clearExtractionCachesForChat: vi.fn(), buildEventBaseCollectionId: vi.fn(), isLastWindowExtracted: vi.fn(),
    setVectorizationTip: vi.fn(), ensureVectorizationTip: vi.fn(), shouldUseTipFallback: vi.fn(),
    resolveActiveEventBaseCollection: vi.fn(),
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../core/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({ isCollectionEnabled: vi.fn(), isCollectionLockedToChat: vi.fn(), setCollectionLock: vi.fn(), setCollectionMeta: vi.fn() }));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../core/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

const { countUnfinishedWindows } = await import('../core/eventbase-workflow.js');

describe('countUnfinishedWindows', () => {
    it('reports a clean run as having nothing unfinished', () => {
        expect(countUnfinishedWindows({
            eventsExtracted: 12, windowsProcessed: 4, windowsSkipped: 0, windowsTimedOut: 0, windowsFailed: 0,
        })).toBe(0);
    });

    // The shape observed live: 8192-token cap, 2 windows fine, 1 timed out.
    // The old code reported "✅ Vectorization complete" over this.
    it('counts a timed-out window even when other windows succeeded', () => {
        expect(countUnfinishedWindows({
            eventsExtracted: 3, windowsProcessed: 2, windowsSkipped: 0, windowsTimedOut: 1, windowsFailed: 0,
        })).toBe(1);
    });

    // The shape originally reported: every window fails, nothing is stored.
    it('counts failed windows', () => {
        expect(countUnfinishedWindows({
            eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0, windowsTimedOut: 0, windowsFailed: 3,
        })).toBe(3);
    });

    it('adds the two kinds together — they are independent failure modes', () => {
        expect(countUnfinishedWindows({ windowsTimedOut: 2, windowsFailed: 3 })).toBe(5);
    });

    // A dedup-only run skips windows deliberately; that is not a failure and must
    // not turn the report red.
    it('does not treat deliberately skipped windows as unfinished', () => {
        expect(countUnfinishedWindows({
            eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 40, windowsTimedOut: 0, windowsFailed: 0,
        })).toBe(0);
    });

    // Early returns in the workflow omit the counters entirely.
    it('treats missing counters and a missing result as nothing unfinished', () => {
        expect(countUnfinishedWindows({ eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 })).toBe(0);
        expect(countUnfinishedWindows(null)).toBe(0);
        expect(countUnfinishedWindows(undefined)).toBe(0);
    });
});
