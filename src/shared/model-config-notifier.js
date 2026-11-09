/**
 * ============================================================================
 * MODEL-CONFIG ERROR NOTIFIER
 * ============================================================================
 * Shared UX for configuration failures: a model that is no longer valid, or a
 * collection whose vector size differs from what the embedding model makes. They
 * carry `code === 'invalid_model_config'`, set by src/shared/model-http-errors.js
 * and by the Qdrant backend.
 *
 * Every model path can hit this (EventBase extraction, summarizer, agent mode,
 * embedding), so the user-facing toast lives here once instead of being
 * re-implemented at each catch site. Pausing EventBase auto-sync after such a
 * failure is eventbase-store.js's pauseAutoSyncForChat.
 * ============================================================================
 */

// A bad model fails on EVERY attempt (every auto-sync tick, every generation), so
// without de-dup the user would get a wall of identical sticky toasts. Keyed by the
// message (which embeds the model id + upstream reason) — a different model warns again.
const _notified = new Set();

/**
 * @param {unknown} err
 * @returns {boolean} true if this is a configuration failure.
 */
export function isInvalidModelConfigError(err) {
    return err?.code === 'invalid_model_config';
}

/**
 * Show a sticky (non-auto-dismissing) error toast, once per distinct message.
 * timeOut:0 + extendedTimeOut:0 means the user must dismiss it — a background
 * auto-sync failure can't scroll past unnoticed like a 3-second toast would.
 * @param {string} message
 */
