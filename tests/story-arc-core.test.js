/**
 * Tests for StoryArc mode's pure logic (src/features/eventbase/story-arc-core.js):
 * reading the router's reply, whether a shape has a recipe, and which events each
 * recipe selects, with and without links, and which Route rule decided that.
 */

import { describe, it, expect } from 'vitest';
import {
    STORY_ROUTER_PROMPT,
    STORY_ROUTE_RULE,
    buildStoryRouterMessage,
    buildThreadPickMessage,
    hasRecipe,
    hasThreadPick,
    isStoryArcActive,
    listStoryThreads,
    readStoryRoute,
    readThreadPick,
    selectStoryRecipeEvents,
} from '../src/features/eventbase/story-arc-core.js';

const event = (start, text = `event at ${start}`, extra = {}) => ({ _hash: start, source_window_start: start, source_window_end: start + 1, text, ...extra });
const link = (hash, type = 'continues') => ({ hash, type, thread: 'a thread' });
const starts = (events) => events.map(item => item.source_window_start);
const select = (shape, subject, storedEvents, poolEvents) => selectStoryRecipeEvents({ shape, subject, storedEvents, poolEvents });

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

describe('hasRecipe', () => {
    it('gives a recipe to questions about the past', () => {
        for (const shape of ['first_time', 'chain', 'why', 'current', 'bigger_plot']) {
            expect(hasRecipe(shape), shape).toBe(true);
        }
    });

    // Ordinary turns must not change.
    it('gives none to a scene or an unknown shape', () => {
        for (const shape of ['scene', 'anything else']) {
            expect(hasRecipe(shape), shape).toBe(false);
        }
    });
});

