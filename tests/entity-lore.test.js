/**
 * Entity-Lore's run (src/features/entity-lore/entity-lore.js, plan §4, §5, §6 and §7 of
 * InternalProject/Vectfox/plans/entity-lore.md), with StoryArc's entity rules and Entity-Lore's own rules and prompts as
 * they are, and SillyTavern, the collection's metadata, EventBase's reads and LoreBase's steps mocked as they behave.
 *
 * Guards that:
 *   - an EventBase run that added events to the open chat's collection in use starts a run, while Entity-Lore,
 *     StoryArc and LoreBase are on; any other starts none, and one ending during a run starts one more after it,
 *   - the name check is asked about every name due and nothing excluded, and its answers go in the record: a name
 *     that is another candidate's keys that candidate's entry and adds its events to it,
 *   - the first entry makes the chat's book and adds it to the chat, the entry joins the selection in use there, the
 *     record keeps its uid, count and hash, and LoreBase then writes that book's keys and vectors alone,
 *   - after an EventBase run at most 5 entries are written, most events first; Run now writes every one once the user
 *     says yes to how many,
 *   - an entry due again is written from the entry as it stands, keeping its keys, and its LoreBase keys written anew;
 *     one the user edited or deleted is left alone; a book gone starts the record over,
 *   - a failed call leaves its character due and is counted; a model the provider refuses raises the sticky popup and
 *     stops the run; a chat opened during the run gets no book,
 *   - a long arc is written from the notes on each slice, and the book is saved one entry at a time,
 *   - the card reads each character's state as a run does, saving nothing; a row's button writes one due character's
 *     entry after the name check on that name, or a written one again, an edited one from the entry as the user left
 *     it; Allow again forgets a name, refused during a run; each run's end is told, and the last outcome kept.
 *
 * Names are made up and match no story.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {}, chatId: '', worldNames: [], books: {}, collectionMeta: {}, events: [], merges: {}, chatBooks: [], characters: [],
    selections: {}, chatChangeHandlers: new Set(), isYes: true, isLoreBaseWriting: false, inUseCollectionId: '', ask: null,
}));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({ name1: 'Wren' }), getCurrentChatId: () => host.chatId }));
vi.mock('../src/sillytavern/events.js', () => ({
    event_types: { CHAT_CHANGED: 'chat_id_changed' },
    eventSource: { on: vi.fn((_name, handler) => host.chatChangeHandlers.add(handler)), removeListener: vi.fn((_name, handler) => host.chatChangeHandlers.delete(handler)) },
}));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(async () => host.isYes) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { get vectfox() { return host.settings; } } }));
// SillyTavern's lorebooks, as src/sillytavern/world-info.js hands them out: a copy of each book.
vi.mock('../src/sillytavern/world-info.js', () => ({
    get world_names() { return host.worldNames; },
    loadWorldInfo: vi.fn(async bookName => (host.books[bookName] ? structuredClone(host.books[bookName]) : null)),
    createLorebook: vi.fn(async (bookName) => {
        host.worldNames.push(bookName);
        host.books[bookName] = { entries: {} };
        return bookName;
    }),
    createLorebookEntry: vi.fn(async (bookName, { comment, keys, content }) => {
        const { entries } = host.books[bookName];
        let uid = 0;
        while (uid in entries) uid += 1;
        entries[uid] = { uid, comment, key: [...keys], content };
        return String(uid);
    }),
    saveLorebookEntry: vi.fn(async (bookName, uid, { comment, content, keys }) => {
        Object.assign(host.books[bookName].entries[uid], { comment, content }, keys ? { key: [...keys] } : {});
    }),
}));
vi.mock('../src/shared/chat-messages.js', () => ({ chatMessages: () => [] }));
vi.mock('../src/shared/progress-tracker.js', () => ({
    progressTracker: { show: vi.fn(), setCancelHandler: vi.fn(), updateCurrentItem: vi.fn(), updateProgress: vi.fn(), addError: vi.fn(), complete: vi.fn(), reopen: vi.fn() },
}));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isInvalidModelConfigError: error => error?.code === 'invalid_model_config',
    notifyInvalidModel: vi.fn(),
}));
vi.mock('../src/features/collections/index.js', () => ({
    getCollectionMeta: vi.fn(key => structuredClone(host.collectionMeta[key] ?? {})),
    setCollectionMeta: vi.fn((key, data) => { host.collectionMeta[key] = { ...(host.collectionMeta[key] ?? {}), ...structuredClone(data) }; }),
}));
vi.mock('../src/features/eventbase/index.js', async () => {
    const entities = await import('../src/features/eventbase/story-arc-entity-core.js');
    return {
        buildEntityNameWriter: entities.buildEntityNameWriter,
        eventsNamingEntity: entities.eventsNamingEntity,
        holdsName: entities.holdsName,
        listEntities: entities.listEntities,
        withKeptEntityNames: entities.withKeptEntityNames,
        chineseScriptNameOf: () => null,
        readStoryLanguage: () => ({ promptMode: 'others', isCjkStory: false, chineseScript: null }),
        collectionInUse: () => ({
            collection: host.inUseCollectionId ? { collectionId: host.inUseCollectionId, registryKey: `qdrant:${host.inUseCollectionId}` } : null,
        }),
        isStoryArcActive: settings => settings.story_arc_mode_enabled === true,
        readChatStoryEvents: vi.fn(async () => ({ collectionId: 'harbor-collection', registryKey: 'qdrant:harbor-collection', name: 'Harbor', events: host.events })),
        readEntityMerges: () => host.merges,
        inTimelineOrder: events => [...events].sort((a, b) => a.timeline_sort_key - b.timeline_sort_key),
        formatStoryLine: event => `- #${event.timeline_sort_key}: ${event.text} (when: Day ${event.timeline_sort_key})`,
    };
});
vi.mock('../src/features/llm-provider/index.js', () => ({
    parseJsonArrayFromLlm: raw => JSON.parse(raw).names,
}));
vi.mock('../src/features/lorebase/index.js', () => ({
    ADD_TO_CHAT: 'chat',
    BOTH_KINDS: ['keys', 'vectors'],
    THINKING_TOKEN_ALLOWANCE: 8000,
    // Add to this chat: the chat's list, and the book's first selection locked to the chat.
    addLoreBookToChat: vi.fn(async (bookName) => {
        host.chatBooks.push(bookName);
        host.selections[bookName] ??= { id: 'selection-1', selectedUids: [] };
        return { chatId: host.chatId };
    }),
    askTextOnLoreBase: vi.fn(() => (...args) => host.ask(...args)),
    chatBookNames: () => [...host.chatBooks],
    chatCharacters: () => host.characters,
    ensureLoreSelection: vi.fn(bookName => (host.selections[bookName] ??= { id: 'selection-1', selectedUids: [] })),
    // A character is a token here, so a test makes a long arc with long events.
    estimatedTokens: text => text.length,
    isLoreBaseSwitchedOn: settings => settings.lorebase_enabled === true,
    isLoreBaseWriting: () => host.isLoreBaseWriting,
    loreBaseInactiveReason: settings => (settings.lorebase_enabled ? null : 'Use LoreBase is off.'),
    regenerateKeysOfEntries: vi.fn(async () => ({})),
    resolveLoreBaseLlmConfig: () => ({ ok: true }),
    saveEntryWithVectors: vi.fn(async (bookName, uid, { comment, content, keys }) => {
        Object.assign(host.books[bookName].entries[uid], { comment, content, key: [...keys] });
        return { isDecided: true, failure: null, vectorProblem: null };
    }),
    selectionInUse: vi.fn(bookName => host.selections[bookName] ?? null),
    setLoreBookSelection: vi.fn((bookName, _id, uids) => { host.selections[bookName].selectedUids = [...uids].map(String); }),
    setLoreSelectionLock: vi.fn(),
    writeMissing: vi.fn(async () => ({})),
}));

const { createLorebook, createLorebookEntry, saveLorebookEntry } = await import('../src/sillytavern/world-info.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { progressTracker } = await import('../src/shared/progress-tracker.js');
const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
const { log } = await import('../src/sillytavern/log.js');
const { readChatStoryEvents } = await import('../src/features/eventbase/index.js');
const { addLoreBookToChat, regenerateKeysOfEntries, saveEntryWithVectors, writeMissing } = await import('../src/features/lorebase/index.js');
const {
    allowEntityLoreAgain, lastEntityLoreRun, onEntityLoreRunEnded, onEventBaseRunEnded, readEntityLoreCharacters, runEntityLoreNow, writeEntityLoreEntryNow,
} = await import('../src/features/entity-lore/index.js');
const { entryContentHash } = await import('../src/features/entity-lore/entity-lore-core.js');

const CHAT_ID = 'Harbor Tales - 2026-01-01';
const BOOK = `VectFox NPCs - ${CHAT_ID}`;
const REGISTRY_KEY = 'qdrant:harbor-collection';
const record = () => host.collectionMeta[REGISTRY_KEY]?.entityLore;

let timeline = 0;
// Events tagging people, oldest first.
const eventsNaming = (name, count, text = `${name} works the harbor.`) => Array.from({ length: count }, () => {
    timeline += 1;
    return { characters: [name], text, timeline_sort_key: timeline };
});
const entryAbout = name => `[Identity]\n${name} is a made-up harbor hand.\n[Personality]\nPatient.\n[History]\nGrew up by the docks.\n[Key events]\n- Day 1: arrived.\n[Relationships]\n- Wren: a friend.`;
const isCheck = messages => messages[0].content.includes('sort the names');
const isNotes = messages => messages[0].content.includes('take notes');
const entryNameOf = messages => /Write one lorebook entry about (.+?), a character/u.exec(messages[1].content)?.[1];
// The model: the check answers as `checkAnswers` says, every other name named; an entry, or notes, for each call.
const answering = (checkAnswers = {}) => vi.fn(async (messages) => {
    if (isCheck(messages)) {
        const names = [...messages[1].content.matchAll(/^\d+\. (.+?): \d+ events?\./gmu)].map(match => match[1]);
        return JSON.stringify({ names: names.map(name => ({ name, answer: 'named', ...checkAnswers[name] })) });
    }
    if (isNotes(messages)) return 'Day 1: arrived at the harbor.';
    return entryAbout(entryNameOf(messages));
});
const settle = async () => {
    for (let turn = 0; turn < 30; turn += 1) await new Promise(resolve => { setTimeout(resolve, 0); });
};
const runAfterEventBase = async (eventsAdded = 3, collectionId = 'harbor-collection') => {
    onEventBaseRunEnded({ collectionId, eventsAdded, windowsProcessed: 1 });
    await settle();
};
const checkedNames = () => {
    const check = host.ask.mock.calls.find(([messages]) => isCheck(messages));
    return check ? [...check[0][1].content.matchAll(/^\d+\. (.+?): /gmu)].map(match => match[1]) : null;
};

beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(host, {
        settings: { entity_lore_enabled: true, story_arc_mode_enabled: true, lorebase_enabled: true, vector_backend: 'qdrant' },
        chatId: CHAT_ID, worldNames: ['Harbor Atlas'], books: { 'Harbor Atlas': { entries: { 0: { uid: 0, comment: 'Captain Brannoc', key: ['Brannoc'], content: 'A captain.' } } } },
        collectionMeta: {}, events: [], merges: {}, chatBooks: ['Harbor Atlas'], selections: {}, isYes: true, isLoreBaseWriting: false,
        inUseCollectionId: 'harbor-collection', ask: answering(),
        characters: [{ name: 'Keeper Orrin', description: 'Keeper Orrin keeps the lighthouse with his cat, Biscuit.' }],
    });
    host.chatChangeHandlers.clear();
});

describe('when a run starts (§4.1)', () => {
    it('writes nothing after an EventBase run that added no events, or another collection\'s, or while Entity-Lore, StoryArc or LoreBase is off', async () => {
        host.events = eventsNaming('Tamsin', 12);
        await runAfterEventBase(0);
        await runAfterEventBase(3, 'other-collection');
        for (const off of ['entity_lore_enabled', 'story_arc_mode_enabled', 'lorebase_enabled']) {
            host.settings = { ...host.settings, entity_lore_enabled: true, story_arc_mode_enabled: true, lorebase_enabled: true, [off]: false };
            await runAfterEventBase();
        }
        expect(readChatStoryEvents).not.toHaveBeenCalled();
        expect(host.ask).not.toHaveBeenCalled();
    });

    it('runs once more when an EventBase run ends during a run', async () => {
        host.events = eventsNaming('Tamsin', 12);
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (isCheck(messages)) await held;
            return model(messages);
        });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 2 });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 1 });
        release();
        await settle();
        expect(readChatStoryEvents).toHaveBeenCalledTimes(2);
        expect(createLorebookEntry).toHaveBeenCalledTimes(1);
    });
});

describe('a run (§4.2 to §4.6)', () => {
    it("checks every name due, then writes the named one's entry from its events and its other name's, in the chat's new book", async () => {
        host.events = [...eventsNaming('Tamsin', 12), ...eventsNaming('Tamsin Vale', 10, 'Tamsin Vale signs the ledger.'), ...eventsNaming('the ferryman', 10)];
        host.ask = answering({ 'Tamsin Vale': { answer: 'same_as', same_as: 'Tamsin' }, 'the ferryman': { answer: 'not_named' } });
        await runAfterEventBase();

        expect(checkedNames()).toEqual(['Tamsin', 'Tamsin Vale', 'the ferryman']);
        expect(createLorebook).toHaveBeenCalledWith(BOOK);
        expect(addLoreBookToChat).toHaveBeenCalledWith(BOOK, 'chat');
        const entryCall = host.ask.mock.calls.find(([messages]) => entryNameOf(messages) === 'Tamsin')[0][1].content;
        expect(entryCall).toContain('Tamsin, a character in this story, also called Tamsin Vale.');
        expect(entryCall.match(/^- #\d+: /gmu)).toHaveLength(22);
        expect(entryCall).toContain('Tamsin Vale signs the ledger.');
        expect(host.books[BOOK].entries[0]).toEqual({ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Tamsin Vale'], content: entryAbout('Tamsin') });
        expect(host.selections[BOOK].selectedUids).toEqual(['0']);
        expect(record()).toEqual({
            bookName: BOOK,
            entries: {
                'Tamsin Vale': { state: 'same_as', sameAs: 'Tamsin' },
                'the ferryman': { state: 'not_named' },
                Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash(entryAbout('Tamsin')) },
            },
        });
        expect(writeMissing).toHaveBeenCalledWith(host.settings, ['keys', 'vectors'], { bookNames: [BOOK] });
        expect(progressTracker.show).toHaveBeenCalledWith('Entity-Lore', 4, 'Entries', { unitLabel: 'Entries' });
        expect(progressTracker.updateProgress).toHaveBeenLastCalledWith(4);
        expect(progressTracker.complete).toHaveBeenCalledWith(true, '1 entry written');
    });

    it("asks nothing about the chat's character, the persona, a name in a book the chat loads or in the card's description, or one below Write at", async () => {
        host.events = [
            ...eventsNaming('Keeper Orrin', 15), ...eventsNaming('Wren', 14), ...eventsNaming('Brannoc', 13), ...eventsNaming('Biscuit', 12),
            ...eventsNaming('Hollis', 9), ...eventsNaming('Tamsin', 10),
        ];
        await runAfterEventBase();
        expect(checkedNames()).toEqual(['Tamsin']);
    });

    it('writes at most 5 after an EventBase run, most events first', async () => {
        host.events = ['Ash', 'Bryn', 'Cole', 'Dara', 'Esme', 'Finn', 'Gale'].flatMap((name, index) => eventsNaming(name, 10 + index));
        await runAfterEventBase();
        expect(createLorebookEntry.mock.calls.map(([, fields]) => fields.comment).sort()).toEqual(['Cole', 'Dara', 'Esme', 'Finn', 'Gale']);
    });

    it('writes an entry again at Rewrite every from the entry as it stands, its keys kept, then writes its LoreBase keys anew', async () => {
        host.events = eventsNaming('Tamsin', 40);
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries: { 3: { uid: 3, comment: 'Tamsin', key: ['Tamsin', 'the salt trader'], content: 'Tamsin trades salt.' } } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: { state: 'written', uid: '3', writtenAtEvents: 10, contentHash: entryContentHash('Tamsin trades salt.') } } } };
        await runAfterEventBase();

        expect(checkedNames()).toBeNull();
        const prompt = host.ask.mock.calls[0][0][1].content;
        expect(prompt).toContain("Tamsin's entry as it stands:\n\nTamsin trades salt.");
        expect(saveEntryWithVectors).toHaveBeenCalledWith(BOOK, '3', { comment: 'Tamsin', content: entryAbout('Tamsin'), keys: ['Tamsin', 'the salt trader'] }, host.settings);
        expect(record().entries.Tamsin).toMatchObject({ state: 'written', uid: '3', writtenAtEvents: 40, contentHash: entryContentHash(entryAbout('Tamsin')) });
        expect(regenerateKeysOfEntries).toHaveBeenCalledWith(BOOK, [expect.objectContaining({ uid: 3 })], host.settings);
        expect(progressTracker.complete).toHaveBeenCalledWith(true, '0 entries written, 1 rewritten');
    });

    it('leaves an entry the user edited, and one they deleted, as they are', async () => {
        host.events = [...eventsNaming('Tamsin', 40), ...eventsNaming('Hollis', 40)];
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries: { 3: { uid: 3, comment: 'Tamsin', key: ['Tamsin'], content: 'Tamsin trades salt, and the user wrote this.' } } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: {
            Tamsin: { state: 'written', uid: '3', writtenAtEvents: 10, contentHash: entryContentHash('Tamsin trades salt.') },
            Hollis: { state: 'written', uid: '7', writtenAtEvents: 10, contentHash: entryContentHash('Hollis sells maps.') },
        } } };
        await runAfterEventBase();
        expect(host.ask).not.toHaveBeenCalled();
        expect(record().entries.Hollis.state).toBe('deleted');
        expect(record().entries.Tamsin.writtenAtEvents).toBe(10);
    });

    it('starts over when its book is gone: a new book, and the entry written again', async () => {
        host.events = eventsNaming('Tamsin', 12);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: 'Deleted Book', entries: {
            Tamsin: { state: 'written', uid: '0', writtenAtEvents: 10, contentHash: 'old' },
            'the ferryman': { state: 'not_named' },
        } } };
        await runAfterEventBase();
        expect(createLorebook).toHaveBeenCalledWith(BOOK);
        expect(record().bookName).toBe(BOOK);
        expect(record().entries.Tamsin).toMatchObject({ state: 'written', uid: '0', writtenAtEvents: 12 });
        expect(record().entries['the ferryman']).toEqual({ state: 'not_named' });
    });

    it("adds a name the check matched to an entry already written to that entry's keys", async () => {
        host.events = [...eventsNaming('Tamsin', 12), ...eventsNaming('Tam', 10)];
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries: { 0: { uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: 'Tamsin trades salt.' } } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash('Tamsin trades salt.') } } } };
        host.ask = answering({ Tam: { answer: 'same_as', same_as: 'Tamsin' } });
        await runAfterEventBase();
        expect(saveLorebookEntry).toHaveBeenCalledWith(BOOK, '0', { comment: 'Tamsin', content: 'Tamsin trades salt.', keys: ['Tamsin', 'Tam'] });
        expect(record().entries.Tam).toEqual({ state: 'same_as', sameAs: 'Tamsin' });
        expect(createLorebookEntry).not.toHaveBeenCalled();
    });

    it('writes a long arc from the notes on each slice', async () => {
        host.events = eventsNaming('Tamsin', 12, `Tamsin works the harbor. ${'The tide turns. '.repeat(200)}`);
        await runAfterEventBase();
        const notesCalls = host.ask.mock.calls.filter(([messages]) => isNotes(messages));
        expect(notesCalls.length).toBeGreaterThan(1);
        expect(notesCalls[0][0][1].content).toMatch(/^Part 1 of \d+ of the story's events naming Tamsin/u);
        const entryCall = host.ask.mock.calls.find(([messages]) => entryNameOf(messages) === 'Tamsin')[0][1].content;
        expect(entryCall).toMatch(/^Notes on the story's events that matter to Tamsin, oldest first:/u);
        expect(createLorebookEntry).toHaveBeenCalledTimes(1);
    });

    it('saves the book one entry at a time, as each save writes a loaded copy of the whole book', async () => {
        host.events = ['Ash', 'Bryn', 'Cole'].flatMap(name => eventsNaming(name, 12));
        let saving = 0;
        let mostAtOnce = 0;
        const asSillyTavernSaves = createLorebookEntry.getMockImplementation();
        createLorebookEntry.mockImplementation(async (bookName, { comment, keys, content }) => {
            saving += 1;
            mostAtOnce = Math.max(mostAtOnce, saving);
            await new Promise(resolve => { setTimeout(resolve, 5); });
            const { entries } = host.books[bookName];
            const uid = Object.keys(entries).length;
            entries[uid] = { uid, comment, key: keys, content };
            saving -= 1;
            return String(uid);
        });
        try {
            onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
            await vi.waitFor(() => expect(writeMissing).toHaveBeenCalled());
            expect(mostAtOnce).toBe(1);
            expect(Object.keys(host.books[BOOK].entries)).toHaveLength(3);
        } finally {
            createLorebookEntry.mockImplementation(asSillyTavernSaves);
        }
    });
});

describe('Run now (§4.1)', () => {
    it('asks how many it writes, then writes every one; no writes nothing', async () => {
        host.events = ['Ash', 'Bryn', 'Cole', 'Dara', 'Esme', 'Finn', 'Gale'].flatMap((name, index) => eventsNaming(name, 10 + index));
        host.isYes = false;
        expect(await runEntityLoreNow()).toEqual({ problem: null });
        expect(confirmPopup.mock.calls[0][0][0].text).toBe("Write 7 entries? Each is one call on LoreBase's model, after one call that checks the names.");
        expect(host.ask).not.toHaveBeenCalled();

        host.isYes = true;
        await runEntityLoreNow();
        expect(createLorebookEntry).toHaveBeenCalledTimes(7);
    });

    it("says why it writes nothing: Entity-Lore off, or no entry due, asking nothing", async () => {
        host.events = eventsNaming('Tamsin', 4);
        expect(await runEntityLoreNow()).toEqual({ problem: 'No entry is due now.', isNothingDue: true });
        host.settings.entity_lore_enabled = false;
        expect(await runEntityLoreNow()).toEqual({ problem: 'Use Entity-Lore is off.' });
        host.settings = { ...host.settings, entity_lore_enabled: true, story_arc_mode_enabled: false };
        expect(await runEntityLoreNow()).toEqual({ problem: 'Turn on StoryArc mode first. Entity-Lore counts characters in its events.' });
        expect(confirmPopup).not.toHaveBeenCalled();
    });
});

describe("the card's rows (§3)", () => {
    const writtenBook = (entries) => {
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries };
        host.selections[BOOK] = { id: 'selection-1', selectedUids: Object.keys(entries) };
    };

    it("reads each character's state and the chat's book as a run reads them, saving nothing", async () => {
        host.events = [...eventsNaming('Tamsin', 12), ...eventsNaming('Hollis', 4), ...eventsNaming('Wren', 11)];
        const before = await readEntityLoreCharacters();
        expect(before).toEqual({
            chatId: CHAT_ID, bookName: BOOK, isBookMade: false, isBookInChat: false,
            states: [
                expect.objectContaining({ name: 'Tamsin', eventCount: 12, state: 'due' }),
                expect.objectContaining({ name: 'Wren', eventCount: 11, state: 'excluded', exclusion: 'persona' }),
                expect.objectContaining({ name: 'Hollis', eventCount: 4, state: 'waiting', writeAt: 10 }),
            ],
        });
        writtenBook({ 0: { uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: 'Tamsin trades salt.' } });
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash('Tamsin trades salt.') } } } };
        const { setCollectionMeta } = await import('../src/features/collections/index.js');
        setCollectionMeta.mockClear();
        expect(await readEntityLoreCharacters()).toMatchObject({ bookName: BOOK, isBookMade: true, isBookInChat: true, states: [{ name: 'Tamsin', state: 'written', writtenAtEvents: 12 }, {}, {}] });
        expect(setCollectionMeta).not.toHaveBeenCalled();
        expect(host.ask).not.toHaveBeenCalled();
    });

    it("writes one due character's entry now, after the name check on that name alone", async () => {
        host.events = [...eventsNaming('Tamsin', 12), ...eventsNaming('Ash', 15)];
        expect(await writeEntityLoreEntryNow('tamsin')).toEqual({ problem: null });
        expect(checkedNames()).toEqual(['Tamsin']);
        expect(createLorebookEntry.mock.calls.map(([, fields]) => fields.comment)).toEqual(['Tamsin']);
        expect(record().entries.Ash).toBeUndefined();
        expect(lastEntityLoreRun()).toEqual({ chatId: CHAT_ID, text: '1 entry written', isClean: true });
    });

    it('writes a written entry again now, before Rewrite every, and one the user edited from the entry as they left it', async () => {
        host.events = [...eventsNaming('Tamsin', 14), ...eventsNaming('Hollis', 12)];
        writtenBook({
            0: { uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: 'Tamsin trades salt.' },
            1: { uid: 1, comment: 'Hollis', key: ['Hollis'], content: 'Hollis sells maps, as the user wrote.' },
        });
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: {
            Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash('Tamsin trades salt.') },
            Hollis: { state: 'written', uid: '1', writtenAtEvents: 12, contentHash: entryContentHash('Hollis sells maps.') },
        } } };
        await writeEntityLoreEntryNow('Tamsin');
        expect(saveEntryWithVectors).toHaveBeenCalledWith(BOOK, '0', { comment: 'Tamsin', content: entryAbout('Tamsin'), keys: ['Tamsin'] }, host.settings);
        expect(record().entries.Tamsin.writtenAtEvents).toBe(14);

        saveEntryWithVectors.mockClear();
        await writeEntityLoreEntryNow('Hollis');
        expect(host.ask.mock.calls.at(-1)[0][1].content).toContain("Hollis's entry as it stands:\n\nHollis sells maps, as the user wrote.");
        expect(saveEntryWithVectors).toHaveBeenCalledWith(BOOK, '1', { comment: 'Hollis', content: entryAbout('Hollis'), keys: ['Hollis'] }, host.settings);
        expect(record().entries.Hollis).toMatchObject({ state: 'written', writtenAtEvents: 12, contentHash: entryContentHash(entryAbout('Hollis')) });
        expect(lastEntityLoreRun()).toEqual({ chatId: CHAT_ID, text: '0 entries written, 1 rewritten', isClean: true });
    });

    it('writes nothing for a name in no state a button writes, and says why while Entity-Lore cannot run', async () => {
        host.events = [...eventsNaming('Tamsin', 4), ...eventsNaming('Wren', 11)];
        expect(await writeEntityLoreEntryNow('Tamsin')).toEqual({ problem: null });
        expect(await writeEntityLoreEntryNow('Wren')).toEqual({ problem: null });
        expect(host.ask).not.toHaveBeenCalled();
        expect(progressTracker.show).not.toHaveBeenCalled();
        host.settings.lorebase_enabled = false;
        expect(await writeEntityLoreEntryNow('Tamsin')).toEqual({ problem: "Turn on Use LoreBase on the Main tab first. Entity-Lore's entries go through LoreBase." });
    });

    it('forgets a name on Allow again, so it is counted as new; refused while a run writes', async () => {
        host.events = eventsNaming('the ferryman', 12);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: '', entries: { 'The Ferryman': { state: 'not_named' }, Hollis: { state: 'deleted', uid: '4' } } } };
        expect(allowEntityLoreAgain('the ferryman')).toEqual({ problem: null });
        expect(record().entries).toEqual({ Hollis: { state: 'deleted', uid: '4' } });
        expect((await readEntityLoreCharacters()).states[0]).toMatchObject({ name: 'the ferryman', state: 'due' });

        let release;
        const held = new Promise((resolve) => { release = resolve; });
        host.ask = vi.fn(async () => { await held; return JSON.stringify({ names: [] }); });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 1 });
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());
        expect(allowEntityLoreAgain('Hollis')).toEqual({ problem: 'Entity-Lore is writing already; the progress panel shows it.' });
        release();
        await settle();
    });

    it("tells each run's end, whatever it wrote, and keeps the outcome of the last that tried an entry", async () => {
        const ended = vi.fn();
        onEntityLoreRunEnded(ended);
        host.events = eventsNaming('Tamsin', 4);
        const before = lastEntityLoreRun();
        await runAfterEventBase();
        expect(ended).toHaveBeenCalledTimes(1);
        expect(lastEntityLoreRun()).toBe(before);
    });
});

describe('failures (§7)', () => {
    it('leaves a character whose entry failed due, counts it and goes on with the others', async () => {
        host.events = [...eventsNaming('Ash', 12), ...eventsNaming('Bryn', 11)];
        const model = answering();
        host.ask = vi.fn(async messages => (entryNameOf(messages) === 'Ash' ? 'No entry here.' : model(messages)));
        await runAfterEventBase();
        expect(record().entries.Ash).toBeUndefined();
        expect(record().entries.Bryn.state).toBe('written');
        expect(log.warn).toHaveBeenCalledWith('[VectFox-EntityLore] Ash:', expect.objectContaining({ message: "its answer holds 0 of the entry's 5 section headings" }));
        expect(progressTracker.complete).toHaveBeenCalledWith(false, '1 entry written, 1 failed (see the console)');
    });

    it('raises the sticky popup for a model the provider refuses, and stops the run', async () => {
        host.events = eventsNaming('Tamsin', 12);
        host.ask = vi.fn(async () => { throw Object.assign(new Error('The provider refuses the model.'), { code: 'invalid_model_config' }); });
        await runAfterEventBase();
        expect(notifyInvalidModel).toHaveBeenCalledWith('The provider refuses the model.');
        expect(host.ask).toHaveBeenCalledTimes(1);
        expect(createLorebook).not.toHaveBeenCalled();
    });

    it('makes no book while another chat is open, so the entry stays due', async () => {
        host.events = eventsNaming('Tamsin', 12);
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (entryNameOf(messages)) {
                host.chatId = 'Another Chat - 2026-02-02';
                for (const handler of host.chatChangeHandlers) handler();
            }
            return model(messages);
        });
        await runAfterEventBase();
        expect(createLorebook).not.toHaveBeenCalled();
        expect(createLorebookEntry).not.toHaveBeenCalled();
        expect(record()?.entries?.Tamsin).toBeUndefined();
    });

    it("writes into the run's book once another chat is open, but leaves its LoreBase keys, which lock to the open chat, to the next run", async () => {
        host.events = eventsNaming('Tamsin', 12);
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries: {} };
        host.selections[BOOK] = { id: 'selection-1', selectedUids: [] };
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: {} } };
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (entryNameOf(messages)) host.chatId = 'Another Chat - 2026-02-02';
            return model(messages);
        });
        await runAfterEventBase();
        expect(host.books[BOOK].entries[0].comment).toBe('Tamsin');
        expect(host.selections[BOOK].selectedUids).toEqual(['0']);
        expect(addLoreBookToChat).not.toHaveBeenCalled();
        expect(writeMissing).not.toHaveBeenCalled();
    });

    it("leaves the book's LoreBase keys and vectors to the next run while LoreBase writes", async () => {
        host.events = eventsNaming('Tamsin', 12);
        host.isLoreBaseWriting = true;
        await runAfterEventBase();
        expect(createLorebookEntry).toHaveBeenCalledTimes(1);
        expect(writeMissing).not.toHaveBeenCalled();
    });
});
