/**
 * LoreBase on each reply (plan §5.5 to §5.9 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md), while it acts: its switch on, and Vector Storage's World Info search
 * off, which a reply first settles with the user when both are on (lorebase-switch.js, lorebase-vector-storage.js).
 * VectFox's generation interceptor asks it for a reply's lore beside its retrieval, after SillyTavern's slash commands
 * and never on a dry run, so a send that is only commands runs no pick (#29). The books taking part are those
 * SillyTavern loads that the user locked to the chat or character (D11), and a lock follows its chat or character
 * through a rename; the pick reads the entries selected in them that are ready, with their keys (D17,
 * lorebase-keys.js) and their vectors from the embedding model set now (§4.4 of InternalProject/Vectfox/plans/
 * executed/lorebook-multi-vector.md, lorebase-vectors.js), and a reply that leaves out selected entries not ready says so, once
 * per chat and again when their number changes. On Fast and Cheap [Jev] Jev rates them, above 100 only a search's 100
 * best, and its picks go whole within the lore budget (§5, lorebase-jev-core.js); on High Accuracy Luna picks, then
 * reviews each pick, all at once. Once the retrieval is done too the picks are held for the World Info scan that
 * follows (lorebase-delivery.js). A turn whose search, pick or review fails goes on without that lore, with a toast
 * (D14). Each reply's outcome goes to the tester (lorebase-tester.js), with what that scan reads.
 */
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { lastGenerationPastCommands } from '../../shared/last-generation.js';
import { generationPastCommands } from '../../shared/last-generation-core.js';
import { notifyInvalidModel, notifySetupIncomplete } from '../../shared/model-config-notifier.js';
import { renamedChatIds } from '../../shared/renamed-chat.js';
import { loadDecidedEntries, renameLoreBookCharacter, renameLoreBookChat } from './lorebase-books.js';
import { chatBookNames, lockTarget, selectionInUseHere } from './lorebase-chat-books.js';
import { askOnLoreBase } from './lorebase-connection.js';
import { askJev } from './lorebase-jev.js';
import { loreBudgetOf, loreForReplyByJev } from './lorebase-jev-core.js';
import { holdLoreForNextScan, initializeLoreBaseDelivery } from './lorebase-delivery.js';
import { readBookKeys } from './lorebase-keys.js';
import { isReplyGeneration, loreBaseAccuracyOf, loreForReply, leftOutLoreMessage, unreadyEntriesNotice } from './lorebase-reply-core.js';
import { sceneText } from './lorebase-scene-core.js';
import { sceneMessagesFromChat } from './lorebase-scene.js';
import { replyModel } from './lorebase-setup.js';
import { isLoreBaseActive, loreBaseInactiveReason } from './lorebase-switch.js';
import { initializeLoreBaseTester, keepReplyScan, recordReplyReport } from './lorebase-tester.js';
import { settleVectorStorageConflict } from './lorebase-vector-storage.js';
import { bookVectors, initializeLoreBaseVectors, searchReplyPool } from './lorebase-vectors.js';
import { isEntryReady } from './lorebase-readiness.js';

const LOREBASE = 'LoreBase';
// A try's report type: the pick for the next reply, with no reply sent.
const TRY_TYPE = 'try';
// Why the open chat gives LoreBase nothing to pick from.
const NO_READY_SELECTION = 'No lorebook locked to this chat or its character has selected entries with their keys and vectors.';
const NO_USER_MESSAGE = 'The chat holds no user message for a reply to answer.';

// What the last reply said of the selected entries it left out for not being ready (unreadyEntriesNotice).
let lastUnreadyNotice = null;

/**
 * Move a renamed chat's locks to the name its file was saved under, which is the chat's id from then on (renamedChatIds).
 * @param {{oldFileName?: string, newFileName?: string}} renamed - CHAT_RENAMED's data
 */
async function followChatRename(renamed) {
    let chatIds;
    try {
        chatIds = await renamedChatIds(renamed);
    } catch (error) {
        log.warn('LoreBase: could not learn the name a renamed chat was saved under, so its book locks stay on the old name:', error);
        return;
    }
    renameLoreBookChat(chatIds.oldChatId, chatIds.newChatId);
}

