# Collections, Locks & Backend Routing — Canonical APIs

Single document covering everything related to collections: lock state, listing, registry-key construction, **backend routing for queries**, and the UI checkboxes that mirror lock state. Every piece reads from the same in-memory source of truth and writes back through a small, scope-aware set of helpers.

**Why this document is long:** collection routing is where VectFox's silent wrong-answer bugs come from: locks land in the wrong storage bucket, queries hit the wrong backend, persona ownership stamps don't match. Each comes from reimplementing a helper inline instead of importing it. This doc lists the canonical entry points so authors (human or AI) import them instead.

Read `Doc/collection_helper.md` before touching collection routing. It states the CURRENT contract only — git holds every earlier revision.

## ⚠️ Canonical APIs — USE THESE, DO NOT REIMPLEMENT

**Read this before writing any code that touches a collection.** These functions are the *only* entry points new code should call for collection listing, lock state, registry-key construction, and **per-collection backend routing**. They bundle backend disambiguation, persona/handle ownership, superadmin checks, and storage-key normalization. Re-implementing the logic inline gets it wrong almost every time — the failure mode is silent: locks land in the wrong storage bucket, queries hit the wrong backend, the UI shows nothing changed.

Code outside a feature imports these through the feature's `index.js` (`src/features/collections/index.js`, `src/features/eventbase/index.js`), adding a name there when outside code first needs it; `src/shared/collection-ids.js` is imported directly. `npm test` (`check:import-graph`) rejects a deep import into another feature's files.

| Function | File | Use when |
|---|---|---|
| **`getCollectionListing(settings)`** | [collection-loader.js](../src/features/collections/collection-loader.js) | You need to iterate every collection (rendering a list, finding matches by pattern, computing aggregate state). |
| **`resolveActiveEventBaseCollection(settings, chatUUID?)`** | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | You need *the one* active EventBase collection to READ for a chat (ownership-filtered + lock-aware). Use this instead of taking `[0]` from `findEventBaseCollectionsForChat`. |
| **`resolveEventBaseWriteTarget(settings, chatUUID?)`** | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | You are about to INGEST events, stamp the auto-sync marker, or report sync status. Same resolution, but the collection's embedded chat UUID must match and it must be registered on the current `vector_backend` — a foreign lock can widen ownership, never redirect writes. |
| **`getCollectionLocks(key)`** / **`getCollectionCharacterLocks(key)`** | [collection-metadata.js](../src/features/collections/collection-metadata.js) | You need the chats / characters *one* collection is locked to (lock dialog, badge, tooltip). |
| **`isCollectionActiveForContext(key, { chatId, characterId })`** | [collection-metadata.js](../src/features/collections/collection-metadata.js) | You need "is *one* collection locked to the current chat / character?" (badge, checkbox state). Activation itself goes through `shouldCollectionActivate`, which also weighs triggers and conditions. |
| **`setCollectionLock`** / **`removeCollectionLock`** / **`clearCollectionLock`**, and **`setCollectionCharacterLock`** / **`removeCollectionCharacterLock`** | [collection-metadata.js](../src/features/collections/collection-metadata.js) | You need to *change* one collection's locks (user clicks lock / unlock / clear). |
| **`buildRegistryKey(collectionId, settings)`** | [collection-ids.js](../src/shared/collection-ids.js) | You only have a bare collection ID and need to convert it to the canonical `"backend:id"` storage key (for any metadata read/write). Never hand-roll `` `${backend}:${collectionId}` `` — use this instead. |
| **`resolveBackendForCollection(input)`** | [collection-ids.js](../src/shared/collection-ids.js) | You have an ID (either registry-key or bare) and need to pick the right backend instance for it (query, delete, list, etc.). Returns `{ backend, collectionId }` where `collectionId` is the bare form. Replaces hand-rolled `parseRegistryKey(...).backend ?? settings.vector_backend` chains. |

### `resolveBackendForCollection(input)` — pick the right backend for a collection

```js
import { resolveBackendForCollection } from '../../shared/collection-ids.js';

const { backend, collectionId } = resolveBackendForCollection('qdrant:vf_lorebook_qdrant_rabbit_mychat_1779...');
// → { backend: 'qdrant', collectionId: 'vf_lorebook_qdrant_rabbit_mychat_1779...' }

const { backend: b2, collectionId: c2 } = resolveBackendForCollection('vf_eventbase_vectra_rabbit_your_wives_uuid');
// → { backend: 'vectra', collectionId: 'vf_eventbase_vectra_rabbit_your_wives_uuid' }
// (no `backend:` prefix on the input → detected from the ID's second segment)
```

Resolution order:
1. **Registry-key prefix wins** (`qdrant:` / `vectra:` / `standard:`) — the canonical form, which most call sites pass.
2. **Detect from ID structure** (`vf_<kind>_<backend>_…`) — for bare IDs: entries registered before registry keys existed, and callers that pass bare IDs.
3. **`{ backend: null, collectionId: bareForm }`** when both fail. Caller chooses whether to fall through to `settings.vector_backend`, throw, or warn.

**Always use this for routing.** The returned `collectionId` is the BARE form — backend methods (`StandardBackend.queryCollection`, `QdrantBackend.deleteVectorItems`, plugin REST endpoints) expect bare IDs and route on the `backend` field returned here.

**Why this matters:** routing by `parseRegistryKey(id).backend ?? settings.vector_backend` sends every bare ID to the user's default backend. With collections on two backends (a standard and a qdrant EventBase locked at once, common after persona switches or cross-backend imports), standard collections get queried through Qdrant → wrong physical location → 0 results, and qdrant collections through Standard → wrong API path → 0 results; the injected memory then comes only from collections that happen to sit on the default backend. TEST 013 covers this.

### `getCollectionListing(settings)` — listing iterator

```js
const entries = getCollectionListing(settings);
// entries: Array<{ registryKey, collectionId, backend, meta, isOwn, isActive }>
```

Built-in checks:
- Reads the registry, parses each `backend:id` key.
- `isOwn`: superadmin override OR `meta.creatorHandle` matches current persona handle OR, for an entry with no `creatorHandle` stamp, the bare ID contains `_<handle>_`.
- `isActive`: calls `isCollectionActiveForContext(registryKey, …)` internally — already keyed correctly.
- Call this **once** per render and reuse the array. Do not call `isCollectionActiveForContext` in a per-card loop.

### Lock state for one collection — read and change

```js
const key = collection.registryKey || collection.id;

getCollectionLocks(key);            // → ['chatId', …]       chats it is locked to
getCollectionCharacterLocks(key);   // → ['characterId', …]  characters it is locked to
isCollectionActiveForContext(key, { chatId: getCurrentChatId(), characterId: getContext()?.characterId });
// → true when it is locked to the current chat (scope 'chat') or character (scope 'character')

setCollectionLock(key, chatId);         // add a chat lock
removeCollectionLock(key, chatId);      // drop one chat lock; other chats keep theirs
clearCollectionLock(key);               // drop every chat lock
setCollectionCharacterLock(key, String(characterId));
removeCollectionCharacterLock(key, String(characterId));
```

- **Storage-key convention:** pass the registry-key form (`backend:id`). On a `collection` object from `findCollectionByKey` or `getCollectionListing`, use `collection.registryKey || collection.id`. These functions read and write exactly the key they are given — **no fallback to the other form**, so the wrong form gives wrong-state reads, not errors. When a lock may sit under either form (EventBase resolution, the auto-sync status), use `isCollectionActiveForContextAnyKey`.
- **Scope:** `getCollectionMeta` resolves every collection's scope to `'chat'` or `'character'` (`getEffectiveScope`: the stored value, else parsed from the ID), and `isCollectionActiveForContext` checks the matching list.
- **Ownership:** the lock functions do not check it. It is applied where collections are listed — `getCollectionListing`'s `isOwn` and the DB browser's persona filter — so lock controls are only offered on the persona's own collections (every collection under `superadmin`).
- The chat-lock writes keep the `chat_lock_index` reverse map (read by `getChatLockedCollections(chatId)`) in step with `lockedToChatIds`.

