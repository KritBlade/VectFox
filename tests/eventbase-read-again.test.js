/**
 * Reading a stretch of the open chat again (src/features/eventbase/eventbase-read-again.js,
 * eventbase-read-range-again.md): before the run, what the stretch holds, on which models, and what it costs, with a
 * price only where VectFox can read one (D2); after the windows are read, StoryArc's two steps on the same progress
 * panel and the verdict that ends it (B2, B3).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    chat: [],
    inUse: null,
    storedEvents: [],
    storedEventsError: null,
    tokenizerError: null,
    linkConfig: { ok: true },
    profile: { problem: '', name: 'Writer', model: 'glm-5' },
}));

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ chat: host.chat }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
// One token a character, so each count is the text's length.
vi.mock('../src/sillytavern/tokenizers.js', () => ({
    getTokenCountAsync: vi.fn(async (text) => {
        if (host.tokenizerError) throw host.tokenizerError;
        return text.length;
    }),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { complete: vi.fn() } }));
vi.mock('../src/features/llm-provider/index.js', () => ({
    describeChatConnectionProfile: vi.fn(() => host.profile),
    readOpenRouterModelPrice: vi.fn(async () => ({ input: 0.000001, output: 0.000004 })),
}));
vi.mock('../src/features/text-cleaning/index.js', () => ({ cleanText: text => text }));
vi.mock('../src/features/eventbase/agentic-retrieval.js', () => ({ resolveStoryLinkLlmConfig: () => host.linkConfig }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    collectionInUse: () => ({ collection: host.inUse, reason: host.inUse ? null : 'no-collection', collections: [], lockedElsewhere: [] }),
    noCollectionInUseText: () => null,
}));
vi.mock('../src/features/eventbase/eventbase-schema.js', async importOriginal => ({
    ...(await importOriginal()),
    buildExtractionPrompt: () => 'P'.repeat(100),
}));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    readStoredEvents: vi.fn(async () => {
        if (host.storedEventsError) throw host.storedEventsError;
        return host.storedEvents;
    }),
}));
vi.mock('../src/features/eventbase/story-arc-core.js', () => ({ isStoryArcActive: settings => Boolean(settings.story_arc_mode_enabled) }));
vi.mock('../src/features/eventbase/story-arc-links.js', () => ({
    linkEventsReadAgain: vi.fn(),
    readLinkModelPrice: vi.fn(async () => null),
}));
vi.mock('../src/features/eventbase/story-language.js', () => ({ readStoryLanguage: () => ({ promptMode: 'intl' }) }));

const { describeReadingAgain, finishReadingAgain } = await import('../src/features/eventbase/eventbase-read-again.js');
const { readOpenRouterModelPrice } = await import('../src/features/llm-provider/index.js');
const { linkEventsReadAgain } = await import('../src/features/eventbase/story-arc-links.js');
const { progressTracker } = await import('../src/shared/progress-tracker.js');
const { estimateStoryLinkPass } = await import('../src/features/eventbase/story-arc-links-core.js');

const SETTINGS = {
    eventbase_window_overlap: 0,
    chat_provider: 'openrouter',
    chat_model: 'deepseek/deepseek-v4',
    story_arc_mode_enabled: true,
    story_arc_link_provider: 'openrouter',
    story_arc_link_model: 'openai/gpt-6-luna',
};
const eventOf = (eventId, windowStart, links) => ({
    event_id: eventId, source_window_start: windowStart, source_window_end: windowStart + 1, story_links: links ?? [],
});
const describeMessages4To7 = (settings = SETTINGS) => describeReadingAgain({ settings, startFromMessage: 4, endAtMessage: 7, windowSize: 2 });

beforeEach(() => {
    vi.clearAllMocks();
    host.chat = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? 'User' : 'Bot', mes: `message ${i}` }));
    host.chat.splice(5, 0, { name: 'User', mes: '   ' });
    host.inUse = { collectionId: 'vf_eventbase_chat', registryKey: 'qdrant:vf_eventbase_chat', name: 'Harbor Keeper' };
    host.storedEvents = [
        eventOf('before', 0),
        eventOf('held-a', 2),
        eventOf('held-b', 4),
        eventOf('held-c', 4),
        eventOf('after-in', 8, [{ event_id: 'held-b', type: 'continues', thread: '' }]),
        eventOf('after-out', 10, [{ event_id: 'before', type: 'continues', thread: '' }]),
    ];
    host.storedEventsError = null;
    host.tokenizerError = null;
    host.linkConfig = { ok: true };
    host.profile = { problem: '', name: 'Writer', model: 'glm-5' };
});

describe('describeReadingAgain', () => {
    it('snaps the stretch to whole windows on the chat as the run counts it, and counts what its windows hold and what links into them', async () => {
        const plan = await describeMessages4To7();

        expect(plan).toMatchObject({
            problem: '', collectionId: 'vf_eventbase_chat', collectionName: 'Harbor Keeper',
            firstMessage: 3, lastMessage: 8, windowCount: 3, heldCount: 3, linkingInCount: 1, willLink: true, waitReason: '',
            stepTitles: { windows: 'Reading again, step 1 of 3: windows' },
        });
    });

    it('counts the prompt tokens from the windows\' real text, and prices them on manual OpenRouter from the model\'s own price', async () => {
        const plan = await describeMessages4To7();

        // Messages 2 to 7 of the chat with text, each as "Name: text", joined by a blank line; the blank message is left out.
        const stretchText = ['Bot: message 2', 'User: message 3', 'Bot: message 4', 'User: message 5', 'Bot: message 6', 'User: message 7'].join('\n\n');
        const inputTokens = 3 * 100 + stretchText.length;
        expect(plan.extraction).toEqual({ model: 'deepseek/deepseek-v4 on OpenRouter', inputTokens, costUsd: inputTokens * 0.000001 });
        expect(readOpenRouterModelPrice).toHaveBeenCalledWith('deepseek/deepseek-v4');
        expect(plan.links).toEqual({ model: 'openai/gpt-6-luna on OpenRouter', estimate: estimateStoryLinkPass(4, null, 3) });
    });

    it('names a connection profile\'s model and shows no price for it, as a user may run any model there', async () => {
        const plan = await describeMessages4To7({ ...SETTINGS, chat_provider: 'connection_profile' });

        expect(plan.extraction).toMatchObject({ model: 'Writer (glm-5), a connection profile', costUsd: null });
        expect(readOpenRouterModelPrice).not.toHaveBeenCalled();
    });

    it('shows no token count, and so no price, when SillyTavern\'s tokenizer cannot count', async () => {
        host.tokenizerError = new Error('The tokenizer is not loaded');

        const plan = await describeMessages4To7();

        expect(plan.extraction).toMatchObject({ inputTokens: null, costUsd: null });
    });

    it('links nothing, saying why, in a collection no link pass has linked', async () => {
        host.storedEvents = host.storedEvents.map(({ story_links: _links, ...event }) => event);

        const plan = await describeMessages4To7();

        expect(plan).toMatchObject({ willLink: false, links: null, stepTitles: { windows: 'Reading again: windows' } });
        expect(plan.waitReason).toContain('no StoryArc link pass');
    });

    it('links when the only undecided events are the ones its windows hold, as a read of the stretch that failed before linking leaves', async () => {
        const isHeld = event => [2, 4].includes(event.source_window_start);
        host.storedEvents = host.storedEvents.map(({ story_links: links, ...event }) => (isHeld(event) ? event : { ...event, story_links: links }));

        const plan = await describeMessages4To7();

        expect(plan).toMatchObject({ willLink: true, waitReason: '' });
    });

    it('says why there is nothing to read: no collection in use, no whole window, or events it cannot read', async () => {
        host.inUse = null;
        expect((await describeMessages4To7()).problem).toContain('no EventBase collection yet');

        host.inUse = { collectionId: 'vf_eventbase_chat', name: 'Harbor Keeper' };
        expect((await describeReadingAgain({ settings: SETTINGS, startFromMessage: 9, endAtMessage: 4, windowSize: 2 })).problem)
            .toBe('No whole window of 2 messages lies between those messages, so there is nothing to read again.');

        host.storedEventsError = new Error('Qdrant is unreachable');
        expect((await describeMessages4To7()).problem).toContain('Could not read the collection\'s events');
    });
});

describe('finishReadingAgain', () => {
    const result = { windowsProcessed: 3, eventsExtracted: 4, insertedEventIds: ['new-1', 'new-2'], eventIdsWithMovedLinks: ['after-in'] };
    const tally = (total, finishedCount, failedCount = 0) => ({ total, finishedCount, linkedCount: finishedCount, failedCount, droppedLinkCount: 0, stopReason: '' });

    it('links the new events and decides again the moved links, on the plan\'s step titles, then ends the panel with the verdict', async () => {
        const plan = await describeMessages4To7();
        linkEventsReadAgain.mockResolvedValue({ newEvents: tally(2, 2), movedLinks: tally(1, 1) });

        const verdict = await finishReadingAgain({ result, plan, settings: SETTINGS, shouldStop: () => false });

        expect(linkEventsReadAgain).toHaveBeenCalledWith(expect.objectContaining({
            collectionId: 'vf_eventbase_chat', newEventIds: ['new-1', 'new-2'], eventIdsWithMovedLinks: ['after-in'], stepTitles: plan.stepTitles,
        }));
        expect(verdict).toEqual({ isSuccess: true, message: 'Read 3 of 3 windows again, 4 events found; 2 of 2 new events linked; 1 of 1 events with moved links decided again.' });
        expect(progressTracker.complete).toHaveBeenCalledWith(true, verdict.message);
    });

    it('links nothing when StoryArc does not link here, or the run was stopped, and the verdict says which', async () => {
        host.storedEvents = host.storedEvents.map(({ story_links: _links, ...event }) => event);
        const waitingPlan = await describeMessages4To7();
        const waiting = await finishReadingAgain({ result, plan: waitingPlan, settings: SETTINGS, shouldStop: () => false });
        expect(waiting.message).toContain('no StoryArc link pass');

        host.storedEvents = [eventOf('held-a', 2)];
        const stopped = await finishReadingAgain({ result, plan: await describeMessages4To7(), settings: SETTINGS, shouldStop: () => true });
        expect(stopped.isSuccess).toBe(false);
        expect(stopped.message).toMatch(/^Stopped: /);
        expect(linkEventsReadAgain).not.toHaveBeenCalled();
    });

    it('ends the panel red, saying why, when the links could not be decided', async () => {
        const plan = await describeMessages4To7();
        linkEventsReadAgain.mockRejectedValue(new Error('Choose the StoryArc link model first.'));

        const verdict = await finishReadingAgain({ result, plan, settings: SETTINGS, shouldStop: () => false });

        expect(verdict.isSuccess).toBe(false);
        expect(verdict.message).toContain('Links were not decided: Choose the StoryArc link model first.');
        expect(progressTracker.complete).toHaveBeenCalledWith(false, verdict.message);
    });
});
