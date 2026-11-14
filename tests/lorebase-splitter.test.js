/**
 * LoreBase's splitter (src/features/lorebase/lorebase-splitter.js) cuts an entry at its author's markers first and by
 * windows last, as the benchmark's lore_passages.py does; the live tests matched the two on every entry of the three
 * test books. These fixtures are shaped like those books: Date A Live's '---' / '[NAME]' / '---' sections with
 * all-capitals lines inside, a Chinese card's <tag> wrapper and 【】 headings, and Mushoku's short entries.
 */
import { describe, expect, it } from 'vitest';
import { entryCategory, entryPassages, entryTitle, estimatedTokens, splitEntry } from '../src/features/lorebase/lorebase-splitter.js';

const words = (count, word = 'lantern') => Array.from({ length: count }, () => word).join(' ');

describe('estimated tokens', () => {
    it('counts a CJK character as one and a Latin word as 1.3, rounding half to even as the benchmark does', () => {
        expect(estimatedTokens('魔法使い')).toBe(4);
        expect(estimatedTokens('the keeper trims the lamp')).toBe(6); // 6.5 rounds to the even 6
        expect(estimatedTokens('爆裂 magic')).toBe(3); // 2 + 1.3
    });
});

describe('titles and categories', () => {
    it('reads the category prefix off the comment, in brackets, 【】 or a short "name:"', () => {
        expect(entryTitle({ comment: '[DAL Spirits] Miku Izayoi' })).toBe('Miku Izayoi');
        expect(entryCategory({ comment: '[DAL Spirits] Miku Izayoi' })).toBe('[DAL Spirits]');
        expect(entryTitle({ comment: '角色:惠惠' })).toBe('惠惠');
        expect(entryTitle({ uid: 12 })).toBe('entry 12');
    });
});

describe('sections', () => {
    it('cuts at the strongest heading kind, and keeps an all-capitals line inside its section', () => {
        const content = [
            'Miku sings for the crowd.',
            '---', '[BASIC INFO]', '---',
            'Name: Miku Izayoi',
            '---', '[BEHAVIOR]', '---',
            'PHASE 3 — THE CRACK',
            'She stops singing.',
        ].join('\n');

        const { passages } = splitEntry(content);

        expect(passages.map(passage => passage.section)).toEqual(['(intro)', 'BASIC INFO', 'BEHAVIOR']);
        expect(passages[2].text).toContain('PHASE 3 — THE CRACK');
    });

    it('keeps a section whole up to one and a half windows, and cuts a longer one into units no larger than a window', () => {
        const longSection = ['[HISTORY]', ...Array.from({ length: 6 }, (_, index) => `◆ Beat ${index}: ${words(60)}`)].join('\n');

        const { passages } = splitEntry(longSection, 150);

        expect(passages.length).toBeGreaterThan(1);
        expect(passages.every(passage => passage.section === 'HISTORY')).toBe(true);
        expect(passages.every(passage => estimatedTokens(passage.text) <= 150)).toBe(true);
        expect(passages[0].text.startsWith('[HISTORY]')).toBe(true);
    });

    it('cuts a unit longer than a window at sentence ends, never inside a sentence', () => {
        const sentence = `${words(20)}.`;
        const { passages } = splitEntry(['# Lore', Array.from({ length: 12 }, () => sentence).join(' ')].join('\n'), 60);

        expect(passages.length).toBeGreaterThan(1);
        for (const passage of passages) {
            expect(passage.text.replace(/^# Lore\n/, '').trim().endsWith('.')).toBe(true);
        }
    });

    it('joins a unit smaller than a tenth of the window to the passage before it in the same section', () => {
        const content = ['[RULES]', `◆ First: ${words(120)}`, `◆ Second: ${words(120)}`, '◆ Last'].join('\n');

        const { passages } = splitEntry(content, 200);

        expect(passages.at(-1).text.endsWith('◆ Last')).toBe(true);
        expect(passages.some(passage => passage.text === '◆ Last')).toBe(false);
    });
});

describe('the wrapper frame', () => {
    it('keeps a <tag> wrapper around the whole entry apart, so a trim can keep the tags balanced', () => {
        const { frame, passages } = splitEntry('<second_character>\n【姓名】\n阿克娅\n</second_character>');

        expect(frame).toEqual({ open: '<second_character>', close: '</second_character>' });
        expect(passages.map(passage => passage.text).join('\n')).not.toContain('second_character');
    });
});

describe('passages as they are stored', () => {
    it('prefixes the text to embed with the entry title and the section, and numbers the passages', () => {
        const { passages } = entryPassages({ uid: 4, comment: '[Mushoku] Roxy Migurdia', content: 'Roxy teaches water magic.\n## Speech\nShe speaks politely.' });

        expect(passages.map(passage => passage.embeddingText)).toEqual([
            'Roxy Migurdia — Roxy teaches water magic.',
            'Roxy Migurdia / Speech — ## Speech\nShe speaks politely.',
        ]);
        expect(passages.map(passage => [passage.passageIndex, passage.passageCount])).toEqual([[0, 2], [1, 2]]);
    });
});