/**
 * Follow generations, so a reply first settles Vector Storage's World Info search with the user, and renamed
 * characters and chats, so a book locked to one stays locked to it; arm every World Info scan; let the tester follow
 * each reply; and keep the vectors of edited books current. Called once at start-up, after followGenerations
 * (src/shared/last-generation.js), which keeps whether a quiet generation is quiet-to-loud for the pick.
 */
export function initializeLoreBase() {
    initializeLoreBaseDelivery();
    initializeLoreBaseTester();
    initializeLoreBaseVectors();
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async (type, options, isDryRun) => {
        // A dry run reaches no interceptor, so it must not stand in for the generation that does.
        if (isDryRun) return;
        // SillyTavern waits for this listener, and runs the interceptors after it, Vector Storage's among them.
        if (isReplyGeneration(type, generationPastCommands(type, options))) await settleVectorStorageConflict();
    });
    eventSource.on(event_types.CHARACTER_RENAMED, renameLoreBookCharacter);
    eventSource.on(event_types.CHAT_RENAMED, followChatRename);
}

/**
 * The books taking part in this reply (D11): those SillyTavern loads with a selection in use here, locked to this chat
 * or character, each with the entries LoreBase decides in that selection that are ready (isEntryReady: their keys,
 * D17, and their vectors from the embedding model set now, §4.4 of lorebook-multi-vector.md), its pinned sections, and
 * its keys by uid; and each such book's count of selected entries left out for not being ready.
 * @param {object} settings - VectFox settings
 * @returns {Promise<{books: Array<{bookName: string, entries: object[], pinnedSections: string[], keysByUid: Record<string, string[]>}>,
 *   unreadyBooks: Array<{bookName: string, count: number}>}>}
 * @throws {Error} When the keys or vectors cannot be read
 */
async function booksTakingPart(settings) {
    const books = [];
    for (const bookName of chatBookNames()) {
        const selection = selectionInUseHere(bookName);
        if (!selection?.selectedUids.length) continue;
        const entries = await loadDecidedEntries(bookName, selection);
        if (entries.length) books.push({ bookName, entries, pinnedSections: selection.pinnedSections });
    }
    if (!books.length) return { books, unreadyBooks: [] };
    const bookNames = books.map(book => book.bookName);
    const [keys] = await Promise.all([readBookKeys(bookNames), bookVectors(bookNames, settings)]);
    const ready = [];
    const unreadyBooks = [];
    for (const book of books) {
        const keysByUid = keys[book.bookName] ?? {};
        const entries = book.entries.filter(entry => isEntryReady(book.bookName, entry, settings));
        const unready = book.entries.length - entries.length;
        if (unready) {
            log.verbose(`LoreBase: ${unready} selected entries of lorebook "${book.bookName}" have no keys or vectors yet, so they send nothing`);
            unreadyBooks.push({ bookName: book.bookName, count: unready });
        }
        if (entries.length) ready.push({ ...book, entries, keysByUid });
    }
    return { books: ready, unreadyBooks };
}

/** Say once per chat, and again when their number changes, which selected entries this reply leaves out for not being ready. */
function noticeUnreadyEntries(unreadyBooks) {
    const { notice, message } = unreadyEntriesNotice(lastUnreadyNotice, lockTarget().chatId, unreadyBooks);
    lastUnreadyNotice = notice;
    if (message) showLeftOutLoreToast(message);
}

function showLeftOutLoreToast(message) {
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(message, 'VectFox — LoreBase left lore out', { timeOut: 30000, extendedTimeOut: 10000 });
}

const tokensOf = (passages, partNumbers) => partNumbers.reduce((total, number) => total + passages[number - 1].tokens, 0);
const allPartNumbers = passages => passages.map((_, index) => index + 1);
// A failed call that regenerating cannot fix: a model the provider does not know, or an embedding setup that cannot run.
const isConfigurationFailure = failure => failure.error?.kind === 'model_config' || failure.error?.code === 'invalid_model_config';

