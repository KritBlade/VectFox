/**
 * ============================================================================
 * STORY ARC LINKS
 * ============================================================================
 * Writes the links between story events. A pass from the StoryArc tab links a
 * chat's stored events, and each new event gets its links after it joins; after
 * a stretch of the chat is read again, its new events are linked in the open and
 * the events whose links went into it are decided again. One decision needs only
 * stored vectors and text, not other links, so decisions run in parallel. Each is
 * stored as it finishes, so a stopped pass keeps its work.
 * A collection's links can also be saved to a file, put back, deleted, or moved off the events
 * Compact collection removes, with no LLM call.
 *
 * Pure logic lives in story-arc-links-core.js.
 * ============================================================================
 */

import { fetchPortableChunks } from '../collections/index.js';
import { exportFileHeader } from '../../shared/export-file-header.js';
import { resolveStoryArcMaxTokens } from '../../shared/retrieval-budget.js';
import { updateChunkMetadata } from '../vector-backend/index.js';
import { searchEventCollection } from './eventbase-search.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { LLM_CALL_FEATURES, readOpenRouterModelPrice } from '../llm-provider/index.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { log } from '../../sillytavern/log.js';
import { callLlmForJson, resolveStoryLinkLlmConfig } from './agentic-retrieval.js';
import { collectionInUse, noCollectionInUseText } from './eventbase-chat-collections.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { isStoryArcActive } from './story-arc-core.js';
import {
    LINK_NEAREST_COUNT,
    LINK_PARALLEL_CALLS_DEFAULT,
    LINK_PARALLEL_CALLS_MAX,
    STORY_LINK_PROMPT,
    buildStoryLinkMessage,
    buildStoryLinksFile,
    earlierEventsOf,
    estimateStoryLinkPass,
    inTimelineOrder,
    measureStoryLinkCoverage,
    mergeLinkCandidates,
    nearestByVector,
    planStoryLinkDeletes,
    planStoryLinkWrites,
    readStoryLinks,
    readStoryLinksFile,
    shouldLinkNewEvents,
} from './story-arc-links-core.js';
import { listStoryEvents } from './story-arc-retrieval.js';

/** A thinking model's slowest calls took over 200 seconds on one pass, and a failed call gets one more try. */
const LINK_TIMEOUT_MS = 180000;
const LINK_ATTEMPTS = 2;
/** This many failures in a row mean the model or connection is down, so a pass stops rather than failing every event. */
const MAX_CONSECUTIVE_FAILURES = 10;
/** More new events than this wait for the StoryArc button, so a large import never spends without showing its cost. */
const NEW_EVENT_LINK_LIMIT = 50;
const NEW_EVENT_PARALLEL_CALLS = 3;
/** Links put back from a file or deleted at once: database writes with no LLM call, as many as a pass's most. */
const LINK_WRITES_AT_ONCE = LINK_PARALLEL_CALLS_MAX;
/** Hits a new event's candidates come from. Older events far outnumber newer ones, so few hits are lost as later events. */
const NEW_EVENT_POOL_SIZE = 40;

/** One LLM decision, without storing it. Events with nothing earlier need no call. */
async function _decideLinks(event, candidates, llmConnection, settings) {
    if (!candidates.length) return { links: [], droppedCount: 0 };
    const reply = await generationRateLimiter.execute(
        () => callLlmForJson({
            systemPrompt: STORY_LINK_PROMPT,
            userMessage: buildStoryLinkMessage(event, candidates),
            llmConnection,
            timeoutMs: LINK_TIMEOUT_MS,
            maxTokens: resolveStoryArcMaxTokens(settings),
            contextLabel: 'StoryArc links',
            feature: LLM_CALL_FEATURES.storyArc,
        }),
        generationRateLimitSettings(settings),
        'story-links',
    );
    return readStoryLinks(reply, candidates);
}

/**
 * Run `work`, trying once more after a failure, unless the model is invalid, which no retry can fix.
 *
 * @param {() => Promise<any>} work
 * @param {string} description - What failed, for the log
 * @returns {Promise<any>} what `work` returned
 * @throws the last error
 */
