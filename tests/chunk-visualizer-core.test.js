/**
 * The Chunk Visualizer's rules (src/features/database-browser/chunk-visualizer-core.js): what a chunk holds as its form
 * and its row show it, which chunks the list shows and in what order, how a chunk is named, the collection's Qdrant
 * record and the tokenizer lock it sets, and what the form changes against what is saved; a LoreBase part named and
 * ordered by its entry and part.
 */

import { describe, expect, it } from 'vitest';
import {
    CHUNK_FILTERS,
    LOREBASE_PART_SORTS,
    chunkLabel,
    chunkTitle,
    collectionRecordLines,
    eventFields,
    formChanges,
    isLoreBasePart,
    loreBasePartPlace,
    normalizeKeywords,
    originLine,
    reopenedChunk,
    saveProblem,
    savedChunkFields,
    textPreview,
    tokenizerLockOf,
    visibleChunks,
} from '../src/features/database-browser/chunk-visualizer-core.js';

const loaded = (key, text, metadata = {}, extra = {}) => {
    const chunk = { key, hash: 1000 + Number(key), index: Number(key), text, metadata };
    return { ...chunk, fields: savedChunkFields(chunk), placeValue: Number(key), ...extra };
};

// A form left as it was opened, as chunk-visualizer.js reads it.
const untouchedForm = fields => ({ name: fields.name, text: fields.text });

describe('what a chunk holds', () => {
    it('reads its text, its name and its keywords from the backend payload, and nothing else', () => {
        const chunk = {
            text: 'The tide came in.',
            metadata: { name: '  Harbor tide ', keywords: [{ text: 'tide', weight: 1.5 }], enabled: false, context: 'Harbor', xmlTag: 'scene', position: 1, depth: 0 },
        };
        expect(savedChunkFields(chunk)).toEqual({ text: 'The tide came in.', name: 'Harbor tide', keywords: [{ text: 'tide' }] });
        expect(savedChunkFields({ metadata: {} })).toEqual({ text: '', name: '', keywords: [] });
    });

    it('reads a keyword stored as a word or as an object as its word, a stored weight dropped', () => {
        expect(normalizeKeywords(['mast', { text: 'sail' }, { text: 'oar', weight: 2 }, null, ''])).toEqual([
            { text: 'mast' }, { text: 'sail' }, { text: 'oar' },
        ]);
    });

    it('shows an EventBase event\'s own fields', () => {
        expect(eventFields({ metadata: { event_type: 'decision', importance: 7, concepts: ['trust'], open_threads: ['the map'], real_world_date: '2026-11-05T09:30:12.345Z' } }))
            .toEqual({ type: 'decision', importance: 7, concepts: ['trust'], items: [], openThreads: ['the map'], sentAt: '2026-11-05 09:30 UTC' });
        expect(eventFields({ metadata: {} }).importance).toBeNull();
    });

    it('names where a chunk came from: one message, or a window of messages and the event in it', () => {
        expect(originLine({ index: 12, metadata: {} })).toEqual({ text: 'Message', name: '12' });
        expect(originLine({ metadata: { source_window_start: 40, source_window_end: 44, window_event_order: 2 } }))
            .toEqual({ text: 'Messages', name: '40 to 44, event 3' });
        expect(textPreview('  The   tide\ncame  in.  ', 8)).toBe('The tide…');
    });

    it("names a LoreBase part by its entry and part, and titles it by its entry's title, its first line", () => {
        const part = loaded('0', 'Harbor lighthouse\nThe keeper lights it at dusk.', { lorebookName: 'Harbor Atlas', entryUid: '12', partNumber: 2 });
        expect(isLoreBasePart(part)).toBe(true);
        expect(originLine(part)).toEqual({ text: 'Entry', name: '12, part 2' });
        expect(chunkTitle(part)).toBe('Harbor lighthouse');
        // An entry with no title: its part's text stands in.
        expect(chunkTitle(loaded('1', '\nThe keeper lights it.', { entryUid: '13', partNumber: 1 }))).toBe('The keeper lights it.');
        expect(isLoreBasePart(loaded('2', 'The gate.', { entryUid: '' }))).toBe(false);
    });

    it('titles any other chunk by its name, else the start of its text, else as having none', () => {
        expect(chunkTitle(loaded('0', 'Harbor lighthouse\nThe keeper.', { name: 'Light' }))).toBe('Light');
        expect(chunkTitle(loaded('1', 'Harbor lighthouse\nThe keeper.'))).toBe('Harbor lighthouse The keeper.');
        expect(chunkTitle(loaded('2', ''))).toBe('No text');
    });
});

