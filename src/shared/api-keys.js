/**
 * ============================================================================
 * VectFox API KEY HELPERS
 * ============================================================================
 *
 * Single source of truth for resolving API keys at runtime, and the
 * one-shot migration that consolidates legacy per-feature key fields
 * into a single key per provider.
 *
 * Keys live in slots SillyTavern already round-trips, and every call that
 * needs the real key goes through a SillyTavern proxy that reads it
 * server-side. VectFox-specific slots (e.g. `'summarize_openrouter_api_key'`)
 * do not work: ST's `writeSecret(customSlot, value)` accepts the write, but
 * `readSecretState` never surfaces custom slots in the client's
 * `secret_state`, so such a key is write-only. Per provider:
 *
 *   - OpenRouter (one key for embedding + summarize + agent):
 *     Stored in ST's well-known `SECRET_KEYS.OPENROUTER` slot. ST's
 *     `getSecretState` returns this slot as an array of `{value, label,
 *     active, id}` entries — but `value` is MASKED, seven stars and the
 *     key's last 3 characters in 1.19.0, unless `allowKeysExposure: true` is
 *     set in `config.yaml` (default false). So `getOpenRouterApiKey()`
 *     returns the masked string when a key is configured, and empty string
 *     otherwise. That's a presence indicator: never show it, since it holds
 *     the key's end, and DON'T send it as a Bearer token; you'll get 401.
 *
 *     Embedding works because it goes through ST's `/api/vector/insert`
 *     (or the Similharity plugin's `/api/plugins/similharity/chunks/insert`)
 *     proxy, which reads the real key server-side via
 *     `readSecret(SECRET_KEYS.OPENROUTER)`.
 *
 *     Summarize, EventBase, and Agentic chat-completion paths apply the
 *     same pattern: POST to `/api/backends/chat-completions/generate` with
 *     `chat_completion_source: 'openrouter'` — ST's server reads the real
 *     key and forwards to OpenRouter. All three VectFox UI inputs
 *     (Embedding / EventBase model / AgentMode) write to the same slot
 *     via `writeSecret`, so setting the key in any of them is shared.
 *
 *   - vLLM-style "Custom OpenAI-compatible" (one key for embedding +
 *     summarize + agent):
 *     VectFox's vLLM key inputs write two slots. Chat-side requests read
 *     `SECRET_KEYS.CUSTOM` (`api_key_custom`): they route through
 *     `/api/backends/chat-completions/generate` with
 *     `chat_completion_source: 'custom'` and `custom_url:
 *     settings.vllm_url` in the body, and ST's server reads the real key
 *     via `readSecret(SECRET_KEYS.CUSTOM)` and forwards to the
 *     user-specified endpoint. Embedding reads `SECRET_KEYS.VLLM`
 *     (`api_key_vllm`, ST's vLLM Text Completion slot) through ST's
 *     `/api/vector/insert` server-side header injection. Both slots are
 *     masked client-side like OpenRouter's: getCustomApiKey() returns the
 *     masked string for presence checks only.
 *
 *   - Qdrant API key (Cloud auth):
 *     Stored in ST's secret_state under the CUSTOM slot name `api_key_qdrant`
 *     (not in ST's SECRET_KEYS enum — writeSecret/readSecret accept any
 *     string key; only getSecretState's read-to-client path filters by enum).
 *     Server-side: the Similharity plugin reads it via
 *     `readSecret(req.user.directories, 'api_key_qdrant', null)` and uses
 *     the real value to authenticate to Qdrant Cloud. Client-side:
 *     `secret_state.api_key_qdrant` is undefined (enum filter), so the UI
 *     presence indicator round-trips via the plugin's
 *     `/qdrant/key-status` endpoint instead (see `fetchQdrantApiKeyPresence`).
 *
 *   - Ollama:
 *     No API key field. ST has no SECRET_KEYS.OLLAMA and no
 *     getOllamaHeaders, so its Ollama vector path never sends an
 *     Authorization header. Users who need authed Ollama (rare — Ollama is
 *     typically LAN no-auth) configure auth at their reverse proxy.
 *
 * migrateLegacyApiKeys() documents what the one-shot migration moves and
 * deletes.
 *
 * @author Kritblade
 * ============================================================================
 */

import { extension_settings, saveSettings } from '../sillytavern/settings.js';
import { SECRET_KEYS, secret_state, writeSecret, readSecretState } from '../sillytavern/secrets.js';
import { extensionNames } from '../sillytavern/installed-extensions.js';
import { log } from '../sillytavern/log.js';
import { checkPluginAvailable } from './similharity-plugin.js';