async function _tryTwice(work, description) {
    let lastError;
    for (let attempt = 1; attempt <= LINK_ATTEMPTS; attempt++) {
        try {
            return await work();
        } catch (err) {
            lastError = err;
            if (isInvalidModelConfigError(err)) break;
            log.warn(`[VectFox-StoryArc] ${description} failed on attempt ${attempt} of ${LINK_ATTEMPTS}:`, err);
        }
    }
    throw lastError;
}

/**
 * Decide and store events' links in parallel, each stored as it finishes. A failed
 * event stays undecided. Stops on an invalid model, which it reports, or a run of failures.
 *
 * @param {object} params
 * @param {object[]} params.events - The events to link
 * @param {number} params.parallelCalls
 * @param {(event: object) => Promise<object[]>|object[]} params.findCandidates - What an event chooses links from; may throw
 * @param {string} params.collectionId
 * @param {object} params.llmConnection
 * @param {object} params.settings
 * @param {() => boolean} [params.shouldStop] - Checked before each event
 * @param {(event: object, err: Error) => void} params.onEventFailed
 * @param {(tally: object) => void} [params.onEventFinished]
 * @returns {Promise<{finishedCount: number, linkedCount: number, failedCount: number, droppedLinkCount: number, stopReason: string}>}
 */
async function _linkEvents({ events, parallelCalls, findCandidates, collectionId, llmConnection, settings, shouldStop = () => false, onEventFailed, onEventFinished = () => {} }) {
    const tally = { finishedCount: 0, linkedCount: 0, failedCount: 0, droppedLinkCount: 0, stopReason: '' };
    let consecutiveFailures = 0;
    let next = 0;
    const linkOneEvent = async (event) => {
        const candidates = await findCandidates(event);
        const label = `The event at message ${event.source_window_start}`;
        const decision = await _tryTwice(() => _decideLinks(event, candidates, llmConnection, settings), `${label}: its link decision`);
        // Only the write is tried again here, so a failed write never pays for a second decision.
        await _tryTwice(() => updateChunkMetadata(collectionId, event._hash, { story_links: decision.links }, settings), `${label}: storing its links`);
        return decision;
    };
    const runWorker = async () => {
        while (next < events.length && !shouldStop() && !tally.stopReason) {
            const event = events[next++];
            try {
                const { links, droppedCount } = await linkOneEvent(event);
                tally.linkedCount += links.length > 0 ? 1 : 0;
                tally.droppedLinkCount += droppedCount;
                consecutiveFailures = 0;
            } catch (err) {
                tally.failedCount++;
                consecutiveFailures++;
                onEventFailed(event, err);
                if (isInvalidModelConfigError(err)) {
                    notifyInvalidModel(err.message);
                    tally.stopReason = err.message;
                } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    tally.stopReason = `${MAX_CONSECUTIVE_FAILURES} events failed in a row. Last error: ${err?.message || err}`;
                }
            }
            tally.finishedCount++;
            onEventFinished(tally);
        }
    };
    await Promise.all(Array.from({ length: Math.min(parallelCalls, events.length) }, runWorker));
    return tally;
}

/**
 * The link model's price per token, read only on manual OpenRouter (readOpenRouterModelPrice). Null otherwise; the
 * caller then shows tokens only.
 *
 * @param {object} settings
 * @returns {Promise<{input: number, output: number}|null>}
 */
export async function readLinkModelPrice(settings) {
    if ((settings.story_arc_link_provider || 'openrouter') !== 'openrouter') return null;
    return readOpenRouterModelPrice(settings.story_arc_link_model);
}

/** A collection's stored events with their stored vectors, in timeline order, for decisions made from those vectors. */
async function _readEventsWithVectors(collectionId, settings) {
    const chunks = await fetchPortableChunks(collectionId, settings);
    return inTimelineOrder(chunks
        .filter(chunk => chunk.metadata?.eventbase === true)
        .map(chunk => ({
            ...chunk.metadata,
            text: chunk.text,
            _hash: Number(chunk.hash),
            vector: Array.isArray(chunk.vector) ? Float32Array.from(chunk.vector) : null,
        })));
}

