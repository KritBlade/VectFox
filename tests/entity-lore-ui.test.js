/**
 * @vitest-environment jsdom
 *
 * The Entity-Lore card's content (src/features/entity-lore/entity-lore-ui.js, §3 of
 * InternalProject/Vectfox/plans/entity-lore.md).
 *
 * Guards that:
 *   - each state's row has §3's pill and buttons, its event count, its other names and, for a same_as, the hint to
 *     merge the names on StoryArc's Entity tab; each button names its character and entry; Lock is offered wherever
 *     Entity-Lore would write the character, and a locked row offers Open entry, when it has one, and Lock; Lock's
 *     padlock shows the character's state, open in the success ink while unlocked, closed and pressed once locked,
 *     when pressing it unlocks; a written entry offers Catch up now and Rewrite now, an edited one each anyway, and one
 *     due to be rewritten for a change of its names Rewrite now alone, saying why; a row whose
 *     name is in another book names that entry, a linked one with what the link means, Allow again, and, while
 *     LoreBase does not read its key in this chat, what it waits for,
 *   - the list pages 20 rows at a time, its page kept within the pages there are, and says why it is empty,
 *   - the notice says what to turn on first while Entity-Lore is off, that it is paused while it is on, and offers the
 *     button to where it is fixed; LoreBase or StoryArc not acting disables the switch, the model not set does not,
 *   - the book line names the book before its first entry, once made, and once unlinked from the chat.
 *
 * Names are made up and match no story.
 */
/* global document -- this file runs under the jsdom environment */
import { describe, expect, it } from 'vitest';

import { ENTITY_LORE_FIX_AT, ENTITY_LORE_NEED, ENTITY_STATE, EXCLUSION, NAMES_CHANGED_BY } from '../src/features/entity-lore/entity-lore-core.js';
import {
    ENTITY_LORE_ACTION, ENTITY_LORE_ROWS_PER_PAGE, entityLoreBookLine, entityLoreLastRunText, entityLoreListMarkup, entityLoreNoticeMarkup,
    entityLoreProblemMarkup, isSwitchGatedBy,
} from '../src/features/entity-lore/entity-lore-ui.js';

const drawn = (markup) => {
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    return holder;
};
const row = (name, state, extra = {}) => ({ name, otherNames: [], eventCount: 12, state, ...extra });
const rowOf = (state, extra) => drawn(entityLoreListMarkup({ rows: [row('Tamsin', state, extra)], pageIndex: 0, isSearching: false }).list);
const pillsOf = holder => [...holder.querySelectorAll('.vfx-pill')].map(pill => pill.textContent);
const buttonsOf = holder => [...holder.querySelectorAll('button')].map(button => button.textContent || button.title);
const subsOf = holder => [...holder.querySelectorAll('.vfx-row-sub')].map(line => line.textContent);
const LOCK = "Lock: Entity-Lore leaves this character's entry as it is";
// An entry of another book the chat loads, as the row's lorebookEntry carries it, which LoreBase decides here.
const YSOLDE = { bookName: 'Harbor Atlas', uid: '7', title: '[NPC] Ysolde', names: ['[NPC] Ysolde'], isDecidedHere: true, isConstant: false };
const LINK_LINE = "The name check found this is another name of that entry's character, so LoreBase reads it as one of the entry's keys.";

