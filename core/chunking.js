/**
 * ============================================================================
 * VECTFOX CHUNKING STRATEGIES
 * ============================================================================
 * Unified chunking system for all content types.
 * Each strategy is a pure function that takes text and options, returns chunks.
 *
 * CHAT STRATEGIES (unit-based, no size controls):
 * - per_message: Each message = one chunk
 * - conversation_turns: User+AI pairs = one chunk
 * - message_batch: N messages = one chunk
 *
 * TEXT STRATEGIES (size-based):
 * - adaptive: Smart splitting at natural boundaries
 * - paragraph: Split on double newlines
 * - section: Split on markdown headers
 * - sentence: Group sentences to target size
 *
 * CONTENT STRATEGIES:
 * - per_entry: Each lorebook entry = one chunk
 * - per_field: Each character field = one chunk
 * - combined: Merge then chunk with adaptive
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from '../src/shared/constants.js';

/**
 * Main entry point - chunks text using specified strategy
 * @param {string|Array|object} text - Text to chunk (format depends on strategy)
 * @param {object} options - Chunking options
 * @param {string} options.strategy - Strategy ID
 * @param {number} options.chunkSize - Target chunk size in characters (for text strategies)
 * @param {number} options.batchSize - Messages per batch (for message_batch strategy)
 * @returns {Array<{text: string, metadata: object}>} Array of chunks
 */
export async function chunkText(text, options = {}) {
    const {
        strategy = 'adaptive',
        chunkSize = DEFAULT_CHUNK_SIZE,
        chunkOverlap = DEFAULT_CHUNK_OVERLAP,
        batchSize = 4,
    } = options;

    if (!text) {
        return [];
    }

    // Objects are allowed for per_field strategy
    const isObject = typeof text === 'object' && !Array.isArray(text);
    if (typeof text !== 'string' && !Array.isArray(text) && !isObject) {
        return [];
    }

    // Select strategy
    const strategyFn = STRATEGIES[strategy] || STRATEGIES.adaptive;
    const chunks = strategyFn(text, { chunkSize, chunkOverlap, batchSize });

    // Add metadata to each chunk
    return chunks.map((chunk, index) => ({
        text: typeof chunk === 'string' ? chunk : chunk.text,
        metadata: {
            chunkIndex: index,
            totalChunks: chunks.length,
            strategy: strategy,
            ...(typeof chunk === 'object' ? chunk.metadata : {}),
        },
    }));
}

/**
 * Strategy implementations
 */
