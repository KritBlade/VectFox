/**
 * Unit tests for keyword-extraction.js: the keywords a chunk is stored with, picked at its extraction level, the most
 * frequent first.
 */

import { describe, it, expect, vi } from 'vitest';

// keyword-extraction.js → bm25-scorer.js → src/sillytavern/log.js → ../../../../extensions.js
// (a SillyTavern host path that doesn't resolve under vitest). Mock it.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

// Mock the SillyTavern substituteParams function
vi.mock('../../../../../script.js', () => ({
    substituteParams: vi.fn((str) => {
        // Simple mock that replaces common ST macros
        return str
            .replace(/\{\{char\}\}/gi, 'TestCharacter')
            .replace(/\{\{user\}\}/gi, 'TestUser');
    }),
}));

import {
    EXTRACTION_LEVELS,
    DEFAULT_EXTRACTION_LEVEL,
    extractLorebookKeywords,
    extractTextKeywords,
    extractChatKeywords,
    extractBM25Keywords,
} from '../src/features/keyword-search/keyword-extraction.js';
import { getOverfetchAmount } from '../src/features/keyword-search/bm25-scorer.js';

// ============================================================================
// EXTRACTION_LEVELS Configuration Tests
// ============================================================================

describe('EXTRACTION_LEVELS', () => {
    it('should have all expected levels defined', () => {
        expect(EXTRACTION_LEVELS).toHaveProperty('off');
        expect(EXTRACTION_LEVELS).toHaveProperty('minimal');
        expect(EXTRACTION_LEVELS).toHaveProperty('balanced');
        expect(EXTRACTION_LEVELS).toHaveProperty('aggressive');
    });

    it('should have off level disabled', () => {
        expect(EXTRACTION_LEVELS.off.enabled).toBe(false);
    });

    it('should have minimal level configured correctly', () => {
        expect(EXTRACTION_LEVELS.minimal.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.minimal.headerSize).toBe(1500);
        expect(EXTRACTION_LEVELS.minimal.maxKeywords).toBe(5);
        expect(EXTRACTION_LEVELS.minimal.minFrequency).toBe(1);
    });

    it('should have balanced level configured correctly', () => {
        expect(EXTRACTION_LEVELS.balanced.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.balanced.headerSize).toBe(5000);
        expect(EXTRACTION_LEVELS.balanced.maxKeywords).toBe(12);
        expect(EXTRACTION_LEVELS.balanced.minFrequency).toBe(1);
    });

    it('should have aggressive level configured correctly', () => {
        expect(EXTRACTION_LEVELS.aggressive.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.aggressive.headerSize).toBe(null); // Full text
        expect(EXTRACTION_LEVELS.aggressive.maxKeywords).toBe(15);
        expect(EXTRACTION_LEVELS.aggressive.minFrequency).toBe(1);
    });
});

describe('DEFAULT_EXTRACTION_LEVEL', () => {
    it('should be balanced', () => {
        expect(DEFAULT_EXTRACTION_LEVEL).toBe('balanced');
    });
});

// ============================================================================
// extractLorebookKeywords Tests
// ============================================================================