/**
 * What an event chooses links from: the earlier events nearest it by stored vector, and the latest before it.
 *
 * @param {object} event - With its stored vector
 * @param {object[]} orderedEvents - The collection's events, in timeline order
 * @returns {object[]}
 * @throws When the event's vector could not be read, as it would choose from recent events alone and count as decided
 */
function _candidatesFromStoredVectors(event, orderedEvents) {
    if (!event.vector) throw new Error('Its stored vector could not be read.');
    const earlierEvents = earlierEventsOf(event, orderedEvents);
    return mergeLinkCandidates(nearestByVector(event.vector, earlierEvents, LINK_NEAREST_COUNT), earlierEvents);
}

/**
 * The chat's collection in use and its stored events, or what stands in the way. StoryArc reads the collection in
 * use alone, from the one route every reader asks (collectionInUse): with none in use it has no events and no links,
 * and `noneInUse` holds the route's answer, for a caller to say why in its own words (D18 of
 * vectfox-multi-collection-per-chat.md).
 *
 * @param {object} settings
 * @returns {Promise<{problem: string, noneInUse?: object}|{collectionId: string, registryKey: string, name: string, events: object[]}>}
 */
export async function readChatStoryEvents(settings) {
    if (settings.vector_backend !== 'qdrant') return { problem: 'StoryArc links need the Qdrant backend.' };
    const inUse = collectionInUse(settings);
    const { collection } = inUse;
    if (!collection) {
        const why = noCollectionInUseText(inUse, 'StoryArc has no events or links here');
        return why ? { problem: why, noneInUse: inUse } : { problem: 'This chat has no EventBase collection yet.' };
    }
    const events = await listStoryEvents(collection.collectionId, settings);
    if (!events) return { problem: 'Could not read this chat\'s events. See the console.' };
    if (!events.length) return { problem: 'This chat has no stored events yet.' };
    return { collectionId: collection.collectionId, registryKey: collection.registryKey, name: collection.name, events };
}

/**
 * What a link pass on the current chat would do and cost, for the StoryArc tab to show first.
 *
 * @param {object} settings
 * @param {number} [parallelCalls] - Events decided at once, from the tab's Events at once
 * @returns {Promise<{problem: string, noneInUse?: object}|{collectionId: string, collectionName: string, coverage: object, allEstimate: object, undecidedEstimate: object, model: string}>}
 *   noneInUse: the chat has collections and none in use (collectionInUse), so the pass would send nothing
 */
export async function describeStoryLinkPass(settings, parallelCalls = LINK_PARALLEL_CALLS_DEFAULT) {
    const { problem, noneInUse, collectionId, name, events } = await readChatStoryEvents(settings);
    if (problem) return noneInUse ? { problem, noneInUse } : { problem };
    const llmConnection = resolveStoryLinkLlmConfig(settings);
    if (!llmConnection.ok) return { problem: llmConnection.problem ?? `Set the link model and its provider's key or URL first (${llmConnection.reason}).` };
    const coverage = measureStoryLinkCoverage(events);
    const price = await readLinkModelPrice(settings);
    return {
        collectionId,
        collectionName: name,
        coverage,
        allEstimate: estimateStoryLinkPass(coverage.totalCount, price, parallelCalls),
        undecidedEstimate: estimateStoryLinkPass(coverage.totalCount - coverage.decidedCount, price, parallelCalls),
        model: settings.story_arc_link_model,
    };
}

/**
 * How far the current chat's link pass has got, for the StoryArc tab's status line.
 *
 * @param {object} settings
 * @returns {Promise<{problem: string}|object>} the coverage, with the collection's name, or what stands in the way
 */
export async function readStoryLinkCoverage(settings) {
    const { problem, name, events } = await readChatStoryEvents(settings);
    return problem ? { problem } : { ...measureStoryLinkCoverage(events), collectionName: name };
}

/**
 * Link a collection's stored events, from the StoryArc tab. Shows progress and a Stop button.
 *
 * @param {object} params
 * @param {string} params.collectionId - The collection whose cost was shown
 * @param {object} params.settings
 * @param {boolean} params.shouldRelinkDecided - true redoes every event; false only those no pass has decided
 * @param {number} [params.parallelCalls] - Events decided at once, from the tab's Events at once
 * @returns {Promise<{decidedCount: number, failedCount: number, isStopped: boolean}>}
 */
