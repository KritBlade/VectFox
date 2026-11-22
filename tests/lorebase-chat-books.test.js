/**
 * The open chat's books as the WorldInfo page lists them (chatBookLocks in src/features/lorebase/lorebase-chat-books.js,
 * plan §5.2 and D11 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): each book
 * SillyTavern loads here and has, in the order its scan loads them, with how many of its selected entries LoreBase
 * decides (loadDecidedEntries, the count the keys line reads), its saved selection when the book cannot be loaded,
 * whether it is locked to this chat or to the character it loads the book through, by the character's avatar file name,
 * in a group chat between replies each member's books with that member's lock, and whether its row offers Unlink: a
 * list Unlink takes books out of loads it. And the lock a key run
 * makes (§6.1 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): where, read as the run starts, and which of
 * the books it wrote keys for lock to that chat. And Add a lorebook (§6 of lorebook-multi-vector.md): the books the
 * chat does not load, each added to this chat as its Chat Lorebook or to the character through SillyTavern's own places
 * and locked where it went, or refused, linking and locking nothing, a chat's Chat Lorebook never replaced. And
 * unlinking a book from the chat's lists for the WorldInfo page's
 * Unlink (§3.6 of vectfox-multi-collection-per-chat.md): where the chat loads it from, out of the
 * character's Additional Lorebooks and the global list, and off the chat as its Chat Lorebook, after which Add a
 * lorebook offers it again; the character's own and the persona's left to SillyTavern, and the global list said to load
 * it still when SillyTavern's World Info panel is not on the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    worldNames: [], globalBooks: [], charLore: [], context: null, chatId: 'chat-harbor', settings: { vectfox: {} }, books: {},
    isLinkMade: true, isPanelShown: true,
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
    addChatLorebook: vi.fn(async bookName => {
        if (host.isLinkMade) host.context.chatMetadata.world_info = bookName;
    }),
    removeCharacterLorebook: vi.fn((characterFileName, bookName) => {
        const item = host.charLore.find(candidate => candidate.name === characterFileName);
        if (item) item.extraBooks = item.extraBooks.filter(name => name !== bookName);
    }),
    removeGlobalLorebook: vi.fn(bookName => {
        if (!host.isPanelShown) throw new Error("SillyTavern's World Info panel is not on the page.");
        host.globalBooks.splice(host.globalBooks.indexOf(bookName), 1);
    }),
    removeChatLorebook: vi.fn(async bookName => {
        if (host.context.chatMetadata.world_info === bookName) delete host.context.chatMetadata.world_info;
    }),
    getWorldInfoSettings: () => ({ world_info: { charLore: host.charLore } }),
    characterLorebooks: characterFileName => host.charLore.find(item => item.name === characterFileName)?.extraBooks ?? [],
    loadWorldInfo: vi.fn(async bookName => {
        if (host.books[bookName] instanceof Error) throw host.books[bookName];
        return host.books[bookName] ?? null;
    }),
    selected_world_info: host.globalBooks,
    world_names: host.worldNames,
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context, getCurrentChatId: () => host.chatId }));
// SillyTavern's file name of a character: its avatar's without the extension.
vi.mock('../src/sillytavern/identifiers.js', () => ({ getCharaFilename: (id, { manualAvatarKey = null } = {}) => manualAvatarKey?.replace(/\.[^/.]+$/, '') ?? null }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));

const { log } = await import('../src/sillytavern/log.js');
const {
    addCharacterLorebook, addChatLorebook, loadWorldInfo, removeCharacterLorebook, removeChatLorebook, removeGlobalLorebook,
} = await import('../src/sillytavern/world-info.js');
const {
    ADD_TO_CHARACTER, ADD_TO_CHAT, addLoreBookToChat, booksToAdd, chatBookLinks, chatBookLocks, chatBookNames, keyRunLockPlace,
    lockKeyedBooks, newLoreSelectionHere, unlinkLoreBookFromChat, useLoreSelectionHere,
} = await import('../src/features/lorebase/lorebase-chat-books.js');
const { loreBaseBooksMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { oneSelectionRecord } = await import('./lorebase-book-record.js');

const recordOf = ({ selected = [], chats = [], characters = [] } = {}) => oneSelectionRecord({
    selectedUids: selected, lockedToChatIds: chats, lockedToCharacterAvatars: characters,
});
// A book of one selection, the record recordOf makes, as the WorldInfo page lists it.
const ONE_SELECTION = [{ id: 'first', name: 'First' }];
const bookOf = (bookName, selectedCount, isLockedToChat, isLockedToCharacter, canUnlink, selections = [], selectionInUseId = null) => ({
    bookName, selectedCount, isLockedToChat, isLockedToCharacter, selections, selectionInUseId, canUnlink,
});
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
    host.isPanelShown = true;
    vi.clearAllMocks();
});

describe('chatBookLocks', () => {
    it("lists the books this chat loads in the scan's order, each with its selection in use here, its count, its locks and Unlink", async () => {
        host.settings.vectfox.lorebase_books = {
            'Harbor Atlas': recordOf({ selected: ['0', '1'], chats: ['chat-harbor'] }),
            'Keeper Notes': recordOf({ selected: ['7'], characters: ['keeper-orrin.png'] }),
            // Locked elsewhere only.
            'Tide Tables': recordOf({ selected: ['2'], chats: ['chat-other'], characters: ['wren.png'] }),
            // Locked here, but this chat does not load it.
            'Voyage Log': recordOf({ selected: ['5'], chats: ['chat-harbor'] }),
        };

        // The global book, the character's own (its extra book SillyTavern no longer has is left out), then the chat's.
        // The character's own book has no Unlink: it is SillyTavern's to change.
        expect(await chatBookLocks()).toEqual({
            hasChat: true,
            books: [
                bookOf('Tide Tables', 1, false, false, true, ONE_SELECTION),
                bookOf('Keeper Notes', 1, false, true, false, ONE_SELECTION, 'first'),
                bookOf('Harbor Atlas', 2, true, false, true, ONE_SELECTION, 'first'),
            ],
        });
    });

    it('counts and locks the selection in use here, the chat lock before the character lock, and every selection with none', async () => {
        host.books['Harbor Atlas'] = bookWith(0, 1, 2);
        const harbor = recordOf({ selected: ['0'], characters: ['keeper-orrin.png'] });
        harbor.selections.push({ id: 'second', name: 'Second', selectedUids: ['1', '2'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] });
        const tide = recordOf({ selected: ['2'] });
        host.books['Tide Tables'] = bookWith(2, 3);
        tide.selections.push({ id: 'second', name: 'Second', selectedUids: ['3'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': harbor, 'Tide Tables': tide };

        const both = [...ONE_SELECTION, { id: 'second', name: 'Second' }];
        const { books } = await chatBookLocks();
        expect(books.find(book => book.bookName === 'Harbor Atlas')).toEqual(bookOf('Harbor Atlas', 2, true, false, true, both, 'second'));
        expect(books.find(book => book.bookName === 'Tide Tables')).toEqual(bookOf('Tide Tables', 2, false, false, true, both));
    });

    it('counts nothing selected and no lock for a book LoreBase has no record of, and offers Unlink where a list Unlink empties loads it, loading no book', async () => {
        // The global list's book and the chat's Chat Lorebook can be unlinked; the character's own lorebook is SillyTavern's to change.
        expect((await chatBookLocks()).books).toEqual([
            bookOf('Tide Tables', 0, false, false, true), bookOf('Keeper Notes', 0, false, false, false),
            bookOf('Harbor Atlas', 0, false, false, true),
        ]);
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    it('counts only the selected entries LoreBase decides, as the keys line does', async () => {
        // Entry 1 was emptied and entry 9 deleted since they were selected.
        host.books['Harbor Atlas'] = { entries: { 0: { uid: 0, content: 'The harbor bells.' }, 1: { uid: 1, content: '' } } };
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0', '1', '9'] }) };
        expect((await chatBookLocks()).books.at(-1)).toEqual(bookOf('Harbor Atlas', 1, false, false, true, ONE_SELECTION));
    });

    it('counts the saved selection of a book that cannot be loaded, and logs why', async () => {
        const failure = new Error('HTTP 500');
        host.books['Harbor Atlas'] = failure;
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0', '1', '9'] }) };
        expect((await chatBookLocks()).books.at(-1)).toEqual(bookOf('Harbor Atlas', 3, false, false, true, ONE_SELECTION));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'), failure);
    });

    it('locks nothing to a character in a group chat, whose chat lock still counts', async () => {
        host.chatId = 'group-harbor';
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };
        host.settings.vectfox.lorebase_books = { 'Tide Tables': recordOf({ chats: ['group-harbor'], characters: ['keeper-orrin.png'] }) };

        expect(await chatBookLocks()).toEqual({ hasChat: true, books: [bookOf('Tide Tables', 0, true, false, true, ONE_SELECTION, 'first')] });
    });

    it('says when no chat is open', async () => {
        host.chatId = undefined;
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };

        expect(await chatBookLocks()).toEqual({ hasChat: false, books: [bookOf('Tide Tables', 0, false, false, true)] });
    });
});

describe('the lock a key run makes', () => {
    const firstOf = bookName => host.settings.vectfox.lorebase_books[bookName].selections[0];

    it('is read as the run starts: the open chat, and the books the chat loads with where each is in use, but those whose lock the user set', () => {
        const place = keyRunLockPlace(['Keeper Notes']);
        expect([place.chatId, [...place.whereByBook.keys()], place.whereByBook.get('Harbor Atlas')]).toEqual([
            'chat-harbor', ['Tide Tables', 'Lost Charts', 'Harbor Atlas'], { chatId: 'chat-harbor', characterAvatar: 'keeper-orrin.png', characterName: 'Keeper Orrin' },
        ]);
        host.chatId = undefined;
        expect(keyRunLockPlace()).toBeNull();
    });

    it('locks the one selection of each keyed book the chat loads to the chat, unless one is in use here, and names them', () => {
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
        expect([firstOf('Harbor Atlas').lockedToChatIds, firstOf('Tide Tables').lockedToChatIds]).toEqual([['chat-harbor'], ['chat-other', 'chat-harbor']]);
        expect(host.settings.vectfox.lorebase_books['Keeper Notes']).toEqual(recordOf({ selected: ['7'], characters: ['keeper-orrin.png'] }));
        expect(host.settings.vectfox.lorebase_books['Voyage Log']).toEqual(recordOf({ selected: ['5'] }));
    });

    it('leaves a book with more than one selection as the user set it', () => {
        const harbor = recordOf({ selected: ['0'] });
        harbor.selections.push({ id: 'second', name: 'Second', selectedUids: ['1'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': harbor };
        expect(lockKeyedBooks(keyRunLockPlace(), ['Harbor Atlas'])).toBeNull();
        expect(harbor.selections.map(selection => selection.lockedToChatIds)).toEqual([[], []]);
    });

    it('locks to the chat the run started in, never to one opened while it went', () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0'] }) };
        const place = keyRunLockPlace();
        host.chatId = 'chat-later';
        expect(lockKeyedBooks(place, ['Harbor Atlas'])).toEqual({ chatId: 'chat-harbor', bookNames: ['Harbor Atlas'] });
        expect(firstOf('Harbor Atlas').lockedToChatIds).toEqual(['chat-harbor']);
    });

    it('leaves a book whose lock the user set on the screen, so a lock turned off stays off, and locks nothing with no chat', () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': recordOf({ selected: ['0'] }), 'Tide Tables': recordOf({ selected: ['2'], chats: ['chat-harbor'] }) };
        expect(lockKeyedBooks(keyRunLockPlace(['Harbor Atlas']), ['Harbor Atlas', 'Tide Tables'])).toBeNull();
        expect([firstOf('Harbor Atlas').lockedToChatIds, firstOf('Tide Tables').lockedToChatIds]).toEqual([[], ['chat-harbor']]);
        expect(lockKeyedBooks(null, ['Harbor Atlas'])).toBeNull();
        expect(firstOf('Harbor Atlas').lockedToChatIds).toEqual([]);
    });

    it('locks to a group chat, where no one character holds a lock', () => {
        host.chatId = 'group-harbor';
        host.context = { characters: host.context.characters, characterId: undefined, chatMetadata: {}, powerUserSettings: {} };
        host.settings.vectfox.lorebase_books = { 'Tide Tables': recordOf({ selected: ['2'], characters: ['keeper-orrin.png'] }) };
        const place = keyRunLockPlace();
        expect(place).toEqual({ chatId: 'group-harbor', whereByBook: new Map([['Tide Tables', { chatId: 'group-harbor', characterAvatar: null, characterName: '' }]]) });
        expect(lockKeyedBooks(place, ['Tide Tables'])).toEqual({ chatId: 'group-harbor', bookNames: ['Tide Tables'] });
        expect(firstOf('Tide Tables').lockedToChatIds).toEqual(['group-harbor']);
    });
});

describe('a group chat: each member\'s books, in use through that member (option b)', () => {
    // Keeper Orrin and Wren in a group, Mara muted. SillyTavern loads a member's own lorebook and Additional Lorebooks on
    // that member's turn, so between replies the pages list every unmuted member's books, each "here" through its member.
    beforeEach(() => {
        host.chatId = 'group-harbor';
        host.worldNames.push('Wren Journal', 'Mara Notes');
        host.charLore.push({ name: 'wren', extraBooks: ['Voyage Log'] });
        host.context = {
            characters: [
                { name: 'Keeper Orrin', avatar: 'keeper-orrin.png', data: { extensions: { world: 'Keeper Notes' } } },
                { name: 'Wren', avatar: 'wren.png', data: { extensions: { world: 'Wren Journal' } } },
                { name: 'Mara', avatar: 'mara.png', data: { extensions: { world: 'Mara Notes' } } },
            ],
            characterId: undefined,
            groupId: 'harbor-crew',
            groups: [{ id: 'harbor-crew', members: ['keeper-orrin.png', 'wren.png', 'mara.png'], disabled_members: ['mara.png'] }],
            chatMetadata: {},
            powerUserSettings: {},
        };
        host.books['Wren Journal'] = bookWith(9);
    });

    it("lists every unmuted member's books between replies, each in use through the member that loads it", async () => {
        host.settings.vectfox.lorebase_books = {
            'Wren Journal': recordOf({ selected: ['9'], characters: ['wren.png'] }),
            'Keeper Notes': recordOf({ selected: ['7'], characters: ['wren.png'] }),
        };
        expect(chatBookNames()).toEqual(['Tide Tables', 'Keeper Notes', 'Lost Charts', 'Wren Journal', 'Voyage Log']);
        const { books } = await chatBookLocks();
        expect(books.find(book => book.bookName === 'Wren Journal')).toMatchObject({ selectionInUseId: 'first', selectedCount: 1, isLockedToCharacter: true });
        // Keeper Notes is Keeper Orrin's lorebook, so a lock to Wren does not put it in use here.
        expect(books.find(book => book.bookName === 'Keeper Notes')).toMatchObject({ selectionInUseId: null, isLockedToCharacter: false });
    });

    it("reads the drafted member alone on that member's turn, as SillyTavern's scan loads its books", async () => {
        host.settings.vectfox.lorebase_books = { 'Tide Tables': recordOf({ selected: ['2'], characters: ['wren.png'] }) };
        host.context.characterId = 1;
        expect(chatBookNames()).toEqual(['Tide Tables', 'Wren Journal', 'Voyage Log']);
        expect((await chatBookLocks()).books[0]).toMatchObject({ bookName: 'Tide Tables', selectionInUseId: 'first', isLockedToCharacter: true });
        host.context.characterId = undefined;
        expect((await chatBookLocks()).books[0]).toMatchObject({ bookName: 'Tide Tables', selectionInUseId: null });
    });

    it("reads each book's member where a key run locks, and locks to the group chat", () => {
        host.settings.vectfox.lorebase_books = { 'Wren Journal': recordOf({ selected: ['9'], characters: ['wren.png'] }), 'Voyage Log': recordOf({ selected: ['5'] }) };
        const place = keyRunLockPlace();
        expect(place.whereByBook.get('Voyage Log')).toEqual({ chatId: 'group-harbor', characterAvatar: 'wren.png', characterName: 'Wren' });
        expect(place.whereByBook.get('Tide Tables')).toEqual({ chatId: 'group-harbor', characterAvatar: null, characterName: '' });
        // Wren Journal is in use through Wren's lock already; Voyage Log has none in use, so it locks to the group chat.
        expect(lockKeyedBooks(place, ['Wren Journal', 'Voyage Log'])).toEqual({ chatId: 'group-harbor', bookNames: ['Voyage Log'] });
    });

    it("unlinks a book from the Additional Lorebooks of the member that lists it", async () => {
        expect(chatBookLinks('Voyage Log')).toEqual({ unlinkedFrom: ['characterBooks'], stillLoadedBy: [] });
        expect(await unlinkLoreBookFromChat('Voyage Log')).toEqual({ unlinkedFrom: ['characterBooks'], stillLoadedBy: [] });
        expect(removeCharacterLorebook).toHaveBeenCalledWith('wren', 'Voyage Log');
    });
});

describe("the WorldInfo page's switcher", () => {
    const selectionsOf = bookName => host.settings.vectfox.lorebase_books[bookName].selections;

    beforeEach(() => {
        const harbor = recordOf({ selected: ['0', '1'], chats: ['chat-harbor'] });
        harbor.selections.push({ id: 'second', name: 'Second', selectedUids: ['1'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] });
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': harbor };
    });

    it("puts a selection in use in this chat, taking the chat off the book's other selection", () => {
        useLoreSelectionHere('Harbor Atlas', 'second');
        expect(selectionsOf('Harbor Atlas').map(selection => selection.lockedToChatIds)).toEqual([[], ['chat-harbor']]);
        host.chatId = undefined;
        expect(() => useLoreSelectionHere('Harbor Atlas', 'first')).toThrow('Open a chat to choose the selection it uses.');
    });

    it('makes a new selection from the one in use, or the one named, and puts it in use in this chat', () => {
        const copy = newLoreSelectionHere('Harbor Atlas');
        expect(copy).toMatchObject({ name: 'Harbor Atlas 2', selectedUids: ['0', '1'], lockedToChatIds: ['chat-harbor'] });
        expect(selectionsOf('Harbor Atlas')[0].lockedToChatIds).toEqual([]);
        expect(newLoreSelectionHere('Harbor Atlas', 'second')).toMatchObject({ name: 'Harbor Atlas 3', selectedUids: ['1'], lockedToChatIds: ['chat-harbor'] });
    });

    it('makes a new selection locked nowhere with no chat open', () => {
        host.chatId = undefined;
        expect(newLoreSelectionHere('Harbor Atlas')).toMatchObject({ name: 'Harbor Atlas 2', selectedUids: ['0', '1'], lockedToChatIds: [] });
    });

    // A book whose record its trash deleted, or never opened, has none to copy: its first is made, as Choose entries makes it.
    it("makes a book's first selection, named after it with nothing selected, and puts it in use in this chat, when it has none", () => {
        expect(newLoreSelectionHere('Keeper Notes')).toMatchObject({ name: 'Keeper Notes', selectedUids: [], lockedToChatIds: ['chat-harbor'] });
        expect(selectionsOf('Keeper Notes')).toHaveLength(1);
    });
});

describe('Add a lorebook', () => {
    const books = () => host.settings.vectfox.lorebase_books;
    const firstOf = bookName => books()[bookName].selections[0];
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

    it("adds a book to the character's Additional Lorebooks and locks its first selection, made then, to the character", async () => {
        expect(await addLoreBookToChat('Voyage Log', ADD_TO_CHARACTER)).toEqual({ characterAvatar: 'keeper-orrin.png' });
        expect(addCharacterLorebook).toHaveBeenCalledWith('keeper-orrin.png', 'Voyage Log');
        expect(addChatLorebook).not.toHaveBeenCalled();
        expect(books()['Voyage Log'].selections).toHaveLength(1);
        expect(firstOf('Voyage Log')).toMatchObject({ name: 'Voyage Log', selectedUids: [], lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        expect(booksToAdd().bookNames).toEqual([]);
    });

    it('adds a book to this chat as its Chat Lorebook and locks it to this chat, in a group chat too', async () => {
        host.context.chatMetadata = {};
        expect(await addLoreBookToChat('Voyage Log', ADD_TO_CHAT)).toEqual({ chatId: 'chat-harbor' });
        expect(addChatLorebook).toHaveBeenCalledWith('Voyage Log');
        expect(chatBookLinks('Voyage Log')).toEqual({ unlinkedFrom: ['chatBook'], stillLoadedBy: [] });
        expect(firstOf('Voyage Log')).toMatchObject({ lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] });

        inGroupChat();
        expect(await addLoreBookToChat('Keeper Notes', ADD_TO_CHAT)).toEqual({ chatId: 'group-harbor' });
        expect(firstOf('Keeper Notes').lockedToChatIds).toEqual(['group-harbor']);
    });

    // A chat has one Chat Lorebook: adding another would quietly unlink the one the user set.
    it("never replaces the chat's Chat Lorebook, naming it, and points to the character or SillyTavern's Chat Lore button", async () => {
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHAT))
            .rejects.toThrow('This chat\'s Chat Lorebook is "Harbor Atlas" already, and a chat has one: add "Voyage Log" to this character instead.');
        inGroupChat();
        host.context.chatMetadata = { world_info: 'Tide Tables' };
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHAT))
            .rejects.toThrow('This chat\'s Chat Lorebook is "Tide Tables" already, and a chat has one: change it at SillyTavern\'s Chat Lore button.');
        expect(addChatLorebook).not.toHaveBeenCalled();
        expect(books()).toBeUndefined();
    });

    it('takes the place of a Chat Lorebook SillyTavern no longer has, as SillyTavern reads none there', async () => {
        host.context.chatMetadata = { world_info: 'Lost Charts' };
        expect(await addLoreBookToChat('Voyage Log', ADD_TO_CHAT)).toEqual({ chatId: 'chat-harbor' });
        expect(host.context.chatMetadata.world_info).toBe('Voyage Log');
    });

    it('refuses, linking and locking nothing: no chat, a place it does not know, a book SillyTavern lacks or the chat loads, the character of a group chat', async () => {
        host.chatId = null;
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHAT)).rejects.toThrow('Open a chat to add a lorebook to it.');
        host.chatId = 'chat-harbor';
        await expect(addLoreBookToChat('Voyage Log', 'all-chats')).rejects.toThrow('Add a lorebook has no place called "all-chats".');
        await expect(addLoreBookToChat('Lost Charts', ADD_TO_CHARACTER)).rejects.toThrow('SillyTavern has no lorebook named "Lost Charts".');
        await expect(addLoreBookToChat('Tide Tables', ADD_TO_CHARACTER)).rejects.toThrow('This chat already loads "Tide Tables".');
        inGroupChat();
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHARACTER)).rejects.toThrow('A group chat has no one character to add a lorebook to: add it to this chat.');
        expect(addCharacterLorebook).not.toHaveBeenCalled();
        expect(addChatLorebook).not.toHaveBeenCalled();
        expect(books()).toBeUndefined();
    });

    it('says when SillyTavern did not add the book, and locks nothing', async () => {
        host.isLinkMade = false;
        host.context.chatMetadata = {};
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHARACTER)).rejects.toThrow('SillyTavern did not add "Voyage Log" to this character\'s lorebooks.');
        await expect(addLoreBookToChat('Voyage Log', ADD_TO_CHAT)).rejects.toThrow('SillyTavern did not add "Voyage Log" to this chat.');
        expect(books()).toBeUndefined();
    });

    it("the WorldInfo page's Add buttons carry the places it takes, this chat's first", () => {
        const markup = loreBaseBooksMarkup({ hasChat: true, books: [], add: { bookNames: ['Voyage Log'], canAddToCharacter: true } });
        expect([...markup.matchAll(/data-lorebase-add="([^"]+)"/g)].map(match => match[1])).toEqual([ADD_TO_CHAT, ADD_TO_CHARACTER]);
    });
});

describe("unlinking a book from the chat's lists, for the WorldInfo page's Unlink", () => {
    it('says which of the lists loading a book Unlink takes it out of, and which places keep loading it', () => {
        host.charLore[0].extraBooks.push('Voyage Log');
        host.context.powerUserSettings = { persona_description_lorebook: 'Voyage Log' };
        expect(chatBookLinks('Voyage Log')).toEqual({ unlinkedFrom: ['characterBooks'], stillLoadedBy: ['personaBook'] });
        expect(chatBookLinks('Tide Tables')).toEqual({ unlinkedFrom: ['globalList'], stillLoadedBy: [] });
        expect(chatBookLinks('Keeper Notes')).toEqual({ unlinkedFrom: [], stillLoadedBy: ['characterOwnBook'] });
        expect(chatBookLinks('Harbor Atlas')).toEqual({ unlinkedFrom: ['chatBook'], stillLoadedBy: [] });
    });

    it("unlinks a book from this character's Additional Lorebooks and the global list, so the chat loads it no more", async () => {
        host.charLore[0].extraBooks.push('Tide Tables');
        expect(await unlinkLoreBookFromChat('Tide Tables')).toEqual({ unlinkedFrom: ['globalList', 'characterBooks'], stillLoadedBy: [] });
        expect(removeCharacterLorebook).toHaveBeenCalledWith('keeper-orrin', 'Tide Tables');
        expect(removeGlobalLorebook).toHaveBeenCalledWith('Tide Tables');
        expect(chatBookNames()).not.toContain('Tide Tables');
    });

    // The chat's own book loads in this chat alone, so unlinking it changes no other chat.
    it("unlinks the chat's Chat Lorebook, after which Add a lorebook offers the book again and adds it back to this chat", async () => {
        expect(booksToAdd().bookNames).not.toContain('Harbor Atlas');
        expect(await unlinkLoreBookFromChat('Harbor Atlas')).toEqual({ unlinkedFrom: ['chatBook'], stillLoadedBy: [] });
        expect(removeChatLorebook).toHaveBeenCalledWith('Harbor Atlas');
        expect(chatBookNames()).not.toContain('Harbor Atlas');
        expect(booksToAdd().bookNames).toContain('Harbor Atlas');
        expect(await addLoreBookToChat('Harbor Atlas', ADD_TO_CHAT)).toEqual({ chatId: 'chat-harbor' });
        expect(chatBookLinks('Harbor Atlas')).toEqual({ unlinkedFrom: ['chatBook'], stillLoadedBy: [] });
    });

    it("leaves the character's own lorebook and the persona's to SillyTavern, and says what still loads it", async () => {
        host.context.powerUserSettings = { persona_description_lorebook: 'Voyage Log' };
        expect(await unlinkLoreBookFromChat('Keeper Notes')).toEqual({ unlinkedFrom: [], stillLoadedBy: ['characterOwnBook'] });
        expect(await unlinkLoreBookFromChat('Voyage Log')).toEqual({ unlinkedFrom: [], stillLoadedBy: ['personaBook'] });
        expect(removeCharacterLorebook).not.toHaveBeenCalled();
        expect(removeGlobalLorebook).not.toHaveBeenCalled();
        expect(removeChatLorebook).not.toHaveBeenCalled();
    });

    it("says the global list still loads a book when SillyTavern's World Info panel is not on the page, and logs why", async () => {
        host.isPanelShown = false;
        expect(await unlinkLoreBookFromChat('Tide Tables')).toEqual({ unlinkedFrom: [], stillLoadedBy: ['globalList'] });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("global list"), expect.any(Error));
    });
});
