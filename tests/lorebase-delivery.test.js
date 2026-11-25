/**
 * LoreBase's delivery through SillyTavern's World Info scan (src/features/lorebase/lorebase-delivery.js, plan §5.7 and
 * §6.8 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): the listener is made the last
 * once the app is ready, and again each time the interceptor holds, after any listener added since; a reply's picks go
 * to the next scan in the same chat, and only to it; every scan blanks the keys of the entries LoreBase decides in the
 * books locked here (D11); while LoreBase does not act, with VectFox or its switch off or Vector Storage's World Info
 * search on (§5.9), the scan is left alone; and the tester's dry scan as SillyTavern alone (§5.10) is left alone too,
 * but never while a generation's scan is due, and never counted when an interceptor held during it. And the books added
 * to the chat through LoreBase's Add to this chat (L1 of InternalProject/Vectfox/plans/entity-lore.md): added to every
 * scan as chat lore before it is armed, only while LoreBase acts, each once, a book SillyTavern lacks or cannot load
 * skipped and said.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oneSelectionRecord } from './lorebase-book-record.js';

const host = vi.hoisted(() => ({
    listeners: {},
    addedListeners: {},
    readyListeners: [],
    chatId: 'chat-harbor',
    context: null,
    settings: { vectfox: {} },
    isWorldInfoSearchOn: false,
    worldNames: [],
    books: {},
}));

vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: () => host.context,
    getCurrentChatId: () => host.chatId,
}));
vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: {
        on: vi.fn((event, listener) => { (host.addedListeners[event] ??= []).push(listener); }),
        once: vi.fn((event, listener) => { if (event === 'app_ready') host.readyListeners.push(listener); }),
        makeLast: vi.fn((event, listener) => { host.listeners[event] = listener; }),
        emit: vi.fn(async () => {}),
    },
    event_types: { APP_READY: 'app_ready', WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate' },
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getCharaFilename: () => 'keeper-orrin' }));
vi.mock('../src/sillytavern/world-info.js', () => ({
    METADATA_KEY: 'world_info', getWorldInfoSettings: () => ({ world_info: { charLore: [] } }), characterLorebooks: () => [], selected_world_info: [],
    world_names: host.worldNames,
    // SillyTavern hands out its cached book; a book set to an Error fails to load.
    loadWorldInfo: vi.fn(async bookName => {
        if (host.books[bookName] instanceof Error) throw host.books[bookName];
        return host.books[bookName] ?? null;
    }),
}));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/vector-storage.js', () => ({ isVectorStorageWorldInfoOn: () => host.isWorldInfoSearchOn }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));

const { eventSource } = await import('../src/sillytavern/events.js');
const { log } = await import('../src/sillytavern/log.js');
const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
const { holdLoreForNextScan, initializeLoreBaseDelivery, loreBasePicksCarriedBy, scanLeftToSillyTavern } = await import('../src/features/lorebase/lorebase-delivery.js');

initializeLoreBaseDelivery();

const passage = text => ({ section: '(intro)', text, tokens: 5 });
const lighthousePick = sentParts => ({
    bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', uses: 'some', frame: null,
    passages: [passage('The lighthouse stands on the north cliff.'), passage('Its keeper is Orrin.')], sentParts,
});
// The pick sending its first part, as the scan forces it: inside LoreBase's block, in a tag named by its title.
const lighthouseBlock = {
    uid: 0, world: 'Harbor Atlas', key: ['lighthouse'], group: '', useProbability: false,
    content: '<VectLorebook>\n<Lighthouse_of_Vell>\nThe lighthouse stands on the north cliff.\n</Lighthouse_of_Vell>\n</VectLorebook>',
};
const loadedScan = () => ({
    globalLore: [
        { uid: 0, world: 'Harbor Atlas', key: ['lighthouse'], content: 'The lighthouse stands on the north cliff.\nIts keeper is Orrin.' },
        { uid: 1, world: 'Harbor Atlas', key: ['tidewarden'], content: 'The tidewardens read the harbor bells.' },
        { uid: 2, world: 'Harbor Atlas', key: ['bell'], content: 'Left to its keys.' },
    ],
    characterLore: [{ uid: 7, world: 'Keeper Notes', key: ['lamp'], content: 'The lamp is never left dark.' }],
    chatLore: [],
    personaLore: [],
});
const scan = async (loaded = loadedScan()) => {
    await host.listeners.worldinfo_entries_loaded(loaded);
    return loaded;
};
const forcedActivations = () => eventSource.emit.mock.calls.filter(([event]) => event === 'worldinfo_force_activate').map(([, forced]) => forced);
const keysOf = loaded => [...loaded.globalLore, ...loaded.characterLore].map(entry => entry.key);

beforeEach(() => {
    vi.clearAllMocks();
    host.chatId = 'chat-harbor';
    host.context = { characters: { 3: { name: 'Keeper Orrin', avatar: 'keeper-orrin.png' } }, characterId: '3' };
    host.isWorldInfoSearchOn = false;
    host.settings.vectfox = {
        enabled: true,
        lorebase_enabled: true,
        vector_backend: 'qdrant',
        lorebase_books: {
            'Harbor Atlas': oneSelectionRecord({ selectedUids: ['0', '1'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] }),
            'Keeper Notes': oneSelectionRecord({ selectedUids: ['7'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] }),
        },
    };
    holdLoreForNextScan(null);
});

describe('the scan listener', () => {
    it('is made the last to run once the app is ready, after the listeners extensions added as they loaded', () => {
        expect(host.readyListeners).toHaveLength(1);
        // The hold before each test came before the app was ready, which arms nothing.
        expect(eventSource.makeLast).not.toHaveBeenCalled();
        host.readyListeners[0]();
        expect(eventSource.makeLast).toHaveBeenCalledWith('worldinfo_entries_loaded', expect.any(Function));
    });

    it('is made the last again each time the interceptor holds, after a listener added since, such as a TavernHelper script', () => {
        const listener = host.listeners.worldinfo_entries_loaded;
        eventSource.makeLast.mockClear();
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        holdLoreForNextScan(null);
        expect(eventSource.makeLast.mock.calls).toEqual([['worldinfo_entries_loaded', listener], ['worldinfo_entries_loaded', listener]]);
    });
});

describe('a reply and the scan that follows (§5.7)', () => {
    it('blanks the keys of every entry LoreBase decides in the books locked here, and forces the pick with the parts kept, in its block', async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        const loaded = await scan();

        expect(keysOf(loaded)).toEqual([[], [], ['bell'], []]);
        expect(forcedActivations()).toEqual([[lighthouseBlock]]);
    });

    it("says which picks the entry carrying the scan's block holds, and none for another entry or after the next scan", async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        await scan();

        expect(loreBasePicksCarriedBy({ world: 'Harbor Atlas', uid: 0 })).toEqual([{ bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', isWhole: false, jevChance: null }]);
        expect(loreBasePicksCarriedBy({ world: 'Harbor Atlas', uid: 2 })).toBeNull();
        await scan();
        expect(loreBasePicksCarriedBy({ world: 'Harbor Atlas', uid: 0 })).toBeNull();
    });

    it('gives the picks to that scan alone: the next one blanks the same keys and forces nothing', async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1, 2])] });
        await scan();
        const next = await scan();

        expect(forcedActivations()).toHaveLength(1);
        expect(keysOf(next)).toEqual([[], [], ['bell'], []]);
    });

    it('holds nothing for a generation with no pick, so its scan sends no selected entry', async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        holdLoreForNextScan(null);
        const loaded = await scan();

        expect(forcedActivations()).toEqual([]);
        expect(keysOf(loaded)).toEqual([[], [], ['bell'], []]);
    });

    it('forces nothing for a pick whose review kept no part', async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([])] });
        await scan();
        expect(forcedActivations()).toEqual([]);
    });

    it("drops the picks when the chat changed before the scan, as that scan loads another chat's books", async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        host.chatId = 'chat-other';
        const loaded = await scan();

        expect(forcedActivations()).toEqual([]);
        // Not locked to this chat, Harbor Atlas is SillyTavern's here; Keeper Notes is locked to the character.
        expect(keysOf(loaded)).toEqual([['lighthouse'], ['tidewarden'], ['bell'], []]);
    });
});

describe('where LoreBase leaves the scan alone', () => {
    it('leaves every key and forces nothing while VectFox is off, and drops the picks held', async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        host.settings.vectfox.enabled = false;
        const loaded = await scan();
        expect(keysOf(loaded)).toEqual([['lighthouse'], ['tidewarden'], ['bell'], ['lamp']]);

        host.settings.vectfox.enabled = true;
        await scan();
        expect(forcedActivations()).toEqual([]);
    });

    it('leaves every key and forces nothing while LoreBase is off, its selections kept', async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        host.settings.vectfox.lorebase_enabled = false;
        const loaded = await scan();
        expect(keysOf(loaded)).toEqual([['lighthouse'], ['tidewarden'], ['bell'], ['lamp']]);
        expect(forcedActivations()).toEqual([]);
        expect(host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].selectedUids).toEqual(['0', '1']);
    });

    it("leaves every key and forces nothing while Vector Storage's World Info search is on, as LoreBase sits out", async () => {
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        host.isWorldInfoSearchOn = true;
        const loaded = await scan();
        expect(keysOf(loaded)).toEqual([['lighthouse'], ['tidewarden'], ['bell'], ['lamp']]);
        expect(forcedActivations()).toEqual([]);
    });

    it('leaves the books locked nowhere here to their keys', async () => {
        host.settings.vectfox.lorebase_books['Keeper Notes'].selections[0].lockedToCharacterAvatars = ['someone-else.png'];
        host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].lockedToChatIds = [];
        const loaded = await scan();
        expect(keysOf(loaded)).toEqual([['lighthouse'], ['tidewarden'], ['bell'], ['lamp']]);
    });

    it("blanks the keys of a book's selection in use here alone, the chat's lock before the character's, and leaves a book with none in use to its keys", async () => {
        const { 'Harbor Atlas': harbor, 'Keeper Notes': keeper } = host.settings.vectfox.lorebase_books;
        Object.assign(harbor.selections[0], { lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        harbor.selections.push({ id: 'night', name: 'Night watch', selectedUids: ['1'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] });
        keeper.selections[0].lockedToCharacterAvatars = [];
        keeper.selections.push({ id: 'elsewhere', name: 'Elsewhere', selectedUids: ['7'], pinnedSections: [], lockedToChatIds: ['chat-other'], lockedToCharacterAvatars: [] });
        const loaded = await scan();
        expect(keysOf(loaded)).toEqual([['lighthouse'], [], ['bell'], ['lamp']]);
    });
});

describe("the tester's scan as SillyTavern alone (§5.10)", () => {
    it('leaves that scan unarmed, every key kept and nothing forced, once the scan due since the last hold went', async () => {
        await scan();
        eventSource.emit.mockClear();
        const loaded = await scanLeftToSillyTavern(() => scan());
        expect(keysOf(loaded)).toEqual([['lighthouse'], ['tidewarden'], ['bell'], ['lamp']]);
        expect(forcedActivations()).toEqual([]);
    });

    it("runs nothing while a generation's scan is due, from the interceptor's hold to that scan", async () => {
        const run = vi.fn(() => scan());
        expect(await scanLeftToSillyTavern(run)).toBeNull();
        expect(run).not.toHaveBeenCalled();
        holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
        expect(await scanLeftToSillyTavern(run)).toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it('counts for nothing when an interceptor holds during it, and arms every scan after that hold', async () => {
        await scan();
        eventSource.emit.mockClear();
        const result = await scanLeftToSillyTavern(async () => {
            holdLoreForNextScan({ reviewedPicks: [lighthousePick([1])] });
            return scan();
        });
        expect(result).toBeNull();
        expect(forcedActivations()).toEqual([[lighthouseBlock]]);
    });

    it('runs one at a time', async () => {
        await scan();
        const inner = vi.fn();
        let innerResult;
        await scanLeftToSillyTavern(async () => { innerResult = await scanLeftToSillyTavern(inner); });
        expect(innerResult).toBeNull();
        expect(inner).not.toHaveBeenCalled();
    });
});

describe("the books added to the chat through LoreBase's Add to this chat (L1 of entity-lore.md)", () => {
    const CORAL_INDEX = {
        entries: {
            4: { uid: 4, key: ['reef'], content: 'The reef breaks at low tide.' },
            9: { uid: 9, key: ['coral'], content: 'Coral grows slowly.' },
        },
    };
    const addedTo = (...bookNames) => { host.context.chatMetadata = { vectfox_chat_lorebooks: bookNames }; };
    // As SillyTavern runs the listeners: those added as the extensions loaded, the added books' first, then the arming,
    // which is made the last.
    const loadAdded = async (loaded) => {
        for (const listener of host.addedListeners.worldinfo_entries_loaded) await listener(loaded);
        return loaded;
    };
    const fullScan = async (loaded = loadedScan()) => scan(await loadAdded(loaded));

    beforeEach(() => {
        host.worldNames.splice(0, host.worldNames.length, 'Harbor Atlas', 'Keeper Notes', 'Coral Index', 'Tide Tables');
        host.books = { 'Coral Index': CORAL_INDEX, 'Tide Tables': { entries: { 1: { uid: 1, key: ['tide'], content: 'High tide at noon.' } } } };
        host.settings.vectfox.lorebase_books['Coral Index'] = oneSelectionRecord({
            selectedUids: ['4'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [],
        });
    });

    it('is added as the extensions load, before the scan is armed, which is made the last once the app is ready', () => {
        expect(host.addedListeners.worldinfo_entries_loaded).toHaveLength(1);
        expect(host.addedListeners.worldinfo_entries_loaded[0]).not.toBe(host.listeners.worldinfo_entries_loaded);
    });

    it("adds each book to the scan's chat lore, as SillyTavern adds its Chat Lorebook, and LoreBase then decides their selected entries", async () => {
        addedTo('Coral Index', 'Tide Tables');
        const loaded = await fullScan();
        expect(loaded.chatLore.map(entry => [entry.world, entry.uid, entry.key])).toEqual([
            // Selected and locked here, so LoreBase decides it: its keys go.
            ['Coral Index', 4, []],
            ['Coral Index', 9, ['coral']],
            ['Tide Tables', 1, ['tide']],
        ]);
        expect(CORAL_INDEX.entries[4].key).toEqual(['reef']);
        expect(keysOf(loaded)).toEqual([[], [], ['bell'], []]);
    });

    it("adds nothing while LoreBase does not act: VectFox off, LoreBase's switch off, or Vector Storage's World Info search on (D12)", async () => {
        addedTo('Coral Index');
        host.settings.vectfox.enabled = false;
        expect((await loadAdded(loadedScan())).chatLore).toEqual([]);
        host.settings.vectfox.enabled = true;
        host.settings.vectfox.lorebase_enabled = false;
        expect((await loadAdded(loadedScan())).chatLore).toEqual([]);
        host.settings.vectfox.lorebase_enabled = true;
        host.isWorldInfoSearchOn = true;
        expect((await loadAdded(loadedScan())).chatLore).toEqual([]);
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    it("adds no book a list of SillyTavern's loaded already, so it is scanned once, as SillyTavern's", async () => {
        addedTo('Harbor Atlas', 'Keeper Notes');
        const loaded = await loadAdded(loadedScan());
        expect(loaded.chatLore).toEqual([]);
        expect(loaded.globalLore).toHaveLength(3);
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    it('adds nothing for a chat with no added books, nor for one whose field holds no book names', async () => {
        expect((await loadAdded(loadedScan())).chatLore).toEqual([]);
        host.context.chatMetadata = { vectfox_chat_lorebooks: 'Coral Index' };
        expect((await loadAdded(loadedScan())).chatLore).toEqual([]);
        host.context.chatMetadata = { vectfox_chat_lorebooks: [null, 7, ''] };
        expect((await loadAdded(loadedScan())).chatLore).toEqual([]);
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    it('skips a book SillyTavern no longer has, saying so once, and a book that fails to load, saying why, and adds the rest', async () => {
        const failure = new Error('The server is down.');
        host.books['Tide Tables'] = failure;
        addedTo('Lost Charts', 'Tide Tables', 'Coral Index');
        const loaded = await loadAdded(loadedScan());
        expect(loaded.chatLore.map(entry => [entry.world, entry.uid])).toEqual([['Coral Index', 4], ['Coral Index', 9]]);
        expect(log.warn.mock.calls).toEqual([
            ['LoreBase: lorebook "Lost Charts" was added to this chat, but SillyTavern no longer has it, so it sends nothing. Unlink it on the WorldInfo page.'],
            ['LoreBase: lorebook "Tide Tables", added to this chat, could not be loaded, so this scan sends none of it:', failure],
        ]);
        await loadAdded(loadedScan());
        expect(log.warn.mock.calls.filter(([message]) => message.includes('Lost Charts'))).toHaveLength(1);
    });
});
