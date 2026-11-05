/**
 * Tests for StoryArc mode's pure logic (src/features/eventbase/story-arc-core.js):
 * reading the router's reply, whether a shape has a recipe, which events each recipe
 * selects, with and without links, which Route rule decided that, and how a long
 * block is cut.
 */

import { describe, it, expect } from 'vitest';
import {
    BLOCK_CUT_PROMPT_BY_SHAPE,
    STORY_ROUTER_PROMPT,
    STORY_ROUTE_RULE,
    buildBlockCutMessage,
    buildStoryRouterMessage,
    buildThreadPickMessage,
    cutBlockToSeats,
    hasRecipe,
    hasThreadPick,
    isBlockCutNeeded,
    isStoryArcActive,
    listStoryThreads,
    readBlockCut,
    readStoryRoute,
    readThreadPick,
    selectStoryRecipeEvents,
} from '../src/features/eventbase/story-arc-core.js';

const event = (start, text = `event at ${start}`, extra = {}) => ({ _hash: start, event_id: `id${extra._hash ?? start}`, source_window_start: start, source_window_end: start + 1, text, ...extra });
const link = (hash, type = 'continues') => ({ event_id: `id${hash}`, type, thread: 'a thread' });
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
        for (const shape of ['first_time', 'last_time', 'chain', 'why', 'current', 'bigger_plot']) {
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
        for (const shape of ['scene', 'first_time', 'last_time', 'chain', 'why', 'current', 'bigger_plot']) {
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
        for (const shape of ['first_time', 'last_time', 'current', 'scene', 'anything else']) expect(hasThreadPick(shape), shape).toBe(false);
    });
});

