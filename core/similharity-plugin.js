/**
 * Whether the Similharity server plugin is installed, and which version: one /health probe per session, shared by
 * every caller, so a plugin-less install sends one request (one 404 in the console) however many features ask.
 */

import { getRequestHeaders } from '../../../../../script.js';
import { log } from './log.js';

// `pluginAvailable` is the settled result, null until a probe settles. `pluginProbeInFlight` is the promise of a
// probe that has started but not finished, so concurrent callers share one request.
let pluginAvailable = null;
let pluginProbeInFlight = null;
// The version the same /health probe reported, or null with no plugin or no version field. /health always carries
// it; the /version route is missing from older plugins, which are the ones a version check is for.
let pluginVersion = null;

/**
 * Whether the Similharity plugin is installed. The first call probes /health; later calls get the settled result,
 * and calls made while a probe runs share it.
 * @returns {Promise<boolean>}
 */
export async function checkPluginAvailable() {
    if (pluginAvailable !== null) {
        return pluginAvailable;
    }
    if (pluginProbeInFlight) {
        return pluginProbeInFlight;
    }

    pluginProbeInFlight = (async () => {
        try {
            const response = await fetch('/api/plugins/similharity/health', {
                method: 'GET',
                headers: getRequestHeaders()
            });

            if (response.ok) {
                const data = await response.json();
                pluginAvailable = data.status === 'ok';
                pluginVersion = typeof data.version === 'string' && data.version ? data.version : null;
                log.lifecycle(`VectFox: Plugin ${pluginAvailable ? 'detected' : 'not found'} (v${pluginVersion || 'unknown'})`);
            } else {
                pluginAvailable = false;
            }
        } catch (error) {
            log.warn('VectFox: plugin availability probe failed:', error);
            pluginAvailable = false;
        } finally {
            pluginProbeInFlight = null;
        }

        return pluginAvailable;
    })();

    return pluginProbeInFlight;
}

/**
 * Whether the last settled probe found the plugin; false while no probe has settled.
 * @returns {boolean}
 */
export function isPluginDetected() {
    return pluginAvailable === true;
}

/**
 * Forgets the probe result, so the next checkPluginAvailable() probes /health again. Also drops a probe in flight,
 * so one started before the reset cannot hand its result to a caller that asked after it.
 */
export function resetPluginAvailableCache() {
    pluginAvailable = null;
    pluginVersion = null;
    pluginProbeInFlight = null;
}

/**
 * The version the plugin reported on its last /health probe, or null with no plugin or no version field. Read this
 * rather than the /version route, which older plugins lack. Meaningful once checkPluginAvailable() has settled.
 * @returns {string|null}
 */
export function getDetectedPluginVersion() {
    return pluginVersion;
}
