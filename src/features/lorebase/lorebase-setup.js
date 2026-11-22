/**
 * Whether LoreBase can write and run, and why not (§2 and §7.2 of InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md,
 * §5.9 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): the one place each check lives, so
 * the WorldInfo page's model card, the Generate buttons, turning LoreBase on, closing the selection screen, Regenerate
 * keys, the entry editor and every run say the same. Keys need Qdrant and LoreBase's own model; vectors need Qdrant and
 * VectFox's embedding model; each reply's pick needs Jev's profile on Fast and Cheap [Jev], or LoreBase's own model on
 * High Accuracy. The model card names the first thing missing, in the order a new user sets them up.
 */
import { embeddingSetupProblem } from '../embedding/index.js';
import { describeLoreBaseConnectionProblem, resolveLoreBaseLlmConfig } from './lorebase-connection.js';
import { resolveJevConnection } from './lorebase-jev.js';
import { FAST_AND_CHEAP, loreBaseAccuracyOf } from './lorebase-reply-core.js';
import { KEYS, VECTORS } from './lorebase-storage-core.js';
import { isLoreBaseBackend } from './lorebase-switch.js';

const CORE_PAGE = 'Core page';

/**
 * Why LoreBase can keep nothing here: off Qdrant, where it keeps each entry's keys and vectors (D15).
 * @param {object} settings - VectFox settings
 * @returns {string|null} null on Qdrant
 */
export function qdrantProblem(settings) {
    return isLoreBaseBackend(settings) ? null : `LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the ${CORE_PAGE}.`;
}

/**
 * Why keys cannot be written now: they need Qdrant, and LoreBase's own model writes them (D17).
 * @param {object} settings - VectFox settings
 * @returns {string|null} null when they can
 */
export function keyWritingProblem(settings) {
    const problem = qdrantProblem(settings);
    if (problem) return problem;
    const connection = resolveLoreBaseLlmConfig(settings);
    return connection.ok ? null : describeLoreBaseConnectionProblem(connection.reason, connection.problem, settings);
}

/**
 * Why vectors cannot be written now: they need Qdrant, and VectFox's embedding model writes them. The embedding's
 * problem says where it is set only when its own words do not: a connection profile's already name the Core page.
 * @param {object} settings - VectFox settings
 * @returns {string|null} null when they can
 */
export function vectorWritingProblem(settings) {
    const problem = qdrantProblem(settings);
    if (problem) return problem;
    const embeddingProblem = embeddingSetupProblem(settings);
    if (!embeddingProblem) return null;
    const sentence = /[.!?]$/.test(embeddingProblem) ? embeddingProblem : `${embeddingProblem}.`;
    const where = sentence.includes(CORE_PAGE) ? '' : ` Set it on the ${CORE_PAGE}.`;
    return `VectFox's embedding model writes LoreBase's vectors, and it cannot run yet: ${sentence}${where}`;
}

/**
 * Why `kinds` cannot be written now: the keys' problem first, then the vectors'.
 * @param {object} settings - VectFox settings
 * @param {readonly string[]} kinds - KEYS, VECTORS or BOTH_KINDS
 * @returns {string|null} null when they can
 */
export function writingProblem(settings, kinds) {
    return (kinds.includes(KEYS) && keyWritingProblem(settings)) || (kinds.includes(VECTORS) && vectorWritingProblem(settings)) || null;
}

/**
 * The model that picks each reply's entries: Jev, through its profile, on Fast and Cheap [Jev], where LoreBase's own
 * model only writes the keys; LoreBase's own model on High Accuracy. What the reply asks, and the problem the model card
 * and turning LoreBase on name.
 * @param {object} settings - VectFox settings
 * @returns {{isJev: true, jev: object, problem: string}|{isJev: false, connection: object, problem: string}} problem:
 *   why it cannot run, '' when it can
 */
export function replyModel(settings) {
    if (loreBaseAccuracyOf(settings.lorebase_accuracy) === FAST_AND_CHEAP) {
        const jev = resolveJevConnection(settings);
        return { isJev: true, jev, problem: jev.ok ? '' : jev.problem };
    }
    const connection = resolveLoreBaseLlmConfig(settings);
    return { isJev: false, connection, problem: connection.ok ? '' : describeLoreBaseConnectionProblem(connection.reason, connection.problem, settings) };
}

/**
 * Why the model that picks each reply's entries cannot run (replyModel).
 * @param {object} settings - VectFox settings
 * @returns {string} '' when it can run
 */
export function replyModelProblem(settings) {
    return replyModel(settings).problem;
}

/**
 * The first thing LoreBase's setup lacks, for the WorldInfo page's model card: Qdrant, VectFox's embedding model,
 * LoreBase's own model, then the model that picks each reply's entries, Jev's profile on Fast and Cheap [Jev].
 * @param {object} settings - VectFox settings
 * @returns {string} '' when nothing is missing
 */
export function loreBaseSetupProblem(settings) {
    return vectorWritingProblem(settings) || keyWritingProblem(settings) || replyModelProblem(settings) || '';
}