### What NOT to do

These patterns will look correct but produce broken state:

| Wrong | Right |
|---|---|
| `isCollectionActiveForContext(collection.id, …)` | `isCollectionActiveForContext(collection.registryKey \|\| collection.id, …)` |
| `setCollectionLock(collection.id, chatId)` | `setCollectionLock(collection.registryKey \|\| collection.id, chatId)` |
| Iterating the registry + checking `creatorHandle.toLowerCase() === handle` inline | `getCollectionListing(settings).filter(e => e.isOwn)` |
| Iterating collections + calling `isCollectionActiveForContext` per card | `getCollectionListing` once → use `entry.isActive` |
| Reading `extension_settings.vectfox.collections[bare_id]` directly | `getCollectionMeta(registryKey)` (storage is keyed by `backend:id`) |
| Auto-resolving bare ID → registry-key by scanning the registry | Caller passes the canonical form; there is no auto-resolve scan, because one would mask wrong-form callers |
| `isCollectionAutoSyncEnabled(collectionId)` — bare ID — silently returns `false` even when the UI shows checked (UI writes via registryKey, this reads from a *different bucket*) | `isCollectionAutoSyncEnabled(registryKey)` — same form the UI + every write path uses |
| `` `${getRegistryBackend(settings.vector_backend)}:${collectionId}` `` hand-rolled at every call site (drift bait — one site forgets and the bug above surfaces) | `buildRegistryKey(collectionId, settings)` |
| `shouldCollectionActivate(collectionId, context)` with bare `collectionId` — its internal `getCollectionMeta` and `isCollectionLockedToChat` calls both read from `extension_settings.vectfox.collections[id]`, which is keyed by `backend:id` form. Passing bare ID returns empty defaults; lock checks always return `false`, so every collection looks unlocked and nothing activates correctly. | `shouldCollectionActivate(entry.registryKey, context)` where `entry` comes from `getCollectionListing(settings)` |
| `queryCollection(collection.collectionId, ...)` — passing the bare ID. `queryCollection`'s `parseRegistryKey` returns `backend=null`, then it falls back to `settings.vector_backend` (the user's *default* backend). On mixed-backend setups this silently queries the wrong backend → 0 results, or worse, returns content from a *different* collection that happens to be on the default backend. TEST 013 covers this. | `queryCollection(collection.registryKey, ...)` — the registry-key form lets `resolveBackendForCollection` pick the right backend per-collection. |
| `liveCollectionIds: lockedLiveCollections.map(c => c.collectionId)` — destructuring `.collectionId` off a `_gatherLockedEventBaseCollections` result. The object has BOTH `.collectionId` (bare) and `.registryKey` (canonical) — picking the wrong one cascades the bare-ID bug down to every consumer (retrieveEvents, retrieveEventsForTurn). | `liveCollectionIds: lockedLiveCollections.map(c => c.registryKey)` — same pattern, right field. |
| `parseRegistryKey(id).backend ?? 'qdrant'` (or `?? settings.vector_backend`) hand-rolled — silently misroutes bare IDs that *do* have a detectable backend in the ID structure. | `resolveBackendForCollection(id)` — tries registry-key prefix first, then ID-structure detection, then returns `null` so the caller knows resolution failed. |

## Pause/Resume button — `enabled` flag

Separate concern from locks. It's a per-collection hard kill switch — when `false`, that one collection is blocked from any activation regardless of locks, triggers, or scope.

> **Do not confuse with the global master switch.** This pause flag is **per-collection**, stored at `extension_settings.vectfox.collections[registryKey].enabled` and read via `isCollectionEnabled(registryKey)`. The VectFox master switch is a **different key** — top-level `extension_settings.vectfox.enabled`, read via `isVectFoxEnabled()` ([feature-gate.js](../src/shared/feature-gate.js)) — and gates *all* runtime work (retrieval injection, auto-sync, lorebook WI) globally. Same word, different scope and different storage path.

- **UI:** Play/pause icon on each collection card in the Database Browser
- **Write:** `setCollectionEnabled(collection.registryKey || collection.id, false)` → stores `{ enabled: false }` under `extension_settings.vectfox.collections[registryKey]`
- **Read:** `isCollectionEnabled(registryKey)` in `src/features/collections/collection-metadata.js` — pass the registry-key form, not bare ID
- **Default:** `true` (enabled) when no metadata exists
- **All collections use the same key form** — `backend:id`. EventBase collections are registered as `${registryBackend}:${collectionId}` in `eventbase-store.js`, not as plain IDs. The `data-collection-key` attribute on every card is always `collection.registryKey || collection.id`.

## Async runtime activation — `shouldCollectionActivate`

Used by any code path that must decide at runtime whether a collection is currently in scope, respecting triggers, advanced conditions, and manual locks. The semantic WI lorebook search path (`world-info-integration.js`) is the canonical example.

**Must receive the registry-key form.** Internally calls `getCollectionMeta(id)` and `isCollectionLockedToChat(id, chatId)`, both of which read from `extension_settings.vectfox.collections[id]` — keyed by `backend:id`. Passing a bare collection ID silently gets empty defaults and lock checks always return `false`.

**Canonical pattern:**

```js
import { getCollectionListing, shouldCollectionActivate } from '../collections/index.js';

const listing = getCollectionListing(settings);
const currentChatId = getCurrentChatId() ? String(getCurrentChatId()) : null;
const currentCharacterId = getContext().characterId != null ? String(getContext().characterId) : null;
const context = { currentChatId, currentCharacterId, recentMessages };   // recentMessages (newest first) lets triggers match

for (const entry of listing) {
    if (!entry.collectionId.startsWith('vf_lorebook_')) continue;
    if (entry.meta.enabled === false) continue;                           // paused
    if (!(await shouldCollectionActivate(entry.registryKey, context))) continue;  // out of scope
    // entry.registryKey is correct for all subsequent getCollectionMeta calls
}
```

Gate chain inside `shouldCollectionActivate` — every gate that applies must pass:
```
1. enabled=false                → BLOCKED (pause button)
2. Lock                         → BLOCKED unless currentChatId is in lockedToChatIds
                                  or currentCharacterId is in lockedToCharacterIds
3. Activation Triggers, if set  → BLOCKED unless a keyword matches recentMessages
4. Advanced Conditions, if set  → BLOCKED unless the rules pass
5. Every gate above passed      → ACTIVE
```

**Important:** the lock is the master switch, for semantic WI as for every other collection. Triggers and conditions only narrow a locked lorebook; an unlocked lorebook is out of scope and will not be searched, whatever its triggers.

## ⚠️ Embedding model resolution — `getModelFromSettings`

Sibling principle to the canonical APIs above — same "use the one helper, never reimplement inline" rule, different domain. Lives in this doc because the model is part of the **storage-key contract** for every collection: vectra partitions chunks by model on disk, so insert and query must agree on the model value or the read silently misses.

The settings object stores the embedding model under **provider-specific** field names: `embedding_openrouter_model`, `embedding_ollama_model`, `embedding_vllm_model`, `cohere_model`, etc. (the provider selection itself is `settings.embedding_provider`). There is **no flat `settings.model`** — that key is always empty/undefined. Code that reads `settings.model` directly silently produces the wrong value (empty string) without throwing.

**Always use** [`getModelFromSettings(settings, fallback?)`](../src/features/embedding/providers.js) from `src/features/embedding/providers.js`:

