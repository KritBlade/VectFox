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
 * keep the pre-search. StoryArc Route rules decide the route for each
 * situation, and every turn reports the rule that decided it.
 *
 * On a question about a thread, a second LLM call reads the chat's thread names
 * and picks those that could hold the answer, even when they share no word with
 * the question. The events of those threads take seats in the block first.
 *
 * A recipe gathers more events than a memory block should hold, so a last LLM call
 * chooses the lines that answer the question, which cuts a long block to 20. A
 * question about the first or last time fills what is left of the 20 from the end
 * of the block it asks about, which needs no LLM and can stand in for the call.
 *
 * @see InternalProject/Vectfox/plans/story-arc.md
 * ============================================================================
 */

import { formatLabelledStoryLine, storyLinePosition } from './eventbase-injection.js';
import {
    ALL_STORY_LINK_TYPES,
    STORY_LINK_TYPE,
    buildStoryLinkGraph,
    eventsByEventId,
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
    last_time: 'the last or most recent occurrence of something that happens more than once, such as the last time two people met or spoke. How one matter finally ended is not this shape',
};

const SCENE_SHAPE = 'scene';

/** The shapes a recipe answers. Any other shape keeps the pre-search. */
const RECIPE_SHAPES = new Set(['first_time', 'last_time', 'chain', 'why', 'current', 'bigger_plot']);

/** The shapes that ask for one end of a matter: its first or its last time. */
const TIME_SHAPES = new Set(['first_time', 'last_time']);

/** The shape whose block suits any events in time order. */
const THREAD_SHAPE = 'chain';

/** Names of the StoryArc Route rules, as logs and Debug Query show them. */
export const STORY_ROUTE_RULE = Object.freeze({
    /** The question's shape chose its recipe, and the recipe found events. */
    SHAPE_RECIPE: 'shape-recipe',
    /** The router called the message an ordinary turn, so it keeps the pre-search. */
    ORDINARY_TURN: 'ordinary-turn',
    /** The router failed, has no model, or returned an unknown shape, so the turn keeps the pre-search. */
    ROUTER_UNUSABLE: 'router-unusable',
    /** The collection could not be listed, so the turn keeps the pre-search. */
    LISTING_FAILED: 'listing-failed',
    /** Too few events are decided to walk, so a recipe searches without links. */
    LINKS_NOT_GENERATED: 'links-not-generated',
    /** A recipe ended with no events, so the turn keeps the pre-search. */
    RECIPE_FOUND_NOTHING: 'recipe-found-nothing',
    /** A first-time question whose subject is empty or named in no stored event starts from the closest events. */
    FIRST_TIME_SUBJECT_NOT_FOUND: 'first-time-subject-not-found',
    /** A last-time question whose subject is empty or named in no stored event starts from the closest events. */
    LAST_TIME_SUBJECT_NOT_FOUND: 'last-time-subject-not-found',
    /** An LLM picked threads by name, and their events took seats in the block first. */
    THREAD_PICK: 'thread-pick',
    /** The thread pick failed, so the recipe ran without it. */
    THREAD_PICK_FAILED: 'thread-pick-failed',
    /** An LLM chose the lines that answer the question, and a long block was cut to them. */
    BLOCK_CUT: 'block-cut',
    /** The cut failed, or its reply named no line, so a long block was cut without it. */
    BLOCK_CUT_FAILED: 'block-cut-failed',
});

/** Events a first-time or last-time recipe gathers before the cut. Its closest hits come first and its walk last, so a shorter limit would drop the very events it asks about. */
const TIME_BLOCK_EVENT_LIMIT = 75;
/** Lines a block keeps after the cut, per square root of the story's events: 10 at 200 events, 30 at 1,800. A line is about 200 tokens, against about 470 for a full event. */
const BLOCK_LINES_PER_ROOT_EVENT = 0.7;
/** The fewest lines a block keeps, as many events as a plain search, at about 2,100 tokens. */
const MIN_BLOCK_LINES = 10;
/** The most lines a block keeps, about 8,100 tokens, however long the story. */
const MAX_BLOCK_LINES = 40;
/** Seats a block has before the cut, per line it keeps. A chat window holds about 1.8 lines, so the cut chooses among over four times what it keeps. */
const BLOCK_SEATS_PER_LINE = 2.5;
/** The fewest seats a block has. Only the cut reads them, so a short story loses nothing by having more than its lines call for. */
const MIN_BLOCK_SEATS = 40;
/**
 * Hybrid hits a recipe asks for. The search cannot be limited to chosen events, so
 * this pool is how a recipe tells which events are closest to the question.
 */
