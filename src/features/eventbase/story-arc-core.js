/**
 * ============================================================================
 * STORY ARC CORE
 * ============================================================================
 * Pure logic for StoryArc mode, which answers questions about the story's past
 * that a top-K similarity search misses, such as "how did she become head of
 * the guild?" or "do you remember when we first met?".
 *
 * A small LLM call, the router, reads the player's message and returns the
 * question's shape and subject. The shape picks a recipe: which events to fetch,
 * which links to walk, and how many to keep. Ordinary turns have no recipe and
 * keep today's retrieval path. StoryArc Route rules decide the route for each
 * situation, and every turn reports the rule that decided it.
 *
 * On a question about a thread, a second LLM call reads the chat's thread names
 * and picks those that could hold the answer, even when they share no word with
 * the question. The events of those threads take seats in the block first.
 *
 * @see InternalProject/Vectfox/plans/story-arc.md
 * ============================================================================
 */

import {
    ALL_STORY_LINK_TYPES,
    STORY_LINK_TYPE,
    buildStoryLinkGraph,
    inTimelineOrder,
    measureStoryLinkCoverage,
    walkStoryLinks,
} from './story-arc-links-core.js';

/** What each question shape means, as the router reads it. */
const STORY_SHAPES = {
    scene: "one scene or fight: what happened in it and how it ended, or anything that is not a question about the story's past",
    first_time: 'the first time someone appeared or something happened',
    chain: 'how someone or something came to be what it is now, step by step',
    why: 'why something happened or keeps happening',
    current: 'where things stand now',
    bigger_plot: 'how one matter connects to a larger plot',
};

const SCENE_SHAPE = 'scene';

/** The shapes a recipe answers. Any other shape keeps today's path. */
const RECIPE_SHAPES = new Set(['first_time', 'chain', 'why', 'current', 'bigger_plot']);

/** The shape whose block suits any events in time order. */
const THREAD_SHAPE = 'chain';

/** Names of the StoryArc Route rules, as logs and Debug Query show them. */
export const STORY_ROUTE_RULE = Object.freeze({
    /** The question's shape chose its recipe, and the recipe found events. */
    SHAPE_RECIPE: 'shape-recipe',
    /** The router called the message an ordinary turn, so it keeps today's path. */
    ORDINARY_TURN: 'ordinary-turn',
    /** The router failed, has no model, or returned an unknown shape, so the turn keeps today's path. */
    ROUTER_UNUSABLE: 'router-unusable',
    /** The collection could not be listed, so the turn keeps today's path. */
    LISTING_FAILED: 'listing-failed',
    /** Too few events are decided to walk, so a recipe searches without links. */
    LINKS_NOT_GENERATED: 'links-not-generated',
    /** A recipe ended with no events, so the turn keeps today's path. */
    RECIPE_FOUND_NOTHING: 'recipe-found-nothing',
    /** A first-time question whose subject is empty or named in no stored event starts from the closest events. */
    FIRST_TIME_SUBJECT_NOT_FOUND: 'first-time-subject-not-found',
    /** An LLM picked threads by name, and their events took seats in the block first. */
    THREAD_PICK: 'thread-pick',
    /** The thread pick failed or has no model, so the recipe ran without it. */
    THREAD_PICK_FAILED: 'thread-pick-failed',
});

/** Events in a block. 75 short lines come to about 10,500 characters. */
const BLOCK_EVENT_LIMIT = 75;
/** Seats a thread pick's events take first, which leaves a walk the 50 closest events it had without one. */
const PICKED_EVENT_SEATS = 25;
/**
 * Hybrid hits a recipe asks for. The search cannot be limited to chosen events, so
 * this pool is how a recipe tells which events are closest to the question.
 */
export const STORY_POOL_SIZE = 200;
/** The closest hits a walk starts from. */
const WALK_SEED_COUNT = 10;
const FIRST_TIME_EARLIEST_COUNT = 5;
const FIRST_TIME_CLOSEST_COUNT = 20;
/** The newest events of a thread a current-state block keeps. */
const CURRENT_NEWEST_COUNT = 10;
/** A link this short stays inside a scene or the one next to it, so it joins steps without drifting across the story. */
const SCENE_LINK_GAP = 20;
/** The shapes whose block holds a thread's steps, which picked threads can add to. */
const THREAD_PICK_SHAPES = new Set(['chain', 'why', 'bigger_plot']);

/**
 * StoryArc mode's switch, plus what it needs: Agent Mode for the router, and Qdrant.
 * @param {object} settings
 * @returns {boolean}
 */
export function isStoryArcActive(settings) {
    return !!(settings?.story_arc_mode_enabled && settings.agentic_retrieval_enabled && settings.vector_backend === 'qdrant');
}

