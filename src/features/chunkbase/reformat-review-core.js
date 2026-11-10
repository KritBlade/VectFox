/**
 * ============================================================================
 * AUTO-REFORMAT REVIEW: RULES
 * ============================================================================
 * What reformat-review.js wires and reformat-review-markup.js draws, kept free
 * of the page: an entry's fields as its form shows them and back, whether the
 * form changed it, why it may not be trusted, and what Accept keeps.
 * ============================================================================
 */

/** The kinds of entry Auto-Reformat writes. */
export const ENTRY_TYPES = Object.freeze(['character', 'organization', 'concept', 'location', 'item', 'other']);

/** The fields a form shows as comma-separated text. */
const LIST_FIELDS = ['aliases', 'traits', 'relationships', 'keywords'];

const csvText = list => (Array.isArray(list) ? list.join(', ') : '');

const parseCsv = text => String(text || '').split(',').map(part => part.trim()).filter(Boolean);

/**
 * An entry's fields as its form shows them: text, lists comma-separated, and whether it is kept.
 *
 * @param {object} record - From reformatDocument(), with `_accepted`
 * @returns {{entry_type: string, name: string, aliases: string, affiliation: string, traits: string,
 *   relationships: string, keywords: string, body: string, isKept: boolean}}
 */
export function entryFormValues(record) {
    return {
        entry_type: record.entry_type || 'other',
        name: String(record.name || ''),
        aliases: csvText(record.aliases),
        affiliation: String(record.affiliation || ''),
        traits: csvText(record.traits),
        relationships: csvText(record.relationships),
        keywords: csvText(record.keywords),
        body: String(record.body || ''),
        isKept: record._accepted !== false,
    };
}

/** Whether a form differs from the entry it was drawn from. */
export function isEntryEdited(record, form) {
    const drawn = entryFormValues(record);
    return Object.keys(drawn).some(field => drawn[field] !== form[field]);
}

/** The entry a form holds: trimmed text, lists split on commas, and whether it is kept. */
export function entryFromForm(record, form) {
    const entry = { ...record, entry_type: form.entry_type, _accepted: form.isKept };
    for (const field of ['name', 'affiliation', 'body']) entry[field] = String(form[field] || '').trim();
    for (const field of LIST_FIELDS) entry[field] = parseCsv(form[field]);
    return entry;
}

/**
 * Why an entry may be invented: its name, or some of its aliases, appear nowhere in the source. Empty when it is
 * grounded.
 *
 * @param {{name: string, _nameGrounded?: boolean, _ungroundedAliases?: string[]}} record
 * @returns {string[]}
 */
export function groundingWarnings(record) {
    const warnings = [];
    if (record._nameGrounded === false) warnings.push(`"${record.name}" is not in the source: check it was not invented.`);
    if (record._ungroundedAliases?.length) warnings.push(`Not in the source: ${record._ungroundedAliases.join(', ')}.`);
    return warnings;
}

/**
 * What Accept keeps, or why it cannot: at least one entry must be kept, and each kept one needs a name and a body.
 *
 * @param {object[]} entries - From entryFromForm, in the review's order
 * @returns {{kept: object[], problem: string}}
 */
export function acceptedEntries(entries) {
    const kept = entries.filter(entry => entry._accepted);
    if (!kept.length) return { kept, problem: 'Keep at least one entry, or choose Chunk by strategy.' };
    const incomplete = kept.filter(entry => !entry.name || !entry.body);
    if (incomplete.length) {
        const names = incomplete.map(entry => entry.name || `entry ${entries.indexOf(entry) + 1}`).join(', ');
        return { kept, problem: `A kept entry needs a name and a body: ${names}.` };
    }
    return { kept, problem: '' };
}
