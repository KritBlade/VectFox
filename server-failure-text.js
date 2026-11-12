// What a server's failed reply may tell the client, without quoting the reply. A provider can quote the key it
// refused (OpenAI's 401 shows it masked), so the plugin passes on only the status code, its status text and fixed
// hints chosen from the reply. Every hint the reply earns is given, and each keeps a word VectFox reads, from 3.6.17
// on: "not found" for a model or setup error, "rate limit", "timed out" or "network" for a server worth asking again,
// and "network error" for a server VectFox reports as unreachable. A reply's own word "suspended", which VectFox also
// retries on, is not carried, as no hint would describe it.
//
// SillyTavern's own embedding functions put the status text and the reply into their errors, so the code is read back
// from the status text. Anything else that reaches the client passes through redactKeyMaterial, the last guard.

const KEY_REFUSED = /unauthori[sz]ed|authoriz|api[ _-]?key|apikey|authenticat|credential/i;
const MODEL_INVALID = /deprecated|no endpoints?|no allowed providers?|not found|not_found|no such model|unknown model|invalid model|not a valid model|does not exist|doesn't exist/i;
const SERVER_BUSY = /overloaded|rate.?limit|too many requests|over capacity|\bbusy\b|try again later/i;
const SERVER_TIMEOUT = /timed? ?out|timeout/i;
const NETWORK_FAILURE = /network|fetch|econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|enetunreach|epipe|getaddrinfo|socket hang up|connection (?:refused|error)|refused to connect|could not connect|invalid[ _]url|err_connection|net::err|dns lookup/i;

// What the server did, in the order a message names it, and what earns each.
const HINTS = [
    { text: 'refused the API key', isEarned: ({ status, statusText, reply }) => status === 401 || /^unauthori[sz]ed$/i.test(statusText) || KEY_REFUSED.test(reply) },
    { text: 'says the model was not found or is not valid', isEarned: ({ reply }) => MODEL_INVALID.test(reply) },
    { text: 'is busy or hit a rate limit', isEarned: ({ status, statusText, reply }) => status === 429 || /^too many requests$/i.test(statusText) || SERVER_BUSY.test(reply) },
    { text: 'timed out', isEarned: ({ reply }) => SERVER_TIMEOUT.test(reply) },
    { text: 'reports a network error', isEarned: ({ reply }) => NETWORK_FAILURE.test(reply) },
];

// SillyTavern 1.19.0's vllm-vectors.js, ollama-vectors.js and llamacpp-vectors.js throw
// "<name>: Failed to get vector for text: <status text> <reply>".
const SILLYTAVERN_REPLY_ERROR = /^(.*?Failed to get (?:batch )?vectors?(?: for text)?):\s*(.*)$/s;
const STATUS_CODES = new Map([
    ['Bad Request', 400], ['Unauthorized', 401], ['Payment Required', 402], ['Forbidden', 403], ['Not Found', 404],
    ['Method Not Allowed', 405], ['Not Acceptable', 406], ['Request Timeout', 408], ['Conflict', 409], ['Gone', 410],
    ['Payload Too Large', 413], ['Content Too Large', 413], ['Unprocessable Entity', 422], ['Unprocessable Content', 422],
    ['Too Many Requests', 429], ['Internal Server Error', 500], ['Not Implemented', 501], ['Bad Gateway', 502],
    ['Service Unavailable', 503], ['Gateway Timeout', 504],
]);

// Key shapes and what replaces each: the value Node's fetch quotes when it refuses a header, vendor prefixes (OpenAI,
// OpenRouter, Anthropic, xAI, Groq, NVIDIA, Hugging Face, Google), a masked key (up to 64 characters each side of a
// run of stars or bullets), a Bearer token, and the user and password written into a URL. Every shape runs in time
// linear in the text, so a long reply cannot stall it. VectFox's shared/server-error-text.js keeps the same shapes.
const KEY_SHAPES = [
    [/"[^"]*(?=" is an invalid header)/g, '"[key removed]'],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_\-*•.]{6,}/g, '[key removed]'],
    [/\b(?:xai|gsk|nvapi|hf)[-_][A-Za-z0-9_\-*•]{10,}/g, '[key removed]'],
    [/\bAIza[0-9A-Za-z_\-*]{20,}/g, '[key removed]'],
    [/[A-Za-z0-9_-]{0,64}(?:\*{3,}|•{2,})[A-Za-z0-9_-]{0,64}/g, '[key removed]'],
    [/\bBearer\s+\S+/gi, '[key removed]'],
    [/(\/\/)[^\s/?#@]+@/g, '$1[key removed]@'],
];

/** "a", "a and b", "a, b and c" */
function joinedHints(hints) {
    return hints.length < 2 ? hints.join('') : `${hints.slice(0, -1).join(', ')} and ${hints.at(-1)}`;
}

/**
 * A failed reply as the plugin passes it on: its status, its status text and fixed hints, never its body.
 *
 * @param {{status?: number, statusText?: string, reply?: string}} failure
 * @returns {string} For example "401 Unauthorized (the server refused the API key)", or '' when nothing is known
 */
export function serverFailureText({ status, statusText = '', reply = '' }) {
    const failure = { status, statusText: String(statusText ?? '').trim(), reply: String(reply ?? '') };
    const hints = HINTS.filter(hint => hint.isEarned(failure)).map(hint => hint.text);
    const head = [status, failure.statusText].filter(Boolean).join(' ');
    return [head, hints.length > 0 && `(the server ${joinedHints(hints)})`].filter(Boolean).join(' ');
}

/**
 * An Error whose message holds no server reply, marked so errorWithoutServerReply passes it on as it is.
 *
 * @param {string} message
 * @returns {Error}
 */
export function errorFreeOfServerReply(message) {
    return Object.assign(new Error(message), { isFreeOfServerReply: true });
}

/**
 * An error from SillyTavern's own embedding functions, with the server's reply taken out: its prefix, the status
 * code and text, and fixed hints. Any other error keeps its message, with anything key-shaped removed, and its cause,
 * which for a network failure names the address and the reason, such as ECONNREFUSED; formatError adds the cause and
 * removes anything key-shaped from the whole.
 *
 * @param {unknown} error
 * @returns {Error}
 */
export function errorWithoutServerReply(error) {
    if (error?.isFreeOfServerReply) return error;
    const message = String(error?.message ?? error ?? 'unknown error');
    const match = message.match(SILLYTAVERN_REPLY_ERROR);
    if (!match) {
        const kept = errorFreeOfServerReply(redactKeyMaterial(message));
        if (error?.cause) kept.cause = error.cause;
        return kept;
    }
    const [, prefix, rest] = match;
    const statusText = [...STATUS_CODES.keys()].find(text => rest.toLowerCase().startsWith(text.toLowerCase())) ?? '';
    const failure = serverFailureText({ status: STATUS_CODES.get(statusText), statusText, reply: rest.slice(statusText.length) });
    return errorFreeOfServerReply(failure ? `${prefix}: ${failure}` : prefix);
}

/**
 * Text with anything shaped like an API key replaced, a masked key included.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactKeyMaterial(text) {
    return KEY_SHAPES.reduce((out, [shape, replacement]) => out.replace(shape, replacement), String(text ?? ''));
}
