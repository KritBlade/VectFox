/**
 * The public API's contract (A3 of InternalProject/Vectfox/plans/vectfox-public-api.md): every name another extension
 * reads, pinned in CONTRACT. The test goes red when a member of the `VectFox` object, an event, a payload field, a
 * capability or a value an LLM call's report names is renamed, removed or added, when `apiVersion` differs from the
 * contract's, and when the developer page (Doc/public-api.md) leaves a name out or names an event VectFox does not emit.
 * A change to CONTRACT follows the version rule (§4.4, D3): an added name raises apiVersion's minor version; a removed,
 * renamed or changed one raises its major version.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONTRACT = Object.freeze({
    apiVersion: '1.0.0',
    // Each member of globalThis.VectFox and what it is.
    members: {
        apiVersion: 'string',
        extensionVersion: 'getter',
        capabilities: 'list',
        isReady: 'method',
        whenReady: 'method',
        on: 'method',
        off: 'method',
    },
    capabilities: ['events'],
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
});

const host = vi.hoisted(() => ({ listeners: {} }));

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
// The real collection IDs read a chat's UUID from an ID alone; the open chat is not asked.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => null, chat_metadata: {} }));

const LANTERN_UUID = 'cccccccc-3333-4333-8333-cccccccccccc';
const LANTERN_EVENTS = `vf_eventbase_qdrant_wren_lantern_${LANTERN_UUID}`;

/** The modules fresh, as a page load gives them, and the object published. */
async function loadPublishedApi() {
    vi.resetModules();
    const publicApi = await import('../src/features/public-api/index.js');
    const core = await import('../src/features/public-api/public-api-core.js');
    const llmCallReport = await import('../src/features/llm-provider/llm-call-report.js');
    publicApi.publishPublicApi();
    return { api: globalThis.VectFox, publicApi, core, llmCallReport };
}

/** What a member of the object is, in CONTRACT's words. */
function kindOf(api, name) {
    const descriptor = Object.getOwnPropertyDescriptor(api, name);
    if (descriptor.get) return 'getter';
    if (typeof descriptor.value === 'function') return 'method';
    if (Array.isArray(descriptor.value)) return 'list';
    return typeof descriptor.value;
}

/** The payload each event's listener hears through VectFox.on, as another extension hears it. */
async function heardPayloads(api, publicApi) {
    const heard = {};
    for (const name of Object.keys(CONTRACT.events)) api.on(name, payload => { (heard[name] ??= []).push(payload); });
    await publicApi.announcePublicApiReady();
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
        expect(sorted(Object.getOwnPropertyNames(api))).toEqual(sorted(Object.keys(CONTRACT.members)));
        expect(Object.fromEntries(Object.keys(CONTRACT.members).map(name => [name, kindOf(api, name)]))).toEqual(CONTRACT.members);
        expect(Object.isFrozen(api)).toBe(true);
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

describe('the developer page', () => {
    // The page's inline code, its examples left out: an example may name anything.
    const page = readFileSync(fileURLToPath(new URL('../Doc/public-api.md', import.meta.url)), 'utf8');
    const inlineCode = [...page.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(match => match[1]);
    const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isNamed = name => inlineCode.some(code => new RegExp(`(^|[^A-Za-z0-9_])${escaped(name)}($|[^A-Za-z0-9_])`).test(code));

    it('names every member, capability, event, payload field and value of the contract', () => {
        const quoted = value => `'${value}'`;
        const names = [
            ...Object.keys(CONTRACT.members),
            ...CONTRACT.capabilities.map(quoted),
            ...Object.entries(CONTRACT.events).flatMap(([name, fields]) => [name, ...fields]),
            ...CONTRACT.llmCallUsage,
            ...Object.values(CONTRACT.llmCallValues).flat().map(quoted),
        ];
        expect(names.filter(name => !isNamed(name))).toEqual([]);
    });

    it('names no event VectFox does not emit', () => {
        const named = new Set(inlineCode.flatMap(code => code.match(/\bvectfox_[a-z]+(?:_[a-z]+)*\b/g) ?? []));
        expect([...named].filter(name => !Object.hasOwn(CONTRACT.events, name))).toEqual([]);
    });
});
