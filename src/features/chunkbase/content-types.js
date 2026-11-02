/**
 * ============================================================================
 * VectFox CONTENT TYPES REGISTRY
 * ============================================================================
 * Unified system for handling different content types with type-appropriate
 * features while sharing the same pipeline infrastructure.
 *
 * CHUNKING STRATEGY DESIGN:
 * - "unit" strategies (per_message, conversation_turns, message_batch, per_entry, per_field) = no size controls
 * - "text" strategies (adaptive, paragraph, section, sentence) = show size controls where applicable
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

/**
 * Chunking strategy metadata
 * needsSize: whether chunk size slider should appear
 * needsOverlap: whether overlap slider should appear
 * needsBatchSize: whether batch size slider should appear (for message_batch)
 */
export const CHUNKING_STRATEGIES = {
    // =========================================================================
    // CHAT STRATEGIES (unit-based, no size controls)
    // =========================================================================
    per_message: {
        id: 'per_message',
        name: 'Per Message',
        description: 'Each message becomes one chunk. Best for precise recall.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['chat'],
    },
    conversation_turns: {
        id: 'conversation_turns',
        name: 'Conversation Turns',
        description: 'Pairs user + AI messages together. Good for dialogue context.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['chat'],
    },
    message_batch: {
        id: 'message_batch',
        name: 'Message Batch',
        description: 'Groups N messages together. Configurable batch size.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: true,
        bestFor: ['chat'],
    },
    // =========================================================================
    // CONTENT STRATEGIES (unit-based, no size controls)
    // =========================================================================
    per_entry: {
        id: 'per_entry',
        name: 'Per Entry',
        description: 'Each lorebook entry becomes one chunk. Preserves WI structure.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['lorebook'],
    },
    per_field: {
        id: 'per_field',
        name: 'Per Field',
        description: 'Each character field becomes one chunk. Enables field-specific retrieval.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['character'],
    },
    per_page: {
        id: 'per_page',
        name: 'Per Page',
        description: 'Each wiki page becomes one chunk. Best for multi-page scrapes.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['wiki'],
    },

    // =========================================================================
    // TEXT STRATEGIES (size-based)
    // =========================================================================
    adaptive: {
        id: 'adaptive',
        name: 'Adaptive',
        description: 'Intelligently splits at natural boundaries (paragraphs → sentences → words).',
        needsSize: true,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['chat', 'document', 'url', 'wiki', 'youtube'],
        defaultSize: 500,
    },
    paragraph: {
        id: 'paragraph',
        name: 'By Paragraph',
        description: 'Splits on double newlines. Each paragraph becomes a chunk.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['document', 'url', 'lorebook'],
    },
    section: {
        id: 'section',
        name: 'By Section Headers',
        description: 'Splits on markdown headers (#, ##). Each section becomes a chunk.',
        needsSize: false,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['document', 'url', 'wiki'],
    },
    sentence: {
        id: 'sentence',
        name: 'By Sentence',
        description: 'Groups sentences up to target size. Most granular text splitting.',
        needsSize: true,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['document'],
        defaultSize: 300,
    },
    dialogue: {
        id: 'dialogue',
        name: 'Dialogue-Aware',
        description: 'Keeps quoted speech intact. Best for transcripts and scripts.',
        needsSize: true,
        needsOverlap: false,
        needsBatchSize: false,
        bestFor: ['document', 'youtube'],
        defaultSize: 400,
    },
};

/**
 * Get chunking strategy metadata
 */
export function getChunkingStrategy(strategyId) {
    return CHUNKING_STRATEGIES[strategyId] || null;
}

/**
 * Content Type Definitions
 * Each type defines its unique characteristics while sharing core infrastructure
 */
