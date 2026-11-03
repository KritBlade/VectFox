/**
 * ============================================================================
 * VECTFOX CHAT VECTORIZATION
 * ============================================================================
 * Core logic for vectorizing chat messages and retrieving relevant context
 *
 * @author Kritblade
 * ============================================================================
 */

import { getCurrentChatId, substituteParams, getContext } from '../../sillytavern/chat.js';
import { is_send_press } from '../../sillytavern/generation.js';
import { setExtensionPrompt, extension_prompts } from '../../sillytavern/prompt-injection.js';
import { getStringHash as calculateHash } from '../../sillytavern/identifiers.js';
import { extractChatKeywords } from '../keyword-search/index.js';
import { getSavedHashes, queryCollection, isBackendAvailable, runBoundedRetrieval } from '../vector-backend/index.js';
import {
    getCollectionRegistry,
    isCollectionEmpty,
    isCollectionEnabled,
    filterActiveCollections,
    buildSearchContext,
    processChunkLinks,
    getChunkMetadata,
    getCollectionMeta,
} from '../collections/index.js';
import { progressTracker } from '../../shared/progress-tracker.js';

import { LRUCache } from './lru-cache.js';
import { EXTENSION_PROMPT_TAG, EVENTBASE_PROMPT_TAG, SUMMARIZER_PROMPT_TAG, HASH_CACHE_SIZE } from '../../shared/constants.js';
import { resolveEventBaseRetrievalTimeoutMs } from '../../shared/retrieval-budget.js';
import { log } from '../../sillytavern/log.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    COLLECTION_PREFIXES,
    INTERNAL_COLLECTION_IDS,
    parseRegistryKey,
    getRegistryBackend,
} from '../../shared/collection-ids.js';

// Hash cache for performance
const hashCache = new LRUCache(HASH_CACHE_SIZE);

export { getChatUUID, parseRegistryKey };

/**
 * Gets the hash value for a string (with LRU caching)
 * @param {string} str Input string
 * @returns {number} Hash value
 */
function getStringHash(str) {
    const cached = hashCache.get(str);
    if (cached !== undefined) {
        return cached;
    }
    const hash = calculateHash(str);
    hashCache.set(str, hash);
    return hash;
}

/**
 * Gets message text without file attachments
 * Matches behavior of ST vectors extension for hash compatibility
 * @param {object} message Chat message object
 * @returns {string} Message text without attachment prefix
 */
function getTextWithoutAttachments(message) {
    const fileLength = message?.extra?.fileLength || 0;
    return String(message?.mes || '').substring(fileLength).trim();
}

/**
 * Groups messages according to chunking strategy
 *
 * HASH DESIGN NOTE: Hashes are calculated from combined text ONLY (not message indices).
 * This is INTENTIONAL semantic deduplication - identical text produces identical embeddings,
 * so storing duplicates would waste storage and query budget. Individual message IDs are
 * preserved in metadata.messageIds and metadata.messageHashes for injection lookup.
 * DO NOT add message indices to hash calculation - it would break incremental sync and
 * disable deduplication with no functional benefit.
 *
 * @param {object[]} messages Messages to group
 * @param {string} strategy Chunking strategy: 'per_message', 'conversation_turns', 'message_batch'
 * @param {number} batchSize Number of messages per batch (for message_batch strategy)
 * @param {string} keywordLevel Keyword extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @returns {object[]} Grouped message items ready for chunking
 */
// LEGACY CHAT STRATEGIES NOTE:
// *** will be remove in future version because no longer used by eventbased path ***
// EventBase-enabled chat sync no longer depends on these chat chunk grouping modes, but
// they are kept temporarily for backward compatibility and non-EventBase legacy flows.

/**
 * Synchronizes chat with vector index using simple FIFO queue
 *
 * How it works:
 * 1. Get all messages, get all vectorized hashes from DB
 * 2. Queue = messages not yet in DB (by hash)
 * 3. Process batch: take message, chunk it, insert chunks, remove from queue
 * 4. Repeat until queue empty
 *
 * @param {object} settings VECTFOX settings
 * @param {string|null} [triggerEvent] ST event that scheduled this sync
 * @returns {Promise<object>} Progress info
 */
