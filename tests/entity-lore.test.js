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
 *   - a long arc is written from the notes on each slice, each event with one time, and the book is saved one entry at
 *     a time,
 *   - the card reads each character's state as a run does, saving nothing; a row's button writes one due character's
 *     entry after the name check on that name, or a written one again, an edited one from the entry as the user left
 *     it; Allow again forgets a name, and Lock keeps a character from every run, each refused during a run; each run's
 *     end is told, and the last outcome kept,
 *   - names merged on StoryArc's Entity tab make an entry written under any of them the kept name's at once, keyed by
 *     every name and due again, rewritten from the entry as it stands; a name split off one comes off its keys at once,
 *     and its entry is written afresh from the events of the names it keeps, as is the entry a name the name check
 *     matched was matched to, once Allow again forgets that name, which is then kept apart from that entry's
 *     character: the name check is told, and reads a same_as between them as named; each with no model call and
 *     whatever is switched off, after a run under way ends, in order; a split changes nothing for a name the name check
 *     matched; a failed Allow again says why,
 *   - the changes to the record made outside a run go one at a time, Lock's too, and a run reads the record once they
 *     are made,
 *   - the name check is shown the titles of the chat's other books, and a name it says is another name of one's
 *     character gets no entry: the record keeps the link, the author's book stays as it was, and the name joins that
 *     entry's LoreBase keys at the run's end and again at each run, never while LoreBase writes or before the entry has
 *     keys; a link whose book the chat no longer loads reads as due; a title two books share links nothing; Allow again
 *     takes the name off those keys and keeps the two apart, or says why it failed (E1 to E3 of
 *     InternalProject/Vectfox/plans/entity-lore-names-across-languages.md),
 *   - the names the first ask answers named are asked about again, alone, shown the other books' author keys, and take
 *     that answer, an unread one keeping named; no second ask when no name is named or no key is shown; a failed second
 *     ask fails the whole check, so nothing is written and every name is asked about again at the next run (E5).
 *
 * Names are made up and match no story.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {}, chatId: '', worldNames: [], books: {}, collectionMeta: {}, events: [], merges: {}, chatBooks: [], characters: [],
    selections: {}, chatChangeHandlers: new Set(), isYes: true, isLoreBaseWriting: false, inUseCollectionId: '', ask: null, loreBaseKeys: {},
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
        formatStoryLine: event => `- #${event.timeline_sort_key}: ${event.text} (when: ${[event.DateTime, event.scene_time].filter(Boolean).join(', ') || `Day ${event.timeline_sort_key}`})`,
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
        host.selections[bookName] ??= { id: 'selection-1', selectedEntries: [] };
        return { chatId: host.chatId };
    }),
    askTextOnLoreBase: vi.fn(() => (...args) => host.ask(...args)),
    chatBookNames: () => [...host.chatBooks],
    chatCharacters: () => host.characters,
    // What LoreBase decides here: the entries the selection in use holds.
    decidedUidsHere: vi.fn(bookName => new Set((host.selections[bookName]?.selectedEntries ?? []).map(String))),
    ensureLoreSelection: vi.fn(bookName => (host.selections[bookName] ??= { id: 'selection-1', selectedEntries: [] })),
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
    setLoreBookSelection: vi.fn((bookName, _id, uids) => { host.selections[bookName].selectedEntries = [...new Set([...uids].map(String))]; }),
    selectedUidsOf: selection => [...(selection?.selectedEntries ?? [])],
    setLoreSelectionLock: vi.fn(),
    // LoreBase's stored keys (host.loreBaseKeys: book, uid, keys), changed as it changes them: a name added or taken off in
    // any case, an entry with no keys left as it is, refused while LoreBase writes.
    setNamesInLoreBaseKeys: vi.fn(async (changes) => {
        if (host.isLoreBaseWriting) throw new Error('LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.');
        return changes.map(({ bookName, uid, name, isHeld }) => {
            const keys = host.loreBaseKeys[bookName]?.[uid];
            if (!keys) return 'no_keys';
            const isName = key => key.toLowerCase() === name.toLowerCase();
            if (keys.some(isName) === isHeld) return 'unchanged';
            host.loreBaseKeys[bookName][uid] = isHeld ? [...keys, name] : keys.filter(key => !isName(key));
            return 'changed';
        });
    }),
    writeMissing: vi.fn(async () => ({})),
}));

