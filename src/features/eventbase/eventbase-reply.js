/**
 * EventBase's reply step, which the manifest's generation interceptor runs before each reply (src/index.js,
 * vectfox_rearrangeChat). It empties the last turn's blocks first, so a turn that injects nothing never sends the last
 * turn's memory; then, while VectFox is on and the chat is long enough, it runs EventBase retrieval, the Summarizer
 * injection and ghosting. Each search is bounded: one that is slow or fails sends the reply without that memory and
 * says why, and one that settles past its bound publishes nothing (src/features/vector-backend/bounded-retrieval.js).
 * All three read the chat's collection in use, which the step asks the one route for once (collectionInUse); with none
 * in use they read none of the chat's events, and one red toast per reply says so, naming those switched on (D18 of
 * vectfox-multi-collection-per-chat.md).
 */
import { getCurrentChatId, substituteParams } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { setExtensionPrompt } from '../../sillytavern/prompt-injection.js';
import { getChatUUID } from '../../shared/collection-ids.js';
import { EVENTBASE_PROMPT_TAG, SUMMARIZER_PROMPT_TAG } from '../../shared/constants.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { resolveEventBaseRetrievalTimeoutMs } from '../../shared/retrieval-budget.js';
import { runBoundedRetrieval } from '../vector-backend/index.js';
import { collectionInUse, showNoCollectionInUse } from './eventbase-chat-collections.js';
import { runEventBaseRetrieval } from './eventbase-workflow.js';
import { isStoryArcActive } from './story-arc-core.js';
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
 * Say in red that this reply read none of the chat's events, naming what was switched on to read them, while the chat
 * has collections and none in use (showNoCollectionInUse). Once per reply.
 * @param {ReturnType<typeof collectionInUse>} inUse
 * @param {object} settings - VectFox settings
 * @param {boolean} hasSearch - Whether the reply searches EventBase: it has a query
 */
function warnOfReplyWithoutCollection(inUse, settings, hasSearch) {
    const readers = [
        ...(hasSearch ? ['retrieval'] : []),
        ...(settings.summarizer_injection_enabled ? ['Summarizer Injection'] : []),
        ...(hasSearch && isStoryArcActive(settings) ? ['StoryArc'] : []),
    ];
    if (!readers.length) return;
    const listed = new Intl.ListFormat('en', { type: 'conjunction' }).format(readers);
    showNoCollectionInUse(inUse, `this reply read none of its events: ${listed}`);
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
        // The chat's collection for the whole reply, from the one route every reader asks.
        const inUse = collectionInUse(settings);
        warnOfReplyWithoutCollection(inUse, settings, Boolean(queryText));
        if (queryText) {
            // The one path that can route through Agent Mode, whose planner call and query fanout run inside this
            // bound with their own user-set timeouts; the Agent Mode-inclusive budget keeps the bound from overruling
            // them.
            await runBoundedRetrieval(
                boundedRun => runEventBaseRetrieval({ chat, searchText: queryText, settings, chatUUID: getChatUUID(), inUse, boundedRun }),
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
        await runBoundedRetrieval(boundedRun => runSummarizerInjection(settings, inUse, boundedRun), {
            contextLabel: 'Summarizer',
            sourceName: 'recent event summaries',
            timeoutMessage: 'Summarizer injection timed out',
            settings,
        });

        // Blanks the oldest messages already vectorized from this prompt only, after the search text was read.
        try {
            applyGhosting(chat, settings, inUse);
        } catch (error) {
            log.error('VectFox Ghost: prompt wipe error (non-fatal):', error);
        }
    } catch (error) {
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectFox');
        log.error('VectFox: the reply step failed', error);
    }
}
