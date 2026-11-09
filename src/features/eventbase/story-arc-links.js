/**
 * ============================================================================
 * STORY ARC LINKS
 * ============================================================================
 * Writes the links between story events. A pass from the StoryArc tab links a
 * chat's stored events, and each new event gets its links after it joins. One
 * decision needs only stored vectors and text, not other links, so decisions run
 * in parallel. Each is stored as it finishes, so a stopped pass keeps its work.
 * A collection's links can also be saved to a file, put back or deleted, with no LLM call.
 *
 * Pure logic lives in story-arc-links-core.js.
 * ============================================================================
 */

import { fetchPortableChunks } from '../collections/index.js';
import { queryCollection, updateChunkMetadata } from '../vector-backend/index.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { log } from '../../sillytavern/log.js';
import { callLlmForJson, resolveStoryLinkLlmConfig } from './agentic-retrieval.js';
import { resolveActiveEventBaseCollection } from './eventbase-store.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { isStoryArcActive } from './story-arc-core.js';
import {
    LINK_NEAREST_COUNT,
    LINK_PARALLEL_CALLS,
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

/** A thinking model's reasoning counts against this, so it leaves room for that as well as the short reply. */
const LINK_MAX_TOKENS = 8200;
/** A thinking model's slowest calls took over 200 seconds on one pass, and a failed call gets one more try. */
const LINK_TIMEOUT_MS = 180000;
const LINK_ATTEMPTS = 2;
/** This many failures in a row mean the model or connection is down, so a pass stops rather than failing every event. */
const MAX_CONSECUTIVE_FAILURES = 10;
/** More new events than this wait for the StoryArc button, so a large import never spends without showing its cost. */
const NEW_EVENT_LINK_LIMIT = 50;
const NEW_EVENT_PARALLEL_CALLS = 3;
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
            maxTokens: LINK_MAX_TOKENS,
            contextLabel: 'StoryArc links',
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

/** An LLM price, per token, from OpenRouter's public model list. Null when unknown; the caller then shows tokens only. */
async function _readLinkModelPrice(settings) {
    if ((settings.story_arc_link_provider || 'openrouter') !== 'openrouter') return null;
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { data } = await response.json();
        const pricing = (data ?? []).find(model => model.id === settings.story_arc_link_model)?.pricing;
        // A link prompt is billed at the cache-write price where a model has one, as a whole pass on GPT-6 Luna showed.
        const input = Number(pricing?.input_cache_write ?? pricing?.prompt);
        const output = Number(pricing?.completion);
        return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
    } catch (err) {
        log.warn('[VectFox-StoryArc] Could not read the link model\'s price:', err);
        return null;
    }
}

/**
 * The current chat's collection and stored events, or what stands in the way.
 *
 * @param {object} settings
 * @param {object} [resolveOptions] - Passed on to resolveActiveEventBaseCollection
 * @returns {Promise<{problem: string}|{collectionId: string, registryKey: string, events: object[]}>}
 */
export async function readChatStoryEvents(settings, resolveOptions) {
    if (settings.vector_backend !== 'qdrant') return { problem: 'StoryArc links need the Qdrant backend.' };
    const collection = resolveActiveEventBaseCollection(settings, undefined, resolveOptions);
    if (!collection) return { problem: 'This chat has no EventBase collection yet.' };
    const events = await listStoryEvents(collection.collectionId, settings);
    if (!events) return { problem: 'Could not read this chat\'s events. See the console.' };
    if (!events.length) return { problem: 'This chat has no stored events yet.' };
    return { collectionId: collection.collectionId, registryKey: collection.registryKey, events };
}

/**
 * What a link pass on the current chat would do and cost, for the StoryArc tab to show first.
 *
 * @param {object} settings
 * @returns {Promise<{problem: string}|{collectionId: string, coverage: object, allEstimate: object, undecidedEstimate: object, model: string}>}
 */
export async function describeStoryLinkPass(settings) {
    const { problem, collectionId, events } = await readChatStoryEvents(settings);
    if (problem) return { problem };
    const llmConnection = resolveStoryLinkLlmConfig(settings);
    if (!llmConnection.ok) return { problem: `Set the link model and its provider's key or URL first (${llmConnection.reason}).` };
    const coverage = measureStoryLinkCoverage(events);
    const price = await _readLinkModelPrice(settings);
    return {
        collectionId,
        coverage,
        allEstimate: estimateStoryLinkPass(coverage.totalCount, price),
        undecidedEstimate: estimateStoryLinkPass(coverage.totalCount - coverage.decidedCount, price),
        model: settings.story_arc_link_model,
    };
}

