/**
 * @vitest-environment jsdom
 *
 * Vectorize Content's wiring (src/features/eventbase/content-vectorizer.js), driven as a user would: the dialog opens on
 * the Chat page with the open chat, or on a chat file when none is open; a chat file picked or dropped on the Source
 * card loads, a drop never reaching SillyTavern's own; the window sliders save VectFox's settings and Text cleaning sets
 * its one preset; a run says on its page what it needs; a chat's Vectorize reads a chat with no collection into its
 * first, and asks Catch up, Start over or New collection on one whose collection is in use (§2.1 of
 * vectfox-multi-collection-per-chat.md), each read at the window size its collection keeps (§2.7), and a chat file's
 * asks before reading it again; the dialog opened on New collection makes one; the dialog closes after a clean read of
 * something new and otherwise stays open saying why; Stop ends a run; the close is announced once, after any run; the
 * Action page's Sync chat reads what EventBase has not read once the user confirms, and says in a dialog when there is
 * nothing to read, the AutoSync page's Up to date included, or a run found nothing new; the auto-sync catch-up reads
 * the open chat's new messages with no dialog. A run ends at the End message when one is set, and with Read windows
 * already read again on, Vectorize reads the stretch again after a red confirm of what it replaces and costs
 * (eventbase-read-range-again.md).
 */
/* global document, window, toastr -- this file runs under the jsdom environment, and stubs SillyTavern's toastr per test */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    answer: true,
    dialogs: [],
    root: { vectfox: {} },
    context: {},
    cleaningPreset: 'light',
    priorWindows: false,
    runResult: null,
    syncStatus: null,
    llmCheck: { ok: true },
    ownCollections: [],
    chosenCollection: null,
    choice: null,
    keptWindowSize: undefined,
    savedHashes: [11, 12, 13],
    emptyError: null,
    readAgainPlan: null,
    readAgainVerdict: null,
}));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.root, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({
    // A dialog is on the page while open; closing asks its canClose, as SillyTavern's Close does.
    openPanelPopup: vi.fn((root, { canClose } = {}) => {
        document.body.append(root);
        return new Promise((resolve) => { host.dialogs.push({ root, canClose, resolve }); });
    }),
    closePanelPopup: vi.fn(async (root) => {
        const dialog = host.dialogs.find(each => each.root === root);
        if (!dialog || (dialog.canClose && !(await dialog.canClose()))) return;
        host.dialogs.splice(host.dialogs.indexOf(dialog), 1);
        root.remove();
        dialog.resolve();
    }),
    confirmPopup: vi.fn(async () => host.answer),
    choicePopup: vi.fn(async () => host.choice),
    noticePopup: vi.fn(async () => {}),
}));
vi.mock('../src/features/eventbase/eventbase-chat-sync.js', () => ({
    runEventBaseOnOpenChat: vi.fn(async (settings, signal, run) => {
        // A run into a new collection puts it in use as it starts (runEventBaseIngestion, through useChatCollection).
        if (run?.collectionIdOverride) {
            host.ownCollections = [
                ...host.ownCollections.map(collection => ({ ...collection, isLockedHere: false })),
                { registryKey: `qdrant:${run.collectionIdOverride}`, name: 'Harbor Keeper 2', isLockedHere: true },
            ];
        }
        if (host.runResult instanceof Error) throw host.runResult;
        // A run that goes on until stopped, then returns what it saved.
        if (host.runResult === 'until-stopped') {
            await new Promise(resolve => signal.addEventListener('abort', resolve));
            return { eventsExtracted: 1, windowsProcessed: 1, windowsSkipped: 0 };
        }
        return host.runResult;
    }),
}));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    getVectorizationTip: () => (host.priorWindows ? 120 : undefined),
    readEventBaseProgress: () => ({}),
    prepareForFreshExtraction: vi.fn(async () => ({ skipTipFallback: true })),
    getCollectionWindowSize: vi.fn(() => host.keptWindowSize),
    setCollectionWindowSize: vi.fn(),
    emptyEventBaseCollection: vi.fn(async () => {
        if (host.emptyError) throw host.emptyError;
        return host.savedHashes.length;
    }),
}));
// The chat's collection in use and its own collections (the one route, collectionInUse), the question asked while none
// is in use, and New collection's collection (eventbase-collection-in-use.test.js).
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    NEW_COLLECTION: '+new',
    collectionInUse: () => {
        const lockedHere = host.ownCollections.filter(collection => collection.isLockedHere);
        const collection = lockedHere.length === 1 ? lockedHere[0] : null;
        const reason = collection ? null : host.ownCollections.length ? 'none-in-use' : 'no-collection';
        return { collection, reason, collections: host.ownCollections, lockedElsewhere: [], backend: 'qdrant' };
    },
    // The one locked here, which the question answers without asking, else the answer given.
    askWhichChatCollection: vi.fn(async () => host.ownCollections.find(collection => collection.isLockedHere)?.registryKey ?? host.chosenCollection),
    resolveEventBaseRunTarget: (settings, chatUUID) => ({ collectionId: `vf_eventbase_${chatUUID}`, registryKey: `qdrant:vf_eventbase_${chatUUID}` }),
    startNewChatCollection: vi.fn(() => ({ registryKey: 'qdrant:vf_eventbase_chat-uuid_mh3k2x1a', collectionId: 'vf_eventbase_chat-uuid_mh3k2x1a', name: 'Harbor Keeper 2' })),
}));
vi.mock('../src/features/vector-backend/index.js', () => ({ getSavedHashes: vi.fn(async () => host.savedHashes) }));
vi.mock('../src/features/eventbase/eventbase-workflow.js', () => ({
    runEventBaseIngestion: vi.fn(),
    countUnfinishedWindows: () => 0,
    notifyUnfinishedWindows: vi.fn(),
    getChatAutoSyncStatus: vi.fn(async () => host.syncStatus),
}));
vi.mock('../src/features/llm-provider/index.js', () => ({ validateLLMConfig: () => host.llmCheck }));
// What a stretch read again holds and costs, and the link steps after it (eventbase-read-again.test.js holds them).
vi.mock('../src/features/eventbase/eventbase-read-again.js', () => ({
    describeReadingAgain: vi.fn(async () => host.readAgainPlan),
    finishReadingAgain: vi.fn(async () => host.readAgainVerdict),
}));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => '' }));
vi.mock('../src/shared/collection-ids.js', () => ({
    getChatUUID: () => 'chat-uuid',
    buildArchiveEventCollectionId: ({ filenameCharName, archiveUUID }) => `vf_archiveevent_${filenameCharName}_${archiveUUID}`,
    buildRegistryKey: collectionId => `qdrant:${collectionId}`,
    parseRegistryKey: registryKey => ({ backend: 'qdrant', collectionId: registryKey.replace(/^qdrant:/, '') }),
}));
vi.mock('../src/features/text-cleaning/index.js', async () => ({
    presetDescription: (await vi.importActual('../src/features/text-cleaning/text-cleaning-dialog-core.js')).presetDescription,
    cleaningPresetChoices: () => [
        { id: 'light', name: 'Light', description: 'Strips markup.' },
        { id: 'custom', name: 'Custom', description: 'Your own built-ins and custom patterns.' },
    ],
    getCleaningSettings: () => ({ selectedPreset: host.cleaningPreset }),
    chooseCleaningPreset: vi.fn(),
    openTextCleaningDialog: vi.fn(async () => {}),
}));
// requestCancel does nothing here, as on a panel still holding the last run's verdict.
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { setCancelHandler: vi.fn(), clearCancelHandler: vi.fn(), show: vi.fn(), complete: vi.fn(), requestCancel: vi.fn() } }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ isInvalidModelConfigError: () => false, notifyInvalidModel: vi.fn() }));
vi.mock('../src/shared/pick-files.js', () => ({ pickFiles: vi.fn(async () => []) }));

