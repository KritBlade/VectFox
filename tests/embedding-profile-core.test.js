/**
 * What stops embedding on a SillyTavern connection profile (src/features/embedding/embedding-profile-core.js,
 * connection plan §3): each problem in order, each naming the profile and where to fix it.
 */

import { describe, expect, it } from 'vitest';
import { EMBEDDING_PROFILE_PROVIDERS, embeddingProfileKind, embeddingProfileProblem } from '../src/features/embedding/embedding-profile-core.js';

const CURRENT_PLUGIN = { isFound: true, version: '3.4.0', isCurrent: true, requiredVersion: '3.4.0', updateInstructions: 'Restart SillyTavern.' };

const profile = { id: 'p-harbor', name: 'Harbor Ollama', api: 'ollama' };
const ready = {
    provider: 'ollama', profileId: 'p-harbor', isManagerAvailable: true, profile, profileProvider: 'ollama',
    url: 'http://harbor:11434', model: 'harbor-embed', plugin: CURRENT_PLUGIN,
};

/** A usable profile of a type that sends its key ID through Similharity. */
const readyOn = (provider, api, extra = {}) => ({
    ...ready, provider, profileProvider: provider, profile: { id: 'p-lantern', name: 'Lantern', api }, url: 'http://lantern:8080', ...extra,
});

describe('embeddingProfileProblem', () => {
    it('passes a usable profile of each type, a model left out where the server picks it', () => {
        expect(embeddingProfileProblem(ready)).toBe('');
        expect(embeddingProfileProblem(readyOn('llamacpp', 'llamacpp', { model: '' }))).toBe('');
        expect(embeddingProfileProblem(readyOn('koboldcpp', 'koboldcpp', { model: '' }))).toBe('');
        expect(embeddingProfileProblem(readyOn('custom', 'custom'))).toBe('');
    });

    it('carries Ollama, with fields of its own and no key, and three types that send the key ID through Similharity', () => {
        expect(EMBEDDING_PROFILE_PROVIDERS).toEqual({
            ollama: { name: 'Ollama', requiresModel: true, hasManualFields: true, sendsKeyId: false },
            llamacpp: { name: 'llama.cpp', requiresModel: false, hasManualFields: false, sendsKeyId: true },
            koboldcpp: { name: 'KoboldCPP', requiresModel: false, hasManualFields: false, sendsKeyId: true },
            custom: { name: 'Custom', requiresModel: true, hasManualFields: false, sendsKeyId: true },
        });
        expect(embeddingProfileKind('__proto__')).toBeNull();
        expect(embeddingProfileKind('vllm')).toBeNull();
    });

    it('names the profile and where to fix each problem, in order', () => {
        expect(embeddingProfileProblem({ ...ready, profileId: '', profile: null }))
            .toBe('Embedding: no connection profile is chosen. Choose one on the Core page.');
        expect(embeddingProfileProblem({ ...ready, isManagerAvailable: false, profile: null }))
            .toMatch(/^Embedding: SillyTavern's Connection Manager extension is off.*choose another provider on the Core page\.$/);
        expect(embeddingProfileProblem({ ...ready, profile: null }))
            .toBe('Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.');
        expect(embeddingProfileProblem({ ...ready, profileProvider: null, profile: { ...profile, api: 'openrouter' }, url: '' }))
            .toBe('Embedding: profile "Harbor Ollama" (API "openrouter") cannot embed: embedding runs on a profile of type '
                + 'Ollama, llama.cpp, KoboldCPP, or Custom. Choose one on the Core page.');
        expect(embeddingProfileProblem({ ...ready, profileProvider: 'custom', profile: { ...profile, api: 'custom' }, url: '' }))
            .toBe('Embedding: profile "Harbor Ollama" is now a Custom profile, and embedding was set up on it as Ollama. '
                + 'Choose the profile again on the Core page.');
        expect(embeddingProfileProblem({ ...ready, url: '', model: '' }))
            .toBe('Embedding: profile "Harbor Ollama" names no server URL. Set one in that profile in SillyTavern.');
        expect(embeddingProfileProblem({ ...ready, model: '' }))
            .toBe('Embedding: profile "Harbor Ollama" names no model. Choose an embedding model in that profile in SillyTavern.');
        expect(embeddingProfileProblem(readyOn('custom', 'custom', { model: '' })))
            .toBe('Embedding: profile "Lantern" names no model. Choose an embedding model in that profile in SillyTavern.');
    });

    it('stops a type that sends its key ID without Similharity 3.4.0, before its URL and model', () => {
        const needs = 'Embedding: profile "Lantern" is a llama.cpp profile, which embeds only through the Similharity plugin 3.4.0 or later';
        const noPlugin = { ...CURRENT_PLUGIN, isFound: false, version: null, isCurrent: false };
        expect(embeddingProfileProblem(readyOn('llamacpp', 'llamacpp', { plugin: noPlugin, url: '' })))
            .toBe(`${needs}, and SillyTavern has none. Install Similharity as the VectFox README says.`);
        const oldPlugin = { ...CURRENT_PLUGIN, version: '3.3.5', isCurrent: false };
        expect(embeddingProfileProblem(readyOn('llamacpp', 'llamacpp', { plugin: oldPlugin })))
            .toBe(`${needs}, and SillyTavern has Similharity 3.3.5. Restart SillyTavern.`);
        const unversioned = { ...CURRENT_PLUGIN, version: null, isCurrent: false };
        expect(embeddingProfileProblem(readyOn('llamacpp', 'llamacpp', { plugin: unversioned })))
            .toBe(`${needs}, and SillyTavern has a Similharity that reports no version. Restart SillyTavern.`);
    });

    it('lets Ollama run with no plugin, as SillyTavern\'s own route embeds on it', () => {
        expect(embeddingProfileProblem({ ...ready, plugin: { ...CURRENT_PLUGIN, isFound: false, version: null, isCurrent: false } })).toBe('');
    });
});
