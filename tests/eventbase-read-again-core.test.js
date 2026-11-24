/**
 * What Vectorize Content shows and says when it reads a stretch again
 * (src/features/eventbase/eventbase-read-again-core.js, eventbase-read-range-again.md): what the stretch holds, its
 * prompt tokens, why StoryArc links nothing, the progress panel's title for each step, the confirm, and the verdict.
 */

import { describe, it, expect } from 'vitest';
import {
    describeStretch,
    extractionInputTokensOf,
    linkWaitReasonOf,
    readAgainConfirmLines,
    readAgainStepTitles,
    readAgainVerdict,
} from '../src/features/eventbase/eventbase-read-again-core.js';

const eventOf = (eventId, windowStart, links) => ({
    event_id: eventId, source_window_start: windowStart, source_window_end: windowStart + 1, ...(links ? { story_links: links } : {}),
});

describe('describeStretch', () => {
    it('holds the events of its windows, and the events outside them whose links go into them', () => {
        const stored = [
            eventOf('before', 0),
            eventOf('held-a', 2),
            eventOf('held-b', 4, [{ event_id: 'held-a' }]),
            eventOf('other-size', 2, undefined),
            eventOf('after-in', 8, [{ event_id: 'held-b' }]),
            eventOf('after-out', 10, [{ event_id: 'before' }]),
        ];
        stored[3].source_window_end = 4;

        const { heldEvents, eventsLinkingIn } = describeStretch([{ start: 2, end: 3 }, { start: 4, end: 5 }], stored);

        expect(heldEvents.map(event => event.event_id)).toEqual(['held-a', 'held-b']);
        expect(eventsLinkingIn.map(event => event.event_id)).toEqual(['after-in']);
    });

    it('shows the link pass by every event but the undecided ones its windows hold, which the run replaces', () => {
        const stored = [
            eventOf('before', 0, []),
            eventOf('held-undecided', 2),
            eventOf('held-decided', 4, []),
            eventOf('after-undecided', 8),
        ];

        const { eventsShowingLinkPass } = describeStretch([{ start: 2, end: 3 }, { start: 4, end: 5 }], stored);

        expect(eventsShowingLinkPass.map(event => event.event_id)).toEqual(['before', 'held-decided', 'after-undecided']);
    });
});

describe('extractionInputTokensOf', () => {
    it('counts each window\'s prompt once and each message once for every window that holds it', () => {
        expect(extractionInputTokensOf({ windowCount: 4, promptTokens: 1000, stretchTextTokens: 3000, windowSize: 3, step: 2 })).toBe(8500);
    });

    it('is nothing for no window', () => {
        expect(extractionInputTokensOf({ windowCount: 0, promptTokens: 1000, stretchTextTokens: 0, windowSize: 2, step: 2 })).toBe(0);
    });
});

describe('linkWaitReasonOf', () => {
    it('links with StoryArc on, a link pass done and a link model', () => {
        expect(linkWaitReasonOf({ isStoryArcOn: true, hasLinkPass: true, isLinkModelReady: true })).toBe('');
    });

    it('says why it links nothing: StoryArc off, no link pass, or no link model', () => {
        expect(linkWaitReasonOf({ isStoryArcOn: false, hasLinkPass: true, isLinkModelReady: true })).toContain('StoryArc is off');
        expect(linkWaitReasonOf({ isStoryArcOn: true, hasLinkPass: false, isLinkModelReady: true })).toContain('no StoryArc link pass');
        expect(linkWaitReasonOf({ isStoryArcOn: true, hasLinkPass: true, isLinkModelReady: false })).toContain('link model is not set');
    });
});

describe('readAgainStepTitles', () => {
    it('numbers three steps when StoryArc links, and names one when it does not', () => {
        expect(readAgainStepTitles(true)).toEqual({
            windows: 'Reading again, step 1 of 3: windows',
            newEvents: 'Reading again, step 2 of 3: linking new events',
            movedLinks: 'Reading again, step 3 of 3: deciding moved links again',
        });
        expect(readAgainStepTitles(false).windows).toBe('Reading again: windows');
    });
});

