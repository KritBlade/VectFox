/**
 * The public API's pure parts: its version, the events it emits, the groups it serves, readiness and the shape of the
 * `VectFox` object (§4 of InternalProject/Vectfox/plans/vectfox-public-api.md). No host imports: public-api.js
 * publishes the object and emits the events.
 */

/**
 * The API's version, semver. A minor version only adds a method, event, field or reason; a removed, renamed or changed
 * name raises the major version at once, and no code keeps the old name working. A reader compares the major only.
 */
export const PUBLIC_API_VERSION = '1.0.0';

/** The events VectFox emits on SillyTavern's eventSource, by name. */
export const PUBLIC_EVENTS = Object.freeze({
    ready: 'vectfox_ready',
});

/** The groups this build serves, so a consumer checks once instead of probing each method. */
export const PUBLIC_API_CAPABILITIES = Object.freeze(['events']);

/**
 * Whether VectFox emits an event of this name.
 * @param {string} name
 * @returns {boolean}
 */
export function isPublicEventName(name) {
    return Object.values(PUBLIC_EVENTS).includes(name);
}

/**
 * The payload of `vectfox_ready`, frozen so no listener changes what the next one reads.
 * @returns {Readonly<{apiVersion: string}>}
 */
export function readyPayload() {
    return Object.freeze({ apiVersion: PUBLIC_API_VERSION });
}

/**
 * Readiness: false until VectFox's initialization ends, then true for good. `whenReady()` gives one promise, which
 * resolves then; `markReady()` says whether this call made VectFox ready, so it is announced once.
 * @returns {{isReady: () => boolean, whenReady: () => Promise<void>, markReady: () => boolean}}
 */
export function createReadiness() {
    let isReadyNow = false;
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    return {
        isReady: () => isReadyNow,
        whenReady: () => readyPromise,
        markReady: () => {
            if (isReadyNow) return false;
            isReadyNow = true;
            resolveReady();
            return true;
        },
    };
}

/**
 * The frozen `VectFox` object (§4.1). `extensionVersion` is read when asked: the manifest's version once start-up has
 * read it, null before then or when it could not be read.
 * @param {object} parts
 * @param {ReturnType<typeof createReadiness>} parts.readiness
 * @param {() => (string|null)} parts.readExtensionVersion
 * @param {(name: string, handler: Function) => (() => void)} parts.on - Subscribes; returns its own unsubscribe
 * @param {(name: string, handler: Function) => void} parts.off
 * @returns {Readonly<object>}
 */
export function buildPublicApi({ readiness, readExtensionVersion, on, off }) {
    return Object.freeze({
        apiVersion: PUBLIC_API_VERSION,
        get extensionVersion() {
            return readExtensionVersion();
        },
        capabilities: PUBLIC_API_CAPABILITIES,
        isReady: readiness.isReady,
        whenReady: readiness.whenReady,
        on,
        off,
    });
}
