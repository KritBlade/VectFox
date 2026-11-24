/**
 * ============================================================================
 * READ A STRETCH AGAIN
 * ============================================================================
 * Vectorize Content reads a stretch of the open chat again, from its Start from
 * message to its End message, into the chat's collection in use
 * (InternalProject/Vectfox/plans/eventbase-read-range-again.md). Before the run
 * it shows what the stretch holds and what the run costs (describeReadingAgain);
 * runEventBaseIngestion reads its windows, each replacing its events; then
 * StoryArc links the new events and decides again the events whose links went
 * to a replaced one, and the progress panel ends with the verdict
 * (finishReadingAgain). The rules are in eventbase-read-again-core.js.
 * ============================================================================
 */

import { getContext } from '../../sillytavern/chat.js';
import { log } from '../../sillytavern/log.js';
import { getTokenCountAsync } from '../../sillytavern/tokenizers.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { describeChatConnectionProfile, readOpenRouterModelPrice } from '../llm-provider/index.js';
import { cleanText } from '../text-cleaning/index.js';
import { resolveStoryLinkLlmConfig } from './agentic-retrieval.js';
import { collectionInUse, noCollectionInUseText } from './eventbase-chat-collections.js';
import {
    describeStretch,
    extractionInputTokensOf,
    linkWaitReasonOf,
    readAgainStepTitles,
    readAgainVerdict,
} from './eventbase-read-again-core.js';
import { buildExtractionPrompt } from './eventbase-schema.js';
import { readStoredEvents } from './eventbase-store.js';
import { chatWindowsOf, windowsInStretch } from './eventbase-window-grid-core.js';
import { isStoryArcActive } from './story-arc-core.js';
import { LINK_PARALLEL_CALLS_DEFAULT, estimateStoryLinkPass, shouldLinkNewEvents } from './story-arc-links-core.js';
import { linkEventsReadAgain, readLinkModelPrice } from './story-arc-links.js';
import { readStoryLanguage } from './story-language.js';

/**
 * A model as the dialog names it: a connection profile's name and model, or the model on its manual provider.
 *
 * @param {{provider: string, model: string, profileId: string, feature: string, page: string}} choice
 * @returns {string}
 */
function _modelLabel({ provider, model, profileId, feature, page }) {
    if (provider === CONNECTION_PROFILE_PROVIDER) {
        const profile = describeChatConnectionProfile(profileId, { feature, page });
        if (profile.problem) return `a connection profile that cannot run: ${profile.problem}`;
        return `${profile.name}${profile.model ? ` (${profile.model})` : ''}, a connection profile`;
    }
    return `${model || 'no model set'} on ${provider === 'vllm' ? 'vLLM' : 'OpenRouter'}`;
}

/**
 * A token count, or null when SillyTavern's tokenizer could not count it.
 *
 * @param {string} text
 * @returns {Promise<number|null>}
 */
async function _tokensOf(text) {
    try {
        return await getTokenCountAsync(text);
    } catch (err) {
        log.warn('[EventBase] Could not count the tokens of a stretch read again, so the dialog shows no token count:', err);
        return null;
    }
}

/**
 * What reading a stretch of the open chat again would do and cost, for Vectorize Content to show first: the
 * collection in use, the stretch snapped to whole windows, the events its windows hold now, the events outside them
 * whose links go into them, the EventBase and StoryArc link models, their tokens, and a price only where VectFox can
 * read one.
 *
 * @param {object} params
 * @param {object} params.settings
 * @param {number} params.startFromMessage - From 1
 * @param {number|null} params.endAtMessage - From 1; null for the chat's end
 * @param {number} params.windowSize - The collection's window size
 * @returns {Promise<{problem: string}|object>} the plan, which finishReadingAgain takes, or why there is nothing to read
 */
