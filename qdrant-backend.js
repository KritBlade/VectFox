/**
 * ============================================================================
 * QDRANT BACKEND (DIRECT REST API)
 * ============================================================================
 * Server-side Qdrant vector database operations using direct REST API calls.
 * Uses ONE main collection with payload filters for different data types.
 *
 * Why Direct REST instead of SDK?
 * - More transparent error handling
 * - Works better with various Qdrant setups
 * - Explicit control over headers and requests
 * - Better debugging capabilities
 *
 * Note: Qdrant Cloud may have CORS issues when accessed from browser.
 * This backend runs server-side so CORS is not an issue here.
 *
 * Collections: VectFox names the collection on each call. With its multitenancy on, every collection shares one,
 * "vectfox_main", told apart by the indexed tenant field `content_type`, which holds the collection's own ID, and
 * filters such as {content_type: "vf_eventbase_..."}. With it off, each collection is a Qdrant collection of its own.
 * Older clients scope by `type` and `sourceId`, which every path still reads.
 *
 * @author VectFox
 * ============================================================================
 */

import { assertSendableHeaders, fetchOnSameHost } from './request-safety.js';

// Qdrant on-disk constants. NEVER change these without an upgrade routine —
// they live inside user Qdrant databases.
const SENTINEL_POINT_TYPE = '_vectfox_meta';
const SENTINEL_FLAG_KEY = '_vectfox_sentinel';

// D1: One-shot legacy-data warning. Fires once per process when a query result
// still contains the old _vecthare_meta sentinel, meaning the user hasn't run
// the upgrade button yet.
let _legacyDataWarningFired = false;
const MULTITENANCY_COLLECTION = 'vectfox_main';

// The payload field that tells collections apart inside the shared one: VectFox writes each point's collection ID
// there. Indexed as a tenant field, so a filter on it reads one tenant's points only.
export const TENANT_FIELD = 'content_type';

// The most tenants one discovery lists. A facet answer this long may be cut, so discovery then says it did not list
// them all, and VectFox prunes nothing it did not see.
const TENANT_FACET_LIMIT = 10000;

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Qdrant Backend Manager
 * Manages Qdrant REST API connection and operations
 */
