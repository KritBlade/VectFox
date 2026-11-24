/**
 * The `VectFox` object (A1 of InternalProject/Vectfox/plans/vectfox-public-api.md, §4.1): there as soon as
 * src/index.js is evaluated, frozen, ready once initialization ends, and `vectfox_ready` emitted once, without
 * waiting for its listeners; its events (A2, §4.3); and its chat group and settings snapshot (R1, §5.2), which answer
 * `not-ready` until then. The emitter here behaves as SillyTavern's does: it awaits each listener in turn.
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
// The route VectFox's own readers ask for the open chat and the collection it uses.
vi.mock('../src/features/eventbase/index.js', () => ({
    openChatCollectionInUse: (settings) => {
        host.inUseAskedWith.push(settings);
        return host.inUse;
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
                autoSyncWindowTurns: 1, autoSyncSettleLag: true,
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
