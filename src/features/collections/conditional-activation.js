/**
 * ============================================================================
 * VectFox CONDITIONAL ACTIVATION SYSTEM
 * ============================================================================
 * Evaluates the Advanced Conditions rules in a collection's settings, builds
 * the search context those rules read, and applies chunk links to retrieval
 * results.
 *
 * @author Kritblade
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';

// ============================================================================
// CONDITION EVALUATORS (10 types)
// ============================================================================
// Each evaluates one Advanced Conditions rule against the search context.
// shouldCollectionActivate() applies a collection's rules once its lock and
// triggers have passed.
// ============================================================================

/**
 * Evaluates a pattern condition (advanced version of keyword)
 * Supports regex patterns, custom scan depth, and filtering by message role
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluatePatternCondition(rule, context) {
    const settings = rule.settings || {};

    // Support both 'patterns' (new) and 'values' (legacy)
    const patterns = settings.patterns || settings.values || [];
    const matchMode = settings.matchMode || 'any';
    const caseSensitive = settings.caseSensitive === true;
    const scanDepth = settings.scanDepth || 10;
    const searchIn = settings.searchIn || 'all'; // 'all', 'user', 'assistant'

    if (patterns.length === 0) {
        return false;
    }

    // Get messages to search based on scan depth and role filter
    let messagesToSearch = context.recentMessages || [];

    // Apply scan depth
    messagesToSearch = messagesToSearch.slice(0, scanDepth);

    // Filter by role if needed
    if (searchIn !== 'all' && context.messageRoles) {
        const roles = context.messageRoles.slice(0, scanDepth);
        messagesToSearch = messagesToSearch.filter((_, idx) => {
            const role = roles[idx];
            if (searchIn === 'user') return role === 'user';
            if (searchIn === 'assistant') return role === 'assistant' || role === 'char';
            return true;
        });
    }

    const searchText = messagesToSearch.join('\n');
    if (!searchText) {
        return false;
    }

    // Evaluate each pattern
    const results = patterns.map(pattern => {
        // Check if it's a regex pattern (wrapped in /.../)
        if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
            try {
                const lastSlash = pattern.lastIndexOf('/');
                const regexPattern = pattern.slice(1, lastSlash);
                const flags = pattern.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
                const regex = new RegExp(regexPattern, flags);
                return regex.test(searchText);
            } catch (e) {
                log.warn(`VectFox: Invalid pattern regex: ${pattern}`, e);
                return false;
            }
        }

        // Plain text matching
        const textToSearch = caseSensitive ? searchText : searchText.toLowerCase();
        const patternToMatch = caseSensitive ? pattern : pattern.toLowerCase();
        return textToSearch.includes(patternToMatch);
    });

    // Apply match mode
    if (matchMode === 'all') {
        return results.every(r => r);
    }
    return results.some(r => r); // 'any' mode
}


/**
 * Evaluates a speaker condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateSpeakerCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || ''], matchType: 'any' };
    const targetSpeakers = settings.values || [];
    const matchType = settings.matchType || 'any';

    if (matchType === 'all') {
        // All speakers must be in recent messages
        const speakers = context.messageSpeakers || [];
        return targetSpeakers.every(target => speakers.includes(target));
    } else {
        // Any speaker matches (default)
        return targetSpeakers.includes(context.lastSpeaker);
    }
}

/**
 * Evaluates a message count condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateMessageCountCondition(rule, context) {
    const settings = rule.settings || { count: parseInt(rule.value) || 0, operator: 'gte' };
    const count = settings.count || 0;
    const operator = settings.operator || 'gte';
    const upperBound = settings.upperBound || 0;

    switch (operator) {
        case 'eq':
            return context.messageCount === count;
        case 'gte':
            return context.messageCount >= count;
        case 'lte':
            return context.messageCount <= count;
        case 'between':
            return context.messageCount >= count && context.messageCount <= upperBound;
        default:
            return context.messageCount >= count;
    }
}

/**
 * Evaluates a time of day condition
 * @param {object} rule Condition rule
 * @returns {boolean} Whether condition is met
 */
function evaluateTimeOfDayCondition(rule) {
    try {
        const settings = rule.settings || {};
        const startTime = settings.startTime || '00:00';
        const endTime = settings.endTime || '23:59';

        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();
        const [startH, startM] = startTime.split(':').map(n => parseInt(n));
        const [endH, endM] = endTime.split(':').map(n => parseInt(n));
        const start = startH * 60 + startM;
        const end = endH * 60 + endM;

        if (start <= end) {
            // Normal range (e.g., 09:00-17:00)
            return currentTime >= start && currentTime <= end;
        } else {
            // Midnight crossing (e.g., 22:00-02:00)
            return currentTime >= start || currentTime <= end;
        }
    } catch (error) {
        log.warn('VectFox Conditions: Invalid timeOfDay format:', error);
        return false;
    }
}

