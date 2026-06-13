# Similharity Server Plugin

**Version 3.3.1**

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
[similharity] Initializing v3.3.1...
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
  "version": "3.3.1",
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
- `vllm` - vLLM server
- `palm` - Google PaLM API
- `vertexai` - Google Vertex AI
- `extras` - SillyTavern Extras

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
