/**
 * The `VectFox` object (A1 of InternalProject/Vectfox/plans/vectfox-public-api.md, §4.1): there as soon as
 * src/index.js is evaluated, frozen, ready once initialization ends, and `vectfox_ready` emitted once, without
 * waiting for its listeners. The emitter here behaves as SillyTavern's does: it awaits each listener in turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    listeners: {},
    manifest: { version: '3.6.300' },
    manifestError: null,
}));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: {
        on: (event, listener) => { (host.listeners[event] ??= []).push(listener); },
        removeListener: (event, listener) => {
            const listeners = host.listeners[event] ?? [];
            const index = listeners.indexOf(listener);
            if (index > -1) listeners.splice(index, 1);
        },
        emit: async (event, ...args) => {
            for (const listener of (host.listeners[event] ?? []).slice()) {
                await listener(...args);
            }
        },
    },
    event_types: {},
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/shared/extension-manifest.js', () => ({
    loadExtensionManifest: async () => {
        if (host.manifestError) throw host.manifestError;
        return host.manifest;
    },
}));
// The real collection IDs read a chat's UUID from an ID alone; the open chat is not asked.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => null, chat_metadata: {} }));

const HARBOR_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const HARBOR_EVENTS = `vf_eventbase_qdrant_wren_harbor_${HARBOR_UUID}`;
const HARBOR_LATER_EVENTS = `${HARBOR_EVENTS}_mwpopqxs`;
const ARCHIVE_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const HARBOR_ARCHIVE = `vf_archiveevent_qdrant_wren_harbor_${ARCHIVE_UUID}`;
const HARBOR_LORE = 'vf_lorebase_qdrant_wren_harbor_atlas_19qag9zxydm';

/** The modules fresh, as a page load gives them: one readiness, nothing published. */
async function loadPublicApi() {
    vi.resetModules();
    const { log } = await import('../src/sillytavern/log.js');
    const publicApi = await import('../src/features/public-api/index.js');
    return { log, ...publicApi };
}

/** Whether a promise has settled after pending work runs. */
async function hasSettled(promise) {
    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    return settled;
}

beforeEach(() => {
    host.listeners = {};
    host.manifest = { version: '3.6.300' };
    host.manifestError = null;
    delete globalThis.VectFox;
});

afterEach(() => {
    delete globalThis.VectFox;
    vi.clearAllMocks();
});

describe('the VectFox object', () => {
    it('is there once published, frozen, at API 1.0.0, and not ready until initialization ends', async () => {
        const { publishPublicApi } = await loadPublicApi();
        publishPublicApi();
        const api = globalThis.VectFox;

        expect(Object.isFrozen(api)).toBe(true);
        expect(api.apiVersion).toBe('1.0.0');
        expect(api.capabilities).toEqual(['events']);
        expect(Object.isFrozen(api.capabilities)).toBe(true);
        expect(api.isReady()).toBe(false);
        expect(api.extensionVersion).toBeNull();
        expect(() => { api.apiVersion = '2.0.0'; }).toThrow(TypeError);
        expect(() => { api.on = () => {}; }).toThrow(TypeError);
        expect(await hasSettled(api.whenReady())).toBe(false);
    });

    it('turns ready once, and a consumer loaded before VectFox hears vectfox_ready once, frozen', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        const heard = [];
        // A consumer loaded before VectFox listens on SillyTavern's eventSource, as no VectFox object exists yet.
        host.listeners.vectfox_ready = [payload => heard.push(payload)];
        publishPublicApi();
        const api = globalThis.VectFox;
        const waiting = api.whenReady();

        await announcePublicApiReady();
        await announcePublicApiReady();

        expect(api.isReady()).toBe(true);
        expect(await hasSettled(waiting)).toBe(true);
        expect(api.whenReady()).toBe(waiting);
        expect(heard).toEqual([{ apiVersion: '1.0.0' }]);
        expect(Object.isFrozen(heard[0])).toBe(true);
        expect(api.extensionVersion).toBe('3.6.300');
    });

    it('does not wait for a listener that never resolves', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        host.listeners.vectfox_ready = [() => new Promise(() => {})];
        publishPublicApi();

        expect(await hasSettled(announcePublicApiReady())).toBe(true);
        expect(globalThis.VectFox.isReady()).toBe(true);
    });

    it('turns ready with extensionVersion null when the manifest cannot be read, and says so', async () => {
        const { publishPublicApi, announcePublicApiReady, log } = await loadPublicApi();
        host.manifestError = new Error('manifest.json answered HTTP 404');
        const heard = [];
        host.listeners.vectfox_ready = [payload => heard.push(payload)];
        publishPublicApi();

        await announcePublicApiReady();

        expect(globalThis.VectFox.isReady()).toBe(true);
        expect(globalThis.VectFox.extensionVersion).toBeNull();
        expect(heard).toHaveLength(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('extensionVersion stays null'), host.manifestError);
    });

    it('says so when it replaces the object of another copy of VectFox', async () => {
        const { publishPublicApi, log } = await loadPublicApi();
        const other = Object.freeze({ apiVersion: '1.0.0' });
        globalThis.VectFox = other;

        publishPublicApi();

        expect(globalThis.VectFox).not.toBe(other);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('another copy of VectFox'));
    });
});