const { openContentVectorizer, backfillCurrentChatWithProgress, syncOpenChat } = await import('../src/features/eventbase/content-vectorizer.js');
const { runEventBaseOnOpenChat } = await import('../src/features/eventbase/eventbase-chat-sync.js');
const { runEventBaseIngestion } = await import('../src/features/eventbase/eventbase-workflow.js');
const { askWhichChatCollection, startNewChatCollection } = await import('../src/features/eventbase/eventbase-chat-collections.js');
const { emptyEventBaseCollection, setCollectionWindowSize } = await import('../src/features/eventbase/eventbase-store.js');
const { chooseCleaningPreset, openTextCleaningDialog } = await import('../src/features/text-cleaning/index.js');
const { pickFiles } = await import('../src/shared/pick-files.js');
const { choicePopup, confirmPopup, closePanelPopup, noticePopup } = await import('../src/sillytavern/popup.js');
const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { describeReadingAgain, finishReadingAgain } = await import('../src/features/eventbase/eventbase-read-again.js');
const { readAgainConfirmLines } = await import('../src/features/eventbase/eventbase-read-again-core.js');

const $id = id => document.getElementById(id);
const page = () => $id('vectfox_cv_page_chat');
const actionOn = name => page().querySelector(`[data-cv-action="${name}"]`);
const partOf = name => page().querySelector(`[data-cv-part="${name}"]`);
const fileRegion = () => page().querySelector('[data-cv-region="file"]');
const runState = () => page().querySelector('[data-cv-hint="run-state"]').textContent;
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};
const closed = [];

