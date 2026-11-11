// Tests embedding on llama.cpp, KoboldCPP and Custom: the key a request sends is the one its ID names, or none, and
// never SillyTavern's active key; the URL, model and batches each server gets; and the errors before and after a
// request. SillyTavern is stubbed as its 1.19.0 code behaves: a key lookup with no ID reads the active key, one with
// an ID reads that key or nothing, and llama.cpp's and KoboldCPP's headers come from that lookup.
//
//   node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getOpenAiStyleEmbeddings, OPENAI_STYLE_BATCH_LIMIT } from '../openai-style-embedding.js';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SOURCES = ['llamacpp', 'koboldcpp', 'custom'];
const KEY_SLOT = { llamacpp: 'api_key_llamacpp', koboldcpp: 'api_key_koboldcpp', custom: 'api_key_custom' };
const PROFILE_KEY_ID = 'profile-key-id';
const DIRECTORIES = { root: '/st/data/default-user' };

/** SillyTavern's key lists: each slot's active key, and the profile's key under its ID. */
const SAVED_KEYS = {
    api_key_llamacpp: [{ id: 'active-llamacpp', value: 'active-llamacpp-key', active: true }, { id: PROFILE_KEY_ID, value: 'profile-key', active: false }],
    api_key_koboldcpp: [{ id: 'active-koboldcpp', value: 'active-koboldcpp-key', active: true }, { id: PROFILE_KEY_ID, value: 'profile-key', active: false }],
    api_key_custom: [{ id: 'active-custom', value: 'active-custom-key', active: true }, { id: PROFILE_KEY_ID, value: 'profile-key', active: false }],
};

/** A reply of one embedding per text, each naming its text's place, in the order `order` gives. */
function embeddingsReply(input, order = items => items) {
    const data = input.map((text, index) => ({ index, embedding: [index, text.length] }));
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: order(data) }), text: async () => '' };
}

/** SillyTavern as the plugin sees it, recording each key lookup and each request. */
function stubSillyTavern({ reply = embeddingsReply } = {}) {
    const lookups = [];
    const requests = [];
    // As SecretManager.readSecret: with an ID, that key or none; with none, the active key.
    const readSecret = (directories, key, id = null) => {
        lookups.push({ key, id });
        return (SAVED_KEYS[key] ?? []).find(secret => (id ? secret.id === id : secret.active))?.value || '';
    };
    const host = {
        TEXTGEN_TYPES: { LLAMACPP: 'llamacpp', KOBOLDCPP: 'koboldcpp' },
        SECRET_KEYS: { CUSTOM: 'api_key_custom', LLAMACPP: 'api_key_llamacpp', KOBOLDCPP: 'api_key_koboldcpp' },
        // SillyTavern 1.19.0's util.js trimV1.
        trimV1: str => String(str ?? '').replace(/\/$/, '').replace(/\/v1$/, ''),
        readSecret,
        // As getLlamaCppHeaders and getKoboldCppHeaders, which setAdditionalHeadersByType calls for these two types.
        setAdditionalHeadersByType: (headers, type, server, directories, secretId = null) => {
            const key = readSecret(directories, `api_key_${type}`, secretId);
            if (key) headers.Authorization = `Bearer ${key}`;
        },
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            requests.push({ url, headers: init.headers, body });
            return reply(body.input);
        },
    };
    return { host, lookups, requests };
}

const URL_OF = { llamacpp: 'http://10.0.0.5:8080', koboldcpp: 'http://10.0.0.6:5001', custom: 'https://embed.example.test/v1' };
const embed = (source, texts, request, host) => getOpenAiStyleEmbeddings(source, texts, { apiUrl: URL_OF[source], directories: DIRECTORIES, ...request }, host);

for (const source of SOURCES) {
    test(`${source}: the key the profile's ID names is sent, not the active one`, async () => {
        const { host, requests } = stubSillyTavern();
        await embed(source, ['a harbor at dusk'], { secretId: PROFILE_KEY_ID }, host);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers.Authorization, 'Bearer profile-key');
    });

    test(`${source}: no ID sends no key, while another key is active`, async () => {
        const { host, requests, lookups } = stubSillyTavern();
        await embed(source, ['a harbor at dusk'], {}, host);
        assert.equal('Authorization' in requests[0].headers, false);
        assert.ok(lookups.length > 0 && lookups.every(lookup => lookup.key === KEY_SLOT[source] && lookup.id));
    });

    test(`${source}: an ID whose key was deleted in SillyTavern sends no key`, async () => {
        const { host, requests } = stubSillyTavern();
        await embed(source, ['a harbor at dusk'], { secretId: 'deleted-key-id' }, host);
        assert.equal('Authorization' in requests[0].headers, false);
    });

    for (const apiUrl of ['', '   ', undefined]) {
        test(`${source}: no server URL (${JSON.stringify(apiUrl)}) throws before any request`, async () => {
            const { host, requests } = stubSillyTavern();
            await assert.rejects(embed(source, ['a harbor at dusk'], { apiUrl }, host), /embedding: the request names no server URL\.$/);
            assert.equal(requests.length, 0);
        });
    }

    test(`${source}: a URL that does not parse throws before any request`, async () => {
        const { host, requests } = stubSillyTavern();
        await assert.rejects(embed(source, ['a harbor at dusk'], { apiUrl: 'harbor lantern' }, host), /"harbor lantern" is not a URL\.$/);
        assert.equal(requests.length, 0);
    });
}

