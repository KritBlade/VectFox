/**
 * ============================================================================
 * API KEY BOXES, STATIC MARKUP
 * ============================================================================
 * The key box and its delete button, for the settings pages that save a key to
 * SillyTavern's secret store: Core and AgentMode. Pure: builds strings.
 * ============================================================================
 */

/** A key box: masked, never filled by the browser, its saved key shown only in its placeholder. */
export function keyInput({ id, placeholder }) {
    return `<input type="password" id="${id}" class="vfx-input" placeholder="${placeholder}" autocomplete="off">`;
}

/** The icon button that deletes a saved key, after a confirm (settings-panel.js clearSharedApiKey). */
export function clearKeyButton(id) {
    return `<button type="button" id="${id}" class="vfx-btn vfx-btn-icon vfx-btn-danger" title="Delete saved key"><i class="fa-solid fa-trash-can"></i></button>`;
}
