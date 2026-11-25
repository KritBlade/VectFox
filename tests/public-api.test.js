/**
 * The `VectFox` object (A1 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md, §4.1): there as soon as
 * src/index.js is evaluated, frozen, ready once initialization ends, and `vectfox_ready` emitted once, without
 * waiting for its listeners; its events (A2, §4.3); its chat group and settings snapshot (R1, §5.2); its eventBase
 * group, the feed of a collection's events and removals (R2, §5.3), which answer `not-ready` until then; and the marker
 * that marks the LLM calls' requests while the PublicAPI page's switch is on (U1). The emitter here behaves as
 * SillyTavern's does: it awaits each listener in turn. EventBase's feed is a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    listeners: {},
    manifest: { version: '3.6.300' },
    manifestError: null,
    // The open chat's metadata, as SillyTavern keeps it: one object, its integrity the chat's UUID.
    chatMetadata: {},
    inUse: { chatId: null, collectionId: null },
    inUseAskedWith: [],
    // EventBase's feed: what it answers, or the error it throws, and what it was asked.
    feed: null,
    feedError: null,
    feedAskedWith: [],
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
// The real collection IDs read a chat's UUID from an ID, and the open chat's from its metadata.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => null, chat_metadata: host.chatMetadata }));
// VectFox's switch is read from the settings the public calls are handed, never from SillyTavern's store.
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: {} }));
// The route VectFox's own readers ask for the open chat and the collection it uses, and EventBase's feed.
vi.mock('../src/features/eventbase/index.js', () => ({
    openChatCollectionInUse: (settings) => {
        host.inUseAskedWith.push(settings);
        return host.inUse;
    },
    readEventFeed: async (settings, read) => {
        host.feedAskedWith.push({ settings, read });
        if (host.feedError) throw host.feedError;
        return host.feed;
    },
}));

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
    const { PUBLIC_API_CAPABILITIES, PUBLIC_API_VERSION } = await import('../src/features/public-api/public-api-core.js');
    return { log, PUBLIC_API_CAPABILITIES, PUBLIC_API_VERSION, ...publicApi };
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
    delete host.chatMetadata.integrity;
    host.inUse = { chatId: null, collectionId: null };
    host.inUseAskedWith = [];
    host.feed = null;
    host.feedError = null;
    host.feedAskedWith = [];
    delete globalThis.VectFox;
});

afterEach(() => {
    delete globalThis.VectFox;
    vi.clearAllMocks();
});

describe('the VectFox object', () => {
    it('is there once published, frozen, at the API\'s version, and not ready until initialization ends', async () => {
        const { publishPublicApi, PUBLIC_API_CAPABILITIES, PUBLIC_API_VERSION } = await loadPublicApi();
        publishPublicApi();
        const api = globalThis.VectFox;

        expect(Object.isFrozen(api)).toBe(true);
        expect(api.apiVersion).toBe(PUBLIC_API_VERSION);
        expect(api.capabilities).toBe(PUBLIC_API_CAPABILITIES);
        expect(Object.isFrozen(api.capabilities)).toBe(true);
        expect(Object.isFrozen(api.chat)).toBe(true);
        expect(Object.isFrozen(api.eventBase)).toBe(true);
        expect(api.isReady()).toBe(false);
        expect(api.extensionVersion).toBeNull();
        expect(() => { api.apiVersion = '2.0.0'; }).toThrow(TypeError);
        expect(() => { api.on = () => {}; }).toThrow(TypeError);
        expect(await hasSettled(api.whenReady())).toBe(false);
    });

    it('turns ready once, and a consumer loaded before VectFox hears vectfox_ready once, frozen', async () => {
        const { publishPublicApi, announcePublicApiReady, PUBLIC_API_VERSION } = await loadPublicApi();
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
        expect(heard).toEqual([{ apiVersion: PUBLIC_API_VERSION }]);
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
        const { publishPublicApi, announcePublicApiReady, PUBLIC_API_VERSION } = await loadPublicApi();
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
        expect(kept).toHaveBeenCalledWith({ apiVersion: PUBLIC_API_VERSION });
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

describe('the mark on VectFox\'s own requests, by the PublicAPI page\'s switch', () => {
    const OWN_REQUEST_MARK = Symbol.for('vectfox.internal-request');
    const markedBy = (marker, feature) => {
        const signal = new AbortController().signal;
        marker(signal, feature);
        return Object.hasOwn(signal, OWN_REQUEST_MARK) ? signal[OWN_REQUEST_MARK] : null;
    };

    it('marks a signal only while the switch is on, read at each call, and none before VectFox is ready', async () => {
        const { announcePublicApiReady, markOwnRequestWhenSwitchedOn, publishPublicApi } = await loadPublicApi();
        publishPublicApi();
        const store = { ...settingsStore(), own_request_mark_enabled: true };
        expect(markedBy(markOwnRequestWhenSwitchedOn, 'eventbase')).toBeNull();

        await announcePublicApiReady(store);
        expect(markedBy(markOwnRequestWhenSwitchedOn, 'storyarc')).toEqual({ label: 'VectFox storyarc' });
        store.own_request_mark_enabled = false;
        expect(markedBy(markOwnRequestWhenSwitchedOn, 'storyarc')).toBeNull();
        store.own_request_mark_enabled = true;
        expect(markedBy(markOwnRequestWhenSwitchedOn, 'agent')).toEqual({ label: 'VectFox agent' });
    });

    it('leaves the signal unmarked for a store that never saved the switch, or holds anything but true', async () => {
        const { announcePublicApiReady, markOwnRequestWhenSwitchedOn, publishPublicApi } = await loadPublicApi();
        publishPublicApi();
        const store = settingsStore();
        await announcePublicApiReady(store);
        expect(markedBy(markOwnRequestWhenSwitchedOn, 'lorebase')).toBeNull();
        store.own_request_mark_enabled = 'true';
        expect(markedBy(markOwnRequestWhenSwitchedOn, 'lorebase')).toBeNull();
    });
});

/** VectFox's settings store as start-up leaves it, with keys beside the listed settings, as a real store holds them. */
function settingsStore() {
    return {
        enabled: true,
        eventbase_ghost_enabled: true,
        eventbase_ghost_keep_recent: 4,
        eventbase_ghost_batch_size: 6,
        summarizer_injection_enabled: true,
        summarizer_injection_count: 15,
        summarizer_injection_full_detail: false,
        summarizer_injection_max_chars: 10000,
        eventbase_autosync_window_turns: 1,
        eventbase_autosync_settle_lag: true,
        openrouter_api_key: 'sk-or-made-up-lantern',
        chat_connection_profile_id: 'profile-lantern',
        qdrant_api_key: 'made-up-qdrant-key',
    };
}

