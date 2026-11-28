// text-preview.js — the start of a text on one line, where a dialog or a row names something by its text: the Chunk
// Visualizer's chunks with no name, and the events the public API's delete question names. Pure.

/**
 * The start of a text on one line: its runs of whitespace as one space, cut after `length` characters with an
 * ellipsis.
 *
 * @param {string} text
 * @param {number} length - How many characters it keeps
 * @returns {string}
 */
export function textPreview(text, length) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    return line.length > length ? `${line.slice(0, length)}…` : line;
}
