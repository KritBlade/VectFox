/**
 * LoreBase's tester (src/features/lorebase/lorebase-tester.js, plan §5.10 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): this session's reports, the newest 20, each listed only in its own
 * chat; at the interceptor's end a report keeps what the World Info scan reads next, as SillyTavern reads it; the scan
 * that follows says which picks SillyTavern kept; the reply's end ties the report to its message and the World Info
 * its prompt held; and a report is measured once its reply ended, with what SillyTavern's keys would send waiting for a
 * scan that was due, the card told only of a change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    handlers: {},
    chatId: 'chat-harbor',
    context: { chat: [] },
    itemized: [],
    isScanDue: false,
    fields: {
        persona: 'A lamp-keeper\'s apprentice.', description: 'Keeper Orrin keeps the lighthouse.', personality: 'Patient.',
        charDepthPrompt: '', scenario: 'A storm night in Vell.', creatorNotes: '',
    },
}));

vi.mock('../src/sillytavern/chat.js', () => ({
    getCharacterCardFields: vi.fn(() => host.fields),
    getContext: () => host.context,
    getCurrentChatId: () => host.chatId,
}));
vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: { on: (event, handler) => { host.handlers[event] = handler; } },
    event_types: { WORLD_INFO_ACTIVATED: 'world_info_activated', GENERATION_ENDED: 'generation_ended' },
}));
vi.mock('../src/sillytavern/itemized-prompts.js', () => ({ itemizedPrompts: host.itemized }));
vi.mock('../src/sillytavern/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), domain: vi.fn(), enabled: () => false },
}));
vi.mock('../src/sillytavern/tokenizers.js', () => ({
    getTokenCountAsync: vi.fn(async text => String(text).split(/\s+/u).filter(Boolean).length),
}));
vi.mock('../src/sillytavern/world-info.js', () => ({ checkWorldInfo: vi.fn(), world_info_include_names: true }));
vi.mock('../src/features/lorebase/lorebase-delivery.js', () => ({
    scanLeftToSillyTavern: vi.fn(async scan => (host.isScanDue ? null : scan())),
}));

const { getCharacterCardFields } = await import('../src/sillytavern/chat.js');
const { log } = await import('../src/sillytavern/log.js');
const { getTokenCountAsync } = await import('../src/sillytavern/tokenizers.js');
const { checkWorldInfo } = await import('../src/sillytavern/world-info.js');
const tester = await import('../src/features/lorebase/lorebase-tester.js');

tester.initializeLoreBaseTester();
const changes = vi.fn();
tester.onLoreBaseReportsChange(changes);

const lighthouse = { uid: 0, comment: 'Lighthouse of Vell', content: 'The lighthouse stands on the north cliff of Vell.' };
const tidewardens = { uid: 1, comment: 'Tidewardens', content: 'The tidewardens read the harbor bells.' };
const books = [{ bookName: 'Harbor Atlas', entries: [lighthouse, tidewardens], pinnedSections: [] }];
const passage = text => ({ section: '(intro)', text, tokens: 5 });
const replyLore = () => ({
    contentCount: 2,
    picks: [{ number: 1, bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', basis: 'named in the chat', certain: true, why: 'Wren asks.', needs: 'the keeper' }],
    unreadItemCount: 0,
    pickSeconds: 2.1,
    reviewedPicks: [{ bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', uses: 'most', frame: null, passages: [passage(lighthouse.content)], sentParts: [1], seconds: 3.4 }],
    failures: [],
});
const replyChat = [{ name: 'Keeper Orrin', mes: 'The lamp is lit.' }, { name: 'Wren', mes: 'Who keeps it tonight?' }];

/** A reply as the interceptor and SillyTavern run it: the report, the scan kept, and the reply's end at message 2. */
function reply({ type = 'normal', isEnded = true } = {}) {
    const lore = replyLore();
    tester.recordReplyReport({ lore, books, type, accuracy: 'default', seconds: 5.6 });
    tester.keepReplyScan(lore, { chat: replyChat, maxContext: 8000, type });
    if (isEnded) {
        host.context.chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c', swipe_id: 1 }];
        host.handlers.generation_ended(3);
    }
    return tester.loreBaseReports()[0];
}

