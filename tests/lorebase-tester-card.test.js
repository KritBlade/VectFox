/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase tester card (src/features/settings-panel/lorebase-tester-card.js, plan §5.10 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): it lists the open chat's reports newest
 * first and draws the picked one, hiding the Reply list while there is none; it follows the newest report until the
 * user picks an older one; drawing the same report again keeps the parts the user opened; and it measures the report it
 * draws only while the card is shown, drawing it again when the card's tab opens.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ reports: [], listener: null, settings: { lorebase_accuracy: 'fast' } }));

vi.mock('../src/features/lorebase/index.js', () => ({
    loreBaseReports: () => host.reports,
    measureLoreBaseReport: vi.fn(async () => {}),
    onLoreBaseReportsChange: listener => { host.listener = listener; },
    tryLoreBasePick: vi.fn(async () => ({ problem: null })),
}));

const { measureLoreBaseReport, tryLoreBasePick } = await import('../src/features/lorebase/index.js');
const { WORLDINFO_TAB, WORLDINFO_TABS_ID, worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { showSubTab } = await import('../src/shared/gui-dna/gene-behaviours.js');
const { bindLoreBaseTester, refreshLoreBaseTester } = await import('../src/features/settings-panel/lorebase-tester-card.js');

const lighthouse = {
    bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', basis: 'named in the chat', certain: true, why: 'Wren asks.',
    needs: 'the keeper', wholeText: 'whole', failure: null, isInPrompt: null,
    review: { uses: 'some', seconds: 3, parts: [{ text: 'Kept.', isSent: true }, { text: 'Left out.', isSent: false }], sentText: 'Kept.' },
};
const report = (id, picks = [lighthouse]) => ({
    id, chatId: 'chat-harbor', type: 'normal', accuracy: 'high', madeAt: Date.UTC(2026, 10, 15, 15, 0, id % 60),
    contentCount: 2, picks, skipped: [{ bookName: 'Harbor Atlas', uid: 1, title: 'Tidewardens' }], unreadItemCount: 0, failures: [],
    seconds: { pick: 2, slowestReview: 3, total: 5 }, isUnderWay: false, messageIndex: id, swipeId: 0,
    isMeasuring: false, measureFailure: null, tokens: null, keysState: 'unmeasured', keys: null,
});
const list = () => document.getElementById('VectFox_lorebase_report');
const options = () => [...list().options].map(option => `${option.value}${option.selected ? ' (shown)' : ''}`);
const drawnTitle = () => document.querySelector('#VectFox_lorebase_report_body .vfx-record-name')?.textContent ?? null;
const drawnMessage = () => list().selectedOptions[0]?.textContent.split(' · ')[2] ?? null;
const pick = id => {
    list().value = String(id);
    list().dispatchEvent(new Event('change'));
};
const showCard = () => {
    document.getElementById('VectFox_lorebase_tester_card').getClientRects = () => [{ width: 1, height: 1 }];
};
const isFolded = selector => document.querySelector(`#VectFox_lorebase_report_body ${selector}`).classList.contains('is-collapsed');

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    host.reports = [];
    globalThis.toastr = { warning: vi.fn() };
    bindLoreBaseTester(host.settings);
});
const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });

describe('the LoreBase tester card', () => {
    it('hides the Reply list and says so while the open chat has no report', () => {
        refreshLoreBaseTester();
        expect(document.getElementById('VectFox_lorebase_report_field').style.display).toBe('none');
        expect(document.getElementById('VectFox_lorebase_report_body').textContent).toContain('No reply in this chat used LoreBase since the page loaded.');
        expect(measureLoreBaseReport).not.toHaveBeenCalled();
    });

    it('lists the reports newest first and draws the newest, measured while the card is shown', () => {
        host.reports = [report(102), report(101)];
        showCard();
        refreshLoreBaseTester();
        expect(document.getElementById('VectFox_lorebase_report_field').style.display).toBe('');
        expect(options()).toEqual(['102 (shown)', '101']);
        expect(drawnTitle()).toBe('Lighthouse of Vell');
        expect(measureLoreBaseReport).toHaveBeenCalledWith(host.reports[0]);
    });

    it('measures nothing while the card is hidden', () => {
        host.reports = [report(111)];
        refreshLoreBaseTester();
        expect(drawnTitle()).toBe('Lighthouse of Vell');
        expect(measureLoreBaseReport).not.toHaveBeenCalled();
    });

    it('draws the report again when its tab opens, measuring it now that the card shows, and not when another tab opens', () => {
        host.reports = [report(112)];
        refreshLoreBaseTester();
        showCard();
        const gene = document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`);
        showSubTab(gene, WORLDINFO_TAB.entityLore);
        expect(measureLoreBaseReport).not.toHaveBeenCalled();
        showSubTab(gene, WORLDINFO_TAB.tester);
        expect(measureLoreBaseReport).toHaveBeenCalledWith(host.reports[0]);
    });

    it('follows the newest report until an older one is picked, keeps that one, and follows again once the newest is picked', () => {
        host.reports = [report(122), report(121)];
        refreshLoreBaseTester();
        pick(121);
        expect(drawnMessage()).toBe('message #121');

        host.reports = [report(123), ...host.reports];
        host.listener();
        expect(options()).toEqual(['123', '122', '121 (shown)']);

        pick(123);
        host.reports = [report(124), ...host.reports];
        host.listener();
        expect(drawnMessage()).toBe('message #124');
    });

    it('keeps open the parts the user opened when it draws the same report again, and folds them for another', () => {
        host.reports = [report(131)];
        refreshLoreBaseTester();
        expect([isFolded('[data-lorebase-parts="0"]'), isFolded('[data-lorebase-skipped]')]).toEqual([true, true]);

        document.querySelector('#VectFox_lorebase_report_body [data-lorebase-parts="0"]').classList.remove('is-collapsed');
        host.listener();
        expect([isFolded('[data-lorebase-parts="0"]'), isFolded('[data-lorebase-skipped]')]).toEqual([false, true]);

        host.reports = [report(132), ...host.reports];
        host.listener();
        expect(isFolded('[data-lorebase-parts="0"]')).toBe(true);
    });

    it("runs Try a pick on the panel's settings, busy until it ends, then follows the newest report, its try", async () => {
        host.reports = [report(142), report(141)];
        refreshLoreBaseTester();
        pick(141);
        expect(drawnMessage()).toBe('message #141');

        let finish;
        tryLoreBasePick.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const button = document.getElementById('VectFox_lorebase_try_pick');
        button.click();
        expect(tryLoreBasePick).toHaveBeenCalledWith(host.settings);
        expect(button.disabled).toBe(true);

        host.reports = [{ ...report(143), type: 'try', isTry: true, messageIndex: null, keysState: 'unavailable' }, ...host.reports];
        host.listener();
        finish({ problem: null });
        await settle();
        expect(button.disabled).toBe(false);
        expect(list().selectedOptions[0].textContent).toMatch(/ · try · no reply$/);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('says why a try picked nothing', async () => {
        tryLoreBasePick.mockResolvedValueOnce({ problem: 'Use LoreBase is off.' });
        document.getElementById('VectFox_lorebase_try_pick').click();
        await settle();
        expect(globalThis.toastr.warning).toHaveBeenCalledWith('Use LoreBase is off.', 'VectFox — Try a pick', expect.any(Object));
    });
});