/** How much recent chat the router sees: enough to work out who "you" or a kinship word means. */
const ROUTER_RECENT_TURNS = 2;
const ROUTER_TURN_CHARS = 600;

export const STORY_ROUTER_PROMPT =
    'A player is writing to a long roleplay story. Decide which memory search their message needs.\n'
    + 'Shapes:\n'
    + Object.entries(STORY_SHAPES).map(([shape, meaning]) => `- "${shape}": ${meaning}\n`).join('')
    + `Most messages just carry the story forward, and those are "${SCENE_SHAPE}". Choose another shape only when the player is asking about the story's past.\n`
    + 'Also give the subject: the person, place or thing the message asks about, spelled exactly as in the message, or empty if there is none. '
    + 'When the player speaks to a character about their shared past, that character is the subject. '
    + 'If the message says only "you", "she" or a kinship word, use recent chat to find the name, and give that name as the subject. '
    + "Recent chat is only background: choose the shape from the player's message, not from the recent chat.\n"
    + `Reply with JSON only: {"shape": "${SCENE_SHAPE}", "subject": ""}`;

/**
 * The router's user message: the end of the recent turns, then the player's message.
 * A turn's end is what the player is answering, so that is the part kept.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.recentTurns - Recent chat, oldest first; may include the player's message itself
 * @param {string} params.userMessage - The message being routed
 * @returns {string}
 */
export function buildStoryRouterMessage({ recentTurns, userMessage }) {
    const earlierTurns = (recentTurns || []).filter(turn => turn.text?.trim() && turn.text.trim() !== userMessage.trim());
    const lines = earlierTurns.slice(-ROUTER_RECENT_TURNS).map(turn => `${turn.speaker}: ${turn.text.slice(-ROUTER_TURN_CHARS)}`);
    return `Recent chat:\n${lines.join('\n') || '(none)'}\n\nPlayer's message:\n${userMessage}`;
}

/**
 * Read the router's reply. An unknown shape reads as a scene, so the turn takes today's path.
 *
 * @param {unknown} reply - Parsed JSON from the router
 * @returns {{shape: string, subject: string, isKnownShape: boolean}}
 */
export function readStoryRoute(reply) {
    const shape = typeof reply?.shape === 'string' ? reply.shape.trim() : '';
    const subject = typeof reply?.subject === 'string' ? reply.subject.trim() : '';
    const isKnownShape = Object.hasOwn(STORY_SHAPES, shape);
    return { shape: isKnownShape ? shape : SCENE_SHAPE, subject, isKnownShape };
}

/**
 * Whether a question shape has a recipe. Any other shape keeps today's path.
 * @param {string} shape
 * @returns {boolean}
 */
export function hasRecipe(shape) {
    return RECIPE_SHAPES.has(shape);
}

export const THREAD_PICK_PROMPT =
    'A player asks about the past of a long roleplay story. Below is the list of the story\'s threads, oldest first, each with the message number where it starts. '
    + 'Pick every thread that could hold a step of the answer, even when it uses another name for the same person or matter. A question about someone\'s relative or partner is also about that person. Pick at most 30.\n'
    + 'Reply with JSON only: {"threads": ["..."]}, copying each thread name exactly.';

/**
 * Whether a shape's recipe asks an LLM to pick threads.
 * @param {string} shape
 * @returns {boolean}
 */
export function hasThreadPick(shape) {
    return THREAD_PICK_SHAPES.has(shape);
}

/**
 * The chat's threads: each name once, with the message where it starts, oldest first.
 *
 * @param {object[]} storedEvents
 * @returns {{name: string, firstMessage: number}[]}
 */
export function listStoryThreads(storedEvents) {
    const firstMessageByName = new Map();
    for (const event of storedEvents) {
        for (const link of event.story_links ?? []) {
            if (!link.thread) continue;
            const earliest = firstMessageByName.get(link.thread);
            if (earliest === undefined || event.source_window_start < earliest) firstMessageByName.set(link.thread, event.source_window_start);
        }
    }
    return [...firstMessageByName]
        .map(([name, firstMessage]) => ({ name, firstMessage }))
        .sort((a, b) => a.firstMessage - b.firstMessage);
}

/**
 * The thread pick's user message: the list, then the question, so the list can be
 * a cached prefix. The subject is added when the question leaves it out, as in
 * "how did your father get there?".
 *
 * @param {{name: string, firstMessage: number}[]} threads - From listStoryThreads
 * @param {string} question
 * @param {string} subject - The router's subject
 * @returns {string}
 */
export function buildThreadPickMessage(threads, question, subject) {
    const list = threads.map(thread => `#${thread.firstMessage} ${thread.name}`).join('\n');
    const about = subject && !question.includes(subject) ? `\nIt is about: ${subject}` : '';
    return `Threads:\n${list}\n\nPlayer's question:\n${question}${about}`;
}

