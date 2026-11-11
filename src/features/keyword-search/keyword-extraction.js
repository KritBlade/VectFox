import { porterStemmer, extractCJKTokens, getCjkTokenizerMode, CJK_TOKENIZER_MODES } from './bm25-scorer.js';
import { substituteParams } from '../../sillytavern/chat.js';
import { buildStopSet } from './stop-words.js';
import { stopLocalesForMode } from './language-modes.js';
import { log } from '../../sillytavern/log.js';

/**
 * ============================================================================
 * VectFox KEYWORD EXTRACTION
 * ============================================================================
 * The keywords a chunk is stored with, and the ones the chat retrieval picks from the chat: a lorebook entry's trigger
 * keys, and words picked from a text at its extraction level. On Qdrant a chunk's keywords join its sparse (BM25)
 * vector; the chat retrieval sets a chunk whose keywords hold one it picked to a full score.
 *
 * EXTRACTION LEVELS (EXTRACTION_LEVELS):
 *   - off: no extraction, only a lorebook entry's trigger keys
 *   - minimal: the first 1500 characters, at most 5 keywords
 *   - balanced: the first 5000 characters, at most 12 keywords
 *   - aggressive: the whole text, at most 15 keywords
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

/**
 * How extractTextKeywords orders the words it may keep, the first kept: by how often each appears, counted up to
 * TOP_RANK; a term in CJK brackets, an author's explicit marker, at TOP_RANK; a compound term such as "time_god" as a
 * word seen COMPOUND_RANK times. Words of the same rank keep their order in the text.
 */
const TOP_RANK = 16;
const COMPOUND_RANK = 3;

const CJK_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF]/;

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
    // [...] with CJK content — ASCII square bracket concept markers (e.g. [長劍])
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

/**
 * What both text extractors start from, or null when there is nothing to extract (no text, or a level that extracts
 * nothing): the text cleared for extraction, the level, its settings and how much of the text it scans. Cleared: the
 * keyword suffix Qdrant storage appends ("[KEYWORDS: …]", or a "[KEYWORD …]" tag, any case), so a stored text read
 * again does not feed its own keywords back, and bracketed markup holding no CJK, such as [User], [OOC] or
 * [tag: content]; brackets holding CJK, such as [長劍], stay for extractBracketTerms.
 *
 * @param {unknown} text
 * @param {string} [levelName]
 * @returns {{text: string, level: string, config: object, headerSize: number|null}|null}
 */
function extractionInput(text, levelName) {
    if (!text || typeof text !== 'string') return null;
    const level = levelName || DEFAULT_EXTRACTION_LEVEL;
    const config = EXTRACTION_LEVELS[level];
    if (!config?.enabled) return null;
    const cleared = text
        .replace(/\s*\[keywords?[:\s][^\]]*\]/gi, '').trimEnd()
        .replace(/\[[^\]\u4E00-\u9FFF\u3040-\u30FF\u3400-\u4DBF\uF900-\uFAFF]{1,30}\]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return { text: cleared, level, config, headerSize: config.headerSize ?? null };
}

/**
 * Extract keywords from plain text at an extraction level: the words of the part it scans, the most frequent first,
 * with compound terms and terms in CJK brackets, up to the level's count.
 *
 * @param {string} text - Text to extract from
 * @param {object} options - Extraction options
 * @param {string} options.level - Extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @param {object} [options.settings] - VectFox settings, for the custom stopwords
 * @returns {{text: string}[]}
 */