describe("a character's row (§3's table)", () => {
    it.each([
        [ENTITY_STATE.waiting, { eventCount: 7, writeAt: 10 }, ['7 events', 'Waiting, 7 of 10 events'], [LOCK]],
        [ENTITY_STATE.due, {}, ['12 events', 'Due'], ['Write now', LOCK]],
        [ENTITY_STATE.written, { uid: '3', writtenAtEvents: 30 }, ['12 events', 'Written at 30 events'], ['Open entry', 'Catch up now', 'Rewrite now', LOCK]],
        [ENTITY_STATE.catchUpDue, { uid: '3', writtenAtEvents: 10 }, ['12 events', 'Catch-up due'], ['Open entry', 'Catch up now', 'Rewrite now', LOCK]],
        [ENTITY_STATE.rewriteDue, { uid: '3', writtenAtEvents: 10 }, ['12 events', 'Rewrite due'], ['Open entry', 'Rewrite now', LOCK]],
        [ENTITY_STATE.editedByUser, { uid: '3', writtenAtEvents: 10 }, ['12 events', 'Edited by you'], ['Open entry', 'Catch up anyway', 'Rewrite anyway', LOCK]],
        [ENTITY_STATE.locked, { uid: '3', writtenAtEvents: 30 }, ['12 events', 'Locked'], ['Open entry', LOCK]],
        [ENTITY_STATE.locked, {}, ['12 events', 'Locked'], [LOCK]],
        [ENTITY_STATE.deletedByUser, {}, ['12 events', 'Deleted by you'], ['Allow again']],
        [ENTITY_STATE.notNamed, {}, ['12 events', 'Not a named character'], ['Allow again']],
        [ENTITY_STATE.sameAs, { sameAs: 'Tamsin Vale' }, ['12 events', 'Same as Tamsin Vale'], ['Allow again']],
        [ENTITY_STATE.inLorebook, { lorebookEntry: YSOLDE }, ['12 events', 'Already in a lorebook'], ['Allow again']],
    ])('%s: its pills and buttons', (state, extra, pills, buttons) => {
        const holder = rowOf(state, extra);
        expect(pillsOf(holder)).toEqual(pills);
        expect(buttonsOf(holder)).toEqual(buttons);
    });

    it('says why an excluded character gets no entry, with no button', () => {
        expect(Object.values(EXCLUSION).map(exclusion => pillsOf(rowOf(ENTITY_STATE.excluded, { exclusion }))[1])).toEqual([
            "This chat's character", 'Your persona', 'Already in a lorebook', 'In the character card',
        ]);
        expect(buttonsOf(rowOf(ENTITY_STATE.excluded, { exclusion: EXCLUSION.persona }))).toEqual([]);
    });

    it("names each button's character and entry, and what it does", () => {
        const [open, catchUpAnyway, rewriteAnyway] = rowOf(ENTITY_STATE.editedByUser, { uid: '3' }).querySelectorAll('button');
        expect({ ...open.dataset }).toEqual({ i18nTitle: 'Open entry', entityLoreAction: ENTITY_LORE_ACTION.openEntry, name: 'Tamsin', uid: '3' });
        expect({ ...catchUpAnyway.dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.catchUpAnyway, name: 'Tamsin', uid: '3' });
        expect({ ...rewriteAnyway.dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.rewriteAnyway, name: 'Tamsin', uid: '3' });
        const [, catchUp, rewrite] = rowOf(ENTITY_STATE.written, { uid: '3' }).querySelectorAll('button');
        expect({ ...catchUp.dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.catchUp, name: 'Tamsin', uid: '3' });
        expect({ ...rewrite.dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.rewrite, name: 'Tamsin', uid: '3' });
        expect({ ...rowOf(ENTITY_STATE.due).querySelector('button').dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.write, name: 'Tamsin' });
    });

    it("shows the character's state on Lock's padlock: open in the success ink while unlocked, closed and pressed once locked", () => {
        const lookOf = holder => {
            const lock = holder.querySelector(`button[title="${LOCK}"]`);
            return { className: lock.className, isPressed: lock.getAttribute('aria-pressed'), icon: lock.querySelector('i').className, data: { ...lock.dataset } };
        };
        const unlockedStates = [ENTITY_STATE.waiting, ENTITY_STATE.due, ENTITY_STATE.written, ENTITY_STATE.catchUpDue, ENTITY_STATE.rewriteDue, ENTITY_STATE.editedByUser];
        const open = {
            className: 'vfx-btn vfx-btn-icon is-success', isPressed: 'false', icon: 'fa-solid fa-lock-open',
            data: { i18nTitle: LOCK, entityLoreAction: ENTITY_LORE_ACTION.lock, name: 'Tamsin', uid: '3' },
        };
        expect(unlockedStates.map(state => lookOf(rowOf(state, { uid: '3', writeAt: 10, writtenAtEvents: 10 })))).toEqual(unlockedStates.map(() => open));
        expect(lookOf(rowOf(ENTITY_STATE.locked, { uid: '3' }))).toEqual({
            className: 'vfx-btn vfx-btn-icon is-on', isPressed: 'true', icon: 'fa-solid fa-lock',
            data: { i18nTitle: LOCK, entityLoreAction: ENTITY_LORE_ACTION.unlock, name: 'Tamsin', uid: '3' },
        });
    });

    it("shows a character's other names, and on a same_as the way to count the two as one", () => {
        const holder = rowOf(ENTITY_STATE.sameAs, { otherNames: ['Tam'], sameAs: 'Tamsin Vale' });
        expect([...holder.querySelectorAll('.vfx-row-sub')].map(line => line.textContent)).toEqual([
            'Also known as: Tam', "To count the two as one, merge their names on StoryArc's Entity tab.",
        ]);
    });

    it('names the entry of another book a name is in, by its title or its uid, whether excluded by its name or linked by the name check (E2, E3)', () => {
        expect(subsOf(rowOf(ENTITY_STATE.excluded, { exclusion: EXCLUSION.lorebook, lorebookEntry: YSOLDE }))).toEqual(['In Harbor Atlas: [NPC] Ysolde']);
        expect(subsOf(rowOf(ENTITY_STATE.excluded, { exclusion: EXCLUSION.lorebook, lorebookEntry: { ...YSOLDE, title: '' } }))).toEqual(['In Harbor Atlas: entry 7']);
        expect(subsOf(rowOf(ENTITY_STATE.excluded, { exclusion: EXCLUSION.persona }))).toEqual([]);
        const linked = rowOf(ENTITY_STATE.inLorebook, { lorebookEntry: YSOLDE });
        expect(subsOf(linked)).toEqual(['In Harbor Atlas: [NPC] Ysolde', LINK_LINE]);
        expect(linked.querySelectorAll('.vfx-pill')[1].querySelector('i').className).toContain('fa-link');
        expect({ ...linked.querySelector('button').dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.allowAgain, name: 'Tamsin' });
    });

    it("says on a link that LoreBase reads its key only once the entry is on and selected here, unless SillyTavern always sends it (E2)", () => {
        expect(subsOf(rowOf(ENTITY_STATE.inLorebook, { lorebookEntry: { ...YSOLDE, isDecidedHere: false } }))).toEqual([
            'In Harbor Atlas: [NPC] Ysolde', LINK_LINE, 'LoreBase reads Tamsin only while the entry is on and selected for this chat, in Choose entries on the Main tab.',
        ]);
        expect(subsOf(rowOf(ENTITY_STATE.inLorebook, { lorebookEntry: { ...YSOLDE, isDecidedHere: false, isConstant: true } })))
            .toEqual(['In Harbor Atlas: [NPC] Ysolde', LINK_LINE]);
    });

    it('shows the names Allow again kept a character apart from', () => {
        const holder = rowOf(ENTITY_STATE.due, { keptApartFrom: ['Tamsin Vale', 'Tam'] });
        expect([...holder.querySelectorAll('.vfx-row-sub')].map(line => line.textContent)).toEqual(['Kept apart from: Tamsin Vale · Tam']);
    });

    it("says why an entry is due to be rewritten when its names changed, on StoryArc's Entity tab, by the name check or by Allow again", () => {
        const subsOf = extra => [...rowOf(ENTITY_STATE.rewriteDue, { uid: '3', ...extra }).querySelectorAll('.vfx-row-sub')].map(line => line.textContent);
        expect(subsOf({ namesChangedBy: NAMES_CHANGED_BY.merge })).toEqual(["Names were merged on StoryArc's Entity tab, so the next run rewrites it with every name's events."]);
        expect(subsOf({ namesChangedBy: NAMES_CHANGED_BY.match }))
            .toEqual(["The name check found another name of this character, so the next run rewrites it with every name's events."]);
        expect(subsOf({ namesChangedBy: NAMES_CHANGED_BY.split }))
            .toEqual(["A name was split off on StoryArc's Entity tab, so the next run writes it again from scratch, from the events of the names shown on this row."]);
        expect(subsOf({ namesChangedBy: NAMES_CHANGED_BY.allowAgain }))
            .toEqual(["A name marked Same as this one was allowed again, so the next run writes it again from scratch, from the events of the names shown on this row."]);
        expect(subsOf({})).toEqual([]);
    });
});

