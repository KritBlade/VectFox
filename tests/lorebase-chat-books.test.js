/**
 * The open chat's books as the WorldInfo page lists them (chatBookLocks in src/features/lorebase/lorebase-chat-books.js,
 * plan §5.2 and D11 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): each book
 * SillyTavern loads here and has, in the order its scan loads them, with how many of its selected entries LoreBase
 * decides (loadDecidedEntries, the count the keys line reads), its saved selection when the book cannot be loaded, and
 * whether it is locked to this chat or to the character, by the character's avatar file name. And the lock a key run
 * makes (§6.1 of InternalProject/Vectfox/plans/lorebook-multi-vector.md): where, read as the run starts, and which of
 * the books it wrote keys for lock to that chat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    worldNames: [], globalBooks: [], charLore: [], context: null, chatId: 'chat-harbor', settings: { vectfox: {} }, books: {},
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../src/sillytavern/world-info.js', () => ({
    METADATA_KEY: 'world_info',
    getWorldInfoSettings: () => ({ world_info: { charLore: host.charLore } }),
    loadWorldInfo: vi.fn(async bookName => {
        if (host.books[bookName] instanceof Error) throw host.books[bookName];
        return host.books[bookName] ?? null;
    }),
    selected_world_info: host.globalBooks,
    world_names: host.worldNames,
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context, getCurrentChatId: () => host.chatId }));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getCharaFilename: id => (id === '3' ? 'keeper-orrin' : null) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));

const { log } = await import('../src/sillytavern/log.js');
const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
const { chatBookLocks, keyRunLockPlace, lockKeyedBooks } = await import('../src/features/lorebase/lorebase-chat-books.js');

const recordOf = ({ selected = [], chats = [], characters = [] } = {}) => ({
    selectedUids: selected, pinnedSections: [], lockedToChatIds: chats, lockedToCharacterAvatars: characters,
});
const bookOf = (bookName, selectedCount, isLockedToChat, isLockedToCharacter) => ({ bookName, selectedCount, isLockedToChat, isLockedToCharacter });
const bookWith = (...uids) => ({ entries: Object.fromEntries(uids.map(uid => [uid, { uid, content: `Entry ${uid}.` }])) });

beforeEach(() => {
    host.worldNames.splice(0, host.worldNames.length, 'Harbor Atlas', 'Keeper Notes', 'Tide Tables', 'Voyage Log');
    host.globalBooks.splice(0, host.globalBooks.length, 'Tide Tables');
    host.charLore = [{ name: 'keeper-orrin', extraBooks: ['Lost Charts'] }];
    host.chatId = 'chat-harbor';
    host.context = {
        characters: { 3: { name: 'Keeper Orrin', avatar: 'keeper-orrin.png', data: { extensions: { world: 'Keeper Notes' } } } },
        characterId: '3',
        chatMetadata: { world_info: 'Harbor Atlas' },
        powerUserSettings: {},
    };
    host.settings.vectfox = {};
    host.books = { 'Harbor Atlas': bookWith(0, 1), 'Keeper Notes': bookWith(7), 'Tide Tables': bookWith(2), 'Voyage Log': bookWith(5) };
    vi.clearAllMocks();
});

describe('chatBookLocks', () => {
    it("lists the books this chat loads in the scan's order, each with its selected count and its locks here", async () => {
        host.settings.vectfox.lorebase_books = {
            'Harbor Atlas': recordOf({ selected: ['0', '1'], chats: ['chat-harbor'] }),
            'Keeper Notes': recordOf({ selected: ['7'], characters: ['keeper-orrin.png'] }),
            // Locked elsewhere only.
            'Tide Tables': recordOf({ selected: ['2'], chats: ['chat-other'], characters: ['wren.png'] }),
            // Locked here, but this chat does not load it.
            'Voyage Log': recordOf({ selected: ['5'], chats: ['chat-harbor'] }),
        };

        // The global book, the character's own (its extra book SillyTavern no longer has is left out), then the chat's.
        expect(await chatBookLocks()).toEqual({
            hasChat: true,
            books: [bookOf('Tide Tables', 1, false, false), bookOf('Keeper Notes', 1, false, true), bookOf('Harbor Atlas', 2, true, false)],
        });
    });

    it('counts nothing selected and no lock for a book LoreBase has no record of, loading no book', async () => {
        expect((await chatBookLocks()).books).toEqual([bookOf('Tide Tables', 0, false, false), bookOf('Keeper Notes', 0, false, false), bookOf('Harbor Atlas', 0, false, false)]);
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    it('counts only the selected entries LoreBase decides, as the keys line does', async () => {
        // Entry 1 was emptied and entry 9 deleted since they were selected.
        host.books['Harbor Atlas'] = { entries: { 0: { uid: 0, content: 'The harbor bells.' }, 1: { uid: 1, content: '' } } };
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0', '1', '9'] }) };
        expect((await chatBookLocks()).books.at(-1)).toEqual(bookOf('Harbor Atlas', 1, false, false));
    });

    it('counts the saved selection of a book that cannot be loaded, and logs why', async () => {
        const failure = new Error('HTTP 500');
        host.books['Harbor Atlas'] = failure;
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0', '1', '9'] }) };
        expect((await chatBookLocks()).books.at(-1)).toEqual(bookOf('Harbor Atlas', 3, false, false));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'), failure);
    });

    it('locks nothing to a character in a group chat, whose chat lock still counts', async () => {
        host.chatId = 'group-harbor';
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };
        host.settings.vectfox.lorebase_books = { 'Tide Tables': recordOf({ chats: ['group-harbor'], characters: ['keeper-orrin.png'] }) };

        expect(await chatBookLocks()).toEqual({ hasChat: true, books: [bookOf('Tide Tables', 0, true, false)] });
    });

    it('says when no chat is open', async () => {
        host.chatId = undefined;
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };

        expect(await chatBookLocks()).toEqual({ hasChat: false, books: [bookOf('Tide Tables', 0, false, false)] });
    });
});

describe('the lock a key run makes', () => {
    const books = () => host.settings.vectfox.lorebase_books;

    it('is read as the run starts: the open chat, its character, and the books the chat loads, but those whose lock the user set', () => {
        expect(keyRunLockPlace(['Keeper Notes'])).toEqual({
            chatId: 'chat-harbor', characterAvatar: 'keeper-orrin.png', lockableBookNames: new Set(['Tide Tables', 'Lost Charts', 'Harbor Atlas']),
        });
        host.chatId = undefined;
        expect(keyRunLockPlace()).toBeNull();
    });

    it('locks each keyed book the chat loads to the chat, unless it is locked to the chat or its character, and names them', () => {
        host.settings.vectfox.lorebase_books = {
            'Harbor Atlas': recordOf({ selected: ['0'] }),
            // Locked to another chat only.
            'Tide Tables': recordOf({ selected: ['2'], chats: ['chat-other'] }),
            'Keeper Notes': recordOf({ selected: ['7'], characters: ['keeper-orrin.png'] }),
            // This chat does not load it.
            'Voyage Log': recordOf({ selected: ['5'] }),
        };
        expect(lockKeyedBooks(keyRunLockPlace(), ['Harbor Atlas', 'Tide Tables', 'Keeper Notes', 'Voyage Log']))
            .toEqual({ chatId: 'chat-harbor', bookNames: ['Harbor Atlas', 'Tide Tables'] });
        expect([books()['Harbor Atlas'].lockedToChatIds, books()['Tide Tables'].lockedToChatIds]).toEqual([['chat-harbor'], ['chat-other', 'chat-harbor']]);
        expect(books()['Keeper Notes']).toEqual(recordOf({ selected: ['7'], characters: ['keeper-orrin.png'] }));
        expect(books()['Voyage Log']).toEqual(recordOf({ selected: ['5'] }));
    });

    it('locks to the chat the run started in, never to one opened while it went', () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0'] }) };
        const place = keyRunLockPlace();
        host.chatId = 'chat-later';
        expect(lockKeyedBooks(place, ['Harbor Atlas'])).toEqual({ chatId: 'chat-harbor', bookNames: ['Harbor Atlas'] });
        expect(books()['Harbor Atlas'].lockedToChatIds).toEqual(['chat-harbor']);
    });

    it('leaves a book whose lock the user set on the screen, so a lock turned off stays off, and locks nothing with no chat', () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0'] }), 'Tide Tables': recordOf({ selected: ['2'], chats: ['chat-harbor'] }) };
        expect(lockKeyedBooks(keyRunLockPlace(['Harbor Atlas']), ['Harbor Atlas', 'Tide Tables'])).toBeNull();
        expect([books()['Harbor Atlas'].lockedToChatIds, books()['Tide Tables'].lockedToChatIds]).toEqual([[], ['chat-harbor']]);
        expect(lockKeyedBooks(null, ['Harbor Atlas'])).toBeNull();
        expect(books()['Harbor Atlas'].lockedToChatIds).toEqual([]);
    });

    it('locks to a group chat, where no one character holds a lock', () => {
        host.chatId = 'group-harbor';
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };
        host.settings.vectfox.lorebase_books = { 'Tide Tables': recordOf({ selected: ['2'], characters: ['keeper-orrin.png'] }) };
        const place = keyRunLockPlace();
        expect(place).toEqual({ chatId: 'group-harbor', characterAvatar: null, lockableBookNames: new Set(['Tide Tables']) });
        expect(lockKeyedBooks(place, ['Tide Tables'])).toEqual({ chatId: 'group-harbor', bookNames: ['Tide Tables'] });
        expect(books()['Tide Tables'].lockedToChatIds).toEqual(['group-harbor']);
    });
});