/** The turn's outcome in the console, and a toast for the lore it left out. */
function reportReplyLore(lore, seconds) {
    const titles = lore.picks.map(pick => `"${pick.title}"`).join(', ') || 'none';
    log.lifecycle(`LoreBase: picked ${lore.picks.length} of ${lore.contentCount} selected entries in ${seconds.toFixed(1)} s: ${titles}`);
    if (Number.isFinite(lore.search?.poolCount)) {
        log.verbose(`LoreBase: the search kept ${lore.search.poolCount} of ${lore.contentCount} entries for Jev in ${lore.search.seconds.toFixed(1)} s`);
    }
    if (lore.unreadItemCount) log.warn(`LoreBase: the pick named ${lore.unreadItemCount} item(s) not in its table of contents, which were skipped`);
    for (const { title, uses, passages, sentParts } of lore.reviewedPicks) {
        log.verbose(`LoreBase: "${title}" uses ${uses}: sends ${sentParts.length} of ${passages.length} parts, `
            + `about ${tokensOf(passages, sentParts)} of ${tokensOf(passages, allPartNumbers(passages))} tokens`);
    }
    for (const failure of lore.failures) {
        log.warn(`LoreBase: the ${failure.step}${failure.title ? ` of "${failure.title}"` : ''} failed:`, failure.error ?? failure.detail);
        if (isConfigurationFailure(failure)) notifyInvalidModel(failure.error.message);
    }
    const turnFailures = lore.failures.filter(failure => !isConfigurationFailure(failure));
    if (turnFailures.length) showLeftOutLoreToast(leftOutLoreMessage(turnFailures, lore.picks.length));
}

/**
 * A reply's lore on the dropdown's choice (loreBaseAccuracyOf): Jev's picks on Fast and Cheap [Jev] (D16), above 100
 * entries among the search's best, within the lore budget (§5 of lorebook-multi-vector.md), else High Accuracy, Luna's
 * pick and reviews. null, with the setup notice, when the choice's connection cannot run.
 * @param {object} settings - VectFox settings
 * @param {{books: object[], scene: string, messages: Array<{name: string, text: string}>}} turn - From openChatTurn
 * @returns {Promise<import('./lorebase-reply-core.js').ReplyLore|null>}
 */
async function askForReplyLore(settings, { books, scene, messages }) {
    const model = replyModel(settings);
    if (model.problem) {
        notifySetupIncomplete(LOREBASE, model.problem);
        return null;
    }
    if (model.isJev) {
        return loreForReplyByJev({
            scene,
            books,
            ask: (state, questions) => askJev(model.jev, state, questions),
            searchPool: contents => searchReplyPool(books, contents, messages, settings),
            loreBudget: loreBudgetOf(settings.lorebase_lore_budget_tokens),
        });
    }
    return loreForReply({ scene, books, ask: askOnLoreBase(model.connection) });
}

/**
 * The open chat's turn for LoreBase: the books taking part, and the scene the next reply answers with its messages,
 * which Fast and Cheap [Jev]'s search reads, or why it has none; either way the books' counts of selected entries left
 * out for not being ready.
 * @param {object} settings - VectFox settings
 * @returns {Promise<{books: object[], scene: string, messages: Array<{name: string, text: string}>, unreadyBooks: object[]}
 *   |{problem: string, unreadyBooks: object[]}>}
 * @throws {Error} When the keys or vectors cannot be read
 */
async function openChatTurn(settings) {
    const { books, unreadyBooks } = await booksTakingPart(settings);
    if (!books.length) return { problem: NO_READY_SELECTION, unreadyBooks };
    const messages = sceneMessagesFromChat();
    if (!messages) return { problem: NO_USER_MESSAGE, unreadyBooks };
    return { books, scene: sceneText(messages), messages, unreadyBooks };
}

/**
 * A turn's lore on the dropdown's choice, logged and made into the tester's report. null when the choice's connection
 * cannot run, its setup notice shown.
 * @param {object} settings - VectFox settings
 * @param {{books: object[], scene: string, messages: object[]}} turn - From openChatTurn
 * @param {{type: string, isReply: boolean}} kind - The generation's type, or a try's, which sends no reply
 * @returns {Promise<import('./lorebase-reply-core.js').ReplyLore|null>}
 */
