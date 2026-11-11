/**
 * Why a chat completion stopped, read from the reply body on either path: `choices[0].finish_reason`, with
 * OpenRouter's `native_finish_reason` beside it. SillyTavern 1.19.0 hands that body over unchanged for OpenRouter,
 * OpenAI, Custom, DeepSeek, Mistral, xAI and Azure, and for an OpenAI-compatible Text Completion server. It rewraps
 * Claude's and Google's replies with their text alone, so on those two no stop reason reaches VectFox.
 */

// Finishes that mean the model was done. Any other reason means the provider cut the reply.
const NORMAL_FINISHES = new Set(['stop', 'end_turn', 'tool_calls', 'function_call']);
const REFUSAL_CHARACTER_LIMIT = 300;

/**
 * @param {any} data - The parsed reply
 * @returns {string} The finish reason, '' when the reply carries none
 */
export function completionFinishReason(data) {
    const reason = data?.choices?.[0]?.finish_reason;
    return reason == null ? '' : String(reason).trim();
}

/** The provider's own reason, '' when it carries none or only repeats `reason`. */
function nativeFinishReason(data, reason) {
    const native = String(data?.choices?.[0]?.native_finish_reason ?? '').trim();
    return native && native.toLowerCase() !== reason.toLowerCase() ? native : '';
}

/**
 * Why the provider cut the reply, '' for one the model finished.
 *
 * @param {any} data - The parsed reply
 * @returns {string} Such as `length`, or `content_filter (native: SAFETY)`
 */
export function completionCutReason(data) {
    const reason = completionFinishReason(data);
    if (!reason || NORMAL_FINISHES.has(reason.toLowerCase())) return '';
    const native = nativeFinishReason(data, reason);
    return native ? `${reason} (native: ${native})` : reason;
}

/**
 * What a reply with no text held, for its error message: its finish reason, a refusal the provider sent in place of
 * text (OpenAI's `message.refusal`), and the output tokens it spent, with those spent on reasoning. A part the reply
 * does not carry is left out.
 *
 * @param {any} data - The parsed reply
 * @returns {string}
 */
export function describeNoTextAnswer(data) {
    const parts = [];
    const reason = completionFinishReason(data);
    if (reason) {
        const native = nativeFinishReason(data, reason);
        parts.push(`finish_reason "${reason}"${native ? ` (native: ${native})` : ''}`);
    }
    const refusal = String(data?.choices?.[0]?.message?.refusal ?? '').replace(/\s+/g, ' ').trim();
    if (refusal) parts.push(`refusal "${refusal.slice(0, REFUSAL_CHARACTER_LIMIT)}"`);
    const count = value => (value == null || value === '' ? NaN : Number(value));
    const outputTokens = count(data?.usage?.completion_tokens);
    const reasoningTokens = count(data?.usage?.completion_tokens_details?.reasoning_tokens);
    if (Number.isFinite(outputTokens)) {
        const spent = `${outputTokens} output token${outputTokens === 1 ? '' : 's'}`;
        parts.push(reasoningTokens > 0 ? `${spent}, ${reasoningTokens} of them reasoning` : spent);
    }
    return parts.length > 0 ? parts.join(' · ') : 'the reply carries no finish reason and no token counts';
}