export async function synchronizeChat(settings, triggerEvent = null) {
    log.lifecycle(`[AutoSync] synchronizeChat: invoked (trigger=${triggerEvent || 'unknown'})`);

    // Master switch: no auto-sync work while VectFox is disabled.
    if (!isVectFoxEnabled(settings)) {
        log.lifecycle('[AutoSync] BAIL: VectFox master switch OFF');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const chatId = getCurrentChatId();
    if (!chatId) {
        log.lifecycle('[AutoSync] BAIL: no chatId');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const uuid = getChatUUID();
    if (!uuid) {
        log.lifecycle('[AutoSync] BAIL: no chatUUID');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // Find EventBase collections registered for this chat and check the per-collection auto-sync flag
    const { findEventBaseCollectionsForChat, resolveEventBaseWriteTarget, pauseAutoSyncForChat } = await import('../eventbase/index.js');
    const { isCollectionAutoSyncEnabled } = await import('../collections/index.js');
    const backend = getRegistryBackend(settings?.vector_backend);
    const eventbaseCollections = findEventBaseCollectionsForChat(uuid, backend);
    // Metadata is keyed by the registry-key form ("backend:id"), matching the
    // write paths (eventbase-workflow.js, content-vectorization.js, settings-panel.js).
    if (log.enabled('lifecycle')) {
        const flagPerCollection = eventbaseCollections.map(({ registryKey }) => `${registryKey}=${isCollectionAutoSyncEnabled(registryKey)}`);
        log.lifecycle(`[AutoSync] uuid=${uuid}, backend=${backend}, eventbaseCollections=${eventbaseCollections.length}, autoSyncFlags=[${flagPerCollection.join(', ')}]`);
    }
    // Gate on the ACTIVE (lock-aware, ownership-filtered) collection ONLY — the same
    // one the AutoSync checkbox reflects (refreshAutoSyncCheckbox → getChatAutoSyncStatus
    // → resolveEventBaseWriteTarget). Using `.some()` across ALL of the chat's
    // collections meant a leftover autoSync=true on a non-active collection (a different
    // persona/backend enabled earlier) fired auto-sync even though the visible toggle was
    // off — and then ingested into the current-backend collection whose own flag was false.
    // Resolving the active collection keeps the toggle and the behavior in lockstep.
    const activeCollection = resolveEventBaseWriteTarget(settings, uuid);
    const autoSyncEnabled = !!activeCollection && isCollectionAutoSyncEnabled(activeCollection.registryKey);

    if (!autoSyncEnabled) {
        log.lifecycle(`[AutoSync] BAIL: active collection auto-sync is off (active=${activeCollection?.registryKey ?? 'none'})`);
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const context = getContext();
    if (!Array.isArray(context.chat)) {
        log.lifecycle('[AutoSync] BAIL: context.chat is not an array');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const { runEventBaseIngestion, getAutoSyncWindowSize } = await import('../eventbase/index.js');
    const messages = context.chat.filter(m => m.mes && m.mes.trim().length > 0);
    log.lifecycle(`[AutoSync] calling runEventBaseIngestion: messages=${messages.length}`);
    let result;
    try {
        result = await runEventBaseIngestion({
            messages,
            chatUUID: uuid,
            settings,
            isAutoSync: true,
            // Pin the write target to the collection we already resolved for the
            // gate above. Without this, runEventBaseIngestion recomputes the ID via
            // buildEventBaseCollectionId(uuid), whose char segment comes from the
            // LIVE context.name2. In a group chat name2 is whichever character is
            // speaking on this trigger, so each speaker's turn would manufacture and
            // lock a NEW per-character EventBase collection for the same chat —
            // scattering events across siblings the summarizer (which reads only the
            // single resolveEventBaseWriteTarget) never sees. The resolved
            // active collection IS the documented auto-sync write target
            // (see Doc/collection_helper.md — resolveEventBaseWriteTarget).
            // activeCollection is guaranteed non-null here: the autoSyncEnabled gate
            // above bails when it's null.
            collectionIdOverride: activeCollection.collectionId,
            // Suppress the popup when the trigger was the user sending a message —
            // the popup should only appear after the AI's reply, not mid-generation.
            // MESSAGE_RECEIVED (and edits/swipes/deletes) still get the popup.
            suppressAutoSyncPopup: triggerEvent === 'MESSAGE_SENT',
            // Feature A: auto-sync uses its own independent window (turns*2), NOT the
            // one-off Vectorize Content eventbase_window_size. Zero overlap so each
            // turn-pair is an independent window.
            windowSizeOverride: getAutoSyncWindowSize(settings),
            windowOverlapOverride: 0,
        });
    } catch (err) {
        // A retired/unknown model (extraction OR embedding) would otherwise be
        // swallowed by ST's ModuleWorkerWrapper and silently re-fail every message.
        // Warn the user once and pause auto-sync so the loop stops until they fix it.
        const { isInvalidModelConfigError, notifyInvalidModel } = await import('../../shared/model-config-notifier.js');
        if (isInvalidModelConfigError(err)) {
            notifyInvalidModel(err.message);
            pauseAutoSyncForChat(uuid, backend);
            return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
        }
        throw err;
    }
    log.lifecycle(`[AutoSync] runEventBaseIngestion result:`, result);

    return {
        remaining: 0,
        messagesProcessed: result.eventsExtracted,
        chunksCreated: result.eventsExtracted,
    };
}

// ============================================================================
// REARRANGE CHAT PIPELINE - Helper Functions
// ============================================================================
// These functions break down the rearrangeChat logic into discrete stages
// for better maintainability and testability.
// ============================================================================

/**
 * Stage 1: Gather all collections that should be queried
 * @returns {string[]} Array of collection IDs to query
 */
function gatherCollectionsToQuery() {
    const collectionsToQuery = [];
    const registry = getCollectionRegistry();

    // Workflow isolation:
    //   vf_eventbase_*     → always excluded (EventBase pipeline owns them)
    //   vf_archiveevent_*  → always excluded (EventBase pipeline owns them)
    //   vf_lorebook_*      → always excluded (Lorebook WI pipeline owns them, injects to <VectFoxLorebook>)
    for (const registryKey of registry) {
        const parsedKey = parseRegistryKey(registryKey);
        const collectionId = parsedKey.collectionId;

        if (collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) ||
            collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT) ||
            collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_LOREBOOK)) {
            continue;
        }

        if (INTERNAL_COLLECTION_IDS.includes(collectionId)) {
            continue;
        }

        if (isCollectionEnabled(registryKey)) {
            collectionsToQuery.push(registryKey);
        }
    }

    return collectionsToQuery;
}

/**
 * Stage 2: Build the search query from recent messages
 * @param {object[]} chat Current chat messages
 * @param {object} settings VECTFOX settings
 * @returns {string} Query text
 */
function buildSearchQuery(chat, settings) {
    const recentMessages = chat
        .filter(x => !x.is_system)
        .reverse()
        .slice(0, settings.query)
        .map(x => substituteParams(x.mes));

    return recentMessages.join('\n').trim();
}

/**
 * Stage 4: Query all active collections and merge results
 * @param {string[]} activeCollections Collections that passed activation filters
 * @param {string} queryText Search query
 * @param {object} settings VECTFOX settings
 * @param {object[]} chat Current chat messages
 * @returns {Promise<object[]>} Array of chunk objects with scores
 */
async function queryAndMergeCollections(activeCollections, queryText, settings, chat) {
    let chunksForVisualizer = [];
    const effectiveTopK = settings.top_k ?? settings.insert;

    // PERF: Build hash-to-message Map once for O(1) lookups instead of O(n) find() per chunk
    const chatHashMap = new Map();
    for (const msg of chat) {
        if (msg.mes) {
            const hash = getStringHash(substituteParams(getTextWithoutAttachments(msg)));
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, msg);
            }
        }
    }

    for (const collectionId of activeCollections) {
        try {
            const queryResults = await queryCollection(collectionId, queryText, effectiveTopK, settings);

            log.trace(`VectFox: Retrieved ${queryResults.hashes.length} chunks from ${collectionId}`);

            // Build chunks with text for visualizer
            const collectionChunks = queryResults.metadata.map((meta, idx) => {
                const hash = queryResults.hashes[idx];

                // Prefer text from metadata (stored in vector DB)
                let text = meta.text;
                let textSource = 'metadata';

                // Fallback: try to find in chat messages if not in metadata
                // PERF: Use pre-built Map for O(1) lookup instead of O(n) find()
                if (!text) {
                    const chatMessage = chatHashMap.get(hash);
                    text = chatMessage ? substituteParams(chatMessage.mes) : '(text not found)';
                    textSource = chatMessage ? 'chat_lookup' : 'not_found';

                    // Debug: Log when text is not found
                    if (textSource === 'not_found') {
                        log.warn(`[VectFox] ⚠️ Chunk text not found! hash=${hash}, meta.text=${meta.text ? 'exists' : 'missing'}, chatMessage=${chatMessage ? 'found' : 'not found'}`);
                    }
                }

                return {
                    hash: hash,
                    metadata: meta,
                    score: meta.score || 1.0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    matchedKeywordsWithWeights: meta.matchedKeywordsWithWeights,
                    keywordBoosted: meta.keywordBoosted,
                    similarity: meta.score || 1.0,
                    text: text,
                    index: meta.messageId || meta.index || 0,
                    collectionId: collectionId,
                    decayApplied: false,
                    // Hybrid search scores
                    vectorScore: meta.vectorScore,
                    textScore: meta.textScore,
                    hybridSearch: meta.hybridSearch
                };
            });

            chunksForVisualizer.push(...collectionChunks);
        } catch (error) {
            log.warn(`VectFox: Failed to query collection ${collectionId}:`, error.message);
        }
    }

    // Sort merged results by score (descending).
    // No global topK cap here — each collection already queried with effectiveTopK.
    // Downstream stages (threshold, decay, dedup) handle final count.
    chunksForVisualizer.sort((a, b) => b.score - a.score);

    return chunksForVisualizer;
}

