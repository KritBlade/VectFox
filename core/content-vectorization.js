/**
 * ============================================================================
 * VectFox CONTENT VECTORIZATION
 * ============================================================================
 * Unified vectorization handler for all content types.
 * Uses the same pipeline infrastructure, just with type-appropriate settings.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { getContentType, getContentTypeDefaults, hasFeature } from './content-types.js';
import { chunkText } from './chunking.js';
import { insertVectorItems, purgeVectorIndex, getSavedHashes } from './core-vector-api.js';
import { isConnectionError } from './model-config-notifier.js';
import { setCollectionMeta, setCollectionLock, setCollectionCharacterLock, saveChunkMetadata } from './collection-metadata.js';
import { registerCollection } from './collection-loader.js';
import { getBackend } from '../backends/backend-manager.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    buildLorebookCollectionId,
    buildCharacterCollectionId,
    buildDocumentCollectionId,
    COLLECTION_PREFIXES,
    buildRegistryKey,
    getBackendFromCollectionId,
    sanitizeNameSegment,
} from './collection-ids.js';
import { extractLorebookKeywords, extractTextKeywords, extractChatKeywords, extractBM25Keywords, EXTRACTION_LEVELS, DEFAULT_EXTRACTION_LEVEL, DEFAULT_BASE_WEIGHT } from './keyword-boost.js';
import { cleanText, cleanContentOrNull } from './text-cleaning.js';
import { prepareLorebookContent } from './lorebook-content-preparer.js';
import { extractGlossary, injectGlossary } from './glossary-extractor.js';
import { getReformatCache } from './reformat-store.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getCurrentChatId } from '../../../../../script.js';
import { getStringHash } from '../../../../utils.js';
import { log } from './log.js';

/**
 * Merge per-call settings on top of the user's global VectFox settings.
 * Single source of truth for "effective settings": callers pass only the keys
 * they want to override (vector_backend, source, model, content-type defaults),
 * and globals supply the rest (qdrant_url, custom_stopwords, summarize_*, etc.).
 *
 * Without this merge, code paths that read globals directly would silently
 * ignore per-call overrides — leading to mismatches like "registry key says
 * qdrant but data lives in vectra".
 *
 * @param {object} [callerSettings] - per-call overrides (may be undefined)
 * @returns {object} merged settings — globals first, overrides win
 */
export function resolveEffectiveSettings(callerSettings) {
    return { ...(extension_settings.vectfox || {}), ...(callerSettings || {}) };
}

/**
 * Main entry point for content vectorization
 * @param {object} params - Vectorization parameters
 * @param {string} params.contentType - Content type ID
 * @param {object} params.source - Source data
 * @param {object} params.settings - Type-specific settings
 * @param {AbortSignal} [params.abortSignal] - Optional abort signal to stop vectorization
 * @returns {Promise<{success: boolean, chunkCount: number, collectionId: string}>}
 */