/**
 * Evaluates a character present condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateCharacterPresentCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || ''], matchType: 'any', lookback: 10 };
    const targetCharacters = settings.values || [];
    const matchType = settings.matchType || 'any';
    const speakers = context.messageSpeakers || [];

    if (matchType === 'all') {
        // All characters must be present
        return targetCharacters.every(char =>
            speakers.some(speaker => (speaker || '').toLowerCase().includes(char.toLowerCase()))
        );
    } else {
        // Any character present (default)
        return targetCharacters.some(char =>
            speakers.some(speaker => (speaker || '').toLowerCase().includes(char.toLowerCase()))
        );
    }
}

/**
 * Evaluates a random chance condition: passes with the configured probability
 * (0 never, 100 always), or 50% when no probability is set.
 * @param {object} rule Condition rule
 * @returns {boolean} Whether condition is met
 */
function evaluateRandomChanceCondition(rule) {
    const configured = rule.settings?.probability ?? parseInt(rule.value);
    const chance = Number.isFinite(configured) ? configured : 50;
    // roll is in [0, 100), so `<` passes exactly `chance` percent of the time.
    const roll = Math.random() * 100;
    return roll < chance;
}

/**
 * Evaluates a generation type condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateGenerationTypeCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || 'normal'], matchType: 'any' };
    const targetGenTypes = settings.values || ['normal'];
    const matchType = settings.matchType || 'any';
    const currentGenType = (context.generationType || 'normal').toLowerCase();

    if (matchType === 'all') {
        // All types must match (doesn't make sense for single context, but kept for consistency)
        return targetGenTypes.every(type => type.toLowerCase() === currentGenType);
    } else {
        // Any type matches (default)
        return targetGenTypes.some(type => type.toLowerCase() === currentGenType);
    }
}

/**
 * Evaluates a swipe count condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateSwipeCountCondition(rule, context) {
    const settings = rule.settings || { count: parseInt(rule.value) || 0, operator: 'gte' };
    const swipeCount = settings.count || 0;
    const operator = settings.operator || 'gte';
    const upperBound = settings.upperBound || 0;
    const currentSwipeCount = context.swipeCount || 0;

    switch (operator) {
        case 'eq':
            return currentSwipeCount === swipeCount;
        case 'gte':
            return currentSwipeCount >= swipeCount;
        case 'lte':
            return currentSwipeCount <= swipeCount;
        case 'between':
            return currentSwipeCount >= swipeCount && currentSwipeCount <= upperBound;
        default:
            return currentSwipeCount >= swipeCount;
    }
}

/**
 * Evaluates a lorebook active condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateLorebookActiveCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || ''], matchType: 'any' };
    const targetEntries = settings.values || [];
    const matchType = settings.matchType || 'any';
    const activeEntries = context.activeLorebookEntries || [];

    if (matchType === 'all') {
        // All entries must be active
        return targetEntries.every(target => {
            const targetLower = target.toLowerCase();
            return activeEntries.some(entry => {
                const entryKey = (entry.key || '').toLowerCase();
                const entryUid = String(entry.uid || '').toLowerCase();
                return entryKey.includes(targetLower) || entryUid === targetLower;
            });
        });
    } else {
        // Any entry active (default)
        return targetEntries.some(target => {
            const targetLower = target.toLowerCase();
            return activeEntries.some(entry => {
                const entryKey = (entry.key || '').toLowerCase();
                const entryUid = String(entry.uid || '').toLowerCase();
                return entryKey.includes(targetLower) || entryUid === targetLower;
            });
        });
    }
}

/**
 * Evaluates an is group chat condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateIsGroupChatCondition(rule, context) {
    const settings = rule.settings || { isGroup: rule.value === 'true' || rule.value === true };
    const expectGroupChat = settings.isGroup !== false;
    const isGroup = context.isGroupChat || false;
    return isGroup === expectGroupChat;
}

// ============================================================================
// MAIN EVALUATION FUNCTIONS
// ============================================================================

/**
 * Evaluates a single condition rule
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
export function evaluateConditionRule(rule, context) {
    let result = false;

    switch (rule.type) {
        case 'pattern':
            result = evaluatePatternCondition(rule, context);
            break;

        case 'keyword': // Legacy - aliases to pattern
            result = evaluatePatternCondition(rule, context);
            break;

        case 'speaker':
            result = evaluateSpeakerCondition(rule, context);
            break;

        case 'messageCount':
            result = evaluateMessageCountCondition(rule, context);
            break;

        case 'timeOfDay':
            result = evaluateTimeOfDayCondition(rule, context);
            break;

        case 'characterPresent':
            result = evaluateCharacterPresentCondition(rule, context);
            break;

        case 'randomChance':
            result = evaluateRandomChanceCondition(rule, context);
            break;

        case 'generationType':
            result = evaluateGenerationTypeCondition(rule, context);
            break;

        case 'swipeCount':
            result = evaluateSwipeCountCondition(rule, context);
            break;

        case 'lorebookActive':
            result = evaluateLorebookActiveCondition(rule, context);
            break;

        case 'isGroupChat':
            result = evaluateIsGroupChatCondition(rule, context);
            break;

        default:
            log.warn(`VectFox Conditions: Unknown condition type: ${rule.type}`);
            result = false;
    }

    // Apply negation if specified
    return rule.negate ? !result : result;
}

/**
 * Builds the search context that activation triggers and condition rules read
 * @param {Array} chat Chat messages
 * @param {number} contextWindow How many recent messages to consider
 * @param {object} metadata Additional metadata
 * @returns {object} Search context
 */