describe('the list', () => {
    const chunks = [
        loaded('0', 'Short.', { keywords: [{ text: 'mast', weight: 1.5 }] }),
        loaded('1', 'A much longer chunk about the harbor.'),
        loaded('2', 'Middle length text.', { name: 'Harbor gate' }),
    ];
    const keysOf = list => list.map(chunk => chunk.key);

    it('finds the search in the text, the name or a keyword, and filters to the chunks with keywords', () => {
        expect(keysOf(visibleChunks(chunks, { query: 'HARBOR' }))).toEqual(['1', '2']);
        expect(keysOf(visibleChunks(chunks, { query: 'mast' }))).toEqual(['0']);
        expect(keysOf(visibleChunks(chunks, { filter: 'keywords' }))).toEqual(['0']);
        expect(CHUNK_FILTERS.map(filter => filter.value)).toEqual(['all', 'keywords']);
    });

    it('orders by the chat\'s history, by length, by keywords, or named first', () => {
        expect(keysOf(visibleChunks(chunks, { sort: 'index-reversed' }))).toEqual(['2', '1', '0']);
        expect(keysOf(visibleChunks(chunks, { sort: 'length-desc' }))).toEqual(['1', '2', '0']);
        expect(keysOf(visibleChunks(chunks, { sort: 'length-asc' }))).toEqual(['0', '2', '1']);
        expect(keysOf(visibleChunks(chunks, { sort: 'keywords' }))).toEqual(['0', '1', '2']);
        expect(keysOf(visibleChunks(chunks, { sort: 'customized' }))).toEqual(['2', '0', '1']);
        expect(keysOf(visibleChunks(chunks, { sort: 'unknown' }))).toEqual(['0', '1', '2']);
    });

    it("orders a lorebook's LoreBase parts by entry, then part, and offers only the orders that mean something for them", () => {
        const part = (key, entryUid, partNumber) => {
            const chunk = loaded(key, `Entry ${entryUid}\nPart ${partNumber}.`, { entryUid, partNumber });
            return { ...chunk, placeValue: loreBasePartPlace(chunk) };
        };
        const parts = [part('0', '12', 2), part('1', '3', 1), part('2', '12', 1), part('3', '100', 1)];
        expect(keysOf(visibleChunks(parts, { sort: 'index' }))).toEqual(['1', '2', '0', '3']);
        expect(LOREBASE_PART_SORTS.map(sort => sort.value)).toEqual(['index', 'length-desc', 'length-asc']);
    });

    it('opens again the chunk with the same ID; for a LoreBase part written again under a new one, its entry\'s same part, else its first', () => {
        const part = (key, hash, entryUid, partNumber) => {
            const chunk = { ...loaded(key, `Entry ${entryUid}\nPart ${partNumber}.`, { entryUid, partNumber }), hash };
            return { ...chunk, placeValue: loreBasePartPlace(chunk) };
        };
        const before = part('0', 501, '12', 2);
        expect(reopenedChunk([part('3', 900, '3', 1), part('4', 501, '12', 2)], before).key).toBe('4');
        expect(reopenedChunk([part('3', 900, '3', 1), part('5', 777, '12', 1), part('6', 601, '12', 2)], before).key).toBe('6');
        // The edit left the entry fewer parts: its first.
        expect(reopenedChunk([part('7', 778, '12', 3), part('8', 779, '12', 1)], before).key).toBe('8');
        expect(reopenedChunk([part('3', 900, '3', 1)], before)).toBeNull();
        // Any other chunk opens again only by its ID.
        expect(reopenedChunk([chunks[0]], { ...chunks[1], hash: 999 })).toBeNull();
        expect(reopenedChunk(chunks, null)).toBeNull();
    });

    // In an EventBase collection every chunk has keywords, so a named chunk must not sink below those with more.
    it('puts a named chunk first, however many keywords the others have', () => {
        const manyKeywords = ['dock', 'rope', 'sail'].map(text => ({ text, weight: 1.5 }));
        const ranked = [
            loaded('0', 'First.', { keywords: manyKeywords }),
            loaded('1', 'Second.', { keywords: manyKeywords.slice(0, 1) }),
            loaded('2', 'Third.', { keywords: manyKeywords }),
            loaded('3', 'Fourth.', { name: 'Harbor gate' }),
        ];
        expect(keysOf(visibleChunks(ranked, { sort: 'customized' }))).toEqual(['3', '0', '1', '2']);
    });

    it('names a chunk by its message and its name, or the start of its text', () => {
        expect(chunkLabel(chunks[2])).toBe('Message 2: Harbor gate');
        expect(chunkLabel(chunks[1])).toBe('Message 1: A much longer chunk about the harbor.');
    });

    it('reads the collection\'s own Qdrant record, naming its CJK tokenizer as the setting does', () => {
        const tokenizerLabel = mode => `${mode} label`;
        expect(collectionRecordLines({ cjk_tokenizer_mode: 'jieba', updated_at: 1762300000000 }, tokenizerLabel)).toEqual([
            { text: 'CJK tokenizer', name: 'jieba label' },
            { text: 'Updated', name: '2025-11-04 23:46 UTC' },
        ]);
        expect(collectionRecordLines(null)).toEqual([]);
    });

    it('locks a collection made with another CJK tokenizer than VectFox is set to, as Similharity refuses its new vectors', () => {
        expect(tokenizerLockOf({ cjk_tokenizer_mode: 'intl' }, 'jieba_tw')).toEqual({ madeWith: 'intl', setTo: 'jieba_tw' });
        expect(tokenizerLockOf({ cjk_tokenizer_mode: 'jieba_tw' }, 'jieba_tw')).toBeNull();
        // Similharity checks nothing for a collection without the record or an insert without a mode.
        expect(tokenizerLockOf({}, 'jieba_tw')).toBeNull();
        expect(tokenizerLockOf(null, 'jieba_tw')).toBeNull();
        expect(tokenizerLockOf({ cjk_tokenizer_mode: 'intl' }, undefined)).toBeNull();
    });
});