export async function runStoryLinkPass({ collectionId, settings, shouldRelinkDecided, parallelCalls = LINK_PARALLEL_CALLS_DEFAULT }) {
    const llmConnection = resolveStoryLinkLlmConfig(settings);
    if (!llmConnection.ok) throw new Error(llmConnection.problem ?? `StoryArc link model is not ready: ${llmConnection.reason}`);

    let isStopRequested = false;
    progressTracker.show('Linking story events', 0, 'Events', { unitLabel: 'Events' });
    progressTracker.setCancelHandler(() => { isStopRequested = true; });
    progressTracker.updateProgress(0, 'Reading stored events and their vectors...');
    try {
        const events = await _readEventsWithVectors(collectionId, settings);
        const toLink = shouldRelinkDecided ? events : events.filter(event => !Array.isArray(event.story_links));

        progressTracker.show('Linking story events', toLink.length, 'Events', { unitLabel: 'Events' });
        progressTracker.setCancelHandler(() => { isStopRequested = true; });

        const { finishedCount, linkedCount, failedCount, droppedLinkCount, stopReason } = await _linkEvents({
            events: toLink,
            parallelCalls,
            findCandidates: event => _candidatesFromStoredVectors(event, events),
            collectionId,
            llmConnection,
            settings,
            shouldStop: () => isStopRequested,
            onEventFailed: (event, err) => progressTracker.addError(`Message ${event.source_window_start}: ${err?.message || err}`),
            onEventFinished: (tally) => {
                // The panel works out its speed and what is left from this count. Status goes last, since this call replaces it.
                progressTracker.updateEmbeddingProgress(tally.finishedCount, toLink.length);
                progressTracker.updateProgress(tally.finishedCount, `${tally.linkedCount} events linked, ${tally.failedCount} failed`);
            },
        });

        const decidedCount = finishedCount - failedCount;
        const outcome = `${decidedCount} of ${toLink.length} events decided, ${linkedCount} with links, ${failedCount} failed`
            + (droppedLinkCount ? `, ${droppedLinkCount} invalid links dropped` : '');
        log.lifecycle(`[VectFox-StoryArc] Link pass on ${collectionId}: ${outcome}${stopReason ? `. Stopped: ${stopReason}` : ''}`);
        if (stopReason) {
            progressTracker.complete(false, `Stopped: ${stopReason} (${outcome})`);
        } else if (isStopRequested) {
            progressTracker.complete(false, `Stopped by you: ${outcome}. Press the button again to link the rest.`);
        } else if (failedCount > 0) {
            progressTracker.complete(false, `${outcome}. Press the button again to retry those.`);
        } else {
            progressTracker.complete(true, outcome);
        }
        return { decidedCount, failedCount, isStopped: isStopRequested || Boolean(stopReason) };
    } catch (err) {
        progressTracker.addError(err?.message || String(err));
        progressTracker.complete(false, 'Link pass failed');
        throw err;
    } finally {
        progressTracker.clearCancelHandler();
    }
}

/**
 * Give an ingestion run's new events their links, in the background, in a collection
 * that has had a link pass (shouldLinkNewEvents); any other waits for Regenerate
 * links, which shows the cost first. Never throws, since ingestion has already
 * succeeded, and a failed event stays undecided for the StoryArc button to pick up.
 *
 * @param {object} params
 * @param {string} params.collectionId
 * @param {string[]} params.newEventIds - `event_id` of each event this run stored
 * @param {object} params.settings
 * @returns {Promise<void>}
 */
