/**
 * @vitest-environment jsdom
 *
 * The Provider dropdowns of the EventBase model, Agent Mode, Auto-Reformat, StoryArc and embedding, on their real page
 * markup (src/features/settings-panel/connection-rows.js, connection plan §1 and §3): each offers a SillyTavern
 * profile first, after Same as EventBase model where it has that; choosing it shows a Profile dropdown of the profiles
 * SillyTavern can use and a readout, and hides the rows a profile supplies; a deleted profile and the Connection
 * Manager switched off say so in the dropdown; the dropdowns repaint when SillyTavern makes, saves or deletes a profile;
 * Agent Mode and Auto-Reformat on Same as EventBase model name the EventBase model's profile; embedding never stores the
 * profile option itself, opens on it for a new install's Custom type with no profile, and choosing a profile stores its
 * ID and type; each Test connection runs its feature's test on the panel's settings and reports the answer.
 */
/* global document, toastr -- this file runs under the jsdom environment, and stubs SillyTavern's toastr per test */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    saveSettingsDebounced: vi.fn(),
    onEmbeddingProviderChange: vi.fn(),
    context: null,
    listeners: {},
    resolvedEmbedding: null,
    backend: null,
    tests: { eventbase: null, agent: null, reformat: null, storyarc: null },
}));

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/sillytavern/secrets.js', () => ({ SECRET_KEYS: {}, deleteSecret: vi.fn(), readSecretState: vi.fn(), secret_state: {}, writeSecret: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/settings.js', () => ({
    extension_settings: host.extensionSettings,
    saveSettingsDebounced: host.saveSettingsDebounced,
}));
vi.mock('../src/features/chunkbase/index.js', () => ({ testAutoReformatConnection: (...args) => host.tests.reformat(...args) }));
vi.mock('../src/features/eventbase/index.js', () => ({
    testAgentModeConnection: (...args) => host.tests.agent(...args),
    testEventBaseConnection: (...args) => host.tests.eventbase(...args),
    testStoryArcConnection: (...args) => host.tests.storyarc(...args),
}));
vi.mock('../src/features/vector-backend/index.js', () => ({ getBackend: vi.fn(async () => host.backend) }));
vi.mock('../src/features/embedding/index.js', async () => {
    const core = await vi.importActual('../src/features/embedding/embedding-profile-core.js');
    return { embeddingProfileKind: core.embeddingProfileKind, resolveEmbeddingProfile: vi.fn(() => host.resolvedEmbedding) };
});

const { corePageMarkup } = await import('../src/features/settings-panel/core-page-markup.js');
const { agentModePageMarkup } = await import('../src/features/settings-panel/agentmode-page-markup.js');
const { chunkBasePageMarkup } = await import('../src/features/settings-panel/chunkbase-page-markup.js');
const { storyArcPageMarkup } = await import('../src/features/eventbase/story-arc-page-markup.js');
const { wireConnectionRows } = await import('../src/features/settings-panel/connection-rows.js');

const CONNECT_API_MAP = {
    openrouter: { selected: 'openai', source: 'openrouter' },
    custom: { selected: 'openai', source: 'custom' },
    ollama: { selected: 'textgenerationwebui', type: 'ollama' },
    kcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' },
    novel: { selected: 'novel' },
};
const profileFixtures = () => [
    { id: 'p-harbor', name: 'Harbor', api: 'openrouter', model: 'harbor/chat-model', 'secret-id': 'secret-1' },
    { id: 'p-lantern', name: 'Lantern', api: 'custom', model: 'lantern-embed' },
    { id: 'p-meadow', name: 'Meadow', api: 'ollama', model: 'meadow-embed' },
    { id: 'p-kiln', name: 'Kiln', api: 'kcpp', model: '', 'secret-id': 'secret-2' },
    { id: 'p-quill', name: 'Quill', api: 'novel', model: 'quill-story' },
];
const EVENT_TYPES = {
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
};
const PROVIDER_SELECTS = ['VectFox_summarize_provider', 'VectFox_agentic_provider', 'VectFox_reformat_provider', 'VectFox_story_arc_link_provider', 'VectFox_source'];

