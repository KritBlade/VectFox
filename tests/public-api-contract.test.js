/**
 * The public API's contract (A3 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md): every name another extension
 * reads, pinned in CONTRACT. The test goes red when a member of the `VectFox` object or of one of its groups, an event, a
 * payload field, a capability, a reason, a field of a call's answer, a setting of the snapshot, a field of an EventBase
 * event listEvents gives, a value an LLM call's report names, a field of a message source or of what it is asked with,
 * how deep story order opens summaries, or the key, place, fields or label of the mark on VectFox's own requests is
 * renamed, removed or added, when `apiVersion` differs from the contract's, and when the developer page
 * (Doc/public-api.md) leaves a name out or names an event VectFox does not emit. A change to CONTRACT follows the version
 * rule (§4.4, D3): an added name raises apiVersion's minor version; a removed, renamed or changed one raises its major
 * version.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONTRACT = Object.freeze({
    apiVersion: '1.4.0',
    // Each member of globalThis.VectFox and what it is.
    members: {
        apiVersion: 'string',
        extensionVersion: 'getter',
        capabilities: 'list',
        isReady: 'method',
        whenReady: 'method',
        on: 'method',
        off: 'method',
        chat: 'group',
        getSettingsSnapshot: 'method',
        eventBase: 'group',
    },
    // Each group's members.
    groups: {
        chat: { getChatId: 'method', getCollectionInUse: 'method', registerMessageSource: 'method' },
        eventBase: { listEvents: 'method' },
    },
    capabilities: ['events', 'chat', 'settings', 'eventbase.read', 'chat.messageSource'],
    // A message source (§5.4): the fields registerMessageSource takes, the fields of what originalsOf is asked with
    // beside the message, and how many summaries deep story order opens.
    messageSource: { registration: ['owner', 'originalsOf'], asked: ['chatMetadata'], maxSummaryDepth: 64 },
    // Why a call answers no (§4.2).
    reasons: ['not-ready', 'no-chat', 'no-collection', 'backend-unsupported', 'read-failed'],
    // The fields of each answer: a refusal, and each call's answer of yes.
    answers: {
        refusal: ['ok', 'reason'],
        getChatId: ['ok', 'chatId'],
        getCollectionInUse: ['ok', 'collectionId'],
        getSettingsSnapshot: ['ok', 'settings'],
        listEvents: ['ok', 'schemaVersion', 'collectionId', 'events', 'removedEventIds', 'emptied', 'cursor', 'hasMore'],
    },
    // The settings getSettingsSnapshot() gives, by their public names.
    settings: [
        'enabled', 'ghostingEnabled', 'ghostingKeepRecent', 'ghostingBatchSize', 'summarizerInjectionEnabled',
        'summarizerInjectionCount', 'summarizerInjectionFullDetail', 'summarizerInjectionMaxChars', 'autoSyncWindowTurns',
        'autoSyncSettleLag', 'requestMarkEnabled',
    ],
    // The fields of each EventBase event listEvents() gives.
    eventFields: [
        'eventId', 'summary', 'cause', 'result', 'characters', 'locations', 'importance', 'storyTime', 'sceneTime',
        'windowStart', 'windowEnd', 'cursor',
    ],
    // Each event and the fields of its payload.
    events: {
        vectfox_ready: ['apiVersion'],
        vectfox_eventbase_synced: ['chatId', 'collectionId', 'eventsAdded', 'windowsProcessed'],
        vectfox_eventbase_events_deleted: ['chatId', 'collectionId', 'eventIds'],
        vectfox_eventbase_collection_changed: ['chatId', 'collectionId'],
        vectfox_llm_call_finished: ['feature', 'connection', 'profileName', 'provider', 'model', 'durationMs', 'outcome', 'usage'],
    },
    llmCallUsage: ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'],
    // The values an LLM call's report gives its fields.
    llmCallValues: {
        feature: ['eventbase', 'lorebase', 'storyarc', 'agent'],
        connection: ['profile', 'manual'],
        outcome: ['ok', 'timed-out', 'failed'],
    },
    // The mark on VectFox's own requests: its Symbol.for key, where a fetch wrapper reads it, the fields of its value,
    // and its label, with the call's feature in place of <feature>.
    ownRequestMark: { key: 'vectfox.internal-request', readFrom: 'init.signal', fields: ['label'], label: 'VectFox <feature>' },
});

const host = vi.hoisted(() => ({ listeners: {}, chatMetadata: {}, context: {}, inUse: { chatId: null, collectionId: null }, feed: null, feedError: null }));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: {
        on: (event, listener) => { (host.listeners[event] ??= []).push(listener); },
        removeListener: (event, listener) => {
            const listeners = host.listeners[event] ?? [];
            const index = listeners.indexOf(listener);
            if (index > -1) listeners.splice(index, 1);
        },
        emit: async (event, ...args) => {
            for (const listener of (host.listeners[event] ?? []).slice()) await listener(...args);
        },
    },
    event_types: {},
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/shared/extension-manifest.js', () => ({ loadExtensionManifest: async () => ({ version: '3.6.300' }) }));
// The real collection IDs read a chat's UUID from an ID, and the open chat's from its metadata.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context, getCurrentChatId: () => null, chat_metadata: host.chatMetadata }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: {} }));
vi.mock('../src/features/eventbase/index.js', () => ({
    openChatCollectionInUse: () => host.inUse,
    readEventFeed: async () => {
        if (host.feedError) throw host.feedError;
        return host.feed;
    },
}));

const LANTERN_UUID = 'cccccccc-3333-4333-8333-cccccccccccc';
const LANTERN_EVENTS = `vf_eventbase_qdrant_wren_lantern_${LANTERN_UUID}`;

/** A made-up event as EventBase's feed gives one. */
const LANTERN_EVENT = Object.freeze({
    event_id: 'evt-lamp', summary: 'Wren trims the lantern wick', cause: '', result: '', characters: ['Wren'], locations: ['the lighthouse'],
    importance: 4, DateTime: null, scene_time: '', source_window_start: 2, source_window_end: 3, change_number: 8,
});