export async function vectorizeContent({ contentType, source, settings, abortSignal = null, continueMode = false, startFromMessage = 1 }) {
    // EventBase workflow only handles chat messages; non-chat content vectorization
    // continues with the legacy path regardless of eventbase_enabled.
    // (Future phases may add EventBase handling for lorebooks/characters here.)

    const throwIfAborted = () => {
        if (abortSignal?.aborted) {
            const err = new Error('Vectorization stopped by user');
            err.name = 'AbortError';
            throw err;
        }
    };

    const type = getContentType(contentType);
    if (!type) {
        throw new Error(`Unknown content type: ${contentType}`);
    }

    const sourceName = source.name || source.filename || source.id || contentType;
    progressTracker.show(`Vectorizing ${type.label || contentType}`, 4, 'Steps');
    progressTracker.updateCurrentItem(sourceName);

    try {
        throwIfAborted();

        // Step 1: Resolve source
        progressTracker.updateProgress(1, 'Loading content...');
        const rawContent = await resolveSource(contentType, source);
        throwIfAborted();

        // Step 2: Prepare and chunk
        progressTracker.updateProgress(2, 'Chunking content...');
        const preparedContent = await prepareContent(contentType, rawContent, settings, startFromMessage);
        throwIfAborted();

        // Auto-Reformat: if the user already reviewed and accepted an LLM
        // reformat pass for this exact source (settings.reformat is a plain
        // pointer {accepted, sourceHash} threaded through resolveEffectiveSettings,
        // never persisted to saved global settings), reuse the frozen chunks and
        // skip chunkText() + the LLM entirely — the accepted result IS the final
        // chunk set. See core/reformat-store.js for the freeze mechanism and
        // ui/reformat-review.js for how chunks get into the cache in the first
        // place (already {text, metadata} shaped, ready for enrichChunks() below).
        const REFORMAT_SUPPORTED_TYPES = ['document', 'url', 'wiki'];
        let chunks;
        if (REFORMAT_SUPPORTED_TYPES.includes(contentType) && settings.reformat?.accepted && settings.reformat?.sourceHash) {
            // Guard against a stale pointer: settings.reformat.sourceHash was computed
            // against whatever source was loaded WHEN the user accepted the reformat.
            // If they've since changed the pasted text / fetched a different URL /
            // rescraped the wiki without re-running (or discarding) Auto-Reformat,
            // currentSettings.reformat would still be sitting there pointing at the
            // OLD content — applying it here would silently vectorize the wrong
            // chunks under the new source's name. Re-hash the CURRENT prepared text
            // (normalized the same way the reformat flow hashed it — see
            // ui/content-vectorizer.js's _resolveReformatSourceText) and only trust
            // the cache if it still matches.
            const normalizedText = typeof preparedContent.text === 'string'
                ? preparedContent.text
                : Array.isArray(preparedContent.text)
                    ? preparedContent.text.map(t => (typeof t === 'string' ? t : t.text || '')).join('\n\n---\n\n')
                    : String(preparedContent.text ?? preparedContent ?? '');
            const currentHash = getStringHash(normalizedText);

            if (currentHash !== settings.reformat.sourceHash) {
                log.warn(`VectFox: Auto-Reformat was accepted for different content than what's loaded now (hash mismatch) — falling back to mechanical chunking. Re-run Auto-Reformat if you want it applied to the current content.`);
            } else {
                const frozen = getReformatCache(settings.reformat.sourceHash);
                if (frozen?.chunks?.length) {
                    chunks = frozen.chunks;
                    log.lifecycle(`VectFox: Using frozen Auto-Reformat chunks for "${sourceName}" (${chunks.length} chunks) — LLM not re-invoked`);
                } else {
                    log.warn(`VectFox: Auto-Reformat marked accepted but no frozen cache found for hash ${settings.reformat.sourceHash} — falling back to mechanical chunking`);
                }
            }
        }
        if (!chunks) {
            chunks = await chunkText(preparedContent.text || preparedContent, {
                strategy: settings.strategy || type.defaultStrategy,
                chunkSize: settings.chunkSize || type.defaults.chunkSize,
                chunkOverlap: settings.chunkOverlap || type.defaults.chunkOverlap,
                batchSize: settings.batchSize || 4,
            });
        }
        throwIfAborted();

        if (chunks.length === 0) {
            throw new Error('No chunks generated from content');
        }

        // Ground bare acronym references: a document typically spells out a named
        // entity once ("Federal Hero Oversight Bureau (FHOB)") and refers to it by
        // acronym everywhere else. If the chunk containing the definition never gets
        // retrieved alongside a chunk that only uses the bare acronym, the model has
        // no grounding for what it means. Prepend the definition to any chunk that
        // references an acronym without it. See core/glossary-extractor.js.
        if (contentType === 'document' && settings.document_glossary_injection !== false) {
            const glossary = extractGlossary(preparedContent.text || '');
            if (glossary.length > 0) {
                chunks = injectGlossary(chunks, glossary);
                log.verbose(`VectFox: Glossary injection found ${glossary.length} acronym(s): ${glossary.map(g => g.acronym).join(', ')}`);
            }
        }

        // Log chunking results for debugging
        const chunkLengths = chunks.map(c => (typeof c === 'string' ? c : c.text || '').length);
        const maxChunkLen = Math.max(...chunkLengths);
        const avgChunkLen = Math.round(chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length);
        log.lifecycle(`VectFox: Chunked "${sourceName}" into ${chunks.length} chunks (avg: ${avgChunkLen} chars, max: ${maxChunkLen} chars)`);

        progressTracker.updateChunks(chunks.length);

        // Step 3: Enrich and hash
        progressTracker.updateProgress(3, 'Processing chunks...');
        const collectionId = generateCollectionId(contentType, source, settings);
        // Storage key for all metadata writes — must match the registry-key form
        // ("backend:id") used by import, loader, and cleanupOrphanedMeta.
        const registryKey = buildRegistryKey(collectionId, settings);

        // Set the appropriate lock based on scope. Registered before embedding starts so the
        // index entry exists even if vectorization is interrupted partway through.
        const scope = settings.scope || 'character';
        if (scope === 'chat') {
            const currentChatId = getCurrentChatId();
            if (currentChatId) setCollectionLock(registryKey, currentChatId);
        } else if (scope === 'character') {
            const currentCharacterId = getContext()?.characterId;
            if (currentCharacterId) setCollectionCharacterLock(registryKey, String(currentCharacterId));
        }

        // Get full extension settings for keyword extraction (includes custom_stopwords)
        const VectFoxSettings = extension_settings.vectfox;

        // Per-call overrides merged on top of globals (see resolveEffectiveSettings).
        const effectiveSettings = resolveEffectiveSettings(settings);
        
        const enrichedChunks = enrichChunks(chunks, contentType, source, settings, preparedContent, VectFoxSettings);
        const hashedChunks = enrichedChunks.map(chunk => ({
            ...chunk,
            hash: getStringHash(chunk.text),
        }));

        // Continue mode: skip chunks already present in the collection
        let finalChunks;
        if (continueMode) {
            try {
                progressTracker.updateProgress(3, 'Checking existing chunks...');
                const savedHashes = await getSavedHashes(collectionId, effectiveSettings);
                const savedSet = new Set(savedHashes);
                const before = hashedChunks.length;
                finalChunks = hashedChunks.filter(c => !savedSet.has(c.hash));
                const skipped = before - finalChunks.length;
                log.lifecycle(`VectFox: Continue mode — ${skipped} chunks already in DB, ${finalChunks.length} remaining`);
                progressTracker.updateChunks(finalChunks.length);
                if (finalChunks.length === 0) {
                    progressTracker.complete(true, 'Already up to date — no new chunks to insert');
                    return { success: true, chunkCount: 0, collectionId };
                }
                toastr.info(`Continuing: ${skipped} chunks skipped, ${finalChunks.length} to insert`, 'VectFox');
            } catch (e) {
                log.warn('VectFox: Could not fetch saved hashes for dedup, inserting all:', e.message);
                finalChunks = hashedChunks;
            }
        } else {
            finalChunks = hashedChunks;
        }

        // Non-chat content (lorebook, character card, document, URL, wiki, YouTube) goes
        // straight into the vector store without LLM summarization — those sources are
        // typically short enough that the embedding model can index them directly.
        // Chat content never reaches this function (EventBase intercepts it upstream).
        //
        // The summarize-before-store pipeline below is intentionally preserved (commented out)
        // in case we want to re-enable per-chunk LLM summarization later (e.g. summarize a
        // lorebook/document chunk BEFORE vectorizing it).
        //
        // REVIVAL NOTE — when re-enabling this block, do NOT reuse its summarizer-specific
        // error handling (`isSummarizationFatalError` / `SummarizationFatalError` and
        // `summarizeText`'s bespoke throws). Route errors through the SHARED helpers in
        // core/model-config-notifier.js that the rest of the codebase already uses:
        //   - `isInvalidModelConfigError` / `notifyInvalidModel`  → config/auth/model failures
        //   - `isConnectionError` / `notifyConnectionError`       → wrong / unreachable URLs
        // (the same pattern as EventBase extraction, agent mode, and embedding). Once this is
        // revived on the shared helpers, DELETE `summarizeText` + `isSummarizationFatalError` +
        // `SummarizationFatalError` from summarizer.js for good — we don't keep one-off error
        // types for a single feature.
        /* ----- BEGIN: summarize-before-store pipeline (DISABLED, kept for future use) -----
        if (contentType === 'chat') {
            progressTracker.updateProgress(3, `Summarizing and inserting ${finalChunks.length} chunks...`);
            log.lifecycle(`[VectFox Summarizer] Pipelining ${finalChunks.length} chat chunks via ${VectFoxSettings.chat_provider}...`);

            // Pre-init backend once before pipeline starts
            try {
                await getBackend(VectFoxSettings);
            } catch (e) {
                log.warn('VectFox: Backend init failed before pipeline insert, will still attempt:', e.message);
            }

            let pipelined = 0;
            const keywordLevel = VectFoxSettings?.keywordLevel || 'balanced';

            {
                for (const chunk of finalChunks) {
                    throwIfAborted();

                    let summaryText;
                    try {
                        summaryText = await summarizeText(chunk.text, VectFoxSettings);
                    } catch (err) {
                        if (isSummarizationFatalError(err)) {
                            const providerLabel = (VectFoxSettings?.chat_provider || 'summarizer').toUpperCase();
                            const msg = `Summarization is enabled but misconfigured: ${err.message}`;
                            try { toastr.error(msg, `${providerLabel} configuration error`); } catch (_) {}
                            throw new Error(msg);
                        }
                        throw err;
                    }
                    const summaryKeywords = keywordLevel !== 'off'
                        ? extractBM25Keywords(summaryText, {
                            level: keywordLevel,
                            baseWeight: VectFoxSettings?.keywordBaseWeight || 1.5,
                            settings: VectFoxSettings,
                        })
                        : [];
                    const summarizedChunk = { ...chunk, text: summaryText, keywords: summaryKeywords };

                    try {
                        throwIfAborted();
                        await insertVectorItems(collectionId, [summarizedChunk], VectFoxSettings, null, abortSignal);
                    } catch (insertErr) {
                        if (insertErr?.name === 'AbortError') throw insertErr;
                        log.error('VectFox: Pipeline insert failed for chunk, skipping:', insertErr.message);
                        progressTracker.addError(`Chunk ${pipelined + 1}: ${insertErr.message}`);
                    }

                    pipelined++;
                    progressTracker.updateProgress(3, `Summarizing + inserting... ${pipelined}/${finalChunks.length}`);
                    progressTracker.updateEmbeddingProgress(pipelined, finalChunks.length);
                }
            }

            log.lifecycle(`[VectFox Summarizer] Pipeline complete: ${pipelined} chunks processed`);

        }
        ----- END: summarize-before-store pipeline ----- */

        {
            // Direct insert path — embed and store chunks as-is.
            progressTracker.updateProgress(4, 'Processing chunks...');

            try {
                await getBackend(effectiveSettings);
            } catch (e) {
                log.warn('VectFox: Backend initialization failed before insert, will still attempt insert:', e.message);
                try { progressTracker.addError(`Backend init failed: ${e.message}`); } catch (_) {}
                try { toastr.error('Backend initialization failed: ' + e.message, 'VectFox'); } catch (_) {}
            }

            try {
                await insertVectorItems(collectionId, finalChunks, effectiveSettings, (embedded, total) => {
                    throwIfAborted();
                    log.verbose(`[Content Vectorization] Processing progress callback: ${embedded}/${total}`);
                    progressTracker.updateEmbeddingProgress(embedded, total);
                    progressTracker.updateCurrentItem(`Processing: ${embedded}/${total} chunks (${total - embedded} remaining)`);
                }, abortSignal);
            } catch (error) {
                log.error('VectFox: insertVectorItems failed', error);
                try { progressTracker.addError(error.message || String(error)); } catch (_) {}
                // Distinguish an embedder-call failure from a storage-write failure
                // (#4): they were both reported as "Failed to write embeddings",
                // which misleads when the real problem is the embedding provider
                // URL/model. A connection failure already raised its own red toast
                // via notifyConnectionError, so skip a second one here.
                const isEmbedFail = error?.code === 'embedding_generation_failed'
                    || /generate embeddings|no embeddings returned/i.test(error?.message || '');
                if (!isConnectionError(error?.message)) {
                    const headline = isEmbedFail
                        ? 'Failed to generate embeddings (check your embedding provider URL and model): '
                        : 'Failed to write embeddings to storage: ';
                    try { toastr.error(headline + (error.message || String(error)), 'VectFox'); } catch (_) {}
                }
                throw error;
            }

            // Persist chunk keywords to extension_settings so no-plugin users get
            // keyword boosting. Native ST /api/vector/insert only stores
            // {hash, text, index} — keywords live nowhere else without the plugin.
            // saveSettingsDebounced batches all writes into one disk flush.
            for (const chunk of finalChunks) {
                if (chunk.keywords?.length > 0) {
                    saveChunkMetadata(String(chunk.hash), { keywords: chunk.keywords });
                }
            }
        }

        // Save collection metadata
        setCollectionMeta(registryKey, {
            contentType,
            sourceName,
            scope: settings.scope || 'character',
            chunkCount: finalChunks.length,
            createdAt: new Date().toISOString(),
            // Do NOT set alwaysActive here — we use a character lock instead
            // so this collection only activates when the same character is active.
            settings: {
                strategy: settings.strategy,
                chunkSize: settings.chunkSize,
            },
        });

        // Register collection in the registry so it's discoverable
        registerCollection(registryKey);
        log.lifecycle(`VectFox: Registered collection ${registryKey}`);


        throwIfAborted();
        progressTracker.complete(true, `Vectorized ${finalChunks.length} chunks`);

        return {
            success: true,
            chunkCount: finalChunks.length,
            collectionId,
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            progressTracker.complete(false, 'Stopped by user');
            throw error;
        }

        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed');
        throw error;
    }
}

