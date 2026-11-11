/**
 * Whether the Similharity server plugin is installed, what its /health reported, and how it stands against the oldest
 * version VectFox works with: one /health probe per session, shared by every caller, so a plugin-less install sends
 * one request (one 404 in the console) however many features ask. Diagnostics asks for a fresh one on each run.
 *
 * The oldest version is `similharity_minimum_version` in VectFox's manifest.json, its one place: a release that needs
 * a newer plugin changes that field and nothing else. It is a floor, not an exact match, so a plugin-only fix never
 * nags users who are up to date. It never drops below 3.4.0, the first plugin that sends a llama.cpp, KoboldCPP or
 * Custom profile's key by its ID (tests/similharity-version-floor.test.js).
 */

import { getRequestHeaders } from '../sillytavern/requests.js';
import { log } from '../sillytavern/log.js';
import { loadExtensionManifest } from './extension-manifest.js';

// `pluginAvailable` is the settled result, null until a probe settles. `pluginProbeInFlight` is the promise of a
// probe that has started but not finished, so concurrent callers share one request. `probeGeneration` moves on each
// reset, so a probe started before it cannot write its result after it.
let pluginAvailable = null;
let pluginProbeInFlight = null;
let probeGeneration = 0;
// What the settled probe read from /health, or null when it got no reply it could read; `probeFailure` then says why.
// /health always carries the version; the /version route is missing from older plugins, which a version check is for.
let pluginHealth = null;
let probeFailure = '';
// The oldest Similharity VectFox works with, from manifest.json; null until read, or when it cannot be.
let requiredVersion = null;

const VERSION_FORMAT = /^\d+\.\d+\.\d+$/;

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

/** Read the oldest Similharity VectFox works with from manifest.json, once. */
async function readRequiredVersion() {
    if (requiredVersion) return;
    try {
        const field = (await loadExtensionManifest())?.similharity_minimum_version;
        if (typeof field === 'string' && VERSION_FORMAT.test(field)) {
            requiredVersion = field;
        } else {
            log.error(`VectFox: manifest.json's similharity_minimum_version is ${JSON.stringify(field)}, not a version such as 3.4.0.`);
        }
    } catch (error) {
        log.error('VectFox: could not read manifest.json for the Similharity version VectFox needs:', error);
    }
}

/** One /health request, written to the probe's state unless a reset came after it started. */
async function probeHealth(generation) {
    let health = null;
    let failure = '';
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (response.ok) {
            const data = await response.json();
            health = {
                status: typeof data.status === 'string' ? data.status : '',
                version: typeof data.version === 'string' && data.version ? data.version : null,
                backends: Array.isArray(data.backends) ? data.backends.map(String) : [],
            };
            if (health.status !== 'ok') failure = `it reports status "${health.status}"`;
        } else {
            failure = `HTTP ${response.status}`;
        }
    } catch (error) {
        log.warn('VectFox: plugin availability probe failed:', error);
        failure = error?.message || String(error);
    }
    const isFound = health?.status === 'ok';
    if (generation === probeGeneration) {
        pluginHealth = health;
        probeFailure = failure;
        pluginAvailable = isFound;
        log.lifecycle(`VectFox: Plugin ${isFound ? 'detected' : 'not found'} (v${health?.version || 'unknown'})`);
    }
    return isFound;
}

/**
 * Whether the Similharity plugin is installed. The first call probes /health and reads the version VectFox needs;
 * later calls get the settled result, and calls made while a probe runs share it.
 * @returns {Promise<boolean>}
 */
export async function checkPluginAvailable() {
    if (pluginAvailable !== null) return pluginAvailable;
    if (pluginProbeInFlight) return pluginProbeInFlight;

    const generation = probeGeneration;
    const probe = (async () => {
        try {
            const [isFound] = await Promise.all([probeHealth(generation), readRequiredVersion()]);
            return isFound;
        } finally {
            if (pluginProbeInFlight === probe) pluginProbeInFlight = null;
        }
    })();
    pluginProbeInFlight = probe;
    return probe;
}

/**
 * Probe /health again now, for a caller that must see the plugin as it is rather than as it was at startup, as
 * Diagnostics does on each run. Every other caller then reads the new result.
 * @returns {Promise<boolean>}
 */
export function refreshPluginProbe() {
    resetPluginAvailableCache();
    return checkPluginAvailable();
}

/**
 * Whether the last settled probe found the plugin; false while no probe has settled.
 * @returns {boolean}
 */
export function isPluginDetected() {
    return pluginAvailable === true;
}

/**
 * Forgets the probe result, so the next checkPluginAvailable() probes /health again. A probe already in flight can
 * no longer hand its result to a caller that asks after the reset. The version VectFox needs is kept.
 */
export function resetPluginAvailableCache() {
    probeGeneration += 1;
    pluginAvailable = null;
    pluginHealth = null;
    probeFailure = '';
    pluginProbeInFlight = null;
}

/**
 * What the last settled probe read from /health: whether it found a working plugin, the status, version and vector
 * backends it reported, and, when it found none, why.
 * @returns {{isFound: boolean, status: string|null, version: string|null, backends: string[], failure: string}}
 */
export function getPluginProbe() {
    return {
        isFound: pluginAvailable === true,
        status: pluginHealth?.status ?? null,
        version: pluginHealth?.version ?? null,
        backends: pluginHealth?.backends ?? [],
        failure: probeFailure,
    };
}

/**
 * How the plugin found stands against the oldest version VectFox works with, once checkPluginAvailable() has
 * settled. isCurrent only when a plugin was found, reported its version, and that version is not older than the
 * floor manifest.json gives; `requiredVersion` is null when that floor could not be read.
 * @returns {{isFound: boolean, version: string|null, requiredVersion: string|null, isCurrent: boolean}}
 */
export function similharityStanding() {
    const isFound = pluginAvailable === true;
    const version = pluginHealth?.version ?? null;
    return {
        isFound,
        version,
        requiredVersion,
        isCurrent: isFound && Boolean(version) && Boolean(requiredVersion) && !isSimilharityVersionBehind(version, requiredVersion),
    };
}