async function closeEveryDialog() {
    for (const dialog of [...host.dialogs]) await closePanelPopup(dialog.root);
    await vi.waitFor(() => expect(host.dialogs).toHaveLength(0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(async () => {
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
    window.matchMedia = () => ({ matches: false });
    await closeEveryDialog();
    document.body.innerHTML = '';
    closed.length = 0;
    host.answer = true;
    host.cleaningPreset = 'light';
    host.priorWindows = false;
    host.runResult = { eventsExtracted: 3, windowsProcessed: 1, windowsSkipped: 0 };
    host.syncStatus = { state: 'partial', chatMessageCount: 40, vectorizationTip: 30, unfinishedWindowCount: 0 };
    host.llmCheck = { ok: true };
    host.ownCollections = [];
    host.chosenCollection = null;
    host.choice = null;
    host.keptWindowSize = undefined;
    host.savedHashes = [11, 12, 13];
    host.emptyError = null;
    host.readAgainPlan = {
        problem: '',
        collectionId: 'vf_eventbase_chat-uuid',
        collectionName: 'Harbor Keeper',
        firstMessage: 37,
        lastMessage: 90,
        windowCount: 9,
        heldCount: 21,
        linkingInCount: 4,
        extraction: { model: 'deepseek/deepseek-v4 on OpenRouter', inputTokens: 23400, costUsd: 0.05 },
        links: { model: 'Linker (gpt-6-luna), a connection profile', estimate: { eventCount: 25, inputTokens: 45250, outputTokens: 8000, minutes: 1, costUsd: null } },
        willLink: true,
        waitReason: '',
        stepTitles: { windows: 'Reading again, step 1 of 3: windows', newEvents: 'Reading again, step 2 of 3: linking new events', movedLinks: 'Reading again, step 3 of 3: deciding moved links again' },
    };
    host.readAgainVerdict = { isSuccess: true, message: 'Read 9 of 9 windows again, 19 events found.' };
    host.root.vectfox = { eventbase_window_size: 4, eventbase_window_overlap: 1 };
    host.context = {
        chatId: 'chat.jsonl',
        chat: [{ mes: 'Open the gate.' }, { mes: 'It opens.' }],
        name2: 'Harbor Keeper',
    };
    vi.clearAllMocks();
});

document.addEventListener('vectfox:content-vectorizer-closed', () => closed.push('closed'));

describe('opening', () => {
    it('opens on the Chat page with the open chat, the saved window size and overlap, and three windows at once', () => {
        openContentVectorizer();
        expect(page().hidden).toBe(false);
        expect($id('vectfox_cv_chat_source_choice').value).toBe('this');
        expect(partOf('this').textContent).toContain('Harbor Keeper');
        expect($id('vectfox_cv_chat_window_size').value).toBe('4');
        expect($id('vectfox_cv_chat_window_overlap').value).toBe('1');
        expect($id('vectfox_cv_chat_parallel_windows').value).toBe('3');
    });

    it('opens on a chat file while no chat is open', () => {
        host.context = { ...host.context, chatId: undefined, chat: [] };
        openContentVectorizer();
        expect($id('vectfox_cv_chat_source_choice').value).toBe('file');
        expect(partOf('this').hidden).toBe(true);
        expect(partOf('file').hidden).toBe(false);
    });
});

describe('a chat file', () => {
    // jsdom has no DataTransfer and its File no text(), so the pick and the drop carry plain ones; SillyTavern listens
    // for drops on the page body.
    const fileOf = (name, text) => ({ name, text: async () => text });
    const dropOn = (element, file) => {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
        element.dispatchEvent(event);
    };
    const chatFile = [
        { chat_metadata: { integrity: 'harbor-file' }, user_name: 'Rook', character_name: 'Harbor Keeper' },
        { name: 'Harbor Keeper', is_user: false, mes: 'The gate is shut.' },
        { name: 'Rook', is_user: true, mes: 'Open it.' },
        { name: 'Harbor Keeper', is_user: false, mes: 'It opens.' },
        { name: 'Rook', is_user: true, mes: 'Go in.' },
    ].map(line => JSON.stringify(line)).join('\n');
    const reachedBody = [];
    const recordBodyDrop = () => reachedBody.push('drop');
    beforeEach(() => {
        reachedBody.length = 0;
        document.body.addEventListener('drop', recordBodyDrop);
        return () => document.body.removeEventListener('drop', recordBodyDrop);
    });

    it('loads one picked with Choose file, which asks only for the chat files it takes', async () => {
        pickFiles.mockResolvedValueOnce([fileOf('harbor.jsonl', chatFile)]);
        openContentVectorizer();
        change($id('vectfox_cv_chat_source_choice'), 'file');
        actionOn('choose-file').click();
        await vi.waitFor(() => expect(fileRegion().textContent).toContain('harbor.jsonl'));
        expect(pickFiles).toHaveBeenCalledWith({ accept: '.txt,.jsonl,.json' });
        expect(fileRegion().textContent).toContain('Messages: 4');
        expect(fileRegion().textContent).toContain('Character: Harbor Keeper');
    });

    it('loads on the Source card as a picked file, and SillyTavern never sees it', async () => {
        openContentVectorizer();
        dropOn($id('vectfox_cv_chat_source_card'), fileOf('harbor.jsonl', chatFile));
        await vi.waitFor(() => expect(fileRegion().textContent).toContain('harbor.jsonl'));
        expect($id('vectfox_cv_chat_source_choice').value).toBe('file');
        expect(partOf('file').hidden).toBe(false);
        expect(reachedBody).toEqual([]);
    });

    it('loads nothing dropped beside the Source card, and still stops at the dialog', async () => {
        openContentVectorizer();
        dropOn($id('vectfox_cv_chat_windows_card'), fileOf('harbor.jsonl', chatFile));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect($id('vectfox_cv_chat_source_choice').value).toBe('this');
        expect(fileRegion().textContent).toBe('');
        expect(reachedBody).toEqual([]);
    });

    it('hands EventBase the whole chat file and the message to start at, so its windows count from the file\'s first message', async () => {
        openContentVectorizer();
        dropOn($id('vectfox_cv_chat_source_card'), fileOf('harbor.jsonl', chatFile));
        await vi.waitFor(() => expect(fileRegion().textContent).toContain('harbor.jsonl'));

        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseIngestion).toHaveBeenCalledTimes(1));
        expect(runEventBaseIngestion.mock.calls[0][0]).toMatchObject({ startFromMessage: 1, chatUUID: 'harbor-file', collectionIdOverride: 'vf_archiveevent_harbor_harbor-file' });
        expect(runEventBaseIngestion.mock.calls[0][0].messages).toHaveLength(4);
        await vi.waitFor(() => expect(actionOn('resume').disabled).toBe(false));

        change($id('vectfox_cv_chat_start_from'), '3');
        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseIngestion).toHaveBeenCalledTimes(2));
        expect(runEventBaseIngestion.mock.calls[1][0]).toMatchObject({ startFromMessage: 3 });
        expect(runEventBaseIngestion.mock.calls[1][0].messages).toHaveLength(4);
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it("asks before reading a file EventBase has read again, a window read again replacing its events, at the dialog's window size", async () => {
        host.priorWindows = true;
        host.answer = false;
        openContentVectorizer();
        dropOn($id('vectfox_cv_chat_source_card'), fileOf('harbor.jsonl', chatFile));
        await vi.waitFor(() => expect(fileRegion().textContent).toContain('harbor.jsonl'));
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        expect(confirmPopup.mock.calls[0][0].map(line => line.text)).toContain('Each window it reads again replaces the events it had, so they do not repeat.');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(runEventBaseIngestion).not.toHaveBeenCalled();

        host.answer = true;
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseIngestion).toHaveBeenCalledTimes(1));
        expect(runEventBaseIngestion.mock.calls[0][0]).toMatchObject({ skipTipFallback: true, windowSizeOverride: 4, collectionIdOverride: 'vf_archiveevent_harbor_harbor-file' });
        expect(setCollectionWindowSize).toHaveBeenCalledWith('qdrant:vf_archiveevent_harbor_harbor-file', 4);
        expect(choicePopup).not.toHaveBeenCalled();
    });
});

