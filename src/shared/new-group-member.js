/**
 * A new member of a group, its name and its ID (§1 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md):
 * EventBase's New collection among a chat's collections, and LoreBase's New selection among a book's selections, are
 * named by one rule and told apart by the time they were made. Pure: no settings, no host.
 */

/**
 * The name a new member of a group takes: the base name with the lowest number from 2 that the group's names do not
 * use, as "Harbor Atlas 2", then "Harbor Atlas 3", a number freed by a rename or a delete taken again.
 * @param {string} baseName
 * @param {Iterable<string>} takenNames - The names the group's members have now
 * @returns {string}
 */
export function numberedName(baseName, takenNames) {
    const taken = new Set(takenNames);
    for (let number = 2; ; number += 1) {
        const name = `${baseName} ${number}`;
        if (!taken.has(name)) return name;
    }
}

/**
 * An ID none of the group's members has: the time in base 36, moved on a step while one has it.
 * @param {Iterable<string>} takenIds - The IDs the group's members have now
 * @param {number} [now] - The time, in milliseconds
 * @returns {string}
 */
export function newTimeId(takenIds, now = Date.now()) {
    const taken = new Set(takenIds);
    let time = now;
    while (taken.has(time.toString(36))) time += 1;
    return time.toString(36);
}
