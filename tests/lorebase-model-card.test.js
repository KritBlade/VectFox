/**
 * @vitest-environment jsdom
 *
 * The WorldInfo page's LoreBase model card lines (src/features/settings-panel/lorebase-model-card.js, §7.2 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): the setup notice names the first thing LoreBase lacks and
 * hides while nothing is missing; the Vectors line names VectFox's embedding model, and its button shows the Core page
 * that sets it; both are drawn again as a control on the card changes, as LoreBase's switch is saved, as SillyTavern's
 * connection profiles change, and as the page opens.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ problem: '', modelName: '', profilesListener: null, switchListener: null }));

vi.mock('../src/sillytavern/connection-profiles.js', () => ({ onConnectionProfilesChanged: listener => { host.profilesListener = listener; } }));
vi.mock('../src/features/embedding/index.js', () => ({ embeddingModelName: () => host.modelName }));
vi.mock('../src/features/lorebase/index.js', () => ({
    loreBaseSetupProblem: () => host.problem,
    onLoreBaseSwitchChange: listener => { host.switchListener = listener; },
}));
vi.mock('../src/features/settings-panel/panel-shell.js', () => ({ showPanelTab: vi.fn() }));

const { showPanelTab } = await import('../src/features/settings-panel/panel-shell.js');
const { worldInfoPageMarkup } = await import('../src/features/settings-panel/worldinfo-page-markup.js');
const { bindLoreBaseModelCard, refreshLoreBaseModelCard } = await import('../src/features/settings-panel/lorebase-model-card.js');

const SETTINGS = { vector_backend: 'qdrant' };
const setupNotice = () => document.getElementById('VectFox_lorebase_setup_notice');
const shownNotice = () => (setupNotice().hidden ? null : setupNotice().textContent.trim());
const vectorsLine = () => document.getElementById('VectFox_lorebase_vectors_model').textContent;

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="VectFox_settings">${worldInfoPageMarkup()}</div>`;
    host.problem = '';
    host.modelName = 'baai/bge-m3 at OpenRouter';
    bindLoreBaseModelCard(SETTINGS);
});

describe("LoreBase's model card lines", () => {
    it('shows no notice while nothing is missing, and names the embedding model on the Vectors line', () => {
        expect([shownNotice(), setupNotice().innerHTML]).toEqual([null, '']);
        expect(vectorsLine()).toBe("baai/bge-m3 at OpenRouter, VectFox's embedding model.");
    });

    it('names the first thing missing, drawn again as a control on the card changes or is typed in, and as the profiles change', () => {
        host.problem = 'Fast and Cheap [Jev] has no profile for Jev.';
        document.getElementById('VectFox_lorebase_accuracy').dispatchEvent(new Event('change', { bubbles: true }));
        expect(shownNotice()).toBe('Fast and Cheap [Jev] has no profile for Jev.');
        host.problem = 'LoreBase: it has no model.';
        document.getElementById('VectFox_lorebase_model').dispatchEvent(new Event('input', { bubbles: true }));
        expect(shownNotice()).toBe('LoreBase: it has no model.');
        host.problem = '';
        host.modelName = '';
        host.profilesListener();
        expect(shownNotice()).toBeNull();
        expect(vectorsLine()).toBe('No embedding model is set.');
    });

    it("draws the notice again as LoreBase's switch is saved, as its last sentence follows the switch", () => {
        host.problem = 'Fast and Cheap [Jev] has no profile for Jev. Until then the entries selected for LoreBase stay out of replies.';
        host.switchListener(true);
        expect(shownNotice()).toBe('Fast and Cheap [Jev] has no profile for Jev. Until then the entries selected for LoreBase stay out of replies.');
        host.problem = 'Fast and Cheap [Jev] has no profile for Jev.';
        host.switchListener(false);
        expect(shownNotice()).toBe('Fast and Cheap [Jev] has no profile for Jev.');
    });

    it('draws again as the page opens, from the settings as they are then', () => {
        host.problem = "LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page.";
        host.modelName = 'harbor-embed on the SillyTavern profile "Harbor Ollama"';
        refreshLoreBaseModelCard();
        expect(shownNotice()).toBe("LoreBase keeps each entry's keys and vectors in Qdrant. Choose Qdrant as the vector backend on the Core page.");
        expect(vectorsLine()).toBe('harbor-embed on the SillyTavern profile "Harbor Ollama", VectFox\'s embedding model.');
    });

    it("shows the Core page, where the embedding model is set, from the Vectors line's button", () => {
        document.getElementById('VectFox_lorebase_vectors_link').click();
        expect(showPanelTab).toHaveBeenCalledWith('core');
    });
});
