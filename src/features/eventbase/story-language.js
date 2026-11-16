/**
 * ============================================================================
 * STORY LANGUAGE
 * ============================================================================
 * The language a story is written in, which its events and Agent Mode's searches
 * follow under every tokenizer mode: read once from the story's latest messages,
 * so a window or a reply in another language follows the story rather than its
 * own few lines. The choice of prompt it leads to lives in prompts-i18n.js
 * (storyLanguageOf).
 * ============================================================================
 */

import { cleanText, stripGameSystemBlocks, stripReasoningBlocks } from '../text-cleaning/index.js';
import { storyLanguageOf } from './prompts-i18n.js';

/** The latest messages a story's language is read from: enough that a few passages in another language do not decide it. */
const STORY_LANGUAGE_SAMPLE_MESSAGES = 200;

/**
 * The language a story's events and searches are written in, read from its latest messages as Agent Mode's planner
 * reads them: without thinking, game-system blocks or what Text Cleaning removes.
 *
 * @param {object[]} messages - Chat messages, each with `mes`
 * @param {object} settings
 * @returns {{promptMode: string, isCjkStory: boolean, chineseScript: 'traditional'|'simplified'|null}}
 */
export function readStoryLanguage(messages, settings) {
    const sample = messages
        .filter(message => !message.is_system)
        .slice(-STORY_LANGUAGE_SAMPLE_MESSAGES)
        .map(message => cleanText(stripGameSystemBlocks(stripReasoningBlocks(String(message.mes ?? '')))))
        .join('\n');
    return storyLanguageOf(settings.cjk_tokenizer_mode || 'intl', sample);
}