/**
 * Resolves and prepares content for preview or chunking
 * Exported for use by the preview functionality
 * @param {string} contentType - Content type ID
 * @param {object} source - Source data from getSourceData()
 * @param {object} settings - Type-specific settings
 * @returns {Promise<{text: string, ...}>} Prepared content with text property
 */
export async function resolveAndPrepareContent(contentType, source, settings) {
    const rawContent = await resolveSource(contentType, source);
    const prepared = await prepareContent(contentType, rawContent, settings);

    // Return as-is - text may be string or array depending on strategy
    return prepared;
}

/**
 * Resolves source data to actual content
 */
async function resolveSource(contentType, source) {
    switch (source.type) {
        case 'paste':
            return { content: source.content, name: source.name };

        case 'file':
            // File uploads may already be parsed by the UI
            // For lorebooks: source.entries contains parsed entries
            // For characters: source.character contains parsed character data
            // For chats: source.messages contains parsed messages
            if (contentType === 'lorebook' && source.entries) {
                return {
                    content: source.entries,
                    name: source.name || source.filename,
                    entries: source.entries,
                };
            }
            if (contentType === 'character' && source.character) {
                return {
                    content: source.character,
                    name: source.name || source.character.name || source.filename,
                    character: source.character,
                };
            }
            if (contentType === 'chat' && source.messages) {
                return {
                    content: source.messages,
                    name: source.name || source.characterName || source.filename,
                    messages: source.messages,
                    metadata: source.metadata,
                };
            }
            // Generic file (plain text)
            return { content: source.content, name: source.filename || source.name };

        case 'url':
            return { content: source.content, name: source.title || source.url, url: source.url };

        case 'wiki':
            // Wiki content already scraped by UI
            return {
                content: source.content,
                name: source.name || 'Wiki',
                wikiType: source.wikiType,
                pages: source.pages,
                pageCount: source.pageCount,
            };

        case 'youtube':
            // YouTube transcript already fetched by UI
            return {
                content: source.content,
                name: source.name || `YouTube-${source.videoId}`,
                videoId: source.videoId,
                url: source.url,
            };

        case 'select':
            return await loadSelectedSource(contentType, source.id);

        case 'current':
            // For chat type - content is passed directly
            return { content: source.content, name: source.name, messages: source.content };

        default:
            if (source.content) {
                return { content: source.content, name: source.name || 'Unknown' };
            }
            throw new Error(`Unknown source type: ${source.type}`);
    }
}

