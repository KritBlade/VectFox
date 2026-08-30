# Collections, Locks & Backend Routing — Canonical APIs

Single document covering everything related to collections: lock state, listing, registry-key construction, **backend routing for queries**, and the UI checkboxes that mirror lock state. Every piece reads from the same in-memory source of truth and writes back through a small, scope-aware set of helpers.

**Why this document is long:** collection routing has historically been the #1 source of silent-wrong-answer bugs in VectFox. Locks land in the wrong storage bucket. Queries hit the wrong backend. Persona ownership stamps don't match. Every bug had the same root cause: someone reimplemented a helper inline instead of importing it. This doc is the *one* place that lists the canonical entry points so future authors (human or AI) stop reinventing them.

Read `Doc/collection_helper.md` before touching collection routing. It states the CURRENT contract only — git holds every earlier revision.

## ⚠️ Canonical APIs — USE THESE, DO NOT REIMPLEMENT

**Read this before writing any code that touches a collection.** These functions are the *only* entry points new code should call for collection listing, lock state, registry-key construction, and **per-collection backend routing**. They bundle backend disambiguation, persona/handle ownership, superadmin checks, and storage-key normalization. Re-implementing the logic inline gets it wrong almost every time — the failure mode is silent: locks land in the wrong storage bucket, queries hit the wrong backend, the UI shows nothing changed.

| Function | File | Use when |
|---|---|---|
| **`getCollectionListing(settings)`** | [collection-loader.js](../core/collection-loader.js) | You need to iterate every collection (rendering a list, finding matches by pattern, computing aggregate state). |
| **`resolveActiveEventBaseCollection(settings, chatUUID?)`** | [eventbase-store.js](../core/eventbase-store.js) | You need *the one* active EventBase collection to READ for a chat (ownership-filtered + lock-aware). Use this instead of taking `[0]` from `findEventBaseCollectionsForChat`. |
| **`resolveEventBaseWriteTarget(settings, chatUUID?)`** | [eventbase-store.js](../core/eventbase-store.js) | You are about to INGEST events, stamp the auto-sync marker, or report sync status. Same resolution, but the collection's embedded chat UUID must match — a foreign lock can widen ownership, never redirect writes. |
| **`getLock(collectionId, options)`** | [collection-metadata.js](../core/collection-metadata.js) | You need lock state for *one* collection (badge, tooltip, checkbox state, "is this active right now?"). |
| **`setLock(collectionId, action, options)`** | [collection-metadata.js](../core/collection-metadata.js) | You need to *mutate* lock state for *one* collection (user clicks lock / unlock / clear). |
| **`buildRegistryKey(collectionId, settings)`** | [collection-ids.js](../core/collection-ids.js) | You only have a bare collection ID and need to convert it to the canonical `"backend:id"` storage key (for any metadata read/write). Never hand-roll `` `${backend}:${collectionId}` `` — use this instead. |
| **`resolveBackendForCollection(input)`** | [collection-ids.js](../core/collection-ids.js) | You have an ID (either registry-key or bare) and need to pick the right backend instance for it (query, delete, list, etc.). Returns `{ backend, collectionId }` where `collectionId` is the bare form. Replaces hand-rolled `parseRegistryKey(...).backend ?? settings.vector_backend` chains. |

### `resolveBackendForCollection(input)` — pick the right backend for a collection

```js
import { resolveBackendForCollection } from './collection-ids.js';

const { backend, collectionId } = resolveBackendForCollection('qdrant:vf_lorebook_qdrant_rabbit_artificrealm_1779...');
// → { backend: 'qdrant', collectionId: 'vf_lorebook_qdrant_rabbit_artificrealm_1779...' }

const { backend: b2, collectionId: c2 } = resolveBackendForCollection('vf_eventbase_vectra_rabbit_your_wives_uuid');
// → { backend: 'vectra', collectionId: 'vf_eventbase_vectra_rabbit_your_wives_uuid' }
// (no `backend:` prefix on the input → detected from the ID's second segment)
```

Resolution order:
1. **Registry-key prefix wins** (`qdrant:` / `vectra:` / `standard:`). Canonical post-2026-05-23 form. Most call sites have this.
2. **Detect from ID structure** (`vf_<kind>_<backend>_…`). Catches legacy bare entries from before the registry-key convention and any place that still passes bare IDs.
3. **`{ backend: null, collectionId: bareForm }`** when both fail. Caller chooses whether to fall through to `settings.vector_backend`, throw, or warn.

**Always use this for routing.** The returned `collectionId` is the BARE form — backend methods (`StandardBackend.queryCollection`, `QdrantBackend.deleteVectorItems`, plugin REST endpoints) expect bare IDs and route on the `backend` field returned here.

**Why this matters:** before this helper landed, `queryCollection` in `core-vector-api.js` used `parseRegistryKey(id).backend ?? settings.vector_backend`. For mixed-backend users (rabbit had a standard EventBase locked + a qdrant EventBase locked at the same time, common after persona switches or cross-backend imports) this silently queried *all* collections through the user's default backend. Standard collections got queried through Qdrant → wrong physical location → 0 results. Qdrant collections got queried through Standard → wrong API path → 0 results. The retrieval pipeline returned other collections' content because *those* happened to be on the default backend. This is the bug that TEST 013 finally caught.

### `getCollectionListing(settings)` — listing iterator

```js
const entries = getCollectionListing(settings);
// entries: Array<{ registryKey, collectionId, backend, meta, isOwn, isActive }>
```

Built-in checks:
- Reads the registry, parses each `backend:id` key.
- `isOwn`: superadmin override OR `meta.creatorHandle` matches current persona handle OR (legacy) bare-ID substring contains current handle.
- `isActive`: calls `isCollectionActiveForContext(registryKey, …)` internally — already keyed correctly.
- Call this **once** per render and reuse the array. Do not call `isCollectionActiveForContext` in a per-card loop.

### `getLock(collectionId, options)` — single-collection read

```js
const lock = getLock(collection.registryKey || collection.id, {
    chatId: getCurrentChatId(),
    characterId: getContext()?.characterId,
    settings,
});
// lock: null  (caller unauthorized — not superadmin, not owner)
//     | { storageKey, scope, chatLocks, characterLocks, isLocked, isActiveHere, canModify }
```

Built-in checks:
- Authorization: `null` return when current persona is not superadmin AND doesn't own the collection. Use `options.ignoreAuth: true` for headless/system code (import flow, registry registration).
- Scope-aware `isActiveHere`: checks the right list (chat vs character) based on `meta.scope`.
- `canModify` flag: lets the UI grey out the lock button rather than letting the click silently fail.

**Storage-key convention:** callers must pass the registry-key form (`backend:id`). On a `collection` object from `findCollectionByKey` or `getCollectionListing`, use `collection.registryKey || collection.id`. **No silent fallback to bare ID** — passing the wrong form gives wrong-state reads, not errors.

### `setLock(collectionId, action, options)` — single-collection mutation

```js
const result = setLock(collection.registryKey || collection.id, {
    kind: 'chat',           // 'chat' | 'character'
    op: 'add',              // 'add' | 'remove' | 'clear'
    target: getCurrentChatId(),  // chatId or characterId; ignored when op='clear'
}, { settings });
// result: { success: true } | { success: false, reason: 'unauthorized' | 'invalid kind' | ... }
```

Built-in checks:
- Same authorization gate as `getLock`. Denied mutations log a warning and return `{success:false, reason:'unauthorized'}` — caller must check the result.
- Routes to the right primitive (`setCollectionLock` / `removeCollectionLock` / `clearCollectionLock` / character variants) based on `action.kind`.
- Updates the reverse index (`chat_lock_index`) atomically with the forward write.

