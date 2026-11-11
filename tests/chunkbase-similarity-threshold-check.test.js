/**
 * Diagnostics' "ChunkBase Similarity Threshold" check (src/features/diagnostics/configuration-checks.js): it passes a
 * threshold from 0.1 to 0.8, warns outside that and fails outside 0 to 1, and every warning and failure names the
 * page the setting is on and its default. The default is written once, in src/shared/constants.js, which index.js's
 * settings defaults and the ChunkBase page's slider also read.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/features/collections/index.js', () => ({
    VALID_GENERATION_TYPES: [],
    validateConditionRule: vi.fn(),
    isCollectionEnabled: vi.fn(),
    getCollectionRegistry: vi.fn(() => ({})),
}));

const { checkChunkBaseSimilarityThreshold } = await import('../src/features/diagnostics/configuration-checks.js');
const { CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT } = await import('../src/shared/constants.js');

const NAME = 'ChunkBase Similarity Threshold';
const WHERE = `on the ChunkBase page, under Retrieval (default ${CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT})`;
const check = threshold => checkChunkBaseSimilarityThreshold({ score_threshold: threshold });

describe('the "ChunkBase Similarity Threshold" check', () => {
    it('passes the default, showing the threshold', () => {
        expect(check(CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT)).toEqual({
            name: NAME, status: 'pass', message: String(CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT),
        });
    });

    it('passes both ends of the range it accepts', () => {
        expect(check(0.1).status).toBe('pass');
        expect(check(0.8).status).toBe('pass');
    });

    it('warns on a threshold that keeps every chunk, naming the page and the default', () => {
        expect(check(0)).toEqual({ name: NAME, status: 'warning', message: `0 keeps chunks however unrelated. Raise it ${WHERE}.` });
    });

    it('warns on a threshold that may drop every chunk, naming the page and the default', () => {
        expect(check(0.9)).toEqual({ name: NAME, status: 'warning', message: `0.9 may drop every chunk. Lower it ${WHERE}.` });
    });

    it('fails a threshold outside 0 to 1, naming the page and the default', () => {
        expect(check(1.5)).toEqual({ name: NAME, status: 'fail', message: `1.5 is outside 0 to 1. Set it ${WHERE}.` });
        expect(check(-0.2).status).toBe('fail');
    });
});

describe('the default ChunkBase similarity threshold', () => {
    it('is 0.25, written only in src/shared/constants.js', () => {
        expect(CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT).toBe(0.25);
    });

    it('is what index.js\'s settings defaults and the ChunkBase slider read', () => {
        const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
        expect(read('../src/index.js')).toContain('    score_threshold: CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT,');
        expect(read('../src/features/settings-panel/settings-panel.js'))
            .toContain("key: 'score_threshold', initial: settings.score_threshold ?? CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT });");
    });

    it('is the default the check names, whatever its value', async () => {
        vi.resetModules();
        vi.doMock('../src/shared/constants.js', () => ({ CHUNKBASE_SIMILARITY_THRESHOLD_DEFAULT: 0.3 }));
        try {
            const { checkChunkBaseSimilarityThreshold: checkWithOtherDefault } = await import('../src/features/diagnostics/configuration-checks.js');
            expect(checkWithOtherDefault({ score_threshold: 0 }).message).toContain('(default 0.3)');
        } finally {
            vi.doUnmock('../src/shared/constants.js');
            vi.resetModules();
        }
    });
});
