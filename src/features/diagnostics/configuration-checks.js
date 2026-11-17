/**
 * ============================================================================
 * VectFox DIAGNOSTICS - CONFIGURATION
 * ============================================================================
 * Settings validation and configuration checks
 *
 * @author Kritblade
 * ============================================================================
 */

import {
    isCollectionEnabled,
    getCollectionRegistry,
} from '../collections/index.js';

/**
 * Check: Query depth, the messages each turn searches with
 */
export function checkQueryDepth(settings) {
    const query = settings.query;
    if (query < 1) return { name: 'Query Depth', status: 'fail', message: `Invalid query depth (${query}). Must be >= 1` };
    if (query > 20) return { name: 'Query Depth', status: 'warning', message: `High query depth (${query}). The search text may dilute` };
    return { name: 'Query Depth', status: 'pass', message: `Query: ${query}` };
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
 * Summarizes the RAG page's context and XML tag, which wrap the memory blocks.
 */
export function checkPromptContextConfig(settings) {
    const hasContext = Boolean(settings.rag_context?.trim());
    const hasXmlTag = Boolean(settings.rag_xml_tag?.trim());
    const message = hasContext || hasXmlTag
        ? `RAG page: ${[hasContext ? 'context' : '', hasXmlTag ? 'XML tag' : ''].filter(Boolean).join(' and ')}`
        : 'No prompt context configured (memory injects as plain text)';
    return { name: 'Prompt Context', status: 'pass', message, category: 'configuration' };
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
