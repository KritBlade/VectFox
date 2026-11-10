/**
 * @vitest-environment jsdom
 *
 * Vectorize Content's wiring (src/features/chunkbase/content-vectorizer.js), driven as a user would: the rail shows one
 * type's page and each page keeps what was typed on it; a run says on its page what it needs; a fetch carries
 * SillyTavern's CSRF token, which the old dialog left out so every fetch got a 403; the Character fields and the
 * Lorebook's Include disabled entries, which nothing read, reach the run; a chat's Vectorize asks before reading again;
 * the close is announced once, after any run.
 */
/* global document, window -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    answer: true,
    dialogs: [],
    root: { vectfox: {} },
    context: {},
    fetched: [],
    priorWindows: false,
}));

vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: host.root, saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { error: vi.fn(), warn: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn() } }));
vi.mock('../src/sillytavern/world-info.js', () => ({
    world_names: ['Harbor <Lore>', 'Tides'],
    loadWorldInfo: vi.fn(async () => ({ entries: { 0: { content: 'Gate' }, 1: { content: 'Tide', disable: true } } })),
}));
vi.mock('../src/sillytavern/identifiers.js', () => ({ getStringHash: text => text.length }));
vi.mock('../src/sillytavern/popup.js', () => ({
    // A dialog is on the page while open; closing asks its canClose, as SillyTavern's Close does.
    openPanelPopup: vi.fn((root, { canClose } = {}) => {
        document.body.append(root);
        return new Promise((resolve) => { host.dialogs.push({ root, canClose, resolve }); });
    }),
    closePanelPopup: vi.fn(async (root) => {
        const dialog = host.dialogs.find(each => each.root === root);
        if (!dialog || (dialog.canClose && !(await dialog.canClose()))) return;
        host.dialogs.splice(host.dialogs.indexOf(dialog), 1);
        root.remove();
        dialog.resolve();
    }),
    confirmPopup: vi.fn(async () => host.answer),
    noticePopup: vi.fn(async () => {}),
}));
vi.mock('../src/features/chunkbase/chat-vectorization.js', () => ({ getChatUUID: () => 'chat-uuid', vectorizeAll: vi.fn(async () => {}) }));
vi.mock('../src/features/chunkbase/content-vectorization.js', () => ({
    resolveEffectiveSettings: settings => ({ ...settings }),
    vectorizeContent: vi.fn(async () => ({ chunkCount: 3 })),
    resolveAndPrepareContent: vi.fn(async (typeId, source) => ({ text: String(source.content || '') })),
}));
vi.mock('../src/features/chunkbase/chunking.js', () => ({ chunkText: vi.fn(async text => (Array.isArray(text) ? text : [text])) }));
vi.mock('../src/features/llm-provider/index.js', () => ({ validateLLMConfig: () => ({ ok: true }), resolveInheritedConnection: () => ({ provider: 'openrouter', model: 'm' }) }));
vi.mock('../src/shared/api-keys.js', () => ({ getOpenRouterApiKey: () => '' }));
vi.mock('../src/shared/collection-ids.js', () => ({ buildArchiveEventCollectionId: () => 'vf_archive' }));
vi.mock('../src/features/text-cleaning/index.js', () => ({
    CLEANING_PRESETS: { light: { id: 'light', name: 'Light', description: 'Strips markup.' } },
    getCleaningSettings: () => ({ selectedPreset: 'light' }),
    saveCleaningSettings: vi.fn(),
    openTextCleaningModal: vi.fn(),
}));
vi.mock('../src/shared/progress-tracker.js', () => ({ progressTracker: { setCancelHandler: vi.fn(), clearCancelHandler: vi.fn(), show: vi.fn(), complete: vi.fn() } }));
vi.mock('../src/shared/model-config-notifier.js', () => ({ isInvalidModelConfigError: () => false, notifyInvalidModel: vi.fn() }));
vi.mock('../src/shared/pick-files.js', () => ({ pickFiles: vi.fn(async () => []) }));
vi.mock('../src/features/eventbase/index.js', () => ({
    getVectorizationTip: () => (host.priorWindows ? 120 : undefined),
    prepareForFreshExtraction: vi.fn(async () => ({ skipTipFallback: true })),
    checkWindowSizeChanged: () => ({ changed: false }),
    setLastUsedWindowSize: vi.fn(),
    runEventBaseIngestion: vi.fn(),
    countUnfinishedWindows: () => 0,
    notifyUnfinishedWindows: vi.fn(),
}));

const { openContentVectorizer, backfillCurrentChatWithProgress } = await import('../src/features/chunkbase/content-vectorizer.js');
const { vectorizeContent } = await import('../src/features/chunkbase/content-vectorization.js');
const { vectorizeAll } = await import('../src/features/chunkbase/chat-vectorization.js');
const { confirmPopup, closePanelPopup } = await import('../src/sillytavern/popup.js');
const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');

const $id = id => document.getElementById(id);
const page = typeId => $id(`vectfox_cv_page_${typeId}`);
const actionOn = (typeId, name) => page(typeId).querySelector(`[data-cv-action="${name}"]`);
const runState = typeId => page(typeId).querySelector('[data-cv-hint="run-state"]').textContent;
const change = (element, value) => {
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
};
const closed = [];

async function closeEveryDialog() {
    for (const dialog of [...host.dialogs]) await closePanelPopup(dialog.root);
    await vi.waitFor(() => expect(host.dialogs).toHaveLength(0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(async () => {
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
    window.matchMedia = () => ({ matches: false });
    await closeEveryDialog();
    document.body.innerHTML = '';
    closed.length = 0;
    host.answer = true;
    host.priorWindows = false;
    host.root.vectfox = { eventbase_window_size: 4, eventbase_window_overlap: 1 };
    host.context = {
        chatId: 'chat.jsonl',
        chat: [{ mes: 'Open the gate.' }, { mes: 'It opens.' }],
        name2: 'Harbor Keeper',
        characterId: 0,
        characters: [{ avatar: 'keeper.png', name: 'Harbor Keeper', description: 'Old.' }, { avatar: 'gull.png', name: 'Gull' }],
    };
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        host.fetched.push({ url, init });
        if (url === '/api/search/visit') return { ok: true, text: async () => '<html><head><title>Docks</title></head><body><p>The docks are busy at dawn, every boat unloading its catch.</p></body></html>' };
        return { ok: false, status: 404, text: async () => 'Not found' };
    }));
    host.fetched = [];
});

document.addEventListener('vectfox:content-vectorizer-closed', () => closed.push('closed'));

describe('the rail', () => {
    it('opens on Chat while a chat is open, shows another type\'s page, and each page keeps what was typed on it', async () => {
        openContentVectorizer();
        expect(page('chat').style.display).toBe('');
        expect(page('chat').querySelector('[data-cv-part="this"]').textContent).toContain('Harbor Keeper');
        expect($id('vectfox_cv_chat_window_size').value).toBe('4');

        $id('vectfox_cv_tab_document').click();
        expect(page('document').style.display).toBe('');
        expect(page('chat').style.display).toBe('none');
        $id('vectfox_cv_document_paste_text').value = 'The harbor wakes at dawn.';
        $id('vectfox_cv_tab_url').click();
        $id('vectfox_cv_tab_document').click();
        expect($id('vectfox_cv_document_paste_text').value).toBe('The harbor wakes at dawn.');
    });

    it('lists the lorebooks, names as written, and shows what the chosen one holds', async () => {
        openContentVectorizer('lorebook');
        const select = $id('vectfox_cv_lorebook_source_select');
        await vi.waitFor(() => expect(select.options.length).toBe(3));
        expect(select.options[1].textContent).toBe('Harbor <Lore>');
        change(select, 'Tides');
        await vi.waitFor(() => expect(page('lorebook').querySelector('[data-cv-region="stats"]').textContent).toContain('Enabled: 1'));
    });

    it('pins the open character first', async () => {
        openContentVectorizer('character');
        const select = $id('vectfox_cv_character_source_select');
        await vi.waitFor(() => expect(select.value).toBe('keeper.png'));
        expect(select.options[1].textContent).toBe('Harbor Keeper (open now)');
    });
});

describe('a run', () => {
    it('says on its page what it needs, and runs nothing', async () => {
        openContentVectorizer('document');
        actionOn('document', 'vectorize').click();
        await vi.waitFor(() => expect(runState('document')).toBe('Paste the text first.'));
        expect(vectorizeContent).not.toHaveBeenCalled();
    });

    // Every POST to SillyTavern needs its CSRF token, and its visit route returns the page's HTML.
    it('fetches a web page with SillyTavern\'s token, reads its text, and vectorizes it', async () => {
        openContentVectorizer('url');
        $id('vectfox_cv_url_url_input').value = 'https://example.com/docks';
        actionOn('url', 'fetch').click();
        await vi.waitFor(() => expect(page('url').querySelector('[data-cv-region="fetched"]').textContent).toContain('Page: Docks'));
        expect(host.fetched[0].url).toBe('/api/search/visit');
        expect(host.fetched[0].init.headers['X-CSRF-Token']).toBe('token');

        actionOn('url', 'vectorize').click();
        await vi.waitFor(() => expect(vectorizeContent).toHaveBeenCalledTimes(1));
        expect(vectorizeContent.mock.calls[0][0]).toMatchObject({ contentType: 'url', source: { type: 'url', title: 'Docks' } });
        expect(vectorizeContent.mock.calls[0][0].source.content).toContain('every boat unloading its catch');
    });

    it('carries the Character fields and the Lorebook\'s Include disabled entries into the run', async () => {
        openContentVectorizer('character');
        await vi.waitFor(() => expect($id('vectfox_cv_character_source_select').value).toBe('keeper.png'));
        const scenario = page('character').querySelectorAll('[data-cv-field]');
        const field = [...scenario].find(box => box.dataset.cvField === 'creator_notes');
        change(field, true);
        actionOn('character', 'vectorize').click();
        await vi.waitFor(() => expect(vectorizeContent).toHaveBeenCalledTimes(1));
        expect(vectorizeContent.mock.calls[0][0].settings.fields.creator_notes).toBe(true);

        await closeEveryDialog();
        openContentVectorizer('lorebook');
        const select = $id('vectfox_cv_lorebook_source_select');
        await vi.waitFor(() => expect(select.options.length).toBe(3));
        change(select, 'Tides');
        change($id('vectfox_cv_lorebook_include_disabled'), true);
        actionOn('lorebook', 'vectorize').click();
        await vi.waitFor(() => expect(vectorizeContent).toHaveBeenCalledTimes(2));
        expect(vectorizeContent.mock.calls[1][0].settings.includeDisabled).toBe(true);
    });

    it('saves a chat\'s window size as VectFox\'s setting', async () => {
        openContentVectorizer('chat');
        change($id('vectfox_cv_chat_window_size'), '6');
        expect(host.root.vectfox.eventbase_window_size).toBe(6);
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });
});

describe('a chat\'s Vectorize', () => {
    it('asks before reading a chat EventBase has read, and Cancel runs nothing', async () => {
        host.priorWindows = true;
        host.answer = false;
        openContentVectorizer('chat');
        actionOn('chat', 'vectorize').click();
        await vi.waitFor(() => expect(confirmPopup).toHaveBeenCalledTimes(1));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(vectorizeAll).not.toHaveBeenCalled();
        expect(host.dialogs).toHaveLength(1);
    });

    it('reads it again on Read again, then closes, announcing the close once the run is over', async () => {
        host.priorWindows = true;
        openContentVectorizer('chat');
        actionOn('chat', 'vectorize').click();
        await vi.waitFor(() => expect(vectorizeAll).toHaveBeenCalledTimes(1));
        expect(vectorizeAll.mock.calls[0][3]).toMatchObject({ startFromMessage: 1, parallelWindows: 3, skipTipFallback: true });
        await vi.waitFor(() => expect(host.dialogs).toHaveLength(0));
        await vi.waitFor(() => expect(closed).toEqual(['closed']));
    });

    it('closes without a run with one announcement', async () => {
        openContentVectorizer('chat');
        await closeEveryDialog();
        expect(closed).toEqual(['closed']);
    });
});

describe('the auto-sync catch-up', () => {
    it('reads the open chat\'s new messages with no dialog, and announces no close', async () => {
        expect(await backfillCurrentChatWithProgress()).toEqual({ ran: true });
        expect(vectorizeAll.mock.calls[0][3]).toMatchObject({ startFromMessage: 1, parallelWindows: 1, skipTipFallback: false });
        expect(closed).toEqual([]);
    });
});