/**
 * Read an LLM's thread pick. The model may copy a list line whole, with its message
 * number. A name no link carries simply reaches no events.
 *
 * @param {unknown} reply - Parsed JSON from the LLM
 * @returns {string[]} thread names, in the model's order
 * @throws {Error} when the reply has no `threads` array, so a malformed reply never reads as "no threads"
 */
export function readThreadPick(reply) {
    if (!Array.isArray(reply?.threads)) {
        throw new Error(`Thread pick reply has no threads array: ${JSON.stringify(reply)?.slice(0, 200)}`);
    }
    return reply.threads
        .filter(name => typeof name === 'string')
        .map(name => name.replace(/^\s*#\d+\s*/, '').trim())
        .filter(Boolean);
}

/**
 * Every event the links of these threads join, in the order the threads are named.
 *
 * @param {string[]} threadNames
 * @param {object[]} storedEvents
 * @returns {Set<number>} hashes
 */
function hashesOfThreads(threadNames, storedEvents) {
    const hashesByName = new Map(threadNames.map(name => [name, new Set()]));
    for (const event of storedEvents) {
        for (const link of event.story_links ?? []) {
            hashesByName.get(link.thread)?.add(event._hash).add(link.hash);
        }
    }
    return new Set([...hashesByName.values()].flatMap(hashes => [...hashes]));
}

/**
 * Whether an event's stored text holds the subject. The stored text carries the
 * summary, cause, result, characters, locations and keywords, so this also finds
 * a name the event's `characters` tag leaves out.
 *
 * @param {object} event
 * @param {string} subject
 * @returns {boolean}
 */
function eventNamesSubject(event, subject) {
    return String(event.text ?? '').toLowerCase().includes(subject.toLowerCase());
}

/**
 * Limit a walk to a block: the events closest to the question, at most one per
 * chat window. A window is one step of a thread, and a block wants steps rather
 * than the detail of one scene. An event outside the pool ranks after every hit,
 * nearest to the seeds first. Picked threads' events go first, closest first, up to
 * their seats, since a pick exists to reach what the search ranks low.
 */
function keepClosestSteps(hopsByHash, eventByHash, poolRankByHash, pickedHashes) {
    const closenessOf = (hash) => poolRankByHash.get(hash) ?? Number.MAX_SAFE_INTEGER;
    const picked = [...pickedHashes]
        .filter(hash => eventByHash.has(hash))
        .sort((a, b) => closenessOf(a) - closenessOf(b))
        .slice(0, PICKED_EVENT_SEATS);
    const ranked = [...hopsByHash.keys()]
        .filter(hash => eventByHash.has(hash))
        .sort((a, b) => (closenessOf(a) - closenessOf(b)) || (hopsByHash.get(a) - hopsByHash.get(b)));
    const seenWindows = new Set();
    const kept = [];
    for (const hash of [...picked, ...ranked]) {
        const event = eventByHash.get(hash);
        if (seenWindows.has(event.source_window_start)) continue;
        seenWindows.add(event.source_window_start);
        kept.push(event);
        if (kept.length === BLOCK_EVENT_LIMIT) break;
    }
    return kept;
}

/** Steps of one thread: the strongest link, and any short enough to stay in the scene. */
const isSceneLink = (position, messageGap) => position === 0 || messageGap <= SCENE_LINK_GAP;

/** Add a walk's events to another's, keeping the distance each already has. */
function addWalk(hopsByHash, moreHopsByHash) {
    for (const [hash, hops] of moreHopsByHash) {
        if (!hopsByHash.has(hash)) hopsByHash.set(hash, hops);
    }
}

/** Events without repeats, each kept at its first place. */
function withoutRepeats(events) {
    return [...new Map(events.map(event => [event._hash, event])).values()];
}

/** A recipe's events when too few events are decided to walk. */
function selectWithoutLinks({ shape, namedEvents, closestNaming, poolEvents }) {
    if (shape === 'current') return { events: [], blockShape: shape, ruleName: STORY_ROUTE_RULE.LINKS_NOT_GENERATED };
    if (shape === 'first_time' && !namedEvents.length) {
        return { events: inTimelineOrder(poolEvents.slice(0, BLOCK_EVENT_LIMIT)), blockShape: THREAD_SHAPE, ruleName: STORY_ROUTE_RULE.FIRST_TIME_SUBJECT_NOT_FOUND };
    }
    const events = shape === 'first_time'
        ? withoutRepeats([...inTimelineOrder(namedEvents).slice(0, FIRST_TIME_EARLIEST_COUNT), ...closestNaming.slice(0, FIRST_TIME_CLOSEST_COUNT)])
        : poolEvents.slice(0, BLOCK_EVENT_LIMIT);
    return { events: inTimelineOrder(events), blockShape: shape, ruleName: STORY_ROUTE_RULE.LINKS_NOT_GENERATED };
}

/**
 * A recipe's events, before the filters every retrieval applies. Pure, so the
 * benchmark can run the same selection on real data.
 *
 * @param {object} params
 * @param {string} params.shape
 * @param {string} params.subject
 * @param {object[]} params.storedEvents - Every event in the collection, each with `_hash`
 * @param {object[]} params.poolEvents - Hybrid hits, closest first, each with `_hash`
 * @param {string[]} [params.pickedThreads] - Thread names an LLM picked, whose events take seats first in a thread block
 * @returns {{events: object[], blockShape: string, ruleName: string}} events in time order; none when the turn should keep today's path
 */
export function selectStoryRecipeEvents({ shape, subject, storedEvents, poolEvents, pickedThreads = [] }) {
    const namedEvents = subject ? storedEvents.filter(event => eventNamesSubject(event, subject)) : [];
    const closestNaming = namedEvents.length ? poolEvents.filter(event => eventNamesSubject(event, subject)) : [];
    if (!measureStoryLinkCoverage(storedEvents).hasUsableLinks) {
        return selectWithoutLinks({ shape, namedEvents, closestNaming, poolEvents });
    }

    const eventByHash = new Map([...poolEvents, ...storedEvents].map(event => [event._hash, event]));
    const eventsOf = (hashes) => [...hashes].map(hash => eventByHash.get(hash)).filter(Boolean);
    const poolRankByHash = new Map(poolEvents.map((event, rank) => [event._hash, rank]));
    const seedHashes = poolEvents.slice(0, WALK_SEED_COUNT).map(event => event._hash);
    const graph = buildStoryLinkGraph(storedEvents);

    if (shape === 'first_time') {
        // The walk from the earliest events can reach a spelling the question did not use.
        const earliestHashes = namedEvents.length
            ? inTimelineOrder(namedEvents).slice(0, FIRST_TIME_EARLIEST_COUNT).map(event => event._hash)
            : seedHashes;
        const sceneGraph = buildStoryLinkGraph(storedEvents, isSceneLink);
        const walked = walkStoryLinks(earliestHashes, sceneGraph.parents, [STORY_LINK_TYPE.CONTINUES]);
        const closest = (namedEvents.length ? closestNaming : poolEvents).slice(0, FIRST_TIME_CLOSEST_COUNT);
        const events = withoutRepeats([...closest, ...inTimelineOrder(eventsOf(walked.keys()))]).slice(0, BLOCK_EVENT_LIMIT);
        return {
            events: inTimelineOrder(events),
            // Without the subject these are not its earliest events, so the block must not say they are.
            blockShape: namedEvents.length ? shape : THREAD_SHAPE,
            ruleName: namedEvents.length ? STORY_ROUTE_RULE.SHAPE_RECIPE : STORY_ROUTE_RULE.FIRST_TIME_SUBJECT_NOT_FOUND,
        };
    }

    if (shape === 'current') {
        const later = walkStoryLinks(seedHashes, graph.children, [STORY_LINK_TYPE.CONTINUES]);
        const latest = inTimelineOrder(eventsOf(later.keys())).slice(-CURRENT_NEWEST_COUNT);
        return { events: inTimelineOrder(withoutRepeats([...latest, ...eventsOf(seedHashes)])), blockShape: shape, ruleName: STORY_ROUTE_RULE.SHAPE_RECIPE };
    }

    let walked;
    if (shape === 'why') {
        walked = walkStoryLinks(seedHashes, graph.parents, [STORY_LINK_TYPE.CAUSED_BY, STORY_LINK_TYPE.CONTINUES]);
    } else if (shape === 'bigger_plot') {
        const namedSeedHashes = closestNaming.slice(0, WALK_SEED_COUNT).map(event => event._hash);
        walked = walkStoryLinks([...seedHashes, ...namedSeedHashes], graph.parents, ALL_STORY_LINK_TYPES);
    } else {
        // Top hits can sit mid-thread, so later steps need the walk forward.
        walked = walkStoryLinks(seedHashes, graph.parents, ALL_STORY_LINK_TYPES);
        addWalk(walked, walkStoryLinks(seedHashes, graph.children, [STORY_LINK_TYPE.CONTINUES]));
    }
    const pickedHashes = hashesOfThreads(pickedThreads, storedEvents);
    return {
        events: inTimelineOrder(keepClosestSteps(walked, eventByHash, poolRankByHash, pickedHashes)),
        blockShape: shape,
        ruleName: pickedHashes.size ? STORY_ROUTE_RULE.THREAD_PICK : STORY_ROUTE_RULE.SHAPE_RECIPE,
    };
}
