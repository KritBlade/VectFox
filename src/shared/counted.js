/**
 * A count with its noun, as a line of the Database Browser or the LoreBase selection screen shows it: "1 chunk",
 * "3 chunks". Pure.
 *
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural] - For a noun that does not take an s: counted(2, 'entry', 'entries')
 * @returns {string}
 */
export const counted = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
