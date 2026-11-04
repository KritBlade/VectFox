/**
 * ============================================================================
 * STORY ARC CORE
 * ============================================================================
 * Pure logic for StoryArc mode, which answers questions about the story's past
 * that a top-K similarity search misses, such as "how did she become head of
 * the guild?" or "do you remember when we first met?".
 *
 * A small LLM call, the router, reads the player's message and returns the
 * question's shape and subject. The shape picks a recipe: which events to fetch
 * and how many. Ordinary turns have no recipe and keep today's retrieval path.
 *
 * @see InternalProject/Vectfox/plans/story-arc.md
 * ============================================================================
 */

import { packTimelineSortKey } from './eventbase-schema.js';

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

/** The hybrid search's closest events, shown in time order. */
const TIME_ORDERED_RECIPE = 'time_ordered';
/** A subject's earliest events, plus the closest events that name it. */
export const FIRST_TIME_RECIPE = 'first_time';
/** The shape whose block suits any events in time order. */
export const THREAD_SHAPE = 'chain';

const RECIPE_BY_SHAPE = {
    first_time: FIRST_TIME_RECIPE,
    chain: TIME_ORDERED_RECIPE,
    why: TIME_ORDERED_RECIPE,
    bigger_plot: TIME_ORDERED_RECIPE,
};

/** Events in a time-ordered block. 50 short lines fit where today's 10 full events do. */
export const TIME_ORDERED_EVENT_LIMIT = 50;
/** The first-time recipe's closest events are picked from this many hybrid hits, since the search cannot be limited to chosen events. */
export const FIRST_TIME_POOL_SIZE = 100;
const FIRST_TIME_EARLIEST_COUNT = 5;
const FIRST_TIME_CLOSEST_COUNT = 20;

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
 * The recipe for a question shape, or null when the turn keeps today's path.
 * @param {string} shape
 * @returns {string|null}
 */
export function recipeForShape(shape) {
    return RECIPE_BY_SHAPE[shape] ?? null;
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

/**
 * The first-time recipe's events: the subject's earliest events, and the hybrid
 * hits closest to the question that also name the subject.
 *
 * @param {object} params
 * @param {object[]} params.storedEvents - Every event in the collection
 * @param {object[]} params.poolEvents - Hybrid hits, closest first
 * @param {string} params.subject
 * @returns {object[]} may repeat an event; empty when nothing names the subject
 */
export function selectFirstTimeEvents({ storedEvents, poolEvents, subject }) {
    if (!subject) return [];
    const earliest = inTimelineOrder(storedEvents.filter(event => eventNamesSubject(event, subject))).slice(0, FIRST_TIME_EARLIEST_COUNT);
    const closest = poolEvents.filter(event => eventNamesSubject(event, subject)).slice(0, FIRST_TIME_CLOSEST_COUNT);
    return [...earliest, ...closest];
}