describe('the character list', () => {
    const rows = Array.from({ length: 45 }, (_, index) => row(`Hand ${index + 1}`, ENTITY_STATE.waiting, { writeAt: 10 }));

    it('shows 20 rows a page, with the pager, its page kept within the pages there are', () => {
        expect(ENTITY_LORE_ROWS_PER_PAGE).toBe(20);
        const last = entityLoreListMarkup({ rows, pageIndex: 9, isSearching: false });
        expect(last.pageIndex).toBe(2);
        expect(drawn(last.list).querySelectorAll('.vfx-row')).toHaveLength(5);
        expect(drawn(last.pagerMarkup).textContent).toBe('3 / 3');
        expect(entityLoreListMarkup({ rows: rows.slice(0, 20), pageIndex: 0, isSearching: false }).pagerMarkup).toBe('');
    });

    it('says why it is empty, for the search or for the chat', () => {
        expect(drawn(entityLoreListMarkup({ rows: [], pageIndex: 3, isSearching: true }).list).textContent).toBe('No name matches the search.');
        expect(entityLoreListMarkup({ rows: [], pageIndex: 3, isSearching: false })).toEqual({
            list: expect.stringContaining('StoryArc counts no person in this chat yet.'), pagerMarkup: '', pageIndex: 0,
        });
        expect(drawn(entityLoreProblemMarkup('This chat has no stored events yet.')).textContent).toBe('This chat has no stored events yet.');
    });
});