beforeEach(() => {
    vi.clearAllMocks();
    host.chatId = `chat-${Math.random()}`;
    host.isScanDue = false;
    host.itemized.splice(0, host.itemized.length);
    checkWorldInfo.mockResolvedValue({
        worldInfoBefore: 'Keeper Orrin keeps the lamp.', worldInfoAfter: ' The old pier fell.',
        allActivatedEntries: new Set([{ world: 'Harbor Atlas', uid: 1, content: tidewardens.content }, { world: 'Harbor Atlas', uid: 9, content: 'Not selected.' }]),
    });
});

afterEach(() => {
    // Let go of any reply a test left under way.
    host.handlers.generation_ended(0);
});

describe("this session's reports", () => {
    it('lists the open chat\'s reports alone, newest first, and keeps the newest 20', () => {
        for (let count = 0; count < 21; count += 1) reply();
        const listed = tester.loreBaseReports();
        expect(listed).toHaveLength(20);
        expect(listed[0].id).toBeGreaterThan(listed[19].id);
        expect(changes).toHaveBeenCalled();
        host.chatId = 'chat-wren';
        expect(tester.loreBaseReports()).toEqual([]);
    });

    it("keeps what the scan reads at the interceptor's end: the chat as SillyTavern reads it, the context size and the card's fields", () => {
        const report = reply({ type: 'swipe', isEnded: false });
        expect(report.scan).toEqual({
            chatForWorldInfo: ['Wren: Who keeps it tonight?', 'Keeper Orrin: The lamp is lit.'],
            maxContext: 8000,
            globalScanData: {
                personaDescription: host.fields.persona, characterDescription: host.fields.description, characterPersonality: host.fields.personality,
                characterDepthPrompt: '', scenario: host.fields.scenario, creatorNotes: '', trigger: 'swipe',
            },
        });
        expect(report.isUnderWay).toBe(true);
    });

    it('keeps no scan for a reply it has no report of', () => {
        tester.keepReplyScan(null, { chat: replyChat, maxContext: 8000, type: 'quiet' });
        expect(getCharacterCardFields).not.toHaveBeenCalled();
    });

    it('makes no report, with a warning, of lore it cannot read, and never throws into the reply', () => {
        const before = tester.loreBaseReports().length;
        expect(() => tester.recordReplyReport({ lore: { ...replyLore(), failures: null }, books, type: 'normal', accuracy: 'default', seconds: 1 })).not.toThrow();
        expect(tester.loreBaseReports()).toHaveLength(before);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not make'), expect.any(TypeError));
    });

    it("notes a pick in the prompt when an entry the reply's scan activated carries what it sent, as LoreBase's block does", () => {
        const report = reply({ isEnded: false });
        host.handlers.world_info_activated([{ world: 'Harbor Atlas', uid: 0, content: `<VectLorebook>\n<Lighthouse_of_Vell>\n${lighthouse.content}\n</Lighthouse_of_Vell>\n</VectLorebook>` }]);
        expect(report.picks[0].isInPrompt).toBe(true);
    });

    it("notes which picks the reply's scan kept, then ties the report to the reply's message and its prompt's World Info", () => {
        const report = reply({ isEnded: false });
        host.handlers.world_info_activated([{ world: 'Harbor Atlas', uid: 1, content: tidewardens.content }]);
        host.handlers.world_info_activated([{ world: 'Harbor Atlas', uid: 0, content: lighthouse.content }]);
        expect(report.picks[0].isInPrompt).toBe(false);

        host.itemized.push({ mesId: 1, worldInfoString: 'older' }, { mesId: 2, worldInfoString: 'Keeper Orrin keeps the lamp.' });
        host.context.chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c', swipe_id: 1 }];
        changes.mockClear();
        host.handlers.generation_ended(3);
        expect(report).toMatchObject({ isUnderWay: false, messageIndex: 2, swipeId: 1, promptWorldInfo: 'Keeper Orrin keeps the lamp.' });
        expect(changes).toHaveBeenCalledTimes(1);
    });

    it('lets go of a reply that never ended once the next reply is under way', () => {
        const stranded = reply({ isEnded: false });
        const next = reply({ isEnded: false });
        expect([stranded.isUnderWay, next.isUnderWay]).toEqual([false, true]);
    });

    it('keeps the report without a scan, with a warning, when the card\'s fields cannot be read', () => {
        getCharacterCardFields.mockImplementationOnce(() => { throw new Error('no character'); });
        const report = reply();
        expect(report.scan).toBeNull();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not keep'), expect.any(Error));
    });
});

