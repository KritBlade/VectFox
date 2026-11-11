/**
 * What a failed embedding means for the person who pressed Save (src/features/vector-backend/embedding-failure.js):
 * busy or slow, which passes; a server VectFox could not reach; a refused setup; or another server error.
 */

import { describe, expect, it } from 'vitest';
import { describeEmbeddingFailure } from '../src/features/vector-backend/embedding-failure.js';

const hedgeFatal = tail => Object.assign(new Error(`Hedge fatal: 4 attempts via openrouter failed in 60.0s — ${tail}`), { name: 'HedgeFatalError', isHedgeFatal: true });
const kindOf = error => describeEmbeddingFailure(error).kind;

describe('a failed embedding', () => {
    it('is busy when the provider limits or overloads, a gateway fails, or a request times out', () => {
        expect(kindOf(new Error('[Qdrant] Failed to insert 1 vectors into harbor: 500 Internal Server Error - {"error":"429 Too Many Requests"}'))).toBe('busy');
        expect(kindOf(new Error('Rate limit exceeded, retry later'))).toBe('busy');
        expect(kindOf(new Error('The engine is currently overloaded'))).toBe('busy');
        expect(kindOf(new Error('503 Service Unavailable'))).toBe('busy');
        expect(kindOf(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))).toBe('busy');
    });

    it('reads a hedge that ran out by its last error, and one whose attempts never came back as slow', () => {
        expect(kindOf(hedgeFatal('last error: Error: 429 Too Many Requests'))).toBe('busy');
        expect(kindOf(hedgeFatal('4 attempts still in-flight at cutoff, none returned'))).toBe('busy');
        expect(kindOf(hedgeFatal('last error: TypeError: fetch failed'))).toBe('unreachable');
    });

    it('is unreachable when the server cannot be connected to', () => {
        expect(kindOf(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe('unreachable');
        expect(kindOf(new TypeError('Failed to fetch'))).toBe('unreachable');
    });

    it('is a refused setup for a configuration error, whatever its words', () => {
        const sizeChange = Object.assign(new Error('Embedding: this collection holds vectors of size 1024, but the current embedding model makes size 768, so nothing was stored.'), { code: 'invalid_model_config' });
        expect(describeEmbeddingFailure(sizeChange)).toMatchObject({ kind: 'setup', detail: sizeChange.message });
    });

    it('is a server error for anything else, and gives the error in one line', () => {
        const failure = describeEmbeddingFailure(new Error('[Qdrant] Failed to insert 1 vectors: 500 Internal Server Error -\n {"error":"model not loaded"}'));
        expect(failure.kind).toBe('server');
        expect(failure.detail).toBe('[Qdrant] Failed to insert 1 vectors: 500 Internal Server Error - {"error":"model not loaded"}');
        expect(failure.advice).toMatch(/not the busy kind/);
    });

    it('tells a busy provider to try Save again', () => {
        expect(describeEmbeddingFailure(new Error('429')).advice).toMatch(/Press Save again in a moment/);
    });
});
