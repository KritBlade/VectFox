// lorebase-decisions.js — LoreBase's Fast and cheap choice (VectFox's lorebook plan, D16): one request to Jev, a
// decisions model, on the SillyTavern connection profile the user chose for it. Jev answers in Typesafe's System One
// format at <the profile's base URL>/systemone: a state, and yes-or-no questions, each answered with its chance of yes.
//
// The request names the profile's source, its URL for a Custom source, its model and its key as an ID, `secret_id`.
// The key is read here, on SillyTavern's server, and goes only where SillyTavern sends that key: an OpenRouter key to
// OpenRouter's API, a Custom key to the Custom profile's own URL. A request with no ID sends no key, as SillyTavern's
// lookups read the active key when given no ID.
//
// A refusal passes on its status and a fixed hint, never the server's reply, which can quote the key it refused.

import { assertSendableHeaders, fetchOnSameHost } from './request-safety.js';
import { errorFreeOfServerReply, serverFailureText } from './server-failure-text.js';

const NO_KEY_SECRET_ID = 'similharity-no-key';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const DECISIONS_ROUTE = '/systemone';
// LoreBase's calls fail when they have not answered by then (its plan, §5.8).
const TIMEOUT_MS = 30000;
// Limits on what one request may hold: a chat's last messages, and a question per selected entry.
const LONGEST_STATE = 400000;
const MOST_QUESTIONS = 5000;
const LONGEST_INSTRUCTIONS = 4000;
const LONGEST_MODEL = 200;

const SOURCES = Object.freeze({
    openrouter: { name: 'OpenRouter', secretKey: host => host.SECRET_KEYS.OPENROUTER, baseUrl: () => OPENROUTER_API_URL },
    custom: { name: 'Custom', secretKey: host => host.SECRET_KEYS.CUSTOM, baseUrl: apiUrl => apiUrl },
});

/**
 * Where a decisions request goes: OpenRouter's API for an OpenRouter profile, whatever it names, and a Custom
 * profile's own URL, each with the decisions route; a URL that already ends in it is the route itself.
 *
 * @param {string} source - openrouter or custom
 * @param {string} [apiUrl] - A Custom profile's URL
 * @returns {string}
 * @throws {RangeError} For another source, a Custom profile with no URL, or a URL that is not http or https
 */
export function decisionsEndpoint(source, apiUrl) {
    const kind = SOURCES[source];
    if (!kind) throw new RangeError(`Jev runs on an OpenRouter or Custom profile, not "${source}".`);
    const base = String(kind.baseUrl(String(apiUrl ?? '').trim()) ?? '').replace(/\/+$/, '');
    if (!base) throw new RangeError(`${kind.name} profile for Jev names no URL.`);
    const endpoint = base.endsWith(DECISIONS_ROUTE) ? base : `${base}${DECISIONS_ROUTE}`;
    let parsed;
    try {
        parsed = new URL(endpoint);
    } catch (error) {
        throw new RangeError(`"${base}" is not a URL.`, { cause: error });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new RangeError(`"${base}" is not an http or https URL.`);
    return endpoint;
}

/** The questions of a request, checked: each a yes-or-no question with its instructions. */
function checkedQuestions(questions) {
    const entries = questions && typeof questions === 'object' && !Array.isArray(questions) ? Object.entries(questions) : [];
    if (!entries.length || entries.length > MOST_QUESTIONS) throw new RangeError(`questions must hold 1 to ${MOST_QUESTIONS} questions.`);
    for (const [name, question] of entries) {
        if (question?.type !== 'noul' || typeof question.instructions !== 'string' || !question.instructions.trim()
            || question.instructions.length > LONGEST_INSTRUCTIONS) {
            throw new RangeError(`Question "${name}" must be a yes-or-no question (type noul) with instructions of up to ${LONGEST_INSTRUCTIONS} characters.`);
        }
    }
    return Object.fromEntries(entries.map(([name, { instructions }]) => [name, { type: 'noul', instructions }]));
}

function keyHeader(kind, secretId, directories, host) {
    try {
        const key = host.readSecret(directories, kind.secretKey(host), secretId || NO_KEY_SECRET_ID);
        return key ? { Authorization: `Bearer ${key}` } : {};
    } catch (error) {
        // A secrets.json that does not parse throws a message quoting the text around the fault, which can be part of
        // a key, so only the error's kind goes on.
        throw errorFreeOfServerReply(`Jev on ${kind.name}: SillyTavern's saved keys could not be read (${error?.name ?? 'Error'}), so nothing was sent.`);
    }
}

/**
 * Ask Jev one request's questions about one state.
 *
 * @param {{source: string, apiUrl?: string, model: string, secretId?: string, state: string,
 *   questions: Record<string, {type: string, instructions: string}>, directories: object}} request - What the client
 *   sent, and the user's SillyTavern directories, where the key lists are
 * @param {object} host - From loadSillyTavernRequestHost (sillytavern-request-host.js)
 * @returns {Promise<{yes: Record<string, number>, inputTokens: number|null, usd: number|null}>} Each question's chance of
 *   yes, and the request's input tokens and cost when the server says them
 * @throws {RangeError} When the request is malformed, before any is sent; {Error} with the status and a fixed hint
 *   when the server refuses it, never the server's reply
 */
export async function askDecisions({ source, apiUrl, model, secretId, state, questions, directories }, host) {
    const endpoint = decisionsEndpoint(source, apiUrl);
    const kind = SOURCES[source];
    if (typeof model !== 'string' || !model.trim() || model.length > LONGEST_MODEL) throw new RangeError('The profile for Jev names no model.');
    if (typeof state !== 'string' || !state.trim() || state.length > LONGEST_STATE) {
        throw new RangeError(`state must be text of 1 to ${LONGEST_STATE} characters.`);
    }
    const checked = checkedQuestions(questions);
    const headers = { 'Content-Type': 'application/json', ...keyHeader(kind, secretId, directories, host) };
    assertSendableHeaders(headers, `Jev on ${kind.name}`);
    // The key header would follow a redirect to another host, so only a redirect on this host is followed.
    const response = await fetchOnSameHost(host.fetch, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: model.trim(), state, questions: checked }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        const failure = serverFailureText({ status: response.status, statusText: response.statusText, reply: await response.text() });
        throw errorFreeOfServerReply(`Jev on ${kind.name}: ${failure}`);
    }
    const payload = await response.json();
    const yes = {};
    for (const name of Object.keys(checked)) {
        const chance = payload?.answers?.[name]?.noul;
        if (typeof chance !== 'number' || !Number.isFinite(chance)) {
            throw errorFreeOfServerReply(`Jev on ${kind.name}: its reply held no chance of yes for question "${name}".`);
        }
        yes[name] = chance;
    }
    const usage = payload?.usage ?? {};
    return {
        yes,
        inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
        usd: Number.isFinite(usage.cost) ? usage.cost : null,
    };
}