```js
import { getModelFromSettings } from '../embedding/index.js';

const model = getModelFromSettings(settings);              // → 'qwen/qwen3-embedding-8b' for openrouter
const modelOrNull = getModelFromSettings(settings, null);  // null when provider has no model field
```

It internally calls `getModelField(settings.embedding_provider)` to look up the right field name, then reads that field.

### Why this matters

Every site that sends a `model` to the plugin API (`chunks/insert`, `chunks/list`, `chunks/query`, `get-embedding`) is part of the **storage-key contract**. Inserts under `model='qwen/qwen3-embedding-8b'` must be queried under the same `model` value or the plugin's per-model partitioning silently returns 0 results. The symptom is "vectra returns 0 results while qdrant works": qdrant does not partition by model, vectra does.

### What NOT to do

| Wrong | Right |
|---|---|
| `model: settings.model` (flat key — always empty) | `model: getModelFromSettings(settings)` |
| `settings.model \|\| ''` | `getModelFromSettings(settings)` |
| `settings[getModelField(settings.embedding_provider)] \|\| null` (one-liner with manual fallback) | `getModelFromSettings(settings, null)` |
| `const modelField = getModelField(s.embedding_provider); s[modelField] \|\| ''` (4-line inline expansion) | `getModelFromSettings(settings)` |
| Defining a local `getModelFromSettings` private helper | Import the canonical one |

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

Call the highest tier that covers your use case:

| Tier | Function | Use when |
|---|---|---|
| **All collections** | `getCollectionListing(settings)` | Render loop, aggregate state. Use `entry.isActive` (and `entry.isOwn`) — no per-card calls needed. |
| **One collection** | `isCollectionActiveForContext(registryKey, { chatId, characterId })` | One collection: the lock switch in Collection Settings (`collection-dialogs.js`). `getCollectionListing` calls it per entry; do not call it per card in a loop. |
| **One collection, either key form** | `isCollectionActiveForContextAnyKey([registryKey, collectionId], { chatId, characterId })` | Same single-source check, but tolerant of both key forms when a lock/scope may be stamped under either the registry-key or the bare id (EventBase read/write resolution, auto-sync status). Returns true if active under ANY form. Use this instead of re-spreading `isCollectionLockedToChat` across call sites. |
| **Lock lists** | `getCollectionLocks(registryKey)` / `getCollectionCharacterLocks(registryKey)` | The chats / characters one collection is locked to (Manage locks, `collection-dialogs.js`). |

`isCollectionActiveForContext` returns `true` based on the collection's scope:
- `scope='chat'` → `chatId` is in `lockedToChatIds`
- `scope='character'` → `characterId` is in `lockedToCharacterIds`
- anything else → `false` (there is no global scope; a stored `global` is rewritten to `character` on load — see below)

## Scope handling — `getEffectiveScope` is the canonical resolver

The scope of a collection (`'chat'` vs `'character'`) controls which lock kind the Collection Settings lock switch writes (`writeLockHere`), which list `isCollectionActiveForContext` reads, and what the switch is called (`lockSwitchState`). Get it wrong and locks silently fail to persist.

**Use the canonical resolver, never branch on bare `meta.scope`:**

