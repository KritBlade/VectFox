/**
 * Tests for the EventBase extraction prompt in every story language
 * (src/features/eventbase/prompts-i18n.js).
 *
 * Guards that:
 *   - each language's example is valid JSON: one event with every field the schema asks for,
 *   - its cast is made up and written in English, whatever language the example is in,
 *   - the BAD list of concepts names a character in English too.
 */

import { describe, it, expect } from 'vitest';

import { getEventBaseExtractionPrompt } from '../src/features/eventbase/prompts-i18n.js';

const STORY_LANGUAGE_MODES = ['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'];
const MODES_LISTING_A_BAD_NAME = ['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean'];
const SCHEMA_FIELDS = [
    'DateTime', 'cause', 'characters', 'concepts', 'event_type', 'factions', 'importance', 'items',
    'keywords', 'locations', 'open_threads', 'result', 'scene_time', 'should_persist', 'summary',
];

const exampleEventsOf = (prompt) => {
    const exampleLine = prompt.split(/\r?\n/).find(line => line.startsWith('[{"event_type"'));
    return JSON.parse(exampleLine);
};

describe.each(STORY_LANGUAGE_MODES)('extraction prompt in %s', (mode) => {
    const prompt = getEventBaseExtractionPrompt(mode);

    it('shows one event with every field the schema asks for', () => {
        const events = exampleEventsOf(prompt);
        expect(events).toHaveLength(1);
        expect(Object.keys(events[0]).sort()).toEqual(SCHEMA_FIELDS);
    });

    it('writes its made-up cast in English', () => {
        const [event] = exampleEventsOf(prompt);
        expect(event.characters).toEqual(expect.arrayContaining(['Aria', 'Leon']));
        expect(event.summary).toContain('Aria');
        expect(event.summary).toContain('Leon');
    });
});

describe.each(MODES_LISTING_A_BAD_NAME)('extraction prompt in %s', (mode) => {
    it('shows a character name as a bad concept in English', () => {
        expect(getEventBaseExtractionPrompt(mode)).toMatch(/[「"]Aria[」"] ?\(/);
    });
});
