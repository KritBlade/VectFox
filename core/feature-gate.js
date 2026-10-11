/**
 * ============================================================================
 * VectFox MASTER SWITCH
 * ============================================================================
 * Single source of truth for the global on/off toggle. VectFox does its
 * automatic work only when this returns true: prompt injection (chunks,
 * EventBase, Summarizer, Lorebook WI), ghosting, EventBase auto-sync, the
 * backend/network startup, and background refreshes that call the backend or
 * load lorebooks. Switching OFF empties every VectFox prompt block at once;
 * switching ON re-runs the startup and refresh work that was skipped.
 *
 * Default ON: the flag is treated as enabled unless it is *explicitly* set to
 * false, so existing installs (which have no `enabled` key) keep working
 * untouched. Every runtime gate must read this helper, never `settings.enabled`
 * inline, so the default-ON semantics live in exactly one place.
 *
 * Not gated: explicit, user-initiated actions (manual vectorization, Database
 * Browser, the dry-run query tester, the settings panel) stay usable so the user
 * can still inspect and manage data while VectFox is switched off. Settings
 * migrations and UI refreshes that read only local state keep running too.
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';

/**
 * @param {object} [settings] - extension_settings.vectfox (defaults to the live store)
 * @returns {boolean} true when VectFox's automatic runtime work is enabled
 */
export function isVectFoxEnabled(settings) {
    const store = settings || extension_settings?.vectfox;
    return store?.enabled !== false;
}
