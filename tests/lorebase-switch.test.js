/**
 * LoreBase's switch and SillyTavern's Vector Storage (src/features/lorebase/lorebase-switch.js and
 * lorebase-vector-storage.js, plan §5.9 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md):
 * LoreBase acts only while VectFox and its switch are on, on Qdrant (D15), and Vector Storage's World Info search is
 * off; turning LoreBase on off Qdrant says it needs Qdrant and stays off; so does turning it on while the model that
 * picks each reply's entries cannot run, before any question; turning it on asks first to write the keys and
 * vectors the selected entries lack (D17, §4.3 and §4.4 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md,
 * lorebase-keys-question.js), says why when they cannot be, and stays off when the user declines with no entry ready,
 * turning on with the ready ones on Not now; then it asks to turn that search off, LoreBase staying off when the user
 * keeps it; once on, what the user agreed to is written, and a writing that does not start says why. A reply
 * that finds the search on again asks which of the two to turn off, and closing the question leaves LoreBase sitting out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oneSelectionRecord } from './lorebase-book-record.js';

const host = vi.hoisted(() => ({ settings: { vectfox: {} }, isWorldInfoSearchOn: false, canTurnOff: true, pending: null, keyProblem: null, replyProblem: '' }));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.settings, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { verbose: vi.fn(), warn: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: vi.fn(), choicePopup: vi.fn(), noticePopup: vi.fn() }));
vi.mock('../src/features/lorebase/lorebase-setup.js', () => ({ replyModelProblem: () => host.replyProblem, writingProblem: vi.fn(() => host.keyProblem) }));
vi.mock('../src/features/lorebase/lorebase-storage.js', () => ({
    selectedEntriesNotReady: vi.fn(async () => {
        if (host.pending instanceof Error) throw host.pending;
        return host.pending;
    }),
    writeMissing: vi.fn(async () => ({ keysWritten: 0, vectorsWritten: 0, failed: 0, stopped: 0, unreadBooks: 0 })),
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
const { selectedEntriesNotReady, writeMissing } = await import('../src/features/lorebase/lorebase-storage.js');
const { turnOffVectorStorageWorldInfo } = await import('../src/sillytavern/vector-storage.js');
const { isLoreBaseActive, isLoreBaseSwitchedOn, loreBaseInactiveReason, onLoreBaseSwitchChange, turnLoreBaseOff } = await import('../src/features/lorebase/lorebase-switch.js');
const { settleVectorStorageConflict, turnLoreBaseOn } = await import('../src/features/lorebase/lorebase-vector-storage.js');

const showsSwitch = vi.fn();
onLoreBaseSwitchChange(showsSwitch);

const HARBOR_RECORD = oneSelectionRecord({ selectedUids: ['0'], lockedToChatIds: ['chat-harbor'] });

beforeEach(() => {
    vi.clearAllMocks();
    globalThis.toastr = { warning: vi.fn() };
    host.settings.vectfox = { vector_backend: 'qdrant', lorebase_books: { 'Harbor Atlas': HARBOR_RECORD } };
    host.isWorldInfoSearchOn = false;
    host.canTurnOff = true;
    host.pending = { books: [], count: 0, readyCount: 0, unreadBooks: 0 };
    host.keyProblem = null;
    host.replyProblem = '';
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
    it("turns on with no question when every selected entry is ready and Vector Storage's World Info search is off", async () => {
        expect((await turnLoreBaseOn()).isOn).toBe(true);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
        expect(saveSettingsDebounced).toHaveBeenCalled();
        expect(showsSwitch).toHaveBeenCalledWith(true);
        expect(writeMissing).not.toHaveBeenCalled();
    });

    it('asks before writing the keys and vectors the selected entries lack, reading the vectors from Qdrant again, and turns on and writes them when the user agrees', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [] }], count: 311, readyCount: 0, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(true);

        expect((await turnLoreBaseOn()).isOn).toBe(true);
        expect(selectedEntriesNotReady).toHaveBeenCalledWith(host.settings.vectfox, { isRereading: true });
        expect(confirmPopup).toHaveBeenCalledWith(expect.any(Array), { okButton: 'Write keys and vectors', cancelButton: 'Leave off' });
        expect(confirmPopup.mock.calls[0][0]).toContainEqual({ text: 'Selected entries without keys or vectors:', name: '311' });
        expect(confirmPopup.mock.calls[0][0].at(-1).text)
            .toBe('Write them and turn LoreBase on? A progress panel shows the writing. Without them, LoreBase stays off.');
        // No selection screen set a lock, so the books it writes keys for lock to the open chat as §6.1 says.
        expect(writeMissing).toHaveBeenCalledWith(host.settings.vectfox, ['keys', 'vectors'], { pending: host.pending, booksWithChosenLocks: [] });
        expect(isLoreBaseSwitchedOn()).toBe(true);
    });

    it('tells that a writing run started, so the books card leaves its line to the run', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [{ uid: 0 }] }], count: 1, readyCount: 0, decidedCount: 1, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(true);

        expect((await turnLoreBaseOn()).missing).toEqual({ missingCount: 1, missingKeyCount: 1, missingVectorCount: 0, decidedCount: 1, isWriting: true });
    });

    it('turns on, and says why in a notice, when the writing does not start', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [] }], count: 4, readyCount: 0, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(true);
        const refusal = new Error('LoreBase is already writing keys or vectors on the progress panel. Wait for it, or press Stop there.');
        writeMissing.mockRejectedValueOnce(refusal);

        expect((await turnLoreBaseOn()).isOn).toBe(true);
        await vi.waitFor(() => expect(noticePopup).toHaveBeenCalledWith([{ icon: 'fa-key', text: refusal.message }]));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('were not written'), refusal);
    });

    it('stays off and writes nothing when the user leaves it off with no entry ready, telling what the selection lacks', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [{ uid: 0 }, { uid: 1 }], vectorEntries: [{ uid: 1 }] }], count: 4, readyCount: 0, decidedCount: 4, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(false);

        expect(await turnLoreBaseOn()).toEqual({
            isOn: false, missing: { missingCount: 4, missingKeyCount: 2, missingVectorCount: 1, decidedCount: 4, isWriting: false },
        });
        expect(writeMissing).not.toHaveBeenCalled();
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(showsSwitch).not.toHaveBeenCalled();
    });

    it('asks about the keys and vectors before Vector Storage\'s search, so leaving LoreBase off turns nothing off', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [] }], count: 4, readyCount: 0, unreadBooks: 0 };
        host.isWorldInfoSearchOn = true;
        confirmPopup.mockResolvedValueOnce(false);

        expect((await turnLoreBaseOn()).isOn).toBe(false);
        expect(confirmPopup).toHaveBeenCalledTimes(1);
        expect(confirmPopup.mock.calls[0][1].okButton).toBe('Write keys and vectors');
        expect(turnOffVectorStorageWorldInfo).not.toHaveBeenCalled();
    });

    it('stays off, saying why, when the missing keys cannot be written', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [] }], count: 4, readyCount: 0, unreadBooks: 0 };
        host.keyProblem = 'LoreBase has no model. Until then the entries selected for LoreBase stay out of replies.';

        expect((await turnLoreBaseOn()).isOn).toBe(false);
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(noticePopup.mock.calls[0][0]).toContainEqual({ text: 'LoreBase cannot write them yet. Without them, LoreBase stays off.' });
        expect(noticePopup.mock.calls[0][0]).toContainEqual({ name: host.keyProblem });
        expect(isLoreBaseSwitchedOn()).toBe(false);
    });

    it('asks what writing needs for the kinds the entries lack alone, so missing vectors wait on no key model', async () => {
        const { writingProblem } = await import('../src/features/lorebase/lorebase-setup.js');
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [], vectorEntries: [{ uid: 0 }] }], count: 1, readyCount: 0, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(true);

        expect((await turnLoreBaseOn()).isOn).toBe(true);
        expect(writingProblem).toHaveBeenCalledWith(host.settings.vectfox, ['vectors']);
    });

    it('stays off, saying why, when the keys and vectors cannot be read', async () => {
        host.pending = new Error("Similharity could not read LoreBase's keys (HTTP 500): Qdrant is down");

        expect((await turnLoreBaseOn()).isOn).toBe(false);
        expect(noticePopup.mock.calls[0][0][0].text).toContain('could not read the keys and vectors');
        expect(noticePopup.mock.calls[0][0]).toContainEqual({ name: host.pending.message });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'), host.pending);
        expect(isLoreBaseSwitchedOn()).toBe(false);
    });

    it('turns on with the ready entries on Not now, writing nothing, and on its model unable to write keys yet', async () => {
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [] }], count: 4, readyCount: 357, unreadBooks: 0 };
        confirmPopup.mockResolvedValueOnce(false);

        expect((await turnLoreBaseOn()).isOn).toBe(true);
        expect(confirmPopup.mock.calls[0][1]).toEqual({ okButton: 'Write keys and vectors', cancelButton: 'Not now' });
        expect(confirmPopup.mock.calls[0][0].at(-1).text)
            .toBe('Write them and turn LoreBase on? A progress panel shows the writing. Until they are written, LoreBase goes on with the 357 entries that are ready.');
        expect(writeMissing).not.toHaveBeenCalled();
        expect(isLoreBaseSwitchedOn()).toBe(true);

        turnLoreBaseOff();
        host.keyProblem = 'LoreBase has no model. Until then the entries selected for LoreBase stay out of replies.';
        expect((await turnLoreBaseOn()).isOn).toBe(true);
        expect(writeMissing).not.toHaveBeenCalled();
    });

    it("stays off, saying why before any question, while the model that picks each reply's entries cannot run", async () => {
        host.replyProblem = 'Fast and Cheap [Jev] has no profile for Jev. Choose one in the Jev group of the LoreBase model card on the WorldInfo page.';
        host.pending = { books: [{ bookName: 'Harbor Atlas', keyEntries: [] }], count: 4, readyCount: 357, unreadBooks: 0 };
        host.isWorldInfoSearchOn = true;

        expect((await turnLoreBaseOn()).isOn).toBe(false);
        expect(noticePopup).toHaveBeenCalledWith([
            { icon: 'fa-plug', text: "LoreBase stays off: the model that picks each reply's entries cannot run yet." },
            { name: host.replyProblem },
        ]);
        expect(selectedEntriesNotReady).not.toHaveBeenCalled();
        expect(confirmPopup).not.toHaveBeenCalled();
        expect(turnOffVectorStorageWorldInfo).not.toHaveBeenCalled();
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(showsSwitch).not.toHaveBeenCalled();
    });

    it('stays off on the Standard backend, and says LoreBase needs Qdrant, reading nothing', async () => {
        host.settings.vectfox.vector_backend = 'standard';
        expect(await turnLoreBaseOn()).toEqual({ isOn: false, missing: null });
        expect(noticePopup.mock.calls[0][0][0].text).toContain('LoreBase needs Qdrant');
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(writeMissing).not.toHaveBeenCalled();
    });

    it('asks to turn that search off first, and turns it off and LoreBase on when the user agrees', async () => {
        host.isWorldInfoSearchOn = true;
        confirmPopup.mockResolvedValueOnce(true);

        expect((await turnLoreBaseOn()).isOn).toBe(true);
        expect(confirmPopup).toHaveBeenCalledWith(expect.any(Array), { okButton: 'Turn it off', cancelButton: 'Keep it on' });
        expect(turnOffVectorStorageWorldInfo).toHaveBeenCalledTimes(1);
        expect(host.settings.vectfox.lorebase_enabled).toBe(true);
        expect(isLoreBaseActive()).toBe(true);
    });

    it('stays off, and leaves the search on, when the user keeps it', async () => {
        host.isWorldInfoSearchOn = true;
        confirmPopup.mockResolvedValueOnce(false);

        expect((await turnLoreBaseOn()).isOn).toBe(false);
        expect(turnOffVectorStorageWorldInfo).not.toHaveBeenCalled();
        expect(host.isWorldInfoSearchOn).toBe(true);
        expect(isLoreBaseSwitchedOn()).toBe(false);
        expect(showsSwitch).not.toHaveBeenCalled();
    });

    it('stays off, with a toast saying where to turn the search off, when it would not turn off', async () => {
        host.isWorldInfoSearchOn = true;
        host.canTurnOff = false;
        confirmPopup.mockResolvedValueOnce(true);

        expect((await turnLoreBaseOn()).isOn).toBe(false);
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