describe('extractLorebookKeywords', () => {
    it('should return empty array for null/undefined entry', () => {
        expect(extractLorebookKeywords(null)).toEqual([]);
        expect(extractLorebookKeywords(undefined)).toEqual([]);
    });

    it('should extract primary keys', () => {
        const entry = {
            key: ['magic', 'wizard', 'spell'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords).toContain('spell');
    });

    it('should extract secondary keys', () => {
        const entry = {
            key: ['dragon'],
            keysecondary: ['fire', 'scales'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('dragon');
        expect(keywords).toContain('fire');
        expect(keywords).toContain('scales');
    });

    it('should normalize keys to lowercase', () => {
        const entry = {
            key: ['MAGIC', 'Wizard', 'SpElL'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords).toContain('spell');
    });

    it('should deduplicate keywords', () => {
        const entry = {
            key: ['magic', 'MAGIC', 'Magic'],
            keysecondary: ['magic'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords.filter(k => k === 'magic').length).toBe(1);
    });

    it('should filter out stopwords', () => {
        const entry = {
            key: ['the', 'magic', 'and', 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).not.toContain('the');
        expect(keywords).not.toContain('and');
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should filter out short words (less than 2 chars)', () => {
        const entry = {
            key: ['a', 'b', 'magic'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).not.toContain('a');
        expect(keywords).not.toContain('b');
        expect(keywords).toContain('magic');
    });

    it('should trim whitespace from keys', () => {
        const entry = {
            key: ['  magic  ', '  wizard  '],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should skip empty or whitespace-only keys', () => {
        const entry = {
            key: ['magic', '', '   ', 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords.length).toBe(2);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should handle non-string keys gracefully', () => {
        const entry = {
            key: ['magic', 123, null, undefined, {}, 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords.length).toBe(2);
    });

    it('should handle custom stopwords from settings', () => {
        const entry = {
            key: ['dragon', 'customword', 'wizard'],
        };
        const settings = {
            custom_stopwords: 'customword, anotherword',
        };
        const keywords = extractLorebookKeywords(entry, settings);
        expect(keywords).not.toContain('customword');
        expect(keywords).toContain('dragon');
        expect(keywords).toContain('wizard');
    });

    it('should process ST macros in custom stopwords', () => {
        const entry = {
            key: ['testcharacter', 'testuser', 'wizard'],
        };
        const settings = {
            custom_stopwords: '{{char}}, {{user}}',
        };
        const keywords = extractLorebookKeywords(entry, settings);
        expect(keywords).not.toContain('testcharacter');
        expect(keywords).not.toContain('testuser');
        expect(keywords).toContain('wizard');
    });
});

// ============================================================================
// extractTextKeywords Tests
// ============================================================================

describe('extractTextKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractTextKeywords(null)).toEqual([]);
        expect(extractTextKeywords(undefined)).toEqual([]);
        expect(extractTextKeywords('')).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
        expect(extractTextKeywords(123)).toEqual([]);
        expect(extractTextKeywords({})).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractTextKeywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords with default balanced level', () => {
        const text = 'The wizard wizard wizard cast a powerful magic spell on the dragon dragon.';
        const keywords = extractTextKeywords(text);
        expect(keywords.length).toBeGreaterThan(0);
        // Each keyword is its word, with no weight
        expect(keywords.every(keyword => Object.keys(keyword).join() === 'text')).toBe(true);
    });

    it('should respect maxKeywords limit for minimal level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess'.repeat(10);
        const keywords = extractTextKeywords(text, { level: 'minimal' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.minimal.maxKeywords);
    });

    it('should respect maxKeywords limit for balanced level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess hero villain'.repeat(20);
        const keywords = extractTextKeywords(text, { level: 'balanced' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.balanced.maxKeywords);
    });

    it('should respect maxKeywords limit for aggressive level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess hero villain'.repeat(50);
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.aggressive.maxKeywords);
    });

    it('should filter out stopwords', () => {
        // Use words that are actually in the project stopword set
        // (src/features/keyword-search/stop-words.js). 'will' is NOT a stopword here, so asserting it
        // gets filtered was always wrong; 'within' is.
        const text = 'The wizard is going to the castle within the dragon lair.';
        const keywords = extractTextKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
        expect(keywordTexts).not.toContain('within');
    });

    it('puts more frequent words first', () => {
        const text = 'Dragon dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywordTexts = extractTextKeywords(text, { level: 'aggressive' }).map(k => k.text);
        expect(keywordTexts.indexOf('dragon')).toBeLessThan(keywordTexts.indexOf('wizard'));
    });

    it('ranks a term in CJK brackets with a word seen 16 times or more, and a compound term as a word seen three times', () => {
        const repeat = (word, times) => Array.from({ length: times }, () => word).join(' ');
        const text = `${repeat('harbor', 20)} ${repeat('lantern', 17)} ${repeat('tide', 16)} ${repeat('gull', 4)} ${repeat('rope', 3)} time_god 【星辰剑】 anchor`;
        const keywordTexts = extractTextKeywords(text, { level: 'aggressive' }).map(k => k.text);
        // The top rank keeps text order: the three words seen 16 times or more, then the bracket term.
        expect(keywordTexts.slice(0, 5)).toEqual(['harbor', 'lantern', 'tide', '星辰剑', 'gull']);
        // A compound term ranks as a word seen three times, after the words seen three times that come before it.
        expect(keywordTexts.indexOf('time_god')).toBeGreaterThan(keywordTexts.indexOf('rope'));
        expect(keywordTexts.indexOf('time_god')).toBeLessThan(keywordTexts.indexOf('anchor'));
    });

    it('should remove parenthetical citations', () => {
        const text = 'The dragon (Source: Ancient Tome) breathes fire (See page 42).';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('source');
        expect(keywordTexts).not.toContain('ancient');
        expect(keywordTexts).not.toContain('tome');
    });

    it('should remove italicized text', () => {
        const text = 'The dragon *this is an example* breathes *another example* fire.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('example');
    });

    it('should strip possessive \'s', () => {
        const text = "Strovolos's domain is vast. Strovolos's power is legendary.";
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        // Should have 'strovolos' not 'strovolo'
        expect(keywordTexts.some(t => t.includes('strovolo'))).toBe(true);
    });

    it('should extract compound terms with / or _', () => {
        const text = 'The divine/time god controls time_flow and space_warp.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('_'))).toBe(true);
    });

    it('keeps the words in frequency order', () => {
        const text = 'Dragon dragon dragon dragon. Wizard wizard. Castle.';
        expect(extractTextKeywords(text, { level: 'aggressive' }).map(k => k.text)).toEqual(['dragon', 'wizard', 'castle']);
    });

    it('should preserve proper nouns without stemming', () => {
        const text = 'Gandalf is a powerful wizard. Gandalf casts spells.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        // 'Gandalf' should be preserved as-is (lowercased)
        expect(keywordTexts).toContain('gandalf');
    });
});

// ============================================================================
// extractChatKeywords Tests
// ============================================================================

describe('extractChatKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractChatKeywords(null)).toEqual([]);
        expect(extractChatKeywords(undefined)).toEqual([]);
        expect(extractChatKeywords('')).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
        expect(extractChatKeywords(123)).toEqual([]);
        expect(extractChatKeywords({})).toEqual([]);
    });

    it('should extract capitalized proper nouns', () => {
        const text = 'I met Gandalf yesterday and he told me about Mordor.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).toContain('gandalf');
        expect(keywordTexts).toContain('mordor');
    });

    it('should not extract words at sentence start', () => {
        const text = 'Yesterday was great. Today is better.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        // These are at sentence start so shouldn't be extracted
        expect(keywordTexts).not.toContain('yesterday');
        expect(keywordTexts).not.toContain('today');
    });

    it('should respect maxKeywords limit', () => {
        const text = 'I talked to Gandalf, Frodo, Aragorn, Legolas, Gimli, Boromir, Samwise, Merry, Pippin, and Elrond.';
        const keywords = extractChatKeywords(text, { maxKeywords: 5 });
        expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it('returns each keyword as its word, with no weight', () => {
        expect(extractChatKeywords('I met Gandalf yesterday.')).toEqual([{ text: 'gandalf' }]);
    });

    it('should deduplicate proper nouns', () => {
        const text = 'Gandalf said hello. Then Gandalf left.';
        const keywords = extractChatKeywords(text);
        const gandolfCount = keywords.filter(k => k.text === 'gandalf').length;
        expect(gandolfCount).toBeLessThanOrEqual(1);
    });

    it('should filter out stopwords even if capitalized', () => {
        const text = 'The wizard went to the castle.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
    });

    it('should extract words after quotes and asterisks', () => {
        const text = '"Hello," said Gandalf. *Gandalf smiled* at Frodo.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).toContain('gandalf');
    });
});

// ============================================================================
// extractBM25Keywords Tests
// ============================================================================

describe('extractBM25Keywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractBM25Keywords(null)).toEqual([]);
        expect(extractBM25Keywords(undefined)).toEqual([]);
        expect(extractBM25Keywords('')).toEqual([]);
        expect(extractBM25Keywords('   ')).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractBM25Keywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords using TF-IDF scoring', () => {
        const text = 'The dragon breathes fire. The dragon is powerful. Dragons are mythical creatures.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeGreaterThan(0);
        expect(keywords.every(keyword => Object.keys(keyword).join() === 'text')).toBe(true);
    });

    it('should respect header size for minimal level', () => {
        const minimalHeaderSize = EXTRACTION_LEVELS.minimal.headerSize;

        // Keep phoenix strictly inside the minimal header window.
        const headerText = 'The phoenix rises from ashes. Phoenix is majestic. Legendary phoenix soars high. '.repeat(10);

        // Ensure unicorn starts strictly after the minimal header boundary.
        const paddingNeeded = Math.max(0, (minimalHeaderSize - headerText.length) + 50);
        const padding = 'x'.repeat(paddingNeeded);

        // Unicorn text should be outside the minimal scan window.
        const tailText = 'Unicorn gallops through forest. Magical unicorn appears. ' +
            'The unicorn is beautiful. Rare unicorn sighting reported. '.repeat(3);
        const text = headerText + padding + tailText;

        // Verify test setup guarantees unicorn starts after scan boundary.
        expect(headerText.length).toBeLessThan(minimalHeaderSize);
        expect(headerText.length + padding.length).toBeGreaterThan(minimalHeaderSize);

        const keywords = extractBM25Keywords(text, { level: 'minimal' });
        const keywordTexts = keywords.map(k => k.text);

        // Phoenix should be found (inside minimal scan window).
        expect(keywordTexts.some(t => t.includes('phoenix'))).toBe(true);
        // Unicorn should NOT be found (outside minimal scan window).
        expect(keywordTexts.some(t => t.includes('unicorn'))).toBe(false);
    });

    it('should scan full text for aggressive level', () => {
        const prefix = 'Common words here. '.repeat(100);
        const suffix = 'Unique dragon appears once at the end.';
        const text = prefix + suffix;

        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('dragon') || t.includes('uniqu'))).toBe(true);
    });

    it('should respect maxKeywords limit', () => {
        const text = 'Dragon wizard spell phoenix castle kingdom knight warrior princess hero villain monster creature'.repeat(10);
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.aggressive.maxKeywords);
    });

    it('should filter out stopwords', () => {
        // 'will' is NOT in the project stopword set (src/features/keyword-search/stop-words.js); 'within'
        // is. Assert on words that are actually treated as stopwords.
        const text = 'The wizard is going to the castle within the dragon lair and tower.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
        expect(keywordTexts).not.toContain('within');
    });

    it('should respect minWordLength option', () => {
        const text = 'A is to be or not be. Dragon wizard.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive', minWordLength: 4 });
        const keywordTexts = keywords.map(k => k.text);
        for (const kw of keywordTexts) {
            expect(kw.length).toBeGreaterThanOrEqual(4);
        }
    });

    it('should boost capitalized words', () => {
        const text = 'gandalf the wizard met GANDALF again. gandalf gandalf gandalf.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        // Should find gandalf with boost
        expect(keywords.some(k => k.text.includes('gandalf'))).toBe(true);
    });

    it('should strip possessive \'s', () => {
        const text = "Strovolos's domain. Strovolos's power. Strovolos's realm.";
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('strovolo'))).toBe(true);
    });

    it('puts the highest TF-IDF first', () => {
        const text = 'Dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywordTexts = extractBM25Keywords(text, { level: 'aggressive' }).map(k => k.text);
        expect(keywordTexts.indexOf('dragon')).toBeLessThan(keywordTexts.indexOf('wizard'));
    });
});

