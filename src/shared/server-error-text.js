/**
 * The text a server answers a failed request with, as VectFox may log and show it: anything shaped like an API key
 * replaced, a masked key included. A provider can quote the key it refused (OpenAI's 401 shows it masked), and
 * Similharity before 3.4.4 passes such a reply on, so every failed reply VectFox reads goes through readErrorBody.
 */

// Vendor key prefixes (OpenAI, OpenRouter, Anthropic, xAI, Groq, NVIDIA, Hugging Face, Google), a masked key
// (characters around a run of stars or bullets), and a Bearer token. Similharity's server-failure-text.js keeps the
// same shapes.
const KEY_SHAPES = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_\-*•.]{6,}/g,
    /\b(?:xai|gsk|nvapi|hf)[-_][A-Za-z0-9_\-*•]{10,}/g,
    /\bAIza[0-9A-Za-z_\-*]{20,}/g,
    /[A-Za-z0-9_-]*(?:\*{3,}|•{2,})[A-Za-z0-9_-]*/g,
    /\bBearer\s+\S+/gi,
];

/**
 * Text with anything shaped like an API key replaced, a masked key included.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactKeyMaterial(text) {
    return KEY_SHAPES.reduce((out, shape) => out.replace(shape, '[key removed]'), String(text ?? ''));
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
