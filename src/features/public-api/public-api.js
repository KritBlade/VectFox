/**
 * Publishes the `VectFox` object other extensions call (§4 of InternalProject/Vectfox/plans/vectfox-public-api.md) and
 * emits its events on SillyTavern's eventSource. src/index.js publishes the object when it is evaluated, so it exists
 * before VectFox's initialization ends, and announces readiness when that ends. VectFox never awaits its own events:
 * SillyTavern's emit awaits each listener in turn, so a listener that never resolves would hold VectFox up.
 */
import { eventSource } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { loadExtensionManifest } from '../../shared/extension-manifest.js';
import { PUBLIC_EVENTS, buildPublicApi, createReadiness, isPublicEventName, readyPayload } from './public-api-core.js';

const readiness = createReadiness();

/** The manifest's version, once start-up has read it. */
let extensionVersion = null;

/**
 * Stops calling a handler for an event.
 * @param {string} name - The event's name
 * @param {Function} handler - The handler `on` was given
 */
function off(name, handler) {
    eventSource.removeListener(name, handler);
}

/**
 * Calls a handler each time VectFox emits an event. An event this VectFox does not emit subscribes nothing and says so
 * in the console, as a consumer written for a newer API may ask for it.
 * @param {string} name - The event's name, such as `vectfox_ready`
 * @param {Function} handler - Called with the event's payload
 * @returns {() => void} Its own unsubscribe
 * @throws {TypeError} When the handler is not a function
 */
function on(name, handler) {
    if (typeof handler !== 'function') throw new TypeError(`VectFox.on('${name}'): the handler is not a function`);
    if (!isPublicEventName(name)) {
        log.warn(`VectFox public API: on() was given '${name}', which this VectFox does not emit, so nothing is subscribed. It emits: ${Object.values(PUBLIC_EVENTS).join(', ')}`);
        return () => {};
    }
    eventSource.on(name, handler);
    return () => off(name, handler);
}

/**
 * Emits one of VectFox's events without waiting for its listeners.
 * @param {string} name
 * @param {object} payload
 */
function emitWithoutWaiting(name, payload) {
    eventSource.emit(name, payload).catch(error => log.warn(`VectFox public API: emitting ${name} failed:`, error));
}

/**
 * Sets `globalThis.VectFox`. Called once, when src/index.js is evaluated.
 */
export function publishPublicApi() {
    if (globalThis.VectFox) log.warn('VectFox public API: globalThis.VectFox was already set, by another copy of VectFox loaded in this page; this copy replaces it');
    globalThis.VectFox = buildPublicApi({ readiness, readExtensionVersion: () => extensionVersion, on, off });
}

/**
 * Marks VectFox ready once its initialization has ended, and emits `vectfox_ready` once. Reads the manifest's version
 * first, so `extensionVersion` is set when a consumer hears of readiness; a manifest that cannot be read leaves it
 * null.
 * @returns {Promise<void>}
 */
export async function announcePublicApiReady() {
    try {
        extensionVersion = (await loadExtensionManifest()).version ?? null;
    } catch (error) {
        log.warn('VectFox public API: manifest.json could not be read, so VectFox.extensionVersion stays null:', error);
    }
    if (!readiness.markReady()) return;
    emitWithoutWaiting(PUBLIC_EVENTS.ready, readyPayload());
}