describe('the chat group and the settings snapshot (R1, §5.2)', () => {
    it('answers not-ready from every call until VectFox is ready, frozen, and throws for none', async () => {
        const { publishPublicApi } = await loadPublicApi();
        publishPublicApi();
        host.chatMetadata.integrity = HARBOR_UUID;
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };
        const api = globalThis.VectFox;

        const answers = [api.chat.getChatId(), api.chat.getCollectionInUse(), api.getSettingsSnapshot()];

        expect(answers).toEqual([{ ok: false, reason: 'not-ready' }, { ok: false, reason: 'not-ready' }, { ok: false, reason: 'not-ready' }]);
        expect(answers.every(Object.isFrozen)).toBe(true);
        expect(host.inUseAskedWith).toEqual([]);
    });

    it('chat.getChatId: the open chat\'s UUID, or no-chat with none open', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        await announcePublicApiReady(settingsStore());
        const api = globalThis.VectFox;

        host.chatMetadata.integrity = HARBOR_UUID;
        const open = api.chat.getChatId();
        delete host.chatMetadata.integrity;
        const none = api.chat.getChatId();

        expect(open).toEqual({ ok: true, chatId: HARBOR_UUID });
        expect(none).toEqual({ ok: false, reason: 'no-chat' });
        expect([open, none].every(Object.isFrozen)).toBe(true);
    });

    it('chat.getCollectionInUse: the collection the open chat uses, from the route VectFox reads by, or why there is none', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        const store = settingsStore();
        await announcePublicApiReady(store);
        const api = globalThis.VectFox;

        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_LATER_EVENTS };
        const inUse = api.chat.getCollectionInUse();
        host.inUse = { chatId: HARBOR_UUID, collectionId: null };
        const noCollection = api.chat.getCollectionInUse();
        host.inUse = { chatId: null, collectionId: null };
        const noChat = api.chat.getCollectionInUse();

        expect(inUse).toEqual({ ok: true, collectionId: HARBOR_LATER_EVENTS });
        expect(noCollection).toEqual({ ok: false, reason: 'no-collection' });
        expect(noChat).toEqual({ ok: false, reason: 'no-chat' });
        expect([inUse, noCollection, noChat].every(Object.isFrozen)).toBe(true);
        expect(host.inUseAskedWith.every(settings => settings === store)).toBe(true);
    });

    it('getSettingsSnapshot: the listed settings by their public names, as they are when asked, frozen', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        const store = settingsStore();
        await announcePublicApiReady(store);
        const api = globalThis.VectFox;

        const before = api.getSettingsSnapshot();
        store.eventbase_ghost_batch_size = 10;
        delete store.summarizer_injection_max_chars;
        const after = api.getSettingsSnapshot();

        expect(before).toEqual({
            ok: true,
            settings: {
                enabled: true, ghostingEnabled: true, ghostingKeepRecent: 4, ghostingBatchSize: 6, summarizerInjectionEnabled: true,
                summarizerInjectionCount: 15, summarizerInjectionFullDetail: false, summarizerInjectionMaxChars: 10000,
                autoSyncWindowTurns: 1, autoSyncSettleLag: true, requestMarkEnabled: false,
            },
        });
        expect(after.settings).toMatchObject({ ghostingBatchSize: 10, summarizerInjectionMaxChars: null });
        expect(before.settings.ghostingBatchSize).toBe(6);
        expect(Object.isFrozen(before) && Object.isFrozen(before.settings)).toBe(true);
        expect(() => { before.settings.ghostingEnabled = false; }).toThrow(TypeError);
    });

    it('getSettingsSnapshot reads VectFox\'s switch as its gate does: on unless set to false', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        const store = settingsStore();
        await announcePublicApiReady(store);
        const api = globalThis.VectFox;

        delete store.enabled;
        const unset = api.getSettingsSnapshot().settings.enabled;
        store.enabled = false;
        const off = api.getSettingsSnapshot().settings.enabled;

        expect([unset, off]).toEqual([true, false]);
    });

    it('getSettingsSnapshot reads the mark\'s switch as the marker does, on only when set to true, and a write to it changes nothing', async () => {
        const { publishPublicApi, announcePublicApiReady, markOwnRequestWhenSwitchedOn } = await loadPublicApi();
        publishPublicApi();
        const store = settingsStore();
        await announcePublicApiReady(store);
        const api = globalThis.VectFox;

        const readings = [];
        for (const value of [undefined, false, 'true', 1, true]) {
            if (value === undefined) delete store.own_request_mark_enabled;
            else store.own_request_mark_enabled = value;
            const signal = new AbortController().signal;
            markOwnRequestWhenSwitchedOn(signal, 'eventbase');
            readings.push([api.getSettingsSnapshot().settings.requestMarkEnabled, Object.hasOwn(signal, Symbol.for('vectfox.internal-request'))]);
        }
        expect(readings).toEqual([[false, false], [false, false], [false, false], [false, false], [true, true]]);

        const { settings } = api.getSettingsSnapshot();
        expect(() => { settings.requestMarkEnabled = false; }).toThrow(TypeError);
        expect(store.own_request_mark_enabled).toBe(true);
        expect(api.getSettingsSnapshot().settings.requestMarkEnabled).toBe(true);
    });

    it('the snapshot holds no key or key ID, and only plain values', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        const { PUBLIC_SETTINGS } = await import('../src/features/public-api/public-api-core.js');
        publishPublicApi();
        await announcePublicApiReady(settingsStore());

        const { settings } = globalThis.VectFox.getSettingsSnapshot();
        const written = JSON.stringify(settings);

        expect(Object.entries(PUBLIC_SETTINGS).filter(([name, key]) => /key|secret|token|password|profile/i.test(`${name} ${key}`))).toEqual([]);
        expect(written).not.toMatch(/made-up|sk-or|profile-lantern/);
        expect(Object.values(settings).every(value => value === null || ['boolean', 'number'].includes(typeof value))).toBe(true);
    });
});

