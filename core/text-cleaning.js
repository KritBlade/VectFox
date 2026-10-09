/**
 * ============================================================================
 * VectFox TEXT CLEANING
 * ============================================================================
 * Pre-vectorization text cleaning with regex patterns.
 * Strips HTML, metadata blocks, and custom tags before chunking.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { uuidv4 } from '../../../../utils.js';
import { log } from './log.js';

// ============================================================================
// BUILT-IN PRESETS
// ============================================================================

/**
 * Built-in cleaning patterns that users can enable
 */
export const BUILTIN_PATTERNS = {
    strip_font_tags: {
        id: 'strip_font_tags',
        name: 'Strip Font Tags (keep text)',
        pattern: '<font[^>]*>(.*?)</font>',
        replacement: '$1',
        flags: 'gi',
        builtin: true,
    },
    strip_color_spans: {
        id: 'strip_color_spans',
        name: 'Strip Color Spans (keep text)',
        pattern: '<span[^>]*style="[^"]*color[^"]*"[^>]*>(.*?)</span>',
        replacement: '$1',
        flags: 'gi',
        builtin: true,
    },
    strip_bold_italic: {
        id: 'strip_bold_italic',
        name: 'Strip Bold/Italic Tags (keep text)',
        pattern: '</?(?:b|i|u|em|strong)>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_hidden_divs: {
        id: 'strip_hidden_divs',
        name: 'Strip Hidden Divs',
        pattern: '<div[^>]*style="[^"]*display:\\s*none[^"]*"[^>]*>[\\s\\S]*?</div>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_details_blocks: {
        id: 'strip_details_blocks',
        name: 'Strip Details/Summary Blocks',
        pattern: '<details>[\\s\\S]*?</details>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_thinking_tags: {
        id: 'strip_thinking_tags',
        name: 'Strip <thinking> Tags',
        pattern: '<thinking>[\\s\\S]*?</thinking>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_tucao_tags: {
        id: 'strip_tucao_tags',
        name: 'Strip <tucao> Tags',
        pattern: '<tucao>[\\s\\S]*?</tucao>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_all_html: {
        id: 'strip_all_html',
        name: 'Strip ALL HTML Tags (keep text)',
        pattern: '<[^>]+>',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
    strip_mvu_update_variable: {
        id: 'strip_mvu_update_variable',
        name: 'Strip <UpdateVariable> Tags (MVU)',
        pattern: '<UpdateVariable>[\\s\\S]*?<\/UpdateVariable>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_combat_calculation: {
        id: 'strip_mvu_combat_calculation',
        name: 'Strip <combat_calculation> Tags (MVU)',
        pattern: '<combat_calculation>[\\s\\S]*?<\/combat_calculation>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_story_analysis: {
        id: 'strip_mvu_story_analysis',
        name: 'Strip <StoryAnalysis> Tags (MVU)',
        pattern: '<StoryAnalysis>[\\s\\S]*?<\/StoryAnalysis>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_combat_log: {
        id: 'strip_mvu_combat_log',
        name: 'Strip <combat_log> Tags (MVU)',
        pattern: '<combat_log>[\\s\\S]*?<\/combat_log>',
        replacement: '',
        flags: 'gm',
        builtin: true,
    },
    strip_mvu_game_system_tags: {
        id: 'strip_mvu_game_system_tags',
        name: 'Strip Game-System Guide/Protocol Tags (MVU)',
        pattern: '<(COT_Guide|JSONPatch_Format|CURRENT_VARIABLE_DATA|Reply_Request|Schema_Syntax|Update_Analysis_Detail|Social_Check_System|encounter_guide|Story_Analysis_Detail|Economic_System|Stat_System|Initiative_System|Trait_Behavior|World_Advancement_Protocol|DC_Determine_Guide|World_Building_Logic|Cognitive_Isolation|Character_Mind_Simulation_Protocol|Conflict_System|Personality_Guide|Intimacy_System|CharacterGenerationProtocol|battle_system_text_rpg|character_attributes_system|combat_calculation_detail|core-points-guide|monster_guide|familiar_system|progression_system|equipment_guide|MoneySystem|Ranking_System|Skill_and_Spell_System|Journey|Healing_System|World Simulation Operations|World_Info|world_faction_distribution|Erotic_Guide|combat_log_detail|Political_Ecosystem|Darkness_mode|Location_Generation_Protocol|Weather_System|Anti_Dramatization|map_coordinate|world_map)\\b[^>]*>[\\s\\S]*?</\\1\\s*>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    // Engine state-variable blocks (<RES_Variable>, <POSTUpdateVariable>, …) and
    // UI scaffolding (<reply_cast>, <choices>, the Scene Stats <styled> panel).
    // <background scene="…" /> is self-closing, so the tail accepts either "/>"
    // or a matched "</tag>" closer.
    strip_mvu_engine_tags: {
        id: 'strip_mvu_engine_tags',
        name: 'Strip Engine State & UI Tags (MVU)',
        pattern: '<(background|reply_cast|POSTUpdateVariable|RES_Variable|RES_POST_Variable|choices|classmate_trait_check|styled)\\b[^>]*?(?:/>|>[\\s\\S]*?</\\1\\s*>)',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
};

/**
 * Preset groups for quick selection
 */
export const CLEANING_PRESETS = {
    none: {
        id: 'none',
        name: 'None',
        description: 'No cleaning applied',
        patterns: [],
    },
    html_formatting: {
        id: 'html_formatting',
        name: 'Strip HTML Formatting',
        description: 'Removes font, color, bold/italic tags but keeps the text',
        patterns: ['strip_font_tags', 'strip_color_spans', 'strip_bold_italic'],
    },
    metadata_blocks: {
        id: 'metadata_blocks',
        name: 'Strip Metadata Blocks',
        description: 'Removes hidden divs, details/summary sections',
        patterns: ['strip_hidden_divs', 'strip_details_blocks'],
    },
    ai_reasoning: {
        id: 'ai_reasoning',
        name: 'Strip AI Reasoning Tags',
        description: 'Removes thinking, tucao, and similar tags',
        patterns: ['strip_thinking_tags', 'strip_tucao_tags'],
    },
    comprehensive: {
        id: 'comprehensive',
        name: 'Comprehensive Clean',
        description: 'All formatting, metadata, and reasoning tags',
        patterns: ['strip_font_tags', 'strip_color_spans', 'strip_bold_italic', 'strip_hidden_divs', 'strip_details_blocks', 'strip_thinking_tags', 'strip_tucao_tags'],
    },
    nuclear: {
        id: 'nuclear',
        name: 'Strip All HTML',
        description: 'Removes ALL HTML tags - plain text only',
        patterns: ['strip_all_html'],
    },
    mvu_game_maker: {
        id: 'mvu_game_maker',
        name: 'MVU Game Maker',
        description: 'Strips MVU game engine tags (state updates, combat logs, game-system guides, cast/stats/choices scaffolding) plus standard HTML formatting and AI reasoning tags',
        patterns: [
            'strip_font_tags',
            'strip_color_spans',
            'strip_bold_italic',
            'strip_hidden_divs',
            'strip_details_blocks',
            'strip_thinking_tags',
            'strip_tucao_tags',
            'strip_mvu_update_variable',
            'strip_mvu_combat_calculation',
            'strip_mvu_story_analysis',
            'strip_mvu_combat_log',
            'strip_mvu_game_system_tags',
            'strip_mvu_engine_tags',
        ],
    },
};

// ============================================================================
// SETTINGS MANAGEMENT
// ============================================================================

/**
 * Gets the cleaning settings from extension_settings
 * @returns {object} Cleaning settings
 */
export function getCleaningSettings() {
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    if (!extension_settings.vectfox.cleaning) {
        // Default: Custom preset with all MVU + standard patterns pre-checked
        // (equivalent to MVU Game Maker preset, but lets users toggle individual patterns)
        const defaultEnabled = Object.keys(BUILTIN_PATTERNS).filter(id => id !== 'strip_all_html');
        extension_settings.vectfox.cleaning = {
            selectedPreset: 'custom',
            customPatterns: [],
            enabledBuiltins: defaultEnabled,
        };
    }
    return extension_settings.vectfox.cleaning;
}

/**
 * Saves cleaning settings
 * @param {object} settings - Settings to save
 */
export function saveCleaningSettings(settings) {
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    extension_settings.vectfox.cleaning = settings;
}

/**
 * Gets all active patterns (builtin + custom)
 * @returns {Array<object>} Array of active pattern objects
 */
export function getActivePatterns() {
    const settings = getCleaningSettings();
    const patterns = [];

    // If using a preset, get its patterns
    if (settings.selectedPreset && settings.selectedPreset !== 'custom') {
        const preset = CLEANING_PRESETS[settings.selectedPreset];
        if (preset) {
            for (const patternId of preset.patterns) {
                if (BUILTIN_PATTERNS[patternId]) {
                    patterns.push(BUILTIN_PATTERNS[patternId]);
                }
            }
        }
    } else {
        // Custom mode - use enabled builtins + custom patterns
        for (const patternId of (settings.enabledBuiltins || [])) {
            if (BUILTIN_PATTERNS[patternId]) {
                patterns.push(BUILTIN_PATTERNS[patternId]);
            }
        }
        for (const custom of (settings.customPatterns || [])) {
            if (custom.enabled !== false) {
                patterns.push(custom);
            }
        }
    }

    return patterns;
}

// ============================================================================
// TEXT CLEANING
// ============================================================================

/**
 * Applies a single pattern to text
 * @param {string} text - Text to clean
 * @param {object} pattern - Pattern object with pattern, replacement, flags
 * @returns {string} Cleaned text
 */
function applyPattern(text, pattern) {
    try {
        const regex = new RegExp(pattern.pattern, pattern.flags || 'g');
        return text.replace(regex, pattern.replacement || '');
    } catch (e) {
        log.warn(`VectFox: Invalid regex pattern "${pattern.name || pattern.pattern}":`, e.message);
        return text;
    }
}

/**
 * Cleans text and returns null when nothing meaningful survives.
 *
 * Canonical entry point for content-preparation pipelines (lorebook,
 * character, document, URL, wiki, YouTube) — anywhere the pattern is
 * "clean a piece of content, then drop the unit entirely if nothing
 * is left." Bundles the clean + emptiness-check into one call so
 * callers can't accidentally skip the check.
 *
 * Returns null when:
 *   - input is falsy
 *   - input is not a string
 *   - cleaned result has zero non-whitespace characters
 *
 * Why a separate function vs. an `if (!cleanText(x).trim())` check at
 * each call site: the 2026-05-24 lorebook regression where a stripped
 * `<Intimacy_System>...</Intimacy_System>` block left an empty entry
 * whose `# <comment>` header + auto-appended `[KEYWORDS: ...]` still
 * built a "valid-looking" chunk. The fix needed an emptiness re-check
 * after cleanText — and every other content pipeline (character per-
 * field, document, URL, wiki, YouTube, wiki per-page) has the exact
 * same shape, the exact same bug, just with different surrounding
 * metadata. Centralizing the gate stops the pattern from drifting.
 *
 * DOES NOT replace `cleanText`. Use the original when you want the
 * cleaned string regardless of whether it's empty (e.g. per-message
 * cleaning fed to an LLM extractor like eventbase-extractor.js, where
 * an empty message just produces no events and isn't a chunk leak).
 *
 * @param {string} text - raw content
 * @returns {string|null} cleaned text, or null if empty/whitespace-only
 */
export function cleanContentOrNull(text) {
    if (typeof text !== 'string' || !text) return null;
    const cleaned = cleanText(text);
    return cleaned && cleaned.trim() ? cleaned : null;
}

/**
 * Cleans text using all active patterns
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
export function cleanText(text) {
    if (!text || typeof text !== 'string') return text;

    const patterns = getActivePatterns();
    if (patterns.length === 0) return text;

    let result = text;
    for (const pattern of patterns) {
        result = applyPattern(result, pattern);
    }

    // Clean up extra whitespace left behind
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
}

/**
 * Strip AI reasoning / planning blocks from a message so downstream consumers
 * (currently the agentic retrieval planner) read narrative, not the model's
 * chain-of-thought.
 *
 * Deliberately UNCONDITIONAL and independent of the user's vectorization
 * cleaning config (getActivePatterns): reasoning must never steer retrieval
 * planning, even when the user has cleaning set to "none" for vectorization,
 * and the default `strip_thinking_tags` pattern only matches <thinking> — not
 * the bare <think> tag ST actually emits, nor custom planning wrappers nested
 * inside it (e.g. <konatan_planning~>).
 *
 * Handles three shapes, narrative-AFTER-reasoning preserved in all of them:
 *   1. Paired standard blocks: <think>…</think>, <thinking>…, <reasoning>….
 *   2. Paired custom "planning" wrappers, e.g. <konatan_planning~>…</konatan_planning~>
 *      (model-injected planning scaffolds; tag names may contain ~ or -).
 *   3. An unterminated <think> that is never closed with </think> — common when the
 *      model only closes the inner planning wrapper. Here we strip the orphan TAG
 *      itself (step 3), NOT everything to end-of-string: an earlier version stripped
 *      <think>…$ and silently deleted the entire narrative reply, leaving the planner
 *      with an empty turn (observed 2026-06-02).
 *
 * @param {string} text
 * @returns {string} text with reasoning blocks removed
 */
export function stripReasoningBlocks(text) {
    if (!text || typeof text !== 'string') return text;
    const stripped = text
        // 1. Paired standard reasoning blocks. \1 keeps open/close matched.
        .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        // 2. Paired custom planning wrappers (tag name contains "planning",
        //    may carry ~ or - e.g. konatan_planning~). No \b — the name can end
        //    in ~, which is not a word char, so \b would fail before '>'.
        .replace(/<([A-Za-z][\w~-]*planning[\w~-]*)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        // 3. Remove orphan reasoning tags left behind (e.g. an unterminated
        //    <think> whose inner planning block was just stripped). Tag-only —
        //    never to EOS, so any narrative after the reasoning survives.
        .replace(/<\/?(?:think|thinking|reasoning)\b[^>]*>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    // Empty-guard / loosen: if stripping wiped EVERYTHING, the reasoning block
    // was malformed (e.g. an unterminated <think> with no inner close, wrapping
    // the whole reply). An empty turn is useless to the planner — it's strictly
    // better to hand back the raw reply than nothing. So fall back to the
    // original text with only the bare tags peeled off (content kept).
    if (stripped) return stripped;
    return text
        .replace(/<\/?[A-Za-z][\w~-]*[^>]*>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Game-system blocks the model appends AFTER the narrative (MVU engine output).
// <UpdateVariable> wraps <UpdateAnalysis> + <JSONPatch>; the inner two are also
// listed so a standalone (un-wrapped) occurrence is still caught. <combat_log>
// is empty most turns but pure noise to a retrieval planner. These overlap with
// BUILTIN_PATTERNS (strip_mvu_update_variable / strip_mvu_combat_log) but those
// are config-gated for vectorization; the planner strip must be unconditional,
// and the builtins don't cover <UpdateAnalysis>/<JSONPatch> by name.
const PLANNER_NOISE_TAGS = ['UpdateVariable', 'UpdateAnalysis', 'JSONPatch', 'combat_log'];

/**
 * Strip MVU game-system blocks (state-update JSON, combat logs) so the agentic
 * planner reads only the narrative, never engine bookkeeping. Unconditional,
 * like stripReasoningBlocks — independent of the vectorization cleaning config.
 *
 * Compose with stripReasoningBlocks to clean a chat turn for the planner:
 *   stripGameSystemBlocks(stripReasoningBlocks(mes))
 *
 * @param {string} text
 * @returns {string} text with game-system blocks removed
 */
export function stripGameSystemBlocks(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    for (const tag of PLANNER_NOISE_TAGS) {
        // \b after the name tolerates attributes; [\s\S]*? is non-greedy so
        // sibling blocks of the same tag aren't swallowed together.
        out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// cleanMessages removed 2026-05-24 — its only consumer was prepareChatContent
// in content-vectorization.js, which is itself gone. EventBase's per-message
// cleaning happens inline in eventbase-extractor.js via cleanText() directly.

// ============================================================================
// CUSTOM PATTERN MANAGEMENT
// ============================================================================

/**
 * Adds a custom cleaning pattern
 * @param {object} pattern - Pattern to add
 * @returns {string} The ID of the added pattern
 */
export function addCustomPattern(pattern) {
    const settings = getCleaningSettings();
    const id = pattern.id || uuidv4();

    const newPattern = {
        id,
        name: pattern.name || 'Custom Pattern',
        pattern: pattern.pattern,
        replacement: pattern.replacement || '',
        flags: pattern.flags || 'g',
        enabled: true,
        builtin: false,
    };

    settings.customPatterns = settings.customPatterns || [];
    settings.customPatterns.push(newPattern);
    saveCleaningSettings(settings);

    return id;
}

/**
 * Updates a custom pattern
 * @param {string} id - Pattern ID
 * @param {object} updates - Fields to update
 */
export function updateCustomPattern(id, updates) {
    const settings = getCleaningSettings();
    if (!settings.customPatterns || !Array.isArray(settings.customPatterns)) {
        return false;
    }

    const index = settings.customPatterns.findIndex(p => p.id === id);

    if (index !== -1 && index !== undefined) {
        settings.customPatterns[index] = {
            ...settings.customPatterns[index],
            ...updates,
        };
        saveCleaningSettings(settings);
        return true;
    }
    return false;
}

/**
 * Removes a custom pattern
 * @param {string} id - Pattern ID to remove
 */
export function removeCustomPattern(id) {
    const settings = getCleaningSettings();
    settings.customPatterns = (settings.customPatterns || []).filter(p => p.id !== id);
    saveCleaningSettings(settings);
}

/**
 * Toggles a builtin pattern
 * @param {string} id - Builtin pattern ID
 * @param {boolean} enabled - Whether to enable
 */
export function toggleBuiltinPattern(id, enabled) {
    const settings = getCleaningSettings();
    settings.enabledBuiltins = settings.enabledBuiltins || [];

    if (enabled && !settings.enabledBuiltins.includes(id)) {
        settings.enabledBuiltins.push(id);
    } else if (!enabled) {
        settings.enabledBuiltins = settings.enabledBuiltins.filter(x => x !== id);
    }

    saveCleaningSettings(settings);
}

// ============================================================================
// IMPORT/EXPORT
// ============================================================================

/**
 * Exports custom patterns as JSON
 * @returns {string} JSON string of custom patterns
 */
export function exportPatterns() {
    const settings = getCleaningSettings();
    return JSON.stringify(settings.customPatterns || [], null, 2);
}

/** Length cap on imported regex patterns. Legitimate patterns are well
 * under 200 chars; 300 leaves headroom without restricting normal use. */
const MAX_IMPORTED_PATTERN_LEN = 300;

/** Catastrophic-backtracking motifs commonly found in ReDoS payloads:
 *  - nested quantifier: (X+)+ or (X*)* — exponential on inputs that
 *    can be split multiple ways
 *  - quantified alternation with overlapping branches: (X|X)+ — same
 *    class of exponential ambiguity
 * These heuristics intentionally don't sweep up legitimate patterns
 * like `(foo)+` (single non-quantified group, then quantifier). */
const REDOS_MOTIF_RE = /\([^)]*[+*][^)]*\)\s*[+*]|\([^)]*\|[^)]*\)\s*[+*]/;

/**
 * Validate an imported pattern string for length + ReDoS shape before
 * it reaches `new RegExp(...)`. Returns { ok: true } if safe to import,
 * or { ok: false, reason: string } if it should be skipped.
 */
function _validateImportedPattern(pattern) {
    if (typeof pattern !== 'string') {
        return { ok: false, reason: 'pattern is not a string' };
    }
    if (pattern.length > MAX_IMPORTED_PATTERN_LEN) {
        return { ok: false, reason: `exceeds ${MAX_IMPORTED_PATTERN_LEN} char limit (got ${pattern.length})` };
    }
    if (REDOS_MOTIF_RE.test(pattern)) {
        return { ok: false, reason: 'matches a catastrophic-backtracking motif (nested quantifier or quantified alternation) — add manually if intended' };
    }
    return { ok: true };
}

/**
 * Imports patterns from JSON (supports both pattern arrays and full templates)
 * @param {string} json - JSON string of patterns or template
 * @returns {{success: boolean, count: number, isTemplate?: boolean, templateName?: string, error?: string, warnings?: string[]}}
 */
export function importPatterns(json) {
    try {
        const data = JSON.parse(json);
        const settings = getCleaningSettings();
        settings.customPatterns = settings.customPatterns || [];
        const warnings = [];

        // Check if this is a full template (has preset/enabledBuiltins/customPatterns)
        if (data.customPatterns && !Array.isArray(data)) {
            // Template format
            if (data.preset) {
                settings.selectedPreset = data.preset;
            }
            if (Array.isArray(data.enabledBuiltins)) {
                settings.enabledBuiltins = data.enabledBuiltins;
            }

            let count = 0;
            for (const pattern of (data.customPatterns || [])) {
                if (!pattern.pattern) continue;

                const validation = _validateImportedPattern(pattern.pattern);
                if (!validation.ok) {
                    warnings.push(`Pattern "${pattern.name || '(unnamed)'}" skipped: ${validation.reason}`);
                    continue;
                }

                const exists = settings.customPatterns.some(p => p.pattern === pattern.pattern);
                if (!exists) {
                    settings.customPatterns.push({
                        id: uuidv4(),
                        name: pattern.name || 'Imported Pattern',
                        pattern: pattern.pattern,
                        replacement: pattern.replacement || '',
                        flags: pattern.flags || 'g',
                        enabled: pattern.enabled !== false,
                        builtin: false,
                    });
                    count++;
                }
            }

            saveCleaningSettings(settings);
            return { success: true, count, warnings, isTemplate: true, templateName: data.name || 'Unnamed Template' };
        }

        // Array format (just patterns)
        if (!Array.isArray(data)) {
            return { success: false, count: 0, error: 'Invalid format - expected array or template object' };
        }

        let count = 0;
        for (const pattern of data) {
            if (!pattern.pattern) continue;

            const validation = _validateImportedPattern(pattern.pattern);
            if (!validation.ok) {
                warnings.push(`Pattern "${pattern.name || '(unnamed)'}" skipped: ${validation.reason}`);
                continue;
            }

            // Check for duplicates by pattern string
            const exists = settings.customPatterns.some(p => p.pattern === pattern.pattern);
            if (!exists) {
                settings.customPatterns.push({
                    id: uuidv4(),
                    name: pattern.name || 'Imported Pattern',
                    pattern: pattern.pattern,
                    replacement: pattern.replacement || '',
                    flags: pattern.flags || 'g',
                    enabled: true,
                    builtin: false,
                });
                count++;
            }
        }

        saveCleaningSettings(settings);
        return { success: true, count, warnings };

    } catch (e) {
        return { success: false, count: 0, error: e.message };
    }
}

/**
 * Tests a pattern against sample text
 * @param {string} pattern - Regex pattern
 * @param {string} flags - Regex flags
 * @param {string} replacement - Replacement string
 * @param {string} sampleText - Text to test against
 * @returns {{success: boolean, result?: string, error?: string}}
 */
export function testPattern(pattern, flags, replacement, sampleText) {
    try {
        const regex = new RegExp(pattern, flags || 'g');
        const result = sampleText.replace(regex, replacement || '');
        return { success: true, result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
