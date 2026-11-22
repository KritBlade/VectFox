/**
 * @vitest-environment jsdom
 *
 * VectFox's row in SillyTavern's wand menu (src/features/settings-panel/wand-menu.js and src/sillytavern/wand-menu.js):
 * it goes into the menu SillyTavern built, at its end with the other ranked row, MVU Helper's, in rank order, its two
 * options rows of the menu itself, folded; clicking it opens or folds
 * Menu and Last reply's lore under it without the click reaching the page, where SillyTavern would close the menu; Menu
 * opens VectFox's panel, Last reply's lore the latest reply's lorebook entries; a click elsewhere folds the two rows;
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
const { addWandMenuRow } = await import('../src/sillytavern/wand-menu.js');

const $id = id => document.getElementById(id);
const option = name => document.querySelector(`[data-vectfox-wand="${name}"]`);
const optionRows = () => [...document.querySelectorAll('#VectFox_wand > .vfx-wand-option')];

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="extensionsMenu"><div id="gallery_wand_container" class="extension_container"></div></div>';
});

const menuOrder = () => [...$id('extensionsMenu').children].map(child => child.id);

describe("VectFox's row in the wand menu", () => {
    it("ends the menu with the ranked rows in rank order, MVU Helper's 90 then VectFox's 91, below the rows other extensions added", () => {
        $id('extensionsMenu').innerHTML = '<div id="gallery_wand_container" class="extension_container"></div>'
            + '<div id="mvuh_wand_button" class="list-group-item" data-wand-menu-rank="90"></div>'
            + '<div id="other_extension_row" class="list-group-item"></div>'
            + '<div id="higher_ranked_row" class="list-group-item" data-wand-menu-rank="95"></div>'
            + '<div id="later_extension_row" class="list-group-item"></div>';
        const mvuHelperClicked = vi.fn();
        $id('mvuh_wand_button').addEventListener('click', mvuHelperClicked);
        mountWandMenu();
        expect(menuOrder()).toEqual(['gallery_wand_container', 'other_extension_row', 'later_extension_row', 'mvuh_wand_button', 'VectFox_wand', 'higher_ranked_row']);
        expect($id('VectFox_wand').dataset.wandMenuRank).toBe('91');
        $id('mvuh_wand_button').click();
        expect(mvuHelperClicked).toHaveBeenCalledTimes(1);
    });

    it('keeps a row of the same rank that comes later below it, and puts one ranked lower that comes later above it', () => {
        mountWandMenu();
        const row = id => Object.assign(document.createElement('div'), { id });
        addWandMenuRow(row('same_rank_row'), 91);
        addWandMenuRow(row('mvuh_wand_button'), 90);
        expect(menuOrder()).toEqual(['gallery_wand_container', 'mvuh_wand_button', 'VectFox_wand', 'same_rank_row']);
    });

    it('goes into the wand menu with its two options folded, each a row of the menu itself, as SillyTavern stacks its own', () => {
        mountWandMenu();
        expect(menuOrder()).toEqual(['gallery_wand_container', 'VectFox_wand']);
        expect($id('VectFox_wand_toggle').textContent).toContain('VectFox');
        expect([...$id('VectFox_wand').children].map(row => row.id || row.dataset.vectfoxWand))
            .toEqual(['VectFox_wand_toggle', 'menu', 'last-reply-lore']);
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);
    });

    it("opens Menu and Last reply's lore under it and folds them again, keeping its clicks from the page, where SillyTavern closes the menu", () => {
        mountWandMenu();
        const reachedPage = vi.fn();
        document.documentElement.addEventListener('click', reachedPage);
        $id('VectFox_wand_toggle').click();
        expect(optionRows().map(row => row.hidden)).toEqual([false, false]);
        expect($id('VectFox_wand_toggle').getAttribute('aria-expanded')).toBe('true');
        expect(optionRows().map(row => row.textContent.trim())).toEqual(['Menu', "Last reply's lore"]);

        $id('VectFox_wand_toggle').click();
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);
        expect($id('VectFox_wand_toggle').getAttribute('aria-expanded')).toBe('false');
        expect(reachedPage).not.toHaveBeenCalled();
        document.documentElement.removeEventListener('click', reachedPage);
    });

    it("opens the panel from Menu and the latest reply's entries from Last reply's lore, folding the options again", () => {
        mountWandMenu();
        $id('VectFox_wand_toggle').click();
        option('menu').click();
        expect(openSettingsPanel).toHaveBeenCalledTimes(1);
        expect(optionRows().map(row => row.hidden)).toEqual([true, true]);

        $id('VectFox_wand_toggle').click();
        option('last-reply-lore').click();
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
