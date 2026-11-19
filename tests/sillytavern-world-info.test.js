/**
 * @vitest-environment jsdom
 *
 * Adding a lorebook through SillyTavern's own World Info controls (src/sillytavern/world-info.js, §6 of
 * InternalProject/Vectfox/plans/lorebook-multi-vector.md): to a character's Additional Lorebooks through
 * charUpdateAddAuxWorld, by the character's avatar file name; and to the global list every chat loads through the World
 * Info panel's own list, whose change handler sets the global books, as SillyTavern's does: the book goes on beside
 * those already on, whatever its name holds, and a book SillyTavern lacks, or a page without the panel, is refused.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ worldNames: [], globalBooks: [] }));

// SillyTavern's world-info.js, /scripts/world-info.js, as this folder reaches it when served beside src/.
vi.mock('../../../../world-info.js', () => ({
    METADATA_KEY: 'world_info',
    charUpdateAddAuxWorld: vi.fn(async () => {}),
    checkWorldInfo: vi.fn(),
    getSortedEntries: vi.fn(),
    getWorldInfoSettings: vi.fn(),
    loadWorldInfo: vi.fn(),
    // A live binding: SillyTavern's change handler assigns a new list.
    get selected_world_info() { return host.globalBooks; },
    world_info_include_names: true,
    world_names: host.worldNames,
}));

const { charUpdateAddAuxWorld } = await import('../../../../world-info.js');
const { addCharacterLorebook, addGlobalLorebook } = await import('../src/sillytavern/world-info.js');

let changeCount = 0;

// The World Info panel's global list as SillyTavern draws it, each option valued by its book's place in world_names,
// and its change handler, which sets the global books from the options selected.
function drawPanelList({ shownOn = host.globalBooks } = {}) {
    const options = host.worldNames.map((bookName, index) => `<option value="${index}"${shownOn.includes(bookName) ? ' selected' : ''}></option>`);
    document.body.innerHTML = `<select id="world_info" multiple>${options.join('')}</select>`;
    const list = document.getElementById('world_info');
    host.worldNames.forEach((bookName, index) => { list.options[index].textContent = bookName; });
    list.addEventListener('change', () => {
        changeCount += 1;
        host.globalBooks = [...list.selectedOptions].map(option => host.worldNames[Number(option.value)]);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    host.worldNames.splice(0, host.worldNames.length, 'Harbor Atlas', 'Tide Tables', 'Voyage, Log', 'The <b>Old</b> "Keep"');
    host.globalBooks = ['Tide Tables'];
    changeCount = 0;
});

describe('addCharacterLorebook', () => {
    it("adds the book to the character's Additional Lorebooks by the character's avatar file name", async () => {
        await addCharacterLorebook('keeper-orrin.png', 'Voyage, Log');
        expect(charUpdateAddAuxWorld).toHaveBeenCalledWith('keeper-orrin.png', 'Voyage, Log');
    });
});

describe('addGlobalLorebook', () => {
    it('turns the book on beside those already on, through one change of the panel list, whatever its name holds', () => {
        drawPanelList();
        addGlobalLorebook('Voyage, Log');
        expect(changeCount).toBe(1);
        expect(host.globalBooks).toEqual(['Tide Tables', 'Voyage, Log']);
        addGlobalLorebook('The <b>Old</b> "Keep"');
        expect(host.globalBooks).toEqual(['Tide Tables', 'Voyage, Log', 'The <b>Old</b> "Keep"']);
    });

    it('keeps every book SillyTavern has on, one its list does not show as on included', () => {
        drawPanelList({ shownOn: [] });
        addGlobalLorebook('Harbor Atlas');
        expect(host.globalBooks).toEqual(['Harbor Atlas', 'Tide Tables']);
    });

    it('refuses a book SillyTavern lacks, and a page without the panel, changing nothing', () => {
        drawPanelList();
        expect(() => addGlobalLorebook('Lost Charts')).toThrow('SillyTavern has no lorebook named "Lost Charts".');
        document.body.innerHTML = '';
        expect(() => addGlobalLorebook('Harbor Atlas')).toThrow("SillyTavern's World Info panel is not on the page.");
        expect(changeCount).toBe(0);
        expect(host.globalBooks).toEqual(['Tide Tables']);
    });
});
