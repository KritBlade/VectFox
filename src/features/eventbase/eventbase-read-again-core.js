/**
 * ============================================================================
 * READ A STRETCH AGAIN — pure logic
 * ============================================================================
 * Vectorize Content can read a stretch of the open chat again, from its Start
 * from message to its End message (InternalProject/Vectfox/plans/
 * executed/eventbase-read-range-again.md). Each window of the stretch replaces its
 * events, then StoryArc links the new events and decides again the events whose
 * links went into the stretch. This holds what the dialog shows before the run,
 * the progress panel's title for each step, and the verdict at the end.
 * eventbase-read-again.js reads and runs it.
 * ============================================================================
 */

import { counted } from '../../shared/counted.js';
import { windowSpanOf } from './eventbase-window-replacement-core.js';
import { isDecided } from './story-arc-links-core.js';
import { linkEstimateText, tokenCountText } from './story-arc-page-markup.js';

const formatCount = count => Number(count).toLocaleString('en-US');

/**
 * What the stretch's windows hold now: their events, which the run replaces; the events outside them whose StoryArc
 * links go to one of those, which it decides again; and the events that show whether the collection has had a link
 * pass: all but the undecided ones the windows hold, as a run of the stretch that stopped or failed before linking
 * leaves, since the run replaces those.
 *
 * @param {{start: number, end: number}[]} windows - The stretch's windows (windowsInStretch)
 * @param {object[]} storedEvents - The collection's events, with their story_links
 * @returns {{heldEvents: object[], eventsLinkingIn: object[], eventsShowingLinkPass: object[]}}
 */
export function describeStretch(windows, storedEvents) {
    const spans = new Set(windows.map(window => windowSpanOf({ source_window_start: window.start, source_window_end: window.end })));
    const heldEvents = storedEvents.filter(event => spans.has(windowSpanOf(event)));
    const heldIds = new Set(heldEvents.map(event => event.event_id));
    const eventsLinkingIn = storedEvents.filter(event => !heldIds.has(event.event_id)
        && (event.story_links ?? []).some(link => heldIds.has(link?.event_id)));
    const eventsShowingLinkPass = storedEvents.filter(event => !heldIds.has(event.event_id) || isDecided(event));
    return { heldEvents, eventsLinkingIn, eventsShowingLinkPass };
}

/**
 * The prompt tokens the stretch's extraction calls send: each window's prompt without its excerpt, and the stretch's
 * text once for every window that holds each message. The replies are left out, as their length depends on the model.
 *
 * @param {{windowCount: number, promptTokens: number, stretchTextTokens: number, windowSize: number, step: number}} measure -
 *   promptTokens: one window's prompt with no excerpt; stretchTextTokens: the text of the stretch's messages
 * @returns {number}
 */
export function extractionInputTokensOf({ windowCount, promptTokens, stretchTextTokens, windowSize, step }) {
    if (!windowCount) return 0;
    return Math.round(windowCount * promptTokens + stretchTextTokens * (windowSize / Math.max(1, step)));
}

/**
 * Why StoryArc links nothing after the stretch, or '' when it links: StoryArc off, a collection no link pass has
 * linked, or no link model.
 *
 * @param {{isStoryArcOn: boolean, hasLinkPass: boolean, isLinkModelReady: boolean}} state
 * @returns {string}
 */
export function linkWaitReasonOf({ isStoryArcOn, hasLinkPass, isLinkModelReady }) {
    if (!isStoryArcOn) return 'StoryArc is off, so no StoryArc links are decided.';
    if (!hasLinkPass) return 'This collection has had no StoryArc link pass, so its links wait for the StoryArc tab.';
    if (!isLinkModelReady) return 'The StoryArc link model is not set, so the links wait for the StoryArc tab.';
    return '';
}

/**
 * The progress panel's title for each step. With no linking, the reading is the one step.
 *
 * @param {boolean} willLink
 * @returns {{windows: string, newEvents: string, movedLinks: string}}
 */
export function readAgainStepTitles(willLink) {
    if (!willLink) return { windows: 'Reading again: windows', newEvents: '', movedLinks: '' };
    return {
        windows: 'Reading again, step 1 of 3: windows',
        newEvents: 'Reading again, step 2 of 3: linking new events',
        movedLinks: 'Reading again, step 3 of 3: deciding moved links again',
    };
}

