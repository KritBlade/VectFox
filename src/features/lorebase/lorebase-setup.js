/**
 * What LoreBase's setup lacks, for the WorldInfo page's model card (§2 and §7.2 of InternalProject/Vectfox/plans/
 * lorebook-multi-vector.md): the first thing missing, in the order a new user sets it up. Each check is the one the
 * runs themselves make, so the card and a run say the same.
 */
import { embeddingSetupProblem } from '../embedding/index.js';
import { describeLoreBaseConnectionProblem, resolveLoreBaseLlmConfig } from './lorebase-connection.js';
import { resolveJevConnection } from './lorebase-jev.js';
import { FAST_AND_CHEAP, loreBaseAccuracyOf } from './lorebase-reply-core.js';
import { isLoreBaseBackend } from './lorebase-switch.js';

const CORE_PAGE = 'Core page';

/**
 * The first thing LoreBase's setup lacks: Qdrant, where its keys and vectors live; VectFox's embedding model, which
 * writes the vectors; LoreBase's own model, which writes the keys; and on Fast and Cheap [Jev], Jev's profile. The
 * embedding's problem says where it is set only when its own words do not: a connection profile's already name the
 * Core page.
 * @param {object} settings - VectFox settings
 * @returns {string} '' when nothing is missing
 */
export function loreBaseSetupProblem(settings) {
    if (!isLoreBaseBackend(settings)) return `LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the ${CORE_PAGE}.`;
    const embeddingProblem = embeddingSetupProblem(settings);
    if (embeddingProblem) {
        const sentence = /[.!?]$/.test(embeddingProblem) ? embeddingProblem : `${embeddingProblem}.`;
        const where = sentence.includes(CORE_PAGE) ? '' : ` Set it on the ${CORE_PAGE}.`;
        return `VectFox's embedding model writes LoreBase's vectors, and it cannot run yet: ${sentence}${where}`;
    }
    const connection = resolveLoreBaseLlmConfig(settings);
    if (!connection.ok) return describeLoreBaseConnectionProblem(connection.reason, connection.problem);
    if (loreBaseAccuracyOf(settings.lorebase_accuracy) !== FAST_AND_CHEAP) return '';
    const jev = resolveJevConnection(settings);
    return jev.ok ? '' : jev.problem;
}
