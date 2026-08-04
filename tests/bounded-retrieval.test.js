/**
 * runBoundedRetrieval — the shared retrieval contract.
 *
 * Every retrieval path in VectFox (Lorebook WI, EventBase, chunk retrieval,
 * summarizer injection) runs through this one function so all four obey the same
 * three rules:
 *   1. bounded    — a hung embedding provider can never freeze a generation
 *   2. non-fatal  — a failed lookup degrades to a fallback, never breaks the turn
 *   3. surfaced   — the user is TOLD, rather than silently losing memory
 *
 * Rule 3 is why this exists. It used to live in five hand-copied try/catch blocks
 * and was missed in four of them (every EventBase/chunk path) plus re-dropped in
 * the Lorebook dry-run during a rebase. The failure is invisible in review: the
 * message still sends and the character just quietly forgets. These tests pin the
 * contract so a new retrieval path can't reintroduce the silence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 50ms stands in for the resolved budget so the timeout cases finish instantly.
// The real resolver (settings -> clamped ms, plus the Agent Mode addition) is
// covered on its own in tests/retrieval-budget.test.js.
vi.mock('../core/retrieval-budget.js', () => ({ resolveRetrievalTimeoutMs: () => 50 }));
vi.mock('../core/log.js', () => ({
    log: { error: vi.fn(), warn: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../core/model-config-notifier.js', () => ({ notifyRetrievalFailure: vi.fn() }));
// Real module reaches core/providers.js, which imports SillyTavern host modules.
vi.mock('../core/embedding-latency-warning.js', () => ({
    describeEmbeddingTimeoutCause: (s) => `Almost always the embedding provider — ${s?.embedding_provider || 'transformers'}.`,
}));

import { runBoundedRetrieval } from '../core/bounded-retrieval.js';
import { notifyRetrievalFailure } from '../core/model-config-notifier.js';
import { log } from '../core/log.js';

const OPTIONS = {
    contextLabel: 'EventBase',
    sourceName: 'event memory',
    timeoutMessage: 'EventBase retrieval timed out',
    settings: { embedding_provider: 'openrouter' },
};

const never = () => new Promise(() => {});           // hangs forever
const slow = (ms, value) => new Promise(r => setTimeout(() => r(value), ms));

beforeEach(() => vi.clearAllMocks());

describe('runBoundedRetrieval', () => {
    it('passes the resolved value straight through on success', async () => {
        const result = await runBoundedRetrieval(Promise.resolve(['hit']), { ...OPTIONS, fallback: [] });

        expect(result).toEqual(['hit']);
        expect(notifyRetrievalFailure).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    it('returns the fallback and surfaces a toast when the retrieval times out', async () => {
        const result = await runBoundedRetrieval(never(), { ...OPTIONS, fallback: [] });

        expect(result).toEqual([]);                                    // degraded, did not throw
        expect(notifyRetrievalFailure).toHaveBeenCalledTimes(1);       // and the user was told
        const [label, source, detail] = notifyRetrievalFailure.mock.calls[0];
        expect(label).toBe('EventBase');
        expect(source).toBe('event memory');
        expect(detail).toContain('EventBase retrieval timed out');
        expect(log.error).toHaveBeenCalledTimes(1);
    });

    // The whole point of the timeout branch: "timed out" alone names nothing the
    // user can change, so they read it as "the extension is broken".
    it('blames the embedding provider by name on a timeout', async () => {
        await runBoundedRetrieval(never(), { ...OPTIONS, fallback: [] });

        const [, , detail] = notifyRetrievalFailure.mock.calls[0];
        expect(detail).toContain('embedding provider');
        expect(detail).toContain('openrouter');
    });

    it('still names a provider when the caller passed no settings', async () => {
        const { settings, ...withoutSettings } = OPTIONS;
        await runBoundedRetrieval(never(), { ...withoutSettings, fallback: [] });

        expect(notifyRetrievalFailure.mock.calls[0][2]).toContain('transformers');
    });

    it('surfaces a rejection the same way as a timeout', async () => {
        const result = await runBoundedRetrieval(Promise.reject(new Error('ECONNREFUSED')), { ...OPTIONS, fallback: [] });

        expect(result).toEqual([]);
        expect(notifyRetrievalFailure).toHaveBeenCalledWith('EventBase', 'event memory', 'ECONNREFUSED');
    });

    // A connection refusal is not a latency problem — appending the embedding
    // explanation there would actively mislead.
    it('does not blame embedding for a non-timeout failure', async () => {
        await runBoundedRetrieval(Promise.reject(new Error('ECONNREFUSED')), { ...OPTIONS, fallback: [] });

        expect(notifyRetrievalFailure.mock.calls[0][2]).not.toContain('embedding provider');
    });

    it('never rethrows — a lookup failure must not break the generation', async () => {
        await expect(runBoundedRetrieval(Promise.reject(new Error('boom')), OPTIONS)).resolves.toBeUndefined();
    });

    it('returns undefined when no fallback is given (fire-and-forget callers)', async () => {
        const result = await runBoundedRetrieval(never(), OPTIONS);

        expect(result).toBeUndefined();
        expect(notifyRetrievalFailure).toHaveBeenCalledTimes(1);
    });

    it('honors an arbitrary fallback shape (the dry-run tester returns an object)', async () => {
        const shape = { injectionText: null, entryCount: 0 };
        const result = await runBoundedRetrieval(never(), { ...OPTIONS, contextLabel: 'Lorebook', fallback: shape });

        expect(result).toEqual(shape);
    });

    it('does not fire on work that finishes inside the budget', async () => {
        const result = await runBoundedRetrieval(slow(5, 'done'), { ...OPTIONS, fallback: null });

        expect(result).toBe('done');
        expect(notifyRetrievalFailure).not.toHaveBeenCalled();
    });

    // Issue #16: the toast said only "retrieval timed out", which names nothing
    // the user can change — and until the budget became a setting, nothing they
    // COULD change. Both halves of the answer have to be in the message.
    it('names the budget it blew and the setting that changes it', async () => {
        await runBoundedRetrieval(never(), { ...OPTIONS, fallback: [] });

        const [, , detail] = notifyRetrievalFailure.mock.calls[0];
        expect(detail).toContain('0.1s');                 // the 50ms mocked budget
        expect(detail).toContain('Retrieval Timeout');    // the setting's UI label
    });

    // Agent Mode runs a planner LLM call INSIDE this bound, so the EventBase call
    // site passes a bigger budget. Ignoring the override is what made agent mode
    // time out on its own defaults (planner 30s inside a 15s bound) — issue #16.
    it('honors an explicit timeoutMs over the settings-resolved budget', async () => {
        const result = await runBoundedRetrieval(slow(120, 'planner done'), { ...OPTIONS, fallback: [], timeoutMs: 400 });

        expect(result).toBe('planner done');              // would have died at the mocked 50ms
        expect(notifyRetrievalFailure).not.toHaveBeenCalled();
    });

    it('falls back to the settings budget when timeoutMs is absent or nonsense', async () => {
        for (const timeoutMs of [undefined, 0, -1, NaN, 'soon']) {
            vi.clearAllMocks();
            const result = await runBoundedRetrieval(slow(120, 'late'), { ...OPTIONS, fallback: [], timeoutMs });

            expect(result, `timeoutMs=${String(timeoutMs)}`).toEqual([]);   // 50ms budget won
            expect(notifyRetrievalFailure).toHaveBeenCalledTimes(1);
        }
    });

    it('reports each subsystem under its own label so the notifier de-dup stays per-source', async () => {
        await runBoundedRetrieval(never(), { contextLabel: 'Chat memory', sourceName: 'vectorized chunks', timeoutMessage: 'Chunk retrieval timed out', fallback: [] });
        await runBoundedRetrieval(never(), { contextLabel: 'Summarizer', sourceName: 'recent event summaries', timeoutMessage: 'Summarizer injection timed out' });

        expect(notifyRetrievalFailure.mock.calls.map(c => c[0])).toEqual(['Chat memory', 'Summarizer']);
    });
});
