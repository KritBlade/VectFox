/**
 * ============================================================================
 * PICK FILES
 * ============================================================================
 * The one door to the browser's file picker, copied from mvu-helper's
 * shared/pick-files.js. The input is created for each pick and never joins the
 * page, as SillyTavern's own pickers do (promptForAvatarFile in its utils.js). An
 * input inside a VectFox dialog would sit in a SillyTavern popup: dismissing its
 * picker fires a `cancel` event that bubbles from the input to the popup's
 * <dialog>, the popup takes any `cancel` for Escape, and the whole dialog closes.
 * tests/file-picker-boundary.test.js refuses a file input anywhere else in src.
 * ============================================================================
 */

/**
 * Ask the user for files. Call it straight from a click handler: a browser opens a picker only during the user's
 * gesture. Resolves with the picked files, or [] when the picker is dismissed; a browser that fires no `cancel` on a
 * file input leaves the promise pending, which holds nothing.
 *
 * @param {{accept?: string, isMultiple?: boolean}} [options] - accept: the input's accept list
 * @returns {Promise<File[]>}
 */
export function pickFiles({ accept = '', isMultiple = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.multiple = isMultiple;
        input.onchange = () => resolve([...(input.files || [])]);
        input.oncancel = () => resolve([]);
        input.click();
    });
}
