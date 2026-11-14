/**
 * ============================================================================
 * VECTFOX COLLECTION ID UTILITIES
 * ============================================================================
 * Single source of truth for all collection ID operations:
 * - Building/generating collection IDs
 * - Parsing collection IDs (all formats)
 * - Pattern matching for discovery
 *
 * ALL other files should import from here instead of rolling their own.
 * ============================================================================
 */

import { getContext, getCurrentChatId, chat_metadata } from '../sillytavern/chat.js';
import { log } from '../sillytavern/log.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Internal system collection IDs that must never participate in retrieval */
export const INTERNAL_COLLECTION_IDS = Object.freeze([
    '__vectfox_health_check__',
]);

/** All known collection prefixes for new collections. */
export const COLLECTION_PREFIXES = {
    // VectFox formats
    VECTFOX_LOREBOOK: 'vf_lorebook_',
    VECTFOX_CHARACTER: 'vf_character_',
    VECTFOX_DOCUMENT: 'vf_document_',
    VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_',
    VECTFOX_EVENTBASE: 'vf_eventbase_',
    // LoreBase's per-book passage index; no timestamp, unlike the old vf_lorebook_ collections.
    VECTFOX_LOREBASE: 'vf_lorebase_',
};

/** Collection types */
export const COLLECTION_TYPES = {
    CHAT: 'chat',
    LOREBOOK: 'lorebook',
    LOREBASE: 'lorebase',
    CHARACTER: 'character',
    DOCUMENT: 'document',
    ARCHIVE_EVENT: 'archive_event',
    FILE: 'file',
    URL: 'url',
    WIKI: 'wiki',
    YOUTUBE: 'youtube',
    UNKNOWN: 'unknown',
};

/** Collection scopes: `'chat'` or `'character'`, the two the Vectorize Content
 * modal offers (`UNKNOWN` marks unparseable IDs, which `getEffectiveScope` then
 * defaults to `'character'`). There is no global scope: `loadAllCollections`
 * (collection-loader.js) rewrites a stored `scope: 'global'` to `'character'`
 * on first read, so do not add a GLOBAL constant.
 */
export const COLLECTION_SCOPES = {
    CHARACTER: 'character',
    CHAT: 'chat',
    UNKNOWN: 'unknown',
};

/**
 * Backend labels that legitimately appear in collection IDs.
 * `vectra` is recognized for backwards compatibility — it's the internal
 * storage name. New IDs always use `standard` instead.
 * Exported so other helpers (parsers, remappers) share one truth.
 */
export const KNOWN_BACKEND_LABELS = Object.freeze(['standard', 'qdrant', 'vectra']);

/**
 * Normalize backend names used in IDs.
 * Keeps old alias "vectra" mapped to "standard" to avoid split IDs.
 * Exported (was private) so collection-export.js and any other caller stops
 * rolling its own version. See Doc/collection_helper.md (single-source-of-truth rule).
 *
 * @param {string} backend
 * @returns {string} normalized backend label suitable for use in a collection ID
 */
export function normalizeBackendForId(backend) {
    const b = String(backend || '').toLowerCase();
    if (!b) return '';
    return b === 'vectra' ? 'standard' : b;
}

/**
 * Parse the backend segment out of a VectFox collection ID.
 *
 * Collection IDs follow the shape:
 *   vf_{contentType}_{backend}_{handle}_{name}_{timestamp}
 *
 * Strips any registry-key prefix (`qdrant:`, `vectra:`, `standard:`) before
 * parsing so callers can pass either form.
 *
 * Returns null when the ID doesn't match any known VectFox shape — caller
 * should fall back to global settings in that case rather than guessing.
 *
 * @param {string} collectionId - bare or registry-keyed ID
 * @returns {string|null} backend label (`'qdrant'` | `'standard'`) or null
 */
export function getBackendFromCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') return null;
    // Strip the registry-key prefix if present (e.g. `qdrant:vf_lorebook_...`).
    const colonIdx = collectionId.indexOf(':');
    const bare = colonIdx > 0 ? collectionId.slice(colonIdx + 1) : collectionId;
    const match = bare.match(/^vf_[^_]+_([^_]+)_/);
    const backend = match?.[1];
    if (!backend) return null;
    return KNOWN_BACKEND_LABELS.includes(backend) ? normalizeBackendForId(backend) : null;
}

