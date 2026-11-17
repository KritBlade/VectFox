// Tests LoreBase's decisions route (lorebase-decisions.js): an OpenRouter profile's key goes only to OpenRouter's API
// and a Custom profile's only to its own URL, each read by the profile's key ID; the request carries the model, the
// state and the questions; the reply's chances of yes, tokens and cost come back; a refusal names its status and a
// hint, never the server's reply; and a malformed request is refused before anything is sent. SillyTavern's key
// lookup and fetch are stand-ins.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askDecisions, decisionsEndpoint } from '../lorebase-decisions.js';

const QUESTIONS = { e1: { type: 'noul', instructions: 'Does the next reply need the lorebook entry "Harbor lighthouse" (about: lighthouse, keeper)?' } };
const STATE = "The chat so far. The last message is the user's; the next reply answers it.\n\nWren: Who keeps the lighthouse?";

function hostWith({ keys = {}, reply = { ok: true, status: 200, json: { answers: { e1: { noul: 0.34 } }, usage: { input_tokens: 120, cost: 0.000014 } } } } = {}) {
    const sent = [];
    const lookups = [];
    const host = {
        SECRET_KEYS: { OPENROUTER: 'api_key_openrouter', CUSTOM: 'api_key_custom' },
        readSecret: (directories, list, id) => {
            lookups.push({ list, id });
            return keys[`${list}/${id}`] ?? '';
        },
        fetch: async (url, init) => {
            sent.push({ url, init });
            return {
                ok: reply.ok, status: reply.status, statusText: reply.statusText ?? '', headers: { get: () => null },
                json: async () => reply.json, text: async () => reply.text ?? '',
            };
        },
    };
    return { host, sent, lookups };
}

test("an OpenRouter profile's key, read by its ID, goes to OpenRouter's API alone, whatever URL the request names", async () => {
    const { host, sent } = hostWith({ keys: { 'api_key_openrouter/or-jev': 'or-key-value' } });
    const answer = await askDecisions({
        source: 'openrouter', apiUrl: 'https://elsewhere.example/v1', model: 'typesafe/jev-1.14', secretId: 'or-jev', state: STATE, questions: QUESTIONS, directories: {},
    }, host);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/systemone');
    assert.equal(sent[0].init.headers.Authorization, 'Bearer or-key-value');
    assert.deepEqual(JSON.parse(sent[0].init.body), { model: 'typesafe/jev-1.14', state: STATE, questions: QUESTIONS });
    assert.deepEqual(answer, { yes: { e1: 0.34 }, inputTokens: 120, usd: 0.000014 });
});

test("a Custom profile's key goes to its own URL's decisions route, and a URL that is the route already is kept", async () => {
    const { host, sent } = hostWith({ keys: { 'api_key_custom/ts-jev': 'ts-key-value' } });
    const request = { source: 'custom', model: 'jev-1.14.0', secretId: 'ts-jev', state: STATE, questions: QUESTIONS, directories: {} };
    await askDecisions({ ...request, apiUrl: 'https://api.typesafe.ai/v1/' }, host);
    await askDecisions({ ...request, apiUrl: 'https://api.typesafe.ai/v1/systemone' }, host);

    assert.deepEqual(sent.map(request => request.url), ['https://api.typesafe.ai/v1/systemone', 'https://api.typesafe.ai/v1/systemone']);
    assert.equal(sent[0].init.headers.Authorization, 'Bearer ts-key-value');
});

test('a profile with no key ID sends no key, never the active one: every lookup names an ID (invariant 7)', async () => {
    for (const secretId of ['', null, undefined]) {
        const { host, sent, lookups } = hostWith({ keys: { 'api_key_custom/undefined': 'active-key', 'api_key_custom/null': 'active-key' } });
        await askDecisions({ source: 'custom', apiUrl: 'http://127.0.0.1:8090/v1', model: 'jev-1.14.0', secretId, state: STATE, questions: QUESTIONS, directories: {} }, host);
        assert.equal(sent[0].init.headers.Authorization, undefined);
        assert.deepEqual(lookups, [{ list: 'api_key_custom', id: 'similharity-no-key' }]);
    }
});

test("a refusal names its status and a hint, never the server's reply", async () => {
    const { host } = hostWith({ reply: { ok: false, status: 401, statusText: 'Unauthorized', text: '{"error":"invalid key sk-or-v1-0123456789abcdef"}' } });
    await assert.rejects(
        askDecisions({ source: 'openrouter', model: 'typesafe/jev-1.14', secretId: 'or-jev', state: STATE, questions: QUESTIONS, directories: {} }, host),
        error => error.message === 'Jev on OpenRouter: 401 Unauthorized (the server refused the API key)' && !error.message.includes('sk-or'),
    );
});

test('a reply with no chance of yes for a question asked is an error', async () => {
    const { host } = hostWith({ reply: { ok: true, status: 200, json: { answers: {} } } });
    await assert.rejects(
        askDecisions({ source: 'openrouter', model: 'typesafe/jev-1.14', state: STATE, questions: QUESTIONS, directories: {} }, host),
        /held no chance of yes for question "e1"/,
    );
});

test('a malformed request is refused before anything is sent', async () => {
    const { host, sent } = hostWith();
    const good = { source: 'openrouter', model: 'typesafe/jev-1.14', state: STATE, questions: QUESTIONS, directories: {} };
    await assert.rejects(askDecisions({ ...good, source: 'claude' }, host), RangeError);
    await assert.rejects(askDecisions({ ...good, source: 'custom', apiUrl: '' }, host), RangeError);
    await assert.rejects(askDecisions({ ...good, source: 'custom', apiUrl: 'file:///etc' }, host), RangeError);
    await assert.rejects(askDecisions({ ...good, model: '' }, host), RangeError);
    await assert.rejects(askDecisions({ ...good, state: '' }, host), RangeError);
    await assert.rejects(askDecisions({ ...good, questions: {} }, host), RangeError);
    await assert.rejects(askDecisions({ ...good, questions: { e1: { type: 'choice', instructions: 'Which?' } } }, host), RangeError);
    assert.equal(sent.length, 0);
});

test('an OpenRouter profile always asks at OpenRouter, and a Custom one at its URL', () => {
    assert.equal(decisionsEndpoint('openrouter', ''), 'https://openrouter.ai/api/v1/systemone');
    assert.equal(decisionsEndpoint('custom', 'https://api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1/systemone');
});