export const STORY_POOL_SIZE = 200;
/** The closest hits a walk starts from. */
const WALK_SEED_COUNT = 10;
/** The subject's first or last events a first-time or last-time block starts from. */
const TIME_END_EVENT_COUNT = 5;
const TIME_CLOSEST_EVENT_COUNT = 20;
/** The newest events of a thread a current-state block keeps. */
const CURRENT_NEWEST_COUNT = 10;
/** Messages this close stay inside a scene or the one next to it: a link this short joins steps without drifting across the story. */
const SCENE_MESSAGE_GAP = 20;
/** The shapes whose block holds a thread's steps, which picked threads can add to. */
const THREAD_PICK_SHAPES = new Set(['chain', 'why', 'bigger_plot']);

/**
 * How much of a story a block holds. A longer story's threads have more steps, spread
 * thinner, and the lines and seats that hold the same share of those steps grow with the
 * square root of its events.
 *
 * @param {number} storyEventCount - The events stored for the story
 * @returns {{lineCount: number, seatCount: number}} the lines a block keeps after the cut, and its seats before it: chat windows in a walked block, or events in a linkless one, and a thread pick's events take them first
 */
export function storyBlockLimits(storyEventCount) {
    const lineCount = Math.min(MAX_BLOCK_LINES, Math.max(MIN_BLOCK_LINES, Math.round(BLOCK_LINES_PER_ROOT_EVENT * Math.sqrt(storyEventCount))));
    return { lineCount, seatCount: Math.max(MIN_BLOCK_SEATS, Math.round(lineCount * BLOCK_SEATS_PER_LINE)) };
}

/**
 * StoryArc mode's switch, plus the Qdrant backend it needs.
 * @param {object} settings
 * @returns {boolean}
 */
export function isStoryArcActive(settings) {
    return !!(settings?.story_arc_mode_enabled && settings.vector_backend === 'qdrant');
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
 * Read the router's reply. An unknown shape reads as a scene, so the turn keeps the pre-search.
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
 * Whether a question shape has a recipe. Any other shape keeps the pre-search.
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
    return `Threads:\n${list}\n\nPlayer's question:\n${question}${_aboutSubject(question, subject)}`;
}

