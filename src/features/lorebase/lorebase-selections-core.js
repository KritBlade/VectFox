/**
 * A lorebook's selections, the pure half (§3.7 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md):
 * a book holds one or more selections, each its own selected entries, pinned sections and locks on chats and
 * characters. A chat uses one selection of a book at a time: the one locked to the chat, else the one locked to its
 * character (selectionInUseOf). Putting one in use at a place takes that place's lock off the book's others
 * (oneInUseLockChanges), and New selection names its copy by numberedName; EventBase's collections are to take the same
 * two rules (§1 of that plan). LoreBase writes keys and vectors for every entry any selection holds
 * (unionOfSelections), so the selections of a book share them. Pure: no settings, no host.
 */

/**
 * @typedef {object} LoreSelection
 * @property {string} id - The time it was made in base 36 (newSelectionId), never made twice in its book
 * @property {string} name - What the pages show; a book's first selection is named after the book
 * @property {string[]} selectedUids - The entries LoreBase decides while the selection is in use
 * @property {string[]} pinnedSections - The section names whose parts are kept whenever their entry is picked
 * @property {string[]} lockedToChatIds - The chats using it, each by its file name
 * @property {string[]} lockedToCharacterAvatars - The characters using it, each by its avatar file name
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
 * Which locks change when one member of a group is put in use at a place, a chat or a character: the one chosen is
 * locked there, and every other member locked there is unlocked, so the place uses one member at a time. A member
 * already as it should be is left out.
 * @param {Array<{id: string, isLockedHere: boolean}>} members - The group's members, each with whether the place has it
 * @param {string} chosenId
 * @returns {{lockIds: string[], unlockIds: string[]}}
 */
export function oneInUseLockChanges(members, chosenId) {
    const chosen = members.find(member => member.id === chosenId);
    return {
        lockIds: chosen && !chosen.isLockedHere ? [chosenId] : [],
        unlockIds: members.filter(member => member.id !== chosenId && member.isLockedHere).map(member => member.id),
    };
}

/**
 * An ID no selection of the book has: the time in base 36, moved on a step while one has it.
 * @param {Iterable<string>} takenIds - The IDs of the book's selections
 * @param {number} [now] - The time, in milliseconds
 * @returns {string}
 */
export function newSelectionId(takenIds, now = Date.now()) {
    const taken = new Set(takenIds);
    let time = now;
    while (taken.has(time.toString(36))) time += 1;
    return time.toString(36);
}

/**
 * A selection with nothing selected, pinned or locked.
 * @param {string} id
 * @param {string} name
 * @returns {LoreSelection}
 */
export function emptySelection(id, name) {
    return { id, name, selectedUids: [], pinnedSections: [], lockedToChatIds: [], lockedToCharacterAvatars: [] };
}

/**
 * Whether a selection is locked to the chat or the character given.
 * @param {LoreSelection} selection
 * @param {{chatId?: string|null, characterAvatar?: string|null}} where
 * @returns {boolean}
 */
export function isSelectionLockedTo(selection, { chatId = null, characterAvatar = null }) {
    return (chatId != null && selection.lockedToChatIds.includes(String(chatId)))
        || (characterAvatar != null && selection.lockedToCharacterAvatars.includes(String(characterAvatar)));
}

/**
 * The selection of a book a chat uses: the one locked to the chat, else the one locked to its character, else none.
 * @param {{selections: LoreSelection[]}|null} record - The book's record
 * @param {{chatId?: string|null, characterAvatar?: string|null}} where
 * @returns {LoreSelection|null}
 */
export function selectionInUseOf(record, { chatId = null, characterAvatar = null }) {
    const selections = record?.selections ?? [];
    return selections.find(selection => isSelectionLockedTo(selection, { chatId }))
        ?? selections.find(selection => isSelectionLockedTo(selection, { characterAvatar }))
        ?? null;
}

/**
 * Every entry any of a book's selections holds, each once, in the shape of a selection's: what LoreBase writes keys and
 * vectors for, and deletes the vectors of no other entry while the book is written.
 * @param {{selections: LoreSelection[]}|null} record - The book's record
 * @returns {{selectedUids: string[]}}
 */
export function unionOfSelections(record) {
    return { selectedUids: [...new Set((record?.selections ?? []).flatMap(selection => selection.selectedUids))] };
}
