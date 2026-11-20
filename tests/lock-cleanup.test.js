/**
 * Clean up locks on the Action page (src/features/settings-panel/lock-cleanup.js), on real collection and lorebook
 * records: it finds every character's chats through SillyTavern's chat list, every group's chats and the open chat;
 * the confirm counts each kind of lock that goes and the chat lock index's entries; Cancel changes nothing; OK removes
 * the locks and rebuilds the index. A chat list that cannot be read leaves every chat lock alone and says why; nothing
 * to clean up says so; a failure is logged and shown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    extensionSettings: { vectfox: {} },
    saveSettingsDebounced: vi.fn(),
    getContext: vi.fn(),
    getCurrentChatId: vi.fn(),
    confirmPopup: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.extensionSettings, saveSettingsDebounced: host.saveSettingsDebounced }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: host.logWarn, error: host.logError, lifecycle: () => {}, verbose: () => {}, trace: () => {} },
}));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: host.getContext, getCurrentChatId: host.getCurrentChatId, chat_metadata: {} }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: host.confirmPopup }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/sillytavern/world-info.js', () => ({ loadWorldInfo: vi.fn() }));
vi.mock('../src/features/collections/index.js', async () => ({
    cleanUpCollectionLocks: (await import('../src/features/collections/collection-metadata.js')).cleanUpCollectionLocks,
}));
vi.mock('../src/features/lorebase/index.js', async () => ({
    cleanUpLoreBookLocks: (await import('../src/features/lorebase/lorebase-books.js')).cleanUpLoreBookLocks,
}));

const { cleanUpLocks } = await import('../src/features/settings-panel/lock-cleanup.js');

const HARBOR = 'qdrant:vf_eventbase_qdrant_wren_harbor';
const LIGHTHOUSE = 'qdrant:vf_eventbase_qdrant_wren_lighthouse';
const toastr = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
const WREN = { avatar: 'wren.png', name: 'Wren', chat_size: 12 };
const ORRIN = { avatar: 'orrin.png', name: 'Orrin', chat_size: 0 };

/** SillyTavern's chat lists, by avatar: a list, `{error: true}`, or an HTTP status that is not OK. */
function answerChatLists(answers) {
    vi.stubGlobal('fetch', vi.fn(async (url, { body }) => {
        expect(url).toBe('/api/characters/chats');
        const { avatar_url: avatar, simple } = JSON.parse(body);
        expect(simple).toBe(true);
        const answer = answers[avatar];
        if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => answer };
    }));
}

const linesOfConfirm = () => host.confirmPopup.mock.calls[0][0].map(line => line.text);

function staleSettings() {
    return {
        collections: {
            [HARBOR]: { lockedToChatIds: ['Wren - harbor', 'Wren - deleted'] },
            [LIGHTHOUSE]: { lockedToChatIds: ['Harbor night group'], lockedToCharacterIds: ['5'] },
        },
        chat_lock_index: {
            'Wren - harbor': [HARBOR],
            'Wren - deleted': [HARBOR],
            'Wren - long gone': ['qdrant:vf_eventbase_qdrant_wren_gone'],
        },
        lorebase_books: {
            'Harbor Lore': {
                selections: [{
                    id: 'first', name: 'Harbor Lore', selectedUids: ['1'], pinnedSections: [], lockedToChatIds: ['Wren - harbor', 'Orrin - deleted'],
                    lockedToCharacterAvatars: ['wren.png', 'gone.png'],
                }],
            },
        },
    };
}

beforeEach(() => {
    for (const mock of [...Object.values(host).filter(value => typeof value === 'function'), ...Object.values(toastr)]) mock.mockReset();
    vi.stubGlobal('toastr', toastr);
    host.extensionSettings.vectfox = staleSettings();
    host.getContext.mockReturnValue({ characters: [WREN, ORRIN], groups: [{ id: 'harbor-night', chats: ['Harbor night group'] }] });
    host.getCurrentChatId.mockReturnValue('Wren - harbor');
    answerChatLists({ 'wren.png': [{ file_name: 'Wren - harbor.jsonl', file_id: 'Wren - harbor' }], 'orrin.png': { error: true } });
});

