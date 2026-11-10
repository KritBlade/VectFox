/**
 * SillyTavern's connection profiles, as src/sillytavern/connection-profiles.js reads and uses them (connection plan §2,
 * §6): the Connection Manager switched off is reported, a profile with an API SillyTavern does not know answers
 * "not supported" instead of throwing, a request sends no preset and keeps the raw reply, a profile with no stored key
 * sends the ID that matches no key, so SillyTavern sends none rather than its active key, and the reply is read the way
 * SillyTavern reads the profile's API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const host = vi.hoisted(() => ({ context: null }));

const {
    CONNECTION_PROFILE_API,
    connectionProfileApi,
    connectionProfileReplyText,
    connectionProfileStoresKey,
    findConnectionProfile,
    isConnectionManagerAvailable,
    isConnectionProfileSupported,
    sendConnectionProfileRequest,
} = await import('../src/sillytavern/connection-profiles.js');

const CONNECT_API_MAP = {
    openai: { selected: 'openai', source: 'openai' },
    custom: { selected: 'openai', source: 'custom' },
    ollama: { selected: 'textgenerationwebui', type: 'ollama' },
    kobold: { selected: 'kobold' },
};
const CHAT_PROFILE = { id: 'profile-chat', name: 'Harbor chat', api: 'custom', model: 'harbor-model', 'secret-id': 'secret-7' };
const TEXT_PROFILE = { id: 'profile-text', name: 'Harbor text', api: 'ollama', model: 'harbor-text' };
const UNKNOWN_PROFILE = { id: 'profile-unknown', name: 'Old plugin', api: 'retired-api' };

beforeEach(() => {
    host.context = {
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: { profiles: [CHAT_PROFILE, TEXT_PROFILE, UNKNOWN_PROFILE] },
        },
        CONNECT_API_MAP,
        ConnectionManagerRequestService: {
            // SillyTavern 1.19.0's own check, which reads CONNECT_API_MAP[profile.api].selected unguarded.
            isProfileSupported: profile => ['openai', 'textgenerationwebui'].includes(CONNECT_API_MAP[profile.api].selected),
            sendRequest: vi.fn(async () => ({ choices: [{ message: { content: 'ok' } }] })),
        },
        extractMessageFromData: vi.fn((data, api) => `${api}:${JSON.stringify(data)}`),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => host.context });
});

describe('the Connection Manager and its profiles', () => {
    it('reports the Connection Manager off when SillyTavern disables it', () => {
        expect(isConnectionManagerAvailable()).toBe(true);
        host.context.extensionSettings.disabledExtensions = ['connection-manager'];
        expect(isConnectionManagerAvailable()).toBe(false);
    });

    it('finds a profile by its ID, and nothing for an ID no profile has', () => {
        expect(findConnectionProfile('profile-text')).toBe(TEXT_PROFILE);
        expect(findConnectionProfile('profile-gone')).toBeNull();
        expect(findConnectionProfile('')).toBeNull();
    });

    it('answers "not supported" for a profile with an API SillyTavern does not know, where SillyTavern\'s check throws', () => {
        expect(() => host.context.ConnectionManagerRequestService.isProfileSupported(UNKNOWN_PROFILE)).toThrow(TypeError);
        expect(isConnectionProfileSupported(UNKNOWN_PROFILE)).toBe(false);
        expect([CHAT_PROFILE, TEXT_PROFILE, UNKNOWN_PROFILE].filter(isConnectionProfileSupported)).toEqual([CHAT_PROFILE, TEXT_PROFILE]);
    });

    it('names the kind of request a profile sends', () => {
        expect(connectionProfileApi(CHAT_PROFILE)).toBe(CONNECTION_PROFILE_API.chat);
        expect(connectionProfileApi(TEXT_PROFILE)).toBe(CONNECTION_PROFILE_API.text);
        expect(connectionProfileApi({ api: 'kobold' })).toBeNull();
        expect(connectionProfileApi(UNKNOWN_PROFILE)).toBeNull();
    });
});

describe('a request on a profile', () => {
    it('sends the messages with no preset and keeps the raw reply, never applying the profile', async () => {
        const messages = [{ role: 'user', content: 'Read this window.' }];
        await sendConnectionProfileRequest(CHAT_PROFILE, messages, 900, { timeoutMs: 5000, overridePayload: { temperature: 0.2 } });
        const [profileId, sent, maxTokens, custom, overridePayload] = host.context.ConnectionManagerRequestService.sendRequest.mock.calls[0];
        expect([profileId, sent, maxTokens]).toEqual(['profile-chat', messages, 900]);
        expect(custom).toMatchObject({ stream: false, extractData: false, includePreset: false, includeInstruct: true });
        expect(custom.signal).toBeInstanceOf(AbortSignal);
        expect(overridePayload).toEqual({ temperature: 0.2 });
    });

    it('sends the ID that matches no key when the profile stores none, so SillyTavern sends no key at all', async () => {
        expect(connectionProfileStoresKey(CHAT_PROFILE)).toBe(true);
        expect(connectionProfileStoresKey(TEXT_PROFILE)).toBe(false);
        await sendConnectionProfileRequest(TEXT_PROFILE, [], 900, { timeoutMs: 5000, overridePayload: { temperature: 0.2 } });
        const overridePayload = host.context.ConnectionManagerRequestService.sendRequest.mock.calls[0][4];
        expect(Object.keys(overridePayload).sort()).toEqual(['secret_id', 'temperature']);
        expect(overridePayload.secret_id).toMatch(/\S/);
    });

    it('reads the reply the way SillyTavern reads the profile\'s API', () => {
        expect(connectionProfileReplyText(CHAT_PROFILE, { content: [] })).toBe('openai:{"content":[]}');
        expect(connectionProfileReplyText(TEXT_PROFILE, { response: 'x' })).toBe('textgenerationwebui:{"response":"x"}');
    });
});
