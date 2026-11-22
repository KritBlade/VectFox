/**
 * The collections Vectorize Content made from the sources it no longer reads
 * (src/features/collections/retired-content-collections-core.js, D12 and §4.5 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): which source a collection came from, by
 * its ID or the type its metadata stores, which registry entries they are, and the lines of the notice once they are
 * deleted.
 */
import { describe, expect, it, vi } from 'vitest';

// shared/collection-ids.js, which parses the registry keys, reads the open chat; nothing here uses it.
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));

const { retiredContentCollections, retiredContentKindOf, retiredContentNoticeLines } = await import('../src/features/collections/retired-content-collections-core.js');

/** A line's text as the dialog shows it. */
const shown = line => (line.parts ? line.parts.map(part => part.text ?? part.name).join('') : [line.text, line.name].filter(Boolean).join(' '));

const CHARACTER_ID = 'vf_character_qdrant_wren_keeper_orrin_1700000000000';
const DOCUMENT_ID = 'vf_document_wren_tide_tables_1690000000000';
const KEPT_IDS = ['vf_eventbase_qdrant_wren_harbor_1', 'vf_archiveevent_qdrant_wren_harbor_2', 'vf_lorebook_qdrant_wren_harbor_atlas_1700000000000'];

describe('the source a collection came from', () => {
    it('names a character card\'s collection by its ID or by the type its metadata stores', () => {
        expect(retiredContentKindOf(CHARACTER_ID)).toBe('character');
        expect(retiredContentKindOf(CHARACTER_ID, 'character')).toBe('character');
        expect(retiredContentKindOf('harbor_notes', 'character')).toBe('character');
        expect(retiredContentKindOf('harbor_notes', 'persona')).toBe('character');
    });

    it('names a document\'s, web page\'s, wiki\'s or YouTube transcript\'s collection by its ID or by its stored type', () => {
        expect(retiredContentKindOf(DOCUMENT_ID)).toBe('outside');
        expect(retiredContentKindOf('vf_document_qdrant_wren_lighthouse_wiki_1700000000000', 'wiki')).toBe('outside');
        for (const type of ['document', 'url', 'wiki', 'youtube', 'file', 'doc', 'paste', 'select', 'current']) {
            expect(retiredContentKindOf('harbor_notes', type), type).toBe('outside');
        }
    });

    it('never retires chat memory or an old lorebook collection, whatever type its metadata stores', () => {
        for (const id of KEPT_IDS) {
            for (const type of [undefined, 'chat', 'character', 'persona', 'document', 'youtube']) {
                expect(retiredContentKindOf(id, type), `${id} ${type}`).toBeNull();
            }
        }
    });

    it('leaves any other collection whose metadata stores no retired type', () => {
        expect(retiredContentKindOf('harbor_notes')).toBeNull();
        for (const type of ['chat', 'lorebook', 'unknown', '']) expect(retiredContentKindOf('harbor_notes', type), type).toBeNull();
        expect(retiredContentKindOf('', undefined)).toBeNull();
        expect(retiredContentKindOf(undefined, undefined)).toBeNull();
    });
});

describe('the registry\'s collections from retired sources', () => {
    it('keeps only those, each with its kind and its backend, read from "backend:id" keys and bare IDs', () => {
        const storedTypes = { 'vectra:harbor_upload_1': 'file', 'qdrant:vf_eventbase_qdrant_wren_harbor_1': 'document' };
        const contentTypeOf = vi.fn(registryKey => storedTypes[registryKey]);
        const registry = [
            `qdrant:${CHARACTER_ID}`,
            'qdrant:vf_eventbase_qdrant_wren_harbor_1',
            'vectra:harbor_upload_1',
            DOCUMENT_ID,
            'standard:harbor_notes',
        ];

        expect(retiredContentCollections(registry, contentTypeOf)).toEqual([
            { registryKey: `qdrant:${CHARACTER_ID}`, collectionId: CHARACTER_ID, backend: 'qdrant', kind: 'character' },
            { registryKey: 'vectra:harbor_upload_1', collectionId: 'harbor_upload_1', backend: 'vectra', kind: 'outside' },
            { registryKey: DOCUMENT_ID, collectionId: DOCUMENT_ID, backend: null, kind: 'outside' },
        ]);
        expect(contentTypeOf.mock.calls).toEqual([
            [`qdrant:${CHARACTER_ID}`, CHARACTER_ID],
            ['qdrant:vf_eventbase_qdrant_wren_harbor_1', 'vf_eventbase_qdrant_wren_harbor_1'],
            ['vectra:harbor_upload_1', 'harbor_upload_1'],
            [DOCUMENT_ID, DOCUMENT_ID],
            ['standard:harbor_notes', 'harbor_notes'],
        ]);
    });

    it('finds none in a registry of chat memory', () => {
        expect(retiredContentCollections(['qdrant:vf_eventbase_qdrant_wren_harbor_1', 'vectra:vf_archiveevent_wren_harbor_2'], () => 'document')).toEqual([]);
        expect(retiredContentCollections([], () => 'document')).toEqual([]);
    });
});

describe('the notice', () => {
    const WHY = 'Vectorize Content now reads only chats, so VectFox deleted the collections it had made from other sources.';
    const UNTOUCHED = 'Chat memory is untouched: EventBase keeps every event.';
    const isFailedLine = line => line.icon === 'fa-triangle-exclamation';

    it('says why the collections are gone, counts them by source, and says chat memory is untouched', () => {
        const lines = retiredContentNoticeLines({ deleted: [{ kind: 'character' }, { kind: 'outside' }, { kind: 'outside' }], failedCount: 0 });
        expect(lines[0]).toMatchObject({ icon: 'fa-circle-info' });
        expect(lines.map(shown)).toEqual([WHY, 'From character cards: 1', 'From documents, web pages, wikis and YouTube: 2', UNTOUCHED]);
    });

    it('leaves out the count of a source it deleted none from', () => {
        expect(retiredContentNoticeLines({ deleted: [{ kind: 'outside' }], failedCount: 0 }).map(shown))
            .toEqual([WHY, 'From documents, web pages, wikis and YouTube: 1', UNTOUCHED]);
        expect(retiredContentNoticeLines({ deleted: [{ kind: 'character' }, { kind: 'character' }], failedCount: 0 }).map(shown))
            .toEqual([WHY, 'From character cards: 2', UNTOUCHED]);
    });

    it('counts those it could not delete last, and only when there are any', () => {
        const lines = retiredContentNoticeLines({ deleted: [{ kind: 'character' }], failedCount: 2 });
        expect(lines.filter(isFailedLine)).toEqual([lines.at(-1)]);
        expect(shown(lines.at(-1))).toBe('VectFox could not delete 2 others. It tries again at the next start.');
        expect(lines.map(shown)).toContain(UNTOUCHED);
        expect(retiredContentNoticeLines({ deleted: [{ kind: 'character' }], failedCount: 0 }).some(isFailedLine)).toBe(false);
    });
});
