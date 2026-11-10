/**
 * The Chunk Visualizer's rules (src/features/database-browser/chunk-visualizer-core.js): what a chunk holds as its form
 * shows it, which chunks the list shows and in what order, and what the form changes against what is saved, including
 * the old visualizer's faults (a depth of 0 saved as 2, a keyword's 1x boost read back as 1.5x).
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_KEYWORD_WEIGHT,
    chunkLabel,
    collectionRecordLines,
    eventFields,
    formChanges,
    isEventBaseCollection,
    linkTargetLabel,
    linkTargetOptions,
    messageLine,
    normalizeKeywords,
    parseKeywordWeight,
    partLabel,
    saveProblem,
    savedChunkFields,
    textPreview,
    tokenizerLockOf,
    visibleChunks,
} from '../src/features/database-browser/chunk-visualizer-core.js';

const loaded = (key, text, metadata = {}, extra = {}) => {
    const chunk = { key, hash: 1000 + Number(key), index: Number(key), text, metadata };
    return { ...chunk, fields: savedChunkFields(chunk), timelineValue: Number(key), ...extra };
};

// A form left as it was opened, as chunk-visualizer.js reads it.
const untouchedForm = fields => ({
    name: fields.name,
    text: fields.text,
    enabled: fields.enabled,
    context: fields.context,
    xmlTag: fields.xmlTag,
    positionText: fields.position === null ? '' : String(fields.position),
    depthText: fields.depth === null ? '2' : String(fields.depth),
    keywords: fields.keywords.map(keyword => ({ text: keyword.text, weightText: String(keyword.weight) })),
    chunkLinks: fields.chunkLinks.map(link => ({ ...link })),
    summaries: [...fields.summaries],
});

describe('what a chunk holds', () => {
    it('reads the backend payload first, then the settings a chunk saved before the payload carried its fields', () => {
        const chunk = { text: 'The tide came in.', metadata: { name: '', context: 'Harbor', enabled: false, keywords: [] } };
        const fields = savedChunkFields(chunk, { name: '  Old name ', context: 'Ignored', keywords: ['tide'], summaries: ['A tide'] });
        expect(fields).toMatchObject({ name: 'Old name', context: 'Harbor', enabled: false, keywords: [{ text: 'tide', weight: DEFAULT_KEYWORD_WEIGHT }], summaries: ['A tide'] });
        expect(savedChunkFields({ text: '', metadata: {} }, { enabled: false }).enabled).toBe(false);
        expect(savedChunkFields({ text: '', metadata: {} }).enabled).toBe(true);
    });

    it('keeps a depth only for the in-chat position, 0 included', () => {
        expect(savedChunkFields({ metadata: { position: 1, depth: 0 } })).toMatchObject({ position: 1, depth: 0 });
        expect(savedChunkFields({ metadata: { position: 1 } })).toMatchObject({ position: 1, depth: 2 });
        expect(savedChunkFields({ metadata: { position: 2, depth: 7 } })).toMatchObject({ position: 2, depth: null });
        expect(savedChunkFields({ metadata: {} })).toMatchObject({ position: null, depth: null });
    });

    it('gives a bare keyword the default boost and an object without a weight none', () => {
        expect(normalizeKeywords(['mast', { text: 'sail' }, { text: 'oar', weight: 2 }, null, ''])).toEqual([
            { text: 'mast', weight: 1.5 }, { text: 'sail', weight: 1 }, { text: 'oar', weight: 2 },
        ]);
        expect(parseKeywordWeight('2.5')).toBe(2.5);
        expect(parseKeywordWeight('')).toBe(DEFAULT_KEYWORD_WEIGHT);
    });

    it('shows an EventBase event\'s own fields', () => {
        expect(eventFields({ metadata: { event_type: 'decision', importance: 7, concepts: ['trust'], open_threads: ['the map'], real_world_date: '2026-11-05T09:30:12.345Z' } }))
            .toEqual({ type: 'decision', importance: 7, concepts: ['trust'], items: [], openThreads: ['the map'], sentAt: '2026-11-05 09:30 UTC' });
        expect(eventFields({ metadata: {} }).importance).toBeNull();
        expect(isEventBaseCollection('vf_eventbase_qdrant_harbor')).toBe(true);
        expect(isEventBaseCollection('vf_lorebook_harbor')).toBe(false);
    });

    it('names where a chunk came from: one message, or a window of messages and the event in it', () => {
        expect(messageLine({ index: 12, metadata: {} })).toEqual({ text: 'Message', name: '12' });
        expect(messageLine({ metadata: { source_window_start: 40, source_window_end: 44, window_event_order: 2 } }))
            .toEqual({ text: 'Messages', name: '40 to 44, event 3' });
        expect(partLabel({ metadata: { chunkIndex: 1, totalChunks: 3 } })).toBe('2 of 3');
        expect(partLabel({ metadata: {} })).toBe('');
        expect(textPreview('  The   tide\ncame  in.  ', 8)).toBe('The tide…');
    });
});

describe('the list', () => {
    const chunks = [
        loaded('0', 'Short.', { keywords: [{ text: 'mast', weight: 1.5 }] }),
        loaded('1', 'A much longer chunk about the harbor.', { enabled: false }),
        loaded('2', 'Middle length text.', { name: 'Harbor gate' }),
    ];
    const keysOf = list => list.map(chunk => chunk.key);

    it('finds the search in the text, the name or a keyword, and filters', () => {
        expect(keysOf(visibleChunks(chunks, { query: 'HARBOR' }))).toEqual(['1', '2']);
        expect(keysOf(visibleChunks(chunks, { query: 'mast' }))).toEqual(['0']);
        expect(keysOf(visibleChunks(chunks, { filter: 'disabled' }))).toEqual(['1']);
        expect(keysOf(visibleChunks(chunks, { filter: 'enabled' }))).toEqual(['0', '2']);
        expect(keysOf(visibleChunks(chunks, { filter: 'keywords' }))).toEqual(['0']);
    });

    it('orders by the chat\'s history, by length, by keywords, or named and tagged first', () => {
        expect(keysOf(visibleChunks(chunks, { sort: 'index-reversed' }))).toEqual(['2', '1', '0']);
        expect(keysOf(visibleChunks(chunks, { sort: 'length-desc' }))).toEqual(['1', '2', '0']);
        expect(keysOf(visibleChunks(chunks, { sort: 'length-asc' }))).toEqual(['0', '2', '1']);
        expect(keysOf(visibleChunks(chunks, { sort: 'keywords' }))).toEqual(['0', '1', '2']);
        expect(keysOf(visibleChunks(chunks, { sort: 'customized' }))).toEqual(['0', '2', '1']);
        expect(keysOf(visibleChunks(chunks, { sort: 'unknown' }))).toEqual(['0', '1', '2']);
    });

    it('offers every other chunk as a link target, and names a target that is not loaded by its ID', () => {
        expect(linkTargetOptions(chunks, '1000').map(option => option.value)).toEqual(['1001', '1002']);
        expect(chunkLabel(chunks[2])).toBe('Message 2: Harbor gate');
        expect(linkTargetLabel(chunks, 1002)).toEqual({ label: 'Message 2: Harbor gate', isLoaded: true });
        expect(linkTargetLabel(chunks, '77')).toEqual({ label: 'ID 77', isLoaded: false });
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
    const fields = savedChunkFields(
        { text: 'The tide came in.', metadata: { name: 'Tide', position: 1, depth: 0, keywords: [{ text: 'tide', weight: 1 }], chunkLinks: [{ targetHash: 1002, mode: 'soft' }] } },
        { summaries: ['High water'] },
    );

    it('changes nothing for a form left as it was, a weight of 1 and a depth of 0 included', () => {
        expect(formChanges(fields, untouchedForm(fields))).toMatchObject({ payload: {}, text: null, hasChanges: false });
    });

    it('writes each changed field as the backend keeps it', () => {
        const changes = formChanges(fields, {
            ...untouchedForm(fields),
            name: '  ',
            enabled: false,
            xmlTag: 'my notes!',
            positionText: '2',
            keywords: [{ text: 'tide', weightText: '2' }],
            chunkLinks: [{ targetHash: '1002', mode: 'soft' }],
        });
        expect(changes.payload).toEqual({ name: null, enabled: false, xmlTag: 'mynotes', position: 2, depth: null, keywords: [{ text: 'tide', weight: 2 }] });
        expect(changes.hasChanges).toBe(true);
    });

    it('saves an in-chat depth of 0 as 0', () => {
        const atTwo = savedChunkFields({ text: 'x', metadata: { position: 1, depth: 2 } });
        expect(formChanges(atTwo, { ...untouchedForm(atTwo), depthText: '0' }).payload).toEqual({ position: 1, depth: 0 });
    });

    it('embeds again only for a text that changed past spaces at its ends, and never an empty one', () => {
        expect(formChanges(fields, { ...untouchedForm(fields), text: '  The tide came in.\n' }).text).toBeNull();
        expect(formChanges(fields, { ...untouchedForm(fields), text: 'The tide went out. ' }).text).toBe('The tide went out.');
        const emptied = formChanges(fields, { ...untouchedForm(fields), text: '   ' });
        expect(emptied).toMatchObject({ text: null, textProblem: 'A chunk needs text.' });
    });

    it('names the summaries added and removed', () => {
        const changes = formChanges(fields, { ...untouchedForm(fields), summaries: ['Low water'] });
        expect(changes).toMatchObject({ addedSummaries: ['Low water'], removedSummaries: ['High water'], summaries: ['Low water'], hasChanges: true });
    });

    it('saves no new vector in a locked collection, and says why', () => {
        const lock = { madeWith: 'intl', setTo: 'jieba_tw' };
        const renamed = formChanges(fields, { ...untouchedForm(fields), name: 'Flood' });
        const retexted = formChanges(fields, { ...untouchedForm(fields), text: 'The tide went out.' });
        const summarized = formChanges(fields, { ...untouchedForm(fields), summaries: ['High water', 'Low water'] });
        const unsummarized = formChanges(fields, { ...untouchedForm(fields), summaries: [] });
        const emptied = formChanges(fields, { ...untouchedForm(fields), text: '' });
        expect(saveProblem(renamed, lock)).toBeNull();
        expect(saveProblem(unsummarized, lock)).toBeNull();
        expect(saveProblem(retexted, lock)).toBe('A changed text or a new summary can\'t be saved here: see above.');
        expect(saveProblem(summarized, lock)).toBe('A changed text or a new summary can\'t be saved here: see above.');
        expect(saveProblem(retexted, null)).toBeNull();
        expect(saveProblem(emptied, null)).toBe('A chunk needs text.');
    });

    it('leaves a field the form does not show unchanged, as an EventBase chunk\'s switch, keywords and links', () => {
        const form = { ...untouchedForm(fields), enabled: undefined, keywords: undefined, chunkLinks: undefined };
        expect(formChanges(fields, form).hasChanges).toBe(false);
    });
});
