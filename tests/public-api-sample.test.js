/**
 * @vitest-environment jsdom
 *
 * The public API's sample consumers (tools/public-api-sample/, the worked examples of Doc/public-api.md), as another
 * extension runs them against a VectFox object. The event reader reads the collection in use whole, then each
 * collection from its own cursor, page after page, on each run, removal and change of collection, waits for one read of
 * a collection before the next, keeps what it had on a no, and starts on `vectfox_ready` when it loads first. The usage
 * tracker files each request by VectFox's mark, counts the chat's model requests, passes every request on as it came,
 * and counts VectFox's calls from `vectfox_llm_call_finished`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VECTFOX_MARK = Symbol.for('vectfox.internal-request');

/** SillyTavern's eventSource, with its listeners by event name. */
function fakeEventSource() {
    const listeners = {};
    return {
        listeners,
        on: (name, listener) => { (listeners[name] ??= []).push(listener); },
        emit: (name, payload) => { for (const listener of listeners[name] ?? []) listener(payload); },
    };
}

/**
 * A VectFox object whose listEvents answers with the answers given, in turn, and whose events a test emits.
 * @param {{isReady?: boolean, capabilities?: string[], inUse?: object, answers?: object[]}} [options]
 */
function fakeVectFox({ isReady = true, capabilities = ['events', 'chat', 'eventbase.read'], inUse = { ok: true, collectionId: 'A' }, answers = [] } = {}) {
    const handlers = {};
    const queue = [...answers];
    return {
        handlers,
        isReady: () => isReady,
        capabilities,
        chat: { getCollectionInUse: () => inUse },
        eventBase: { listEvents: vi.fn(async () => queue.shift()) },
        on: (name, handler) => { (handlers[name] ??= []).push(handler); return () => {}; },
        emit: (name, payload) => { for (const handler of handlers[name] ?? []) handler(payload); },
    };
}