describe('the page\'s settings', () => {
    it('saves a chat\'s window size and overlap as VectFox\'s settings', () => {
        openContentVectorizer();
        change($id('vectfox_cv_chat_window_size'), '6');
        expect(host.root.vectfox.eventbase_window_size).toBe(6);
        change($id('vectfox_cv_chat_window_overlap'), '2');
        expect(host.root.vectfox.eventbase_window_overlap).toBe(2);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
    });

    it('sets VectFox\'s one cleaning preset, and shows the one Patterns leaves chosen in Text Cleaning, or that it is not in this VectFox', async () => {
        openContentVectorizer();
        const select = $id('vectfox_cv_chat_cleaning_preset');
        const note = () => page().querySelector('[data-cv-hint="cleaning-note"]').textContent;
        expect([select.value, note()]).toEqual(['light', 'Strips markup.']);

        change(select, 'custom');
        expect(chooseCleaningPreset).toHaveBeenCalledWith('custom');
        expect(note()).toBe('Your own built-ins and custom patterns.');

        host.cleaningPreset = 'light';
        actionOn('manage-cleaning').click();
        await vi.waitFor(() => expect(select.value).toBe('light'));
        expect(openTextCleaningDialog).toHaveBeenCalledTimes(1);
        expect(note()).toBe('Strips markup.');

        host.cleaningPreset = 'saved_elsewhere';
        actionOn('manage-cleaning').click();
        await vi.waitFor(() => expect(note()).toBe('The saved preset "saved_elsewhere" is not in this VectFox, so nothing is cleaned. Pick a preset.'));
    });
});

describe('a run', () => {
    it('says on its page what it needs, and runs nothing', async () => {
        openContentVectorizer();
        change($id('vectfox_cv_chat_source_choice'), 'file');
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runState()).toBe('Choose a file first.'));

        host.context.chat = [];
        change($id('vectfox_cv_chat_source_choice'), 'this');
        actionOn('resume').click();
        await vi.waitFor(() => expect(runState()).toBe('The open chat has no messages.'));
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
        expect(runEventBaseIngestion).not.toHaveBeenCalled();
    });
});

