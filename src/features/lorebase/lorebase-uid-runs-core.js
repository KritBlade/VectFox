/**
 * A set of a lorebook's entry uids written short, the one form LoreBase's record keeps them in: the entries each
 * selection holds (`selectedEntries`) and the entries the selection screen last saw (`seenEntries`). Each run of
 * whole-number uids is written "first-last", a single one as itself, and a uid that is not a whole number written
 * plainly as itself, after the runs. SillyTavern numbers a book's entries from 0 and gives a new one the lowest uid
 * free (getFreeWorldEntryUid), so a book's uids mostly run on: 320 entries make one string. A book whose uids are
 * scattered makes one string a uid, never more than a list of them. A uid "first-last" of two whole numbers reads as
 * a run, as SillyTavern makes no such uid. Pure. Covered by tests/lorebase-uid-runs-core.test.js.
 */

const RUN = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/;

/**
 * Whether a uid is a whole number written plainly, as SillyTavern numbers a book's entries.
 * @param {string} uid
 * @returns {boolean}
 */
const isWholeNumberUid = uid => /^(0|[1-9]\d*)$/.test(uid) && Number.isSafeInteger(Number(uid));

/** A run of uids from first to last, as the short form writes it. */
const runText = (first, last) => (first === last ? String(first) : `${first}-${last}`);

/**
 * The short form of a set of uids, each once, its runs in order.
 * @param {Iterable<string|number>} uids
 * @returns {string[]}
 */
export function uidRunsOf(uids) {
    const unique = [...new Set([...uids].map(String))];
    const numbers = unique.filter(isWholeNumberUid).map(Number).sort((first, second) => first - second);
    const runs = [];
    let first = null;
    let last = null;
    for (const number of numbers) {
        if (last !== null && number === last + 1) {
            last = number;
            continue;
        }
        if (first !== null) runs.push(runText(first, last));
        first = number;
        last = number;
    }
    if (first !== null) runs.push(runText(first, last));
    return [...runs, ...unique.filter(uid => !isWholeNumberUid(uid))];
}

/**
 * The uids a short form holds, each once: the runs' in order, then the others.
 * @param {string[]|null|undefined} runs - As uidRunsOf gives them
 * @returns {string[]}
 */
export function uidsOfRuns(runs) {
    const uids = [];
    for (const run of Array.isArray(runs) ? runs : []) {
        const text = String(run);
        const match = RUN.exec(text);
        if (!match) {
            uids.push(text);
            continue;
        }
        for (let uid = Number(match[1]); uid <= Number(match[2]); uid += 1) uids.push(String(uid));
    }
    return [...new Set(uids)];
}

/**
 * Whether a short form holds a uid, read without writing its runs out.
 * @param {string[]|null|undefined} runs - As uidRunsOf gives them
 * @param {string|number} uid
 * @returns {boolean}
 */
export function runsHoldUid(runs, uid) {
    const wanted = String(uid);
    const number = isWholeNumberUid(wanted) ? Number(wanted) : null;
    return (Array.isArray(runs) ? runs : []).some(run => {
        const text = String(run);
        const match = RUN.exec(text);
        if (!match) return text === wanted;
        return number !== null && number >= Number(match[1]) && number <= Number(match[2]);
    });
}
