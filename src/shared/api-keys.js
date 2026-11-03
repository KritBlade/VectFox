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
 *     active, id}` entries — but `value` is MASKED (e.g. "*******abcd")
 *     unless `allowKeysExposure: true` is set in `config.yaml` (default
 *     false). So `getOpenRouterApiKey()` returns the masked string when
 *     a key is configured, and empty string otherwise. That's a presence
 *     indicator — DON'T send it as a Bearer token; you'll get 401.
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
 *     (Embedding / LLM Summarization / AgentMode) write to the same slot
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
import { log } from '../sillytavern/log.js';
import { checkPluginAvailable } from './similharity-plugin.js';

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
 * Read a plaintext Qdrant API key left in settings (`settings.qdrant_api_key`).
 *
 * The key lives in ST's secret_state under the custom slot `api_key_qdrant`.
 * That slot is NOT in ST's `SECRET_KEYS` enum, so `getSecretState` (and
 * therefore client-side `secret_state.api_key_qdrant`) does NOT surface it.
 * Server-side `readSecret(directories, 'api_key_qdrant')` DOES read it — that's
 * how the Similharity plugin auth-flows the real key value into Qdrant.
 *
 * For client-side presence checks (UI placeholder, "is the key set"), call
 * `fetchQdrantApiKeyPresence()` below — it round-trips to the plugin's
 * `/qdrant/key-status` endpoint, which returns `{set, masked}`.
 *
 * This reader returns the plaintext field until migrateLegacyApiKeys() drains
 * it into the slot, and '' after; the UI and the backends then rely on the
 * async presence fetch and the server-side read respectively.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} the plaintext value, or '' once migrated
 */
export function getQdrantApiKey(settings) {
    const v = settings?.qdrant_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

/**
 * Async presence fetch for the Qdrant API key via the Similharity plugin's
 * `/qdrant/key-status` endpoint. Returns `{set: false, masked: ''}` when the
 * plugin is unreachable so callers can degrade gracefully.
 *
 * @returns {Promise<{set: boolean, masked: string}>}
 */
export async function fetchQdrantApiKeyPresence() {
    try {
        // No plugin → no /qdrant/key-status endpoint. Skip the request so the
        // browser doesn't log a red 404 on plugin-less (fully supported) setups.
        if (!(await checkPluginAvailable())) {
            return { set: false, masked: '' };
        }
        const response = await fetch('/api/plugins/similharity/qdrant/key-status', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            return { set: false, masked: '' };
        }
        const data = await response.json();
        return {
            set: !!data?.set,
            masked: typeof data?.masked === 'string' ? data.masked : '',
        };
    } catch (err) {
        // The caller treats this as "presence unknown" and does not render the key indicator.
        log.warn('VectFox: Qdrant key-status check failed:', err);
        return { set: false, masked: '' };
    }
}

// ─── One-shot legacy field migration ────────────────────────────────────

/**
 * Move legacy plaintext key fields out of `extension_settings.vectfox` into
 * SillyTavern's secret store. Runs once at init from `index.js`.
 *
 * OpenRouter — legacy fields `summarize_openrouter_api_key`,
 * `agentic_retrieval_openrouter_api_key` and `openrouter_api_key`: the first
 * non-empty value goes to `SECRET_KEYS.OPENROUTER` ONLY IF that slot is empty
 * (a value the user set through ST's own UI is kept); all three fields are
 * deleted.
 *
 * vLLM — legacy fields `summarize_vllm_api_key`,
 * `agentic_retrieval_vllm_api_key` and `vllm_api_key`: the first non-empty
 * value goes to `SECRET_KEYS.CUSTOM` (chat side) and `SECRET_KEYS.VLLM`
 * (embedding side), each only if empty; all three fields are deleted.
 *
 * qdrant_api_key: drained to secret_state custom slot 'api_key_qdrant'
 * (gated on Similharity plugin probe — see Qdrant drain block below).
 *
 * ollama_api_key: deleted (no destination — ST does not authenticate Ollama).
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
        if (!existing) {
            try {
                await writeSecret(SECRET_KEYS.OPENROUTER, orValue);
                moves.push(`OpenRouter → wrote to SECRET_KEYS.OPENROUTER (was empty)`);
            } catch (err) {
                log.warn('[VectFox migrate] writeSecret(SECRET_KEYS.OPENROUTER) failed:', err?.message || err);
                moves.push(`OpenRouter → writeSecret FAILED, key not migrated`);
            }
        } else {
            moves.push(`OpenRouter → SECRET_KEYS.OPENROUTER already has a key, keeping that one (didn't clobber)`);
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
        const existingCustom = _readSecretValue(SECRET_KEYS.CUSTOM);
        if (!existingCustom) {
            try {
                await writeSecret(SECRET_KEYS.CUSTOM, vllmValue);
                moves.push(`vLLM → wrote to SECRET_KEYS.CUSTOM (was empty)`);
            } catch (err) {
                log.warn('[VectFox migrate] writeSecret(SECRET_KEYS.CUSTOM) failed:', err?.message || err);
                moves.push(`vLLM → writeSecret(SECRET_KEYS.CUSTOM) FAILED, chat-side key not migrated — re-enter via VectFox UI`);
            }
        } else {
            const msg = `vLLM → SECRET_KEYS.CUSTOM already has a value (likely from ST main-chat config) — kept that one for chat-side. To override, clear ST's Custom OpenAI-compatible key and re-enter via VectFox UI.`;
            log.warn(`[VectFox migrate] ${msg}`);
            moves.push(msg);
        }

        const existingVllm = _readSecretValue(SECRET_KEYS.VLLM);
        if (!existingVllm) {
            try {
                await writeSecret(SECRET_KEYS.VLLM, vllmValue);
                moves.push(`vLLM → wrote to SECRET_KEYS.VLLM (was empty, used by embedding path)`);
            } catch (err) {
                log.warn('[VectFox migrate] writeSecret(SECRET_KEYS.VLLM) failed:', err?.message || err);
                moves.push(`vLLM → writeSecret(SECRET_KEYS.VLLM) FAILED, embedding-side key not migrated — configure via ST's Text Completion → vLLM UI`);
            }
        } else {
            const msg = `vLLM → SECRET_KEYS.VLLM already has a value (from ST Text Completion → vLLM config) — kept that one for embedding-side.`;
            log.warn(`[VectFox migrate] ${msg}`);
            moves.push(msg);
        }
    }

    // ─── Qdrant API key → 'api_key_qdrant' (custom slot) drain ───
    // The Qdrant Cloud key belongs in SillyTavern's secret_state slot 'api_key_qdrant': the client sends
    // `apiKey: null` to the Similharity plugin, which reads the slot server-side with readSecret. The
    // slot name is custom because SECRET_KEYS has no Qdrant entry; writeSecret accepts any name, but the
    // client-side secret_state hides non-enum slots, so the UI checks presence through the plugin's
    // /qdrant/key-status endpoint (fetchQdrantApiKeyPresence above).
    //
    // ⚠️ The drain probes /qdrant/key-status first. A Similharity plugin without that endpoint cannot
    // read the slot, so writing the key there and deleting settings.qdrant_api_key would break Qdrant
    // Cloud auth. The probe gates both the write and the delete; without the endpoint the drain does
    // nothing and runs again on the next load.
    const QDRANT_SLOT = 'api_key_qdrant';
    let pluginSupportsQdrantSecretSlot = false;
    // Only probe the plugin if there's actually a legacy plaintext field to
    // drain. On a fresh / no-plugin install there's nothing to migrate, so
    // pinging /qdrant/key-status just produces a misleading 404 warning.
    if (Object.prototype.hasOwnProperty.call(vf, 'qdrant_api_key')) {
        // First, the canonical plugin-presence check (session-cached /health
        // probe). This separates "no plugin installed at all" from "plugin
        // installed but without /qdrant/key-status" — the two cases that the
        // /qdrant/key-status 404 alone can't tell apart.
        let pluginUp = false;
        try {
            pluginUp = await checkPluginAvailable();
        } catch (err) {
            log.warn(`[VectFox migrate] Plugin availability check failed; skipping Qdrant key migration this run. Plaintext key in settings.json is PRESERVED. Reason:`, err?.message || err);
        }

        if (!pluginUp) {
            // No plugin → nothing can read secret_state.api_key_qdrant back, so
            // migrating would strand the key. Skip and keep the plaintext value.
            // NOT a warning: running without the plugin is a supported choice,
            // not an error. Gated/verbose so it stays out of the normal console
            // and only surfaces when someone is actually debugging migration.
            log.verbose(`[VectFox migrate] Similharity server plugin not installed — Qdrant key migration skipped (expected when running plugin-less). Plaintext qdrant_api_key in settings.json is PRESERVED.`);
        } else {
            // Plugin is up; now capability-probe the specific endpoint to confirm
            // it's new enough to support the secret_state Qdrant slot.
            try {
                const probe = await fetch('/api/plugins/similharity/qdrant/key-status', {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                });
                pluginSupportsQdrantSecretSlot = probe.ok;
                if (!probe.ok) {
                    log.warn(`[VectFox migrate] Plugin /qdrant/key-status probe returned ${probe.status} — the Similharity plugin predates that endpoint. Skipping Qdrant key migration this run; plaintext key in settings.json is PRESERVED. Update the Similharity plugin (cd plugins/similharity && git pull && restart ST) to enable secret_state storage.`);
                }
            } catch (err) {
                log.warn(`[VectFox migrate] Plugin /qdrant/key-status probe failed (plugin unreachable or without that endpoint). Skipping Qdrant key migration this run; plaintext key in settings.json is PRESERVED. Reason:`, err?.message || err);
            }
        }
    }

    if (pluginSupportsQdrantSecretSlot) {
        const rawQdrantPlaintext = vf?.qdrant_api_key;
        const hasPlaintextField = Object.prototype.hasOwnProperty.call(vf, 'qdrant_api_key');
        const hasPlaintextValue = typeof rawQdrantPlaintext === 'string' && rawQdrantPlaintext.trim().length > 0;
        let writeSucceeded = !hasPlaintextValue; // nothing to write = trivially succeeded

        if (hasPlaintextValue) {
            // No don't-clobber check: custom slot is undefined in client-side
            // secret_state, so we can't presence-check from JS. Plugin-side
            // this overwrites any prior value — acceptable for the first
            // migration pass (slot is brand new for VectFox users).
            try {
                await writeSecret(QDRANT_SLOT, rawQdrantPlaintext.trim());
                moves.push(`Qdrant → wrote to secret_state.${QDRANT_SLOT} (len=${rawQdrantPlaintext.trim().length})`);
                writeSucceeded = true;
            } catch (err) {
                log.warn('[VectFox migrate] writeSecret(api_key_qdrant) failed:', err?.message || err);
                moves.push(`Qdrant → writeSecret(${QDRANT_SLOT}) FAILED — plaintext key PRESERVED in settings.json for safety, retry next reload`);
                // writeSucceeded stays false → plaintext stays in settings.json
            }
        }

        // Delete the plaintext field ONLY after a confirmed-successful write
        // (or when there was no value to migrate). Never delete in a half-
        // migrated state — the user's only working key would be lost.
        if (writeSucceeded && hasPlaintextField) {
            delete vf.qdrant_api_key;
            mutated = true;
            if (!hasPlaintextValue) {
                moves.push(`Qdrant → removed empty plaintext qdrant_api_key from settings.json`);
            }
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

    return { summary: moves.length > 0 ? moves.join('; ') : 'nothing-to-migrate' };
}
