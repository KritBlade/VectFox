/**
 * LoreBase's selection screen, the pure rules (src/features/lorebase/lorebase-selection-core.js, plan §5.2 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): the rows and their badges, the books
 * offered, the categories, the filters, the ticks, what the bulk bar and a category's toggle select, the entries new
 * since the book was last opened, the footer and the pinnable sections.
 */
import { describe, expect, it } from 'vitest';
import {
    BADGES, READINESS_CHOICES, bookChoices, categoryList, entryReadiness, filterRows, invertTicks, isEngineLike, liveSelection,
    pinnableSections, selectionAfterBulk, selectionAfterCategory, selectionFooter, selectionRows, seenUidsOf, tickAllMatching, tickRange,
} from '../src/features/lorebase/lorebase-selection-core.js';
import { estimatedTokens } from '../src/features/lorebase/lorebase-splitter.js';

const LONG_TEXT = 'The lighthouse keepers count the ships that pass the north cliff. '.repeat(90);
const BOOK = {
    entries: {
        0: { uid: 0, comment: '[Harbor] Lighthouse of Vell', key: ['lighthouse'], content: LONG_TEXT },
        1: { uid: 1, comment: '[Harbor] Tidewardens', key: ['tidewarden'], content: 'The tidewardens read the harbor bells.' },
        2: { uid: 2, comment: '[mvu_state] Tide clock', key: ['#0765792'], content: '<% if (tide > 3) { %><%= tide %><% } %>' },
        3: { uid: 3, comment: 'Fog Season', key: [], content: 'Fog closes the strait each spring.' },
        4: { uid: 4, comment: '', key: ['bell'], content: 'A bell rings at dusk.' },
        5: { uid: 5, comment: '[Harbor] Harbor Bell', key: ['bell'], content: 'The harbor bell.', constant: true },
        6: { uid: 6, comment: '[Harbor] Storm Watch', key: ['storm'], content: 'Storms come from the west.', sticky: 2 },
        7: { uid: 7, comment: 'Net Market', key: ['nets'], content: 'Nets are sold at dawn.', cooldown: 1 },
        8: { uid: 8, comment: 'Old Pier', key: ['pier'], content: 'The old pier fell in the storm.', disable: true },
        9: { uid: 9, comment: '[Harbor] Lamp Rules', key: ['lamp'], content: 'The lamp is lit at dusk and never left dark through the night. <%= lampName %>' },
    },
};
const rowsOf = (record = { selectedUids: [] }) => selectionRows(BOOK, record);
const byUid = (rows, uid) => rows.find(row => row.uid === uid);
const uids = rows => rows.map(row => row.uid);

