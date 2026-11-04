/**
 * Tests for StoryArc mode's pure logic (src/features/eventbase/story-arc-core.js):
 * reading the router's reply, choosing a recipe, keeping events in chat order, and
 * picking a subject's earliest and closest events.
 */

import { describe, it, expect } from 'vitest';
import {
    STORY_ROUTER_PROMPT,
    buildStoryRouterMessage,
    inTimelineOrder,
    readStoryRoute,
    recipeForShape,
    selectFirstTimeEvents,
} from '../src/features/eventbase/story-arc-core.js';

const event = (start, text, extra = {}) => ({ source_window_start: start, source_window_end: start + 1, text, ...extra });
const starts = (events) => events.map(item => item.source_window_start);

describe('readStoryRoute', () => {
    it('reads a known shape and its subject', () => {
        expect(readStoryRoute({ shape: 'first_time', subject: ' Nora ' })).toEqual({ shape: 'first_time', subject: 'Nora', isKnownShape: true });
    });

    // Anything else keeps today's retrieval path, and the caller warns about it.
    it('reads an unknown or missing shape as a scene', () => {
        for (const reply of [{ shape: 'history' }, { shape: 7 }, {}, null, undefined, 'first_time', { shape: 'constructor' }]) {
            expect(readStoryRoute(reply), JSON.stringify(reply)).toMatchObject({ shape: 'scene', isKnownShape: false });
        }
    });

    it('reads a missing or non-text subject as empty', () => {
        expect(readStoryRoute({ shape: 'chain' }).subject).toBe('');
        expect(readStoryRoute({ shape: 'chain', subject: 3 }).subject).toBe('');
    });
});

describe('recipeForShape', () => {
    it('gives the first-time recipe to first-time questions', () => {
        expect(recipeForShape('first_time')).toBe('first_time');
    });

    it('gives the time-ordered recipe to thread questions', () => {
        for (const shape of ['chain', 'why', 'bigger_plot']) {
            expect(recipeForShape(shape), shape).toBe('time_ordered');
        }
    });

    // Top hits already answer "where is he now", and ordinary turns must not change.
    it('gives no recipe to scene and current, so they keep today\'s path', () => {
        for (const shape of ['scene', 'current', 'anything else']) {
            expect(recipeForShape(shape), shape).toBeNull();
        }
    });
});

describe('STORY_ROUTER_PROMPT', () => {
    it('offers every shape a recipe or today\'s path handles', () => {
        for (const shape of ['scene', 'first_time', 'chain', 'why', 'current', 'bigger_plot']) {
            expect(STORY_ROUTER_PROMPT).toContain(`"${shape}"`);
        }
    });
});

describe('buildStoryRouterMessage', () => {
    it('shows the end of the last two earlier turns, then the message', () => {
        const message = buildStoryRouterMessage({
            recentTurns: [
                { speaker: 'A', text: 'oldest turn' },
                { speaker: 'B', text: 'middle turn' },
                { speaker: 'C', text: `${'x'.repeat(700)}the end` },
                { speaker: 'Player', text: 'Where are you?' },
            ],
            userMessage: 'Where are you?',
        });
        expect(message).not.toContain('oldest turn');
        expect(message).toContain('B: middle turn');
        expect(message).toContain('the end');
        expect(message.length).toBeLessThan(800);
        expect(message.indexOf('Player\'s message:')).toBeGreaterThan(message.indexOf('the end'));
        expect(message.endsWith('Where are you?')).toBe(true);
        // The message itself is not repeated as recent chat.
        expect(message.indexOf('Where are you?')).toBe(message.lastIndexOf('Where are you?'));
    });

    it('says so when there is no recent chat', () => {
        expect(buildStoryRouterMessage({ recentTurns: [], userMessage: 'Hi' })).toContain('Recent chat:\n(none)');
        expect(buildStoryRouterMessage({ recentTurns: undefined, userMessage: 'Hi' })).toContain('(none)');
    });
});

describe('inTimelineOrder', () => {
    it('sorts by timeline_sort_key, so events of one window keep their real order', () => {
        const ordered = inTimelineOrder([
            { timeline_sort_key: 20010000, id: 'second window' },
            { timeline_sort_key: 20000001, id: 'first window, second event' },
            { timeline_sort_key: 20000000, id: 'first window, first event' },
        ]);
        expect(ordered.map(item => item.id)).toEqual(['first window, first event', 'first window, second event', 'second window']);
    });

    it('places events without the key on the same scale', () => {
        const ordered = inTimelineOrder([
            { timeline_sort_key: 30000000, id: 'new, message 3000' },
            { source_window_start: 2000, id: 'old, message 2000' },
            { source_window_start: 2000, window_event_order: 1, id: 'old, message 2000, second' },
            { source_window_end: 4000, id: 'old, only an end' },
        ]);
        expect(ordered.map(item => item.id)).toEqual(['old, message 2000', 'old, message 2000, second', 'new, message 3000', 'old, only an end']);
    });

    it('does not change the array it is given', () => {
        const events = [{ timeline_sort_key: 2 }, { timeline_sort_key: 1 }];
        inTimelineOrder(events);
        expect(events[0].timeline_sort_key).toBe(2);
    });
});

describe('selectFirstTimeEvents', () => {
    const storedEvents = [90, 10, 30, 70, 50, 20, 40, 60].map(start => event(start, `Nora at ${start}`));

    it('takes the subject\'s earliest 5, whatever order they are stored in', () => {
        const chosen = selectFirstTimeEvents({ storedEvents, poolEvents: [], subject: 'Nora' });
        expect(starts(chosen)).toEqual([10, 20, 30, 40, 50]);
    });

    it('adds the closest hits that name the subject, closest first, at most 20', () => {
        const poolEvents = [
            event(500, 'Someone else'),
            ...Array.from({ length: 25 }, (_, i) => event(1000 + i, 'Nora again')),
        ];
        const chosen = selectFirstTimeEvents({ storedEvents: [], poolEvents, subject: 'Nora' });
        expect(chosen).toHaveLength(20);
        expect(chosen[0].source_window_start).toBe(1000);
        expect(starts(chosen)).not.toContain(500);
    });

    // The stored text holds the characters and keywords lines, and users type Latin names in any case.
    it('matches the whole stored text, ignoring case', () => {
        const stored = [event(1, 'A meeting\nCHARS: Nora, Bo'), event(2, 'Nothing here')];
        expect(starts(selectFirstTimeEvents({ storedEvents: stored, poolEvents: [], subject: 'nora' }))).toEqual([1]);
    });

    it('matches a Chinese name inside a sentence', () => {
        const stored = [event(1, 'Critblade在包廂中詢問薇拉的名字'), event(2, '英妮獨自離開')];
        expect(starts(selectFirstTimeEvents({ storedEvents: stored, poolEvents: [], subject: '薇拉' }))).toEqual([1]);
    });

    it('returns nothing for an empty subject or one named nowhere', () => {
        expect(selectFirstTimeEvents({ storedEvents, poolEvents: storedEvents, subject: '' })).toEqual([]);
        expect(selectFirstTimeEvents({ storedEvents, poolEvents: storedEvents, subject: 'Bo' })).toEqual([]);
    });
});