/** A feed answer: what changed after the cursor asked for. */
const answer = ({ events = [], removedEventIds = [], emptied = false, cursor, hasMore = false }) => ({
    ok: true, schemaVersion: '1.3', collectionId: 'A', events, removedEventIds, emptied, cursor, hasMore,
});
const event = eventId => ({ eventId, summary: `Summary of ${eventId}` });
/** Lets every read the handlers started finish. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const idsOf = state => state.events.map(kept => kept.eventId);

let eventSource;

beforeEach(() => {
    vi.resetModules();
    eventSource = fakeEventSource();
    globalThis.SillyTavern = { getContext: () => ({ eventSource }) };
    delete globalThis.VectFox;
});

afterEach(() => {
    delete globalThis.SillyTavern;
    delete globalThis.VectFox;
});

describe('the sample event reader', () => {
    const loadReader = () => import('../tools/public-api-sample/event-reader.js');

    it('reads the collection in use whole, then from its cursor on each run, removal and emptying', async () => {
        const VectFox = fakeVectFox({
            answers: [
                answer({ events: [event('e1'), event('e2')], cursor: 5 }),
                answer({ events: [event('e3')], cursor: 6 }),
                answer({ removedEventIds: ['e1'], cursor: 7 }),
                answer({ emptied: true, events: [event('e4')], cursor: 9 }),
            ],
        });
        globalThis.VectFox = VectFox;
        const { startEventReader, eventReaderState } = await loadReader();

        startEventReader();
        await settle();
        expect(idsOf(eventReaderState().A)).toEqual(['e1', 'e2']);
        VectFox.emit('vectfox_eventbase_synced', { collectionId: 'A' });
        await settle();
        expect(idsOf(eventReaderState().A)).toEqual(['e1', 'e2', 'e3']);
        VectFox.emit('vectfox_eventbase_events_deleted', { collectionId: 'A' });
        await settle();
        expect(idsOf(eventReaderState().A)).toEqual(['e2', 'e3']);
        VectFox.emit('vectfox_eventbase_synced', { collectionId: 'A' });
        await settle();

        expect(eventReaderState().A).toEqual({ cursor: 9, events: [event('e4')] });
        expect(VectFox.eventBase.listEvents.mock.calls.map(([request]) => request)).toEqual([
            { collectionId: 'A', after: undefined },
            { collectionId: 'A', after: 5 },
            { collectionId: 'A', after: 6 },
            { collectionId: 'A', after: 7 },
        ]);
    });

    it('reads again from the new cursor while there is more, and keeps an edited event once', async () => {
        const VectFox = fakeVectFox({
            answers: [
                answer({ events: [event('e1')], cursor: 3, hasMore: true }),
                answer({ events: [{ ...event('e1'), summary: 'Edited' }, event('e2')], cursor: 4 }),
            ],
        });
        globalThis.VectFox = VectFox;
        const { startEventReader, eventReaderState } = await loadReader();

        startEventReader();
        await settle();

        expect(VectFox.eventBase.listEvents.mock.calls.map(([request]) => request.after)).toEqual([undefined, 3]);
        expect(eventReaderState().A).toEqual({ cursor: 4, events: [{ ...event('e1'), summary: 'Edited' }, event('e2')] });
    });

    it('keeps one cursor per collection: another collection is read whole, and the first again from its own cursor', async () => {
        const VectFox = fakeVectFox({
            answers: [
                answer({ events: [event('a1')], cursor: 5 }),
                answer({ events: [event('b1')], cursor: 2 }),
                answer({ events: [event('a2')], cursor: 8 }),
            ],
        });
        globalThis.VectFox = VectFox;
        const { startEventReader, eventReaderState } = await loadReader();

        startEventReader();
        await settle();
        VectFox.emit('vectfox_eventbase_collection_changed', { chatId: 'chat', collectionId: 'B' });
        await settle();
        VectFox.emit('vectfox_eventbase_collection_changed', { chatId: 'chat', collectionId: null });
        VectFox.emit('vectfox_eventbase_collection_changed', { chatId: 'chat', collectionId: 'A' });
        await settle();

        expect(VectFox.eventBase.listEvents.mock.calls.map(([request]) => request)).toEqual([
            { collectionId: 'A', after: undefined },
            { collectionId: 'B', after: undefined },
            { collectionId: 'A', after: 5 },
        ]);
        expect(idsOf(eventReaderState().A)).toEqual(['a1', 'a2']);
        expect(eventReaderState().B).toEqual({ cursor: 2, events: [event('b1')] });
    });

    it('keeps what it had on a no, and asks from the same cursor next time', async () => {
        const VectFox = fakeVectFox({
            answers: [
                answer({ events: [event('e1')], cursor: 5 }),
                { ok: false, reason: 'read-failed' },
                answer({ events: [event('e2')], cursor: 6 }),
            ],
        });
        globalThis.VectFox = VectFox;
        const { startEventReader, eventReaderState } = await loadReader();

        startEventReader();
        await settle();
        VectFox.emit('vectfox_eventbase_synced', { collectionId: 'A' });
        await settle();
        expect(eventReaderState().A).toEqual({ cursor: 5, events: [event('e1')] });
        VectFox.emit('vectfox_eventbase_synced', { collectionId: 'A' });
        await settle();

        expect(VectFox.eventBase.listEvents.mock.calls.map(([request]) => request.after)).toEqual([undefined, 5, 5]);
        expect(idsOf(eventReaderState().A)).toEqual(['e1', 'e2']);
    });

    it('starts a read of a collection only once its last read has ended', async () => {
        const VectFox = fakeVectFox();
        let answerFirst;
        VectFox.eventBase.listEvents
            .mockImplementationOnce(() => new Promise(resolve => { answerFirst = resolve; }))
            .mockResolvedValueOnce(answer({ events: [event('e2')], cursor: 6 }));
        globalThis.VectFox = VectFox;
        const { startEventReader, eventReaderState } = await loadReader();

        startEventReader();
        VectFox.emit('vectfox_eventbase_synced', { collectionId: 'A' });
        await settle();
        expect(VectFox.eventBase.listEvents).toHaveBeenCalledTimes(1);
        answerFirst(answer({ events: [event('e1')], cursor: 5 }));
        await settle();

        expect(VectFox.eventBase.listEvents.mock.calls.map(([request]) => request.after)).toEqual([undefined, 5]);
        expect(idsOf(eventReaderState().A)).toEqual(['e1', 'e2']);
    });

    it('starts on vectfox_ready when it loads before VectFox, and reads nothing on a VectFox without the feed', async () => {
        const { startEventReader } = await loadReader();
        startEventReader();
        expect(eventSource.listeners.vectfox_ready).toHaveLength(1);
        const VectFox = fakeVectFox({ answers: [answer({ events: [event('e1')], cursor: 1 })] });
        globalThis.VectFox = VectFox;
        eventSource.emit('vectfox_ready', { apiVersion: '1.4.0' });
        await settle();
        expect(VectFox.eventBase.listEvents).toHaveBeenCalledTimes(1);

        vi.resetModules();
        const older = fakeVectFox({ capabilities: ['events', 'chat'] });
        globalThis.VectFox = older;
        (await loadReader()).startEventReader();
        older.emit('vectfox_eventbase_synced', { collectionId: 'A' });
        await settle();
        expect(older.eventBase.listEvents).not.toHaveBeenCalled();
    });
});

describe('the sample usage tracker', () => {
    const loadTracker = () => import('../tools/public-api-sample/usage-tracker.js');
    const markedSignal = label => {
        const signal = new AbortController().signal;
        Object.defineProperty(signal, VECTFOX_MARK, { value: Object.freeze({ label }) });
        return signal;
    };

    it("files a marked request as VectFox's and an unmarked model request as the chat's, and passes each on as it came", async () => {
        const originalFetch = vi.fn(async () => new Response('{}'));
        globalThis.window.fetch = originalFetch;
        const VectFox = fakeVectFox();
        globalThis.VectFox = VectFox;
        const { startUsageTracker, usageTrackerTally } = await loadTracker();

        startUsageTracker();
        const vectfoxInit = { method: 'POST', signal: markedSignal('VectFox lorebase') };
        await globalThis.window.fetch('/api/plugins/similharity/lorebase/decisions', vectfoxInit);
        const chatInit = { method: 'POST', signal: new AbortController().signal };
        await globalThis.window.fetch('/api/backends/chat-completions/generate', chatInit);
        await globalThis.window.fetch(new Request(`${globalThis.location.origin}/api/backends/text-completions/generate`, { method: 'POST' }));
        await globalThis.window.fetch('/api/settings/get', { method: 'POST' });
        VectFox.emit('vectfox_llm_call_finished', { feature: 'lorebase', connection: 'profile', profileName: 'Luna', provider: 'custom', model: 'openai/gpt-6-luna', durationMs: 800, outcome: 'ok' });

        expect(usageTrackerTally()).toMatchObject({
            vectfoxRequests: [{ label: 'VectFox lorebase', path: '/api/plugins/similharity/lorebase/decisions' }],
            chatModelRequests: 2,
            vectfoxCalls: [{ feature: 'lorebase', connection: 'profile', model: 'openai/gpt-6-luna', outcome: 'ok', totalTokens: null }],
        });
        expect(originalFetch).toHaveBeenCalledTimes(4);
        expect(originalFetch.mock.calls[0]).toEqual(['/api/plugins/similharity/lorebase/decisions', vectfoxInit]);
        expect(originalFetch.mock.calls[1]).toEqual(['/api/backends/chat-completions/generate', chatInit]);
    });

    it("counts VectFox's calls from the event, with their tokens, once VectFox is ready", async () => {
        globalThis.window.fetch = vi.fn(async () => new Response('{}'));
        const { startUsageTracker, usageTrackerTally } = await loadTracker();

        startUsageTracker();
        const VectFox = fakeVectFox();
        globalThis.VectFox = VectFox;
        eventSource.emit('vectfox_ready', { apiVersion: '1.4.0' });
        VectFox.emit('vectfox_llm_call_finished', { feature: 'eventbase', connection: 'profile', profileName: 'Luna', provider: 'openrouter', model: 'openai/gpt-6-luna', durationMs: 900, outcome: 'ok', usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000, cachedTokens: 0 } });
        VectFox.emit('vectfox_llm_call_finished', { feature: 'lorebase', connection: 'manual', profileName: null, provider: 'openrouter', model: null, durationMs: 30000, outcome: 'timed-out' });

        expect(usageTrackerTally().vectfoxCalls).toEqual([
            { feature: 'eventbase', connection: 'profile', model: 'openai/gpt-6-luna', outcome: 'ok', totalTokens: 1000 },
            { feature: 'lorebase', connection: 'manual', model: null, outcome: 'timed-out', totalTokens: null },
        ]);
    });
});