### What NOT to do

These patterns will look correct but produce broken state:

| Wrong | Right |
|---|---|
| `isCollectionActiveForContext(collection.id, …)` | `isCollectionActiveForContext(collection.registryKey \|\| collection.id, …)` — or use `getLock` |
| `setCollectionLock(collection.id, chatId)` | `setLock(collection.registryKey \|\| collection.id, { kind: 'chat', op: 'add', target: chatId }, { settings })` |
| Iterating the registry + checking `creatorHandle.toLowerCase() === handle` inline | `getCollectionListing(settings).filter(e => e.isOwn)` |
| Iterating collections + calling `isCollectionActiveForContext` per card | `getCollectionListing` once → use `entry.isActive` |
| Reading `extension_settings.vectfox.collections[bare_id]` directly | `getCollectionMeta(registryKey)` (storage now keyed by `backend:id`) |
| Auto-resolving bare ID → registry-key by scanning the registry | Caller passes the canonical form; the auto-resolve scan was removed deliberately because it masked wrong-form callers |
| `isCollectionAutoSyncEnabled(collectionId)` — bare ID — silently returns `false` even when the UI shows checked (UI writes via registryKey, this reads from a *different bucket*) — root cause of the 2026-05-17 auto-sync regression | `isCollectionAutoSyncEnabled(registryKey)` — same form the UI + every write path uses |
| `` `${getRegistryBackend(settings.vector_backend)}:${collectionId}` `` hand-rolled at every call site (drift bait — one site forgets and the bug above surfaces) | `buildRegistryKey(collectionId, settings)` |
| `shouldCollectionActivate(collectionId, context)` with bare `collectionId` — its internal `getCollectionMeta` and `isCollectionLockedToChat` calls both read from `extension_settings.vectfox.collections[id]`, which is keyed by `backend:id` form. Passing bare ID returns empty defaults; lock checks always return `false`, so every collection looks unlocked and nothing activates correctly. Root cause of the 2026-05-20 semantic WI lorebook scope bug. | `shouldCollectionActivate(entry.registryKey, context)` where `entry` comes from `getCollectionListing(settings)` |
| `queryCollection(collection.collectionId, ...)` — passing the bare ID. `queryCollection`'s `parseRegistryKey` returns `backend=null`, then it falls back to `settings.vector_backend` (the user's *default* backend). On mixed-backend setups this silently queries the wrong backend → 0 results, or worse, returns content from a *different* collection that happens to be on the default backend. Root cause of the 2026-05-23 EventBase cross-backend retrieval bug (TEST 013). | `queryCollection(collection.registryKey, ...)` — the registry-key form lets `resolveBackendForCollection` pick the right backend per-collection. |
| `liveCollectionIds: lockedLiveCollections.map(c => c.collectionId)` — destructuring `.collectionId` off a `_gatherLockedEventBaseCollections` result. The object has BOTH `.collectionId` (bare) and `.registryKey` (canonical) — picking the wrong one cascades the bare-ID bug down to every consumer (retrieveEvents, retrieveEventsWithAgent). | `liveCollectionIds: lockedLiveCollections.map(c => c.registryKey)` — same pattern, right field. |
| `parseRegistryKey(id).backend ?? 'qdrant'` (or `?? settings.vector_backend`) hand-rolled — silently misroutes bare IDs that *do* have a detectable backend in the ID structure. | `resolveBackendForCollection(id)` — tries registry-key prefix first, then ID-structure detection, then returns `null` so the caller knows resolution failed. |

### Older primitives — when you might still need them

