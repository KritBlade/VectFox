/**
 * ============================================================================
 * VectFox OFF-BOX STARTUP WORK
 * ============================================================================
 * Everything VectFox does at load time that reaches off the page — collection
 * discovery, the EventBase payload-index backfill, and the Similharity version
 * check. All of it talks to either Qdrant or the Similharity plugin.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN index.js
 *
 * The master switch (core/feature-gate.js) used to gate only the generation-time
 * paths, so a switched-off VectFox still probed the plugin, initialized Qdrant,
 * pushed config to Similharity and discovered collections on every page load —
 * plenty of console noise and network traffic for an extension the user had
 * turned off. Pulling this work into one named function lets index.js skip it
 * wholesale when disabled.
 *
 * It has to be RE-RUNNABLE, not merely skippable, because flipping the switch
 * back ON must give a working VectFox without a page reload. Two of these steps
 * do not self-heal on demand:
 *
 *   - ensureEventBaseIndexes() is one-shot-per-install, guarded by the persisted
 *     `eventbase_indexes_v1_backfilled` flag. Skip it and nothing retries until
 *     the next page load.
 *   - Collection discovery refreshes the registry that the Database Browser and
 *     cross-chat retrieval read. (The registry itself is persisted in
 *     settings.json, so it is stale rather than empty — but collections created
 *     while VectFox was off would be invisible.)
 *
 * Everything else is lazily initialized on first use and needs no help here:
 * Qdrant backend init and the Similharity config push both happen inside
 * QdrantBackend.initialize() via getBackend(), and plugin detection is cached by
 * checkPluginAvailable() on first call.
 *
 * It lives in core/ rather than index.js so ui/ui-manager.js can import it
 * directly. Importing index.js from a module index.js itself imports would be
 * circular, and dynamically importing the extension entry point risks
 * re-executing it under a different module URL.
 * ============================================================================
 */

import {
    discoverExistingCollections,
    pruneOrphanedEventBaseChatMaps,
    checkPluginAvailable,
    getDetectedPluginVersion,
} from './collection-loader.js';
import AsyncUtils from '../utils/async-utils.js';
import { log } from './log.js';

/**
 * D5: Cross-repo version floor — warn ONLY when the installed similharity is OLDER
 * than the minimum VectFox needs. This is a floor (>=) check, not an exact match:
 * VectFox stays forward-compatible with newer plugin builds, so a plugin-only bugfix
 * bump (e.g. 3.3.1 -> 3.3.2) must not nag users who are, in fact, up to date. Only
 * bump this when VectFox genuinely requires a newer plugin feature.
 */
const SIMILHARITY_MIN_VERSION = '3.3.1';

/**
 * @param {string} version installed plugin version
 * @param {string} minimum required floor
 * @returns {boolean} true when `version` is strictly older than `minimum`
 */
function isSimilharityVersionBehind(version, minimum) {
    const parse = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
    const installed = parse(version), required = parse(minimum);
    for (let i = 0; i < Math.max(installed.length, required.length); i++) {
        const difference = (installed[i] || 0) - (required[i] || 0);
        if (difference !== 0) return difference < 0;
    }
    return false; // equal → up to date
}

/** Shared tail for both outdated-plugin messages — how the user actually fixes it. */
const PLUGIN_UPDATE_INSTRUCTIONS = 'Restart SillyTavern so it can auto-update the server plugin. '
    + 'If that does not help, the plugin was installed from a ZIP and cannot auto-update: delete '
    + 'SillyTavern/plugins/similharity and reinstall it with git clone (see the VectFox README).';

/**
 * Warn (toast + console) when the installed Similharity plugin is below the floor.
 * Silent no-op when no plugin is installed — that is a supported setup, not an error.
 *
 * The version comes from the /health probe checkPluginAvailable() already made,
 * NOT from /api/plugins/similharity/version. That route only exists as of plugin
 * 2026-05-14, so older plugins 404'd it and this function returned silently on
 * `!response.ok` — going quiet in precisely the case it was written to catch.
 * GitHub issue #11 burned hours diagnosing a pre-2026-05-09 plugin whose server
 * console was emitting log lines from long-deleted code, with nothing anywhere
 * reporting the version. /health has carried `version` since the plugin's first
 * commit, so reading it there covers every build ever shipped — and costs no
 * extra request.
 */
