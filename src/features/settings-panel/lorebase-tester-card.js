/**
 * The WorldInfo page's LoreBase tester card (plan §5.10 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md), on the page's LoreBase tester tab: Try a pick, which runs the
 * next reply's pick with no reply; this session's reports for the open chat, the newest first in its Reply list, and the
 * one picked there drawn in full. Picking the newest follows each new reply; picking an older one keeps it. A report is
 * measured only while the card is shown, so opening its tab draws the report again; it is drawn again on each change
 * too, with the parts and lists the user opened kept open.
 */
import { setCollapsed, setShown } from '../../shared/gui-dna/gene-behaviours.js';
import { loreBaseReports, measureLoreBaseReport, onLoreBaseReportsChange, tryLoreBasePick } from '../lorebase/index.js';
import { WORLDINFO_TAB, WORLDINFO_TABS_ID, loreBaseReportMarkup, loreBaseReportOptions } from './worldinfo-page-markup.js';

const FOLDED_BOXES = '[data-lorebase-parts], [data-lorebase-skipped]';
// The report picked in the Reply list, or null to follow the newest.
let pickedReportId = null;
// The report drawn last, so drawing it again keeps the folded boxes the user opened.
let drawnReportId = null;

const boxKey = box => box.dataset.lorebaseParts ?? 'skipped';
const isCardShown = () => Boolean(document.getElementById('VectFox_lorebase_tester_card')?.getClientRects().length);

/** Draw the open chat's reports, the picked one in full, and measure it while the card is shown. */
export function refreshLoreBaseTester() {
    const list = document.getElementById('VectFox_lorebase_report');
    const body = document.getElementById('VectFox_lorebase_report_body');
    if (!list || !body) return;
    const reports = loreBaseReports();
    const report = reports.find(candidate => candidate.id === pickedReportId) ?? reports[0] ?? null;
    const openedBoxes = report && report.id === drawnReportId
        ? new Set([...body.querySelectorAll(FOLDED_BOXES)].filter(box => !box.classList.contains('is-collapsed')).map(boxKey))
        : new Set();
    drawnReportId = report?.id ?? null;
    list.innerHTML = loreBaseReportOptions(reports, drawnReportId);
    setShown(document.getElementById('VectFox_lorebase_report_field'), reports.length > 0);
    body.innerHTML = loreBaseReportMarkup(report);
    for (const box of body.querySelectorAll(FOLDED_BOXES)) setCollapsed(box, !openedBoxes.has(boxKey(box)));
    // Measuring never throws: it logs what failed and shows it in the report.
    if (report && isCardShown()) void measureLoreBaseReport(report);
}

/**
 * Run Try a pick, and draw its report once made: the card follows the newest again. A try that picks nothing says why.
 * @param {HTMLButtonElement} button
 * @param {object} settings - The settings panel's settings object
 */
async function tryPick(button, settings) {
    button.disabled = true;
    pickedReportId = null;
    try {
        const { problem } = await tryLoreBasePick(settings);
        // toastr is SillyTavern's page global.
        if (problem) globalThis.toastr?.warning(problem, 'VectFox — Try a pick', { timeOut: 15000 });
    } finally {
        button.disabled = false;
    }
}

/**
 * Follow the Reply list, Try a pick, each change to the reports and the opening of the tester's tab. Called once, as
 * the panel is mounted.
 * @param {object} settings - The settings panel's settings object, which Try a pick runs on
 */
export function bindLoreBaseTester(settings) {
    document.querySelector(`[data-vfx-subtabs="${WORLDINFO_TABS_ID}"]`)?.addEventListener('vfx-subtab-change', event => {
        if (event.detail.tab === WORLDINFO_TAB.tester) refreshLoreBaseTester();
    });
    document.getElementById('VectFox_lorebase_report')?.addEventListener('change', event => {
        const id = Number(event.currentTarget.value);
        pickedReportId = id === loreBaseReports()[0]?.id ? null : id;
        refreshLoreBaseTester();
    });
    document.getElementById('VectFox_lorebase_try_pick')?.addEventListener('click', event => {
        void tryPick(event.currentTarget, settings);
    });
    onLoreBaseReportsChange(refreshLoreBaseTester);
}
