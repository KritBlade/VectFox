/**
 * runBoundedRetrieval — the shared retrieval contract.
 *
 * Both retrievals a reply runs, EventBase's and the Summarizer injection, go through this one function, so both obey
 * the same four rules:
 *   1. bounded    — a hung embedding provider can never freeze a generation
 *   2. non-fatal  — a failed lookup degrades to a fallback, never breaks the turn
 *   3. surfaced   — the user is TOLD, rather than silently losing memory
 *   4. not late   — a retrieval that settles past its bound finds its run ended, so it publishes nothing
 *
 * Rule 3 is why this exists: a missing "also surface it" is invisible in review, as the message still sends and the
 * character just quietly forgets. These tests pin the contract so a new retrieval path can't reintroduce the silence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 50ms stands in for the resolved budget so the timeout cases finish instantly.
// The real resolver (settings -> clamped ms, plus the Agent Mode addition) is
// covered on its own in tests/retrieval-budget.test.js.
vi.mock('../src/shared/retrieval-budget.js', () => ({ resolveRetrievalTimeoutMs: () => 50 }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { error: vi.fn(), warn: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../src/shared/model-config-notifier.js', () => ({ notifyRetrievalFailure: vi.fn() }));
// Real module reaches src/features/embedding/providers.js, which imports SillyTavern host modules.
vi.mock('../src/features/embedding/embedding-latency-warning.js', () => ({
    describeEmbeddingTimeoutCause: (s) => `Almost always the embedding provider — ${s?.embedding_provider || 'transformers'}.`,
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../../script.js', () => ({}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

import { UNBOUNDED_RUN, runBoundedRetrieval } from '../src/features/vector-backend/bounded-retrieval.js';
import { notifyRetrievalFailure } from '../src/shared/model-config-notifier.js';
import { log } from '../src/sillytavern/log.js';

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
        const result = await runBoundedRetrieval(() => Promise.resolve(['hit']), { ...OPTIONS, fallback: [] });

        expect(result).toEqual(['hit']);
        expect(notifyRetrievalFailure).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    it('returns the fallback and surfaces a toast when the retrieval times out', async () => {
        const result = await runBoundedRetrieval(never, { ...OPTIONS, fallback: [] });

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
        await runBoundedRetrieval(never, { ...OPTIONS, fallback: [] });

        const [, , detail] = notifyRetrievalFailure.mock.calls[0];
        expect(detail).toContain('embedding provider');
        expect(detail).toContain('openrouter');
    });

    it('still names a provider when the caller passed no settings', async () => {
        const { settings, ...withoutSettings } = OPTIONS;
        await runBoundedRetrieval(never, { ...withoutSettings, fallback: [] });

        expect(notifyRetrievalFailure.mock.calls[0][2]).toContain('transformers');
    });

    it('surfaces a rejection the same way as a timeout', async () => {
        const result = await runBoundedRetrieval(() => Promise.reject(new Error('ECONNREFUSED')), { ...OPTIONS, fallback: [] });

        expect(result).toEqual([]);
        expect(notifyRetrievalFailure).toHaveBeenCalledWith('EventBase', 'event memory', 'ECONNREFUSED');
    });

    it('surfaces a retrieval that throws as it starts the same way as a rejection', async () => {
        const result = await runBoundedRetrieval(() => { throw new Error('ECONNREFUSED'); }, { ...OPTIONS, fallback: [] });

        expect(result).toEqual([]);
        expect(notifyRetrievalFailure).toHaveBeenCalledWith('EventBase', 'event memory', 'ECONNREFUSED');
    });

    // A connection refusal is not a latency problem — appending the embedding
    // explanation there would actively mislead.
    it('does not blame embedding for a non-timeout failure', async () => {
        await runBoundedRetrieval(() => Promise.reject(new Error('ECONNREFUSED')), { ...OPTIONS, fallback: [] });

        expect(notifyRetrievalFailure.mock.calls[0][2]).not.toContain('embedding provider');
    });

    it('never rethrows — a lookup failure must not break the generation', async () => {
        await expect(runBoundedRetrieval(() => Promise.reject(new Error('boom')), OPTIONS)).resolves.toBeUndefined();
    });

    it('returns undefined when no fallback is given (fire-and-forget callers)', async () => {
        const result = await runBoundedRetrieval(never, OPTIONS);

        expect(result).toBeUndefined();
        expect(notifyRetrievalFailure).toHaveBeenCalledTimes(1);
    });

    it('honors an arbitrary fallback shape (the dry-run tester returns an object)', async () => {
        const shape = { injectionText: null, eventCount: 0 };
        const result = await runBoundedRetrieval(never, { ...OPTIONS, fallback: shape });

        expect(result).toEqual(shape);
    });

    it('does not fire on work that finishes inside the budget', async () => {
        const result = await runBoundedRetrieval(() => slow(5, 'done'), { ...OPTIONS, fallback: null });

        expect(result).toBe('done');
        expect(notifyRetrievalFailure).not.toHaveBeenCalled();
    });

    // Issue #16: the toast said only "retrieval timed out", which names nothing
    // the user can change — and until the budget became a setting, nothing they
    // COULD change. Both halves of the answer have to be in the message.
    it('names the budget it blew and the setting that changes it', async () => {
        await runBoundedRetrieval(never, { ...OPTIONS, fallback: [] });

        const [, , detail] = notifyRetrievalFailure.mock.calls[0];
        expect(detail).toContain('0.1s');                 // the 50ms mocked budget
        expect(detail).toContain('"Retrieval timeout" on the Core page');    // the setting's UI label and page
    });

    // Agent Mode runs a planner LLM call INSIDE this bound, so the EventBase call
    // site passes a bigger budget (issue #16).
    it('honors an explicit timeoutMs over the settings-resolved budget', async () => {
        const result = await runBoundedRetrieval(() => slow(120, 'planner done'), { ...OPTIONS, fallback: [], timeoutMs: 400 });

        expect(result).toBe('planner done');              // would have died at the mocked 50ms
        expect(notifyRetrievalFailure).not.toHaveBeenCalled();
    });

    it('falls back to the settings budget when timeoutMs is absent or nonsense', async () => {
        for (const timeoutMs of [undefined, 0, -1, NaN, 'soon']) {
            vi.clearAllMocks();
            const result = await runBoundedRetrieval(() => slow(120, 'late'), { ...OPTIONS, fallback: [], timeoutMs });

            expect(result, `timeoutMs=${String(timeoutMs)}`).toEqual([]);   // 50ms budget won
            expect(notifyRetrievalFailure).toHaveBeenCalledTimes(1);
        }
    });

    it('reports each subsystem under its own label so the notifier de-dup stays per-source', async () => {
        await runBoundedRetrieval(never, { contextLabel: 'EventBase', sourceName: 'event memory', timeoutMessage: 'EventBase retrieval timed out', fallback: [] });
        await runBoundedRetrieval(never, { contextLabel: 'Summarizer', sourceName: 'recent event summaries', timeoutMessage: 'Summarizer injection timed out' });

        expect(notifyRetrievalFailure.mock.calls.map(c => c[0])).toEqual(['EventBase', 'Summarizer']);
    });
});

describe('the bounded run a retrieval gets', () => {
    // Issue #28: the reply goes without a retrieval that missed its bound, and the retrieval must not publish when it
    // settles later.
    it('is current until the bound passes, and has ended from then on', async () => {
        let boundedRun;
        let settle;
        const result = runBoundedRetrieval(run => {
            boundedRun = run;
            return new Promise(resolve => { settle = resolve; });
        }, { ...OPTIONS, fallback: 'without memory' });

        expect(boundedRun.isCurrent()).toBe(true);
        await expect(result).resolves.toBe('without memory');
        expect(boundedRun.isCurrent()).toBe(false);

        settle(['a late hit']);
        await slow(0);
        expect(boundedRun.isCurrent()).toBe(false);
    });

    it('stays current once the retrieval settled in time, after the budget would have passed', async () => {
        let boundedRun;
        await runBoundedRetrieval(run => {
            boundedRun = run;
            return Promise.resolve(['hit']);
        }, OPTIONS);

        await slow(80);                                   // past the mocked 50ms budget
        expect(boundedRun.isCurrent()).toBe(true);
    });

    it('is a run of its own for each retrieval', async () => {
        const runs = [];
        await runBoundedRetrieval(run => { runs.push(run); return never(); }, OPTIONS);
        await runBoundedRetrieval(run => { runs.push(run); return Promise.resolve('found'); }, OPTIONS);

        expect(runs.map(run => run.isCurrent())).toEqual([false, true]);
    });

    it('is always current for a retrieval no bound limits, such as the Query Tester\'s preview', () => {
        expect(UNBOUNDED_RUN.isCurrent()).toBe(true);
    });
});