/**
 * Stage 4.5: Expand summary chunks to their parent chunks (dual-vector system)
 * When a summary chunk matches a query, we want to inject the full parent text instead.
 * The summary's score is preserved since that's what semantically matched.
 *
 * @param {object[]} chunks Chunks from query results
 * @param {string[]} activeCollections Collections that were queried
 * @param {object} settings VECTFOX settings
 * @returns {Promise<object[]>} Chunks with summaries expanded to parents
 */
async function expandSummaryChunks(chunks, activeCollections, settings) {
    const expandedChunks = [];
    const parentHashesNeeded = new Map(); // parentHash -> { summaryChunk, collectionId }

    // First pass: identify which chunks are summaries and need parent expansion
    for (const chunk of chunks) {
        const meta = chunk.metadata || {};
        const isSummary = meta.isSummaryChunk || meta.isSummary || meta.isSummaryVector;
        const parentHash = meta.parentHash;

        if (isSummary && parentHash) {
            // Track this summary for parent lookup
            parentHashesNeeded.set(String(parentHash), {
                summaryChunk: chunk,
                collectionId: chunk.collectionId
            });
        } else {
            // Not a summary, keep as-is
            expandedChunks.push(chunk);
        }
    }

    // If no summaries found, return original chunks
    if (parentHashesNeeded.size === 0) {
        return chunks;
    }

    // Second pass: fetch parent chunks from the vector DB
    // Group by collection for efficiency
    const parentsByCollection = new Map();
    for (const [parentHash, info] of parentHashesNeeded) {
        const collectionId = info.collectionId;
        if (!parentsByCollection.has(collectionId)) {
            parentsByCollection.set(collectionId, []);
        }
        parentsByCollection.get(collectionId).push({ parentHash, summaryChunk: info.summaryChunk });
    }

    // Fetch parents from each collection
    for (const [collectionId, parentInfos] of parentsByCollection) {
        try {
            // Get all chunks from this collection with metadata
            const collectionData = await getSavedHashes(collectionId, settings, true);

            if (collectionData && collectionData.metadata) {
                // Build a lookup map of hash -> chunk data
                const chunkLookup = new Map();
                for (let i = 0; i < collectionData.hashes.length; i++) {
                    const hash = String(collectionData.hashes[i]);
                    chunkLookup.set(hash, collectionData.metadata[i]);
                }

                // Find each parent and create expanded chunk
                for (const { parentHash, summaryChunk } of parentInfos) {
                    const parentData = chunkLookup.get(String(parentHash));

                    if (parentData) {
                        // Found parent - create expanded chunk with parent's text but summary's score
                        const expandedChunk = {
                            ...summaryChunk,
                            hash: parentHash, // Use parent's hash for deduplication
                            text: parentData.text || parentData.mes || '(parent text not found)',
                            metadata: {
                                ...parentData,
                                expandedFromSummary: true,
                                originalSummaryHash: summaryChunk.hash,
                                originalSummaryScore: summaryChunk.score
                            },
                            // Keep summary's score since that's what matched the query
                            score: summaryChunk.score,
                            originalScore: summaryChunk.originalScore,
                            expandedFromSummary: true
                        };

                        expandedChunks.push(expandedChunk);
                    } else {
                        // Parent not found - keep the summary chunk as fallback
                        log.warn(`VectFox: Parent chunk ${parentHash} not found for summary ${summaryChunk.hash}, using summary text`);
                        expandedChunks.push(summaryChunk);
                    }
                }
            } else {
                // Couldn't get collection data - keep summaries as-is
                for (const { summaryChunk } of parentInfos) {
                    expandedChunks.push(summaryChunk);
                }
            }
        } catch (error) {
            log.warn(`VectFox: Failed to expand summaries from ${collectionId}:`, error.message);
            // Keep summaries as-is on error
            for (const { summaryChunk } of parentInfos) {
                expandedChunks.push(summaryChunk);
            }
        }
    }

    return expandedChunks;
}

/**
 * Stage 6: Apply threshold filter to chunks
 * @param {object[]} chunks Chunks to filter
 * @param {number} threshold Score threshold
 * @returns {object[]} Filtered chunks
 */
function applyThresholdFilter(chunks, threshold) {
    return chunks.filter(chunk => chunk.score >= threshold);
}

/**
 * Stage 8.5: Process chunk links
 * - Processes explicit chunk links (soft boost / hard include)
 * @param {object[]} chunks Chunks to process
 * @param {string[]} activeCollections Active collection IDs (unused, kept for call-site compatibility)
 * @param {object} settings VECTFOX settings
 * @returns {Promise<object[]>} Processed chunks with links applied
 */
async function applyGroupsAndLinksStage(chunks, activeCollections, settings) {
    let processedChunks = [...chunks];

    // Build metadata map for chunks that have explicit links.
    // Backend payload (chunk.metadata.chunkLinks) is source of truth; ext_settings is the
    // legacy fallback. NOTE: processChunkLinks indexes this as a PLAIN OBJECT (map[hash]),
    // so it must be a {} — not a Map (a Map indexed with [] is always undefined).
    const chunkMetadataMap = {};
    const forceTargetCollection = new Map(); // parseInt(targetHash) -> source chunk's collectionId
    for (const chunk of processedChunks) {
        const links = chunk.metadata?.chunkLinks || getChunkMetadata(chunk.hash)?.chunkLinks;
        if (links && links.length > 0) {
            chunkMetadataMap[String(chunk.hash)] = { chunkLinks: links };
            // Links are within-collection (the link editor only lists same-collection
            // targets), so a force target lives in the source chunk's collection.
            for (const link of links) {
                if (link.mode === 'force') forceTargetCollection.set(parseInt(link.targetHash), chunk.collectionId);
            }
        }
    }

    if (Object.keys(chunkMetadataMap).length > 0) {
        const linkResult = processChunkLinks(processedChunks, chunkMetadataMap, settings.group_soft_boost || 0.15);
        processedChunks = linkResult.chunks;

        // Force links: pull in any force-linked targets that weren't already retrieved, so
        // "target MUST appear when this chunk appears" actually holds. These bypass the
        // query and threshold stages by design (they ran earlier); dedup may still
        // skip ones already present in the chat context.
        if (linkResult.missingHardLinks?.length > 0) {
            const fetched = await fetchForceLinkedChunks(linkResult.missingHardLinks, forceTargetCollection, settings);
            const present = new Set(processedChunks.map(c => String(c.hash)));
            const toAdd = fetched.filter(c => !present.has(String(c.hash)));
            if (toAdd.length > 0) {
                processedChunks.push(...toAdd);
            }
        }
    }

    return processedChunks;
}