const STRATEGIES = {
    // =========================================================================
    // CHAT STRATEGIES (unit-based)
    // =========================================================================

    /**
     * Per Message - each message becomes one chunk
     * @param {Array} messages - Array of message objects with .text or .mes
     */
    per_message: (messages) => {
        if (!Array.isArray(messages)) {
            // Single text input - treat as one chunk
            const text = typeof messages === 'string' ? messages : (messages.text || messages.mes || String(messages));
            return [text];
        }

        const chunks = [];
        for (const msg of messages) {
            const text = typeof msg === 'string' ? msg : (msg.text || msg.mes || '');
            const speaker = msg.is_user ? 'User' : (msg.name || 'Character');
            const isUser = msg.is_user || false;
            const messageId = msg.index ?? msg.id ?? msg.send_date;

            chunks.push({
                text,
                metadata: {
                    speaker,
                    isUser,
                    messageId,
                },
            });
        }
        return chunks;
    },

    /**
     * Conversation Turns - pairs user + AI messages together
     * @param {Array} messages - Array of message objects
     */
    conversation_turns: (messages) => {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }

        const chunks = [];
        for (let i = 0; i < messages.length; i += 2) {
            const pair = [messages[i]];
            if (i + 1 < messages.length) {
                pair.push(messages[i + 1]);
            }

            // Combine texts with speaker labels
            const combinedText = pair.map(m => {
                const role = m.is_user ? 'User' : (m.name || 'Character');
                const text = m.text || m.mes || '';
                return `[${role}]: ${text}`;
            }).join('\n\n');

            chunks.push({
                text: combinedText,
                metadata: {
                    strategy: 'conversation_turns',
                    messageIds: pair.map(m => m.index ?? m.id),
                    startIndex: pair[0].index ?? pair[0].id,
                    endIndex: pair[pair.length - 1].index ?? pair[pair.length - 1].id,
                },
            });
        }
        return chunks;
    },

    /**
     * Message Batch - groups N messages together
     * @param {Array} messages - Array of message objects
     * @param {object} options - Must include batchSize
     */
    message_batch: (messages, options) => {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }

        const batchSize = options.batchSize || 4;
        const chunks = [];

        for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);

            // Combine texts with speaker labels
            const combinedText = batch.map(m => {
                const role = m.is_user ? 'User' : (m.name || 'Character');
                const text = m.text || m.mes || '';
                return `[${role}]: ${text}`;
            }).join('\n\n');

            chunks.push({
                text: combinedText,
                metadata: {
                    strategy: 'message_batch',
                    batchSize: batch.length,
                    messageIds: batch.map(m => m.index ?? m.id),
                    startIndex: batch[0].index ?? batch[0].id,
                    endIndex: batch[batch.length - 1].index ?? batch[batch.length - 1].id,
                },
            });
        }
        return chunks;
    },

    /**
     * Adaptive - intelligent splitting at natural boundaries
     * Tries paragraphs first, then sentences, then words
     */
    adaptive: (text, options) => {
        if (Array.isArray(text)) {
            // If given array, treat as per_message
            return STRATEGIES.per_message(text, options);
        }
        return adaptiveChunk(text, options);
    },

    // =========================================================================
    // TEXT STRATEGIES (for documents, URLs, etc.)
    // =========================================================================

    /**
     * Split on paragraph boundaries (double newlines)
     */
    paragraph: (text) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }
        const paragraphs = text.split(/\n\n+|^---+$/m).filter(p => p.trim());
        return paragraphs.map(p => p.trim());
    },

    /**
     * Split on markdown section headers
     */
    section: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }

        const headerRegex = /^(#{1,6})\s+(.+)$/gm;
        const sections = [];
        let lastIndex = 0;
        let match;

        while ((match = headerRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                const beforeContent = text.slice(lastIndex, match.index).trim();
                if (beforeContent) {
                    sections.push(beforeContent);
                }
            }
            lastIndex = match.index;
        }

        if (lastIndex < text.length) {
            sections.push(text.slice(lastIndex).trim());
        }

        // If no headers found, fall back to paragraph
        if (sections.length === 0) {
            return STRATEGIES.paragraph(text, options);
        }

        return sections.filter(s => s);
    },

    /**
     * Split on sentence boundaries, grouping to target size
     */
    sentence: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }

        // Split on English (.!?) and Chinese (。！？) sentence-ending punctuation
        // Chinese punctuation often has no following whitespace, so \s* (zero or more)
        const sentences = text
            .split(/(?<=[.!?。！？])\s*/)
            .filter(s => s.trim())
            .map(s => s.trim());

        const chunks = [];
        let currentChunk = '';

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 <= options.chunkSize) {
                currentChunk += (currentChunk ? ' ' : '') + sentence;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = sentence;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    },

    // =========================================================================
    // CONTENT STRATEGIES (lorebook, character, etc.)
    // =========================================================================

    /**
     * Per Entry - each lorebook entry becomes one chunk
     */
    per_entry: (entries) => {
        if (!Array.isArray(entries)) {
            return [typeof entries === 'string' ? entries : String(entries)];
        }
        return entries.map(e => {
            const text = typeof e === 'string' ? e : (e.text || e.content || String(e));
            return {
                text,
                metadata: {
                    entryName: e.comment || e.name || e.key?.[0] || undefined,
                    keys: e.key || e.keys || undefined,
                },
            };
        });
    },

    /**
     * Per Field - each character field becomes one chunk
     */
    per_field: (fields) => {
        if (typeof fields !== 'object' || Array.isArray(fields)) {
            return [String(fields)];
        }
        return Object.entries(fields)
            .filter(([, value]) => value && typeof value === 'string' && value.trim())
            .map(([field, value]) => ({
                text: value,
                metadata: { field },
            }));
    },

    /**
     * Combined - merge all content then chunk with adaptive
     */
    combined: (content, options) => {
        let combined = '';

        if (typeof content === 'object' && !Array.isArray(content)) {
            combined = Object.values(content)
                .filter(v => v && typeof v === 'string')
                .join('\n\n');
        } else if (Array.isArray(content)) {
            combined = content.map(t => typeof t === 'string' ? t : (t.text || '')).join('\n\n');
        } else {
            combined = String(content);
        }

        return adaptiveChunk(combined, options);
    },

    /**
     * Dialogue-aware - keeps quoted speech intact
     */
    dialogue: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }

        const dialogueRegex = /"[^"]+"|'[^']+'|「[^」]+」|『[^』]+』/g;
        let chunks = [];
        let currentChunk = '';
        let lastIndex = 0;

        let match;
        while ((match = dialogueRegex.exec(text)) !== null) {
            const before = text.slice(lastIndex, match.index);
            currentChunk += before;

            const dialogue = match[0];

            if (currentChunk.length + dialogue.length <= options.chunkSize) {
                currentChunk += dialogue;
            } else {
                if (currentChunk.trim()) chunks.push(currentChunk.trim());
                currentChunk = dialogue;
            }

            lastIndex = match.index + dialogue.length;
        }

        currentChunk += text.slice(lastIndex);
        if (currentChunk.trim()) chunks.push(currentChunk.trim());

        // Split any oversized chunks
        const finalChunks = [];
        for (const chunk of chunks) {
            if (chunk.length <= options.chunkSize) {
                finalChunks.push(chunk);
            } else {
                finalChunks.push(...adaptiveChunk(chunk, options));
            }
        }

        return finalChunks;
    },
};