/**
 * Loads content from a selected source (lorebook, character, etc.)
 */
async function loadSelectedSource(contentType, sourceId) {
    const context = getContext();

    switch (contentType) {
        case 'lorebook':
            return await loadLorebookContent(sourceId, context);

        case 'character':
            return await loadCharacterContent(sourceId, context);

        default:
            throw new Error(`Cannot load selected source for type: ${contentType}`);
    }
}

/**
 * Loads lorebook/world info content by name
 */
async function loadLorebookContent(lorebookName, context) {
    try {
        // Import ST's world-info module to load the lorebook
        const worldInfoModule = await import('../../../../world-info.js');
        const loadWorldInfo = worldInfoModule.loadWorldInfo;

        if (!loadWorldInfo) {
            throw new Error('World Info loader not available');
        }

        // Load the lorebook data
        const data = await loadWorldInfo(lorebookName);

        if (!data || !data.entries) {
            throw new Error(`Lorebook "${lorebookName}" has no entries`);
        }

        const entries = Object.values(data.entries).filter(e => e.content);

        log.lifecycle(`VectFox: Loaded lorebook "${lorebookName}" with ${entries.length} entries`);

        return {
            content: entries,
            name: lorebookName,
            entries: entries,
        };

    } catch (e) {
        log.error('VectFox: Failed to load lorebook:', e);
        throw new Error(`Failed to load lorebook "${lorebookName}": ${e.message}`);
    }
}