export async function linkNewStoryEvents({ collectionId, newEventIds, settings }) {
    try {
        if (!isStoryArcActive(settings) || !newEventIds.length) return;
        if (newEventIds.length > NEW_EVENT_LINK_LIMIT) {
            globalThis.toastr?.info(`${newEventIds.length} new events have no StoryArc links yet. Use the StoryArc tab to link them, where the cost is shown first.`, 'VectFox StoryArc');
            return;
        }
        const llmConnection = resolveStoryLinkLlmConfig(settings);
        if (!llmConnection.ok) {
            log.warn(`[VectFox-StoryArc] New events were not linked: ${llmConnection.problem ?? llmConnection.reason}`);
            return;
        }
        const events = await listStoryEvents(collectionId, settings);
        if (!events) return;
        const newIds = new Set(newEventIds);
        const newEvents = inTimelineOrder(events.filter(event => newIds.has(event.event_id)));
        if (!shouldLinkNewEvents(events.filter(event => !newIds.has(event.event_id)))) {
            log.domain('story_arc', 'lifecycle', `[VectFox-StoryArc] ${collectionId} has had no link pass, so its ${newEvents.length} new events wait for Regenerate links`);
            return;
        }
        const ordered = inTimelineOrder(events);
        const eventByHash = new Map(events.map(event => [event._hash, event]));
        const { failedCount, stopReason } = await _linkEvents({
            events: newEvents,
            parallelCalls: NEW_EVENT_PARALLEL_CALLS,
            findCandidates: async (event) => {
                const earlierEvents = earlierEventsOf(event, ordered);
                // Link candidates are not retrieval, so no similarity threshold cuts them.
                const { hashes } = earlierEvents.length ? await searchEventCollection(collectionId, event.text, NEW_EVENT_POOL_SIZE, settings, { threshold: 0 }) : { hashes: [] };
                const nearest = (hashes ?? [])
                    .map(hash => eventByHash.get(Number(hash)))
                    .filter(hit => hit && hit.source_window_start < event.source_window_start)
                    .slice(0, LINK_NEAREST_COUNT);
                return mergeLinkCandidates(nearest, earlierEvents);
            },
            collectionId,
            llmConnection,
            settings,
            onEventFailed: (event, err) => log.warn(`[VectFox-StoryArc] The new event at message ${event.source_window_start} was not linked:`, err),
        });
        if (failedCount) {
            log.warn(`[VectFox-StoryArc] ${failedCount} of ${newEvents.length} new events were not linked${stopReason ? `, and linking stopped: ${stopReason}` : ''}. The StoryArc tab's button can retry them.`);
        }
    } catch (err) {
        log.warn('[VectFox-StoryArc] Linking new events failed:', err);
    }
}

/**
 * After a stretch of the chat is read again (eventbase-read-range-again.md): link every new event it stored, with no
 * limit, then decide again each event that held a link to an event the run replaced, the new events among its
 * candidates (its D3). Each step has the progress panel to itself, under the title the caller gives it, with its own
 * count, and the caller gives the verdict. Decisions run in parallel, each stored as it finishes, so a stop keeps the
 * work done, and an event that failed or was not reached stays undecided for the StoryArc tab's button. A step that
 * stopped for an invalid model or a run of failures leaves the next one undone.
 *
 * @param {object} params
 * @param {string} params.collectionId
 * @param {string[]} params.newEventIds - event_id of each event the run stored
 * @param {string[]} params.eventIdsWithMovedLinks - event_id of each event that held a link to a replaced event
 * @param {object} params.settings
 * @param {() => boolean} params.shouldStop - Checked before each event
 * @param {{newEvents: string, movedLinks: string}} params.stepTitles - The progress panel's title for each step
 * @returns {Promise<{newEvents: object, movedLinks: object}>} each step's tally: total, finishedCount, linkedCount,
 *   failedCount, droppedLinkCount and stopReason
 * @throws When the link model is not ready, or the collection's events cannot be read
 */
