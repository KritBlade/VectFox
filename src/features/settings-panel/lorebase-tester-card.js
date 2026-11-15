/**
 * The WorldInfo page's LoreBase tester card (plan §5.10 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): this session's reports for the open chat, the newest first in its Reply
 * list, and the one picked there drawn in full. Picking the newest follows each new reply; picking an older one keeps
 * it. A report is measured once the card is shown, and drawn again on each change, with the parts and lists the user
 * opened kept open.
 */
import { setCollapsed, setShown } from '../../shared/gui-dna/gene-behaviours.js';
import { loreBaseReports, measureLoreBaseReport, onLoreBaseReportsChange } from '../lorebase/index.js';
import { loreBaseReportMarkup, loreBaseReportOptions } from './worldinfo-page-markup.js';

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

/** Follow the Reply list and each change to the reports. Called once, as the panel is mounted. */
export function bindLoreBaseTester() {
    document.getElementById('VectFox_lorebase_report')?.addEventListener('change', event => {
        const id = Number(event.currentTarget.value);
        pickedReportId = id === loreBaseReports()[0]?.id ? null : id;
        refreshLoreBaseTester();
    });
    onLoreBaseReportsChange(refreshLoreBaseTester);
}
