/**
 * LoreBase's switch and SillyTavern's Vector Storage (src/features/lorebase/lorebase-switch.js and
 * lorebase-vector-storage.js, plan §5.9 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md):
 * LoreBase acts only while VectFox and its switch are on, on Qdrant (D15), and Vector Storage's World Info search is
 * off; turning LoreBase on off Qdrant says it needs Qdrant and stays off; turning it on asks first to have the selected
 * entries with no keys keyed (D17), says why when they cannot be, and stays off unless the user agrees; then it asks to
 * turn that search off, LoreBase staying off when the user keeps it; once on, the missing keys are written. A reply
 * that finds the search on again asks which of the two to turn off, and closing the question leaves LoreBase sitting out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ settings: { vectfox: {} }, isWorldInfoSearchOn: false, canTurnOff: true, pending: null, keyProblem: null }));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { verbose: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(), choicePopup: vi.fn(), noticePopup: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-keys.js', () => ({
    selectedEntriesWithoutKeys: vi.fn(async () => {
        if (host.pending instanceof Error) throw host.pending;
        return host.pending;
    }),
    keyWritingProblem: () => host.keyProblem,
    writeKeysOfSelections: vi.fn(async () => ({ written: 0, failed: 0, stopped: 0, unreadBooks: 0 })),
}));
vi.mock('../src/sillytavern/vector-storage.js', () => ({
    isVectorStorageWorldInfoOn: () => host.isWorldInfoSearchOn,
    turnOffVectorStorageWorldInfo: vi.fn(async () => {
        if (host.canTurnOff) host.isWorldInfoSearchOn = false;
        return !host.isWorldInfoSearchOn;
    }),
}));

const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');
const { log } = await import('../src/sillytavern/log.js');
const { choicePopup, confirmPopup, noticePopup } = await import('../src/sillytavern/popup.js');
const { writeKeysOfSelections } = await import('../src/features/lorebase/lorebase-keys.js');
const { turnOffVectorStorageWorldInfo } = await import('../src/sillytavern/vector-storage.js');
const { isLoreBaseActive, isLoreBaseSwitchedOn, loreBaseInactiveReason, onLoreBaseSwitchChange, turnLoreBaseOff } = await import('../src/features/lorebase/lorebase-switch.js');
const { settleVectorStorageConflict, turnLoreBaseOn } = await import('../src/features/lorebase/lorebase-vector-storage.js');

const showsSwitch = vi.fn();
onLoreBaseSwitchChange(showsSwitch);

const HARBOR_RECORD = { selectedUids: ['0'], pinnedSections: [], lockedToChatIds: ['chat-harbor'], lockedToCharacterAvatars: [] };

beforeEach(() => {
    vi.clearAllMocks();
    globalThis.toastr = { warning: vi.fn() };
    host.settings.vectfox = { vector_backend: 'qdrant', lorebase_books: { 'Harbor Atlas': HARBOR_RECORD } };
    host.isWorldInfoSearchOn = false;
    host.canTurnOff = true;
    host.pending = { books: [], count: 0, unreadBooks: 0 };
    host.keyProblem = null;
});

describe('when LoreBase acts', () => {
    it("acts only while VectFox and LoreBase are on, on Qdrant, and Vector Storage's World Info search is off", () => {
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(isLoreBaseActive()).toBe(false);

        host.settings.vectfox.lorebase_enabled = true;
        expect(isLoreBaseActive()).toBe(true);
        expect(isLoreBaseActive({ enabled: false, lorebase_enabled: true, vector_backend: 'qdrant' })).toBe(false);
        expect(isLoreBaseActive({ lorebase_enabled: true, vector_backend: 'standard' })).toBe(false);

        host.isWorldInfoSearchOn = true;
        expect(isLoreBaseActive()).toBe(false);
    });

    it('says why it does not act, first cause first, and nothing while it acts', () => {
        expect(loreBaseInactiveReason({ enabled: false, lorebase_enabled: false, vector_backend: 'standard' })).toBe('VectFox is turned off.');
        expect(loreBaseInactiveReason({ lorebase_enabled: false, vector_backend: 'standard' })).toBe('Use LoreBase is off.');
        expect(loreBaseInactiveReason({ lorebase_enabled: true, vector_backend: 'standard' })).toBe('LoreBase runs on the Qdrant backend only.');
        expect(loreBaseInactiveReason({ lorebase_enabled: true, vector_backend: 'qdrant' })).toBeNull();
        host.isWorldInfoSearchOn = true;
        expect(loreBaseInactiveReason({ lorebase_enabled: true, vector_backend: 'qdrant' }))
            .toBe("SillyTavern's Vector Storage has its World Info search on, which LoreBase leaves alone.");
    });
});

describe('turning LoreBase on and off', () => {
    it("turns on with no question when every selected entry has keys and Vector Storage's World Info search is off", async () => {
        expect(await turnLoreBaseOn()).toBe(true);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
        expect(saveSettingsDebounced).toHaveBeenCalled();
        expect(showsSwitch).toHaveBeenCalledWith(true);
        expect(writeKeysOfSelections).not.toHaveBeenCalled();
    });

    it('asks before writing the selected entries\' missing keys, and turns on and writes them when the user agrees', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', entries: [] }], count: 311, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(true);

        expect(await turnLoreBaseOn()).toBe(true);
        expect(confirmPopup).toHaveBeenCalledWith(expect.any(Array), { okButton: 'Write keys', cancelButton: 'Leave off' });
        expect(confirmPopup.mock.calls[0][0]).toContainEqual({ text: 'Selected entries with no keys:', name: '311' });
        expect(writeKeysOfSelections).toHaveBeenCalledWith(host.settings.vectfox, host.pending);
        expect(isLoreBaseSwitchedOn()).toBe(true);
    });

    it('stays off and writes nothing when the user leaves it off', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', entries: [] }], count: 4, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(false);

        expect(await turnLoreBaseOn()).toBe(false);
        expect(writeKeysOfSelections).not.toHaveBeenCalled();
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(showsSwitch).not.toHaveBeenCalled();
    });

    it('asks about the keys before Vector Storage\'s search, so leaving LoreBase off turns nothing off', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', entries: [] }], count: 4, unreadBooks: 0 };
        host.isWorldInfoSearchOn = true;
        confirmPopup.mockResolvedValueOnce(false);

        expect(await turnLoreBaseOn()).toBe(false);
        expect(confirmPopup).toHaveBeenCalledTimes(1);
        expect(confirmPopup.mock.calls[0][1].okButton).toBe('Write keys');
        expect(turnOffVectorStorageWorldInfo).not.toHaveBeenCalled();
    });

    it('stays off, saying why, when the missing keys cannot be written', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', entries: [] }], count: 4, unreadBooks: 0 };
        host.keyProblem = 'LoreBase has no model. Until then the entries selected for LoreBase stay out of replies.';

        expect(await turnLoreBaseOn()).toBe(false);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(noticePopup.mock.calls[0][0]).toContainEqual({ name: host.keyProblem });
        expect(isLoreBaseSwitchedOn()).toBe(false);
    });

    it('stays off, saying why, when the keys cannot be read', async () => {
        host.pending = new Error("Similharity could not read LoreBase's keys (HTTP 500): Qdrant is down");

        expect(await turnLoreBaseOn()).toBe(false);
        expect(noticePopup.mock.calls[0][0][0].text).toContain('could not read the keys');
        expect(noticePopup.mock.calls[0][0]).toContainEqual({ name: host.pending.message });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'), host.pending);
        expect(isLoreBaseSwitchedOn()).toBe(false);
    });

    it('stays off on the Standard backend, and says LoreBase needs Qdrant', async () => {
        host.settings.vectfox.vector_backend = 'standard';
        expect(await turnLoreBaseOn()).toBe(false);
        expect(noticePopup.mock.calls[0][0][0].text).toContain('LoreBase needs Qdrant');
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(writeKeysOfSelections).not.toHaveBeenCalled();
    });

    it('asks to turn that search off first, and turns it off and LoreBase on when the user agrees', async () => {
        host.isWorldInfoSearchOn = true;
        confirmPopup.mockResolvedValueOnce(true);

        expect(await turnLoreBaseOn()).toBe(true);
        expect(confirmPopup).toHaveBeenCalledWith(expect.any(Array), { okButton: 'Turn it off', cancelButton: 'Keep it on' });
        expect(turnOffVectorStorageWorldInfo).toHaveBeenCalledTimes(1);
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
        expect(isLoreBaseActive()).toBe(true);
    });

    it('stays off, and leaves the search on, when the user keeps it', async () => {
        host.isWorldInfoSearchOn = true;
        confirmPopup.mockResolvedValueOnce(false);

        expect(await turnLoreBaseOn()).toBe(false);
        expect(turnOffVectorStorageWorldInfo).not.toHaveBeenCalled();
        expect(host.isWorldInfoSearchOn).toBe(true);
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(showsSwitch).not.toHaveBeenCalled();
    });

    it('stays off, with a toast saying where to turn the search off, when it would not turn off', async () => {
        host.isWorldInfoSearchOn = true;
        host.canTurnOff = false;
        confirmPopup.mockResolvedValueOnce(true);

        expect(await turnLoreBaseOn()).toBe(false);
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(expect.stringContaining('Enabled for World Info'), 'VectFox — LoreBase', expect.any(Object));
    });

    it('turns off keeping the selections, pins and locks, and tells whoever shows the switch', () => {
        host.settings.vectfox.lorebase_enabled = true;
        turnLoreBaseOff();
        expect(host.settings.vectfox).toEqual({ vector_backend: 'qdrant', lorebase_books: { 'Harbor Atlas': HARBOR_RECORD }, lorebase_enabled: false });
        expect(showsSwitch).toHaveBeenCalledWith(false);
    });
});

describe("a reply that finds Vector Storage's World Info search on again", () => {
    beforeEach(() => {
        host.settings.vectfox.lorebase_enabled = true;
        host.isWorldInfoSearchOn = true;
    });

    it('asks nothing while the two do not meet: the search off, LoreBase off, or VectFox off', async () => {
        host.isWorldInfoSearchOn = false;
        await settleVectorStorageConflict();
        host.isWorldInfoSearchOn = true;
        host.settings.vectfox.lorebase_enabled = false;
        await settleVectorStorageConflict();
        host.settings.vectfox = { enabled: false, lorebase_enabled: true };
        await settleVectorStorageConflict();
        expect(choicePopup).not.toHaveBeenCalled();
    });

    it("turns the search off when the user picks it, so LoreBase acts in this reply", async () => {
        choicePopup.mockResolvedValueOnce('vector-storage');
        await settleVectorStorageConflict();

        expect(choicePopup.mock.calls[0][1]).toEqual({
            choices: [{ text: 'Turn its World Info off', value: 'vector-storage' }, { text: 'Turn LoreBase off', value: 'lorebase' }],
            cancelButton: false,
        });
        expect(turnOffVectorStorageWorldInfo).toHaveBeenCalledTimes(1);
        expect(isLoreBaseActive()).toBe(true);
    });

    it('turns LoreBase off when the user picks it, leaving the search on', async () => {
        choicePopup.mockResolvedValueOnce('lorebase');
        await settleVectorStorageConflict();

        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(host.isWorldInfoSearchOn).toBe(true);
        expect(showsSwitch).toHaveBeenCalledWith(false);
    });

    it('leaves both on when the question is closed, so LoreBase sits out this reply', async () => {
        choicePopup.mockResolvedValueOnce(null);
        await settleVectorStorageConflict();

        expect(turnOffVectorStorageWorldInfo).not.toHaveBeenCalled();
        expect(isLoreBaseSwitchedOn()).toBe(true);
        expect(isLoreBaseActive()).toBe(false);
        expect(log.verbose).toHaveBeenCalledWith(expect.stringContaining('goes without LoreBase'));
    });

    it('toasts when the search would not turn off, and LoreBase sits out', async () => {
        host.canTurnOff = false;
        choicePopup.mockResolvedValueOnce('vector-storage');
        await settleVectorStorageConflict();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(isLoreBaseActive()).toBe(false);
    });
});