/**
 * Replace the backend segment in a collection ID so it matches a target backend.
 * Returns the original ID unchanged if:
 *   - The ID doesn't match a known VectFox prefix
 *   - There's no backend segment to replace (legacy format)
 *   - The current backend already equals the target (no-op)
 *
 * Used by the import path when converting an export from one backend to another
 * (qdrant↔standard). Without this, importing a qdrant export into the standard
 * backend would create a vectra folder named `vf_*_qdrant_*`, which then
 * confuses every other code path that parses the backend from the ID.
 *
 * @param {string} collectionId
 * @param {string} targetBackend - target backend label (e.g. 'qdrant', 'standard')
 * @returns {string} remapped ID (or original on no-op / unknown format)
 */
export function remapCollectionIdToBackend(collectionId, targetBackend) {
    const normalizedTarget = normalizeBackendForId(targetBackend);
    if (!normalizedTarget) return collectionId;

    for (const prefix of Object.values(COLLECTION_PREFIXES)) {
        if (!collectionId.startsWith(prefix)) continue;
        const rest = collectionId.slice(prefix.length); // e.g. 'standard_rabbit_chat_uuid'
        for (const srcBackend of KNOWN_BACKEND_LABELS) {
            if (rest.startsWith(srcBackend + '_')) {
                const normalizedSrc = normalizeBackendForId(srcBackend);
                return normalizedSrc === normalizedTarget
                    ? collectionId
                    : prefix + normalizedTarget + rest.slice(srcBackend.length);
            }
        }
        break; // matched prefix but no recognized backend segment — legacy ID
    }
    return collectionId; // unknown format — leave unchanged
}

/**
 * Replace the persona-handle segment in a collection ID so it matches a target handle.
 *
 * Mirror of {@link remapCollectionIdToBackend} for the segment that follows the
 * optional backend in the unified shape:
 *   vf_<type>_[<backend>_]<handle>_<name>_<timestamp>
 *
 * Used by the import path so a collection exported by one persona is re-homed under
 * the importing persona. Without this, the imported ID keeps the source handle and
 * the DB-browser persona filter hides it as foreign (see collection-loader.js
 * `registerCollection` and database-browser.js `_filterCollectionsByCurrentPersona`).
 *
 * The handle is treated as a single underscore-delimited segment — the same parse
 * convention used everywhere else (database-browser.js `_extractHandleFromCollectionId`).
 * The authoritative ownership signal is the `creatorHandle` metadata stamp, which the
 * import path sets explicitly; this remap only keeps the ID human-consistent.
 *
 * Returns the original ID unchanged when it doesn't match a known prefix, has no
 * handle segment, or the handle already equals the target (no-op).
 *
 * @param {string} collectionId
 * @param {string} targetHandle - persona handle (raw or sanitized; sanitized internally)
 * @returns {string} remapped ID (or original on no-op / unknown format)
 */
export function remapCollectionIdToHandle(collectionId, targetHandle) {
    const sanitizedTarget = sanitizeHandleId(targetHandle);

    for (const prefix of Object.values(COLLECTION_PREFIXES)) {
        if (!collectionId.startsWith(prefix)) continue;
        let rest = collectionId.slice(prefix.length); // 'qdrant_wanderer_char_uuid' or 'wanderer_char_uuid'

        // Skip the optional backend segment if present so we land on the handle.
        let backendPart = '';
        for (const b of KNOWN_BACKEND_LABELS) {
            if (rest.startsWith(b + '_')) {
                backendPart = b + '_';
                rest = rest.slice(backendPart.length);
                break;
            }
        }

        const sepIdx = rest.indexOf('_');
        if (sepIdx <= 0) return collectionId; // no handle segment (legacy / malformed)
        const oldHandle = rest.slice(0, sepIdx);
        return oldHandle === sanitizedTarget
            ? collectionId // no-op
            : prefix + backendPart + sanitizedTarget + rest.slice(oldHandle.length);
    }
    return collectionId; // unknown format — leave unchanged
}

