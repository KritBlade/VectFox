/**
 * What a failed embedding request means, read the same way at every place an embedding request can fail: the query
 * embedding, and Qdrant's and the Standard backend's inserts and queries. A wrong model or configuration, and a key
 * that a llama.cpp, KoboldCPP or Custom profile's server refuses, throw with `code: 'invalid_model_config'`, the code
 * that raises the sticky toast and pauses auto-sync (connection plan §3, §4).
 */

import { connectionProfileKeyMessage, namesKeyProblem } from '../../shared/connection-profile-key-failure.js';
import { throwIfModelConfigError } from '../../shared/model-http-errors.js';
import { log } from '../../sillytavern/log.js';
import { embeddingProfileKind } from './embedding-profile-core.js';
import { getModelFromSettings, resolveEmbeddingProfile } from './providers.js';

/**
 * Throw when a failed embedding request is the user's configuration to fix; return so the caller throws its own error
 * otherwise. On a profile that sends a key ID, text naming a key problem throws the key message, naming the profile.
 *
 * @param {object} settings - VectFox settings
 * @param {{status: number, responseText: string}} failure - The HTTP status and the reply's text
 * @throws {Error} With `code: 'invalid_model_config'`
 */
export function throwIfEmbeddingConfigError(settings, { status, responseText }) {
    const onProfile = embeddingProfileKind(settings?.embedding_provider)?.sendsKeyId ? resolveEmbeddingProfile(settings) : null;
    if (onProfile?.profileName && namesKeyProblem(responseText)) {
        log.warn(`[VectFox] Embedding: the server of profile "${onProfile.profileName}" refused the key (HTTP ${status}):`, String(responseText).slice(0, 300));
        const message = connectionProfileKeyMessage({ feature: 'Embedding', profileName: onProfile.profileName, storesKey: onProfile.storesKey });
        throw Object.assign(new Error(message), { code: 'invalid_model_config' });
    }
    throwIfModelConfigError({
        contextLabel: 'Embedding',
        provider: settings?.embedding_provider,
        model: getModelFromSettings(settings),
        status,
        responseText,
        enforceStatusGate: false,
    });
}