/**
 * Fetch force-linked target chunks that weren't in the query results so they can be
 * injected (mode: 'force' = "target MUST appear"). Targets are grouped by collection
 * (links are within-collection) and pulled from the backend via getSavedHashes(..., true).
 * Forced chunks are marked forceLinked and given a top score so they survive to injection.
 * @param {number[]} missingHashes Force-link target hashes not present in results
 * @param {Map<number,string>} targetCollection parseInt(hash) -> collectionId
 * @param {object} settings VECTFOX settings
 * @returns {Promise<object[]>} Chunk objects ready to inject
 */
async function fetchForceLinkedChunks(missingHashes, targetCollection, settings) {
    // Group missing hashes by their collection
    const byCollection = new Map();
    for (const hash of missingHashes) {
        const collectionId = targetCollection.get(hash);
        if (!collectionId) continue; // unknown source collection — can't locate it
        if (!byCollection.has(collectionId)) byCollection.set(collectionId, []);
        byCollection.get(collectionId).push(hash);
    }

    const fetched = [];
    for (const [collectionId, hashes] of byCollection) {
        try {
            const data = await getSavedHashes(collectionId, settings, true);
            if (!data?.metadata) continue;
            const lookup = new Map();
            for (let i = 0; i < data.hashes.length; i++) {
                lookup.set(String(data.hashes[i]), data.metadata[i]);
            }
            for (const hash of hashes) {
                const meta = lookup.get(String(hash));
                if (!meta) {
                    log.warn(`VectFox: Force-linked target ${hash} not found in ${collectionId}`);
                    continue;
                }
                fetched.push({
                    hash,
                    metadata: meta,
                    text: meta.text || meta.mes || '(force-linked text not found)',
                    score: 1.0,
                    originalScore: meta.score,
                    similarity: 1.0,
                    index: meta.messageId || meta.index || 0,
                    collectionId,
                    forceLinked: true,
                });
            }
        } catch (error) {
            log.warn(`VectFox: Failed to fetch force-linked chunks from ${collectionId}:`, error.message);
        }
    }
    return fetched;
}

/**
 * Stage 9: Deduplicate chunks already in chat context
 * Only checks against recent messages within the context window, not entire chat history.
 * @param {object[]} chunks Chunks to deduplicate
 * @param {object[]} chat Current chat messages
 * @param {object} settings VECTFOX settings (uses deduplication_depth)
 * @returns {{toInject: object[], skipped: object[]}} Chunks to inject and skipped duplicates
 */
function deduplicateChunks(chunks, chat, settings) {
    // Determine how far back to check for duplicates
    // Default to 50 messages if not specified (reasonable context window)
    const deduplicationDepth = settings.deduplication_depth ?? 50;

    // Only check the most recent N messages (within context window)
    const recentMessages = deduplicationDepth > 0 && deduplicationDepth < chat.length
        ? chat.slice(-deduplicationDepth)
        : chat;

    log.verbose(`[VECTFOX Dedup] Building hash set from ${recentMessages.length} recent messages (depth: ${deduplicationDepth})`);
    log.verbose(`[VECTFOX Dedup] Total chat length: ${chat.length}, checking duplicates in last ${recentMessages.length} messages`);

    // Build set of hashes currently in chat context
    const currentChatHashes = new Set();
    const chatHashMap = new Map(); // For debugging: hash -> message preview

    recentMessages.forEach((msg, idx) => {
        if (msg.mes) {
            const cleanedText = substituteParams(getTextWithoutAttachments(msg));
            const hash = getStringHash(cleanedText);
            currentChatHashes.add(hash);

            // Store sample for debugging (first occurrence only)
            // Calculate absolute index in full chat
            const absoluteIndex = chat.length - recentMessages.length + idx;
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, {
                    index: absoluteIndex,
                    preview: cleanedText.substring(0, 80),
                    isUser: msg.is_user,
                    name: msg.name
                });
            }
        }
    });

    log.verbose(`[VECTFOX Dedup] Built hash set with ${currentChatHashes.size} unique message hashes from recent context`);

    const toInject = [];
    const skipped = [];

    for (const chunk of chunks) {
        const isInChat = currentChatHashes.has(chunk.hash);

        if (isInChat) {
            const matchedMsg = chatHashMap.get(chunk.hash);
            log.trace(`[VECTFOX Dedup] ❌ SKIPPING chunk (hash: ${chunk.hash})`);
            log.trace(`  Chunk text: "${chunk.text?.substring(0, 80)}..."`);
            log.trace(`  Matches chat message #${matchedMsg.index} from ${matchedMsg.name}: "${matchedMsg.preview}..."`);
            log.trace(`  Score: ${chunk.score?.toFixed(4)}, Collection: ${chunk.collectionId}`);

            skipped.push(chunk);
        } else {
            log.trace(`[VECTFOX Dedup] ✅ KEEPING chunk (hash: ${chunk.hash}, score: ${chunk.score?.toFixed(4)})`);
            log.trace(`  Text: "${chunk.text?.substring(0, 80)}..."`);

            toInject.push(chunk);
        }
    }

    log.verbose(`[VECTFOX Dedup] FINAL: ${toInject.length} will inject, ${skipped.length} skipped as duplicates`);

    return { toInject, skipped };
}

/**
 * Builds the nested prompt structure with context and XML tags at each level.
 * Groups chunks by collection and applies wrapping in this order:
 * 1. Global wrapper (outermost)
 * 2. Collection wrapper (groups chunks from same collection)
 * 3. Chunk wrapper (innermost, per-chunk)
 *
 * @param {object[]} chunks Chunks to inject
 * @param {object} settings VECTFOX settings
 * @returns {string} Formatted injection text
 */
