/**
 * ============================================================================
 * WORLDINFO PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's WorldInfo page on GUI-DNA: semantic activation of the
 * chat's vectorized lorebooks, and how their entries are matched. Every control
 * keeps the id settings-panel.js wires it by, and the card the wiring shows and
 * hides keeps its id too. The status line under the switch is built here as
 * well. Pure: builds strings.
 * ============================================================================
 */

import { detail, field, fieldLabel, hint, resultList } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

const HIDDEN = ' style="display:none;"';

function activationCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-globe', title: 'Semantic activation', description: 'Pulls in lorebook entries by meaning, beside SillyTavern\'s keyword matching.' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: 'VectFox_enabled_world_info', title: 'Use in this chat', description: 'Needs a vectorized lorebook locked to this chat. Off unlocks the active ones.', isSpan: true })}
            <div id="VectFox_wi_status" class="vfx-span" aria-live="polite"></div>
        </div>
    </section>`;
}

function matchingCard() {
    return `<section id="VectFox_world_info_settings" class="vfx-card"${HIDDEN}>
        ${cardHeader({ icon: 'fa-sliders', title: 'Matching', description: 'How entries are matched. Action → Query Tester shows what a message pulls in.' })}
        <div class="vfx-card-body vfx-grid">
            ${field([
                fieldLabel({ text: 'Similarity threshold', forId: 'VectFox_world_info_threshold', hasHelp: true }),
                sliderNumber({ id: 'VectFox_world_info_threshold', min: 0.01, max: 1, step: 0.01, title: 'Threshold' }),
                hint({ text: 'Entries less similar to the recent chat than this stay out.' }),
                detail({ text: 'Hybrid scores run a little lower than plain similarity, so with hybrid scoring on, which is the default, 80% of this value applies.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Entries per lorebook', forId: 'VectFox_world_info_top_k' }),
                sliderNumber({ id: 'VectFox_world_info_top_k', min: 1, max: 20, step: 1, title: 'Entries' }),
                hint({ text: 'The most entries one lorebook may add per reply.' }),
            ])}
            ${field([
                fieldLabel({ text: 'Query depth', forId: 'VectFox_world_info_query_depth' }),
                sliderNumber({ id: 'VectFox_world_info_query_depth', min: 1, max: 10, step: 1, title: 'Messages' }),
                hint({ text: 'Recent messages read to find matching entries.' }),
            ])}
            ${switchRow({ id: 'VectFox_world_info_retrieval_popup', title: 'Toast on retrieval', description: 'Shows a toast each time lorebook entries are pulled in.' })}
        </div>
    </section>`;
}

/**
 * The WorldInfo page's cards: Semantic activation, and Matching, which shows while activation is on.
 *
 * @returns {string}
 */
export function worldInfoPageMarkup() {
    return activationCard() + matchingCard();
}

/**
 * Semantic activation's status for the open chat.
 *
 * @param {{state: 'no-lorebooks'|'none-active'|'active', names?: string[]}} status - `names` are the active lorebooks
 * @returns {string}
 */
export function worldInfoStatusMarkup({ state, names = [] }) {
    if (state === 'no-lorebooks') {
        return resultList({ lines: [{ status: 'warning', text: 'No lorebook vectorized yet. Vectorize Content on the Action page stores one.' }] });
    }
    if (state === 'none-active') {
        return resultList({ lines: [{ status: 'warning', text: 'No lorebook is locked to this chat. Lock one in Database Browser → Collection Settings.' }] });
    }
    return resultList({ lines: [{ status: 'success', name: `Active for this chat: ${names.join(', ')}` }] });
}
