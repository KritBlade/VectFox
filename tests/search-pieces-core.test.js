/**
 * The pieces a search text is searched in (src/features/embedding/search-pieces-core.js; plan:
 * InternalProject/Vectfox/plans/executed/search-text-pieces.md): text within the piece size is one piece, as before; a
 * longer one, in any script, is cut into pieces within the size, in its order, with every character of it kept.
 */
import { describe, expect, it } from 'vitest';
import { searchTokens, splitSearchText } from '../src/features/embedding/search-pieces-core.js';

/** Every piece within the size, by the measure the splitter cuts by. */
const expectWithin = (pieces, pieceTokens) => {
    for (const piece of pieces) expect(searchTokens(piece)).toBeLessThanOrEqual(pieceTokens);
};
/** The pieces hold the text's every non-space character, in its order. */
const expectWhole = (pieces, text) => expect(pieces.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));

describe('searchTokens', () => {
    it('counts 1.3 per Latin word, 1 per CJK character, and 1 per letter of any other script', () => {
        expect(searchTokens('Wren met Harbor')).toBeCloseTo(3.9);
        expect(searchTokens('港口灯塔')).toBe(4);
        expect(searchTokens('Привет')).toBe(6);
        expect(searchTokens('สวัสดี')).toBeGreaterThan(0);
    });

    it('never counts less than a quarter of the non-space characters, so a long link counts too', () => {
        const link = `https://example.com/${'a'.repeat(380)}`;
        expect(searchTokens(link)).toBe(link.length / 4);
    });
});

describe('splitSearchText', () => {
    it('keeps a text within the size as one piece, trimmed', () => {
        expect(splitSearchText('  Wren met the lighthouse keeper.  ', 50)).toEqual(['Wren met the lighthouse keeper.']);
    });

    it('returns no piece for an empty text', () => {
        expect(splitSearchText('   ', 50)).toEqual([]);
        expect(splitSearchText(null, 50)).toEqual([]);
    });

    it('cuts English lines into pieces within the size, in order, keeping every word', () => {
        const text = Array.from({ length: 40 }, (_, i) => `Line ${i}: Wren carried the lamp up the tower stairs.`).join('\n');
        const pieces = splitSearchText(text, 60);
        expect(pieces.length).toBeGreaterThan(1);
        expectWithin(pieces, 60);
        expectWhole(pieces, text);
        expect(pieces[0].startsWith('Line 0:')).toBe(true);
    });

    it('cuts one long line at its sentence ends', () => {
        const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i} tells how Wren mended the net.`).join(' ');
        const pieces = splitSearchText(text, 40);
        expectWithin(pieces, 40);
        expectWhole(pieces, text);
        expect(pieces.every(piece => piece.endsWith('.'))).toBe(true);
    });

    it('cuts Chinese at its sentence ends, and a run with no punctuation into runs within the size', () => {
        const sentences = '灯塔的守望者在夜里点亮了灯。'.repeat(30);
        const sentencePieces = splitSearchText(sentences, 50);
        expectWithin(sentencePieces, 50);
        expectWhole(sentencePieces, sentences);
        expect(sentencePieces.every(piece => piece.endsWith('。'))).toBe(true);

        const run = '灯'.repeat(300);
        const runPieces = splitSearchText(run, 100);
        expect(runPieces.length).toBeGreaterThanOrEqual(3);
        expectWithin(runPieces, 100);
        expectWhole(runPieces, run);
    });

    it('cuts Cyrillic and Thai, which a Latin-and-CJK count would read as nothing', () => {
        const cyrillic = 'Привет, хранитель маяка. '.repeat(60);
        const cyrillicPieces = splitSearchText(cyrillic, 50);
        expect(cyrillicPieces.length).toBeGreaterThan(1);
        expectWithin(cyrillicPieces, 50);
        expectWhole(cyrillicPieces, cyrillic);

        const thai = 'สวัสดีครับผู้ดูแลประภาคาร'.repeat(40);
        const thaiPieces = splitSearchText(thai, 40);
        expect(thaiPieces.length).toBeGreaterThan(1);
        expectWithin(thaiPieces, 40);
        expectWhole(thaiPieces, thai);
    });

    it('cuts a long link inside a sentence into runs within the size', () => {
        const text = `Wren saved the chart at https://example.com/${'x'.repeat(4000)} before the storm.`;
        const pieces = splitSearchText(text, 500);
        expect(pieces.length).toBeGreaterThan(1);
        expectWithin(pieces, 500);
        expectWhole(pieces, text);
    });

    it('searches every text whole at an infinite size', () => {
        const text = 'Wren carried the lamp. '.repeat(5000).trim();
        expect(splitSearchText(text, Infinity)).toEqual([text]);
    });
});