/**
 * How far the current chat's link pass has got, for the StoryArc tab's status line.
 *
 * @param {object} settings
 * @returns {Promise<{problem: string}|object>} the coverage, or what stands in the way
 */
export async function readStoryLinkCoverage(settings) {
    const { problem, events } = await readChatStoryEvents(settings, { shouldLogResolution: false });
    return problem ? { problem } : measureStoryLinkCoverage(events);
}

/**
 * Link a collection's stored events, from the StoryArc tab. Shows progress and a Stop button.
 *
 * @param {object} params
 * @param {string} params.collectionId - The collection whose cost was shown
 * @param {object} params.settings
 * @param {boolean} params.shouldRelinkDecided - true redoes every event; false only those no pass has decided
 * @returns {Promise<{decidedCount: number, failedCount: number, isStopped: boolean}>}
 */
export async function runStoryLinkPass({ collectionId, settings, shouldRelinkDecided }) {
    const llmConnection = resolveStoryLinkLlmConfig(settings);
    if (!llmConnection.ok) throw new Error(`StoryArc link model is not ready: ${llmConnection.reason}`);

    let isStopRequested = false;
    progressTracker.show('Linking story events', 0, 'Events');
    progressTracker.setCancelHandler(() => { isStopRequested = true; });
    progressTracker.updateProgress(0, 'Reading stored events and their vectors...');
    try {
        const chunks = await fetchPortableChunks(collectionId, settings);
        const events = inTimelineOrder(chunks
            .filter(chunk => chunk.metadata?.eventbase === true)
            .map(chunk => ({
                ...chunk.metadata,
                text: chunk.text,
                _hash: Number(chunk.hash),
                vector: Array.isArray(chunk.vector) ? Float32Array.from(chunk.vector) : null,
            })));
        const toLink = shouldRelinkDecided ? events : events.filter(event => !Array.isArray(event.story_links));

        progressTracker.show('Linking story events', toLink.length, 'Events');
        progressTracker.setCancelHandler(() => { isStopRequested = true; });

        const { finishedCount, linkedCount, failedCount, droppedLinkCount, stopReason } = await _linkEvents({
            events: toLink,
            parallelCalls: LINK_PARALLEL_CALLS,
            findCandidates: (event) => {
                // Without its vector an event would choose from recent events alone, and count as decided.
                if (!event.vector) throw new Error('Its stored vector could not be read.');
                const earlierEvents = earlierEventsOf(event, events);
                return mergeLinkCandidates(nearestByVector(event.vector, earlierEvents, LINK_NEAREST_COUNT), earlierEvents);
            },
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
 * Give an ingestion run's new events their links, in the background. Never throws,
 * since ingestion has already succeeded, and a failed event stays undecided for
 * the StoryArc button to pick up.
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
            log.warn(`[VectFox-StoryArc] New events were not linked: ${llmConnection.reason}`);
            return;
        }
        const events = await listStoryEvents(collectionId, settings);
        if (!events) return;
        const newIds = new Set(newEventIds);
        const newEvents = inTimelineOrder(events.filter(event => newIds.has(event.event_id)));
        if (!shouldLinkNewEvents(events.filter(event => !newIds.has(event.event_id)))) {
            log.domain('story_arc', 'lifecycle', '[VectFox-StoryArc] This chat has had no link pass, so its new events wait for the StoryArc button');
            return;
        }
        const ordered = inTimelineOrder(events);
        const eventByHash = new Map(events.map(event => [event._hash, event]));
        const searchSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
        const { failedCount, stopReason } = await _linkEvents({
            events: newEvents,
            parallelCalls: NEW_EVENT_PARALLEL_CALLS,
            findCandidates: async (event) => {
                const earlierEvents = earlierEventsOf(event, ordered);
                const { hashes } = earlierEvents.length ? await queryCollection(collectionId, event.text, NEW_EVENT_POOL_SIZE, searchSettings) : { hashes: [] };
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
    return buildStoryLinksFile(events, collection, new Date().toISOString());
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
    progressTracker.show(wording.title, writes.length, 'Events');
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
        await Promise.all(Array.from({ length: Math.min(LINK_PARALLEL_CALLS, writes.length) }, runWorker));
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