```js
// Inside the collections feature; code outside it imports through '../collections/index.js'.
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

Returns `'chat'` or `'character'` only — never `null`, `undefined`, or `'unknown'`.

### Why `getCollectionMeta` auto-resolves scope

`getCollectionMeta` runs `getEffectiveScope` on every read so downstream callers don't have to remember the defensive pattern. Cheap when stored scope is already valid (single string compare); it parses the ID only when no valid scope is stored. That removes the class of "bare `meta.scope === 'chat'` silently misses null/unknown" bugs.

### Rules for new code

- ✅ **Use `getCollectionMeta()`** to read scope — its result is always valid.
- ✅ **Use `getEffectiveScope(id, payload)`** explicitly when the meta comes from an untrusted source (export file, network response).
- ❌ **Don't set `defaultCollectionMeta.scope` to `'unknown'`.** The default is `null`; the resolver fills it in.
- ❌ **Don't write `'unknown'` to `meta.scope`** anywhere on disk. If scope can't be determined, leave the field absent and let the resolver derive it from the ID.
- ❌ **Don't write a new "scope helper"** with `if (meta.scope === ...) return ... else parseFromId ... else default`. That's `getEffectiveScope` — import it; a private variant drifts from it. SigMap finds it (see CLAUDE.md for the workflow).

### Collections with a stored `'unknown'` scope (corrected at read time)

Collections saved by older versions may have `scope: 'unknown'` on disk. They keep working:
- `getCollectionMeta` runs the merged value through `getEffectiveScope` before returning, so `meta.scope` reads as `'chat'` or `'character'`.
- No data migration needed — the read path corrects every access.
- The stored `'unknown'` string stays on disk until the next `setCollectionMeta` call overwrites it. Harmless.

TEST 005/006/007 cover the standard-backend no-plugin path, including the lock checkbox flow.

## No global scope

`scope='global'` is not a valid value. The Vectorize Content modal offers only `Character` (default) and `This Chat`.

1. **`COLLECTION_SCOPES`** in `src/shared/collection-ids.js` holds `CHARACTER`, `CHAT` and `UNKNOWN` (the unparseable-input sentinel).
2. **`parseCollectionId` returns the canonical scope:**
   - `vf_lorebook_*` / `vf_document_*` / `vf_character_*` → `'character'`
   - `vf_eventbase_*` / `vf_archiveevent_*` → `'chat'`
3. **A stored `scope: 'global'` is rewritten on load** by `loadAllCollections`:
   ```
   storedMeta.scope === 'global'  →  setCollectionMeta(writeKey, { scope: 'character' })
   ```
   It is the only `'global'` check in the code, kept for user data that still holds the value. Do not remove it.

A rewritten collection has no character lock. It stops activating until the user switches "Active for this character" on again in Collection Settings, which calls `setCollectionCharacterLock(collectionKey, String(currentCharacterId))`.

**Rule for new code:** never reintroduce `scope === 'global'` branches anywhere. If you need to handle stored data that *might* contain `'global'`, route it through `getEffectiveScope` — the canonical resolver folds every invalid value into `'character'` or `'chat'`.

## DB Browser — the Active here pill in the listing

In `src/features/database-browser/database-browser.js`, `renderCollections` calls `getCollectionListing(settings)` once and keys each entry's `isActive` (computed there with `isCollectionActiveForContext(registryKey, ...)`) by registry key and by bare ID. The "Active here only" filter and every row read that lookup; no row calls `isCollectionActiveForContext` itself. An active row shows the Active here pill and a line from `activeHereLine` naming the lock that matched: this chat, this character, or both, and how many other chats it is locked to. It names the lock that matched, not the one its scope implies, since `shouldCollectionActivate()` takes either lock whatever the scope.

## DB Browser → Collection Settings → the lock switch

In `src/features/database-browser/collection-dialogs.js`:

| Function | Role |
|---|---|
| `lockAreaView` | The switch's state (`isCollectionActiveForContext`), its wording by scope (`lockSwitchState`) and the lock summary (`lockSummary`), the last two in `collection-settings-core.js` |
| `editCollectionSettings` | Sets the switch from that view, and again after Manage locks closes |
| `saveCollectionSettings` | Writes the lock on Save, only when the switch was moved |
| `writeLockHere` | The lock it writes, by scope |

**`writeLockHere` lock mutation:**

```
scope='chat'      + on  →  setCollectionLock(collectionKey, currentChatId)
scope='chat'      + off →  removeCollectionLock(collectionKey, currentChatId)
scope='character' + on  →  setCollectionCharacterLock(collectionKey, String(currentCharacterId))
scope='character' + off →  removeCollectionCharacterLock(collectionKey, String(currentCharacterId))
```

The switch shows on when any lock matches here, a chat lock or a character lock, so Save writes only when the user moved it. A switch shown on for a lock of the other kind must not add one of its own. Without the chat or character its scope locks to, the switch is off limits and Manage locks is the way in. Character 0 is a character: only a missing id means none.

`collectionKey` is the registry-key form (`backend:id`): the browser passes `collection.registryKey || collection.id`.

Each call only touches the lock for the **current** chat/character. Other chats or characters that have this collection locked keep their entries intact — `removeCollectionLock` filters by id, doesn't wipe the list.

## WorldInfo page — the "Use in this chat" switch

In `src/features/settings-panel/settings-panel.js`; [worldinfo-page-markup.js](../src/features/settings-panel/worldinfo-page-markup.js) builds the page and its status.

**`refreshWIStatus`** (auto-sync from events) fires on:
- WorldInfo tab click
- After lorebook vectorization completes
- `vectfox:collections-updated` custom event
- `CHAT_CHANGED` event
- Initial load

It computes `activeIds` by filtering own-persona lorebooks (creatorHandle stamp) through `isCollectionActiveForContext`, then drives the switch through an inline `_setWIEnabled(bool)` helper and the status through `worldInfoStatusMarkup`:

| Result | Switch | Tone | Status |
|---|---|---|---|
| 0 lorebooks (this persona) | off | warning | "No lorebook vectorized yet. Vectorize Content on the Action page stores one." |
| 0 active | off | warning | "No lorebook is locked to this chat. Lock one in Database Browser → Collection Settings." |
| ≥1 active | on | success | "Active for this chat: <names>" |

**Critical:** `_setWIEnabled` calls `prop('checked', enabled)` directly. It does **not** call `.trigger('change')`. This is load-bearing — see "Manual vs auto-sync paths" below.

**Manual change handler** (the user turns the switch):

| Action | Behaviour |
|---|---|
| On + no own lorebooks | Back off, info toast, open Content Vectorizer (`'lorebook'`) |
| On + no active | Back off, info toast, open DB Browser |
| On + ≥1 active | Persist `enabled_world_info=true`, show the Matching card |
| Off | For each currently-active own lorebook, remove the lock making it active (chat or character per scope). Dispatch `vectfox:collections-updated`. Persist `enabled_world_info=false`, hide the Matching card. |

## Auto-sync — the "Auto-sync this chat" switch

### The smart marker — what makes auto-sync correct

Before reading the rest of this section, internalize this: **the window fingerprint cache is what prevents auto-sync from re-extracting the entire chat on every trigger**. Without it, the cost of running auto-sync would grow linearly with chat length on every single message — every trigger would re-process every window from the top. The fingerprint cache is the "smart marker" that lets auto-sync only do the *new* work.

The cache lives in [`src/features/eventbase/eventbase-store.js`](../src/features/eventbase/eventbase-store.js). Four functions form the contract:

| Function | Role in auto-sync |
|---|---|
| `markWindowExtracted(sourceHashes, chatUUID)` | Called by `runEventBaseIngestion` after each window is successfully extracted. Writes the fingerprint to both the in-memory `_windowCacheSet` AND the persisted `extension_settings.vectfox.eventbase_extracted_windows[chatUUID]` array, takes the window off the unfinished record, then calls `saveSettingsDebounced()`. Survives page reload. |
| `markWindowUnfinished(sourceHashes, chatUUID)` | Called by `runEventBaseIngestion` for each window that failed or timed out. Writes the fingerprint to `extension_settings.vectfox.eventbase_unfinished_windows[chatUUID]`. See "When a window fails" below. |
| `isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID)` | Per-window dedup gate inside the ingestion loop. Returns `set.has(fp)` from the in-memory Set — synchronous, O(1). `messageIds` and `settings` are kept for API compat but ignored. |
| `isLastWindowExtracted(messages, windowSize, step, chatUUID, hashFn)` | Quick-exit gate at the top of `runEventBaseIngestion`. If the last possible window for the current message count is already in the cache, ingestion no-ops immediately without building the window list. This is the cheapest possible "is there anything new?" check. It says nothing about earlier windows, because a run carries on past a failed one. |

User scenario the cache makes safe:

1. User vectorizes a chat at 2 messages — window `[0-1]` extracted. `markWindowExtracted` records its fingerprint.
2. User replies twice — chat now has 6 messages. Two new windows `[2-3]` and `[4-5]` exist on disk but are unmarked in the cache.
3. User turns on "Auto-sync this chat". Next trigger calls `runEventBaseIngestion`.
4. `isLastWindowExtracted` checks `[4-5]` against the cache → not present → returns false → ingestion runs.
5. The ingestion loop iterates windows. For `[0-1]`, `isWindowAlreadyExtracted` returns true → skipped (no LLM call, no duplicate event). For `[2-3]` and `[4-5]`, returns false → LLM extracts events, `markWindowExtracted` records each fingerprint.
6. Next trigger: `isLastWindowExtracted` against `[4-5]` returns true → quick-exit → no work done.

**When a window fails.** A failed window is only absent from the cache, while the windows after it are present, so the quick-exit and the tip cannot see it. The unfinished record exists to say so:

1. **Same run.** A window that fails or times out goes on the record and the run carries on. A provider rejection, a parse failure, a reply cut at the token limit, and a reply with no valid event all count as failing. When all windows are through, the run sends the failed ones again, up to 2 more passes, after 5s and 10s. It stops early when a pass got nothing through and more than 8 windows failed, because that points at the provider rather than at those windows.
2. **Still failing.** The window stays on the record. The progress panel and a sticky toast report it, and the auto-sync status on the AutoSync page names it.
3. **Later runs.** A manual run does not take the quick-exit while its window size has windows on the record, so Resume reaches them. Auto-sync keeps the quick-exit and sends them when the next turn commits, but only those at or after its start marker. Neither run uses the tip fallback while the record has such windows. A window already on the record when a run begins gets one send in that run, so one that always fails does not cost three calls every time.
4. **Off the record.** Success takes a window off. A manual run also drops windows the chat no longer has, because a message in them was edited or deleted, and `clearExtractionCachesForChat` drops the whole record.

A fatal error (bad key, bad model) stops the run with no re-send, but its window still goes on the record.

**Test coverage**: see TEST 014 in `tests/Eventbase-test.spec.js`, and `tests/eventbase-window-resend.test.js` for failed windows. The full storage shape (two-tier persisted-array + in-memory-Set) and the rationale for *why* it's two-tier is in [Doc/dev_helper.md §4](dev_helper.md).

### Second safety layer — the start marker (window-size-change protection)

The fingerprint cache above is **window-size-dependent**: a window's fingerprint includes the message hashes it covers, so the fingerprint for `[0-1]` at `windowSize=2` does NOT match `[0-3]` at `windowSize=4`. If a user vectorized a long chat at one window size and then changes the setting before enabling auto-sync, every fingerprint silently misses and the cache devolves into "extract everything from message 0 again" — exactly the failure mode the cache exists to prevent.

The **auto-sync start marker** is the second gate that catches this case. It's a message-index threshold per chat that says "auto-sync should only process windows whose `start >= marker`." Three functions in [`src/features/eventbase/eventbase-store.js`](../src/features/eventbase/eventbase-store.js):

| Function | Role |
|---|---|
| `stampAutoSyncMarker(chatUUID, settings, options?)` | Called from the auto-sync switch's handler when the user turns auto-sync on (and re-called when the window-size setting changes while auto-sync is on). Smart placement: if the EventBase collection has existing events → `marker = max(source_window_end) + 1`; if empty → `marker = current chat length`. Pass `{ floor: 'chatLength' }` to force from-now-on placement regardless of coverage (the enable-time "Just keep up from here" choice). Persists to `extension_settings.vectfox.eventbase_autosync_start_marker[chatUUID]` and calls `saveSettingsDebounced()`. |
| `getAutoSyncMarker(chatUUID)` | Read by `runEventBaseIngestion` to gate the window list. Returns `undefined` when no marker is stamped (manual runs and pre-auto-sync chats). |
| `clearAutoSyncMarker(chatUUID)` | Called when auto-sync is disabled so re-enabling later re-computes a fresh marker against the current chat state. |

The filter is at [`src/features/eventbase/eventbase-workflow.js`](../src/features/eventbase/eventbase-workflow.js):

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

Auto-sync **catches up the whole gap** (tip → now) on its next trigger — it does *not* "start from now" by default. For a large gap that next trigger is a surprise burst of LLM calls, so the enable handler ([settings-panel.js](../src/features/settings-panel/settings-panel.js) → `#VectFox_autosync_enabled` `input`) gates it:

1. Compute pending windows: `countWindowsBehind(commitBoundary, getVectorizationTip(uuid), getAutoSyncWindowSize(settings))`, where `commitBoundary` is `status.commitBoundary` (chat length minus the held-back active turn — see the settle/commit lag layer). Clamping the backlog to the committed boundary keeps the deliberately-unextracted active turn from being counted as backfill.
2. If at least `FAR_BEHIND_WINDOW_COUNT` (5) windows, `callGenericPopup(CONFIRM, …)` — **Catch up now** vs **Just keep up from here** (X/Esc reverts):
   - *Catch up now* → `backfillCurrentChatWithProgress()` ([content-vectorizer.js](../src/features/chunkbase/content-vectorizer.js)) runs the Continue path with the standard progress UI (full-screen on mobile), then the marker lands at the freshly-advanced tip (smart placement).
   - *Just keep up from here* → `stampAutoSyncMarker(uuid, settings, { floor: 'chatLength' })` skips the backlog.
3. Below threshold → enable silently (a small gap catches up on the next trigger).

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
// src/features/eventbase/eventbase-workflow.js
getCommitBoundary(messages, settings)
//  → settings.eventbase_autosync_settle_lag === false ? messages.length
//  : max(0, messages.length - getAutoSyncWindowSize(settings))   // hold back one turn
```

`runEventBaseIngestion` slices its window-builder **and** its quick-exit to `messages.slice(0, commitBoundary)` on auto-sync runs (`isAutoSync === true`); manual Vectorize Content / backfill ignores the lag and covers the whole chat. Crucially, `getChatAutoSyncStatus` evaluates `isChatFullyVectorized` against the **same committed slice** — so "fully synced" means *all committed windows extracted*, not *the active turn extracted*. Without that, the deliberately-unextracted active turn would keep the status on Behind forever.

Because un-kept swipes only ever live on the active turn (which is past the boundary), they never reach the window-builder → **zero embeddings for discarded generations**. When the user sends the next turn, the previously-active turn falls inside the boundary and extracts exactly once.

- **On by default, no downside in practice:** the held-back turn is always the newest message, hence always inside ST's live context window — retrieval never needs it. A chat whose tail was already extracted shows no gap (the monotonic tip covers it). Design: `InternalProject/Vectfox/plans/executed/autosync-settle-lag.md`.
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

The auto-sync start marker is stamped *once* at enable time and never advances as new windows extract, so it cannot serve as the UI count. The vectorization tip (`max(source_window_end) + 1` for the chat) is the live value: `setVectorizationTip` keeps it in memory and persists it to `extension_settings.vectfox.eventbase_vectorization_tip[chatUUID]` (backend-agnostic), and `getVectorizationTip` warms the in-memory cache from that map after a reload. When neither holds a value, which deleting or importing the collection brings about, `ensureVectorizationTip` probes the backend via `listChunks`; the probe works for Qdrant and Standard+plugin. For Standard without the similharity plugin it returns `null` (the native fallback returns hashes, no metadata), so the UI falls back to `markerValue` until the next ingestion run sets the tip.

A saved tip can also be older than its collection, because SillyTavern saves the whole settings file from whichever tab saves last: a tab left open or a restored backup puts back an old one. So `getChatAutoSyncStatus` has a known tip at least `FAR_BEHIND_WINDOW_COUNT` windows behind the sync boundary read against the backend, once per chat per page load, the same line at which the enable flow asks before catching up. A higher reach raises the tip and drops the window record, which would otherwise make Resume start where it ends. The check only raises: windows with no events leave nothing in the backend, so it can prove a tip too low but never too high. It keeps the tip when the events at the collection's end are older than events below the tip, because that is a Reset & Vectorize stopped part way, and Resume has to carry on from there.

| Function | File | Notes |
|---|---|---|
| `getVectorizationTip(chatUUID)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Sync; returns the in-memory tip, else the persisted one (warming the cache), else `undefined`. UI falls back to `markerValue` when undefined. |
| `setVectorizationTip(chatUUID, tip)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Sync, monotonic max in memory and in the persisted map — out-of-order calls won't regress. Called by `runEventBaseIngestion` after every successful window via `setVectorizationTip(uuid, win.end + 1)`. |
| `clearVectorizationTip(chatUUID)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Clears the in-memory and persisted tip. Call when deleting, importing or clearing EventBase for a chat (parity with `clearAutoSyncMarker`). |
| `ensureVectorizationTip(chatUUID, collectionId, settings, syncProgress?)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Async. Returns the known tip at once (in-memory or persisted), unless `syncProgress` (`{ commitBoundary, windowSize }`) shows it far behind, which checks it as above. With no known tip it probes the backend once, caches the result in memory only, and returns it. Returns `null` when the collection has no events. Called by `getChatAutoSyncStatus`, which passes `syncProgress`, and by the ingestion fast-forward, which does not. |
| `countWindowsBehind(commitBoundary, tip, windowSize)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Whole Auto-sync windows between a tip and the sync boundary, for the enable flow and the far-behind check. |

### Last-used window size — window-size-change detection for Continue

Persists the `windowSize` of the last ingestion run that extracted windows. Vectorize Content → Continue checks it through `checkWindowSizeChanged` to warn before a window-size change re-extracts, and the branch fork carries it over to the new collection.