// Settings nothing reads any more that can hold a key in plaintext: the roots VectHare and VectHare+ kept their
// settings in before the rename to VectFox, with key fields such as summarize_openrouter_api_key, and the
// credentials of the retired BananaBread and Milvus backends.
const RETIRED_SETTINGS_ROOTS = ['vecthare', 'vecthareplus'];
const RETIRED_CREDENTIAL_FIELDS = ['bananabread_api_key', 'milvus_token', 'milvus_password'];

// SillyTavern's slot for the Qdrant Cloud key, a custom name as SECRET_KEYS has no Qdrant entry.
const QDRANT_KEY_SLOT = 'api_key_qdrant';

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Extract the actual key value from `secret_state[slot]`.
 *
 * `secret_state` schema varies by slot — observed in production:
 * array-of-secrets shape for `SECRET_KEYS.OPENROUTER` (multiple keys
 * with `.active`/`.value` per entry), plus simpler string or object
 * shapes for other slots. Defensive against all three.
 *
 * Only call this for slots ST natively round-trips (the `SECRET_KEYS`
 * constants). Custom slot names don't survive `readSecretState`.
 *
 * @param {string} slot
 * @returns {string} trimmed value, or empty string
 */
function _readSecretValue(slot) {
    if (!slot) return '';
    const stored = secret_state?.[slot];
    if (!stored) return '';
    if (typeof stored === 'string') return stored.trim();
    if (Array.isArray(stored) && stored.length > 0) {
        const active = stored.find(s => s?.active) || stored[0];
        if (typeof active?.value === 'string') return active.value.trim();
    }
    if (typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value.trim();
    }
    return '';
}

// ─── Public readers ─────────────────────────────────────────────────────

/**
 * Resolve the OpenRouter API key — RETURNS A MASKED VALUE, not the real key.
 *
 * ST's `getSecretState` masks all values for non-EXPORTABLE_KEYS (OpenRouter
 * is not exportable), so what we get back is something like "*******abcd".
 * Use this for:
 *   - Presence checks (empty string ⇒ no key configured)
 *   - UI placeholder masking
 *
 * DO NOT pass the return value as a Bearer token — you'll get 401. Instead,
 * route OpenRouter requests through ST's `/api/backends/chat-completions/generate`
 * proxy with `chat_completion_source: 'openrouter'`; the server reads the
 * real key via `readSecret(SECRET_KEYS.OPENROUTER)` and forwards correctly.
 * `postChatCompletion` in `src/features/llm-provider/llm-provider-call.js` is that call.
 *
 * @returns {string} masked value (presence indicator) or empty string
 */
export function getOpenRouterApiKey() {
    return _readSecretValue(SECRET_KEYS.OPENROUTER);
}

/**
 * Resolve the Custom OpenAI-compatible API key — the slot VectFox's
 * vLLM-style chat calls read. RETURNS A MASKED VALUE,
 * not the real key — same as `getOpenRouterApiKey`. Use for presence
 * checks and placeholder masking only; chat-side calls route through
 * ST's `/api/backends/chat-completions/generate` proxy with
 * `chat_completion_source: 'custom'` where the server reads the real
 * key via `readSecret(SECRET_KEYS.CUSTOM)`.
 *
 * @returns {string} masked value (presence indicator) or empty string
 */
export function getCustomApiKey() {
    return _readSecretValue(SECRET_KEYS.CUSTOM);
}

/**
 * Async presence fetch for the Qdrant API key via the Similharity plugin's
 * `/qdrant/key-status` endpoint. Keeps only whether a key is saved: plugins
 * before 3.4.4 answer `masked` with the key's last 4 characters, which is
 * never read. Returns `{set: false}` when the plugin is unreachable so callers
 * can degrade gracefully.
 *
 * @returns {Promise<{set: boolean}>}
 */
export async function fetchQdrantApiKeyPresence() {
    try {
        // No plugin → no /qdrant/key-status endpoint. Skip the request so the
        // browser doesn't log a red 404 on plugin-less (fully supported) setups.
        if (!(await checkPluginAvailable())) {
            return { set: false };
        }
        const response = await fetch('/api/plugins/similharity/qdrant/key-status', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            return { set: false };
        }
        const data = await response.json();
        return { set: !!data?.set };
    } catch (err) {
        // The caller treats this as "presence unknown" and does not render the key indicator.
        log.warn('VectFox: Qdrant key-status check failed:', err);
        return { set: false };
    }
}

// ─── One-shot legacy field migration ────────────────────────────────────

