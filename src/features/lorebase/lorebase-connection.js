/**
 * LoreBase's model (plan §5.6 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-index.md): its own
 * row on the WorldInfo page, on a SillyTavern profile, OpenRouter or vLLM. The llm-provider feature resolves it as it
 * resolves every other consumer's, so LoreBase holds no manual-provider code of its own.
 */
import {
    describeConnectionProblem,
    resolveConnectionProfileId,
    resolveLlmConnection,
    resolveModelParameterStyle,
    sendConnectionTest,
    shownVllmUrl,
} from '../llm-provider/index.js';

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
