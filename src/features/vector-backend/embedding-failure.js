/**
 * What a failed embedding means for the person who pressed Save, read from the error an insert throws: a provider that
 * is busy or slow, which passes, so saving again usually works; a server VectFox could not reach; a setup the provider
 * or the collection refuses, which fails the same way until it is fixed; or another error from the embedding server.
 * A hedge that ran out of attempts is read by its last error, and one whose attempts never came back counts as slow.
 */

import { isConnectionError, isInvalidModelConfigError } from '../../shared/model-config-notifier.js';

const BUSY_SIGNAL = /\b429\b|rate.?limit|too many requests|overloaded|over capacity|\bbusy\b|\b50[234]\b|bad gateway|service unavailable|gateway time-?out|timed? ?out|timeout/i;

const ADVICE = Object.freeze({
    busy: 'The embedding provider is busy or slow right now, which usually passes. Press Save again in a moment: the edit is still in the form.',
    unreachable: 'VectFox could not reach the embedding server. Check that it is running and that its URL is right, then press Save again.',
    setup: 'The embedding setup was refused, and saving again fails the same way until it is fixed.',
    server: 'The embedding server returned an error that is not the busy kind. If Save fails again, check the provider\'s status or the SillyTavern server console.',
});

/**
 * @param {unknown} error - What the insert threw
 * @returns {{kind: 'busy'|'unreachable'|'setup'|'server', advice: string, detail: string}}
 */
export function describeEmbeddingFailure(error) {
    const detail = String(error?.message ?? error ?? 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (isInvalidModelConfigError(error)) return { kind: 'setup', advice: ADVICE.setup, detail };
    const lastError = error?.isHedgeFatal ? (detail.match(/last error: (.*)$/)?.[1] ?? '') : detail;
    const isSlow = error?.name === 'TimeoutError' || (error?.isHedgeFatal === true && !lastError);
    let kind = 'server';
    if (isSlow || BUSY_SIGNAL.test(lastError)) kind = 'busy';
    else if (isConnectionError(lastError)) kind = 'unreachable';
    return { kind, advice: ADVICE[kind], detail };
}
