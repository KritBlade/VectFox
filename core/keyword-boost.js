import { porterStemmer, extractCJKTokens, getCjkTokenizerMode, CJK_TOKENIZER_MODES } from './bm25-scorer.js';
import { substituteParams } from '../src/sillytavern/chat.js';
import { buildStopSet } from './stop-words.js';
import { stopLocalesForMode } from './language-modes.js';
import { log } from '../src/sillytavern/log.js';

/**
 * ============================================================================
 * VectFox KEYWORD SYSTEM
 * ============================================================================
 * Keyword extraction and boosting for vector search.
 *
 * EXTRACTION LEVELS:
 *   - off: No auto-extraction, only manual/WI trigger keys
 *   - minimal: Title only (first line), max 3 keywords
 *   - balanced: Header area (first 300 chars), max 8 keywords
 *   - aggressive: Full text scan, max 15 keywords
 *
 * FREQUENCY-BASED WEIGHTING:
 *   Words that appear more often get higher weights.
 *   Formula: baseWeight + (frequency - minFreq) * 0.1
 *   Example: base 1.5x, word appears 5x (min 2) → 1.5 + (5-2)*0.1 = 1.8x
 *
 * BOOST MATH (Additive):
 *   Each keyword has a weight (e.g., 1.5x, 2.0x, 3.0x).
 *   The boost above 1.0 is added together:
 *     - "magic" (1.5x) + "divine" (2.0x) = 1 + 0.5 + 1.0 = 2.5x total boost
 *
 * @version 4.0.0
 * ============================================================================
 */

/** Extraction level configurations */
export const EXTRACTION_LEVELS = {
    off: {
        label: 'Off',
        description: 'No auto-extraction, only WI trigger keys',
        enabled: false,
    },
    minimal: {
        label: 'Minimal',
        description: 'First 1500 chars, max 5 keywords',
        enabled: true,
        headerSize: 1500,
        minFrequency: 1,
        maxKeywords: 5,
    },
    balanced: {
        label: 'Balanced',
        description: 'First 5000 chars, max 12 keywords',
        enabled: true,
        headerSize: 5000,
        minFrequency: 1,
        maxKeywords: 12,
    },
    aggressive: {
        label: 'Aggressive',
        description: 'Full text scan, max 15 keywords',
        enabled: true,
        headerSize: null, // null = full text
        minFrequency: 1,
        maxKeywords: 15,
    },
};

/** Default extraction level */
export const DEFAULT_EXTRACTION_LEVEL = 'balanced';

/** Default base weight for keywords */
export const DEFAULT_BASE_WEIGHT = 1.5;

/** Weight increment per frequency count above minimum */
const FREQUENCY_WEIGHT_INCREMENT = 0.1;

/** Maximum weight cap (prevent runaway weights) */
const MAX_KEYWORD_WEIGHT = 3.0;

/**
 * Balanced scan cap when summarization is enabled.
 * Derived from a typical English summarized chunk (~1328 chars) + 20% buffer.
 */
//const SUMMARY_BALANCED_HEADER_SIZE = 1600;
// for some reason, bigger value speed up retrival
const SUMMARY_BALANCED_HEADER_SIZE = 5000;

const CJK_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF]/;

// In Japanese mode, allow a small set of high-signal 1-char tokens (mostly RPG terms)
// plus frequency-based survival to avoid losing recurring key concepts.
// In Japanese mode, allow a small set of high-signal 1-char tokens 
// (RPG, School, and Slice-of-Life terms)
// plus frequency-based survival to avoid losing recurring key concepts.
const JAPANESE_SINGLE_CHAR_ALLOWLIST = new Set([
    // RPG Original
    '剣', '刀', '弓', '槍', '盾', '魔', '王', '神', '龍', '竜', '炎', '氷', '闇', '光', '聖',
    // RPG Magic & Combat
    '雷', '水', '風', '土', '毒', '幻', '魂', '気', '斧', '杖', '鞭', '鎧', '血', '傷', '罠',
    // RPG Locations & Entities
    '城', '塔', '森', '牢', '街', '村', '扉', '橋', '鬼', '獣', '霊', '姫', '帝', '敵', '賊',
    // RPG Items
    '鍵', '薬', '宝', '本', '鏡',
    
    // School & Academics
    '寮', '塾', '席', '部', '組', '噂', '罰',
    // Romance & Drama
    '恋', '愛', '涙', '嘘', '絆',
    // SoL Locations & Events
    '駅', '家', '店', '海', '祭',
    // SoL Items, Weather & Animals
    '傘', '雨', '雪', '桜', '猫', '犬', '茶', '酒',
    // Relationships
    '友', '親', '兄', '弟', '姉', '妹'
]);