describe('Clean up locks', () => {
    it("counts each kind of lock on what no longer exists and the index's entries, then removes them once confirmed", async () => {
        host.confirmPopup.mockResolvedValue(true);
        await cleanUpLocks();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(host.confirmPopup).toHaveBeenCalledWith(expect.any(Array), { okButton: 'Clean up locks', isDestructive: true });
        expect(linesOfConfirm()).toEqual([
            'Remove the locks on chats and characters that no longer exist?',
            '1 collection lock on a chat that no longer exists.',
            '1 collection lock on a character that no longer exists.',
            '1 lorebook lock on a chat that no longer exists.',
            '1 lorebook lock on a character that no longer exists.',
            'A chat renamed while a collection was locked to it counts as gone: the lock kept the old name.',
            '2 chat lock index entries have no lock behind them.',
            '1 lock the chat lock index lacks.',
            "Clean up locks removes those locks and rebuilds the chat lock index, VectFox's list of the collections locked to each chat. Cancel keeps them.",
        ]);

        const settings = host.extensionSettings.vectfox;
        expect(settings.collections[HARBOR].lockedToChatIds).toEqual(['Wren - harbor']);
        expect(settings.collections[LIGHTHOUSE].lockedToChatIds).toEqual(['Harbor night group']);
        expect(settings.collections[LIGHTHOUSE].lockedToCharacterIds).toEqual([]);
        expect(settings.chat_lock_index).toEqual({ 'Wren - harbor': [HARBOR], 'Harbor night group': [LIGHTHOUSE] });
        expect(settings.lorebase_books['Harbor Lore'].selections[0]).toMatchObject({ lockedToChatIds: ['Wren - harbor'], lockedToCharacterAvatars: ['wren.png'], selectedUids: ['1'] });
        expect(host.saveSettingsDebounced).toHaveBeenCalled();
        expect(toastr.success).toHaveBeenCalledWith(
            'Removed 4 locks on chats and characters that no longer exist. Rebuilt the chat lock index: 2 entries removed, 1 entry added.',
            'Locks cleaned up',
        );
    });

    it('changes nothing when the user cancels', async () => {
        host.confirmPopup.mockResolvedValue(false);
        await cleanUpLocks();

        expect(host.extensionSettings.vectfox).toEqual(staleSettings());
        expect(host.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(toastr.success).not.toHaveBeenCalled();
    });

    it("leaves every chat lock alone when a character's chat list cannot be read, says why, and still cleans up the rest", async () => {
        // Wren has chats, so SillyTavern's error is not an empty list.
        answerChatLists({ 'wren.png': { error: true }, 'orrin.png': { error: true } });
        host.confirmPopup.mockResolvedValue(true);
        await cleanUpLocks();

        expect(linesOfConfirm()).toEqual([
            'Remove the locks on chats and characters that no longer exist?',
            '1 collection lock on a character that no longer exists.',
            '1 lorebook lock on a character that no longer exists.',
            '1 chat lock index entry has no lock behind it.',
            '1 lock the chat lock index lacks.',
            'Chat locks were not checked: SillyTavern could not list the chats of Wren.',
            "Clean up locks removes those locks and rebuilds the chat lock index, VectFox's list of the collections locked to each chat. Cancel keeps them.",
        ]);
        const settings = host.extensionSettings.vectfox;
        expect(settings.collections[HARBOR].lockedToChatIds).toEqual(['Wren - harbor', 'Wren - deleted']);
        expect(settings.lorebase_books['Harbor Lore'].selections[0].lockedToChatIds).toEqual(['Wren - harbor', 'Orrin - deleted']);
        expect(settings.chat_lock_index).toEqual({ 'Wren - harbor': [HARBOR], 'Wren - deleted': [HARBOR], 'Harbor night group': [LIGHTHOUSE] });
        expect(host.logWarn).toHaveBeenCalledWith(expect.stringContaining('SillyTavern could not list the chats of Wren.'));
    });

    it('asks only to rebuild the chat lock index when no lock is on what no longer exists, and rebuilds it', async () => {
        host.extensionSettings.vectfox = {
            collections: { [HARBOR]: { lockedToChatIds: ['Wren - harbor'] } },
            chat_lock_index: { 'Wren - harbor': [HARBOR], 'Wren - long gone': ['qdrant:vf_eventbase_qdrant_wren_gone'] },
        };
        host.confirmPopup.mockResolvedValue(true);
        await cleanUpLocks();

        expect(linesOfConfirm()).toEqual([
            "Rebuild the chat lock index from the collections' own locks?",
            '1 chat lock index entry has no lock behind it.',
            "The chat lock index is VectFox's list of the collections locked to each chat. Clean up locks rebuilds it; Cancel keeps it as it is.",
        ]);
        expect(host.extensionSettings.vectfox.chat_lock_index).toEqual({ 'Wren - harbor': [HARBOR] });
        expect(toastr.success).toHaveBeenCalledWith('Rebuilt the chat lock index: 1 entry removed, 0 entries added.', 'Locks cleaned up');
    });

    it('names the status SillyTavern answered when a chat list request fails', async () => {
        answerChatLists({ 'wren.png': 500, 'orrin.png': { error: true } });
        host.confirmPopup.mockResolvedValue(false);
        await cleanUpLocks();

        expect(linesOfConfirm()).toContain('Chat locks were not checked: SillyTavern answered 500 when asked for the chats of Wren.');
    });

    it('says so when every lock names what exists and the index matches, asking nothing', async () => {
        host.extensionSettings.vectfox = {
            collections: { [HARBOR]: { lockedToChatIds: ['Wren - harbor'] } },
            chat_lock_index: { 'Wren - harbor': [HARBOR] },
            lorebase_books: { 'Harbor Lore': { selections: [{ id: 'first', name: 'Harbor Lore', selectedUids: [], pinnedSections: [], lockedToChatIds: ['Harbor night group'], lockedToCharacterAvatars: ['orrin.png'] }] } },
        };
        await cleanUpLocks();

        expect(host.confirmPopup).not.toHaveBeenCalled();
        expect(toastr.info).toHaveBeenCalledWith('Every lock names a chat or character that exists, and the chat lock index matches the locks.', 'VectFox');
    });

    it('warns when nothing else is stale but the chat locks were not checked', async () => {
        host.extensionSettings.vectfox = { collections: { [HARBOR]: { lockedToChatIds: ['Wren - harbor'] } }, chat_lock_index: { 'Wren - harbor': [HARBOR] } };
        answerChatLists({ 'wren.png': 503, 'orrin.png': [] });
        await cleanUpLocks();

        expect(host.confirmPopup).not.toHaveBeenCalled();
        expect(toastr.warning).toHaveBeenCalledWith(
            'No lock to remove, but chat locks were not checked: SillyTavern answered 503 when asked for the chats of Wren.',
            'VectFox',
        );
    });

    it('logs and shows a failure', async () => {
        host.confirmPopup.mockRejectedValue(new Error('the popup broke'));
        await cleanUpLocks();

        expect(host.logError).toHaveBeenCalledWith('VectFox: Clean up locks failed:', expect.any(Error));
        expect(toastr.error).toHaveBeenCalledWith('Clean up locks failed: the popup broke', 'VectFox');
        expect(host.extensionSettings.vectfox).toEqual(staleSettings());
    });
});