/**
 * Loads character card content
 */
async function loadCharacterContent(characterId, context) {
    const characters = context?.characters || [];
    const character = characters.find(c => c.avatar === characterId);

    if (!character) {
        throw new Error(`Character not found: ${characterId}`);
    }

    return {
        content: character,
        name: character.name,
        character: character,
    };
}

/**
 * Prepares content for chunking based on content type
 */
async function prepareContent(contentType, rawContent, settings, startFromMessage = 1) {
    switch (contentType) {
        case 'lorebook':
            return prepareLorebookContent(rawContent, settings);

        case 'character':
            return prepareCharacterContent(rawContent, settings);

        // 'chat' case removed 2026-05-24 — chat history is exclusively
        // processed by EventBase (LLM event extraction), not chunked.
        // The production gates in ui/content-vectorizer.js intercept chat
        // before any code path can reach this dispatcher with that type.
        // The defensive tripwire in generateCollectionId() below still
        // throws if someone bypasses both gates manually.

        case 'url':
            return prepareUrlContent(rawContent, settings);

        case 'document':
            return prepareDocumentContent(rawContent, settings);

        case 'wiki':
            return prepareWikiContent(rawContent, settings);

        case 'youtube':
            return prepareYouTubeContent(rawContent, settings);

        default:
            return rawContent.content || rawContent;
    }
}

// prepareLorebookContent imported from ./lorebook-content-preparer.js

/**
 * Prepares character content
 */
