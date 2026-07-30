/**
 * Tests for warnIfEmbeddingSlow (core/embedding-latency-warning.js).
 *
 * Guards the contract that lets this be called unconditionally on every query:
 *   - absent timings (older Similharity plugin) are a silent no-op, NOT a crash,
 *   - fast embeds stay quiet,
 *   - slow embeds always log, and toast at most once per throttle window,
 *   - the message names the provider/model so the user knows what to change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../core/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../core/providers.js', () => ({
    getModelFromSettings: (s) => s?.embedding_openrouter_model || '',
}));

import { warnIfEmbeddingSlow, SLOW_EMBEDDING_WARN_MS, _resetEmbeddingLatencyWarningThrottle } from '../core/embedding-latency-warning.js';
import { log } from '../core/log.js';

const settings = { embedding_provider: 'openrouter', embedding_openrouter_model: 'qwen/qwen3-embedding-8b' };

beforeEach(() => {
    vi.clearAllMocks();
    _resetEmbeddingLatencyWarningThrottle();
    globalThis.toastr = { warning: vi.fn() };
});
afterEach(() => { delete globalThis.toastr; });

describe('warnIfEmbeddingSlow', () => {
    it('is a no-op when the plugin reported no timings (older plugin)', () => {
        for (const v of [undefined, null, NaN, 'slow']) {
            expect(warnIfEmbeddingSlow(v, settings)).toBe(false);
        }
        expect(log.warn).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('stays quiet for a fast embed', () => {
        expect(warnIfEmbeddingSlow(SLOW_EMBEDDING_WARN_MS - 1, settings)).toBe(false);
        expect(log.warn).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('logs AND toasts a slow embed, naming provider + model and the real seconds', () => {
        expect(warnIfEmbeddingSlow(15252, settings)).toBe(true);

        const logged = log.warn.mock.calls[0][0];
        expect(logged).toContain('15.3s');
        expect(logged).toContain('openrouter');
        expect(logged).toContain('qwen/qwen3-embedding-8b');
        // Must exonerate the vector DB — misattributing this to Qdrant is what cost hours.
        expect(logged).toMatch(/vector database is NOT the bottleneck/i);

        const [body, title] = globalThis.toastr.warning.mock.calls[0];
        expect(body).toContain('15.3s');
        expect(title).toMatch(/slow embedding/i);
    });

    it('throttles the toast but never the log', () => {
        for (let i = 0; i < 4; i++) expect(warnIfEmbeddingSlow(9000, settings)).toBe(true);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1); // throttled
        expect(log.warn).toHaveBeenCalledTimes(4);                  // full record kept
    });

    it('falls back to the provider name when no model is configured', () => {
        warnIfEmbeddingSlow(9000, { embedding_provider: 'ollama' });
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
