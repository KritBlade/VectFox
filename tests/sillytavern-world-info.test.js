/**
 * @vitest-environment jsdom
 *
 * Adding a lorebook through SillyTavern's own controls (src/sillytavern/world-info.js, §6 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): to a character's Additional Lorebooks through
 * charUpdateAddAuxWorld, by the character's avatar file name. Taking a lorebook out again: the character's Additional
 * Lorebooks set without it through charSetAuxWorlds, by the character's file name; the global list every chat loads
 * through the World Info panel's own
 * list, whose change handler sets the global books, the other books kept on; and the Chat Lorebook off the chat, the
 * metadata without it, the Chat Lore buttons unmarked and the metadata saved, another book left as it is.
 * Saving one entry's title and text, and its keys when given, as SillyTavern's World Info commands do: the loaded copy
 * changed, saved at once, and the World Info editor drawn again; a book or entry SillyTavern lacks is refused, saving
 * nothing. Creating a book (Entity-Lore's, §4.6 of InternalProject/Vectfox/plans/entity-lore.md): empty, under the name
 * a file holds, numbered from (2) while SillyTavern has that name in any case and accents, SillyTavern's list read again,
 * and a book the list lacks once saved refused. Adding an entry as /createentry does: SillyTavern's template at the
 * first free uid, its title as its memo, its keys and text set, saved at once and the editor drawn again.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ worldNames: [], globalBooks: [], books: {}, charLore: [], chatMetadata: {}, savedNames: [], isServerRefusing: false }));

// SillyTavern's script.js, as this folder reaches it when served beside src/: the open chat's metadata, a live binding.
vi.mock('../../../../../script.js', () => ({
    get chat_metadata() { return host.chatMetadata; },
    saveMetadata: vi.fn(async () => {}),
}));

// SillyTavern's utils.js: its server's file name rule, which drops the characters a file name cannot hold, and its
// match of two names in any case and accents.
vi.mock('../../../../utils.js', () => ({
    getSanitizedFilename: vi.fn(async name => name.replace(/[/\\:*?"<>|]/g, '')),
    equalsIgnoreCaseAndAccents: (a, b) => [a, b].map(name => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()).every((name, _, both) => name === both[0]),
}));

// SillyTavern's world-info.js, /scripts/world-info.js, as this folder reaches it when served beside src/.
vi.mock('../../../../world-info.js', () => ({
    METADATA_KEY: 'world_info',
    charSetAuxWorlds: vi.fn(),
    charUpdateAddAuxWorld: vi.fn(async () => {}),
    checkWorldInfo: vi.fn(),
    // A new entry from SillyTavern's template, at the book's first free uid.
    createWorldInfoEntry: vi.fn((_name, data) => {
        let uid = 0;
        while (uid in data.entries) uid += 1;
        data.entries[uid] = { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, selective: true, addMemo: false, disable: false };
        return data.entries[uid];
    }),
    getSortedEntries: vi.fn(),
    getWorldInfoSettings: vi.fn(() => ({ world_info: { charLore: host.charLore } })),
    // SillyTavern hands out a copy of its cached book.
    loadWorldInfo: vi.fn(async bookName => (host.books[bookName] ? structuredClone(host.books[bookName]) : null)),
    reloadEditor: vi.fn(),
    saveWorldInfo: vi.fn(async bookName => { host.savedNames.push(bookName); }),
    // Its list read again from the server, which holds every book saved unless it refused them.
    updateWorldInfoList: vi.fn(async () => {
        if (!host.isServerRefusing) host.worldNames.push(...host.savedNames.filter(name => !host.worldNames.includes(name)));
    }),
    // A live binding: SillyTavern's change handler assigns a new list.
    get selected_world_info() { return host.globalBooks; },
    world_info_include_names: true,
    world_names: host.worldNames,
}));

const { charSetAuxWorlds, charUpdateAddAuxWorld, createWorldInfoEntry, reloadEditor, saveWorldInfo, updateWorldInfoList } = await import('../../../../world-info.js');
const { saveMetadata } = await import('../../../../../script.js');
const {
    addCharacterLorebook, createLorebook, createLorebookEntry, removeCharacterLorebook, removeChatLorebook, removeGlobalLorebook, saveLorebookEntry,
} = await import('../src/sillytavern/world-info.js');

let changeCount = 0;

// The World Info panel's global list as SillyTavern draws it, each option valued by its book's place in world_names,
// and its change handler, which sets the global books from the options selected.
function drawPanelList({ shownOn = host.globalBooks } = {}) {
    const options = host.worldNames.map((bookName, index) => `<option value="${index}"${shownOn.includes(bookName) ? ' selected' : ''}></option>`);
    document.body.innerHTML = `<select id="world_info" multiple>${options.join('')}</select>`;
    const list = document.getElementById('world_info');
    host.worldNames.forEach((bookName, index) => { list.options[index].textContent = bookName; });
    list.addEventListener('change', () => {
        changeCount += 1;
        host.globalBooks = [...list.selectedOptions].map(option => host.worldNames[Number(option.value)]);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    host.worldNames.splice(0, host.worldNames.length, 'Harbor Atlas', 'Tide Tables', 'Voyage, Log', 'The <b>Old</b> "Keep"');
    host.globalBooks = ['Tide Tables'];
    host.charLore = [{ name: 'keeper-orrin', extraBooks: ['Voyage, Log', 'Harbor Atlas'] }];
    host.savedNames = [];
    host.isServerRefusing = false;
    changeCount = 0;
});

describe('createLorebook', () => {
    it('saves an empty book at once under the name as a file holds it, then reads SillyTavern\'s list again, and returns the name', async () => {
        expect(await createLorebook('VectFox NPCs - Night: Harbor?')).toBe('VectFox NPCs - Night Harbor');
        expect(saveWorldInfo).toHaveBeenCalledWith('VectFox NPCs - Night Harbor', { entries: {} }, true);
        expect(saveWorldInfo.mock.invocationCallOrder[0]).toBeLessThan(updateWorldInfoList.mock.invocationCallOrder[0]);
        expect(host.worldNames).toContain('VectFox NPCs - Night Harbor');
    });

    it('numbers the name from (2) while SillyTavern has a book of that name, in any case and accents', async () => {
        host.worldNames.push('VECTFOX NPCS - TIDE', 'VectFox NPCs - Tíde (2)');
        expect(await createLorebook('VectFox NPCs - Tide')).toBe('VectFox NPCs - Tide (3)');
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    it('refuses a book SillyTavern does not list once saved', async () => {
        host.isServerRefusing = true;
        await expect(createLorebook('VectFox NPCs - Tide')).rejects.toThrow('SillyTavern did not save the lorebook "VectFox NPCs - Tide".');
    });
});

describe('createLorebookEntry', () => {
    beforeEach(() => {
        host.books = { 'Harbor Atlas': { entries: { 0: { uid: 0, comment: 'Lighthouse', content: 'It stands.', key: ['beacon'] }, 4: { uid: 4, comment: 'Pier', content: 'Old.' } } } };
    });

    it("adds an entry from SillyTavern's template at the first free uid, its title as its memo, its keys and text set, saved at once and the editor drawn again", async () => {
        const keys = ['Tamsin', 'Tamsin Vale'];
        expect(await createLorebookEntry('Harbor Atlas', { comment: 'Tamsin', keys, content: '[Identity]\nA salt trader.' })).toBe('1');
        keys.push('Orla');
        const [bookName, book, isImmediate] = saveWorldInfo.mock.calls[0];
        expect([bookName, isImmediate]).toEqual(['Harbor Atlas', true]);
        expect(book.entries[1]).toEqual({
            uid: 1, key: ['Tamsin', 'Tamsin Vale'], keysecondary: [], comment: 'Tamsin', content: '[Identity]\nA salt trader.',
            constant: false, selective: true, addMemo: true, disable: false,
        });
        expect(book.entries[0]).toEqual(host.books['Harbor Atlas'].entries[0]);
        expect(reloadEditor).toHaveBeenCalledWith('Harbor Atlas');
        expect(saveWorldInfo.mock.invocationCallOrder[0]).toBeLessThan(reloadEditor.mock.invocationCallOrder[0]);
    });

    it('refuses a book SillyTavern lacks, or an entry it finds no uid for, saving nothing', async () => {
        await expect(createLorebookEntry('Lost Charts', { comment: 'Tamsin', keys: [], content: '' })).rejects.toThrow('SillyTavern has no lorebook named "Lost Charts".');
        createWorldInfoEntry.mockReturnValueOnce(undefined);
        await expect(createLorebookEntry('Harbor Atlas', { comment: 'Tamsin', keys: [], content: '' })).rejects.toThrow('SillyTavern found no uid for a new entry in lorebook "Harbor Atlas".');
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });
});

describe('addCharacterLorebook', () => {
    it("adds the book to the character's Additional Lorebooks by the character's avatar file name", async () => {
        await addCharacterLorebook('keeper-orrin.png', 'Voyage, Log');
        expect(charUpdateAddAuxWorld).toHaveBeenCalledWith('keeper-orrin.png', 'Voyage, Log');
    });
});

describe('saveLorebookEntry', () => {
    beforeEach(() => {
        host.books = {
            'Harbor Atlas': { entries: { 0: { uid: 0, comment: 'Lighthouse', content: 'It stands.', key: ['beacon'] }, 4: { uid: 4, comment: 'Pier', content: 'Old.' } } },
        };
    });

    it("changes the entry's title and text alone, saves the book at once, then draws SillyTavern's editor again", async () => {
        await saveLorebookEntry('Harbor Atlas', '4', { comment: 'Old pier', content: 'Its planks are gone.' });
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
        const [bookName, book, isImmediate] = saveWorldInfo.mock.calls[0];
        expect([bookName, isImmediate]).toEqual(['Harbor Atlas', true]);
        expect(book.entries).toEqual({
            0: { uid: 0, comment: 'Lighthouse', content: 'It stands.', key: ['beacon'] },
            4: { uid: 4, comment: 'Old pier', content: 'Its planks are gone.' },
        });
        expect(reloadEditor).toHaveBeenCalledWith('Harbor Atlas');
        expect(saveWorldInfo.mock.invocationCallOrder[0]).toBeLessThan(reloadEditor.mock.invocationCallOrder[0]);
    });

    it('sets the entry\'s keys too when given, a copy of them', async () => {
        const keys = ['beacon', 'lamp'];
        await saveLorebookEntry('Harbor Atlas', '0', { comment: 'Lighthouse', content: 'It stands.', keys });
        keys.push('tower');
        expect(saveWorldInfo.mock.calls[0][1].entries[0]).toEqual({ uid: 0, comment: 'Lighthouse', content: 'It stands.', key: ['beacon', 'lamp'] });
    });

    it('refuses a book or an entry SillyTavern lacks, saving nothing', async () => {
        await expect(saveLorebookEntry('Lost Charts', '0', { comment: '', content: '' })).rejects.toThrow('SillyTavern has no lorebook named "Lost Charts".');
        await expect(saveLorebookEntry('Harbor Atlas', '9', { comment: '', content: '' })).rejects.toThrow('Lorebook "Harbor Atlas" has no entry 9 any more.');
        expect(saveWorldInfo).not.toHaveBeenCalled();
        expect(reloadEditor).not.toHaveBeenCalled();
    });
});

describe('removeCharacterLorebook', () => {
    it("sets the character's Additional Lorebooks without the book, by the character's file name, the others kept", () => {
        removeCharacterLorebook('keeper-orrin', 'Voyage, Log');
        expect(charSetAuxWorlds).toHaveBeenCalledWith('keeper-orrin', ['Harbor Atlas']);
    });
});

describe('removeGlobalLorebook', () => {
    it('turns the book off through one change of the panel list, the other books kept on', () => {
        host.globalBooks = ['Tide Tables', 'Voyage, Log', 'Harbor Atlas'];
        drawPanelList();
        removeGlobalLorebook('Voyage, Log');
        expect(changeCount).toBe(1);
        expect(host.globalBooks).toEqual(['Harbor Atlas', 'Tide Tables']);
    });

    it('refuses a page without the panel, changing nothing', () => {
        document.body.innerHTML = '';
        expect(() => removeGlobalLorebook('Tide Tables')).toThrow("SillyTavern's World Info panel is not on the page.");
        expect(host.globalBooks).toEqual(['Tide Tables']);
    });
});

describe('removeChatLorebook', () => {
    const drawChatLoreButtons = () => {
        document.body.innerHTML = '<div class="chat_lorebook_button world_set"></div><div class="chat_lorebook_button world_set"></div>';
    };

    it("takes the book off the chat's metadata, unmarks every Chat Lore button, then saves the metadata", async () => {
        host.chatMetadata = { world_info: 'Harbor Atlas', integrity: 'harbor-uuid' };
        drawChatLoreButtons();
        await removeChatLorebook('Harbor Atlas');
        expect(host.chatMetadata).toEqual({ integrity: 'harbor-uuid' });
        expect(document.querySelectorAll('.chat_lorebook_button.world_set')).toHaveLength(0);
        expect(saveMetadata).toHaveBeenCalledTimes(1);
    });

    it('leaves a chat whose Chat Lorebook is another book as it is, saving nothing', async () => {
        host.chatMetadata = { world_info: 'Tide Tables' };
        drawChatLoreButtons();
        await removeChatLorebook('Harbor Atlas');
        expect(host.chatMetadata).toEqual({ world_info: 'Tide Tables' });
        expect(document.querySelectorAll('.chat_lorebook_button.world_set')).toHaveLength(2);
        expect(saveMetadata).not.toHaveBeenCalled();
    });
});
