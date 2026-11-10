/**
 * @vitest-environment jsdom
 *
 * The settings panel's RAG page on GUI-DNA (src/features/settings-panel/rag-page-markup.js): both controls keep the
 * id settings-panel.js wires them by, an empty XML tag box reads as no tag, which is what it sends, and the page is
 * drawn from GUI-DNA alone, pointing to where a collection or a chunk sets its own wrapper.
 */
/* global document -- this file runs under the jsdom environment */

import { beforeEach, describe, expect, it } from 'vitest';

const { ragPageMarkup } = await import('../src/features/settings-panel/rag-page-markup.js');

describe('RAG page markup', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="VectFox_settings">${ragPageMarkup()}</div>`;
    });

    it('keeps the context prompt a textarea and the XML tag a text box, each under its own label', () => {
        expect([...document.querySelectorAll('#VectFox_settings [id]')].map(element => element.id)).toEqual(['VectFox_rag_context', 'VectFox_rag_xml_tag']);
        expect(document.getElementById('VectFox_rag_context').tagName).toBe('TEXTAREA');
        expect(document.getElementById('VectFox_rag_xml_tag').type).toBe('text');
        for (const id of ['VectFox_rag_context', 'VectFox_rag_xml_tag']) {
            expect(document.querySelectorAll(`label[for="${id}"]`), id).toHaveLength(1);
        }
    });

    it('shows an empty XML tag box as no tag', () => {
        expect(document.getElementById('VectFox_rag_xml_tag').placeholder).toBe('No tag');
        expect(document.body.textContent).toContain('Empty sends them unwrapped.');
    });

    it('draws only GUI-DNA classes and no inline style, and names where a collection or chunk sets its own', () => {
        const classes = [...document.querySelectorAll('[class]')].flatMap(element => [...element.classList]);
        expect(classes.filter(name => !name.startsWith('vfx-') && !name.startsWith('fa-') && !name.startsWith('is-'))).toEqual([]);
        expect(document.querySelector('[style]')).toBeNull();
        expect(document.querySelector('.vfx-notice').textContent).toContain('Database Browser → Collection Settings, or Chunk Visualizer');
    });
});
