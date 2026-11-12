/**
 * The text a server answers a failed request with, as VectFox may log and show it: anything shaped like an API key
 * replaced, a masked key included. A provider can quote the key it refused (OpenAI's 401 shows it masked), and
 * Similharity before 3.4.4 passes such a reply on, so every failed reply VectFox reads goes through readErrorBody.
 */

// Key shapes and what replaces each: the value Node's fetch quotes when it refuses a header, vendor prefixes (OpenAI,
// OpenRouter, Anthropic, xAI, Groq, NVIDIA, Hugging Face, Google), a masked key (up to 64 characters each side of a
// run of stars or bullets), a Bearer token, and the user and password written into a URL. Every shape runs in time
// linear in the text, so a long reply cannot stall it. Similharity's server-failure-text.js keeps the same shapes.
const KEY_SHAPES = [
    [/"[^"]*(?=" is an invalid header)/g, '"[key removed]'],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_\-*•.]{6,}/g, '[key removed]'],
    [/\b(?:xai|gsk|nvapi|hf)[-_][A-Za-z0-9_\-*•]{10,}/g, '[key removed]'],
    [/\bAIza[0-9A-Za-z_\-*]{20,}/g, '[key removed]'],
    [/[A-Za-z0-9_-]{0,64}(?:\*{3,}|•{2,})[A-Za-z0-9_-]{0,64}/g, '[key removed]'],
    [/\bBearer\s+\S+/gi, '[key removed]'],
    [/(\/\/)[^\s/?#@]+@/g, '$1[key removed]@'],
];

/**
 * Text with anything shaped like an API key replaced, a masked key included.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactKeyMaterial(text) {
    return KEY_SHAPES.reduce((out, [shape, replacement]) => out.replace(shape, replacement), String(text ?? ''));
}

/**
 * A failed response's body, with anything key-shaped removed.
 *
 * @param {Response} response
 * @param {string} [fallback] - What the caller shows when the body cannot be read
 * @returns {Promise<string>}
 */
export async function readErrorBody(response, fallback = '') {
    // EXPECTED: a body that cannot be read, already used or cut off, leaves the status and the fallback to say it.
    const text = await response.text().catch(() => fallback);
    return redactKeyMaterial(text);
}
