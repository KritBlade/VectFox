/**
 * LoreBase's model connection (src/features/lorebase/lorebase-connection.js, plan §5.6 of InternalProject/Vectfox/
 * plans/executed/lorebook-semantic-overhaul-passage-index.md): its own row on the WorldInfo page runs on a SillyTavern profile,
 * OpenRouter or vLLM through the llm-provider feature's one connection check, never sends a temperature, says what is
 * wrong, where to fix it and what that costs as LoreBase stands (connectionConsequence, for Jev's sentences too), and
 * its Test connection sends the fixed test message on that connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkConnectionProfileMock = vi.fn();
const sendConnectionTestMock = vi.fn();
const postChatCompletionMock = vi.fn();
const keys = vi.hoisted(() => ({ openRouter: 'key', custom: 'key' }));

// The real connection check reads the profile and the saved keys through these mocks.
vi.mock('../src/features/llm-provider/llm-provider-call.js', () => ({ checkConnectionProfile: (...args) => checkConnectionProfileMock(...args) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => keys.openRouter, getCustomApiKey: () => keys.custom }));
vi.mock('../src/features/llm-provider/index.js', async () => {
    const connection = await import('../src/features/llm-provider/llm-connection.js');
    return {
        describeConnectionProblem: connection.describeConnectionProblem,
        LLM_CALL_FEATURES: (await vi.importActual('../src/features/llm-provider/llm-call-report.js')).LLM_CALL_FEATURES,
        resolveLlmConnection: connection.resolveLlmConnection,
        shownVllmUrl: connection.shownVllmUrl,
        resolveConnectionProfileId: (await import('../src/features/llm-provider/connection-profile-core.js')).resolveConnectionProfileId,
        resolveModelParameterStyle: () => ({ sendTemperature: true, reasoningEffort: 'none', tokenLimitParameter: 'max_completion_tokens' }),
        sendConnectionTest: (...args) => sendConnectionTestMock(...args),
        postChatCompletion: (...args) => postChatCompletionMock(...args),
        parseJsonArrayFromLlm: text => JSON.parse(text),
    };
});
// LoreBase's calls, which this file does not send, read their answers through these.
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/features/text-cleaning/index.js', () => ({ stripReasoningBlocks: text => text }));
// LoreBase's switch reads the settings it is handed; these are the live ones it would read without them.
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));

const {
    askOnLoreBase, connectionConsequence, describeLoreBaseConnectionProblem, resolveLoreBaseLlmConfig, testLoreBaseConnection,
} = await import('../src/features/lorebase/lorebase-connection.js');

const CONSEQUENCE = 'Until then the entries selected for LoreBase stay out of replies.';
const NO_KEYS = 'Until then no keys are written for the entries selected for LoreBase.';
// LoreBase running, VectFox and LoreBase on, on Qdrant, on each Accuracy choice.
const RUNNING_HIGH = { enabled: true, lorebase_enabled: true, vector_backend: 'qdrant', lorebase_accuracy: 'high' };
const RUNNING_FAST = { ...RUNNING_HIGH, lorebase_accuracy: 'fast' };

beforeEach(() => {
    checkConnectionProfileMock.mockReset();
    sendConnectionTestMock.mockReset();
    postChatCompletionMock.mockReset();
    keys.openRouter = 'key';
    keys.custom = 'key';
});

describe("LoreBase's connection", () => {
    it('runs on the profile chosen on the WorldInfo page, checked for LoreBase, and never sends a temperature', () => {
        checkConnectionProfileMock.mockReturnValue({ ok: true, profile: { model: 'profile-model' } });
        const connection = resolveLoreBaseLlmConfig({ lorebase_provider: 'connection_profile', lorebase_connection_profile_id: 'p-harbor', lorebase_model: 'unused' });
        expect(checkConnectionProfileMock).toHaveBeenCalledWith('p-harbor', { feature: 'LoreBase', page: 'WorldInfo' });
        expect(connection).toEqual({
            ok: true, provider: 'connection_profile', model: 'profile-model', connectionProfileId: 'p-harbor', connectionProfilePage: 'WorldInfo',
            parameterStyle: { sendTemperature: false, reasoningEffort: null, tokenLimitParameter: 'max_completion_tokens' },
        });
    });

    it('runs on OpenRouter with its own model, and on vLLM with the URL the AgentMode or Core page shows', () => {
        expect(resolveLoreBaseLlmConfig({ lorebase_provider: 'openrouter', lorebase_model: 'openai/gpt-6-luna' })).toMatchObject({ ok: true, provider: 'openrouter', model: 'openai/gpt-6-luna' });
        const onVllm = { lorebase_provider: 'vllm', lorebase_model: 'served-model', chat_provider: 'vllm', chat_vllm_url: 'http://harbor.test/v1', agent_provider: 'openrouter', agent_vllm_url: 'http://hidden.test/v1' };
        expect(resolveLoreBaseLlmConfig(onVllm)).toMatchObject({ ok: true, provider: 'vllm', model: 'served-model', vllmUrl: 'http://harbor.test/v1' });
    });

    it("says what is wrong, where to fix it, and, while it picks each reply's entries, that the selected entries stay out until then", () => {
        expect(resolveLoreBaseLlmConfig({ lorebase_provider: 'openrouter', lorebase_model: ' ' })).toEqual({ ok: false, reason: 'missing_model' });
        expect(describeLoreBaseConnectionProblem('missing_model', undefined, RUNNING_HIGH)).toBe(
            `LoreBase is on, but it has no model. Set Model under LoreBase model on the WorldInfo page. ${CONSEQUENCE}`);

        keys.openRouter = '';
        const noKey = resolveLoreBaseLlmConfig({ lorebase_provider: 'openrouter', lorebase_model: 'openai/gpt-6-luna' });
        expect(describeLoreBaseConnectionProblem(noKey.reason, undefined, RUNNING_HIGH)).toBe(
            `LoreBase is on, but it runs on OpenRouter and no OpenRouter key is saved. Enter the key on the AgentMode or Core page. ${CONSEQUENCE}`);

        checkConnectionProfileMock.mockReturnValue({ ok: false, reason: 'LoreBase: its connection profile was deleted in SillyTavern. Choose another on the WorldInfo page.' });
        const deleted = resolveLoreBaseLlmConfig({ lorebase_provider: 'connection_profile', lorebase_connection_profile_id: 'p-gone' });
        expect(describeLoreBaseConnectionProblem(deleted.reason, deleted.problem, RUNNING_HIGH)).toBe(
            `LoreBase: its connection profile was deleted in SillyTavern. Choose another on the WorldInfo page. ${CONSEQUENCE}`);
    });

    it('says no keys are written on Fast and Cheap [Jev], where Jev picks, and while LoreBase is off says neither that it is on nor that entries stay out', () => {
        expect(describeLoreBaseConnectionProblem('missing_model', undefined, RUNNING_FAST)).toBe(
            `LoreBase is on, but it has no model. Set Model under LoreBase model on the WorldInfo page. ${NO_KEYS}`);
        const off = { ...RUNNING_HIGH, lorebase_enabled: false };
        expect(describeLoreBaseConnectionProblem('missing_model', undefined, off)).toBe(
            `LoreBase: it has no model. Set Model under LoreBase model on the WorldInfo page. ${NO_KEYS}`);
        const profileProblem = 'LoreBase: no connection profile is chosen. Choose one on the WorldInfo page.';
        expect(describeLoreBaseConnectionProblem('connection_profile', profileProblem, off)).toBe(`${profileProblem} ${NO_KEYS}`);
    });

    it("sends Test connection's fixed message on LoreBase's connection, or says why it cannot run", async () => {
        sendConnectionTestMock.mockResolvedValue({ content: 'OK', cutReason: null });
        const settings = { lorebase_provider: 'openrouter', lorebase_model: 'openai/gpt-6-luna' };
        await expect(testLoreBaseConnection(settings)).resolves.toEqual({ content: 'OK', cutReason: null });
        const connection = resolveLoreBaseLlmConfig(settings);
        expect(sendConnectionTestMock).toHaveBeenCalledWith(connection, { contextLabel: 'LoreBase', feature: 'lorebase', parameterStyle: connection.parameterStyle });

        sendConnectionTestMock.mockClear();
        await expect(testLoreBaseConnection({ ...RUNNING_HIGH, lorebase_provider: 'vllm', lorebase_model: 'served-model' }))
            .rejects.toThrow(`LoreBase is on, but it runs on vLLM with no URL. Set Base URL on the AgentMode page, or under EventBase model on the Core page. ${CONSEQUENCE}`);
        expect(sendConnectionTestMock).not.toHaveBeenCalled();
    });
});

describe('what a LoreBase model that cannot run costs', () => {
    const jev = { isJev: true };
    const loreBaseModel = { isJev: false };

    it('keeps the selected entries out of replies while LoreBase runs, for the model that picks them on the choice', () => {
        expect(connectionConsequence(RUNNING_HIGH, loreBaseModel)).toBe(CONSEQUENCE);
        expect(connectionConsequence(RUNNING_FAST, jev)).toBe(CONSEQUENCE);
        expect(connectionConsequence({ ...RUNNING_HIGH, lorebase_accuracy: 'default' }, loreBaseModel)).toBe(CONSEQUENCE);
    });

    it("writes no keys for LoreBase's own model otherwise, and costs nothing for Jev otherwise", () => {
        expect(connectionConsequence(RUNNING_FAST, loreBaseModel)).toBe(NO_KEYS);
        expect(connectionConsequence(RUNNING_HIGH, jev)).toBe('');
    });

    it('keeps nothing out of replies while LoreBase does not run: its switch off, VectFox off, or off Qdrant', () => {
        for (const notRunning of [
            { ...RUNNING_FAST, lorebase_enabled: false },
            { ...RUNNING_FAST, enabled: false },
            { ...RUNNING_FAST, vector_backend: 'vectra' },
        ]) {
            expect(connectionConsequence(notRunning, jev)).toBe('');
            expect(connectionConsequence({ ...notRunning, lorebase_accuracy: 'high' }, loreBaseModel)).toBe(NO_KEYS);
        }
    });
});

describe("a call on LoreBase's connection", () => {
    it("reads its answer's entries, and hands the caller the call's token counts once it answers, as the tester reads the pick's", async () => {
        postChatCompletionMock.mockResolvedValue({ content: '[{"number": 3}]', cutReason: null, usage: { prompt_tokens: 15070, cached_tokens: 10141 } });
        const ask = askOnLoreBase({ provider: 'openrouter', model: 'openai/gpt-6-luna', parameterStyle: {} });
        const onUsage = vi.fn();
        await expect(ask([{ role: 'user', content: 'pick' }], { maxTokens: 10, reasoningEffort: 'low', identKeys: ['number'], onUsage })).resolves.toEqual([{ number: 3 }]);
        expect(onUsage).toHaveBeenCalledWith({ prompt_tokens: 15070, cached_tokens: 10141 });
        await expect(ask([{ role: 'user', content: 'keys' }], { maxTokens: 10, reasoningEffort: 'low', identKeys: ['keys'] })).resolves.toEqual([{ number: 3 }]);
        expect(postChatCompletionMock.mock.calls[0][0]).toMatchObject({ model: 'openai/gpt-6-luna', provider: 'openrouter', maxTokens: 10, reasoningEffort: 'low' });
    });
});
