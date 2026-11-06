/**
 * Tests for Agent Mode's planner prompt in every story language
 * (src/features/eventbase/prompts-i18n.js).
 *
 * Guards that:
 *   - the planner writes queries and a rationale only, with no filters,
 *   - it is told nothing about pre-search hits, which it does not see,
 *   - each example is valid JSON in the shape it asks for, with a made-up cast written in English,
 *   - its user message holds recent chat and the current message only.
 */

import { describe, it, expect } from 'vitest';

import { buildPlannerUserMessage, getAgenticPlannerPrompt } from '../src/features/eventbase/prompts-i18n.js';

const STORY_LANGUAGE_MODES = ['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'];
const MADE_UP_CAST = ['Kai', 'Yuki', 'Marcus', 'Tessa'];

const examplesOf = prompt => (prompt.split('\r\n').join('\n').match(/^\{\n[\s\S]*?^\}$/gm) ?? []).map(text => JSON.parse(text));

describe.each(STORY_LANGUAGE_MODES)('planner prompt in %s', (mode) => {
    const prompt = getAgenticPlannerPrompt(mode);

    it('asks for two fields and says nothing of filters', () => {
        expect(prompt).toContain('exactly two fields');
        expect(prompt).not.toMatch(/filter|_any|importance_gte/i);
    });

    it('says nothing of pre-search hits', () => {
        expect(prompt).not.toMatch(/pre-search|candidate/i);
    });

    it('still reads the current message first, then recent chat', () => {
        expect(prompt).toContain('1. THE CURRENT USER MESSAGE');
        expect(prompt).toContain('2. RECENT CHAT');
    });

    it('gives three examples of queries and a rationale', () => {
        const examples = examplesOf(prompt);
        expect(examples).toHaveLength(3);
        for (const example of examples) {
            expect(Object.keys(example).sort()).toEqual(['queries', 'rationale']);
            expect(example.queries.length).toBeGreaterThanOrEqual(3);
            expect(example.queries.every(query => typeof query === 'string' && query.length > 0)).toBe(true);
        }
    });

    it('writes its made-up cast in English in the examples', () => {
        const queries = examplesOf(prompt).flatMap(example => example.queries).join(' ');
        for (const name of MADE_UP_CAST) expect(queries).toContain(name);
    });
});

describe('buildPlannerUserMessage', () => {
    it('holds recent chat and the current message, and ends by asking for the plan', () => {
        const message = buildPlannerUserMessage({ recentTurns: [{ speaker: 'Rin', text: 'an earlier line' }], userMessage: 'Where did Nora go?' });
        expect(message).toBe('Recent chat (oldest first):\n  [-1] Rin: an earlier line\n\nCurrent user message:\n  Where did Nora go?\n\nPlan retrieval. Return strict JSON only.');
    });
});
