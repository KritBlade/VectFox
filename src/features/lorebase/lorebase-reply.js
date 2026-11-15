/**
 * LoreBase on each reply (plan §5.5, §5.6, §5.8 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). VectFox's generation interceptor asks it for a reply's lore, after
 * SillyTavern's slash commands and never on a dry run, so a send that is only commands runs no pick (#29). The books
 * taking part are those SillyTavern loads that the user locked to the chat or character (D11); Luna picks among the
 * entries selected in them, then reviews each pick, all at once. A turn whose pick or review fails goes on without
 * that lore, with a toast (D14).
 */
import { eventSource, event_types } from '../../sillytavern/events.js';
import { log } from '../../sillytavern/log.js';
import { loadWorldInfo } from '../../sillytavern/world-info.js';
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { notifyInvalidModel, notifySetupIncomplete } from '../../shared/model-config-notifier.js';
import { parseJsonArrayFromLlm, postChatCompletion } from '../llm-provider/index.js';
import { stripReasoningBlocks } from '../text-cleaning/index.js';
import { getLoreBook, isLoreBookLocked } from './lorebase-books.js';
import { chatBookNames, lockTarget } from './lorebase-chat-books.js';
import { describeLoreBaseConnectionProblem, resolveLoreBaseLlmConfig } from './lorebase-connection.js';
import { CALL_TIMEOUT_MS, decidedEntries, isReplyGeneration, loreForReply, leftOutLoreMessage, reviewEffort } from './lorebase-reply-core.js';
import { sceneText } from './lorebase-scene-core.js';
import { sceneMessagesFromChat } from './lorebase-scene.js';

const LOREBASE = 'LoreBase';

// The last generation past its slash commands. SillyTavern passes the interceptor a generation's type but not whether
// a quiet one is quiet-to-loud; GENERATION_AFTER_COMMANDS, which fires just before the interceptors run, carries it.
let lastGeneration = null;

/** Follow generations, so a quiet-to-loud one counts as a reply. Called once at start-up. */
export function initializeLoreBase() {
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, options, isDryRun) => {
        // A dry run reaches no interceptor, so it must not stand in for the generation that does.
        if (isDryRun) return;
        lastGeneration = { type, isQuietToLoud: Boolean(options?.quietToLoud) };
    });
}

/**
 * The books taking part in this reply (D11): those SillyTavern loads that the user locked to this chat or character,
 * each with the entries LoreBase decides in it.
 * @returns {Promise<Array<{bookName: string, entries: object[], pinnedSections: string[]}>>}
 */
async function booksTakingPart() {
    const where = lockTarget();
    const books = [];
    for (const bookName of chatBookNames()) {
        const record = getLoreBook(bookName);
        if (!record?.selectedUids.length || !isLoreBookLocked(bookName, where)) continue;
        const entries = decidedEntries(await loadWorldInfo(bookName), record);
        if (entries.length) books.push({ bookName, entries, pinnedSections: record.pinnedSections });
    }
    return books;
}

/** One call on LoreBase's connection, its answer's entries read as the trials read them. */
function askOn(connection) {
    return async (messages, { maxTokens, reasoningEffort, identKeys }) => {
        const { content, cutReason } = await postChatCompletion({
            messages,
            model: connection.model,
            provider: connection.provider,
            vllmUrl: connection.vllmUrl || '',
            connectionProfileId: connection.connectionProfileId || '',
            connectionProfilePage: connection.connectionProfilePage || '',
            maxTokens,
            timeoutMs: CALL_TIMEOUT_MS,
            contextLabel: LOREBASE,
            authBranch: false,
            // LoreBase's own toast reports a failed call, with what the reply goes on without.
            shouldNotifyProviderFailure: false,
            // No temperature: LoreBase's connection never sends one, as the trials sent none.
            ...connection.parameterStyle,
            reasoningEffort,
        });
        if (cutReason) log.warn(`LoreBase: the provider cut an answer short (${cutReason}); reading what arrived`);
        // A thinking model can write its reasoning before the JSON, and what it reasoned is not the answer.
        return parseJsonArrayFromLlm(stripReasoningBlocks(content), { label: LOREBASE, identKeys });
    };
}

function showLeftOutLoreToast(message) {
    // toastr is SillyTavern's page global, absent where no page is loaded.
    globalThis.toastr?.warning(message, 'VectFox — LoreBase left lore out', { timeOut: 30000, extendedTimeOut: 10000 });
}

const tokensOf = (passages, partNumbers) => partNumbers.reduce((total, number) => total + passages[number - 1].tokens, 0);
const allPartNumbers = passages => passages.map((_, index) => index + 1);
// A failed call that regenerating cannot fix, such as a model the provider does not know.
const isConfigurationFailure = failure => failure.error?.kind === 'model_config';

/** The turn's outcome in the console, and a toast for the lore it left out. */
function reportReplyLore(lore, seconds) {
    const titles = lore.picks.map(pick => `"${pick.title}"`).join(', ') || 'none';
    log.lifecycle(`LoreBase: picked ${lore.picks.length} of ${lore.contentCount} selected entries in ${seconds.toFixed(1)} s: ${titles}`);
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
 * This reply's lore, or null when LoreBase has nothing to do: VectFox off, a generation that is not a reply (D8), no
 * selected entry in the books taking part, or no user message for the reply to answer. Never throws: a failure is
 * logged and shown, and the reply goes on without the lore it could not get.
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {object} settings - VectFox settings
 * @returns {Promise<import('./lorebase-reply-core.js').ReplyLore|null>}
 */
export async function prepareLoreForReply(type, settings) {
    if (!isVectFoxEnabled(settings) || !isReplyGeneration(type, lastGeneration)) return null;
    try {
        const books = await booksTakingPart();
        if (!books.length) return null;
        const messages = sceneMessagesFromChat();
        if (!messages) {
            log.verbose('LoreBase: the chat holds no user message for the reply to answer, so nothing is picked');
            return null;
        }
        const connection = resolveLoreBaseLlmConfig(settings);
        if (!connection.ok) {
            notifySetupIncomplete(LOREBASE, describeLoreBaseConnectionProblem(connection.reason, connection.problem));
            return null;
        }
        const startedAt = performance.now();
        const lore = await loreForReply({
            scene: sceneText(messages), books, reviewEffort: reviewEffort(settings.lorebase_accuracy), ask: askOn(connection),
        });
        reportReplyLore(lore, (performance.now() - startedAt) / 1000);
        return lore;
    } catch (error) {
        log.error('LoreBase: preparing the lore for this reply failed:', error);
        showLeftOutLoreToast(leftOutLoreMessage([{ step: 'pick', detail: String(error?.message || error) }], 0));
        return null;
    }
}
