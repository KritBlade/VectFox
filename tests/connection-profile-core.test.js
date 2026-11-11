/**
 * The pure rules of a chat call on a SillyTavern connection profile (src/features/llm-provider/connection-profile-core.js,
 * connection plan §1, §2, §4): which profile each consumer runs on, Same as EventBase model included; the request's
 * closed override keys by API; what stops a call before it starts; and what each way SillyTavern's sendRequest fails
 * means, first match winning.
 */

import { describe, expect, it } from 'vitest';
import {
    CONNECTION_PROFILE_OVERRIDE_KEYS,
    classifyConnectionProfileFailure,
    connectionProfileProblem,
    connectionProfileRequestShape,
    resolveConnectionProfileId,
} from '../src/features/llm-provider/connection-profile-core.js';

const ON_PROFILE = 'connection_profile';

describe('the profile each chat consumer runs on', () => {
    const settings = {
        chat_provider: ON_PROFILE, chat_connection_profile_id: 'profile-eventbase',
        agent_provider: '', agent_connection_profile_id: 'profile-agent-hidden',
        reformat_provider: ON_PROFILE, reformat_connection_profile_id: 'profile-reformat',
        story_arc_link_provider: ON_PROFILE, story_arc_link_connection_profile_id: 'profile-storyarc',
    };

    it('reads each consumer\'s own profile while it is on one', () => {
        expect(resolveConnectionProfileId(settings, 'eventbase')).toBe('profile-eventbase');
        expect(resolveConnectionProfileId(settings, 'reformat')).toBe('profile-reformat');
        expect(resolveConnectionProfileId(settings, 'storyarc')).toBe('profile-storyarc');
    });

    it('runs Same as EventBase model on the EventBase model\'s profile, not the consumer\'s hidden one', () => {
        expect(resolveConnectionProfileId(settings, 'agent')).toBe('profile-eventbase');
        expect(resolveConnectionProfileId({ ...settings, reformat_provider: '' }, 'reformat')).toBe('profile-eventbase');
    });

    it('has no profile on a manual provider, the stored ID kept but unused', () => {
        const manual = { ...settings, chat_provider: 'vllm', agent_provider: 'openrouter', story_arc_link_provider: 'openrouter' };
        expect(['eventbase', 'agent', 'storyarc'].map(consumer => resolveConnectionProfileId(manual, consumer))).toEqual(['', '', '']);
        expect(resolveConnectionProfileId({ ...manual, reformat_provider: '' }, 'reformat')).toBe('');
    });

    it('refuses a consumer it does not know', () => {
        expect(() => resolveConnectionProfileId(settings, 'summarizer')).toThrow('Unknown chat consumer');
    });
});

describe('the request a profile call sends', () => {
    const switches = { maxTokens: 900, temperature: 0.2, sendTemperature: true, tokenLimitParameter: 'max_completion_tokens', reasoningEffort: 'none', responseFormat: { type: 'json_object' } };

    it('overrides on Chat Completion only temperature, max_completion_tokens, reasoning_effort and response_format', () => {
        expect(connectionProfileRequestShape({ api: 'chat', ...switches })).toEqual({
            maxTokens: undefined,
            overridePayload: { temperature: 0.2, max_completion_tokens: 900, reasoning_effort: 'none', response_format: { type: 'json_object' } },
        });
        expect(connectionProfileRequestShape({ api: 'chat', ...switches, sendTemperature: false, tokenLimitParameter: 'max_tokens', reasoningEffort: null, responseFormat: null }))
            .toEqual({ maxTokens: 900, overridePayload: {} });
    });

    it('overrides on Text Completion only temperature, whatever the switches', () => {
        expect(connectionProfileRequestShape({ api: 'text', ...switches })).toEqual({ maxTokens: 900, overridePayload: { temperature: 0.2 } });
    });

    it('never sends a key outside the closed set, for any combination of switches', () => {
        for (const api of ['chat', 'text']) {
            for (const sendTemperature of [true, false]) {
                for (const tokenLimitParameter of ['max_tokens', 'max_completion_tokens']) {
                    for (const reasoningEffort of [null, 'low']) {
                        const { overridePayload } = connectionProfileRequestShape({ ...switches, api, sendTemperature, tokenLimitParameter, reasoningEffort });
                        expect(Object.keys(overridePayload).filter(key => !CONNECTION_PROFILE_OVERRIDE_KEYS[api].includes(key))).toEqual([]);
                    }
                }
            }
        }
    });
});

