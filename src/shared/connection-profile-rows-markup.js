/**
 * ============================================================================
 * CONNECTION PROFILE ROWS, STATIC MARKUP
 * ============================================================================
 * What a chat consumer's Provider dropdown offers, and what its SillyTavern profile
 * option shows (connection plan §1): the Profile dropdown, which the settings
 * panel's wiring paints from SillyTavern's profiles, and the readout under it; the
 * readout of the profile a consumer takes from the EventBase model; and a card's
 * Test connection button. The Core, AgentMode, StoryArc and WorldInfo pages draw
 * them, each with its own id prefix, so all five read alike. Pure:
 * builds strings.
 * ============================================================================
 */

import { CONNECTION_PROFILE_PROVIDER } from './constants.js';
import { controlRow, field, fieldLabel, hint, select, selectOption } from './gui-dna/gui-dna-core.js';
import { buttonWithId } from './gui-dna/panel-page-genes.js';

const HIDDEN = ' style="display:none;"';

/**
 * A chat consumer's own Provider options: SillyTavern profile, then the manual OpenRouter and vLLM. Every chat
 * consumer's dropdown lists them from here, so the manual two retire here (connection plan D1).
 *
 * @returns {string[]} Option markup, for select()
 */
export function chatProviderOptions() {
    return [
        selectOption({ value: CONNECTION_PROFILE_PROVIDER, text: 'SillyTavern profile' }),
        selectOption({ value: 'openrouter', text: 'OpenRouter' }),
        selectOption({ value: 'vllm', text: 'vLLM' }),
    ];
}

/** The ids of one consumer's profile rows and test button, from its prefix. */
export function connectionProfileRowIds(prefix) {
    return {
        rows: `${prefix}_connection_profile_rows`,
        select: `${prefix}_connection_profile`,
        readout: `${prefix}_connection_profile_readout`,
        inheritedReadout: `${prefix}_inherited_profile_readout`,
        testButton: `${prefix}_test_connection`,
    };
}

/**
 * The Profile dropdown, its hint and the readout under it, in a block that starts hidden for the wiring to show on
 * the SillyTavern profile option. The dropdown's options are painted by the wiring.
 *
 * @param {string} prefix - The consumer's id prefix, as `VectFox_summarize`
 * @param {{hintText: string}} words
 * @returns {string}
 */
export function connectionProfileRows(prefix, { hintText }) {
    const ids = connectionProfileRowIds(prefix);
    return `<div id="${ids.rows}" class="vfx-grid vfx-span"${HIDDEN}>
        ${field([
            fieldLabel({ text: 'Profile', forId: ids.select }),
            select({ id: ids.select }),
            hint({ text: hintText }),
        ], { isSpan: true })}
        <div id="${ids.readout}" class="vfx-span"></div>
    </div>`;
}

/**
 * The readout of the profile a consumer on Same as EventBase model takes from the EventBase model, hidden until the
 * EventBase model runs on a profile.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function inheritedProfileReadout(prefix) {
    return `<div id="${connectionProfileRowIds(prefix).inheritedReadout}" class="vfx-span"${HIDDEN}></div>`;
}

/**
 * A card's Test connection button, which sends one short fixed message on the current choice.
 *
 * @param {string} prefix
 * @param {{hintText: string}} words
 * @returns {string}
 */
export function testConnectionButton(prefix, { hintText }) {
    return field([
        controlRow([buttonWithId({ id: connectionProfileRowIds(prefix).testButton, text: 'Test connection', icon: 'fa-plug' })]),
        hint({ text: hintText }),
    ], { isSpan: true });
}