export const CONTENT_TYPES = {
    chat: {
        id: 'chat',
        name: 'Chat History',
        icon: 'fa-comments',
        description: 'Vectorize conversation history for semantic recall',

        features: {
            keywordExtraction: false,
            speakerAware: true,
            autoSync: true,
        },

        // 2026-05-24 cleanup: chunkingStrategies / defaultStrategy / the populated
        // defaults object are all GONE. Chat history is exclusively processed by
        // EventBase (LLM event extraction) — no chunking strategy, no chunk size,
        // no batch size applies. The production gates in ui/content-vectorizer.js
        // (startVectorization / continueVectorization / previewChunks) intercept
        // chat → EventBase before any chunking-config reader could fire.
        //
        // `defaults: {}` is kept INTENTIONALLY as a defensive shim. Some readers
        // (e.g. content-vectorization.js:98 / content-vectorizer.js:2280) access
        // `type.defaults.chunkSize` without optional chaining. The empty object
        // ensures `undefined` is returned instead of TypeError IF someone ever
        // manually modifies code to bypass the production gates and route chat
        // through the chunk pipeline. Same spirit as the `case 'chat': throw`
        // tripwire in generateCollectionId() — defense in depth.
        //
        // Do NOT re-add chunkSize / batchSize / chunkingStrategies here. If you
        // need chat-specific tuning, it belongs in EventBase's own settings
        // (eventbase_window_size, eventbase_window_overlap, etc.).
        defaults: {},

        sourceType: 'chat',
        sourceOptions: {
            allowUpload: true,
            uploadFormats: ['.txt', '.jsonl', '.json'],
        },
    },

    lorebook: {
        id: 'lorebook',
        name: 'Lorebook / World Info',
        icon: 'fa-book-atlas',
        description: 'Vectorize world info entries for semantic activation',

        features: {
            keywordExtraction: true,
            keyInheritance: true,
            scopeControl: true,
            respectDisabled: true,
        },

        chunkingStrategies: ['per_entry', 'paragraph', 'adaptive'],
        defaultStrategy: 'per_entry',

        defaults: {
            chunkSize: 600,
            autoKeywords: true,
            scope: 'character',
        },

        sourceType: 'select',
        sourceOptions: {
            allowUpload: true,
            uploadFormats: ['.json', '.lorebook'],
            selectLabel: 'Select Lorebook',
        },
    },

    character: {
        id: 'character',
        name: 'Character Card',
        icon: 'fa-user',
        description: 'Vectorize character definitions for context retrieval',

        features: {
            keywordExtraction: true,
            fieldSelection: true,
            scopeControl: true,
            characterScoped: true,
        },

        chunkingStrategies: ['per_field', 'paragraph', 'adaptive'],
        defaultStrategy: 'per_field',

        defaults: {
            chunkSize: 400,
            autoKeywords: true,
            scope: 'character',
            fields: {
                description: true,
                personality: true,
                scenario: true,
                first_mes: false,
                mes_example: false,
                system_prompt: true,
                post_history_instructions: true,
                creator_notes: false,
            },
        },

        sourceType: 'select',
        sourceOptions: {
            allowUpload: true,
            uploadFormats: ['.png', '.json'],
            selectLabel: 'Select Character',
        },
    },

    url: {
        id: 'url',
        name: 'URL / Webpage',
        icon: 'fa-globe',
        description: 'Fetch and vectorize content from a webpage',

        features: {
            keywordExtraction: true,
            scopeControl: true,
            sectionHeaders: true,
        },

        chunkingStrategies: ['adaptive', 'section', 'paragraph'],
        defaultStrategy: 'adaptive',

        defaults: {
            chunkSize: 400,
            autoKeywords: true,
            scope: 'character',
        },

        sourceType: 'url',
        sourceOptions: {
            placeholder: 'https://example.com/article',
        },
    },

    document: {
        id: 'document',
        name: 'Custom Document',
        icon: 'fa-file-lines',
        description: 'Upload documents or text files for retrieval',

        features: {
            keywordExtraction: true,
            scopeControl: true,
            sectionHeaders: true,
        },

        chunkingStrategies: ['adaptive', 'section', 'paragraph', 'sentence', 'dialogue'],
        defaultStrategy: 'adaptive',

        defaults: {
            chunkSize: 400,
            autoKeywords: false,
            scope: 'character',
        },

        sourceType: 'input',
        sourceOptions: {
            methods: [
                { id: 'paste', name: 'Paste Text', icon: 'fa-paste' },
                { id: 'upload', name: 'Upload File', icon: 'fa-upload', formats: ['.txt', '.md', '.json', '.html', '.yaml'] },
            ],
        },
    },

    wiki: {
        id: 'wiki',
        name: 'Wiki Page',
        icon: 'fa-book-open',
        description: 'Scrape Fandom or MediaWiki pages',

        features: {
            keywordExtraction: true,
            scopeControl: true,
            sectionHeaders: true,
            requiresPlugin: true,
            bulkScrape: true,
        },

        chunkingStrategies: ['per_page', 'section', 'adaptive'],
        defaultStrategy: 'per_page',

        defaults: {
            chunkSize: 600,
            autoKeywords: true,
            scope: 'character',
            wikiType: 'fandom',
        },

        sourceType: 'wiki',
        sourceOptions: {
            types: [
                { id: 'fandom', name: 'Fandom Wiki', placeholder: 'https://baldursgate.fandom.com/ or just "baldursgate"' },
                { id: 'mediawiki', name: 'MediaWiki / Wikipedia', placeholder: 'https://en.wikipedia.org/wiki/Article_Name' },
            ],
            filterPlaceholder: 'Astarion, Gale, Shadowheart (comma-separated page names)',
            pluginUrl: 'https://github.com/SillyTavern/SillyTavern-Fandom-Scraper',
        },
    },

    youtube: {
        id: 'youtube',
        name: 'YouTube Transcript',
        icon: 'fa-youtube',
        iconBrand: true,
        description: 'Extract and vectorize video transcripts',

        features: {
            keywordExtraction: true,
            scopeControl: true,
            timestamps: true,
        },

        chunkingStrategies: ['adaptive', 'paragraph', 'dialogue'],
        defaultStrategy: 'adaptive',

        defaults: {
            chunkSize: 400,
            autoKeywords: true,
            scope: 'character',
        },

        sourceType: 'youtube',
        sourceOptions: {
            placeholder: 'https://www.youtube.com/watch?v=... or video ID',
            langPlaceholder: 'en (optional language code)',
        },
    },
};

