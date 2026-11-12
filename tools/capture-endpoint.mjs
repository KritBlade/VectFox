// capture-endpoint.mjs: a local HTTP endpoint that stands in for an LLM or embedding server and records, for each
// request, which test key it carried, never a key's value. The connection plan's L1 and A1 rows use it to show that a
// request sent on a SillyTavern profile carries that profile's key and no other.
//
//   node tools/capture-endpoint.mjs --port 9101 [--key A=<made-up key>]... [--auth accept|require|reject]
//        [--delay-ms 0] [--dimensions 8] [--marker <text>] [--extraction-reply empty|one-event]
//
// It listens on 127.0.0.1 only. --key names a made-up test key; a request carrying it is recorded under that name.
// A key that is none of them is recorded as unknown, with only its length, so a real key that reaches the endpoint
// shows up without being shown. A header with a scheme and no key after it, such as "Authorization: Bearer", counts
// as no key. --auth require answers 401 to a request with no key, and --auth reject answers 401
// to every request, as a server refusing the key does. --marker records whether any message holds that text.
//
// It answers the routes VectFox and Similharity call: OpenAI-style /models, /chat/completions, /completions and
// /embeddings, llama.cpp's /completion, /props and /health, KoboldCPP's /api/v1/model, /api/extra/version and
// /api/v1/generate, and Ollama's /api/tags, /api/embed and /api/embeddings. A chat reply is [] for an EventBase
// extraction prompt, or one event with a summary of its own under --extraction-reply one-event, so every window
// stores something; a one-query plan for an Agent Mode planner prompt; and OK otherwise.
//
// GET /__capture returns what it recorded; POST /__capture/reset clears it.

import { createServer } from 'node:http';

const SAMPLING_FIELDS = ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'max_tokens', 'max_completion_tokens', 'seed', 'reasoning_effort'];
const KEY_HEADERS = ['authorization', 'api-key', 'x-api-key'];

function fail(message) {
    console.error(`[capture-endpoint] ${message}`);
    process.exit(1);
}

function parseArguments(argv) {
    const options = { port: 0, keys: new Map(), auth: 'accept', delayMs: 0, dimensions: 8, marker: '', extractionReply: 'empty' };
    for (let index = 0; index < argv.length; index += 2) {
        const [name, value] = [argv[index], argv[index + 1]];
        if (value === undefined) fail(`${name} needs a value`);
        if (name === '--port') options.port = Number(value);
        else if (name === '--auth') options.auth = value;
        else if (name === '--delay-ms') options.delayMs = Number(value);
        else if (name === '--dimensions') options.dimensions = Number(value);
        else if (name === '--marker') options.marker = value;
        else if (name === '--extraction-reply') options.extractionReply = value;
        else if (name === '--key') {
            const separator = value.indexOf('=');
            if (separator < 1) fail('--key takes NAME=<made-up key>');
            options.keys.set(value.slice(separator + 1), value.slice(0, separator));
        } else fail(`unknown option ${name}`);
    }
    if (!Number.isInteger(options.port) || options.port <= 0) fail('--port is required');
    if (!['accept', 'require', 'reject'].includes(options.auth)) fail('--auth is accept, require or reject');
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) fail('--dimensions is a whole number');
    if (!['empty', 'one-event'].includes(options.extractionReply)) fail('--extraction-reply is empty or one-event');
    return options;
}

const options = parseArguments(process.argv.slice(2));
const records = [];

/**
 * A key header's value as the name of the test key it holds, "unknown (N characters)", "empty" for a scheme with no
 * key after it (SillyTavern sends "Bearer " with an empty key, and Node trims the space), or null when absent.
 */
function keyNameOf(headerValue) {
    if (headerValue === undefined) return null;
    const token = String(headerValue).replace(/^(Bearer|Basic)\b/i, '').trim();
    if (!token) return 'empty';
    return options.keys.get(token) ?? `unknown (${token.length} characters)`;
}

/** What a request's key headers held, as one line: their test key names, or none when no header held a key. */
function keyOf(keys) {
    const names = [...new Set(Object.values(keys))].filter(name => name !== 'empty');
    if (names.length) return names.join(' + ');
    return Object.keys(keys).length ? 'none (empty header)' : 'none';
}

/** Every text a request body could hold a marker in: its messages, prompt and input. */
function bodyTextOf(body) {
    return JSON.stringify([body?.messages, body?.prompt, body?.input, body?.system]);
}

function recordOf(request, path, body) {
    const keys = Object.fromEntries(KEY_HEADERS.filter(header => request.headers[header] !== undefined).map(header => [header, keyNameOf(request.headers[header])]));
    const inputs = body?.input ?? body?.prompt;
    return {
        at: new Date().toISOString(),
        method: request.method,
        path,
        key: keyOf(keys),
        keys,
        model: typeof body?.model === 'string' ? body.model : null,
        roles: Array.isArray(body?.messages) ? body.messages.map(message => message?.role ?? '?') : null,
        inputCount: Array.isArray(inputs) ? inputs.length : (inputs === undefined ? 0 : 1),
        hasMarker: options.marker ? bodyTextOf(body).includes(options.marker) : null,
        sampling: Object.fromEntries(SAMPLING_FIELDS.filter(field => body?.[field] !== undefined).map(field => [field, body[field]])),
        isStream: body?.stream === true,
        status: 200,
    };
}