/**
 * Adaptive chunking - splits at natural boundaries respecting size limits
 * Tries: paragraphs → sentences → words
 */
function adaptiveChunk(text, options) {
    if (typeof text !== 'string') {
        return [String(text)];
    }

    const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    const chunks = [];
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

    let currentChunk = '';

    for (const para of paragraphs) {
        const trimmedPara = para.trim();
        if (!trimmedPara) continue;

        if (currentChunk.length + trimmedPara.length + 2 > chunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }

            if (trimmedPara.length > chunkSize) {
                chunks.push(...splitLargeParagraph(trimmedPara, chunkSize));
            } else {
                currentChunk = trimmedPara;
            }
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + trimmedPara;
        }
    }

    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks.length > 0 ? chunks : [text];
}

/**
 * Splits a large paragraph at sentence boundaries, then words if needed
 */
function splitLargeParagraph(text, maxSize) {
    // Split on English (.!?) and Chinese (。！？) sentence-ending punctuation
    const sentences = text.split(/(?<=[.!?。！？])\s*/);
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
        if (currentChunk.length + sentence.length + 1 <= maxSize) {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
        } else {
            if (currentChunk) chunks.push(currentChunk);

            if (sentence.length > maxSize) {
                // Split by words
                const words = sentence.split(/\s+/);
                let wordChunk = '';
                for (const word of words) {
                    if (wordChunk.length + word.length + 1 <= maxSize) {
                        wordChunk += (wordChunk ? ' ' : '') + word;
                    } else {
                        if (wordChunk) chunks.push(wordChunk);
                        wordChunk = word;
                    }
                }
                if (wordChunk) currentChunk = wordChunk;
            } else {
                currentChunk = sentence;
            }
        }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

