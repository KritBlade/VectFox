/**
 * ============================================================================
 * MODEL-CONFIG ERROR NOTIFIER
 * ============================================================================
 * Shared UX for "the configured model is no longer valid" failures — the errors
 * tagged with `code === 'invalid_model_config'` by core/model-http-errors.js.
 *
 * Every model path can hit this (EventBase extraction, summarizer, agent mode,
 * embedding), so the user-facing toast and the auto-sync pause live here once
 * instead of being re-implemented at each catch site.
 * ============================================================================
 */

// A bad model fails on EVERY attempt (every auto-sync tick, every generation), so
// without de-dup the user would get a wall of identical sticky toasts. Keyed by the
// message (which embeds the model id + upstream reason) — a different model warns again.
const _notified = new Set();

/**
 * @param {unknown} err
 * @returns {boolean} true if this is a "model no longer valid" failure.
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
        toastr.error(message, 'VectFox — model no longer valid', {
            timeOut: 0,
            extendedTimeOut: 0,
        });
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

/** Forget prior notifications so a corrected-then-broken-again model can warn afresh. */
export function resetInvalidModelNotifications() {
    _notified.clear();
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

/** Forget prior connection notifications (parity with resetInvalidModelNotifications). */
export function resetConnectionNotifications() {
    _connNotified.clear();
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
            // cause (see core/bounded-retrieval.js) and 200 clipped it mid-sentence.
            + `The message still sent. Details: ${message.slice(0, 320)}`,
            `VectFox — ${contextLabel} retrieval failed`,
            { timeOut: 12000, extendedTimeOut: 4000 },
        );
    } catch (_) { /* toastr unavailable (e.g. unit tests) */ }
}

/** Forget prior retrieval notifications (parity with the notifiers above). */
export function resetRetrievalFailureNotifications() {
    _retrievalNotified.clear();
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

/** Forget prior no-active-source notifications (parity with the notifiers above). */
export function resetNoActiveCollectionsNotifications() {
    _noActiveSourceNotified.clear();
}

/**
 * Turn OFF auto-sync for the current chat's EventBase collection(s) so a bad model
 * stops silently re-failing on every message. The user re-enables it after fixing
 * the model. Dispatches `vectfox:collections-updated` so the UI checkbox updates.
 *
 * @param {string} chatUUID
 * @param {string} backend - registry backend, i.e. getRegistryBackend(settings.vector_backend)
 */
export async function pauseAutoSyncForChat(chatUUID, backend) {
    if (!chatUUID || !backend) return;
    const { findEventBaseCollectionsForChat } = await import('./eventbase-store.js');
    const { setCollectionAutoSync } = await import('./collection-metadata.js');

    let paused = 0;
    for (const { registryKey } of findEventBaseCollectionsForChat(chatUUID, backend)) {
        setCollectionAutoSync(registryKey, false);
        paused++;
    }
    if (paused > 0) {
        try { document.dispatchEvent(new CustomEvent('vectfox:collections-updated')); } catch (_) {}
    }
}