/**
 * What the dialog asks before a stretch is read again: what it reads and replaces, on which model, and what that
 * costs. A price shows only where VectFox could read the model's (on manual OpenRouter); a prompt count leaves out
 * the replies, whose length depends on the model.
 *
 * @param {object} plan - describeReadingAgain's answer
 * @param {string} plan.collectionName
 * @param {number} plan.firstMessage - The stretch's first message, from 1, once snapped to whole windows
 * @param {number} plan.lastMessage
 * @param {number} plan.windowCount
 * @param {number} plan.heldCount - Events the windows hold now
 * @param {number} plan.linkingInCount - Events outside them whose links go into them
 * @param {{model: string, inputTokens: number|null, costUsd: number|null}} plan.extraction
 * @param {{model: string, estimate: object}|null} plan.links - estimate: estimateStoryLinkPass's answer; null when
 *   nothing is linked
 * @param {string} plan.waitReason - Why nothing is linked
 * @returns {{text: string, name?: string}[]}
 */
export function readAgainConfirmLines(plan) {
    const { extraction } = plan;
    const promptCost = extraction.costUsd === null ? 'price unknown' : `about $${extraction.costUsd.toFixed(2)} for the prompts`;
    const promptTokens = extraction.inputTokens === null ? '' : `, about ${tokenCountText(extraction.inputTokens)} prompt tokens`;
    const lines = [
        { text: 'Read again into:', name: plan.collectionName },
        { text: 'Messages, snapped to whole windows:', name: `${formatCount(plan.firstMessage)} to ${formatCount(plan.lastMessage)}` },
        { text: 'EventBase model:', name: extraction.model },
        { text: 'Extraction:', name: `${counted(plan.windowCount, 'window')}, one call each: ${promptCost}${promptTokens}` },
        { text: 'Events these windows hold now, each replaced:', name: counted(plan.heldCount, 'event') },
        { text: 'A window whose new read finds no event loses its events.' },
    ];
    if (plan.links) {
        lines.push(
            { text: 'StoryArc link model:', name: plan.links.model },
            { text: 'Links for the new events, about as many as now, and again for the events whose links go into these windows:', name: counted(plan.linkingInCount, 'event') },
            { text: 'Linking:', name: linkEstimateText(plan.links.estimate) },
        );
    } else if (plan.waitReason) {
        lines.push({ text: plan.waitReason });
    }
    return lines;
}

/**
 * The run's verdict: green only when every window was read and every event decided, else red, naming what failed or
 * was left.
 *
 * @param {object} reading - runEventBaseIngestion's result, with the stretch's window count
 * @param {number} reading.windowCount
 * @param {number} reading.windowsProcessed
 * @param {number} reading.eventsExtracted
 * @param {{newEvents: object, movedLinks: object}|null} links - linkEventsReadAgain's tallies; null when nothing was linked
 * @param {{isStopped: boolean, waitReason?: string, linkError?: string}} ending - waitReason: why nothing was linked;
 *   linkError: why linking could not start
 * @returns {{isSuccess: boolean, message: string}}
 */
export function readAgainVerdict(reading, links, { isStopped, waitReason = '', linkError = '' }) {
    const unreadWindows = Math.max(0, reading.windowCount - reading.windowsProcessed);
    const parts = [`Read ${reading.windowsProcessed} of ${counted(reading.windowCount, 'window')} again, ${counted(reading.eventsExtracted, 'event')} found`];
    let isSuccess = !isStopped && unreadWindows === 0 && !linkError;
    for (const [key, words] of [['newEvents', 'new events linked'], ['movedLinks', 'events with moved links decided again']]) {
        const tally = links?.[key];
        if (!tally) continue;
        const decided = tally.finishedCount - tally.failedCount;
        const notReached = tally.total - tally.finishedCount;
        parts.push(`${decided} of ${tally.total} ${words}`
            + (tally.failedCount ? `, ${tally.failedCount} failed` : '')
            + (notReached ? `, ${notReached} not reached` : ''));
        if (tally.failedCount || notReached || tally.stopReason) isSuccess = false;
    }
    let message = `${parts.join('; ')}.`;
    if (isStopped) message = `Stopped: ${message}`;
    const linkStop = links?.newEvents?.stopReason || links?.movedLinks?.stopReason;
    if (linkStop) message += ` Linking stopped: ${linkStop}`;
    if (linkError) message += ` Links were not decided: ${linkError}`;
    if (waitReason) message += ` ${waitReason}`;
    if (!isSuccess && (links || linkError)) message += ' The StoryArc tab\'s button decides the events left.';
    return { isSuccess, message };
}
