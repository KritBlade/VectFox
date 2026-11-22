/**
 * LoreBase on each reply (src/features/lorebase/lorebase-reply.js, plan §5.5 to §5.9 of InternalProject/Vectfox/
 * plans/executed/lorebook-semantic-overhaul-passage-index.md): the generation interceptor's ask for a reply's lore runs the pick
 * only on replies (D8), a quiet-to-loud generation included, and only while LoreBase acts, a reply first settling
 * Vector Storage's World Info search with the user; reads the books SillyTavern loads that are locked to the chat or
 * character (D11); sends each call on LoreBase's connection as the trials sent them; goes on without the lore a failed
 * call could not get, with the toast for it (D14); says, once per chat and again when their number changes, which
 * selected entries a reply leaves out for not being ready, with no keys (D17) or no vectors from the embedding model set
 * now (§4.4 of lorebook-multi-vector.md); on Fast and Cheap [Jev] searches above 100 entries and sends Jev's picks
 * within the lore budget (§5), a search failed on the embedding setup raising the sticky popup; holds a reply's picks
 * for the World Info scan that follows once
 * the retrieval beside them is done, where a generation with no pick sends no selected entry (§5.7, §6.8); and hands
 * each reply's outcome to the tester, with what that scan reads (§5.10).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oneSelectionRecord } from './lorebase-book-record.js';

const host = vi.hoisted(() => ({
    handlers: {},
    context: null,
    chatId: 'chat-harbor',
    globalBooks: [],
    charLore: [],
    books: {},
    settings: { vectfox: {} },
    connection: null,
    isWorldInfoSearchOn: false,
    // Every entry has keys but these ("book/uid"), and a read of the keys fails with this error when one is set.
    unkeyedUids: new Set(),
    keysReadError: null,
    // Every entry has vectors from the embedding model set now but these ("book/uid"), and a read of the vectors fails
    // with this error when one is set.
    unvectorizedUids: new Set(),
    vectorsReadError: null,
    // Fast and Cheap [Jev]: Jev's connection, and its answer.
    jevConnection: null,
    jevAnswer: null,
}));

vi.mock('../src/sillytavern/chat.js', () => ({
    getContext: () => host.context,
    getCurrentChatId: () => host.chatId,
    substituteParams: text => text,
}));
vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: {
        on: (event, handler) => { host.handlers[event] = handler; },
        once: (event, handler) => { host.handlers[event] = handler; },
        makeLast: (event, handler) => { host.handlers[event] = handler; },
        emit: vi.fn(async () => {}),
    },
    event_types: {
        GENERATION_AFTER_COMMANDS: 'generation_after_commands', CHARACTER_RENAMED: 'character_renamed', CHAT_RENAMED: 'chat_renamed',
        APP_READY: 'app_ready', WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
    },
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({
    // SillyTavern's file name of a character: its avatar's without the extension.
    getCharaFilename: (id, { manualAvatarKey = null } = {}) => manualAvatarKey?.replace(/\.[^/.]+$/, '') ?? null,
    // SillyTavern's server cleaner, which drops what a file name cannot hold.
    getSanitizedFilename: vi.fn(async fileName => fileName.replace(/[/?<>\\:*|"]/gu, '')),
}));
vi.mock('../src/sillytavern/world-info.js', () => ({
    METADATA_KEY: 'world_info',
    getWorldInfoSettings: () => ({ world_info: { charLore: host.charLore } }),
    characterLorebooks: characterFileName => host.charLore.find(item => item.name === characterFileName)?.extraBooks ?? [],
    loadWorldInfo: vi.fn(async name => host.books[name] ?? null),
    selected_world_info: host.globalBooks,
}));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isConnectionError: () => false, notifyConnectionError: vi.fn(), notifyUpstreamRejection: vi.fn(),
    notifyInvalidModel: vi.fn(), notifySetupIncomplete: vi.fn(),
}));
// The real JSON reader, which needs these of SillyTavern and VectFox to load.
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../src/shared/model-http-errors.js', () => ({ getModelConfigErrorMessage: () => null }));
vi.mock('../src/features/llm-provider/index.js', async () => {
    const call = await vi.importActual('../src/features/llm-provider/llm-provider-call.js');
    return { parseJsonArrayFromLlm: call.parseJsonArrayFromLlm, postChatCompletion: vi.fn() };
});
vi.mock('../src/features/text-cleaning/index.js', () => ({
    cleanText: text => text,
    stripGameSystemBlocks: text => text,
    stripReasoningBlocks: vi.fn(text => text.replace(/<think>[\s\S]*?<\/think>/g, '')),
}));
vi.mock('../src/features/lorebase/lorebase-connection.js', async () => ({
    // The real call, so the requests and the answer's reading are what LoreBase sends and reads.
    askOnLoreBase: (await vi.importActual('../src/features/lorebase/lorebase-connection.js')).askOnLoreBase,
    resolveLoreBaseLlmConfig: () => host.connection,
    describeLoreBaseConnectionProblem: (reason, problem) => `${problem} Until then the entries selected for LoreBase stay out of replies.`,
}));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(), choicePopup: vi.fn() }));
vi.mock('../src/sillytavern/vector-storage.js', () => ({
    isVectorStorageWorldInfoOn: () => host.isWorldInfoSearchOn,
    turnOffVectorStorageWorldInfo: vi.fn(async () => { host.isWorldInfoSearchOn = false; return true; }),
}));
vi.mock('../src/features/lorebase/lorebase-tester.js', () => ({
    initializeLoreBaseTester: vi.fn(), keepReplyScan: vi.fn(), recordReplyReport: vi.fn(),
}));
vi.mock('../src/features/lorebase/lorebase-jev.js', () => ({
    resolveJevConnection: () => host.jevConnection,
    askJev: vi.fn(async () => host.jevAnswer),
}));
vi.mock('../src/features/lorebase/lorebase-vectors.js', () => ({
    initializeLoreBaseVectors: vi.fn(),
    bookVectors: vi.fn(async bookNames => {
        if (host.vectorsReadError) throw host.vectorsReadError;
        return new Map(bookNames.map(bookName => [bookName, new Map()]));
    }),
    hasStoredCurrentVectors: vi.fn((bookName, entry) => !host.unvectorizedUids.has(`${bookName}/${entry.uid}`)),
    searchReplyPool: vi.fn(async (books, contents) => {
        if (host.searchError) throw host.searchError;
        return contents.slice(-2);
    }),
}));
vi.mock('../src/features/lorebase/lorebase-routes.js', () => ({ postLoreBaseRoute: vi.fn() }));
// The reply's model is lorebase-setup.js's (replyModel), read as it is from the Jev and LoreBase connections above.
vi.mock('../src/features/embedding/index.js', () => ({ embeddingSetupProblem: () => '' }));
vi.mock('../src/features/lorebase/lorebase-keys.js', () => ({
    hasStoredKeys: (bookName, uid) => !host.unkeyedUids.has(`${bookName}/${uid}`),
    readBookKeys: vi.fn(async bookNames => {
        if (host.keysReadError) throw host.keysReadError;
        return Object.fromEntries(bookNames.map(bookName => [bookName, Object.fromEntries(Object.values(host.books[bookName]?.entries ?? {})
            .filter(entry => !host.unkeyedUids.has(`${bookName}/${entry.uid}`))
            .map(entry => [String(entry.uid), [`keys of ${entry.comment}`]]))]));
    }),
}));

const { eventSource } = await import('../src/sillytavern/events.js');
const { loadWorldInfo } = await import('../src/sillytavern/world-info.js');
const { getSanitizedFilename } = await import('../src/sillytavern/identifiers.js');
const { log } = await import('../src/sillytavern/log.js');
const { notifyInvalidModel, notifySetupIncomplete } = await import('../src/shared/model-config-notifier.js');
const { postChatCompletion } = await import('../src/features/llm-provider/index.js');
const { stripReasoningBlocks } = await import('../src/features/text-cleaning/index.js');
const { choicePopup } = await import('../src/sillytavern/popup.js');
const { turnOffVectorStorageWorldInfo } = await import('../src/sillytavern/vector-storage.js');
const { initializeLoreBaseTester, keepReplyScan, recordReplyReport } = await import('../src/features/lorebase/lorebase-tester.js');
const { askJev } = await import('../src/features/lorebase/lorebase-jev.js');
const { searchReplyPool } = await import('../src/features/lorebase/lorebase-vectors.js');
const { initializeLoreBase, prepareLoreBesideRetrieval, prepareLoreForReply, tryLoreBasePick } = await import('../src/features/lorebase/lorebase-reply.js');

initializeLoreBase();
host.handlers.app_ready();
// beforeEach clears the mocks, so start-up is counted here.
const testerStartUps = initializeLoreBaseTester.mock.calls.length;
const afterCommands = (type, options, isDryRun = false) => host.handlers.generation_after_commands(type, options, isDryRun);

const LIGHTHOUSE = { uid: 0, comment: 'Lighthouse of Vell', content: '[Cliff]\nThe lighthouse stands on the north cliff of Vell.\n[Lamp]\nIts lamp burns through every storm.' };
const TIDEWARDENS = { uid: 1, comment: 'Tidewardens', content: '[Duties]\nThe tidewardens read the harbor bells.\n[Ranks]\nA warden rises by the bells they read.' };
const LAMP_RULES = { uid: 7, comment: 'Lamp Rules', content: 'The lamp is never left dark.' };
const ON_PROFILE = {
    ok: true, provider: 'connection_profile', model: 'openai/gpt-6-luna', connectionProfileId: 'p-harbor', connectionProfilePage: 'WorldInfo',
    parameterStyle: { sendTemperature: false, tokenLimitParameter: 'max_tokens', reasoningEffort: null },
};
const answer = entries => ({ content: JSON.stringify({ entries }), cutReason: null });
const pickOf = (...numbers) => answer(numbers.map(number => ({ number, basis: 'named in the chat', certain: true, why: 'it is asked after', needs: 'who keeps it' })));
const reviewOf = (uses, leaveOut = []) => answer([{ entry: 1, uses, leave_out: leaveOut }]);
const userContent = callIndex => postChatCompletion.mock.calls[callIndex][0].messages[1].content;
// The pick's table of contents: all of its system prompt after the table's opening line, so the table ends it.
const pickTable = callIndex => postChatCompletion.mock.calls[callIndex][0].messages[0].content.split('number and title.\n\n')[1];

let settings;
beforeEach(() => {
    vi.clearAllMocks();
    globalThis.toastr = { warning: vi.fn() };
    host.chatId = 'chat-harbor';
    host.context = {
        chat: [{ name: 'Keeper Orrin', mes: 'The lamp is lit.', is_user: false }, { name: 'Wren', mes: 'Who keeps it tonight?', is_user: true }],
        characters: { 3: { name: 'Keeper Orrin', avatar: 'keeper-orrin.png', data: { extensions: { world: 'Keeper Notes' } } } },
        characterId: '3',
        chatMetadata: { world_info: 'Voyage Log' },
        powerUserSettings: { persona_description_lorebook: '' },
    };
    host.globalBooks.splice(0, host.globalBooks.length, 'Harbor Atlas');
    host.charLore = [];
    host.books = { 'Harbor Atlas': { entries: { 0: LIGHTHOUSE, 1: TIDEWARDENS } }, 'Keeper Notes': { entries: { 7: LAMP_RULES } }, 'Voyage Log': { entries: {} } };
    host.settings.vectfox = {
        lorebase_enabled: true,
        vector_backend: 'qdrant',
        lorebase_books: { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['0', '1'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] }) },
    };
    settings = { enabled: true, lorebase_enabled: true, vector_backend: 'qdrant', lorebase_accuracy: 'high' };
    host.connection = ON_PROFILE;
    host.isWorldInfoSearchOn = false;
    host.unkeyedUids = new Set();
    host.keysReadError = null;
    host.unvectorizedUids = new Set();
    host.vectorsReadError = null;
    host.searchError = null;
    host.jevConnection = { ok: true, fields: { source: 'openrouter', model: 'typesafe/jev-1.14', secret_id: 'or-jev' } };
    host.jevAnswer = { yes: { e1: 0.64, e2: 0.2 }, inputTokens: 40, usd: 0.00002 };
    // A fresh generation record for each test: a plain reply.
    afterCommands('normal', {});
});

describe('which generations ask for lore (D8)', () => {
    it('asks nothing on impersonate or a quiet generation, and picks on a quiet-to-loud one', async () => {
        postChatCompletion.mockResolvedValue(pickOf());
        expect(await prepareLoreForReply('impersonate', settings)).toBeNull();
        afterCommands('quiet', { quietToLoud: false });
        expect(await prepareLoreForReply('quiet', settings)).toBeNull();
        // A dry run reaches no interceptor, so it does not stand in for the generation that does.
        afterCommands('quiet', { quietToLoud: true }, true);
        expect(await prepareLoreForReply('quiet', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();

        afterCommands('quiet', { quietToLoud: true });
        expect(await prepareLoreForReply('quiet', settings)).toMatchObject({ picks: [], failures: [] });
        expect(postChatCompletion).toHaveBeenCalledTimes(1);
    });

    it('picks on normal sends, swipes, regenerates and continues', async () => {
        postChatCompletion.mockResolvedValue(pickOf());
        for (const type of ['normal', 'swipe', 'regenerate', 'continue']) {
            afterCommands(type, {});
            await prepareLoreForReply(type, settings);
        }
        expect(postChatCompletion).toHaveBeenCalledTimes(4);
    });

    it('does nothing while VectFox is off', async () => {
        expect(await prepareLoreForReply('normal', { ...settings, enabled: false })).toBeNull();
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });
});

describe("LoreBase's switch and Vector Storage's World Info search (§5.9)", () => {
    it('picks nothing while LoreBase is off', async () => {
        expect(await prepareLoreForReply('normal', { ...settings, lorebase_enabled: false })).toBeNull();
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    it("asks before a reply's interceptors when the search is on again, and picks once the user turns it off", async () => {
        host.isWorldInfoSearchOn = true;
        choicePopup.mockResolvedValueOnce('vector-storage');
        postChatCompletion.mockResolvedValue(pickOf());

        await afterCommands('normal', {});
        expect(choicePopup).toHaveBeenCalledTimes(1);
        expect(turnOffVectorStorageWorldInfo).toHaveBeenCalledTimes(1);
        expect(await prepareLoreForReply('normal', settings)).toMatchObject({ picks: [], failures: [] });
    });

    it('sits out a reply whose question was closed, with both still on', async () => {
        host.isWorldInfoSearchOn = true;
        choicePopup.mockResolvedValueOnce(null);

        await afterCommands('normal', {});
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();
    });

    it('asks nothing on a quiet generation or a dry run, which are not replies', async () => {
        host.isWorldInfoSearchOn = true;
        await afterCommands('quiet', { quietToLoud: false });
        await afterCommands('normal', {}, true);
        expect(choicePopup).not.toHaveBeenCalled();
    });
});

describe('Fast and Cheap [Jev] (D16)', () => {
    it('asks Jev once about every keyed entry, asks Luna nothing, and sends its picks above 0.25 whole', async () => {
        const lore = await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'fast' });

        expect(postChatCompletion).not.toHaveBeenCalled();
        expect(askJev).toHaveBeenCalledTimes(1);
        const [fields, state, questions] = askJev.mock.calls[0];
        expect(fields).toEqual(host.jevConnection.fields);
        expect(state).toBe("The chat so far. The last message is the user's; the next reply answers it.\n\nKeeper Orrin: The lamp is lit.\n\nWren: Who keeps it tonight?");
        expect(questions.e1.instructions).toBe('Does the next reply need the lorebook entry "Lighthouse of Vell" (about: keys of Lighthouse of Vell)?');
        expect(Object.keys(questions)).toEqual(['e1', 'e2']);
        expect(lore.picks.map(pick => [pick.title, pick.yes])).toEqual([['Lighthouse of Vell', 0.64]]);
        expect(lore.reviewedPicks.map(({ title, uses, sentParts }) => ({ title, uses, sentParts }))).toEqual([{ title: 'Lighthouse of Vell', uses: 'whole', sentParts: [1, 2] }]);
    });

    it('searches nothing at 100 entries or fewer, and sends no more than the lore budget holds', async () => {
        // Two long entries, each under 1,000 tokens, together over it.
        const words = count => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
        host.books['Harbor Atlas'] = { entries: { 0: { ...LIGHTHOUSE, content: words(600) }, 1: { ...TIDEWARDENS, content: words(500) } } };
        host.jevAnswer = { yes: { e1: 0.64, e2: 0.5 } };
        const roomy = await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'fast' });
        expect(searchReplyPool).not.toHaveBeenCalled();
        expect(roomy.picks.map(pick => pick.title)).toEqual(['Lighthouse of Vell', 'Tidewardens']);
        expect(roomy.search).toEqual({ seats: 100, poolCount: null, seconds: null });

        // At the least budget, which a saved value below it reads as, the lighthouse, rated best, goes alone.
        const tight = await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'fast', lorebase_lore_budget_tokens: 1 });
        expect(tight.picks.map(pick => pick.title)).toEqual(['Lighthouse of Vell']);
    });

    describe('above 100 entries', () => {
        beforeEach(() => {
            const many = Object.fromEntries(Array.from({ length: 101 }, (_, uid) => [uid, { uid, comment: `Entry ${uid}`, content: `Text of entry ${uid}.` }]));
            host.books['Harbor Atlas'] = { entries: many };
            host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].selectedUids = Object.keys(many);
        });

        it("asks Jev only about the search's pool, the search given the books, the table and the scene's messages", async () => {
            host.jevAnswer = { yes: { e100: 0.9, e101: 0.1 } };
            const fast = { ...settings, lorebase_accuracy: 'fast' };
            const lore = await prepareLoreForReply('normal', fast);

            expect(searchReplyPool).toHaveBeenCalledTimes(1);
            const [books, contents, messages, searchSettings] = searchReplyPool.mock.calls[0];
            expect(books.map(book => book.bookName)).toEqual(['Harbor Atlas']);
            expect(contents).toHaveLength(101);
            expect(messages).toEqual([{ name: 'Keeper Orrin', text: 'The lamp is lit.' }, { name: 'Wren', text: 'Who keeps it tonight?' }]);
            expect(searchSettings).toBe(fast);
            expect(Object.keys(askJev.mock.calls[0][2])).toEqual(['e100', 'e101']);
            expect(lore.picks.map(pick => pick.title)).toEqual(['Entry 99']);
            expect(lore.search).toMatchObject({ seats: 100, poolCount: 2 });
        });

        it('leaves every selected entry out when the search fails, with the toast that asks to regenerate', async () => {
            host.searchError = new Error('[Qdrant] Hybrid query of 1 collections in vf_lorebase_rabbit failed: 500');
            const lore = await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'fast' });
            expect(askJev).not.toHaveBeenCalled();
            expect(lore.picks).toEqual([]);
            expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
            expect(globalThis.toastr.warning.mock.calls[0][0]).toMatch(/^LoreBase could not pick the lore for this reply, so none of the entries selected for LoreBase go in\. Regenerate the message to try again\. Details: the search failed: \[Qdrant\] Hybrid query/u);
            expect(notifyInvalidModel).not.toHaveBeenCalled();
        });

        it('raises the sticky popup, and no toast, when the search fails on the embedding setup', async () => {
            host.searchError = Object.assign(new Error('Embedding: the model "baai/bge-m9" is not known.'), { code: 'invalid_model_config' });
            await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'fast' });
            expect(notifyInvalidModel).toHaveBeenCalledWith('Embedding: the model "baai/bge-m9" is not known.');
            expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        });
    });

    it('says where to choose Jev\'s profile when none can run, and sends no selected entry', async () => {
        host.jevConnection = { ok: false, problem: 'Fast and Cheap [Jev] has no profile for Jev. Choose one in the Jev group of the LoreBase model card on the WorldInfo page.' };
        expect(await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'fast' })).toBeNull();
        expect(askJev).not.toHaveBeenCalled();
        expect(notifySetupIncomplete).toHaveBeenCalledWith('LoreBase', host.jevConnection.problem);
    });
});

describe('Try a pick (§5.10)', () => {
    it("picks for the open chat's next reply with no reply generation before it, and hands the tester a try's report", async () => {
        // The last generation was not a reply, which a try does not need.
        afterCommands('impersonate', {});
        postChatCompletion.mockResolvedValueOnce(pickOf(1)).mockResolvedValueOnce(reviewOf('most'));

        expect(await tryLoreBasePick(settings)).toEqual({ problem: null });
        expect(postChatCompletion).toHaveBeenCalledTimes(2);
        expect(recordReplyReport).toHaveBeenCalledTimes(1);
        expect(recordReplyReport.mock.calls[0][0]).toMatchObject({ type: 'try', isReply: false, accuracy: 'high' });
        expect(recordReplyReport.mock.calls[0][0].lore.picks.map(pick => pick.title)).toEqual(['Lighthouse of Vell']);
        // Nothing is kept for a World Info scan: a try sends no reply.
        expect(keepReplyScan).not.toHaveBeenCalled();
    });

    it('asks Jev on Fast and Cheap [Jev], as a reply would', async () => {
        expect(await tryLoreBasePick({ ...settings, lorebase_accuracy: 'fast' })).toEqual({ problem: null });
        expect(askJev).toHaveBeenCalledTimes(1);
        expect(postChatCompletion).not.toHaveBeenCalled();
        expect(recordReplyReport.mock.calls[0][0]).toMatchObject({ type: 'try', isReply: false, accuracy: 'fast' });
    });

    it('says why it picked nothing: LoreBase off, off Qdrant, no ready selection, or no user message', async () => {
        expect(await tryLoreBasePick({ ...settings, lorebase_enabled: false })).toEqual({ problem: 'Use LoreBase is off.' });
        expect(await tryLoreBasePick({ ...settings, vector_backend: 'standard' })).toEqual({ problem: 'LoreBase runs on the Qdrant backend only.' });
        host.unkeyedUids = new Set(['Harbor Atlas/0', 'Harbor Atlas/1']);
        expect(await tryLoreBasePick(settings)).toEqual({ problem: 'No lorebook locked to this chat or its character has selected entries with their keys and vectors.' });
        host.unkeyedUids = new Set();
        host.context.chat = [{ name: 'Keeper Orrin', mes: 'Welcome to Vell.', is_user: false }];
        expect(await tryLoreBasePick(settings)).toEqual({ problem: 'The chat holds no user message for a reply to answer.' });
        expect(postChatCompletion).not.toHaveBeenCalled();
        expect(recordReplyReport).not.toHaveBeenCalled();
    });

    it('returns a keys read that failed as its problem, logged, and never throws', async () => {
        host.keysReadError = new Error("Similharity could not read LoreBase's keys (HTTP 500): Qdrant is down");
        expect(await tryLoreBasePick(settings)).toEqual({ problem: "Similharity could not read LoreBase's keys (HTTP 500): Qdrant is down" });
        expect(log.warn).toHaveBeenCalledWith('LoreBase: trying a pick failed:', host.keysReadError);
    });
});

describe('the books taking part (D11)', () => {
    it("reads only the books SillyTavern loads that are locked to this chat or character, each with its selected entries", async () => {
        host.charLore = [{ name: 'keeper-orrin', extraBooks: ['Tide Tables'] }];
        host.books['Tide Tables'] = { entries: { 2: { uid: 2, comment: 'Neap Tide', content: 'Neap tides come twice a month.' } } };
        host.books['Unloaded Book'] = { entries: { 0: { uid: 0, comment: 'Far Isles', content: 'Far to the west.' } } };
        host.settings.vectfox.lorebase_books = {
            'Harbor Atlas': oneSelectionRecord({ selectedUids: ['1'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] }),
            'Keeper Notes': oneSelectionRecord({ selectedUids: ['7'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] }),
            // Selected but locked elsewhere, and selected and locked but not loaded by SillyTavern.
            'Tide Tables': oneSelectionRecord({ selectedUids: ['2'], pinnedSections: [], lockedToChatIds: ['chat-other'], lockedToCharacterAvatars: [] }),
            'Unloaded Book': oneSelectionRecord({ selectedUids: ['0'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] }),
        };
        postChatCompletion.mockResolvedValue(pickOf());
        await prepareLoreForReply('normal', settings);

        expect(pickTable(0)).toBe('1. Tidewardens (keys of Tidewardens)\n2. Lamp Rules (keys of Lamp Rules)');
        expect(loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['Harbor Atlas', 'Keeper Notes']);
    });

    it("reads a book's selection in use here alone, the chat's lock before the character's, and leaves a book with none in use to its keys", async () => {
        const harbor = oneSelectionRecord({ selectedUids: ['0'], lockedToCharacterAvatars: ['keeper-orrin.png'] });
        harbor.selections.push({ id: 'night', name: 'Night watch', selectedUids: ['1'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] });
        const keeper = oneSelectionRecord({ selectedUids: ['7'] });
        keeper.selections.push({ id: 'elsewhere', name: 'Elsewhere', selectedUids: ['7'], pinnedSections: [], lockedToChatIds: ['chat-other'], lockedToCharacterAvatars: [] });
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': harbor, 'Keeper Notes': keeper };
        postChatCompletion.mockResolvedValue(pickOf());
        await prepareLoreForReply('normal', settings);

        expect(pickTable(0)).toBe('1. Tidewardens (keys of Tidewardens)');
        expect(loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['Harbor Atlas']);
    });

    it('leaves out a selected entry whose keys are not written yet, so it sends nothing (D17)', async () => {
        host.unkeyedUids = new Set(['Harbor Atlas/0']);
        postChatCompletion.mockResolvedValue(pickOf());
        await prepareLoreForReply('normal', settings);

        expect(pickTable(0)).toBe('1. Tidewardens (keys of Tidewardens)');
    });

    it('leaves out a selected entry with keys but no vectors from the embedding model set now (§4.4)', async () => {
        host.unvectorizedUids = new Set(['Harbor Atlas/1']);
        postChatCompletion.mockResolvedValue(pickOf());
        await prepareLoreForReply('normal', settings);

        expect(pickTable(0)).toBe('1. Lighthouse of Vell (keys of Lighthouse of Vell)');
    });

    it('runs no pick when no selected entry is ready', async () => {
        host.unkeyedUids = new Set(['Harbor Atlas/0']);
        host.unvectorizedUids = new Set(['Harbor Atlas/1']);
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();
    });

    it('goes on without the selected entries when their vectors cannot be read, with the toast a failed pick shows', async () => {
        host.vectorsReadError = new Error('[Qdrant] Failed to list chunks: 500 Server Error - Qdrant is down');
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('none of the entries selected for LoreBase go in');
    });

    it('says once per chat which selected entries it leaves out for not being ready, and again when their number changes', async () => {
        // A chat of its own, so what an earlier reply said in another chat does not count here.
        host.chatId = 'chat-unkeyed-once';
        host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].lockedToChatIds = ['chat-unkeyed-once'];
        host.unkeyedUids = new Set(['Harbor Atlas/0']);
        postChatCompletion.mockResolvedValue(pickOf());
        const unkeyedToasts = () => globalThis.toastr.warning.mock.calls.filter(([message]) => message.includes('no keys or vectors'));

        await prepareLoreForReply('normal', settings);
        expect(unkeyedToasts()).toEqual([['1 selected entry of the lorebook "Harbor Atlas" has no keys or vectors yet, so LoreBase leaves it out of every '
            + "reply. Generate all on VectFox's WorldInfo page writes what it lacks.", 'VectFox — LoreBase left lore out', { timeOut: 30000, extendedTimeOut: 10000 }]]);
        await prepareLoreForReply('normal', settings);
        expect(unkeyedToasts()).toHaveLength(1);

        // No selected entry ready, the other without vectors: nothing is picked, and the reply still says why.
        host.unvectorizedUids = new Set(['Harbor Atlas/1']);
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(unkeyedToasts()).toHaveLength(2);
        expect(unkeyedToasts()[1][0]).toContain('2 selected entries of the lorebook "Harbor Atlas" have no keys or vectors yet');
    });

    it('says it again in another chat, and nothing in a chat whose selected entries are all ready', async () => {
        host.chatId = 'chat-unkeyed-first';
        host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].lockedToChatIds = ['chat-unkeyed-first', 'chat-unkeyed-second'];
        host.unkeyedUids = new Set(['Harbor Atlas/1']);
        postChatCompletion.mockResolvedValue(pickOf());
        const unkeyedToasts = () => globalThis.toastr.warning.mock.calls.filter(([message]) => message.includes('no keys or vectors'));

        await prepareLoreForReply('normal', settings);
        host.chatId = 'chat-unkeyed-second';
        await prepareLoreForReply('normal', settings);
        expect(unkeyedToasts()).toHaveLength(2);

        host.unkeyedUids = new Set();
        await prepareLoreForReply('normal', settings);
        expect(unkeyedToasts()).toHaveLength(2);
    });

    it('goes on without the selected entries when their keys cannot be read, with the toast a failed pick shows', async () => {
        host.keysReadError = new Error("Similharity could not read LoreBase's keys (HTTP 500): Qdrant is not set up");
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('none of the entries selected for LoreBase go in');
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('Qdrant is not set up');
    });

    it('keeps a book locked to a character through a rename, which gives the character a new avatar file name', async () => {
        host.settings.vectfox.lorebase_books = {
            'Keeper Notes': oneSelectionRecord({ selectedUids: ['7'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: ['keeper-orrin.png'] }),
        };
        host.handlers.character_renamed('keeper-orrin.png', 'keeper-orrin-the-elder.png');
        host.context.characters[3].avatar = 'keeper-orrin-the-elder.png';
        postChatCompletion.mockResolvedValue(pickOf());
        await prepareLoreForReply('normal', settings);

        expect(host.settings.vectfox.lorebase_books['Keeper Notes'].selections[0].lockedToCharacterAvatars).toEqual(['keeper-orrin-the-elder.png']);
        expect(loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['Keeper Notes']);
    });

    it('keeps a book locked to a chat through its rename, under the name the server saved its file as', async () => {
        // SillyTavern announces the name as typed; its server saved the file without the colon and question mark.
        await host.handlers.chat_renamed({ avatarId: 'keeper-orrin.png', groupId: undefined, oldFileName: 'chat-harbor.jsonl', newFileName: 'Harbor: the storm?.jsonl' });
        host.chatId = 'Harbor the storm';
        postChatCompletion.mockResolvedValue(pickOf());
        await prepareLoreForReply('normal', settings);

        expect(getSanitizedFilename).toHaveBeenCalledWith('Harbor: the storm?.jsonl');
        expect(host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].lockedToChatIds).toEqual(['Harbor the storm']);
        expect(loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['Harbor Atlas']);
    });

    it("leaves a renamed chat's locks where they were, with a warning, when the server cannot say the saved name", async () => {
        const failure = new Error('Not Found');
        getSanitizedFilename.mockRejectedValueOnce(failure);
        await host.handlers.chat_renamed({ avatarId: 'keeper-orrin.png', groupId: undefined, oldFileName: 'chat-harbor.jsonl', newFileName: 'chat-harbor-storm.jsonl' });

        expect(host.settings.vectfox.lorebase_books['Harbor Atlas'].selections[0].lockedToChatIds).toEqual(['chat-harbor']);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('saved under'), failure);
    });

    it('asks nothing when no book taking part has a selected entry LoreBase decides', async () => {
        host.settings.vectfox.lorebase_books = { 'Harbor Atlas': oneSelectionRecord({ selectedUids: ['0'], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] }) };
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        host.settings.vectfox.lorebase_books = {};
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('asks nothing when the chat holds no user message for the reply to answer', async () => {
        host.context.chat = [{ name: 'Keeper Orrin', mes: 'Welcome to Vell.', is_user: false }];
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(postChatCompletion).not.toHaveBeenCalled();
    });
});

describe("the calls on LoreBase's connection", () => {
    it('sends no temperature, and the pick and each review at low effort', async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        const lore = await prepareLoreForReply('normal', settings);

        const sent = {
            provider: 'connection_profile', model: 'openai/gpt-6-luna', connectionProfileId: 'p-harbor', connectionProfilePage: 'WorldInfo',
            timeoutMs: 30000, contextLabel: 'LoreBase', shouldNotifyProviderFailure: false, sendTemperature: false, tokenLimitParameter: 'max_tokens',
        };
        const [pickRequest, reviewRequest] = postChatCompletion.mock.calls.map(([request]) => request);
        expect(pickRequest).toMatchObject({ ...sent, maxTokens: 9500, reasoningEffort: 'low' });
        expect(reviewRequest).toMatchObject({ ...sent, maxTokens: 10000, reasoningEffort: 'low' });
        for (const request of [pickRequest, reviewRequest]) expect(request).not.toHaveProperty('temperature');
        expect(userContent(1)).toContain('Entry 1: Tidewardens\nYour reason: it is asked after You wanted: who keeps it');
        expect(lore.reviewedPicks).toMatchObject([{ bookName: 'Harbor Atlas', uid: 1, uses: 'most', sentParts: [1, 2] }]);
    });

    it('runs High Accuracy on a value the dropdown no longer offers, and reports it so', async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        await prepareLoreForReply('normal', { ...settings, lorebase_accuracy: 'default' });
        expect(postChatCompletion).toHaveBeenCalledTimes(2);
        expect(askJev).not.toHaveBeenCalled();
        expect(recordReplyReport.mock.calls[0][0].accuracy).toBe('high');
    });

    it('reads the answer, not the reasoning a thinking model writes before it', async () => {
        postChatCompletion.mockResolvedValueOnce({ content: `<think>Maybe ${JSON.stringify({ entries: [{ number: 2 }] })}</think>${pickOf(1).content}`, cutReason: null })
            .mockResolvedValueOnce(reviewOf('some'));
        const lore = await prepareLoreForReply('normal', settings);
        expect(stripReasoningBlocks).toHaveBeenCalled();
        expect(lore.picks.map(pick => pick.title)).toEqual(['Lighthouse of Vell']);
    });

    it('says where to fix a connection that cannot run, and asks nothing', async () => {
        host.connection = { ok: false, reason: 'connection_profile', problem: 'LoreBase: no connection profile is chosen. Choose one on the WorldInfo page.' };
        expect(await prepareLoreForReply('normal', settings)).toBeNull();
        expect(notifySetupIncomplete).toHaveBeenCalledWith('LoreBase',
            'LoreBase: no connection profile is chosen. Choose one on the WorldInfo page. Until then the entries selected for LoreBase stay out of replies.');
        expect(postChatCompletion).not.toHaveBeenCalled();
    });
});

describe('a turn whose call fails goes on without that lore (D14)', () => {
    it('shows the yellow toast for a failed pick, and the reply still goes', async () => {
        postChatCompletion.mockRejectedValueOnce(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
        const lore = await prepareLoreForReply('normal', settings);
        expect(lore).toMatchObject({ picks: [], reviewedPicks: [], failures: [{ step: 'pick' }] });
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(
            'LoreBase could not pick the lore for this reply, so none of the entries selected for LoreBase go in. '
            + 'Regenerate the message to try again. Details: it did not answer within 30 seconds',
            'VectFox — LoreBase left lore out', { timeOut: 30000, extendedTimeOut: 10000 });
    });

    it('names the entry whose review failed, while the other pick goes in', async () => {
        postChatCompletion.mockImplementation(async ({ messages }) => {
            if (messages[1].content.includes('Pick the entries')) return pickOf(1, 2);
            if (messages[1].content.includes('Entry 1: Lighthouse of Vell')) return { content: 'I would rather not say.', cutReason: null };
            return reviewOf('most');
        });
        const lore = await prepareLoreForReply('normal', settings);
        expect(lore.reviewedPicks.map(reviewed => reviewed.title)).toEqual(['Tidewardens']);
        expect(globalThis.toastr.warning.mock.calls[0][0]).toBe('LoreBase could not review its pick "Lighthouse of Vell", so it is left out of this reply '
            + 'while the other picks go in. Regenerate the message to try again. Details: its answer could not be read');
    });

    it('sends a model the provider refuses to the configuration toast, since regenerating cannot fix it', async () => {
        const refused = Object.assign(new Error('LoreBase: OpenRouter has no model "openai/gpt-6-lunar". Check Model in the profile.'), { kind: 'model_config' });
        postChatCompletion.mockRejectedValueOnce(refused);
        await prepareLoreForReply('normal', settings);
        expect(notifyInvalidModel).toHaveBeenCalledWith(refused.message);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });
});

describe('the World Info scan that follows the reply (§5.7)', () => {
    const scannedBooks = () => ({
        globalLore: Object.values(host.books['Harbor Atlas'].entries).map(entry => ({ ...entry, world: 'Harbor Atlas', key: [entry.comment.toLowerCase()] })),
        characterLore: [], chatLore: [], personaLore: [],
    });
    const scan = async () => {
        const loaded = scannedBooks();
        await host.handlers.worldinfo_entries_loaded(loaded);
        return loaded;
    };
    const forcedActivations = () => eventSource.emit.mock.calls.filter(([event]) => event === 'worldinfo_force_activate').map(([, forced]) => forced);

    const noRetrieval = async () => {};
    const tidewardensSent = [{
        ...TIDEWARDENS, world: 'Harbor Atlas', key: ['tidewardens'], group: '', useProbability: false,
        content: `<VectLorebook>\n<Tidewardens>\n${TIDEWARDENS.content}\n</Tidewardens>\n</VectLorebook>`,
    }];

    it('sends the pick the review kept, and keeps every selected entry from firing by its keys', async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        await prepareLoreBesideRetrieval('normal', settings, noRetrieval);
        const loaded = await scan();

        expect(loaded.globalLore.map(entry => entry.key)).toEqual([[], []]);
        expect(forcedActivations()).toEqual([tidewardensSent]);
    });

    it('holds the picks only once the retrieval beside them is done, so a scan before then gets none of them (§6.8)', async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        let finishRetrieval;
        const interceptor = prepareLoreBesideRetrieval('normal', settings, () => new Promise(resolve => { finishRetrieval = resolve; }));
        // The pick and its review are done, and reported, while the retrieval still runs.
        await vi.waitFor(() => expect(log.lifecycle).toHaveBeenCalled());
        const between = await scan();
        expect(forcedActivations()).toEqual([]);
        expect(between.globalLore.map(entry => entry.key)).toEqual([[], []]);

        finishRetrieval();
        await interceptor;
        await scan();
        expect(forcedActivations()).toEqual([tidewardensSent]);
    });

    it('holds the picks when the retrieval beside them fails, and throws its failure again, as the reply goes on', async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        const timedOut = new Error('EventBase retrieval timed out');
        await expect(prepareLoreBesideRetrieval('normal', settings, async () => { throw timedOut; })).rejects.toBe(timedOut);
        await scan();
        expect(forcedActivations()).toEqual([tidewardensSent]);
    });

    it("sends no selected entry on a quiet generation's scan, which gets no pick (D8)", async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        await prepareLoreBesideRetrieval('normal', settings, noRetrieval);
        afterCommands('quiet', { quietToLoud: false });
        await prepareLoreBesideRetrieval('quiet', settings, noRetrieval);
        const loaded = await scan();

        expect(forcedActivations()).toEqual([]);
        expect(loaded.globalLore.map(entry => entry.key)).toEqual([[], []]);
    });

    it('sends none of the selected entries when the pick fails (D14)', async () => {
        postChatCompletion.mockRejectedValueOnce(new Error('Too Many Requests'));
        await prepareLoreBesideRetrieval('normal', settings, noRetrieval);
        await scan();
        expect(forcedActivations()).toEqual([]);
    });
});

describe('the tester (§5.10)', () => {
    const replyChat = [{ name: 'Wren', mes: 'Who keeps it tonight?' }];
    const noRetrieval = async () => {};

    it('follows the replies from start-up', () => {
        expect(testerStartUps).toBe(1);
    });

    it("hands it each reply's lore with the books read, the type, the Accuracy and the seconds, then what the scan reads", async () => {
        postChatCompletion.mockResolvedValueOnce(pickOf(2)).mockResolvedValueOnce(reviewOf('most'));
        await prepareLoreBesideRetrieval('swipe', settings, noRetrieval, { chat: replyChat, maxContext: 8000 });

        expect(recordReplyReport).toHaveBeenCalledTimes(1);
        const [{ lore, books, type, accuracy, seconds }] = recordReplyReport.mock.calls[0];
        expect(lore.picks.map(pick => pick.title)).toEqual(['Tidewardens']);
        expect(books).toEqual([{
            bookName: 'Harbor Atlas', entries: [LIGHTHOUSE, TIDEWARDENS], pinnedSections: [],
            keysByUid: { 0: ['keys of Lighthouse of Vell'], 1: ['keys of Tidewardens'] },
        }]);
        expect([type, accuracy]).toEqual(['swipe', 'high']);
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(keepReplyScan).toHaveBeenCalledWith(lore, { chat: replyChat, maxContext: 8000, type: 'swipe' });
    });

    it('hands it nothing to report for a generation LoreBase picks nothing for', async () => {
        afterCommands('quiet', { quietToLoud: false });
        await prepareLoreBesideRetrieval('quiet', settings, noRetrieval, { chat: replyChat, maxContext: 8000 });
        expect(recordReplyReport).not.toHaveBeenCalled();
        expect(keepReplyScan).toHaveBeenCalledWith(null, { chat: replyChat, maxContext: 8000, type: 'quiet' });
    });
});
