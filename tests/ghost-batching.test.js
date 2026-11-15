/**
 * Ghosting in whole batches — the wipe boundary moves only every N messages so the
 * prompt's leading prefix stays byte-identical between turns (provider prompt caching
 * can reuse it). Locks in the contract from the fork:
 *   - batch 1 is today's rolling behaviour (the boundary moves every turn);
 *   - batch > 1 snaps the boundary DOWN to a multiple of the batch size;
 *   - a stored value outside 1..100 clamps, so a hand-edited settings.json can never put
 *     the boundary on a grid the slider cannot show;
 *   - the published readout carries step / boundary / raw window / next jump;
 *   - every wipe bound (vectorization tip, kept-recent floor, World Info floor, current
 *     turn) still holds with batching on.
 *
 * summarizer-injection.js's imports are mocked (same pattern as summarizer-injection.test.js).
 */
/* global window -- applyGhosting publishes its readout on the page's global */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted lifts these so the (also-hoisted) vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
    setExtensionPrompt: vi.fn(),
    getChatUUID: vi.fn(() => 'uuid-1'),
    getVectorizationTip: vi.fn(),
    getWorldInfoSettings: vi.fn(() => ({})),
    getSortedEntries: vi.fn(async () => []),
    getContext: vi.fn(() => ({ chat: [], symbols: { ignore: Symbol('ignore') } })),
}));

vi.mock('../../../../../script.js', () => ({ setExtensionPrompt: mocks.setExtensionPrompt }));
// Host modules ST provides at runtime but that don't exist in the repo — stub the
// import graph the same way summarizer-injection.test.js does.
vi.mock('../../../../extensions.js', () => ({ getContext: mocks.getContext }));
vi.mock('../../../../world-info.js', () => ({
    getWorldInfoSettings: mocks.getWorldInfoSettings,
    getSortedEntries: mocks.getSortedEntries,
}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({
    getBackend: vi.fn(async () => ({ listChunks: vi.fn(async () => []) })),
}));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: mocks.getChatUUID }));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    resolveActiveEventBaseCollection: vi.fn(),
    getVectorizationTip: mocks.getVectorizationTip,
}));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn() {}, error() {}, domain() {}, trace() {}, verbose() {}, lifecycle() {}, enabled: () => false },
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

import { applyGhosting } from '../src/features/eventbase/summarizer-injection.js';

/** Build a prompt-array of n content-bearing messages. */
function makeChat(n) {
    return Array.from({ length: n }, (_, i) => ({ mes: `Message ${i}`, extra: {} }));
}

/**
 * Point getContext at a full chat of `n` non-system messages so applyGhosting's
 * index-space translation counts them as vectorized.
 */
function contextWith(n) {
    mocks.getContext.mockReturnValue({
        chat: makeChat(n),
        symbols: { ignore: Symbol('ignore') },
    });
}

/** Enabled ghosting settings with the batch size under test. */
function ghostSettings(step, overrides = {}) {
    return {
        eventbase_ghost_enabled: true,
        summarizer_injection_enabled: true,
        eventbase_ghost_keep_recent: 10,
        eventbase_ghost_step: step,
        ...overrides,
    };
}

/**
 * Replay consecutive generations: each turn appends a user + AI message, then runs
 * applyGhosting on a fresh prompt copy (ST hands the interceptor a working copy, not
 * the live chat). Returns the outgoing prompt text and published boundary per turn.
 */
function replayTurns(step, turns, overrides = {}) {
    const history = [];
    const chat = makeChat(12);
    for (let t = 0; t < turns; t++) {
        chat.push({ mes: `User ${t}`, extra: {} }, { mes: `AI ${t}`, extra: {} });
        contextWith(chat.length);
        mocks.getVectorizationTip.mockReturnValue(chat.length);
        const prompt = chat.map(m => ({ ...m, extra: { ...m.extra } }));
        applyGhosting(prompt, ghostSettings(step, overrides));
        history.push({
            text: prompt.map(m => m.mes).join('\n'),
            cutoff: window.VectFox_LastGhost.cutoff,
        });
    }
    return history;
}

describe('applyGhosting — cache-friendliness across turns', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        mocks.getWorldInfoSettings.mockReturnValue({});
    });

    it('keeps the whole previous prompt as a prefix between batch jumps', () => {
        // 25 turns of two messages, starting at 12: boundaries land on 20/30/40/50/60.
        const turns = replayTurns(10, 25);

        const shared = turns.slice(1).filter((t, i) => t.text.startsWith(turns[i].text)).length;
        // 24 transitions, 5 jumps, so 19 turns reuse the entire previous prompt.
        expect(shared).toBe(19);
        for (const t of turns) expect(t.cutoff % 10).toBe(0);
    });

    it('moves the first raw message every turn at batch size 1', () => {
        const turns = replayTurns(1, 25);

        const shared = turns.slice(1).filter((t, i) => t.text.startsWith(turns[i].text)).length;
        expect(shared).toBe(0);
        const cutoffs = turns.map(t => t.cutoff);
        for (let i = 1; i < cutoffs.length; i++) expect(cutoffs[i]).toBeGreaterThan(cutoffs[i - 1]);
    });
});