describe('the notice and the switch', () => {
    const storyArcOff = { need: ENTITY_LORE_NEED.storyArc, reason: 'StoryArc mode is off.', fix: 'Turn on StoryArc mode first.', fixAt: ENTITY_LORE_FIX_AT.storyArcPage };

    it('says what to turn on first while Entity-Lore is off, and that it is paused while on, with the button to the fix', () => {
        const off = drawn(entityLoreNoticeMarkup({ blocker: storyArcOff, isOn: false }));
        expect(off.querySelector('.vfx-notice').className).toContain('is-info');
        expect(off.querySelector('.vfx-notice-text').textContent).toBe('Turn on StoryArc mode first.');
        expect({ ...off.querySelector('button').dataset }).toEqual({ entityLoreAction: ENTITY_LORE_ACTION.fix, fixAt: ENTITY_LORE_FIX_AT.storyArcPage });
        expect(off.querySelector('button').textContent).toBe('Open StoryArc');
        const paused = drawn(entityLoreNoticeMarkup({ blocker: { ...storyArcOff, fixAt: ENTITY_LORE_FIX_AT.worldInfoMain }, isOn: true }));
        expect(paused.querySelector('.vfx-notice').className).toContain('is-warning');
        expect(paused.querySelector('.vfx-notice-text').textContent).toBe('Entity-Lore is paused: StoryArc mode is off.');
        expect(paused.querySelector('button').textContent).toBe('Open Main');
        expect(drawn(entityLoreNoticeMarkup({ blocker: { ...storyArcOff, fixAt: null }, isOn: false })).querySelector('button')).toBeNull();
        expect(entityLoreNoticeMarkup({ blocker: null, isOn: true })).toBe('');
    });

    it('disables the switch for LoreBase or StoryArc not acting, never for the model not set', () => {
        expect(isSwitchGatedBy(storyArcOff)).toBe(true);
        expect(isSwitchGatedBy({ need: ENTITY_LORE_NEED.loreBase })).toBe(true);
        expect(isSwitchGatedBy({ need: ENTITY_LORE_NEED.loreBaseModel })).toBe(false);
        expect(isSwitchGatedBy(null)).toBe(false);
    });
});

describe('the book line and the last run', () => {
    it('names the book before its first entry, once made, and once unlinked from this chat', () => {
        const bookName = 'VectFox NPCs - Harbor Tales';
        expect(entityLoreBookLine({ bookName, isBookMade: false, isBookInChat: false })).toBe('The first entry creates VectFox NPCs - Harbor Tales and adds it to this chat.');
        expect(entityLoreBookLine({ bookName, isBookMade: true, isBookInChat: true })).toBe('Writes into VectFox NPCs - Harbor Tales, added to this chat.');
        expect(entityLoreBookLine({ bookName, isBookMade: true, isBookInChat: false })).toBe('Writes into VectFox NPCs - Harbor Tales, which the next entry adds to this chat again.');
    });

    it("says the last run's outcome as the progress panel ended on it", () => {
        expect(entityLoreLastRunText({ text: '3 entries written, 1 rewritten, 1 failed (see the console)' })).toBe('Last run: 3 entries written, 1 rewritten, 1 failed (see the console).');
    });
});
