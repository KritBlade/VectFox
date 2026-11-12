// What a server's failed reply may tell the client, without quoting the reply. A provider can quote the key it
// refused (OpenAI's 401 shows it masked), so the plugin passes on only the status, its status text and a fixed hint
// chosen from the reply. The hints keep the words VectFox reads, from 3.6.39 on: "not found" for a model or setup
// error, "API key" for a refused key, and "rate limit" or "timed out" for a server worth asking again.
//
// SillyTavern's own embedding functions put the reply into their errors, and anything else that reaches the client
// passes through redactKeyMaterial, the last guard.

const KEY_REFUSED = /unauthori[sz]ed|authoriz|api[ _-]?key|apikey|authenticat|credential/i;
const MODEL_INVALID = /deprecated|no endpoints?|no allowed providers?|not found|not_found|no such model|unknown model|invalid model|not a valid model|does not exist|doesn't exist/i;
const SERVER_BUSY = /overloaded|rate.?limit|too many requests|over capacity|\bbusy\b|try again later/i;
const SERVER_TIMEOUT = /timed? ?out|timeout/i;

const HINT = {
    keyRefused: 'the server refused the API key',
    modelInvalid: 'the server says the model was not found or is not valid',
    serverBusy: 'the server is busy or hit a rate limit',
    serverTimeout: 'the server timed out',
};

// SillyTavern 1.19.0's vllm-vectors.js, ollama-vectors.js and llamacpp-vectors.js throw
// "<name>: Failed to get vector for text: <status text> <reply>".
const SILLYTAVERN_REPLY_ERROR = /^(.*?Failed to get (?:batch )?vectors?(?: for text)?):\s*(.*)$/s;
const STATUS_TEXTS = [
    'Bad Request', 'Unauthorized', 'Payment Required', 'Forbidden', 'Not Found', 'Method Not Allowed', 'Not Acceptable',
    'Request Timeout', 'Conflict', 'Gone', 'Payload Too Large', 'Content Too Large', 'Unprocessable Entity',
    'Unprocessable Content', 'Too Many Requests', 'Internal Server Error', 'Not Implemented', 'Bad Gateway',
    'Service Unavailable', 'Gateway Timeout',
];

// Key shapes: vendor prefixes (OpenAI, OpenRouter, Anthropic, xAI, Groq, NVIDIA, Hugging Face, Google), a masked key
// (characters around a run of stars or bullets), and a Bearer token.
const KEY_SHAPES = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_\-*•.]{6,}/g,
    /\b(?:xai|gsk|nvapi|hf)[-_][A-Za-z0-9_\-*•]{10,}/g,
    /\bAIza[0-9A-Za-z_\-*]{20,}/g,
    /[A-Za-z0-9_-]*(?:\*{3,}|•{2,})[A-Za-z0-9_-]*/g,
    /\bBearer\s+\S+/gi,
];

/** The hint a reply earns: its status decides when it can, then its words. */
function hintOf(status, statusText, reply) {
    if (status === 401 || /^unauthori[sz]ed$/i.test(statusText)) return HINT.keyRefused;
    if (status === 429 || /^too many requests$/i.test(statusText)) return HINT.serverBusy;
    if (KEY_REFUSED.test(reply)) return HINT.keyRefused;
    if (MODEL_INVALID.test(reply)) return HINT.modelInvalid;
    if (SERVER_BUSY.test(reply)) return HINT.serverBusy;
    if (SERVER_TIMEOUT.test(reply)) return HINT.serverTimeout;
    return '';
}

/**
 * A failed reply as the plugin passes it on: its status, its status text and a fixed hint, never its body.
 *
 * @param {{status?: number, statusText?: string, reply?: string}} failure
 * @returns {string} For example "401 Unauthorized (the server refused the API key)", or '' when nothing is known
 */
export function serverFailureText({ status, statusText = '', reply = '' }) {
    const text = String(statusText ?? '').trim();
    const hint = hintOf(status, text, String(reply ?? ''));
    const head = [status, text].filter(Boolean).join(' ');
    return [head, hint && `(${hint})`].filter(Boolean).join(' ');
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
 * text and a fixed hint. Any other error keeps its message, with anything key-shaped removed, and no cause.
 *
 * @param {unknown} error
 * @returns {Error}
 */
export function errorWithoutServerReply(error) {
    if (error?.isFreeOfServerReply) return error;
    const message = String(error?.message ?? error ?? 'unknown error');
    const match = message.match(SILLYTAVERN_REPLY_ERROR);
    if (!match) return errorFreeOfServerReply(redactKeyMaterial(message));
    const [, prefix, rest] = match;
    const statusText = STATUS_TEXTS.find(text => rest.toLowerCase().startsWith(text.toLowerCase())) ?? '';
    const failure = serverFailureText({ statusText, reply: rest.slice(statusText.length) });
    return errorFreeOfServerReply(failure ? `${prefix}: ${failure}` : prefix);
}

/**
 * Text with anything shaped like an API key replaced, a masked key included.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactKeyMaterial(text) {
    return KEY_SHAPES.reduce((out, shape) => out.replace(shape, '[key removed]'), String(text ?? ''));
}