function prepareCharacterContent(rawContent, settings) {
    const character = rawContent.character || rawContent.content;
    const selectedFields = settings.fields || getContentTypeDefaults('character').fields;

    const FIELD_MAP = {
        description: { key: 'description', label: 'Description' },
        personality: { key: 'personality', label: 'Personality' },
        scenario: { key: 'scenario', label: 'Scenario' },
        first_mes: { key: 'first_mes', label: 'First Message' },
        mes_example: { key: 'mes_example', label: 'Example Messages' },
        system_prompt: { key: 'system_prompt', label: 'System Prompt' },
        post_history_instructions: { key: 'post_history_instructions', label: 'Post-History Instructions' },
        creator_notes: { key: 'creator_notes', label: 'Creator Notes' },
    };

    // For per_field strategy
    // Use cleanContentOrNull so a field whose entire content gets stripped
    // by user regex is dropped from `fields` rather than appearing under
    // its label with an empty value. Same bug class as the lorebook
    // empty-after-clean leak.
    if (settings.strategy === 'per_field') {
        const fields = {};
        for (const [fieldId, enabled] of Object.entries(selectedFields)) {
            if (enabled && FIELD_MAP[fieldId] && character[FIELD_MAP[fieldId].key]) {
                const cleaned = cleanContentOrNull(character[FIELD_MAP[fieldId].key]);
                if (cleaned !== null) {
                    fields[FIELD_MAP[fieldId].label] = cleaned;
                }
            }
        }
        return { text: fields, type: 'fields', character: character };
    }

    // Otherwise, concatenate selected fields
    // cleanContentOrNull also covers the combined case — without it a
    // fully-stripped field still produces `## Label\n` as its rendered
    // section, surviving the `.filter(Boolean)` below.
    const combined = Object.entries(selectedFields)
        .filter(([, enabled]) => enabled)
        .map(([fieldId]) => {
            const field = FIELD_MAP[fieldId];
            if (!field || !character[field.key]) return null;
            const cleaned = cleanContentOrNull(character[field.key]);
            return cleaned !== null ? `## ${field.label}\n${cleaned}` : null;
        })
        .filter(Boolean)
        .join('\n\n');

    return { text: combined, type: 'combined', character: character };
}

// prepareChatContent removed 2026-05-24 — chat history is exclusively
// processed by EventBase (see eventbase-workflow.js::runEventBaseIngestion).
// All previous chunking strategies (per_message / conversation_turns /
// message_batch / adaptive) are unreachable from production code paths.
// The dispatcher case above is gone; the defensive tripwire in
// generateCollectionId() further down still throws if anyone bypasses
// both gates by modifying source manually.

/**
 * Prepares URL/webpage content
 */
function prepareUrlContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Basic text cleaning for web content
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first; bail with empty text if
        // nothing survives (caller can short-circuit instead of inserting
        // a 0-byte chunk). See cleanContentOrNull docstring.
        const cleaned = cleanContentOrNull(text);
        if (cleaned === null) {
            return { text: '', type: 'url', name: rawContent.name, url: rawContent.url };
        }
        text = cleaned;
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Remove common web artifacts
        text = text.replace(/\[edit\]/gi, '');
        text = text.replace(/\[\d+\]/g, ''); // Remove reference numbers like [1], [2]
        // Trim
        text = text.trim();
    }

    return { text, type: 'url', name: rawContent.name, url: rawContent.url };
}

/**
 * Prepares document content
 */
function prepareDocumentContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Basic text cleaning
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first; bail with empty text if
        // nothing survives. See cleanContentOrNull docstring.
        const cleaned = cleanContentOrNull(text);
        if (cleaned === null) {
            return { text: '', type: 'document', name: rawContent.name };
        }
        text = cleaned;
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    return { text, type: 'document', name: rawContent.name };
}

/**
 * Prepares wiki content
 */
function prepareWikiContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Wiki content is already formatted with headers from scraper
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first; bail with empty text if
        // nothing survives. See cleanContentOrNull docstring.
        const cleaned = cleanContentOrNull(text);
        if (cleaned === null) {
            text = '';
        } else {
            text = cleaned;
            // Remove excessive whitespace
            text = text.replace(/\n{3,}/g, '\n\n');
            // Trim
            text = text.trim();
        }
    }

    // For per_page strategy, split back into individual pages
    // Per-page: clean ONLY the page content (not the `# Title` header).
    // Two behaviors in one update:
    //   1. Drop pages whose content goes empty after cleaning — same
    //      bug class as the lorebook empty-header leak.
    //   2. Title is preserved verbatim — it's metadata, not content
    //      the user's regex should touch. Previously the title was
    //      inside the cleanText call alongside the content.
    if (settings.strategy === 'per_page' && rawContent.pages) {
        return {
            text: rawContent.pages
                .map(p => {
                    const cleaned = cleanContentOrNull(p.content);
                    if (cleaned === null) return null;
                    return {
                        text: `# ${p.title}\n\n${cleaned}`,
                        metadata: {
                            pageTitle: p.title,
                        },
                    };
                })
                .filter(Boolean),
            type: 'pages',
            pages: rawContent.pages,
            name: rawContent.name,
        };
    }

    return {
        text,
        type: 'wiki',
        name: rawContent.name,
        wikiType: rawContent.wikiType,
        pageCount: rawContent.pageCount,
    };
}