`setCollectionLock`, `removeCollectionLock`, `clearCollectionLock`, `setCollectionCharacterLock`, etc. ([collection-metadata.js](../core/collection-metadata.js)) are the raw write primitives without authorization. The facade routes to these. **Only call them directly from inside `setLock` or from system code that already enforces auth at a higher layer** (`registerCollection`'s creatorHandle stamping is the canonical example). Application code, UI handlers, and anything user-triggered should go through `setLock`.

## Pause/Resume button — `enabled` flag

Separate concern from locks. It's a per-collection hard kill switch — when `false`, that one collection is blocked from any activation regardless of locks, triggers, or scope.

> **Do not confuse with the global master switch.** This pause flag is **per-collection**, stored at `extension_settings.vectfox.collections[registryKey].enabled` and read via `isCollectionEnabled(registryKey)`. The VectFox master switch is a **different key** — top-level `extension_settings.vectfox.enabled`, read via `isVectFoxEnabled()` ([feature-gate.js](../core/feature-gate.js)) — and gates *all* runtime work (retrieval injection, auto-sync, lorebook WI) globally. Same word, different scope and different storage path.

- **UI:** Play/pause icon on each collection card in the Database Browser
- **Write:** `setCollectionEnabled(collection.registryKey || collection.id, false)` → stores `{ enabled: false }` under `extension_settings.vectfox.collections[registryKey]`
- **Read:** `isCollectionEnabled(registryKey)` in `core/collection-metadata.js` — pass the registry-key form, not bare ID
- **Default:** `true` (enabled) when no metadata exists
- **All collections use the same key form** — `backend:id`. EventBase collections are registered as `${registryBackend}:${collectionId}` in `eventbase-store.js`, not as plain IDs. The `data-collection-key` attribute on every card is always `collection.registryKey || collection.id`.

## Async runtime activation — `shouldCollectionActivate`

Used by any code path that must decide at runtime whether a collection is currently in scope, respecting triggers, advanced conditions, and manual locks. The semantic WI lorebook search path (`world-info-integration.js`) is the canonical example.

**Must receive the registry-key form.** Internally calls `getCollectionMeta(id)` and `isCollectionLockedToChat(id, chatId)`, both of which read from `extension_settings.vectfox.collections[id]` — keyed by `backend:id`. Passing a bare collection ID silently gets empty defaults and lock checks always return `false`.

**Canonical pattern:**

```js
import { getCollectionListing } from './collection-loader.js';
import { shouldCollectionActivate } from './collection-metadata.js';

const listing = getCollectionListing(settings);
const currentChatId = getCurrentChatId() ? String(getCurrentChatId()) : null;
const currentCharacterId = getContext().characterId != null ? String(getContext().characterId) : null;
const context = { currentChatId, currentCharacterId };

for (const entry of listing) {
    if (!entry.collectionId.startsWith('vf_lorebook_')) continue;
    if (entry.meta.enabled === false) continue;                           // paused
    if (!(await shouldCollectionActivate(entry.registryKey, context))) continue;  // out of scope
    // entry.registryKey is correct for all subsequent getCollectionMeta calls
}
```

Priority chain inside `shouldCollectionActivate`:
```
1. enabled=false          → BLOCKED (pause button)
2. Activation Triggers    → ACTIVE if any keyword matches recent messages
3. Advanced Conditions    → ACTIVE if condition passes
4. Chat lock match        → ACTIVE if currentChatId is in lockedToChatIds
5. Character lock match   → ACTIVE if currentCharacterId is in lockedToCharacterIds
6. Nothing matched        → BLOCKED
```

**Important:** trigger/condition gates are intentional for semantic WI — a lorebook with keyword triggers should activate even without a manual chat lock. A lorebook with no triggers and no lock is out of scope and will not be searched.

## ⚠️ Embedding model resolution — `getModelFromSettings`

Sibling principle to the lock facade — same "use the one helper, never reimplement inline" rule, different domain. Lives in this doc because the model is part of the **storage-key contract** for every collection: vectra partitions chunks by model on disk, so insert and query must agree on the model value or the read silently misses.

The settings object stores the embedding model under **provider-specific** field names: `embedding_openrouter_model`, `embedding_ollama_model`, `embedding_vllm_model`, `cohere_model`, etc. (the active providers were renamed to the `embedding_*` convention; the embedding-provider selection itself is `settings.embedding_provider`, formerly `settings.source`). There is **no flat `settings.model`** — that key is always empty/undefined. Code that reads `settings.model` directly silently produces the wrong value (empty string) without throwing.

**Always use** [`getModelFromSettings(settings, fallback?)`](../core/providers.js) from `core/providers.js`:

```js
import { getModelFromSettings } from './providers.js';

const model = getModelFromSettings(settings);              // → 'qwen/qwen3-embedding-8b' for openrouter
const modelOrNull = getModelFromSettings(settings, null);  // null when provider has no model field
```

It internally calls `getModelField(settings.embedding_provider)` to look up the right field name, then reads that field.

### Why this matters

Every site that sends a `model` to the plugin API (`chunks/insert`, `chunks/list`, `chunks/query`, `get-embedding`) is part of the **storage-key contract**. Inserts under `model='qwen/qwen3-embedding-8b'` must be queried under the same `model` value or the plugin's per-model partitioning silently returns 0 results. This bug surfaced as "vectra returns 0 results while qdrant works" — qdrant doesn't partition by model field, so it masked the bug; vectra exposed it.

### What NOT to do

| Wrong | Right |
|---|---|
| `model: settings.model` (flat key — always empty) | `model: getModelFromSettings(settings)` |
| `settings.model \|\| ''` | `getModelFromSettings(settings)` |
| `settings[getModelField(settings.embedding_provider)] \|\| null` (one-liner with manual fallback) | `getModelFromSettings(settings, null)` |
| `const modelField = getModelField(s.embedding_provider); s[modelField] \|\| ''` (4-line inline expansion) | `getModelFromSettings(settings)` |
| Defining a local `getModelFromSettings` private helper (this happened 3 times before consolidation) | Import the canonical one |

### When to use `getModelField` directly instead

`getModelField(providerId)` returns the **field name** (a string like `'embedding_openrouter_model'`) or `null`. Use it only when you need the *name* itself for a validation check or display:

```js
// Validation: does the user need to configure a model for the current provider?
const modelField = getModelField(settings.embedding_provider);
if (config.requiresModel && modelField && !settings[modelField]) {
    return { error: 'Model not configured' };
}
```

If you just need the value, `getModelFromSettings(settings)` is shorter and harder to misuse.

## Lock-state read tiers — which layer to call

Three tiers exist. Call the highest tier that covers your use case:

| Tier | Function | Use when |
|---|---|---|
| **API (preferred)** | `getLock(registryKey, opts)` | One collection — UI badge, checkbox, tooltip. Returns `isActiveHere`, `canModify`, `chatLocks`, etc. Bundles auth check. |
| **API (preferred)** | `getCollectionListing(settings)` | All collections — render loop, aggregate state. Use `entry.isActive` — no per-card calls needed. |
| **Underlying** | `isCollectionActiveForContext(registryKey, { chatId, characterId })` | Called internally by both API functions. Do not call per-card in a loop — use `getCollectionListing` instead. Still correct when you have exactly one collection and no auth check is needed (e.g. runtime activation in `world-info-integration.js`). |
| **Underlying (raw keys)** | `isCollectionActiveForContextAnyKey([registryKey, collectionId], { chatId, characterId })` | Same single-source check, but tolerant of both key forms when a lock/scope may be stamped under either the registry-key or the bare id (EventBase read/write resolution, auto-sync LED). Returns true if active under ANY form. Use this instead of re-spreading `isCollectionLockedToChat` across call sites. |
| **Raw** | `setCollectionLock` / `removeCollectionLock` etc. | Internal only — called by `setLock` facade. Do not call from application code. |

`isCollectionActiveForContext` returns `true` based on the collection's scope:
- `scope='chat'` → `chatId` is in `lockedToChatIds`
- `scope='character'` → `characterId` is in `lockedToCharacterIds`
- anything else → `false` (no global scope; legacy `global` was migrated to `character` — see below)

## Scope handling — `getEffectiveScope` is the canonical resolver

The scope of a collection (`'chat'` vs `'character'`) controls which lock kind `saveActivation` writes, which list `isCollectionActiveForContext` reads, and which UI elements appear in the activation editor. Get it wrong and locks silently fail to persist — exactly the 2026-05-24 no-plugin regression.

**Use the canonical resolver, never branch on bare `meta.scope`:**

```js
import { getEffectiveScope, getCollectionMeta } from './collection-metadata.js';

// Read path — getCollectionMeta auto-resolves scope, so .scope is always valid:
const meta = getCollectionMeta(registryKey);
if (meta.scope === 'chat') { /* … */ }

// Explicit resolution (e.g. when meta comes from an export payload, not from
// getCollectionMeta — its scope is untrusted):
const scope = getEffectiveScope(collectionId, importPayload);
```

### Resolution order (inside `getEffectiveScope`)

1. **Stored `meta.scope`** if it's already `'chat'` or `'character'`.
2. **Parse from collection ID structure:**
   - `vf_eventbase_*` / `vf_archiveevent_*` → `'chat'`
   - `vf_character_*` / `vf_lorebook_*` / `vf_document_*` → `'character'`
3. **Default `'character'`** (matches `content-vectorization.js` insert default — the safer wider-scope option).

Returns `'chat'` or `'character'` only — never `null`, `undefined`, or the legacy `'unknown'`.

### Why `getCollectionMeta` auto-resolves scope

`getCollectionMeta` runs `getEffectiveScope` on every read so downstream callers don't have to remember the defensive pattern. Cheap when stored scope is already valid (single string compare); only parses the ID on the no-plugin / legacy code paths. This eliminates the entire class of "bare `meta.scope === 'chat'` silently misses null/unknown" bugs.

### Rules for new code

- ✅ **Use `getCollectionMeta()`** to read scope — its result is always valid.
- ✅ **Use `getEffectiveScope(id, payload)`** explicitly when the meta comes from an untrusted source (export file, network response).
- ❌ **Don't write `defaultCollectionMeta.scope = 'unknown'`** again. Default is `null`; the resolver fills it in.
- ❌ **Don't write `'unknown'` to `meta.scope`** anywhere on disk. If scope can't be determined, leave the field absent and let the resolver derive it from the ID.
- ❌ **Don't write a new "scope helper"** with `if (meta.scope === ...) return ... else parseFromId ... else default`. That's `getEffectiveScope` — import it. The 2026-05-24 incident was caused by exactly this: a private `_inferScope` lived in `collection-export.js` for months while every other caller wrote its own variant. Discoverable via SigMap; see CLAUDE.md for the workflow.

### Legacy collections (auto-corrected at read time)

Users who created collections before 2026-05-24 may have `scope: 'unknown'` saved on disk. They keep working transparently:
- `getCollectionMeta` runs the merged value through `getEffectiveScope` before returning, so `meta.scope` reads as `'chat'` or `'character'`.
- No data migration needed — the read path silently corrects every access.
- The stored `'unknown'` string stays on disk until the next `setCollectionMeta` call overwrites it. Harmless.

### History

The 2026-05-24 no-plugin lock-activation regression was caused by `defaultCollectionMeta.scope = 'unknown'` (truthy string) breaking the `storedMeta.scope || parsedMeta.scope` fall-through pattern. Fix landed same day:
1. Default changed to `null`.
2. `getEffectiveScope` extracted as canonical helper, `_inferScope` (duplicate) deleted.
3. `getCollectionMeta` wired to auto-resolve via the helper.

TEST 005/006/007 are the regression coverage — they exercise the standard-backend no-plugin path including the lock checkbox flow.

## Scope migration — global is gone

`scope='global'` is no longer a valid value anywhere in the codebase. The Vectorize Content modal exposes only `Character` (default) and `This Chat`. Both the runtime path and the parser were cleaned up 2026-05-24:

1. **`COLLECTION_SCOPES.GLOBAL` was deleted** from `core/collection-ids.js`. Only `CHARACTER`, `CHAT`, and `UNKNOWN` (the unparseable-input sentinel) remain.
2. **`parseCollectionId` no longer returns `'global'`.** Before the cleanup it emitted `'global'` for `vf_lorebook_*`, `vf_document_*`, and `vf_archiveevent_*`. `getEffectiveScope` rejected those values and fell through to its `'character'` default — which happened to be correct for lorebook/document but **silently wrong for archive events** (should be `'chat'`). The parser now returns the canonical value directly:
   - `vf_lorebook_*` / `vf_document_*` / `vf_character_*` → `'character'`
   - `vf_eventbase_*` / `vf_archiveevent_*` → `'chat'`
3. **Legacy on-disk `scope: 'global'` entries are auto-migrated** on first read by `loadAllCollections`:
   ```
   storedMeta.scope === 'global'  →  setCollectionMeta(writeKey, { scope: 'character' })
   ```
   This is the *only* remaining string-literal `'global'` reference in the codebase — it's needed to clean up user data that pre-dates the cleanup. Do not remove it.

A migrated collection has no character lock by default — it stops auto-activating until the user re-checks "Active for current chat" in Collection Settings (which then calls `setCollectionCharacterLock(currentCharacterId)`).

**Rule for new code:** never reintroduce `scope === 'global'` branches anywhere. If you need to handle stored data that *might* contain `'global'`, route it through `getEffectiveScope` — the canonical resolver folds every invalid value into `'character'` or `'chat'`.

## DB Browser — lock badge in the listing

In `ui/database-browser.js`, the main render loop calls `getCollectionListing(settings)` once and iterates its entries. Each entry carries `entry.isActive` (pre-computed by `getCollectionListing` via `isCollectionActiveForContext(registryKey, ...)` internally). The badge renderer receives the entry and reads `entry.isActive` — there is no per-card `isCollectionActiveForContext` call in the loop. The badge displays a scope-appropriate tooltip:
- `scope='chat'` → "Active for current chat" (with chat-count suffix if locked to multiple chats)
- `scope='character'` → "Active for current chat (locked to current character)"

A fallback `isCollectionActiveForContext` call survives in the badge helper for callers that pass a raw collection ID instead of an entry — this is internal plumbing, not the intended pattern.

## DB Browser → Collection Settings → "Active for current chat" checkbox

In `ui/database-browser.js`:

| Function | Role |
|---|---|
| `openActivationEditor` | Computes `state.alwaysActive` via `isCollectionActiveForContext` |
| `renderActivationEditor` | Sets `prop('checked', state.alwaysActive)` |
| `refreshActivationLockButton` | Re-syncs checkbox after Manage Locks dialog — same helper |
| `saveActivation` | Mutates locks on Save based on scope |

**`saveActivation` lock mutation:**

```
scope='chat'      + checked   →  setCollectionLock(state.collectionId, currentChatId)
scope='chat'      + unchecked →  removeCollectionLock(state.collectionId, currentChatId)
scope='character' + checked   →  setCollectionCharacterLock(state.collectionId, currentCharacterId)
scope='character' + unchecked →  removeCollectionCharacterLock(state.collectionId, currentCharacterId)
```

`state.collectionId` is the registry-key form (`backend:id`) — set when `openActivationEditor` is called with `collection.registryKey || collection.id`. Key form is correct. **Note:** these calls use the raw primitives directly rather than the `setLock` facade. They bypass the auth check that `setLock` performs, which is acceptable here because `saveActivation` is only reachable by the collection owner. Migration to `setLock` is a known pending cleanup.

Each call only touches the lock for the **current** chat/character. Other chats or characters that have this collection locked keep their entries intact — `removeCollectionLock` filters by id, doesn't wipe the list.

## WI Panel — "Enable Semantic WI Activation" checkbox

In `ui/ui-manager.js`.

**`refreshWIStatus`** (auto-sync from events) fires on:
- WorldInfo tab click
- After lorebook vectorization completes
- `vectfox:collections-updated` custom event
- `CHAT_CHANGED` event
- Initial load

It computes `activeIds` by filtering own-persona lorebooks (creatorHandle stamp) through `isCollectionActiveForContext`, then drives the checkbox + status via an inline `_setWIEnabled(bool)` helper:

| Result | Checkbox | LED | Status |
|---|---|---|---|
| 0 lorebooks (this persona) | ❎ | 🟡 | "No lorebooks vectorized — vectorize one first" |
| 0 active | ❎ | 🟡 | "Lorebook vectorized but not active for this chat — lock it…" |
| ≥1 active | ✅ | 🟢 | "Active for this chat: <names>" |

**Critical:** `_setWIEnabled` calls `prop('checked', enabled)` directly. It does **not** call `.trigger('change')`. This is load-bearing — see "Manual vs auto-sync paths" below.

**Manual change handler** (user clicks the checkbox):

| Action | Behaviour |
|---|---|
| ✓ Check + no own lorebooks | Uncheck, redirect to Content Vectorizer (`'lorebook'`) |
| ✓ Check + no active | Uncheck, redirect to DB Browser |
| ✓ Check + ≥1 active | Persist `enabled_world_info=true`, show settings panel |
| ✗ Uncheck | For each currently-active own lorebook, remove the lock making it active (chat or character per scope). Dispatch `vectfox:collections-updated`. Persist `enabled_world_info=false`. |

## Chat Auto-Sync — "Enable Auto-Sync" checkbox

### The smart marker — what makes auto-sync correct

Before reading the rest of this section, internalize this: **the window fingerprint cache is what prevents auto-sync from re-extracting the entire chat on every trigger**. Without it, the cost of running auto-sync would grow linearly with chat length on every single message — every trigger would re-process every window from the top. The fingerprint cache is the "smart marker" that lets auto-sync only do the *new* work.

The cache lives in [`core/eventbase-store.js`](../core/eventbase-store.js). Three functions form the contract:

| Function | Role in auto-sync |
|---|---|
| `markWindowExtracted(sourceHashes, chatUUID)` | Called by `runEventBaseIngestion` after each window is successfully extracted. Writes the fingerprint to both the in-memory `_windowCacheSet` AND the persisted `extension_settings.vectfox.eventbase_extracted_windows[chatUUID]` array, then calls `saveSettingsDebounced()`. Survives page reload. |
| `isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID)` | Per-window dedup gate inside the ingestion loop. Returns `set.has(fp)` from the in-memory Set — synchronous, O(1). `messageIds` and `settings` are kept for API compat but ignored. |
| `isLastWindowExtracted(messages, windowSize, step, chatUUID, hashFn)` | Quick-exit gate at the top of `runEventBaseIngestion`. If the last possible window for the current message count is already in the cache, every prior window must be too (windows process in order), so ingestion no-ops immediately without building the window list. This is the cheapest possible "is there anything new?" check. |

User scenario the cache makes safe:

1. User vectorizes a chat at 2 messages — window `[0-1]` extracted. `markWindowExtracted` records its fingerprint.
2. User replies twice — chat now has 6 messages. Two new windows `[2-3]` and `[4-5]` exist on disk but are unmarked in the cache.
3. User ticks "Enable Auto-Sync". Next trigger calls `runEventBaseIngestion`.
4. `isLastWindowExtracted` checks `[4-5]` against the cache → not present → returns false → ingestion runs.
5. The ingestion loop iterates windows. For `[0-1]`, `isWindowAlreadyExtracted` returns true → skipped (no LLM call, no duplicate event). For `[2-3]` and `[4-5]`, returns false → LLM extracts events, `markWindowExtracted` records each fingerprint.
6. Next trigger: `isLastWindowExtracted` against `[4-5]` returns true → quick-exit → no work done.

**Test coverage**: see TEST 014 in `tests/Eventbase-test.spec.js`. The full storage shape (two-tier persisted-array + in-memory-Set) and the rationale for *why* it's two-tier is in [Doc/dev_helper.md §4](dev_helper.md).

### Second safety layer — the start marker (window-size-change protection)

The fingerprint cache above is **window-size-dependent**: a window's fingerprint includes the message hashes it covers, so the fingerprint for `[0-1]` at `windowSize=2` does NOT match `[0-3]` at `windowSize=4`. If a user vectorized a long chat at one window size and then changes the setting before enabling auto-sync, every fingerprint silently misses and the cache devolves into "extract everything from message 0 again" — exactly the failure mode the cache exists to prevent.

The **auto-sync start marker** is the second gate that catches this case. It's a message-index threshold per chat that says "auto-sync should only process windows whose `start >= marker`." Three functions in [`core/eventbase-store.js`](../core/eventbase-store.js):

| Function | Role |
|---|---|
| `stampAutoSyncMarker(chatUUID, settings, options?)` | Called from the Auto-Sync checkbox change handler when the user enables auto-sync (and re-called when the window-size setting changes while auto-sync is on). Smart placement: if the EventBase collection has existing events → `marker = max(source_window_end) + 1`; if empty → `marker = current chat length`. Pass `{ floor: 'chatLength' }` to force from-now-on placement regardless of coverage (the enable-time "Just keep up from here" choice). Persists to `extension_settings.vectfox.eventbase_autosync_start_marker[chatUUID]` and calls `saveSettingsDebounced()`. |
| `getAutoSyncMarker(chatUUID)` | Read by `runEventBaseIngestion` to gate the window list. Returns `undefined` when no marker is stamped (manual runs and pre-auto-sync chats). |
| `clearAutoSyncMarker(chatUUID)` | Called when auto-sync is disabled so re-enabling later re-computes a fresh marker against the current chat state. |

The filter is at [`core/eventbase-workflow.js`](../core/eventbase-workflow.js):

```js
if (isAutoSync) {
    const marker = getAutoSyncMarker(uuid);
    if (typeof marker === 'number') {
        windows = windows.filter(w => w.start >= marker);
    }
}
```

**Why `>=` and not `>`:** `stampAutoSyncMarker` uses `max(source_window_end) + 1`, so the next legitimate window starts *exactly at* the marker. Using `>` would skip the first new window after the boundary — an extraction gap. Boundary inclusion is asserted by TEST 015 Phase 4.

### Enable-time backlog catch-up (confirm, then run)

Auto-sync **catches up the whole gap** (tip → now) on its next trigger — it does *not* "start from now" by default. For a large gap that next trigger is a surprise burst of LLM calls, so the enable handler ([ui-manager.js](../ui/ui-manager.js) → `#VectFox_autosync_enabled` `input`) gates it:

1. Compute pending windows: `floor(max(0, commitBoundary − getVectorizationTip(uuid)) / getAutoSyncWindowSize(settings))`, where `commitBoundary` is `status.commitBoundary` (chat length minus the held-back active turn — see the settle/commit lag layer). Clamping the backlog to the committed boundary keeps the deliberately-unextracted active turn from being counted as backfill.
2. If `>= 5` windows, `callGenericPopup(CONFIRM, …)` — **Catch up now** vs **Just keep up from here** (X/Esc reverts):
   - *Catch up now* → `backfillCurrentChatWithProgress()` ([content-vectorizer.js](../ui/content-vectorizer.js)) runs the Continue path with the standard progress UI (full-screen on mobile), then the marker lands at the freshly-advanced tip (smart placement).
   - *Just keep up from here* → `stampAutoSyncMarker(uuid, settings, { floor: 'chatLength' })` skips the backlog.
3. Below threshold → enable silently (small gap catches up on the next trigger, as before).

The catch-up backfill runs at `eventbase_window_size` while auto-sync runs at `getAutoSyncWindowSize` — **safe** because the marker/tip gate is index-based: catch-up advances the tip, the marker is stamped there, and auto-sync only processes windows *above* it at its own size. No fingerprint collision, no duplicate coverage. Floor-override behavior is asserted by TEST 016 Phase 5.

**Why the manual path ignores the marker:** the filter only applies when `isAutoSync === true`. A user manually clicking Vectorize Content can refill historical gaps at a new window size on purpose; the marker is an auto-sync-only safety, not a global "don't re-process" gate.

User scenario the marker makes safe:

1. User vectorizes chat at `windowSize=2`, message count=2 → window `[0-1]` extracted, event has `source_window_end=1`.
2. User replies twice → chat now has 6 messages.
3. User opens settings, changes `windowSize` to 4, then enables Auto-Sync.
4. `stampAutoSyncMarker` reads the collection: `max(source_window_end)=1` → marker stamped as `2`.
5. Next auto-sync trigger: `runEventBaseIngestion` builds windows at `windowSize=4` → `[0-3]` and `[4-7]`.
6. Marker filter: `[0-3]` (start=0 < 2) excluded; `[4-7]` (start=4 ≥ 2) kept. Only legitimate new content gets extracted.
7. Without the marker, both windows would have unknown fingerprints (new window size → fresh fingerprints) and both would be re-extracted, including the duplicate of messages 0,1 inside `[0-3]`.

### Third safety layer — the settle/commit lag (re-roll protection)

Auto-sync fires on `MESSAGE_SWIPED`. Without a lag, every swipe of the latest AI reply rewrites its `.mes` → new hash → new window fingerprint → a fresh extraction, leaving **one embedding per discarded generation**. The Summarizer worsens it (it force-locks the window to 1 turn and forces auto-sync on).

The **settle/commit lag** holds the *active* (still-swipeable) last turn back from extraction until a newer message supersedes it. One helper is the single source of truth:

```js
// core/eventbase-workflow.js
getCommitBoundary(messages, settings)
//  → settings.eventbase_autosync_settle_lag === false ? messages.length
//  : max(0, messages.length - getAutoSyncWindowSize(settings))   // hold back one turn
```

`runEventBaseIngestion` slices its window-builder **and** its quick-exit to `messages.slice(0, commitBoundary)` on auto-sync runs (`isAutoSync === true`); manual Vectorize Content / backfill ignores the lag and covers the whole chat. Crucially, `getChatAutoSyncStatus` evaluates `isChatFullyVectorized` against the **same committed slice** — so "fully synced" means *all committed windows extracted*, not *the active turn extracted*. Without that, the deliberately-unextracted active turn would pin the LED on yellow forever.

Because un-kept swipes only ever live on the active turn (which is past the boundary), they never reach the window-builder → **zero embeddings for discarded generations**. When the user sends the next turn, the previously-active turn falls inside the boundary and extracts exactly once.

- **On by default, no migration, no practical downside:** the held-back turn is always the newest message, hence always inside ST's live context window — retrieval never needs it. Existing fully-synced chats show no gap at upgrade (their tail was already extracted; the monotonic tip already covers it). See [plans/autosync-settle-lag.md](../plans/autosync-settle-lag.md).
- **UI:** when fully synced with `vectorization < chat`, the counter appends `· latest turn pending settle` so green + a one-turn gap reads as intentional, not a backlog. The enable-time backlog estimate clamps pending to `status.commitBoundary` so the held turn isn't counted as backfill.
- **The one inherent property:** the final turn of a chat that is never continued is never auto-extracted (nothing supersedes it) — it's still in live context, and manual Vectorize Content force-covers it if ever wanted.

**Layer-summary table:**

| Layer | Helper | Catches | When |
|---|---|---|---|
| 1 | `isLastWindowExtracted` / `isWindowAlreadyExtracted` (fingerprint cache) | Re-running the same windowing again | Same window size as the prior extraction |
| 2 | `getAutoSyncMarker` + `windows.filter(w => w.start >= marker)` | Re-processing pre-marker history under a *different* window size | Window size changed between the prior extraction and auto-sync enable |
| 3 | `getCommitBoundary` (settle/commit lag) | Embedding throwaway re-rolls/swipes of the active turn | Always, on auto-sync runs (default ON) |

**Test coverage:** TEST 015 in `tests/Eventbase-test.spec.js` is a pure-function exercise of the marker contract — fresh UUID returns `undefined`, stamp/read round-trips through the canonical getter, the `>= marker` filter excludes obsolete pre-marker windows and keeps post-marker windows, the boundary `start === marker` is included, and `clearAutoSyncMarker` removes the entry cleanly. The settle-lag is covered by `tests/eventbase-settle-lag.test.js` (pure boundary math, runs in CI) and TEST 023 in the spec (swipe-on-active-turn never extracts; the kept turn extracts once superseded).

### Vectorization tip cache — honest "vectorization: N msgs" display

The auto-sync start marker is stamped *once* at enable time and never advances as new windows extract. Using it for the UI count produces a frozen, misleading number. The vectorization tip is the live truth source. Not persisted — `setVectorizationTip` keeps it current during the session (backend-agnostic). On a cold cache after page reload, `ensureVectorizationTip` probes the backend via `listChunks` to backfill it; this works for Qdrant and Standard+plugin. For Standard without the similharity plugin the probe returns `null` (native fallback only returns hashes, no metadata), so the UI falls back to `markerValue` until the next ingestion run refreshes the in-memory cache.

| Function | File | Notes |
|---|---|---|
| `getVectorizationTip(chatUUID)` | [eventbase-store.js](../core/eventbase-store.js) | Sync; returns cached tip or `undefined`. UI falls back to `markerValue` when undefined. |
| `setVectorizationTip(chatUUID, tip)` | [eventbase-store.js](../core/eventbase-store.js) | Sync, monotonic max — out-of-order calls won't regress. Called by `runEventBaseIngestion` after every successful window via `setVectorizationTip(uuid, win.end + 1)`. |
| `clearVectorizationTip(chatUUID)` | [eventbase-store.js](../core/eventbase-store.js) | Call when deleting or clearing EventBase for a chat (parity with `clearAutoSyncMarker`). |
| `ensureVectorizationTip(chatUUID, collectionId, settings)` | [eventbase-store.js](../core/eventbase-store.js) | Async. Returns cached tip immediately on hit; probes backend once on session-cold miss, populates cache, returns value. Returns `null` when collection has no events. Called by `getChatAutoSyncStatus`. |

### Last-used window size — window-size-change detection for Continue

Persists the `windowSize` that was in effect when auto-sync last ran successfully. Used by the Continue modal to detect a window-size change since the last extraction (the modal is planned for deletion by §10 / C4 of the autosync plan, but `getLastUsedWindowSize` will remain as a diagnostic).

| Function | File | Notes |
|---|---|---|
| `getLastUsedWindowSize(chatUUID)` | [eventbase-store.js](../core/eventbase-store.js) | Reads from `extension_settings.vectfox.eventbase_last_used_window_size[chatUUID]`. Returns `undefined` when no prior run. |
| `setLastUsedWindowSize(chatUUID, windowSize)` | [eventbase-store.js](../core/eventbase-store.js) | Stamped by `runEventBaseIngestion` after a successful run with `windowsProcessed > 0`. Do not call from application code. |

### Collection resolver — find the EventBase collection for a chat

> **Naming convention (apply going forward):**
> `resolve…` returns **the one** active/canonical answer (or `null`).
> `find…`/`list…` return **all** candidates (an array).
> `get…` reads a stored value; `is…`/`has…` return a boolean.
> Pick the verb that matches the contract so callers don't have to read this doc.

**A chat UUID can map to MULTIPLE EventBase collections** — one per persona/handle
(`name1`), plus imported archives registered under a different name. The earlier
"at most one collection per backend" assumption was wrong and caused the auto-sync
marker to read a stale import instead of the active collection. Use the **lock** to
disambiguate which one is active.

| Function | File | Use when |
|---|---|---|
| `resolveActiveEventBaseCollection(settings, chatUUID?, { requireUuidMatch? })` | [eventbase-store.js](../core/eventbase-store.js) | **Default choice for READS.** Returns `{ collectionId, registryKey }` for the single **active** collection — ownership-filtered (via `getCollectionListing`) and lock-aware (matches the DB Browser's "Active here only"). Returns `null` when none. Used by `buildSummarizerInjection`. |
| `resolveEventBaseWriteTarget(settings, chatUUID?)` | [eventbase-store.js](../core/eventbase-store.js) | **Required for WRITES.** Thin wrapper passing `requireUuidMatch: true`. Used by `runEventBaseIngestion`, `synchronizeChat`, `stampAutoSyncMarker`, and `getChatAutoSyncStatus`. Returns `null` on a chat's first ingestion — callers fall through to `buildEventBaseCollectionId`. |
| `findEventBaseCollectionsForChat(uuid, preferredBackend)` | [eventbase-store.js](../core/eventbase-store.js) | Only when you genuinely need **every** candidate (e.g. pausing auto-sync on all of a chat's collections, or a has-data fallback probe). Returns `Array<{ collectionId, registryKey }>`, lock-ranked first. Pass `getRegistryBackend(settings.vector_backend)` as `preferredBackend`. **Do not** take `[0]` to mean "the active one" — call `resolveActiveEventBaseCollection` for that. Returns `[]` when no collection exists yet. |

#### Eligibility rules inside `resolveActiveEventBaseCollection` — on READS an explicit lock is a FULL override

A collection qualifies as the chat's active EventBase collection in **one of two** ways. Do not collapse these into a single "lock AND uuid" gate — that was the 2026-06-21 bug.

1. **Explicit per-chat lock → eligible unconditionally.** If the collection is locked to the current chat (`isCollectionActiveForContextAnyKey([registryKey, collectionId], { chatId })`), it is the active collection **regardless of ownership and regardless of whether its embedded UUID still matches this chat.** A lock is a deliberate user override.
2. **Auto-association (no lock) → must be owned AND UUID-matching.** Only when there is no lock does the resolver require `isOwn` *and* `matchesPatterns(id, uuidPatterns)`.

**Why the lock must bypass the UUID match on reads (not just ownership):** the collection ID bakes in the chat UUID at creation time, but the live chat UUID can **drift** away from it — e.g. after a delete + re-vectorize cycle, or when the user intentionally binds another chat's EventBase here (branch/duplicate sharing). The lock survives that drift; the UUID embedded in the ID does not. Requiring a UUID match on the read path would make the collection show **ACTIVE** in the DB Browser (lock-only badge) while retrieval ignored it.

On the **write** path the mirror-image outcome is correct, not a bug: a chat whose only EventBase collection is a foreign one locked in for retrieval shows that collection as ACTIVE (its events ARE retrieved here) *and* reports **"no collection → vectorize first"**, because this chat genuinely has nowhere of its own to write yet. Vectorizing then creates it.

**Invariant — keep these three lock checks consistent, they must all agree:**
- the DB Browser "Active here" badge (`isCollectionActiveForContext`, lock-only),
- the retrieval gather (`_gatherLockedEventBaseCollections`, lock-only, no UUID check),
- and `resolveActiveEventBaseCollection` (rule 1 above) — reads only; see the write-target carve-out below.

**Rule 1 applies to READS ONLY.** `resolveEventBaseWriteTarget` (`requireUuidMatch: true`) replaces rule 1 with: *eligible when the embedded UUID matches AND (locked OR owned)*. The lock still widens **ownership** — an imported or other-persona collection for this chat is a valid write target — it just cannot redirect ingestion into a **different conversation's** collection.

**Why writes cannot follow a foreign lock:** locking chat A's EventBase into chat B is the supported way to retrieve A's events while playing B. If ingestion honored that lock, B's events land in A's collection, where the two chats' independent `source_window_end` values collide inside one sort frame — `_orderEventsForPresentation` groups by `_sortFrame` (the collection ID), so one collection means one frame and the injected timeline interleaves both conversations. `ensureVectorizationTip` then reads A's tip (a message index in A) and skips every window in B: the "Resume extracted 0 events" report.

Group chats are unaffected: all speakers share one chat UUID, so their collections satisfy the UUID match regardless of which `name2` was live when the ID was built.

**Ranking among eligible collections**, most significant tier first: lock, then own-UUID, then current backend. The own-UUID tier is load-bearing when a chat has both its own collection and a foreign one locked in — without it both tiers score equal and the winner falls to registry insertion order, which flips silently the first time a collection is deleted and re-registered.

### Low-level fingerprint cache management

Called internally by the ingestion loop. Do not call from application code — reimplementing these inline is the historical source of dedup bugs.

| Function | File | Notes |
|---|---|---|
| `windowFingerprint(sourceHashes)` | [eventbase-store.js](../core/eventbase-store.js) | Deterministic sorted-join of message hashes. **Window-size dependent** — a fingerprint from `windowSize=2` never collides with one from `windowSize=4`, which is why the start marker is needed as a second safety layer. |
| `clearWindowCacheForChat(chatUUID)` | [eventbase-store.js](../core/eventbase-store.js) | Evicts the in-memory fingerprint Set for a chat. Use when a collection is deleted. Do NOT call on window-size change — that would force full re-extraction; use `stampAutoSyncMarker` instead. |

### Auto-sync entry points

| Function | File | Role |
|---|---|---|
| `synchronizeChat(settings, batchSize, triggerEvent)` | [chat-vectorization.js](../core/chat-vectorization.js) | The auto-sync coordinator. Gates on **the write target only** — `resolveEventBaseWriteTarget(settings, uuid)` then `isCollectionAutoSyncEnabled(active.registryKey)` — NOT a `.some()` across every collection (a leftover `autoSync=true` on a non-active sibling used to fire even with the toggle visibly off). Then calls `runEventBaseIngestion({ isAutoSync: true, collectionIdOverride: active.collectionId })`. **The override is load-bearing** (commit `5d8a6dd`): it pins the write target to the resolved active collection so a group chat doesn't manufacture a new per-speaker collection each turn. Bails immediately when the VectFox master switch is off (`isVectFoxEnabled` — see [feature-gate.js](../core/feature-gate.js)). Called from ST event hooks (MESSAGE_SENT, MESSAGE_RECEIVED, etc.). Pass `triggerEvent` so it can suppress the popup on MESSAGE_SENT mid-generation. |
| `rearrangeChat(chat, settings, type, { dryRun, testMessage })` | [chat-vectorization.js](../core/chat-vectorization.js) | ST generation interceptor (`CHAT_COMPLETION_PROMPT_READY`). Handles semantic retrieval and prompt injection. **Separate concern from `synchronizeChat`** — retrieval does not trigger auto-sync extraction. Clears stale injections then early-returns (injects nothing) when the master switch is off (`isVectFoxEnabled`); the `dryRun` query-tester path is exempt so debugging still works. The `dryRun` / `testMessage` params support the debug query tester. |

### Key-form parity

**Key-form parity is load-bearing.** Four sites read or write the per-collection autoSync flag: `refreshAutoSyncCheckbox` (UI mirror), `getChatAutoSyncStatus` (state evaluator), the change handler (writer), and `synchronizeChat` (the engine that actually fires extraction). All four must use the **registry-key form** (`backend:id`) — built via `buildRegistryKey(collectionId, settings)` or pulled from `entry.registryKey`. The 2026-05-17 regression where the popup never fired and extraction never ran was a single site (`synchronizeChat`) reading with the bare collection ID while everyone else wrote with the registry key. The flag was saved correctly; the reader looked in the wrong bucket and saw `undefined`.

State evaluator: **`async getChatAutoSyncStatus(settings)`** in `core/eventbase-workflow.js`. Mostly in-memory; performs at most ONE backend probe per (chat, session) for the vectorization-tip cache (see below). Returns one of:

```
{ state: 'no-chat' }
{ state: 'no-collection' }
{ state: 'vectorization-ahead', collectionId, registryKey, chatMessageCount, markerValue }
{ state: 'partial',          collectionId, registryKey, chatMessageCount, markerValue?, vectorizationTip? }
{ state: 'fully-vectorized', collectionId, registryKey, chatMessageCount, markerValue?, vectorizationTip? }
```

Match logic: delegates to **`resolveEventBaseWriteTarget(settings, uuid)`** (returns `no-collection` when it yields `null`) — the LED reports on the collection auto-sync would actually write to, so it must resolve with the same rules. It does NOT do its own UUID walk anymore; that logic lives inside the resolver (see "Eligibility rules inside `resolveActiveEventBaseCollection`" above). A chat whose ONLY EventBase collection is a foreign one locked in for retrieval correctly reports `no-collection`, and the UI offers Vectorize Content.

"Fully vectorized" is determined by `isChatFullyVectorized(messages, settings, chatUUID)`, which checks whether the last possible window for the current message count is already in `eventbase_extracted_windows[uuid]`. No DB query, just an O(1) Set lookup.

**Vectorization tip cache (`vectorizationTip`)** — added 2026-05-26 to fix a UI lie. The auto-sync **start marker** (`eventbase_autosync_start_marker[uuid]`) is stamped ONCE when auto-sync is enabled and never updated as new windows extract. The UI used to display the marker as "vectorization: N msgs," which froze at enable-time and drifted from reality. The tip cache lives in `core/eventbase-store.js` as `_vectorizationTipByUuid: Map<uuid, number>` and represents `max(source_window_end) + 1` for the chat. The ingestion loop calls `setVectorizationTip(uuid, win.end + 1)` after every successful `markWindowExtracted`, keeping the cache current with zero per-tick cost. On cache miss (first read after page reload), `ensureVectorizationTip()` fires one `listChunks` probe to backfill from Qdrant. UI prefers `vectorizationTip` over `markerValue` for the "vectorization: N msgs" display.

**`vectorization-ahead` state** — distinct branch (added 2026-05-24) covering the case where the per-chat auto-sync marker (`extension_settings.vectfox.eventbase_autosync_start_marker[uuid]`) is past the current chat's message count. Usual cause: user bound a chat vectorization that was extracted from a longer version of the same chat (or deleted messages after vectorizing). The marker filter inside `runEventBaseIngestion` rejects every window in that case — extraction is frozen until the chat catches up to the marker. The UI surfaces this as a distinct, informative state instead of the misleading "Locked — will sync on next trigger" message that previously fired and never produced any work. **Intentional non-fix**: no marker clamp / re-stamp / clear. The chat-shrinkage case is rare and user-induced; auto-correcting silently would hide a likely user error (binding the wrong vectorization). UI clarity beats silent recovery.

**`refreshAutoSyncCheckbox(settings)`** fires on:
- AutoSync tab click
- `CHAT_CHANGED` event
- Initial load
- `vectfox:collections-updated` custom event
- `vectfox:eventbase-synced` custom event (after an ingestion run completes)

Resolution table:

| State | autoSync flag | Lock | Checkbox | LED | Status |
|---|---|---|---|---|---|
| `no-chat` | — | — | ❎ | 🟡 | "No chat loaded" |
| `no-collection` | — | — | ❎ | 🟡 | "Not initialized — vectorize chat first" |
| has-collection | false OR no lock | — | ❎ | ⚪ | "Auto-sync inactive" + counts |
| `vectorization-ahead` | true | locked | ✅ | 🟡 | "Vectorization is ahead of current chat — no auto-sync needed." + counts + gap + remediation hint |
| `partial` | true | locked | ✅ | 🟡 | "Locked — will sync to latest history on next auto-sync trigger" + counts |
| `fully-vectorized` | true | locked | ✅ | 🟢 | "Ready — fully synced" + counts |

The "counts" suffix shows `chat: N msgs · vectorization: M msgs` when both numbers are available — surfaces the backfill gap in `partial`, confirms parity in `fully-vectorized`, makes the ahead-of-chat condition visually obvious in `vectorization-ahead`.

**Change handler** (user clicks):

| Action | Behaviour |
|---|---|
| ✓ Check + no-chat | Toast warn, uncheck |
| ✓ Check + no-collection | Open Content Vectorizer (`'chat'`) |
| ✓ Check + partial | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + toast "will catch up" |
| ✓ Check + fully-vectorized | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + toast "fully synced" |
| ✗ Uncheck | `setCollectionAutoSync(registryKey, false)` + `clearAutoSyncMarker(uuid)` only. **Does NOT remove the chat lock** — the lock is a separate concern (retrieval activation / explicit user choice via the DB Browser), so disabling auto-sync must not deactivate the collection. Unlocking is the DB Browser's job. |

`registryKey` here is `status.registryKey` from `getChatAutoSyncStatus` — the canonical `"backend:id"` form. All four metadata read paths (this table, `refreshAutoSyncCheckbox`, `synchronizeChat`, `getChatAutoSyncStatus`) use the same form. After mutation, dispatches `vectfox:collections-updated` and re-runs `refreshAutoSyncCheckbox` so the LED updates.

## Manual vs auto-sync paths

UI elements that mirror lock state are pulled in two ways. The distinction matters because the manual paths have side effects.

| Trigger | Calls `.trigger('change')` | Lock mutation? |
|---|---|---|
| User clicks WI checkbox | (browser-native) | **Yes** — change handler removes/checks locks |
| User clicks Auto-Sync checkbox | (browser-native) | **Yes** — change handler removes/sets chat lock |
| User clicks "Active for current chat" in Collection Settings | (via Save button) | **Yes** — `saveActivation` mutates |
| `refreshWIStatus` auto-uncheck | **No** — `_setWIEnabled` uses `prop()` only | **No** — pure UI mirror |
| `refreshAutoSyncCheckbox` auto-state | **No** — direct `prop()` | **No** — pure UI mirror |
| `refreshActivationLockButton` after Manage Locks | **No** — direct `prop()` | **No** — re-reads state set by the dialog |

**Rule:** auto-sync paths must never invoke the change handler. Otherwise, opening the WI panel could trigger lock removal as a side effect of the UI sync.

## Custom events

| Event | Fired by | Listeners |
|---|---|---|
| `vectfox:collections-updated` | `saveActivation`, WI uncheck handler, Auto-Sync change handler | `refreshWIStatus`, `refreshAutoSyncCheckbox` |
| `vectfox:eventbase-synced` | `runEventBaseIngestion` at end of run | `refreshAutoSyncCheckbox` |

Plus ST's `CHAT_CHANGED` — same two refresh handlers re-run.

## Runtime activation chain (`shouldCollectionActivate`)

The runtime priority list in `core/collection-metadata.js`:

```
1. Pause button (enabled=false)          → BLOCKED
2. Activation Triggers match             → ACTIVE
3. Advanced Conditions pass              → ACTIVE
4. Chat lock match (currentChatId)       → ACTIVE
4. Character lock match (currentCharId)  → ACTIVE
5. Nothing matched                       → BLOCKED
```

There is **no global-scope priority**. That branch (formerly "priority 1.5") was removed when global was unwired. If you find yourself adding a `meta.scope === 'global'` check anywhere, stop — the migration handles legacy data, and there is no path that should produce a new `'global'` value.

## Key files

| File | Role |
|---|---|
| `core/collection-ids.js` | `buildRegistryKey`, `parseRegistryKey`, `resolveBackendForCollection`, `getBackendFromCollectionId`, `remapCollectionIdToBackend`, `normalizeBackendForId`, `KNOWN_BACKEND_LABELS` |
| `core/collection-metadata.js` | `isCollectionActiveForContext`, `setCollectionLock`, `removeCollectionLock`, `setCollectionCharacterLock`, `removeCollectionCharacterLock`, `setCollectionAutoSync`, `shouldCollectionActivate`, `getLock`, `setLock` |
| `core/collection-loader.js` | Migration (`scope='global'` → `'character'`), `loadAllCollections`, `getCollectionListing` |
| `core/core-vector-api.js` | `queryCollection` — the canonical per-collection-backend routing entry point |
| `core/eventbase-workflow.js` | `getChatAutoSyncStatus`, `isChatFullyVectorized`, dispatches `vectfox:eventbase-synced` |
| `core/content-vectorization.js` | Default `scope='character'`, no `'global'` fallback |
| `ui/database-browser.js` | Listing lock badge, `openActivationEditor`, `renderActivationEditor`, `refreshActivationLockButton`, `saveActivation` |
| `ui/ui-manager.js` | `refreshWIStatus` + `_setWIEnabled`, `refreshAutoSyncCheckbox`, WI checkbox handler, Auto-Sync checkbox handler, event listeners |
| `ui/content-vectorizer.js` | Scope picker without global, post-vectorization `refreshWIStatus` call |

## Things you should NOT do

- Don't call `.trigger('change')` from any refresh/auto-sync path. Use `prop('checked', x)` directly and persist settings inline.
- Don't probe the backend for checkbox state. Every state evaluator (`isCollectionActiveForContext`, `getChatAutoSyncStatus`) uses in-memory data only.
- Don't add `scope === 'global'` checks. The only legitimate reference is the one-time migration block in `loadAllCollections`.
- Don't duplicate `isCollectionActiveForContext` logic inline. If you need it in a new place, import it.
- Don't write directly to `lockedToChatIds` / `lockedToCharacterIds`. Use the `setCollectionLock` / `removeCollectionLock` / `setCollectionCharacterLock` / `removeCollectionCharacterLock` helpers — they maintain the `chat_lock_index` reverse map too.
- Don't pass bare collection IDs to `queryCollection` (in `core/core-vector-api.js`). The function routes by backend prefix internally via `resolveBackendForCollection`. Bare IDs work *only* when the backend can be detected from the ID structure — registry-key form is the canonical input.
- Don't hand-roll backend detection (`id.includes('_qdrant_') ? 'qdrant' : 'standard'`). Use `resolveBackendForCollection(id)` — it returns the bare collectionId you'll need for the backend call anyway.