const { createLorebook, createLorebookEntry, loadWorldInfo, saveLorebookEntry } = await import('../src/sillytavern/world-info.js');
const { confirmPopup } = await import('../src/sillytavern/popup.js');
const { progressTracker } = await import('../src/shared/progress-tracker.js');
const { notifyInvalidModel } = await import('../src/shared/model-config-notifier.js');
const { log } = await import('../src/sillytavern/log.js');
const { readChatStoryEvents } = await import('../src/features/eventbase/index.js');
const { selectedUidsOf } = await import('../src/features/lorebase/lorebase-selections-core.js');
const { addLoreBookToChat, regenerateKeysOfEntries, saveEntryWithVectors, setNamesInLoreBaseKeys, writeMissing } = await import('../src/features/lorebase/index.js');
const {
    allowEntityLoreAgain, lastEntityLoreRun, lockEntityLoreCharacter, onEntityLoreRunEnded, onEntityNameSplit, onEntityNamesMerged, onEventBaseRunEnded,
    readEntityLoreCharacters, runEntityLoreNow, writeEntityLoreEntryNow,
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
const entryAbout = name => `[Identity]\n${name} is a made-up harbor hand.\n[Personality]\nPatient.\n[Background]\nGrew up by the docks.\n[Key events]\n- Day 1: arrived.\n[Relationships]\n- Wren: a friend.`;
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
        inUseCollectionId: 'harbor-collection', ask: answering(), loreBaseKeys: {},
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
        expect(selectedUidsOf(host.selections[BOOK])).toEqual(['0']);
        expect(record()).toEqual({
            bookName: BOOK,
            entries: {
                'Tamsin Vale': { state: 'same_as', sameAs: 'Tamsin' },
                'the ferryman': { state: 'not_named' },
                Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash(entryAbout('Tamsin')) },
            },
            lockedNames: [],
            keptApart: [],
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
        expect(entryCall).toMatch(/^Notes on Tamsin, part by part, oldest first:/u);
        expect(createLorebookEntry).toHaveBeenCalledTimes(1);
    });

    it('gives each event one time: its DateTime to the minute, or its scene_time where it has none', async () => {
        host.events = eventsNaming('Tamsin', 12).map((event, index) => [
            { ...event, DateTime: '2026-04-08T18:58:00.000Z', scene_time: 'April 8th, evening' },
            { ...event, DateTime: null, scene_time: 'Day 3 of the Long Tide' },
        ][index] ?? event);
        await runAfterEventBase();
        const entryCall = host.ask.mock.calls.find(([messages]) => entryNameOf(messages) === 'Tamsin')[0][1].content;
        expect(entryCall).toContain('Tamsin works the harbor. (when: 2026-04-08 18:58)');
        expect(entryCall).toContain('Tamsin works the harbor. (when: Day 3 of the Long Tide)');
        expect(entryCall).not.toContain('T18:58');
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
        const [question, buttons] = confirmPopup.mock.calls[0];
        expect(question[0].parts).toEqual([{ text: 'Write lorebook entries for ' }, { name: '7' }, { text: ' characters' }, { text: '?' }]);
        expect(question[1].parts).toEqual([{ text: "One entry per character, from the story's events about them, into a new lorebook for this chat, " }, { name: BOOK }, { text: '.' }]);
        expect(buttons).toEqual({ okButton: 'Write', isCostly: true });
        expect(host.ask).not.toHaveBeenCalled();

        host.isYes = true;
        await runEntityLoreNow();
        expect(createLorebookEntry).toHaveBeenCalledTimes(7);
    });

    it('asks about the rewrites alone, with Rewrite, when no new entry is due', async () => {
        host.events = eventsNaming('Tamsin', 45);
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries: { 0: { uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: 'Tamsin trades salt.' } } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash('Tamsin trades salt.') } } } };
        host.isYes = false;
        await runEntityLoreNow();
        const [question, buttons] = confirmPopup.mock.calls[0];
        expect(question[0].parts).toEqual([{ text: 'Rewrite ' }, { name: '1' }, { text: ' lorebook entry?' }]);
        expect(question[1].parts).toEqual([{ text: "Each is written again from the character's whole story so far, in this chat's lorebook " }, { name: BOOK }, { text: '.' }]);
        expect(buttons).toEqual({ okButton: 'Rewrite', isCostly: true });
        expect(host.ask).not.toHaveBeenCalled();
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
        host.selections[BOOK] = { id: 'selection-1', selectedEntries: Object.keys(entries) };
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
        expect(await allowEntityLoreAgain('the ferryman')).toEqual({ problem: null });
        expect(record().entries).toEqual({ Hollis: { state: 'deleted', uid: '4' } });
        expect((await readEntityLoreCharacters()).states[0]).toMatchObject({ name: 'the ferryman', state: 'due' });

        let release;
        const held = new Promise((resolve) => { release = resolve; });
        host.ask = vi.fn(async () => { await held; return JSON.stringify({ names: [] }); });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 1 });
        await vi.waitFor(() => expect(host.ask).toHaveBeenCalled());
        expect(await allowEntityLoreAgain('Hollis')).toEqual({ problem: 'Entity-Lore is writing already; the progress panel shows it.' });
        release();
        await settle();
    });

    it('locks a character from every run, its entry left as it is, and unlocks it; refused while a run writes', async () => {
        host.events = [...eventsNaming('Tamsin', 60), ...eventsNaming('Hollis', 12)];
        writtenBook({ 0: { uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: 'Tamsin trades salt.' } });
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: { state: 'written', uid: '0', writtenAtEvents: 12, contentHash: entryContentHash('Tamsin trades salt.') } } } };
        expect(await lockEntityLoreCharacter({ name: 'Tamsin', otherNames: [] }, true)).toEqual({ problem: null });
        expect(await lockEntityLoreCharacter({ name: 'Hollis', otherNames: [] }, true)).toEqual({ problem: null });
        expect(record().lockedNames).toEqual(['Tamsin', 'Hollis']);
        expect((await readEntityLoreCharacters()).states.map(({ name, state }) => [name, state])).toEqual([['Tamsin', 'locked'], ['Hollis', 'locked']]);

        await runAfterEventBase();
        expect(await runEntityLoreNow()).toEqual({ problem: 'No entry is due now.', isNothingDue: true });
        expect(host.ask).not.toHaveBeenCalled();
        expect(host.books[BOOK].entries[0].content).toBe('Tamsin trades salt.');

        expect(await lockEntityLoreCharacter({ name: 'Hollis', otherNames: [] }, false)).toEqual({ problem: null });
        expect(record().lockedNames).toEqual(['Tamsin']);
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (isCheck(messages)) await held;
            return model(messages);
        });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
        await settle();
        expect(await lockEntityLoreCharacter({ name: 'Tamsin', otherNames: [] }, false)).toEqual({ problem: 'Entity-Lore is writing already; the progress panel shows it.' });
        release();
        await settle();
        expect(checkedNames()).toEqual(['Hollis']);
        expect(host.books[BOOK].entries[0].content).toBe('Tamsin trades salt.');
        expect(record().lockedNames).toEqual(['Tamsin']);
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