describe('readAgainConfirmLines', () => {
    const plan = {
        collectionName: 'Harbor Keeper',
        firstMessage: 37,
        lastMessage: 1290,
        windowCount: 627,
        heldCount: 1400,
        linkingInCount: 12,
        extraction: { model: 'deepseek/deepseek-v4 on OpenRouter', inputTokens: 1_250_000, costUsd: 0.4 },
        links: { model: 'Linker, a connection profile', estimate: { eventCount: 1412, inputTokens: 2_555_720, outputTokens: 451_840, minutes: 49, costUsd: null } },
        waitReason: '',
    };

    it('names what it reads, on which models, and every number with its unit', () => {
        expect(readAgainConfirmLines(plan)).toEqual([
            { text: 'Read again into:', name: 'Harbor Keeper' },
            { text: 'Messages, snapped to whole windows:', name: '37 to 1,290' },
            { text: 'EventBase model:', name: 'deepseek/deepseek-v4 on OpenRouter' },
            { text: 'Extraction:', name: '627 windows, one call each: about $0.40 for the prompts, about 1250k prompt tokens' },
            { text: 'Events these windows hold now, each replaced:', name: '1400 events' },
            { text: 'A window whose new read finds no event loses its events.' },
            { text: 'StoryArc link model:', name: 'Linker, a connection profile' },
            { text: 'Links for the new events, about as many as now, and again for the events whose links go into these windows:', name: '12 events' },
            { text: 'Linking:', name: '1412 events: price unknown, about 49 minutes, about 2556k input and 452k output tokens' },
        ]);
    });

    it('shows no price it cannot read, no token count it could not take, and why nothing is linked', () => {
        const lines = readAgainConfirmLines({
            ...plan,
            extraction: { model: 'Writer, a connection profile', inputTokens: null, costUsd: null },
            links: null,
            waitReason: 'StoryArc is off, so no StoryArc links are decided.',
        });
        expect(lines[3]).toEqual({ text: 'Extraction:', name: '627 windows, one call each: price unknown' });
        expect(lines.at(-1)).toEqual({ text: 'StoryArc is off, so no StoryArc links are decided.' });
        expect(lines.some(line => line.text === 'StoryArc link model:')).toBe(false);
    });
});

describe('readAgainVerdict', () => {
    const reading = { windowCount: 4, windowsProcessed: 4, eventsExtracted: 9 };
    const tally = (total, finishedCount, failedCount = 0, stopReason = '') => ({ total, finishedCount, failedCount, stopReason });

    it('is green with every window read and every event decided, counting each step', () => {
        expect(readAgainVerdict(reading, { newEvents: tally(9, 9), movedLinks: tally(2, 2) }, { isStopped: false })).toEqual({
            isSuccess: true,
            message: 'Read 4 of 4 windows again, 9 events found; 9 of 9 new events linked; 2 of 2 events with moved links decided again.',
        });
    });

    it('is red with a window unread, naming it', () => {
        const verdict = readAgainVerdict({ ...reading, windowsProcessed: 3 }, null, { isStopped: false, waitReason: 'StoryArc is off, so no StoryArc links are decided.' });
        expect(verdict).toEqual({
            isSuccess: false,
            message: 'Read 3 of 4 windows again, 9 events found. StoryArc is off, so no StoryArc links are decided.',
        });
    });

    it('is red with an event failed or not reached, pointing at the StoryArc tab', () => {
        const verdict = readAgainVerdict(reading, { newEvents: tally(9, 9, 2), movedLinks: tally(2, 0, 0, '') }, { isStopped: true });
        expect(verdict.isSuccess).toBe(false);
        expect(verdict.message).toBe('Stopped: Read 4 of 4 windows again, 9 events found; 7 of 9 new events linked, 2 failed; '
            + '0 of 2 events with moved links decided again, 2 not reached. The StoryArc tab\'s button decides the events left.');
    });

    it('is red with events left unreached, though none failed, or with linking stopped', () => {
        expect(readAgainVerdict(reading, { newEvents: tally(9, 9), movedLinks: tally(2, 1) }, { isStopped: false }).isSuccess).toBe(false);
        expect(readAgainVerdict(reading, { newEvents: tally(9, 9, 0, 'Linking was refused'), movedLinks: tally(0, 0) }, { isStopped: false }).isSuccess).toBe(false);
    });

    it('names why linking stopped or could not start', () => {
        expect(readAgainVerdict(reading, { newEvents: tally(9, 1, 1, 'No such model'), movedLinks: tally(2, 0) }, { isStopped: false }).message)
            .toContain('Linking stopped: No such model');
        const verdict = readAgainVerdict(reading, null, { isStopped: false, linkError: 'Could not read this collection\'s events.' });
        expect(verdict.isSuccess).toBe(false);
        expect(verdict.message).toContain('Links were not decided: Could not read this collection\'s events.');
    });
});