describe('isStoryArcActive', () => {
    const on = { story_arc_mode_enabled: true, agentic_retrieval_enabled: true, vector_backend: 'qdrant' };

    it('needs its switch, Agent Mode and Qdrant', () => {
        expect(isStoryArcActive(on)).toBe(true);
        expect(isStoryArcActive({ ...on, story_arc_mode_enabled: false })).toBe(false);
        expect(isStoryArcActive({ ...on, agentic_retrieval_enabled: false })).toBe(false);
        expect(isStoryArcActive({ ...on, vector_backend: 'standard' })).toBe(false);
        expect(isStoryArcActive(undefined)).toBe(false);
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

describe('hasThreadPick', () => {
    it('picks threads only for a question about a thread', () => {
        for (const shape of ['chain', 'why', 'bigger_plot']) expect(hasThreadPick(shape), shape).toBe(true);
        for (const shape of ['first_time', 'current', 'scene', 'anything else']) expect(hasThreadPick(shape), shape).toBe(false);
    });
});

describe('listStoryThreads', () => {
    it('lists each name once at the message where it starts, oldest first', () => {
        const events = [
            event(300, 'c', { story_links: [{ hash: 1, type: 'continues', thread: 'The blockade' }] }),
            event(100, 'a', { story_links: [{ hash: 2, type: 'continues', thread: 'The blockade' }, { hash: 3, type: 'reveals', thread: 'The ledger' }] }),
            event(50, 'b', { story_links: [{ hash: 4, type: 'continues', thread: 'The duel' }] }),
        ];
        expect(listStoryThreads(events)).toEqual([
            { name: 'The duel', firstMessage: 50 },
            { name: 'The blockade', firstMessage: 100 },
            { name: 'The ledger', firstMessage: 100 },
        ]);
    });

    it('leaves out a link with no name and an event not yet decided', () => {
        expect(listStoryThreads([event(1, 'a', { story_links: [{ hash: 2, type: 'continues', thread: '' }] }), event(2)])).toEqual([]);
    });
});

describe('buildThreadPickMessage', () => {
    const threads = [{ name: 'The duel', firstMessage: 50 }, { name: 'The ledger', firstMessage: 100 }];

    // The list first lets a provider cache it, since only the question changes.
    it('puts the list first and the question last', () => {
        expect(buildThreadPickMessage(threads, 'How did Nora win?', 'Nora')).toBe("Threads:\n#50 The duel\n#100 The ledger\n\nPlayer's question:\nHow did Nora win?");
    });

    it('adds the subject when the question leaves it out', () => {
        expect(buildThreadPickMessage(threads, 'How did you win?', 'Nora')).toContain("Player's question:\nHow did you win?\nIt is about: Nora");
    });

    it('adds nothing when there is no subject', () => {
        expect(buildThreadPickMessage(threads, 'How did it end?', '')).not.toContain('It is about');
    });
});

describe('readThreadPick', () => {
    it('reads thread names in the model\'s order', () => {
        expect(readThreadPick({ threads: ['The ledger', 'The duel'] })).toEqual(['The ledger', 'The duel']);
    });

    // The model copies a list line whole more often than not.
    it('removes a copied message number', () => {
        expect(readThreadPick({ threads: ['#530 The ledger', ' #1840  The duel '] })).toEqual(['The ledger', 'The duel']);
    });

    it('drops what is not a name', () => {
        expect(readThreadPick({ threads: ['The duel', 3, null, '', '  '] })).toEqual(['The duel']);
    });

    it('reads an empty pick as no threads', () => {
        expect(readThreadPick({ threads: [] })).toEqual([]);
    });

    // A malformed reply must count as a failed pick, not as "nothing fits".
    it('throws when the reply has no list', () => {
        for (const reply of [{}, null, undefined, { threads: 'The duel' }]) {
            expect(() => readThreadPick(reply), JSON.stringify(reply)).toThrow('no threads array');
        }
    });
});

describe('selectStoryRecipeEvents with a thread pick', () => {
    const threadLink = (hash, thread) => ({ hash, type: 'continues', thread });
    const pick = (shape, storedEvents, poolEvents, pickedThreads) => selectStoryRecipeEvents({ shape, subject: '', storedEvents, poolEvents, pickedThreads });
    /** A thread the search never reaches, at messages 10 to 30. */
    const missed = [
        event(10, 'first step', { story_links: [] }),
        event(20, 'second step', { story_links: [threadLink(10, 'Finding the father')] }),
        event(30, 'third step', { story_links: [threadLink(20, 'Finding the father')] }),
    ];
    const hit = event(500, 'the closest hit', { story_links: [] });

    it('adds both ends of every link in a picked thread, past what the search found', () => {
        const { events, ruleName } = pick('chain', [...missed, hit], [hit], ['Finding the father']);
        expect(starts(events)).toEqual([10, 20, 30, 500]);
        expect(ruleName).toBe(STORY_ROUTE_RULE.THREAD_PICK);
    });

    it('works the same for every thread shape', () => {
        for (const shape of ['chain', 'why', 'bigger_plot']) {
            expect(starts(pick(shape, [...missed, hit], [hit], ['Finding the father']).events), shape).toEqual([10, 20, 30, 500]);
        }
    });

    it('reports the normal rule when no link carries a picked name', () => {
        const { events, ruleName } = pick('chain', [...missed, hit], [hit], ['A thread nobody named']);
        expect(starts(events)).toEqual([500]);
        expect(ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
    });

    it('reports the normal rule when nothing was picked', () => {
        expect(pick('chain', [...missed, hit], [hit], []).ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
    });

    /** 80 steps of one thread the question reaches, and a picked thread of 40 events. */
    const walkedThread = Array.from({ length: 80 }, (_, i) => event(5000 + i * 10, `walked ${i}`, { story_links: i ? [link(5000 + (i - 1) * 10)] : [] }));
    const bigPicked = Array.from({ length: 40 }, (_, i) => event(100 + i * 10, `picked ${i}`, { story_links: i ? [threadLink(100 + (i - 1) * 10, 'Big thread')] : [] }));

    it('caps a pick at 25 seats, which leaves the walk its own 50', () => {
        const poolEvents = [...walkedThread].reverse();
        const { events } = pick('chain', [...walkedThread, ...bigPicked], poolEvents, ['Big thread']);
        expect(events).toHaveLength(75);
        expect(events.filter(item => item.text.startsWith('picked'))).toHaveLength(25);
        expect(events.filter(item => item.text.startsWith('walked'))).toHaveLength(50);
    });

    it('seats a pick\'s closest events first', () => {
        const closePicked = bigPicked[39];
        const { events } = pick('chain', bigPicked, [closePicked], ['Big thread']);
        expect(starts(events)).toContain(closePicked.source_window_start);
    });

    // The same window is one step, whichever way the event got its seat.
    it('keeps one event per window across picks and the walk', () => {
        const picked = event(40, 'picked', { _hash: 1, story_links: [] });
        const sameWindow = event(40, 'walked', { _hash: 2, story_links: [] });
        const holder = event(60, 'holder', { _hash: 3, story_links: [threadLink(1, 'A thread')] });
        const { events } = pick('chain', [picked, sameWindow, holder], [sameWindow, holder], ['A thread']);
        expect(events.filter(item => item.source_window_start === 40)).toHaveLength(1);
    });

    it('tolerates a picked link to a deleted event', () => {
        const orphan = event(200, 'orphan', { story_links: [threadLink(12345, 'Lost thread')] });
        expect(starts(pick('chain', [orphan], [orphan], ['Lost thread']).events)).toEqual([200]);
    });

    it('leaves first-time and current-state blocks alone', () => {
        const first = selectStoryRecipeEvents({ shape: 'first_time', subject: 'hit', storedEvents: [...missed, hit], poolEvents: [hit], pickedThreads: ['Finding the father'] });
        expect(starts(first.events)).toEqual([500]);
        expect(first.ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
        const current = selectStoryRecipeEvents({ shape: 'current', subject: '', storedEvents: [...missed, hit], poolEvents: [hit], pickedThreads: ['Finding the father'] });
        expect(starts(current.events)).toEqual([500]);
    });
});

describe('selectStoryRecipeEvents without links', () => {
    const storedEvents = [90, 10, 30, 70, 50, 20, 40, 60].map(start => event(start, `Nora at ${start}`));

    it('gives a thread question the 75 closest events in time order', () => {
        const pool = Array.from({ length: 90 }, (_, i) => event(1000 - i));
        for (const shape of ['chain', 'why', 'bigger_plot']) {
            const { events, blockShape, ruleName } = select(shape, '', [], pool);
            expect(events).toHaveLength(75);
            expect(events[0].source_window_start).toBe(926);
            expect(events[74].source_window_start).toBe(1000);
            expect(blockShape).toBe(shape);
            expect(ruleName).toBe(STORY_ROUTE_RULE.LINKS_NOT_GENERATED);
        }
    });

    it('gives a first-time question the subject\'s earliest 5, whatever order they are stored in', () => {
        const { events, blockShape } = select('first_time', 'Nora', storedEvents, []);
        expect(starts(events)).toEqual([10, 20, 30, 40, 50]);
        expect(blockShape).toBe('first_time');
    });

    it('adds the closest hits that name the subject, at most 20', () => {
        const pool = [event(500, 'Someone else'), ...Array.from({ length: 25 }, (_, i) => event(1000 + i, 'Nora again'))];
        const { events } = select('first_time', 'Nora', [event(1, 'Nora once')], pool);
        expect(events).toHaveLength(21);
        expect(starts(events)).toContain(1000);
        expect(starts(events)).not.toContain(1024);
        expect(starts(events)).not.toContain(500);
    });

    // The stored text holds the characters and keywords lines, and users type Latin names in any case.
    it('matches the whole stored text, ignoring case', () => {
        const stored = [event(1, 'A meeting\nCHARS: Nora, Bo'), event(2, 'Nothing here')];
        expect(starts(select('first_time', 'nora', stored, []).events)).toEqual([1]);
    });

    it('matches a Chinese name inside a sentence', () => {
        const stored = [event(1, 'Critblade在包廂中詢問薇拉的名字'), event(2, '英妮獨自離開')];
        expect(starts(select('first_time', '薇拉', stored, []).events)).toEqual([1]);
    });

    it('gives the closest events under the thread header when the subject is empty or named nowhere', () => {
        const pool = [event(300), event(100), event(200)];
        for (const subject of ['', 'Bo']) {
            const { events, blockShape, ruleName } = select('first_time', subject, storedEvents, pool);
            expect(starts(events), subject).toEqual([100, 200, 300]);
            expect(blockShape, subject).toBe('chain');
            expect(ruleName, subject).toBe(STORY_ROUTE_RULE.FIRST_TIME_SUBJECT_NOT_FOUND);
        }
    });

    it('leaves a current-state question to today\'s path', () => {
        const { events, ruleName } = select('current', 'Nora', storedEvents, storedEvents);
        expect(events).toEqual([]);
        expect(ruleName).toBe(STORY_ROUTE_RULE.LINKS_NOT_GENERATED);
    });

    // Walks would stop at undecided events, so a chat part-way through a pass stays on the search.
    it('does not walk until 90% of events are decided', () => {
        const decided = Array.from({ length: 8 }, (_, i) => event(i + 1, `step ${i}`, { story_links: i ? [link(i)] : [] }));
        const undecided = [event(100), event(101)];
        const { ruleName } = select('chain', '', [...decided, ...undecided], [decided[7]]);
        expect(ruleName).toBe(STORY_ROUTE_RULE.LINKS_NOT_GENERATED);
    });
});

describe('selectStoryRecipeEvents with links', () => {
    /** A thread of steps at messages 100, 110, 120, 130, 140, plus unrelated decided events. */
    const thread = [100, 110, 120, 130, 140].map((start, i, all) => event(start, `step at ${start}`, { story_links: i ? [link(all[i - 1])] : [] }));
    const unrelated = Array.from({ length: 5 }, (_, i) => event(900 + i * 10, `other ${i}`, { story_links: [] }));
    const stored = [...thread, ...unrelated];

    it('walks a chain back and forward from a hit mid-thread, past what the search found', () => {
        const { events, blockShape, ruleName } = select('chain', '', stored, [thread[2]]);
        expect(starts(events)).toEqual([100, 110, 120, 130, 140]);
        expect(blockShape).toBe('chain');
        expect(ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
    });

    it('walks a why question back only, over its causes and steps', () => {
        const caused = event(50, 'the cause', { story_links: [] });
        const revealed = event(60, 'an aside', { story_links: [] });
        const effect = event(70, 'the effect', { story_links: [link(50, 'caused_by'), link(60, 'reveals')] });
        const after = event(80, 'what followed', { story_links: [link(70)] });
        const { events } = select('why', '', [caused, revealed, effect, after, ...unrelated], [effect]);
        expect(starts(events)).toEqual([50, 70]);
    });

    it('walks a bigger plot back over every link type, also from the hits naming the subject', () => {
        const root = event(10, 'the old rebellion', { story_links: [] });
        const reveal = event(20, 'the shard', { story_links: [link(10, 'reveals')] });
        const named = event(30, 'Nora learns of it', { story_links: [link(20, 'caused_by')] });
        const closeHits = Array.from({ length: 10 }, (_, i) => event(500 + i, 'close but unrelated', { story_links: [] }));
        const { events } = select('bigger_plot', 'Nora', [root, reveal, named, ...closeHits], [...closeHits, named]);
        expect(starts(events)).toEqual(expect.arrayContaining([10, 20, 30]));
    });

    // A window is one step of a thread, and a block wants steps, not the detail of one scene.
    it('keeps the closest event of each window', () => {
        const first = event(100, 'closer', { _hash: 1, story_links: [] });
        const second = event(100, 'further', { _hash: 2, story_links: [{ hash: 1, type: 'continues', thread: 't' }] });
        const third = event(110, 'next step', { _hash: 3, story_links: [{ hash: 2, type: 'continues', thread: 't' }] });
        const { events } = select('chain', '', [first, second, third], [third, first, second]);
        expect(events.map(item => item.text)).toEqual(['closer', 'next step']);
    });

    it('keeps a chain\'s top hits and what links reach from them, and no other hit', () => {
        const hits = Array.from({ length: 30 }, (_, i) => event(2000 + i, `hit ${i}`, { story_links: [] }));
        const { events } = select('chain', '', [...thread, ...hits], hits);
        expect(events).toHaveLength(10);
        expect(starts(events)).toContain(2009);
        expect(starts(events)).not.toContain(2010);
    });

    it('cuts a long walk to 75, keeping the closest, then those nearest the seeds', () => {
        const long = Array.from({ length: 100 }, (_, i) => event(i * 10 + 10, `step ${i}`, { story_links: i ? [link(i * 10)] : [] }));
        const lastStep = long[99];
        const closeEarlyStep = long[0];
        const { events } = select('chain', '', long, [lastStep, closeEarlyStep]);
        expect(events).toHaveLength(75);
        expect(starts(events)).toContain(closeEarlyStep.source_window_start);
        expect(starts(events)).toContain(lastStep.source_window_start);
        // The next closest are the steps one link from the seed at the end of the thread.
        expect(starts(events)).toContain(990);
    });

    it('walks a first-time question back from the subject\'s earliest events, reaching another spelling', () => {
        const scene = event(1180, 'Vera at the door', { story_links: [] });
        const named = event(1198, 'Mayla signs', { story_links: [link(1180)] });
        const decided = [event(1, 'unrelated', { story_links: [] }), scene, named];
        const { events, blockShape, ruleName } = select('first_time', 'Mayla', decided, [named]);
        expect(starts(events)).toEqual([1180, 1198]);
        expect(blockShape).toBe('first_time');
        expect(ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
    });

    // A long-range link from the earliest events would walk off into another thread.
    it('follows only scene links when a first-time walk leaves an event\'s strongest link', () => {
        const near = event(95, 'in the scene', { story_links: [] });
        const far = event(5, 'a long way back', { story_links: [] });
        const named = event(100, 'Nora arrives', { story_links: [link(95), link(5)] });
        const noisy = event(99, 'Someone else', { story_links: [link(5)] });
        const { events } = select('first_time', 'Nora', [far, near, noisy, named], [named]);
        expect(starts(events)).toEqual([95, 100]);
    });

    // These are not the subject's earliest events, so the block must not claim to be.
    it('starts a first-time walk from the closest events under the thread header when the subject is named nowhere', () => {
        const { events, blockShape, ruleName } = select('first_time', 'Bo', stored, [thread[1]]);
        expect(starts(events)).toEqual([100, 110]);
        expect(blockShape).toBe('chain');
        expect(ruleName).toBe(STORY_ROUTE_RULE.FIRST_TIME_SUBJECT_NOT_FOUND);
    });

    it('never makes a first-time block longer than 75', () => {
        const named = Array.from({ length: 100 }, (_, i) => event(i + 1, 'Nora here', { story_links: i ? [link(i)] : [] }));
        expect(select('first_time', 'Nora', named, [...named].reverse()).events.length).toBeLessThanOrEqual(75);
    });

    it('gives a current-state question the thread\'s newest events and the closest hits', () => {
        const long = Array.from({ length: 30 }, (_, i) => event(i * 10 + 10, `step ${i}`, { story_links: i ? [link(i * 10)] : [] }));
        const { events, blockShape, ruleName } = select('current', '', long, [long[2]]);
        expect(starts(events)).toEqual([30, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300]);
        expect(blockShape).toBe('current');
        expect(ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
    });

    it('keeps a pool event that is not in the listing, such as an archive hit', () => {
        const archive = event(7, 'from an archive');
        const { events } = select('chain', '', stored, [archive, thread[0]]);
        expect(starts(events)).toContain(7);
    });

    it('tolerates a link to a deleted event', () => {
        const orphan = event(200, 'orphan', { story_links: [link(12345)] });
        expect(starts(select('chain', '', [orphan], [orphan]).events)).toEqual([200]);
    });
});