/**
 * Get content type definition by ID
 */
export function getContentType(typeId) {
    return CONTENT_TYPES[typeId] || null;
}

/**
 * Get all content types as array
 */
export function getAllContentTypes() {
    return Object.values(CONTENT_TYPES);
}

/**
 * Get chunking strategies for a content type (with full metadata)
 */
export function getChunkingStrategies(typeId) {
    const type = CONTENT_TYPES[typeId];
    if (!type?.chunkingStrategies) return [];

    return type.chunkingStrategies
        .map(id => CHUNKING_STRATEGIES[id])
        .filter(Boolean);
}

/**
 * Get default settings for a content type (includes defaultStrategy)
 */
export function getContentTypeDefaults(typeId) {
    const type = CONTENT_TYPES[typeId];
    if (!type) return {};
    return {
        ...type.defaults,
        strategy: type.defaultStrategy,
    };
}

/**
 * Check if a content type supports a feature
 */
export function hasFeature(typeId, feature) {
    const type = CONTENT_TYPES[typeId];
    return type?.features?.[feature] === true;
}

/**
 * Character card fields that can be vectorized
 */
export const CHARACTER_FIELDS = [
    { id: 'description', name: 'Description', description: 'Character description/persona' },
    { id: 'personality', name: 'Personality', description: 'Personality summary' },
    { id: 'scenario', name: 'Scenario', description: 'Current scenario/setting' },
    { id: 'first_mes', name: 'First Message', description: 'Opening message' },
    { id: 'mes_example', name: 'Example Messages', description: 'Example dialogue' },
    { id: 'system_prompt', name: 'System Prompt', description: 'System instructions' },
    { id: 'post_history_instructions', name: 'Jailbreak/NSFW', description: 'Post-history instructions' },
    { id: 'creator_notes', name: 'Creator Notes', description: 'Notes from card creator' },
];
