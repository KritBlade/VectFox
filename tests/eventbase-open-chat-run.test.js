/**
 * Running EventBase over the open chat (runEventBaseOnOpenChat, src/features/eventbase/eventbase-chat-sync.js) hands it
 * the whole chat and the message to start at, so a run from a later message numbers its windows from the chat's first
 * message, and passes on the dialog's run: its windows at once, the progress panel's plan and the tip it skips.
 *
 * The module's SillyTavern wrappers and its EventBase, collection and backend imports are stubbed, and the EventBase
 * run is a stub that records what it was asked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    chat: [],
    runEventBaseIngestion: vi.fn(async () => ({ eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 })),
    log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), enabled: () => false },
}));

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(() => ({ chat: mocks.chat })), getCurrentChatId: vi.fn(() => 'chat-1') }));
vi.mock('../src/sillytavern/generation.js', () => ({ is_send_press: false }));
vi.mock('../src/sillytavern/log.js', () => ({ log: mocks.log }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../src/shared/collection-ids.js', () => ({ getChatUUID: vi.fn(() => 'uuid-1'), getRegistryBackend: vi.fn(backend => backend || 'standard') }));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { complete: vi.fn() } }));
vi.mock('../src/features/collections/index.js', () => ({ isCollectionAutoSyncEnabled: vi.fn(() => false) }));
vi.mock('../src/features/vector-backend/index.js', () => ({ isBackendAvailable: vi.fn(async () => true) }));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({ pauseCollectionAutoSync: vi.fn() }));
vi.mock('../src/features/eventbase/eventbase-chat-collections.js', () => ({
    collectionInUse: vi.fn(() => ({ collection: null, reason: 'no-collection', collections: [], lockedElsewhere: [] })),
    showNoCollectionInUse: vi.fn(),
}));
vi.mock('../src/features/eventbase/eventbase-workflow.js', () => ({
    runEventBaseIngestion: mocks.runEventBaseIngestion, countUnfinishedWindows: vi.fn(() => 0), getAutoSyncWindowSize: vi.fn(() => 4), notifyUnfinishedWindows: vi.fn(),
}));

const { runEventBaseOnOpenChat } = await import('../src/features/eventbase/eventbase-chat-sync.js');

describe('EventBase over the open chat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
        mocks.chat.length = 0;
        mocks.chat.push(
            { name: 'Harbor Keeper', is_user: false, mes: 'The gate is shut.' },
            { name: 'Rook', is_user: true, mes: 'Open it.' },
            { name: 'Harbor Keeper', is_user: false, mes: 'It opens.' },
            { name: 'Rook', is_user: true, mes: 'Go in.' },
        );
    });

    it('starts at the chat\'s first message by default', async () => {
        await runEventBaseOnOpenChat({ vector_backend: 'qdrant' });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0]).toMatchObject({ startFromMessage: 1 });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0].messages).toHaveLength(4);
    });

    it('hands a run from a later message the whole chat and that message, with the dialog\'s run', async () => {
        const progressPlan = { strategy: 'per_message', batchSize: 1, totalChunks: 4 };
        await runEventBaseOnOpenChat({ vector_backend: 'qdrant' }, null, { startFromMessage: 3, parallelWindows: 2, progressPlan, skipTipFallback: true });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0]).toMatchObject({
            startFromMessage: 3, chatUUID: 'uuid-1', isAutoSync: false, parallelWindows: 2, progressPlan, skipTipFallback: true,
        });
        expect(mocks.runEventBaseIngestion.mock.calls[0][0].messages).toHaveLength(4);
    });
});
