/**
 * Tests for warnIfEmbeddingSlow (core/embedding-latency-warning.js).
 *
 * Guards the contract that lets this be called unconditionally on every query:
 *   - absent timings (older Similharity plugin) are a silent no-op, NOT a crash,
 *   - fast embeds stay quiet,
 *   - slow embeds always log, and NEVER toast,
 *   - the message names the provider/model so the user knows what to change.
 *
 * The no-toast rule is load-bearing (GitHub issue #12). A slow-but-successful
 * embed costs the user nothing — the results arrive. The case that actually
 * costs them memory is the retrieval timing out, and core/bounded-retrieval.js
 * already raises a red error toast for that, naming this same provider. An
 * earlier orange toast on the success path just trained users to dismiss popups.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../core/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../core/providers.js', () => ({
    getModelFromSettings: (s) => s?.embedding_openrouter_model || '',
}));

import { warnIfEmbeddingSlow, slowEmbeddingWarnMs } from '../core/embedding-latency-warning.js';
import { RETRIEVAL_TIMEOUT_DEFAULT_MS } from '../core/constants.js';
import { log } from '../core/log.js';

const settings = { embedding_provider: 'openrouter', embedding_openrouter_model: 'qwen/qwen3-embedding-8b' };

/** Every toastr level, so a toast added at ANY severity fails these tests. */
function spyToastr() {
    globalThis.toastr = { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() };
    return globalThis.toastr;
}
function expectNoToast(t) {
    for (const [level, fn] of Object.entries(t)) {
        expect(fn, `toastr.${level} must not be called`).not.toHaveBeenCalled();
    }
}

let toastr;
beforeEach(() => {
    vi.clearAllMocks();
    toastr = spyToastr();
});
afterEach(() => { delete globalThis.toastr; });

describe('threshold', () => {
    it('sits at two thirds of the retrieval budget, not a free-standing number', () => {
        // The whole point is "approaching the cliff". Hard-coding it let the two
        // constants drift apart until the warning fired at a third of the budget.
        expect(slowEmbeddingWarnMs(settings)).toBe(Math.round(RETRIEVAL_TIMEOUT_DEFAULT_MS * (2 / 3)));
        expect(slowEmbeddingWarnMs(settings)).toBe(10000);
    });

    // The budget became a user setting in issue #16. A module-level constant
    // would have kept warning at 10s for someone who raised the budget to 60s,
    // reintroducing exactly the drift the test above exists to prevent.
    it('tracks the budget the user actually configured', () => {
        expect(slowEmbeddingWarnMs({ ...settings, retrieval_timeout_ms: 60000 })).toBe(40000);
        expect(slowEmbeddingWarnMs({ ...settings, retrieval_timeout_ms: 6000 })).toBe(4000);
    });

    it('stays quiet at 5s — a healthy local provider reaches that', () => {
        // Regression guard for issue #12: Ollama on a 10Gb LAN crosses 5s from
        // time to time while returning full results well inside the timeout.
        expect(warnIfEmbeddingSlow(5000, settings)).toBe(false);
        expect(warnIfEmbeddingSlow(9999, settings)).toBe(false);
        expect(log.warn).not.toHaveBeenCalled();
        expectNoToast(toastr);
    });
});

describe('warnIfEmbeddingSlow', () => {
    it('is a no-op when the plugin reported no timings (older plugin)', () => {
        for (const v of [undefined, null, NaN, 'slow']) {
            expect(warnIfEmbeddingSlow(v, settings)).toBe(false);
        }
        expect(log.warn).not.toHaveBeenCalled();
        expectNoToast(toastr);
    });

    it('stays quiet just under the threshold', () => {
        expect(warnIfEmbeddingSlow(slowEmbeddingWarnMs(settings) - 1, settings)).toBe(false);
        expect(log.warn).not.toHaveBeenCalled();
        expectNoToast(toastr);
    });

    it('logs a slow embed, naming provider + model and the real seconds', () => {
        expect(warnIfEmbeddingSlow(15252, settings)).toBe(true);

        const logged = log.warn.mock.calls[0][0];
        expect(logged).toContain('15.3s');
        expect(logged).toContain('openrouter');
        expect(logged).toContain('qwen/qwen3-embedding-8b');
        // Must exonerate the vector DB — misattributing this to Qdrant is what cost hours.
        expect(logged).toMatch(/vector database is NOT the bottleneck/i);
        // And it must quote the real budget, not a stale hard-coded "15s".
        expect(logged).toContain(`${(RETRIEVAL_TIMEOUT_DEFAULT_MS / 1000).toFixed(1)}s`);
    });

    it('NEVER toasts, at any severity, however slow the embed', () => {
        for (const ms of [10000, 14000, 60000]) {
            expect(warnIfEmbeddingSlow(ms, settings)).toBe(true);
        }
        expectNoToast(toastr);
    });

    it('logs every occurrence — the console keeps the full record, unthrottled', () => {
        for (let i = 0; i < 4; i++) expect(warnIfEmbeddingSlow(12000, settings)).toBe(true);
        expect(log.warn).toHaveBeenCalledTimes(4);
        expectNoToast(toastr);
    });

    it('falls back to the provider name when no model is configured', () => {
        warnIfEmbeddingSlow(12000, { embedding_provider: 'ollama' });
        const logged = log.warn.mock.calls[0][0];
        expect(logged).toContain('ollama');
        expect(logged).not.toContain('()'); // no empty parenthetical
    });

    it('survives a missing toastr (headless) after logging', () => {
        delete globalThis.toastr;
        expect(() => warnIfEmbeddingSlow(20000, settings)).not.toThrow();
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});
