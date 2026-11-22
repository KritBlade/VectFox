/**
 * SillyTavern's decorators, the `@@` lines that open a lorebook entry's content, read as its World Info scan reads them
 * (parseDecorators in world-info.js, SillyTavern 1.19.0): the entries they keep SillyTavern's own, and the content a
 * scanned entry sends (plan §5.2 and §5.7 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md).
 * Pure: no SillyTavern.
 */

const DECORATOR_OPENER = '@@';
const FALLBACK_OPENER = '@@@';
/** Has SillyTavern's scan send an entry every time, whatever its keys. */
export const ACTIVATE_DECORATOR = '@@activate';
/** Keeps SillyTavern's scan from ever sending an entry, or an entry an extension forces in its place. */
export const DONT_ACTIVATE_DECORATOR = '@@dont_activate';
// The decorators SillyTavern knows, in the order its scan reads them.
const KNOWN_DECORATORS = [ACTIVATE_DECORATOR, DONT_ACTIVATE_DECORATOR];

/**
 * An entry's decorators and the content SillyTavern sends, as its scan reads them: every line at the content's head
 * that starts with '@@' is a decorator line, and the content sent starts at the first line that does not, or is the
 * whole content when none follows them. A line that starts with a known decorator is kept as written; a line that
 * starts with '@@@' is read, less its first '@', only right after an unknown one, as its fallback; any other is dropped.
 * @param {string} content
 * @returns {{decorators: string[], content: string}}
 */
function parseDecorators(content) {
    const text = String(content ?? '');
    if (!text.startsWith(DECORATOR_OPENER)) return { decorators: [], content: text };
    const lines = text.split('\n');
    const decorators = [];
    let isAfterUnknownDecorator = false;
    for (const [index, line] of lines.entries()) {
        if (!line.startsWith(DECORATOR_OPENER)) return { decorators, content: lines.slice(index).join('\n') };
        const isFallback = line.startsWith(FALLBACK_OPENER);
        if (isFallback && !isAfterUnknownDecorator) continue;
        const decorator = isFallback ? line.substring(1) : line;
        const isKnown = KNOWN_DECORATORS.some(known => decorator.startsWith(known));
        if (isKnown) decorators.push(decorator);
        isAfterUnknownDecorator = !isKnown;
    }
    return { decorators, content: text };
}

/**
 * An entry's content without the decorator lines that open it, as SillyTavern sends a scanned entry. A forced entry
 * skips that step, so LoreBase gives what it forces as SillyTavern would send it.
 * @param {string} content
 * @returns {string}
 */
export function withoutDecoratorLines(content) {
    return parseDecorators(content).content;
}

/**
 * The decorator by which SillyTavern's scan decides an entry whatever its keys, or null: @@activate sends it every
 * time, and @@dont_activate never. The scan reads them before the entry's keys and before an entry an extension forces
 * in its place, @@activate first, and only as written: a line such as `@@activate_now` decides nothing.
 * @param {string} content - The entry's content, its decorator lines included
 * @returns {string|null} ACTIVATE_DECORATOR or DONT_ACTIVATE_DECORATOR, or null
 */
export function activationDecoratorOf(content) {
    const { decorators } = parseDecorators(content);
    return KNOWN_DECORATORS.find(decorator => decorators.includes(decorator)) ?? null;
}