/** The modules fresh, as a page load gives them, and the object published. */
async function loadPublishedApi() {
    vi.resetModules();
    const publicApi = await import('../src/features/public-api/index.js');
    const core = await import('../src/features/public-api/public-api-core.js');
    const llmCallReport = await import('../src/features/llm-provider/llm-call-report.js');
    publicApi.publishPublicApi();
    return { api: globalThis.VectFox, publicApi, core, llmCallReport };
}

/** What a member of the object or of a group is, in CONTRACT's words. */
function kindOf(owner, name) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor.get) return 'getter';
    if (typeof descriptor.value === 'function') return 'method';
    if (Array.isArray(descriptor.value)) return 'list';
    if (descriptor.value && typeof descriptor.value === 'object') return 'group';
    return typeof descriptor.value;
}

/** Each member of an object and what it is. */
const kindsOf = owner => Object.fromEntries(Object.getOwnPropertyNames(owner).map(name => [name, kindOf(owner, name)]));

/** The payload each event's listener hears through VectFox.on, as another extension hears it. */
async function heardPayloads(api, publicApi) {
    const heard = {};
    for (const name of Object.keys(CONTRACT.events)) api.on(name, payload => { (heard[name] ??= []).push(payload); });
    await publicApi.announcePublicApiReady({});
    publicApi.announceEventBaseRunEnded({ collectionId: LANTERN_EVENTS, eventsAdded: 3, windowsProcessed: 1 });
    publicApi.announceEventBaseEventsRemoved(LANTERN_EVENTS, ['evt-lamp']);
    publicApi.announceCollectionInUseChanged({ chatId: LANTERN_UUID, collectionId: LANTERN_EVENTS });
    publicApi.announceLlmCallFinished({
        feature: 'eventbase', connection: 'profile', profileName: 'Lantern Luna', provider: 'openrouter', model: 'openai/gpt-6-luna',
        durationMs: 640, outcome: 'ok', usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102, cached_tokens: null },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    return heard;
}

const sorted = names => [...names].sort();

beforeEach(() => {
    host.listeners = {};
    delete host.chatMetadata.integrity;
    host.context = {};
    host.inUse = { chatId: null, collectionId: null };
    host.feed = null;
    host.feedError = null;
    delete globalThis.VectFox;
});

afterEach(() => {
    delete globalThis.VectFox;
    vi.clearAllMocks();
});

describe('the contract of the VectFox object', () => {
    it('is at the contract\'s apiVersion', async () => {
        const { api, core } = await loadPublishedApi();
        expect(core.PUBLIC_API_VERSION).toBe(CONTRACT.apiVersion);
        expect(api.apiVersion).toBe(CONTRACT.apiVersion);
    });

    it('has exactly the contract\'s members, each of its kind, and is frozen', async () => {
        const { api } = await loadPublishedApi();
        expect(kindsOf(api)).toEqual(CONTRACT.members);
        expect(Object.isFrozen(api)).toBe(true);
    });

    it('has exactly the contract\'s groups, each with the contract\'s members, frozen', async () => {
        const { api } = await loadPublishedApi();
        for (const [group, members] of Object.entries(CONTRACT.groups)) {
            expect(kindsOf(api[group]), group).toEqual(members);
            expect(Object.isFrozen(api[group]), group).toBe(true);
        }
    });

    it('answers as the contract says: isReady a boolean, whenReady a promise, on its own unsubscribe, off nothing', async () => {
        const { api } = await loadPublishedApi();
        expect(typeof api.isReady()).toBe('boolean');
        expect(api.whenReady()).toBeInstanceOf(Promise);
        const handler = () => {};
        expect(typeof api.on('vectfox_ready', handler)).toBe('function');
        expect(api.off('vectfox_ready', handler)).toBeUndefined();
        expect(api.extensionVersion).toBeNull();
    });

    it('serves exactly the contract\'s capabilities', async () => {
        const { api } = await loadPublishedApi();
        expect(api.capabilities).toEqual(CONTRACT.capabilities);
        expect(Object.isFrozen(api.capabilities)).toBe(true);
    });
});

describe('the contract of the calls', () => {
    it('answers no with exactly the contract\'s reasons', async () => {
        const { core } = await loadPublishedApi();
        expect(sorted(Object.values(core.PUBLIC_API_REASONS))).toEqual(sorted(CONTRACT.reasons));
    });

    it('answers each call with exactly the contract\'s fields, frozen, the snapshot with exactly its settings and an event with exactly its fields', async () => {
        const { api, publicApi } = await loadPublishedApi();
        const calls = {
            getChatId: () => api.chat.getChatId(),
            getCollectionInUse: () => api.chat.getCollectionInUse(),
            getSettingsSnapshot: () => api.getSettingsSnapshot(),
            listEvents: () => api.eventBase.listEvents(),
        };
        const refusals = await Promise.all(Object.values(calls).map(call => call()));
        await publicApi.announcePublicApiReady({ enabled: true });
        const refusedWithNoChat = [calls.getChatId(), calls.getCollectionInUse(), await calls.listEvents()];
        host.chatMetadata.integrity = LANTERN_UUID;
        host.inUse = { chatId: LANTERN_UUID, collectionId: null };
        refusals.push(calls.getCollectionInUse(), ...refusedWithNoChat);
        host.inUse = { chatId: LANTERN_UUID, collectionId: LANTERN_EVENTS };
        host.feed = { supported: false, reason: 'Change numbers are kept on Qdrant only.' };
        refusals.push(await calls.listEvents());
        host.feedError = new Error('Qdrant not initialized');
        refusals.push(await calls.listEvents());
        host.feedError = null;
        host.feed = { supported: true, schemaVersion: 1.3, events: [LANTERN_EVENT], removedEventIds: ['evt-wick'], emptied: false, cursor: 8, hasMore: false };

        for (const refusal of refusals) {
            expect(sorted(Object.keys(refusal))).toEqual(sorted(CONTRACT.answers.refusal));
            expect(CONTRACT.reasons).toContain(refusal.reason);
            expect(Object.isFrozen(refusal)).toBe(true);
        }
        expect(sorted(new Set(refusals.map(refusal => refusal.reason)))).toEqual(sorted(CONTRACT.reasons));
        for (const [name, call] of Object.entries(calls)) {
            const answer = await call();
            expect(answer.ok, name).toBe(true);
            expect(sorted(Object.keys(answer)), name).toEqual(sorted(CONTRACT.answers[name]));
            expect(Object.isFrozen(answer), name).toBe(true);
        }
        expect(sorted(Object.keys(calls.getSettingsSnapshot().settings))).toEqual(sorted(CONTRACT.settings));
        const [event] = (await calls.listEvents()).events;
        expect(sorted(Object.keys(event))).toEqual(sorted(CONTRACT.eventFields));
        expect(Object.isFrozen(event)).toBe(true);
    });
});

describe('the contract of the events', () => {
    it('emits exactly the contract\'s events', async () => {
        const { core } = await loadPublishedApi();
        expect(sorted(Object.values(core.PUBLIC_EVENTS))).toEqual(sorted(Object.keys(CONTRACT.events)));
    });

    it('sends each event with exactly the contract\'s fields, frozen', async () => {
        const { api, publicApi } = await loadPublishedApi();
        const heard = await heardPayloads(api, publicApi);
        for (const [name, fields] of Object.entries(CONTRACT.events)) {
            expect(heard[name], name).toHaveLength(1);
            expect(sorted(Object.keys(heard[name][0])), name).toEqual(sorted(fields));
            expect(Object.isFrozen(heard[name][0]), name).toBe(true);
        }
        const { usage } = heard.vectfox_llm_call_finished[0];
        expect(sorted(Object.keys(usage))).toEqual(sorted(CONTRACT.llmCallUsage));
        expect(Object.isFrozen(usage)).toBe(true);
    });

    it('names an LLM call\'s feature, connection and outcome with exactly the contract\'s values', async () => {
        const { llmCallReport } = await loadPublishedApi();
        expect({
            feature: sorted(Object.values(llmCallReport.LLM_CALL_FEATURES)),
            connection: sorted(Object.values(llmCallReport.LLM_CALL_CONNECTIONS)),
            outcome: sorted(Object.values(llmCallReport.LLM_CALL_OUTCOMES)),
        }).toEqual(Object.fromEntries(Object.entries(CONTRACT.llmCallValues).map(([field, values]) => [field, sorted(values)])));
    });
});

describe('the contract of a message source', () => {
    it('takes exactly the contract\'s fields, gives its own unregister, and is asked with the message and exactly the contract\'s fields, frozen', async () => {
        const { api, publicApi } = await loadPublishedApi();
        const { setMessageSource, storyMessages } = await import('../src/shared/chat-messages.js');
        const { MAX_SUMMARY_DEPTH } = await import('../src/shared/chat-messages-core.js');
        setMessageSource(publicApi.askMessageSources);
        const lamp = { name: 'Wren', mes: 'Wren trims the lantern wick.' };
        const summary = { name: 'Summary', mes: 'Wren keeps the lighthouse.', fields: [lamp] };
        host.context = { chat: [summary], chatMetadata: { integrity: LANTERN_UUID } };
        const asked = [];
        const registration = {
            owner: 'Lantern summaries',
            originalsOf: (message, context) => {
                asked.push({ message, context });
                return message.fields ?? null;
            },
        };
        expect(sorted(Object.keys(registration))).toEqual(sorted(CONTRACT.messageSource.registration));

        const unregister = api.chat.registerMessageSource(registration);
        expect(typeof unregister).toBe('function');
        expect(storyMessages()).toEqual([lamp]);
        expect(asked.map(({ message }) => message)).toEqual([summary, lamp]);
        for (const { context } of asked) {
            expect(sorted(Object.keys(context))).toEqual(sorted(CONTRACT.messageSource.asked));
            expect(context.chatMetadata).toBe(host.context.chatMetadata);
            expect(Object.isFrozen(context)).toBe(true);
        }
        expect(MAX_SUMMARY_DEPTH).toBe(CONTRACT.messageSource.maxSummaryDepth);
        expect(unregister()).toBeUndefined();
        expect(storyMessages()).toEqual([summary]);
    });
});

describe('the contract of the mark on VectFox\'s own requests', () => {
    it('writes exactly the contract\'s mark for each feature on the request\'s signal: under its key, frozen, not enumerable', async () => {
        const { core } = await loadPublishedApi();
        for (const feature of CONTRACT.llmCallValues.feature) {
            const signal = new AbortController().signal;
            const init = { method: 'POST', body: '{}', signal };
            core.markOwnRequest(signal, feature);
            const key = Symbol.for(CONTRACT.ownRequestMark.key);
            const mark = init.signal[key];
            expect(sorted(Object.keys(mark)), feature).toEqual(sorted(CONTRACT.ownRequestMark.fields));
            expect(mark.label, feature).toBe(CONTRACT.ownRequestMark.label.replace('<feature>', feature));
            expect(Object.isFrozen(mark), feature).toBe(true);
            expect(Object.getOwnPropertyDescriptor(signal, key).enumerable, feature).toBe(false);
        }
    });
});

describe('the developer page', () => {
    // The page's inline code, its examples left out: an example may name anything.
    const page = readFileSync(fileURLToPath(new URL('../Doc/public-api.md', import.meta.url)), 'utf8');
    const inlineCode = [...page.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(match => match[1]);
    const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isNamed = name => inlineCode.some(code => new RegExp(`(^|[^A-Za-z0-9_])${escaped(name)}($|[^A-Za-z0-9_])`).test(code));

    it('names every member, group member, capability, reason, answer field, setting, event field, event, payload field, value, message source field and mark of the contract', () => {
        const quoted = value => `'${value}'`;
        const names = [
            ...Object.keys(CONTRACT.members),
            ...Object.values(CONTRACT.groups).flatMap(members => Object.keys(members)),
            ...CONTRACT.capabilities.map(quoted),
            ...CONTRACT.messageSource.registration,
            ...CONTRACT.messageSource.asked,
            ...CONTRACT.reasons.map(quoted),
            ...Object.values(CONTRACT.answers).flat(),
            ...CONTRACT.settings,
            ...CONTRACT.eventFields,
            ...Object.entries(CONTRACT.events).flatMap(([name, fields]) => [name, ...fields]),
            ...CONTRACT.llmCallUsage,
            ...Object.values(CONTRACT.llmCallValues).flat().map(quoted),
            CONTRACT.ownRequestMark.key,
            CONTRACT.ownRequestMark.readFrom,
            ...CONTRACT.ownRequestMark.fields,
        ];
        expect([...new Set(names)].filter(name => !isNamed(name))).toEqual([]);
    });

    it('names no event VectFox does not emit', () => {
        const named = new Set(inlineCode.flatMap(code => code.match(/\bvectfox_[a-z]+(?:_[a-z]+)*\b/g) ?? []));
        expect([...named].filter(name => !Object.hasOwn(CONTRACT.events, name))).toEqual([]);
    });
});