class QdrantBackend {
    constructor() {
        // LIFECYCLE INSTRUMENTATION (2026-05-30 — added to diagnose "Qdrant not
        // initialized" errors that appeared mid-run when the plugin had
        // previously been initialized successfully. The most plausible cause
        // is that something is replacing or clearing the instance state after
        // initialize() succeeds. To find that "something", we need:
        //   1. A unique per-instance ID so we know if the singleton got
        //      reconstructed (which would explain "baseUrl is null")
        //   2. A property trap on baseUrl that logs every write — particularly
        //      any write-to-null after it was set — with a stack trace so we
        //      can see which code path is responsible
        //   3. Failure-site context (instanceId, config snapshot) at the
        //      throw site so we can correlate it with the lifecycle log
        // Grep keywords in sillytavern.log:
        //   "Qdrant LIFECYCLE"   — all lifecycle events
        //   "baseUrl CLEARED"    — the specific moment state was lost
        //   "Qdrant not initialized — instanceId" — failure context
        // This is pure observability. Behavior is unchanged.
        this._instanceId = `qb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        this._initCount = 0;   // bumps each time initialize() succeeds

        // Property trap on baseUrl. Logs:
        //   - Any write that clears a previously-set value (root-cause smoking gun)
        //   - The initial set during initialize() (proves init happened)
        let _baseUrl = null;
        Object.defineProperty(this, 'baseUrl', {
            enumerable: true,
            configurable: true,
            get() { return _baseUrl; },
            set(v) {
                if (_baseUrl != null && (v == null || v === '')) {
                    // The bug we're hunting: state went from set to unset.
                    console.error(`[Qdrant LIFECYCLE] baseUrl CLEARED — was "${_baseUrl}", set to "${v}". instanceId=${this._instanceId}. Stack:\n${new Error('baseUrl cleared').stack}`);
                } else if (_baseUrl == null && v != null) {
                    console.log(`[Qdrant LIFECYCLE] baseUrl set to "${v}". instanceId=${this._instanceId}`);
                }
                _baseUrl = v;
            },
        });

        this.baseUrl = null;
        this.apiKey = null;
        this.config = {
            host: '127.0.0.1',
            port: 6333,
            url: null,
            apiKey: null,
        };
        // Cached Qdrant server version (e.g. "1.15.0"). Probed once at initialize().
        // null = unknown (probe failed or not yet attempted).
        this.serverVersion = null;

        console.log(`[Qdrant LIFECYCLE] QdrantBackend constructed. instanceId=${this._instanceId}`);
    }

    /**
     * Parse a semver-ish version string ("1.13.0", "1.13.2-dev") into [major, minor, patch].
     * Returns [0,0,0] when unparseable.
     */
    _parseVersion(v) {
        if (!v || typeof v !== 'string') return [0, 0, 0];
        const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
        if (!m) return [0, 0, 0];
        return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    }

    /**
     * Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
     */
    _cmpVersion(a, b) {
        const A = this._parseVersion(a);
        const B = this._parseVersion(b);
        for (let i = 0; i < 3; i++) {
            if (A[i] > B[i]) return 1;
            if (A[i] < B[i]) return -1;
        }
        return 0;
    }

    /**
     * Does the connected Qdrant support formula queries? (Requires 1.13+.)
     * Returns false when the version is unknown — caller should fall back gracefully.
     */
    supportsFormulaQuery() {
        if (!this.serverVersion) return false;
        return this._cmpVersion(this.serverVersion, '1.13.0') >= 0;
    }

    /**
     * Parse collection name to handle both old (source:id) and new (backend:source:id) formats
     * @param {string} collectionName - Collection name in format "qdrant:source:id" or "source:id"
     * @returns {string} - Actual collection name (source:id)
     */
    _parseCollectionName(collectionName) {
        if (!collectionName) return collectionName;

        // New format: backend:source:id (e.g., "qdrant:ollama:chat_123")
        // Old format: source:id (e.g., "ollama:chat_123")
        if (collectionName.startsWith('qdrant:')) {
            // Strip "qdrant:" prefix to get "source:id"
            return collectionName.substring(7); // 'qdrant:'.length === 7
        }
        // Now strip the source prefix if present
        if (collectionName.indexOf(':') !== -1) {
            collectionName = collectionName.split(':')[1];
        }

        // Already in correct format or old format
        return collectionName;
    }

    /**
     * Build headers for Qdrant API requests
     */
    _getHeaders() {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.apiKey) {
            headers['api-key'] = this.apiKey;
        }
        return headers;
    }

    /**
     * Make a request to Qdrant API with retry logic
     * @param {string} method - HTTP method
     * @param {string} endpoint - API endpoint
     * @param {object|null} body - Request body
     * @param {number} maxRetries - Maximum retry attempts for transient failures
     */
    async _request(method, endpoint, body = null, maxRetries = 3) {
        const url = `${this.baseUrl}${endpoint}`;
        // Before the retries: Node's refusal of a header value quotes the value, and would read as a network error.
        assertSendableHeaders(this._getHeaders(), 'Qdrant');

        // Add explicit timeout of 60s to prevent indefinite hangs during heavy operations (like wait=true)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const options = {
            method,
            headers: this._getHeaders(),
            signal: controller.signal,
        };
        if (body) {
            options.body = JSON.stringify(body);
        }

        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // The api-key header would follow a redirect to another host, so only a redirect on this host is followed.
                const response = await fetchOnSameHost(fetch, url, options);
                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorText = await response.text();
                    let errorMessage;
                    try {
                        const errorJson = JSON.parse(errorText);
                        errorMessage = errorJson.status?.error || errorJson.message || errorText;
                    } catch {
                        errorMessage = errorText;
                    }

                    // Check if error is retryable (5xx errors, 429 rate limit)
                    const isRetryable = response.status >= 500 || response.status === 429;
                    if (isRetryable && attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
                        console.warn(`[Qdrant] ${method} ${endpoint} failed (${response.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    throw new Error(`Qdrant ${method} ${endpoint} failed: ${response.status} ${errorMessage}`);
                }

                // Some endpoints return empty response
                const text = await response.text();
                if (!text) return null;
                try {
                    return JSON.parse(text);
                } catch (parseErr) {
                    // OBSERVABILITY: capture enough state to diagnose WHY the
                    // response failed to parse. The three plausible causes are:
                    //   (a) network blip cut the response mid-stream — receivedBytes
                    //       will be less than declaredContentLength
                    //   (b) chunked transfer with a missing chunk — Content-Length
                    //       will be absent, transfer-encoding will be "chunked",
                    //       and the body will end mid-token
                    //   (c) something else entirely — both bytes will match but
                    //       the JSON itself will be malformed (rare Qdrant bug)
                    // Grep `sillytavern.log` for "QDRANT_PARSE_TRUNCATION" to find
                    // each occurrence. The control flow below is identical to the
                    // pre-instrumentation version (rethrow parseErr); the only
                    // change is one console.error block. Production safe.
                    const headers = {};
                    if (response.headers && typeof response.headers.forEach === 'function') {
                        response.headers.forEach((v, k) => { headers[k] = v; });
                    }
                    const receivedBytes = text.length;
                    const declaredContentLength = headers['content-length'] != null
                        ? Number(headers['content-length'])
                        : null;
                    const truncationDelta = declaredContentLength != null
                        ? declaredContentLength - receivedBytes
                        : null;
                    console.error('[Qdrant] QDRANT_PARSE_TRUNCATION', JSON.stringify({
                        endpoint: `${method} ${endpoint}`,
                        httpStatus: response.status,
                        parseError: parseErr.message,
                        receivedBytes,
                        declaredContentLength,
                        truncationDelta,
                        transferEncoding: headers['transfer-encoding'] || null,
                        connection: headers['connection'] || null,
                        contentType: headers['content-type'] || null,
                        bodyPrefix: text.slice(0, 200),
                        bodySuffix: text.slice(-200),
                    }));
                    throw parseErr;
                }

            } catch (error) {
                lastError = error;

                // Network errors (ECONNREFUSED, timeout, etc.) are retryable
                const isNetworkError = error.name === 'TypeError' ||
                    error.name === 'AbortError' ||
                    error.message?.includes('fetch failed') ||
                    error.message?.includes('ECONNREFUSED') ||
                    error.message?.includes('ETIMEDOUT');

                if (isNetworkError && attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                    console.warn(`[Qdrant] Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${error.message}${error.cause ? ` (Cause: ${error.cause})` : ''}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                throw error;
            } finally {
                // Ensure timeout is cleared on success or error thrown
                clearTimeout(timeoutId);
            }
        }

        throw lastError;
    }

    /**
     * Initialize Qdrant connection
     * @param {object} config - Configuration { host, port, url, apiKey }
     */
    async initialize(config = {}) {
        // Merge config
        this.config = { ...this.config, ...config };
        this.apiKey = this.config.apiKey || null;

        // Build base URL
        if (this.config.url) {
            // Cloud or custom URL - remove trailing slash
            this.baseUrl = this.config.url.replace(/\/+$/, '');
        } else {
            // Local instance
            this.baseUrl = `http://${this.config.host}:${this.config.port}`;
        }

        console.log('[Qdrant] Initializing with URL:', this.baseUrl);
        console.log('[Qdrant] API Key:', this.apiKey ? '(set)' : '(not set)');

        // Test connection
        try {
            await this._request('GET', '/collections');
            this._initCount++;
            console.log(`[Qdrant] Connection successful. [LIFECYCLE] instanceId=${this._instanceId}, initCount=${this._initCount}`);
        } catch (error) {
            console.error('[Qdrant] Connection failed:', error.message);
            throw error;
        }

        // Probe server version. Used by EventBase native-rerank to gate formula
        // queries (require 1.13+). Probe failure is non-fatal — features that
        // depend on a known version simply stay disabled.
        try {
            const root = await this._request('GET', '/');
            this.serverVersion = root?.version || root?.result?.version || null;
            if (this.serverVersion) {
                const okFormula = this.supportsFormulaQuery();
                console.log(`[Qdrant] Server version: ${this.serverVersion} (formula query ${okFormula ? 'supported' : 'NOT supported, requires 1.13+'})`);
            } else {
                console.warn('[Qdrant] Server version probe returned no version field; formula-query features will stay disabled');
            }
        } catch (error) {
            console.warn('[Qdrant] Version probe failed:', error.message);
            this.serverVersion = null;
        }

        // Ensure indexes exist on any existing multitenancy collection
        await this.ensurePayloadIndexes(MULTITENANCY_COLLECTION);
        const collections = await this.getCollections();
        for (const collectionName of collections || []) {
            await this.ensurePayloadIndexes(collectionName);
        }
    }

    /**
     * Health check
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            if (!this.baseUrl) return false;
            await this._request('GET', '/collections');
            return true;
        } catch (error) {
            console.error('[Qdrant] Health check failed:', error.message);
            return false;
        }
    }

    /**
     * Ensure collection exists with proper schema and payload indexes
     * @param {string} collectionName - Collection name
     * @param {number} vectorSize - Vector dimension (e.g., 768)
     * @param {object} [opts]
     * @param {boolean} [opts.nativeSparse=false] - Declare a `text_sparse` named sparse vector with `modifier: "idf"` for native BM25
     */
    async ensureCollection(collectionName, vectorSize = 768, opts = {}) {
        const { nativeSparse = false } = opts;
        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            collectionName = this._parseCollectionName(collectionName);
            const exists = collections.result?.collections?.some(c => c.name === collectionName);
            if (!exists) {
                // Create collection
                const body = {
                    vectors: {
                        size: vectorSize,
                        distance: 'Cosine',
                    },
                };
                if (nativeSparse) {
                    // Qdrant 1.10+: declare a named sparse vector with IDF modifier so BM25 is
                    // computed server-side over the true global corpus. Index params left as
                    // defaults — Qdrant uses on-disk by default for sparse.
                    body.sparse_vectors = {
                        text_sparse: { modifier: 'idf' },
                    };
                }
                try {
                    await this._request('PUT', `/collections/${collectionName}`, body);
                    console.log(`[Qdrant] Created collection: ${collectionName} (dim=${vectorSize}${nativeSparse ? ', +text_sparse[idf]' : ''})`);
                } catch (createError) {
                    // 409 = another concurrent request already created it — that's fine
                    if (createError.message?.includes('409') || createError.message?.includes('already exists')) {
                        console.log(`[Qdrant] Collection ${collectionName} already exists (concurrent creation), continuing.`);
                    } else {
                        throw createError;
                    }
                }

                // Create payload indexes for filterable fields
                await this.createPayloadIndexes(collectionName);
            }
        } catch (error) {
            console.error(`[Qdrant] Failed to ensure collection ${collectionName}:`, error.message);
            throw error;
        }
    }

    /**
     * Create payload indexes for filterable fields
     * @param {string} collectionName - Collection name
     */
    async createPayloadIndexes(collectionName) {
        collectionName = this._parseCollectionName(collectionName);
        // Fields that need indexes for filtering
        // Tenant fields use { type: 'keyword', is_tenant: true } for optimized multitenancy
        // Regular fields use simple type string
        const indexConfigs = [
            // TENANT FIELDS (is_tenant: true for optimized multitenancy)
            { field: TENANT_FIELD, schema: { type: 'keyword', is_tenant: true } },
            { field: 'type', schema: { type: 'keyword', is_tenant: true } },
            { field: 'sourceId', schema: { type: 'keyword', is_tenant: true } },
            // REGULAR KEYWORD FIELDS
            { field: 'embeddingSource', schema: 'keyword' },
            { field: 'embeddingModel', schema: 'keyword' },
            { field: 'characterName', schema: 'keyword' },
            { field: 'chatId', schema: 'keyword' },
            { field: 'keywords', schema: 'keyword' },
            // TEXT FIELDS (for full-text search)
            { field: 'text', schema: 'text' },
            // INTEGER FIELDS
            { field: 'hash', schema: 'integer' },
            { field: 'timestamp', schema: 'integer' },
            { field: 'importance', schema: 'integer' },
            // EventBase event-source window end — used by formula recency decay and
            // dedup-depth range filter when the EventBase native rerank path is on.
            { field: 'source_window_end', schema: 'integer' },
            // Packed whole-timeline sort key (window_start * stride + event_order).
            // Indexed so a future Qdrant order_by can page the DB in true chat
            // order without pulling every point client-side. Older points simply
            // lack the field; order_by treats them as absent, which is expected.
            { field: 'timeline_sort_key', schema: 'integer' },
            // BOOL FIELDS
            // Required for formula expressions — Qdrant demands an index for bool fields used in formula match.
            { field: 'should_persist', schema: 'bool' },
            // EventBase planner-filterable fields (Phase 1.5 agentic filters).
            // keyword schema handles both scalar and array-of-string payloads —
            // match: { any: [...] } works on either shape.
            { field: 'characters',  schema: 'keyword' },
            { field: 'locations',   schema: 'keyword' },
            { field: 'factions',    schema: 'keyword' },
            { field: 'concepts',    schema: 'keyword' },
            { field: 'items',       schema: 'keyword' },
            { field: 'event_type',  schema: 'keyword' },
        ];

        for (const { field, schema } of indexConfigs) {
            try {
                await this._request('PUT', `/collections/${collectionName}/index`, {
                    field_name: field,
                    field_schema: schema,
                });
                const schemaType = typeof schema === 'object' ? `${schema.type}${schema.is_tenant ? ' (tenant)' : ''}` : schema;
                console.log(`[Qdrant] Created index for ${field} (${schemaType})`);
            } catch (error) {
                // Index might already exist, that's fine
                if (!error.message?.includes('already exists') && !error.message?.includes('409')) {
                    console.warn(`[Qdrant] Failed to create index for ${field}:`, error.message);
                }
            }
        }
    }

    /**
     * Sentinel point ID used to store per-collection VectFox metadata
     * (e.g. the CJK tokenizer mode this collection was built with).
     * Uses a fixed UUID so it never collides with hash-derived integer IDs.
     */
    _SENTINEL_ID = '00000000-0000-0000-0000-0000feedf00d';

    /**
     * Read VectFox's sentinel metadata point for a collection. Returns null when
     * the collection or the sentinel point is missing.
     *
     * @param {string} collectionName
     * @returns {Promise<object|null>}
     */
    async getCollectionMetadata(collectionName) {
        collectionName = this._parseCollectionName(collectionName);
        try {
            const resp = await this._request('POST', `/collections/${collectionName}/points`, {
                ids: [this._SENTINEL_ID],
                with_payload: true,
                with_vector: false,
            });
            const point = resp.result?.[0];
            if (!point) return null;
            return point.payload || null;
        } catch (error) {
            console.debug(`[Qdrant] getCollectionMetadata(${collectionName}) failed:`, error.message);
            return null;
        }
    }

    /**
     * Write VectFox's sentinel metadata point. Creates or overwrites the
     * sentinel; uses a zero dense vector so the point exists but won't surface
     * in any normal vector search (also filtered out by the `type` payload).
     *
     * @param {string} collectionName
     * @param {object} metadata - free-form, must serialise cleanly
     * @param {number} vectorSize - dimension of the dense vector slot
     */
    async setCollectionMetadata(collectionName, metadata, vectorSize) {
        collectionName = this._parseCollectionName(collectionName);
        const zero = new Array(vectorSize).fill(0);
        const payload = {
            ...metadata,
            type: SENTINEL_POINT_TYPE,
            [SENTINEL_FLAG_KEY]: true,
            updated_at: Date.now(),
        };
        // Inspect the collection so we know whether it has named sparse vectors;
        // if so the sentinel needs the object-form vector slot.
        let usesNamedVectors = false;
        try {
            const info = await this._request('GET', `/collections/${collectionName}`);
            usesNamedVectors = !!info.result?.config?.params?.sparse_vectors;
        } catch (e) { /* assume plain */ }

        const point = {
            id: this._SENTINEL_ID,
            vector: usesNamedVectors ? { '': zero } : zero,
            payload,
        };
        await this._request('PUT', `/collections/${collectionName}/points?wait=true`, {
            points: [point],
        });
        console.log(`[Qdrant] Wrote sentinel for ${collectionName}:`, metadata);
    }

    /**
     * Ensure payload indexes exist on an existing collection
     * @param {string} collectionName - Collection name
     */
    async ensurePayloadIndexes(collectionName) {
        try {
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === collectionName);
            if (exists) {
                await this.createPayloadIndexes(collectionName);
                console.log(`[Qdrant] Ensured payload indexes for ${collectionName}`);
            }
        } catch (error) {
            console.error(`[Qdrant] Failed to ensure indexes for ${collectionName}:`, error.message);
        }
    }

