# Similharity Server Plugin

Server-side plugin for [the VectFox](https://github.com/KritBlade/VectFox) extension that provides enhanced vector database backends and full metadata storage capabilities.

> **Deployment scope — local / LAN use only.** This plugin is designed for a single-user SillyTavern install on the user's own machine (or a private LAN). The plugin's `/chunks/*` and embedding routes relay user-configured URLs (Ollama, vLLM, Qdrant) without host allowlisting — this is intentional, because those URLs are legitimately set to `127.0.0.1` / RFC1918 addresses for self-hosted servers. Do **not** expose this plugin to the public internet or use it in a multi-tenant deployment where users don't trust each other. SillyTavern itself isn't designed for multi-tenant isolation; this plugin matches that scope. See header in `index.js` for the full threat-model rationale.

---

## Features

- **Qdrant Backend** - High-performance vector search with multitenancy support
- **Enhanced Vectra** - Full metadata storage (bypasses ST's hash/text/index limitation)
- **Collection Browser** - List all collections across all backends
- **Folder Explorer** - Open collection folders directly from UI

---

## Installation

### Prerequisites (Windows): Install Git and Node.js

The install steps below use two commands: `git` and `npm`. On Windows you need to install these once first. (If you already run SillyTavern from source, you have Node.js/npm already — you may only need Git.)

**1. Open the Command Prompt:**

1. Press the **Windows key** on your keyboard (or click the Start button).
2. Type **`cmd`**
3. Press **Enter**. A black window with white text opens — that's the Command Prompt.

**2. Type these two commands, one at a time.** After typing each one, press **Enter** and wait for it to finish before typing the next:

```bat
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

- `Git.Git` installs **Git** (gives you the `git` command).
- `OpenJS.NodeJS.LTS` installs **Node.js**, which includes **npm** (gives you the `npm` command).
- `winget` is built into Windows 10 and 11, so you don't need to install anything to run these.

**3. Close the Command Prompt window and open a new one** (repeat step 1). This is important — the new commands only work in a freshly opened window.

**4. Check it worked.** Type each of these and press Enter; you should see a version number, not an error:

```bat
git --version
npm --version
```

If both print a version, you're ready. Continue to Step 1 below.

> On **Linux/Mac**, install Git and Node.js with your system package manager (e.g. `sudo apt install git nodejs npm`, or `brew install git node`) instead of `winget`.

### Step 1: Enable Server Plugins

Add to your `config.yaml` (in SillyTavern root folder):

```yaml
enableServerPlugins: true
```

### Step 2: Install Plugin via Git (RECOMMENDED)

**This method enables automatic updates!**

Open a terminal/command prompt in your SillyTavern folder and run:

```bash
cd plugins
git clone -b Similharity-Plugin https://github.com/KritBlade/VectFox.git similharity
cd similharity
npm install
```

Your folder structure should now look like:
```
SillyTavern/
└── plugins/
    └── similharity/
        ├── .git/          <-- THIS IS IMPORTANT FOR AUTO-UPDATES
        ├── index.js
        ├── package.json
        ├── qdrant-backend.js
        └── README.md
```

### Step 3: Restart SillyTavern

Check console for:
```
[similharity] Initializing v<the version in package.json>...
[similharity] Plugin initialized successfully
```

---

## Auto-Updates

**If you installed via `git clone` (Step 2 above)**, the plugin will automatically update every time you restart SillyTavern!

SillyTavern runs `git pull` on all plugin folders that are git repositories on startup. This is enabled by default.

### Verify Auto-Update is Working

1. Check that `.git` folder exists inside `plugins/similharity/`
2. On startup, look for this message in console:
   ```
   Auto-updating server plugins...
   ```

### If You Downloaded Manually (ZIP)

If you downloaded the plugin as a ZIP file instead of using `git clone`, auto-updates **will not work**. To fix this:

1. Delete the `plugins/similharity` folder
2. Follow Step 2 above to reinstall via git
3. Your settings and data are stored separately and won't be lost

### Disable Auto-Updates (Optional)

If you want to disable auto-updates, add to `config.yaml`:

```yaml
enableServerPluginsAutoUpdate: false
```

---

## API Endpoints

All endpoints are prefixed with `/api/plugins/similharity`

### Health Check

#### `GET /health`

Returns plugin status and capabilities.

**Response:**
```json
{
  "status": "ok",
  "plugin": "similharity",
  "version": "<the version in package.json>",
  "features": [
    "vectra-full-metadata",
    "qdrant",
    "collection-browser",
    "folder-explorer"
  ]
}
```

---

## Collection Management

### List All Collections

#### `GET /collections`

Scans all vector backends (Standard/Vectra, Qdrant) and returns unified collection list.

**Response:**
```json
{
  "success": true,
  "count": 3,
  "collections": [
    {
      "id": "similharity_chat_Alice",
      "source": "transformers",
      "backend": "standard",
      "chunkCount": 150,
      "modelCount": 1
    },
    {
      "id": "similharity_global",
      "source": "qdrant",
      "backend": "qdrant",
      "chunkCount": 1000,
      "modelCount": 1
    }
  ]
}
```

### Get Collection Info

#### `GET /collection/:id?source=transformers`

Returns detailed info about a specific collection.

**Parameters:**
- `id` (path) - Collection ID
- `source` (query) - Embedding source (default: `transformers`)

**Response:**
```json
{
  "success": true,
  "info": {
    "id": "similharity_chat_Alice",
    "source": "transformers",
    "exists": true,
    "models": [
      {
        "name": "Xenova_all-MiniLM-L6-v2",
        "size": 524288
      }
    ],
    "totalChunks": 150,
    "totalSize": 524288
  }
}
```

### List Embedding Sources

#### `GET /sources`

Lists all available embedding sources in the vectors directory.

**Response:**
```json
{
  "success": true,
  "count": 3,
  "sources": ["transformers", "openai", "palm"]
}
```

### Open Collection Folder

#### `POST /open-folder`

Opens the collection folder in file explorer (platform-specific).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "backend": "standard"
}
```

**Response:**
```json
{
  "success": true,
  "path": "C:/ST/data/vectors/transformers/similharity_chat_Alice"
}
```

**Note:** Qdrant collections have no local folder (remote storage).

---

## Qdrant Backend

**Multitenancy Support:** Qdrant uses a single collection with payload filters to separate data from different sources (chat/character/global).

### Initialize

#### `POST /qdrant/init`

Connects to Qdrant server.

**Request:**
```json
{
  "url": "http://localhost:6333",
  "apiKey": "your-api-key"
}
```

**Alternative (host/port):**
```json
{
  "host": "localhost",
  "port": 6333,
  "apiKey": "your-api-key"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Qdrant initialized"
}
```

### Health Check

#### `GET /qdrant/health`

Checks Qdrant server health.

**Response:**
```json
{
  "healthy": true
}
```

### Insert Vectors (Multitenancy)

#### `POST /qdrant/insert`

Inserts vectors with tenant metadata for filtering.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "items": [
    {
      "hash": "abc123",
      "text": "Ancient lore about dragons",
      "vector": [0.1, 0.2, 0.3, ...],
      "importance": 200,
      "keywords": ["dragon", "lore"]
    }
  ],
  "tenantMetadata": {
    "type": "chat",
    "sourceId": "alice_chat_001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 1
}
```

### Query Collection (Multitenancy)

#### `POST /qdrant/query`

Searches with payload filters for multitenancy.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "queryVector": [0.1, 0.2, 0.3, ...],
  "topK": 10,
  "filters": {
    "type": "chat",
    "sourceId": "alice_chat_001",
    "minImportance": 100
  }
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "hash": "abc123",
      "text": "Ancient lore about dragons",
      "score": 0.95,
      "metadata": {
        "importance": 200,
        "keywords": ["dragon", "lore"]
      }
    }
  ]
}
```

### List Hashes (Multitenancy)

#### `POST /qdrant/list`

Lists hashes with tenant filters.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "filters": {
    "type": "chat",
    "sourceId": "alice_chat_001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "hashes": ["abc123", "def456"]
}
```

### Delete Vectors

#### `POST /qdrant/delete`

Deletes specific items by hash.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "hashes": ["abc123", "def456"]
}
```

**Response:**
```json
{
  "success": true,
  "deleted": 2
}
```

### Purge Collection (Multitenancy)

#### `POST /qdrant/purge`

Purges vectors matching tenant filters.

**Request:**
```json
{
  "collectionId": "similharity_global",
  "filters": {
    "type": "chat",
    "sourceId": "alice_chat_001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Collection similharity_global purged"
}
```

### Purge All Collections

#### `POST /qdrant/purge-all`

Deletes ALL Qdrant collections. **Use with extreme caution!**

**Response:**
```json
{
  "success": true,
  "message": "All collections purged"
}
```

---

## LoreBase

VectFox's LoreBase has its model write keys for each lorebook entry the user turns on, and keeps them in Qdrant: one collection with no vectors, `vectfox_lorebase_keys`, a point per entry, each SillyTavern user reading and writing only their own. The collection is never listed as a VectFox collection. Each entry's vectors are points of its book's tenant, `vf_lorebase_qdrant_<account>_<book>`, in the account's own collection, `vf_lorebase_<account>`, or in `vectfox_main` while VectFox's One shared collection is on. `<account>` is the user's handle in lower case, each run of characters other than a to z, 0 to 9 and the hyphen turned into one hyphen, so it never holds an underscore.

### List Books

#### `POST /lorebase/books`

Lists the requesting user's LoreBase books as Qdrant holds them: how many entries of each book have keys, an empty list included, and each of the account's book tenants in its own collection and in `vectfox_main`, with its point count, the book its points name (their `lorebookName`) and the embedding source and model one of them was stored with. `GET /collections`, which VectFox's discovery reads, stays as it was: it lists an account's `vf_lorebase_<account>` whole, never its books.

**Request Body:** `{}`

**Response:**
```json
{
  "keys": [{ "book": "Harbor book", "entryCount": 313 }],
  "vectors": [{
    "collection": "vf_lorebase_rabbit",
    "tenant": "vf_lorebase_qdrant_rabbit_harbor_book_1x9k2mq",
    "book": "Harbor book",
    "pointCount": 640,
    "embeddingSource": "custom",
    "embeddingModel": "baai/bge-m3"
  }]
}
```

A tenant whose point names no book has `"book": null`. Qdrant not set up answers 500.

### Write Keys

#### `POST /lorebase/keys/write`

Writes the keys of some of a book's entries, replacing any they had. An entry holds 0 to 200 keys of up to 300 characters each: an empty list is an entry LoreBase's model found nothing in to key, kept so it is not asked again. An entry's `title`, up to 2,000 characters, is stored with its keys when given; an entry written with none keeps none.

**Request Body:**
```json
{
  "book": "Harbor book",
  "entries": [{ "uid": "3", "title": "Harbor lighthouse", "keys": ["lighthouse", "keeper"] }]
}
```

**Response:** `{ "written": 1 }`. A malformed body answers 400; Qdrant not set up answers 500, saying LoreBase keeps its keys in Qdrant.

### Read Keys

#### `POST /lorebase/keys/read`

**Request Body:** `{ "books": ["Harbor book"] }`

**Response:** `{ "books": { "Harbor book": { "3": ["lighthouse", "keeper"], "5": [] } }, "titles": { "Harbor book": { "3": "Harbor lighthouse" } } }`, every named book present in each, `{}` when none of its entries has keys written; an entry written with an empty list reads back as `[]`, and one written with no title is in `books` alone.

### Delete Keys

#### `POST /lorebase/keys/delete`

Deletes the requesting user's keys: those of the named books' entries, or, with no `books`, of every entry in every book. Other users' keys stay. `books`, when given, lists 1 to 2,000 book names; an empty list, or anything else, answers 400 and deletes nothing.

**Request Body:** `{ "books": ["Harbor book"] }`, or `{}` for every book

**Response:** `{ "deleted": 311 }`, how many entries' keys were deleted.

### Ask Jev (Fast and cheap)

#### `POST /lorebase/decisions`

LoreBase's Fast and cheap choice asks Jev, a decisions model, whether the next reply needs each selected entry, on the SillyTavern connection profile chosen for it. The request names the profile's source, its URL for a Custom profile, its model and its key's ID; the key is read here and goes only where SillyTavern sends it: an OpenRouter key to `https://openrouter.ai/api/v1/systemone`, a Custom key to the profile's own URL with `/systemone`.

**Request Body:**
```json
{
  "source": "openrouter",
  "model": "typesafe/jev-1.14",
  "secret_id": "<the profile's key ID>",
  "state": "The chat so far. ...",
  "questions": { "e1": { "type": "noul", "instructions": "Does the next reply need the lorebook entry \"Harbor lighthouse\" (about: lighthouse, keeper)?" } }
}
```

**Response:** `{ "yes": { "e1": 0.34 }, "inputTokens": 120, "usd": 0.000014 }`. A malformed request answers 400; a refusal answers 502 with its status and a fixed hint, never the server's reply.

---

## Vectra (Standard Backend) - Enhanced

**Why Enhanced Vectra?**

SillyTavern's `/api/vector/insert` is hardcoded to only store `{hash, text, index}`. This plugin provides custom endpoints that store **full metadata** for chunk properties like importance, keywords, conditions, etc.

### Insert with Full Metadata

#### `POST /vectra/insert`

Stores ALL chunk metadata fields (not just hash/text/index).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers",
  "items": [
    {
      "hash": "abc123",
      "text": "We defeated the dragon in the mountains.",
      "index": 0,
      "name": "Dragon Battle",
      "importance": 150,
      "keywords": ["dragon", "combat", "victory"],
      "disabled": false,
      "customWeight": 1.5,
      "conditions": {
        "enabled": true,
        "rules": [
          { "type": "keyword", "operator": "contains", "value": "dragon" }
        ]
      },
      "chunkGroup": "Combat Scenes",
      "groupBoost": 1.2,
      "summaryVectors": ["Epic dragon fight"],
      "isSummaryChunk": false,
      "parentHash": null,
      "metadata": {
        "timestamp": 1234567890,
        "messageIndex": 42,
        "sceneTitle": "Mountain Battle"
      }
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 1
}
```

### List with Full Metadata

#### `POST /vectra/list`

Returns ALL items with complete metadata (not just hash/text/index).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers"
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "vector": [0.1, 0.2, 0.3, ...],
    "metadata": {
      "hash": "abc123",
      "text": "We defeated the dragon in the mountains.",
      "index": 0,
      "name": "Dragon Battle",
      "importance": 150,
      "keywords": ["dragon", "combat", "victory"],
      "disabled": false,
      "customWeight": 1.5,
      "conditions": {...},
      "chunkGroup": "Combat Scenes",
      "groupBoost": 1.2,
      "summaryVectors": ["Epic dragon fight"],
      "isSummaryChunk": false,
      "parentHash": null,
      "timestamp": 1234567890,
      "messageIndex": 42,
      "sceneTitle": "Mountain Battle"
    }
  }
]
```

### Query with Full Metadata

#### `POST /vectra/query`

Searches and returns results with ALL metadata.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers",
  "searchText": "dragon battle",
  "topK": 10,
  "threshold": 0.5
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "score": 0.92,
    "metadata": {
      "name": "Dragon Battle",
      "importance": 150,
      "keywords": ["dragon", "combat", "victory"],
      ...
    }
  }
]
```

---

## Embedding Utilities

### Query with Vectors

#### `POST /query-with-vectors`

Returns results **with embedding vectors** (for client-side similarity calculations).

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers",
  "queryVector": [0.1, 0.2, 0.3, ...],
  "topK": 10,
  "threshold": 0.5
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "vector": [0.1, 0.2, 0.3, ...],
    "score": 0.92
  }
]
```

### List with Vectors

#### `POST /list-with-vectors`

Returns all items **with embedding vectors**.

**Request:**
```json
{
  "collectionId": "similharity_chat_Alice",
  "source": "transformers"
}
```

**Response:**
```json
[
  {
    "hash": "abc123",
    "text": "We defeated the dragon in the mountains.",
    "index": 0,
    "vector": [0.1, 0.2, 0.3, ...]
  }
]
```

### Get Embedding

#### `POST /get-embedding`

Generates embedding for a single text using configured provider.

**Request:**
```json
{
  "text": "dragon battle in the mountains",
  "source": "transformers",
  "model": "Xenova/all-MiniLM-L6-v2"
}
```

**Response:**
```json
{
  "success": true,
  "embedding": [0.1, 0.2, 0.3, ...]
}
```

### Batch Embeddings

#### `POST /batch-embeddings`

Generates embeddings for multiple texts.

**Request:**
```json
{
  "texts": [
    "dragon battle",
    "ancient ruins",
    "forest encounter"
  ],
  "source": "transformers",
  "model": "Xenova/all-MiniLM-L6-v2"
}
```

**Response:**
```json
{
  "success": true,
  "embeddings": [
    [0.1, 0.2, 0.3, ...],
    [0.4, 0.5, 0.6, ...],
    [0.7, 0.8, 0.9, ...]
  ]
}
```

---

## Supported Embedding Sources

The plugin supports all SillyTavern embedding providers:

- `transformers` - Local transformers.js models
- `openai` - OpenAI embeddings API
- `togetherai` - Together AI
- `mistral` - Mistral AI
- `nomicai` - Nomic AI
- `cohere` - Cohere embeddings
- `ollama` - Ollama local embeddings
- `llamacpp` - llama.cpp server
- `koboldcpp` - KoboldCPP server
- `custom` - any OpenAI-style `/embeddings` server
- `vllm` - vLLM server
- `palm` - Google PaLM API
- `vertexai` - Google Vertex AI
- `extras` - SillyTavern Extras

`llamacpp`, `koboldcpp` and `custom` need `apiUrl`, the server's URL, and take `model` when the server needs one. Their key is sent as `secret_id`, the ID of a key saved in SillyTavern, which the plugin reads on SillyTavern's server, so the key never leaves it. With no `secret_id` no key is sent, not even SillyTavern's active one. The request goes to `/v1/embeddings` on a llama.cpp or KoboldCPP URL, and to the URL plus `/embeddings` for `custom`, at most 32 texts at a time. A URL that already ends in `/embeddings` is used as it is, such as an OpenRouter profile's `https://openrouter.ai/api/v1/embeddings`, under which SillyTavern finds OpenRouter's embedding models. A failed request gives back its status and a fixed hint, such as `401 Unauthorized (the server refused the API key)`, never the server's own reply, which can quote the key.

`vllm` takes `apiUrl`, the server's URL (`http://127.0.0.1:8000` when the request names none), and `model`. It sends the vLLM key saved in SillyTavern, through SillyTavern's own vLLM embedding function, or `apiKey` when the request gives one. The request goes to `/v1/embeddings` on the URL, at most 32 texts at a time, and a failed one gives back its status and a fixed hint, never the server's reply.

---

## Metadata Schema

Similharity stores rich metadata with each vector chunk:

### Core Fields (ST Compatibility)
- `hash` - Content hash
- `text` - Chunk text
- `index` - Chunk index

### Similharity Rich Metadata
- `name` - Custom chunk name
- `disabled` - Enable/disable chunk
- `importance` - Importance weighting (0-200%)
- `keywords` - Keyword array for boosting
- `customWeight` - Custom similarity weight multiplier

### Conditional Activation
- `conditions` - Rules for when chunk should activate
  - `enabled` - Enable/disable conditions
  - `rules` - Array of condition rules

### Dual-Vector
- `summaryVectors` - Summary text embeddings
- `isSummaryChunk` - Is this a summary chunk?
- `parentHash` - Parent chunk hash

### Chunk Groups
- `chunkGroup` - Group name
- `groupBoost` - Group similarity boost multiplier

### Temporal Data
- `timestamp` - Unix timestamp
- `messageIndex` - Message index in chat
- `sceneIndex` - Scene index
- `sceneTitle` - Scene title

---

## Error Handling

All endpoints return standard error responses:

```json
{
  "success": false,
  "error": "Error message here"
}
```

Or for simple errors:

```json
{
  "error": "Error message here"
}
```

---

## Security Note

This plugin provides direct access to vector databases. Only install if you trust the Similharity extension. Never expose plugin endpoints to untrusted clients.

---

## License

MIT

## Author

Kritblade

## Repository

[https://github.com/KritBlade/VectFox](https://github.com/KritBlade/VectFox)