describe('applyGhosting — batch size bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        mocks.getWorldInfoSettings.mockReturnValue({});
    });

    it('clamps a stored batch size above the slider maximum', () => {
        const chat = makeChat(500);
        contextWith(500);
        mocks.getVectorizationTip.mockReturnValue(500);

        applyGhosting(chat, ghostSettings(1000));

        // keepFloor 10 -> rolling boundary 490 -> snapped down to the 100-message grid.
        expect(window.VectFox_LastGhost).toMatchObject({ step: 100, cutoff: 400, rawKept: 100 });
        expect(chat.slice(0, 400).every(m => m.mes === '')).toBe(true);
        expect(chat.slice(400).every((m, i) => m.mes === `Message ${i + 400}`)).toBe(true);
    });
});

describe('applyGhosting — batching regression (step = 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        mocks.getWorldInfoSettings.mockReturnValue({});
    });

    it('keeps today\'s rolling boundary when step is 1', () => {
        const chat = makeChat(20);
        contextWith(20);
        mocks.getVectorizationTip.mockReturnValue(20);

        const settings = {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 1,
        };

        // keepFloor = max(10, 1, 0) = 10; cutoff = min(20, 20 - 10) = 10.
        const result = applyGhosting(chat, settings);

        expect(result.wiped).toBe(10);
        for (let i = 0; i < 10; i++) expect(chat[i].mes).toBe('');
        for (let i = 10; i < 20; i++) expect(chat[i].mes).toBe(`Message ${i}`);
    });

    it('falls back to rolling when step is missing or invalid', () => {
        for (const step of [0, -5, NaN, 'abc', undefined]) {
            const chat = makeChat(20);
            contextWith(20);
            mocks.getVectorizationTip.mockReturnValue(20);

            const result = applyGhosting(chat, {
                eventbase_ghost_enabled: true,
                summarizer_injection_enabled: true,
                eventbase_ghost_keep_recent: 10,
                eventbase_ghost_step: step,
            });

            expect(result.wiped, `step=${String(step)}`).toBe(10);
        }
    });
});

describe('applyGhosting — batched boundary (step > 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        mocks.getWorldInfoSettings.mockReturnValue({});
    });

    it('snaps the wipe boundary down and publishes the raw-window readout', () => {
        const chat = makeChat(25);
        contextWith(25);
        mocks.getVectorizationTip.mockReturnValue(25);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(10);
        expect(chat.slice(0, 10).every(m => m.mes === '')).toBe(true);
        expect(chat.slice(10).every((m, i) => m.mes === `Message ${i + 10}`)).toBe(true);
        expect(window.VectFox_LastGhost).toMatchObject({ step: 10, cutoff: 10, rawKept: 15, nextJumpIn: 5 });
    });

    it('waits for the first full batch before wiping', () => {
        const chat = makeChat(19);
        contextWith(19);
        mocks.getVectorizationTip.mockReturnValue(19);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(0);
        expect(chat.every((m, i) => m.mes === `Message ${i}`)).toBe(true);
        expect(window.VectFox_LastGhost).toMatchObject({ cutoff: 0, rawKept: 19, nextJumpIn: 1 });
    });

    it('never wipes beyond the vectorization tip or the recent keep floor', () => {
        const chat = makeChat(40);
        contextWith(40);
        mocks.getVectorizationTip.mockReturnValue(27);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(20);
        expect(chat.slice(20, 27).every((m, i) => m.mes === `Message ${i + 20}`)).toBe(true);
        expect(chat.slice(30).every((m, i) => m.mes === `Message ${i + 30}`)).toBe(true);
    });

    it('does not wipe any messages needed by an uncapped World Info scan', () => {
        const chat = makeChat(30);
        contextWith(30);
        mocks.getVectorizationTip.mockReturnValue(30);
        mocks.getWorldInfoSettings.mockReturnValue({ world_info_min_activations: 1, world_info_min_activations_depth_max: 0 });

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(0);
        expect(window.VectFox_LastGhost.nextJumpIn).toBeNull();
    });

    it('never wipes the current turn, even when keep-recent is zero', () => {
        const chat = makeChat(25);
        contextWith(25);
        mocks.getVectorizationTip.mockReturnValue(25);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 0,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(20);
        expect(chat.at(-1).mes).toBe('Message 24');
    });

    it('leaves the input untouched when disabled', () => {
        const chat = makeChat(20);
        const original = chat.map(m => ({ ...m }));
        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: false,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result).toEqual({ wiped: 0, charsRemoved: 0 });
        expect(chat).toEqual(original);
    });
});