    /**
     * An item's Qdrant point ID: the ID the client chose (a whole number or a UUID), or else its hash, as a number.
     * @private
     * @param {{id?: number|string, hash: number|string}} item
     * @returns {number|string}
     * @throws {Error} When the chosen ID is neither a whole number nor a UUID, which Qdrant refuses
     */
    _pointIdOf(item) {
        if (item.id === undefined || item.id === null) {
            return typeof item.hash === 'string' ? parseInt(item.hash, 10) : item.hash;
        }
        if (Number.isSafeInteger(item.id) && item.id >= 0) return item.id;
        if (typeof item.id === 'string' && UUID_FORMAT.test(item.id)) return item.id;
        throw new Error(`[Qdrant] Point ID ${JSON.stringify(item.id)} is neither a whole number nor a UUID, so nothing was stored.`);
    }

    /**
     * Insert vector items into collection (MULTITENANCY)
     * @param {string} collectionName - Collection name: the chat's own, or "vectfox_main" with multitenancy on
     * @param {Array} items - Items with {hash, text, vector, sparseVector?, metadata}
     * @param {object} tenantMetadata - Tenant info {type, sourceId, embeddingSource}
     * @param {object} [opts]
     * @param {boolean} [opts.nativeSparse=false] - Use named-vector point shape and ship `item.sparseVector` to Qdrant's `text_sparse` field
     * @returns {Promise<void>}
     */
    async insertVectors(collectionName, items, tenantMetadata = {}, opts = {}) {
        const { nativeSparse = false, cjkTokenizerMode = null } = opts;
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }
        if (items.length === 0) return;

        // The chat's own collection, or vectfox_main with multitenancy on
        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        // Every point ID first, so an unusable one stops the insert before anything is written.
        const pointIds = items.map(item => this._pointIdOf(item));

        // Validate all items have vectors
        const missingVectors = items.filter(item => !item.vector || !Array.isArray(item.vector));
        if (missingVectors.length > 0) {
            throw new Error(`[Qdrant] ${missingVectors.length} items are missing vectors. Hashes: ${missingVectors.slice(0, 5).map(i => i.hash).join(', ')}${missingVectors.length > 5 ? '...' : ''}`);
        }

        // Get expected dimension from first vector
        const expectedDimension = items[0].vector.length;
        if (expectedDimension === 0) {
            throw new Error('[Qdrant] First item has empty vector (dimension 0)');
        }

        // Validate all vectors have the same dimension
        const mismatchedItems = items.filter(item => item.vector.length !== expectedDimension);
        if (mismatchedItems.length > 0) {
            const examples = mismatchedItems.slice(0, 3).map(i => `hash ${i.hash}: ${i.vector.length}`).join(', ');
            throw new Error(`[Qdrant] Vector dimension mismatch. Expected ${expectedDimension}, but found: ${examples}${mismatchedItems.length > 3 ? '...' : ''} (${mismatchedItems.length} total mismatches)`);
        }

        // A collection holds one vector size, and its points are the user's data, so a different size stops the insert
        // with the error Qdrant itself gives, and deletes nothing. When the size cannot be read, the insert goes on and
        // Qdrant refuses a wrong size itself.
        let storedDimension = null;
        try {
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (exists) {
                const collectionInfo = await this._request('GET', `/collections/${mainCollection}`);
                storedDimension = collectionInfo.result?.config?.params?.vectors?.size ?? null;
            }
        } catch (error) {
            console.warn(`[Qdrant] Could not read the vector size of ${mainCollection}, so Qdrant checks it on insert:`, error.message);
        }
        if (storedDimension && storedDimension !== expectedDimension) {
            throw new Error(`Vector dimension error: expected dim: ${storedDimension}, got ${expectedDimension}`);
        }

        // Ensure collection exists (use first vector's size)
        const vectorSize = expectedDimension;
        await this.ensureCollection(mainCollection, vectorSize, { nativeSparse });
        // A shared collection made before the tenant field was indexed gets the index on its next insert.
        if (items.some(item => item.metadata?.[TENANT_FIELD])) await this._ensureTenantIndex(mainCollection);

        // Sentinel handling: when native sparse is enabled, the CJK tokenizer mode is baked
        // into the indexed sparse vectors. Write the sentinel on first insert; verify it
        // matches on subsequent inserts so a mid-stream mode change is caught early.
        if (nativeSparse && cjkTokenizerMode) {
            try {
                const existing = await this.getCollectionMetadata(mainCollection);
                if (!existing || !existing.cjk_tokenizer_mode) {
                    await this.setCollectionMetadata(mainCollection, {
                        cjk_tokenizer_mode: cjkTokenizerMode,
                    }, vectorSize);
                } else if (existing.cjk_tokenizer_mode !== cjkTokenizerMode) {
                    throw new Error(
                        `[Qdrant] Tokenizer mode mismatch: collection "${mainCollection}" was built with "${existing.cjk_tokenizer_mode}" but insert is using "${cjkTokenizerMode}". ` +
                        `Delete the collection and re-vectorize to switch tokenizer modes.`
                    );
                }
            } catch (error) {
                if (error.message?.includes('Tokenizer mode mismatch')) throw error;
                console.warn(`[Qdrant] Sentinel read/write failed for ${mainCollection}:`, error.message);
            }
        }