test('each server gets its own embeddings route', async () => {
    const routes = [
        ['llamacpp', 'http://10.0.0.5:8080', 'http://10.0.0.5:8080/v1/embeddings'],
        ['llamacpp', 'http://10.0.0.5:8080/v1/', 'http://10.0.0.5:8080/v1/embeddings'],
        ['koboldcpp', 'http://10.0.0.6:5001/', 'http://10.0.0.6:5001/v1/embeddings'],
        ['custom', 'https://embed.example.test/v1', 'https://embed.example.test/v1/embeddings'],
        ['custom', 'https://embed.example.test/api/', 'https://embed.example.test/api/embeddings'],
    ];
    for (const [source, apiUrl, expected] of routes) {
        const { host, requests } = stubSillyTavern();
        await embed(source, ['a harbor at dusk'], { apiUrl }, host);
        assert.equal(requests[0].url, expected, `${source} on ${apiUrl}`);
    }
});

test('the model is named when the profile holds one, and left out when it holds none', async () => {
    const named = stubSillyTavern();
    await embed('custom', ['a harbor at dusk'], { model: 'bge-m3' }, named.host);
    assert.deepEqual(named.requests[0].body, { input: ['a harbor at dusk'], model: 'bge-m3' });

    const unnamed = stubSillyTavern();
    await embed('koboldcpp', ['a harbor at dusk'], { model: '' }, unnamed.host);
    assert.deepEqual(unnamed.requests[0].body, { input: ['a harbor at dusk'] });
});

test(`a Custom batch splits at ${OPENAI_STYLE_BATCH_LIMIT} texts and comes back in order`, async () => {
    const texts = Array.from({ length: 70 }, (_, place) => `text ${'x'.repeat(place)}`);
    const { host, requests } = stubSillyTavern({ reply: input => embeddingsReply(input, items => [...items].reverse()) });
    const embeddings = await embed('custom', texts, { secretId: PROFILE_KEY_ID }, host);
    assert.deepEqual(requests.map(request => request.body.input.length), [32, 32, 6]);
    assert.ok(requests.every(request => request.headers.Authorization === 'Bearer profile-key'));
    assert.deepEqual(embeddings.map(embedding => embedding[1]), texts.map(text => text.length));
});

test('a refusal throws with the status and the server\'s own text', async () => {
    const refusal = () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"Invalid API key"}' });
    const { host } = stubSillyTavern({ reply: refusal });
    await assert.rejects(embed('custom', ['a harbor at dusk'], {}, host), { message: 'Custom embedding: 401 Unauthorized {"error":"Invalid API key"}' });
});

test('a reply without one embedding per text throws', async () => {
    const short = input => embeddingsReply(input, items => items.slice(1));
    const { host } = stubSillyTavern({ reply: short });
    await assert.rejects(embed('llamacpp', ['one', 'two'], {}, host), { message: 'llama.cpp embedding: the server returned 1 embeddings for 2 texts.' });

    const notOpenAiStyle = () => ({ ok: true, status: 200, json: async () => ({ embedding: [0.1] }) });
    const second = stubSillyTavern({ reply: notOpenAiStyle });
    await assert.rejects(embed('koboldcpp', ['one'], {}, second.host), { message: 'KoboldCPP embedding: the server\'s reply holds no data array.' });
});

test('a source with no OpenAI-style route is refused before any request', async () => {
    const { host, requests } = stubSillyTavern();
    await assert.rejects(getOpenAiStyleEmbeddings('vllm', ['one'], { apiUrl: 'http://10.0.0.7:8000', directories: DIRECTORIES }, host), /does not embed on an OpenAI-style route/);
    assert.equal(requests.length, 0);
});

// Credential invariant 7 of VectFox's connection plan.
test('invariant 7: ST\'s llama.cpp embedding is never called, and the Custom key is read only by an ID', async () => {
    const pluginFiles = readdirSync(PLUGIN_ROOT).filter(name => name.endsWith('.js'));
    assert.ok(pluginFiles.includes('index.js') && pluginFiles.includes('openai-style-embedding.js'));
    for (const name of pluginFiles) {
        const text = readFileSync(path.join(PLUGIN_ROOT, name), 'utf8');
        assert.doesNotMatch(text, /getLlamaCppVector|getLlamaCppBatchVector/, `${name} names SillyTavern's llama.cpp embedding`);
        if (name !== 'openai-style-embedding.js') {
            assert.doesNotMatch(text, /api_key_custom|SECRET_KEYS\.CUSTOM/, `${name} reads the Custom key`);
        }
    }

    for (const source of SOURCES) {
        for (const secretId of [PROFILE_KEY_ID, '', null, undefined]) {
            const { host, lookups } = stubSillyTavern();
            await embed(source, ['a harbor at dusk'], { secretId }, host);
            assert.ok(lookups.length > 0, `${source} looked up no key`);
            assert.ok(lookups.every(lookup => typeof lookup.id === 'string' && lookup.id.length > 0), `${source} with ${JSON.stringify(secretId)} looked a key up with no ID`);
        }
    }
});
