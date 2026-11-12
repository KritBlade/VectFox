/**
 * The notice that manual OpenRouter and vLLM retire (src/features/settings-panel/manual-connection-notice.js and
 * manual-connection-notice-core.js, connection plan row N1): it names each Provider dropdown on one of them, with
 * Same as EventBase model left to the EventBase model; it says how to move, and for embedding what it needs and what
 * happens to stored vectors on each backend; it shows once per install, only while VectFox is on and a dropdown holds
 * one, after SillyTavern has loaded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ appReadyListeners: [] }));

vi.mock('../src/sillytavern/events.js', () => ({
    event_types: { APP_READY: 'app_ready' },
    eventSource: { once: vi.fn((type, listener) => { if (type === 'app_ready') host.appReadyListeners.push(listener); }) },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ noticePopup: vi.fn(async () => {}) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));

const { manualConnectionNoticeLines, manualConnections } = await import('../src/features/settings-panel/manual-connection-notice-core.js');
const { scheduleManualConnectionNotice, showManualConnectionNotice } = await import('../src/features/settings-panel/manual-connection-notice.js');
const { noticePopup } = await import('../src/sillytavern/popup.js');
const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');

/** An install from before profiles: what it saved for each Provider dropdown. */
const installBeforeProfiles = () => ({
    enabled: true, vector_backend: 'qdrant',
    chat_provider: 'openrouter', agent_provider: '', reformat_provider: '', story_arc_link_provider: 'openrouter',
    embedding_provider: 'transformers', has_shown_manual_connection_retirement_notice: false,
});

/** A line's text as the dialog shows it. */
const shown = line => (line.parts ? line.parts.map(part => part.text ?? part.name).join('') : [line.text, line.name].filter(Boolean).join(' '));

beforeEach(() => {
    vi.clearAllMocks();
    host.appReadyListeners = [];
});

describe('the dropdowns the notice names', () => {
    it('names each consumer on manual OpenRouter or vLLM, and leaves Same as EventBase model to the EventBase model', () => {
        expect(manualConnections(installBeforeProfiles())).toEqual([
            { feature: 'EventBase', page: 'Core', provider: 'OpenRouter' },
            { feature: 'StoryArc', page: 'StoryArc', provider: 'OpenRouter' },
        ]);
    });

    it('reads an unset EventBase model as OpenRouter, names vLLM and embedding, and skips profiles and other providers', () => {
        expect(manualConnections({
            chat_provider: '', agent_provider: 'vllm', reformat_provider: 'connection_profile', story_arc_link_provider: 'connection_profile',
            embedding_provider: 'vllm',
        })).toEqual([
            { feature: 'EventBase', page: 'Core', provider: 'OpenRouter' },
            { feature: 'Agent Mode', page: 'AgentMode', provider: 'vLLM' },
            { feature: 'Embedding', page: 'Core', provider: 'vLLM' },
        ]);
        for (const embeddingProvider of ['transformers', 'ollama', 'custom', 'llamacpp', 'koboldcpp', 'constructor']) {
            expect(manualConnections({ chat_provider: 'connection_profile', story_arc_link_provider: 'connection_profile', embedding_provider: embeddingProvider }), embeddingProvider).toEqual([]);
        }
    });
});

describe('what the notice says', () => {
    it('lists each dropdown with its provider and page, and how to move it', () => {
        const lines = manualConnectionNoticeLines(manualConnections(installBeforeProfiles()), { vectorBackend: 'qdrant' }).map(shown);
        expect(lines).toContain('EventBase runs on OpenRouter, on the Core page.');
        expect(lines).toContain('StoryArc runs on OpenRouter, on the StoryArc page.');
        expect(lines.some(line => line.includes('choose SillyTavern profile in that Provider dropdown'))).toBe(true);
        expect(lines.some(line => line.includes('Embedding needs'))).toBe(false);
        expect(lines.at(-1)).toBe('Until then, nothing changes. I show this only once.');
    });

    it('tells embedding what it needs, the OpenRouter URL, and what happens to the vectors on each backend', () => {
        const embeddingOn = (provider, vectorBackend) => manualConnectionNoticeLines([{ feature: 'Embedding', page: 'Core', provider }], { vectorBackend }).map(shown);
        expect(embeddingOn('OpenRouter', 'qdrant')).toEqual(expect.arrayContaining([
            'Embedding needs an Ollama, llama.cpp, KoboldCPP or Custom profile.',
            'For OpenRouter, make a Custom profile with the URL https://openrouter.ai/api/v1/embeddings, so SillyTavern lists its embedding models.',
            'You are on Qdrant, so a profile with the same embedding model keeps your stored vectors.',
        ]));
        const onStandard = embeddingOn('vLLM', 'standard');
        expect(onStandard).toContain('You are on the Standard backend, so a profile starts an empty store. Vectorize your chats again after you move.');
        expect(onStandard.some(line => line.includes('openrouter.ai'))).toBe(false);
    });

    it('keeps its fixed words free of em dashes and semicolons, and never builds one from a value', () => {
        const lines = manualConnectionNoticeLines(manualConnections({ ...installBeforeProfiles(), agent_provider: 'vllm', embedding_provider: 'openrouter' }), { vectorBackend: 'standard' });
        const fixedWords = lines.flatMap(line => (line.parts ? line.parts.map(part => part.text).filter(Boolean) : [line.text]));
        for (const words of fixedWords) expect(words, words).not.toMatch(/[—;]/);
        expect(fixedWords.some(words => /OpenRouter runs|EventBase runs/.test(words))).toBe(false);
    });
});

describe('when the notice shows', () => {
    it('shows once, marked and saved before it opens', async () => {
        const settings = installBeforeProfiles();
        expect(await showManualConnectionNotice(settings)).toBe(true);
        expect(settings.has_shown_manual_connection_retirement_notice).toBe(true);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(noticePopup).toHaveBeenCalledWith(expect.any(Array), { isWide: true });

        expect(await showManualConnectionNotice(settings)).toBe(false);
        expect(noticePopup).toHaveBeenCalledTimes(1);
    });

    it('waits, unmarked, while no dropdown holds a manual option or VectFox is off', async () => {
        const onProfiles = { ...installBeforeProfiles(), chat_provider: 'connection_profile', story_arc_link_provider: 'connection_profile' };
        const switchedOff = { ...installBeforeProfiles(), enabled: false };
        for (const settings of [onProfiles, switchedOff]) {
            expect(await showManualConnectionNotice(settings)).toBe(false);
            expect(settings.has_shown_manual_connection_retirement_notice).toBe(false);
        }
        expect(noticePopup).not.toHaveBeenCalled();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('opens only once SillyTavern has loaded', async () => {
        const settings = installBeforeProfiles();
        scheduleManualConnectionNotice(settings);
        expect(noticePopup).not.toHaveBeenCalled();
        host.appReadyListeners.forEach(listener => listener());
        await vi.waitFor(() => expect(noticePopup).toHaveBeenCalledTimes(1));
    });
});