/**
 * Save a key moved out of settings.json in a SillyTavern slot. SillyTavern's writeSecret never throws: it answers the
 * saved key's ID, or null when it did not save the key. Only null means not saved, as in the key boxes.
 *
 * @param {string} slot
 * @param {string} value - The key, trimmed
 * @returns {Promise<boolean>} whether SillyTavern saved it
 */
async function isSavedInSillyTavern(slot, value) {
    const savedId = await writeSecret(slot, value);
    if (savedId !== null) return true;
    log.warn(`[VectFox migrate] SillyTavern did not save the key moved out of settings.json in ${slot}`);
    return false;
}

/**
 * Move legacy plaintext key fields out of `extension_settings.vectfox` into
 * SillyTavern's secret store. Runs at every start from `index.js`.
 *
 * Every legacy key field is deleted whether or not SillyTavern saves its key,
 * as VectFox never keeps a key in settings.json. One red toast names each key
 * SillyTavern did not save and asks the user to paste it again.
 *
 * OpenRouter: legacy fields `summarize_openrouter_api_key`,
 * `agentic_retrieval_openrouter_api_key` and `openrouter_api_key`. The first
 * non-empty value goes to `SECRET_KEYS.OPENROUTER` only if that slot is empty,
 * so a key the user set through ST's own UI is kept.
 *
 * vLLM: legacy fields `summarize_vllm_api_key`,
 * `agentic_retrieval_vllm_api_key` and `vllm_api_key`. The first non-empty
 * value goes to `SECRET_KEYS.CUSTOM` (chat side) and `SECRET_KEYS.VLLM`
 * (embedding side), each only if empty.
 *
 * qdrant_api_key: goes to SillyTavern's slot 'api_key_qdrant', which
 * Similharity reads on the server.
 *
 * ollama_api_key: deleted, as ST does not authenticate Ollama.
 *
 * Idempotent: on subsequent runs the legacy fields are already absent
 * and the function is a no-op.
 *
 * @returns {Promise<{summary: string}>}
 */
