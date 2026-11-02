/**
 * Unit tests for src/features/chunkbase/lru-cache.js — the cache
 * chat-vectorization.js keeps message-text hashes in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LRUCache } from '../src/features/chunkbase/lru-cache.js';

describe('LRUCache', () => {
    let cache;

    beforeEach(() => {
        cache = new LRUCache(3);
    });

    it('should set and get values', () => {
        cache.set('a', 1);
        expect(cache.get('a')).toBe(1);
    });

    it('should return undefined for missing keys', () => {
        expect(cache.get('missing')).toBeUndefined();
    });

    it('should evict least recently used item when at capacity', () => {
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.set('d', 4); // Should evict 'a'

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
        expect(cache.get('d')).toBe(4);
    });

    it('should update LRU order on get', () => {
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.get('a'); // Access 'a', making it most recent
        cache.set('d', 4); // Should evict 'b' (not 'a')

        expect(cache.get('a')).toBe(1);
        expect(cache.get('b')).toBeUndefined();
    });

    it('should update LRU order on set of existing key', () => {
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.set('a', 10); // Update 'a', making it most recent
        cache.set('d', 4); // Should evict 'b'

        expect(cache.get('a')).toBe(10);
        expect(cache.get('b')).toBeUndefined();
    });
});
