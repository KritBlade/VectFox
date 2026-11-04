/**
 * ============================================================================
 * STORY ARC LINKS CORE
 * ============================================================================
 * Pure logic for the links between story events. An event stores backward links
 * to the earlier events it builds on, in its `story_links` payload field, so a
 * thread can be walked to its earliest event. One LLM call per event picks those
 * links from its nearest earlier events and the events just before it.
 *
 * `story_links` is absent until a link pass has decided the event, and an empty
 * array means it decided the event has no earlier step.
 *
 * @see InternalProject/Vectfox/plans/story-arc.md
 * ============================================================================
 */

import { packTimelineSortKey, parseEmbedText } from './eventbase-schema.js';

export const STORY_LINK_TYPE = Object.freeze({
    /** The next step of the same thread. */
    CONTINUES: 'continues',
    /** That earlier event made this one happen. */
    CAUSED_BY: 'caused_by',
    /** This event ties that earlier matter to a bigger plot. */
    REVEALS: 'reveals',
});

/** Every link type, for a walk that follows them all. */
export const ALL_STORY_LINK_TYPES = Object.freeze(Object.values(STORY_LINK_TYPE));

export const STORY_LINK_PROMPT =
    'You connect events in a long roleplay story into threads. A thread is one specific quest, mystery, project, conflict or relationship arc that moves forward step by step.\n'
    + 'You get one NEW event and a list of EARLIER events, oldest first, each with an id such as E3 and its message number. Find the earlier events that are direct previous steps of a thread the new event belongs to.\n'
    + 'For each link give its type:\n'
    + `- "${STORY_LINK_TYPE.CONTINUES}": the new event is the next step of the same thread.\n`
    + `- "${STORY_LINK_TYPE.CAUSED_BY}": that earlier event made the new event happen.\n`
    + `- "${STORY_LINK_TYPE.REVEALS}": the new event uncovers something that ties that earlier event to a bigger plot, or shows that two separate matters are one.\n`
    + 'Also name the thread in a few words, in the language of the story. The name must say what the thread is about, such as a named quest or the two people in a relationship arc.\n'
    + 'Rules:\n'
    + '- If you cannot name one specific thread that both events are steps of, there is no link.\n'
    + '- Sharing a person, place or topic is not a link. The protagonist is in nearly every event: his general promises, plans, authority or bond with his companions are not a thread.\n'
    + '- A vague follow-up is not a link: someone who read only the earlier event must be able to see that the new event picks up that same matter.\n'
    + '- At most 3 links, the strongest first.\n'
    + '- No links is a common and correct answer: many events start something new, or their earlier steps are not in this list.\n'
    + `Reply with JSON only: {"links": [{"id": "E3", "type": "${STORY_LINK_TYPE.CONTINUES}", "thread": "..."}]}`;

/** Nearest earlier events an LLM sees for one event. */
export const LINK_NEAREST_COUNT = 10;
/** Events just before it, so a scene can join up when its steps read differently. */
const LINK_RECENT_COUNT = 3;

/** Below this share of decided events, walks would stop at undecided events, so recipes do not use links. */
const USABLE_DECIDED_SHARE = 0.9;

/** Parallel LLM calls in a link pass, the same as EventBase's own import at its highest. A browser on plain HTTP sends at most 6 to one server at a time. */
export const LINK_PARALLEL_CALLS = 8;
/** Per event, measured on a 1,437-event pass with GPT-6 Luna at medium reasoning, from a browser on plain HTTP. */
const LINK_INPUT_TOKENS_PER_EVENT = 1810;
const LINK_OUTPUT_TOKENS_PER_EVENT = 320;
const LINK_PASS_SECONDS_PER_EVENT = 0.78;

/**
 * What a link pass would likely cost. Other models think more or less, so this is a guide.
 *
 * @param {number} eventCount
 * @param {{input: number, output: number}|null} pricePerToken - Null when the price is unknown
 * @returns {{eventCount: number, inputTokens: number, outputTokens: number, minutes: number, costUsd: number|null}}
 */
