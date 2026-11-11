/**
 * What stops embedding on a SillyTavern connection profile (src/features/embedding/embedding-profile-core.js,
 * connection plan §3): each problem in order, each naming the profile and where to fix it.
 */

import { describe, expect, it } from 'vitest';
import { EMBEDDING_PROFILE_PROVIDERS, embeddingProfileProblem } from '../src/features/embedding/embedding-profile-core.js';

const profile = { id: 'p-harbor', name: 'Harbor Ollama', api: 'ollama' };
const ready = { profileId: 'p-harbor', isManagerAvailable: true, profile, profileProvider: 'ollama', url: 'http://harbor:11434', model: 'harbor-embed' };

describe('embeddingProfileProblem', () => {
    it('passes a usable Ollama profile', () => {
        expect(embeddingProfileProblem(ready)).toBe('');
    });

    it('carries Ollama only, which must name its model', () => {
        expect(EMBEDDING_PROFILE_PROVIDERS).toEqual({ ollama: { name: 'Ollama', requiresModel: true } });
    });

    it('names the profile and where to fix each problem, in order', () => {
        expect(embeddingProfileProblem({ ...ready, isManagerAvailable: false, profile: null }))
            .toMatch(/^Embedding: SillyTavern's Connection Manager extension is off.*choose another provider on the Core page\.$/);
        expect(embeddingProfileProblem({ ...ready, profile: null }))
            .toBe('Embedding: its connection profile was deleted in SillyTavern. Choose another on the Core page.');
        expect(embeddingProfileProblem({ ...ready, profile: { ...profile, api: 'custom' }, profileProvider: 'custom', url: '' }))
            .toBe('Embedding: profile "Harbor Ollama" (API "custom") cannot embed: embedding runs on a profile of type Ollama. Choose one on the Core page.');
        expect(embeddingProfileProblem({ ...ready, profileProvider: null, profile: { ...profile, api: 'mystery' } }))
            .toBe('Embedding: profile "Harbor Ollama" (API "mystery") cannot embed: embedding runs on a profile of type Ollama. Choose one on the Core page.');
        expect(embeddingProfileProblem({ ...ready, url: '', model: '' }))
            .toBe('Embedding: profile "Harbor Ollama" names no server URL. Set one in that profile in SillyTavern.');
        expect(embeddingProfileProblem({ ...ready, model: '' }))
            .toBe('Embedding: profile "Harbor Ollama" names no model. Choose an embedding model in that profile in SillyTavern.');
    });
});