describe("names merged or split on StoryArc's Entity tab, and a matched name allowed again (D14, D17)", () => {
    const MERGE = { collectionKey: REGISTRY_KEY, keptName: 'Tamsin', otherNames: ['Marrow'] };
    const SPLIT = { collectionKey: REGISTRY_KEY, keptName: 'Tamsin', splitName: 'Marrow' };
    const writtenAs = (name, uid) => ({ state: 'written', uid: String(uid), writtenAtEvents: 12, contentHash: entryContentHash(entryAbout(name)) });
    const bookOf = (entries) => {
        host.worldNames.push(BOOK);
        host.chatBooks.push(BOOK);
        host.books[BOOK] = { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
    };

    it("make an entry written under a merged name the kept name's at once, keyed by every name, due again, with no model call, whatever is off", async () => {
        bookOf([{ uid: 0, comment: 'Marrow', key: ['Marrow', 'the ferry witch'], content: entryAbout('Marrow') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Marrow: writtenAs('Marrow', 0) } } };
        host.settings = { ...host.settings, entity_lore_enabled: false, lorebase_enabled: false, story_arc_mode_enabled: false };
        onEntityNamesMerged(MERGE);
        await settle();
        expect(host.books[BOOK].entries[0]).toEqual({ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow', 'the ferry witch'], content: entryAbout('Marrow') });
        expect(record()).toEqual({ bookName: BOOK, entries: { Tamsin: { ...writtenAs('Marrow', 0), namesChangedBy: 'merge' } }, lockedNames: [], keptApart: [] });
        expect(host.ask).not.toHaveBeenCalled();

        host.events = [...eventsNaming('Tamsin', 6), ...eventsNaming('Marrow', 8)];
        host.merges = { Tamsin: ['Marrow'] };
        const { states } = await readEntityLoreCharacters(host.settings);
        expect(states.map(({ name, state }) => [name, state])).toEqual([['Tamsin', 'rewrite_due']]);
    });

    it("rewrite a merged entity's entry at the next run from the entry as it stands, with every name's events", async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: entryAbout('Tamsin') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0) } } };
        onEntityNamesMerged(MERGE);
        await settle();
        host.events = [...eventsNaming('Tamsin', 12), ...eventsNaming('Marrow', 3)];
        host.merges = { Tamsin: ['Marrow'] };
        await runAfterEventBase();
        const prompt = host.ask.mock.calls[0][0][1].content;
        expect(prompt).toContain(`Tamsin's entry as it stands:\n\n${entryAbout('Tamsin')}`);
        expect(prompt.match(/^- #/gmu)).toHaveLength(15);
        expect(record().entries.Tamsin).toEqual({ state: 'written', uid: '0', writtenAtEvents: 15, contentHash: entryContentHash(entryAbout('Tamsin')) });
    });

    it("key the kept name's own entry by the merged names, its title as it was, and say when another name has an entry too", async () => {
        vi.stubGlobal('toastr', { warning: vi.fn() });
        bookOf([
            { uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: entryAbout('Tamsin') },
            { uid: 1, comment: 'Marrow', key: ['Marrow'], content: entryAbout('Marrow') },
        ]);
        const entityLore = { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0), Marrow: writtenAs('Marrow', 1) } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore };
        onEntityNamesMerged(MERGE);
        await settle();
        expect(host.books[BOOK].entries).toEqual({
            0: { uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') },
            1: { uid: 1, comment: 'Marrow', key: ['Marrow'], content: entryAbout('Marrow') },
        });
        expect(record()).toEqual({ ...entityLore, entries: { ...entityLore.entries, Tamsin: { ...writtenAs('Tamsin', 0), namesChangedBy: 'merge' } }, lockedNames: [], keptApart: [] });
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(
            `Marrow also has an entry in "${BOOK}". Entity-Lore keeps writing Tamsin's; delete the other in World Info if it says the same.`, 'VectFox Entity-Lore');
        vi.unstubAllGlobals();
    });

    it('wait for a run under way to end, each in the order it was made, as the run saves the record it read', async () => {
        bookOf([{ uid: 0, comment: 'Marrow', key: ['Marrow'], content: entryAbout('Marrow') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Marrow: writtenAs('Marrow', 0) } } };
        host.events = eventsNaming('Hollis', 12);
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (isCheck(messages)) await held;
            return model(messages);
        });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
        await settle();
        onEntityNamesMerged(MERGE);
        onEntityNameSplit(SPLIT);
        await settle();
        expect(host.books[BOOK].entries[0]).toMatchObject({ comment: 'Marrow', key: ['Marrow'] });
        release();
        await settle();
        expect(record().entries).toEqual({ Hollis: expect.objectContaining({ state: 'written', uid: '1' }), Tamsin: { ...writtenAs('Marrow', 0), namesChangedBy: 'split' } });
        expect(host.books[BOOK].entries[0]).toMatchObject({ comment: 'Tamsin', key: ['Tamsin'] });
    });

    it.each([
        ['a name split off on StoryArc', {}, async () => {
            onEntityNameSplit(SPLIT);
            await settle();
        }, 'split'],
        ['a name the name check matched, allowed again', { Marrow: { state: 'same_as', sameAs: 'Tamsin' } }, async () => {
            expect(await allowEntityLoreAgain('MARROW')).toEqual({ problem: null });
        }, 'allow_again'],
    ])("%s: out of the entry's keys at once, with no model call, whatever is off, and the entry written afresh at the next run", async (_, matched, change, mark) => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'marrow', 'the ferry witch'], content: entryAbout('Tamsin') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0), ...matched } } };
        host.settings = { ...host.settings, entity_lore_enabled: false, lorebase_enabled: false, story_arc_mode_enabled: false };
        await change();
        expect(host.books[BOOK].entries[0]).toEqual({ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'the ferry witch'], content: entryAbout('Tamsin') });
        expect(record().entries).toEqual({ Tamsin: { ...writtenAs('Tamsin', 0), namesChangedBy: mark } });
        expect(host.ask).not.toHaveBeenCalled();

        host.settings = { ...host.settings, entity_lore_enabled: true, lorebase_enabled: true, story_arc_mode_enabled: true };
        host.events = [...eventsNaming('Tamsin', 14, 'Tamsin mends nets.'), ...eventsNaming('Marrow', 9, 'Marrow rows the ferry.')];
        await runAfterEventBase();
        const prompt = host.ask.mock.calls[0][0][1].content;
        expect(prompt).not.toContain('as it stands');
        expect(prompt).not.toContain('Marrow');
        expect(prompt.match(/^- #/gmu)).toHaveLength(14);
        expect(saveEntryWithVectors).toHaveBeenCalledWith(BOOK, '0', { comment: 'Tamsin', content: entryAbout('Tamsin'), keys: ['Tamsin', 'the ferry witch'] }, host.settings);
        expect(regenerateKeysOfEntries).toHaveBeenCalledWith(BOOK, [expect.objectContaining({ uid: 0 })], host.settings);
        expect(record().entries.Tamsin).toEqual({ state: 'written', uid: '0', writtenAtEvents: 14, contentHash: entryContentHash(entryAbout('Tamsin')) });
    });

    it('leave the entry as it is on a split of a name the name check matched to it, as it reads that name\'s events still, and ask nothing', async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') }]);
        const entityLore = { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0), Marrow: { state: 'same_as', sameAs: 'Tamsin' } }, lockedNames: [] };
        host.collectionMeta[REGISTRY_KEY] = { entityLore };
        onEntityNameSplit(SPLIT);
        await settle();
        expect(host.books[BOOK].entries[0].key).toEqual(['Tamsin', 'Marrow']);
        expect(record()).toEqual(entityLore);
        expect(saveLorebookEntry).not.toHaveBeenCalled();
        expect(confirmPopup).not.toHaveBeenCalled();
    });

    it('ask at a split whether the entry is written again from scratch, opening on Keep as it is, which keys it without the name and leaves it', async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') }]);
        const entityLore = { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0) }, lockedNames: [], keptApart: [] };
        host.collectionMeta[REGISTRY_KEY] = { entityLore };
        host.isYes = false;
        onEntityNameSplit(SPLIT);
        await settle();
        const [question, buttons] = confirmPopup.mock.calls[0];
        expect(question[0].parts).toEqual([{ text: 'Write the lorebook entry for ' }, { name: 'Tamsin' }, { text: ' again from scratch?' }]);
        expect(buttons).toEqual({ okButton: 'Write again', cancelButton: 'Keep as it is', isCostly: true });
        expect(host.books[BOOK].entries[0]).toEqual({ uid: 0, comment: 'Tamsin', key: ['Tamsin'], content: entryAbout('Tamsin') });
        expect(record()).toEqual(entityLore);
        expect(host.ask).not.toHaveBeenCalled();
    });

    it('ask at the split even while a run is under way, and make the change once it ends', async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0) } } };
        host.events = eventsNaming('Hollis', 12);
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (isCheck(messages)) await held;
            return model(messages);
        });
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
        await settle();
        onEntityNameSplit(SPLIT);
        await settle();
        expect(confirmPopup).toHaveBeenCalledTimes(1);
        expect(host.books[BOOK].entries[0].key).toEqual(['Tamsin', 'Marrow']);
        release();
        await settle();
        expect(host.books[BOOK].entries[0].key).toEqual(['Tamsin']);
        expect(record().entries.Tamsin).toEqual({ ...writtenAs('Tamsin', 0), namesChangedBy: 'split' });
    });

    it('ask nothing at a split of a name off an entry the user edited, which stays theirs, and key it without the name', async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: 'Tamsin, as the user wrote her.' }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0) } } };
        onEntityNameSplit(SPLIT);
        await settle();
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(host.books[BOOK].entries[0].key).toEqual(['Tamsin']);
    });

    it("keep a name allowed again apart from its entry's character: the name check is told, and a same_as to it anyway reads as named", async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0), Marrow: { state: 'same_as', sameAs: 'Tamsin' } } } };
        host.events = [...eventsNaming('Tamsin', 14), ...eventsNaming('Marrow', 12)];
        expect(await allowEntityLoreAgain('Marrow')).toEqual({ problem: null });
        expect(record().keptApart).toEqual([{ name: 'Marrow', from: 'Tamsin' }]);
        expect((await readEntityLoreCharacters()).states.map(({ name, keptApartFrom }) => [name, keptApartFrom])).toEqual([['Tamsin', ['Marrow']], ['Marrow', ['Tamsin']]]);

        host.ask = answering({ Marrow: { answer: 'same_as', same_as: 'Tamsin' } });
        await runAfterEventBase();
        const check = host.ask.mock.calls.find(([messages]) => isCheck(messages))[0][1].content;
        expect(check).toContain('1. Marrow: 12 events. One of them: ');
        expect(check).toContain('\n   Not the same character as Tamsin.\n');
        expect(record().entries.Marrow).toMatchObject({ state: 'written', uid: '1' });
        expect(host.books[BOOK].entries[0].key).toEqual(['Tamsin']);
        expect(saveLorebookEntry).toHaveBeenCalledTimes(1);
    });

    it('say why Allow again failed, the record and the keys as they were', async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') }]);
        const entityLore = { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0), Marrow: { state: 'same_as', sameAs: 'Tamsin' } } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore };
        loadWorldInfo.mockRejectedValueOnce(new Error('The server did not answer.'));
        expect(await allowEntityLoreAgain('Marrow')).toEqual({ problem: 'Allow again failed: The server did not answer.' });
        expect(record()).toEqual(entityLore);
        expect(host.books[BOOK].entries[0].key).toEqual(['Tamsin', 'Marrow']);
        expect(log.warn).toHaveBeenCalledWith('[VectFox-EntityLore] Marrow: Allow again failed, so its record is as it was:', expect.any(Error));
    });

    it('are made one at a time outside a run, with Lock and Unlock, and a run reads the record once they are made', async () => {
        bookOf([{ uid: 0, comment: 'Tamsin', key: ['Tamsin', 'Marrow'], content: entryAbout('Tamsin') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Tamsin: writtenAs('Tamsin', 0), Marrow: { state: 'same_as', sameAs: 'Tamsin' } } } };
        host.events = [...eventsNaming('Tamsin', 14), ...eventsNaming('Marrow', 9), ...eventsNaming('Hollis', 12)];
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        loadWorldInfo.mockImplementationOnce(async (bookName) => {
            await held;
            return structuredClone(host.books[bookName]);
        });
        const allowed = allowEntityLoreAgain('Marrow');
        const locked = lockEntityLoreCharacter({ name: 'Hollis', otherNames: [] }, true);
        onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
        await settle();
        expect(host.ask).not.toHaveBeenCalled();
        release();
        expect(await allowed).toEqual({ problem: null });
        expect(await locked).toEqual({ problem: null });
        await settle();
        expect(record().lockedNames).toEqual(['Hollis']);
        expect(record().entries.Marrow).toBeUndefined();
        expect(host.ask.mock.calls.map(([messages]) => entryNameOf(messages))).toEqual(['Tamsin']);
        expect(host.ask.mock.calls[0][0][1].content).not.toContain('as it stands');
    });

    it('are made, once a run ends, before the next run reads the record, one that starts while they are made too', async () => {
        bookOf([{ uid: 0, comment: 'Marrow', key: ['Marrow'], content: entryAbout('Marrow') }]);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: { Marrow: writtenAs('Marrow', 0) } } };
        host.events = [...eventsNaming('Marrow', 12), ...eventsNaming('Hollis', 12)];
        let releaseCheck;
        const checkHeld = new Promise((resolve) => { releaseCheck = resolve; });
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (isCheck(messages)) await checkHeld;
            return model(messages);
        });
        // The merge made during the first run loads the book once that run has written Hollis; that load waits.
        const loadBook = loadWorldInfo.getMockImplementation();
        let releaseLoad;
        const loadHeld = new Promise((resolve) => { releaseLoad = resolve; });
        let isLoadHeld = false;
        loadWorldInfo.mockImplementation(async (bookName) => {
            if (bookName === BOOK && record().entries.Hollis && !isLoadHeld) {
                isLoadHeld = true;
                await loadHeld;
            }
            return loadBook(bookName);
        });
        try {
            onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
            await settle();
            host.merges = { Tamsin: ['Marrow'] };
            onEntityNamesMerged(MERGE);
            releaseCheck();
            await settle();
            expect(isLoadHeld).toBe(true);
            host.events = [...host.events, ...eventsNaming('Corin', 12)];
            onEventBaseRunEnded({ collectionId: 'harbor-collection', eventsAdded: 3 });
            await settle();
            releaseLoad();
            await settle();
        } finally {
            loadWorldInfo.mockImplementation(loadBook);
        }
        expect(createLorebookEntry.mock.calls.map(([, entry]) => entry.comment)).toEqual(['Hollis', 'Corin']);
        expect(record().entries.Tamsin).toMatchObject({ state: 'written', uid: '0' });
    });
});

