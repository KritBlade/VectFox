/**
 * EventBase extraction, Auto-Reformat and the pre-run check on a SillyTavern connection profile (connection plan §1, §4,
 * §6): each sends its call on the profile it resolves, from the page that chooses it; the check that gates a Vectorize
 * Content run checks the profile instead of a model; and a provider VectFox does not know stops the run, where it once
 * ran on OpenRouter unasked. Only the network call is replaced: the profile resolution and its check are the real ones,
 * on a stubbed SillyTavern.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanText: (text) => text }));
vi.mock('../src/features/eventbase/eventbase-message-hash.js', () => ({ hashSourceMessage: (message) => message.mes.length }));

const calls = vi.hoisted(() => ({ post: null }));
vi.mock('../src/features/llm-provider/llm-provider-call.js', async () => ({
    ...(await vi.importActual('../src/features/llm-provider/llm-provider-call.js')),
    postChatCompletion: (...args) => calls.post(...args),
}));

const { LlmCallError, validateLLMConfig } = await import('../src/features/llm-provider/index.js');
const { extractEvents } = await import('../src/features/eventbase/eventbase-extractor.js');
const { reformatDocument } = await import('../src/features/chunkbase/reformat-extractor.js');

const PROFILE = { id: 'profile-harbor', name: 'Harbor', api: 'custom', model: 'harbor-model', 'secret-id': 'secret-1' };

beforeEach(() => {
    calls.post = vi.fn(async () => ({ content: '[]', finishReason: 'stop' }));
    vi.stubGlobal('SillyTavern', {
        getContext: () => ({
            extensionSettings: { disabledExtensions: [], connectionManager: { profiles: [PROFILE] } },
            CONNECT_API_MAP: { custom: { selected: 'openai', source: 'custom' } },
            ConnectionManagerRequestService: { isProfileSupported: () => true },
        }),
    });
});

const onProfile = { chat_provider: 'connection_profile', chat_connection_profile_id: 'profile-harbor' };
const WINDOW = { messages: [{ name: 'User', mes: 'hello' }, { name: 'Bot', mes: 'hi there' }], windowStart: 4, windowEnd: 5, windowIndex: 2 };

describe('EventBase extraction on a profile', () => {
    it('sends each window on the profile chosen on the Core page', async () => {
        await extractEvents({ ...WINDOW, settings: { ...onProfile, chat_model: '' } });
        expect(calls.post.mock.calls[0][0]).toMatchObject({
            provider: 'connection_profile', connectionProfileId: 'profile-harbor', connectionProfilePage: 'Core', contextLabel: 'EventBase',
        });
    });

    it('stops the run on a provider VectFox does not know, and calls nothing', async () => {
        await expect(extractEvents({ ...WINDOW, settings: { chat_provider: 'claude', chat_model: 'm' } }))
            .rejects.toMatchObject({ code: 'invalid_model_config', message: expect.stringContaining('provider "claude" is not one VectFox knows') });
        expect(calls.post).not.toHaveBeenCalled();
    });
});

describe('Auto-Reformat on a profile', () => {
    const text = '# Harbor\nThe harbor master keeps the ledger.';
    const reformat = settings => reformatDocument({ text, contentType: 'document', settings });

    it('runs Same as EventBase model on the EventBase model\'s profile, chosen on the Core page', async () => {
        calls.post.mockRejectedValue(new LlmCallError('stop here', { kind: 'model_config' }));
        await expect(reformat({ ...onProfile, reformat_provider: '' })).rejects.toMatchObject({ code: 'invalid_model_config' });
        expect(calls.post.mock.calls[0][0]).toMatchObject({ provider: 'connection_profile', connectionProfileId: 'profile-harbor', connectionProfilePage: 'Core', contextLabel: 'Auto-Reformat' });
    });

    it('runs on its own profile, chosen on the ChunkBase page', async () => {
        calls.post.mockRejectedValue(new LlmCallError('stop here', { kind: 'model_config' }));
        await expect(reformat({ chat_provider: 'openrouter', reformat_provider: 'connection_profile', reformat_connection_profile_id: 'profile-own' }))
            .rejects.toMatchObject({ code: 'invalid_model_config' });
        expect(calls.post.mock.calls[0][0]).toMatchObject({ connectionProfileId: 'profile-own', connectionProfilePage: 'ChunkBase' });
    });

    it('stops on a provider VectFox does not know, and calls nothing', async () => {
        await expect(reformat({ reformat_provider: 'claude' })).rejects.toMatchObject({ code: 'invalid_model_config' });
        expect(calls.post).not.toHaveBeenCalled();
    });
});

describe('the check before a Vectorize Content run', () => {
    it('checks the profile, ahead of a model a profile does not need', () => {
        expect(validateLLMConfig({ ...onProfile, chat_model: '' })).toEqual({ ok: true });
    });

    it('names what is wrong with the profile and where to fix it', () => {
        expect(validateLLMConfig({ ...onProfile, chat_connection_profile_id: '' }))
            .toEqual({ ok: false, reason: 'EventBase: no connection profile is chosen. Choose one on the Core page.' });
        expect(validateLLMConfig({ ...onProfile, chat_connection_profile_id: 'profile-gone' }).reason).toContain('was deleted in SillyTavern');
    });
});