export async function checkSimilharityVersion() {
    try {
        // No plugin installed is a supported setup, not something to warn about.
        if (!(await checkPluginAvailable())) return;

        const installedVersion = getDetectedPluginVersion();

        // Plugin answered /health but reported no version. Not expected from any
        // released build, so say something rather than assume it is fine — silence
        // here is the exact failure this function was rewritten to remove.
        if (!installedVersion) {
            log.warn(`[VectFox] similharity plugin responded without a version field — cannot verify it meets the v${SIMILHARITY_MIN_VERSION}+ floor. ${PLUGIN_UPDATE_INSTRUCTIONS}`);
            toastr.warning(
                `Could not determine your similharity plugin version, so VectFox cannot confirm it is current. ${PLUGIN_UPDATE_INSTRUCTIONS}`,
                'VectFox — plugin version unknown',
                { timeOut: 15000 },
            );
            return;
        }

        if (isSimilharityVersionBehind(installedVersion, SIMILHARITY_MIN_VERSION)) {
            log.warn(`[VectFox] similharity plugin outdated: need v${SIMILHARITY_MIN_VERSION}+, got v${installedVersion}. ${PLUGIN_UPDATE_INSTRUCTIONS}`);
            toastr.warning(
                `similharity plugin is outdated (need v${SIMILHARITY_MIN_VERSION}+, got v${installedVersion}). ${PLUGIN_UPDATE_INSTRUCTIONS}`,
                'VectFox',
                { timeOut: 15000 },
            );
        }
    } catch (_error) {
        // similharity not installed — separate problem, not our warning to raise
    }
}

/**
 * Shared join point so the load path and a fast master-switch toggle cannot stack
 * two concurrent discoveries. Cleared when the run settles.
 * @type {Promise<void>|null}
 */
let networkStartupInFlight = null;

/**
 * Run (or join) VectFox's off-box startup work.
 *
 * Callers: index.js on load when the master switch is ON, and ui/ui-manager.js when
 * the user turns the switch back ON.
 *
 * @param {object} startupSettings the live VectFox settings object
 * @returns {Promise<void>} resolves once discovery has settled. The index backfill and
 *   version check are deliberately fire-and-forget — same as when this was inlined in
 *   index.js, so a slow plugin cannot delay the rest of extension init.
 */
export function runNetworkStartup(startupSettings) {
    if (networkStartupInFlight) return networkStartupInFlight;

    networkStartupInFlight = (async () => {
        try {
            // VEC-34: Discover existing collections with retry.
            // Exponential backoff handles temporary backend unavailability.
            try {
                const collections = await AsyncUtils.retry(
                    () => discoverExistingCollections(startupSettings),
                    {
                        maxAttempts: 3,
                        delay: 2000,
                        maxDelay: 10000,
                        backoffFactor: 2,
                        onRetry: (attempt, error) => {
                            log.warn(`VectFox: Collection discovery attempt ${attempt} failed: ${error.message}. Retrying...`);
                        },
                    }
                );
                if (collections.length > 0) {
                    log.lifecycle(`VectFox: Discovered ${collections.length} existing collections`);
                }
                // Discovery succeeded → registry reflects reality. Sweep stale per-chat
                // EventBase settings (marker / last-window-size / tip) for chats whose
                // collection no longer exists. Skipped automatically on an empty registry.
                try {
                    await pruneOrphanedEventBaseChatMaps();
                } catch (pruneError) {
                    log.warn('VectFox: Orphan-sweep of per-chat EventBase settings failed (non-fatal):', pruneError?.message || pruneError);
                }
            } catch (error) {
                log.error('VectFox: Collection discovery failed after retries:', error.message);
                toastr.warning(
                    'Could not discover existing collections. Open Database Browser to refresh manually.',
                    'VectFox: Collection Discovery Failed',
                    { timeOut: 10000 }
                );
            }

            // Phase 1.5: backfill EventBase payload indexes on pre-existing Qdrant collections.
            if (startupSettings.vector_backend === 'qdrant') {
                import('./eventbase-store.js').then(({ ensureEventBaseIndexes }) => {
                    ensureEventBaseIndexes(startupSettings).catch(error => {
                        log.warn('[VectFox] EventBase index backfill failed:', error);
                    });
                }).catch(() => {});
            }

            checkSimilharityVersion();
        } finally {
            networkStartupInFlight = null;
        }
    })();

    return networkStartupInFlight;
}