        // Format points for Qdrant with multitenancy payload
        // NOTE: Spread item.metadata FIRST so critical fields can override it
        // IMPORTANT: Ensure hash is a number - Qdrant accepts unsigned integers or UUID strings,
        // but NOT numeric strings like "977206". JSON parsing from HTTP requests can sometimes
        // convert numbers to strings, so we explicitly coerce here.
        const points = items.map((item, position) => ({
            id: pointIds[position],
            // When the collection has a named sparse vector, Qdrant requires the point's vector
            // field to be an object keyed by vector name. Default dense vector is keyed by "".
            // Without sparse, keep the plain-array form so we don't break existing collections.
            vector: nativeSparse && item.sparseVector
                ? { '': item.vector, text_sparse: item.sparseVector }
                : item.vector,
            payload: {
                // ===== SPREAD ADDITIONAL METADATA FIRST (so it can be overridden) =====
                ...(item.metadata || {}),

                // ===== CORE FIELDS (override metadata) =====
                text: item.text,
                hash: typeof item.hash === 'string' ? parseInt(item.hash, 10) : item.hash, // Keep consistent with ID

                // ===== MULTITENANCY FIELDS (CRITICAL - must not be overwritten) =====
                type: tenantMetadata.type || 'chat',
                sourceId: tenantMetadata.sourceId || 'unknown',
                embeddingSource: tenantMetadata.embeddingSource || 'transformers',
                embeddingModel: tenantMetadata.embeddingModel || '',

                // ===== TIMESTAMPS (for temporal decay) =====
                timestamp: item.metadata?.timestamp || Date.now(),
                // messageIndex carries the chat message number for ordering in the visualizer.
                // Both ingestion paths set top-level item.index (legacy chat: batch[0].index;
                // EventBase: source_window_start + 1) — persist it here so the field is queryable.
                messageIndex: item.index ?? item.metadata?.messageIndex ?? null,

                // ===== LEGACY FIELDS =====
                // Fall back to item.metadata.* when the top-level field is undefined.
                // EventBase items store these inside metadata; older chunk items set them
                // at the top level. Both shapes coexist.
                importance: item.importance !== undefined ? item.importance : (item.metadata?.importance ?? 100),
                keywords: item.keywords || item.metadata?.keywords || [],
                conditions: item.conditions !== undefined ? item.conditions : (item.metadata?.conditions ?? null),
                isSummaryChunk: item.isSummaryChunk !== undefined ? item.isSummaryChunk : (item.metadata?.isSummaryChunk ?? false),
                parentHash: item.parentHash !== undefined ? item.parentHash : (item.metadata?.parentHash ?? null),

                // ===== CHAT-SPECIFIC =====
                speaker: item.metadata?.speaker,
                summary: item.metadata?.summary ?? null,
                sceneTitle: item.metadata?.sceneTitle,
                sceneIndex: item.metadata?.sceneIndex,
                sceneStart: item.metadata?.sceneStart,
                sceneEnd: item.metadata?.sceneEnd,

                // ===== LOREBOOK-SPECIFIC =====
                entryName: item.metadata?.entryName,
                lorebookId: item.metadata?.lorebookId,

                // ===== CHARACTER-SPECIFIC =====
                characterName: item.metadata?.characterName,
                fieldName: item.metadata?.fieldName,

                // ===== DOCUMENT-SPECIFIC =====
                documentName: item.metadata?.documentName,
                url: item.metadata?.url,
                scrapeDate: item.metadata?.scrapeDate,
            },
        }));

        // Upsert points (PUT with wait=true for reliability)
        await this._request('PUT', `/collections/${mainCollection}/points?wait=true`, {
            points: points,
        });

