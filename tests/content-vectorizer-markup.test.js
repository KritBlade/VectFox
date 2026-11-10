/**
 * @vitest-environment jsdom
 *
 * Vectorize Content's markup (src/features/chunkbase/content-vectorizer-markup.js): a rail of the content types in two
 * groups and a page for each, side by side with ids of their own, each with the cards its type uses.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import { contentVectorizerMarkup, cvId, loadedSourceMarkup, reformatMarkup, wikiPluginMarkup } from '../src/features/chunkbase/content-vectorizer-markup.js';

const VIEW = { chat: { messageCount: 2400, characterName: 'Harbor Keeper', chatId: 'abc-123' }, characterName: 'Harbor Keeper', cleaningPresets: [{ id: 'light', name: 'Light', description: 'Strips markup.' }], cleaningPreset: 'light' };

function parse(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    return template.content;
}

const dialog = parse(contentVectorizerMarkup({ activeTypeId: 'lorebook', view: VIEW }));
const has = (typeId, name) => Boolean(dialog.querySelector(`#${cvId(typeId, name)}`));

describe('the dialog', () => {
    it('lists the seven types in two groups and shows only the active page', () => {
        expect([...dialog.querySelectorAll('.vfx-nav-group')].map(group => group.textContent)).toEqual(['From SillyTavern', 'From outside']);
        expect(dialog.querySelectorAll('.vfx-nav-item')).toHaveLength(7);
        expect([...dialog.querySelectorAll('.vfx-page')].filter(page => page.style.display !== 'none').map(page => page.dataset.cvType)).toEqual(['lorebook']);
        expect(dialog.querySelector('.vfx-nav-item.is-active').id).toBe('vectfox_cv_tab_lorebook');
    });

    it('gives every control an id of its own across the pages', () => {
        const ids = [...dialog.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const label of dialog.querySelectorAll('label[for]')) expect(dialog.querySelector(`#${label.htmlFor}`)).not.toBeNull();
    });

    it('gives each type its cards: a chat its windows and Resume, a lorebook its disabled-entries switch', () => {
        expect(has('chat', 'window_size') && has('chat', 'parallel_windows') && has('chat', 'start_from')).toBe(true);
        expect(has('chat', 'strategy')).toBe(false);
        expect(dialog.querySelector(`#vectfox_cv_page_chat [data-cv-action="resume"]`)).not.toBeNull();
        expect(dialog.querySelector(`#vectfox_cv_page_chat [data-cv-action="preview"]`)).toBeNull();
        expect(has('lorebook', 'include_disabled')).toBe(true);
        expect(has('document', 'include_disabled')).toBe(false);
        expect(dialog.querySelectorAll('[data-cv-field]')).toHaveLength(8);
        expect(['document', 'url', 'wiki'].every(typeId => has(typeId, 'reformat_card'))).toBe(true);
        expect(['chat', 'lorebook', 'character', 'youtube'].some(typeId => has(typeId, 'reformat_card'))).toBe(false);
        expect(dialog.querySelector('#vectfox_cv_page_chat').textContent).toContain('Messages: 2,400');
    });
});

describe('painted parts', () => {
    it('says a wiki\'s plugin is ready, or links to it when missing', () => {
        expect(parse(wikiPluginMarkup({ isAvailable: true, wikiName: 'Fandom', pluginUrl: 'u' })).textContent).toContain('Fandom scraper ready');
        const missing = parse(wikiPluginMarkup({ isAvailable: false, wikiName: 'Fandom', pluginUrl: 'https://example.com/plugin' }));
        expect(missing.querySelector('a').href).toBe('https://example.com/plugin');
    });

    it('shows a loaded source\'s pills or why it failed, and Auto-Reformat\'s states', () => {
        expect(parse(loadedSourceMarkup({ state: 'done', lines: [{ text: 'Pages', name: '3' }] })).textContent).toBe('Pages: 3');
        expect(parse(loadedSourceMarkup({ state: 'failed', reason: 'Forbidden' })).textContent).toContain('Forbidden');
        expect(parse(reformatMarkup({ state: 'accepted', entryCount: 12 })).querySelector('[data-cv-action="reformat-discard"]')).not.toBeNull();
        expect(parse(reformatMarkup({ state: 'idle' })).querySelector('[data-cv-action="reformat"]')).not.toBeNull();
    });
});