export async function migrateLegacyApiKeys() {
    const vf = extension_settings?.vectfox;
    if (!vf) {
        log.warn('[VectFox migrate] extension_settings.vectfox not initialized — skipping');
        return { summary: 'not-initialized' };
    }

    // ─── Diagnostic snapshot: what's in vf at migration start? ───
    // Helps debug the "settings.json has plaintext keys but migration says
    // nothing to migrate" scenario — if a field shows up here but isn't
    // listed in the post-migration "deleted" log, something is filtering it
    // out before migration runs (defaults merge, etc.).
    const apiKeyFieldsBefore = Object.keys(vf).filter(k => k.includes('api_key'));
    log.lifecycle(`[VectFox migrate] START. vf has ${apiKeyFieldsBefore.length} *api_key* field(s):`, apiKeyFieldsBefore);
    if (apiKeyFieldsBefore.length > 0) {
        // Show length only (never log the actual key value)
        log.lifecycle(`[VectFox migrate] *api_key* field details:`, apiKeyFieldsBefore.map(k => {
            const v = vf[k];
            return {
                field: k,
                hasOwnProperty: Object.prototype.hasOwnProperty.call(vf, k),
                type: typeof v,
                length: typeof v === 'string' ? v.length : null,
                isEmpty: typeof v === 'string' && v.trim().length === 0,
            };
        }));
    }

    let mutated = false;
    const moves = []; // human-readable log entries
    const unsavedKeyNames = []; // providers whose key SillyTavern did not save, for the toast

    // ─── OpenRouter consolidation ───
    const orLegacy = [
        'summarize_openrouter_api_key',
        'agentic_retrieval_openrouter_api_key',
        'openrouter_api_key',
    ];
    let orValue = '';
    for (const field of orLegacy) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        const v = vf[field];
        if (!orValue && typeof v === 'string' && v.trim().length > 0) {
            orValue = v.trim();
            moves.push(`OpenRouter source: ${field} (len=${orValue.length})`);
        }
        delete vf[field];
        mutated = true;
    }
    if (orValue) {
        const existing = _readSecretValue(SECRET_KEYS.OPENROUTER);
        if (existing) {
            moves.push(`OpenRouter → SECRET_KEYS.OPENROUTER already has a key, keeping that one (didn't clobber)`);
        } else if (await isSavedInSillyTavern(SECRET_KEYS.OPENROUTER, orValue)) {
            moves.push(`OpenRouter → wrote to SECRET_KEYS.OPENROUTER (was empty)`);
        } else {
            moves.push(`OpenRouter → SillyTavern did not save the key in SECRET_KEYS.OPENROUTER, deleted from settings.json all the same`);
            unsavedKeyNames.push('OpenRouter');
        }
    }

    // ─── vLLM → SECRET_KEYS.CUSTOM + SECRET_KEYS.VLLM drain ───
    // Chat-side vLLM calls route through ST's chat-completions proxy with
    // `chat_completion_source: 'custom'`, which reads `SECRET_KEYS.CUSTOM`
    // server-side; embedding reads `SECRET_KEYS.VLLM`. Drain a plaintext key
    // from `settings.vllm_api_key` or its two sibling legacy fields (first
    // non-empty wins) into both slots and delete all three fields.
    // Don't-clobber rule: a slot that already holds a value keeps it — the
    // user's main chat may use Custom OpenAI-compatible with a different key,
    // which a write would hijack.
    const vllmLegacy = [
        'summarize_vllm_api_key',
        'agentic_retrieval_vllm_api_key',
        'vllm_api_key',
    ];
    let vllmValue = '';
    for (const field of vllmLegacy) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        const v = vf[field];
        if (!vllmValue && typeof v === 'string' && v.trim().length > 0) {
            vllmValue = v.trim();
            moves.push(`vLLM source: ${field} (len=${vllmValue.length})`);
        }
        delete vf[field];
        mutated = true;
    }
    if (vllmValue) {
        // Dual-write: the chat-side proxy reads SECRET_KEYS.CUSTOM and the
        // embedding-side proxy reads SECRET_KEYS.VLLM, so one key serves both.
        // Each write is don't-clobber, so an existing ST main-chat config (Custom
        // source) or ST vLLM Text Completion config keeps its own value.
        let isVllmKeySaved = true;
        const existingCustom = _readSecretValue(SECRET_KEYS.CUSTOM);
        if (existingCustom) {
            const msg = `vLLM → SECRET_KEYS.CUSTOM already has a value (likely from ST main-chat config) — kept that one for chat-side. To override, clear ST's Custom OpenAI-compatible key and re-enter via VectFox UI.`;
            log.warn(`[VectFox migrate] ${msg}`);
            moves.push(msg);
        } else if (await isSavedInSillyTavern(SECRET_KEYS.CUSTOM, vllmValue)) {
            moves.push(`vLLM → wrote to SECRET_KEYS.CUSTOM (was empty)`);
        } else {
            moves.push(`vLLM → SillyTavern did not save the key in SECRET_KEYS.CUSTOM, deleted from settings.json all the same`);
            isVllmKeySaved = false;
        }

        const existingVllm = _readSecretValue(SECRET_KEYS.VLLM);
        if (existingVllm) {
            const msg = `vLLM → SECRET_KEYS.VLLM already has a value (from ST Text Completion → vLLM config) — kept that one for embedding-side.`;
            log.warn(`[VectFox migrate] ${msg}`);
            moves.push(msg);
        } else if (await isSavedInSillyTavern(SECRET_KEYS.VLLM, vllmValue)) {
            moves.push(`vLLM → wrote to SECRET_KEYS.VLLM (was empty, used by embedding path)`);
        } else {
            moves.push(`vLLM → SillyTavern did not save the key in SECRET_KEYS.VLLM, deleted from settings.json all the same`);
            isVllmKeySaved = false;
        }
        if (!isVllmKeySaved) unsavedKeyNames.push('vLLM');
    }

    // ─── Qdrant API key → 'api_key_qdrant' (custom slot) ───
    // The Qdrant Cloud key belongs in SillyTavern's slot 'api_key_qdrant': the client sends `apiKey: null` to the
    // Similharity plugin, which reads the slot server-side with readSecret. SillyTavern writes the slot itself, so
    // the move needs no plugin, and a plugin installed later reads the key there. The slot name is custom because
    // SECRET_KEYS has no Qdrant entry, and the client-side secret_state hides non-enum slots, so nothing here can
    // see a key the slot already holds. The moved key becomes the one in use, as it was the key VectFox sent.
    if (Object.prototype.hasOwnProperty.call(vf, 'qdrant_api_key')) {
        const qdrantValue = typeof vf.qdrant_api_key === 'string' ? vf.qdrant_api_key.trim() : '';
        delete vf.qdrant_api_key;
        mutated = true;
        if (!qdrantValue) {
            moves.push(`Qdrant → removed empty plaintext qdrant_api_key from settings.json`);
        } else if (await isSavedInSillyTavern(QDRANT_KEY_SLOT, qdrantValue)) {
            moves.push(`Qdrant → wrote to secret_state.${QDRANT_KEY_SLOT} (len=${qdrantValue.length})`);
        } else {
            moves.push(`Qdrant → SillyTavern did not save the key in ${QDRANT_KEY_SLOT}, deleted from settings.json all the same`);
            unsavedKeyNames.push('Qdrant');
        }
    }

    // ─── Ollama plaintext drain (no destination — ST has no ollama auth) ───
    // ST has no SECRET_KEYS.OLLAMA and no getOllamaHeaders branch in
    // additional-headers.js. ST's ollama-vectors.js calls
    // setAdditionalHeadersByType(headers, TEXTGEN_TYPES.OLLAMA, ...) which
    // is a silent no-op for ollama — no Authorization header is ever sent
    // to the upstream Ollama endpoint. So whatever VectFox previously
    // stored in settings.ollama_api_key was dead weight on BOTH sides.
    // Migration just deletes the field. No probe gate needed — there's
    // nothing to write anywhere.
    if (Object.prototype.hasOwnProperty.call(vf, 'ollama_api_key')) {
        const hadValue = typeof vf.ollama_api_key === 'string' && vf.ollama_api_key.trim().length > 0;
        delete vf.ollama_api_key;
        mutated = true;
        moves.push(hadValue
            ? `Ollama → removed plaintext ollama_api_key from settings.json (ST does not authenticate ollama; field was a no-op)`
            : `Ollama → removed empty plaintext ollama_api_key from settings.json`);
    }

    // ─── Retired settings that can hold a key: deleted unread, logged by name only ───
    // A VectHare extension still installed owns its root, so the roots stay while one is.
    const isVectHareInstalled = extensionNames.some(name => /vecthare/i.test(name));
    for (const root of RETIRED_SETTINGS_ROOTS) {
        if (!Object.prototype.hasOwnProperty.call(extension_settings, root)) continue;
        if (isVectHareInstalled) {
            moves.push(`Kept extension_settings.${root}: a VectHare extension is installed and reads it`);
            continue;
        }
        delete extension_settings[root];
        mutated = true;
        moves.push(`Removed extension_settings.${root}, where VectHare kept its settings before the rename, as it can hold plaintext keys`);
    }
    for (const field of RETIRED_CREDENTIAL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        delete vf[field];
        mutated = true;
        moves.push(`Removed ${field}, a credential of a retired backend`);
    }

    if (mutated) {
        log.lifecycle(`[VectFox migrate] mutated=true → calling await saveSettings() (synchronous)`);
        // Synchronous save, not debounced: a reload before a debounced save
        // flushes would leave the deleted legacy fields in settings.json
        // although extension_settings.vectfox is clean in memory.
        await saveSettings();
        log.lifecycle(`[VectFox migrate] saveSettings() returned. Disk should be in sync with memory now.`);
    } else {
        log.lifecycle(`[VectFox migrate] mutated=false → skipping saveSettings(). If settings.json has stale fields, they will NOT be cleared by this migration run (in-memory state was already clean).`);
    }

    // Diagnostic: what's left in vf after migration?
    const apiKeyFieldsAfter = Object.keys(vf).filter(k => k.includes('api_key'));
    log.lifecycle(`[VectFox migrate] END. vf has ${apiKeyFieldsAfter.length} *api_key* field(s) remaining:`, apiKeyFieldsAfter);

    if (moves.length > 0) {
        log.lifecycle(`[VectFox migrate] Migration complete:\n  - ${moves.join('\n  - ')}`);
        // Refresh in-memory secret_state if we wrote OpenRouter or CUSTOM
        try { await readSecretState(); } catch (error) { log.warn('[VectFox migrate] secret_state refresh failed:', error); }
    } else {
        log.lifecycle('[VectFox migrate] No legacy API-key fields found — nothing to migrate');
    }

    if (unsavedKeyNames.length > 0) {
        const isOneKey = unsavedKeyNames.length === 1;
        const names = new Intl.ListFormat('en', { type: 'conjunction' }).format(unsavedKeyNames);
        toastr.error(
            isOneKey
                ? `SillyTavern did not save your ${names} key when VectFox moved it out of settings.json. Paste it again in VectFox's settings.`
                : `SillyTavern did not save your ${names} keys when VectFox moved them out of settings.json. Paste them again in VectFox's settings.`,
            isOneKey ? 'Key not saved' : 'Keys not saved',
            { timeOut: 0, extendedTimeOut: 0 },
        );
    }

    return { summary: moves.length > 0 ? moves.join('; ') : 'nothing-to-migrate' };
}
