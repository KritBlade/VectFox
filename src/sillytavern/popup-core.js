// sillytavern/popup-core.js — the parts of the dialog door that need no SillyTavern import: a dialog's text as lines
// (what each line shows; popup.js renders the segments), and whether a modal VectFox placed on a dialog is open on it.
// tests/popup-core.test.js holds both to their shapes.
//
// A LINE is one of:
//   { text }          a fixed sentence, keyed with its English source;
//   { name }          a value shown as written: a name, an id, a version, a path;
//   { text, name }    a keyed lead-in, then the value;
//   { parts: [...] }  segments in order, each { text } or { name }, for a line that mixes fixed words and values.
// Any of them may lead with `icon`, a Font Awesome solid icon's class (`fa-circle-exclamation`); a danger dialog,
// which asks a safety question, draws it red (settings-panel.css). A line with nothing else to show shows no icon.
// A fixed word is never built from a value, so the locale pass can translate it; a value is never translated.

const isShown = (value) => value !== undefined && value !== null && String(value) !== '';
const ICON_CLASS = /^fa-[a-z0-9-]+$/;

/**
 * The segments a line shows, in order: { icon } for its leading icon, { key } for a fixed word, { value, isStrong }
 * for data — strong when it is the line's own value rather than a piece of a mixed line. A line of no known shape
 * shows nothing.
 */
export function dialogLineSegments(line) {
    if (!line || typeof line !== 'object') return [];
    const segments = [];
    if (Array.isArray(line.parts)) {
        for (const part of line.parts) {
            if (part && typeof part.text === 'string' && part.text) segments.push({ key: part.text });
            else if (part && isShown(part.name)) segments.push({ value: String(part.name), isStrong: false });
        }
    } else {
        if (typeof line.text === 'string' && line.text) segments.push({ key: line.text });
        if (isShown(line.name)) {
            if (segments.length) segments.push({ value: ' ', isStrong: false });
            segments.push({ value: String(line.name), isStrong: true });
        }
    }
    if (segments.length && typeof line.icon === 'string' && ICON_CLASS.test(line.icon)) segments.unshift({ icon: line.icon });
    return segments;
}

// The modals VectFox places on an open dialog (popup.js placeOnTopmostModalLayer): the tools a panel page opens, the
// Database Browser's own dialogs and the Chunk Visualizer.
const PLACED_MODAL_SELECTOR = '.vectfox-modal, .vectfox-visualizer-modal';

/**
 * Whether a modal VectFox placed on the dialog holding `element` is shown there now. That dialog then stays open on
 * Escape or Close, so Escape closes only the modal.
 *
 * @param {HTMLElement} element - Anything inside the dialog
 * @returns {boolean}
 */
export function isModalOpenOnDialogOf(element) {
    const dialog = element?.closest('dialog');
    if (!dialog) return false;
    return [...dialog.children].some(child => child.matches(PLACED_MODAL_SELECTOR) && getComputedStyle(child).display !== 'none');
}