/**
 * Prepares YouTube transcript content
 */
function prepareYouTubeContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Clean up transcript text
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first; bail with empty text if
        // nothing survives. See cleanContentOrNull docstring.
        const cleaned = cleanContentOrNull(text);
        if (cleaned === null) {
            text = '';
        } else {
            text = cleaned;
            // Remove excessive whitespace
            text = text.replace(/\n{3,}/g, '\n\n');
            // Trim
            text = text.trim();
        }
    }

    return {
        text,
        type: 'youtube',
        name: rawContent.name,
        videoId: rawContent.videoId,
        url: rawContent.url,
    };
}

/**
 * Generates a collection ID for the content
 * Uses the unified builders from collection-ids.js
 */
function generateCollectionId(contentType, source, settings) {
    const sourceName = source.name || source.id || source.filename || contentType;
    const timestamp = Date.now();

    switch (contentType) {
        case 'chat':
            throw new Error(
                'VectFox: generateCollectionId(contentType="chat") is disabled. ' +
                'Chat history must go through eventbase-workflow.js, not the chunk content pipeline.'
            );

        case 'lorebook':
            return buildLorebookCollectionId(sourceName, settings.vector_backend, timestamp);

        case 'character':
            return buildCharacterCollectionId(sourceName, settings.vector_backend, timestamp);

        case 'document':
            return buildDocumentCollectionId(sourceName, settings.vector_backend, timestamp);

        case 'url':
            // Use domain from URL or title
            let urlName = sourceName;
            try {
                const url = new URL(source.url || '');
                urlName = source.title || url.hostname || 'webpage';
            } catch {
                urlName = source.title || source.name || 'webpage';
            }
            return buildDocumentCollectionId(urlName, settings.vector_backend, timestamp);

        case 'wiki':
            return buildDocumentCollectionId(source.name || 'wiki', settings.vector_backend, timestamp);

        case 'youtube':
            return buildDocumentCollectionId(source.name || source.videoId || 'youtube', settings.vector_backend, timestamp);
    }

    // Fallback for unknown types or chat fallback
    const scope = settings.scope || 'character';
    const context = getContext();
    const baseName = sourceName;

    // Sanitize name for use in ID — Unicode-aware so CJK / Cyrillic / etc. survive.
    const sanitizedName = sanitizeNameSegment(baseName, 50);

    // Add scope prefix
    let scopePrefix = '';
    if (scope === 'character' && context?.characterId) {
        scopePrefix = `char_${context.characterId}_`;
    } else if (scope === 'chat' && context?.chatId) {
        scopePrefix = `chat_${context.chatId}_`;
    }

    return `VectFox_${contentType}_${scopePrefix}${sanitizedName}_${timestamp}`;
}

/**
 * Enriches chunks with metadata and keywords
 * @param {Array} chunks - Array of chunk strings or objects
 * @param {string} contentType - Type of content
 * @param {object} source - Source info
 * @param {object} settings - Vectorization settings including keyword options
 * @param {object} preparedContent - Prepared content data
 * @param {object} VectFoxSettings - Full VectFox extension settings (includes custom_stopwords)
 */