describe('names in another book the chat loads (E1 to E3 of entity-lore-names-across-languages.md)', () => {
    const YSOLDE = { uid: 1, comment: '[NPC] Ysolde', key: ['Ysolde'], content: 'A harbor witch.' };
    const LINK = { state: 'in_lorebook', bookName: 'Harbor Atlas', uid: '1', title: '[NPC] Ysolde' };
    const STILL_WRITING = 'LoreBase is already writing keys or vectors; the progress panel shows them. Wait for it, or press Stop there.';
    const checkText = () => host.ask.mock.calls.find(([messages]) => isCheck(messages))[0][1].content;

    beforeEach(() => {
        host.books['Harbor Atlas'].entries[1] = structuredClone(YSOLDE);
        host.loreBaseKeys = { 'Harbor Atlas': { 1: ['Ysolde', 'harbor witch'] } };
    });

    it("shows the check the other books' titles, and links a name it says is another name of one: no entry of its own, the author's book as it was, the name in that entry's LoreBase keys", async () => {
        host.events = [...eventsNaming('Isolde', 12), ...eventsNaming('Tamsin', 10)];
        host.ask = answering({ Isolde: { answer: 'same_as', same_as: 'Ysolde' } });
        await runAfterEventBase();

        expect(checkText()).toContain('Entries already written for this story, by title:\n- Captain Brannoc\n- [NPC] Ysolde\n');
        expect(record().entries.Isolde).toEqual(LINK);
        expect(createLorebookEntry.mock.calls.map(([, fields]) => fields.comment)).toEqual(['Tamsin']);
        expect(host.books['Harbor Atlas'].entries[1]).toEqual(YSOLDE);
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'harbor witch', 'Isolde']);
        expect(log.lifecycle).toHaveBeenCalledWith(expect.stringContaining('Isolde same_as [NPC] Ysolde in "Harbor Atlas"'));
        expect((await readEntityLoreCharacters()).states.find(each => each.name === 'Isolde')).toMatchObject({
            state: 'in_lorebook', lorebookEntry: { bookName: 'Harbor Atlas', uid: '1', title: '[NPC] Ysolde', isDecidedHere: false, isConstant: false },
        });
    });

    it('adds the name again at a later run once its keys were rewritten, but never while LoreBase writes, or to an entry with no keys yet', async () => {
        host.events = eventsNaming('Isolde', 12);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: '', entries: { Isolde: LINK } } };
        await runAfterEventBase();
        expect(host.ask).not.toHaveBeenCalled();
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'harbor witch', 'Isolde']);

        host.loreBaseKeys['Harbor Atlas'][1] = ['Ysolde', 'witch of the harbor'];
        host.isLoreBaseWriting = true;
        setNamesInLoreBaseKeys.mockClear();
        await runAfterEventBase();
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'witch of the harbor']);
        // Asked nothing, as LoreBase's guard would bring its panel up.
        expect(setNamesInLoreBaseKeys).not.toHaveBeenCalled();
        host.isLoreBaseWriting = false;
        await runAfterEventBase();
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'witch of the harbor', 'Isolde']);

        delete host.loreBaseKeys['Harbor Atlas'][1];
        await runAfterEventBase();
        expect(host.loreBaseKeys['Harbor Atlas']).toEqual({});
    });

    it('reads a link as due once the chat no longer loads its book, and asks the check about the name again', async () => {
        host.events = eventsNaming('Isolde', 12);
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: '', entries: { Isolde: LINK } } };
        host.chatBooks = [];
        expect((await readEntityLoreCharacters()).states[0]).toMatchObject({ name: 'Isolde', state: 'due' });
        await runAfterEventBase();
        expect(checkedNames()).toEqual(['Isolde']);
        expect(record().entries.Isolde).toMatchObject({ state: 'written', uid: '0' });
    });

    it('leaves to the name check a name a title holds only bare, so the check links it, as the exclusion reads titles as written (E4)', async () => {
        host.books['Harbor Atlas'].entries[5] = { uid: 5, comment: '[NPC] Orla Vance', key: ['Wren'], content: 'A harbor pilot.' };
        host.loreBaseKeys['Harbor Atlas'][5] = ['Wren', 'harbor pilot'];
        host.events = eventsNaming('Orla Vance', 12);
        expect((await readEntityLoreCharacters()).states).toMatchObject([{ name: 'Orla Vance', state: 'due' }]);

        host.ask = answering({ 'Orla Vance': { answer: 'same_as', same_as: '[NPC] Orla Vance' } });
        await runAfterEventBase();
        expect(checkedNames()).toEqual(['Orla Vance']);
        expect(record().entries['Orla Vance']).toEqual({ state: 'in_lorebook', bookName: 'Harbor Atlas', uid: '5', title: '[NPC] Orla Vance' });
        expect(createLorebookEntry).not.toHaveBeenCalled();
        expect(host.loreBaseKeys['Harbor Atlas'][5]).toEqual(['Wren', 'harbor pilot', 'Orla Vance']);
    });

    it('links a name the check answers same_as its own name to the entry whose title is that name bare, writing it no second entry (E6)', async () => {
        host.books['Harbor Atlas'].entries[5] = { uid: 5, comment: '[NPC] Orla Vance', key: ['Wren'], content: 'A harbor pilot.' };
        host.loreBaseKeys['Harbor Atlas'][5] = ['Wren', 'harbor pilot'];
        host.events = eventsNaming('Orla Vance', 12);
        host.ask = answering({ 'Orla Vance': { answer: 'same_as', same_as: 'Orla Vance' } });
        await runAfterEventBase();
        expect(record().entries['Orla Vance']).toEqual({ state: 'in_lorebook', bookName: 'Harbor Atlas', uid: '5', title: '[NPC] Orla Vance' });
        expect(createLorebookEntry).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not be read'));
        expect(host.loreBaseKeys['Harbor Atlas'][5]).toEqual(['Wren', 'harbor pilot', 'Orla Vance']);
    });

    it('links nothing to a title two books share: the answer is not read, and the name is written as its own entry', async () => {
        host.worldNames.push('Tide Tables');
        host.chatBooks.push('Tide Tables');
        host.books['Tide Tables'] = { entries: { 4: { uid: 4, comment: '[npc] ysolde', key: [], content: 'Another Ysolde.' } } };
        host.events = eventsNaming('Isolde', 12);
        host.ask = answering({ Isolde: { answer: 'same_as', same_as: '[NPC] Ysolde' } });
        await runAfterEventBase();
        expect(checkText()).toContain('- Captain Brannoc\n- [NPC] Ysolde\n\n');
        expect(log.warn).toHaveBeenCalledWith('[VectFox-EntityLore] The name check: 1 answer could not be read; those names stay due');
        expect(record().entries.Isolde).toMatchObject({ state: 'written' });
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'harbor witch']);
    });

    it("takes a linked name off that entry's LoreBase keys on Allow again and keeps the two apart, so the check's same_as to it reads as named", async () => {
        host.events = eventsNaming('Isolde', 12);
        host.loreBaseKeys['Harbor Atlas'][1].push('Isolde');
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: '', entries: { Isolde: LINK } } };
        expect(await allowEntityLoreAgain('isolde')).toEqual({ problem: null });
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'harbor witch']);
        expect(record()).toEqual({ bookName: '', entries: {}, lockedNames: [], keptApart: [{ name: 'isolde', from: '[NPC] Ysolde' }] });
        expect(host.books['Harbor Atlas'].entries[1]).toEqual(YSOLDE);

        host.ask = answering({ Isolde: { answer: 'same_as', same_as: 'Ysolde' } });
        await runAfterEventBase();
        expect(checkText()).toContain('\n   Not the same character as [NPC] Ysolde.\n');
        expect(record().entries.Isolde).toMatchObject({ state: 'written' });
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'harbor witch']);
    });

    it('says why Allow again on a link failed while LoreBase writes, the record and the keys as they were', async () => {
        host.loreBaseKeys['Harbor Atlas'][1].push('Isolde');
        const entityLore = { bookName: '', entries: { Isolde: LINK } };
        host.collectionMeta[REGISTRY_KEY] = { entityLore };
        host.isLoreBaseWriting = true;
        expect(await allowEntityLoreAgain('Isolde')).toEqual({ problem: `Allow again failed: ${STILL_WRITING}` });
        expect(record()).toEqual(entityLore);
        expect(host.loreBaseKeys['Harbor Atlas'][1]).toEqual(['Ysolde', 'harbor witch', 'Isolde']);
    });
});

