/**
 * LoreBase's Fast and Cheap [Jev] choice, its connection (plan D16 and §5.6 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): Jev runs on the SillyTavern profile chosen on its own row of the
 * WorldInfo page, an OpenRouter or Custom profile naming Jev's model. VectFox sends Similharity the profile's source,
 * URL, model and key ID, never a key; Similharity reads the key on SillyTavern's server and asks Jev at the URL's
 * `/systemone`, sending a key only where SillyTavern sends it.
 */
import { connectionProfileDecisionsFields, findConnectionProfile } from '../../sillytavern/connection-profiles.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { readErrorBody } from '../../shared/server-error-text.js';
import { connectionConsequence } from './lorebase-connection.js';
import { CALL_TIMEOUT_MS } from './lorebase-reply-core.js';

const DECISIONS_ROUTE = '/api/plugins/similharity/lorebase/decisions';
/** The setting that holds Jev's profile ID. */
export const JEV_PROFILE_SETTING = 'lorebase_jev_connection_profile_id';
const WHERE_TO_FIX = 'Choose one in the Jev group of the LoreBase model card on the WorldInfo page.';
// A made-up state and question for Test connection, so a test never carries chat text.
const TEST_STATE = "The chat so far. The last message is the user's; the next reply answers it.\n\nWren: We sail for the harbor lighthouse at dawn.";
const TEST_QUESTIONS = { e1: { type: 'noul', instructions: 'Does the next reply need the lorebook entry "Harbor lighthouse" (about: lighthouse, harbor, keeper)?' } };

/**
 * Jev's connection on the profile chosen for it, or why it cannot run, ending on what that costs as LoreBase stands
 * now (connectionConsequence).
 * @param {object} settings - VectFox settings
 * @returns {{ok: true, fields: object}|{ok: false, problem: string}}
 */
export function resolveJevConnection(settings) {
    const cannotRun = (...sentences) => ({ ok: false, problem: [...sentences, connectionConsequence(settings, { isJev: true })].filter(Boolean).join(' ') });
    const profileId = String(settings?.[JEV_PROFILE_SETTING] ?? '').trim();
    if (!profileId) return cannotRun('Fast and Cheap [Jev] has no profile for Jev.', WHERE_TO_FIX);
    const profile = findConnectionProfile(profileId);
    if (!profile) return cannotRun("Jev's profile is no longer in SillyTavern.", WHERE_TO_FIX);
    const fields = connectionProfileDecisionsFields(profile);
    if (!fields) return cannotRun(`Jev's profile "${profile.name}" is neither an OpenRouter nor a Custom profile.`, WHERE_TO_FIX);
    if (!fields.model) {
        return cannotRun(`Jev's profile "${profile.name}" names no model: set typesafe/jev-1.14 on OpenRouter, or jev-1.14.0 on Typesafe's own URL.`);
    }
    if (fields.source === 'custom' && !fields.apiUrl) return cannotRun(`Jev's Custom profile "${profile.name}" names no URL.`);
    return { ok: true, fields };
}

/**
 * Ask Jev the questions about the state, through Similharity.
 * @param {object} fields - From resolveJevConnection
 * @param {string} state
 * @param {Record<string, {type: string, instructions: string}>} questions
 * @returns {Promise<{yes: Record<string, number>, inputTokens: number|null, usd: number|null}>}
 * @throws {Error} What Similharity answered, or a TimeoutError when it has not answered in time
 */
export async function askJev(fields, state, questions) {
    const response = await fetch(DECISIONS_ROUTE, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ ...fields, state, questions }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = await readErrorBody(response, response.statusText);
        throw new Error(`Jev could not answer through Similharity (HTTP ${response.status}): ${detail}`);
    }
    return response.json();
}

/**
 * Jev's Test connection (WorldInfo page): one made-up question on Jev's profile.
 * @param {object} settings - VectFox settings
 * @returns {Promise<{content: string, cutReason: null}>}
 * @throws {Error} Why Jev's connection cannot run, or what the call threw
 */
export async function testJevConnection(settings) {
    const connection = resolveJevConnection(settings);
    if (!connection.ok) throw new Error(connection.problem);
    const { yes, usd } = await askJev(connection.fields, TEST_STATE, TEST_QUESTIONS);
    const cost = Number.isFinite(usd) ? `, for $${usd.toFixed(6)}` : '';
    return { content: `Jev rated a made-up entry at ${Number(yes.e1).toFixed(2)}${cost}.`, cutReason: null };
}