export async function linkEventsReadAgain({ collectionId, newEventIds, eventIdsWithMovedLinks, settings, shouldStop, stepTitles }) {
    const llmConnection = resolveStoryLinkLlmConfig(settings);
    if (!llmConnection.ok) throw new Error(llmConnection.problem ?? `StoryArc link model is not ready: ${llmConnection.reason}`);
    const events = await _readEventsWithVectors(collectionId, settings);
    const newIds = new Set(newEventIds);
    const movedIds = new Set(eventIdsWithMovedLinks);
    const steps = [
        { key: 'newEvents', toLink: events.filter(event => newIds.has(event.event_id)) },
        { key: 'movedLinks', toLink: events.filter(event => movedIds.has(event.event_id) && !newIds.has(event.event_id)) },
    ];
    const tallies = {};
    let earlierStopReason = '';
    for (const { key, toLink } of steps) {
        if (shouldStop() || earlierStopReason) {
            tallies[key] = { total: toLink.length, finishedCount: 0, linkedCount: 0, failedCount: 0, droppedLinkCount: 0, stopReason: '' };
            continue;
        }
        progressTracker.show(stepTitles[key], toLink.length, 'Events', { unitLabel: 'Events' });
        const tally = await _linkEvents({
            events: toLink,
            parallelCalls: NEW_EVENT_PARALLEL_CALLS,
            findCandidates: event => _candidatesFromStoredVectors(event, events),
            collectionId,
            llmConnection,
            settings,
            shouldStop,
            onEventFailed: (event, err) => progressTracker.addError(`Message ${event.source_window_start}: ${err?.message || err}`),
            onEventFinished: (stepTally) => {
                progressTracker.updateEmbeddingProgress(stepTally.finishedCount, toLink.length);
                progressTracker.updateProgress(stepTally.finishedCount, `${stepTally.linkedCount} events linked, ${stepTally.failedCount} failed`);
            },
        });
        tallies[key] = { total: toLink.length, ...tally };
        earlierStopReason = tally.stopReason;
        log.lifecycle(`[VectFox-StoryArc] ${stepTitles[key]} on ${collectionId}: ${tally.finishedCount - tally.failedCount} of ${toLink.length} decided, ${tally.failedCount} failed${tally.stopReason ? `. Stopped: ${tally.stopReason}` : ''}`);
    }
    return tallies;
}

/**
 * How far a collection's link pass has got, for its row in the Database Browser.
 *
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<object|null>} the coverage, or null when its events could not be read, which the listing has logged
 */
export async function readCollectionLinkCoverage(collectionId, settings) {
    const events = await listStoryEvents(collectionId, settings);
    return events ? measureStoryLinkCoverage(events) : null;
}

/** A collection's stored events, for its links to be saved, matched against a file or deleted. */
async function _readCollectionEvents(collectionId, settings) {
    const events = await listStoryEvents(collectionId, settings);
    if (!events) throw new Error('Could not read this collection\'s events. See the console.');
    return events;
}

/**
 * A collection's links as a file of their own.
 *
 * @param {{id: string, name: string}} collection
 * @param {object} settings
 * @returns {Promise<object>} the file, whose `events` is empty when no event is decided
 */
export async function buildCollectionLinksFile(collection, settings) {
    const events = await _readCollectionEvents(collection.id, settings);
    return buildStoryLinksFile(events, collection, exportFileHeader());
}

/**
 * What a links file would write to a collection, without writing it.
 *
 * @param {unknown} file - Parsed JSON
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<object>} the plan from planStoryLinkWrites
 */
export async function planStoryLinksImport(file, collectionId, settings) {
    const linksByEventId = readStoryLinksFile(file);
    return planStoryLinkWrites(linksByEventId, await _readCollectionEvents(collectionId, settings));
}

/**
 * What deleting a collection's links would write, without writing it.
 *
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<{event: object, links: null}[]>} one write per decided event, from planStoryLinkDeletes
 */
export async function planStoryLinksDelete(collectionId, settings) {
    return planStoryLinkDeletes(await _readCollectionEvents(collectionId, settings));
}

/** How the progress window and the log name each kind of links write. */
const LINKS_IMPORT_WORDING = Object.freeze({ title: 'Importing StoryArc links', logName: 'Links import', doneWord: 'written', retry: 'Import the file again' });
const LINKS_DELETE_WORDING = Object.freeze({ title: 'Deleting StoryArc links', logName: 'Links delete', doneWord: 'cleared', retry: 'Press Delete links again' });
const LINKS_MOVE_WORDING = Object.freeze({ title: 'Moving StoryArc links', logName: 'Links move', doneWord: 'moved', retry: 'No event was removed. Press Compact collection again' });

