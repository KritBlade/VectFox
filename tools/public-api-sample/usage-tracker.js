/**
 * A usage tracker for VectFox's public API: the worked example of the VectFox's own LLM calls section of VectFox's
 * developer page (Doc/public-api.md). It files each model request as it goes out, VectFox's by the mark on its signal
 * and every other one as the chat's, and counts VectFox's calls from `vectfox_llm_call_finished`, which comes after
 * each call with its tokens. The mark is there only while the user has it switched on, on VectFox's PublicAPI page,
 * so the event is the full count of VectFox's calls. It uses only the VectFox object and SillyTavern's eventSource.
 */

const VECTFOX_MARK = Symbol.for('vectfox.internal-request');

/** SillyTavern's routes for a chat or text completion: what a request to a model goes to. */
const MODEL_REQUEST_PATH = /\/api\/backends\/(chat|text)-completions\/generate$/;

/**
 * What the tracker has counted: VectFox's requests by the label of their mark, the chat's model requests, and
 * VectFox's calls as the event reports them.
 */
const tally = { vectfoxRequests: [], chatModelRequests: 0, vectfoxCalls: [] };

/**
 * The path a fetch goes to.
 * @param {RequestInfo|URL} input
 * @returns {string}
 */
function pathOf(input) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url ?? '';
    return new URL(url, location.origin).pathname;
}

/**
 * Starts the tracker: it wraps `fetch` to file each request as it goes out, and listens to VectFox's calls. It works
 * whether its extension loads before VectFox or after it.
 */
export function startUsageTracker() {
    const originalFetch = window.fetch;
    window.fetch = function (input, init, ...rest) {
        const mark = init?.signal?.[VECTFOX_MARK];
        if (mark) tally.vectfoxRequests.push({ label: mark.label, path: pathOf(input) });
        else if (MODEL_REQUEST_PATH.test(pathOf(input))) tally.chatModelRequests++;
        return originalFetch.call(this, input, init, ...rest);
    };
    const start = (VectFox) => {
        VectFox.on('vectfox_llm_call_finished', ({ feature, connection, model, outcome, usage }) => {
            tally.vectfoxCalls.push({ feature, connection, model, outcome, totalTokens: usage?.totalTokens ?? null });
        });
    };
    if (globalThis.VectFox?.isReady()) {
        start(globalThis.VectFox);
    } else {
        SillyTavern.getContext().eventSource.on('vectfox_ready', () => start(globalThis.VectFox));
    }
}

/**
 * What the tracker has counted so far, a copy.
 * @returns {{vectfoxRequests: Array<{label: string, path: string}>, chatModelRequests: number,
 *   vectfoxCalls: Array<{feature: string, connection: string, model: string|null, outcome: string,
 *   totalTokens: number|null}>}}
 */
export function usageTrackerTally() {
    return structuredClone(tally);
}