export function notifyInvalidModel(message) {
    if (!message || _notified.has(message)) return;
    _notified.add(message);
    try {
        toastr.error(message, 'VectFox — configuration invalid', {
            timeOut: 0,
            extendedTimeOut: 0,
        });
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

// ---------------------------------------------------------------------------
// Connection / URL error surfacing — sibling concern to model-config.
// ---------------------------------------------------------------------------
// When a configured endpoint URL is wrong (or the server behind it is down /
// unreachable), the call fails at the connection level. The summarizer, EventBase
// extractor, and agent-mode planner all route through ST's chat-completions proxy,
// so the failure comes back as a non-2xx body carrying the upstream socket error
// (ECONNREFUSED, getaddrinfo ENOTFOUND, "fetch failed", …) rather than a client
// fetch throw. We cannot distinguish "wrong URL" from "server is down" — both look
// identical — so the toast guides the user to check both.
const _connNotified = new Set();

/**
 * Heuristic: does this text/error look like a connection/URL failure (vs an HTTP
 * 4xx, auth, or model-config error, which are classified elsewhere)?
 * @param {unknown} detail - response body text, err.message, or an Error
 * @returns {boolean}
 */
export function isConnectionError(detail) {
    const s = (typeof detail === 'string' ? detail : (detail?.message || detail?.name || '')).toLowerCase();
    if (!s) return false;
    return /econnrefused|enotfound|eai_again|econnreset|etimedout|ehostunreach|enetunreach|epipe|getaddrinfo|fetch failed|failed to fetch|socket hang up|connection refused|refused to connect|could not connect|err_invalid_url|invalid url|err_connection|net::err|network ?error|connection error|dns lookup/i.test(s);
}

/**
 * Red, sticky, de-duped toast for a connection/URL failure. De-dup key is
 * context+url, so a different endpoint warns afresh but a persistently-failing
 * one doesn't spam on every retry / auto-sync tick.
 * @param {string} contextLabel - 'Summarizer' | 'EventBase' | 'Agent Mode' | 'Embedding'
 * @param {string} [url] - the endpoint the user configured (omit for fixed providers like OpenRouter)
 * @param {string} [detail] - short upstream error snippet for diagnosis
 */
export function notifyConnectionError(contextLabel, url, detail) {
    const key = `${contextLabel}|${url || ''}`;
    if (_connNotified.has(key)) return;
    _connNotified.add(key);
    const where = url ? ` at ${url}` : '';
    const why = detail ? ` (${String(detail).replace(/\s+/g, ' ').trim().slice(0, 160)})` : '';
    try {
        toastr.error(
            `Couldn't connect to the ${contextLabel} endpoint${where}. Check the URL is correct and the server is running — we can't proceed until this is fixed.${why}`,
            `VectFox — can't reach ${contextLabel}`,
            { timeOut: 0, extendedTimeOut: 0 },
        );
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

// ---------------------------------------------------------------------------
// Upstream rejection surfacing — the failures SillyTavern's proxy hides from us.
// ---------------------------------------------------------------------------
// ST's /api/backends/chat-completions/generate handler, on an upstream non-2xx,
// reads the provider's real error body, logs it to the SERVER console, and then
// replies with only `{ error: { message: <statusText> }, quota_error }` — and
// without calling response.status(), so Express sends it as HTTP **200**
// (src/endpoints/backends/chat-completions.js, the `else` branch after fetch).
//
// From the browser that is indistinguishable from a model that answered with
// nothing: a 200 whose choices[0].message.content is absent. VectFox used to
// classify it as kind:'empty' and log "returned empty response", so a wrong key,
// an unsupported parameter, or a rejected prompt all produced the same content-
// free per-window skip. That is the silent-model-failure class again (issue #11),
// arriving through a different door.
//
// We cannot recover the provider's actual sentence — ST forwards `statusText`
// only, which for a 400 is the literal string "Bad Request". So the toast says
// what we do know, and points at the one place the real reason exists.
const _upstreamNotified = new Set();

/**
 * Sticky, de-duped toast for "the provider rejected this request and ST only told
 * us the status text". Sticky because this class never self-heals: the same bad
 * key / unsupported parameter / invalid model fails identically on every window,
 * and an auto-dismissing toast during a long background extraction is exactly the
 * silence we are trying to remove. A warning because the caller carries on past it
 * and the user must act: red means a run stopped. A provider's own server error
 * asks nothing of the user, so postChatCompletion logs it without calling this.
 *
 * De-dup key is context + model + detail, so a different model or a different
 * upstream status warns afresh while a run of 200 failing windows warns once.
 *
 * @param {string} contextLabel - 'EventBase' | 'Summarizer' | 'Agent Mode' | 'Auto-Reformat'
 * @param {string} model - the model id that was requested
 * @param {string} detail - upstream status text ST forwarded (e.g. 'Bad Request')
 * @param {boolean} [isQuotaError] - ST's quota_error flag (429 + insufficient_quota)
 */
export function notifyUpstreamRejection(contextLabel, model, detail, isQuotaError = false) {
    const key = `${contextLabel}|${model || ''}|${detail || ''}|${isQuotaError}`;
    if (_upstreamNotified.has(key)) return;
    _upstreamNotified.add(key);

    const why = isQuotaError
        ? 'Your provider reports the account is out of quota — check billing/credits.'
        : 'Common causes: a parameter this model does not accept (see "Use max_completion_tokens", '
          + '"Send temperature" and "Turn off model thinking" in Core → LLM Summarization settings), '
          + 'a wrong API key, or a prompt the provider refused.';

    try {
        toastr.warning(
            `The provider rejected the ${contextLabel} request for model "${model}" (${detail}). ${why} `
            + `SillyTavern only forwards the status text to the browser — the provider's full error is in the `
            + `SillyTavern SERVER console ("Chat completion request error").`,
            `VectFox — ${contextLabel} request rejected`,
            { timeOut: 0, extendedTimeOut: 0 },
        );
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

// ---------------------------------------------------------------------------
// Retrieval failure surfacing — sibling concern to model-config and connection.
// ---------------------------------------------------------------------------
// A retrieval path that catches its own errors and returns an empty result set is
// indistinguishable, from the user's seat, from a corpus with nothing relevant in
// it: no toast, no error, the message just sends without the memory it should have
// had. That is what GitHub issue #11 reported — semantic lorebook activation went
// silent on one backend and there was nothing in the console at default log level
// to say why. Retrieval callers still degrade gracefully (a failed lookup must
// never break a generation), but the degradation is now announced.
const _retrievalNotified = new Set();

/**
 * De-duped error toast for "we could not retrieve from this source this turn".
 *
 * De-dup key is context + source + message, so a persistently-broken collection
 * warns once per session rather than on every single generation, while a
 * different collection or a different failure still gets through. Auto-dismissing
 * (unlike the model/connection toasts) because retrieval failures are often
 * transient — a restarted Qdrant or a slow embedder recovers on its own, and a
 * sticky toast per turn would be worse than the silence it replaces.
 *
 * @param {string} contextLabel - 'Lorebook' | 'EventBase' | 'Chat memory' | …
 * @param {string} sourceName - human-readable collection / book name
 * @param {unknown} detail - the caught error (or a message string)
 */
export function notifyRetrievalFailure(contextLabel, sourceName, detail) {
    const message = (typeof detail === 'string' ? detail : detail?.message || String(detail || 'unknown error'))
        .replace(/\s+/g, ' ')
        .trim();
    const key = `${contextLabel}|${sourceName}|${message}`;
    if (_retrievalNotified.has(key)) return;
    _retrievalNotified.add(key);
    try {
        toastr.error(
            `Couldn't search "${sourceName}" this turn, so none of its content was injected. `
            // 320, not 200: a timeout now carries an explanation of the likely
            // cause (see src/features/vector-backend/bounded-retrieval.js) and 200 clipped it mid-sentence.
            + `The message still sent. Details: ${message.slice(0, 320)}`,
            `VectFox — ${contextLabel} retrieval failed`,
            { timeOut: 12000, extendedTimeOut: 4000 },
        );
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

/**
 * Forget prior retrieval-failure notifications.
 * @internal Resets module state between tests.
 */
export function resetRetrievalFailureNotifications() {
    _retrievalNotified.clear();
}

/**
 * Yellow toast for a turn whose memory search failed, a query embedding included after
 * its retry, so the turn's memory is missing or incomplete. The player can regenerate,
 * so it is a warning, and it is not de-duped: every turn that loses memory says so.
 *
 * @param {string} detail - the failed search's error message
 * @param {boolean} hasInjectedMemory - whether the turn still injected what the other searches found
 */
export function notifyMemoryNotInjected(detail, hasInjectedMemory) {
    const message = String(detail || 'unknown error').replace(/\s+/g, ' ').trim();
    const outcome = hasInjectedMemory ? 'so this turn\'s memory is incomplete' : 'so no memory was injected this turn';
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(
        `A memory search failed, ${outcome}. `
        + `Regenerate to try again. Details: ${message.slice(0, 320)}`,
        'VectFox — memory not injected correctly',
        { timeOut: 30000, extendedTimeOut: 10000 },
    );
}

// ---------------------------------------------------------------------------
// "Feature is on but nothing it needs is active" surfacing.
// ---------------------------------------------------------------------------
// Distinct from notifyRetrievalFailure: there, a query ran and broke. Here, no
// query was ever issued because every candidate collection was filtered out
// before the search — disabled, owned by another persona, or not activated by
// any trigger/condition/lock. The user has the feature switched ON and vectorized
// content sitting in the registry, so from their seat it simply does nothing, and
// the per-collection reason is a log.trace nobody has enabled. Same silent class
// as GitHub issue #11, different cause.
const _noActiveSourceNotified = new Set();

/**
 * De-duped warning toast for "this feature is enabled, you have vectorized
 * content, and none of it is eligible this turn — here is why".
 *
 * De-dup key is context + scope + reason, where scope is normally the current
 * chat id. Per-chat rather than per-session on purpose: the most common cause is
 * a lock that points at a different chat/character, which is exactly what the
 * user changes when they switch chats. A session-wide de-dup would show it once
 * in the chat where it did not matter and stay quiet in the one where it did.
 *
 * @param {string} contextLabel - 'Semantic Lorebook' | 'ChunkBase' | …
 * @param {string} scopeKey - current chat id (or any per-context de-dup key)
 * @param {string} reason - human-readable breakdown of why nothing qualified
 */
export function notifyNoActiveCollections(contextLabel, scopeKey, reason) {
    const key = `${contextLabel}|${scopeKey || ''}|${reason}`;
    if (_noActiveSourceNotified.has(key)) return;
    _noActiveSourceNotified.add(key);
    try {
        toastr.warning(
            `${contextLabel} is ON but nothing was searched this turn. ${reason} `
            + `Open the Database Browser to lock the collection to this chat or character.`,
            `VectFox — ${contextLabel} inactive`,
            { timeOut: 15000, extendedTimeOut: 5000 },
        );
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

/**
 * Forget prior no-active-source notifications.
 * @internal Resets module state between tests.
 */
export function resetNoActiveCollectionsNotifications() {
    _noActiveSourceNotified.clear();
}
