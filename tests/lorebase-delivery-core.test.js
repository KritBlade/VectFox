/**
 * LoreBase's delivery through SillyTavern's World Info scan, the pure rules (src/features/lorebase/
 * lorebase-delivery-core.js, plan §5.7 and D14 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-
 * index.md): what each pick sends, and how a scan is armed: the keys of every entry LoreBase decides blanked in the
 * scan's copy, never in SillyTavern's cached book, and the picks force-activated in one <VectLorebook> block for each
 * place in the prompt they take, each pick in a tag of its own.
 */
import { describe, expect, it } from 'vitest';
import { addedBooksToLoad, armScan, chatLoreEntriesOf, scanDeliveries, scanKey } from '../src/features/lorebase/lorebase-delivery-core.js';

const passage = text => ({ section: '(intro)', text, tokens: 5 });
const reviewed = (uid, sentParts, { frame = null, texts = ['The lamp burns all night.', 'The keeper sleeps by day.', 'Gulls nest on the roof.'] } = {}) => ({
    bookName: 'Harbor Atlas', uid, title: `entry ${uid}`, uses: sentParts.length ? 'some' : 'none', frame, passages: texts.map(passage), sentParts,
});

// The books added to the chat through LoreBase's Add to this chat (L1 of InternalProject/Vectfox/plans/entity-lore.md).
describe('addedBooksToLoad', () => {
    const loaded = () => ({
        globalLore: [{ uid: 0, world: 'Harbor Atlas' }],
        characterLore: [{ uid: 7, world: 'Keeper Notes' }],
        chatLore: [{ uid: 3, world: 'Voyage Log' }],
        personaLore: [],
    });

    it('keeps the added books the scan lacks, each once, in the order they were added', () => {
        expect(addedBooksToLoad(['Tide Tables', 'Coral Index', 'Tide Tables'], loaded())).toEqual(['Tide Tables', 'Coral Index']);
    });

    it("leaves out a book any list of SillyTavern's loaded already, so it is scanned once, as SillyTavern's", () => {
        expect(addedBooksToLoad(['Harbor Atlas', 'Keeper Notes', 'Voyage Log', 'Tide Tables'], loaded())).toEqual(['Tide Tables']);
        expect(addedBooksToLoad([], loaded())).toEqual([]);
    });
});

describe('chatLoreEntriesOf', () => {
    it("copies each entry as SillyTavern's chat lore holds it, its uid first and the book as its world, the book left as it was", () => {
        const book = { entries: { 4: { uid: 4, key: ['reef'], content: 'The reef breaks at low tide.' }, 9: { uid: 9, key: [], content: 'Coral grows slowly.' } } };
        const entries = chatLoreEntriesOf('Coral Index', book);
        expect(entries).toEqual([
            { uid: 4, world: 'Coral Index', key: ['reef'], content: 'The reef breaks at low tide.' },
            { uid: 9, world: 'Coral Index', key: [], content: 'Coral grows slowly.' },
        ]);
        expect(Object.keys(entries[0])).toEqual(['uid', 'world', 'key', 'content']);
        entries[0].key = [];
        expect(book.entries[4]).toEqual({ uid: 4, key: ['reef'], content: 'The reef breaks at low tide.' });
    });

    it('gives nothing for a book with no entries, or none at all', () => {
        expect(chatLoreEntriesOf('Coral Index', { entries: {} })).toEqual([]);
        expect(chatLoreEntriesOf('Coral Index', null)).toEqual([]);
    });
});

describe('scanKey', () => {
    it("names an entry as SillyTavern's scan does: its book, a dot, its uid", () => {
        expect(scanKey('Harbor Atlas', 3)).toBe('Harbor Atlas.3');
        expect(scanKey('Harbor Atlas', '3')).toBe('Harbor Atlas.3');
    });
});

describe('scanDeliveries', () => {
    it('sends the whole entry when its review kept every part', () => {
        expect(scanDeliveries([reviewed(0, [1, 2, 3])]).get('Harbor Atlas.0')).toEqual({ isWhole: true, text: '', title: 'entry 0', hasFrame: false, jevChance: null });
    });

    it("sends the parts its review kept, in the entry's order, one to a line", () => {
        expect(scanDeliveries([reviewed(1, [1, 3])]).get('Harbor Atlas.1')).toEqual({
            isWhole: false, text: 'The lamp burns all night.\nGulls nest on the roof.', title: 'entry 1', hasFrame: false, jevChance: null,
        });
    });

    it("keeps the entry's wrapper tags around the parts it sends, so the tags stay balanced", () => {
        const frame = { open: '<lighthouse>', close: '</lighthouse>' };
        const delivery = scanDeliveries([reviewed(2, [2], { frame })]).get('Harbor Atlas.2');
        expect([delivery.text, delivery.hasFrame]).toEqual(['<lighthouse>\nThe keeper sleeps by day.\n</lighthouse>', true]);
    });

    it("keeps Jev's chance of yes on a pick of Fast and Cheap [Jev], for the reply lore list", () => {
        expect(scanDeliveries([{ ...reviewed(5, [1, 2, 3]), jevChance: 0.7 }]).get('Harbor Atlas.5').jevChance).toBe(0.7);
    });

    it('sends nothing for a pick whose review kept no part', () => {
        const deliveries = scanDeliveries([reviewed(3, []), reviewed(4, [2])]);
        expect([...deliveries.keys()]).toEqual(['Harbor Atlas.4']);
    });
});