/** The subject, as a line after a question that leaves it out. */
function _aboutSubject(question, subject) {
    return subject && !question.includes(subject) ? `\nIt is about: ${subject}` : '';
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
    const eventById = eventsByEventId(storedEvents);
    for (const event of storedEvents) {
        for (const link of event.story_links ?? []) {
            const hashes = hashesByName.get(link.thread);
            if (!hashes) continue;
            hashes.add(event._hash);
            const parent = eventById.get(link.event_id);
            if (parent) hashes.add(parent._hash);
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
 * Limit a walk to a block: the chat windows of the events closest to the question,
 * with every event stored at them. A window can tell several things, and a search rank
 * cannot say which answers the question, so the block cut reads them all. An event
 * outside the pool ranks after every hit, nearest to the seeds first. Picked threads'
 * events go first, closest first, up to their limit, since a pick exists to reach what
 * the search ranks low.
 */
function keepClosestWindows(hopsByHash, eventByHash, poolRankByHash, pickedHashes, seatCount) {
    const closenessOf = (hash) => poolRankByHash.get(hash) ?? Number.MAX_SAFE_INTEGER;
    const picked = [...pickedHashes]
        .filter(hash => eventByHash.has(hash))
        .sort((a, b) => closenessOf(a) - closenessOf(b))
        .slice(0, seatCount);
    const ranked = [...hopsByHash.keys()]
        .filter(hash => eventByHash.has(hash))
        .sort((a, b) => (closenessOf(a) - closenessOf(b)) || (hopsByHash.get(a) - hopsByHash.get(b)));
    const windows = new Set();
    for (const hash of [...picked, ...ranked]) {
        windows.add(storyLinePosition(eventByHash.get(hash)));
        if (windows.size === seatCount) break;
    }
    return [...eventByHash.values()].filter(event => windows.has(storyLinePosition(event)));
}

/** Steps of one thread: the strongest link, and any short enough to stay in the scene. */
const isSceneLink = (position, messageGap) => position === 0 || messageGap <= SCENE_MESSAGE_GAP;

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

/** The subject's first events for a first-time question, its last for a last-time one. */
function timeEndEvents(shape, namedEvents) {
    const ordered = inTimelineOrder(namedEvents);
    return shape === 'first_time' ? ordered.slice(0, TIME_END_EVENT_COUNT) : ordered.slice(-TIME_END_EVENT_COUNT);
}

/** A last-time block also seats the top hits, which can reach a later spelling of the subject's name. */
function timeTopHits(shape, poolEvents) {
    return shape === 'last_time' ? poolEvents.slice(0, WALK_SEED_COUNT) : [];
}

function timeSubjectNotFoundRule(shape) {
    return shape === 'first_time' ? STORY_ROUTE_RULE.FIRST_TIME_SUBJECT_NOT_FOUND : STORY_ROUTE_RULE.LAST_TIME_SUBJECT_NOT_FOUND;
}

/** A recipe's events when too few events are decided to walk. */
function selectWithoutLinks({ shape, namedEvents, closestNaming, poolEvents, seatCount }) {
    if (shape === 'current') return { events: [], blockShape: shape, ruleName: STORY_ROUTE_RULE.LINKS_NOT_GENERATED };
    if (TIME_SHAPES.has(shape) && !namedEvents.length) {
        return { events: inTimelineOrder(poolEvents.slice(0, seatCount)), blockShape: THREAD_SHAPE, ruleName: timeSubjectNotFoundRule(shape) };
    }
    const events = TIME_SHAPES.has(shape)
        ? withoutRepeats([...timeEndEvents(shape, namedEvents), ...closestNaming.slice(0, TIME_CLOSEST_EVENT_COUNT), ...timeTopHits(shape, poolEvents)])
        : poolEvents.slice(0, seatCount);
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
 * @returns {{events: object[], blockShape: string, ruleName: string}} events in time order; none when the turn should keep the pre-search
 */
export function selectStoryRecipeEvents({ shape, subject, storedEvents, poolEvents, pickedThreads = [] }) {
    const namedEvents = subject ? storedEvents.filter(event => eventNamesSubject(event, subject)) : [];
    const closestNaming = namedEvents.length ? poolEvents.filter(event => eventNamesSubject(event, subject)) : [];
    const { seatCount } = storyBlockLimits(storedEvents.length);
    if (!measureStoryLinkCoverage(storedEvents).hasUsableLinks) {
        return selectWithoutLinks({ shape, namedEvents, closestNaming, poolEvents, seatCount });
    }

    const eventByHash = new Map([...poolEvents, ...storedEvents].map(event => [event._hash, event]));
    const eventsOf = (hashes) => [...hashes].map(hash => eventByHash.get(hash)).filter(Boolean);
    const poolRankByHash = new Map(poolEvents.map((event, rank) => [event._hash, rank]));
    const seedHashes = poolEvents.slice(0, WALK_SEED_COUNT).map(event => event._hash);
    const graph = buildStoryLinkGraph(storedEvents);

    if (TIME_SHAPES.has(shape)) {
        // The walk away from the subject's first or last events can reach a spelling the question did not use.
        const endHashes = namedEvents.length ? timeEndEvents(shape, namedEvents).map(event => event._hash) : seedHashes;
        const sceneGraph = buildStoryLinkGraph(storedEvents, isSceneLink);
        const walked = walkStoryLinks(endHashes, shape === 'first_time' ? sceneGraph.parents : sceneGraph.children, [STORY_LINK_TYPE.CONTINUES]);
        const closest = (namedEvents.length ? closestNaming : poolEvents).slice(0, TIME_CLOSEST_EVENT_COUNT);
        const events = withoutRepeats([...closest, ...timeTopHits(shape, poolEvents), ...inTimelineOrder(eventsOf(walked.keys()))]).slice(0, TIME_BLOCK_EVENT_LIMIT);
        return {
            events: inTimelineOrder(events),
            // Without the subject these are not its first or last events, so the block must not say they are.
            blockShape: namedEvents.length ? shape : THREAD_SHAPE,
            ruleName: namedEvents.length ? STORY_ROUTE_RULE.SHAPE_RECIPE : timeSubjectNotFoundRule(shape),
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
        events: inTimelineOrder(keepClosestWindows(walked, eventByHash, poolRankByHash, pickedHashes, seatCount)),
        blockShape: shape,
        ruleName: pickedHashes.size ? STORY_ROUTE_RULE.THREAD_PICK : STORY_ROUTE_RULE.SHAPE_RECIPE,
    };
}

const BLOCK_CUT_PROMPT_START = 'A player asks about the past of a long roleplay story. Below are events from the story\'s memory, oldest first, which a search found. Each line starts with its # position in the conversation: a smaller # happened earlier. Many of them do not matter for this question.\n';
const BLOCK_CUT_PROMPT_END = 'Skip events about other matters, and keep only one of any events that tell the same step.\n'
    + 'Reply with JSON only: {"events": ["12", "47a", "96"]}, using the # label of each line. Lines with the same number and different letters come from one moment of the story and can tell different things, so judge each on its own.';
const BLOCK_CUT_GOAL_BY_SHAPE = {
    chain: 'how this came to be, step by step: where the matter starts, the steps that moved it on, and where it ended up.',
    why: 'why this happened: the event asked about, what directly caused it, and the earlier causes behind those, however far back. Leave out what came after, unless it explains the cause.',
    bigger_plot: 'how this ties into a larger plot: where the matter starts, the events that connect it to the larger plot, and the latest on that plot.',
};

/**
 * What the block cut asks for, by the router's shape. A current-state block is never
 * longer than the cut's count, so it has no prompt.
 */
const BLOCK_CUT_PROMPT_WRITERS = Object.freeze({
    first_time: lineCount => `${BLOCK_CUT_PROMPT_START}The question asks for the first time something happened. Choose up to ${lineCount} events from the earliest scene that fits, and what leads straight out of it. A later scene does not count, however well it matches the words. `
        + `People can go by other names in earlier events, so a scene can fit without using the name in the question. ${BLOCK_CUT_PROMPT_END}`,
    last_time: lineCount => `${BLOCK_CUT_PROMPT_START}The question asks for the last or most recent time something happened. Choose up to ${lineCount} events from the latest scene that fits, and what leads straight into it. An earlier scene does not count, however well it matches the words. ${BLOCK_CUT_PROMPT_END}`,
    ...Object.fromEntries(Object.entries(BLOCK_CUT_GOAL_BY_SHAPE).map(([shape, goal]) => [
        shape,
        lineCount => `${BLOCK_CUT_PROMPT_START}Choose the ${lineCount} events that together answer it best, as a short account of ${goal} ${BLOCK_CUT_PROMPT_END}`,
    ])),
});

/**
 * The block cut's prompt for a shape that has one.
 * @param {string} shape - The router's shape
 * @param {number} lineCount - The lines the block keeps
 * @returns {string}
 */
export function buildBlockCutPrompt(shape, lineCount) {
    return BLOCK_CUT_PROMPT_WRITERS[shape](lineCount);
}

/**
 * Whether a block is long enough to cut.
 * @param {string} shape - The router's shape
 * @param {number} eventCount
 * @param {number} lineCount - The lines the block keeps
 * @returns {boolean}
 */
export function isBlockCutNeeded(shape, eventCount, lineCount) {
    return Object.hasOwn(BLOCK_CUT_PROMPT_WRITERS, shape) && eventCount > lineCount;
}

/**
 * A block's lines with their labels, oldest first: each line's # position, with a letter
 * when its window holds several lines, so the block cut can take one of them.
 *
 * @param {object[]} events
 * @returns {{event: object, label: string}[]}
 */
function labelBlockLines(events) {
    const ordered = inTimelineOrder(events);
    const lineCountAt = new Map();
    for (const event of ordered) lineCountAt.set(storyLinePosition(event), (lineCountAt.get(storyLinePosition(event)) ?? 0) + 1);
    const seenAt = new Map();
    return ordered.map((event) => {
        const position = storyLinePosition(event);
        const seen = seenAt.get(position) ?? 0;
        seenAt.set(position, seen + 1);
        const letter = lineCountAt.get(position) > 1 ? String.fromCharCode(97 + seen) : '';
        return { event, label: `${position ?? '?'}${letter}` };
    });
}

/**
 * The block cut's user message: the block's lines, then the question. The subject is
 * added when the question leaves it out.
 *
 * @param {object[]} events
 * @param {string} question
 * @param {string} subject - The router's subject
 * @returns {string}
 */
export function buildBlockCutMessage(events, question, subject) {
    const lines = labelBlockLines(events).map(({ event, label }) => formatLabelledStoryLine(event, label)).join('\n');
    return `Events:\n${lines}\n\nPlayer's question:\n${question}${_aboutSubject(question, subject)}`;
}

/**
 * Read an LLM's block cut. The model may copy a line's # along with its label. A bare
 * number, or a letter the block does not have, names every line at that position.
 *
 * @param {unknown} reply - Parsed JSON from the LLM
 * @param {object[]} events - The block the model chose from
 * @returns {object[]} the chosen events, in the model's order
 * @throws {Error} when the reply has no `events` array or names no line, so a malformed reply never empties a block
 */
export function readBlockCut(reply, events) {
    if (!Array.isArray(reply?.events)) {
        throw new Error(`Block cut reply has no events array: ${JSON.stringify(reply)?.slice(0, 200)}`);
    }
    const lines = labelBlockLines(events);
    const chosen = withoutRepeats(reply.events.flatMap((value) => {
        const match = /(\d+)([a-z]?)/i.exec(String(value));
        if (!match) return [];
        const label = `${match[1]}${match[2].toLowerCase()}`;
        const named = lines.filter(line => line.label === label);
        return named.length ? named : lines.filter(line => storyLinePosition(line.event) === Number(match[1]));
    }).map(line => line.event));
    if (!chosen.length) {
        throw new Error(`Block cut reply names no line of the block: ${JSON.stringify(reply.events).slice(0, 200)}`);
    }
    return chosen;
}

/**
 * The seat rule of a first-time or last-time block, which needs no LLM: half the seats
 * from the block's end, which a walk reached under any name, and half from where it
 * first or last names the subject. Closest to the end asked about first.
 */
function seatsByTimeRule(shape, events, subject, lineCount) {
    // A last-time block is a first-time block read from the other end.
    const fromAskedEnd = shape === 'first_time' ? inTimelineOrder(events) : inTimelineOrder(events).reverse();
    const endSeats = Math.floor(lineCount / 2);
    const namingPlace = subject ? fromAskedEnd.findIndex(event => eventNamesSubject(event, subject)) : -1;
    const namingStart = Math.max(namingPlace, endSeats);
    return [...fromAskedEnd.slice(0, endSeats), ...fromAskedEnd.slice(namingStart), ...fromAskedEnd.slice(endSeats, namingStart)].slice(0, lineCount);
}

/**
 * A first-time or last-time block's seats when the LLM chose: its lines, then the block's
 * lines in the same scene or the next, closest first. Other scenes take no seat, even a
 * free one, since a reader can name any scene it is shown.
 */
function seatsAroundChosen(chosenEvents, events, lineCount) {
    const chosenPlaces = chosenEvents.map(storyLinePosition);
    const gapOf = event => Math.min(...chosenPlaces.map(place => Math.abs(storyLinePosition(event) - place)));
    const near = events.filter(event => gapOf(event) <= SCENE_MESSAGE_GAP).sort((a, b) => gapOf(a) - gapOf(b));
    return withoutRepeats([...chosenEvents, ...near]).slice(0, lineCount);
}

/**
 * Cut a long block to its seats. A first-time or last-time block keeps the LLM's lines and
 * their scene, and any other block keeps the LLM's lines. When the LLM failed, a first-time
 * or last-time block takes its seat rule, and any other keeps its closest event of each
 * window, then its next closest.
 *
 * @param {object} params
 * @param {string} params.shape - The router's shape, which says what the question asks even when the block has no subject
 * @param {string} params.subject - The router's subject
 * @param {object[]} params.events - The block
 * @param {object[]} params.poolEvents - Hybrid hits, closest first
 * @param {object[]|null} params.chosenEvents - The LLM's lines, null when that failed
 * @param {number} params.lineCount - The lines the block keeps
 * @returns {object[]} events in time order
 */
export function cutBlockToSeats({ shape, subject, events, poolEvents, chosenEvents, lineCount }) {
    if (TIME_SHAPES.has(shape)) {
        const seats = chosenEvents?.length
            ? seatsAroundChosen(chosenEvents.slice(0, lineCount), events, lineCount)
            : seatsByTimeRule(shape, events, subject, lineCount);
        return inTimelineOrder(seats);
    }
    if (chosenEvents) return inTimelineOrder(chosenEvents.slice(0, lineCount));
    const placeByHash = new Map(poolEvents.map((event, place) => [event._hash, place]));
    const placeOf = (event) => placeByHash.get(event._hash) ?? Number.MAX_SAFE_INTEGER;
    const closestFirst = [...events].sort((a, b) => placeOf(a) - placeOf(b));
    // With no LLM to say which event of a window answers, each window takes a seat before any takes a second.
    const windowsSeated = new Set();
    const closestOfEachWindow = closestFirst.filter((event) => {
        const isFirstOfWindow = !windowsSeated.has(storyLinePosition(event));
        windowsSeated.add(storyLinePosition(event));
        return isFirstOfWindow;
    });
    return inTimelineOrder(withoutRepeats([...closestOfEachWindow, ...closestFirst]).slice(0, lineCount));
}