describe('measuring a report', () => {
    it("counts once the reply ended: the picks' tokens, the prompt's World Info, and what SillyTavern's keys would send", async () => {
        host.itemized.push({ mesId: 2, worldInfoString: 'Keeper Orrin keeps the lamp.' });
        const report = reply();
        changes.mockClear();
        await tester.measureLoreBaseReport(report);

        expect(checkWorldInfo).toHaveBeenCalledWith(report.scan.chatForWorldInfo, 8000, true, report.scan.globalScanData);
        expect(report.tokens).toEqual({ sent: 9, pickedWhole: 9, picks: [{ sent: 9, whole: 9 }], promptWorldInfo: 5 });
        expect(report.keysState).toBe('measured');
        expect(report.keys).toEqual({ entries: 1, tokens: 6, worldInfo: 9 });
        expect(changes).toHaveBeenCalledTimes(1);

        await tester.measureLoreBaseReport(report);
        expect(checkWorldInfo).toHaveBeenCalledTimes(1);
    });

    it('measures nothing while a reply is under way', async () => {
        const report = reply({ isEnded: false });
        await tester.measureLoreBaseReport(report);
        expect(getTokenCountAsync).not.toHaveBeenCalled();
        expect(report.tokens).toBeNull();
    });

    it("waits for a generation's scan that was due, tells the card once, and measures the keys when shown again", async () => {
        const report = reply();
        host.isScanDue = true;
        changes.mockClear();
        await tester.measureLoreBaseReport(report);
        expect([report.keysState, report.keys, report.tokens.sent]).toEqual(['waiting', null, 9]);
        expect(changes).toHaveBeenCalledTimes(1);

        await tester.measureLoreBaseReport(report);
        expect(changes).toHaveBeenCalledTimes(1);

        host.isScanDue = false;
        await tester.measureLoreBaseReport(report);
        expect(report.keysState).toBe('measured');
        expect(changes).toHaveBeenCalledTimes(2);
    });

    it("says the keys cannot be measured when the reply's scan was not kept", async () => {
        getCharacterCardFields.mockImplementationOnce(() => { throw new Error('no character'); });
        const report = reply();
        await tester.measureLoreBaseReport(report);
        expect([report.keysState, report.keys]).toEqual(['unavailable', null]);
        expect(checkWorldInfo).not.toHaveBeenCalled();
    });

    it('logs a count that failed and shows it in the report, and does not count again', async () => {
        const report = reply();
        getTokenCountAsync.mockRejectedValueOnce(new Error('tokenizer offline'));
        changes.mockClear();
        await tester.measureLoreBaseReport(report);
        expect(report.measureFailure).toBe('tokenizer offline');
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not count'), expect.any(Error));
        expect(changes).toHaveBeenCalledTimes(1);
        await tester.measureLoreBaseReport(report);
        expect(checkWorldInfo).not.toHaveBeenCalled();
    });

    it("makes a try's report with no reply to wait for: measured at once, its picks' tokens only, the keys left unmeasured", async () => {
        tester.recordReplyReport({ lore: replyLore(), books, type: 'try', accuracy: 'default', seconds: 5.6, isReply: false });
        const report = tester.loreBaseReports()[0];
        expect([report.type, report.isTry, report.isUnderWay, report.keysState]).toEqual(['try', true, false, 'unavailable']);

        await tester.measureLoreBaseReport(report);
        expect(report.tokens).toEqual({ sent: 9, pickedWhole: 9, picks: [{ sent: 9, whole: 9 }], promptWorldInfo: null });
        expect([report.keysState, report.keys]).toEqual(['unavailable', null]);
        expect(checkWorldInfo).not.toHaveBeenCalled();

        // A reply's end ties nothing to a try.
        host.handlers.generation_ended(3);
        expect(report.messageIndex).toBeNull();
    });

    it("measures only the open chat's report, as the scan loads the open chat's books", async () => {
        const report = reply();
        host.chatId = 'chat-wren';
        await tester.measureLoreBaseReport(report);
        expect(report.tokens).toBeNull();
    });
});