describe('what the form changes', () => {
    const fields = savedChunkFields({ text: 'The tide came in.', metadata: { name: 'Tide', keywords: [{ text: 'tide', weight: 1 }] } });
    const NO_CHANGE = { payload: {}, text: null, textProblem: '', hasChanges: false };

    it('changes nothing for a form left as it was, or for a field the form leaves out', () => {
        expect(formChanges(fields, untouchedForm(fields))).toEqual(NO_CHANGE);
        expect(formChanges(fields, {})).toEqual(NO_CHANGE);
    });

    it('writes a changed name as the backend keeps it, trimmed, and an emptied one as none', () => {
        expect(formChanges(fields, { ...untouchedForm(fields), name: '  High tide ' })).toEqual({ ...NO_CHANGE, payload: { name: 'High tide' }, hasChanges: true });
        expect(formChanges(fields, { ...untouchedForm(fields), name: '  ' }).payload).toEqual({ name: null });
        expect(formChanges(fields, { ...untouchedForm(fields), name: ' Tide ' }).hasChanges).toBe(false);
    });

    it('embeds again only for a text that changed past spaces at its ends, and never an empty one', () => {
        expect(formChanges(fields, { ...untouchedForm(fields), text: '  The tide came in.\n' }).text).toBeNull();
        expect(formChanges(fields, { ...untouchedForm(fields), text: 'The tide went out. ' }).text).toBe('The tide went out.');
        const emptied = formChanges(fields, { ...untouchedForm(fields), text: '   ' });
        expect(emptied).toMatchObject({ text: null, textProblem: 'A chunk needs text.' });
    });

    it('saves no changed text in a locked collection, and says why, but saves a new name there', () => {
        const lock = { madeWith: 'intl', setTo: 'jieba_tw' };
        const renamed = formChanges(fields, { ...untouchedForm(fields), name: 'Flood' });
        const retexted = formChanges(fields, { ...untouchedForm(fields), text: 'The tide went out.' });
        const emptied = formChanges(fields, { ...untouchedForm(fields), text: '' });
        expect(saveProblem(renamed, lock)).toBeNull();
        expect(saveProblem(retexted, lock)).toBe('A changed text can\'t be saved here: see above.');
        expect(saveProblem(retexted, null)).toBeNull();
        expect(saveProblem(emptied, null)).toBe('A chunk needs text.');
        expect(saveProblem(emptied, lock)).toBe('A chunk needs text.');
    });
});