const baseSettings = () => ({
    chat_provider: 'openrouter', chat_connection_profile_id: '',
    agent_provider: '', agent_connection_profile_id: '',
    reformat_provider: '', reformat_connection_profile_id: '',
    story_arc_link_provider: 'openrouter', story_arc_link_connection_profile_id: '',
    embedding_provider: 'transformers', embedding_connection_profile_id: '',
});

const element = id => document.getElementById(id);
const isShown = node => node.style.display !== 'none';
const isFieldShown = inputId => isShown(element(inputId).closest('.vfx-field'));
const choose = (id, value) => $(`#${id}`).val(value).trigger('change');
const optionsOf = id => [...element(id).options].map(option => ({ value: option.value, text: option.textContent, isDisabled: option.disabled, isSelected: option.selected }));
const linesOf = id => [...element(id).querySelectorAll('li')].map(line => line.textContent.replace(/\s+/g, ' ').trim());
const emit = type => (host.listeners[type] ?? []).forEach(listener => listener());
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function mount(settings) {
    document.body.innerHTML = `<div id="VectFox_settings">${corePageMarkup({
        languageModes: [{ value: 'intl', label: 'Default' }],
        retrievalTimeout: { minMs: 5000, maxMs: 120000, defaultMs: 30000 },
    })}${agentModePageMarkup()}${chunkBasePageMarkup()}${storyArcPageMarkup()}</div>`;
    host.extensionSettings.vectfox = settings;
    wireConnectionRows(settings, { onEmbeddingProviderChange: host.onEmbeddingProviderChange });
    return settings;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    host.listeners = {};
    host.resolvedEmbedding = null;
    host.backend = null;
    for (const name of Object.keys(host.tests)) host.tests[name] = vi.fn(async () => ({ content: 'OK', cutReason: null }));
    host.context = {
        extensionSettings: { disabledExtensions: [], connectionManager: { profiles: profileFixtures() } },
        CONNECT_API_MAP,
        ConnectionManagerRequestService: {
            isProfileSupported: profile => ['openai', 'textgenerationwebui'].includes(CONNECT_API_MAP[profile.api]?.selected),
        },
        eventSource: { on: (type, listener) => { (host.listeners[type] ??= []).push(listener); } },
        eventTypes: EVENT_TYPES,
    };
    vi.stubGlobal('SillyTavern', { getContext: () => host.context });
});

