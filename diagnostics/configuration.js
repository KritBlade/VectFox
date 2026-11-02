/**
 * ============================================================================
 * VectFox DIAGNOSTICS - CONFIGURATION
 * ============================================================================
 * Settings validation and configuration checks
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { VALID_GENERATION_TYPES, validateConditionRule } from '../src/features/collections/conditional-activation.js';
import { isCollectionEnabled } from '../src/features/collections/collection-metadata.js';
import { getCollectionRegistry } from '../src/features/collections/collection-loader.js';

const CHAT_NOT_APPLICABLE_MESSAGE = 'Not applicable (EventBase mode — chat is not stored as a chunk collection)';

/**
 * Check: RAG Query Status
 * Checks if there are ANY enabled collections that can be queried during generation.
 */
export function checkChatEnabled(settings) {
    const chatEnabled = settings.enabled_chats;

    const registry = getCollectionRegistry();
    let otherEnabledCount = 0;
    const otherEnabledNames = [];

    for (const registryKey of registry) {
        let collectionId = registryKey;
        if (registryKey.includes(':')) {
            collectionId = registryKey.substring(registryKey.indexOf(':') + 1);
        }

        if (isCollectionEnabled(registryKey)) {
            otherEnabledCount++;
            if (otherEnabledNames.length < 3) {
                otherEnabledNames.push(collectionId.substring(0, 20));
            }
        }
    }

    const hasAnyEnabled = chatEnabled || otherEnabledCount > 0;

    if (!hasAnyEnabled) {
        return {
            name: 'RAG Query Status',
            status: 'warning',
            message: 'No collections enabled for querying. Enable chat vectorization or enable other collections in the Database Browser.'
        };
    }

    // Build status message
    const parts = [];
    if (chatEnabled) {
        parts.push('Chat: enabled');
    }
    if (otherEnabledCount > 0) {
        parts.push(`Other collections: ${otherEnabledCount} enabled`);
    }

    return {
        name: 'RAG Query Status',
        status: 'pass',
        message: parts.join(' | ')
    };
}

/**
 * Check: Chunk size (for adaptive strategy)
 */
export function checkChunkSize(settings) {
    const size = settings.chunk_size || 500;

    if (size < 50) {
        return {
            name: 'Chunk Size',
            status: 'fail',
            message: `Chunk size too small (${size} chars). Minimum: 50`
        };
    }

    if (size < 100) {
        return {
            name: 'Chunk Size',
            status: 'warning',
            message: `Chunk size is very small (${size} chars). Recommended: 200-800`
        };
    }

    if (size > 2000) {
        return {
            name: 'Chunk Size',
            status: 'warning',
            message: `Chunk size is very large (${size} chars). May cause context issues`
        };
    }

    return {
        name: 'Chunk Size',
        status: 'pass',
        message: `${size} characters`
    };
}

/**
 * Check: Score threshold validation
 */
export function checkScoreThreshold(settings) {
    const threshold = settings.score_threshold;

    if (threshold < 0 || threshold > 1) {
        return {
            name: 'Score Threshold',
            status: 'fail',
            message: `Invalid threshold (${threshold}). Must be 0.0-1.0`
        };
    }

    if (threshold < 0.1) {
        return {
            name: 'Score Threshold',
            status: 'warning',
            message: `Very low threshold (${threshold}). May retrieve irrelevant results`
        };
    }

    if (threshold > 0.8) {
        return {
            name: 'Score Threshold',
            status: 'warning',
            message: `Very high threshold (${threshold}). May retrieve nothing`
        };
    }

    return {
        name: 'Score Threshold',
        status: 'pass',
        message: `${threshold}`
    };
}

/**
 * Check: Insert and query counts
 */
export function checkInsertQueryCounts(settings) {
    const insert = settings.insert;
    const query = settings.query;

    if (insert < 1 || query < 1) {
        return {
            name: 'Insert/Query Counts',
            status: 'fail',
            message: `Invalid counts (insert: ${insert}, query: ${query}). Must be >= 1`
        };
    }

    if (insert > 20 || query > 20) {
        return {
            name: 'Insert/Query Counts',
            status: 'warning',
            message: `High counts (insert: ${insert}, query: ${query}). May use too much context`
        };
    }

    return {
        name: 'Insert/Query Counts',
        status: 'pass',
        message: `Insert: ${insert}, Query: ${query}`
    };
}

/**
 * Check: Current chat has vectors
 */
export async function checkChatVectors() {
    return {
        name: 'Chat Vectors',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE
    };
}

/**
 * Check: Collection ID format and UUID availability
 */
