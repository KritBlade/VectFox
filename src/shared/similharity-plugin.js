/**
 * Whether the Similharity server plugin is installed, and which version: one /health probe per session, shared by
 * every caller, so a plugin-less install sends one request (one 404 in the console) however many features ask. Also
 * the oldest version VectFox works with.
 */

import { getRequestHeaders } from '../sillytavern/requests.js';
import { log } from '../sillytavern/log.js';

// `pluginAvailable` is the settled result, null until a probe settles. `pluginProbeInFlight` is the promise of a
// probe that has started but not finished, so concurrent callers share one request.
let pluginAvailable = null;
let pluginProbeInFlight = null;
// The version the same /health probe reported, or null with no plugin or no version field. /health always carries
// it; the /version route is missing from older plugins, which are the ones a version check is for.
let pluginVersion = null;

/**
 * The oldest Similharity VectFox works with. A floor, not an exact match: VectFox works with newer builds, so a
 * plugin-only fix must not nag users who are up to date. Raise it only when VectFox needs a newer plugin, for a
 * feature it calls or a fix that protects data. 3.3.5 is the first plugin that deletes nothing on a vector size
 * change, and 3.4.0 the first that embeds on a llama.cpp, KoboldCPP or Custom profile with the profile's key.
 */
export const SIMILHARITY_MIN_VERSION = '3.4.0';

/** How the user updates an old plugin, for every message that says it is old. */
export const PLUGIN_UPDATE_INSTRUCTIONS = 'Restart SillyTavern so it can auto-update the server plugin. '
    + 'If that does not help, the plugin was installed from a ZIP and cannot auto-update: delete '
    + 'SillyTavern/plugins/similharity and reinstall it with git clone (see the VectFox README).';

/**
 * Whether a plugin version is older than a floor, compared number by number, so 3.10.0 is newer than 3.3.5.
 *
 * @param {string} version - The installed plugin's version
 * @param {string} minimum - The floor
 * @returns {boolean} true when `version` is strictly older than `minimum`
 */
export function isSimilharityVersionBehind(version, minimum) {
    const parse = text => String(text).split('.').map(part => parseInt(part, 10) || 0);
    const installed = parse(version), required = parse(minimum);
    for (let place = 0; place < Math.max(installed.length, required.length); place++) {
        const difference = (installed[place] || 0) - (required[place] || 0);
        if (difference !== 0) return difference < 0;
    }
    return false;
}

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
