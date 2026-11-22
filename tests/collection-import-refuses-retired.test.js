/**
 * An import refuses a collection from a source Vectorize Content no longer reads (validateImportData in
 * src/features/collections/collection-export.js, §4.5 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): an export of a character card's, a
 * document's, a web page's, a wiki's or a YouTube transcript's collection, known by its ID or by the type the export
 * carries, gives an error, so the Database Browser imports nothing from the file; an EventBase export gives none.
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

const { validateImportData } = await import('../src/features/collections/collection-export.js');

const SETTINGS = { vector_backend: 'qdrant', embedding_provider: 'openrouter' };
const REFUSAL = 'Vectorize Content no longer reads character cards, documents, web pages, wikis or YouTube, so VectFox does not import their collections.';

/** One collection's export file, as exportCollection writes it, without vectors. */
const exportOf = collection => ({
    version: '1.0.0',
    embedding: { source: 'openrouter', model: 'baai/bge-m3', backend: 'qdrant', dimension: null, hasVectors: false },
    collection: { name: 'Harbor', ...collection },
    settings: {},
    chunks: [{ hash: 52001, index: 0, text: 'Keeper Orrin trims the lamp.', metadata: {} }],
});

describe('importing a collection from a retired source', () => {
    it('refuses a character card\'s or a document\'s collection by its ID', () => {
        for (const id of ['vf_character_qdrant_wren_keeper_orrin_1700000000000', 'vf_document_qdrant_wren_tide_tables_1700000000000']) {
            const validation = validateImportData(exportOf({ id }), SETTINGS);
            expect(validation.valid, id).toBe(false);
            expect(validation.errors, id).toEqual([`${id}: ${REFUSAL}`]);
        }
    });

    it('refuses a collection whose export carries the type of a retired source', () => {
        for (const contentType of ['character', 'persona', 'document', 'url', 'wiki', 'youtube', 'file']) {
            const validation = validateImportData(exportOf({ id: 'harbor_notes', contentType }), SETTINGS);
            expect(validation.valid, contentType).toBe(false);
            expect(validation.errors, contentType).toEqual([`harbor_notes: ${REFUSAL}`]);
        }
    });

    it('refuses a file of several collections when one of them is from a retired source', () => {
        const file = {
            version: '1.0.0',
            type: 'multi',
            collections: [exportOf({ id: 'vf_eventbase_qdrant_wren_harbor_1', contentType: 'chat' }), exportOf({ id: 'vf_document_wren_tide_tables_1690000000000', contentType: 'document' })],
        };
        const validation = validateImportData(file, SETTINGS);
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual([`vf_document_wren_tide_tables_1690000000000: ${REFUSAL}`]);
    });

    it('takes an EventBase export', () => {
        const validation = validateImportData(exportOf({ id: 'vf_eventbase_qdrant_wren_harbor_1', contentType: 'chat' }), SETTINGS);
        expect(validation).toMatchObject({ valid: true, errors: [], warnings: [] });
    });
});