/** An event as EventBase's feed gives one, made up. */
function feedEvent(eventId, changeNumber, windowStart = 4) {
    return {
        event_id: eventId,
        summary: `Mara finds a brass key under the pier (${eventId})`,
        cause: 'A storm broke the pier lamps',
        result: 'Tobin keeps the key',
        characters: ['Mara', 'Tobin'],
        locations: ['Saltmarsh harbor'],
        importance: 6,
        DateTime: '1802-04-11T21:00:00.000Z',
        scene_time: 'the night the lighthouse went dark',
        source_window_start: windowStart,
        source_window_end: windowStart + 1,
        change_number: changeNumber,
    };
}

/** That event by the public names listEvents gives it. */
function publicEvent(event) {
    return {
        eventId: event.event_id,
        summary: event.summary,
        cause: event.cause,
        result: event.result,
        characters: event.characters,
        locations: event.locations,
        importance: event.importance,
        storyTime: event.DateTime,
        sceneTime: event.scene_time,
        windowStart: event.source_window_start,
        windowEnd: event.source_window_end,
        cursor: event.change_number,
    };
}

/** What the feed answers for a read. */
const feedPage = parts => ({ supported: true, schemaVersion: 1.3, events: [], removedEventIds: [], emptied: false, cursor: 0, hasMore: false, ...parts });