export function buildSearchContext(chat, contextWindow = 10, metadata = {}) {
    const recentMessages = chat.slice(-contextWindow).map(m => m.mes || '');
    const lastMessage = chat[chat.length - 1] || {};

    // Extract speakers from recent messages
    const messageSpeakers = chat.slice(-contextWindow).map(m => {
        if (m.name) return m.name;
        return m.is_user ? 'User' : 'Character';
    });

    // Count swipes on last message
    const swipeCount = (lastMessage.swipes && lastMessage.swipes.length > 0)
        ? lastMessage.swipes.length - 1
        : 0;

    return {
        recentMessages,
        lastSpeaker: lastMessage.name || (lastMessage.is_user ? 'User' : 'Character'),
        messageCount: chat.length,
        messageSpeakers,           // Array of speaker names for characterPresent
        timestamp: new Date(),     // Current timestamp for timeOfDay

        // Generation, chat and character context
        generationType: metadata.generationType || 'normal',         // Generation type (normal, swipe, regenerate, continue, impersonate)
        swipeCount: swipeCount,                                      // Number of swipes on last message
        activeLorebookEntries: metadata.activeLorebookEntries || [], // Active lorebook entries
        isGroupChat: metadata.isGroupChat || false,                  // Whether this is a group chat
        currentCharacter: metadata.currentCharacter || null,         // Current character name (for expressions extension)
        currentChatId: metadata.currentChatId || null,               // Current chat ID (for lock checks)
        currentCharacterId: metadata.currentCharacterId || null,     // Current character ID (for character locks)
    };
}

// ============================================================================
// CHUNK LINKS
// ============================================================================
// A chunk's links, set in the chunk viewer, pull related chunks into the
// retrieval results: a force link adds its target, a soft link boosts it.
// ============================================================================

/**
 * Processes chunk links and returns chunks that need to be included/boosted
 *
 * Link modes:
 * - force: Target chunk MUST be included if source chunk is in results
 * - soft:  Target chunk gets a score boost if source chunk is in results
 *
 * Each chunk defines its own links independently. For two-way linking,
 * add links on both chunks. For one-way, only add on the source chunk.
 *
 * @param {object[]} chunks Array of chunks from search results
 * @param {object} chunkMetadataMap Plain object of hash -> chunk metadata (includes chunkLinks)
 * @param {number} softBoost Score boost for soft links (default 0.15)
 * @returns {object} { chunks: processedChunks, hardLinkedHashes: Set }
 */
