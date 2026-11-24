/**
 * @vitest-environment jsdom
 *
 * Vectorize Content's markup (src/features/eventbase/content-vectorizer-markup.js): a rail holding the Chat row under
 * From SillyTavern and the Chat page, its controls with ids of their own, its cards in order (Source, Windows with
 * EventBase's window sliders, Options with Text cleaning alone, Vectorize), a Source card that offers a chat file when
 * no chat is open, and the parts the wiring paints.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import {
    CHAT_TYPE_ID,
    VECTORIZER_ROOT_ID,
    contentVectorizerMarkup,
    currentChatMarkup,
    cvId,
    cvPageId,
    cvTabId,
    loadedSourceMarkup,
} from '../src/features/eventbase/content-vectorizer-markup.js';

const CHAT = { messageCount: 2400, characterName: 'Harbor Keeper', chatId: 'abc-123' };
const VIEW = { chat: CHAT, cleaningPresets: [{ id: 'light', name: 'Light', description: 'Strips markup.' }, { id: 'custom', name: 'Custom', description: 'Your own patterns.' }], cleaningPreset: 'light', cleaningNote: 'Strips markup.' };

function parse(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    return template.content;
}

const dialog = parse(contentVectorizerMarkup({ view: VIEW }));
const control = name => dialog.querySelector(`#${cvId(CHAT_TYPE_ID, name)}`);
const part = (root, name) => root.querySelector(`[data-cv-part="${name}"]`);

describe('the dialog', () => {
    it('shows the Chat row alone under From SillyTavern, active, beside the Chat page', () => {
        expect(dialog.firstElementChild.id).toBe(VECTORIZER_ROOT_ID);
        expect([...dialog.querySelectorAll('.vfx-nav-group')].map(group => group.textContent)).toEqual(['From SillyTavern']);
        expect([...dialog.querySelectorAll('.vfx-nav-item')].map(item => item.id)).toEqual([cvTabId(CHAT_TYPE_ID)]);
        expect(dialog.querySelector('.vfx-nav-item.is-active').id).toBe('vectfox_cv_tab_chat');
        expect([...dialog.querySelectorAll('.vfx-page')].map(page => [page.id, page.dataset.cvType])).toEqual([[cvPageId(CHAT_TYPE_ID), 'chat']]);
    });

    it('gives every control an id of its own, and every label a control', () => {
        const ids = [...dialog.querySelectorAll('[id]')].map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const label of dialog.querySelectorAll('label[for]')) expect(dialog.querySelector(`#${label.htmlFor}`)).not.toBeNull();
    });

    it('draws the Source, Windows, Options and Vectorize cards in order, with no ChunkBase control', () => {
        expect([...dialog.querySelectorAll('.vfx-card')].map(card => card.id))
            .toEqual(['source_card', 'windows_card', 'options_card', 'run_card'].map(name => cvId(CHAT_TYPE_ID, name)));
        expect([...dialog.querySelectorAll('.vfx-card-title')].map(title => title.textContent)).toEqual(['Source', 'Windows', 'Options', 'Vectorize']);
        expect([...control('windows_card').querySelectorAll('input[type="number"]')].map(box => box.id))
            .toEqual(['parallel_windows', 'window_size', 'window_overlap'].map(name => cvId(CHAT_TYPE_ID, name)));
        expect(control('start_from')).not.toBeNull();
        expect(control('strategy')).toBeNull();
        expect(dialog.querySelector('[data-cv-action="preview"]')).toBeNull();
        expect(dialog.querySelector('[id$="_include_disabled"]')).toBeNull();
        expect(dialog.querySelectorAll('[data-cv-field]')).toHaveLength(0);
        expect(control('reformat_card')).toBeNull();
    });

    it('holds Text cleaning alone in the Options card, its chosen preset shown with its description', () => {
        const options = control('options_card');
        expect([...options.querySelectorAll('select, input, textarea')].map(element => element.id)).toEqual([cvId(CHAT_TYPE_ID, 'cleaning_preset')]);
        expect(control('cleaning_preset').value).toBe('light');
        expect(options.querySelector('[data-cv-hint="cleaning-note"]').textContent).toBe('Strips markup.');
        expect(options.querySelector('[data-cv-action="manage-cleaning"]')).not.toBeNull();
    });

    it('reads the open chat by default, with Resume and Vectorize, and Stop hidden until a run starts', () => {
        expect(control('source_choice').value).toBe('this');
        expect(part(dialog, 'this').hidden).toBe(false);
        expect(part(dialog, 'file').hidden).toBe(true);
        expect(part(dialog, 'this').textContent).toContain('Messages: 2,400');
        expect(['resume', 'vectorize'].every(name => dialog.querySelector(`[data-cv-action="${name}"]`))).toBe(true);
        expect(part(dialog, 'stop').hidden).toBe(true);
    });

    it('offers a chat file when no chat is open, naming the files it takes', () => {
        const noChat = parse(contentVectorizerMarkup({ view: { ...VIEW, chat: null } }));
        expect(noChat.querySelector(`#${cvId(CHAT_TYPE_ID, 'source_choice')}`).value).toBe('file');
        expect(part(noChat, 'this').hidden).toBe(true);
        expect(part(noChat, 'this').textContent).toContain('No chat is open.');
        expect(part(noChat, 'file').hidden).toBe(false);
        expect(part(noChat, 'file').querySelector('[data-cv-action="choose-file"]')).not.toBeNull();
        expect(part(noChat, 'file').querySelector('.vfx-code').textContent).toBe('.txt .jsonl .json');
    });
});

describe('painted parts', () => {
    it('shows the open chat\'s messages, character and ID', () => {
        const chat = parse(currentChatMarkup(CHAT));
        expect(chat.textContent).toContain('Messages: 2,400');
        expect(chat.textContent).toContain('Character: Harbor Keeper');
        expect(chat.querySelector('.vfx-code').textContent).toBe('abc-123');
    });

    it('shows a loaded chat file\'s pills, the file being read, or why it failed', () => {
        expect(parse(loadedSourceMarkup({ state: 'done', lines: [{ text: 'Messages', name: '3' }] })).textContent).toBe('Messages: 3');
        expect(parse(loadedSourceMarkup({ state: 'busy', busyText: 'Reading harbor.jsonl…' })).textContent).toBe('Reading harbor.jsonl…');
        expect(parse(loadedSourceMarkup({ state: 'failed', reason: 'It holds no messages.' })).textContent).toContain('It holds no messages.');
    });
});