        console.log(`[Qdrant] Inserted ${items.length} vectors into ${mainCollection} (type: ${tenantMetadata.type}, sourceId: ${tenantMetadata.sourceId})`);
    }

    /**
     * Query collection for similar vectors (MULTITENANCY)
     * @param {string} collectionName - Collection name: the chat's own, or "vectfox_main" with multitenancy on
     * @param {number[]} queryVector - Query vector
     * @param {number} topK - Number of results
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and narrowing filters such as minImportance
     * @returns {Promise<Array>} Results with {hash, text, score, metadata}
     */
    async queryCollection(collectionName, queryVector, topK = 10, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return [];
            }

            // _buildFilterExcludingSentinel keeps the sentinel-exclusion rule consistent with every other read path
            // (listItems, getSavedHashes, _buildHybridFilter).
            const searchPayload = {
                vector: queryVector,
                limit: topK,
                with_payload: true,
                filter: this._buildFilterExcludingSentinel(this._scopeMust(filters)),
            };

            // Search
            const response = await this._request('POST', `/collections/${mainCollection}/points/search`, searchPayload);

            // Format results
            return (response.result || []).map(result => ({
                hash: result.payload.hash,
                text: result.payload.text,
                score: result.score,
                metadata: result.payload,
            }));
        } catch (error) {
            console.error(`[Qdrant] Query failed for ${mainCollection}:`, error.message);
            return [];
        }
    }


    /**
     * Canonical sentinel-exclusion filter builder.
     *
     * Every read path that touches points-search or points-scroll MUST exclude
     * the per-collection sentinel point (which carries the CJK tokenizer mode
     * and other VectFox metadata, see {@link setCollectionMetadata}). Without
     * this exclusion the sentinel surfaces as a phantom result with
     * vectorScore=0 in every query — wasting a topK slot and polluting
     * downstream pipelines.
     *
     * Use this helper anywhere you build a Qdrant filter for a read path:
     *   - {@link queryCollection}
     *   - {@link listItems}
     *   - {@link getSavedHashes}
     *   - {@link _buildHybridFilter} (extends this base with should/min_should)
     *
     * If the sentinel marker convention ever changes (extra payload key,
     * different `type` value, etc.), update this method and every read path
     * stays consistent automatically. This consolidation was added 2026-05-23
     * after queryCollection and getSavedHashes were both found to be missing
     * the exclusion — the bug surfaced one phantom row per query for an
     * extended period until TEST 013 caught it.
     *
     * @private
     * @param {Array} must - Additional `must` clauses (tenant filters, etc.)
     * @returns {object} Qdrant filter object with sentinel exclusion always in `must_not`
     */
    _buildFilterExcludingSentinel(must = []) {
        const must_not = [{ key: 'type', match: { value: SENTINEL_POINT_TYPE } }];
        return must.length > 0 ? { must, must_not } : { must_not };
    }

    /**
     * The `must` clauses a request's filters name: the tenant (`content_type`, and the older `type` and `sourceId`)
     * and the fields that narrow it. Every path that reads, counts, changes or deletes points takes its scope from here,
     * so a filter one path understands, every path understands.
     * @private
     * @param {object} [filters]
     * @returns {Array<object>}
     */
    _scopeMust(filters = {}) {
        const must = [];
        const add = (key, clause) => must.push({ key, ...clause });
        if (filters[TENANT_FIELD])      add(TENANT_FIELD,      { match: { value: filters[TENANT_FIELD] } });
        if (filters.type)               add('type',            { match: { value: filters.type } });
        if (filters.sourceId)           add('sourceId',        { match: { value: filters.sourceId } });
        if (filters.minImportance !== undefined) add('importance', { range: { gte: filters.minImportance } });
        if (filters.timestampAfter !== undefined) add('timestamp', { range: { gte: filters.timestampAfter } });
        if (filters.characterName)      add('characterName',   { match: { value: filters.characterName } });
        if (filters.chatId)             add('chatId',          { match: { value: filters.chatId } });
        if (filters.embeddingSource)    add('embeddingSource', { match: { value: filters.embeddingSource } });
        // Planner-emitted hard importance floor.
        if (typeof filters.importance_gte === 'number') add('importance', { range: { gte: filters.importance_gte } });
        return must;
    }

    /**
     * Whether filters name a tenant, so a change or delete they scope stays inside one collection of the shared one.
     * @param {object} [filters]
     * @returns {boolean}
     */
    _namesTenant(filters = {}) {
        return Boolean(filters[TENANT_FIELD] || filters.type || filters.sourceId);
    }

    /**
     * Build a Qdrant filter object from VectFox's filter shape. Shared by all hybrid paths.
     * Always excludes the VectFox sentinel point via {@link _buildFilterExcludingSentinel}.
     * @private
     * @returns {object}
     */
    _buildHybridFilter(filters) {
        const must = this._scopeMust(filters);
        const should = [];

        // Planner-emitted *_any filters: OR within and across fields.
        // match: { any: [...] } works on both scalar and array payload fields.
        const anyMap = {
            characters_any: 'characters',
            locations_any:  'locations',
            factions_any:   'factions',
            concepts_any:   'concepts',
            items_any:      'items',
            event_type_any: 'event_type',
        };
        for (const [src, payloadKey] of Object.entries(anyMap)) {
            const vals = filters[src];
            if (Array.isArray(vals) && vals.length > 0) {
                should.push({ key: payloadKey, match: { any: vals } });
            }
        }

        // Base filter with sentinel exclusion + any must clauses we've collected.
        const out = this._buildFilterExcludingSentinel(must);
        // *_any fields (concepts, characters, locations, etc.) are a hard OR, not a boost: Qdrant keeps only
        // points matching at least one `should` clause, so an event tagged with none of the values is left out,
        // and a value no event has can leave nothing.
        if (should.length > 0) {
            out.should = should;
        }
        return out;
    }

    /**
     * Native Qdrant hybrid query: single /query call with prefetch on dense + sparse, fused
     * server-side via RRF (or DBSF). Returns the final ranked list.
     *
     * Requires:
     *   - Qdrant 1.10+
     *   - Collection created with `sparse_vectors: { text_sparse: { modifier: 'idf' } }`
     *   - Sparse query vector tokenized with the same CJK mode used at ingest
     *
     * @param {string} collectionName
     * @param {number[]} denseVector
     * @param {{indices:number[], values:number[]}} sparseVector
     * @param {number} topK
     * @param {object} options - { fusion: 'rrf'|'dbsf' (default 'rrf'), prefetchLimit: int (default topK*4) }
     * @param {object} filters
     * @returns {Promise<Array<{hash, text, score, metadata}>>}
     */
    async hybridQueryNative(collectionName, denseVector, sparseVector, topK = 10, options = {}, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }
        collectionName = this._parseCollectionName(collectionName);

        const fusion = options.fusion || 'rrf';
        const prefetchLimit = options.prefetchLimit || topK * 4;
        const filter = this._buildHybridFilter(filters);
        const debug = !!options.eventbaseDebug;

        if (debug) {
            const top5sparse = sparseVector.indices
                .map((idx, i) => ({ idx, val: sparseVector.values[i] }))
                .sort((a, b) => b.val - a.val)
                .slice(0, 5)
                .map(t => `${t.idx}:${t.val.toFixed(3)}`)
                .join(', ');
            console.log(`[Qdrant-debug] hybridQueryNative: collection=${collectionName}, topK=${topK}, fusion=${fusion}, prefetchLimit=${prefetchLimit}`);
            if (options.debugQuery) {
                console.log(`[Qdrant-debug] Query text: "${String(options.debugQuery).slice(0, 200)}"`);
            }
            console.log(`[Qdrant-debug] Dense: dim=${denseVector.length}`);
            console.log(`[Qdrant-debug] Sparse: ${sparseVector.indices.length} tokens, top-5 by weight: [${top5sparse}]`);
        }

        // For the default (unnamed) dense vector Qdrant expects `using` to be OMITTED, not "".
        const densePrefetch  = { query: denseVector,  limit: prefetchLimit };
        const sparsePrefetch = { query: sparseVector, using: 'text_sparse', limit: prefetchLimit };
        if (filter) { densePrefetch.filter = filter; sparsePrefetch.filter = filter; }

        const body = {
            prefetch: [densePrefetch, sparsePrefetch],
            query: { fusion },
            limit: topK,
            with_payload: true,
        };

        let resp;
        try {
            resp = await this._request('POST', `/collections/${collectionName}/points/query`, body);
        } catch (err) {
            // Surface the full Qdrant error so the route can include it in the 500 response.
            console.error('[Qdrant] hybridQueryNative request failed. Body:', JSON.stringify(body).slice(0, 500), 'Error:', err.message);
            throw err;
        }
        const points = resp.result?.points || [];

        // D1: Loud one-shot warning if legacy sentinel still present on-disk.
        if (!_legacyDataWarningFired && points.some(p => p.payload?.type === '_vecthare_meta')) {
            _legacyDataWarningFired = true;
            console.warn('[VectFox] LEGACY DATA DETECTED — run the "Upgrade to VectFox v2" button in the Action tab before querying.');
        }

        console.log(`[Qdrant] Native hybrid (fusion=${fusion}) returned ${points.length} results from ${collectionName}`);

        if (debug) {
            points.slice(0, 10).forEach((p, i) => {
                const text = p.payload?.text ? String(p.payload.text).slice(0, 80).replace(/\n/g, ' ') : '';
                console.log(`[Qdrant-debug] [${i + 1}] score=${p.score?.toFixed(4)}, hash=${String(p.payload?.hash ?? '').slice(0, 8)}, text="${text}"`);
            });
        }

        return points.map(p => ({
            hash: p.payload?.hash,
            text: p.payload?.text,
            score: p.score,
            metadata: p.payload,
            fusionMethod: fusion,
            nativeSparse: true,
        }));
    }

    /**
     * Native Qdrant hybrid query + EventBase re-rank in a single /query call.
     *
     * Wraps the existing dense + sparse RRF hybrid in an outer formula query that
     * computes the EventBase weighted score (cosine × $score + importance + persist +
     * recency exp_decay) server-side, plus a min-importance + optional dedup-depth
     * filter. The client still does anchor boost, pairwise dedup, cross-collection
     * merge, and dual-query merge — see plans/qdrant-native-eventbase-rerank-formula.md.
     *
     * Requires Qdrant 1.13+ (formula query). Caller MUST check supportsFormulaQuery()
     * first; this method does not guard internally because the route-level check is
     * cheaper than a Qdrant round-trip that fails with 400.
     *
     * @param {string} collectionName
     * @param {number[]} denseVector
     * @param {{indices:number[], values:number[]}} sparseVector
     * @param {number} topK - Final outer limit (typically finalTopK × 2 to give dedup overfetch room)
     * @param {object} rerankParams - { weights:{cosine,importance,persist,recency} (pre-normalized),
     *                                  chatLength, halfLife, minImportance, visibleThreshold,
     *                                  applyContextDedupFilter, rrfScoreScale? }
     * @param {object} options - { prefetchLimit, eventbaseDebug, debugQuery }
     * @param {object} filters - { type, sourceId, ... } — tenant/content filters
     * @returns {Promise<Array<{hash,text,score,metadata,formulaScore,fusionMethod,nativeSparse,rerankApplied}>>}
     */
    async hybridQueryNativeWithRerank(collectionName, denseVector, sparseVector, topK = 16, rerankParams = {}, options = {}, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }
        collectionName = this._parseCollectionName(collectionName);

        const {
            weights = { cosine: 0.4, importance: 0.2, persist: 0.2, recency: 0.2 },
            chatLength = 0,
            halfLife = 40,
            minImportance = 1,
            visibleThreshold = -1,
            applyContextDedupFilter = true,
            // Qdrant normalizes RRF such that the top hit's fused score peaks at
            // ≈1.0 (uses k=1, so rank-1 in both legs sums to 1/2 + 1/2 = 1.0),
            // which matches the [0, 1] scale of cosine. So no rescale is needed
            // for parity with the JS path — both use RRF fused score as the
            // cosineScore input. Kept as a knob in case future tuning wants to
            // amplify/attenuate the cosine term.
            // See plans/qdrant-native-eventbase-rerank-formula.md "Shift 1" — the
            // initial 40× estimate was based on the un-normalized RRF formula
            // (1/(60+rank)); the measured behavior is normalized.
            rrfScoreScale = 1.0,
        } = rerankParams;

        const prefetchLimit = options.prefetchLimit || topK * 4;
        const hybridLimit = Math.max(topK, prefetchLimit / 2);
        const tenantFilter = this._buildHybridFilter(filters);
        const debug = !!options.eventbaseDebug;

        // Outer filter: min-importance always; dedup-depth conditional.
        // Qdrant FieldCondition shape: { key, range: { gte, lt, ... } } — NOT
        // the nested-field form { range: { fieldname: { gte: ... } } } which
        // some other vector DBs use.
        const outerMust = [];
        if (typeof minImportance === 'number' && minImportance > 0) {
            outerMust.push({ key: 'importance', range: { gte: minImportance } });
        }
        if (applyContextDedupFilter && typeof visibleThreshold === 'number' && visibleThreshold >= 0) {
            outerMust.push({ key: 'source_window_end', range: { lt: visibleThreshold } });
        }
        // Merge tenant filter conditions in too — they should narrow the candidate set
        // before formula scoring runs.
        if (tenantFilter?.must) outerMust.push(...tenantFilter.must);
        // Always carry the sentinel exclusion (must_not) from the tenant filter — it
        // excludes sentinel metadata points regardless of whether outerMust has any
        // conditions of its own.
        const outerFilter = {};
        if (outerMust.length > 0) outerFilter.must = outerMust;
        if (tenantFilter?.must_not?.length) outerFilter.must_not = tenantFilter.must_not;
        const hasOuterFilter = !!(outerFilter.must || outerFilter.must_not);

        // Inner prefetch: existing dense + sparse + RRF, but with the tenant filter
        // pushed into each leg so the hybrid candidates are already tenant-scoped.
        const densePrefetch  = { query: denseVector,  limit: prefetchLimit };
        const sparsePrefetch = { query: sparseVector, using: 'text_sparse', limit: prefetchLimit };
        if (tenantFilter) { densePrefetch.filter = tenantFilter; sparsePrefetch.filter = tenantFilter; }

        const body = {
            prefetch: [{
                prefetch: [densePrefetch, sparsePrefetch],
                query: { fusion: 'rrf' },
                limit: hybridLimit,
            }],
            query: {
                formula: {
                    sum: [
                        // w.cosine × (rrfScoreScale × $score)
                        { mult: [weights.cosine,     { mult: [rrfScoreScale, '$score'] }] },
                        // w.importance × (importance / 10). Note `div` is a structured object,
                        // not an array — Qdrant rejects array form.
                        { mult: [weights.importance, { div: { left: 'importance', right: 10 } }] },
                        // w.persist × (should_persist == true ? 1 : 0). A bare FieldCondition
                        // is itself an expression that yields 1 when the condition matches and
                        // 0 otherwise — no `if_true`/`if_false` wrapper needed.
                        { mult: [weights.persist,    { key: 'should_persist', match: { value: true } }] },
                        // w.recency × exp_decay(source_window_end → chatLength).
                        // Decay uses `x` (the input expression — bare payload field is OK)
                        // and `target` (the value at which decay = 1.0), not `key`/`origin`.
                        { mult: [weights.recency,    { exp_decay: { x: 'source_window_end', target: chatLength, scale: halfLife, midpoint: 0.5 } }] },
                    ],
                },
            },
            limit: topK,
            with_payload: true,
        };
        if (hasOuterFilter) body.filter = outerFilter;

        if (debug) {
            const top5sparse = sparseVector.indices
                .map((idx, i) => ({ idx, val: sparseVector.values[i] }))
                .sort((a, b) => b.val - a.val)
                .slice(0, 5)
                .map(t => `${t.idx}:${t.val.toFixed(3)}`)
                .join(', ');
            console.log(`[Qdrant-debug] hybridQueryNativeWithRerank: collection=${collectionName}, topK=${topK}, prefetchLimit=${prefetchLimit}, hybridLimit=${hybridLimit}`);
            console.log(`[Qdrant-debug] weights: cosine=${weights.cosine?.toFixed(3)} importance=${weights.importance?.toFixed(3)} persist=${weights.persist?.toFixed(3)} recency=${weights.recency?.toFixed(3)} rrfScoreScale=${rrfScoreScale}`);
            console.log(`[Qdrant-debug] recency: origin=${chatLength}, halfLife=${halfLife}; filter: minImportance=${minImportance}, visibleThreshold=${applyContextDedupFilter ? visibleThreshold : '(disabled)'}`);
            if (options.debugQuery) {
                console.log(`[Qdrant-debug] Query text: "${String(options.debugQuery).slice(0, 200)}"`);
            }
            console.log(`[Qdrant-debug] Dense: dim=${denseVector.length}; Sparse: ${sparseVector.indices.length} tokens, top-5 by weight: [${top5sparse}]`);
        }

        let resp;
        try {
            resp = await this._request('POST', `/collections/${collectionName}/points/query`, body);
        } catch (err) {
            // Auto-heal: existing collections created before the should_persist bool index was
            // added will hit "Index required but not found for should_persist". Create the index
            // now and retry once — subsequent queries on this collection will succeed without retrying.
            if (err.message?.includes('should_persist')) {
                console.warn('[Qdrant] Missing should_persist index — creating it now and retrying...');
                try {
                    await this._request('PUT', `/collections/${collectionName}/index`, {
                        field_name: 'should_persist',
                        field_schema: 'bool',
                    });
                    resp = await this._request('POST', `/collections/${collectionName}/points/query`, body);
                } catch (retryErr) {
                    console.error('[Qdrant] hybridQueryNativeWithRerank retry failed:', retryErr.message);
                    throw retryErr;
                }
            } else {
                console.error('[Qdrant] hybridQueryNativeWithRerank request failed. Body:', JSON.stringify(body).slice(0, 800), 'Error:', err.message);
                throw err;
            }
        }
        const points = resp.result?.points || [];

        // D1: Loud one-shot warning if legacy sentinel still present on-disk.
        if (!_legacyDataWarningFired && points.some(p => p.payload?.type === '_vecthare_meta')) {
            _legacyDataWarningFired = true;
            console.warn('[VectFox] LEGACY DATA DETECTED — run the "Upgrade to VectFox v2" button in the Action tab before querying.');
        }

        console.log(`[Qdrant] Native hybrid + rerank returned ${points.length} results from ${collectionName}`);

        if (debug) {
            points.slice(0, 10).forEach((p, i) => {
                const text = p.payload?.text ? String(p.payload.text).slice(0, 80).replace(/\n/g, ' ') : '';
                console.log(`[Qdrant-debug] [${i + 1}] formulaScore=${p.score?.toFixed(4)}, imp=${p.payload?.importance}, persist=${p.payload?.should_persist}, swe=${p.payload?.source_window_end}, text="${text}"`);
            });
        }

        return points.map(p => ({
            hash: p.payload?.hash,
            text: p.payload?.text,
            score: p.score,                 // = formula output (re-ranked score)
            formulaScore: p.score,
            metadata: p.payload,
            fusionMethod: 'rrf',
            nativeSparse: true,
            rerankApplied: true,
        }));
    }

    /**
     * List all items in a collection (MULTITENANCY)
     * @param {string} collectionName - Collection name: the chat's own, or "vectfox_main" with multitenancy on
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and any narrowing filters
     * @param {object} options - Options { includeVectors, scrollLimit }
     * @returns {Promise<Array>} Array of items with {hash, text, metadata, vector?}
     */
    async listItems(collectionName, filters = {}, options = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        // The chat's own collection, or vectfox_main with multitenancy on
        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return [];
            }

            // Sentinel exclusion is centralized in _buildFilterExcludingSentinel —
            // surfacing the sentinel in chunk listings breaks delete-by-hash flows
            // (chunk.hash is undefined → Qdrant rejects the delete with 400
            // PointsSelector format error).
            const filter = this._buildFilterExcludingSentinel(this._scopeMust(filters));

            // Scroll through all points
            const items = [];
            let offset = null;

            // Scroll batch size. Default 100 (Qdrant's recommendation for large payloads).
            // Export uses 500 (vectors + text fits well under the 16-32 MB/request target,
            // 5x fewer round trips). Pure reads have no indexing overhead so larger is safe.
            const scrollLimit = options.scrollLimit || 100;

            do {
                const scrollPayload = {
                    limit: scrollLimit,
                    with_payload: true,
                    with_vector: options.includeVectors || false,
                    filter,
                };

                if (offset !== null) {
                    scrollPayload.offset = offset;
                }

                const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, scrollPayload);

                items.push(...(response.result?.points || []).map(p => ({
                    hash: p.payload.hash,
                    text: p.payload.text,
                    metadata: p.payload,
                    vector: options.includeVectors ? p.vector : undefined,
                })));
                offset = response.result?.next_page_offset;
            } while (offset !== null && offset !== undefined);

            console.log(">>> [Qdrant] Listed", items.length, "items from", mainCollection);
            return items;
        } catch (error) {
            console.error(`[Qdrant] Failed to list items from ${mainCollection}:`, error.message);
            return [];
        }
    }

    /**
     * Get all saved hashes from a collection (MULTITENANCY)
     * @param {string} collectionName - Collection name: the chat's own, or "vectfox_main" with multitenancy on
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and any narrowing filters
     * @returns {Promise<number[]>} Array of hashes
     */
    async getSavedHashes(collectionName, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return [];
            }

            // Scroll through all points to get hashes. Sentinel exclusion is
            // centralized in _buildFilterExcludingSentinel — sentinel has no
            // `hash` field, so without the exclusion this list would contain
            // `undefined` entries that confuse exists/delete-by-hash callers.
            const filter = this._buildFilterExcludingSentinel(this._scopeMust(filters));
            const hashes = [];
            let offset = null;

            do {
                const scrollPayload = {
                    limit: 100,
                    with_payload: { include: ['hash'] },
                    with_vector: false,
                    filter,
                };

                if (offset !== null) {
                    scrollPayload.offset = offset;
                }

                const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, scrollPayload);

                hashes.push(...(response.result?.points || []).map(p => p.payload.hash));
                offset = response.result?.next_page_offset;
            } while (offset !== null && offset !== undefined);

            return hashes;
        } catch (error) {
            console.error(`[Qdrant] Failed to get hashes from ${mainCollection}:`, error.message);
            return [];
        }
    }

    /**
     * Delete items by hash. When the filters name a tenant, the delete matches the payload `hash` inside that tenant,
     * so a hash two collections of the shared one both hold is deleted from one of them only. Without a tenant it
     * deletes the points whose ID is the hash, as before.
     * @param {string} collectionName - Collection name: the collection's own, or "vectfox_main" with multitenancy on
     * @param {number[]} hashes - Hashes to delete
     * @param {object} [filters] - The tenant, {content_type}, and any narrowing filters
     * @returns {Promise<void>}
     */
    async deleteVectors(collectionName, hashes, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }
        if (hashes.length === 0) return;

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        // Validate: Qdrant point IDs must be uint or UUID string. Drop null/undefined/NaN
        // hashes before sending; surface them as an error so the client knows the delete
        // never reached Qdrant for those items (previously: 400 from Qdrant + silent catch).
        const numericHashes = [];
        const invalidHashes = [];
        for (const h of hashes) {
            const n = typeof h === 'string' ? parseInt(h, 10) : h;
            if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
                numericHashes.push(n);
            } else {
                invalidHashes.push(h);
            }
        }
        if (invalidHashes.length > 0) {
            throw new Error(`[Qdrant] Cannot delete: ${invalidHashes.length} item(s) have invalid hashes (${JSON.stringify(invalidHashes.slice(0, 3))}). These items likely have no \`hash\` payload field — e.g. the VectFox sentinel point. Listing now filters the sentinel out, so this should not happen for normal chunks.`);
        }
        if (numericHashes.length === 0) {
            throw new Error(`[Qdrant] Cannot delete: all ${hashes.length} hash(es) were invalid.`);
        }

        // Throw on failure so the route returns 500 and the client UI sees the error.
        await this._request('POST', `/collections/${mainCollection}/points/delete?wait=true`, this._namesTenant(filters)
            ? { filter: { must: [...this._scopeMust(filters), { key: 'hash', match: { any: numericHashes } }] } }
            : { points: numericHashes });

        console.log(`[Qdrant] Deleted ${numericHashes.length} items from ${mainCollection}${filters[TENANT_FIELD] ? ` (${TENANT_FIELD}: ${filters[TENANT_FIELD]})` : ''}`);
    }

    /**
     * Delete one tenant's points from a shared collection: every point the filters' tenant holds, {content_type} or the
     * older {type, sourceId}. Filters that name no tenant throw rather than report a purge that deleted nothing.
     * @param {string} collectionName - Collection name: the collection's own, or "vectfox_main" with multitenancy on
     * @param {object} filters - The tenant to delete
     * @returns {Promise<void>}
     */
    async purgeCollection(collectionName, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return;
            }

            if (!this._namesTenant(filters)) {
                throw new Error(`[Qdrant] A purge of ${mainCollection} by filter needs a tenant (${TENANT_FIELD}, type or sourceId), `
                    + `and these filters name none: ${JSON.stringify(Object.keys(filters))}. Nothing was deleted.`);
            }

            // Delete points by filter
            await this._request('POST', `/collections/${mainCollection}/points/delete?wait=true`, {
                filter: { must: this._scopeMust(filters) }
            });

            console.log(`[Qdrant] Purged ${mainCollection} (${TENANT_FIELD}: ${filters[TENANT_FIELD]}, type: ${filters.type}, sourceId: ${filters.sourceId})`);
        } catch (error) {
            if (error.message?.includes('404')) {
                return;
            }
            console.error(`[Qdrant] Purge failed for ${mainCollection}:`, error.message);
            throw error;
        }
    }

    /**
     * Delete a whole collection, "vectfox_main" unless another is named. With multitenancy on, that is every chat's
     * data.
     * @param {string} [collectionName] - The collection to delete
     * @returns {Promise<void>}
     */
    async purgeAll(collectionName = MULTITENANCY_COLLECTION) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            await this._request('DELETE', `/collections/${mainCollection}`);
            console.log(`[Qdrant] Purged entire collection: ${mainCollection}`);
        } catch (error) {
            if (error.message?.includes('404')) {
                return;
            }
            console.error(`[Qdrant] Purge all failed:`, error.message);
            throw error;
        }
    }

    // ========================================================================
    // ADDITIONAL METHODS REQUIRED BY PLUGIN ROUTER
    // ========================================================================



    async getCollections() {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }
        try {
            const collections = await this._request('GET', '/collections');
            return collections.result?.collections?.map(c => c.name) || [];
        } catch (error) {
            console.error(`[Qdrant] getCollections failed:`, error.message);
            return [];
        }
    }

    /**
     * Index the tenant field on a collection made before it was indexed, once per collection per process. A tenant
     * filter works without the index but reads every point; the facet discovery uses needs it.
     * @private
     * @param {string} collectionName
     * @returns {Promise<void>}
     */
    async _ensureTenantIndex(collectionName) {
        this._tenantIndexed ??= new Set();
        if (this._tenantIndexed.has(collectionName)) return;
        try {
            await this._request('PUT', `/collections/${collectionName}/index?wait=true`, {
                field_name: TENANT_FIELD,
                field_schema: { type: 'keyword', is_tenant: true },
            });
        } catch (error) {
            if (!error.message?.includes('already exists') && !error.message?.includes('409')) throw error;
        }
        this._tenantIndexed.add(collectionName);
    }

    /**
     * The tenants of a shared collection, each with its point count, from Qdrant's facet counts (Qdrant 1.12+).
     * @param {string} collectionName
     * @returns {Promise<Array<{tenant: string, count: number}>>}
     * @throws {Error} When Qdrant cannot count them, or when the answer may be cut at the facet limit
     */
    async listTenants(collectionName) {
        collectionName = this._parseCollectionName(collectionName);
        await this._ensureTenantIndex(collectionName);
        const response = await this._request('POST', `/collections/${collectionName}/facet`, {
            key: TENANT_FIELD,
            limit: TENANT_FACET_LIMIT,
            exact: true,
        });
        const hits = response.result?.hits || [];
        if (hits.length >= TENANT_FACET_LIMIT) {
            throw new Error(`[Qdrant] ${collectionName} has at least ${TENANT_FACET_LIMIT} tenants, more than one discovery lists`);
        }
        // Qdrant 1.20 still reports a tenant whose points were all deleted, with a count of 0: it is gone.
        return hits.filter(hit => hit.count > 0).map(hit => ({ tenant: String(hit.value), count: hit.count }));
    }

    /**
     * The exact number of points the filters select, the sentinel left out.
     * @param {string} collectionName
     * @param {object} [filters]
     * @returns {Promise<number>}
     */
    async countPoints(collectionName, filters = {}) {
        collectionName = this._parseCollectionName(collectionName);
        const response = await this._request('POST', `/collections/${collectionName}/points/count`, {
            filter: this._buildFilterExcludingSentinel(this._scopeMust(filters)),
            exact: true,
        });
        return response.result?.count ?? 0;
    }

    /**
     * The embedding source one point the filters select was stored with, or 'unknown'.
     * @private
     * @param {string} collectionName
     * @param {object} [filters]
     * @returns {Promise<string>}
     */
    async _sampleEmbeddingSource(collectionName, filters = {}) {
        const response = await this._request('POST', `/collections/${collectionName}/points/scroll`, {
            filter: this._buildFilterExcludingSentinel(this._scopeMust(filters)),
            limit: 1,
            with_payload: { include: ['embeddingSource'] },
            with_vector: false,
        });
        return response.result?.points?.[0]?.payload?.embeddingSource || 'unknown';
    }

    /**
     * One hybrid search of one LoreBase index, pooled per entry (VectFox's lorebook passage index, its plan §5.6): a
     * flat search fusing the dense and sparse legs by RRF, read in fused order, each entry keeping its best passages.
     * Not Qdrant's grouped query, whose fused scores rise as earlier groups drop out. A dense search alongside gives
     * each passage its cosine, the score a gate can hold to a bar; the fused score only ranks.
     * @param {string} collectionName
     * @param {number[]} denseVector
     * @param {{indices: number[], values: number[]}} sparseVector
     * @param {object} [filters] - The index's tenant, {content_type}
     * @param {{prefetchLimit?: number, entries?: number, passagesPerEntry?: number}} [limits]
     * @returns {Promise<Array<{entryKey: string, entryUid: number, score: number, cosine: number, passages: Array<{hash: number, passageIndex: number, sectionName: string, score: number, cosine: number}>}>>}
     */
    async pooledSearch(collectionName, denseVector, sparseVector, filters = {}, { prefetchLimit = 300, entries = 10, passagesPerEntry = 3 } = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');
        collectionName = this._parseCollectionName(collectionName);
        const filter = this._buildHybridFilter(filters);
        const fields = ['entryKey', 'entryUid', 'sectionName', 'passageIndex', 'hash'];
        const [fused, dense] = await Promise.all([
            this._request('POST', `/collections/${collectionName}/points/query`, {
                prefetch: [
                    { query: denseVector, limit: prefetchLimit, filter },
                    { query: sparseVector, using: 'text_sparse', limit: prefetchLimit, filter },
                ],
                query: { fusion: 'rrf' },
                limit: prefetchLimit,
                with_payload: fields,
            }),
            this._request('POST', `/collections/${collectionName}/points/query`, {
                query: denseVector,
                filter,
                limit: prefetchLimit,
                with_payload: false,
            }),
        ]);
        const cosineOf = new Map((dense.result?.points || []).map(point => [String(point.id), point.score]));
        const byEntry = new Map();
        for (const point of fused.result?.points || []) {
            const payload = point.payload || {};
            if (payload.entryKey === undefined || payload.entryKey === null) continue;
            const cosine = cosineOf.get(String(point.id)) ?? 0;
            let entry = byEntry.get(payload.entryKey);
            if (!entry) {
                if (byEntry.size >= entries) continue;
                entry = { entryKey: payload.entryKey, entryUid: payload.entryUid, score: point.score, cosine, passages: [] };
                byEntry.set(payload.entryKey, entry);
            }
            entry.cosine = Math.max(entry.cosine, cosine);
            if (entry.passages.length < passagesPerEntry) {
                entry.passages.push({ hash: payload.hash, passageIndex: payload.passageIndex, sectionName: payload.sectionName, score: point.score, cosine });
            }
        }
        return [...byEntry.values()];
    }

    /**
     * What VectFox's collection discovery sees in Qdrant: each collection of its own, and each tenant of the shared
     * collection as a collection of its own, which is how VectFox names it. `tenantsListed` is false when a shared
     * collection's tenants could not all be listed (a Qdrant older than 1.12 has no facet counts); the shared
     * collection is then listed by its own name, as before.
     * @returns {Promise<{collections: Array<{id: string, source: string, chunkCount: number, sharedCollection?: string}>, tenantsListed: boolean}>}
     */
    async describeCollections() {
        const collections = [];
        let tenantsListed = true;
        for (const name of await this.getCollections()) {
            if (name === MULTITENANCY_COLLECTION) {
                try {
                    for (const { tenant, count } of await this.listTenants(name)) {
                        collections.push({
                            id: tenant,
                            source: await this._sampleEmbeddingSource(name, { [TENANT_FIELD]: tenant }),
                            chunkCount: count,
                            sharedCollection: name,
                        });
                    }
                    continue;
                } catch (error) {
                    tenantsListed = false;
                    console.warn(`[Qdrant] The tenants of ${name} were not listed, so discovery shows it whole:`, error.message);
                }
            }
            // A "source:id" or "backend:source:id" name carries its source; otherwise one point says it.
            const parts = name.split(':');
            const source = parts.length === 2 ? parts[0]
                : parts.length === 3 ? parts[1]
                    : await this._sampleEmbeddingSource(name);
            collections.push({ id: name, source, chunkCount: await this.countPoints(name) });
        }
        return { collections, tenantsListed };
    }

    /**
     * Get a single item by hash (MULTITENANCY)
     * @param {string} collectionName - Collection name: the chat's own, or "vectfox_main" with multitenancy on
     * @param {number} hash - Item hash to find
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and any narrowing filters
     * @returns {Promise<object|null>} Item or null if not found
     */
    async getItem(collectionName, hash, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;
        console.log(mainCollection);
        // Ensure hash is numeric for consistent matching with stored payload
        const numericHash = typeof hash === 'string' ? parseInt(hash, 10) : hash;

        try {
            // Build filter to find specific item
            const must = [
                { key: 'hash', match: { value: numericHash } },
                ...this._scopeMust(filters),
            ];

            const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, {
                filter: { must },
                limit: 1,
                with_payload: true,
                with_vector: true,
            });

            const points = response.result?.points || [];
            if (points.length === 0) {
                return null;
            }

            const p = points[0];
            return {
                hash: p.payload.hash,
                text: p.payload.text,
                vector: p.vector,
                metadata: p.payload,
            };
        } catch (error) {
            console.error(`[Qdrant] getItem failed:`, error.message);
            return null;
        }
    }

    /**
     * Update an item (delete and re-insert with new data)
     * @param {string} collectionName - Collection name
     * @param {number} hash - Item hash to update
     * @param {object} updates - Updated fields {text?, hash?, vector?, ...metadata}
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and any narrowing filters
     * @returns {Promise<void>}
     */
    async updateItem(collectionName, hash, updates, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        // Get existing item
        const existing = await this.getItem(collectionName, hash, filters);
        if (!existing) {
            throw new Error(`Item with hash ${hash} not found`);
        }

        // Delete old item
        await this.deleteVectors(collectionName, [hash], filters);

        // Merge updates with existing data
        const newHash = updates.hash || hash;
        const newItem = {
            hash: newHash,
            text: updates.text || existing.text,
            vector: updates.vector || existing.vector,
            metadata: { ...existing.metadata, ...updates },
        };

        // Insert updated item
        await this.insertVectors(collectionName, [newItem], filters);

        console.log(`[Qdrant] Updated item ${hash} -> ${newHash}`);
    }

    /**
     * Update item metadata only (no re-embedding needed)
     * @param {string} collectionName - Collection name
     * @param {number} hash - Item hash to update
     * @param {object} metadata - New metadata fields to merge
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and any narrowing filters
     * @returns {Promise<void>}
     */
    async updateItemMetadata(collectionName, hash, metadata, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const numericHash = typeof hash === 'string' ? parseInt(hash, 10) : hash;

        // Use Qdrant's native payload-update endpoint — no vector fetch/delete/reinsert needed.
        // This works correctly for both plain-vector and named-vector (hybrid) collections. With a tenant named, the
        // point is found by payload hash inside it, as deleteVectors finds it.
        await this._request('POST', `/collections/${collectionName}/points/payload?wait=true`, this._namesTenant(filters)
            ? { payload: metadata, filter: { must: [...this._scopeMust(filters), { key: 'hash', match: { value: numericHash } }] } }
            : { payload: metadata, points: [numericHash] });

        console.log(`[Qdrant] Updated metadata for item ${hash}`);
    }

    /**
     * Query vectors with threshold filtering (alias for queryCollection)
     * @param {string} collectionName - Collection name
     * @param {number[]} queryVector - Query vector
     * @param {number} topK - Number of results
     * @param {number} threshold - Minimum score threshold
     * @param {object} filters - Payload filters
     * @returns {Promise<Array>} Results above threshold
     */
    async queryVectors(collectionName, queryVector, topK, threshold, filters = {}) {
        const results = await this.queryCollection(collectionName, queryVector, topK, filters);
        // Filter by threshold
        return results.filter(r => r.score >= threshold);
    }

    /**
     * Get collection statistics (MULTITENANCY)
     * @param {string} collectionName - Collection name
     * @param {object} filters - The tenant ({content_type}, or the older {type, sourceId}) and any narrowing filters
     * @returns {Promise<object>} Statistics object
     */
    async getCollectionStats(collectionName, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return {
                    chunkCount: 0,
                    totalCharacters: 0,
                    totalTokens: 0,
                    storageSize: 0,
                    embeddingDimensions: 0,
                    avgChunkSize: 0,
                    messageCount: 0,
                    sources: {},
                    backend: 'qdrant',
                };
            }

            // Get collection info from Qdrant
            const collectionInfo = await this._request('GET', `/collections/${mainCollection}`);
            const totalPoints = collectionInfo.result?.points_count || 0;
            const vectorSize = collectionInfo.result?.config?.params?.vectors?.size || 0;

            // Get items matching filters to calculate stats
            const items = await this.listItems(collectionName, filters, { includeVectors: false });

            let totalCharacters = 0;
            let totalTokens = 0;
            const sources = {};
            const messageHashes = new Set();

            for (const item of items) {
                const text = item.text || '';
                totalCharacters += text.length;
                totalTokens += Math.ceil(text.length / 4); // Rough estimate

                const src = item.metadata?.embeddingSource || 'unknown';
                sources[src] = (sources[src] || 0) + 1;

                if (item.metadata?.originalMessageHash) {
                    messageHashes.add(item.metadata.originalMessageHash);
                }
            }

            return {
                chunkCount: items.length,
                totalPoints: totalPoints, // Total in collection (all tenants)
                totalCharacters,
                totalTokens,
                storageSize: 0, // Qdrant doesn't expose this easily
                embeddingDimensions: vectorSize,
                avgChunkSize: items.length > 0 ? Math.round(totalCharacters / items.length) : 0,
                messageCount: messageHashes.size,
                sources,
                backend: 'qdrant',
            };
        } catch (error) {
            console.error(`[Qdrant] getCollectionStats failed:`, error.message);
            return {
                chunkCount: 0,
                totalCharacters: 0,
                totalTokens: 0,
                storageSize: 0,
                embeddingDimensions: 0,
                avgChunkSize: 0,
                messageCount: 0,
                sources: {},
                backend: 'qdrant',
                error: error.message,
            };
        }
    }

    /**
     * Check if a chunk with given message IDs already exists (duplicate detection)
     * Like st-qdrant-memory's chunkExists function
     * @param {string} collectionName - Collection name
     * @param {string[]} messageIds - Array of message IDs to check
     * @param {object} filters - Multitenancy filters
     * @returns {Promise<boolean>} True if any chunk contains these message IDs
     */
    async chunkExists(collectionName, messageIds, filters = {}) {
        if (!this.baseUrl) { console.error(`[Qdrant LIFECYCLE] 'Qdrant not initialized' thrown. instanceId=${this._instanceId}, initCount=${this._initCount}, config.url=${this.config?.url}, config.host=${this.config?.host}, config.port=${this.config?.port}, apiKey=${this.apiKey ? '(set)' : '(null)'}`); throw new Error('Qdrant not initialized'); }
        if (!messageIds || messageIds.length === 0) return false;

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Build OR conditions for message ID matching
            const should = messageIds.map(id => ({
                key: 'messageIds',
                match: { text: String(id) }
            }));

            // The tenant and any narrowing filters as must conditions
            const must = this._scopeMust(filters);

            const filter = { should };
            if (must.length > 0) {
                filter.must = must;
            }

            const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, {
                filter,
                limit: 1,
                with_payload: false,
                with_vector: false,
            });

            return (response.result?.points?.length || 0) > 0;
        } catch (error) {
            console.error(`[Qdrant] chunkExists failed:`, error.message);
            return false;
        }
    }
}

// Export singleton instance
const qdrantBackend = new QdrantBackend();
// LIFECYCLE: prove how many times this module was evaluated. If the bug is
// caused by Node.js re-importing the module (cache invalidation, plugin
// reload), we'll see this line fire more than once per process lifetime.
console.log(`[Qdrant LIFECYCLE] qdrant-backend.js module evaluated, exporting instanceId=${qdrantBackend._instanceId}`);
export default qdrantBackend;