function buildNestedInjectionText(chunks, settings) {
    // Group chunks by collection
    const byCollection = new Map();
    for (const chunk of chunks) {
        const collId = chunk.collectionId || 'unknown';
        if (!byCollection.has(collId)) {
            byCollection.set(collId, []);
        }
        byCollection.get(collId).push(chunk);
    }

    // Build collection blocks
    const collectionBlocks = [];

    for (const [collectionId, collChunks] of byCollection) {
        // Get collection metadata for context/xmlTag
        const collMeta = getCollectionMeta(collectionId) || {};
        const collContext = collMeta.context ? substituteParams(collMeta.context) : '';
        const collXmlTag = collMeta.xmlTag || '';

        // Build chunk texts with per-chunk wrapping
        const chunkTexts = collChunks.map(chunk => {
            const chunkMeta = getChunkMetadata(chunk.hash) || {};
            const dbMeta = chunk.metadata || {};
            // Backend payload is source of truth; ext_settings is the legacy fallback.
            const rawContext = dbMeta.context || chunkMeta.context;
            const chunkContext = rawContext ? substituteParams(rawContext) : '';
            const chunkXmlTag = dbMeta.xmlTag || chunkMeta.xmlTag || '';
            const text = chunk.text || '(text not available)';

            // Build chunk with optional wrapping
            let chunkBlock = '';

            if (chunkContext) {
                chunkBlock += chunkContext + '\n';
            }

            if (chunkXmlTag) {
                chunkBlock += `<${chunkXmlTag}>\n${text}\n</${chunkXmlTag}>`;
            } else {
                chunkBlock += text;
            }

            return chunkBlock;
        });

        // Join chunks within this collection
        let collectionBlock = chunkTexts.join('\n\n');

        // Apply collection-level wrapping
        if (collContext) {
            collectionBlock = collContext + '\n\n' + collectionBlock;
        }

        if (collXmlTag) {
            collectionBlock = `<${collXmlTag}>\n${collectionBlock}\n</${collXmlTag}>`;
        }

        collectionBlocks.push(collectionBlock);
    }

    // Join all collection blocks
    let fullText = collectionBlocks.join('\n\n');

    // Apply global-level wrapping
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    const globalXmlTag = settings.rag_xml_tag || '';

    if (globalContext) {
        fullText = globalContext + '\n\n' + fullText;
    }

    if (globalXmlTag) {
        fullText = `<${globalXmlTag}>\n${fullText}\n</${globalXmlTag}>`;
    }

    return fullText;
}

/**
 * Resolves the effective injection position for a chunk using cascade:
 * chunk → collection → global
 * @param {object} chunk Chunk with collectionId
 * @param {object} settings VECTFOX settings
 * @returns {{position: number, depth: number}} Resolved position and depth
 */
function resolveChunkInjectionPosition(chunk, settings) {
    const chunkMeta = getChunkMetadata(chunk.hash) || {};
    const dbMeta = chunk.metadata || {};
    const collMeta = getCollectionMeta(chunk.collectionId) || {};

    // Cascade: chunk (backend payload → ext_settings fallback) → collection → global
    const position = dbMeta.position ?? chunkMeta.position ?? collMeta.position ?? settings.position;
    const depth = dbMeta.depth ?? chunkMeta.depth ?? collMeta.depth ?? settings.depth ?? 2;

    return { position, depth };
}

/**
 * Stage 10: Format and inject chunks into prompt
 * Supports per-chunk/per-collection injection positions via cascade resolution.
 * Groups chunks by their resolved position+depth and creates separate injections.
 *
 * @param {object[]} chunksToInject Chunks to inject
 * @param {object} settings VECTFOX settings
 * @returns {{verified: boolean, text: string}} Injection result
 */
function injectChunksIntoPrompt(chunksToInject, settings) {
    const injectionDebug = log.domainEnabled('injection');
    // Control print: Log chunks QUEUED for injection (not yet injected)
    if (injectionDebug) {
        log.domain('injection', 'trace', `[VECTFOX Injection Control] Preparing to inject ${chunksToInject.length} chunks`);
        log.domain('injection', 'trace', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        let emptyTextCount = 0;
        chunksToInject.forEach((chunk, idx) => {
            const textLength = chunk.text?.length || 0;
            const hasValidText = textLength > 0 && chunk.text !== '(text not found)' && chunk.text !== '(text not available)';
            if (!hasValidText) emptyTextCount++;

            log.domain('injection', 'trace', `  [${idx + 1}/${chunksToInject.length}] CHUNK QUEUED FOR INJECTION ${!hasValidText ? '⚠️ EMPTY/INVALID TEXT' : ''}`);
            log.domain('injection', 'trace', `      Hash: ${chunk.hash}`);
            log.domain('injection', 'trace', `      Score: ${chunk.score?.toFixed(4)}`);
            log.domain('injection', 'trace', `      Collection: ${chunk.collectionId}`);
            log.domain('injection', 'trace', `      Text length: ${textLength} chars ${!hasValidText ? '⚠️' : '✓'}`);
            log.domain('injection', 'trace', `      Text preview: "${chunk.text?.substring(0, 120)}${textLength > 120 ? '...' : ''}"`);
            log.domain('injection', 'trace', '      ─────────────────────────────────────────────────────────────────');
        });
        if (emptyTextCount > 0) {
            log.warn(`[VECTFOX Injection Control] ⚠️ WARNING: ${emptyTextCount}/${chunksToInject.length} chunks have empty or placeholder text!`);
        }
        log.domain('injection', 'trace', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    // Group chunks by resolved injection position+depth
    const positionGroups = new Map(); // "position:depth" → chunks[]

    for (const chunk of chunksToInject) {
        const { position, depth } = resolveChunkInjectionPosition(chunk, settings);
        const key = `${position}:${depth}`;

        if (!positionGroups.has(key)) {
            positionGroups.set(key, { position, depth, chunks: [] });
        }
        positionGroups.get(key).chunks.push(chunk);
    }

    // If all chunks go to the same position, use the simple single-injection path
    if (positionGroups.size === 1) {
        const [_, group] = [...positionGroups.entries()][0];
        const insertedText = buildNestedInjectionText(group.chunks, settings);

        if (injectionDebug) {
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Single position injection: position="${group.position}", depth=${group.depth}, chunks=${group.chunks.length}, textLength=${insertedText.length}`);
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Injection text preview: "${insertedText.substring(0, 200)}${insertedText.length > 200 ? '...' : ''}"`); 
        }

        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, group.position, group.depth, false);

        // Verify injection
        const verifiedPrompt = extension_prompts[EXTENSION_PROMPT_TAG];
        const injectionVerified = verifiedPrompt && verifiedPrompt.value === insertedText;

        if (injectionDebug) {
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Injection verification: ${injectionVerified ? '✓ PASSED' : '✗ FAILED'}`);
            log.domain('injection', 'trace', `[VECTFOX Injection Control] extension_prompts[${EXTENSION_PROMPT_TAG}]:`, {
                exists: !!verifiedPrompt,
                valueLength: verifiedPrompt?.value?.length,
                position: verifiedPrompt?.position,
                depth: verifiedPrompt?.depth,
                valuePreview: verifiedPrompt?.value?.substring(0, 100)
            });
        }

        if (!injectionVerified) {
            log.warn('VectFox: ⚠️ Injection verification failed!', {
                expected: insertedText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...',
                promptExists: !!verifiedPrompt
            });
        }

        return { verified: injectionVerified, text: insertedText };
    }

    // Multiple injection positions - create separate extension prompts for each
    if (injectionDebug) log.domain('injection', 'trace', `[VECTFOX Injection Control] Multiple position injection: ${positionGroups.size} different positions`);

    // Clear the main tag first (will be unused when multi-position)
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);

    let allVerified = true;
    const allTexts = [];
    let groupIndex = 0;

    for (const [key, group] of positionGroups) {
        // Build text for this position group (no global wrapper - that goes on outermost only)
        const groupSettings = { ...settings, rag_context: '', rag_xml_tag: '' };
        const groupText = buildNestedInjectionText(group.chunks, groupSettings);

        if (injectionDebug) {
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Position group ${groupIndex + 1}/${positionGroups.size}: key="${key}", chunks=${group.chunks.length}, textLength=${groupText.length}`);
            group.chunks.forEach((chunk, idx) => {
                log.domain('injection', 'trace', `    [${idx + 1}/${group.chunks.length}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}`);
            });
        }

        // Use unique tag per position group
        const tag = `${EXTENSION_PROMPT_TAG}_pos${groupIndex}`;

        setExtensionPrompt(tag, groupText, group.position, group.depth, false);

        // Verify
        const verifiedPrompt = extension_prompts[tag];
        const verified = verifiedPrompt && verifiedPrompt.value === groupText;

        if (injectionDebug) log.domain('injection', 'trace', `[VECTFOX Injection Control] Position group ${groupIndex + 1} verification: ${verified ? '✓ PASSED' : '✗ FAILED'}`);

        if (!verified) {
            log.warn(`VectFox: ⚠️ Injection verification failed for position ${key}`, {
                tag,
                expected: groupText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...'
            });
            allVerified = false;
        }

        allTexts.push(groupText);
        groupIndex++;
    }

    if (injectionDebug) log.domain('injection', 'trace', `[VECTFOX Injection Control] Injection complete: ${allVerified ? '✓ All verified' : '✗ Some failed'}, ${allTexts.length} groups`);

    return {
        verified: allVerified,
        text: allTexts.join('\n\n---\n\n') // Combine for debug output
    };
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Empty every prompt block the generation interceptor owns: the chunk block, its
 * per-position variants, EventBase memory and Summarizer Injection. ST keeps an
 * extension prompt until it is overwritten, so a block that is not cleared keeps
 * reaching the model on every later generation — including turns VectFox skips.
 * The lorebook block is not included: the GENERATION_STARTED handler owns it and
 * fills it before the interceptor runs (see clearLorebookPrompt).
 *
 * @param {object} settings VECTFOX settings
 */
export function clearInterceptorPrompts(settings) {
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);
    const positionTagPrefix = `${EXTENSION_PROMPT_TAG}_pos`;
    for (const tag of Object.keys(extension_prompts)) {
        if (tag.startsWith(positionTagPrefix)) {
            setExtensionPrompt(tag, '', 0, 0, false);
        }
    }
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
    setExtensionPrompt(SUMMARIZER_PROMPT_TAG, '', settings.position, settings.depth, false);
}

