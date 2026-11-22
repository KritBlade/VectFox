/**
 * A chat's rename keeps its collections' locks (src/features/collections/collection-metadata.js, §2.2 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): every collection locked to the old chat ID is
 * locked to the name the server saved its file under, in the records and in the chat lock index, a colon or question
 * mark in the name typed included; other chats' locks stay; and the locks stay on the old name, with a warning, when
 * the server cannot say the name it saved.
 *
 * The real collection records run on a settings object of the test's; SillyTavern's file name cleaner drops what a file
 * name cannot hold, as its server does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ extensionSettings: { vectfox: {} }, isCleanerDown: false }));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.extensionSettings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => null, chat_metadata: {} }));
vi.mock('../src/sillytavern/identifiers.js', () => ({
    getSanitizedFilename: vi.fn(async name => {
        if (host.isCleanerDown) throw new Error('Failed to fetch');
        return name.replace(/[:?"]/gu, '');
    }),
}));

const metadata = await import('../src/features/collections/collection-metadata.js');
const { log } = await import('../src/sillytavern/log.js');

const HARBOR = 'qdrant:vf_eventbase_qdrant_wren_harbor_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ARCHIVE = 'qdrant:vf_archiveevent_qdrant_wren_harbor_cccccccc-3333-4333-8333-cccccccccccc';
const OTHER = 'qdrant:vf_eventbase_qdrant_wren_tide_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

beforeEach(() => {
    vi.clearAllMocks();
    host.isCleanerDown = false;
    host.extensionSettings.vectfox = { collections: {}, chat_lock_index: {} };
    metadata.setCollectionLock(HARBOR, 'Wren - harbor');
    metadata.setCollectionLock(ARCHIVE, 'Wren - harbor');
    metadata.setCollectionLock(OTHER, 'Wren - tide');
});

describe("a chat's rename", () => {
    it('moves every lock on the old chat to the name the server saved, in the records and the lock index, and leaves the rest', async () => {
        await metadata.followChatRenameOfCollections({ oldFileName: 'Wren - harbor.jsonl', newFileName: 'Wren: the storm?.jsonl' });
        expect([HARBOR, ARCHIVE, OTHER].map(key => metadata.getCollectionLocks(key))).toEqual([['Wren the storm'], ['Wren the storm'], ['Wren - tide']]);
        expect(metadata.getChatLockedCollections('Wren the storm')).toEqual([HARBOR, ARCHIVE]);
        expect(metadata.getChatLockedCollections('Wren - harbor')).toEqual([]);
        expect(metadata.getChatLockedCollections('Wren - tide')).toEqual([OTHER]);
    });

    it('keeps the locks on the old name, with a warning, when the server cannot say the name it saved', async () => {
        host.isCleanerDown = true;
        await metadata.followChatRenameOfCollections({ oldFileName: 'Wren - harbor.jsonl', newFileName: 'Wren - storm.jsonl' });
        expect(metadata.getCollectionLocks(HARBOR)).toEqual(['Wren - harbor']);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('collection locks stay on the old name'), expect.any(Error));
    });

    // SillyTavern opens the renamed chat (CHAT_CHANGED) before CHAT_RENAMED, so the AutoSync page drew it with no lock.
    it('redraws the pages that show the locks once the locks moved, and not when none did', async () => {
        const dispatchEvent = vi.fn();
        vi.stubGlobal('document', { dispatchEvent });
        try {
            await metadata.followChatRenameOfCollections({ oldFileName: 'Wren - tide.jsonl', newFileName: 'Wren - calm.jsonl' });
            expect(dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(['vectfox:collections-updated']);

            dispatchEvent.mockClear();
            await metadata.followChatRenameOfCollections({ oldFileName: 'Wren - nobody.jsonl', newFileName: 'Wren - still nobody.jsonl' });
            expect(dispatchEvent).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('moves nothing when the name saved is the old one', () => {
        expect(metadata.moveCollectionChatLocks('Wren - harbor', 'Wren - harbor')).toBe(0);
        expect(metadata.getCollectionLocks(HARBOR)).toEqual(['Wren - harbor']);
    });
});