/**
 * Store each write's links on its event, a few at a time. Shows progress and a Stop
 * button. Each event stores as it finishes, so a stopped run keeps its work, and
 * running it again finishes it.
 *
 * @param {{event: object, links: object[]|null}[]} writes
 * @param {string} collectionId
 * @param {object} settings
 * @param {{title: string, logName: string, doneWord: string, retry: string}} wording
 * @returns {Promise<{writtenCount: number, failedCount: number, isStopped: boolean}>}
 */
async function _storeLinksOnEvents(writes, collectionId, settings, wording) {
    let isStopRequested = false;
    let stopReason = '';
    let writtenCount = 0;
    let failedCount = 0;
    let consecutiveFailures = 0;
    let next = 0;
    progressTracker.show(wording.title, writes.length, 'Events', { unitLabel: 'Events' });
    progressTracker.setCancelHandler(() => { isStopRequested = true; });
    const runWorker = async () => {
        while (next < writes.length && !isStopRequested && !stopReason) {
            const { event, links } = writes[next++];
            try {
                await _tryTwice(() => updateChunkMetadata(collectionId, event._hash, { story_links: links }, settings), `The event at message ${event.source_window_start}: storing its links`);
                writtenCount++;
                consecutiveFailures = 0;
            } catch (err) {
                failedCount++;
                consecutiveFailures++;
                progressTracker.addError(`Message ${event.source_window_start}: ${err?.message || err}`);
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    stopReason = `${MAX_CONSECUTIVE_FAILURES} events failed in a row. Last error: ${err?.message || err}`;
                }
            }
            progressTracker.updateEmbeddingProgress(writtenCount + failedCount, writes.length);
            progressTracker.updateProgress(writtenCount + failedCount, `${writtenCount} events ${wording.doneWord}, ${failedCount} failed`);
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(LINK_WRITES_AT_ONCE, writes.length) }, runWorker));
        const outcome = `${writtenCount} of ${writes.length} events ${wording.doneWord}, ${failedCount} failed`;
        log.lifecycle(`[VectFox-StoryArc] ${wording.logName} on ${collectionId}: ${outcome}${stopReason ? `. Stopped: ${stopReason}` : ''}`);
        if (stopReason) {
            progressTracker.complete(false, `Stopped: ${stopReason} (${outcome})`);
        } else if (isStopRequested) {
            progressTracker.complete(false, `Stopped by you: ${outcome}. ${wording.retry} to finish.`);
        } else if (failedCount > 0) {
            progressTracker.complete(false, `${outcome}. ${wording.retry} to retry those.`);
        } else {
            progressTracker.complete(true, outcome);
        }
        return { writtenCount, failedCount, isStopped: isStopRequested || Boolean(stopReason) };
    } finally {
        progressTracker.clearCancelHandler();
    }
}

/**
 * Store a links import's links on their events.
 *
 * @param {{event: object, links: object[]}[]} writes - From planStoryLinksImport
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<{writtenCount: number, failedCount: number, isStopped: boolean}>}
 */
export function writeImportedStoryLinks(writes, collectionId, settings) {
    return _storeLinksOnEvents(writes, collectionId, settings, LINKS_IMPORT_WORDING);
}

/**
 * Delete a collection's links, leaving each event undecided. Its events stay as they are.
 *
 * @param {{event: object, links: null}[]} writes - From planStoryLinksDelete
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<{writtenCount: number, failedCount: number, isStopped: boolean}>}
 */
export function deleteStoryLinks(writes, collectionId, settings) {
    return _storeLinksOnEvents(writes, collectionId, settings, LINKS_DELETE_WORDING);
}

/**
 * Point the links that go to events Compact collection removes at the events that stay. It runs before any event
 * goes, so a stopped or failed move removes nothing.
 *
 * @param {{event: object, links: object[]}[]} writes - The plan's linkMoves, from planCompaction
 * @param {string} collectionId
 * @param {object} settings
 * @returns {Promise<{writtenCount: number, failedCount: number, isStopped: boolean}>}
 */
export function moveStoryLinks(writes, collectionId, settings) {
    return _storeLinksOnEvents(writes, collectionId, settings, LINKS_MOVE_WORDING);
}