export function processChunkLinks(chunks, chunkMetadataMap, softBoost = 0.15) {
    const resultHashes = new Set(chunks.map(c => c.hash));
    const hardLinkedHashes = new Set();
    const softBoosts = new Map(); // hash -> total boost

    // First pass: collect all force links and soft boosts.
    // Links use the visualizer's shape: chunkLinks: [{ targetHash, mode: 'force'|'soft' }]
    // (the link editor radio writes exactly these values — see chunk-visualizer.js).
    for (const chunk of chunks) {
        const meta = chunkMetadataMap[chunk.hash];
        if (!meta?.chunkLinks || meta.chunkLinks.length === 0) continue;

        for (const link of meta.chunkLinks) {
            const targetHash = parseInt(link.targetHash);

            if (link.mode === 'force') {
                // Force link: target MUST be included
                hardLinkedHashes.add(targetHash);
            } else if (link.mode === 'soft') {
                // Soft link: accumulate boost for target
                const currentBoost = softBoosts.get(targetHash) || 0;
                softBoosts.set(targetHash, currentBoost + softBoost);
            }
        }
    }

    // Second pass: apply soft boosts to existing chunks
    const processedChunks = chunks.map(chunk => {
        const boost = softBoosts.get(chunk.hash) || 0;
        if (boost > 0) {
            return {
                ...chunk,
                score: Math.min(1.0, (chunk.score || 0) + boost),
                softLinked: true,
                linkBoost: boost
            };
        }
        return chunk;
    });

    // Hard-linked chunks that aren't in results need to be fetched separately
    // Return the hashes so caller can fetch them
    const missingHardLinks = [...hardLinkedHashes].filter(h => !resultHashes.has(h));

    return {
        chunks: processedChunks,
        hardLinkedHashes: hardLinkedHashes,
        missingHardLinks: missingHardLinks
    };
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Valid generation types
 */
export const VALID_GENERATION_TYPES = ['normal', 'swipe', 'regenerate', 'continue', 'impersonate'];

/**
 * Validates a condition rule
 * @param {object} rule Condition rule to validate
 * @returns {object} Validation result { valid: boolean, errors: string[] }
 */
export function validateConditionRule(rule) {
    const errors = [];

    if (!rule.type) {
        errors.push('Condition type is required');
    }

    // Value validation depends on whether settings are used
    const hasSettings = rule.settings && Object.keys(rule.settings).length > 0;
    if (!hasSettings && (!rule.value || String(rule.value).trim() === '')) {
        errors.push('Condition value is required');
    }

    switch (rule.type) {
        case 'messageCount': {
            const mcCount = rule.settings?.count ?? parseInt(rule.value);
            if (isNaN(mcCount) || mcCount < 0) {
                errors.push('Message count must be a positive number');
            }
            break;
        }

        case 'timeOfDay': {
            const todSettings = rule.settings || {};
            if (todSettings.startTime || todSettings.endTime) {
                const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
                if (todSettings.startTime && !timeRegex.test(todSettings.startTime)) {
                    errors.push('Invalid start time format. Use HH:MM (e.g., 09:00)');
                }
                if (todSettings.endTime && !timeRegex.test(todSettings.endTime)) {
                    errors.push('Invalid end time format. Use HH:MM (e.g., 17:00)');
                }
            } else if (rule.value) {
                // Legacy format: HH:MM-HH:MM
                const timeParts = rule.value.split('-');
                if (timeParts.length !== 2) {
                    errors.push('Time range must be in format HH:MM-HH:MM (e.g., 09:00-17:00)');
                } else {
                    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
                    if (!timeRegex.test(timeParts[0]) || !timeRegex.test(timeParts[1])) {
                        errors.push('Invalid time format. Use HH:MM (e.g., 09:00, 17:30)');
                    }
                }
            }
            break;
        }

        case 'randomChance': {
            const chance = rule.settings?.probability ?? parseInt(rule.value);
            if (isNaN(chance) || chance < 0 || chance > 100) {
                errors.push('Random chance must be between 0 and 100');
            }
            break;
        }

        case 'characterPresent': {
            const cpValues = rule.settings?.values || [rule.value];
            if (cpValues.length === 0 || cpValues.every(v => !v || v.trim() === '')) {
                errors.push('Character name cannot be empty');
            }
            break;
        }

        case 'generationType': {
            const gtValues = rule.settings?.values || [rule.value];
            for (const genType of gtValues) {
                if (genType && !VALID_GENERATION_TYPES.includes(genType.toLowerCase())) {
                    errors.push(`Invalid generation type: "${genType}". Valid types: ${VALID_GENERATION_TYPES.join(', ')}`);
                }
            }
            break;
        }

        case 'swipeCount': {
            const scCount = rule.settings?.count ?? parseInt(rule.value);
            if (isNaN(scCount) || scCount < 0) {
                errors.push('Swipe count must be a positive number');
            }
            break;
        }

        case 'lorebookActive': {
            const lbValues = rule.settings?.values || [rule.value];
            if (lbValues.length === 0 || lbValues.every(v => !v || v.trim() === '')) {
                errors.push('Lorebook entry key or UID cannot be empty');
            }
            break;
        }

        case 'isGroupChat': {
            const gcValue = rule.settings?.isGroup ?? rule.value;
            if (gcValue !== 'true' && gcValue !== 'false' && gcValue !== true && gcValue !== false) {
                errors.push('isGroupChat value must be true or false');
            }
            break;
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}
