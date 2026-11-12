// Two guards on a request that carries a key. Node's fetch quotes in its error a header value with a line break
// inside, so such a key would reach the error text and the logs: a header holding a line break or another control
// character is refused first, by its name only. And Node keeps a custom key header, such as Qdrant's `api-key`, when it
// follows a redirect to another host: fetchOnSameHost follows a redirect only while it stays on the host the request
// was sent to.

// Header values may hold a tab, and nothing else below 0x20, nor DEL. Node first trims tabs, spaces and line breaks
// from both ends of a value, as the Fetch standard says, and sends what is left, so only what is left is checked.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const EDGE_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/**
 * Throw, naming the header but never its value, when a header value holds a control character Node would not trim.
 *
 * @param {Record<string, unknown>} headers
 * @param {string} what - Names the request in the message, such as "Qdrant"
 */
export function assertSendableHeaders(headers, what) {
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (CONTROL_CHARACTER.test(String(value).replace(EDGE_WHITESPACE, ''))) {
            throw new Error(`${what}: the ${name} header holds a line break or another control character, so nothing was sent. Save the key again in SillyTavern.`);
        }
    }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * fetch, following a redirect only on the host the request was sent to, with the method and body fetch itself keeps.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 * @throws {Error} Naming only the other host's origin, for a redirect away from the host
 */
export async function fetchOnSameHost(fetchImpl, url, init = {}) {
    const startHost = new URL(url).hostname.toLowerCase();
    let current = url;
    let request = { ...init, redirect: 'manual' };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetchImpl(current, request);
        const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.('location') : null;
        if (!location) return response;
        const next = new URL(location, current);
        if (next.hostname.toLowerCase() !== startHost) {
            throw new Error(`the server answered with a redirect to ${next.origin}, another host, so the request was not sent there. If that is the right address, enter it in VectFox.`);
        }
        // EXPECTED: the redirect's own body is never read, and a body that cannot be cancelled has nothing to free.
        response.body?.cancel?.().catch(() => {});
        // As fetch does: 303 turns any method but HEAD into GET, and 301 and 302 turn POST into GET, both without a body.
        const method = String(request.method ?? 'GET').toUpperCase();
        if ((response.status === 303 && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST')) {
            request = { ...request, method: 'GET', body: undefined };
        }
        current = next.href;
    }
    throw new Error(`the server redirected more than ${MAX_REDIRECTS} times, so the request stopped.`);
}
