/**
 * The old vectorized lorebook collections LoreBase replaced (src/features/lorebase/lorebase-old-collections-core.js,
 * plan D5 and §6.4 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): which registry
 * entries they are, the book each came from by its ID, the locks each carries to its book, and the notice's lines.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({})), getCurrentChatId: vi.fn(), chat_metadata: {} }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));

const { bookOfOldCollection, oldCollectionsNoticeLines, oldLorebookCollections } = await import('../src/features/lorebase/lorebase-old-collections-core.js');

const BOOKS = ['Harbor Atlas', 'Atlas', 'Tide Tables', '港口地圖✨'];

/** A line's text as the dialog shows it. */
const shown = line => (line.parts ? line.parts.map(part => part.text ?? part.name).join('') : [line.text, line.name].filter(Boolean).join(' '));

describe('the book of an old lorebook collection', () => {
    it("reads the book from the end of the collection's ID, the longest name that fits winning", () => {
        expect(bookOfOldCollection('vf_lorebook_qdrant_wren_harbor_atlas_1700000000000', BOOKS)).toBe('Harbor Atlas');
        expect(bookOfOldCollection('vf_lorebook_qdrant_wren_atlas_1700000000000', BOOKS)).toBe('Atlas');
        expect(bookOfOldCollection('vf_lorebook_wren_tide_tables_1690000000000', BOOKS)).toBe('Tide Tables');
    });

    it('matches a name the ID kept with its sign turned into an underscore, and a name it cut at 50 characters', () => {
        expect(bookOfOldCollection('vf_lorebook_vectra_wren_港口地圖__1700000000000', BOOKS)).toBe('港口地圖✨');
        const longName = 'The Very Long Chronicle of the Harbor Town and All Its Keepers';
        const cut = 'the_very_long_chronicle_of_the_harbor_town_and_all';
        expect(bookOfOldCollection(`vf_lorebook_qdrant_wren_${cut}_1700000000000`, [longName])).toBe(longName);
    });

    it('finds no book when none SillyTavern has fits, or the ID ends in no time', () => {
        expect(bookOfOldCollection('vf_lorebook_qdrant_wren_lost_charts_1700000000000', BOOKS)).toBeNull();
        expect(bookOfOldCollection('vf_lorebook_qdrant_wren_harbor_atlas', BOOKS)).toBeNull();
    });
});

describe('the old lorebook collections in the registry', () => {
    const locks = {
        'qdrant:vf_lorebook_qdrant_wren_harbor_atlas_1700000000000': { chats: ['chat-1'], characters: ['1', '7'] },
        vf_lorebook_qdrant_wren_harbor_atlas_1700000000000: { chats: ['chat-1', 'chat-9'], characters: [] },
    };
    const host = {
        bookNames: BOOKS,
        chatLocksOf: key => locks[key]?.chats ?? [],
        characterLocksOf: key => locks[key]?.characters ?? [],
        avatarOf: characterId => ({ 1: 'keeper_orrin.png' })[characterId] ?? null,
    };

    it('keeps only the lorebook collections, each with its backend, its book and its locks under both its keys', () => {
        const registry = ['qdrant:vf_lorebook_qdrant_wren_harbor_atlas_1700000000000', 'qdrant:vf_eventbase_wren_harbor_1', 'vf_lorebook_wren_lost_charts_1690000000000'];
        expect(oldLorebookCollections(registry, host)).toEqual([
            {
                registryKey: 'qdrant:vf_lorebook_qdrant_wren_harbor_atlas_1700000000000', collectionId: 'vf_lorebook_qdrant_wren_harbor_atlas_1700000000000',
                backend: 'qdrant', bookName: 'Harbor Atlas', chatIds: ['chat-1', 'chat-9'], characterAvatars: ['keeper_orrin.png'],
            },
            {
                registryKey: 'vf_lorebook_wren_lost_charts_1690000000000', collectionId: 'vf_lorebook_wren_lost_charts_1690000000000',
                backend: null, bookName: null, chatIds: [], characterAvatars: [],
            },
        ]);
    });

    it('finds none in a registry without one', () => {
        expect(oldLorebookCollections(['qdrant:vf_eventbase_wren_harbor_1', 'vectra:vf_document_wren_notes_1'], host)).toEqual([]);
    });
});

describe('the notice', () => {
    const atlas = { bookName: 'Harbor Atlas', chatIds: [], characterAvatars: [] };

    it('names each book once, in order, says how to choose its entries again, and why the collections are gone', () => {
        const lines = oldCollectionsNoticeLines({ deleted: [{ ...atlas }, { bookName: 'Tide Tables', chatIds: [], characterAvatars: [] }, { ...atlas }], failedCount: 0 });
        expect(lines[0]).toMatchObject({ icon: 'fa-circle-info' });
        expect(lines.filter(line => line.icon === 'fa-book').map(line => line.name)).toEqual(['Harbor Atlas', 'Tide Tables']);
        expect(lines.map(shown).join('\n')).toContain('Choose entries');
        expect(lines.map(shown).join('\n')).not.toContain('locked to');
    });

    it('says the books kept the locks when a collection with a book had any', () => {
        const lines = oldCollectionsNoticeLines({ deleted: [{ ...atlas, characterAvatars: ['keeper_orrin.png'] }], failedCount: 0 });
        expect(lines.map(shown)).toContain('Each book is locked to the chats and characters its old collections were locked to.');
    });

    it('counts the collections from books SillyTavern no longer has, and those it could not delete', () => {
        const lines = oldCollectionsNoticeLines({ deleted: [{ bookName: null, chatIds: ['chat-1'], characterAvatars: [] }], failedCount: 2 });
        const text = lines.map(shown);
        expect(text).toContain('1 of them came from books SillyTavern no longer has under that name.');
        expect(text).toContain('VectFox could not delete 2 other old lorebook collections. It tries again at the next start.');
        expect(lines.some(line => line.icon === 'fa-book')).toBe(false);
        expect(text.join('\n')).not.toContain('locked to');
    });
});
