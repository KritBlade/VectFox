/**
 * LoreBase's model (plan §5.6 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): its own
 * row on the WorldInfo page, on a SillyTavern profile, OpenRouter or vLLM. The llm-provider feature resolves it as it
 * resolves every other consumer's, so LoreBase holds no manual-provider code of its own. A call can hand its token
 * counts to the caller, as the tester's report of High Accuracy's pick reads them.
 */
import { log } from '../../sillytavern/log.js';
import {
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
import { CALL_TIMEOUT_MS } from './lorebase-reply-core.js';

const LOREBASE = 'LoreBase';

// Where LoreBase's connection is chosen, how a missing model is fixed there, and what happens until it is fixed.
const LOREBASE_CONNECTION = Object.freeze({
    feature: LOREBASE,
    page: 'WorldInfo',
    missingModelFix: 'it has no model. Set Model under LoreBase model on the WorldInfo page.',
    consequence: 'Until then the entries selected for LoreBase stay out of replies.',
});

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
 * The sentence for LoreBase's connection that cannot run: what is wrong, where to fix it, and that the entries
 * selected for LoreBase stay out of replies until then.
 *
 * @param {string} reason - From resolveLoreBaseLlmConfig
 * @param {string} [problem] - From resolveLoreBaseLlmConfig, for a profile that cannot be used
 * @returns {string}
 */
export function describeLoreBaseConnectionProblem(reason, problem) {
    return describeConnectionProblem(LOREBASE_CONNECTION, reason, problem);
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
        const { content, cutReason, usage } = await postChatCompletion({
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
            // LoreBase reports a failed call itself, with what goes on without it.
            shouldNotifyProviderFailure: false,
            // No temperature: LoreBase's connection never sends one, as the trials sent none.
            ...connection.parameterStyle,
            reasoningEffort,
        });
        if (cutReason) log.warn(`LoreBase: the provider cut an answer short (${cutReason}); reading what arrived`);
        onUsage?.(usage);
        // A thinking model can write its reasoning before the JSON, and what it reasoned is not the answer.
        return parseJsonArrayFromLlm(stripReasoningBlocks(content), { label: LOREBASE, identKeys });
    };
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
    if (!connection.ok) throw new Error(describeLoreBaseConnectionProblem(connection.reason, connection.problem));
    return sendConnectionTest(connection, { contextLabel: LOREBASE, parameterStyle: connection.parameterStyle });
}