describe('a chat\'s Vectorize', () => {
    const IN_USE = { registryKey: 'qdrant:vf_eventbase_chat-uuid', name: 'Harbor Keeper', isLockedHere: true };
    const NEW_KEY = 'qdrant:vf_eventbase_chat-uuid_mh3k2x1a';
    const runOptions = call => runEventBaseOnOpenChat.mock.calls[call][2];

    it("reads a chat with no collection yet into its first, asking nothing, at the dialog's window size, which the collection keeps; then closes, announcing the close once", async () => {
        host.context.chat.push({ mes: '   ' });
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(askWhichChatCollection).not.toHaveBeenCalled();
        expect(choicePopup).not.toHaveBeenCalled();
        expect(setCollectionWindowSize).toHaveBeenCalledWith(IN_USE.registryKey, 4);
        expect(runOptions(0)).toMatchObject({
            startFromMessage: 1, parallelWindows: 3, skipTipFallback: true, windowSizeOverride: 4, collectionIdOverride: null,
            progressPlan: { strategy: 'per_message', batchSize: 1, totalChunks: 2 },
        });
        await vi.waitFor(() => expect(host.dialogs).toHaveLength(0));
        await vi.waitFor(() => expect(closed).toEqual(['closed']));
    });

    it('asks Catch up, Start over or New collection on a chat whose collection is in use, naming it and the message it reads from; Cancel runs nothing', async () => {
        host.ownCollections = [IN_USE];
        openContentVectorizer();
        change($id('vectfox_cv_chat_start_from'), '41');
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(choicePopup).toHaveBeenCalledTimes(1));
        const [lines, { choices }] = choicePopup.mock.calls[0];
        expect(lines).toEqual([
            { text: 'This chat reads into:', name: 'Harbor Keeper' },
            { text: 'Catch up reads the messages it has not read.' },
            { text: 'Start over empties it, then reads the chat again from message 41.' },
            { text: 'New collection reads the chat from message 41 into a new collection, and keeps this one.' },
        ]);
        expect(choices.map(choice => choice.text)).toEqual(['Catch up', 'Start over', 'New collection']);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
        expect(emptyEventBaseCollection).not.toHaveBeenCalled();
        expect(startNewChatCollection).not.toHaveBeenCalled();
        expect(host.dialogs).toHaveLength(1);
    });

    it('catches up at the window size the collection keeps, whatever the dialog says, forgetting nothing', async () => {
        host.ownCollections = [IN_USE];
        host.keptWindowSize = 6;
        host.choice = 'catch-up';
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(runOptions(0)).toMatchObject({ skipTipFallback: false, windowSizeOverride: 6, collectionIdOverride: null });
        expect(setCollectionWindowSize).not.toHaveBeenCalled();
    });

    it("catches up on Resume, asking nothing, a collection that keeps no window size at the dialog's, which it keeps from then on", async () => {
        host.ownCollections = [IN_USE];
        openContentVectorizer();
        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(choicePopup).not.toHaveBeenCalled();
        expect(setCollectionWindowSize).toHaveBeenCalledWith(IN_USE.registryKey, 4);
        expect(runOptions(0)).toMatchObject({ skipTipFallback: false, windowSizeOverride: 4 });
    });

    it("starts over after a red confirm counting the events it deletes, empties the collection first, then reads it from the Start from message at the dialog's window size", async () => {
        host.ownCollections = [IN_USE];
        host.keptWindowSize = 6;
        host.choice = 'start-over';
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        const [lines, options] = confirmPopup.mock.calls[0];
        expect(lines.slice(0, 2)).toEqual([
            { text: 'Start this collection over?', name: 'Harbor Keeper' },
            { text: 'Events it deletes, with their StoryArc links:', name: '3' },
        ]);
        expect(options).toMatchObject({ okButton: 'Start over', isDestructive: true });
        expect(emptyEventBaseCollection).toHaveBeenCalledWith(IN_USE.registryKey, host.root.vectfox, { windowSize: 4 });
        expect(emptyEventBaseCollection.mock.invocationCallOrder[0]).toBeLessThan(runEventBaseOnOpenChat.mock.invocationCallOrder[0]);
        expect(runOptions(0)).toMatchObject({ startFromMessage: 1, skipTipFallback: true, windowSizeOverride: 4, collectionIdOverride: null });
    });

    it('empties and reads nothing on Cancel, and says in red, reading nothing, when the collection could not be emptied', async () => {
        host.ownCollections = [IN_USE];
        host.choice = 'start-over';
        host.answer = false;
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(emptyEventBaseCollection).not.toHaveBeenCalled();

        host.answer = true;
        host.emptyError = new Error('Qdrant refused the delete');
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledTimes(1));
        expect(toastr.error.mock.calls[0][0]).toBe('Start over stopped: the collection could not be emptied (Qdrant refused the delete), so nothing was read again. Start over again to retry.');
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it("reads the chat into a new collection at the dialog's window size, which its run puts in use, then says auto-sync is off for it", async () => {
        host.ownCollections = [IN_USE];
        host.choice = 'new-collection';
        openContentVectorizer();
        change($id('vectfox_cv_chat_start_from'), '5');
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(toastr.info).toHaveBeenCalledTimes(1));
        expect(startNewChatCollection).toHaveBeenCalledWith(host.root.vectfox, { windowSize: 4 });
        expect(runOptions(0)).toMatchObject({ startFromMessage: 5, skipTipFallback: true, windowSizeOverride: 4, collectionIdOverride: 'vf_eventbase_chat-uuid_mh3k2x1a' });
        expect(toastr.info).toHaveBeenCalledWith('"Harbor Keeper 2" is in use in this chat now. Auto-sync is off for it: turn it on on the AutoSync page.', 'EventBase', { timeOut: 12000 });
    });

    it('says in red, reading nothing, when the new collection could not be made', async () => {
        host.ownCollections = [IN_USE];
        host.choice = 'new-collection';
        startNewChatCollection.mockImplementationOnce(() => { throw new Error('This chat has no UUID of its own.'); });
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(toastr.error).toHaveBeenCalledWith('New collection could not be made: This chat has no UUID of its own.', 'EventBase'));
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('says nothing of auto-sync when the new collection did not come into use, its run never starting', async () => {
        host.ownCollections = [IN_USE];
        host.choice = 'new-collection';
        runEventBaseOnOpenChat.mockImplementationOnce(async () => null);
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(actionOn('vectorize').disabled).toBe(false));
        expect(toastr.info).not.toHaveBeenCalled();
    });

    it("asks which collection to use while none of the chat's is locked to it, offering New collection: nothing on Cancel, the one chosen caught up, a new one read on New collection", async () => {
        host.ownCollections = [{ ...IN_USE, isLockedHere: false }, { registryKey: 'qdrant:vf_eventbase_chat-uuid_2', name: 'Harbor Keeper 2', isLockedHere: false }];
        host.runResult = { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };
        openContentVectorizer();
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(askWhichChatCollection).toHaveBeenCalledTimes(1));
        expect(askWhichChatCollection.mock.calls[0][1]).toEqual({ canMakeNew: true });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();

        host.chosenCollection = 'qdrant:vf_eventbase_chat-uuid_2';
        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(runOptions(0)).toMatchObject({ skipTipFallback: false, collectionIdOverride: null });
        await vi.waitFor(() => expect(actionOn('resume').disabled).toBe(false));

        host.chosenCollection = '+new';
        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(2));
        expect(runOptions(1)).toMatchObject({ skipTipFallback: true, collectionIdOverride: 'vf_eventbase_chat-uuid_mh3k2x1a' });
        expect(choicePopup).not.toHaveBeenCalled();
        expect(host.ownCollections.find(collection => collection.isLockedHere).registryKey).toBe(NEW_KEY);
    });

    it('reads into a new collection at once when opened on New collection, asking nothing, its run card saying so; an open dialog turns to it', async () => {
        host.ownCollections = [IN_USE];
        openContentVectorizer();
        expect(partOf('new-collection').hidden).toBe(true);
        openContentVectorizer({ isOnNewCollection: true });
        expect(partOf('new-collection').hidden).toBe(false);
        expect(partOf('new-collection').textContent).toBe('Vectorize reads this chat into a new collection, from the Start from message.');
        // A chat file reads into its archive collection, so the line goes while one is the source.
        change($id('vectfox_cv_chat_source_choice'), 'file');
        expect(partOf('new-collection').hidden).toBe(true);
        change($id('vectfox_cv_chat_source_choice'), 'this');
        expect(partOf('new-collection').hidden).toBe(false);
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(askWhichChatCollection).not.toHaveBeenCalled();
        expect(choicePopup).not.toHaveBeenCalled();
        expect(runOptions(0)).toMatchObject({ collectionIdOverride: 'vf_eventbase_chat-uuid_mh3k2x1a', windowSizeOverride: 4 });
    });

    it('closes without a run with one announcement', async () => {
        openContentVectorizer();
        await closeEveryDialog();
        expect(closed).toEqual(['closed']);
    });
});

