/**
 * One in use per place (§1 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md): a chat uses one of
 * its own EventBase collections, and one selection of each lorebook, at a time. Which locks change when one member of
 * such a group is put in use is this one rule, which EventBase's and LoreBase's lock functions both follow. Pure: no
 * settings, no host.
 */

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