/** A unit vector worked out from the text, the same for the same text, so a search finds what was stored. */
function vectorOf(text) {
    const vector = new Array(options.dimensions).fill(0);
    const source = String(text ?? '');
    for (let index = 0; index < source.length; index += 1) vector[index % options.dimensions] += (source.charCodeAt(index) % 31) + 1;
    const length = Math.hypot(...vector) || 1;
    return vector.map(value => value / length);
}

function chatReplyOf(body) {
    const text = bodyTextOf(body);
    if (text.includes('event_type')) {
        if (options.extractionReply === 'empty') return '[]';
        const summary = `Capture endpoint event ${records.length} at ${new Date().toISOString()}.`;
        return JSON.stringify([{ event_type: 'other', summary, importance: 5, characters: [], locations: [], keywords: ['capture'] }]);
    }
    if (text.includes('queries')) return JSON.stringify({ queries: ['capture endpoint query'], rationale: 'capture endpoint' });
    return 'OK';
}

function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

function sendChat(response, body) {
    const content = chatReplyOf(body);
    if (body?.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
    }
    sendJson(response, 200, {
        id: 'capture', object: 'chat.completion', model: body?.model ?? 'capture-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

function sendEmbeddings(response, path, body) {
    if (path === '/api/embeddings') return sendJson(response, 200, { embedding: vectorOf(body?.prompt) });
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? body?.content ?? ''];
    if (path === '/api/embed') return sendJson(response, 200, { model: body?.model, embeddings: inputs.map(vectorOf) });
    return sendJson(response, 200, {
        object: 'list', model: body?.model ?? 'capture-model',
        data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: vectorOf(input) })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    });
}

/** The answer for a route: a capture route, a refusal by --auth, or what the server it stands in for would say. */
function answer(request, response, path, body, record) {
    const hasKey = !record.key.startsWith('none');
    if (options.auth === 'reject' || (options.auth === 'require' && !hasKey)) {
        record.status = 401;
        const message = hasKey ? 'Incorrect API key provided.' : 'You did not provide an API key.';
        return sendJson(response, 401, { error: { message, type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    const isPost = request.method === 'POST';
    if (path.endsWith('/models')) return sendJson(response, 200, { object: 'list', data: [{ id: 'capture-model', object: 'model' }] });
    if (isPost && (path.endsWith('/embeddings') || path === '/api/embed')) return sendEmbeddings(response, path, body);
    if (isPost && path.endsWith('/chat/completions')) return sendChat(response, body);
    if (isPost && path.endsWith('/completions')) return sendJson(response, 200, { choices: [{ index: 0, text: chatReplyOf(body), finish_reason: 'stop' }] });
    if (isPost && path === '/completion') return sendJson(response, 200, { content: chatReplyOf(body), stop: true });
    if (path === '/props') return sendJson(response, 200, { default_generation_settings: { n_ctx: 4096 }, total_slots: 1 });
    if (path === '/health') return sendJson(response, 200, { status: 'ok' });
    if (path === '/api/v1/model') return sendJson(response, 200, { result: 'koboldcpp/capture-model' });
    if (path === '/api/extra/version') return sendJson(response, 200, { result: 'KoboldCpp', version: '1.124' });
    if (isPost && path === '/api/v1/generate') return sendJson(response, 200, { results: [{ text: chatReplyOf(body) }] });
    if (path === '/api/tags') return sendJson(response, 200, { models: [{ name: 'capture-model', model: 'capture-model' }] });
    return sendJson(response, 200, {});
}

function readBody(request) {
    return new Promise((resolve) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve(null);
            try {
                resolve(JSON.parse(text));
            } catch (error) {
                console.warn(`[capture-endpoint :${options.port}] a body that is not JSON (${text.length} characters):`, error.message);
                resolve(null);
            }
        });
    });
}

const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/__capture') return sendJson(response, 200, records);
    if (path === '/__capture/reset' && request.method === 'POST') {
        records.length = 0;
        return sendJson(response, 200, { cleared: true });
    }
    const body = await readBody(request);
    const record = recordOf(request, path, body);
    records.push(record);
    if (options.delayMs > 0) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    answer(request, response, path, body, record);
    console.log(`[capture-endpoint :${options.port}] ${record.method} ${path} key=${record.key} model=${record.model ?? '-'} status=${record.status}`);
});

server.listen(options.port, '127.0.0.1', () => {
    console.log(`[capture-endpoint :${options.port}] listening, auth ${options.auth}, ${options.keys.size} test key(s), ${options.dimensions} dimensions`);
});