describe("the name check's second ask, shown the other books' keys (E5 of entity-lore-names-across-languages.md)", () => {
    const ORLA = { uid: 2, comment: '[NPC] Orla Vance', key: ['Orla', 'Wren'], content: 'A harbor pilot.' };
    const isKeyedCheck = messages => isCheck(messages) && messages[1].content.includes('Keyed by:');
    const checksAsked = () => host.ask.mock.calls.filter(([messages]) => isCheck(messages)).map(([messages]) => messages[1].content);
    const namesIn = prompt => [...prompt.matchAll(/^\d+\. (.+?): /gmu)].map(match => match[1]);
    // The first ask answers as `firstAnswers` says, the second, shown the keys, as `secondAnswers` says; every other name named.
    const answeringTwice = (firstAnswers, secondAnswers) => vi.fn(async messages => answering(isKeyedCheck(messages) ? secondAnswers : firstAnswers)(messages));
    const NOT_NAMED = { answer: 'not_named' };
    const ORLA_LINK = { state: 'in_lorebook', bookName: 'Harbor Atlas', uid: '2', title: '[NPC] Orla Vance' };

    beforeEach(() => {
        host.books['Harbor Atlas'].entries[2] = structuredClone(ORLA);
        host.loreBaseKeys = { 'Harbor Atlas': { 2: ['Orla', 'harbor pilot'] } };
        host.events = [...eventsNaming('Ren', 12), ...eventsNaming('Tamsin', 11), ...eventsNaming('the ferryman', 10)];
    });

    it('asks again about the names the first ask answers named, alone and shown the keys, and links one it says is another name of an entry', async () => {
        host.ask = answeringTwice({ 'the ferryman': NOT_NAMED }, { Ren: { answer: 'same_as', same_as: '[NPC] Orla Vance' } });
        await runAfterEventBase();

        const [firstAsk, secondAsk] = checksAsked();
        expect(namesIn(firstAsk)).toEqual(expect.arrayContaining(['Ren', 'Tamsin', 'the ferryman']));
        expect(firstAsk).not.toContain('Keyed by:');
        expect(namesIn(secondAsk).sort()).toEqual(['Ren', 'Tamsin']);
        expect(secondAsk).toContain('- [NPC] Orla Vance\n  Keyed by: Wren\n');
        expect(progressTracker.updateCurrentItem).toHaveBeenCalledWith("Checking 2 names against the keys of the chat's lorebooks");
        expect(record().entries.Ren).toEqual(ORLA_LINK);
        expect(record().entries['the ferryman']).toMatchObject({ state: 'not_named' });
        expect(createLorebookEntry.mock.calls.map(([, fields]) => fields.comment)).toEqual(['Tamsin']);
        expect(host.loreBaseKeys['Harbor Atlas'][2]).toEqual(['Orla', 'harbor pilot', 'Ren']);
        expect(log.lifecycle).toHaveBeenCalledWith(expect.stringContaining('Ren same_as [NPC] Orla Vance in "Harbor Atlas" (second ask)'));
    });

    it('asks no second time when the first ask answers no name named, or no other book has a key to show', async () => {
        host.ask = answering({ Ren: NOT_NAMED, Tamsin: NOT_NAMED, 'the ferryman': NOT_NAMED });
        await runAfterEventBase();
        expect(checksAsked()).toHaveLength(1);

        host.collectionMeta = {};
        host.books['Harbor Atlas'].entries[2].key = ['Orla', 'orla vance'];
        host.ask = answering();
        await runAfterEventBase();
        expect(checksAsked()).toHaveLength(1);
        expect(record().entries.Ren).toMatchObject({ state: 'written' });
    });

    it('fails the whole check when the second ask fails: no new entry, the record as it was, every name asked about again at the next run', async () => {
        const model = answeringTwice({ 'the ferryman': NOT_NAMED }, {});
        host.ask = vi.fn(async (messages) => {
            if (isKeyedCheck(messages)) throw new Error('The provider is down.');
            return model(messages);
        });
        await runAfterEventBase();
        expect(createLorebookEntry).not.toHaveBeenCalled();
        expect(record()?.entries ?? {}).toEqual({});
        expect(progressTracker.addError).toHaveBeenCalledWith("The name check's second ask: The provider is down.");
        expect(log.warn).toHaveBeenCalledWith("[VectFox-EntityLore] The name check's second ask:", expect.objectContaining({ message: 'The provider is down.' }));

        host.ask = answeringTwice({ 'the ferryman': NOT_NAMED }, { Ren: { answer: 'same_as', same_as: '[NPC] Orla Vance' } });
        await runAfterEventBase();
        expect(namesIn(checksAsked()[0])).toEqual(expect.arrayContaining(['Ren', 'Tamsin', 'the ferryman']));
        expect(record().entries.Ren).toEqual(ORLA_LINK);
    });

    it('asks no second time once Stop is pressed during the first ask, and writes nothing', async () => {
        const model = answeringTwice({ 'the ferryman': NOT_NAMED }, {});
        host.ask = vi.fn(async (messages) => {
            if (isCheck(messages)) progressTracker.setCancelHandler.mock.calls.at(-1)[0]();
            return model(messages);
        });
        await runAfterEventBase();
        expect(checksAsked()).toHaveLength(1);
        expect(createLorebookEntry).not.toHaveBeenCalled();
        expect(record().entries['the ferryman']).toMatchObject({ state: 'not_named' });
    });

    it('keeps the first answer of a name the second ask leaves unread, so it is written as a named one', async () => {
        host.ask = answeringTwice({ 'the ferryman': NOT_NAMED }, { Ren: { answer: 'same_as', same_as: 'Nobody Known' } });
        await runAfterEventBase();
        expect(log.warn).toHaveBeenCalledWith("[VectFox-EntityLore] The name check's second ask: 1 answer could not be read; those names stay due");
        expect(createLorebookEntry.mock.calls.map(([, fields]) => fields.comment).sort()).toEqual(['Ren', 'Tamsin']);
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
        host.selections[BOOK] = { id: 'selection-1', selectedEntries: [] };
        host.collectionMeta[REGISTRY_KEY] = { entityLore: { bookName: BOOK, entries: {} } };
        const model = answering();
        host.ask = vi.fn(async (messages) => {
            if (entryNameOf(messages)) host.chatId = 'Another Chat - 2026-02-02';
            return model(messages);
        });
        await runAfterEventBase();
        expect(host.books[BOOK].entries[0].comment).toBe('Tamsin');
        expect(selectedUidsOf(host.selections[BOOK])).toEqual(['0']);
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