describe('VectFox.on and VectFox.off', () => {
    it('on subscribes and returns its own unsubscribe, and off unsubscribes', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        const api = globalThis.VectFox;
        const kept = vi.fn();
        const unsubscribed = vi.fn();
        const offed = vi.fn();

        api.on('vectfox_ready', kept);
        const unsubscribe = api.on('vectfox_ready', unsubscribed);
        api.on('vectfox_ready', offed);
        unsubscribe();
        api.off('vectfox_ready', offed);
        await announcePublicApiReady();

        expect(kept).toHaveBeenCalledTimes(1);
        expect(kept).toHaveBeenCalledWith({ apiVersion: '1.0.0' });
        expect(unsubscribed).not.toHaveBeenCalled();
        expect(offed).not.toHaveBeenCalled();
    });

    it('subscribes nothing to an event this VectFox does not emit, and says so', async () => {
        const { publishPublicApi, log } = await loadPublicApi();
        publishPublicApi();

        const unsubscribe = globalThis.VectFox.on('vectfox_not_an_event', () => {});

        expect(typeof unsubscribe).toBe('function');
        expect(host.listeners.vectfox_not_an_event).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("'vectfox_not_an_event'"));
        expect(() => unsubscribe()).not.toThrow();
    });

    it('throws a TypeError for a handler that is not a function', async () => {
        const { publishPublicApi } = await loadPublicApi();
        publishPublicApi();

        expect(() => globalThis.VectFox.on('vectfox_ready', 'not a function')).toThrow(TypeError);
        expect(host.listeners.vectfox_ready).toBeUndefined();
    });

    it('subscribes to every event of §4.3', async () => {
        const { publishPublicApi, log } = await loadPublicApi();
        publishPublicApi();
        const names = ['vectfox_ready', 'vectfox_eventbase_synced', 'vectfox_eventbase_events_deleted', 'vectfox_eventbase_collection_changed', 'vectfox_llm_call_finished'];
        for (const name of names) globalThis.VectFox.on(name, () => {});
        expect(names.map(name => host.listeners[name]?.length)).toEqual([1, 1, 1, 1, 1]);
        expect(log.warn).not.toHaveBeenCalled();
    });
});

/** What one event's listeners heard, each payload once. */
function heardOn(name) {
    const heard = [];
    host.listeners[name] = [payload => heard.push(payload)];
    return heard;
}