export function estimateStoryLinkPass(eventCount, pricePerToken) {
    const inputTokens = eventCount * LINK_INPUT_TOKENS_PER_EVENT;
    const outputTokens = eventCount * LINK_OUTPUT_TOKENS_PER_EVENT;
    return {
        eventCount,
        inputTokens,
        outputTokens,
        minutes: Math.ceil(eventCount * LINK_PASS_SECONDS_PER_EVENT / 60),
        costUsd: pricePerToken ? inputTokens * pricePerToken.input + outputTokens * pricePerToken.output : null,
    };
}

/**
 * Events in true chat order. Older events without a `timeline_sort_key` use their
 * window start on the same scale, so a mixed set still sorts as one sequence.
 *
 * @param {object[]} events
 * @returns {object[]} a new array
 */
export function inTimelineOrder(events) {
    const timelineValue = (event) => (typeof event.timeline_sort_key === 'number'
        ? event.timeline_sort_key
        : packTimelineSortKey(event.source_window_start ?? event.source_window_end, event.window_event_order));
    return [...events].sort((a, b) => timelineValue(a) - timelineValue(b));
}

/** @param {object} event @returns {boolean} whether a link pass has decided this event */
function isDecided(event) {
    return Array.isArray(event?.story_links);
}

/**
 * How far a collection's link pass has got.
 *
 * @param {object[]} events
 * @returns {{totalCount: number, decidedCount: number, linkedCount: number, hasUsableLinks: boolean}}
 *   `hasUsableLinks` is true when enough events are decided, and at least one has a link, for a walk to be useful.
 */
export function measureStoryLinkCoverage(events) {
    const decided = events.filter(isDecided);
    const linkedCount = decided.filter(event => event.story_links.length > 0).length;
    return {
        totalCount: events.length,
        decidedCount: decided.length,
        linkedCount,
        hasUsableLinks: linkedCount > 0 && decided.length >= events.length * USABLE_DECIDED_SHARE,
    };
}

/**
 * Whether older events are decided well enough for a new event's link pass to be
 * worth paying for. A chat that never had a link pass waits for the StoryArc button.
 *
 * @param {object[]} olderEvents - Stored events other than the new ones
 * @returns {boolean}
 */
export function shouldLinkNewEvents(olderEvents) {
    return olderEvents.filter(isDecided).length >= olderEvents.length * USABLE_DECIDED_SHARE;
}

/**
 * Events from windows before this event's, in timeline order. Events of the same
 * window are left out, since their order within a window says little.
 *
 * @param {object} event
 * @param {object[]} orderedEvents - All events, in timeline order
 * @returns {object[]}
 */
export function earlierEventsOf(event, orderedEvents) {
    return orderedEvents.filter(other => other.source_window_start < event.source_window_start);
}

/**
 * The events closest to a vector. Stored vectors have unit length, since Qdrant
 * normalizes them for cosine distance, so a dot product gives the cosine.
 *
 * @param {Float32Array} vector
 * @param {object[]} events - Each with `vector` as a Float32Array
 * @param {number} limit
 * @returns {object[]} closest first
 */
export function nearestByVector(vector, events, limit) {
    const nearest = [];
    for (const event of events) {
        const other = event.vector;
        if (other?.length !== vector.length) continue;
        let similarity = 0;
        for (let i = 0; i < vector.length; i++) similarity += vector[i] * other[i];
        if (nearest.length === limit && similarity <= nearest[limit - 1].similarity) continue;
        let position = nearest.length;
        while (position > 0 && nearest[position - 1].similarity < similarity) position--;
        nearest.splice(position, 0, { event, similarity });
        if (nearest.length > limit) nearest.pop();
    }
    return nearest.map(item => item.event);
}

/**
 * What an LLM chooses links from: the nearest earlier events and the events just
 * before this one, oldest first and without repeats.
 *
 * @param {object[]} nearestEvents - Earlier events closest to this event
 * @param {object[]} earlierEvents - All earlier events, in timeline order
 * @returns {object[]}
 */
export function mergeLinkCandidates(nearestEvents, earlierEvents) {
    const byHash = new Map([...nearestEvents, ...earlierEvents.slice(-LINK_RECENT_COUNT)].map(event => [event._hash, event]));
    return inTimelineOrder([...byHash.values()]);
}