export async function describeReadingAgain({ settings, startFromMessage, endAtMessage, windowSize }) {
    const inUse = collectionInUse(settings);
    const { collection } = inUse;
    if (!collection) {
        return { problem: noCollectionInUseText(inUse, 'there is nothing to read again') ?? 'This chat has no EventBase collection yet, so there is nothing to read again.' };
    }
    const messages = (getContext().chat ?? []).filter(message => message.mes && message.mes.trim().length > 0);
    const overlap = Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 0));
    const step = windowSize - overlap;
    const windows = windowsInStretch(chatWindowsOf({ messageCount: messages.length, windowSize, step }), { startFromMessage, endAtMessage });
    if (!windows.length) {
        return { problem: `No whole window of ${windowSize} messages lies between those messages, so there is nothing to read again.` };
    }

    let storedEvents;
    try {
        storedEvents = await readStoredEvents(collection.collectionId, settings);
    } catch (err) {
        log.warn(`[EventBase] Could not read ${collection.collectionId} to show what a stretch read again replaces:`, err);
        return { problem: 'Could not read the collection\'s events, so nothing was read again. See the console.' };
    }
    const { heldEvents, eventsLinkingIn, eventsShowingLinkPass } = describeStretch(windows, storedEvents);

    const firstMessage = windows[0].start;
    const lastMessage = windows[windows.length - 1].end;
    const storyLanguage = readStoryLanguage(messages, settings);
    const stretchText = messages.slice(firstMessage, lastMessage + 1)
        .map(message => `${message.name || ''}: ${cleanText(String(message.mes || ''))}`)
        .join('\n\n');
    const [promptTokens, stretchTextTokens] = await Promise.all([
        _tokensOf(buildExtractionPrompt('', settings.eventbase_max_events_per_window || 3, settings.eventbase_custom_prompt || '', storyLanguage.promptMode)),
        _tokensOf(stretchText),
    ]);
    const inputTokens = promptTokens === null || stretchTextTokens === null
        ? null
        : extractionInputTokensOf({ windowCount: windows.length, promptTokens, stretchTextTokens, windowSize, step });
    const eventBaseProvider = (settings.chat_provider || 'openrouter').toLowerCase();
    const extractionPrice = eventBaseProvider === 'openrouter' ? await readOpenRouterModelPrice(settings.chat_model) : null;

    const waitReason = linkWaitReasonOf({
        isStoryArcOn: isStoryArcActive(settings),
        hasLinkPass: shouldLinkNewEvents(eventsShowingLinkPass),
        isLinkModelReady: resolveStoryLinkLlmConfig(settings).ok,
    });
    const willLink = waitReason === '';
    const links = willLink
        ? {
            model: _modelLabel({
                provider: settings.story_arc_link_provider || 'openrouter', model: settings.story_arc_link_model,
                profileId: settings.story_arc_link_connection_profile_id, feature: 'StoryArc links', page: 'StoryArc',
            }),
            estimate: estimateStoryLinkPass(heldEvents.length + eventsLinkingIn.length, await readLinkModelPrice(settings), LINK_PARALLEL_CALLS_DEFAULT),
        }
        : null;

    return {
        problem: '',
        collectionId: collection.collectionId,
        collectionName: collection.name,
        firstMessage: firstMessage + 1,
        lastMessage: lastMessage + 1,
        windowCount: windows.length,
        heldCount: heldEvents.length,
        linkingInCount: eventsLinkingIn.length,
        extraction: {
            model: _modelLabel({
                provider: eventBaseProvider, model: settings.chat_model, profileId: settings.chat_connection_profile_id,
                feature: 'EventBase', page: 'Core',
            }),
            inputTokens,
            costUsd: extractionPrice && inputTokens !== null ? inputTokens * extractionPrice.input : null,
        },
        links,
        willLink,
        waitReason,
        stepTitles: readAgainStepTitles(willLink),
    };
}

/**
 * After the stretch's windows are read: link the new events and decide again the events whose links went to a
 * replaced one, when StoryArc links here, then end the progress panel with the verdict. Never throws; a link step that
 * could not start is in the verdict.
 *
 * @param {object} params
 * @param {object} params.result - runEventBaseIngestion's result for the stretch
 * @param {object} params.plan - describeReadingAgain's plan
 * @param {object} params.settings
 * @param {() => boolean} params.shouldStop - The run's Stop
 * @returns {Promise<{isSuccess: boolean, message: string}>}
 */
export async function finishReadingAgain({ result, plan, settings, shouldStop }) {
    let links = null;
    let linkError = '';
    const hasEventsToDecide = (result.insertedEventIds?.length ?? 0) + (result.eventIdsWithMovedLinks?.length ?? 0) > 0;
    if (plan.willLink && hasEventsToDecide && !shouldStop()) {
        try {
            links = await linkEventsReadAgain({
                collectionId: plan.collectionId,
                newEventIds: result.insertedEventIds ?? [],
                eventIdsWithMovedLinks: result.eventIdsWithMovedLinks ?? [],
                settings,
                shouldStop,
                stepTitles: plan.stepTitles,
            });
        } catch (err) {
            log.warn('[EventBase] The links of a stretch read again could not be decided:', err);
            linkError = err?.message || String(err);
        }
    }
    const verdict = readAgainVerdict({ ...result, windowCount: plan.windowCount }, links, { isStopped: shouldStop(), waitReason: plan.waitReason, linkError });
    log.lifecycle(`[EventBase] Stretch read again: ${verdict.message}`);
    progressTracker.complete(verdict.isSuccess, verdict.message);
    return verdict;
}