// In Traditional Chinese mode, allow a focused set of high-signal 1-char tokens
// (RPG + school + slice-of-life), plus frequency-based survival.
const TRADITIONAL_CHINESE_SINGLE_CHAR_ALLOWLIST = new Set([
    // RPG Core
    '劍', '刀', '弓', '槍', '盾', '魔', '王', '神', '龍', '炎', '冰', '闇', '光', '聖',
    // RPG Combat & Elements
    '雷', '水', '風', '土', '毒', '幻', '魂', '氣', '斧', '杖', '鞭', '鎧', '血', '傷', '陣',
    // RPG Places & Entities
    '城', '塔', '森', '牢', '街', '村', '門', '橋', '鬼', '獸', '靈', '姬', '帝', '敵', '賊',
    // RPG Items
    '鑰', '藥', '寶', '書', '鏡',

    // School & Academics
    '班', '組', '課', '部', '社', '室', '寮', '罰',
    // Romance & Drama
    '戀', '愛', '淚', '謊', '絆',
    // SoL Locations & Events
    '家', '店', '海', '祭', '站',
    // SoL Items, Weather & Animals
    '傘', '雨', '雪', '櫻', '貓', '狗', '茶', '酒',
    // Relationships
    '友', '親', '兄', '弟', '姊', '妹',
]);

// In Simplified Chinese mode, allow a focused set of high-signal 1-char tokens
// (RPG + school + slice-of-life), plus frequency-based survival.
const SIMPLIFIED_CHINESE_SINGLE_CHAR_ALLOWLIST = new Set([
    // RPG Core
    '剑', '刀', '弓', '枪', '盾', '魔', '王', '神', '龙', '炎', '冰', '暗', '光', '圣',
    // RPG Combat & Elements
    '雷', '水', '风', '土', '毒', '幻', '魂', '气', '斧', '杖', '鞭', '铠', '血', '伤', '阵',
    // RPG Places & Entities
    '城', '塔', '森', '牢', '街', '村', '门', '桥', '鬼', '兽', '灵', '姬', '帝', '敌', '贼',
    // RPG Items
    '钥', '药', '宝', '书', '镜',

    // School & Academics
    '班', '组', '课', '部', '社', '室', '宿', '罚',
    // Romance & Drama
    '恋', '爱', '泪', '谎', '绊',
    // SoL Locations & Events
    '家', '店', '海', '祭', '站',
    // SoL Items, Weather & Animals
    '伞', '雨', '雪', '樱', '猫', '狗', '茶', '酒',
    // Relationships
    '友', '亲', '兄', '弟', '姐', '妹',
]);

function isCjkToken(token) {
    return typeof token === 'string' && CJK_CHAR_RE.test(token);
}

function shouldKeepCjkKeyword(token, frequency, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode) {
    if (!isCjkToken(token)) return true;
    if (token.length >= 2) return true;
    if (isJapaneseMode) {
        if (frequency >= 2) return true;
        return JAPANESE_SINGLE_CHAR_ALLOWLIST.has(token);
    }
    if (isTraditionalChineseMode) {
        if (frequency >= 2) return true;
        return TRADITIONAL_CHINESE_SINGLE_CHAR_ALLOWLIST.has(token);
    }
    if (isSimplifiedChineseMode) {
        if (frequency >= 2) return true;
        return SIMPLIFIED_CHINESE_SINGLE_CHAR_ALLOWLIST.has(token);
    }
    return false;
}

function isSummarizationEnabled(settings) {
    return ['openrouter', 'vllm'].includes(String(settings?.chat_provider || 'openrouter'));
}

function getEffectiveHeaderSize(config, level, settings) {
    if (!config?.headerSize) return null;

    // Keep existing behavior for non-summarized content.
    if (!isSummarizationEnabled(settings)) return config.headerSize;

    // Summarized text is denser and shorter; cap balanced scan to reduce noise/over-scan.
    if (level === 'balanced') {
        return Math.min(config.headerSize, SUMMARY_BALANCED_HEADER_SIZE);
    }

    return config.headerSize;
}