describe('what stops a call on a profile before it starts', () => {
    const profile = { id: 'profile-chat', name: 'Harbor chat', api: 'custom', model: 'harbor-model' };
    const ready = { feature: 'EventBase', page: 'Core', profileId: 'profile-chat', isManagerAvailable: true, profile, isSupported: true, api: 'chat' };

    it('passes a usable profile', () => {
        expect(connectionProfileProblem(ready)).toBe('');
        expect(connectionProfileProblem({ ...ready, api: 'text', profile: { ...profile, model: '' } })).toBe('');
    });

    it('names the feature and where to fix each problem, in order', () => {
        expect(connectionProfileProblem({ ...ready, profileId: '' })).toBe('EventBase: no connection profile is chosen. Choose one on the Core page.');
        expect(connectionProfileProblem({ ...ready, isManagerAvailable: false })).toMatch(/^EventBase: SillyTavern's Connection Manager extension is off.*Core page\.$/);
        expect(connectionProfileProblem({ ...ready, profile: null })).toBe('EventBase: its connection profile was deleted in SillyTavern. Choose another on the Core page.');
        expect(connectionProfileProblem({ ...ready, isSupported: false })).toMatch(/^EventBase: SillyTavern can't send requests on profile "Harbor chat" \(API "custom"\)\..*Core page\.$/);
        expect(connectionProfileProblem({ ...ready, profile: { ...profile, model: ' ' } })).toBe('EventBase: profile "Harbor chat" names no model. Choose a model in that profile in SillyTavern.');
    });
});

describe('what a failed profile call means', () => {
    const context = { feature: 'EventBase', profileName: 'Harbor chat', model: 'harbor-model', storesKey: true };
    const failed = cause => Object.assign(new Error('API request failed'), { cause });
    const causeOf = (message, name = 'Error') => Object.assign(new Error(message), { name });

    it('1: a bare SillyTavern error before the request is a configuration error', () => {
        expect(classifyConnectionProfileFailure(new Error('Connection Manager is not available'), context))
            .toMatchObject({ kind: 'model_config', message: 'EventBase: profile "Harbor chat" could not be used: Connection Manager is not available' });
    });

    it('2: a timeout or an abort rethrows its cause', () => {
        const timeout = causeOf('signal timed out', 'TimeoutError');
        expect(classifyConnectionProfileFailure(failed(timeout), context)).toEqual({ kind: 'rethrow', cause: timeout });
        expect(classifyConnectionProfileFailure(failed(causeOf('aborted', 'AbortError')), context).kind).toBe('rethrow');
    });

    it('3: "Response not OK" points at the server console, or says no key was sent when the profile stores none', () => {
        expect(classifyConnectionProfileFailure(failed(causeOf('Response not OK')), context))
            .toMatchObject({ kind: 'model_config', message: 'EventBase: SillyTavern got no usable reply on profile "Harbor chat". The reason is in the SillyTavern server console.' });
        expect(classifyConnectionProfileFailure(failed(causeOf('Response not OK')), { ...context, storesKey: false }).message)
            .toBe('EventBase: the provider needs an API key, and profile "Harbor chat" stores none, so VectFox sent none. Select the key in SillyTavern and update the profile.');
    });

    it('4: a key problem gives the key message', () => {
        expect(classifyConnectionProfileFailure(failed(causeOf('Unauthorized')), context))
            .toMatchObject({ kind: 'model_config', message: 'EventBase: the provider rejected the API key for profile "Harbor chat", or that key was deleted in SillyTavern. Check the key saved in that profile in SillyTavern.' });
        expect(classifyConnectionProfileFailure(failed(causeOf('Invalid API key provided')), { ...context, storesKey: false }).message)
            .toMatch(/stores none, so VectFox sent none/);
    });

    it('4: a server\'s own wording of a 401 that names authorization gives the key message too', () => {
        expect(classifyConnectionProfileFailure(failed(causeOf('Authorization Required')), { ...context, storesKey: false }))
            .toMatchObject({ kind: 'model_config', message: 'EventBase: the provider needs an API key, and profile "Harbor chat" stores none, so VectFox sent none. Select the key in SillyTavern and update the profile.' });
        expect(classifyConnectionProfileFailure(failed(causeOf('Authorization Required')), context).message)
            .toMatch(/rejected the API key for profile "Harbor chat"/);
    });

    it('5: a reply that is not JSON, as from a URL serving a web page, points at the profile\'s URL', () => {
        const urlMessage = 'EventBase: the server of profile "Harbor chat" answered with a web page or other text, not an API reply. Check the URL saved in that profile in SillyTavern.';
        for (const detail of [
            'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
            'Unexpected token < in JSON at position 0',
            'Unexpected end of JSON input',
            'invalid json response body at http://10.0.0.5:5151/chat/completions reason: Unexpected token < in JSON at position 0',
        ]) {
            expect(classifyConnectionProfileFailure(failed(causeOf(detail)), context), detail).toMatchObject({ kind: 'model_config', message: urlMessage });
        }
    });

    it('6: a model or configuration error aborts the run', () => {
        expect(classifyConnectionProfileFailure(failed(causeOf('Not Found')), context)).toMatchObject({ kind: 'model_config' });
    });

    it('7: an unreachable server is a connection failure', () => {
        expect(classifyConnectionProfileFailure(failed(causeOf('Connection refused: 127.0.0.1:8080')), context))
            .toMatchObject({ kind: 'connection', detail: 'Connection refused: 127.0.0.1:8080' });
    });

    it('8: anything else, a moderation block included, skips only its window', () => {
        expect(classifyConnectionProfileFailure(failed(causeOf('Forbidden')), context)).toMatchObject({ kind: 'upstream_error' });
        expect(classifyConnectionProfileFailure(failed(causeOf('Too Many Requests')), context)).toMatchObject({ kind: 'upstream_error' });
    });
});