describe("the screen's rows", () => {
    it('lists every entry in the book order, with its title, category, size and what SillyTavern keeps', () => {
        const rows = rowsOf({ selectedUids: ['1', '5'] });
        expect(uids(rows)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
        expect(byUid(rows, '0')).toMatchObject({ title: 'Lighthouse of Vell', category: '[Harbor]', tokens: estimatedTokens(LONG_TEXT), keyCount: 1, isSelected: false });
        expect(byUid(rows, '1')).toMatchObject({ isSelected: true, undecidableReason: null, isDisabled: false });
        expect(rows.map(row => row.undecidableReason).slice(5, 8)).toEqual(['constant', 'sticky', 'cooldown']);
        const [empty, blank] = selectionRows({ entries: { 9: { uid: 9, comment: 'Buoy Line' }, 10: { uid: 10, comment: 'Salt Flats', content: '  ' } } }, null);
        expect([empty.undecidableReason, blank.undecidableReason]).toEqual(['empty', 'empty']);
        expect(byUid(rows, '8').isDisabled).toBe(true);
        expect(byUid(rows, '4')).toMatchObject({ title: 'entry 4', category: '' });
    });

    it('says SillyTavern keeps an entry an @@activate or @@dont_activate line opens, and no other with decorator lines', () => {
        const rows = selectionRows({ entries: {
            0: { uid: 0, comment: 'Lamp Oil', content: '@@activate\nOil for the lamp.' },
            1: { uid: 1, comment: 'Wreck Map', content: '@@if wren_is_here\n@@dont_activate\nThe wreck lies north.' },
            2: { uid: 2, comment: 'Gull Roost', content: '@@if wren_is_here\nGulls roost on the roof.' },
        } }, null);
        expect(rows.map(row => row.undecidableReason)).toEqual(['activate_decorator', 'dont_activate_decorator', null]);
    });

    it('badges template code, an engine, code-like keys, no keys, a long entry and no title', () => {
        const rows = rowsOf();
        expect(byUid(rows, '0').badges).toEqual([BADGES.long]);
        expect(byUid(rows, '1').badges).toEqual([]);
        expect(byUid(rows, '2').badges).toEqual([BADGES.mostlyCode, BADGES.enginePrefix, BADGES.machineKey]);
        expect(byUid(rows, '3').badges).toEqual([BADGES.keyless]);
        expect(byUid(rows, '4').badges).toEqual([BADGES.noTitle]);
        expect(byUid(rows, '9').badges).toEqual([BADGES.templateCode]);
        expect(rows.filter(isEngineLike).map(row => row.uid)).toEqual(['2']);
    });

    it('reads mvu-helper call blocks as engines, and a word key with a number as a word', () => {
        const book = { entries: {
            0: { uid: 0, comment: 'Reply check [POST]', key: ['check'], content: 'Check the reply.' },
            1: { uid: 1, comment: 'Arc', key: ['Arc15', 'MV-0042'], content: 'Arc fifteen.' },
            2: { uid: 2, comment: 'Ops', key: ['A-113', '#0765'], content: 'Codes.' },
        } };
        const rows = selectionRows(book, null);
        expect(rows.map(row => row.badges)).toEqual([[BADGES.enginePrefix], [], [BADGES.machineKey]]);
    });

    it('marks the entries added since the book was last opened, and none on a first opening', () => {
        expect(rowsOf({ selectedUids: [], seenUids: ['0', '1', '2', '3', '4', '5', '6', '7', '8'] }).filter(row => row.isNew).map(row => row.uid)).toEqual(['9']);
        expect(rowsOf({ selectedUids: [] }).some(row => row.isNew)).toBe(false);
        expect(selectionRows(BOOK, null).some(row => row.isNew)).toBe(false);
        expect(seenUidsOf(BOOK)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    });
});

describe('the books offered', () => {
    it("puts the open chat's books first, in SillyTavern's order, then the rest by name, with their selected counts", () => {
        const selectedCounts = { 'Harbor Atlas': 2, Zeta: 1 };
        expect(bookChoices(['Zeta', 'Alpha', 'Harbor Atlas', 'Voyage Log'], ['Voyage Log', 'Harbor Atlas', 'Unknown Book'], selectedCounts)).toEqual([
            { bookName: 'Voyage Log', isActive: true, selectedCount: 0 },
            { bookName: 'Harbor Atlas', isActive: true, selectedCount: 2 },
            { bookName: 'Alpha', isActive: false, selectedCount: 0 },
            { bookName: 'Zeta', isActive: false, selectedCount: 1 },
        ]);
    });
});

describe('the categories', () => {
    it('lists them as they first appear, entries with none last, each on once its toggle has selected all it can', () => {
        const list = categoryList(rowsOf({ selectedUids: ['0', '1', '9', '5'] }));
        expect(list.map(({ category, rowCount, selectedCount, bulkCount, state }) => [category, rowCount, selectedCount, bulkCount, state])).toEqual([
            ['[Harbor]', 5, 3, 3, 'on'],
            ['[mvu_state]', 1, 0, 0, 'off'],
            ['', 4, 0, 3, 'off'],
        ]);
        expect(categoryList(rowsOf({ selectedUids: ['3'] })).find(item => item.category === '').state).toBe('mixed');
        // An engine entry selected one by one makes its category mixed, never on.
        expect(categoryList(rowsOf({ selectedUids: ['2'] })).find(item => item.category === '[mvu_state]').state).toBe('mixed');
    });

    it("turns a whole category on, but its engine-like entries and those SillyTavern keeps, and off, all of it", () => {
        const rows = rowsOf();
        expect(selectionAfterCategory([], rows, '[Harbor]', true).sort()).toEqual(['0', '1', '9']);
        expect(selectionAfterCategory(['2'], rows, '[mvu_state]', true)).toEqual(['2']);
        expect(selectionAfterCategory([], rows, '[mvu_state]', true)).toEqual([]);
        expect(selectionAfterCategory(['0', '1', '2', '3'], rows, '[Harbor]', false).sort()).toEqual(['2', '3']);
    });
});

describe('the filters', () => {
    const rows = rowsOf();

    it('match every word of the text in the title, comment, keys or entry text, case ignored', () => {
        expect(uids(filterRows(rows, { text: 'HARBOR bells' }))).toEqual(['1']);
        expect(uids(filterRows(rows, { text: 'tidewarden' }))).toEqual(['1']);
        expect(uids(filterRows(rows, { text: 'dusk' }))).toEqual(['4', '9']);
    });

    it('narrow to a category, a size, a badge, or the new ones', () => {
        expect(uids(filterRows(rows, { category: '' }))).toEqual(['3', '4', '7', '8']);
        expect(uids(filterRows(rows, { minimumTokens: 1000 }))).toEqual(['0']);
        expect(uids(filterRows(rows, { badge: BADGES.templateCode }))).toEqual(['9']);
        expect(uids(filterRows(rows, { badge: BADGES.keyless }))).toEqual(['3']);
        const withNew = selectionRows(BOOK, { selectedUids: [], seenUids: ['0', '1'] });
        expect(uids(filterRows(withNew, { isNewOnly: true, category: '[Harbor]' }))).toEqual(['5', '6', '9']);
    });

    it('narrow to the selected entries that are ready, or to those that are not, by isEntryReady whatever each row shows', () => {
        // 0 is ready, 1 lacks vectors, 3 is having its keys written, 4 has its keys written anew on the ones it has, 8's
        // vectors are not read; the rest are not selected, so they stand nowhere.
        const states = {
            0: { status: 'ready', isReady: true }, 1: { status: 'missing', isReady: false }, 3: { status: 'writing-keys', isReady: false },
            4: { status: 'writing-keys', isReady: true }, 8: { status: 'unknown', isReady: false },
        };
        const readinessOf = row => states[row.uid] ?? null;
        expect(uids(filterRows(rows, { readiness: READINESS_CHOICES.ready, readinessOf }))).toEqual(['0', '4']);
        expect(uids(filterRows(rows, { readiness: READINESS_CHOICES.notReady, readinessOf }))).toEqual(['1', '3', '8']);
        expect(filterRows(rows, { readiness: READINESS_CHOICES.any, readinessOf })).toHaveLength(rows.length);
    });
});

describe("a selected entry's keys and vectors, as its row says them", () => {
    const keys = { status: 'ready', keys: ['lighthouse'] };

    it('says its keys or its vectors are being written, keys first, carrying the keys it has and whether it is ready on what it has', () => {
        expect(entryReadiness({ status: 'writing' }, { status: 'writing' }, false)).toEqual({ status: 'writing-keys', isReady: false });
        expect(entryReadiness({ status: 'writing' }, { status: 'ready' }, true)).toEqual({ status: 'writing-keys', isReady: true });
        expect(entryReadiness(keys, { status: 'writing' }, false)).toEqual({ status: 'vectorizing', keys: ['lighthouse'], isReady: false });
    });

    it('says which failed with the reason, keys first', () => {
        expect(entryReadiness({ status: 'failed', detail: 'no list' }, { status: 'failed', detail: 'refused' }, false))
            .toEqual({ status: 'keys-failed', detail: 'no list', isReady: false });
        expect(entryReadiness(keys, { status: 'failed', detail: 'refused' }, false)).toEqual({ status: 'vectors-failed', detail: 'refused', keys: ['lighthouse'], isReady: false });
    });

    it("says what it lacks, another embedding model's vectors among them, and claims nothing of vectors not read, which are not ready", () => {
        expect(entryReadiness({ status: 'missing' }, { status: 'missing' }, false))
            .toEqual({ status: 'missing', lacksKeys: true, lacksVectors: true, isOtherModel: false, keys: null, isReady: false });
        expect(entryReadiness(keys, { status: 'other-model' }, false))
            .toEqual({ status: 'missing', lacksKeys: false, lacksVectors: true, isOtherModel: true, keys: ['lighthouse'], isReady: false });
        expect(entryReadiness({ status: 'missing' }, { status: 'unknown' }, false)).toMatchObject({ status: 'missing', lacksKeys: true, lacksVectors: false });
        expect(entryReadiness(keys, { status: 'unknown' }, false)).toEqual({ status: 'unknown', keys: ['lighthouse'], isReady: false });
    });

    it('is ready with its keys and its vectors, an empty list of keys included', () => {
        expect(entryReadiness(keys, { status: 'ready' }, true)).toEqual({ status: 'ready', keys: ['lighthouse'], isReady: true });
        expect(entryReadiness({ status: 'ready', keys: [] }, { status: 'ready' }, true)).toEqual({ status: 'ready', keys: [], isReady: true });
    });
});

describe('the ticks the bulk bar acts on', () => {
    const rows = rowsOf();

    it('ticks every matching row but engine-like ones and those SillyTavern keeps, keeping ticks the filters hide', () => {
        const matching = filterRows(rows, { category: '[Harbor]' });
        expect([...tickAllMatching(new Set(['3']), matching)].sort()).toEqual(['0', '1', '3', '9']);
        expect([...tickAllMatching(new Set(), rows)].sort()).toEqual(['0', '1', '3', '4', '8', '9']);
    });

    it("inverts the matching rows' ticks, never ticking an engine-like row or one SillyTavern keeps", () => {
        expect([...invertTicks(new Set(['0', '2', '7']), rows)].sort()).toEqual(['1', '3', '4', '8', '9']);
    });

    it('gives every matching row from the last one clicked to the shift-clicked one its new tick', () => {
        expect([...tickRange(new Set(), rows, '3', '0', true)].sort()).toEqual(['0', '1', '2', '3']);
        expect([...tickRange(new Set(['0', '1', '2', '3', '4']), rows, '1', '3', false)].sort()).toEqual(['0', '4']);
        // A row SillyTavern keeps is never ticked, and an anchor the filters hide ticks the clicked row alone.
        expect([...tickRange(new Set(), rows, '4', '7', true)].sort()).toEqual(['4']);
        expect([...tickRange(new Set(), filterRows(rows, { category: '' }), '0', '3', true)]).toEqual(['3']);
    });

    it('turns LoreBase on for the ticked rows, never for one SillyTavern keeps, and off for every ticked row', () => {
        expect(selectionAfterBulk(['1'], rows, new Set(['0', '2', '5']), true).sort()).toEqual(['0', '1', '2']);
        expect(selectionAfterBulk(['0', '1', '5'], rows, new Set(['1', '5']), false)).toEqual(['0']);
    });
});

describe('what the screen keeps and shows about the selection', () => {
    it("drops the uids of entries the book no longer holds", () => {
        expect(liveSelection(BOOK, { selectedUids: ['1', '42', '9'] })).toEqual(['1', '9']);
        expect(liveSelection(null, { selectedUids: ['1'] })).toEqual([]);
    });

    it('counts the entries LoreBase decides, the ready ones the pick reads, and the tokens their lines add to its table of contents', () => {
        const record = { selectedUids: ['1', '3', '5', '8'] };
        const isReady = () => true;
        expect(selectionFooter(BOOK, record, { isReady }))
            .toEqual({ decidedCount: 2, entryCount: 2, titleTokens: estimatedTokens('1. Tidewardens') + estimatedTokens('2. Fog Season') });
        expect(selectionFooter(BOOK, record, { isReady: entry => entry.uid === 3 }))
            .toEqual({ decidedCount: 2, entryCount: 1, titleTokens: estimatedTokens('1. Fog Season') });
        expect(selectionFooter(BOOK, record)).toEqual({ decidedCount: 2, entryCount: 0, titleTokens: 0 });
        expect(selectionFooter(BOOK, { selectedUids: [] }, { isReady })).toEqual({ decidedCount: 0, entryCount: 0, titleTokens: 0 });
    });

    it('offers the section names of the entries the pick reads, most held first, and keeps a pinned name', () => {
        const book = { entries: {
            0: { uid: 0, comment: 'Wren', content: 'Intro line.\n[Speech]\nShort and dry.\n[Secrets]\nShe hides the map.' },
            1: { uid: 1, comment: 'Orrin', content: '[Speech]\nSlow and kind.\n[History]\nKept the lamp for years.' },
            2: { uid: 2, comment: 'Mara', content: '[Speech]\nQuick.' },
        } };
        expect(pinnableSections(book, { selectedUids: ['0', '1'], pinnedSections: ['Secrets', 'Spoilers'] })).toEqual([
            { name: 'Speech', entryCount: 2, isPinned: false },
            { name: 'History', entryCount: 1, isPinned: false },
            { name: 'Secrets', entryCount: 1, isPinned: true },
            { name: 'Spoilers', entryCount: 0, isPinned: true },
        ]);
    });
});
