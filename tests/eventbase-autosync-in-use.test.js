/**
 * Auto-sync writes only the chat's collection in use (synchronizeChat, src/features/eventbase/eventbase-chat-sync.js;
 * §2.2 and D18 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): it asks the one route
 * (collectionInUse) and writes the collection it gives, while that one's auto-sync is on. With none in use it writes
 * nothing, and while one of the chat's collections has auto-sync on, it says so in red for each message; a model the
 * provider no longer knows turns auto-sync off for the collection in use alone.
 *
 * The module's SillyTavern wrappers and its EventBase and backend imports are stubbed; the route is a stub that gives
 * what each test sets.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    chat: [],
    inUse: null,
    runEventBaseIngestion: vi.fn(async () => ({ eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 })),
    showNoCollectionInUse: vi.fn(),
    pauseCollectionAutoSync: vi.fn(),
    notifyInvalidModel: vi.fn(),
    log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), enabled: () => false },
}));

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({ chat: mocks.chat })), getCurrentChatId: vi.fn(() => 'chat-1') }));
vi.mock('../src/sillytavern/generation.js', () => ({ is_send_press: false }));
vi.mock('../src/sillytavern/log.js', () => ({ log: mocks.log }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: vi.fn(() => 'uuid-1') }));
vi.mock('../src/shared/model-config-notifier.js', () => ({
    isInvalidModelConfigError: error => error?.code === 'invalid_model_config',
    notifyInvalidModel: mocks.notifyInvalidModel,
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { complete: vi.fn() } }));
vi.mock('../src/features/vector-backend/index.js', () => ({ isBackendAvailable: vi.fn(async () => true) }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    collectionInUse: vi.fn(() => mocks.inUse),
    showNoCollectionInUse: mocks.showNoCollectionInUse,
}));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({ pauseCollectionAutoSync: mocks.pauseCollectionAutoSync }));
vi.mock('../src/features/eventbase/eventbase-workflow.js', () => ({
    runEventBaseIngestion: mocks.runEventBaseIngestion, countUnfinishedWindows: vi.fn(() => 0), getAutoSyncWindowSize: vi.fn(() => 2), notifyUnfinishedWindows: vi.fn(),
}));

const { synchronizeChat } = await import('../src/features/eventbase/eventbase-chat-sync.js');
const { collectionInUse } = await import('../src/features/eventbase/eventbase-chat-collections.js');

const SETTINGS = { enabled: true, vector_backend: 'qdrant' };
const collection = (registryKey, isAutoSyncOn) => ({ registryKey, collectionId: registryKey.slice(7), isAutoSyncOn, isLockedHere: false, isPaused: false });
const FIRST = collection('qdrant:vf_eventbase_first', true);
const LATER = collection('qdrant:vf_eventbase_later', false);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.chat.splice(0, mocks.chat.length, { mes: 'The gate is shut.' }, { mes: 'Open it.' });
});

describe('the messages auto-sync reads', () => {
    it('are the open chat in story order: those with text, a summary a message source answers for as its messages', async () => {
        const { setMessageSource } = await import('../src/shared/chat-messages.js');
        const inUse = { ...FIRST, isLockedHere: true };
        mocks.inUse = { collection: inUse, reason: null, collections: [inUse], lockedElsewhere: [] };
        const kept = [{ mes: 'The gate is shut.' }, { mes: 'Open it.' }];
        mocks.chat.splice(0, mocks.chat.length, { mes: 'They argued at the gate.', stands: kept }, { mes: '' }, { mes: 'It opens.' });
        setMessageSource(message => (message.stands ? { owner: 'Gate Summaries', originals: message.stands } : null));
        try {
            await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        } finally {
            setMessageSource(null);
        }
        expect(mocks.runEventBaseIngestion.mock.calls[0][0].messages).toEqual([...kept, { mes: 'It opens.' }]);
    });
});

describe('auto-sync and the collection in use', () => {
    it('asks the one route for the open chat, and writes the collection it gives while that one has auto-sync on', async () => {
        const inUse = { ...LATER, isAutoSyncOn: true, isLockedHere: true };
        mocks.inUse = { collection: inUse, reason: null, collections: [FIRST, inUse], lockedElsewhere: [] };
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        expect(collectionInUse).toHaveBeenCalledWith(SETTINGS, { chatUUID: 'uuid-1', chatId: 'chat-1' });
        expect(mocks.runEventBaseIngestion).toHaveBeenCalledWith(expect.objectContaining({ collectionIdOverride: 'vf_eventbase_later', isAutoSync: true }));
        expect(mocks.showNoCollectionInUse).not.toHaveBeenCalled();
    });

    it("writes nothing while the collection in use has auto-sync off, a flag on another of the chat's collections counting for nothing", async () => {
        const inUse = { ...LATER, isLockedHere: true };
        mocks.inUse = { collection: inUse, reason: null, collections: [FIRST, inUse], lockedElsewhere: [] };
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        expect(mocks.runEventBaseIngestion).not.toHaveBeenCalled();
        expect(mocks.showNoCollectionInUse).not.toHaveBeenCalled();
    });

    it('writes nothing with none in use, and says so in red for the message while one of the chat\'s collections has auto-sync on', async () => {
        mocks.inUse = { collection: null, reason: 'none-in-use', collections: [FIRST, LATER], lockedElsewhere: [] };
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        expect(mocks.runEventBaseIngestion).not.toHaveBeenCalled();
        expect(mocks.showNoCollectionInUse).toHaveBeenCalledWith(mocks.inUse, 'auto-sync wrote nothing for this message');
    });

    it('says so too for one with auto-sync on that is locked here on the other backend', async () => {
        mocks.inUse = { collection: null, reason: 'other-backend', collections: [], lockedElsewhere: [collection('vectra:vf_eventbase_first', true)] };
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        expect(mocks.showNoCollectionInUse).toHaveBeenCalledTimes(1);
    });

    it('says nothing with none in use while none of the chat\'s collections has auto-sync on, nor for a chat with none', async () => {
        mocks.inUse = { collection: null, reason: 'none-in-use', collections: [LATER], lockedElsewhere: [] };
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        mocks.inUse = { collection: null, reason: 'no-collection', collections: [], lockedElsewhere: [] };
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        expect(mocks.showNoCollectionInUse).not.toHaveBeenCalled();
        expect(mocks.runEventBaseIngestion).not.toHaveBeenCalled();
    });

    it('turns auto-sync off for the collection in use alone when the provider no longer knows the model', async () => {
        const inUse = { ...LATER, isAutoSyncOn: true, isLockedHere: true };
        mocks.inUse = { collection: inUse, reason: null, collections: [FIRST, inUse], lockedElsewhere: [] };
        mocks.runEventBaseIngestion.mockRejectedValueOnce(Object.assign(new Error('model not found'), { code: 'invalid_model_config' }));
        await synchronizeChat(SETTINGS, 'MESSAGE_RECEIVED');
        expect(mocks.notifyInvalidModel).toHaveBeenCalledWith('model not found');
        expect(mocks.pauseCollectionAutoSync).toHaveBeenCalledTimes(1);
        expect(mocks.pauseCollectionAutoSync).toHaveBeenCalledWith('qdrant:vf_eventbase_later');
    });
});
