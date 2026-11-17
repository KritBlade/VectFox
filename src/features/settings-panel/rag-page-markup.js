/**
 * ============================================================================
 * RAG PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's RAG page on GUI-DNA: the context prompt and the XML tag
 * around the events VectFox injects. Every control keeps the id settings-panel.js
 * wires it by. Pure: builds strings.
 * ============================================================================
 */

import { detail, field, fieldLabel, hint, input, textarea } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader } from '../../shared/gui-dna/panel-page-genes.js';

function memoryWrapperCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-quote-left', title: 'Memory wrapper', description: 'Text around the events VectFox injects. Core → Injection sets where.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Context prompt', forId: 'VectFox_rag_context', hasHelp: true }),
                textarea({ id: 'VectFox_rag_context', rows: 3 }),
                hint({ text: 'Goes before the events. Macros such as {{user}} and {{char}} work.' }),
                detail({ text: 'For example: The following may be relevant to your conversation with {{user}}. Empty adds nothing.' }),
            ], { isSpan: true })}
            ${field([
                fieldLabel({ text: 'XML tag', forId: 'VectFox_rag_xml_tag', hasHelp: true }),
                input({ id: 'VectFox_rag_xml_tag', placeholder: 'No tag', isCode: true }),
                hint({ text: 'Wraps the events in <tag>…</tag>. Empty sends them unwrapped.' }),
                detail({ text: 'Only letters, digits, _ and - are kept.' }),
            ])}
        </div>
    </section>`;
}

/**
 * The RAG page's card: Memory wrapper.
 *
 * @returns {string}
 */
export function ragPageMarkup() {
    return memoryWrapperCard();
}
