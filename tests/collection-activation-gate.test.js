/**
 * shouldCollectionActivate — the activation gate contract.
 *
 * THE MODEL (owner's design, implemented 2026-07-29):
 *   The LOCK is the master switch. A collection that is not locked to the current
 *   chat or character never activates, whatever else is configured. Activation
 *   Triggers and Advanced Conditions only NARROW an already-locked collection —
 *   they cannot switch one on by themselves, and when both are set both must pass.
 *
 * This replaced an OR chain where a trigger match returned true "regardless of
 * lock state", which inverted the model twice over:
 *   - an UNLOCKED collection could activate on a keyword (the cross-persona leak
 *     that the isOwn guard in core/world-info-integration.js was added to contain)
 *   - a non-matching trigger fell THROUGH to the lock check, so a trigger on a
 *     LOCKED collection was a no-op that could never gate anything
 *
 * The gate is shared: documents/files/URLs/characters reach it via
 * filterActiveCollections (core/chat-vectorization.js, core/core-vector-api.js),
 * lorebooks via core/world-info-integration.js. These tests are the contract for
 * all of them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: { collections: {} } },
    getContext: vi.fn(() => ({ characterId: '0', name1: 'TestPersona' })),
}));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

// Advanced conditions have their own suite; here they are a controllable gate so
// the AND relationship with triggers can be pinned without a rules engine.
const conditionResult = vi.hoisted(() => ({ value: true }));
vi.mock('../core/conditional-activation.js', () => ({
    evaluateConditionRule: vi.fn(() => conditionResult.value),
}));

import { extension_settings } from '../../../../extensions.js';
import { shouldCollectionActivate } from '../core/collection-metadata.js';

const COLLECTION = 'qdrant:vf_lorebook_qdrant_testpersona_worldlore_1750000000000';
const CHAT_ID = 'chat-abc';
const CHARACTER_ID = '4';

/** Write collection metadata the way setCollectionMeta would. */
function setMeta(meta) {
    extension_settings.vectfox.collections[COLLECTION] = meta;
}

/** Context as the callers build it — trigger matching needs recentMessages. */
function context({ chatId = CHAT_ID, characterId = CHARACTER_ID, messages = ['The dragon circled the spire.'] } = {}) {
    return { currentChatId: chatId, currentCharacterId: characterId, recentMessages: messages };
}

beforeEach(() => {
    extension_settings.vectfox = { collections: {} };
    conditionResult.value = true;
});

describe('Gate 1 — pause button', () => {
    it('blocks even a locked collection', async () => {
        setMeta({ enabled: false, lockedToChatIds: [CHAT_ID] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });
});

describe('Gate 2 — the lock is the master switch', () => {
    it('does not activate an unlocked collection', async () => {
        setMeta({});
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });

    it('does not activate on a trigger match when the collection is UNLOCKED', async () => {
        // The regression this whole change exists for. Under the old OR chain this
        // returned true and bypassed the lock entirely.
        setMeta({ triggers: ['dragon'] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });

    it('does not activate on passing conditions when the collection is UNLOCKED', async () => {
        setMeta({ conditions: { enabled: true, rules: [{ type: 'always' }], logic: 'AND' } });
        conditionResult.value = true;
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });

    it('activates a chat-locked collection with nothing else configured', async () => {
        setMeta({ lockedToChatIds: [CHAT_ID] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(true);
    });

    it('activates a character-locked collection with nothing else configured', async () => {
        setMeta({ lockedToCharacterIds: [CHARACTER_ID] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(true);
    });

    it('does not activate when the lock points at a DIFFERENT chat and character', async () => {
        setMeta({ lockedToChatIds: ['some-other-chat'], lockedToCharacterIds: ['99'] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });
});

describe('Gate 3 — triggers narrow a locked collection', () => {
    it('activates when locked AND the trigger matches', async () => {
        setMeta({ lockedToChatIds: [CHAT_ID], triggers: ['dragon'] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(true);
    });

    it('does NOT activate when locked but the trigger misses', async () => {
        // Under the old OR chain this fell through to the lock and returned true,
        // making triggers a no-op on every locked collection.
        setMeta({ lockedToChatIds: [CHAT_ID], triggers: ['unicorn'] });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });

    it('does not activate when the context carries no messages to scan', async () => {
        // checkTriggers returns false on empty scan text. Callers must supply
        // recentMessages; omitting it is what silently killed lorebook triggers.
        setMeta({ lockedToChatIds: [CHAT_ID], triggers: ['dragon'] });
        expect(await shouldCollectionActivate(COLLECTION, context({ messages: [] }))).toBe(false);
    });

    it('honors matchMode "all"', async () => {
        setMeta({ lockedToChatIds: [CHAT_ID], triggers: ['dragon', 'spire'], triggerMatchMode: 'all' });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(true);

        setMeta({ lockedToChatIds: [CHAT_ID], triggers: ['dragon', 'griffin'], triggerMatchMode: 'all' });
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });
});

describe('Gate 4 — conditions narrow further, and both must pass', () => {
    const bothConfigured = {
        lockedToChatIds: [CHAT_ID],
        triggers: ['dragon'],
        conditions: { enabled: true, rules: [{ type: 'always' }], logic: 'AND' },
    };

    it('activates when locked, trigger matches, and conditions pass', async () => {
        setMeta(bothConfigured);
        conditionResult.value = true;
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(true);
    });

    it('does not activate when the trigger matches but conditions fail', async () => {
        setMeta(bothConfigured);
        conditionResult.value = false;
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });

    it('does not activate when conditions pass but the trigger misses', async () => {
        setMeta({ ...bothConfigured, triggers: ['unicorn'] });
        conditionResult.value = true;
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(false);
    });

    it('ignores conditions that are configured but switched off', async () => {
        setMeta({
            lockedToChatIds: [CHAT_ID],
            conditions: { enabled: false, rules: [{ type: 'always' }], logic: 'AND' },
        });
        conditionResult.value = false;   // would fail if it were consulted
        expect(await shouldCollectionActivate(COLLECTION, context())).toBe(true);
    });
});
