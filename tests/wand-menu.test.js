/**
 * @vitest-environment jsdom
 *
 * VectFox's row in SillyTavern's wand menu (src/features/settings-panel/wand-menu.js and src/sillytavern/wand-menu.js):
 * it goes into the menu SillyTavern built, its two options rows of the menu itself, folded; clicking it opens or folds
 * Menu and Selected lorebook under it without the click reaching the page, where SillyTavern would close the menu; Menu
 * opens VectFox's panel, Selected lorebook the latest reply's lorebook entries; a click elsewhere folds the two rows;
 * and with no wand menu, the console says so.
 */
/* global document -- this file runs under the jsdom environment */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../src/features/settings-panel/panel-shell.js', () => ({ openSettingsPanel: vi.fn(async () => {}) }));
vi.mock('../src/features/reply-lore/index.js', () => ({ openReplyLore: vi.fn(async () => {}) }));

const { log } = await import('../src/sillytavern/log.js');
const { openSettingsPanel } = await import('../src/features/settings-panel/panel-shell.js');
const { openReplyLore } = await import('../src/features/reply-lore/index.js');
const { mountWandMenu } = await import('../src/features/settings-panel/wand-menu.js');

const $id = id => document.getElementById(id);
const option = name => document.querySelector(`[data-vectfox-wand="${name}"]`);
const optionRows = () => [...document.querySelectorAll('#VectFox_wand > .vfx-wand-option')];

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="extensionsMenu"><div id="gallery_wand_container" class="extension_container"></div></div>';
});

describe("VectFox's row in the wand menu", () => {
    it('goes into the wand menu with its two options folded, each a row of the menu itself, as SillyTavern stacks its own', () => {
        mountWandMenu();
        expect($id('extensionsMenu').lastElementChild.id).toBe('VectFox_wand');
        expect($id('VectFox_wand_toggle').textContent).toContain('VectFox');
        expect([...$id('VectFox_wand').children].map(row => row.id || row.dataset.vectfoxWand))
            .toEqual(['VectFox_wand_toggle', 'menu', 'selected-lorebook']);
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);
    });

    it('opens Menu and Selected lorebook under it and folds them again, keeping its clicks from the page, where SillyTavern closes the menu', () => {
        mountWandMenu();
        const reachedPage = vi.fn();
        document.documentElement.addEventListener('click', reachedPage);
        $id('VectFox_wand_toggle').click();
        expect(optionRows().map(row => row.hidden)).toEqual([false, false]);
        expect($id('VectFox_wand_toggle').getAttribute('aria-expanded')).toBe('true');
        expect(optionRows().map(row => row.textContent.trim())).toEqual(['Menu', 'Selected lorebook']);

        $id('VectFox_wand_toggle').click();
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);
        expect($id('VectFox_wand_toggle').getAttribute('aria-expanded')).toBe('false');
        expect(reachedPage).not.toHaveBeenCalled();
        document.documentElement.removeEventListener('click', reachedPage);
    });

    it('opens the panel from Menu and the latest reply\'s entries from Selected lorebook, folding the options again', () => {
        mountWandMenu();
        $id('VectFox_wand_toggle').click();
        option('menu').click();
        expect(openSettingsPanel).toHaveBeenCalledTimes(1);
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);

        $id('VectFox_wand_toggle').click();
        option('selected-lorebook').click();
        expect(openReplyLore).toHaveBeenCalledTimes(1);
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);
    });

    it('says in the console when SillyTavern has no wand menu, and adds nothing', () => {
        document.body.innerHTML = '';
        mountWandMenu();
        expect($id('VectFox_wand')).toBeNull();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('wand menu'));
    });
});
