/**
 * LoreBase's model (plan §5.6 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): its own
 * row on the WorldInfo page, on a SillyTavern profile, OpenRouter or vLLM. The llm-provider feature resolves it as it
 * resolves every other consumer's, so LoreBase holds no manual-provider code of its own. A call can hand its token
 * counts to the caller, as the tester's report of High Accuracy's pick reads them. A sentence saying that LoreBase's
 * model or Jev cannot run ends on what that costs as LoreBase stands then (connectionConsequence).
 */
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { log } from '../../sillytavern/log.js';
import {
    LLM_CALL_FEATURES,
    describeConnectionProblem,
    parseJsonArrayFromLlm,
    postChatCompletion,
    resolveConnectionProfileId,
    resolveLlmConnection,
    resolveModelParameterStyle,
    sendConnectionTest,
    shownVllmUrl,
} from '../llm-provider/index.js';
import { stripReasoningBlocks } from '../text-cleaning/index.js';
import { CALL_TIMEOUT_MS, FAST_AND_CHEAP, loreBaseAccuracyOf } from './lorebase-reply-core.js';
import { isLoreBaseBackend, isLoreBaseSwitchedOn } from './lorebase-switch.js';

const LOREBASE = 'LoreBase';

// Where LoreBase's connection is chosen, and how a missing model is fixed there.
const LOREBASE_CONNECTION = Object.freeze({
    feature: LOREBASE,
    page: 'WorldInfo',
    missingModelFix: 'it has no model. Set Model under LoreBase model on the WorldInfo page.',
});
// What a model of LoreBase's that cannot run costs: a reply's lore, or the keys of the entries selected for LoreBase.
const OUT_OF_REPLIES = 'Until then the entries selected for LoreBase stay out of replies.';
const NO_KEYS_WRITTEN = 'Until then no keys are written for the entries selected for LoreBase.';

/** Whether LoreBase runs: VectFox and LoreBase on, on Qdrant. While it does not, SillyTavern's keys decide every entry. */
const isLoreBaseRunning = settings => isVectFoxEnabled(settings) && isLoreBaseSwitchedOn(settings) && isLoreBaseBackend(settings);

/**
 * What it costs, as LoreBase stands now, that one of its models cannot run. The entries selected for LoreBase stay out
 * of replies only while LoreBase runs, and only when the model is the one that picks each reply's entries: Jev on Fast
 * and Cheap [Jev], LoreBase's own model on High Accuracy. Otherwise LoreBase's own model, which writes the keys on both
 * choices, writes none, and Jev costs nothing.
 * @param {object} settings - VectFox settings
 * @param {{isJev: boolean}} model - Jev, or LoreBase's own model
 * @returns {string} '' when it costs nothing now
 */
export function connectionConsequence(settings, { isJev }) {
    const isJevPicking = loreBaseAccuracyOf(settings?.lorebase_accuracy) === FAST_AND_CHEAP;
    if (isJev === isJevPicking && isLoreBaseRunning(settings)) return OUT_OF_REPLIES;
    return isJev ? '' : NO_KEYS_WRITTEN;
}

/**
 * LoreBase's connection, or why it cannot run. The temperature is never sent, as in the route trials; each call sets
 * its own reasoning effort.
 *
 * @param {object} settings
 * @returns {{ok: true, provider: string, model: string, parameterStyle: object}|{ok: false, reason: string, problem?: string}}
 */
export function resolveLoreBaseLlmConfig(settings) {
    const connection = resolveLlmConnection({
        provider: settings.lorebase_provider,
        model: settings.lorebase_model,
        vllmUrl: shownVllmUrl(settings),
        connectionProfileId: resolveConnectionProfileId(settings, 'lorebase'),
        feature: LOREBASE_CONNECTION.feature,
        page: LOREBASE_CONNECTION.page,
    });
    if (!connection.ok) return connection;
    return { ...connection, parameterStyle: { ...resolveModelParameterStyle(settings), sendTemperature: false, reasoningEffort: null } };
}

/**
 * The sentence for LoreBase's connection that cannot run: what is wrong, where to fix it, and what that costs as
 * LoreBase stands now (connectionConsequence). While LoreBase does not run, it does not say LoreBase is on.
 *
 * @param {string} reason - From resolveLoreBaseLlmConfig
 * @param {string|undefined} problem - From resolveLoreBaseLlmConfig, for a profile that cannot be used
 * @param {object} settings - VectFox settings
 * @returns {string}
 */