/**
 * Returns the storage backend label used in registry keys.
 * The user-facing setting is 'standard' but the actual storage is Vectra,
 * so we normalise 'standard' → 'vectra' to match what the Similharity plugin
 * reports.  'qdrant' passes through unchanged.
 * @param {string} vectorBackend Value from settings.vector_backend
 * @returns {string} 'vectra' | 'qdrant' | ...
 */
export function getRegistryBackend(vectorBackend) {
    const b = String(vectorBackend || 'standard').toLowerCase();
    return b === 'standard' ? 'vectra' : b;
}

/**
 * Build the canonical registry-key form ("backend:collectionId") used as the
 * dict key for all collection metadata (locks, autoSync, scope, conditions,
 * etc.). All write paths must use this form so reads stay consistent with
 * writes — see the auto-sync key-mismatch bug fixed by introducing this helper.
 *
 * @param {string} collectionId Bare collection ID (no backend prefix)
 * @param {object|string} settingsOrBackend Either a settings object (uses settings.vector_backend) or a pre-normalized backend string
 * @returns {string} "backend:collectionId"
 */
export function buildRegistryKey(collectionId, settingsOrBackend) {
    const backend = typeof settingsOrBackend === 'string'
        ? settingsOrBackend
        : getRegistryBackend(settingsOrBackend?.vector_backend);
    return `${backend}:${collectionId}`;
}

/**
 * Canonical resolver: given either a registry-key ("backend:collectionId")
 * or a bare collection ID, return the backend label + the bare collection ID.
 *
 * Use this anywhere routing must pick the right backend for a collection,
 * instead of:
 *   1. `parseRegistryKey(id).backend ?? settings.vector_backend` (picks the
 *       wrong backend for a collection that lives on the other one)
 *   2. `getBackendFromCollectionId(bareId)` alone (misses input already in
 *       registry-key form)
 *   3. Hand-rolled `id.includes('qdrant') ? 'qdrant' : 'standard'` (drift bait)
 *
 * Resolution order:
 *   1. If the input has a known backend prefix (`qdrant:` / `vectra:` /
 *      `standard:`), use that — the canonical form.
 *   2. Otherwise, try to detect the backend from the ID's structure
 *      (`vf_<kind>_<backend>_…`), for bare entries without a registry-key
 *      prefix.
 *   3. If both fail, return `{ backend: null }`. Caller decides whether to
 *      throw, warn, or fall through to a settings-level default.
 *
 * The returned `collectionId` is always the BARE form — backend methods
 * (e.g. StandardBackend.queryCollection, plugin REST calls) expect bare IDs
 * and route by the `backend` field returned here.
 *
 * @param {string} input - registry key or bare collection ID
 * @returns {{ backend: string|null, collectionId: string }}
 *   `backend` is one of {@link KNOWN_BACKEND_LABELS} or `null` if unresolvable.
 *   `collectionId` is always the bare form.
 */
export function resolveBackendForCollection(input) {
    const parsed = parseRegistryKey(input);
    if (parsed.backend) {
        return { backend: parsed.backend, collectionId: parsed.collectionId };
    }
    const detected = getBackendFromCollectionId(parsed.collectionId);
    return { backend: detected, collectionId: parsed.collectionId };
}

// ============================================================================
// CHAT UUID UTILITIES
// ============================================================================

/**
 * Gets the unique chat UUID from chat_metadata.integrity
 * This is the authoritative identifier for a chat.
 * @returns {string|null} Chat UUID or null if no chat
 */
export function getChatUUID() {
    const integrity = chat_metadata?.integrity;
    if (integrity) {
        return integrity;
    }
    // Fallback: use chatId (less ideal but works for old chats)
    const chatId = getCurrentChatId();
    if (chatId) {
        log.warn('VectFox: chat_metadata.integrity not found, falling back to chatId');
        return chatId;
    }
    return null;
}

// ============================================================================
// COLLECTION ID BUILDERS
// ============================================================================