/** One event as the link prompt shows it. */
function describeEventForLink(event) {
    const { summary, cause, result } = parseEmbedText(event.text);
    return `(message ${event.source_window_start}) ${summary ?? String(event.text ?? '').split('\n')[0]}`
        + (cause ? ` | CAUSE: ${cause}` : '')
        + (result ? ` | RESULT: ${result}` : '');
}

/**
 * The link prompt's user message. Candidates get ids E1..En, because their message
 * numbers read too much like list positions.
 *
 * @param {object} event
 * @param {object[]} candidates - Oldest first
 * @returns {string}
 */
export function buildStoryLinkMessage(event, candidates) {
    const listed = candidates.map((candidate, i) => `E${i + 1}: ${describeEventForLink(candidate)}`).join('\n');
    return `EARLIER:\n${listed}\n\nNEW:\n${describeEventForLink(event)}`;
}

/**
 * Read an LLM's link reply into `story_links`, strongest first. A link that names
 * no candidate or an unknown type is dropped and counted.
 *
 * @param {unknown} reply - Parsed JSON from the LLM
 * @param {object[]} candidates - The list its ids refer to
 * @returns {{links: {hash: number, type: string, thread: string}[], droppedCount: number}}
 * @throws {Error} when the reply has no `links` array, so a malformed reply never reads as "no links"
 */
export function readStoryLinks(reply, candidates) {
    if (!Array.isArray(reply?.links)) {
        throw new Error(`Link reply has no links array: ${JSON.stringify(reply)?.slice(0, 200)}`);
    }
    const links = [];
    const seenHashes = new Set();
    let droppedCount = 0;
    for (const item of reply.links) {
        const position = Number(/^E(\d+)$/.exec(String(item?.id ?? '').trim())?.[1]);
        const candidate = candidates[position - 1];
        if (!candidate || !ALL_STORY_LINK_TYPES.includes(item?.type) || seenHashes.has(candidate._hash)) {
            droppedCount++;
            continue;
        }
        seenHashes.add(candidate._hash);
        links.push({ hash: candidate._hash, type: item.type, thread: typeof item.thread === 'string' ? item.thread.trim() : '' });
    }
    return { links, droppedCount };
}

/**
 * The walkable links between events. A link to a deleted event is left out.
 *
 * @param {object[]} events
 * @param {(position: number, messageGap: number) => boolean} [keepsLink] - Which links to keep, given a link's place in its event's list (0 is the strongest) and how many messages it spans
 * @returns {{parents: Map<number, {hash: number, type: string}[]>, children: Map<number, {hash: number, type: string}[]>}}
 */
export function buildStoryLinkGraph(events, keepsLink = () => true) {
    const eventByHash = new Map(events.map(event => [event._hash, event]));
    const parents = new Map();
    const children = new Map();
    const addNeighbour = (neighbours, hash, neighbour) => {
        if (!neighbours.has(hash)) neighbours.set(hash, []);
        neighbours.get(hash).push(neighbour);
    };
    for (const event of events) {
        (event.story_links ?? []).forEach((link, position) => {
            const parent = eventByHash.get(link.hash);
            if (!parent || !keepsLink(position, event.source_window_start - parent.source_window_start)) return;
            addNeighbour(parents, event._hash, { hash: link.hash, type: link.type });
            addNeighbour(children, link.hash, { hash: event._hash, type: link.type });
        });
    }
    return { parents, children };
}

/**
 * Every event reachable from the seeds over the allowed link types.
 *
 * @param {Iterable<number>} seedHashes
 * @param {Map<number, {hash: number, type: string}[]>} neighbours - `parents` or `children` of a link graph
 * @param {readonly string[]} allowedTypes
 * @returns {Map<number, number>} each reached hash and how many links away it is; seeds are 0
 */
export function walkStoryLinks(seedHashes, neighbours, allowedTypes) {
    const hopsByHash = new Map([...seedHashes].map(hash => [hash, 0]));
    const waiting = [...hopsByHash.keys()];
    for (let next = 0; next < waiting.length; next++) {
        const hash = waiting[next];
        for (const neighbour of neighbours.get(hash) ?? []) {
            if (!allowedTypes.includes(neighbour.type) || hopsByHash.has(neighbour.hash)) continue;
            hopsByHash.set(neighbour.hash, hopsByHash.get(hash) + 1);
            waiting.push(neighbour.hash);
        }
    }
    return hopsByHash;
}