function enrichChunks(chunks, contentType, source, settings, preparedContent, VectFoxSettings) {
    // Get keyword extraction settings
    const keywordLevel = settings.keywordLevel || 'balanced';
    const keywordBaseWeight = settings.keywordBaseWeight || 1.5;

    return chunks.map((chunk, index) => {
        const chunkText = typeof chunk === 'string' ? chunk : chunk.text;
        let keywords = []; // Will hold {text, weight} objects
        let entryName = null;
        let entryUid = null;

        // For lorebooks with per_entry, get keywords from the entry
        if (contentType === 'lorebook' && preparedContent.entries?.[index]) {
            const entry = preparedContent.entries[index];
            entryName = entry.comment || entry.name || entry.key?.[0] || 'Entry';
            entryUid = entry.uid;

            // Get explicit trigger keys (these are manually set, so use base weight)
            const triggerKeys = extractLorebookKeywords(entry, VectFoxSettings);
            keywords = triggerKeys.map(k => ({ text: k, weight: keywordBaseWeight }));

            // Also get auto-extracted keywords with frequency-based weights
            if (keywordLevel !== 'off') {
                const autoKeywords = extractTextKeywords(entry.content || chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: VectFoxSettings,
                });
                keywords = keywords.concat(autoKeywords);
            }
        } else if (contentType === 'chat') {
            // For chat, use BM25/TF-IDF to find most distinctive words
            if (keywordLevel !== 'off') {
                keywords = extractBM25Keywords(chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: VectFoxSettings,
                });
            }
        } else {
            // For other content (url, wiki, document, youtube), use frequency-based extraction
            if (keywordLevel !== 'off') {
                keywords = extractTextKeywords(chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: VectFoxSettings,
                });
            }
        }

        // Auto-Reformat: LLM-extracted entity/topic records carry rich fields
        // (name/aliases/keywords) that the frequency-based extraction above
        // doesn't know about. Boost them in as high-weight keywords and set
        // entryName so the Database Browser shows a sensible per-chunk title —
        // same pattern as the lorebook/character special-cases in this function.
        // entryName also feeds the BM25 title-boost signal in hybrid-search.js.
        if (chunk.metadata?.entry_type) {
            entryName = chunk.metadata.name || entryName;
            const reformatKeywordTexts = [
                chunk.metadata.name,
                ...(Array.isArray(chunk.metadata.aliases) ? chunk.metadata.aliases : []),
                ...(Array.isArray(chunk.metadata.keywords) ? chunk.metadata.keywords : []),
            ].filter(Boolean);
            for (const kwText of reformatKeywordTexts) {
                keywords.push({ text: kwText.toLowerCase(), weight: keywordBaseWeight + 0.5 });
            }
        }

        // Add character name as keyword with higher weight (it's the main subject)
        if (contentType === 'character' && preparedContent.character?.name) {
            keywords.push({
                text: preparedContent.character.name.toLowerCase(),
                weight: keywordBaseWeight + 0.5, // Character name gets bonus weight
            });
        }

        // Add speaker name as keyword for chat messages
        if (contentType === 'chat' && chunk.metadata?.speakerName) {
            keywords.push({
                text: chunk.metadata.speakerName.toLowerCase(),
                weight: keywordBaseWeight,
            });
        }

        // Deduplicate keywords (keep highest weight for duplicates)
        const keywordMap = new Map();
        for (const kw of keywords) {
            const existing = keywordMap.get(kw.text);
            if (!existing || kw.weight > existing.weight) {
                keywordMap.set(kw.text, kw);
            }
        }
        const dedupedKeywords = Array.from(keywordMap.values());

        return {
            text: chunkText,
            index: index,
            keywords: dedupedKeywords,
            metadata: {
                // Chunk-level metadata first (chunkIndex/totalChunks/strategy/etc.)
                // so the explicit fields below win on conflict. The per_entry strategy
                // writes `entryName: undefined` for string inputs, which would otherwise
                // clobber the real entryName resolved from preparedContent.entries.
                ...(chunk.metadata || {}),
                contentType,
                sourceName: source.name || source.filename || 'Unknown',
                entryName,
                entryUid,
                keywordLevel,
                keywordBaseWeight,
            },
        };
    });
}

/**
 * Deletes a content collection
 */
/**
 * Delete the underlying vector data for a content collection.
 *
 * The backend the data physically lives in is encoded in the collection ID
 * itself (e.g. `vf_lorebook_qdrant_…` vs `vf_lorebook_standard_…`). The
 * helper auto-detects this from the ID when the caller doesn't pass a
 * `vector_backend` override, so cleanup ALWAYS targets the backend that
 * actually holds the data — never the user's currently-selected global.
 *
 * Without this auto-detection, the previous code routed every cleanup
 * through `extension_settings.vectfox.vector_backend`. If the user's global
 * was `standard` while the data lived in qdrant (e.g. tests overriding
 * `vector_backend: 'qdrant'` for one call), the purge silently no-op'd
 * against vectra and the qdrant folder leaked on disk. Accumulated orphans
 * eventually stalled Qdrant startup → plugin timeout → "Plugin shutting
 * down" crash. Surfaced 2026-05-23 via 31 qdrant orphans on the NAS.
 *
 * @param {string} collectionId - bare collection ID (no `backend:` prefix)
 * @param {object} [callerSettings] - per-call overrides; if omitted, the
 *   backend is detected from the collection ID format.
 */
export async function deleteContentCollection(collectionId, callerSettings = null) {
    let baseSettings = callerSettings;
    if (!baseSettings) {
        const detected = getBackendFromCollectionId(collectionId);
        if (detected) baseSettings = { vector_backend: detected };
    }
    const effectiveSettings = resolveEffectiveSettings(baseSettings);
    await purgeVectorIndex(collectionId, effectiveSettings);
    log.lifecycle(`VectFox: Deleted collection: ${collectionId} (routed via ${effectiveSettings.vector_backend})`);
}
