/**
 * eventbase-settle-lag.test.js — unit tests for the auto-sync settle/commit lag.
 *
 * Covers the PURE boundary math (getCommitBoundary / getAutoSyncWindowSize) that
 * is the single source of truth shared by the window-builder, the quick-exit, and
 * the LED/counter. The end-to-end "swipe N times → 0 events, then supersede → 1
 * event" behavior lives in the Playwright suite (Eventbase-test.spec.js, TEST 016)
 * because it needs a live ST session.
 *
 * Isolation: eventbase-workflow.js transitively imports ST modules (script.js,
 * extensions.js, …) that don't resolve under vitest. We mock the whole import
 * graph with empty stubs — the functions under test use none of it. Same approach
 * as summarizer-injection.test.js.
 *
 * See plans/autosync-settle-lag.md.
 */
import { describe, it, expect, vi } from 'vitest';

// ST-rooted modules (won't resolve in node) + every sibling the workflow pulls in.
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
    resolveEventBaseWriteTarget: vi.fn(),
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../core/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({ isCollectionEnabled: vi.fn(), isCollectionLockedToChat: vi.fn(), setCollectionLock: vi.fn(), setCollectionMeta: vi.fn() }));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../core/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

const { getCommitBoundary, getAutoSyncWindowSize } = await import('../core/eventbase-workflow.js');

const msgs = (n) => Array.from({ length: n }, (_, i) => ({ mes: `m${i}`, name: i % 2 ? 'AI' : 'User' }));

describe('getAutoSyncWindowSize', () => {
    it('defaults to 1 turn = 2 messages', () => {
        expect(getAutoSyncWindowSize({})).toBe(2);
        expect(getAutoSyncWindowSize(undefined)).toBe(2);
    });
    it('scales turns → messages and clamps to [1,20] turns', () => {
        expect(getAutoSyncWindowSize({ eventbase_autosync_window_turns: 3 })).toBe(6);
        expect(getAutoSyncWindowSize({ eventbase_autosync_window_turns: 0 })).toBe(2);   // clamp up to 1
        expect(getAutoSyncWindowSize({ eventbase_autosync_window_turns: 99 })).toBe(40); // clamp down to 20
    });
});

describe('getCommitBoundary (settle/commit lag)', () => {
    it('holds back exactly one turn (2 msgs) by default', () => {
        expect(getCommitBoundary(msgs(10), {})).toBe(8);
        expect(getCommitBoundary(msgs(100), {})).toBe(98);
    });

    it('holds back the configured auto-sync window size', () => {
        expect(getCommitBoundary(msgs(20), { eventbase_autosync_window_turns: 3 })).toBe(14); // 20 - 6
    });

    it('treats absent/true setting as ON (existing users get the lag)', () => {
        expect(getCommitBoundary(msgs(10), { eventbase_autosync_settle_lag: true })).toBe(8);
        expect(getCommitBoundary(msgs(10), {})).toBe(8);
    });

    it('disables the lag only on an explicit false', () => {
        expect(getCommitBoundary(msgs(10), { eventbase_autosync_settle_lag: false })).toBe(10);
    });

    it('never returns negative for short chats', () => {
        expect(getCommitBoundary(msgs(1), {})).toBe(0);
        expect(getCommitBoundary(msgs(0), {})).toBe(0);
        expect(getCommitBoundary([], {})).toBe(0);
    });

    it('handles a non-array defensively', () => {
        expect(getCommitBoundary(undefined, {})).toBe(0);
        expect(getCommitBoundary(null, { eventbase_autosync_settle_lag: false })).toBe(0);
    });

    it('self-correction: a new turn moves the boundary forward by one turn', () => {
        // 50 turns extracted up to boundary 98; user sends turn 51 → length 102.
        expect(getCommitBoundary(msgs(100), {})).toBe(98);
        expect(getCommitBoundary(msgs(102), {})).toBe(100); // previously-held turn now eligible
    });
});
