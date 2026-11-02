// retry.js — re-runs a failing async operation with exponential backoff.

/**
 * Run `operation`; when it throws, wait and run it again, multiplying the wait by `backoffFactor`
 * after each failure (never above `maxDelay`), until a run succeeds or `maxAttempts` runs have
 * failed. The last error is then thrown.
 *
 * @template T
 * @param {() => Promise<T>} operation - the async work to run
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] - total runs, the first one included
 * @param {number} [options.delay=1000] - wait before the second run, in ms
 * @param {number} [options.maxDelay=30000] - longest wait between two runs, in ms
 * @param {number} [options.backoffFactor=2] - multiplier applied to the wait after each failure
 * @param {(attempt: number, error: *) => void} [options.onRetry] - called before each wait with
 *   the failed run's number and its error
 * @param {(error: *) => boolean} [options.shouldRetry] - return false to throw that error at once
 * @returns {Promise<T>} the result of the first run that succeeds
 */
export async function retry(operation, options = {}) {
    const {
        maxAttempts = 3,
        delay = 1000,
        maxDelay = 30000,
        backoffFactor = 2,
        onRetry = null,
        shouldRetry = () => true,
    } = options;

    let lastError;
    let currentDelay = delay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts || !shouldRetry(error)) {
                throw error;
            }

            if (onRetry) {
                onRetry(attempt, error);
            }

            await new Promise(resolve => setTimeout(resolve, currentDelay));
            currentDelay = Math.min(currentDelay * backoffFactor, maxDelay);
        }
    }

    throw lastError;
}