/**
 * Get combined stopwords (default + custom from settings)
 * Processes ST macros like {{char}}, {{user}} in custom stopwords
 * @param {object} settings - VectFox settings (optional)
 * @returns {Set<string>} Combined stopwords set
 */
function getCombinedStopwords(settings = null) {
    const mode = settings?.cjk_tokenizer_mode || getCjkTokenizerMode();
    const combined = buildStopSet(stopLocalesForMode(mode));

    // Add custom stopwords if settings provided
    if (settings && settings.custom_stopwords && typeof settings.custom_stopwords === 'string') {
        // Process ST macros ({{char}}, {{user}}, etc.) before splitting
        let processedString = substituteParams(settings.custom_stopwords);
        processedString = processedString.toLowerCase();

        const customWords = processedString
            .split(',')
            .map(w => w.trim())
            .filter(w => w.length > 0);

        for (const word of customWords) {
            combined.add(word);
        }
    }

    // Allowlists take precedence over stop words: a character explicitly kept
    // by a language allowlist must not be filtered as a stop word, regardless
    // of what the general stop-word lists say.
    for (const c of JAPANESE_SINGLE_CHAR_ALLOWLIST) combined.delete(c);
    for (const c of TRADITIONAL_CHINESE_SINGLE_CHAR_ALLOWLIST) combined.delete(c);
    for (const c of SIMPLIFIED_CHINESE_SINGLE_CHAR_ALLOWLIST) combined.delete(c);

    return combined;
}

/**
 * Extract keywords from a lorebook entry
 * @param {object} entry - Lorebook entry with key array
 * @param {object} settings - VectFox settings (optional)
 * @returns {string[]} Array of keywords
 */
export function extractLorebookKeywords(entry, settings = null) {
    if (!entry) return [];

    const stopwords = getCombinedStopwords(settings);
    const keywords = [];

    // Primary keys (trigger words)
    if (Array.isArray(entry.key)) {
        entry.key.forEach(k => {
            if (k && typeof k === 'string' && k.trim()) {
                const normalized = k.trim().toLowerCase();
                // Filter out stop words - they're too common to be useful as keywords
                // Don't stem: keys are often names/titles that should match exactly
                if (!stopwords.has(normalized) && normalized.length >= 2) {
                    keywords.push(normalized);
                }
            }
        });
    }

    // Secondary keys
    if (Array.isArray(entry.keysecondary)) {
        entry.keysecondary.forEach(k => {
            if (k && typeof k === 'string' && k.trim()) {
                const normalized = k.trim().toLowerCase();
                // Filter out stop words
                // Don't stem: keys are often names/titles that should match exactly
                if (!stopwords.has(normalized) && normalized.length >= 2) {
                    keywords.push(normalized);
                }
            }
        });
    }

    return [...new Set(keywords)]; // Dedupe
}

/**
 * Extract keywords from plain text with configurable extraction level
 *
 * Returns keywords with frequency-based weights.
 * Higher frequency = higher weight (capped at MAX_KEYWORD_WEIGHT)
 *
 * @param {string} text - Text to extract from
 * @param {object} options - Extraction options
 * @param {string} options.level - Extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @param {number} options.baseWeight - Base weight for keywords (default 1.5)
 * @returns {Array<{text: string, weight: number}>} Array of weighted keywords
 */

/**
 * Extract terms enclosed in CJK bracket markers: 【】「」『』
 * These are structural markers in Chinese/Japanese text that explicitly signal
 * named concepts — game systems, skills, titles, item names, etc.
 * Bracket-enclosed terms are treated as high-priority keywords regardless of
 * their frequency in the surrounding text.
 *
 * To extend for other bracket styles, add to the bracket character class below.
 * @param {string} text
 * @returns {string[]} Unique bracket-enclosed terms containing at least one CJK char
 */
function extractBracketTerms(text) {
    const results = [];
    // 【...】 — CJK concept/system marker (game skills, item names, system panels)
    // [...] with CJK content — ASCII square bracket concept markers (e.g. [勇者之劍])
    // 「」 and 『』 are dialogue SPEECH QUOTES — intentionally excluded.
    const bracketRe = /(?:\u3010([^\u3011\n]{2,20})\u3011|\[([^\]\n]{2,20})\])/g;
    let m;
    const cjkRe = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\uF900-\uFAFF]/;
    while ((m = bracketRe.exec(text)) !== null) {
        const inner = (m[1] ?? m[2]).trim();
        // Only include if the term contains at least one CJK character
        if (cjkRe.test(inner)) {
            results.push(inner);
        }
    }
    return [...new Set(results)];
}