| Function | File | Notes |
|---|---|---|
| `getLastUsedWindowSize(chatUUID)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Reads from `extension_settings.vectfox.eventbase_last_used_window_size[chatUUID]`. Returns `undefined` when no prior run. |
| `setLastUsedWindowSize(chatUUID, windowSize)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Stamped by `runEventBaseIngestion` after a successful run with `windowsProcessed > 0`. Do not call from application code. |
| `checkWindowSizeChanged(chatUUID, currentSize)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Compares the current window size with the last-used one. Use it instead of comparing `getLastUsedWindowSize(…)` inline. |

### Collection resolver — find the EventBase collection for a chat

> **Naming convention (apply going forward):**
> `resolve…` returns **the one** active/canonical answer (or `null`).
> `find…`/`list…` return **all** candidates (an array).
> `get…` reads a stored value; `is…`/`has…` return a boolean.
> Pick the verb that matches the contract so callers don't have to read this doc.

**A chat UUID can map to MULTIPLE EventBase collections** — one per persona/handle
(`name1`), plus imported archives registered under a different name. Code that
assumes one collection per backend reads a stale import instead of the active
collection; the **lock** says which one is active.

| Function | File | Use when |
|---|---|---|
| `resolveActiveEventBaseCollection(settings, chatUUID?, { requireUuidMatch?, shouldLogResolution? })` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | **Default choice for READS.** Returns `{ collectionId, registryKey }` for the single **active** collection — ownership-filtered (via `getCollectionListing`) and lock-aware (matches the DB Browser's "Active here only"). Returns `null` when none. Logs `[EventBase][resolve]` lifecycle diagnostics (candidates + pick) unless `shouldLogResolution: false`. Used by `buildSummarizerInjection`. |
| `resolveEventBaseWriteTarget(settings, chatUUID?, { shouldLogResolution? })` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | **Required for WRITES.** Thin wrapper passing `requireUuidMatch: true`. Used by `runEventBaseIngestion`, `synchronizeChat`, `stampAutoSyncMarker`, and `getChatAutoSyncStatus`. Returns `null` on a chat's first ingestion on the current backend — callers fall through to `buildEventBaseCollectionId`. |
| `findEventBaseCollectionsForChat(uuid, preferredBackend)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Only when you genuinely need **every** candidate (e.g. pausing auto-sync on all of a chat's collections, or a has-data fallback probe). Returns `Array<{ collectionId, registryKey }>`, lock-ranked first. Pass `getRegistryBackend(settings.vector_backend)` as `preferredBackend`. **Do not** take `[0]` to mean "the active one" — call `resolveActiveEventBaseCollection` for that. Returns `[]` when no collection exists yet. |

#### Eligibility rules inside `resolveActiveEventBaseCollection` — on READS an explicit lock is a FULL override

A collection qualifies as the chat's active EventBase collection in **one of two** ways. Do not collapse these into a single "lock AND uuid" gate: retrieval would then ignore a locked collection whose embedded UUID has drifted (see below).

1. **Explicit per-chat lock → eligible unconditionally.** If the collection is locked to the current chat (`isCollectionActiveForContextAnyKey([registryKey, collectionId], { chatId })`), it is the active collection **regardless of ownership and regardless of whether its embedded UUID still matches this chat.** A lock is a deliberate user override.
2. **Auto-association (no lock) → must be owned AND UUID-matching.** Only when there is no lock does the resolver require `isOwn` *and* a match against the chat's UUID patterns (`matchesPatterns`).

**Why the lock must bypass the UUID match on reads (not just ownership):** the collection ID bakes in the chat UUID at creation time, but the live chat UUID can **drift** away from it — e.g. after a delete + re-vectorize cycle, or when the user intentionally binds another chat's EventBase here (branch/duplicate sharing). The lock survives that drift; the UUID embedded in the ID does not. Requiring a UUID match on the read path would make the collection show **ACTIVE** in the DB Browser (lock-only badge) while retrieval ignored it.

On the **write** path the mirror-image outcome is correct, not a bug: a chat whose only EventBase collection is a foreign one locked in for retrieval shows that collection as ACTIVE (its events ARE retrieved here) *and* reports **"no collection → vectorize first"**, because this chat genuinely has nowhere of its own to write yet. Vectorizing then creates it.

**Invariant — keep these three lock checks consistent, they must all agree:**
- the DB Browser "Active here" badge (`isCollectionActiveForContext`, lock-only),
- the retrieval gather (`_gatherLockedEventBaseCollections`, lock-only, no UUID check),
- and `resolveActiveEventBaseCollection` (rule 1 above) — reads only; see the write-target carve-out below.

**Rule 1 applies to READS ONLY.** `resolveEventBaseWriteTarget` (`requireUuidMatch: true`) replaces rule 1 with: *eligible when the registry-key backend equals `getRegistryBackend(settings.vector_backend)` AND the embedded UUID matches AND (locked OR owned)*. The lock still widens **ownership** — an imported or other-persona collection for this chat is a valid write target — it just cannot redirect ingestion into a **different conversation's** collection or a **different backend's** collection.

**Why writes must stay on the current backend:** every write caller passes only the bare `collectionId` to the backend chosen by `settings.vector_backend`. A `vectra:vf_eventbase_standard_…` collection still locked to the chat after switching to Qdrant would be re-created in Qdrant under its Vectra name (`qdrant:vf_eventbase_standard_…`), so the DB Browser shows a Qdrant collection labelled `standard`. Rejecting it makes the chat report "no collection" on the new backend, and vectorizing creates a correctly named `vf_eventbase_qdrant_…` collection.

**Why writes cannot follow a foreign lock:** locking chat A's EventBase into chat B is the supported way to retrieve A's events while playing B. If ingestion honored that lock, B's events land in A's collection, where the two chats' independent `source_window_end` values collide inside one sort frame — `_orderEventsForPresentation` groups by `_sortFrame` (the collection ID), so one collection means one frame and the injected timeline interleaves both conversations. `ensureVectorizationTip` then reads A's tip (a message index in A) and skips every window in B: the "Resume extracted 0 events" report.

Group chats are unaffected: all speakers share one chat UUID, so their collections satisfy the UUID match regardless of which `name2` was live when the ID was built.

**Ranking among eligible collections**, most significant tier first: lock, then own-UUID, then current backend. The own-UUID tier is load-bearing when a chat has both its own collection and a foreign one locked in — without it both tiers score equal and the winner falls to registry insertion order, which flips silently the first time a collection is deleted and re-registered.

### Low-level fingerprint cache management

Called internally by the ingestion loop. Do not call from application code; reimplementing them inline breaks dedup.

| Function | File | Notes |
|---|---|---|
| `windowFingerprint(sourceHashes)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Deterministic sorted-join of message hashes. **Window-size dependent** — a fingerprint from `windowSize=2` never collides with one from `windowSize=4`, which is why the start marker is needed as a second safety layer. |
| `clearWindowCacheForChat(chatUUID)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Evicts the in-memory fingerprint Set for a chat. Use when a collection is deleted or imported. Do NOT call on window-size change — that would force full re-extraction; use `stampAutoSyncMarker` instead. |

### Auto-sync entry points

| Function | File | Role |
|---|---|---|
| `synchronizeChat(settings, batchSize, triggerEvent)` | [chat-vectorization.js](../src/features/chunkbase/chat-vectorization.js) | The auto-sync coordinator. Gates on **the write target only** — `resolveEventBaseWriteTarget(settings, uuid)` then `isCollectionAutoSyncEnabled(active.registryKey)` — NOT a `.some()` across every collection (a leftover `autoSync=true` on a non-active sibling would fire while the toggle shows off). Then calls `runEventBaseIngestion({ isAutoSync: true, collectionIdOverride: active.collectionId })`. **The override is load-bearing**: it pins the write target to the resolved active collection so a group chat doesn't manufacture a new per-speaker collection each turn. Called from ST event hooks (MESSAGE_SENT, MESSAGE_RECEIVED, etc.) in [src/index.js](../src/index.js), which schedule nothing while the VectFox master switch is off; it also bails on its own master-switch check (`isVectFoxEnabled` — see [feature-gate.js](../src/shared/feature-gate.js)) when the switch goes off inside the debounce window. Pass `triggerEvent` so it can suppress the popup on MESSAGE_SENT mid-generation. |
| `rearrangeChat(chat, settings, type, { dryRun, testMessage })` | [chat-vectorization.js](../src/features/chunkbase/chat-vectorization.js) | ST generation interceptor (manifest `generate_interceptor`, runs before the prompt is built). Handles semantic retrieval and prompt injection. **Separate concern from `synchronizeChat`** — retrieval does not trigger auto-sync extraction. Every live (non-quiet) generation first empties every block it owns via `clearInterceptorPrompts` (chunk block, per-position variants, EventBase, Summarizer), so a turn that injects nothing never resends last turn's memory; then it early-returns when the master switch is off (`isVectFoxEnabled`). The lorebook block is cleared by its own GENERATION_STARTED handler ([world-info-integration.js](../src/features/world-info/world-info-integration.js)). The `dryRun` / `testMessage` params support the Query Tester, which is exempt from the master switch so debugging still works. |

### Key-form parity

**Key-form parity is load-bearing.** Four sites read or write the per-collection autoSync flag: `refreshAutoSyncCheckbox` (UI mirror), `getChatAutoSyncStatus` (state evaluator), the change handler (writer), and `synchronizeChat` (the engine that actually fires extraction). All four must use the **registry-key form** (`backend:id`) — built via `buildRegistryKey(collectionId, settings)` or pulled from `entry.registryKey`. One site reading with the bare collection ID while the others write with the registry key looks in the wrong bucket and sees `undefined`: the flag is saved, yet the popup never fires and extraction never runs.

State evaluator: **`async getChatAutoSyncStatus(settings, { shouldProbeBackend = true, shouldLogResolution = true })`** in `src/features/eventbase/eventbase-workflow.js`. Mostly in-memory; performs at most ONE backend probe per (chat, session) for the vectorization-tip cache (see below). `shouldProbeBackend: false` skips that probe and reports only the cached tip; `shouldLogResolution: false` silences the write-target resolver's diagnostics. `refreshAutoSyncCheckbox` passes both while the master switch is off, so a passive panel refresh never calls the backend and logs nothing. Returns one of:

```
{ state: 'no-chat' }
{ state: 'no-collection' }
{ state: 'vectorization-ahead', collectionId, registryKey, chatMessageCount, markerValue }
{ state: 'partial',          collectionId, registryKey, chatMessageCount, commitBoundary, unfinishedWindowCount, markerValue?, vectorizationTip? }
{ state: 'fully-vectorized', collectionId, registryKey, chatMessageCount, commitBoundary, unfinishedWindowCount: 0, markerValue?, vectorizationTip? }
```

Match logic: delegates to **`resolveEventBaseWriteTarget(settings, uuid)`** (returns `no-collection` when it yields `null`) — the status reports on the collection auto-sync would actually write to, so it must resolve with the same rules. It does no UUID walk of its own; that logic lives inside the resolver (see "Eligibility rules inside `resolveActiveEventBaseCollection`" above). A chat whose ONLY EventBase collection is a foreign one locked in for retrieval correctly reports `no-collection`; turning the switch on then offers a fork when the chat is a branch or checkpoint, and Vectorize Content otherwise (see "Branch and checkpoint fork" below).

"Fully vectorized" is determined by `isChatFullyVectorized(messages, settings, chatUUID)`, which checks that the last possible window for the current message count is already in `eventbase_extracted_windows[uuid]` and that no window of that size is in `eventbase_unfinished_windows[uuid]`. No DB query, just an O(1) Set lookup and a read of the record.

**`vectorizationTip`** is the tip from "Vectorization tip cache" above. The status prefers it over `markerValue` for its "vectorized: N messages" count, because the start marker (`eventbase_autosync_start_marker[uuid]`) is stamped once at enable time and never moves.

**`vectorization-ahead` state** covers the per-chat auto-sync marker (`extension_settings.vectfox.eventbase_autosync_start_marker[uuid]`) being past the current chat's message count. Usual cause: the user bound a chat vectorization extracted from a longer version of the same chat (or deleted messages after vectorizing). The marker filter inside `runEventBaseIngestion` then rejects every window — extraction waits until the chat reaches the marker — and the UI says so instead of reporting a sync that never happens. **No auto-correction on purpose**: no marker clamp / re-stamp / clear. The chat-shrinkage case is rare and user-induced; auto-correcting silently would hide a likely user error (binding the wrong vectorization). UI clarity beats silent recovery.

**`refreshAutoSyncCheckbox(settings)`** fires on:
- AutoSync tab click
- `CHAT_CHANGED` event
- Initial load
- `vectfox:collections-updated` custom event
- `vectfox:eventbase-synced` custom event (after an ingestion run completes)
- Master switch toggle (OFF: shows the paused status; ON: after the network startup re-runs)

While the master switch is off, `refreshAutoSyncCheckbox` reads only cached state and logs nothing (`shouldProbeBackend: false`, `shouldLogResolution: false`), and every has-collection state shows the paused status below. It still runs on chat change so the switch matches the current chat — the Summarizer Injection switch reads it.

Resolution table. `autoSyncStatusMarkup` in [autosync-page-markup.js](../src/features/settings-panel/autosync-page-markup.js) builds each status from these states:

| State | autoSync flag | Lock | Switch | Tone | Status |
|---|---|---|---|---|---|
| `no-chat` | — | — | off | warning | "No chat open." |
| `no-collection` | — | — | off | warning | "Not vectorized yet. Turning auto-sync on starts it." |
| has-collection, master switch off | any | any | on iff flag + lock | plain | "Paused while VectFox is off." + counts |
| has-collection | false OR no lock | — | off | plain | "Off for this chat." + counts |
| `vectorization-ahead` | true | locked | on | warning | "Vectorization reaches past this chat's end, so there is nothing to sync." + the counts with the gap + what to check |
| `partial`, failed windows on the record | true | locked | on | warning | "N windows failed and hold no events. Resume in Vectorize Content sends them again." + counts |
| `partial` | true | locked | on | warning | "Behind. The next auto-sync catches up." + counts |
| `fully-vectorized` | true | locked | on | success | "Up to date." + counts |

The counts line reads `Chat: N messages · vectorized: M messages` when the chat's count is known, the second part when the tip or marker is. A fully vectorized chat whose newest turn the settle lag holds back adds `· the latest turn waits to settle`.

**Change handler** (the user turns the switch):

| Action | Behaviour |
|---|---|
| On + no-chat | Warning toast, switch back off |
| On + no-collection, branch/checkpoint with a fork source | Popup: **Fork from parent** → `forkEventBaseFromSource`, re-read status, continue as partial / fully-vectorized · **Vectorize from scratch** → open Content Vectorizer (`'chat'`) · close → switch off |
| On + no-collection, otherwise | Info toast, open Content Vectorizer (`'chat'`); auto-sync turns on when that run finishes |
| On + partial or fully-vectorized | `setCollectionLock(registryKey, chatId)` + `setCollectionAutoSync(registryKey, true)` + the start-marker stamp. A far-behind chat first asks whether to catch up now or keep up from here; closing that popup leaves auto-sync off |
| Off | `setCollectionAutoSync(registryKey, false)` + `clearAutoSyncMarker(uuid)` only. **Does NOT remove the chat lock** — the lock is a separate concern (retrieval activation / explicit user choice via the DB Browser), so disabling auto-sync must not deactivate the collection. Unlocking is the DB Browser's job. |

Every path that leaves auto-sync off also turns Summarizer Injection off, since its newest events would go stale.

`registryKey` here is `status.registryKey` from `getChatAutoSyncStatus` — the canonical `"backend:id"` form. All four metadata read paths (this table, `refreshAutoSyncCheckbox`, `synchronizeChat`, `getChatAutoSyncStatus`) use the same form. After mutation, dispatches `vectfox:collections-updated` and re-runs `refreshAutoSyncCheckbox` so the status updates.

### Branch and checkpoint fork

SillyTavern gives every new branch and checkpoint its own `chat_metadata.integrity` (ST #5943), so it has a new chat UUID and no EventBase collection of its own — the write target resolves to `null` even when the parent's collection is locked here. Writing into the parent's collection is not an option: after the split the two chats' `source_window_end` values describe different stories, and the parent's tip is past the branch's messages. Instead the branch **forks**: the parent's events for the shared messages are copied into the branch's own collection with their stored vectors (no LLM extraction, no re-embedding), and auto-sync extracts only what comes after the split.

**When:** the auto-sync switch is turned on, `getChatAutoSyncStatus` reports `no-collection`, and the chat has `chat_metadata.main_chat` (SillyTavern sets it only on branches and checkpoints).

**Finding the parent** — by message content, so it works after the parent chat file is deleted (deleting a chat does not delete its collection):
1. **Local window record** (`eventbase_extracted_windows`, chat UUID → window fingerprints of source message hashes). No backend reads. The candidate whose hashes match the longest run of this chat's opening messages wins; it needs at least one recorded window made entirely of shared messages, which rules out chats that share only the greeting. Its collection comes from `resolveActiveEventBaseCollection(settings, parentUuid)` and must be on the current backend.
2. **Locked collection of another chat** — when the record has no match (extracted on another install, imported, or record cleared). Each such EventBase collection locked to this chat is read once and matched by its events' `source_message_hashes`.

**Split point** = length of that matching run. Copied: every event whose `source_window_end` is before it, including events whose message was edited in the parent after extraction (the parent still uses them). If a parent message near the split was edited and never re-extracted, the run stops early and auto-sync re-extracts a few extra windows — never the reverse.

**After the copy** the branch collection is registered, `scope: 'chat'`, locked to this chat; the source is unlocked from this chat; the copied windows go into the branch's window record, the tip is set to the split, and the parent's last window size carries over. The enable flow then continues as for any existing collection (backlog gate, `setCollectionAutoSync`, `stampAutoSyncMarker`). A failure or stop during the copy purges the partial collection. The fork refuses when vectors are missing or the parent was embedded with a different provider/model.

| Function | File | Role |
|---|---|---|
| `findEventBaseForkSource(settings)` | [eventbase-fork.js](../src/features/eventbase/eventbase-fork.js) | Parent collection + split point, or `null` |
| `forkEventBaseFromSource(settings, source)` | [eventbase-fork.js](../src/features/eventbase/eventbase-fork.js) | Copy + activation, with progress panel |
| `rankForkSourcesFromWindowRecord`, `measureSharedPrefix`, `selectChunksBeforeSplit`, … | [eventbase-fork-core.js](../src/features/eventbase/eventbase-fork-core.js) | Pure matching/selection rules |
| `hashSourceMessage(message)` | [eventbase-message-hash.js](../src/features/eventbase/eventbase-message-hash.js) | The one message hash behind `source_message_hashes`, window fingerprints and fork matching |
| `fetchPortableChunks`, `insertChunksWithVectors` | [collection-export.js](../src/features/collections/collection-export.js) | The export/import read and write, shared with the fork |

## Manual vs auto-sync paths

UI elements that mirror lock state are pulled in two ways. The distinction matters because the manual paths have side effects.

| Trigger | Calls `.trigger('change')` | Lock mutation? |
|---|---|---|
| User turns the semantic activation switch | (browser-native) | **Yes** — change handler removes/checks locks |
| User turns the auto-sync switch | (browser-native) | **Yes** — change handler removes/sets chat lock |
| User moves the lock switch in Collection Settings | (via Save button) | **Yes** — `writeLockHere` mutates |
| `refreshWIStatus` auto-uncheck | **No** — `_setWIEnabled` uses `prop()` only | **No** — pure UI mirror |
| `refreshAutoSyncCheckbox` auto-state | **No** — direct `prop()` | **No** — pure UI mirror |
| Collection Settings after Manage locks | **No** — the switch is set directly | **No** — re-reads the locks Manage locks set |

**Rule:** auto-sync paths must never invoke the change handler. Otherwise, opening the WorldInfo page could trigger lock removal as a side effect of the UI sync.

## Custom events

| Event | Fired by | Listeners |
|---|---|---|
| `vectfox:collections-updated` | `editCollectionSettings` on a save or a lock change, the semantic activation switch turned off, the auto-sync switch | `refreshWIStatus`, `refreshAutoSyncCheckbox` |
| `vectfox:eventbase-synced` | `runEventBaseIngestion` at end of run | `refreshAutoSyncCheckbox` |

Plus ST's `CHAT_CHANGED` — same two refresh handlers re-run.

## Runtime activation chain (`shouldCollectionActivate`)

The gate chain in `src/features/collections/collection-metadata.js`; every gate that applies must pass:

```
1. Pause button (enabled=false)               → BLOCKED
2. Lock: chat (currentChatId) or character    → required; unlocked → BLOCKED
3. Activation Triggers, if set                → a keyword must match this turn
4. Advanced Conditions, if set                → the rules must pass this turn
5. Locked, every configured filter passed     → ACTIVE
```

Triggers and conditions narrow a locked collection; neither can activate an unlocked one. There is **no global scope**: stored `scope: 'global'` values are rewritten to `'character'` on load, no path should produce a new `'global'` value, and no code should check `meta.scope === 'global'`.

## Key files

| File | Role |
|---|---|
| `src/shared/collection-ids.js` | `buildRegistryKey`, `parseRegistryKey`, `resolveBackendForCollection`, `getBackendFromCollectionId`, `remapCollectionIdToBackend`, `normalizeBackendForId`, `KNOWN_BACKEND_LABELS` |
| `src/features/collections/collection-metadata.js` | `isCollectionActiveForContext`, `getCollectionLocks`, `getCollectionCharacterLocks`, `setCollectionLock`, `removeCollectionLock`, `setCollectionCharacterLock`, `removeCollectionCharacterLock`, `setCollectionAutoSync`, `shouldCollectionActivate` |
| `src/features/collections/collection-loader.js` | Migration (`scope='global'` → `'character'`), `loadAllCollections`, `getCollectionListing` |
| `src/features/vector-backend/vector-api.js` | `queryCollection` — the canonical per-collection-backend routing entry point |
| `src/features/eventbase/eventbase-workflow.js` | `getChatAutoSyncStatus`, `isChatFullyVectorized`, dispatches `vectfox:eventbase-synced` |
| `src/features/chunkbase/content-vectorization.js` | Default `scope='character'`, no `'global'` fallback |
| `src/features/database-browser/database-browser.js` | The Active here pill (`activeHereLine`) |
| `src/features/database-browser/collection-dialogs.js` | Collection Settings' lock switch (`lockAreaView`, `saveCollectionSettings`, `writeLockHere`) and Manage locks (`manageCollectionLocks`) |
| `src/features/settings-panel/settings-panel.js` | `refreshWIStatus` + `_setWIEnabled`, `refreshAutoSyncCheckbox`, the semantic activation and auto-sync switch handlers, event listeners |
| `src/features/chunkbase/content-vectorizer.js` | Scope picker without global, post-vectorization `refreshWIStatus` call |

## Things you should NOT do

- Don't call `.trigger('change')` from any refresh/auto-sync path. Use `prop('checked', x)` directly and persist settings inline.
- Don't add backend probes to checkbox-state evaluators. `isCollectionActiveForContext` uses in-memory data only; `getChatAutoSyncStatus`'s only backend call is the one-time vectorization-tip probe, which `shouldProbeBackend: false` skips.
- Don't add `scope === 'global'` checks. The only legitimate one is the rewrite block in `loadAllCollections`.
- Don't duplicate `isCollectionActiveForContext` logic inline. If you need it in a new place, import it.
- Don't write directly to `lockedToChatIds` / `lockedToCharacterIds`. Use the `setCollectionLock` / `removeCollectionLock` / `setCollectionCharacterLock` / `removeCollectionCharacterLock` helpers — they maintain the `chat_lock_index` reverse map too.
- Don't pass bare collection IDs to `queryCollection` (in `src/features/vector-backend/vector-api.js`). The function routes by backend prefix internally via `resolveBackendForCollection`. Bare IDs work *only* when the backend can be detected from the ID structure — registry-key form is the canonical input.
- Don't hand-roll backend detection (`id.includes('_qdrant_') ? 'qdrant' : 'standard'`). Use `resolveBackendForCollection(id)` — it returns the bare collectionId you'll need for the backend call anyway.