/**
 * Canonical segment sanitizer for collection IDs — the single primitive every
 * other sanitizer in the codebase is built on, so the rules can't drift.
 *
 * Always: NFC-normalize (so decomposed combining marks — macOS NFD filenames,
 * some Vietnamese input — survive the \p{L} filter instead of being stripped),
 * lowercase, collapse runs of non-alphanumerics to a single underscore, cap length.
 *
 * Options tune the two axes that legitimately vary between segment kinds:
 *   - `trim`     strip leading/trailing underscores (handle/char segments do; raw
 *                name segments historically don't, to preserve positional info).
 *   - `fallback` value substituted when the input is empty AND when sanitizing
 *                reduces it to empty (e.g. all-punctuation). '' = no fallback.
 *
 * @param {string} name
 * @param {{ maxLen?: number, trim?: boolean, fallback?: string }} [opts]
 * @returns {string}
 */
export function sanitizeIdSegment(name, { maxLen = 30, trim = false, fallback = '' } = {}) {
    let s = String(name || fallback)
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_');
    if (trim) s = s.replace(/^_|_$/g, '');
    return s.substring(0, maxLen) || fallback;
}

/**
 * Sanitize a name segment for use in collection IDs (lowercase, alphanumeric +
 * underscores, length-capped). No edge-trim and no fallback word — matches the
 * positional name segment used by the lorebook/character/document builders and
 * the registry-scan matchers in collection-loader / content-vectorization /
 * world-info-integration.
 *
 * @param {string} name
 * @param {number} maxLength
 * @returns {string}
 */
export function sanitizeNameSegment(name, maxLength) {
    return sanitizeIdSegment(name, { maxLen: maxLength, trim: false, fallback: '' });
}

/**
 * Sanitize a persona name into the canonical handleId form used across collection IDs
 * (NFC-normalized, lowercase, underscore-joined, edge-trimmed, capped at 30 chars,
 * empty → 'user'). Single source of truth — the ID builders, `registerCollection`'s
 * creatorHandle stamp, `getCollectionListing`'s ownership check (behind the DB-browser
 * persona filter), and `remapCollectionIdToHandle` all derive the handle this way, so
 * they must all route through here.
 *
 * @param {string} name - raw persona name (typically getContext().name1)
 * @returns {string} sanitized handleId
 */
export function sanitizeHandleId(name) {
    return sanitizeIdSegment(name, { maxLen: 30, trim: true, fallback: 'user' });
}

/**
 * Sanitize the persona handle from the active context. Must match the logic in the eventbase /
 * archive builders so registerCollection's stamp check sees the handle in the collection name.
 */
function _currentHandleId() {
    return sanitizeHandleId(getContext()?.name1);
}

/**
 * Builds a lorebook collection ID following the unified protocol:
 *   vf_lorebook_<backend>_<handle>_<name>_<timestamp>
 * Backend is optional but recommended; without it the format drops the backend segment:
 *   vf_lorebook_<handle>_<name>_<timestamp>
 *
 * @param {string} lorebookName Lorebook name
 * @param {string} [backend]    Vector backend (e.g. 'qdrant', 'standard')
 * @param {number} [timestamp]  Optional timestamp, defaults to Date.now()
 * @returns {string} Collection ID
 */
export function buildLorebookCollectionId(lorebookName, backend, timestamp) {
    const sanitizedName = sanitizeNameSegment(lorebookName, 50);
    const handle = _currentHandleId();
    const normalizedBackend = normalizeBackendForId(backend);
    const ts = timestamp || Date.now();
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTFOX_LOREBOOK}${normalizedBackend}_${handle}_${sanitizedName}_${ts}`;
    }
    return `${COLLECTION_PREFIXES.VECTFOX_LOREBOOK}${handle}_${sanitizedName}_${ts}`;
}

/**
 * Builds a character collection ID following the unified protocol:
 *   vf_character_<backend>_<handle>_<name>_<timestamp>
 *
 * @param {string} characterName Character name
 * @param {string} [backend]     Vector backend
 * @param {number} [timestamp]   Optional timestamp
 * @returns {string} Collection ID
 */
export function buildCharacterCollectionId(characterName, backend, timestamp) {
    const sanitizedName = sanitizeNameSegment(characterName, 50);
    const handle = _currentHandleId();
    const normalizedBackend = normalizeBackendForId(backend);
    const ts = timestamp || Date.now();
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTFOX_CHARACTER}${normalizedBackend}_${handle}_${sanitizedName}_${ts}`;
    }
    return `${COLLECTION_PREFIXES.VECTFOX_CHARACTER}${handle}_${sanitizedName}_${ts}`;
}

