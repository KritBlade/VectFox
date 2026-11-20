/**
 * The in-use switcher (§1.2 of InternalProject/Vectfox/plans/vectfox-multi-collection-per-chat.md): one dropdown that
 * shows and changes which member of a group the open chat uses, drawn alike wherever a group is. Selection in use here,
 * on each book row of the WorldInfo page's LoreBase books card, holds the book's selections; Collection in use here, on
 * the AutoSync page, is to hold the chat's collections. It lists each member by its name, the one in use here chosen,
 * then the New choice last; while none is in use here it opens on "None in use here", which chooses nothing. The page
 * that draws it hands each choice to the feature that owns the group. Pure: builds strings.
 */
import { select, selectOption } from '../../shared/gui-dna/gui-dna-core.js';

/** The New choice's value: no member's ID holds a "+". */
export const IN_USE_NEW = '+new';

/**
 * One switcher, on GUI-DNA's select, which a list row's actions lead with.
 * @param {{id: string, title: string, members: Array<{id: string, name: string}>, inUseId: string|null, newText: string,
 *   data?: Record<string, string>}} switcher - title: its accessible name; newText: the New choice's words
 * @returns {string}
 */
export function inUseSwitcherMarkup({ id, title, members, inUseId, newText, data }) {
    const isNoneInUse = !members.some(member => member.id === inUseId);
    return select({
        id,
        title,
        data,
        options: [
            isNoneInUse ? selectOption({ value: '', text: 'None in use here', isSelected: true }) : '',
            ...members.map(member => selectOption({ value: member.id, name: member.name, isSelected: member.id === inUseId })),
            selectOption({ value: IN_USE_NEW, text: newText }),
        ].filter(Boolean),
    });
}
