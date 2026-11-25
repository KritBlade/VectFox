/**
 * Saving one field of the open chat's metadata (src/sillytavern/chat.js), as SillyTavern's own chat settings save it:
 * the field set on the open chat's metadata, or deleted for undefined, the other fields kept, then the chat saved
 * through saveMetadata. LoreBase keeps the books added to a chat there (L1 of InternalProject/Vectfox/plans/entity-lore.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ chatMetadata: {} }));

// SillyTavern's script.js, as this folder reaches it when served beside src/: the open chat's metadata, a live binding.
vi.mock('../../../../../script.js', () => ({
    get chat_metadata() { return host.chatMetadata; },
    saveMetadata: vi.fn(async () => {}),
    characters: [],
    getCharacterCardFields: vi.fn(),
    getCurrentChatId: vi.fn(),
    substituteParams: vi.fn(),
}));
// SillyTavern's extensions.js, /scripts/extensions.js, as this folder reaches it when served beside src/.
vi.mock('../../../../extensions.js', () => ({ getContext: vi.fn() }));

const { saveMetadata } = await import('../../../../../script.js');
const { saveChatMetadataField } = await import('../src/sillytavern/chat.js');

beforeEach(() => {
    vi.clearAllMocks();
    host.chatMetadata = { integrity: 'harbor-uuid', world_info: 'Harbor Atlas' };
});

describe('saveChatMetadataField', () => {
    it("sets the field on the open chat's metadata, the other fields kept, then saves the chat", async () => {
        await saveChatMetadataField('vectfox_chat_lorebooks', ['Coral Index', 'Reef Charts']);
        expect(host.chatMetadata).toEqual({ integrity: 'harbor-uuid', world_info: 'Harbor Atlas', vectfox_chat_lorebooks: ['Coral Index', 'Reef Charts'] });
        expect(saveMetadata).toHaveBeenCalledTimes(1);
    });

    it('deletes the field for undefined, then saves the chat', async () => {
        host.chatMetadata.vectfox_chat_lorebooks = ['Coral Index'];
        await saveChatMetadataField('vectfox_chat_lorebooks', undefined);
        expect(host.chatMetadata).toEqual({ integrity: 'harbor-uuid', world_info: 'Harbor Atlas' });
        expect(saveMetadata).toHaveBeenCalledTimes(1);
    });
});
