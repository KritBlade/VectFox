/**
 * EventBase fork for branch/checkpoint chats — parent matching, split point,
 * and which events are copied.
 *
 * Message hashes go through hashSourceMessage, the same function the extractor
 * stores in `source_message_hashes` and the window record fingerprints, so the
 * fixtures below are built with it.
 */

import { describe, it, expect } from 'vitest';
import { hashSourceMessage } from '../src/features/eventbase/eventbase-message-hash.js';
import {
    measureSharedPrefix,
    rankForkSourcesFromWindowRecords,
    collectSourceMessageHashes,
    selectChunksBeforeSplit,
    toBranchChunk,
    findEmbeddingMismatch,
    summarizeCopiedWindows,
} from '../src/features/eventbase/eventbase-fork-core.js';

const message = (name, mes) => ({ name, mes });
const fingerprint = (hashes) => hashes.map(String).sort().join(',');
const windowsOf = (hashes, size) => {
    const windows = [];
    for (let start = 0; start + size <= hashes.length; start += size) windows.push(hashes.slice(start, start + size));
    return windows;
};
const eventChunk = (start, end, sourceHashes, extra = {}) => ({
    hash: start * 1000 + end,
    text: `event ${start}-${end}`,
    index: end,
    vector: [0.1, 0.2],
    metadata: {
        source_window_start: start,
        source_window_end: end,
        source_message_ids: Array.from({ length: end - start + 1 }, (_, i) => start + i),
        source_message_hashes: sourceHashes,
        chat_uuid: 'parent-uuid',
        ...extra,
    },
});

// Parent: 12 messages. Branch: shares the first 8, then diverges.
const parentMessages = Array.from({ length: 12 }, (_, i) => message(i % 2 ? 'Char' : 'User', `parent line ${i}`));
const branchMessages = [
    ...parentMessages.slice(0, 8),
    message('User', 'branch line 8'),
    message('Char', 'branch line 9'),
];
const parentHashes = parentMessages.map(hashSourceMessage);
const branchHashes = branchMessages.map(hashSourceMessage);

describe('hashSourceMessage', () => {
    it('keeps the stored hash values (window record and stored events depend on them)', () => {
        expect(hashSourceMessage({ name: 'Kai', mes: '  早安！\n' })).toBe(1144484477);
        expect(hashSourceMessage({ name: 'Rin', mes: 'Hello there' })).toBe(2680015622);
    });

    it('prefers the message\'s own hash', () => {
        expect(hashSourceMessage({ hash: 42, name: 'x', mes: 'y' })).toBe(42);
    });
});

describe('measureSharedPrefix', () => {
    it('stops at the first message the parent never had', () => {
        expect(measureSharedPrefix(branchHashes, new Set(parentHashes.map(String)))).toBe(8);
    });

    it('stops early at a message whose hash was never recorded', () => {
        const known = new Set(parentHashes.map(String));
        known.delete(String(parentHashes[3]));
        expect(measureSharedPrefix(branchHashes, known)).toBe(3);
    });
});