/** The object published and ready, with the settings store it answers from. */
async function readyPublicApi() {
    const loaded = await loadPublicApi();
    loaded.publishPublicApi();
    const store = settingsStore();
    await loaded.announcePublicApiReady(store);
    return { ...loaded, api: globalThis.VectFox, store };
}

describe('the eventBase group: EventBase\'s feed (R2, §5.3)', () => {
    it('answers not-ready until VectFox is ready, frozen, and reads nothing', async () => {
        const { publishPublicApi } = await loadPublicApi();
        publishPublicApi();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };

        const answer = await globalThis.VectFox.eventBase.listEvents();

        expect(answer).toEqual({ ok: false, reason: 'not-ready' });
        expect(Object.isFrozen(answer)).toBe(true);
        expect(host.feedAskedWith).toEqual([]);
    });

    it('rejects with a TypeError a request that cannot be right, ready or not, and reads nothing', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        const { listEvents } = globalThis.VectFox.eventBase;
        const wrong = [
            'harbor', null, [], { after: -1 }, { after: 1.5 }, { after: '3' }, { collectionId: HARBOR_LORE }, { collectionId: 42 },
            { chatId: '' }, { chatId: 7 },
        ];

        for (const request of wrong) await expect(listEvents(request), JSON.stringify(request)).rejects.toThrow(TypeError);
        await announcePublicApiReady(settingsStore());
        for (const request of wrong) await expect(listEvents(request), JSON.stringify(request)).rejects.toThrow(TypeError);
        expect(host.feedAskedWith).toEqual([]);
    });

    it('reads the collection the open chat uses, every event with no after, by public names, frozen throughout', async () => {
        const { api, store } = await readyPublicApi();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };
        const pier = feedEvent('eb-pier', 0, 0);
        const ferry = feedEvent('eb-ferry', 5);
        host.feed = feedPage({ events: [pier, ferry], cursor: 7 });

        const answer = await api.eventBase.listEvents();

        expect(host.feedAskedWith).toEqual([{ settings: store, read: { collectionId: HARBOR_EVENTS, after: null } }]);
        expect(answer).toEqual({
            ok: true, schemaVersion: '1.3', collectionId: HARBOR_EVENTS, events: [publicEvent(pier), publicEvent(ferry)],
            removedEventIds: [], emptied: false, cursor: 7, hasMore: false,
        });
        expect([answer, answer.events, answer.removedEventIds, ...answer.events].every(Object.isFrozen)).toBe(true);
        expect(answer.events.every(event => Object.isFrozen(event.characters) && Object.isFrozen(event.locations))).toBe(true);
        expect(answer.events[0].characters).not.toBe(pier.characters);
    });

    it('reads after a number: the events written since, the removals and the cursor to read on from', async () => {
        const { api } = await readyPublicApi();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };
        const storm = feedEvent('eb-storm', 9);
        host.feed = feedPage({ events: [storm], removedEventIds: ['eb-pier'], cursor: 10, hasMore: true });

        const answer = await api.eventBase.listEvents({ after: 7 });

        expect(host.feedAskedWith[0].read).toEqual({ collectionId: HARBOR_EVENTS, after: 7 });
        expect(answer).toMatchObject({ ok: true, events: [publicEvent(storm)], removedEventIds: ['eb-pier'], emptied: false, cursor: 10, hasMore: true });
    });

    it('says a collection emptied since was emptied, with only what was written after', async () => {
        const { api } = await readyPublicApi();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };
        const restored = feedEvent('eb-restored', 12);
        host.feed = feedPage({ events: [restored], emptied: true, cursor: 12 });

        const answer = await api.eventBase.listEvents({ after: 9 });

        expect(answer).toMatchObject({ ok: true, emptied: true, events: [publicEvent(restored)], cursor: 12 });
    });

    it('reads a collection named, with no chat open, and refuses one that is not the chat named', async () => {
        const { api } = await readyPublicApi();
        host.feed = feedPage({ cursor: 3 });

        const named = await api.eventBase.listEvents({ collectionId: HARBOR_ARCHIVE, after: 0 });
        const ofItsChat = await api.eventBase.listEvents({ chatId: ARCHIVE_UUID, collectionId: HARBOR_ARCHIVE });
        const ofAnotherChat = await api.eventBase.listEvents({ chatId: HARBOR_UUID, collectionId: HARBOR_ARCHIVE });

        expect(named).toMatchObject({ ok: true, collectionId: HARBOR_ARCHIVE, cursor: 3 });
        expect(ofItsChat).toMatchObject({ ok: true, collectionId: HARBOR_ARCHIVE });
        expect(ofAnotherChat).toEqual({ ok: false, reason: 'no-collection' });
        expect(host.feedAskedWith.map(({ read }) => read)).toEqual([
            { collectionId: HARBOR_ARCHIVE, after: 0 },
            { collectionId: HARBOR_ARCHIVE, after: null },
        ]);
        expect(host.inUseAskedWith).toEqual([]);
    });

    it('with no collection named: no-chat with none open or another open than the chat named, no-collection with none in use', async () => {
        const { api } = await readyPublicApi();
        host.feed = feedPage({ cursor: 4 });

        const noneOpen = await api.eventBase.listEvents();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };
        const anotherOpen = await api.eventBase.listEvents({ chatId: ARCHIVE_UUID });
        const thisOneOpen = await api.eventBase.listEvents({ chatId: HARBOR_UUID });
        host.inUse = { chatId: HARBOR_UUID, collectionId: null };
        const noneInUse = await api.eventBase.listEvents({ chatId: HARBOR_UUID });

        expect([noneOpen, anotherOpen, noneInUse]).toEqual([
            { ok: false, reason: 'no-chat' }, { ok: false, reason: 'no-chat' }, { ok: false, reason: 'no-collection' },
        ]);
        expect(thisOneOpen).toMatchObject({ ok: true, collectionId: HARBOR_EVENTS });
        expect(host.feedAskedWith).toHaveLength(1);
    });

    it('answers backend-unsupported for a backend without change numbers and read-failed for a read that failed, each said in the console', async () => {
        const { api, log } = await readyPublicApi();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };

        host.feed = { supported: false, reason: 'Change numbers are kept on Qdrant only, and StandardBackend keeps none.' };
        const unsupported = await api.eventBase.listEvents();
        host.feedError = new Error('Qdrant not initialized');
        const failed = await api.eventBase.listEvents({ after: 3 });

        expect(unsupported).toEqual({ ok: false, reason: 'backend-unsupported' });
        expect(failed).toEqual({ ok: false, reason: 'read-failed' });
        expect([unsupported, failed].every(Object.isFrozen)).toBe(true);
        expect(log.verbose).toHaveBeenCalledWith(expect.stringContaining('StandardBackend keeps none'));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(HARBOR_EVENTS), host.feedError);
    });

    it('reads the chat\'s other collection once a lock moves it there, which vectfox_eventbase_collection_changed announces', async () => {
        const { api, announceCollectionInUseChanged } = await readyPublicApi();
        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_EVENTS };
        host.feed = feedPage({ cursor: 2 });
        const reads = [];
        api.on('vectfox_eventbase_collection_changed', () => { reads.push(api.eventBase.listEvents()); });

        host.inUse = { chatId: HARBOR_UUID, collectionId: HARBOR_LATER_EVENTS };
        announceCollectionInUseChanged(host.inUse);
        const [answer] = await Promise.all(reads);

        expect(answer).toMatchObject({ ok: true, collectionId: HARBOR_LATER_EVENTS });
        expect(host.feedAskedWith.map(({ read }) => read.collectionId)).toEqual([HARBOR_LATER_EVENTS]);
    });
});
