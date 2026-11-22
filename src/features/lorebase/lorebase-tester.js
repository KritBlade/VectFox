/**
 * LoreBase's tester (plan §5.10 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): what
 * LoreBase did on each reply of this session, for the WorldInfo page's tester card. A reply's report is made once its
 * pick and reviews are done; at the end of the generation interceptor it keeps what SillyTavern's World Info scan reads
 * next (the chat, the context size and the card's fields); the scan that follows says which picks went in, as
 * SillyTavern's World Info budget is the last cut; and once the reply ends the report is tied to the message it went
 * to, with the World Info its prompt held as SillyTavern's prompt itemization holds it. Its token counts are measured
 * when the card shows it, with the tokenizer SillyTavern's itemization counts with, and what SillyTavern's keys would
 * send by scanning that chat again, dry, as SillyTavern alone (lorebase-delivery.js). A Try a pick makes a report too,
 * with no reply: measured at once, it has no World Info scan, so what SillyTavern's keys would send is not measured.
 * Reports live in page memory only, the newest 20; a reload clears them.
 */
import { getCharacterCardFields, getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { eventSource, event_types } from '../../sillytavern/events.js';
import { itemizedPrompts } from '../../sillytavern/itemized-prompts.js';
import { log } from '../../sillytavern/log.js';
import { getTokenCountAsync } from '../../sillytavern/tokenizers.js';
import { checkWorldInfo, world_info_include_names } from '../../sillytavern/world-info.js';
import { scanLeftToSillyTavern } from './lorebase-delivery.js';
import { pickTokens, replyReport, selectedTextsSentByKeys } from './lorebase-tester-core.js';

const KEPT_REPORTS = 20;

/**
 * @typedef {import('./lorebase-tester-core.js').ReplyReportBody & {
 *   id: number, chatId: string|null, type: string, accuracy: string, madeAt: number,
 *   scan: {chatForWorldInfo: string[], maxContext: number, globalScanData: object}|null,
 *   isTry: boolean, isUnderWay: boolean, messageIndex: number|null, swipeId: number|null, promptWorldInfo: string|null,
 *   isScanSeen: boolean, isMeasuring: boolean, measureFailure: string|null,
 *   tokens: {sent: number, pickedWhole: number, picks: Array<{sent: number, whole: number}|null>,
 *     promptWorldInfo: number|null}|null,
 *   keysState: 'unmeasured'|'waiting'|'measured'|'unavailable',
 *   keys: {entries: number, tokens: number, worldInfo: number}|null,
 * }} ReplyReport
 * `isTry`: made by Try a pick, with no reply. `keysState`: what SillyTavern's keys would send is not measured yet;
 * waits for a generation's scan that was due; is measured into `keys`; or cannot be, as the reply's scan was not kept
 * or there was no reply.
 */

/** @type {ReplyReport[]} This session's reports, newest first. */
let reports = [];
let nextReportId = 1;
// The report of the reply under way, from its interceptor's end until the reply ends.
let reportUnderWay = null;
const reportOfLore = new WeakMap();
const changeListeners = new Set();

function reportsChanged() {
    for (const listener of changeListeners) listener();
}

/**
 * Call a listener each time a report is made, tied to its reply or measured.
 * @param {() => void} listener
 */
export function onLoreBaseReportsChange(listener) {
    changeListeners.add(listener);
}

/**
 * This session's reports for the open chat, newest first.
 * @returns {ReplyReport[]}
 */
export function loreBaseReports() {
    const chatId = getCurrentChatId() ?? null;
    return reports.filter(report => report.chatId === chatId);
}

/**
 * Make a reply's report once its pick and reviews are done. Never throws: the reply's lore must not wait on the tester.
 * A try's report (Try a pick) has no reply to wait for, and no reply scan to measure SillyTavern's keys on.
 * @param {object} turn
 * @param {import('./lorebase-reply-core.js').ReplyLore} turn.lore
 * @param {Array<{bookName: string, entries: object[]}>} turn.books - The books taking part
 * @param {string} turn.type - The generation's type, or 'try'
 * @param {string} turn.accuracy - The choice the turn ran on, from loreBaseAccuracyOf: 'fast' or 'high'
 * @param {number} turn.seconds - LoreBase's whole time on the reply
 * @param {boolean} [turn.isReply] - false for a try, which sends no reply
 */
export function recordReplyReport({ lore, books, type, accuracy, seconds, isReply = true }) {
    let body;
    try {
        body = replyReport({ lore, books, seconds });
    } catch (error) {
        log.warn("LoreBase: the tester could not make this reply's report:", error);
        return;
    }
    const report = {
        id: nextReportId++, chatId: getCurrentChatId() ?? null, type, accuracy, madeAt: Date.now(), ...body,
        scan: null, isTry: !isReply, isUnderWay: isReply, messageIndex: null, swipeId: null, promptWorldInfo: null,
        isScanSeen: false, isMeasuring: false, measureFailure: null, tokens: null, keysState: isReply ? 'unmeasured' : 'unavailable',
        keys: null,
    };
    reportOfLore.set(lore, report);
    reports = [report, ...reports].slice(0, KEPT_REPORTS);
    reportsChanged();
}

/**
 * At the generation interceptor's end: keep what SillyTavern's World Info scan reads next, as it reads it, and wait
 * for the reply to end. A reply LoreBase made no report for keeps nothing.
 * @param {object|null} lore - This reply's lore, as recordReplyReport had it
 * @param {object} replyScan
 * @param {Array<{name: string, mes: string}>} replyScan.chat - The interceptor's chat, as the scan reads it after
 * @param {number} replyScan.maxContext - The interceptor's context size, the scan's
 * @param {string} replyScan.type - The generation's type
 */
export function keepReplyScan(lore, { chat, maxContext, type }) {
    const report = lore ? reportOfLore.get(lore) : null;
    if (!report) return;
    if (reportUnderWay && reportUnderWay !== report) reportUnderWay.isUnderWay = false;
    reportUnderWay = report;
    try {
        const fields = getCharacterCardFields();
        report.scan = {
            chatForWorldInfo: chat.map(message => (world_info_include_names ? `${message.name}: ${message.mes}` : message.mes)).reverse(),
            maxContext,
            globalScanData: {
                personaDescription: fields.persona,
                characterDescription: fields.description,
                characterPersonality: fields.personality,
                characterDepthPrompt: fields.charDepthPrompt,
                scenario: fields.scenario,
                creatorNotes: fields.creatorNotes,
                // SillyTavern names the scan by the generation's type; a reply's type is always one it names.
                trigger: type,
            },
        };
    } catch (error) {
        log.warn("LoreBase: the tester could not keep this reply's World Info scan, so it cannot say what SillyTavern's keys would send:", error);
    }
}

/**
 * The reply's scan went: note which of its picks SillyTavern kept, as its World Info budget is the last cut. The picks
 * go in inside LoreBase's blocks, each carried by one entry, so a pick went in when an entry the scan activated holds
 * what it sent.
 */
function noteScanOfReply(activatedEntries) {
    const report = reportUnderWay;
    if (!report || report.isScanSeen) return;
    report.isScanSeen = true;
    const contents = (activatedEntries ?? []).map(entry => String(entry?.content ?? ''));
    for (const pick of report.picks) {
        if (pick.review?.sentText) pick.isInPrompt = contents.some(content => content.includes(pick.review.sentText));
    }
}

/** The reply ended: tie its report to the message it went to, with its prompt's World Info as itemized. */
function tieReportToReply(chatLength) {
    const report = reportUnderWay;
    reportUnderWay = null;
    if (!report) return;
    const messageIndex = Number(chatLength) - 1;
    const message = getContext()?.chat?.[messageIndex];
    report.isUnderWay = false;
    report.messageIndex = messageIndex >= 0 ? messageIndex : null;
    report.swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
    report.promptWorldInfo = itemizedPrompts.find(prompt => prompt.mesId === messageIndex)?.worldInfoString ?? null;
    reportsChanged();
}

/** What SillyTavern's keys would send: the chat scanned again, dry, as SillyTavern alone; null when it could not run. */
async function keysAlone(report) {
    const { chatForWorldInfo, maxContext, globalScanData } = report.scan;
    const scan = await scanLeftToSillyTavern(() => checkWorldInfo(chatForWorldInfo, maxContext, true, globalScanData));
    if (!scan) return null;
    const texts = selectedTextsSentByKeys(report, scan.allActivatedEntries);
    const counts = await Promise.all(texts.map(text => getTokenCountAsync(text)));
    return {
        entries: texts.length,
        tokens: counts.reduce((total, count) => total + count, 0),
        worldInfo: await getTokenCountAsync(scan.worldInfoBefore + scan.worldInfoAfter),
    };
}

/**
 * Count a report's tokens, once, as the card shows it: what its picks send and the same entries whole, its prompt's
 * World Info, and what SillyTavern's keys would send. Waits while a reply is under way. When a generation's scan is
 * due, the keys wait for the card to show the report again; the listeners hear only of a change, so a card that draws
 * the report again on each one never asks in a loop.
 * @param {ReplyReport} report
 * @returns {Promise<void>}
 */
export async function measureLoreBaseReport(report) {
    const isKeysToMeasure = report.keysState === 'unmeasured' || report.keysState === 'waiting';
    if ((report.tokens && !isKeysToMeasure) || report.isMeasuring || report.measureFailure) return;
    if (report.isUnderWay || reportUnderWay || report.chatId !== (getCurrentChatId() ?? null)) return;
    report.isMeasuring = true;
    let isChanged = false;
    try {
        if (!report.tokens) {
            report.tokens = {
                ...await pickTokens(report, getTokenCountAsync),
                promptWorldInfo: report.promptWorldInfo === null ? null : await getTokenCountAsync(report.promptWorldInfo),
            };
            isChanged = true;
        }
        if (isKeysToMeasure) {
            const keys = report.scan ? await keysAlone(report) : null;
            const keysState = keys ? 'measured' : (report.scan ? 'waiting' : 'unavailable');
            if (keys) report.keys = keys;
            isChanged ||= keysState !== report.keysState;
            report.keysState = keysState;
        }
    } catch (error) {
        log.warn("LoreBase: the tester could not count this reply's tokens:", error);
        report.measureFailure = String(error?.message || error);
        isChanged = true;
    } finally {
        report.isMeasuring = false;
        if (isChanged) reportsChanged();
    }
}

/** Follow each reply: the scan that took its picks, and its end. Called once at start-up. */
export function initializeLoreBaseTester() {
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, noteScanOfReply);
    eventSource.on(event_types.GENERATION_ENDED, tieReportToReply);
}
