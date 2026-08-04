/**
 * Unit tests for callWithHedge — the embedding/insert retry race in
 * core/core-vector-api.js.
 *
 * The hedge was built for attempts that HANG (connection-level routing stalls on
 * multi-upstream providers), so it fires duplicates on a fixed clock. A fast
 * FAILURE is a different animal, and the clock was the wrong instrument for it:
 * observed 2026-08-04, an insert that 500'd after 0.7s left the batch idle for
 * 14.3s waiting for its t=15s slot, while the log claimed "primary still slow"
 * about an attempt that had already died.
 *
 * These tests pin both behaviours at once — the schedule still governs slowness,
 * failures short-circuit it — plus the invariants that keeps: no slot fires twice,
 * and the attempt count stays at maxHedges + 1.
 *
 * Isolation: core-vector-api.js reaches ST modules that don't resolve under
 * vitest, so the whole import graph is stubbed. callWithHedge touches none of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, modules: [] }));
vi.mock('../../../../secrets.js', () => ({ secret_state: {}, SECRET_KEYS: {}, findSecret: vi.fn(), writeSecret: vi.fn() }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => false }));
vi.mock('../providers/webllm.js', () => ({ getWebLlmProvider: vi.fn() }));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(), getBackendForCollection: vi.fn(), invalidateBackendHealth: vi.fn(),
    recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn(),
}));
vi.mock('../core/log.js', () => ({
    log: new Proxy({}, { get: () => () => {} }),
}));

const { callWithHedge } = await import('../core/core-vector-api.js');

const THRESHOLD = 15000;
const MAX_HEDGES = 3;
const ctx = { debugOn: false, batchIdx: 1, totalBatches: 1, provider: 'openrouter' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Resolve/reject on demand so a test controls exactly when each attempt settles. */
function deferredQueue() {
    const calls = [];
    const fn = () => {
        let resolveIt, rejectIt;
        const promise = new Promise((res, rej) => { resolveIt = res; rejectIt = rej; });
        calls.push({ resolveIt, rejectIt });
        return promise;
    };
    return { fn, calls };
}

describe('callWithHedge — the slow path it was built for', () => {
    it('does not fire a hedge when the primary answers', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);
        expect(calls).toHaveLength(1);
        calls[0].resolveIt('stored');
        await expect(race).resolves.toBe('stored');

        await vi.advanceTimersByTimeAsync(THRESHOLD * (MAX_HEDGES + 1));
        expect(calls).toHaveLength(1); // timers must be dead after settling
    });

    it('still fires on the clock when an attempt hangs rather than failing', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);

        await vi.advanceTimersByTimeAsync(THRESHOLD - 1);
        expect(calls).toHaveLength(1); // nothing failed, so nothing is brought forward
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(2); // hedge 1 at its slot

        calls[1].resolveIt('stored by hedge');
        await expect(race).resolves.toBe('stored by hedge');
    });
});

describe('callWithHedge — a failure short-circuits the clock', () => {
    it('brings the next hedge forward instead of waiting for its slot', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);

        // Primary dies almost immediately, as the observed 500 did.
        calls[0].rejectIt(new Error('500 Internal Server Error'));
        await vi.advanceTimersByTimeAsync(0);

        expect(calls).toHaveLength(2); // hedge 1 already in flight, 15s early

        calls[1].resolveIt('stored');
        await expect(race).resolves.toBe('stored');
    });

    it('does not let the clock re-fire a slot that failure already used', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);

        calls[0].rejectIt(new Error('boom'));
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);

        // t=15s arrives — hedge 1's original slot. It must be a no-op.
        await vi.advanceTimersByTimeAsync(THRESHOLD);
        expect(calls).toHaveLength(2);

        calls[1].resolveIt('stored');
        await expect(race).resolves.toBe('stored');
    });

    it('never exceeds maxHedges + 1 attempts even when every one fails instantly', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);
        race.catch(() => {}); // handled below

        for (let i = 0; i < MAX_HEDGES + 1; i++) {
            calls[i].rejectIt(new Error(`fail ${i}`));
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(calls).toHaveLength(MAX_HEDGES + 1);

        await vi.advanceTimersByTimeAsync(THRESHOLD * (MAX_HEDGES + 2));
        expect(calls).toHaveLength(MAX_HEDGES + 1);
    });

    // Previously this waited out the full 60s cutoff with nothing in flight.
    it('reports hedge-fatal as soon as the last attempt fails, not at the cutoff', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);
        const outcome = race.then(() => 'resolved', (e) => e);

        for (let i = 0; i < MAX_HEDGES + 1; i++) {
            calls[i].rejectIt(new Error(`fail ${i}`));
            await vi.advanceTimersByTimeAsync(0);
        }

        // No timer advance to the cutoff — the rejection must already be there.
        const err = await outcome;
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('HedgeFatalError');
        expect(err.isHedgeFatal).toBe(true);
        expect(err.message).toMatch(/fail 3/); // carries the last error
    });

    // A late failure must not cancel a hedge that is still running and may yet win.
    it('keeps waiting when attempts are still in flight after a failure', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);

        calls[0].rejectIt(new Error('primary died'));
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);

        // Hedge 1 is still running; hedge 2 arrives on its own slot and wins.
        await vi.advanceTimersByTimeAsync(THRESHOLD * 2);
        expect(calls.length).toBeGreaterThanOrEqual(3);
        calls[2].resolveIt('late win');
        await expect(race).resolves.toBe('late win');
    });
});

describe('callWithHedge — user abort', () => {
    it('settles immediately and fires no further attempts', async () => {
        const { fn, calls } = deferredQueue();
        const race = callWithHedge(fn, THRESHOLD, MAX_HEDGES, ctx);
        const outcome = race.then(() => 'resolved', (e) => e);

        const abort = new Error('aborted');
        abort.name = 'AbortError';
        calls[0].rejectIt(abort);
        await vi.advanceTimersByTimeAsync(0);

        expect(await outcome).toBe(abort);
        await vi.advanceTimersByTimeAsync(THRESHOLD * (MAX_HEDGES + 1));
        expect(calls).toHaveLength(1); // no early hedge, no scheduled hedge
    });
});