describe('a chat consumer\'s Provider dropdown', () => {
    it('lists SillyTavern profile first on all five dropdowns, after Same as EventBase model on the two that have it', () => {
        mount(baseSettings());
        const valuesOf = id => optionsOf(id).map(option => option.value);
        expect(valuesOf('VectFox_summarize_provider')).toEqual(['connection_profile', 'openrouter', 'vllm']);
        expect(valuesOf('VectFox_story_arc_link_provider')).toEqual(['connection_profile', 'openrouter', 'vllm']);
        expect(valuesOf('VectFox_source')).toEqual(['connection_profile', 'transformers', 'ollama', 'openrouter', 'vllm']);
        for (const id of ['VectFox_agentic_provider', 'VectFox_reformat_provider']) {
            expect(valuesOf(id), id).toEqual(['', 'connection_profile', 'openrouter', 'vllm']);
        }
        expect(PROVIDER_SELECTS.map(id => optionsOf(id).find(option => option.value === 'connection_profile').text)).toEqual(Array(5).fill('SillyTavern profile'));
    });

    it('shows the Profile rows on the EventBase model in place of its model, key and URL', () => {
        const settings = mount(baseSettings());
        expect(isShown(element('VectFox_summarize_settings'))).toBe(true);
        expect(isShown(element('VectFox_summarize_connection_profile_rows'))).toBe(false);

        choose('VectFox_summarize_provider', 'connection_profile');

        expect(settings.chat_provider).toBe('connection_profile');
        expect(host.saveSettingsDebounced).toHaveBeenCalled();
        expect(isShown(element('VectFox_summarize_settings'))).toBe(false);
        expect(isShown(element('VectFox_summarize_connection_profile_rows'))).toBe(true);
    });

    it('lists the profiles SillyTavern can send on, in its order, under a Choose a profile that cannot be picked; a choice is saved and read out', () => {
        const settings = mount({ ...baseSettings(), chat_provider: 'connection_profile' });
        expect(optionsOf('VectFox_summarize_connection_profile')).toEqual([
            { value: '', text: 'Choose a profile', isDisabled: true, isSelected: true },
            { value: 'p-harbor', text: 'Harbor', isDisabled: false, isSelected: false },
            { value: 'p-lantern', text: 'Lantern', isDisabled: false, isSelected: false },
            { value: 'p-meadow', text: 'Meadow', isDisabled: false, isSelected: false },
            { value: 'p-kiln', text: 'Kiln', isDisabled: false, isSelected: false },
        ]);
        expect(linesOf('VectFox_summarize_connection_profile_readout')).toEqual(['EventBase: no connection profile is chosen. Choose one on the Core page.']);

        choose('VectFox_summarize_connection_profile', 'p-lantern');
        expect(settings.chat_connection_profile_id).toBe('p-lantern');
        expect(linesOf('VectFox_summarize_connection_profile_readout')).toEqual(['API: custom', 'Model: lantern-embed', 'No key stored: none is sent']);

        choose('VectFox_summarize_connection_profile', 'p-harbor');
        expect(linesOf('VectFox_summarize_connection_profile_readout')).toEqual(['API: openrouter', 'Model: harbor/chat-model']);
    });

    it('shows a deleted profile as a selected "(deleted profile)" that cannot be picked, never a blank, and says why it cannot run', () => {
        mount({ ...baseSettings(), chat_provider: 'connection_profile', chat_connection_profile_id: 'p-gone' });
        expect(optionsOf('VectFox_summarize_connection_profile').slice(0, 2)).toEqual([
            { value: '', text: 'Choose a profile', isDisabled: true, isSelected: false },
            { value: 'p-gone', text: '(deleted profile)', isDisabled: true, isSelected: true },
        ]);
        expect(linesOf('VectFox_summarize_connection_profile_readout')).toEqual(['EventBase: its connection profile was deleted in SillyTavern. Choose another on the Core page.']);
    });

    it('keeps a chosen profile SillyTavern can no longer send on, under its name and not pickable again', () => {
        mount({ ...baseSettings(), chat_provider: 'connection_profile', chat_connection_profile_id: 'p-quill' });
        expect(optionsOf('VectFox_summarize_connection_profile')).toContainEqual({ value: 'p-quill', text: 'Quill', isDisabled: true, isSelected: true });
        expect(linesOf('VectFox_summarize_connection_profile_readout')[0]).toMatch(/^EventBase: SillyTavern can't send requests on profile "Quill"/);
    });

    it('says in the dropdown that the Connection Manager is off, and why the profile cannot run', () => {
        host.context.extensionSettings.disabledExtensions = ['connection-manager'];
        mount({ ...baseSettings(), chat_provider: 'connection_profile', chat_connection_profile_id: 'p-harbor' });
        expect(optionsOf('VectFox_summarize_connection_profile')).toEqual([
            { value: 'p-harbor', text: 'Turn on Connection Manager in SillyTavern\'s extensions to choose a profile', isDisabled: true, isSelected: true },
        ]);
        expect(linesOf('VectFox_summarize_connection_profile_readout')[0]).toMatch(/^EventBase: SillyTavern's Connection Manager extension is off/);
    });

    it('repaints when SillyTavern makes, saves or deletes a profile', () => {
        mount({ ...baseSettings(), chat_provider: 'connection_profile', chat_connection_profile_id: 'p-harbor' });
        const profiles = host.context.extensionSettings.connectionManager.profiles;

        profiles[0].name = 'Harbor North';
        emit(EVENT_TYPES.CONNECTION_PROFILE_UPDATED);
        expect(optionsOf('VectFox_summarize_connection_profile')).toContainEqual({ value: 'p-harbor', text: 'Harbor North', isDisabled: false, isSelected: true });

        profiles.push({ id: 'p-garden', name: 'Garden', api: 'custom', model: 'garden-chat' });
        emit(EVENT_TYPES.CONNECTION_PROFILE_CREATED);
        expect(optionsOf('VectFox_summarize_connection_profile').map(option => option.text)).toContain('Garden');

        profiles.splice(0, 1);
        emit(EVENT_TYPES.CONNECTION_PROFILE_DELETED);
        expect(optionsOf('VectFox_summarize_connection_profile')).toContainEqual({ value: 'p-harbor', text: '(deleted profile)', isDisabled: true, isSelected: true });
    });

    it('names the EventBase model\'s profile on Agent Mode and Auto-Reformat on Same as EventBase model, hiding their Model rows, until the EventBase model goes manual', () => {
        mount({ ...baseSettings(), chat_provider: 'connection_profile', chat_connection_profile_id: 'p-harbor' });
        for (const prefix of ['VectFox_agentic', 'VectFox_reformat']) {
            expect(isShown(element(`${prefix}_inherited_profile_readout`)), prefix).toBe(true);
            expect(linesOf(`${prefix}_inherited_profile_readout`), prefix).toEqual(['EventBase model\'s profile: Harbor', 'API: openrouter', 'Model: harbor/chat-model']);
            expect(isShown(element(`${prefix}_connection_profile_rows`)), prefix).toBe(false);
            expect(isFieldShown(`${prefix}_model`), prefix).toBe(false);
            expect(isShown(element(`${prefix}_provider_hint`)), prefix).toBe(false);
        }

        choose('VectFox_summarize_provider', 'openrouter');

        for (const prefix of ['VectFox_agentic', 'VectFox_reformat']) {
            expect(isShown(element(`${prefix}_inherited_profile_readout`)), prefix).toBe(false);
            expect(isFieldShown(`${prefix}_model`), prefix).toBe(true);
            expect(isShown(element(`${prefix}_provider_hint`)), prefix).toBe(true);
        }
    });

    it('runs Agent Mode on a profile of its own in place of its rows, and keeps that profile stored when it moves to a manual provider', () => {
        const settings = mount(baseSettings());
        choose('VectFox_agentic_provider', 'connection_profile');
        expect(isShown(element('VectFox_agentic_connection_profile_rows'))).toBe(true);
        expect(isFieldShown('VectFox_agentic_model')).toBe(false);
        expect(isShown(element('VectFox_agentic_openrouter_row'))).toBe(false);

        choose('VectFox_agentic_connection_profile', 'p-meadow');
        expect(settings.agent_connection_profile_id).toBe('p-meadow');
        expect(linesOf('VectFox_agentic_connection_profile_readout')).toEqual(['API: ollama', 'Model: meadow-embed', 'No key stored: none is sent']);

        choose('VectFox_agentic_provider', 'vllm');
        expect(settings).toMatchObject({ agent_provider: 'vllm', agent_connection_profile_id: 'p-meadow' });
        expect(isShown(element('VectFox_agentic_connection_profile_rows'))).toBe(false);
        expect(isShown(element('VectFox_agentic_vllm_row'))).toBe(true);
        expect(isFieldShown('VectFox_agentic_model')).toBe(true);
    });

    it('hides StoryArc\'s Link model while it runs on a profile, which names its own model', () => {
        const settings = mount(baseSettings());
        expect(isFieldShown('VectFox_story_arc_link_model')).toBe(true);
        choose('VectFox_story_arc_link_provider', 'connection_profile');
        choose('VectFox_story_arc_link_connection_profile', 'p-harbor');
        expect(settings).toMatchObject({ story_arc_link_provider: 'connection_profile', story_arc_link_connection_profile_id: 'p-harbor' });
        expect(isFieldShown('VectFox_story_arc_link_model')).toBe(false);
        expect(linesOf('VectFox_story_arc_link_connection_profile_readout')).toEqual(['API: openrouter', 'Model: harbor/chat-model']);
    });
});

describe('embedding\'s Provider dropdown', () => {
    it('stores nothing for the SillyTavern profile option itself, and lists only Ollama, llama.cpp, KoboldCPP and Custom profiles', () => {
        const settings = mount(baseSettings());
        choose('VectFox_source', 'connection_profile');
        expect(settings).toMatchObject({ embedding_provider: 'transformers', embedding_connection_profile_id: '' });
        expect(host.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(host.onEmbeddingProviderChange).not.toHaveBeenCalled();
        expect(isShown(element('VectFox_embedding_connection_profile_rows'))).toBe(true);
        for (const group of document.querySelectorAll('#VectFox_provider_settings > [data-provider]')) expect(isShown(group), group.dataset.provider).toBe(false);
        expect(optionsOf('VectFox_embedding_connection_profile').map(option => option.text)).toEqual(['Choose a profile', 'Lantern', 'Meadow', 'Kiln']);
    });

    it('stores a chosen profile\'s ID and its type, reads it out, and keeps Keep model in memory on an Ollama profile', () => {
        const settings = mount(baseSettings());
        choose('VectFox_source', 'connection_profile');
        host.resolvedEmbedding = { profileName: 'Kiln', url: 'http://kiln.local:5001', model: '', storesKey: true, problem: '' };
        choose('VectFox_embedding_connection_profile', 'p-kiln');
        expect(settings).toMatchObject({ embedding_provider: 'koboldcpp', embedding_connection_profile_id: 'p-kiln' });
        expect(host.onEmbeddingProviderChange).toHaveBeenCalledTimes(1);
        expect(linesOf('VectFox_embedding_connection_profile_readout')).toEqual([
            'URL: http://kiln.local:5001',
            'Model: none named, the server embeds with its own',
            'The server needs: KoboldCPP 1.87 or later, with an embedding model loaded.',
        ]);

        host.resolvedEmbedding = { profileName: 'Lantern', url: 'http://lantern.local/v1', model: 'lantern-embed', storesKey: false, problem: '' };
        choose('VectFox_embedding_connection_profile', 'p-lantern');
        expect(linesOf('VectFox_embedding_connection_profile_readout')).toEqual([
            'URL: http://lantern.local/v1', 'Model: lantern-embed', 'The server needs: An OpenAI-style /embeddings route: the profile\'s URL if it ends in /embeddings, else under it.', 'No key stored: none is sent',
        ]);

        host.resolvedEmbedding = { profileName: 'Meadow', url: 'http://meadow.local:11434', model: 'meadow-embed', storesKey: false, problem: '' };
        choose('VectFox_embedding_connection_profile', 'p-meadow');
        expect(settings.embedding_provider).toBe('ollama');
        expect(isShown(document.querySelector('#VectFox_provider_settings > [data-provider="ollama"]'))).toBe(true);
        expect(isShown(element('VectFox_ollama_manual_rows'))).toBe(false);
        expect(isShown(element('VectFox_ollama_keep').closest('.vfx-switch-row'))).toBe(true);
    });

    it('clears the stored profile when another provider is chosen, and shows that provider\'s rows', () => {
        const settings = mount({ ...baseSettings(), embedding_provider: 'custom', embedding_connection_profile_id: 'p-lantern' });
        choose('VectFox_source', 'openrouter');
        expect(settings).toMatchObject({ embedding_provider: 'openrouter', embedding_connection_profile_id: '' });
        expect(host.onEmbeddingProviderChange).toHaveBeenCalledTimes(1);
        expect(isShown(element('VectFox_embedding_connection_profile_rows'))).toBe(false);
        expect(isShown(document.querySelector('#VectFox_provider_settings > [data-provider="openrouter"]'))).toBe(true);
    });

    it('opens on the SillyTavern profile option while a profile is stored, and on manual Ollama while none is', () => {
        mount({ ...baseSettings(), embedding_provider: 'ollama', embedding_connection_profile_id: 'p-meadow' });
        expect(element('VectFox_source').value).toBe('connection_profile');
        expect(element('VectFox_embedding_connection_profile').value).toBe('p-meadow');

        mount({ ...baseSettings(), embedding_provider: 'ollama', embedding_connection_profile_id: '' });
        expect(element('VectFox_source').value).toBe('ollama');
        expect(isShown(element('VectFox_ollama_manual_rows'))).toBe(true);
    });

    it('opens a new install\'s Custom type with no profile on the SillyTavern profile option, none chosen, and says what to do', () => {
        host.context.extensionSettings.connectionManager.profiles = profileFixtures().slice(0, 1);
        host.resolvedEmbedding = { profileName: '', url: '', model: '', storesKey: false, problem: 'Embedding: no connection profile is chosen. Choose one on the Core page.' };
        mount({ ...baseSettings(), embedding_provider: 'custom', embedding_connection_profile_id: '' });
        expect(element('VectFox_source').value).toBe('connection_profile');
        expect(isShown(element('VectFox_embedding_connection_profile_rows'))).toBe(true);
        expect(optionsOf('VectFox_embedding_connection_profile')).toEqual([{ value: '', text: 'Choose a profile', isDisabled: true, isSelected: true }]);
        expect(linesOf('VectFox_embedding_connection_profile_readout')).toEqual([
            'Embedding: no connection profile is chosen. Choose one on the Core page.',
            'SillyTavern has no Ollama, llama.cpp, KoboldCPP or Custom profile yet. Make one under Connection Profiles in SillyTavern.',
        ]);
    });

    it('says how to make a profile when SillyTavern has none it can embed on', () => {
        host.context.extensionSettings.connectionManager.profiles = profileFixtures().slice(0, 1);
        mount(baseSettings());
        choose('VectFox_source', 'connection_profile');
        expect(linesOf('VectFox_embedding_connection_profile_readout'))
            .toEqual(['SillyTavern has no Ollama, llama.cpp, KoboldCPP or Custom profile yet. Make one under Connection Profiles in SillyTavern.']);
    });
});

describe('Test connection', () => {
    it('runs each chat consumer\'s own test on the panel\'s settings, and shows the reply or the reason it failed', async () => {
        const settings = mount(baseSettings());
        host.tests.agent = vi.fn(async () => { throw new Error('Agent Mode is on, but it has no model.'); });
        host.tests.reformat = vi.fn(async () => ({ content: 'OK', cutReason: 'length' }));

        for (const prefix of ['VectFox_summarize', 'VectFox_agentic', 'VectFox_reformat', 'VectFox_story_arc_link']) {
            element(`${prefix}_test_connection`).click();
        }
        await settle();

        for (const test of Object.values(host.tests)) expect(test).toHaveBeenCalledWith(settings);
        expect(toastr.success).toHaveBeenCalledWith('OK', 'EventBase: the connection works', expect.any(Object));
        expect(toastr.success).toHaveBeenCalledWith('OK', 'StoryArc: the connection works', expect.any(Object));
        expect(toastr.success).toHaveBeenCalledWith('OK (cut short by the provider: length)', 'Auto-Reformat: the connection works', expect.any(Object));
        expect(toastr.error).toHaveBeenCalledWith('Agent Mode is on, but it has no model.', 'Agent Mode: the connection test failed', expect.any(Object));
        expect(element('VectFox_agentic_test_connection').disabled).toBe(false);
    });

    it('embeds a fixed line on the active backend for embedding, and says when no plugin can embed it', async () => {
        const settings = mount(baseSettings());
        host.backend = { embedQuery: vi.fn(async () => new Array(1024).fill(0.1)) };
        element('VectFox_embedding_test_connection').click();
        await settle();
        expect(host.backend.embedQuery).toHaveBeenCalledWith('This is a connection test from VectFox.', settings);
        expect(toastr.success).toHaveBeenCalledWith('1024 dimensions', 'Embedding: the connection works', expect.any(Object));

        for (const answer of [null, []]) {
            toastr.error.mockClear();
            host.backend = { embedQuery: vi.fn(async () => answer) };
            element('VectFox_embedding_test_connection').click();
            await settle();
            expect(toastr.error, JSON.stringify(answer)).toHaveBeenCalledWith(expect.stringMatching(/Similharity/), 'Embedding: the connection test failed', expect.any(Object));
        }
    });
});