export function extractTextKeywords(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    // Strip appended [KEYWORDS: ...] / [KEYWORD ...] tags (any case, colon optional)
    // to prevent bleed-through when the stored Qdrant text is re-processed.
    text = text.replace(/\s*\[keywords?[:\s][^\]]*\]/gi, '').trimEnd();
    // Strip structural markup tags: [User], [Character], [OOC], [location], [tag: content], etc.
    // Only strips brackets whose content is purely non-CJK (ASCII labels/formatting markers).
    // Brackets containing CJK characters (e.g. [勇者之劍]) are preserved for extractBracketTerms.
    text = text.replace(/\[[^\]\u4E00-\u9FFF\u3040-\u30FF\u3400-\u4DBF\uF900-\uFAFF]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();

    const level = options.level || DEFAULT_EXTRACTION_LEVEL;
    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const config = EXTRACTION_LEVELS[level];
    const effectiveHeaderSize = getEffectiveHeaderSize(config, level, options.settings);

    // If extraction is disabled, return empty
    if (!config || !config.enabled) {
        return [];
    }

    const stopwords = getCombinedStopwords(options.settings);
    const cjkTokenizerMode = getCjkTokenizerMode();
    const isJapaneseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.tiny_segmenter;
    const isTraditionalChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba_tw;
    const isSimplifiedChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba;

    // Step 1: Clean text - remove example citations and italics
    let cleanedText = text.replace(/\([^)]+\)/g, ' '); // Remove (parenthetical citations)
    cleanedText = cleanedText.replace(/\*[^*]+\*/g, ' '); // Remove *italicized examples*
    // Strip possessive 's before tokenization (e.g., "Strovolos's" → "Strovolos")
    cleanedText = cleanedText.replace(/'s\b/g, '');

    // Step 2: Determine scan area based on level
    const scanArea = effectiveHeaderSize
        ? cleanedText.substring(0, effectiveHeaderSize)
        : cleanedText;

    // Step 2.5: Detect capitalized words (likely proper nouns/names) before lowercasing
    // Match words that are capitalized mid-sentence or in titles
    const properNouns = new Set();
    const capitalizedPattern = /\b[A-Z][a-z]{3,}\b/g;
    let match;
    while ((match = capitalizedPattern.exec(scanArea)) !== null) {
        properNouns.add(match[0].toLowerCase());
    }

    // Step 3: Extract and count words (Latin + CJK words; supports Simplified + Traditional)
    const topicWords = (scanArea.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
        .concat(extractCJKTokens(scanArea));
    const wordCounts = new Map();

    for (const word of topicWords) {
        if (stopwords.has(word)) continue;
        // Don't stem proper nouns/names - they should match exactly
        const stemmed = properNouns.has(word) ? word : porterStemmer(word);
        wordCounts.set(stemmed, (wordCounts.get(stemmed) || 0) + 1);
    }

    // Step 4: Filter by minimum frequency and build weighted keywords
    const weightedKeywords = [];

    for (const [word, count] of wordCounts) {
        if (count >= config.minFrequency) {
            if (!shouldKeepCjkKeyword(word, count, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode)) continue;
            // Calculate weight based on frequency
            // More occurrences = higher weight
            const frequencyBonus = (count - config.minFrequency) * FREQUENCY_WEIGHT_INCREMENT;
            const weight = Math.min(MAX_KEYWORD_WEIGHT, baseWeight + frequencyBonus);

            weightedKeywords.push({ text: word, weight, frequency: count });
        }
    }

    // Step 5: Extract compound terms (e.g., "divine/time", "time_god")
    const compoundMatches = scanArea.match(/\b\w+[/_]\w+\b/gi) || [];
    for (const compound of compoundMatches) {
        const normalized = compound.toLowerCase().replace(/[/_]/g, '_');
        if (normalized.length >= 4) {
            // Compound terms get a slight weight bonus
            weightedKeywords.push({
                text: normalized,
                weight: Math.min(MAX_KEYWORD_WEIGHT, baseWeight + 0.2),
                frequency: 1,
            });
        }
    }

    // Step 5.5: Inject bracket-enclosed terms (【...】「...」『...』) as max-priority keywords.
    // These are explicit concept markers in CJK text — game systems, skills, titles, item names.
    // They bypass minFrequency: appearing once inside brackets is an intentional author signal.
    for (const term of extractBracketTerms(scanArea)) {
        if (!stopwords.has(term)) {
            weightedKeywords.push({ text: term, weight: MAX_KEYWORD_WEIGHT, frequency: 1 });
        }
    }

    // Step 6: Sort by weight (highest first), dedupe, and limit
    const seen = new Set();
    const result = [];

    weightedKeywords.sort((a, b) => b.weight - a.weight);

    for (const kw of weightedKeywords) {
        if (!seen.has(kw.text)) {
            seen.add(kw.text);
            result.push(kw);
            if (result.length >= config.maxKeywords) break;
        }
    }

    if (result.length > 0) {
        log.trace(`[VectFox Keyword Extraction] Extracted text keywords (${level} level): [${result.map(k => `${k.text}(${k.weight.toFixed(2)}x, freq:${k.frequency})`).join(', ')}] from: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    }

    return result;
}

/**
 * Extract keywords from chat messages using proper noun detection
 * Finds capitalized words mid-sentence (names, places, etc.)
 *
 * @param {string} text - Chat message text
 * @param {object} options - Extraction options
 * @param {number} options.baseWeight - Base weight for keywords (default 1.5)
 * @param {number} options.maxKeywords - Maximum keywords to return (default 8)
 * @returns {Array<{text: string, weight: number}>} Array of weighted keywords
 */
export function extractChatKeywords(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const maxKeywords = options.maxKeywords || 8;
    const stopwords = getCombinedStopwords(options.settings);

    const keywords = [];
    const seen = new Set();

    // Find capitalized words that aren't at sentence start
    // Looks for capital letter followed by lowercase, not preceded by sentence-ending punctuation
    const properNounRegex = /(?<![.!?]\s*)(?<=\s|^"|^'|^\*|"|'|\*)\b([A-Z][a-z]{2,})\b/g;
    let match;

    while ((match = properNounRegex.exec(text)) !== null) {
        const word = match[1].toLowerCase();

        // Skip common words that happen to be capitalized
        if (stopwords.has(word)) continue;

        // Don't stem proper nouns - preserve names/titles exactly
        // Skip if already seen
        if (seen.has(word)) continue;
        seen.add(word);

        keywords.push({ text: word, weight: baseWeight });

        if (keywords.length >= maxKeywords) break;
    }

    // Also extract CJK words (Simplified + Traditional)
    if (keywords.length < maxKeywords) {
        for (const word of extractCJKTokens(text)) {
            if (stopwords.has(word)) continue;
            if (seen.has(word)) continue;
            seen.add(word);
            keywords.push({ text: word, weight: baseWeight });
            if (keywords.length >= maxKeywords) break;
        }
    }

    if (keywords.length > 0) {
        log.trace(`[VectFox Keyword Extraction] Extracted chat keywords: [${keywords.map(k => `${k.text}(${k.weight.toFixed(2)}x)`).join(', ')}] from text: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    }

    return keywords;
}

/**
 * Extract keywords using BM25/TF-IDF scoring
 * Finds the most distinctive and important words in a text by:
 * 1. Splitting text into sentences (mini-corpus)
 * 2. Calculating TF-IDF for each word
 * 3. Returning top-scoring words as keywords
 *
 * This is better than proper noun extraction because it finds
 * contextually important words, not just capitalized names.
 *
 * Respects extraction levels:
 * - minimal: First 100 chars, max 3 keywords, min freq 1
 * - balanced: First 300 chars, max 8 keywords, min freq 2
 * - aggressive: Full text, max 15 keywords, min freq 3
 *
 * @param {string} text - Text to extract keywords from
 * @param {object} options - Extraction options
 * @param {string} options.level - Extraction level: 'minimal', 'balanced', 'aggressive' (default: 'balanced')
 * @param {number} options.baseWeight - Base weight for keywords (default 1.5)
 * @param {number} options.maxKeywords - Override max keywords (uses level default if not set)
 * @param {number} options.minWordLength - Minimum word length (default 3)
 * @returns {Array<{text: string, weight: number, tfidf: number}>} Weighted keywords
 */
export function extractBM25Keywords(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return [];

    // Strip appended [KEYWORDS: ...] / [KEYWORD ...] tags (any case, colon optional)
    // to prevent bleed-through when the stored Qdrant text is re-processed.
    text = text.replace(/\s*\[keywords?[:\s][^\]]*\]/gi, '').trimEnd();
    // Strip structural markup tags: [User], [Character], [OOC], [location], [tag: content], etc.
    // Only strips brackets whose content is purely non-CJK (ASCII labels/formatting markers).
    // Brackets containing CJK characters (e.g. [勇者之劍]) are preserved for extractBracketTerms.
    text = text.replace(/\[[^\]\u4E00-\u9FFF\u3040-\u30FF\u3400-\u4DBF\uF900-\uFAFF]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();

    // Get extraction level config
    const level = options.level || DEFAULT_EXTRACTION_LEVEL;
    const config = EXTRACTION_LEVELS[level];
    const effectiveHeaderSize = getEffectiveHeaderSize(config, level, options.settings);

    // If extraction is disabled, return empty
    if (!config || !config.enabled) return [];

    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const maxKeywords = options.maxKeywords || config.maxKeywords || 8;
    const minFrequency = config.minFrequency || 1;
    const minWordLength = options.minWordLength || 3;
    const stopwords = getCombinedStopwords(options.settings);
    const cjkTokenizerMode = getCjkTokenizerMode();
    const isJapaneseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.tiny_segmenter;
    const isTraditionalChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba_tw;
    const isSimplifiedChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba;

    // Apply header size limit (scan area)
    let scanText = text;
    if (effectiveHeaderSize && text.length > effectiveHeaderSize) {
        // For minimal/balanced, focus on the beginning of the text
        scanText = text.substring(0, effectiveHeaderSize);
        // Try to end at a word boundary
        const lastSpace = scanText.lastIndexOf(' ');
        if (lastSpace > effectiveHeaderSize * 0.8) {
            scanText = scanText.substring(0, lastSpace);
        }
    }

    // Strip possessive 's before tokenization
    scanText = scanText.replace(/'s\b/g, '');

    // Detect capitalized words (proper nouns/names) before lowercasing
    const properNouns = new Set();
    const capitalizedPattern = /\b[A-Z][a-z]{3,}\b/g;
    let match;
    while ((match = capitalizedPattern.exec(scanText)) !== null) {
        properNouns.add(match[0].toLowerCase());
    }

    // Split into sentences (mini-corpus for IDF calculation)
    // Includes Chinese sentence-ending punctuation 。！？
    const sentences = scanText
        .split(/[.!?。！？\n]+/)
        .map(s => s.trim())
        .filter(s => s.length > 2); // Skip very short fragments (CJK sentences can be short)

    if (sentences.length === 0) {
        // Fallback: treat whole text as one sentence
        sentences.push(scanText);
    }

    // Tokenize each sentence (Latin words + CJK words; Simplified + Traditional)
    const _cjkStripReBM25 = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
    const tokenizeSentence = (s) => {
        const cjkTokens = extractCJKTokens(s).filter(t => !stopwords.has(t));
        const latinTokens = s
            .replace(_cjkStripReBM25, ' ')
            .toLowerCase()
            .replace(/[^\w\s'-]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= minWordLength && !stopwords.has(t))
            .map(t => {
                // Don't stem proper nouns (names) - preserve them exactly
                if (properNouns.has(t)) return t;
                return t.length > 3 ? porterStemmer(t) : t;
            });
        return [...latinTokens, ...cjkTokens];
    };

    const sentenceTokens = sentences.map(tokenizeSentence);

    // Calculate document frequency (how many sentences contain each word)
    const docFreq = new Map();
    for (const tokens of sentenceTokens) {
        const uniqueTokens = new Set(tokens);
        for (const token of uniqueTokens) {
            docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
    }

    // Calculate term frequency across entire scan area
    const allTokens = sentenceTokens.flat();
    const termFreq = new Map();
    for (const token of allTokens) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Calculate TF-IDF for each unique word
    const numSentences = sentences.length;
    const tfidfScores = [];

    for (const [word, tf] of termFreq.entries()) {
        // Skip words below minimum frequency threshold
        if (tf < minFrequency) continue;
        if (!shouldKeepCjkKeyword(word, tf, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode)) continue;

        const df = docFreq.get(word) || 1;

        // IDF: log((N + 1) / (df + 1)) + 1 (smoothed to avoid log(0))
        const idf = Math.log((numSentences + 1) / (df + 1)) + 1;

        // TF-IDF score
        const tfidf = tf * idf;

        // Boost for capitalized words (likely proper nouns/names)
        // Check in original text to preserve case info
        const isCapitalized = text.includes(word.charAt(0).toUpperCase() + word.slice(1));
        const capitalBoost = isCapitalized ? 1.3 : 1.0;

        tfidfScores.push({
            text: word,
            tf: tf,
            idf: idf,
            tfidf: tfidf * capitalBoost,
            isCapitalized
        });
    }

    // Inject bracket-enclosed terms (【...】「...」『...』) that aren't already scored.
    // Assign a synthetic TF-IDF score above the current maximum so they survive the
    // top-N cut even when their natural frequency is 1.
    const scoredTerms = new Set(tfidfScores.map(s => s.text));
    const currentMax = tfidfScores.reduce((max, s) => Math.max(max, s.tfidf), 0);
    const bracketBoost = currentMax * 1.5 + 10;
    for (const term of extractBracketTerms(scanText)) {
        if (!stopwords.has(term) && !scoredTerms.has(term)) {
            tfidfScores.push({ text: term, tf: 1, idf: bracketBoost, tfidf: bracketBoost, isCapitalized: false });
        }
    }

    // Sort by TF-IDF score (highest first)
    tfidfScores.sort((a, b) => b.tfidf - a.tfidf);

    // Take top N and assign weights based on relative TF-IDF
    const topWords = tfidfScores.slice(0, maxKeywords);

    if (topWords.length === 0) return [];

    const maxTfidf = topWords[0].tfidf;
    const keywords = topWords.map(w => ({
        text: w.text,
        // Weight scales from baseWeight to baseWeight + 0.5 based on TF-IDF rank
        weight: baseWeight + (w.tfidf / maxTfidf) * 0.5,
        tfidf: w.tfidf
    }));

    if (keywords.length > 0) {
        log.trace(`[VectFox BM25 Keywords] Level=${level}, scanned ${scanText.length}/${text.length} chars, ${sentences.length} sentences → [${keywords.map(k => `${k.text}(${k.weight.toFixed(2)}x)`).join(', ')}]`);
    }

    return keywords;
}

/**
 * ============================================================================
 * ENHANCED KEYWORD EXTRACTION (Named Entity Detection + TF-IDF + Position)
 * ============================================================================
 *
 * Multi-signal approach that combines:
 * 1. Named Entity Detection (proper nouns, acronyms)
 * 2. TF-IDF scoring for distinctive terms
 * 3. Position weighting (title/header boost)
 *
 * This is more sophisticated than pure TF-IDF and catches important
 * named entities that might have low frequency.
 */

/**
 * Normalize a keyword to { text, weight } format
 * Handles both string and object formats
 * @param {string|object} kw - Keyword (string or { text, weight })
 * @param {number} defaultWeight - Default weight for string keywords
 * @returns {{ text: string, weight: number }}
 */
function normalizeKeyword(kw, defaultWeight = DEFAULT_BASE_WEIGHT) {
    if (typeof kw === 'string') {
        return { text: kw.toLowerCase(), weight: defaultWeight };
    }
    if (kw && typeof kw === 'object' && kw.text) {
        return {
            text: kw.text.toLowerCase(),
            weight: typeof kw.weight === 'number' ? kw.weight : defaultWeight
        };
    }
    return null;
}

/**
 * Check if query contains a keyword
 * @param {string} query - Search query (lowercased)
 * @param {string} keyword - Keyword to check (lowercased)
 * @returns {boolean}
 */
function queryHasKeyword(query, keyword) {
    if (!query || !keyword) return false;
    return query.includes(keyword);
}

/**
 * Maximum per-keyword contribution cap (prevents single high-weight keyword from dominating)
 */
const MAX_KEYWORD_CONTRIBUTION = 0.5;

/**
 * Scaling factors based on match count (diminishing returns)
 * This prevents spam where many low-relevance keywords could inflate scores
 */
const MATCH_SCALING_FACTORS = {
    1: 0.30,   // 1 match: 30% of raw boost
    2: 0.60,   // 2 matches: 60% of raw boost
    3: 1.00,   // 3+ matches: full boost
};

/**
 * Apply keyword boost with DIMINISHING RETURNS
 *
 * Enhanced boost calculation that prevents exploitation:
 * 1. Per-keyword contribution capped at 0.5 (prevents single high-weight keyword dominance)
 * 2. Scaling factor based on match count (1 match = 30%, 2 = 60%, 3+ = 100%)
 * 3. More keywords required for full boost effect
 *
 * Examples (with diminishing returns):
 *   - 1 match "magic" (1.5x): contribution=0.5, rawBoost=1.5, scale=30% → finalBoost=1.15x
 *   - 2 matches (1.5x each): contribution=0.5+0.5=1.0, rawBoost=2.0, scale=60% → finalBoost=1.6x
 *   - 3+ matches: full boost applied
 *
 * Spam Protection:
 *   - 1 match "magic" (3.0x): contribution=min(2.0,0.5)=0.5, rawBoost=1.5, scale=30% → 1.15x (not 3.0x!)
 *
 * @param {Array} results - Search results [{text, score, keywords, ...}]
 * @param {string} query - The search query
 * @param {object} options - Boost options
 * @param {boolean} options.diminishingReturns - Use diminishing returns (default: true)
 * @param {boolean} options.perKeywordCap - Cap per-keyword contribution (default: true)
 * @returns {Array} Results with boosted scores, sorted by score desc
 */
export function applyKeywordBoost(results, query, options = {}) {
    if (!results || !Array.isArray(results) || !query) return results;

    const {
        diminishingReturns = true,
        perKeywordCap = true,
    } = options;

    const queryLower = query.toLowerCase();

    log.verbose(`[VectFox Keyword Boost] Starting keyword boost for query: "${query}" (diminishing=${diminishingReturns}, cap=${perKeywordCap})`);

    const boosted = results.map(result => {
        const rawKeywords = result.keywords || result.metadata?.keywords || [];
        const matchedKeywords = [];
        let boostSum = 0;

        for (const kw of rawKeywords) {
            const normalized = normalizeKeyword(kw);
            if (!normalized) continue;

            if (queryHasKeyword(queryLower, normalized.text)) {
                matchedKeywords.push(normalized);

                // Calculate contribution with optional per-keyword cap
                const rawContribution = normalized.weight - 1.0;
                const contribution = perKeywordCap
                    ? Math.min(rawContribution, MAX_KEYWORD_CONTRIBUTION)
                    : rawContribution;

                boostSum += contribution;
            }
        }

        // Calculate raw boost
        const rawBoost = 1.0 + boostSum;

        // Apply diminishing returns scaling based on match count
        let finalBoost;
        if (diminishingReturns && matchedKeywords.length > 0) {
            const matchCount = Math.min(matchedKeywords.length, 3);
            const scalingFactor = MATCH_SCALING_FACTORS[matchCount];

            // Scale only the boost portion, not the base 1.0
            finalBoost = 1.0 + (boostSum * scalingFactor);
        } else {
            finalBoost = rawBoost;
        }

        if (matchedKeywords.length > 0) {
            const scaleInfo = diminishingReturns
                ? ` (raw=${rawBoost.toFixed(2)}x, scale=${(MATCH_SCALING_FACTORS[Math.min(matchedKeywords.length, 3)] * 100).toFixed(0)}%)`
                : '';
            log.trace(`[VectFox Keyword Boost] Result matched ${matchedKeywords.length} keyword(s): [${matchedKeywords.map(k => `${k.text}(${k.weight.toFixed(2)}x)`).join(', ')}] → boost: ${finalBoost.toFixed(2)}x${scaleInfo}, score: ${result.score.toFixed(4)} → ${(result.score * finalBoost).toFixed(4)}`);
        }

        return {
            ...result,
            score: Math.min(1.0, result.score * finalBoost), // Cap at 1.0
            originalScore: result.score,
            keywordBoost: finalBoost,
            rawBoost: rawBoost,
            matchedKeywords: matchedKeywords.map(k => k.text),
            matchedKeywordsWithWeights: matchedKeywords,
            keywordBoosted: matchedKeywords.length > 0,
            diminishingReturns: diminishingReturns,
        };
    });

    // Sort by boosted score
    boosted.sort((a, b) => b.score - a.score);

    const boostedCount = boosted.filter(r => r.keywordBoosted).length;
    log.verbose(`[VectFox Keyword Boost] Applied keyword boosts to ${boostedCount}/${boosted.length} results (diminishing=${diminishingReturns})`);

    return boosted;
}

/**
 * Calculate overfetch amount for keyword boosting
 * We fetch more results than requested so boosted items can surface
 * @param {number} topK - Requested number of results
 * @returns {number} Amount to actually fetch
 */
export function getOverfetchAmount(topK) {
    // Fetch 2x the requested amount (min 10, max 100)
    return Math.min(100, Math.max(10, topK * 2));
}