export function describeLoreBaseConnectionProblem(reason, problem, settings) {
    return describeConnectionProblem({
        ...LOREBASE_CONNECTION,
        consequence: connectionConsequence(settings, { isJev: false }),
        isOn: isLoreBaseRunning(settings),
    }, reason, problem);
}

/**
 * One call on LoreBase's connection, its answer's entries read as the trials read them: the pick, a review, or an
 * entry's keys. A request's onUsage is handed the call's token counts, as the provider reported them, once it answers.
 * @param {{model: string, provider: string, vllmUrl?: string, connectionProfileId?: string, connectionProfilePage?: string,
 *   parameterStyle: object}} connection - From resolveLoreBaseLlmConfig, ok
 * @returns {(messages: Array<{role: string, content: string}>, request: {maxTokens: number, reasoningEffort: string|null,
 *   identKeys: string[], onUsage?: (usage: {prompt_tokens: number|null, cached_tokens: number|null}|null) => void}) =>
 *   Promise<unknown[]>}
 */
export function askOnLoreBase(connection) {
    return async (messages, { maxTokens, reasoningEffort, identKeys, onUsage = null }) => {
        const answer = await callOnLoreBase(connection, messages, { maxTokens, reasoningEffort, timeoutMs: CALL_TIMEOUT_MS, contextLabel: LOREBASE, onUsage });
        return parseJsonArrayFromLlm(answer, { label: LOREBASE, identKeys });
    };
}

/**
 * A call on LoreBase's connection whose answer is text: Entity-Lore's entries and notes, which take longer to write
 * than a pick, so the caller sets how long a call may take.
 * @param {object} connection - From resolveLoreBaseLlmConfig, `ok`
 * @param {{timeoutMs: number, contextLabel: string}} call - How long a call may take, and whose calls they are
 * @returns {(messages: Array<{role: string, content: string}>, request: {maxTokens: number, reasoningEffort: string|null})
 *   => Promise<string>} Sends one call and returns its answer without the reasoning a thinking model writes before it;
 *   throws when the call fails
 */
export function askTextOnLoreBase(connection, { timeoutMs, contextLabel }) {
    return (messages, { maxTokens, reasoningEffort }) => callOnLoreBase(connection, messages, { maxTokens, reasoningEffort, timeoutMs, contextLabel });
}

/** One call on LoreBase's connection: its answer, the reasoning a thinking model writes before it removed. */
async function callOnLoreBase(connection, messages, { maxTokens, reasoningEffort, timeoutMs, contextLabel, onUsage = null }) {
    const { content, cutReason, usage } = await postChatCompletion({
        feature: LLM_CALL_FEATURES.loreBase,
        messages,
        model: connection.model,
        provider: connection.provider,
        vllmUrl: connection.vllmUrl || '',
        connectionProfileId: connection.connectionProfileId || '',
        connectionProfilePage: connection.connectionProfilePage || '',
        maxTokens,
        timeoutMs,
        contextLabel,
        authBranch: false,
        // The caller reports a failed call itself, with what goes on without it.
        shouldNotifyProviderFailure: false,
        // No temperature: LoreBase's connection never sends one, as the trials sent none.
        ...connection.parameterStyle,
        reasoningEffort,
    });
    if (cutReason) log.warn(`${contextLabel}: the provider cut an answer short (${cutReason}); reading what arrived`);
    onUsage?.(usage);
    // A thinking model can write its reasoning before the answer, and what it reasoned is not the answer.
    return stripReasoningBlocks(content);
}

/**
 * LoreBase's Test connection (WorldInfo page): the fixed test message on LoreBase's connection, resolved as its calls
 * resolve it.
 *
 * @param {object} settings
 * @returns {Promise<{content: string, cutReason: string|null}>}
 * @throws {Error} Why LoreBase's connection cannot run, or what the call threw
 */
export async function testLoreBaseConnection(settings) {
    const connection = resolveLoreBaseLlmConfig(settings);
    if (!connection.ok) throw new Error(describeLoreBaseConnectionProblem(connection.reason, connection.problem, settings));
    return sendConnectionTest(connection, { contextLabel: LOREBASE, feature: LLM_CALL_FEATURES.loreBase, parameterStyle: connection.parameterStyle });
}