export function extractTextKeywords(text, options = {}) {
    const input = extractionInput(text, options.level);
    if (!input) return [];
    const { level, config, headerSize } = input;
    text = input.text;

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
    const scanArea = headerSize
        ? cleanedText.substring(0, headerSize)
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

    // Step 4: The words seen often enough, ranked by how often
    const rankedWords = [];

    for (const [word, count] of wordCounts) {
        if (count >= config.minFrequency) {
            if (!shouldKeepCjkKeyword(word, count, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode)) continue;
            rankedWords.push({ text: word, rank: Math.min(TOP_RANK, count - config.minFrequency + 1) });
        }
    }

    // Step 5: Compound terms (e.g., "divine/time", "time_god")
    const compoundMatches = scanArea.match(/\b\w+[/_]\w+\b/gi) || [];
    for (const compound of compoundMatches) {
        const normalized = compound.toLowerCase().replace(/[/_]/g, '_');
        if (normalized.length >= 4) {
            rankedWords.push({ text: normalized, rank: COMPOUND_RANK });
        }
    }

    // Step 5.5: Bracket-enclosed terms (【...】, or [...] holding CJK), at the top rank.
    // These are explicit concept markers in CJK text — game systems, skills, titles, item names.
    // They bypass minFrequency: appearing once inside brackets is an intentional author signal.
    for (const term of extractBracketTerms(scanArea)) {
        if (!stopwords.has(term)) {
            rankedWords.push({ text: term, rank: TOP_RANK });
        }
    }

    // Step 6: The highest ranks first, each word once, up to the level's count
    const seen = new Set();
    const kept = [];

    rankedWords.sort((a, b) => b.rank - a.rank);

    for (const word of rankedWords) {
        if (!seen.has(word.text)) {
            seen.add(word.text);
            kept.push(word);
            if (kept.length >= config.maxKeywords) break;
        }
    }

    if (kept.length > 0) {
        log.trace(`[VectFox Keyword Extraction] Extracted text keywords (${level} level): [${kept.map(word => `${word.text}(rank ${word.rank})`).join(', ')}] from: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    }

    return kept.map(word => ({ text: word.text }));
}

/**
 * Extract keywords from chat messages using proper noun detection
 * Finds capitalized words mid-sentence (names, places, etc.)
 *
 * @param {string} text - Chat message text
 * @param {object} options - Extraction options
 * @param {number} options.maxKeywords - Maximum keywords to return (default 8)
 * @returns {{text: string}[]}
 */
export function extractChatKeywords(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    const maxKeywords = options.maxKeywords || 8;
    const stopwords = getCombinedStopwords(options.settings);

    const keywords = [];
    const seen = new Set();
    // Each word once, past the stopwords (which also drop common words that happen to be capitalized).
    const keep = (word) => {
        if (stopwords.has(word) || seen.has(word)) return;
        seen.add(word);
        keywords.push({ text: word });
    };
    const isFull = () => keywords.length >= maxKeywords;

    // Capitalized words that aren't at sentence start: a capital letter followed by lowercase, not preceded by
    // sentence-ending punctuation. Not stemmed, so names and titles match exactly.
    const properNounRegex = /(?<![.!?]\s*)(?<=\s|^"|^'|^\*|"|'|\*)\b([A-Z][a-z]{2,})\b/g;
    let match;
    while (!isFull() && (match = properNounRegex.exec(text)) !== null) keep(match[1].toLowerCase());

    // Then CJK words (Simplified + Traditional)
    if (!isFull()) {
        for (const word of extractCJKTokens(text)) {
            keep(word);
            if (isFull()) break;
        }
    }

    if (keywords.length > 0) {
        log.trace(`[VectFox Keyword Extraction] Extracted chat keywords: [${keywords.map(k => k.text).join(', ')}] from text: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
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
 * @param {number} options.maxKeywords - Override max keywords (uses level default if not set)
 * @param {number} options.minWordLength - Minimum word length (default 3)
 * @returns {{text: string}[]} The top words by TF-IDF, the highest first
 */
export function extractBM25Keywords(text, options = {}) {
    const input = extractionInput(text, options.level);
    if (!input?.text) return [];
    const { level, config, headerSize } = input;
    text = input.text;

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
    if (headerSize && text.length > headerSize) {
        // For minimal/balanced, focus on the beginning of the text
        scanText = text.substring(0, headerSize);
        // Try to end at a word boundary
        const lastSpace = scanText.lastIndexOf(' ');
        if (lastSpace > headerSize * 0.8) {
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

    // Take the top N
    const topWords = tfidfScores.slice(0, maxKeywords);

    if (topWords.length > 0) {
        log.trace(`[VectFox BM25 Keywords] Level=${level}, scanned ${scanText.length}/${text.length} chars, ${sentences.length} sentences → [${topWords.map(w => `${w.text}(${w.tfidf.toFixed(2)})`).join(', ')}]`);
    }

    return topWords.map(w => ({ text: w.text }));
}
