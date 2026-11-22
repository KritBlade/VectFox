/**
 * What a VectFox file is, and the header each opens with (§1 of InternalProject/Vectfox/plans/
 * executed/vectfox-multi-collection-per-chat.md): exportFileKind in src/features/collections/collection-export.js tells a
 * collection export, of one collection or several, from a row's own file by the type it names, which the Database
 * Browser's Import a collection refuses; and exportFileHeader in src/shared/export-file-header.js dates each new file.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: new Proxy({}, { get: () => () => {} }) }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: {} }, saveSettingsDebounced: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => ({}), getCurrentChatId: () => 'chat-1', chat_metadata: {} }));
vi.mock('../src/sillytavern/secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {} }));
vi.mock('../src/sillytavern/connection-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));

const { exportFileKind } = await import('../src/features/collections/collection-export.js');
const { exportFileHeader } = await import('../src/shared/export-file-header.js');

describe('what a file is', () => {
    it('is a collection when it names no type of its own, or holds several collections', () => {
        expect(exportFileKind({ version: '1.0.0', collection: { id: 'vf_eventbase_chat' }, chunks: [] })).toBe('collection');
        expect(exportFileKind({ version: '1.0.0', type: 'multi', collections: [] })).toBe('collection');
        expect(exportFileKind(null)).toBe('collection');
    });

    it("is the type a row's own file names", () => {
        expect(exportFileKind({ type: 'vectfox-story-links', events: [] })).toBe('vectfox-story-links');
        expect(exportFileKind({ type: 'vectfox-lorebase-keys', entries: [] })).toBe('vectfox-lorebase-keys');
        expect(exportFileKind({ type: 'vectfox-lorebase-vectors', points: [] })).toBe('vectfox-lorebase-vectors');
    });
});

describe('the header every file opens with', () => {
    it('names the format version, when it was made and that VectFox made it', () => {
        const header = exportFileHeader();
        expect(header).toEqual({ version: '1.0.0', exportDate: expect.any(String), generator: 'VectFox' });
        expect(Number.isNaN(Date.parse(header.exportDate))).toBe(false);
    });
});
