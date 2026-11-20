/**
 * What LoreBase's setup lacks (src/features/lorebase/lorebase-setup.js, §2 and §7.2 of InternalProject/Vectfox/plans/
 * lorebook-multi-vector.md): the first thing missing, in the order a new user sets it up: Qdrant, VectFox's embedding
 * model, LoreBase's model, then Jev's profile, on Fast and Cheap [Jev] alone; and the model that picks each reply's
 * entries, which turning LoreBase on needs: Jev on Fast and Cheap [Jev], LoreBase's own model on High Accuracy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ embeddingProblem: '', connection: { ok: true }, jev: { ok: true } }));

vi.mock('../src/features/embedding/index.js', () => ({ embeddingSetupProblem: () => host.embeddingProblem }));
vi.mock('../src/features/lorebase/lorebase-connection.js', () => ({
    resolveLoreBaseLlmConfig: () => host.connection,
    describeLoreBaseConnectionProblem: (reason, problem) => `LoreBase: ${problem ?? reason}`,
}));
vi.mock('../src/features/lorebase/lorebase-jev.js', () => ({ resolveJevConnection: () => host.jev }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/vector-storage.js', () => ({ isVectorStorageWorldInfoOn: () => false }));

const { loreBaseSetupProblem, replyModelProblem } = await import('../src/features/lorebase/lorebase-setup.js');

const READY = { vector_backend: 'qdrant', lorebase_accuracy: 'fast' };
const NO_JEV = 'Fast and Cheap [Jev] has no profile for Jev.';

beforeEach(() => {
    host.embeddingProblem = '';
    host.connection = { ok: true };
    host.jev = { ok: true };
});

describe("what LoreBase's setup lacks", () => {
    it("names nothing while Qdrant, the embedding model, LoreBase's model and Jev's profile are all set", () => {
        expect(loreBaseSetupProblem(READY)).toBe('');
    });

    it('names the first thing missing, in the order a new user sets them up', () => {
        host.embeddingProblem = 'OpenRouter selected but no model configured';
        host.connection = { ok: false, reason: 'missing_model' };
        host.jev = { ok: false, problem: NO_JEV };
        expect(loreBaseSetupProblem({ ...READY, vector_backend: 'standard' }))
            .toBe("LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page.");
        expect(loreBaseSetupProblem(READY))
            .toBe("VectFox's embedding model writes LoreBase's vectors, and it cannot run yet: OpenRouter selected but no model configured. Set it on the Core page.");
        host.embeddingProblem = '';
        expect(loreBaseSetupProblem(READY)).toBe('LoreBase: missing_model');
        host.connection = { ok: true };
        expect(loreBaseSetupProblem(READY)).toBe(NO_JEV);
    });

    it("asks for Jev's profile on Fast and Cheap [Jev] alone, keeps the full stop an embedding problem ends on, and names the Core page once", () => {
        host.jev = { ok: false, problem: NO_JEV };
        expect(loreBaseSetupProblem({ ...READY, lorebase_accuracy: 'high' })).toBe('');
        host.embeddingProblem = 'The profile "Harbor Ollama" was deleted in SillyTavern.';
        expect(loreBaseSetupProblem(READY)).toBe(
            'VectFox\'s embedding model writes LoreBase\'s vectors, and it cannot run yet: The profile "Harbor Ollama" was deleted in SillyTavern. Set it on the Core page.');
        host.embeddingProblem = 'Embedding: no connection profile is chosen. Choose one on the Core page.';
        expect(loreBaseSetupProblem(READY)).toBe(
            "VectFox's embedding model writes LoreBase's vectors, and it cannot run yet: Embedding: no connection profile is chosen. Choose one on the Core page.");
    });
});

describe("the model that picks each reply's entries", () => {
    it("is Jev on Fast and Cheap [Jev], whatever LoreBase's own model, which only writes the keys there", () => {
        expect(replyModelProblem(READY)).toBe('');
        host.jev = { ok: false, problem: NO_JEV };
        expect(replyModelProblem(READY)).toBe(NO_JEV);
        host.jev = { ok: true };
        host.connection = { ok: false, reason: 'missing_model' };
        expect(replyModelProblem(READY)).toBe('');
    });

    it("is LoreBase's own model on High Accuracy, whatever Jev's profile", () => {
        const highAccuracy = { ...READY, lorebase_accuracy: 'high' };
        host.jev = { ok: false, problem: NO_JEV };
        expect(replyModelProblem(highAccuracy)).toBe('');
        host.connection = { ok: false, reason: 'no_profile' };
        expect(replyModelProblem(highAccuracy)).toBe('LoreBase: no_profile');
    });

    it('names neither Qdrant nor the embedding model', () => {
        host.embeddingProblem = 'OpenRouter selected but no model configured';
        expect(replyModelProblem({ ...READY, vector_backend: 'standard' })).toBe('');
    });
});