/**
 * Builds a document collection ID following the unified protocol:
 *   vf_document_<backend>_<handle>_<name>_<timestamp>
 *
 * @param {string} documentName Document name
 * @param {string} [backend]    Vector backend
 * @param {number} [timestamp]  Optional timestamp
 * @returns {string} Collection ID
 */
export function buildDocumentCollectionId(documentName, backend, timestamp) {
    const sanitizedName = sanitizeNameSegment(documentName, 50);
    const handle = _currentHandleId();
    const normalizedBackend = normalizeBackendForId(backend);
    const ts = timestamp || Date.now();
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTFOX_DOCUMENT}${normalizedBackend}_${handle}_${sanitizedName}_${ts}`;
    }
    return `${COLLECTION_PREFIXES.VECTFOX_DOCUMENT}${handle}_${sanitizedName}_${ts}`;
}

/**
 * Builds an EventBase collection ID for the given chat.
 * New format (backend-aware): vf_eventbase_{backend}_{handleId}_{charName}_{chatUUID}
 * Legacy format (no backend):  vf_eventbase_{handleId}_{charName}_{chatUUID}
 * Kept in collection-ids.js as the single source of truth for IDs.
 * @param {string} [chatUUID] Optional UUID override
 * @param {string} [backend] Optional backend name; when omitted, returns legacy format
 * @returns {string|null} Collection ID or null if no chat
 */
export function buildEventBaseCollectionId(chatUUID, backend) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return null;

    const context = getContext();
    const sanitizedHandle = sanitizeHandleId(context?.name1);

    const sanitizedChar = sanitizeIdSegment(context?.name2, { maxLen: 30, trim: true, fallback: 'chat' });

    const normalizedBackend = normalizeBackendForId(backend);
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTFOX_EVENTBASE}${normalizedBackend}_${sanitizedHandle}_${sanitizedChar}_${uuid}`;
    }

    return `${COLLECTION_PREFIXES.VECTFOX_EVENTBASE}${sanitizedHandle}_${sanitizedChar}_${uuid}`;
}

/**
 * Builds a collection ID for an archived chat's EventBase events.
 * Format: vf_archiveevent_{backend}_{handle}_{filenameCharName}_{archiveUUID}
 *
 * The ID is independent of the current chat's UUID — same archive uploaded from
 * any ST chat produces the same ID, enabling fingerprint-cache dedup across re-uploads.
 *
 * @param {object} params
 * @param {string} params.filenameCharName  - Character name parsed from the archive filename
 * @param {string} params.archiveUUID       - archive's chat_metadata.integrity, or SHA-1 of file content
 * @param {string} [params.backend]         - Vector backend (defaults to settings.vector_backend)
 * @returns {string|null}
 */