describe('armScan', () => {
    const harborKeys = ['lighthouse'];
    const loadedScan = () => ({
        globalLore: [
            { uid: 0, world: 'Harbor Atlas', key: harborKeys, keysecondary: ['night'], content: 'The lamp burns all night.', position: 4, order: 300, depth: 2, group: 'lights', probability: 80, useProbability: true },
            { uid: 1, world: 'Harbor Atlas', key: ['tide'], content: 'The tide turns at noon.' },
            { uid: 2, world: 'Harbor Atlas', key: ['bell'], content: 'Not selected.' },
            { uid: 5, world: 'Harbor Atlas', key: ['fog'], content: 'Always sent.', constant: true },
            { uid: 6, world: 'Harbor Atlas', key: ['gull'], content: 'Timed.', cooldown: 3 },
        ],
        characterLore: [{ uid: 7, world: 'Keeper Notes', key: ['oil'], content: '@@if lamp_lit\nOil lasts a week.' }],
        chatLore: [{ uid: 0, world: 'Voyage Log', key: ['lighthouse'], content: 'Not taking part here.' }],
        personaLore: [],
    });
    const selections = { 'Harbor Atlas': new Set(['0', '1', '5', '6']), 'Keeper Notes': new Set(['7']) };
    const selectedUidsOf = bookName => selections[bookName] ?? null;

    it('blanks the keys of every entry LoreBase decides, in every list, and no other', () => {
        const loaded = loadedScan();
        armScan(loaded, { selectedUidsOf, deliveries: null });
        const keysOf = list => list.map(entry => entry.key);
        expect(keysOf(loaded.globalLore)).toEqual([[], [], ['bell'], ['fog'], ['gull']]);
        expect(keysOf(loaded.characterLore)).toEqual([[]]);
        expect(keysOf(loaded.chatLore)).toEqual([['lighthouse']]);
    });

    it("gives a blanked entry a new key list, leaving the list SillyTavern's cached book shares with it", () => {
        const loaded = loadedScan();
        armScan(loaded, { selectedUidsOf, deliveries: null });
        expect(loaded.globalLore[0].key).toEqual([]);
        expect(harborKeys).toEqual(['lighthouse']);
    });

    const whole = title => ({ isWhole: true, text: '', title, hasFrame: false });
    // The block two whole picks that go to the same place in the prompt make, titled as given.
    const blockOfTwo = (firstTitle, secondTitle) => armScan(loadedScan(), {
        selectedUidsOf, deliveries: new Map([['Harbor Atlas.1', whole(firstTitle)], ['Keeper Notes.7', whole(secondTitle)]]),
    }).forced[0].content;

    it('sends a pick inside a VectLorebook block, as the scan loaded the entry, which goes in whole', () => {
        const deliveries = new Map([['Harbor Atlas.0', { isWhole: false, text: 'The lamp burns.', title: 'Lantern Room', hasFrame: false }]]);
        const { forced, sentCount } = armScan(loadedScan(), { selectedUidsOf, deliveries });
        expect(sentCount).toBe(1);
        expect(forced).toEqual([{
            uid: 0, world: 'Harbor Atlas', key: ['lighthouse'], keysecondary: ['night'],
            content: '<VectLorebook>\n<Lantern_Room>\nThe lamp burns.\n</Lantern_Room>\n</VectLorebook>',
            position: 4, order: 300, depth: 2, group: '', probability: 80, useProbability: false,
        }]);
    });

    it('says which picks each block carries, by the entry that carries it, for the reply lore list', () => {
        const deliveries = new Map([
            ['Keeper Notes.7', { ...whole("Oil's Store"), jevChance: 0.9 }],
            ['Harbor Atlas.1', whole('Tide Tables')],
            ['Harbor Atlas.0', { isWhole: false, text: 'The lamp burns.', title: 'Lantern Room', hasFrame: false }],
        ]);
        expect(armScan(loadedScan(), { selectedUidsOf, deliveries }).blocks).toEqual([
            {
                key: 'Keeper Notes.7',
                picks: [
                    { bookName: 'Keeper Notes', uid: 7, title: "Oil's Store", isWhole: true, jevChance: 0.9 },
                    { bookName: 'Harbor Atlas', uid: 1, title: 'Tide Tables', isWhole: true, jevChance: null },
                ],
            },
            { key: 'Harbor Atlas.0', picks: [{ bookName: 'Harbor Atlas', uid: 0, title: 'Lantern Room', isWhole: false, jevChance: null }] },
        ]);
    });

    it('carries the picks that go to one place in one block, most needed first, a whole pick less its opening decorator lines', () => {
        const deliveries = new Map([['Keeper Notes.7', whole("Oil's Store")], ['Harbor Atlas.1', whole('Tide Tables')]]);
        const { forced, sentCount } = armScan(loadedScan(), { selectedUidsOf, deliveries });
        expect(sentCount).toBe(2);
        expect(forced.map(entry => [entry.world, entry.uid, entry.content])).toEqual([[
            'Keeper Notes', 7,
            '<VectLorebook>\n<Oils_Store>\nOil lasts a week.\n</Oils_Store>\n<Tide_Tables>\nThe tide turns at noon.\n</Tide_Tables>\n</VectLorebook>',
        ]]);
    });

    it('sends a block for each place in the prompt the picks take, and keeps a pick in its own wrapper tags as they are', () => {
        const deliveries = new Map([
            ['Harbor Atlas.1', whole('Tide Tables')],
            ['Harbor Atlas.0', { isWhole: false, text: '<lamp>\nThe lamp burns.\n</lamp>', title: 'Lantern Room', hasFrame: true }],
        ]);
        expect(armScan(loadedScan(), { selectedUidsOf, deliveries }).forced.map(entry => [entry.uid, entry.position, entry.content])).toEqual([
            [1, undefined, '<VectLorebook>\n<Tide_Tables>\nThe tide turns at noon.\n</Tide_Tables>\n</VectLorebook>'],
            [0, 4, '<VectLorebook>\n<lamp>\nThe lamp burns.\n</lamp>\n</VectLorebook>'],
        ]);
    });

    it("names a pick's tag by the words of its title, so it closes as it opens, and never twice in a block", () => {
        expect(blockOfTwo('═══════[Tide Tables]═══════', '3 Bells')).toBe(
            '<VectLorebook>\n<Tide_Tables>\nThe tide turns at noon.\n</Tide_Tables>\n<entry_3_Bells>\nOil lasts a week.\n</entry_3_Bells>\n</VectLorebook>');
        expect(blockOfTwo('[☰]', 'Wren’s Map')).toContain('<entry_1>\nThe tide turns at noon.\n</entry_1>\n<Wrens_Map>');
        expect(blockOfTwo('Harbor', 'Harbor')).toContain('</Harbor>\n<Harbor_2>\nOil lasts a week.\n</Harbor_2>');
    });

    it('sends no pick the scan does not hold, or no longer leaves to LoreBase, and leaves the latter its keys', () => {
        const loaded = loadedScan();
        const deliveries = new Map([['Harbor Atlas.9', whole('Lost')], ['Harbor Atlas.5', whole('Fog')], ['Voyage Log.0', whole('Log')]]);
        expect(armScan(loaded, { selectedUidsOf, deliveries })).toEqual({ forced: [], sentCount: 0, blocks: [] });
        expect(loaded.globalLore[3].key).toEqual(['fog']);
        expect(loaded.chatLore[0].key).toEqual(['lighthouse']);
    });

    it('leaves SillyTavern a selected entry an @@activate or @@dont_activate line opens: its keys kept, never sent, never carrying a block', () => {
        const loaded = {
            globalLore: [
                { uid: 0, world: 'Harbor Atlas', key: ['lamp'], content: '@@activate\nThe lamp burns all night.' },
                { uid: 1, world: 'Harbor Atlas', key: ['tide'], content: '@@if wren_is_here\n@@dont_activate\nThe tide turns at noon.' },
                { uid: 2, world: 'Harbor Atlas', key: ['bell'], content: 'The bell rings at dusk.' },
            ],
        };
        const deliveries = new Map([['Harbor Atlas.0', whole('Lamp')], ['Harbor Atlas.1', whole('Tide')], ['Harbor Atlas.2', whole('Bell')]]);
        const { forced, sentCount } = armScan(loaded, { selectedUidsOf: () => new Set(['0', '1', '2']), deliveries });
        expect(loaded.globalLore.map(entry => entry.key)).toEqual([['lamp'], ['tide'], []]);
        expect(sentCount).toBe(1);
        expect(forced.map(entry => [entry.uid, entry.content])).toEqual([[2, '<VectLorebook>\n<Bell>\nThe bell rings at dusk.\n</Bell>\n</VectLorebook>']]);
    });
});
