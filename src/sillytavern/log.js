/**
 * ============================================================================
 * VectFox CENTRAL LOG HELPER
 * ============================================================================
 * One verbosity dimension + orthogonal per-domain deep-dives.
 *
 * Spec: InternalProject/Vectfox/plans/executed/logging-levels-and-classification.md
 *
 * Levels are chosen by CALL FREQUENCY, not by topic:
 *   error / warn          — always on, never gated
 *   lifecycle             — O(1)/run major state changes  (verbosity >= 1)
 *   verbose               — per-batch / per-window timing  (verbosity >= 2)
 *   trace                 — per-item detail                (verbosity >= 3)
 *   domain(name, level)   — subsystem deep-dive, independent of verbosity
 *
 * Defaults are static, and the per-feature debug flags in the settings (`eventbase_debug_logging`,
 * `debug_vectorizing_log`, ...) are not read here. Use the Diagnostics UI (verbosity dropdown + domain
 * checkboxes) instead.
 * ============================================================================
 */

import { extension_settings } from '../../../../../extensions.js';

const VERBOSITY_LEVELS = { off: 0, lifecycle: 1, verbose: 2, trace: 3 };

function getVerbosity() {
    const setting = extension_settings?.vectfox?.debug_verbosity;
    return VERBOSITY_LEVELS[setting] ?? VERBOSITY_LEVELS.off;
}

function getDomain(name) {
    return extension_settings?.vectfox?.debug_domain?.[name] === true;
}

export const log = {
    /**
     * Predicate for guarding EXPENSIVE log-argument construction (loops, big
     * JSON.stringify, preview building). For a plain one-liner just call the
     * level method directly — it self-gates. Example:
     *   if (log.enabled('trace')) { for (...) log.trace(buildPreview(...)); }
     * @param {('lifecycle'|'verbose'|'trace')} level
     */
    enabled: (level) => getVerbosity() >= (VERBOSITY_LEVELS[level] ?? Infinity),
    /** True when the given domain deep-dive toggle is on. */
    domainEnabled: (name) => getDomain(name),
    /** Exceptions, data-integrity violations, blocking config. Always on. */
    error: (...args) => console.error(...args),
    /** Recovered-from anomaly (hedge fired, retry succeeded, fallback used). Always on. */
    warn: (...args) => console.warn(...args),
    /** O(1)/run major state changes. Gated: verbosity >= lifecycle. */
    lifecycle: (...args) => { if (getVerbosity() >= VERBOSITY_LEVELS.lifecycle) console.log(...args); },
    /** Per-batch / per-window timing. NEVER per-item. Gated: verbosity >= verbose. */
    verbose: (...args) => { if (getVerbosity() >= VERBOSITY_LEVELS.verbose) console.log(...args); },
    /** Per-item detail (embed previews, progress-bar pixels). Gated: verbosity >= trace. */
    trace: (...args) => { if (getVerbosity() >= VERBOSITY_LEVELS.trace) console.log(...args); },
    /**
     * Subsystem deep-dive. Fires only when the matching `debug_domain.<name>`
     * toggle is on, regardless of the verbosity dropdown.
     * @param {string} name  a key of the `debug_domain` setting (defaults in index.js)
     * @param {string} level internal level — metadata for future sub-gating; ignored for now
     */
    domain: (name, level, ...args) => {
        if (!getDomain(name)) return;
        console.log(...args);
    },
};