export function buildArchiveEventCollectionId({ filenameCharName, archiveUUID, backend }) {
    if (!archiveUUID) return null;

    const context = getContext();
    const sanitizedHandle = sanitizeHandleId(context?.name1);

    const sanitizedChar = sanitizeIdSegment(filenameCharName, { maxLen: 30, trim: true, fallback: 'archive' });

    const normalizedBackend = normalizeBackendForId(backend);
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT}${normalizedBackend}_${sanitizedHandle}_${sanitizedChar}_${archiveUUID}`;
    }
    return `${COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT}${sanitizedHandle}_${sanitizedChar}_${archiveUUID}`;
}

// ============================================================================
// COLLECTION ID PARSER
// ============================================================================

/**
 * Parses any collection ID format and returns structured info
 * Handles all legacy and current formats.
 *
 * Scope mapping (must stay in sync with `getEffectiveScope`):
 *   - `vf_eventbase_*` / `vf_archiveevent_*` → 'chat'
 *   - `vf_lorebook_*` / `vf_character_*` / `vf_document_*` → 'character'
 *   - invalid input → 'unknown' (sentinel; `getEffectiveScope` falls through
 *     to its 'character' default)
 *
 * @param {string} collectionId Collection ID to parse
 * @returns {{type: string, rawId: string, scope: string, format: string}} Parsed info
 */
export function parseCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') {
        return {
            type: COLLECTION_TYPES.UNKNOWN,
            rawId: 'unknown',
            scope: COLLECTION_SCOPES.UNKNOWN,
            format: 'invalid',
        };
    }

    // VectFox lorebook format: vf_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTFOX_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vectfox',
        };
    }

    // LoreBase index: vf_lorebase_*, locked to a chat or character like a lorebook
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_LOREBASE)) {
        return {
            type: COLLECTION_TYPES.LOREBASE,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTFOX_LOREBASE, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vectfox',
        };
    }

    // VectFox character format: vf_character_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_CHARACTER)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTFOX_CHARACTER, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vectfox',
        };
    }

    // VectFox document format: vf_document_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_DOCUMENT)) {
        return {
            type: COLLECTION_TYPES.DOCUMENT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTFOX_DOCUMENT, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vectfox',
        };
    }

    // VectFox eventbase format: vf_eventbase_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTFOX_EVENTBASE, ''),
            scope: COLLECTION_SCOPES.CHAT,
            format: 'vectfox',
        };
    }

    // VectFox archive event format: vf_archiveevent_*
    // Scope is 'chat' to match getEffectiveScope's documented behavior — archive
    // event collections hold chat-shaped events and belong to the chat scope.
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT)) {
        return {
            type: COLLECTION_TYPES.ARCHIVE_EVENT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT, ''),
            scope: COLLECTION_SCOPES.CHAT,
            format: 'vectfox',
        };
    }

    // Default: unknown
    return {
        type: COLLECTION_TYPES.UNKNOWN,
        rawId: collectionId,
        scope: COLLECTION_SCOPES.UNKNOWN,
        format: 'unknown',
    };
}

// ============================================================================
// PATTERN MATCHING FOR DISCOVERY
// ============================================================================

/**
 * Builds search patterns for finding a chat's collections
 * Used by EventBase to find a chat's collections (eventbase-store.js)
 *
 * @param {string} [chatId] Chat ID (filename)
 * @param {string} [chatUUID] Chat UUID
 * @returns {string[]} Array of patterns to search for (all lowercase)
 */
export function buildChatSearchPatterns(chatId, chatUUID) {
    const patterns = [];
    const uuid = chatUUID || getChatUUID();

    // Primary: UUID (the unique identifier)
    if (uuid) {
        patterns.push(uuid.toLowerCase());
    }

    return patterns;
}

/**
 * Checks if a collection ID matches any of the given patterns
 * Case-insensitive, uses substring matching for flexibility
 *
 * @param {string} collectionId Collection ID to check
 * @param {string[]} patterns Patterns to match against
 * @returns {boolean} True if matches any pattern
 */
export function matchesPatterns(collectionId, patterns) {
    if (!collectionId || !patterns || patterns.length === 0) {
        return false;
    }

    const idLower = collectionId.toLowerCase();

    return patterns.some(pattern =>
        idLower === pattern ||
        idLower.includes(pattern)
    );
}

/**
 * Extracts backend and source from a registry key
 * Registry keys can be:
 * - "backend:source:collectionId" (new format)
 * - "source:collectionId" (migration format)
 * - "collectionId" (legacy format)
 *
 * @param {string} registryKey Registry key to parse
 * @returns {{backend: string|null, source: string|null, collectionId: string}} Parsed key
 */
export function parseRegistryKey(registryKey) {
    if (!registryKey || typeof registryKey !== 'string') {
        return { backend: null, source: null, collectionId: '' };
    }

    // Known storage backends
    const knownBackends = ['standard', 'vectra', 'qdrant'];

    const parts = registryKey.split(':');

    // Current format: backend:collectionId (starts with a known backend)
    if (parts.length >= 2 && knownBackends.includes(parts[0])) {
        return {
            backend: parts[0],
            source: null,
            collectionId: parts.slice(1).join(':'),
        };
    }

    // Legacy format: just collectionId (no recognized prefix)
    return { backend: null, source: null, collectionId: registryKey };
}
