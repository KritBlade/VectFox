/**
 * How SillyTavern's World Info scan activated each entry, the pure rules: what its checkWorldInfo (world-info.js,
 * 1.19.0 and 1.19.1) prints through console.debug, and the loop each entry went in. SillyTavern keeps no record of
 * the keyword that fired an entry; these lines are the one place it says which. A scan's first line is
 * `[WI] --- START WI SCAN (…) ---`, with ` (DRY RUN)` in it for a dry one; an entry's lines start `[WI] Entry <uid>`,
 * the first of them naming its book and carrying the entry itself. A line SillyTavern rewords is not read, so its entry
 * shows no keyword. Pure: no SillyTavern, no console.
 */

/** What fired an entry other than its keys. */
export const ACTIVATION_REASONS = Object.freeze({
    CONSTANT: 'constant', STICKY: 'sticky', DECORATOR: 'decorator', EXTERNAL: 'external',
});

const SCAN_START = '[WI] --- START WI SCAN';
const ENTRY_LINE = /^\[WI\] Entry (\S+)$/;
const ENTRY_HEADER = "from '";
// The lines that name the primary key that matched: alone, or before the entry's secondary keys are checked.
const PRIMARY_LINES = new Set(['activated by primary key match', 'Entry with primary key match']);
// The lines that let a primary match through by the entry's secondary keys, and the logic each says, as SillyTavern's
// entry editor names it. AND ANY and NOT ALL name one key, NOT ANY and AND ALL all of the entry's secondary keys.
const SECONDARY_LINES = new Map([
    ['activated. (AND ANY) Found match secondary keyword', 'AND ANY'],
    ['activated. (NOT ALL) Found not matching secondary keyword', 'NOT ALL'],
    ['activated. (NOT ANY) No secondary keywords found', 'NOT ANY'],
    ['activated. (AND ALL) All secondary keywords found', 'AND ALL'],
]);
const REASON_LINES = new Map([
    ['activated because of constant', ACTIVATION_REASONS.CONSTANT],
    ['activated because active sticky', ACTIVATION_REASONS.STICKY],
    ['activated by @@activate decorator', ACTIVATION_REASONS.DECORATOR],
    ['externally activated', ACTIVATION_REASONS.EXTERNAL],
]);

/**
 * @typedef {{primaryKey?: string, logic?: string, secondaryKeys?: string[], reason?: string, loop?: number}} EntryActivation
 *   What fired an entry: the primary key that matched, with the secondary keys and their logic when the entry has
 *   them, or another reason; and the scan's loop it went in
 * @typedef {{isDryRun: boolean|null, activations: Map<string, EntryActivation>, entryKey: string|null,
 *   entryUid: string|null}} ScanRead - One scan's lines read so far: whether it is dry (null before its first line), what
 *   fired each entry, by activationKey, and the entry its next lines are about
 */

/**
 * How the scan names an entry: its book and uid.
 * @param {string} bookName
 * @param {number|string} uid
 * @returns {string}
 */
export function activationKey(bookName, uid) {
    return `${bookName}.${uid}`;
}

/** @returns {ScanRead} A read with no line yet. */
export function unreadScan() {
    return { isDryRun: null, activations: new Map(), entryKey: null, entryUid: null };
}

/**
 * Read one console.debug call into the scan read so far. A scan's first line begins a new read; a dry scan's other
 * lines are left unread. An entry's first line says which entry its next lines are about; each of those lines that
 * says what fired it is kept. A line whose uid is not the entry's last named is left unread, as its book is unknown.
 * @param {ScanRead} scan - Changed in place, except at a scan's first line
 * @param {unknown[]} args - console.debug's arguments
 * @returns {ScanRead} The read: a new one at a scan's first line, else the one given
 */
export function readWorldInfoLine(scan, args) {
    const [first, what, value] = args;
    if (typeof first !== 'string' || !first.startsWith('[WI] ')) return scan;
    if (first.startsWith(SCAN_START)) return { ...unreadScan(), isDryRun: first.includes('(DRY RUN)') };
    if (scan.isDryRun) return scan;
    const uid = ENTRY_LINE.exec(first)?.[1];
    if (uid === undefined || typeof what !== 'string') return scan;
    if (what.startsWith(ENTRY_HEADER)) {
        const isEntry = value && typeof value === 'object' && String(value.uid) === uid;
        scan.entryKey = isEntry ? activationKey(value.world, value.uid) : null;
        scan.entryUid = isEntry ? uid : null;
        return scan;
    }
    if (scan.entryKey === null || scan.entryUid !== uid) return scan;
    const known = scan.activations.get(scan.entryKey);
    const activation = activationFrom(what, value, known);
    if (activation) scan.activations.set(scan.entryKey, known?.loop === undefined ? activation : { ...activation, loop: known.loop });
    return scan;
}

/**
 * What one entry line says fired the entry, or null for a line that says nothing of it. A primary key or a reason
 * replaces what an earlier loop's lines said; secondary keys join the primary key read before them.
 */
function activationFrom(what, value, known) {
    if (PRIMARY_LINES.has(what)) return typeof value === 'string' ? { primaryKey: value } : null;
    if (REASON_LINES.has(what)) return { reason: REASON_LINES.get(what) };
    if (!SECONDARY_LINES.has(what) || known?.primaryKey === undefined) return null;
    const secondaryKeys = (Array.isArray(value) ? value : [value])
        .filter(key => typeof key === 'string' && key.trim())
        .map(key => key.trim());
    return { primaryKey: known.primaryKey, logic: SECONDARY_LINES.get(what), secondaryKeys };
}

/**
 * Note the loop each entry a scan loop added went in, from WORLDINFO_SCAN_DONE: an entry keeps the first loop it went
 * in. Entries with no line read still get their loop.
 * @param {ScanRead} scan - Changed in place
 * @param {number} loop - The loop's number, from 1
 * @param {Array<{world: string, uid: number|string}>} entries - The entries the loop added to the prompt
 */
export function noteScanLoop(scan, loop, entries) {
    if (!Number.isInteger(loop)) return;
    for (const entry of entries ?? []) {
        if (!entry) continue;
        const key = activationKey(entry.world, entry.uid);
        const known = scan.activations.get(key) ?? {};
        if (known.loop === undefined) scan.activations.set(key, { ...known, loop });
    }
}
