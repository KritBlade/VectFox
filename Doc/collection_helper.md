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
| **`collectionInUse(settings, { chatUUID?, chatId? })`** | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | You need *the* EventBase collection a chat uses, to read or to write: its own collection locked to it on the current backend, or why there is none. The one route every reader and writer asks (D18 of `vectfox-multi-collection-per-chat.md`): never resolve a chat's collection another way, never take `[0]` of a list, and never fall back to a collection not locked. |
| **`sharedCollectionsLockedHere({ chatUUID?, chatId? })`** | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | You need the collections locked in to be read beside the chat's own: other chats' EventBase collections and chat files' archive collections, each with its pause. Never the chat's own, which is `collectionInUse`'s. |
| **`getCollectionLocks(key)`** / **`getCollectionCharacterLocks(key)`** | [collection-metadata.js](../src/features/collections/collection-metadata.js) | You need the chats / characters *one* collection is locked to (lock dialog, badge, tooltip). |
| **`isCollectionActiveForContext(key, { chatId, characterId })`** | [collection-metadata.js](../src/features/collections/collection-metadata.js) | You need "is *one* collection locked to the current chat / character?" (badge, checkbox state). EventBase's retrieval checks the pause flag and the chat lock itself (see "Runtime activation — what a reply searches"). |
| **`setCollectionLock`** / **`removeCollectionLock`** / **`clearCollectionLock`**, and **`setCollectionCharacterLock`** / **`removeCollectionCharacterLock`** | [collection-metadata.js](../src/features/collections/collection-metadata.js) | You need to *change* one collection's locks (user clicks lock / unlock / clear). Not to lock one of a chat's own EventBase collections to it: that is `useChatCollection`. |
| **`useChatCollection(registryKey)`** / **`lockCollectionToOpenChat(registryKey)`** | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | You lock one of a chat's own EventBase collections to it: it is put in use, and the chat's other own collections are unlocked there, on every backend and persona (`oneInUseLockChanges` in `src/shared/one-in-use-locks.js`). `lockCollectionToOpenChat` is the Database Browser's lock: an own collection through `useChatCollection`, another chat's or an archive locked beside it. |
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
- The chat-lock writes keep the `chat_lock_index` reverse map (read by `getChatLockedCollections(chatId)`) in step with `lockedToChatIds`, and a record's delete, by `deleteCollectionMeta` or the Database Browser's orphan sweep (`cleanupOrphanedMeta`), takes its entries out.
- **A chat's rename** (SillyTavern's `CHAT_RENAMED`) moves every collection lock on the old chat ID to the name the server saved the file under (`followChatRenameOfCollections`, `moveCollectionChatLocks`, through `renamedChatIds` in `src/shared/renamed-chat.js`, which LoreBase's book locks follow too), through `removeCollectionLock` and `setCollectionLock`, so the index moves with them. SillyTavern opens the renamed chat before it says the chat was renamed, so the pages that show locks were drawn while they were still on the old name: once collection locks moved, `vectfox:collections-updated` redraws the AutoSync page, and once a book selection's locks moved, `onLoreBookChatLocksMoved` redraws the WorldInfo page's book rows.
- **Clean up locks**, in the Action page's Stored data (`src/features/settings-panel/lock-cleanup.js`), removes the locks on chats and characters that no longer exist, the collections' (`cleanUpCollectionLocks`) and LoreBase's book locks (`cleanUpLoreBookLocks`), then rebuilds `chat_lock_index` from the records' chat locks, after a confirm that counts each kind. It lists every character's chats through SillyTavern's `/api/characters/chats` and every group's chats; a chat list it cannot read whole leaves every chat lock alone. A collection's character lock is the character's place in SillyTavern's list (D9 of `vectfox-multi-collection-per-chat.md`), so only one past the list's end counts as gone.

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
| `queryCollection(collection.collectionId, ...)` — passing the bare ID. `queryCollection`'s `parseRegistryKey` returns `backend=null`, then it falls back to `settings.vector_backend` (the user's *default* backend). On mixed-backend setups this silently queries the wrong backend → 0 results, or worse, returns content from a *different* collection that happens to be on the default backend. TEST 013 covers this. | `queryCollection(collection.registryKey, ...)` — the registry-key form lets `resolveBackendForCollection` pick the right backend per-collection. |
| `liveCollectionIds: lockedLiveCollections.map(c => c.collectionId)` — destructuring `.collectionId` off a collection a reply reads (the collection in use, or one of `sharedCollectionsLockedHere`'s). The object has BOTH `.collectionId` (bare) and `.registryKey` (canonical) — picking the wrong one cascades the bare-ID bug down to every consumer (retrieveEvents, retrieveEventsForTurn). | `liveCollectionIds: lockedLiveCollections.map(c => c.registryKey)` — same pattern, right field. |
| `parseRegistryKey(id).backend ?? 'qdrant'` (or `?? settings.vector_backend`) hand-rolled — silently misroutes bare IDs that *do* have a detectable backend in the ID structure. | `resolveBackendForCollection(id)` — tries registry-key prefix first, then ID-structure detection, then returns `null` so the caller knows resolution failed. |

## Pause/Resume button — `enabled` flag

Separate concern from locks. It's a per-collection hard kill switch — when `false`, that one collection is blocked from any activation regardless of locks or scope.

> **Do not confuse with the global master switch.** This pause flag is **per-collection**, stored at `extension_settings.vectfox.collections[registryKey].enabled` and read via `isCollectionEnabled(registryKey)`. The VectFox master switch is a **different key** — top-level `extension_settings.vectfox.enabled`, read via `isVectFoxEnabled()` ([feature-gate.js](../src/shared/feature-gate.js)) — and gates *all* runtime work (retrieval injection, auto-sync, LoreBase's picks) globally. Same word, different scope and different storage path.

- **UI:** Play/pause icon on each collection card in the Database Browser
- **Write:** `setCollectionEnabled(collection.registryKey || collection.id, false)` → stores `{ enabled: false }` under `extension_settings.vectfox.collections[registryKey]`
- **Read:** `isCollectionEnabled(registryKey)` in `src/features/collections/collection-metadata.js` — pass the registry-key form, not bare ID
- **Default:** `true` (enabled) when no metadata exists
- **All collections use the same key form** — `backend:id`. EventBase collections are registered as `${registryBackend}:${collectionId}` in `eventbase-store.js`, not as plain IDs. The `data-collection-key` attribute on every card is always `collection.registryKey || collection.id`.

## Runtime activation — what a reply searches

The reply step's EventBase retrieval (`runEventBaseRetrieval` in [eventbase-workflow.js](../src/features/eventbase/eventbase-workflow.js)) searches the chat's collection in use (`collectionInUse`, which the reply step asks once and hands to retrieval, Summarizer Injection and ghosting), and the collections locked in beside it (`sharedCollectionsLockedHere`): other chats' live (`vf_eventbase_*`) collections and chat files' archive (`vf_archiveevent_*`) collections locked to the chat. Both check each one under both key forms, `[registryKey, collectionId]`, since pause and lock state from before registry keying can sit under the bare ID:

```
1. Paused under either key form     → skipped    isCollectionEnabled(key) is false
2. Not locked to the current chat   → skipped    isCollectionActiveForContextAnyKey(keys, { chatId }) is false
3. Both gates passed                → searched
```

StoryArc's recipes read the collection in use alone (`storyArcCollectionKey`), its events and the links stored on them, never another collection locked here (D18). With none in use, the chat's own events are read nowhere, and the reply step says so once, in red (`showNoCollectionInUse`), naming what was switched on to read them: retrieval, Summarizer Injection, StoryArc.

Only a chat lock counts: no `characterId` is passed, so a character lock never activates an event collection. No other kind of collection is searched on a reply.

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
   - `vf_lorebook_*` → `'character'`
3. **Default `'character'`**, the wider scope, for any other ID.

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

TEST 006/007 cover the standard-backend no-plugin path, including retrieval through a chat lock.

## No global scope

`scope='global'` is not a valid value. A collection's scope is `'chat'` or `'character'`: the stored value, or the one its ID gives (`getEffectiveScope`).

1. **`COLLECTION_SCOPES`** in `src/shared/collection-ids.js` holds `CHARACTER`, `CHAT` and `UNKNOWN` (the unparseable-input sentinel).
2. **`parseCollectionId` returns the canonical scope:**
   - `vf_lorebook_*` → `'character'`
   - `vf_eventbase_*` / `vf_archiveevent_*` → `'chat'`
   - any other ID → `'unknown'`, which `getEffectiveScope` turns into `'character'`
3. **A stored `scope: 'global'` is rewritten on load** by `loadAllCollections`:
   ```
   storedMeta.scope === 'global'  →  setCollectionMeta(writeKey, { scope: 'character' })
   ```
   It is the only `'global'` check in the code, kept for user data that still holds the value. Do not remove it.

A rewritten collection has no character lock, so its lock switch in Collection Settings shows off until the user switches "Active for this character" on, which calls `setCollectionCharacterLock(collectionKey, String(currentCharacterId))`.

**Rule for new code:** never reintroduce `scope === 'global'` branches anywhere. If you need to handle stored data that *might* contain `'global'`, route it through `getEffectiveScope` — the canonical resolver folds every invalid value into `'character'` or `'chat'`.

## DB Browser — the Active here pill in the listing

In `src/features/database-browser/database-browser.js`, `renderCollections` calls `getCollectionListing(settings)` once and keys each entry's `isActive` (computed there with `isCollectionActiveForContext(registryKey, ...)`) by registry key and by bare ID. The "Active here only" filter and every row read that lookup; no row calls `isCollectionActiveForContext` itself. An active row shows the Active here pill and a line from `activeHereLine` (`activeLockLine` in `collection-settings-core.js`) naming the lock its scope reads, this chat or this character, and how many other chats a chat collection is locked to. Collection Settings' summary and Manage locks read locks the same way: they count and offer the kind the scope reads, and Manage locks lists a lock of the other kind saved before as not read, with its Remove.

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
scope='chat'      + on  →  lockCollectionToOpenChat(collectionKey): one of the chat's own EventBase collections put in use (useChatCollection), any other locked beside them
scope='chat'      + off →  removeCollectionLock(collectionKey, currentChatId)
scope='character' + on  →  setCollectionCharacterLock(collectionKey, String(currentCharacterId))
scope='character' + off →  removeCollectionCharacterLock(collectionKey, String(currentCharacterId))
```

The switch shows on when the lock of the collection's scope matches here (`isCollectionActiveForContext`), and Save writes only when the user moved it. Without the chat or character its scope locks to, the switch is off limits and Manage locks is the way in. Character 0 is a character: only a missing id means none.

`collectionKey` is the registry-key form (`backend:id`): the browser passes `collection.registryKey || collection.id`.

Each call only touches the lock for the **current** chat/character. Other chats or characters that have this collection locked keep their entries intact — `removeCollectionLock` filters by id, doesn't wipe the list.

## DB Browser — Compact collection

A button on the row of each EventBase collection, of a chat or a chat file, when the collection and VectFox both use Qdrant (`canCompactCollection` in `database-browser.js`), since that backend lists every event with its window. It removes what a collection should not hold, after a confirmation that counts it, with no LLM call. A new kind of clean-up joins it as its own part of the plan (`planCompaction` in [`eventbase-compaction-core.js`](../src/features/eventbase/eventbase-compaction-core.js)), with its own line in `describeCompaction`.

1. **What it removes.** Repeats: the events a window holds from extractions before its newest one. Each window keeps its newest extraction that records `created_at`, and an earlier event goes by the rule of a window extracted again (see "When a window is extracted again"): the same first and last message, a shared message, written before it. A window holding no event with `created_at` stays as it is, since an event_id's time can differ by a millisecond between the events of one extraction.
2. **Links first.** `compactCollection` in `eventbase-compaction.js` moves the StoryArc links that pointed at a removed event to the first event of its window's newest extraction (`moveStoryLinks`), then removes the events. A stopped or failed move removes nothing, and pressing the button again finishes it. The removed events' own links go with them.

**Test coverage**: `tests/eventbase-compaction-core.test.js`, `tests/eventbase-compaction.test.js`, and `tests/database-browser-compact.test.js` for the button.

## Auto-sync — the "Auto-sync this chat" switch

### The pointer — how far each collection has read its chat

How far EventBase has read a chat is kept per collection, in the collection's record: `eventbaseProgress` in `extension_settings.vectfox.collections[<registry key>]`, beside its locks, pause, auto-sync switch and StoryArc lists. Two collections of one chat, on two backends or under two personas, never share one, so locking one or the other never moves a pointer.

| Part | What it holds |
|---|---|
| `vectorizationTip` | One past the last message any extracted window covers (the tip, below) |
| `extractedWindows` | The fingerprints of the windows read (the window record, below) |
| `unfinishedWindows` | The fingerprints of the windows that failed |
| `autoSyncStartMarker` | The first message auto-sync reads, where its windows start (the start marker, below) |
| `windowSize` | The window size Vectorize reads it with: the dialog's at the chat's first read, at New collection and at Start over; Catch up reads with it, and no run changes it (the window size a collection keeps, below) |

- **One pair of functions** in [eventbase-store.js](../src/features/eventbase/eventbase-store.js) reads and writes it: `readEventBaseProgress(registryKey)` and `writeEventBaseProgress(registryKey, parts)`, which merge inside `eventbaseProgress`, as `setCollectionMeta` replaces a record's fields whole. Every store function below that takes a `registryKey` reads or writes that collection's pointer. A run reads into its collection's key (`buildRegistryKey(collectionId, settings)`); the AutoSync page, Sync chat and ghosting read the chat's collection in use's (`status.registryKey`, `collectionInUse`).
- **Deleting the collection** deletes its record, the pointer with it, and `clearCachesForDeletedOrImportedCollection` forgets the tip held in memory.
- **An export carries the pointer** in its `settings.eventbaseProgress` (`exportCollection` in [collection-export.js](../src/features/collections/collection-export.js)). An import clears the pointer of the record it writes to, and writes the file's once every chunk is in, keeping only the parts with their shape. A file with none, and a failed or stopped import, leave none: the collection's first run then carries on from the furthest window stored (`shouldUseTipFallback`).
- **At start**, [settings-migration-eventbase-progress.js](../src/app/settings-migration-eventbase-progress.js) copies a pointer an older VectFox kept per chat, in five stores keyed by the chat's UUID, onto each of the chat's collections with no pointer yet, then deletes the stores; an empty registry leaves them for the next start.

### The smart marker — what makes auto-sync correct

Before reading the rest of this section, internalize this: **the window record is what prevents auto-sync from re-extracting the entire chat on every trigger**. Without it, the cost of running auto-sync would grow linearly with chat length on every single message — every trigger would re-process every window from the top. The window record is the "smart marker" that lets auto-sync only do the *new* work.

The record is the pointer's `extractedWindows`, read through [`src/features/eventbase/eventbase-store.js`](../src/features/eventbase/eventbase-store.js). Four functions form the contract:

| Function | Role in auto-sync |
|---|---|
| `markWindowExtracted(sourceHashes, registryKey)` | Called by `runEventBaseIngestion` after each window is successfully extracted. Adds the fingerprint to the collection's `extractedWindows`, and takes off its unfinished record the window and every failed window whose messages have all been read now; the settings save debounced. Survives page reload. |
| `markWindowUnfinished(sourceHashes, registryKey)` | Called by `runEventBaseIngestion` for each window that failed or timed out. Adds the fingerprint to the collection's `unfinishedWindows`. See "When a window fails" below. |
| `isWindowAlreadyExtracted(sourceHashes, registryKey)` | Per-window dedup gate inside the ingestion loop: true when the window's fingerprint is on the record, or every message in it is in a window read already, of any size, so no message is read twice (§2.7 of `vectfox-multi-collection-per-chat.md`). Set lookups: each `extractedWindows` array's fingerprints and message hashes are built into Sets once and kept for that array, so a record whose array is replaced (an import) is read again. |
| `isLastWindowExtracted(messages, windowSize, step, registryKey, hashFn, firstWindowStart?)` | Quick-exit gate at the top of `runEventBaseIngestion`. If the last possible window for the current message count is already on the record, ingestion no-ops immediately without building the window list. This is the cheapest possible "is there anything new?" check. It says nothing about earlier windows, because a run carries on past a failed one. Windows count from `firstWindowStart`: auto-sync's from its start marker (`autoSyncFirstWindowStart`), every other run's from 0. |

User scenario the cache makes safe:

1. User vectorizes a chat at 2 messages — window `[0-1]` extracted. `markWindowExtracted` records its fingerprint.
2. User replies twice — chat now has 6 messages. Two new windows `[2-3]` and `[4-5]` exist on disk but are not on the record.
3. User turns on "Auto-sync this chat". Next trigger calls `runEventBaseIngestion`.
4. `isLastWindowExtracted` checks `[4-5]` against the record → not present → returns false → ingestion runs.
5. The ingestion loop iterates windows. For `[0-1]`, `isWindowAlreadyExtracted` returns true → skipped (no LLM call, no duplicate event). For `[2-3]` and `[4-5]`, returns false → LLM extracts events, `markWindowExtracted` records each fingerprint.
6. Next trigger: `isLastWindowExtracted` against `[4-5]` returns true → quick-exit → no work done.

**When a window fails.** A failed window is only absent from the record, while the windows after it are present, so the quick-exit and the tip cannot see it. The unfinished record exists to say so:

1. **Same run.** A window that fails or times out goes on the record and the run carries on. A provider rejection, a parse failure, a reply cut at the token limit, and a reply with no valid event all count as failing. When all windows are through, the run sends the failed ones again, up to 2 more passes, after 5s and 10s. It stops early when a pass got nothing through and more than 8 windows failed, because that points at the provider rather than at those windows.
2. **Still failing.** The window stays on the record. The progress panel and a sticky toast report it, and the auto-sync status on the AutoSync page names it.
3. **Later runs.** A manual run does not take the quick-exit while its window size has windows on the record, so Resume reaches them. Auto-sync keeps the quick-exit and sends them when the next turn commits, but only those at or after its start marker. Neither run uses the tip fallback while the record has such windows. A window already on the record when a run begins gets one send in that run, so one that always fails does not cost three calls every time.
4. **Off the record.** Success takes a window off, and so does the read of every message in it, in other windows of any size. A manual run also drops windows the chat no longer has, because a message in them was edited or deleted, and `clearExtractionCaches` drops the whole record.

A fatal error (bad key, bad model) stops the run with no re-send, but its window still goes on the record.

**When a window is extracted again.** A message edited after its window was read, or rewritten by a script, gives the window a new fingerprint, so a later run reads it again. So does a window the record lost, as an older settings file saved by another tab can do. The new events replace the ones the window holds: stored events of the same window (the same first and last message) that share at least one message with the new extraction and were written before it ([`eventbase-window-replacement-core.js`](../src/features/eventbase/eventbase-window-replacement-core.js)). Without that, the window would keep both versions of the same moment.

1. **When.** `createWindowReplacement` in `eventbase-store.js` removes them after each batch is stored. At the end of the run, StoryArc links that went to them point at the window's first new event.
2. **What it reads.** The collection, once per run, and only when a window can hold earlier events: one before the tip, any window when no tip is known, or any run that extracts more than one window. A run that extracts only the window after the newest, as an ordinary turn does, reads nothing more.
3. **Which window is the same.** A run numbers its windows from the chat's first message, and auto-sync from its start marker (`autoSyncFirstWindowStart`), so one of its windows starts at the marker whatever window size stamped it. A run from a later message (`startFromMessage` in `runEventBaseIngestion`) keeps the chat's numbering and starts at the window that holds the message. So a window has the same first and last message in every run that numbers it the same way, and the tip and StoryArc's message numbers count from the chat's start. An auto-sync window counted from a marker that is not a multiple of its size has another first and last message than a Vectorize run's window of that size, as a window at another size has (below).
4. **What stays.** A window whose new reading found no events keeps its earlier ones. A window at another size has another first and last message: one whose messages were all read is not read at all, and one holding messages read and unread leaves the read messages' events at both sizes. An event of other messages stored under the window's number stays when it shares no message with the new extraction, as a message deleted or added earlier in the chat can leave them. That check is loose: a message repeated word for word has the same hash wherever it sits.

**Test coverage**: see TEST 014 in `tests/Eventbase-test.spec.js`, `tests/eventbase-progress.test.js` for the pointer itself, `tests/eventbase-window-resend.test.js` for failed windows, `tests/eventbase-window-replacement.test.js` for windows extracted again, and `tests/eventbase-start-from-message.test.js` for a run from a later message. The full storage shape (the record's array + an in-memory Set) and the rationale for *why* it has two tiers is in [Doc/dev_helper.md §4](dev_helper.md).

### Second safety layer — the start marker (windows holding messages read)

The window record above skips a window of any size once every message in it was read. A window that holds messages read and unread is read whole: after `[0-1]` was read at `windowSize=2`, auto-sync's `[0-3]` at `windowSize=4` would read messages 0 and 1 again with 2 and 3.

The **auto-sync start marker** is the second gate that catches this case. It is the first message auto-sync reads, per collection, the pointer's `autoSyncStartMarker`: auto-sync's windows start at it and every step after it, and auto-sync reads none that starts before it. So whatever window size stamped the marker, auto-sync reads no message before it again and skips none after it. Five functions in [`src/features/eventbase/eventbase-store.js`](../src/features/eventbase/eventbase-store.js):

| Function | Role |
|---|---|
| `stampAutoSyncMarker(registryKey, settings, options?)` | Called from the auto-sync switch's handler when the user turns auto-sync on, with the chat's collection in use (and re-called when the auto-sync window setting changes, as turning Summarizer Injection on does). Smart placement: if the collection has existing events → `marker = max(source_window_end) + 1`; if empty → the chat's length. Pass `{ floor: 'chatLength' }` to force from-now-on placement regardless of coverage (the enable-time "Just keep up from here" choice). The chat's length counts its messages with text, as a run does. Writes the collection's `autoSyncStartMarker`. |
| `getAutoSyncMarker(registryKey)` | Read by `runEventBaseIngestion` to gate the window list. Returns `undefined` when no marker is stamped (manual runs and pre-auto-sync chats). |
| `autoSyncFirstWindowStart(registryKey, step)` | Where auto-sync's windows start counting: the marker's place among windows of the step (`marker % step`), or 0 with no marker. The run's window list and quick-exit, and the AutoSync page's status (`isChatFullyVectorized`), count from it, so one window starts at the marker. |
| `clearAutoSyncMarker(registryKey)` | Called when auto-sync is disabled so re-enabling later re-computes a fresh marker against the current chat state. |
| `capAutoSyncMarker(registryKey, messages, { windowSize, step, hashFn })` | Called by `runEventBaseIngestion` at the start of an auto-sync run, before its quick-exit. When the chat got shorter than the marker (messages deleted, or a summary replacing some), it moves the marker back to the chat's unread end and stores it: after the last message the window record holds, among the chat's last `windowSize + step - 1` messages, the most auto-sync leaves unread while it keeps up (the turn it holds back and a window not yet full). So auto-sync reads the turn it held back with the chat's new messages, instead of nothing until the chat grows past the old marker, and reads no message again. |

The windows and the filter are in [`src/features/eventbase/eventbase-workflow.js`](../src/features/eventbase/eventbase-workflow.js):

```js
const firstWindowStart = isAutoSync ? autoSyncFirstWindowStart(registryKey, step) : 0;
for (let start = firstWindowStart; start < commitBoundary; start += step) { /* full windows only */ }
// …
if (isAutoSync) {
    const marker = getAutoSyncMarker(registryKey);
    if (typeof marker === 'number') {
        windows = windows.filter(w => w.start >= marker);
    }
}
```

**Why `>=` and not `>`:** a window starts *exactly at* the marker, so `>` would skip it — an extraction gap. Boundary inclusion is asserted by TEST 015 Phase 4.

**Why the windows start at the marker:** counted from the chat's first message, a marker that is not a multiple of auto-sync's window size falls inside a window that starts before it, which the filter drops, so the messages between the marker and the next window would never be read. `max(source_window_end) + 1` from windows of another size and the chat's length at Keep up from here each land there.

### Enable-time backlog catch-up (confirm, then run)

Auto-sync **catches up the whole gap** (tip → now) on its next trigger — it does *not* "start from now" by default. For a large gap that next trigger is a surprise burst of LLM calls, so the enable handler ([settings-panel.js](../src/features/settings-panel/settings-panel.js) → `#VectFox_autosync_enabled` `input`) gates it:

1. Compute pending windows: `countWindowsBehind(commitBoundary, getVectorizationTip(status.registryKey), getAutoSyncWindowSize(settings))`, where `commitBoundary` is `status.commitBoundary` (chat length minus the held-back active turn — see the settle/commit lag layer). Clamping the backlog to the committed boundary keeps the deliberately-unextracted active turn from being counted as backfill.
2. If at least `FAR_BEHIND_WINDOW_COUNT` (5) windows, `choicePopup` asks: **Catch up now**, **Keep up from here** or **Cancel** (Cancel and Escape leave auto-sync off):
   - *Catch up now* → `backfillCurrentChatWithProgress()` ([content-vectorizer.js](../src/features/eventbase/content-vectorizer.js)) runs the Resume path with the progress panel, then the marker lands at the freshly-advanced tip (smart placement).
   - *Keep up from here* → `stampAutoSyncMarker(status.registryKey, settings, { floor: 'chatLength' })` skips the backlog.
3. Below threshold → enable silently (a small gap catches up on the next trigger).

The catch-up backfill runs at the collection's window size (`getCollectionWindowSize`) while auto-sync runs at `getAutoSyncWindowSize` — **safe** because the marker/tip gate is index-based: catch-up advances the tip, the marker is stamped there, and auto-sync only processes windows from it on at its own size. No fingerprint collision, no duplicate coverage. Floor-override behavior is asserted by TEST 016 Phase 5.

**Why the manual path ignores the marker:** the filter only applies when `isAutoSync === true`. Vectorize Content's Catch up fills historical gaps on purpose, such as one left by Keep up from here, and the window record keeps it from reading a window whose messages were all read; the marker is an auto-sync-only safety, not a global "don't re-process" gate.

User scenario the marker makes safe:

1. User vectorizes chat at `windowSize=2`, message count=2 → window `[0-1]` extracted, event has `source_window_end=1`.
2. User replies → chat now has 10 messages.
3. User opens settings, changes `windowSize` to 4, then enables Auto-Sync.
4. `stampAutoSyncMarker` reads the collection: `max(source_window_end)=1` → marker stamped as `2`.
5. Next auto-sync trigger: `runEventBaseIngestion` builds windows at `windowSize=4` from message 2 (`2 % 4`) → `[2-5]`; `[6-9]` waits for the next turn (the settle/commit lag below).
6. Marker filter: `[2-5]` (start=2 ≥ 2) kept. Messages 2 to 5 are read, and messages 0 and 1 are not read again.
7. Without the marker, the windows would start at message 0 and `[0-3]` would be read, messages 0 and 1 a second time. Counted from message 0 with the marker, the filter would drop `[0-3]` and messages 2 and 3 would never be read.

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
| 1 | `isLastWindowExtracted` / `isWindowAlreadyExtracted` (window record) | Reading a window again, or one of any size whose messages were all read | Always |
| 2 | `getAutoSyncMarker` + `autoSyncFirstWindowStart` + `windows.filter(w => w.start >= marker)` | Reading a window that starts before where auto-sync was turned on, which may hold messages read at another size, and skipping the messages after the marker | Auto-sync runs |
| 3 | `getCommitBoundary` (settle/commit lag) | Embedding throwaway re-rolls/swipes of the active turn | Always, on auto-sync runs (default ON) |

**Test coverage:** TEST 015 in `tests/Eventbase-test.spec.js` is a pure-function exercise of the marker contract — a fresh collection returns `undefined`, stamp/read round-trips through the canonical getter, the `>= marker` filter excludes obsolete pre-marker windows and keeps post-marker windows, the boundary `start === marker` is included, and `clearAutoSyncMarker` removes the entry cleanly. The settle-lag is covered by `tests/eventbase-settle-lag.test.js` (pure boundary math, runs in CI) and TEST 023 in the spec (swipe-on-active-turn never extracts; the kept turn extracts once superseded).

### Vectorization tip cache — honest "vectorization: N msgs" display

The auto-sync start marker is stamped *once* at enable time and never advances as new windows extract, so it cannot serve as the UI count. The vectorization tip (`max(source_window_end) + 1` for the collection) is the live value: `setVectorizationTip` keeps it in memory and writes it into the pointer's `vectorizationTip` (backend-agnostic), and `getVectorizationTip` warms the in-memory cache from the pointer after a reload. When neither holds a value, as after deleting the collection or importing a file with no pointer, `ensureVectorizationTip` probes the backend via `listChunks`; the probe works for Qdrant and Standard+plugin. For Standard without the similharity plugin it returns `null` (the native fallback returns hashes, no metadata), so the UI falls back to `markerValue` until the next ingestion run sets the tip.

A saved tip can also be older than its collection, because SillyTavern saves the whole settings file from whichever tab saves last: a tab left open or a restored backup puts back an old one. So `getChatAutoSyncStatus` has a known tip at least `FAR_BEHIND_WINDOW_COUNT` windows behind the sync boundary read against the backend, once per collection per page load, the same line at which the enable flow asks before catching up. A higher reach raises the tip and drops the window record, which would otherwise make Resume start where it ends. The check only raises: windows with no events leave nothing in the backend, so it can prove a tip too low but never too high. It keeps the tip when the events at the collection's end are older than events below the tip, because that is a Vectorize stopped part way, and Resume has to carry on from there.

| Function | File | Notes |
|---|---|---|
| `getVectorizationTip(registryKey)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Sync; returns the in-memory tip, else the pointer's (warming the cache), else `undefined`. UI falls back to `markerValue` when undefined. |
| `setVectorizationTip(registryKey, tip)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Sync, monotonic max in memory and in the pointer — out-of-order calls won't regress. Called by `runEventBaseIngestion` after every successful window via `setVectorizationTip(registryKey, win.end + 1)`. |
| `clearVectorizationTip(registryKey)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Clears the in-memory tip and the pointer's. `clearExtractionCaches` calls it with the window record. |
| `ensureVectorizationTip(registryKey, settings, syncProgress?)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Async. Returns the known tip at once (in memory or in the pointer), unless `syncProgress` (`{ commitBoundary, windowSize }`) shows it far behind, which checks it as above. With no known tip it probes the collection's events on the current backend once, caches the result in memory only, and returns it. Returns `null` when the collection has no events. Called by `getChatAutoSyncStatus`, which passes `syncProgress`, and by the ingestion fast-forward, which does not, and skips a tip past the chat's end (`vectorization-ahead` below). |
| `countWindowsBehind(commitBoundary, tip, windowSize)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Whole Auto-sync windows between a tip and the sync boundary, for the enable flow and the far-behind check. |

### The window size a collection keeps (§2.7 of `vectfox-multi-collection-per-chat.md`)

The pointer's `windowSize`: the Vectorize dialog's Window size at the chat's first read, at New collection and at Start over, which Catch up reads the collection with, as do Resume, Sync chat and the auto-sync switch's catch-up; a collection that keeps none is read at the dialog's, which it keeps from then on. No run changes it afterwards, and no question is asked when the dialog's size differs: the window record keeps a run at another size from reading a message twice. Auto-sync reads at its own size (`getAutoSyncWindowSize`). The branch fork carries the parent collection's over to the new collection.

| Function | File | Notes |
|---|---|---|
| `getCollectionWindowSize(registryKey)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Reads the pointer's `windowSize`; `undefined` when none is kept. |
| `setCollectionWindowSize(registryKey, windowSize)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Set by Vectorize Content at a chat's first read and on a collection that keeps none, by New collection (`startNewChatCollection`), by Start over (`emptyEventBaseCollection`), and by the fork. |

### Collection resolver — find the EventBase collection for a chat

> **Naming convention (apply going forward):**
> `resolve…` returns **the one** active/canonical answer (or `null`).
> `find…`/`list…` return **all** candidates (an array).
> `get…` reads a stored value; `is…`/`has…` return a boolean.
> Pick the verb that matches the contract so callers don't have to read this doc.

**A chat UUID can map to MULTIPLE EventBase collections** — one per persona/handle
(`name1`), plus imported archives registered under a different name. Code that
assumes one collection per backend reads a stale import instead of the active
collection; the **lock** says which one is active. An EventBase ID can end in a
suffix after the UUID, the time a later collection of the chat was made
(`…_{chatUUID}_mh3k2x1a`), so read the UUID an ID holds with
`parseCollectionId(id).chatUUID`, never by the ID's end or its last segment.

| Function | File | Use when |
|---|---|---|
| `collectionInUse(settings, { chatUUID?, chatId? })` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | **The one route, for reads and writes alike.** Returns `{ collection, reason, collections, lockedElsewhere, backend }`: `collection`, the chat's own collection locked to it on the current backend, as `chatOwnCollections` lists it (with `isPaused` and `isAutoSyncOn`); else `null` and `reason`, `no-chat`, `no-collection` (none of its own on this backend), `none-in-use`, `several-in-use` (locks saved before a chat kept one in use) or `other-backend` (`lockedElsewhere` names it). Used by runs, auto-sync, `getChatAutoSyncStatus`, the AutoSync page's marker, ghosting, Summarizer Injection, Vectorize's question and toasts, Start over and every part of StoryArc. With no collection in use, nothing reads or writes the chat's events. |
| `noCollectionInUseText(inUse, consequence, { isWhereToChooseSaid? })` / `showNoCollectionInUse(inUse, consequence)` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | The words for a chat with collections and none in use, why and where to choose, and the red toast saying them (`preventDuplicates`, so auto-sync's per-message toast does not stack); nothing for `no-chat` or `no-collection`. The reply step says it once per reply, naming what was switched on; auto-sync for each message it does not write while one of the chat's collections has auto-sync on; Regenerate links, which sends nothing. The AutoSync page and the StoryArc page say it on the page. |
| `sharedCollectionsLockedHere({ chatUUID?, chatId? })` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | `{ otherChats, archives }`: other chats' EventBase collections and chat files' archive collections locked to the chat, any backend, each with `isPaused`. Retrieval reads them beside the collection in use, unless paused; the fork reads `otherChats` when no window record matches. |
| `resolveEventBaseRunTarget(settings, chatUUID)` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | The collection a run on the chat reads into: the collection in use; `null` while the chat has collections of its own on the current backend but none in use, so the run writes nothing; else, for a chat with none of its own here, the ID its first run builds with `buildEventBaseCollectionId`. Used by `runEventBaseIngestion` when it is handed no collection, which then throws with the route's words, and by Vectorize Content to read and clear that collection's pointer. |
| `chatOwnCollections(settings)` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | The open chat's own collections on the current backend: each `vf_eventbase_` collection whose chat UUID (`parseCollectionId`) is the chat's, that this account made or that is locked to the chat, each with its name, whether it is locked here (`isCollectionActiveForContextAnyKey`), paused, and has auto-sync on. What Collection in use here and the question list, and what `collectionInUse` reads. |
| `askWhichChatCollection(settings, { canMakeNew? })` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | Before Vectorize, Resume, Sync chat or the auto-sync switch writes a chat with collections but none in use, several locked included: asks which one to use and puts it in use. The first three offer New collection last (`canMakeNew`), answered as `NEW_COLLECTION`, which puts nothing in use. |
| `startNewChatCollection(settings, { windowSize })` | [eventbase-chat-collections.js](../src/features/eventbase/eventbase-chat-collections.js) | New collection's collection: the chat's first ID with the time it was made in base 36 after it (`newTimeId`), named as the chat's first with the lowest number from 2 its collections leave (`numberedName`, both in `src/shared/new-group-member.js`), keeping the dialog's window size, scoped to chats and registered. Its run locks it to the chat as it starts, unlocking the chat's others there. Refuses a chat whose UUID its file name stands in for, as the suffix could not be told from it. |
| `emptyEventBaseCollection(registryKey, settings, { windowSize })` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Start over's emptying: deletes every event of the collection, the StoryArc links stored on them with it, listing again after each delete until none is left; then clears its windows, failed windows and tip, keeps where auto-sync started, and keeps the window size given. A delete that fails, or leaves an event it was given, throws with the pointer as it was. |
| `findEventBaseCollectionsForChat(uuid)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Every EventBase collection registered for a chat UUID, on every backend and of every account, in registry order, each with its backend: what `collectionInUse` and `useChatCollection` read. **Never** pick one from it: call `collectionInUse`. Returns `[]` when no collection exists yet. |

**Vectorize Content on a chat that has a collection** (§2.1 of `vectfox-multi-collection-per-chat.md`) asks, once one is in use: **Catch up** reads what it has not read, at the window size it keeps; **Start over**, after a red confirm counting its events, empties it (`emptyEventBaseCollection`) and reads the chat again from the Start from message at the dialog's window size; **New collection** reads the chat from the Start from message into a new collection (`startNewChatCollection`), and says once it is in use that auto-sync is off for it. Every run ends at the End message when one is set, at the window that holds it. With **Read windows already read again** on, Vectorize asks none of these: after a red confirm of what the stretch from Start to End holds, on which models, and what it costs (`describeReadingAgain`), it reads every window of the stretch again into the collection in use, at the window size it keeps. Each window replaces its events, and one whose new read finds none loses them; StoryArc then links the new events and decides again the events whose links went to a replaced one, on the same progress panel (`finishReadingAgain`; InternalProject's `eventbase-read-range-again.md`). A chat with no collection of its own is read into its first, asking nothing. Resume is the dialog's Catch up; Sync chat and the auto-sync switch's catch-up catch up too. The dialog opened on New collection (`openContentVectorizer({ isOnNewCollection: true })`, from Collection in use here or the question's New collection in Sync chat) makes one at Vectorize, asking nothing. A chat file is read into its archive collection, asking before it reads one again.

#### One route: `collectionInUse`, with no fallback (D18)

A chat holds 1 to N collections, so no reader or writer may guess which one it means. Every one of them asks `collectionInUse`, which reads and writes alike take the same answer from:

1. **The chat's own collections:** `vf_eventbase_` collections whose chat UUID, read by `parseCollectionId`, is the chat's (never a substring of the ID), on the current backend, that this account made or that is locked here (an imported or other-persona collection of the chat counts once locked).
2. **The one in use:** the one of them locked to the chat, by the lock check the Database Browser's Active here makes (`isCollectionActiveForContextAnyKey([registryKey, collectionId], { chatId })`), so a chat lock on a collection scoped to characters counts for nothing.
3. **Otherwise none,** with why: none locked, several locked, or the one locked made on the other backend. Nothing reads or writes the chat's events then, and whatever is switched on says so in red (`showNoCollectionInUse`).

**Another chat's collection locked here** is read by retrieval beside the chat's own (`sharedCollectionsLockedHere`), the supported way to retrieve an older chat's events while playing this one. It is never written, never StoryArc's and never the Summarizer's: a chat whose only EventBase collection is a foreign one locked in has its events retrieved and reports `no-collection`, as it has nowhere of its own to write yet; vectorizing then creates it.

**Why writes cannot follow a foreign lock:** if ingestion honored that lock, chat B's events would land in chat A's collection, where the two chats' independent `source_window_end` values collide inside one sort frame — `_orderEventsForPresentation` groups by `_sortFrame` (the collection ID), so one collection means one frame and the injected timeline interleaves both conversations. `ensureVectorizationTip` would then read A's tip (a message index in A) and skip every window in B.

**Why the collection in use must be on the current backend:** every write caller passes only the bare `collectionId` to the backend `settings.vector_backend` chooses. A `vectra:vf_eventbase_standard_…` collection still locked to the chat after a switch to Qdrant would be re-created in Qdrant under its Vectra name. The route gives `other-backend` instead, naming it; a chat with none of its own on the new backend is read into a correctly named `vf_eventbase_qdrant_…` first collection.

**Invariant — one lock check:** the Database Browser's Active here (`isCollectionActiveForContext`), the route and `sharedCollectionsLockedHere` all read `isCollectionActiveForContextAnyKey`, so a collection shown active here is the one read and written.

Group chats are unaffected: all speakers share one chat UUID, so their collections are the chat's own whichever `name2` was live when the ID was built.

### Low-level window record management

Called internally by the ingestion loop. Do not call from application code; reimplementing them inline breaks dedup.

| Function | File | Notes |
|---|---|---|
| `windowFingerprint(sourceHashes)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Deterministic sorted-join of message hashes. A fingerprint from `windowSize=2` never equals one from `windowSize=4`; `isWindowAlreadyExtracted` also reads each message's hash out of the fingerprints, so a window whose messages were all read in windows of other sizes reads as read. A window holding messages read and unread does not, which is why the start marker is needed as a second safety layer. |
| `clearWindowCache(registryKey)` | [eventbase-store.js](../src/features/eventbase/eventbase-store.js) | Clears a collection's window record and unfinished record, so its next run reads every window again. The far-behind tip check calls it, and `clearExtractionCaches` with the tip. Do NOT call on window-size change — that would force full re-extraction; use `stampAutoSyncMarker` instead. |

### Auto-sync entry points

| Function | File | Role |
|---|---|---|
| `synchronizeChat(settings, triggerEvent)` | [eventbase-chat-sync.js](../src/features/eventbase/eventbase-chat-sync.js) | The auto-sync coordinator. Gates on **the collection in use only** — `collectionInUse(settings, { chatUUID, chatId })`, then its `isAutoSyncOn` — never a flag left on another of the chat's collections. With none in use it writes nothing and, while one of the chat's collections has auto-sync on, says so in red for each message (`showNoCollectionInUse`). Then calls `runEventBaseIngestion({ isAutoSync: true, collectionIdOverride: inUse.collectionId })`. **The override is load-bearing**: it pins the run to the collection in use so a group chat doesn't manufacture a new per-speaker collection each turn. A model the provider no longer knows turns auto-sync off for the collection in use (`pauseCollectionAutoSync`). Called from ST event hooks (MESSAGE_SENT, MESSAGE_RECEIVED, etc.) in [src/index.js](../src/index.js), which schedule nothing while the VectFox master switch is off; it also bails on its own master-switch check (`isVectFoxEnabled` — see [feature-gate.js](../src/shared/feature-gate.js)) when the switch goes off inside the debounce window. Pass `triggerEvent` so it can suppress the popup on MESSAGE_SENT mid-generation. |
| `runEventBaseReplyStep(chat, settings, type)` | [eventbase-reply.js](../src/features/eventbase/eventbase-reply.js) | The reply step, which the ST generation interceptor `vectfox_rearrangeChat` in [src/index.js](../src/index.js) (manifest `generate_interceptor`, runs before the prompt is built) runs beside LoreBase's pick. It runs EventBase retrieval, the Summarizer injection and ghosting, all three on the collection in use it asks `collectionInUse` for once, and says once, in red, when the chat has collections and none in use. **Separate concern from `synchronizeChat`** — retrieval does not trigger auto-sync extraction. Every generation first empties the EventBase and Summarizer blocks via `clearInterceptorPrompts`, so a turn that injects nothing never resends last turn's memory, then returns early on a quiet prompt (`isQuietPrompt` in [src/shared/last-generation-core.js](../src/shared/last-generation-core.js): a quiet generation that is not quiet-to-loud, whose caller builds its own prompt; D4 of the public API plan), when the master switch is off (`isVectFoxEnabled`), no chat is open, or the chat is shorter than `min_chat_length`. A quiet-to-loud generation, shown as a reply, and an impersonation run the step. SillyTavern passes the interceptor the type alone, so `followGenerations` ([src/shared/last-generation.js](../src/shared/last-generation.js)) keeps what `GENERATION_AFTER_COMMANDS` said of the last generation, for this step and LoreBase's pick. The Query Tester calls `runEventBaseRetrieval` itself with `dryRun` and `testMessage`, so it is exempt from the master switch and debugging still works. |

### Key-form parity

**Key-form parity is load-bearing.** Four sites read or write the per-collection autoSync flag: `refreshAutoSyncCheckbox` (UI mirror), `getChatAutoSyncStatus` (state evaluator), the change handler (writer), and `synchronizeChat` (the engine that actually fires extraction). All four must use the **registry-key form** (`backend:id`) — built via `buildRegistryKey(collectionId, settings)` or pulled from `entry.registryKey`. One site reading with the bare collection ID while the others write with the registry key looks in the wrong bucket and sees `undefined`: the flag is saved, yet the popup never fires and extraction never runs.

State evaluator: **`async getChatAutoSyncStatus(settings, { shouldProbeBackend = true })`** in `src/features/eventbase/eventbase-workflow.js`. Reads the pointer of the chat's collection in use (`collectionInUse`); performs at most ONE backend probe per (collection, page load) for the vectorization tip (see below). `shouldProbeBackend: false` skips that probe and reports only the cached tip; `refreshAutoSyncCheckbox` passes it while the master switch is off, so a passive panel refresh never calls the backend. Returns one of:

```
{ state: 'no-chat' }
{ state: 'no-collection' }
{ state: 'none-locked', collections }
{ state: 'vectorization-ahead', collectionId, registryKey, chatMessageCount, commitBoundary, unfinishedWindowCount, markerValue?, vectorizationTip }
{ state: 'partial',          collectionId, registryKey, chatMessageCount, commitBoundary, unfinishedWindowCount, markerValue?, vectorizationTip? }
{ state: 'fully-vectorized', collectionId, registryKey, chatMessageCount, commitBoundary, unfinishedWindowCount: 0, markerValue?, vectorizationTip? }
```

Match logic: asks **`collectionInUse(settings, { chatUUID, chatId })`**, the route every reader and writer asks; with none in use, the status is `none-locked`, with the chat's own collections and the route's words for why (`noneInUseText`), for a chat that has some on this backend, else `no-collection`. It does no UUID walk of its own (see "One route" above). A chat whose ONLY EventBase collection is a foreign one locked in for retrieval correctly reports `no-collection`; turning the switch on then offers a fork when the chat is a branch or checkpoint, and Vectorize Content otherwise (see "Branch and checkpoint fork" below).

"Fully vectorized" is determined by `isChatFullyVectorized(messages, settings, registryKey)`, which checks that the last possible window for the current message count is already in the collection's `extractedWindows` and that no window of that size is in its `unfinishedWindows`. No DB query, just an O(1) Set lookup and a read of the record.

**`vectorizationTip`** is the tip from "Vectorization tip cache" above. The status prefers it over `markerValue` for its "vectorized: N messages" count, because the start marker (the pointer's `autoSyncStartMarker`) is stamped once at enable time and never moves.

**`vectorization-ahead` state** covers the collection's vectorization tip being past the current chat's message count: its events were read on a longer chat. Usual causes: messages were deleted after vectorizing, a summarizer replaced some with a summary, or the user bound a vectorization extracted from a longer copy of the chat. The tip then counts nothing in this chat, so nothing trusts it: the ingestion fast-forward checks each window against the window record instead of recording every window below the tip as read, ghosting blanks nothing until the chat passes the tip, and Sync chat asks to read what the record does not hold, with no count. Auto-sync goes on with the chat's new messages, as its run first moves a marker past the chat's end back to the chat's unread end (`capAutoSyncMarker`), so the turn it held back is read with them. The page says what happened, so a vectorization bound by mistake still shows. A summary that leaves the tip inside the chat, or that the chat grows back over before the next auto-sync run, is not caught: only reading each summary as its originals is (H4 of InternalProject/Vectfox/plans/vectfox-public-api.md).

**`refreshAutoSyncCheckbox(settings)`** fires on:
- AutoSync tab click
- `CHAT_CHANGED` event
- Initial load
- `vectfox:collections-updated` custom event
- `vectfox:eventbase-synced` custom event (after an ingestion run completes)
- Master switch toggle (OFF: shows the paused status; ON: after the network startup re-runs)

Each refresh also draws **Collection in use here** at the top of the Auto-sync card (`autoSyncCollectionMarkup`, on the in-use switcher): the chat's own collections, the one in use chosen as the route gives it (`getChatAutoSyncStatus`'s registry key), "None in use here" while none is, several locked to the chat included, so that each can be chosen, then New collection; nothing for a chat with no collection. A choice puts it in use through `useChatCollection` and draws the page again (`bindCollectionInUse` in `autosync-collection-in-use.js`); New collection opens Vectorize Content on New collection and puts nothing in use. Opening such a chat says nothing: auto-sync says so in red for each message it does not write, while one of the chat's collections has it on (one route, below).

While the master switch is off, `refreshAutoSyncCheckbox` reads only cached state and calls no backend (`shouldProbeBackend: false`), and every has-collection state shows the paused status below. It still runs on chat change so the switch matches the current chat — the Summarizer Injection switch reads it.

Resolution table. `autoSyncStatusMarkup` in [autosync-page-markup.js](../src/features/settings-panel/autosync-page-markup.js) builds each status from these states:

| State | autoSync flag | Lock | Switch | Tone | Status |
|---|---|---|---|---|---|
| `no-chat` | — | — | off | warning | "No chat open." |
| `no-collection` | — | — | off | warning | "Not vectorized yet. Turning auto-sync on starts it." |
| `none-locked` | — | none of the chat's in use | off | warning | The route's words (`noneInUseText`), as "No collection is in use in this chat, so EventBase reads and writes nothing here. Choose one above." |
| has-collection, master switch off | any | any | on iff flag + lock | plain | "Paused while VectFox is off." + counts |
| has-collection | false OR no lock | — | off | plain | "Off for this chat." + counts |
| `vectorization-ahead` | true | locked | on | warning | "This chat is shorter than what EventBase read." + the counts + what happened, and what auto-sync, ghosting and Sync chat do now |
| `partial`, failed windows on the record | true | locked | on | warning | "N windows failed and hold no events. Resume in Vectorize Content sends them again." + counts |
| `partial` | true | locked | on | warning | "Behind. The next auto-sync catches up." + counts |
| `fully-vectorized` | true | locked | on | success | "Up to date." + counts |

The counts line reads `Chat: N messages · vectorized: M messages` when the chat's count is known, the second part when the tip or marker is. A fully vectorized chat whose newest turn the settle lag holds back adds `· the latest turn waits to settle`.

**Change handler** (the user turns the switch):

| Action | Behaviour |
|---|---|
| On + no-chat | Warning toast, switch back off |
| On + none-locked | `askWhichChatCollection`: the one chosen is put in use and the status re-read, continuing as below; Cancel leaves auto-sync off |
| On + no-collection, branch/checkpoint with a fork source | Popup: **Fork from parent** → `forkEventBaseFromSource`, re-read status, continue as partial / fully-vectorized · **Vectorize from scratch** → open Vectorize Content (`openContentVectorizer()`) · close → switch off |
| On + no-collection, otherwise | Info toast, open Vectorize Content (`openContentVectorizer()`); auto-sync turns on when that run finishes |
| On + partial or fully-vectorized | `useChatCollection(registryKey)` + `setCollectionAutoSync(registryKey, true)` + the start-marker stamp. A far-behind chat first asks whether to catch up now or keep up from here; closing that popup leaves auto-sync off |
| Off | `setCollectionAutoSync(registryKey, false)` + `clearAutoSyncMarker(registryKey)` only. **Does NOT remove the chat lock** — the lock is a separate concern (retrieval activation / explicit user choice via the DB Browser), so disabling auto-sync must not deactivate the collection. Unlocking is the DB Browser's job. |

Every path that leaves auto-sync off also turns Summarizer Injection off, since its newest events would go stale.

`registryKey` here is `status.registryKey` from `getChatAutoSyncStatus` — the canonical `"backend:id"` form. All four metadata read paths (this table, `refreshAutoSyncCheckbox`, `synchronizeChat`, `getChatAutoSyncStatus`) use the same form. After mutation, dispatches `vectfox:collections-updated` and re-runs `refreshAutoSyncCheckbox` so the status updates.

### Branch and checkpoint fork

SillyTavern gives every new branch and checkpoint its own `chat_metadata.integrity` (ST #5943), so it has a new chat UUID and no EventBase collection of its own — `collectionInUse` finds none of its own, even when the parent's collection is locked here. Writing into the parent's collection is not an option: after the split the two chats' `source_window_end` values describe different stories, and the parent's tip is past the branch's messages. Instead the branch **forks**: the parent's events for the shared messages are copied into the branch's own collection with their stored vectors (no LLM extraction, no re-embedding), and auto-sync extracts only what comes after the split.

**When:** the auto-sync switch is turned on, `getChatAutoSyncStatus` reports `no-collection`, and the chat has `chat_metadata.main_chat` (SillyTavern sets it only on branches and checkpoints).

**Finding the parent** — by message content, so it works after the parent chat file is deleted (deleting a chat does not delete its collection):
1. **The collections' window records** (each EventBase collection's `extractedWindows`, window fingerprints of source message hashes), searched over the current persona's EventBase collections of other chats on the current backend that are locked to the parent chat (`main_chat`): only a collection in use there is read (D18). No backend reads. The collection whose hashes match the longest run of this chat's opening messages wins. A candidate needs at least one recorded window made entirely of shared messages, which rules out chats that share only the greeting. When collections of another chat hold this chat's opening messages but none is locked to the parent chat, none is read: the fork says so in red, and auto-sync stays off.
2. **Locked collection of another chat** — when the record has no match (extracted on another install, imported, or record cleared). Each such EventBase collection locked to this chat (`sharedCollectionsLockedHere`) is read once and matched by its events' `source_message_hashes`.

**Split point** = length of that matching run. Copied: every event whose `source_window_end` is before it, including events whose message was edited in the parent after extraction (the parent still uses them). If a parent message near the split was edited and never re-extracted, the run stops early and auto-sync re-extracts a few extra windows — never the reverse.

**After the copy** the branch collection is registered, `scope: 'chat'`, and put in use in this chat (`useChatCollection`); the source is unlocked from this chat; the copied windows go into the branch collection's window record, its tip is set to the split, and the parent collection's window size carries over. The enable flow then continues as for any existing collection (backlog gate, `setCollectionAutoSync`, `stampAutoSyncMarker`). A failure or stop during the copy purges the partial collection. The fork refuses when vectors are missing or the parent was embedded with a different provider/model.

| Function | File | Role |
|---|---|---|
| `findEventBaseForkSource(settings)` | [eventbase-fork.js](../src/features/eventbase/eventbase-fork.js) | `{ source, problem }`: the parent's collection in use and the split point; or none, with why when collections of another chat hold the branch's messages but none is in use in its parent |
| `forkEventBaseFromSource(settings, source)` | [eventbase-fork.js](../src/features/eventbase/eventbase-fork.js) | Copy + activation, with progress panel |
| `rankForkSourcesFromWindowRecords`, `measureSharedPrefix`, `selectChunksBeforeSplit`, … | [eventbase-fork-core.js](../src/features/eventbase/eventbase-fork-core.js) | Pure matching/selection rules |
| `hashSourceMessage(message)` | [eventbase-message-hash.js](../src/features/eventbase/eventbase-message-hash.js) | The one message hash behind `source_message_hashes`, window fingerprints and fork matching |
| `fetchPortableChunks`, `insertChunksWithVectors` | [collection-export.js](../src/features/collections/collection-export.js) | The export/import read and write, shared with the fork |

## Manual vs auto-sync paths

UI elements that mirror lock state are pulled in two ways. The distinction matters because the manual paths have side effects.

| Trigger | Calls `.trigger('change')` | Lock mutation? |
|---|---|---|
| User turns the auto-sync switch | (browser-native) | **Yes** — change handler removes/sets chat lock |
| User moves the lock switch in Collection Settings | (via Save button) | **Yes** — `writeLockHere` mutates |
| `refreshAutoSyncCheckbox` auto-state | **No** — direct `prop()` | **No** — pure UI mirror |
| Collection Settings after Manage locks | **No** — the switch is set directly | **No** — re-reads the locks Manage locks set |

**Rule:** auto-sync paths must never invoke the change handler. Otherwise, opening the AutoSync page could trigger lock removal as a side effect of the UI sync.

## Custom events

| Event | Fired by | Listeners |
|---|---|---|
| `vectfox:collections-updated` | `useChatCollection` when a lock changed, Collection in use here, `editCollectionSettings` on a save or a lock change, the auto-sync switch | `refreshAutoSyncCheckbox` |
| `vectfox:eventbase-synced` | `runEventBaseIngestion` at end of run | `refreshAutoSyncCheckbox` |

Plus ST's `CHAT_CHANGED` — the same refresh handler re-runs.

These DOM events are VectFox's own signals between its pages. What other extensions hear is the public API's `vectfox_*` events on SillyTavern's `eventSource` ([public-api.md](public-api.md)): EventBase tells them through the listeners `src/index.js` sets (`eventbase-announcements.js`), each end of a run, finished, stopped or failed (`endRun` in `eventbase-workflow.js`), each removal with its event IDs, and the collection in use whenever `followCollectionInUse` sees it change.

## Key files

| File | Role |
|---|---|
| `src/shared/collection-ids.js` | `buildRegistryKey`, `parseRegistryKey`, `resolveBackendForCollection`, `getBackendFromCollectionId`, `remapCollectionIdToBackend`, `normalizeBackendForId`, `KNOWN_BACKEND_LABELS` |
| `src/features/collections/collection-metadata.js` | `isCollectionActiveForContext`, `isCollectionActiveForContextAnyKey`, `isCollectionEnabled`, `getCollectionLocks`, `getCollectionCharacterLocks`, `setCollectionLock`, `removeCollectionLock`, `setCollectionCharacterLock`, `removeCollectionCharacterLock`, `setCollectionAutoSync` |
| `src/features/collections/collection-loader.js` | Migration (`scope='global'` → `'character'`), `loadAllCollections`, `getCollectionListing` |
| `src/features/vector-backend/vector-api.js` | `queryCollection` — the canonical per-collection-backend routing entry point |
| `src/features/eventbase/eventbase-workflow.js` | `getChatAutoSyncStatus`, `isChatFullyVectorized`, dispatches `vectfox:eventbase-synced`; `runEventBaseRetrieval`, which reads the collection in use beside `sharedCollectionsLockedHere`'s |
| `src/features/eventbase/eventbase-chat-collections.js` | The one route, `collectionInUse`, and its words (`noCollectionInUseText`, `showNoCollectionInUse`); `chatOwnCollections`, `sharedCollectionsLockedHere`, `useChatCollection`, `askWhichChatCollection`, `resolveEventBaseRunTarget`, `startNewChatCollection` |
| `src/features/database-browser/database-browser.js` | The Active here pill (`activeHereLine`) |
| `src/features/database-browser/collection-dialogs.js` | Collection Settings' lock switch (`lockAreaView`, `saveCollectionSettings`, `writeLockHere`) and Manage locks (`manageCollectionLocks`) |
| `src/features/settings-panel/settings-panel.js` | `refreshAutoSyncCheckbox`, the auto-sync switch handler, event listeners |

## Things you should NOT do

- Don't call `.trigger('change')` from any refresh/auto-sync path. Use `prop('checked', x)` directly and persist settings inline.
- Don't add backend probes to checkbox-state evaluators. `isCollectionActiveForContext` uses in-memory data only; `getChatAutoSyncStatus`'s only backend call is the one-time vectorization-tip probe, which `shouldProbeBackend: false` skips.
- Don't add `scope === 'global'` checks. The only legitimate one is the rewrite block in `loadAllCollections`.
- Don't duplicate `isCollectionActiveForContext` logic inline. If you need it in a new place, import it.
- Don't write directly to `lockedToChatIds` / `lockedToCharacterIds`. Use the `setCollectionLock` / `removeCollectionLock` / `setCollectionCharacterLock` / `removeCollectionCharacterLock` helpers, or `cleanUpCollectionLocks` for every record at once: the chat-lock helpers keep the `chat_lock_index` reverse map in step, and `cleanUpCollectionLocks` rebuilds it.
- Don't pass bare collection IDs to `queryCollection` (in `src/features/vector-backend/vector-api.js`). The function routes by backend prefix internally via `resolveBackendForCollection`. Bare IDs work *only* when the backend can be detected from the ID structure — registry-key form is the canonical input.
- Don't hand-roll backend detection (`id.includes('_qdrant_') ? 'qdrant' : 'standard'`). Use `resolveBackendForCollection(id)` — it returns the bare collectionId you'll need for the backend call anyway.
