/**
 * Pure lorebook content preparation — no ST dependencies.
 * Extracted from content-vectorization.js so it can be unit-tested
 * without mocking SillyTavern globals.
 */

import { cleanContentOrNull } from '../text-cleaning/index.js';

/**
 * Prepare lorebook entries for chunking.
 *
 * per_entry  — each entry becomes its own chunk string, prefixed with
 *              `# <title>` when a title is available (comment > name > key[0]).
 * combined   — all entries concatenated with `\n\n---\n\n` separators, same
 *              title prefix per entry.
 *
 * @param {{ entries?: object[], content?: object[]|object }} rawContent
 * @param {{ strategy?: string, includeDisabled?: boolean }} settings - includeDisabled keeps entries disabled in World Info
 * @returns {{ text: string|string[], type: string, entries?: object[], entryCount?: number }}
 */
export function prepareLorebookContent(rawContent, settings) {
    let entries = rawContent.entries || rawContent.content;

    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        entries = Object.values(entries);
    }

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return { text: '', type: 'empty' };
    }

    // Two-pass filter — pre-clean drops entries that never had content
    // to begin with (no point running cleanText on null/undefined),
    // post-clean drops entries whose content was entirely stripped by
    // user regex. The post-clean drop is load-bearing: without it the
    // entry's `comment` header + auto-appended `[KEYWORDS: ...]` survives
    // as a "valid-looking" chunk with no real payload (see cleanContentOrNull).
    // An entry disabled in World Info is left out unless Vectorize Content's Include disabled entries is on.
    const validEntries = entries
        .filter(e => e && e.content && (settings.includeDisabled || !e.disable))
        .map(e => ({ ...e, content: cleanContentOrNull(e.content) }))
        .filter(e => e.content !== null);

    if (settings.strategy === 'per_entry') {
        return {
            text: validEntries.map(e => {
                const header = e.comment || e.name || e.key?.[0] || '';
                return header ? `# ${header}\n${e.content}` : e.content;
            }),
            type: 'per_entry',
            entries: validEntries,
            entryCount: validEntries.length,
        };
    }

    const combined = validEntries.map(e => {
        const header = e.comment || e.name || e.key?.[0] || '';
        return header ? `# ${header}\n${e.content}` : e.content;
    }).join('\n\n---\n\n');

    return { text: combined, type: 'combined', entryCount: validEntries.length };
}
