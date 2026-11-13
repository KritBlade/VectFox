/**
 * Why a completion stopped, read from the reply body SillyTavern 1.19.0 hands back on either path, in OpenAI's words.
 * It hands back unchanged an OpenAI-style body, `choices[0].finish_reason` with OpenRouter's `native_finish_reason`
 * beside it, from OpenRouter, OpenAI, Custom, DeepSeek, Mistral, xAI and Azure, and from an OpenAI-compatible Text
 * Completion server. It hands back three servers' own bodies unchanged too: Ollama's `done_reason`, already in OpenAI's
 * words, and llama.cpp's `stop_type` and Cohere's `finish_reason`, put into OpenAI's words here, with the server's own
 * word kept as the native reason. It rewraps Claude's and Google's replies with their text alone, so on those two no
 * stop reason reaches VectFox.
 */

// Finishes that mean the model was done. Any other reason means the provider cut the reply.
const NORMAL_FINISHES = new Set(['stop', 'end_turn', 'tool_calls', 'function_call']);
// llama.cpp's `/completion` `stop_type` and Cohere's v2 `finish_reason`, in OpenAI's words, so the token limit reads as
// `length`, the word the callers' token-limit messages check. A word not listed keeps its own and reads as a cut:
// llama.cpp's `none`, and Cohere's `ERROR` and `TIMEOUT`.
const LLAMACPP_STOP_TYPES = Object.freeze({ eos: 'stop', word: 'stop', limit: 'length' });
const COHERE_FINISH_REASONS = Object.freeze({ COMPLETE: 'stop', STOP_SEQUENCE: 'stop', MAX_TOKENS: 'length', TOOL_CALL: 'tool_calls' });
const REFUSAL_CHARACTER_LIMIT = 300;

/** A server's own stop word in OpenAI's words, where the table has it, with the server's word as the native reason. */
function inOpenAiWords(openAiWordByServerWord, serverWord) {
    const native = String(serverWord).trim();
    return { reason: openAiWordByServerWord[native] ?? native, native };
}

/**
 * The finish reason and the provider's own word beside it, from the first shape the reply has: OpenAI-style choices,
 * then Ollama's, llama.cpp's and Cohere's own fields.
 *
 * @param {any} data - The parsed reply
 * @returns {{reason: string, native: string}} '' for each one the reply does not carry
 */
function finishReasons(data) {
    const choice = data?.choices?.[0];
    if (choice?.finish_reason != null) {
        return { reason: String(choice.finish_reason).trim(), native: String(choice.native_finish_reason ?? '').trim() };
    }
    if (data?.done_reason != null) return { reason: String(data.done_reason).trim(), native: '' };
    if (data?.stop_type != null) return inOpenAiWords(LLAMACPP_STOP_TYPES, data.stop_type);
    if (data?.finish_reason != null) return inOpenAiWords(COHERE_FINISH_REASONS, data.finish_reason);
    return { reason: '', native: '' };
}

/** The provider's own word, '' when it has none or only repeats `reason`. */
function nativeWordBeside(native, reason) {
    return native && native.toLowerCase() !== reason.toLowerCase() ? native : '';
}

/**
 * @param {any} data - The parsed reply
 * @returns {string} The finish reason in OpenAI's words, '' when the reply carries none
 */
export function completionFinishReason(data) {
    return finishReasons(data).reason;
}

/**
 * Why the provider cut the reply, '' for one the model finished.
 *
 * @param {any} data - The parsed reply
 * @returns {string} Such as `length`, `length (native: MAX_TOKENS)` or `content_filter (native: SAFETY)`
 */
export function completionCutReason(data) {
    const { reason, native } = finishReasons(data);
    if (!reason || NORMAL_FINISHES.has(reason.toLowerCase())) return '';
    const nativeWord = nativeWordBeside(native, reason);
    return nativeWord ? `${reason} (native: ${nativeWord})` : reason;
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
    const { reason, native } = finishReasons(data);
    if (reason) {
        const nativeWord = nativeWordBeside(native, reason);
        parts.push(`finish_reason "${reason}"${nativeWord ? ` (native: ${nativeWord})` : ''}`);
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