describe('listStoryThreads', () => {
    it('lists each name once at the message where it starts, oldest first', () => {
        const events = [
            event(300, 'c', { story_links: [{ event_id: 'id1', type: 'continues', thread: 'The blockade' }] }),
            event(100, 'a', { story_links: [{ event_id: 'id2', type: 'continues', thread: 'The blockade' }, { event_id: 'id3', type: 'reveals', thread: 'The ledger' }] }),
            event(50, 'b', { story_links: [{ event_id: 'id4', type: 'continues', thread: 'The duel' }] }),
        ];
        expect(listStoryThreads(events)).toEqual([
            { name: 'The duel', firstMessage: 50 },
            { name: 'The blockade', firstMessage: 100 },
            { name: 'The ledger', firstMessage: 100 },
        ]);
    });

    it('leaves out a link with no name and an event not yet decided', () => {
        expect(listStoryThreads([event(1, 'a', { story_links: [{ event_id: 'id2', type: 'continues', thread: '' }] }), event(2)])).toEqual([]);
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
    const threadLink = (hash, thread) => ({ event_id: `id${hash}`, type: 'continues', thread });
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

    // A window counts once towards the block, whichever way its events got there.
    it('counts a window once across picks and the walk, and keeps its events', () => {
        const picked = event(40, 'picked', { _hash: 1, story_links: [] });
        const sameWindow = event(40, 'walked', { _hash: 2, story_links: [] });
        const holder = event(60, 'holder', { _hash: 3, story_links: [threadLink(1, 'A thread')] });
        const { events } = pick('chain', [picked, sameWindow, holder], [sameWindow, holder], ['A thread']);
        expect(events.filter(item => item.source_window_start === 40).map(item => item.text).sort()).toEqual(['picked', 'walked']);
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

    it('gives a last-time question the subject\'s latest 5, whatever order they are stored in', () => {
        const { events, blockShape, ruleName } = select('last_time', 'Nora', storedEvents, []);
        expect(starts(events)).toEqual([40, 50, 60, 70, 90]);
        expect(blockShape).toBe('last_time');
        expect(ruleName).toBe(STORY_ROUTE_RULE.LINKS_NOT_GENERATED);
    });

    it('adds a last-time question\'s closest hits naming the subject, and the top 10 hits under any name', () => {
        const pool = [...Array.from({ length: 12 }, (_, i) => event(500 + i, 'Someone else')), ...Array.from({ length: 25 }, (_, i) => event(1000 + i, 'Nora again'))];
        const { events } = select('last_time', 'Nora', [event(1, 'Nora once')], pool);
        expect(events).toHaveLength(31);
        expect(starts(events)).toContain(509);
        expect(starts(events)).not.toContain(510);
        expect(starts(events)).toContain(1019);
        expect(starts(events)).not.toContain(1020);
    });

    it('gives a last-time question the closest events under the thread header when the subject is empty or named nowhere', () => {
        const pool = [event(300), event(100), event(200)];
        for (const subject of ['', 'Bo']) {
            const { events, blockShape, ruleName } = select('last_time', subject, storedEvents, pool);
            expect(starts(events), subject).toEqual([100, 200, 300]);
            expect(blockShape, subject).toBe('chain');
            expect(ruleName, subject).toBe(STORY_ROUTE_RULE.LAST_TIME_SUBJECT_NOT_FOUND);
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

    // A window can tell several things, and a search rank cannot say which answers the question.
    it('keeps every event of a window it reaches, even one no link or hit reaches', () => {
        const linked = event(100, 'linked', { _hash: 1, story_links: [] });
        const unreached = event(100, 'no link to it', { _hash: 2, story_links: [] });
        const hit = event(110, 'next step', { _hash: 3, story_links: [{ event_id: 'id1', type: 'continues', thread: 't' }] });
        const { events } = select('chain', '', [linked, unreached, hit], [hit]);
        expect(events.map(item => item.text).sort()).toEqual(['linked', 'next step', 'no link to it']);
    });

    it('counts windows towards a thread block, so 75 of them can hold more lines', () => {
        const long = Array.from({ length: 100 }, (_, i) => event(i * 10 + 10, `step ${i}`, { story_links: i ? [link(i * 10)] : [] }));
        const others = long.map(item => event(item.source_window_start, `other at ${item.source_window_start}`, { _hash: item.source_window_start + 1, story_links: [] }));
        const { events } = select('chain', '', [...long, ...others], [long[99]]);
        expect(new Set(starts(events)).size).toBe(75);
        expect(events).toHaveLength(150);
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

    it('walks a last-time question forward from the subject\'s latest events, reaching another spelling', () => {
        const named = event(2500, 'Mayla signs', { story_links: [] });
        const later = event(2510, 'Vera at the door', { story_links: [link(2500)] });
        const unrelated = event(100, 'Someone else', { story_links: [] });
        const { events, blockShape, ruleName } = select('last_time', 'Mayla', [unrelated, named, later], [named]);
        expect(starts(events)).toEqual([2500, 2510]);
        expect(blockShape).toBe('last_time');
        expect(ruleName).toBe(STORY_ROUTE_RULE.SHAPE_RECIPE);
    });

    // A long-range link from the latest events would walk off into another thread.
    it('follows only scene links on a last-time walk past an event\'s strongest link', () => {
        const named = event(100, 'Nora arrives', { story_links: [] });
        const near = event(110, 'in the scene', { story_links: [link(100)] });
        const other = event(50, 'elsewhere', { story_links: [] });
        const far = event(900, 'a long way on', { story_links: [link(50), link(100)] });
        const { events } = select('last_time', 'Nora', [other, named, near, far], [named]);
        expect(starts(events)).toEqual([100, 110]);
    });

    it('seats a last-time block\'s top hits, which can use a spelling the question did not', () => {
        const named = event(1920, 'Nora speaks', { story_links: [] });
        const laterSpelling = event(2588, 'Norah returns', { story_links: [] });
        const { events } = select('last_time', 'Nora speaks', [named, laterSpelling], [laterSpelling, named]);
        expect(starts(events)).toEqual([1920, 2588]);
    });

    it('starts a last-time walk from the closest events under the thread header when the subject is named nowhere', () => {
        const { events, blockShape, ruleName } = select('last_time', 'Bo', stored, [thread[3]]);
        expect(starts(events)).toEqual([130, 140]);
        expect(blockShape).toBe('chain');
        expect(ruleName).toBe(STORY_ROUTE_RULE.LAST_TIME_SUBJECT_NOT_FOUND);
    });

    it('never makes a last-time block longer than 75', () => {
        const named = Array.from({ length: 100 }, (_, i) => event(i + 1, 'Nora here', { story_links: i ? [link(i)] : [] }));
        expect(select('last_time', 'Nora', named, [...named].reverse()).events.length).toBeLessThanOrEqual(75);
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

describe('the block cut', () => {
    /** A block of 30 events at messages 100 to 158. Only those from 140 on name Nora. */
    const block = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, i >= 20 ? `Nora at ${100 + i * 2}` : `Bo at ${100 + i * 2}`));
    const pool = [...block].reverse();
    const firstTwenty = starts(block).slice(0, 20);
    const lastTwenty = starts(block).slice(-20);

    describe('isBlockCutNeeded', () => {
        it('cuts a block over 20 for every shape with a prompt', () => {
            for (const shape of ['first_time', 'last_time', 'chain', 'why', 'bigger_plot']) {
                expect(isBlockCutNeeded(shape, 21), shape).toBe(true);
                expect(isBlockCutNeeded(shape, 20), shape).toBe(false);
            }
        });

        // A current-state block holds at most its 10 newest and its 10 closest.
        it('never cuts a current-state block or a turn with no recipe', () => {
            for (const shape of ['current', 'scene', 'anything else']) expect(isBlockCutNeeded(shape, 75), shape).toBe(false);
        });
    });

    describe('BLOCK_CUT_PROMPT_BY_SHAPE', () => {
        it('asks a date question for its own end of the story, and any other for 20 lines', () => {
            expect(BLOCK_CUT_PROMPT_BY_SHAPE.first_time).toContain('up to 20 events from the earliest scene');
            expect(BLOCK_CUT_PROMPT_BY_SHAPE.last_time).toContain('up to 20 events from the latest scene');
            for (const shape of ['chain', 'why', 'bigger_plot']) expect(BLOCK_CUT_PROMPT_BY_SHAPE[shape], shape).toContain('Choose the 20 events');
        });

        it('gives every shape its own goal, and asks for each line\'s label', () => {
            expect(new Set(Object.values(BLOCK_CUT_PROMPT_BY_SHAPE)).size).toBe(5);
            for (const prompt of Object.values(BLOCK_CUT_PROMPT_BY_SHAPE)) expect(prompt).toContain('# label of each line');
        });
    });

    describe('buildBlockCutMessage', () => {
        const events = [event(30, 'A later step'), event(10, 'A first step', { cause: 'Why it began.', result: 'How it ended.' })];

        it('lists the lines oldest first with their positions, then the question', () => {
            expect(buildBlockCutMessage(events, 'How did it go?', '')).toBe("Events:\n- #10: Why it began. A first step How it ended.\n- #30: A later step\n\nPlayer's question:\nHow did it go?");
        });

        it('gives the lines of one window their own letters, and any other line its position', () => {
            const shared = [event(30, 'three'), event(10, 'one', { _hash: 1 }), event(10, 'two', { _hash: 2 })];
            expect(buildBlockCutMessage(shared, 'Why?', '')).toBe("Events:\n- #10a: one\n- #10b: two\n- #30: three\n\nPlayer's question:\nWhy?");
        });

        it('adds the subject only when the question leaves it out', () => {
            expect(buildBlockCutMessage(events, 'How did you win?', 'Nora')).toContain("Player's question:\nHow did you win?\nIt is about: Nora");
            expect(buildBlockCutMessage(events, 'How did Nora win?', 'Nora')).not.toContain('It is about');
        });
    });

    describe('readBlockCut', () => {
        const events = [event(10), event(20), event(30)];

        it('reads positions in the model\'s order, with or without a copied #', () => {
            expect(starts(readBlockCut({ events: [30, '#10', '- #20:'] }, events))).toEqual([30, 10, 20]);
        });

        describe('when a window holds several lines', () => {
            const shared = [event(10, 'one', { _hash: 1 }), event(10, 'two', { _hash: 2 }), event(20, 'three')];
            const textsOf = (reply) => readBlockCut(reply, shared).map(item => item.text);

            it('takes the one line a label names', () => {
                expect(textsOf({ events: ['10b', '#20'] })).toEqual(['two', 'three']);
                expect(textsOf({ events: ['#10A'] })).toEqual(['one']);
            });

            it('takes every line at a position for a bare number', () => {
                expect(textsOf({ events: [10] })).toEqual(['one', 'two']);
            });

            it('takes every line at a position for a letter the block does not have', () => {
                expect(textsOf({ events: ['10z', '20a'] })).toEqual(['one', 'two', 'three']);
            });

            it('takes a line once when two entries name it', () => {
                expect(textsOf({ events: ['10a', 10] })).toEqual(['one', 'two']);
            });
        });

        it('ignores a position that is not in the block, and a repeat', () => {
            expect(starts(readBlockCut({ events: [10, 999, 10, 'none'] }, events))).toEqual([10]);
        });

        // A malformed reply must not read as "nothing answers this", which would empty the block.
        it('throws when the reply has no list', () => {
            for (const reply of [{}, null, undefined, { events: 10 }]) {
                expect(() => readBlockCut(reply, events), JSON.stringify(reply)).toThrow('no events array');
            }
        });

        it('throws when the reply names no line', () => {
            for (const reply of [{ events: [] }, { events: [999] }]) {
                expect(() => readBlockCut(reply, events), JSON.stringify(reply)).toThrow('names no line');
            }
        });
    });

    describe('cutBlockToSeats on a thread question', () => {
        const cut = (chosenEvents) => cutBlockToSeats({ shape: 'chain', subject: 'Nora', events: block, poolEvents: pool, chosenEvents });

        it('keeps only the LLM\'s lines, in time order', () => {
            expect(starts(cut([block[5], block[1]]))).toEqual([102, 110]);
        });

        // Several events can share a position, so a reply can name more than the seats hold.
        it('holds the LLM\'s lines to 20', () => {
            expect(cut(block)).toHaveLength(20);
        });

        it('keeps the 20 closest in time order when the LLM failed', () => {
            expect(starts(cut(null))).toEqual(lastTwenty);
        });

        it('seats each window before any window takes a second event when the LLM failed', () => {
            const twins = Array.from({ length: 25 }, (_, i) => [
                event(200 + i * 2, `first ${i}`, { _hash: 1000 + i }),
                event(200 + i * 2, `second ${i}`, { _hash: 2000 + i }),
            ]).flat();
            const seats = cutBlockToSeats({ shape: 'chain', subject: '', events: twins, poolEvents: twins, chosenEvents: null });
            expect(seats).toHaveLength(20);
            expect(new Set(starts(seats)).size).toBe(20);
        });

        it('ranks an event the search did not find after every hit', () => {
            const hits = block.slice(10);
            const walked = cutBlockToSeats({ shape: 'why', subject: '', events: block, poolEvents: hits, chosenEvents: null });
            expect(starts(walked)).toEqual(starts(hits));
        });
    });

    describe('cutBlockToSeats on a first-time question', () => {
        const cut = (chosenEvents, subject = 'Nora', events = block) => cutBlockToSeats({ shape: 'first_time', subject, events, poolEvents: pool, chosenEvents });

        it('takes 10 from the block\'s start and 10 from where it first names the subject when the LLM failed', () => {
            expect(starts(cut(null))).toEqual([...starts(block).slice(0, 10), ...starts(block).slice(20, 30)]);
        });

        it('seats the LLM\'s lines first, and the rule fills the rest', () => {
            const chosen = [block[15], block[16]];
            const kept = starts(cut(chosen));
            expect(kept).toHaveLength(20);
            expect(kept).toEqual(expect.arrayContaining(starts(chosen)));
            expect(kept.slice(0, 10)).toEqual(starts(block).slice(0, 10));
            // The last of the rule's seats gave way.
            expect(kept).not.toContain(158);
            expect(kept).not.toContain(156);
        });

        it('takes the block\'s first 20 when the subject is empty or named nowhere', () => {
            for (const subject of ['', 'Zed']) expect(starts(cut(null, subject)), subject).toEqual(firstTwenty);
        });

        it('takes the first 20 when the block names the subject among its first events', () => {
            expect(starts(cut(null, 'Bo'))).toEqual(firstTwenty);
        });

        it('fills empty seats when the block first names the subject near its far end', () => {
            const kept = starts(cut(null, 'at 158'));
            expect(kept).toHaveLength(20);
            expect(kept).toContain(158);
            expect(kept.slice(0, 19)).toEqual(starts(block).slice(0, 19));
        });

        it('holds the LLM\'s lines to 20', () => {
            expect(cut(block)).toHaveLength(20);
        });
    });

    describe('cutBlockToSeats on a last-time question', () => {
        /** A block whose subject is last named at message 118, with later events walked to under other names. */
        const earlyNaming = Array.from({ length: 30 }, (_, i) => event(100 + i * 2, i < 10 ? `Nora at ${100 + i * 2}` : `Bo at ${100 + i * 2}`));
        const cut = (chosenEvents, subject = 'Nora', events = earlyNaming) => cutBlockToSeats({ shape: 'last_time', subject, events, poolEvents: pool, chosenEvents });

        it('takes 10 from the block\'s end and 10 up to where it last names the subject when the LLM failed', () => {
            expect(starts(cut(null))).toEqual([...starts(earlyNaming).slice(0, 10), ...starts(earlyNaming).slice(20, 30)]);
        });

        it('seats the LLM\'s lines first, and the rule fills the rest from the newest', () => {
            const chosen = [earlyNaming[15], earlyNaming[16]];
            const kept = starts(cut(chosen));
            expect(kept).toHaveLength(20);
            expect(kept).toEqual(expect.arrayContaining(starts(chosen)));
            expect(kept.slice(-10)).toEqual(starts(earlyNaming).slice(-10));
            // The oldest of the rule's seats gave way.
            expect(kept).not.toContain(100);
            expect(kept).not.toContain(102);
        });

        it('takes the block\'s last 20 when the subject is empty or named nowhere', () => {
            for (const subject of ['', 'Zed']) expect(starts(cut(null, subject)), subject).toEqual(lastTwenty);
        });
    });
});