async function pickForTurn(settings, turn, { type, isReply }) {
    const startedAt = performance.now();
    const lore = await askForReplyLore(settings, turn);
    if (!lore) return null;
    const seconds = (performance.now() - startedAt) / 1000;
    reportReplyLore(lore, seconds);
    recordReplyReport({ lore, books: turn.books, type, accuracy: loreBaseAccuracyOf(settings.lorebase_accuracy), seconds, isReply });
    return lore;
}

/**
 * This reply's lore, or null when LoreBase has nothing to do: LoreBase not acting (isLoreBaseActive), a generation
 * that is not a reply (D8), no selected entry in the books taking part, or no user message for the reply to answer.
 * Never throws: a failure is logged and shown, and the reply goes on without the lore it could not get.
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {object} settings - VectFox settings
 * @returns {Promise<import('./lorebase-reply-core.js').ReplyLore|null>}
 */
export async function prepareLoreForReply(type, settings) {
    if (!isLoreBaseActive(settings) || !isReplyGeneration(type, lastGenerationPastCommands())) return null;
    try {
        const turn = await openChatTurn(settings);
        noticeUnreadyEntries(turn.unreadyBooks);
        if (turn.problem) {
            if (turn.problem === NO_USER_MESSAGE) log.verbose(`LoreBase: ${turn.problem} Nothing is picked.`);
            return null;
        }
        return await pickForTurn(settings, turn, { type, isReply: true });
    } catch (error) {
        log.error('LoreBase: preparing the lore for this reply failed:', error);
        showLeftOutLoreToast(leftOutLoreMessage([{ step: 'pick', detail: String(error?.message || error) }], 0));
        return null;
    }
}

/**
 * Try a pick (plan §5.10): LoreBase's step for the open chat's next reply, on the dropdown's choice and its
 * connections, with no reply sent and nothing held for World Info. Its report goes to the tester, marked as a try.
 * Never throws: a failure is logged and returned as the problem.
 * @param {object} settings - VectFox settings
 * @returns {Promise<{problem: string|null}>} Why nothing was picked, or null once the pick ran or the choice's setup
 *   notice showed
 */
export async function tryLoreBasePick(settings) {
    const inactive = loreBaseInactiveReason(settings);
    if (inactive) return { problem: inactive };
    try {
        const turn = await openChatTurn(settings);
        if (turn.problem) return { problem: turn.problem };
        await pickForTurn(settings, turn, { type: TRY_TYPE, isReply: false });
        return { problem: null };
    } catch (error) {
        log.warn('LoreBase: trying a pick failed:', error);
        return { problem: String(error?.message || error) };
    }
}

/**
 * LoreBase's part of VectFox's generation interceptor: this reply's lore is prepared beside the interceptor's
 * retrieval, and held for the World Info scan only once both are done (§6.8). SillyTavern scans a few milliseconds
 * after the interceptor ends, while the retrieval can outlast the pick by seconds, in which a quiet generation would
 * take or drop picks already held. Each run first drops what the last one held, so a generation with no pick sends no
 * selected entry. A failed retrieval is thrown again once the picks are held, as the reply goes on without it. The
 * tester keeps what the scan reads: the interceptor's chat, as the retrieval leaves it, and context size.
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {object} settings - VectFox settings
 * @param {() => Promise<unknown>} retrieve - Starts the interceptor's retrieval
 * @param {{chat: Array<{name: string, mes: string}>, maxContext: number}} replyScan - The interceptor's chat and
 *   context size
 * @returns {Promise<void>}
 */
export async function prepareLoreBesideRetrieval(type, settings, retrieve, replyScan) {
    holdLoreForNextScan(null);
    const lore = prepareLoreForReply(type, settings);
    try {
        await retrieve();
    } finally {
        const replyLore = await lore;
        holdLoreForNextScan(replyLore);
        keepReplyScan(replyLore, { ...replyScan, type });
    }
}