/**
 * Searches for and injects relevant past messages from ALL enabled collections
 * This includes chat collections (if enabled_chats is true) AND any other
 * enabled collections like lorebooks, documents, character files, etc.
 *
 * @param {object[]} chat Current chat messages
 * @param {object} settings VECTFOX settings
 * @param {string} type Generation type
 */
export async function rearrangeChat(chat, settings, type, { dryRun = false, testMessage = null } = {}) {
    try {
        // === EARLY EXITS ===
        if (!dryRun && type === 'quiet') {
            log.trace('VectFox: Skipping quiet prompt');
            return;
        }

        // Empty the previous generation's blocks before any other exit, so a turn that
        // injects nothing (master switch off, chat too short, retrieval timed out) never
        // sends the last turn's memory instead.
        if (!dryRun) {
            clearInterceptorPrompts(settings);
        }

        // Master switch: inject nothing into live generation when disabled. The dry-run
        // query tester stays functional so users can still inspect retrieval while
        // VectFox is off.
        if (!dryRun && !isVectFoxEnabled(settings)) {
            log.trace('VectFox: master switch OFF — skipping retrieval/injection');
            return;
        }

        log.lifecycle(`🐰 VectFox: rearrangeChat called (type: ${type}, chat length: ${chat?.length || 0}${dryRun ? ', dryRun=true' : ''})`);

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            log.trace('VectFox: No chat selected');
            return dryRun ? { injectionText: null, chunkCount: 0 } : undefined;
        }

        const minChatLength = settings.min_chat_length ?? 0;
        if (!dryRun && minChatLength > 0 && chat.length < minChatLength) {
            log.warn(`⚠️ VectFox: Not enough messages to inject chunks (${chat.length} < ${minChatLength})`);
            log.lifecycle(`   💡 You need at least ${minChatLength} messages before chunk injection starts`);
            return;
        }

        // EventBase workflow: Phase A — skipped in dryRun (EventBase has its own dry-run path).
        if (!dryRun) {
            const queryText = buildSearchQuery(chat, settings);
            if (queryText) {
                const { runEventBaseRetrieval } = await import('../eventbase/index.js');
                // On timeout the message proceeds WITHOUT EventBase injection and
                // the user is told why — see src/features/vector-backend/bounded-retrieval.js for the
                // timeout/degrade/surface contract shared by every retrieval path.
                //
                // This is the ONE path that can route through Agent Mode, whose
                // planner call and query fanout run INSIDE this bound with their
                // own user-set timeouts. Passing the Agent Mode-inclusive budget
                // is what keeps the outer bound from silently overruling them.
                await runBoundedRetrieval(
                    runEventBaseRetrieval({
                        chat,
                        searchText: queryText,
                        settings,
                        chatUUID: getChatUUID(),
                    }),
                    {
                        contextLabel: 'EventBase',
                        sourceName: 'event memory',
                        timeoutMessage: 'EventBase retrieval timed out',
                        settings,
                        timeoutMs: resolveEventBaseRetrievalTimeoutMs(settings),
                    },
                );
            }

            // Feature B — Summarizer Injection: inject the most recent N EventBase
            // events every turn, independent of semantic retrieval above. Self-clears
            // when disabled (so a toggle-off mid-session doesn't leave a stale block).
            // Non-fatal + time-bounded so a slow listChunks can't freeze the turn.
            {
                const { runSummarizerInjection } = await import('../eventbase/index.js');
                await runBoundedRetrieval(runSummarizerInjection(settings), {
                    contextLabel: 'Summarizer',
                    sourceName: 'recent event summaries',
                    timeoutMessage: 'Summarizer injection timed out',
                    settings,
                });
            }

            // Ghosting: blank the OLDEST already-vectorized messages from THIS prompt
            // only (non-destructive clone; resets next gen). Self-gates to ghost +
            // summarizer enabled. Runs AFTER retrieval/injection and buildSearchQuery,
            // and the wiped span (old history, below the tip) sits below the ChunkBase
            // condition dedup tail — so query + conditions are unaffected.
            try {
                const { applyGhosting } = await import('../eventbase/index.js');
                applyGhosting(chat, settings);
            } catch (error) {
                log.error('VectFox Ghost: prompt wipe error (non-fatal):', error);
            }
        } // end if (!dryRun) EventBase block

        // === STAGE 1: Gather collections to query ===
        const collectionsToQuery = gatherCollectionsToQuery(settings);
        const hasCollections = collectionsToQuery.length > 0;
        const canQueryWI = settings.enabled_world_info;

        if (!hasCollections && !canQueryWI) {
            log.trace('[VECTFOX ChunkBase] No enabled ChunkBase collections and World Info disabled — skipping non-chat chunk injection (this is normal if you only use EventBase).');
            return dryRun ? { injectionText: null, chunkCount: 0, noCollections: true } : undefined;
        }
        if (hasCollections) {
            log.verbose(`VectFox: Will query ${collectionsToQuery.length} collections:`, collectionsToQuery);
        } else {
            log.verbose('VectFox: No ChunkBase collections enabled (lorebooks are handled by the Lorebook WI pipeline)');
        }

        // === STAGE 2: Build search query ===
        const queryText = testMessage || buildSearchQuery(chat, settings);
        if (queryText.length === 0) {
            log.trace('VectFox: No text to query');
            return dryRun ? { injectionText: null, chunkCount: 0 } : undefined;
        }

        // === STAGE 2.5: Extract keywords from query message ===
        const extractionLevel = settings.keyword_extraction_level || 'balanced';
        const queryKeywords = extractChatKeywords(queryText, {
            level: extractionLevel,
            baseWeight: settings.keyword_boost_base_weight || 1.5
        });
        const queryKeywordTexts = queryKeywords.map(kw => kw.text.toLowerCase());
        log.trace(`VectFox: Extracted ${queryKeywords.length} keywords from query:`, queryKeywordTexts);

        // === STAGE 3: Filter by activation conditions ===
        let activeCollections = [];
        if (hasCollections) {
            const searchContext = buildSearchContext(chat, settings.query || 10, {
                generationType: type || 'normal',
                isGroupChat: getContext().groupId != null,
                currentCharacter: getContext().name2 || null,
                activeLorebookEntries: [],
                currentChatId: getCurrentChatId(),
                currentCharacterId: getContext().characterId || null
            });
            activeCollections = await filterActiveCollections(collectionsToQuery, searchContext);
        }

        // Skip collections that have 0 chunks on disk — they're shown in DB Browser
        // so the user can delete them, but there's nothing to query.
        const preEmptyFilter = activeCollections.length;
        activeCollections = activeCollections.filter(key => !isCollectionEmpty(key));
        if (activeCollections.length < preEmptyFilter) {
            log.verbose(`VectFox: Skipped ${preEmptyFilter - activeCollections.length} empty collection(s) from retrieval`);
        }

        // Allow WI-only mode even if no regular collections pass filters.
        // Note: ChunkBase (lorebook/docs/URLs/wiki) is entirely optional —
        // users who rely only on EventBase for chat memory will always have
        // zero active ChunkBase collections, which is the intended setup,
        // not an error. The earlier alarming "⚠️ chunks cannot be injected!"
        // log was removed because it implied lorebook setup was required.
        // EventBase injection happens on its own path (eventbase-workflow.js)
        // and is unaffected by this branch.
        if (activeCollections.length === 0 && !canQueryWI) {
            log.trace('[VECTFOX ChunkBase] No active Standard/ChunkBase collections and World Info disabled — skipping non-chat chunk injection (this is normal if you only use EventBase).');
            return dryRun ? { injectionText: null, chunkCount: 0, noActive: true } : undefined;
        }
        if (activeCollections.length > 0) {
            log.verbose(`✅ VectFox: ${activeCollections.length} collections passed activation filters:`, activeCollections);
        }

        // === STAGE 4: Query all collections and merge results ===
        // Popup gating:
        //   - retrieval_popup_on_start / retrieval_popup_on_result: ChunkBase chunks
        //   - world_info_retrieval_popup: lorebook/WI entries (handled in
        //     world-info-integration.js, untouched here)
        // We suppress the ChunkBase popups when activeCollections is empty (WI-only mode)
        // — the "0 results" message would just be misleading noise.
        if (activeCollections.length > 0 && settings.retrieval_popup_on_start) {
            toastr.info(`Retrieving context from ${activeCollections.length} collection(s)...`, 'VectFox Retrieval');
        }

        // Same contract as EventBase above (src/features/vector-backend/bounded-retrieval.js): on failure
        // we proceed with no chunks this turn and say so.
        let chunks = await runBoundedRetrieval(
            queryAndMergeCollections(activeCollections, queryText, settings, chat),
            {
                contextLabel: 'Chat memory',
                sourceName: 'vectorized chunks',
                timeoutMessage: 'Chunk retrieval timed out',
                fallback: [],   // downstream treats an empty list as "no injection"
                settings,
            },
        );

        if (activeCollections.length > 0 && settings.retrieval_popup_on_result) {
            toastr.success(`Retrieved ${chunks.length} result(s) from backend`, 'VectFox Retrieval');
        }

        // === STAGE 4.3: Boost chunks with matching query keywords ===
        if (queryKeywordTexts.length > 0 && chunks.length > 0) {
            let keywordMatchCount = 0;

            for (const chunk of chunks) {
                // Get chunk keywords — prefer vectra/qdrant metadata (plugin path),
                // fall back to extension_settings (saved during insert for no-plugin users).
                const rawKeywords = chunk.metadata?.keywords?.length > 0
                    ? chunk.metadata.keywords
                    : (getChunkMetadata(String(chunk.hash))?.keywords || []);
                const chunkKeywords = rawKeywords
                    .map(kw => (typeof kw === 'object' ? kw.text : kw)?.toLowerCase())
                    .filter(Boolean);

                // Check if chunk has any matching keywords
                const matchedKeywords = queryKeywordTexts.filter(qk => chunkKeywords.includes(qk));

                if (matchedKeywords.length > 0) {
                    // Chunk matches query keywords - boost to perfect hit
                    const oldScore = chunk.score;
                    chunk.keywordMatched = true;
                    chunk.matchedQueryKeywords = matchedKeywords;
                    chunk.score = 1.0; // 100% perfect match
                    chunk.originalScore = oldScore;
                    keywordMatchCount++;
                }
            }

            if (keywordMatchCount > 0) {
                log.verbose(`VectFox: Boosted ${keywordMatchCount}/${chunks.length} chunks with matching keywords to 100% score`);
            } else {
                log.verbose(`VectFox: No chunks matched query keywords, all ${chunks.length} chunks keep original scores`);
            }
        }

        log.verbose(`VectFox: Retrieved ${chunks.length} total chunks from ${activeCollections.length} collections`);

        // === STAGE 4.5: Expand summary chunks to parent chunks (dual-vector) ===
        const chunksBeforeExpansion = chunks.length;
        chunks = await expandSummaryChunks(chunks, activeCollections, settings);
        if (chunks.length !== chunksBeforeExpansion || chunks.some(c => c.expandedFromSummary)) {
            const expandedCount = chunks.filter(c => c.expandedFromSummary).length;
            log.verbose(`VectFox: Expanded ${expandedCount} summary chunks to parent text`);
        }

        // === STAGE 6: Threshold filter ===
        const threshold = settings.score_threshold || 0;
        chunks = applyThresholdFilter(chunks, threshold);

        // === STAGE 8.5: Chunk Groups and Links ===
        chunks = await applyGroupsAndLinksStage(chunks, activeCollections, settings);

        // Read by the e2e spec's mid-pipeline diagnostics (tests/Eventbase-test.spec.js)
        window.VectFox_LastSearch = {
            chunks: chunks,
            query: queryText,
            timestamp: Date.now(),
            settings: { threshold: settings.score_threshold, topK: (settings.top_k ?? settings.insert) }
        };
        log.verbose(`VectFox: Stored ${chunks.length} chunks in window.VectFox_LastSearch`);

        // === STAGE 9: Deduplicate ===
        log.verbose(`[VECTFOX Deduplication] Starting with ${chunks.length} chunks before deduplication`);
        log.verbose(`[VECTFOX Deduplication] Current chat has ${chat.length} messages`);

        const { toInject: chunksToInject, skipped: skippedDuplicates } = deduplicateChunks(chunks, chat, settings);

        log.verbose(`[VECTFOX Deduplication] After deduplication: ${chunksToInject.length} to inject, ${skippedDuplicates.length} skipped`);
        if (skippedDuplicates.length > 0) {
            log.verbose(`[VECTFOX Deduplication] Skipped chunks (already in chat):`);
            skippedDuplicates.forEach((chunk, idx) => {
                log.trace(`  [${idx + 1}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}, Text: "${chunk.text?.substring(0, 80)}..."`);
            });
        }

        if (chunksToInject.length === 0) {
            log.lifecycle('ℹ️ VectFox: All retrieved chunks already in context, nothing to inject');
            log.verbose(`   ${skippedDuplicates.length} chunks were skipped (already in current chat)`);
            log.lifecycle('[VectFox] Injection blocked: All retrieved chunks are already present in the current chat context. Adjust temporal decay or query depth if you want older messages.');
            return dryRun ? { injectionText: null, chunkCount: 0, allDuplicates: true } : undefined;
        }

        log.verbose(`[VECTFOX Deduplication] ✅ ${chunksToInject.length} chunks will proceed to injection`);

        // === STAGE 10: Inject into prompt (or return dry-run result) ===
        if (dryRun) {
            const injectionText = buildNestedInjectionText(chunksToInject, settings);
            return { injectionText, chunkCount: chunksToInject.length };
        }

        const injection = injectChunksIntoPrompt(chunksToInject, settings);

        log.lifecycle(`\n✅ VectFox: Successfully injected ${chunksToInject.length} chunk(s) into prompt`);
        log.verbose(`   Verification: ${injection.verified ? '✓ PASSED' : '✗ FAILED'}`);
        log.verbose(`   Total characters injected: ${injection.text.length}\n`);

        log.lifecycle(`VectFox: ✅ Injected ${chunksToInject.length} chunks (${skippedDuplicates.length} skipped - already in context)`);

    } catch (error) {
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectFox');
        log.error('VectFox: Failed to rearrange chat', error);
    }
}

