/**
 * EventBase's reply step, which the manifest's generation interceptor runs before each reply (src/index.js,
 * vectfox_rearrangeChat). It empties the last turn's blocks first, so a turn that injects nothing never sends the last
 * turn's memory; then, while VectFox is on and the chat is long enough, it runs EventBase retrieval, the Summarizer
 * injection and ghosting. Each search is bounded: one that is slow or fails sends the reply without that memory and
 * says why (src/features/vector-backend/bounded-retrieval.js).
 */
import { getCurrentChatId, substituteParams } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { setExtensionPrompt } from '../../sillytavern/prompt-injection.js';
import { getChatUUID } from '../../shared/collection-ids.js';
import { EVENTBASE_PROMPT_TAG, SUMMARIZER_PROMPT_TAG } from '../../shared/constants.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { resolveEventBaseRetrievalTimeoutMs } from '../../shared/retrieval-budget.js';
import { runBoundedRetrieval } from '../vector-backend/index.js';
import { runEventBaseRetrieval } from './eventbase-workflow.js';
import { applyGhosting, runSummarizerInjection } from './summarizer-injection.js';

/**
 * The text EventBase searches with: the last `settings.query` messages that are not system messages, newest first,
 * with their macros filled in.
 * @param {object[]} chat
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
function buildSearchQuery(chat, settings) {
    return chat
        .filter(message => !message.is_system)
        .reverse()
        .slice(0, settings.query)
        .map(message => substituteParams(message.mes))
        .join('\n')
        .trim();
}

/**
 * Empties the EventBase and Summarizer blocks. SillyTavern keeps an extension prompt until it is overwritten, so each
 * reply step starts here, before any of its exits: a turn VectFox skips must not send the last turn's memory.
 * @param {object} settings - VectFox settings
 */
export function clearInterceptorPrompts(settings) {
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
    setExtensionPrompt(SUMMARIZER_PROMPT_TAG, '', settings.position, settings.depth, false);
}

/**
 * The reply step: EventBase retrieval, the Summarizer injection and ghosting, on a reply that is not a quiet prompt.
 * @param {object[]} chat - The chat SillyTavern is about to send
 * @param {object} settings - VectFox settings
 * @param {string} type - SillyTavern's generation type
 * @returns {Promise<void>}
 */
export async function runEventBaseReplyStep(chat, settings, type) {
    try {
        if (type === 'quiet') {
            log.trace('VectFox: Skipping quiet prompt');
            return;
        }
        clearInterceptorPrompts(settings);

        if (!isVectFoxEnabled(settings)) {
            log.trace('VectFox: master switch OFF — skipping retrieval/injection');
            return;
        }

        log.lifecycle(`🐰 VectFox: reply step (type: ${type}, chat length: ${chat?.length || 0})`);

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            log.trace('VectFox: No chat selected');
            return;
        }

        const minChatLength = settings.min_chat_length ?? 0;
        if (minChatLength > 0 && chat.length < minChatLength) {
            log.warn(`⚠️ VectFox: Not enough messages to inject memory (${chat.length} < ${minChatLength})`);
            log.lifecycle(`   💡 You need at least ${minChatLength} messages before memory injection starts`);
            return;
        }

        const queryText = buildSearchQuery(chat, settings);
        if (queryText) {
            // The one path that can route through Agent Mode, whose planner call and query fanout run inside this
            // bound with their own user-set timeouts; the Agent Mode-inclusive budget keeps the bound from overruling
            // them.
            await runBoundedRetrieval(
                runEventBaseRetrieval({ chat, searchText: queryText, settings, chatUUID: getChatUUID() }),
                {
                    contextLabel: 'EventBase',
                    sourceName: 'event memory',
                    timeoutMessage: 'EventBase retrieval timed out',
                    settings,
                    timeoutMs: resolveEventBaseRetrievalTimeoutMs(settings),
                },
            );
        }

        // The most recent events every turn, apart from the search above. It empties its own block when it is off.
        await runBoundedRetrieval(runSummarizerInjection(settings), {
            contextLabel: 'Summarizer',
            sourceName: 'recent event summaries',
            timeoutMessage: 'Summarizer injection timed out',
            settings,
        });

        // Blanks the oldest messages already vectorized from this prompt only, after the search text was read.
        try {
            applyGhosting(chat, settings);
        } catch (error) {
            log.error('VectFox Ghost: prompt wipe error (non-fatal):', error);
        }
    } catch (error) {
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectFox');
        log.error('VectFox: the reply step failed', error);
    }
}