describe('the EventBase events', () => {
    it('vectfox_eventbase_synced: a run ended, with the chat the collection belongs to, the events it stored and the windows it read', async () => {
        const { announceEventBaseRunEnded } = await loadPublicApi();
        const heard = heardOn('vectfox_eventbase_synced');

        announceEventBaseRunEnded({ collectionId: HARBOR_LATER_EVENTS, eventsAdded: 4, windowsProcessed: 2, insertedEventIds: ['e1'] });

        expect(heard).toEqual([{ chatId: HARBOR_UUID, collectionId: HARBOR_LATER_EVENTS, eventsAdded: 4, windowsProcessed: 2 }]);
        expect(Object.isFrozen(heard[0])).toBe(true);
    });

    it('vectfox_eventbase_events_deleted: the removed events of an EventBase or archive collection, frozen, and nothing for another kind', async () => {
        const { announceEventBaseEventsRemoved } = await loadPublicApi();
        const heard = heardOn('vectfox_eventbase_events_deleted');
        const removed = ['evt-gate', 'evt-tide'];

        announceEventBaseEventsRemoved(HARBOR_EVENTS, removed);
        announceEventBaseEventsRemoved(HARBOR_ARCHIVE, ['evt-old']);
        announceEventBaseEventsRemoved(HARBOR_LORE, ['part-1']);
        announceEventBaseEventsRemoved('vf_lorebook_harbor', ['entry-1']);
        removed.push('evt-later');

        expect(heard).toEqual([
            { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS, eventIds: ['evt-gate', 'evt-tide'] },
            { chatId: ARCHIVE_UUID, collectionId: HARBOR_ARCHIVE, eventIds: ['evt-old'] },
        ]);
        expect(Object.isFrozen(heard[0].eventIds)).toBe(true);
    });

    it('a purged EventBase collection is announced as emptied, with eventIds null, and any other purge says nothing', async () => {
        const { announcePurgedCollection } = await loadPublicApi();
        const heard = heardOn('vectfox_eventbase_events_deleted');

        announcePurgedCollection(HARBOR_EVENTS);
        announcePurgedCollection(HARBOR_LORE);
        announcePurgedCollection('vf_lorebook_harbor');

        expect(heard).toEqual([{ chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS, eventIds: null }]);
    });

    it('vectfox_eventbase_collection_changed: the open chat and the collection it uses, each null with none', async () => {
        const { announceCollectionInUseChanged } = await loadPublicApi();
        const heard = heardOn('vectfox_eventbase_collection_changed');

        announceCollectionInUseChanged({ chatId: HARBOR_UUID, collectionId: HARBOR_LATER_EVENTS });
        announceCollectionInUseChanged({ chatId: HARBOR_UUID, collectionId: null });
        announceCollectionInUseChanged({ chatId: null, collectionId: null });

        expect(heard).toEqual([
            { chatId: HARBOR_UUID, collectionId: HARBOR_LATER_EVENTS },
            { chatId: HARBOR_UUID, collectionId: null },
            { chatId: null, collectionId: null },
        ]);
        expect(heard.every(Object.isFrozen)).toBe(true);
    });
});

describe('vectfox_llm_call_finished', () => {
    const call = {
        feature: 'lorebase', connection: 'profile', profileName: 'Harbor Luna', provider: 'openrouter', model: 'openai/gpt-6-luna',
        durationMs: 812, outcome: 'ok', usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cached_tokens: 64 },
    };

    it('names the call and its tokens, camelCased and frozen, and takes no other field, a key ID included', async () => {
        const { announceLlmCallFinished } = await loadPublicApi();
        const heard = heardOn('vectfox_llm_call_finished');

        announceLlmCallFinished({ ...call, secret_id: 'or-harbor', messages: [{ role: 'user', content: 'Who keeps the lamp?' }] });

        expect(heard).toEqual([{
            feature: 'lorebase', connection: 'profile', profileName: 'Harbor Luna', provider: 'openrouter', model: 'openai/gpt-6-luna',
            durationMs: 812, outcome: 'ok', usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 64 },
        }]);
        expect(Object.isFrozen(heard[0])).toBe(true);
        expect(Object.isFrozen(heard[0].usage)).toBe(true);
    });

    it('leaves usage out when the reply reported no tokens, and says null for a manual call\'s profile', async () => {
        const { announceLlmCallFinished } = await loadPublicApi();
        const heard = heardOn('vectfox_llm_call_finished');

        announceLlmCallFinished({ ...call, connection: 'manual', profileName: null, outcome: 'timed-out', usage: null });

        expect(heard).toHaveLength(1);
        expect(heard[0]).not.toHaveProperty('usage');
        expect(heard[0]).toMatchObject({ connection: 'manual', profileName: null, outcome: 'timed-out' });
    });

    it('does not wait for a listener that never resolves', async () => {
        const { announceLlmCallFinished } = await loadPublicApi();
        let didNextListenerRun = false;
        host.listeners.vectfox_llm_call_finished = [() => new Promise(() => {}), () => { didNextListenerRun = true; }];

        expect(announceLlmCallFinished(call)).toBeUndefined();
        await new Promise(resolve => setTimeout(resolve, 0));

        // SillyTavern's emit waits for each listener in turn, so the next one waits too, but VectFox goes on.
        expect(didNextListenerRun).toBe(false);
    });
});