/**
 * Vectorizes entire chat
 * @param {object} settings VECTFOX settings
 * @param {number} batchSize Batch size
 */
export async function vectorizeAll(settings, batchSize, abortSignal = null, {
    startFromMessage = 1,
    parallelWindows = 1,
    progressPlan = null,
    skipTipFallback = false,
} = {}) {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            return;
        }

        // Pre-flight check: verify backend is available before starting
        const backendName = settings.vector_backend || 'standard';
        const backendAvailable = await isBackendAvailable(backendName, settings);
        if (!backendAvailable) {
            toastr.error(
                `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
                'Vectorization aborted'
            );
            log.error(`VectFox: Backend ${backendName} failed health check before vectorization`);
            return;
        }

        if (abortSignal?.aborted) {
            return;
        }
        if (is_send_press) {
            toastr.info('Message generation is in progress.', 'Vectorization aborted');
            throw new Error('Message generation in progress');
        }

        const context = getContext();
        if (!Array.isArray(context.chat)) return;

        const allMessages = context.chat.filter(m => m.mes && m.mes.trim().length > 0);
        const messages = startFromMessage > 1
            ? allMessages.slice(Math.min(startFromMessage - 1, allMessages.length))
            : allMessages;

        const { runEventBaseIngestion, countUnfinishedWindows } = await import('../eventbase/index.js');
        const result = await runEventBaseIngestion({
            messages,
            chatUUID: getChatUUID(),
            settings,
            abortSignal,
            isAutoSync: false,
            parallelWindows,
            progressPlan,
            skipTipFallback,
        });

        if (chatId !== getCurrentChatId()) {
            progressTracker.complete(false, 'Chat changed during vectorization');
            throw new Error('Chat changed');
        }

        if (abortSignal?.aborted) {
            progressTracker.complete(false, `Stopped — saved ${result.eventsExtracted} events from ${result.windowsProcessed} windows so far`);
            return;
        }

        // runEventBaseIngestion has already set the progress verdict, and when a
        // window timed out or failed that verdict is complete(false, …) naming the
        // reason. Leave it standing — the unconditional green tick that used to be
        // here overwrote it, so a run that extracted nothing still looked clean.
        const unfinishedWindows = countUnfinishedWindows(result);
        if (unfinishedWindows > 0) {
            toastr.warning(
                `EventBase: extracted ${result.eventsExtracted} events from ${result.windowsProcessed} windows, `
                + `but ${unfinishedWindows} window(s) produced nothing. They were not stored and will be retried next run — see the console.`,
                'VectFox',
            );
            log.warn(`VectFox: Vectorization finished with gaps — ${result.eventsExtracted} events, ${result.windowsProcessed} windows processed, ${unfinishedWindows} unfinished`);
            return;
        }

        progressTracker.complete(true, `EventBase: extracted ${result.eventsExtracted} events from ${result.windowsProcessed} windows`);
        toastr.success(`EventBase: extracted ${result.eventsExtracted} events across ${result.windowsProcessed} windows`, 'VectFox');
        log.lifecycle(`VectFox: ✅ Vectorization complete — ${result.eventsExtracted} events, ${result.windowsProcessed} windows processed, ${result.windowsSkipped} skipped`);
    } catch (error) {
        log.error('VectFox: Failed to vectorize all', error);
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed');
        const { isInvalidModelConfigError, notifyInvalidModel } = await import('../../shared/model-config-notifier.js');
        if (isInvalidModelConfigError(error)) {
            notifyInvalidModel(error.message);
        } else {
            toastr.error(`Vectorization failed: ${error.message}`, 'VectFox');
        }
    }
}