describe('the End message', () => {
    const IN_USE = { registryKey: 'qdrant:vf_eventbase_chat-uuid', name: 'Harbor Keeper', isLockedHere: true };

    it('names it in the question, and ends the run chosen at the window that holds it', async () => {
        host.ownCollections = [IN_USE];
        host.choice = 'catch-up';
        openContentVectorizer();
        change($id('vectfox_cv_chat_start_from'), '41');
        change($id('vectfox_cv_chat_end_at'), '90');
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        const [lines] = choicePopup.mock.calls[0];
        expect(lines[2]).toEqual({ text: 'Start over empties it, then reads the chat again from message 41 to message 90.' });
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({ startFromMessage: 41, endAtMessage: 90, isReadingAgain: false, shouldCompleteProgress: true });
    });

    it('reads to the chat\'s end when empty, and empties a box holding no whole number from 1', async () => {
        openContentVectorizer();
        change($id('vectfox_cv_chat_end_at'), 'soon');
        expect($id('vectfox_cv_chat_end_at').value).toBe('');
        actionOn('vectorize').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({ endAtMessage: null });
    });
});

describe('reading a stretch again', () => {
    const IN_USE = { registryKey: 'qdrant:vf_eventbase_chat-uuid', name: 'Harbor Keeper', isLockedHere: true };
    const startReadingAgain = () => {
        openContentVectorizer();
        change($id('vectfox_cv_chat_start_from'), '41');
        change($id('vectfox_cv_chat_end_at'), '90');
        change($id('vectfox_cv_chat_read_again'), true);
        actionOn('vectorize').click();
    };

    it('shows its switch for the open chat only', () => {
        openContentVectorizer();
        expect(partOf('read-again').hidden).toBe(false);
        change($id('vectfox_cv_chat_source_choice'), 'file');
        expect(partOf('read-again').hidden).toBe(true);
    });

    it('asks no Catch up question: it shows in red what the stretch holds and costs, at the window size the collection keeps, then reads it again and lets StoryArc finish on the same panel', async () => {
        host.ownCollections = [IN_USE];
        host.keptWindowSize = 6;
        startReadingAgain();
        await vi.waitFor(() => expect(finishReadingAgain).toHaveBeenCalledTimes(1));
        expect(choicePopup).not.toHaveBeenCalled();
        expect(describeReadingAgain).toHaveBeenCalledWith({ settings: host.root.vectfox, startFromMessage: 41, endAtMessage: 90, windowSize: 6 });
        const [lines, options] = confirmPopup.mock.calls[0];
        expect(lines).toEqual(readAgainConfirmLines(host.readAgainPlan));
        expect(options).toMatchObject({ okButton: 'Read again', isDestructive: true });
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({
            startFromMessage: 41, endAtMessage: 90, isReadingAgain: true, shouldCompleteProgress: false,
            progressTitle: 'Reading again, step 1 of 3: windows', skipTipFallback: false, windowSizeOverride: 6, collectionIdOverride: null,
        });
        expect(finishReadingAgain.mock.calls[0][0]).toMatchObject({ result: host.runResult, plan: host.readAgainPlan, settings: host.root.vectfox });
        await vi.waitFor(() => expect(host.dialogs).toHaveLength(0));
    });

    it('reads nothing on Cancel', async () => {
        host.ownCollections = [IN_USE];
        host.answer = false;
        startReadingAgain();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('says on its page why, asking nothing and reading nothing, when the stretch has nothing to read', async () => {
        host.ownCollections = [IN_USE];
        host.readAgainPlan = { problem: 'No whole window of 4 messages lies between those messages, so there is nothing to read again.' };
        startReadingAgain();
        await vi.waitFor(() => expect(runState()).toBe(host.readAgainPlan.problem));
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('stays open with the verdict on its page when an event was left undecided', async () => {
        host.ownCollections = [IN_USE];
        host.readAgainVerdict = { isSuccess: false, message: 'Read 9 of 9 windows again, 19 events found; 17 of 19 new events linked, 2 failed.' };
        startReadingAgain();
        await vi.waitFor(() => expect(finishReadingAgain).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(runState()).toBe(host.readAgainVerdict.message));
        expect(host.dialogs).toHaveLength(1);
    });

    it('reads a chat with no collection yet into its first, as Vectorize does with the switch off', async () => {
        startReadingAgain();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(describeReadingAgain).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({ isReadingAgain: false, skipTipFallback: true });
    });
});

describe('a chat run that reads nothing new, stops or fails', () => {
    it('stays open after a Resume with nothing new, saying so, and announces no close', async () => {
        host.runResult = { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };
        openContentVectorizer();
        actionOn('resume').click();
        await vi.waitFor(() => expect(runState()).toContain('Nothing new to read'));
        expect(host.dialogs).toHaveLength(1);
        expect(actionOn('resume').disabled).toBe(false);
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(closed).toEqual([]);
    });

    it('stays open after a failed run, which says what broke in red', async () => {
        host.runResult = new Error('The provider refused the key');
        openContentVectorizer();
        actionOn('resume').click();
        await vi.waitFor(() => expect(globalThis.toastr.error).toHaveBeenCalledWith('EventBase failed: The provider refused the key', 'VectFox'));
        expect(host.dialogs).toHaveLength(1);
        expect(actionOn('resume').disabled).toBe(false);
    });

    it('stops on the page\'s Stop, saying it is stopping, then stays open pointing at Resume', async () => {
        host.runResult = 'until-stopped';
        openContentVectorizer();
        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        expect(partOf('stop').hidden).toBe(false);
        expect(actionOn('resume').disabled).toBe(true);
        actionOn('stop').click();
        expect(runState()).toBe('Stopping: what was already sent finishes first.');
        await vi.waitFor(() => expect(runState()).toBe('Stopped. Resume adds what EventBase has not read yet.'));
        expect(partOf('stop').hidden).toBe(true);
        expect(host.dialogs).toHaveLength(1);
        expect(closed).toEqual([]);
    });

    it('stays open after a run that could not start, which said why itself', async () => {
        host.runResult = null;
        openContentVectorizer();
        actionOn('resume').click();
        await vi.waitFor(() => expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(actionOn('resume').disabled).toBe(false));
        expect(host.dialogs).toHaveLength(1);
        expect(runState()).toBe('');
    });
});

describe('Sync chat', () => {
    it('asks with what EventBase has not read, and runs nothing on Cancel', async () => {
        host.syncStatus = { state: 'partial', chatMessageCount: 40, vectorizationTip: 30, unfinishedWindowCount: 2 };
        host.answer = false;
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'cancelled' });
        const [lines, options] = confirmPopup.mock.calls[0];
        expect(lines.slice(0, 2)).toEqual([
            { icon: 'fa-rotate', text: 'Messages EventBase has not read:', name: '10' },
            { text: 'Windows that failed before, read again:', name: '2' },
        ]);
        expect(options).toMatchObject({ okButton: 'Sync' });
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it("reads them on Sync as Resume does with the dialog's defaults, at the window size the collection keeps, with no dialog and no close announced", async () => {
        host.keptWindowSize = 6;
        expect(await syncOpenChat()).toEqual({ ran: true });
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({ startFromMessage: 1, parallelWindows: 3, skipTipFallback: false, windowSizeOverride: 6 });
        expect(host.dialogs).toHaveLength(0);
        expect(closed).toEqual([]);
        expect(noticePopup).not.toHaveBeenCalled();
    });

    it('says in a dialog when the run it was told to start finds nothing new, as no page of Vectorize Content is open to say it', async () => {
        host.runResult = { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };
        expect(await syncOpenChat()).toEqual({ ran: true });
        expect(noticePopup).toHaveBeenCalledWith([{ icon: 'fa-circle-info', text: 'Nothing new to read. A message that does not fill a window waits for the next one.' }]);
    });

    it("asks which collection to use while none of the chat's is locked to it, then syncs the one chosen, and nothing on Cancel", async () => {
        host.syncStatus = { state: 'none-locked', collections: [] };
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'cancelled' });
        expect(askWhichChatCollection.mock.calls[0][1]).toEqual({ canMakeNew: true });
        expect(confirmPopup).not.toHaveBeenCalled();

        askWhichChatCollection.mockImplementationOnce(async () => {
            host.syncStatus = { state: 'partial', chatMessageCount: 40, vectorizationTip: 30, unfinishedWindowCount: 0 };
            return 'qdrant:vf_eventbase_harbor_2';
        });
        expect(await syncOpenChat()).toEqual({ ran: true });
        expect(runEventBaseOnOpenChat).toHaveBeenCalledTimes(1);
    });

    it("opens Vectorize Content on New collection for the question's New collection, reading nothing itself", async () => {
        host.syncStatus = { state: 'none-locked', collections: [] };
        askWhichChatCollection.mockImplementationOnce(async () => '+new');
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'new-collection' });
        await vi.waitFor(() => expect(host.dialogs).toHaveLength(1));
        expect(partOf('new-collection').hidden).toBe(false);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('opens Vectorize Content on the Chat page for a chat with nothing stored yet, and asks nothing', async () => {
        host.syncStatus = { state: 'no-collection' };
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'no-collection' });
        await vi.waitFor(() => expect(host.dialogs).toHaveLength(1));
        expect(page().hidden).toBe(false);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('says in a dialog that the chat is up to date, and asks nothing, when EventBase has read every message', async () => {
        host.syncStatus = { state: 'fully-vectorized', chatMessageCount: 40, vectorizationTip: 40, unfinishedWindowCount: 0 };
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'in-sync' });
        expect(noticePopup.mock.calls[0][0][0]).toEqual({ icon: 'fa-circle-check', text: 'This chat is up to date.' });
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('takes the AutoSync page\'s Up to date over its own count, when the newest message waits for the next window', async () => {
        host.syncStatus = { state: 'fully-vectorized', chatMessageCount: 13, commitBoundary: 11, vectorizationTip: 12, unfinishedWindowCount: 0 };
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'in-sync' });
        const [lines] = noticePopup.mock.calls[0];
        expect(lines[1]).toEqual({ parts: [{ text: 'EventBase has read ' }, { name: '12' }, { text: ' of its ' }, { name: '13' }, { text: ' messages.' }] });
        expect(lines[2].text).toMatch(/^The rest wait until the chat goes on\./);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('stops at the EventBase model\'s check before it asks', async () => {
        host.llmCheck = { ok: false, reason: 'EventBase: no connection profile is chosen. Choose one on the Core page.' };
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'no-model' });
        // Sticky, as every run fails the same way until the user fixes it.
        expect(toastr.error).toHaveBeenCalledWith(expect.stringContaining('no connection profile is chosen'), 'Configuration required', { timeOut: 0, extendedTimeOut: 0 });
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('says in a toast why it does nothing with no chat open', async () => {
        host.syncStatus = { state: 'no-chat' };
        expect(await syncOpenChat()).toEqual({ ran: false, reason: 'no-chat' });
        expect(toastr.info).toHaveBeenCalledWith('Open a chat to sync it.', 'VectFox');
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(runEventBaseOnOpenChat).not.toHaveBeenCalled();
    });

    it('asks with no count for a chat shorter than what EventBase read, as its tip counts nothing there, and reads on Sync', async () => {
        // The tip, 14, says every message of the 10 was read, and the chat's would-be up-to-date verdict with it.
        host.syncStatus = { state: 'vectorization-ahead', chatMessageCount: 10, vectorizationTip: 14, unfinishedWindowCount: 0 };
        expect(await syncOpenChat()).toEqual({ ran: true });
        expect(confirmPopup.mock.calls[0][0][0]).toEqual({ icon: 'fa-rotate', text: 'This chat is shorter than what EventBase read, so the messages it has not read cannot be counted.' });
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({ startFromMessage: 1, skipTipFallback: false });
        expect(noticePopup).not.toHaveBeenCalled();
    });
});

describe('the auto-sync catch-up', () => {
    it("reads the open chat's new messages at the window size its collection keeps, with no dialog, and announces no close", async () => {
        host.keptWindowSize = 6;
        expect(await backfillCurrentChatWithProgress()).toEqual({ ran: true });
        expect(runEventBaseOnOpenChat.mock.calls[0][2]).toMatchObject({ startFromMessage: 1, parallelWindows: 1, skipTipFallback: false, windowSizeOverride: 6 });
        expect(closed).toEqual([]);
    });
});