export function checkCollectionIdFormat() {
    return {
        name: 'Collection ID Format',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Conditional activation module is available
 */
export function checkConditionalActivationModule() {
    try {
        if (!VALID_GENERATION_TYPES || VALID_GENERATION_TYPES.length === 0) {
            return {
                name: 'Conditional Activation',
                status: 'fail',
                message: 'VALID_GENERATION_TYPES not loaded correctly',
                category: 'configuration'
            };
        }

        if (typeof validateConditionRule !== 'function') {
            return {
                name: 'Conditional Activation',
                status: 'fail',
                message: 'Validation functions not available',
                category: 'configuration'
            };
        }

        return {
            name: 'Conditional Activation',
            status: 'pass',
            message: `Module loaded (${VALID_GENERATION_TYPES.length} gen types)`,
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Conditional Activation',
            status: 'fail',
            message: `Module error: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: Hash collision rate in current chat
 * This is INFORMATIONAL - collisions are intentional semantic deduplication.
 * High collision rate (>10%) may indicate repetitive conversations or chunking misconfiguration.
 */
export async function checkHashCollisionRate() {
    return {
        name: 'Hash Collision Rate',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Chat Metadata Integrity
 * Verifies the chat has a valid UUID for vector collection identification.
 * Missing or malformed UUIDs can cause collection mismatches.
 */
export function checkChatMetadataIntegrity() {
    return {
        name: 'Chat Metadata Integrity',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Condition Rule Validity
 * Verifies all chunk conditions in the current chat collection use valid operators and values.
 */
export async function checkConditionRuleValidity() {
    return {
        name: 'Condition Rules',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Collection Registry Status
 * Verifies collections are discoverable and the registry is populated.
 * Empty registry with available backend = discovery issue.
 */
export async function checkCollectionRegistryStatus(settings) {
    const registry = getCollectionRegistry();
    const registryCount = registry.length;

    if (registryCount === 0) {
        // Try to determine if there SHOULD be collections by checking the backend
        // If the user has the plugin, we can check for actual collections
        const hasPlugin = settings.vector_backend === 'qdrant';

        if (hasPlugin) {
            return {
                name: 'Collection Registry',
                status: 'warning',
                message: 'Registry empty. Collections will auto-discover on first message. Open Database Browser to populate now.',
                category: 'configuration'
            };
        }

        return {
            name: 'Collection Registry',
            status: 'pass',
            message: 'Registry empty (no collections vectorized yet)',
            category: 'configuration'
        };
    }

    // Count enabled collections
    const enabledCount = registry.filter(key => isCollectionEnabled(key)).length;

    return {
        name: 'Collection Registry',
        status: 'pass',
        message: `${registryCount} collection(s) registered, ${enabledCount} enabled for querying`,
        category: 'configuration'
    };
}

/**
 * Check: Prompt Context Configuration
 * Summarizes prompt context settings (global, collection, chunk levels).
 */
export async function checkPromptContextConfig(settings) {
    try {
        const { getCollectionMeta } = await import('../src/features/collections/collection-metadata.js');
        const registry = getCollectionRegistry();

        // Check global settings
        const hasGlobalContext = !!(settings.rag_context && settings.rag_context.trim());
        const hasGlobalXmlTag = !!(settings.rag_xml_tag && settings.rag_xml_tag.trim());

        // Count collections with context
        let collectionsWithContext = 0;
        let collectionsWithXmlTag = 0;

        for (const registryKey of registry) {
            let collectionId = registryKey;
            if (registryKey.includes(':')) {
                collectionId = registryKey.substring(registryKey.indexOf(':') + 1);
            }

            const meta = getCollectionMeta(collectionId);
            if (meta?.context && meta.context.trim()) collectionsWithContext++;
            if (meta?.xmlTag && meta.xmlTag.trim()) collectionsWithXmlTag++;
        }

        // Build status message
        const parts = [];
        if (hasGlobalContext || hasGlobalXmlTag) {
            parts.push(`Global: ${hasGlobalContext ? 'context' : ''}${hasGlobalContext && hasGlobalXmlTag ? '+' : ''}${hasGlobalXmlTag ? 'xml' : ''}`);
        }
        if (collectionsWithContext > 0 || collectionsWithXmlTag > 0) {
            parts.push(`${collectionsWithContext} collection(s) with context`);
        }

        if (parts.length === 0) {
            return {
                name: 'Prompt Context',
                status: 'pass',
                message: 'No prompt context configured (chunks inject as plain text)',
                category: 'configuration'
            };
        }

        return {
            name: 'Prompt Context',
            status: 'pass',
            message: parts.join(' | '),
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Prompt Context',
            status: 'warning',
            message: `Could not check: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: PNG Export Capability
 * Verifies the browser supports CompressionStream for PNG exports.
 */
export function checkPNGExportCapability() {
    const hasCompressionStream = typeof CompressionStream !== 'undefined';
    const hasDecompressionStream = typeof DecompressionStream !== 'undefined';
    const hasCanvas = typeof HTMLCanvasElement !== 'undefined';

    const allSupported = hasCompressionStream && hasDecompressionStream && hasCanvas;

    if (!allSupported) {
        const missing = [];
        if (!hasCompressionStream) missing.push('CompressionStream');
        if (!hasDecompressionStream) missing.push('DecompressionStream');
        if (!hasCanvas) missing.push('Canvas');

        return {
            name: 'PNG Export Capability',
            status: 'warning',
            message: `Missing browser APIs: ${missing.join(', ')}. PNG export may not work.`,
            category: 'configuration'
        };
    }

    // Test if deflate-raw is supported
    let deflateRawSupported = false;
    try {
        new CompressionStream('deflate-raw');
        deflateRawSupported = true;
    } catch {
        // deflate-raw not supported, will use fallback
    }

    return {
        name: 'PNG Export Capability',
        status: 'pass',
        message: deflateRawSupported
            ? 'Full PNG export support (native deflate-raw)'
            : 'PNG export supported (using deflate fallback)',
        category: 'configuration'
    };
}
