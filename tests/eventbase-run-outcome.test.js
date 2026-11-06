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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// eventbase-workflow.js transitively imports ST modules that don't resolve under
// vitest, so the whole graph is stubbed — the pure helper under test uses none of
// it. Same harness as eventbase-settle-lag.test.js, which covers this module's
// other pure helpers.
vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: vi.fn(), substituteParams: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: {}, getContext: vi.fn(() => ({ chat: [] })) }));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: vi.fn(), parseRegistryKey: vi.fn(), COLLECTION_PREFIXES: {}, buildRegistryKey: vi.fn() }));
vi.mock('../src/features/collections/collection-loader.js', () => ({ getCollectionRegistry: vi.fn() }));
vi.mock('../src/features/vector-backend/vector-api.js', () => ({ queryCollection: vi.fn(), getSavedHashes: vi.fn() }));
vi.mock('../src/shared/constants.js', () => ({ EVENTBASE_PROMPT_TAG: '3_vectfox_eventbase' }));
vi.mock('../src/features/eventbase/eventbase-schema.js', () => ({ EventBaseFatalError: class {}, EventBaseExtractionError: class {} }));
vi.mock('../src/features/eventbase/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../src/features/eventbase/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: {} }));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    insertEvents: vi.fn(), isWindowAlreadyExtracted: vi.fn(), markWindowExtracted: vi.fn(),
    clearExtractionCachesForChat: vi.fn(), buildEventBaseCollectionId: vi.fn(), isLastWindowExtracted: vi.fn(), getVectorizationTip: vi.fn(),
    setVectorizationTip: vi.fn(), ensureVectorizationTip: vi.fn(), shouldUseTipFallback: vi.fn(),
    resolveEventBaseWriteTarget: vi.fn(),
}));
vi.mock('../src/features/eventbase/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ retrieveEventsForTurn: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../src/features/collections/collection-metadata.js', () => ({ isCollectionEnabled: vi.fn(), isCollectionLockedToChat: vi.fn(), setCollectionLock: vi.fn(), setCollectionMeta: vi.fn() }));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));

const { countUnfinishedWindows, notifyUnfinishedWindows } = await import('../src/features/eventbase/eventbase-workflow.js');

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

describe('notifyUnfinishedWindows', () => {
    const run = (extra) => ({ eventsExtracted: 40, windowsProcessed: 30, windowsFailed: 2, firstFailureDetail: 'the first reason', ...extra });

    beforeEach(() => {
        globalThis.toastr = { error: vi.fn(), warning: vi.fn() };
    });

    it('asks the player to act with a sticky warning, naming the reason and what sends them again', () => {
        notifyUnfinishedWindows(run());

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        const [message, , options] = globalThis.toastr.warning.mock.calls[0];
        expect(message).toContain('extracted 40 events from 30 windows, but 2 window(s) kept failing');
        expect(message).toContain('First error: the first reason');
        expect(message).toContain('Resume in Vectorize Content');
        expect(options).toEqual({ timeOut: 0, extendedTimeOut: 0 });
    });

    it('says what to change when windows timed out', () => {
        notifyUnfinishedWindows(run({ windowsFailed: 0, windowsTimedOut: 3, firstFailureDetail: null }));

        const [message] = globalThis.toastr.warning.mock.calls[0];
        expect(message).toContain('3 timed out: raise "Extraction Timeout"');
        expect(message).not.toContain('First error');
    });

    it('takes its next step and options from the caller', () => {
        notifyUnfinishedWindows(run(), 'The next turn sends them again.', { timeOut: 15000 });

        const [message, , options] = globalThis.toastr.warning.mock.calls[0];
        expect(message).toContain('The next turn sends them again.');
        expect(options).toEqual({ timeOut: 15000 });
    });

    // Nothing got through, so the run achieved nothing and the fault is not those windows.
    it('goes red only when many windows failed and none got through', () => {
        notifyUnfinishedWindows(run({ windowsProcessed: 0, windowsFailed: 9 }));
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('stays a warning for a few windows that were all a run had left', () => {
        notifyUnfinishedWindows(run({ windowsProcessed: 0, windowsFailed: 1 }));
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });
});
