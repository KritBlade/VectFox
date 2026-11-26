/**
 * Summarizer Injection (Feature B) — runSummarizerInjection contract, plus the
 * master-switch gate on refreshWorldInfoEntryDepthCache (the ghosting WI scan-depth
 * cache lives in the same module).
 *
 * Locks in the part most prone to silent breakage: sort by source_window_end
 * desc → slice top N → render chronologically inside <VectFoxSummarizer> tags →
 * strip [EVENT_TYPE] prefixes, plus the self-clearing early-exits: the collection
 * is the chat's collection in use, from the one route (collectionInUse), and with
 * none in use, or the one in use paused, nothing is read (D18). An injection
 * whose read settles past the reply step's bound injects nothing. The depth
 * refresh must not load lorebooks while VectFox is disabled, and must warn
 * instead of failing silently. Ghosting takes the messages read up to the tip of
 * the collection in use out of SillyTavern's prompt copy, finding each by the
 * number SillyTavern gives it, keeps a summary where it is, and at a batch size
 * above 1 moves its boundary only in whole batches, so the prompt's opening stays
 * the same between moves.
 *
 * summarizer-injection.js's imports are mocked (same pattern as backend-manager.test.js),
 * except feature-gate.js and constants.js, which stay real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted lifts these so the (also-hoisted) vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
    setExtensionPrompt: vi.fn(),
    listChunks: vi.fn(),
    getChatUUID: vi.fn(() => 'uuid-1'),
    collectionInUse: vi.fn(),
}));
const IN_USE = { collection: { collectionId: 'c', registryKey: 'k', isPaused: false }, reason: null, collections: [], lockedElsewhere: [] };

vi.mock('../../../../../script.js', () => ({ setExtensionPrompt: mocks.setExtensionPrompt }));
// Host modules that summarizer-injection.js imports but the tests don't drive.
// They don't exist in the repo (ST provides them at runtime) and an unmocked
// host module throws on import (vitest.config.js), so stub them here.
vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn(() => ({ chat: [] })) }));
vi.mock('../../../../world-info.js', () => ({ getWorldInfoSettings: vi.fn(() => ({})), getSortedEntries: vi.fn(async () => []) }));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../src/features/vector-backend/backend-registry.js', () => ({ getBackend: vi.fn(async () => ({ listChunks: mocks.listChunks })) }));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: mocks.getChatUUID }));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({ getVectorizationTip: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    NOT_IN_USE_REASON: { NO_CHAT: 'no-chat', NO_COLLECTION: 'no-collection', NONE_IN_USE: 'none-in-use' },
    collectionInUse: mocks.collectionInUse,
    noCollectionInUseText: (inUse, consequence) => (inUse.reason === 'none-in-use' ? `No collection is in use in this chat, so ${consequence}.` : null),
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn() {}, error() {}, domain() {}, trace() {}, verbose() {}, lifecycle() {}, enabled: () => false } }));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));

import { applyGhosting, runSummarizerInjection, buildSummarizerInjection, refreshWorldInfoEntryDepthCache } from '../src/features/eventbase/summarizer-injection.js';
import { runBoundedRetrieval } from '../src/features/vector-backend/index.js';
import { getSortedEntries, getWorldInfoSettings } from '../../../../world-info.js';
import { getContext } from '../../../../extensions.js';
import { getVectorizationTip } from '../src/features/eventbase/eventbase-store.js';
import { setMessageSource } from '../src/shared/chat-messages.js';
import { log } from '../src/sillytavern/log.js';

const SETTINGS = (over = {}) => ({
    summarizer_injection_enabled: true,
    summarizer_injection_count: 30,
    summarizer_injection_full_detail: false, // summary-only for the format/sort tests
    position: 1,
    depth: 4,
    vector_backend: 'qdrant',
    ...over,
});
const ev = (swe, text, extra = {}) => ({ text, metadata: { eventbase: true, source_window_end: swe, ...extra } });
const lastInjected = () => mocks.setExtensionPrompt.mock.calls.at(-1);
// SillyTavern's prompt copy of a chat, as its interceptors get it: the chat less its hidden messages (a hidden one with
// tool calls stays while tool calling is on), each copy numbered by its place in that list.
const promptOf = (chat, isToolCallingOn = false) => chat
    .filter(message => !message.is_system || (isToolCallingOn && Array.isArray(message.extra?.tool_invocations)))
    .map((message, index) => ({ ...message, index }));

beforeEach(() => {
    mocks.setExtensionPrompt.mockClear();
    mocks.listChunks.mockReset();
    mocks.getChatUUID.mockReturnValue('uuid-1');
    mocks.collectionInUse.mockReset().mockReturnValue(IN_USE);
});

describe('runSummarizerInjection', () => {
    it('clears the slot and no-ops when disabled', async () => {
        const r = await runSummarizerInjection(SETTINGS({ summarizer_injection_enabled: false }));
        expect(r.injected).toBe(0);
        expect(mocks.setExtensionPrompt).toHaveBeenCalledWith('3_vectfox_summarizer', '', 1, 4, false);
        expect(mocks.listChunks).not.toHaveBeenCalled();
    });

    it('clears the slot when no chat is open', async () => {
        mocks.collectionInUse.mockReturnValue({ collection: null, reason: 'no-chat', collections: [], lockedElsewhere: [] });
        const r = await runSummarizerInjection(SETTINGS());
        expect(r.injected).toBe(0);
        expect(lastInjected()).toEqual(['3_vectfox_summarizer', '', 1, 4, false]);
    });

    it('clears the slot, reading nothing, while the chat has collections and none in use', async () => {
        mocks.collectionInUse.mockReturnValue({ collection: null, reason: 'none-in-use', collections: [{ registryKey: 'k' }], lockedElsewhere: [] });
        const r = await runSummarizerInjection(SETTINGS());
        expect(r.injected).toBe(0);
        expect(lastInjected()[1]).toBe('');
        expect(mocks.listChunks).not.toHaveBeenCalled();
    });

    it('clears the slot, reading nothing, while the collection in use is paused', async () => {
        mocks.collectionInUse.mockReturnValue({ ...IN_USE, collection: { ...IN_USE.collection, isPaused: true } });
        const r = await runSummarizerInjection(SETTINGS());
        expect(r.injected).toBe(0);
        expect(mocks.listChunks).not.toHaveBeenCalled();
    });

    it('reads the collection the reply step resolved, asking the route nothing', async () => {
        mocks.listChunks.mockResolvedValue({ items: [ev(2, 'X')] });
        const r = await runSummarizerInjection(SETTINGS(), { ...IN_USE, collection: { ...IN_USE.collection, collectionId: 'c2' } });
        expect(r.injected).toBe(1);
        expect(mocks.collectionInUse).not.toHaveBeenCalled();
        expect(mocks.listChunks.mock.calls[0][0]).toBe('c2');
    });

    it('clears when the collection has no events', async () => {
        mocks.listChunks.mockResolvedValue({ items: [] });
        const r = await runSummarizerInjection(SETTINGS());
        expect(r.injected).toBe(0);
        expect(lastInjected()[1]).toBe('');
    });

    it('injects top-N by source_window_end desc, chronological, in <VectFoxSummarizer>, prefixes stripped', async () => {
        mocks.listChunks.mockResolvedValue({ items: [
            ev(2, '[MOVE] A'), ev(8, '[TALK] D'), ev(4, '[MOVE] B'), ev(6, 'C'),
        ] });
        const r = await runSummarizerInjection(SETTINGS({ summarizer_injection_count: 3 }));
        expect(r.injected).toBe(3);
        const [tag, text] = lastInjected();
        expect(tag).toBe('3_vectfox_summarizer');
        // top-3 by swe desc = D(8), C(6), B(4); rendered chronological with recency tags
        expect(text).toBe('<VectFoxSummarizer>\n(3 turns ago) B\n(2 turns ago) C\n(latest turn) D\n</VectFoxSummarizer>');
    });

    it('events sharing a source_window_end (multiple per turn) share one recency label', async () => {
        // Two events at 2119 (same turn) + one at 2113. Both 2119s must read "latest turn".
        mocks.listChunks.mockResolvedValue({ items: [ev(2119, 'A'), ev(2113, 'C'), ev(2119, 'B')] });
        const r = await runSummarizerInjection(SETTINGS({ summarizer_injection_count: 10 }));
        expect(r.injected).toBe(3);
        expect(lastInjected()[1]).toBe('<VectFoxSummarizer>\n(2 turns ago) C\n(latest turn) B\n(latest turn) A\n</VectFoxSummarizer>');
    });

    it('injects all when fewer events than N exist (no padding)', async () => {
        mocks.listChunks.mockResolvedValue({ items: [ev(2, 'X'), ev(4, 'Y')] });
        const r = await runSummarizerInjection(SETTINGS({ summarizer_injection_count: 10 }));
        expect(r.injected).toBe(2);
        expect(lastInjected()[1]).toBe('<VectFoxSummarizer>\n(2 turns ago) X\n(latest turn) Y\n</VectFoxSummarizer>');
    });

    it('clamps count to 50', async () => {
        mocks.listChunks.mockResolvedValue({ items: Array.from({ length: 60 }, (_, i) => ev(i, 'e' + i)) });
        const r = await runSummarizerInjection(SETTINGS({ summarizer_injection_count: 999 }));
        expect(r.injected).toBe(50);
        // open tag + 50 summary lines + close tag
        expect(lastInjected()[1].split('\n').length).toBe(52);
    });

    it('ignores non-eventbase items (e.g. metadata:{} from standard+no-plugin)', async () => {
        mocks.listChunks.mockResolvedValue({ items: [{ text: 'hash-only', metadata: {} }, ev(2, 'real')] });
        const r = await runSummarizerInjection(SETTINGS());
        expect(r.injected).toBe(1);
        expect(lastInjected()[1]).toBe('<VectFoxSummarizer>\n(latest turn) real\n</VectFoxSummarizer>');
    });
});

describe('buildSummarizerInjection (the Summarizer preview path)', () => {
    it('says why it has nothing while the chat has collections and none in use, and that the one in use is paused', async () => {
        mocks.collectionInUse.mockReturnValue({ collection: null, reason: 'none-in-use', collections: [{ registryKey: 'k' }], lockedElsewhere: [] });
        expect(await buildSummarizerInjection(SETTINGS())).toMatchObject({
            count: 0, reason: 'none-in-use', problem: 'No collection is in use in this chat, so Summarizer Injection reads nothing.',
        });
        mocks.collectionInUse.mockReturnValue({ ...IN_USE, collection: { ...IN_USE.collection, isPaused: true } });
        expect(await buildSummarizerInjection(SETTINGS())).toMatchObject({ count: 0, reason: 'paused' });
    });

    it('computes the would-be content even when the feature is DISABLED (never injects)', async () => {
        mocks.listChunks.mockResolvedValue({ items: [ev(4, 'Y'), ev(2, 'X')] });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_enabled: false, summarizer_injection_count: 5 }));
        expect(out.count).toBe(2);
        expect(out.text).toBe('<VectFoxSummarizer>\n(2 turns ago) X\n(latest turn) Y\n</VectFoxSummarizer>');
        // Preview must NOT touch the prompt slot.
        expect(mocks.setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('char budget keeps the most-recent events and drops the oldest overflow', async () => {
        // 6 events ~30 chars each; budget 80 → fits the latest 2-3, drops the rest.
        mocks.listChunks.mockResolvedValue({ items: [
            ev(10, 'AAAAAAAAAAAAAAAAAAAA'), ev(9, 'BBBBBBBBBBBBBBBBBBBB'),
            ev(8, 'CCCCCCCCCCCCCCCCCCCC'), ev(7, 'DDDDDDDDDDDDDDDDDDDD'),
            ev(6, 'EEEEEEEEEEEEEEEEEEEE'), ev(5, 'FFFFFFFFFFFFFFFFFFFF'),
        ] });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_count: 6, summarizer_injection_max_chars: 80 }));
        expect(out.count).toBeLessThan(6);          // trimmed
        expect(out.count).toBeGreaterThanOrEqual(1);
        expect(out.text).toContain('(latest turn) AAAAAAAAAAAAAAAAAAAA'); // newest always kept
        expect(out.text).not.toContain('FFFFFFFFFFFFFFFFFFFF');           // oldest dropped
    });

    it('always includes the latest event even if it alone exceeds the budget', async () => {
        mocks.listChunks.mockResolvedValue({ items: [ev(10, 'X'.repeat(500)), ev(9, 'older')] });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_count: 2, summarizer_injection_max_chars: 50 }));
        expect(out.count).toBe(1);
        expect(out.text).toContain('X'.repeat(500));
        expect(out.text).not.toContain('older');
    });

    it('max_chars = 0 disables the cap', async () => {
        mocks.listChunks.mockResolvedValue({ items: Array.from({ length: 40 }, (_, i) => ev(i, 'e'.repeat(100))) });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_count: 40, summarizer_injection_max_chars: 0 }));
        expect(out.count).toBe(40);
    });

    it('reports a reason on empty outcomes', async () => {
        mocks.collectionInUse.mockReturnValue({ collection: null, reason: 'no-collection', collections: [], lockedElsewhere: [] });
        const out = await buildSummarizerInjection(SETTINGS());
        expect(out).toMatchObject({ count: 0, text: '', reason: 'no-collection' });
    });

    it('fetches the whole collection (not a small sample) so the true most-recent N are found', async () => {
        // listChunks returns points in backend ID order, NOT source_window_end order.
        // A small limit returns a random sample → wrong "last N". Must overfetch.
        mocks.listChunks.mockResolvedValue({ items: [] });
        await buildSummarizerInjection(SETTINGS({ summarizer_injection_count: 30 }));
        const opts = mocks.listChunks.mock.calls[0][2];
        expect(opts.limit).toBeGreaterThanOrEqual(10000);
    });

    it('picks the globally-most-recent N even when listChunks returns them unordered', async () => {
        // Simulate the real bug: recent events arrive AFTER older ones in the list.
        mocks.listChunks.mockResolvedValue({ items: [
            ev(2107, 'old-ish'), ev(1621, 'oldest'),
            ev(2119, 'newest'), ev(2113, 'second'), ev(2111, 'third'),
        ] });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_full_detail: false, summarizer_injection_count: 3 }));
        expect(out.count).toBe(3);
        // top-3 by swe = 2119, 2113, 2111; rendered chronological
        expect(out.text).toBe('<VectFoxSummarizer>\n(3 turns ago) third\n(2 turns ago) second\n(latest turn) newest\n</VectFoxSummarizer>');
    });

    it('full-detail mode lists structured fields (content-only) under each summary', async () => {
        mocks.listChunks.mockResolvedValue({ items: [
            ev(8, '[TALK] Pact sealed', {
                cause: 'tension rose', result: 'alliance formed',
                characters: ['Rabbit', 'Engni'], locations: ['Hollow Aqueduct'],
                items: ['tideglass', 'lantern'], DateTime: '2026-01-02T03:04:00.000Z',
                concepts: ['accord'], keywords: ['pact', 'accord'],
                open_threads: ['who funds it?'],
            }),
        ] });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_full_detail: true, summarizer_injection_count: 1 }));
        expect(out.count).toBe(1);
        expect(out.text).toBe([
            '<VectFoxSummarizer>',
            '(latest turn) Pact sealed',
            '  Cause: tension rose',
            '  Result: alliance formed',
            '  Characters: Rabbit, Engni',
            '  Locations: Hollow Aqueduct',
            '  Items: tideglass, lantern',
            '  When: 2026-01-02T03:04:00.000Z',
            '  Concepts: accord',
            '  Keywords: pact, accord',
            '  Open threads: who funds it?',
            '  Message index: 8',
            '</VectFoxSummarizer>',
        ].join('\n'));
    });

    it('full-detail mode omits empty fields (compact for sparse events)', async () => {
        mocks.listChunks.mockResolvedValue({ items: [
            ev(4, 'just a summary', { cause: '', result: '   ', items: [], concepts: [null, ''], keywords: ['k1'] }),
        ] });
        const out = await buildSummarizerInjection(SETTINGS({ summarizer_injection_full_detail: true }));
        expect(out.text).toBe([
            '<VectFoxSummarizer>',
            '(latest turn) just a summary',
            '  Keywords: k1',
            '  Message index: 4',
            '</VectFoxSummarizer>',
        ].join('\n'));
    });
});

describe('refreshWorldInfoEntryDepthCache', () => {
    beforeEach(() => {
        getSortedEntries.mockClear();
    });

    it('loads no lorebooks while the master switch is off', async () => {
        await refreshWorldInfoEntryDepthCache({ enabled: false });
        expect(getSortedEntries).not.toHaveBeenCalled();
    });

    it('loads the active lorebooks while VectFox is on', async () => {
        await refreshWorldInfoEntryDepthCache({ enabled: true });
        expect(getSortedEntries).toHaveBeenCalledTimes(1);
    });

    it('warns instead of failing silently when loading lorebooks throws', async () => {
        const warn = vi.spyOn(log, 'warn');
        const failure = new Error('lore load failed');
        getSortedEntries.mockRejectedValueOnce(failure);

        await refreshWorldInfoEntryDepthCache({ enabled: true });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('scan-depth refresh failed'), failure);
        warn.mockRestore();
    });
});

describe('applyGhosting and the collection in use', () => {
    const GHOSTING = { eventbase_ghost_enabled: true, summarizer_injection_enabled: true, eventbase_ghost_keep_recent: 1 };
    const chatOf = () => ['a', 'b', 'c', 'd', 'e', 'f'].map(mes => ({ mes, is_user: false }));

    beforeEach(() => {
        globalThis.window = {};
        getVectorizationTip.mockReset().mockReturnValue(4);
    });

    it('takes the messages the collection in use has read, up to its tip, out of the prompt, and changes no chat message', () => {
        const chat = chatOf();
        getContext.mockReturnValue({ chat });
        const prompt = promptOf(chat);
        expect(applyGhosting(prompt, GHOSTING, IN_USE)).toEqual({ takenOutCount: 4, charsRemoved: 4 });
        expect(prompt.map(message => message.mes)).toEqual(['e', 'f']);
        expect(chat.map(message => message.mes)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(getVectorizationTip).toHaveBeenCalledWith('k');
    });

    it('takes nothing out while the collection in use is paused, or none is in use, reading no tip', () => {
        const paused = { ...IN_USE, collection: { ...IN_USE.collection, isPaused: true } };
        expect(applyGhosting(promptOf(chatOf()), GHOSTING, paused)).toEqual({ takenOutCount: 0, charsRemoved: 0 });
        const none = { collection: null, reason: 'none-in-use', collections: [{ registryKey: 'k' }], lockedElsewhere: [] };
        expect(applyGhosting(promptOf(chatOf()), GHOSTING, none)).toEqual({ takenOutCount: 0, charsRemoved: 0 });
        expect(getVectorizationTip).not.toHaveBeenCalled();
    });

    it('takes nothing out while the tip is past the chat\'s end, as after messages are deleted or a summary replaces some', () => {
        // Read on a chat of 9 messages; this one has 6, so the tip cannot say which of them are in memory.
        getVectorizationTip.mockReturnValue(9);
        getContext.mockReturnValue({ chat: chatOf() });
        const prompt = promptOf(chatOf());
        expect(applyGhosting(prompt, GHOSTING, IN_USE)).toEqual({ takenOutCount: 0, charsRemoved: 0 });
        expect(prompt.map(message => message.mes)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        // At the chat's end it still takes out every message below it but the one kept.
        getVectorizationTip.mockReturnValue(6);
        expect(applyGhosting(promptOf(chatOf()), GHOSTING, IN_USE)).toEqual({ takenOutCount: 5, charsRemoved: 5 });
    });
});

// A summarizer that registered a message source (H4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md, D6): the tip
// counts the story, each summary as the messages it stands for, and ghosting keeps every summary where it is while it
// takes the read messages around it out of the prompt.
describe('applyGhosting beside a summarizer that registered a message source', () => {
    const GHOSTING = { eventbase_ghost_enabled: true, summarizer_injection_enabled: true, eventbase_ghost_keep_recent: 1 };
    const say = mes => ({ mes, is_user: false });
    const summaryOf = (mes, originals) => ({ mes, is_user: false, stands: originals });
    // Ghosts a prompt copy of the chat with this tip, SillyTavern's unless one is given, and returns what was taken out
    // and the prompt's texts.
    const ghost = (chat, tip, { isToolCallingOn = false, prompt = promptOf(chat, isToolCallingOn) } = {}) => {
        getContext.mockReturnValue({ chat, isToolCallingSupported: () => isToolCallingOn });
        getVectorizationTip.mockReset().mockReturnValue(tip);
        return { result: applyGhosting(prompt, GHOSTING, IN_USE), texts: prompt.map(message => message.mes) };
    };

    beforeEach(() => {
        globalThis.window = {};
        setMessageSource(message => (message.stands ? { owner: 'Lantern Summaries', originals: message.stands } : null));
    });

    afterEach(() => {
        setMessageSource(null);
    });

    it('maps the tip, counted in story order, back to the chat, and takes out the read messages around a summary, never it', () => {
        // The story: a, b, then c, d and e behind the summary, then f and g. All 7 are read; g, the last, is kept.
        const chat = [say('a'), say('b'), summaryOf('S', [say('c'), say('d'), say('e')]), say('f'), say('g')];
        expect(ghost(chat, 7)).toEqual({ result: { takenOutCount: 3, charsRemoved: 3 }, texts: ['S', 'g'] });
    });

    it('keeps a summary that opens the chat, and takes out the read messages after it', () => {
        const chat = [summaryOf('S', [say('a'), say('b'), say('c')]), say('d'), say('e'), say('f')];
        expect(ghost(chat, 6)).toEqual({ result: { takenOutCount: 2, charsRemoved: 2 }, texts: ['S', 'f'] });
    });

    it('keeps a summary answered with none, of messages still in the chat, too', () => {
        const chat = [say('a'), summaryOf('S', []), say('b'), say('c')];
        expect(ghost(chat, 3)).toEqual({ result: { takenOutCount: 2, charsRemoved: 2 }, texts: ['S', 'c'] });
    });

    it('takes out up to the tip when the summary lies past it, the tip counting in story order', () => {
        // The story: a to d, then e and f behind the summary, then g. The first 3 are read.
        const chat = [say('a'), say('b'), say('c'), say('d'), summaryOf('S', [say('e'), say('f')]), say('g')];
        expect(ghost(chat, 3).texts).toEqual(['d', 'S', 'g']);
    });

    it('stops at a summary whose originals are not all read', () => {
        // The story: a, then b, c and d behind the summary, then e and f. The tip, 3, falls among the summary's.
        const chat = [say('a'), summaryOf('S', [say('b'), say('c'), say('d')]), say('e'), say('f')];
        expect(ghost(chat, 3).texts).toEqual(['S', 'e', 'f']);
    });

    it('leaves a message with no text after the last message read as it is', () => {
        const chat = [say('a'), say('b'), say(''), say('c'), say('d')];
        expect(ghost(chat, 2)).toEqual({ result: { takenOutCount: 2, charsRemoved: 2 }, texts: ['', 'c', 'd'] });
        // Below a message read, it goes with the rest, and saves nothing.
        expect(ghost(chat, 3)).toEqual({ result: { takenOutCount: 3, charsRemoved: 3 }, texts: ['d'] });
    });

    it('takes a tip past the chat\'s length but within the story\'s for no tip past the end', () => {
        // 5 messages in the chat, 7 in the story: a tip of 7 is not past its end.
        const chat = [say('a'), say('b'), summaryOf('S', [say('c'), say('d'), say('e')]), say('f'), say('g')];
        expect(ghost(chat, 7).result.takenOutCount).toBe(3);
        expect(ghost(chat, 8).result.takenOutCount).toBe(0);
    });

    it('finds each message by its number after an interceptor that ran first took some out', () => {
        // Vector Storage, whose interceptor runs before VectFox's, took b and f out of the prompt.
        const chat = [say('a'), say('b'), summaryOf('S', [say('c'), say('d')]), say('e'), say('f'), say('g')];
        const prompt = promptOf(chat).filter(message => !['b', 'f'].includes(message.mes));
        expect(ghost(chat, 7, { prompt })).toEqual({ result: { takenOutCount: 2, charsRemoved: 2 }, texts: ['S', 'g'] });
    });

    it('finds each message by its number past hidden messages, one with tool calls in the prompt while tool calling is on', () => {
        // A hidden message is read into the story, but SillyTavern leaves it out of the prompt, unless it holds tool
        // calls and tool calling is on.
        const hidden = { mes: 'h', is_user: false, is_system: true };
        const toolCall = { mes: '', is_user: false, is_system: true, extra: { tool_invocations: [{ name: 'roll' }] } };
        const chat = [say('a'), hidden, toolCall, summaryOf('S', [say('b')]), say('c'), say('d')];
        expect(ghost(chat, 5, { isToolCallingOn: true })).toEqual({ result: { takenOutCount: 2, charsRemoved: 2 }, texts: ['S', 'd'] });
        expect(ghost(chat, 5)).toEqual({ result: { takenOutCount: 2, charsRemoved: 2 }, texts: ['S', 'd'] });
    });

    it('keeps a message another extension added, and one whose number points to a message it does not copy', () => {
        const chat = ['a', 'b', 'c', 'd', 'e'].map((mes, day) => ({ mes, is_user: false, name: 'Rin', send_date: `day ${day}` }));
        const prompt = promptOf(chat);
        // Another extension adds a note of its own, with no number, and messages of its own that carry the numbers of b,
        // c and d, each differing from the message its number points to in its date, name or sender.
        prompt.splice(1, 0,
            { mes: 'note', is_user: false },
            { ...prompt[1], mes: 'date', send_date: 'day 9' },
            { ...prompt[2], mes: 'name', name: 'Aoi' },
            { ...prompt[3], mes: 'sender', is_user: true });
        expect(ghost(chat, 5, { prompt })).toEqual({
            result: { takenOutCount: 4, charsRemoved: 4 },
            texts: ['note', 'date', 'name', 'sender', 'e'],
        });
    });
});

describe('applyGhosting in batches', () => {
    const messagesOf = count => Array.from({ length: count }, (_, i) => ({ mes: `m${i}`, is_user: i % 2 === 0 }));
    const ghosting = batchSize => ({ eventbase_ghost_enabled: true, summarizer_injection_enabled: true, eventbase_ghost_keep_recent: 10, eventbase_ghost_batch_size: batchSize });
    // Ghosts SillyTavern's prompt copy of a chat of `count` messages whose first `tip` are in memory, and returns its
    // texts and how many messages were taken out.
    const ghost = (count, tip, settings) => {
        getContext.mockReturnValue({ chat: messagesOf(count) });
        getVectorizationTip.mockReturnValue(tip);
        const prompt = promptOf(messagesOf(count));
        const result = applyGhosting(prompt, settings, IN_USE);
        return { result, texts: prompt.map(message => message.mes), takenOut: count - prompt.length };
    };
    // 25 turns from a chat of 12 messages, each adding a message and its reply, every message in memory. Each turn
    // gives the prompt as sent and how many messages were taken out.
    const replay = batchSize => Array.from({ length: 25 }, (_, turn) => {
        const count = 12 + 2 * (turn + 1);
        const { texts, takenOut } = ghost(count, count, ghosting(batchSize));
        return { sent: texts.join('\n'), takenOut };
    });
    const turnsStartingWithTheLast = turns => turns.slice(1).filter((turn, i) => turn.sent.startsWith(turns[i].sent)).length;
    // The readout applyGhosting publishes on the page's global.
    const lastGhost = () => globalThis.window.VectFox_LastGhost;

    beforeEach(() => {
        globalThis.window = {};
        getVectorizationTip.mockReset();
    });

    it('keeps the whole last prompt at the start of the next one between moves, and moves in whole batches', () => {
        const turns = replay(10);
        // 24 turns follow the first, and the boundary moves on 5 of them (at 10, 20, 30, 40 and 50 messages).
        expect(turnsStartingWithTheLast(turns)).toBe(19);
        for (const turn of turns) expect(turn.takenOut % 10).toBe(0);
    });

    it('moves the boundary every turn at batch size 1', () => {
        expect(turnsStartingWithTheLast(replay(1))).toBe(0);
    });

    it('snaps the boundary down, and says how many messages stay verbatim and how many until the next batch', () => {
        const { result, texts } = ghost(25, 25, ghosting(10));
        // The rolling boundary is 15 (25 messages, 10 kept), so 10 go and 15 stay.
        expect(result).toEqual({ takenOutCount: 10, charsRemoved: 20 });
        expect(texts).toEqual(messagesOf(25).slice(10).map(message => message.mes));
        expect(lastGhost()).toMatchObject({ batchSize: 10, keptVerbatimCount: 15, messagesUntilNextBatch: 5 });
    });

    it('takes nothing out until a whole batch can go', () => {
        const { result } = ghost(19, 19, ghosting(10));
        expect(result.takenOutCount).toBe(0);
        expect(lastGhost()).toMatchObject({ keptVerbatimCount: 19, messagesUntilNextBatch: 1 });
    });

    it('never takes out past the tip', () => {
        // The tip (27) is below the rolling boundary (30), and snaps down to 20.
        const { result, texts } = ghost(40, 27, ghosting(10));
        expect(result.takenOutCount).toBe(20);
        expect(texts).toEqual(messagesOf(40).slice(20).map(message => message.mes));
    });

    it('gives no batch readout while World Info could scan the whole chat, nor at batch size 1', () => {
        getWorldInfoSettings.mockReturnValueOnce({ world_info_min_activations: 1, world_info_min_activations_depth_max: 0 });
        expect(ghost(30, 30, ghosting(10)).result.takenOutCount).toBe(0);
        expect(lastGhost()).toMatchObject({ keptVerbatimCount: null, messagesUntilNextBatch: null });
        expect(ghost(30, 30, ghosting(1)).result.takenOutCount).toBe(20);
        expect(lastGhost()).toMatchObject({ batchSize: 1, keptVerbatimCount: null, messagesUntilNextBatch: null });
    });

    it('moves the boundary every turn when the batch size is missing or unreadable', () => {
        for (const batchSize of [0, -5, Number.NaN, 'abc', undefined]) {
            expect(ghost(25, 25, ghosting(batchSize)).result.takenOutCount, String(batchSize)).toBe(15);
            expect(lastGhost().batchSize).toBe(1);
        }
    });
});

// The reply step bounds the injection (runBoundedRetrieval): one whose read settles past its bound leaves the slot as
// the reply step emptied it, as the reply went without it (GitHub issue #28).
describe('runSummarizerInjection in its bounded run', () => {
    const BOUND = { contextLabel: 'Summarizer', sourceName: 'recent event summaries', timeoutMessage: 'Summarizer injection timed out', timeoutMs: 15000 };

    beforeEach(() => {
        vi.useFakeTimers();
        globalThis.toastr = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() };
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('injects nothing when its read settles past its bound', async () => {
        let settleRead;
        mocks.listChunks.mockReturnValue(new Promise(resolve => { settleRead = resolve; }));
        let injection;
        const reply = runBoundedRetrieval(boundedRun => (injection = runSummarizerInjection(SETTINGS(), IN_USE, boundedRun)), BOUND);

        await vi.advanceTimersByTimeAsync(15000);
        await reply;
        settleRead({ items: [ev(2, 'The duel at the mill')] });

        expect(await injection).toEqual({ injected: 0 });
        expect(mocks.setExtensionPrompt).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
    });

    it('injects what it read inside its bound', async () => {
        mocks.listChunks.mockResolvedValue({ items: [ev(2, 'The duel at the mill')] });
        let injection;
        await runBoundedRetrieval(boundedRun => (injection = runSummarizerInjection(SETTINGS(), IN_USE, boundedRun)), BOUND);

        expect(await injection).toEqual({ injected: 1 });
        expect(lastInjected()[1]).toContain('The duel at the mill');
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });
});