describe('rankForkSourcesFromWindowRecords', () => {
    const collection = (name, windowFingerprints, isLockedToParentChat = false) =>
        ({ registryKey: `qdrant:vf_eventbase_qdrant_wren_harbor_${name}`, collectionId: `vf_eventbase_qdrant_wren_harbor_${name}`, windowFingerprints, isLockedToParentChat });

    it('finds the parent collection and the split point from its window record alone', () => {
        const parent = collection('parent-uuid', windowsOf(parentHashes, 2).map(fingerprint));
        expect(rankForkSourcesFromWindowRecords([parent], branchHashes)).toEqual([
            { registryKey: parent.registryKey, collectionId: parent.collectionId, sharedPrefixLength: 8, coveredWindowCount: 4 },
        ]);
    });

    it('stops at the parent\'s extraction tip when auto-sync was off for its later messages', () => {
        const parent = collection('parent-uuid', windowsOf(parentHashes.slice(0, 4), 2).map(fingerprint));
        expect(rankForkSourcesFromWindowRecords([parent], branchHashes)[0])
            .toMatchObject({ sharedPrefixLength: 4, coveredWindowCount: 2 });
    });

    it('ignores a collection that shares only the greeting, and one with no window record', () => {
        const unrelated = [parentMessages[0], message('User', 'a different opening'), message('Char', 'reply')];
        const candidates = [collection('other-uuid', [fingerprint(unrelated.slice(0, 2).map(hashSourceMessage))]), collection('empty-uuid', [])];
        expect(rankForkSourcesFromWindowRecords(candidates, branchHashes)).toEqual([]);
    });

    it('ranks the longest shared prefix first', () => {
        const candidates = [
            collection('grandparent-uuid', windowsOf(parentHashes.slice(0, 4), 2).map(fingerprint)),
            collection('parent-uuid', windowsOf(parentHashes, 2).map(fingerprint)),
        ];
        expect(rankForkSourcesFromWindowRecords(candidates, branchHashes).map(c => c.collectionId))
            .toEqual(['vf_eventbase_qdrant_wren_harbor_parent-uuid', 'vf_eventbase_qdrant_wren_harbor_grandparent-uuid']);
    });

    it('puts the one locked to the parent chat first of two that share as many messages, before more covered windows', () => {
        // Both share the 8 messages: one read in windows of 2 (4 covered), the locked one in windows of 4 (2 covered).
        const candidates = [
            collection('parent-uuid', windowsOf(parentHashes.slice(0, 8), 2).map(fingerprint)),
            collection('parent-uuid_mh3k2x1a', windowsOf(parentHashes.slice(0, 8), 4).map(fingerprint), true),
        ];
        expect(rankForkSourcesFromWindowRecords(candidates, branchHashes).map(c => [c.collectionId, c.coveredWindowCount]))
            .toEqual([['vf_eventbase_qdrant_wren_harbor_parent-uuid_mh3k2x1a', 2], ['vf_eventbase_qdrant_wren_harbor_parent-uuid', 4]]);
    });
});

describe('selecting the events to copy', () => {
    const parentChunks = [
        ...windowsOf(parentHashes, 2).map((hashes, i) => eventChunk(i * 2, i * 2 + 1, hashes)),
        // Message 2 was edited in the parent after this event was extracted.
        eventChunk(2, 3, [111, parentHashes[3]]),
    ];

    it('copies every event before the split — including ones whose message was edited later', () => {
        const split = measureSharedPrefix(branchHashes, collectSourceMessageHashes(parentChunks));
        expect(split).toBe(8);
        const copied = selectChunksBeforeSplit(parentChunks, split);
        expect(copied.map(c => c.metadata.source_window_end)).toEqual([1, 3, 5, 7, 3]);
    });

    it('drops chunks that are not chat-window events', () => {
        expect(selectChunksBeforeSplit([{ metadata: {} }, eventChunk(0, 1, [])], 8)).toHaveLength(1);
    });

    it('re-homes a copied event to the branch without changing the point', () => {
        const chunk = eventChunk(0, 1, parentHashes.slice(0, 2));
        const copy = toBranchChunk(chunk, 'branch-uuid');
        expect(copy.metadata.chat_uuid).toBe('branch-uuid');
        expect(copy.hash).toBe(chunk.hash);
        expect(copy.vector).toBe(chunk.vector);
        expect(chunk.metadata.chat_uuid).toBe('parent-uuid');
    });

    it('carries the tip and window hashes over to the branch', () => {
        const copied = selectChunksBeforeSplit(parentChunks, 8);
        const { tip, sourceHashLists } = summarizeCopiedWindows(copied);
        expect(tip).toBe(8);
        expect(sourceHashLists).toHaveLength(5);
    });
});

describe('findEmbeddingMismatch', () => {
    const chunks = [eventChunk(0, 1, [], { embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' })];

    it('passes when the embedding matches', () => {
        expect(findEmbeddingMismatch(chunks, { source: 'openrouter', model: 'baai/bge-m3' })).toBeNull();
    });

    it('reports a different model', () => {
        expect(findEmbeddingMismatch(chunks, { source: 'openrouter', model: 'text-embedding-3-small' }))
            .toEqual({ embeddingSource: 'openrouter', embeddingModel: 'baai/bge-m3' });
    });

    it('skips fields the backend did not store', () => {
        expect(findEmbeddingMismatch([eventChunk(0, 1, [])], { source: 'openrouter', model: 'x' })).toBeNull();
    });
});
