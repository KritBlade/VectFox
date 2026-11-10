/**
 * Text Cleaning's rules for its dialog (text-cleaning-dialog.js), with no host imports: a pattern box holds
 * /pattern/flags, as SillyTavern's regex boxes do, or a bare pattern, which cleans case-blind everywhere.
 */

/** The flags a bare pattern takes. */
const BARE_PATTERN_FLAGS = 'gi';

/**
 * What a pattern box holds, split into the pattern and its flags.
 *
 * @param {string} text - /pattern/flags or a bare pattern
 * @returns {{pattern: string, flags: string}}
 */
export function patternFromText(text) {
    const typed = String(text ?? '');
    const slashed = typed.match(/^\/(.+)\/([dgimsuvy]*)$/);
    if (slashed) return { pattern: slashed[1], flags: slashed[2] || 'g' };
    return { pattern: typed, flags: BARE_PATTERN_FLAGS };
}

/**
 * A stored pattern as its box shows it, /pattern/flags, which patternFromText reads back as it was, a pattern that
 * starts with a slash included.
 *
 * @param {{pattern?: string, flags?: string}} stored
 * @returns {string}
 */
export function patternText({ pattern = '', flags = '' } = {}) {
    return pattern ? `/${pattern}/${flags || 'g'}` : '';
}

/**
 * A file name for an exported setup: its name, lowercase, spaces as dashes, and what a file name cannot hold left out.
 *
 * @param {string} name
 * @returns {string}
 */
export function setupFileName(name) {
    const slug = String(name ?? '').trim().toLowerCase()
        // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, '-');
    return `vectfox-cleaning-${slug || 'setup'}.json`;
}
