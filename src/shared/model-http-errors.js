const MODEL_CONFIG_STATUSES = new Set([400, 404]);
// Match phrases that point at a wrong/retired/unavailable model. We must NOT match
// the bare word "model": context-length-exceeded and content-policy 400s also say
// "model" (e.g. "this model's maximum context length…"), and those are per-window
// failures that should be skipped, not promoted to a run-aborting fatal error.
// "not found" IS included on purpose: OpenRouter via ST's proxy returns HTTP 200
// with body {"message":"Not Found"} for an invalid model — the real-world signal we
// must catch. A genuine routing 404 also matches, but that's a config problem worth
// surfacing too, so the broadness is acceptable (context-length/policy don't say it).
const MODEL_CONFIG_ERROR_RE = /(deprecated|no endpoints?|no allowed providers?|not found|not_found|no such model|unknown model|invalid model|not a valid model|does not exist|doesn't exist)/i;

function _upstreamSnippet(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

/**
 * Classify a provider HTTP failure as a model/configuration error (wrong, retired,
 * or unavailable model) that should abort the operation and be surfaced to the user,
 * instead of being silently dropped or treated as a transient per-window skip.
 *
 * Shared by every VectFox path that calls a configured model: EventBase extraction,
 * the summarizer, agent-mode planning, and embedding inserts/queries. Each caller
 * passes its own contextLabel so the message reads e.g. "EventBase: …" / "Embedding: …".
 *
 * @param {object} failure
 * @param {string} [failure.contextLabel] - Prefix identifying the calling path (default 'VectFox').
 * @param {string} failure.provider       - Provider name (OpenRouter, vLLM, …).
 * @param {string} failure.model          - The model id that was requested.
 * @param {number} failure.status         - HTTP status from the provider.
 * @param {string} failure.responseText   - Raw upstream response body (or statusText).
 * @param {boolean} [failure.enforceStatusGate] - When true (default), only 400/404 qualify.
 *        Set false for the embedding path, where the similharity plugin may wrap a
 *        model error as HTTP 500 — there we classify on the forwarded text alone.
 * @returns {string|null} A user-facing fatal message, or null if not a model-config error.
 */
export function getModelConfigErrorMessage({ contextLabel = 'VectFox', provider, model, status, responseText, enforceStatusGate = true }) {
    const snippet = _upstreamSnippet(responseText);
    if (!MODEL_CONFIG_ERROR_RE.test(snippet)) {
        return null;
    }
    if (enforceStatusGate && !MODEL_CONFIG_STATUSES.has(status)) {
        return null;
    }

    return `${contextLabel}: ${provider} model/configuration error for model "${model}" (HTTP ${status}). Upstream response: ${snippet || '(empty response)'}`;
}

/**
 * If the failure is a model/configuration error, throw an Error tagged with
 * `code = 'invalid_model_config'` (the marker the UI notifier keys on). Otherwise
 * return without throwing, so the caller can fall through to its own error handling.
 *
 * Convenience wrapper for paths that don't already have a typed fatal-error class
 * (e.g. embedding insert/query). Paths that DO have one (EventBase, summarizer)
 * call getModelConfigErrorMessage directly and throw their own error type.
 *
 * @param {object} failure - Same shape as getModelConfigErrorMessage's argument.
 */
export function throwIfModelConfigError(failure) {
    const message = getModelConfigErrorMessage(failure);
    if (message) {
        const err = new Error(message);
        err.code = 'invalid_model_config';
        throw err;
    }
}
