/**
 * The open chat's books as the WorldInfo page lists them (chatBookLocks in src/features/lorebase/lorebase-chat-books.js,
 * plan §5.2 and D11 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): each book
 * SillyTavern loads here and has, in the order its scan loads them, with how many of its selected entries LoreBase
 * decides (loadDecidedEntries, the count the keys line reads), its saved selection when the book cannot be loaded, and
 * whether it is locked to this chat or to the character, by the character's avatar file name. And the lock a key run
 * makes (§6.1 of InternalProject/Vectfox/plans/lorebook-multi-vector.md): where, read as the run starts, and which of
 * the books it wrote keys for lock to that chat. And Add a lorebook (§6 of lorebook-multi-vector.md): the books the
 * chat does not load, each added to the character or to all chats through SillyTavern's own lists and locked where it
 * went, or refused, linking and locking nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    worldNames: [], globalBooks: [], charLore: [], context: null, chatId: 'chat-harbor', settings: { vectfox: {} }, books: {},
    isLinkMade: true,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../src/sillytavern/world-info.js', () => ({
    METADATA_KEY: 'world_info',
    // As SillyTavern does, unless the test says it made no link: the character's list, keyed by its avatar file name
    // without its extension, and the global list.
    addCharacterLorebook: vi.fn(async (characterAvatar, bookName) => {
        if (!host.isLinkMade) return;
        const name = characterAvatar.replace(/\.[^/.]+$/, '');
        const item = host.charLore.find(candidate => candidate.name === name);
        if (item) item.extraBooks.push(bookName);
        else host.charLore.push({ name, extraBooks: [bookName] });
    }),
    addGlobalLorebook: vi.fn(bookName => {
        if (host.isLinkMade) host.globalBooks.push(bookName);
    }),
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
const { addCharacterLorebook, addGlobalLorebook, loadWorldInfo } = await import('../src/sillytavern/world-info.js');
const {
    ADD_TO_ALL_CHATS, ADD_TO_CHARACTER, addLoreBookToChat, booksToAdd, chatBookLocks, keyRunLockPlace, lockKeyedBooks,
} = await import('../src/features/lorebase/lorebase-chat-books.js');
const { loreBaseBooksMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');

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
    host.isLinkMade = true;
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

describe('Add a lorebook', () => {
    const books = () => host.settings.vectfox.lorebase_books;
    const inGroupChat = () => {
        host.chatId = 'group-harbor';
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };
    };

    it('offers every book SillyTavern has that the chat does not load, in its order, and the character outside a group chat', () => {
        host.worldNames.push('Coral Index');
        expect(booksToAdd()).toEqual({ bookNames: ['Voyage Log', 'Coral Index'], canAddToCharacter: true });
        inGroupChat();
        expect(booksToAdd()).toEqual({ bookNames: ['Harbor Atlas', 'Keeper Notes', 'Voyage Log', 'Coral Index'], canAddToCharacter: false });
    });

    it("adds a book to the character's Additional Lorebooks and locks it to the character", async () => {
        expect(await addLoreBookToChat('Voyage Log', ADD_TO_CHARACTER)).toEqual({ characterAvatar: 'keeper-orrin.png' });
        expect(addCharacterLorebook).toHaveBeenCalledWith('keeper-orrin.png', 'Voyage Log');
        expect(addGlobalLorebook).not.toHaveBeenCalled();
        expect(books()['Voyage Log']).toMatchObject({ lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        expect(booksToAdd().bookNames).toEqual([]);
    });

    it('adds a book to all chats and locks it to this chat, in a group chat too', async () => {
        expect(await addLoreBookToChat('Voyage Log', ADD_TO_ALL_CHATS)).toEqual({ chatId: 'chat-harbor' });
        expect(addGlobalLorebook).toHaveBeenCalledWith('Voyage Log');
        expect(books()['Voyage Log']).toMatchObject({ lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] });

        inGroupChat();
        expect(await addLoreBookToChat('Keeper Notes', ADD_TO_ALL_CHATS)).toEqual({ chatId: 'group-harbor' });
        expect(books()['Keeper Notes'].lockedToChatIds).toEqual(['group-harbor']);
    });

    it('refuses, linking and locking nothing: no chat, a place it does not know, a book SillyTavern lacks or the chat loads, the character of a group chat', async () => {
        host.chatId = null;
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_ALL_CHATS)).rejects.toThrow('Open a chat to add a lorebook to it.');
        host.chatId = 'chat-harbor';
        await expect(addLoreBookToChat('Voyage Log', 'persona')).rejects.toThrow('Add a lorebook has no place called "persona".');
        await expect(addLoreBookToChat('Lost Charts', ADD_TO_CHARACTER)).rejects.toThrow('SillyTavern has no lorebook named "Lost Charts".');
        await expect(addLoreBookToChat('Tide Tables', ADD_TO_CHARACTER)).rejects.toThrow('This chat already loads "Tide Tables".');
        inGroupChat();
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHARACTER)).rejects.toThrow('A group chat has no one character to add a lorebook to: add it to all chats.');
        expect(addCharacterLorebook).not.toHaveBeenCalled();
        expect(addGlobalLorebook).not.toHaveBeenCalled();
        expect(books()).toBeUndefined();
    });

    it('says when SillyTavern did not add the book, and locks nothing', async () => {
        host.isLinkMade = false;
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHARACTER)).rejects.toThrow('SillyTavern did not add "Voyage Log" to this character\'s lorebooks.');
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_ALL_CHATS)).rejects.toThrow('SillyTavern did not add "Voyage Log" to the lorebooks every chat loads.');
        expect(books()).toBeUndefined();
    });

    it("the WorldInfo page's Add buttons carry the places it takes", () => {
        const markup = loreBaseBooksMarkup({ hasChat: true, books: [], add: { bookNames: ['Voyage Log'], canAddToCharacter: true } });
        expect([...markup.matchAll(/data-lorebase-add="([^"]+)"/g)].map(match => match[1])).toEqual([ADD_TO_CHARACTER, ADD_TO_ALL_CHATS]);
    });
});