// ============================================================================
// getOverfetchAmount Tests
// ============================================================================

describe('getOverfetchAmount', () => {
    it('should return 2x the requested amount', () => {
        expect(getOverfetchAmount(10)).toBe(20);
        expect(getOverfetchAmount(25)).toBe(50);
    });

    it('should have minimum of 10', () => {
        expect(getOverfetchAmount(1)).toBe(10);
        expect(getOverfetchAmount(3)).toBe(10);
    });

    it('should have maximum of 100', () => {
        expect(getOverfetchAmount(60)).toBe(100);
        expect(getOverfetchAmount(100)).toBe(100);
    });

    it('should handle edge cases', () => {
        expect(getOverfetchAmount(0)).toBe(10); // min 10
        expect(getOverfetchAmount(5)).toBe(10); // 2*5=10
        expect(getOverfetchAmount(50)).toBe(100); // 2*50=100 (max)
    });
});

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('Edge Cases', () => {
    it('should handle very long text without crashing', () => {
        const longText = 'Dragon wizard castle knight '.repeat(10000);

        expect(() => extractTextKeywords(longText, { level: 'aggressive' })).not.toThrow();
        expect(() => extractBM25Keywords(longText, { level: 'aggressive' })).not.toThrow();
    });

    it('should handle text with special characters', () => {
        const text = 'The dragon!!! cast a spell??? on the wizard... @#$%^&*()';

        expect(() => extractTextKeywords(text)).not.toThrow();
        expect(() => extractBM25Keywords(text)).not.toThrow();
    });

    it('should handle unicode text', () => {
        const text = 'The dragon 龍 breathes fire 火. The wizard 巫師 casts spells.';

        expect(() => extractTextKeywords(text)).not.toThrow();
        expect(() => extractBM25Keywords(text)).not.toThrow();
    });

    it('should handle text with only stopwords', () => {
        const text = 'The and is are was were been being have has had having do does did doing';

        const keywords1 = extractTextKeywords(text);
        const keywords2 = extractBM25Keywords(text);

        expect(keywords1).toEqual([]);
        expect(keywords2).toEqual([]);
    });

    it('should handle text with only short words', () => {
        const text = 'A b c d e f g h i j k l m n o p';

        const keywords = extractTextKeywords(text);
        expect(keywords).toEqual([]);
    });

});
