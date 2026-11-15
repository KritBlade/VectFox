/**
 * LoreBase's delivery through SillyTavern's World Info scan, the pure rules (src/features/lorebase/
 * lorebase-delivery-core.js, plan §5.7 and D14 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-
 * index.md): what each pick sends, and how a scan is armed: the keys of every entry LoreBase decides blanked in the
 * scan's copy, never in SillyTavern's cached book, and the picks force-activated in one <VectLorebook> block for each
 * place in the prompt they take, each pick in a tag of its own.
 */
import { describe, expect, it } from 'vitest';
import { armScan, scanDeliveries, scanKey, withoutDecoratorLines } from '../src/features/lorebase/lorebase-delivery-core.js';

const passage = text => ({ section: '(intro)', text, tokens: 5 });
const reviewed = (uid, sentParts, { frame = null, texts = ['The lamp burns all night.', 'The keeper sleeps by day.', 'Gulls nest on the roof.'] } = {}) => ({
    bookName: 'Harbor Atlas', uid, title: `entry ${uid}`, uses: sentParts.length ? 'some' : 'none', frame, passages: texts.map(passage), sentParts,
});

describe('scanKey', () => {
    it("names an entry as SillyTavern's scan does: its book, a dot, its uid", () => {
        expect(scanKey('Harbor Atlas', 3)).toBe('Harbor Atlas.3');
        expect(scanKey('Harbor Atlas', '3')).toBe('Harbor Atlas.3');
    });
});

describe('withoutDecoratorLines', () => {
    it('leaves out the decorator lines that open an entry, as SillyTavern does before it sends one', () => {
        expect(withoutDecoratorLines('@@activate\n@@if wren_is_here\nThe lamp burns.\n@@ stays here')).toBe('The lamp burns.\n@@ stays here');
        expect(withoutDecoratorLines('The lamp burns.\n@@activate')).toBe('The lamp burns.\n@@activate');
    });

    it('keeps an entry of decorator lines alone whole, as SillyTavern does', () => {
        expect(withoutDecoratorLines('@@activate\n@@dont_activate')).toBe('@@activate\n@@dont_activate');
        expect(withoutDecoratorLines('')).toBe('');
        expect(withoutDecoratorLines(undefined)).toBe('');
    });
});

describe('scanDeliveries', () => {
    it('sends the whole entry when its review kept every part', () => {
        expect(scanDeliveries([reviewed(0, [1, 2, 3])]).get('Harbor Atlas.0')).toEqual({ isWhole: true, text: '', title: 'entry 0', hasFrame: false });
    });

    it("sends the parts its review kept, in the entry's order, one to a line", () => {
        expect(scanDeliveries([reviewed(1, [1, 3])]).get('Harbor Atlas.1')).toEqual({
            isWhole: false, text: 'The lamp burns all night.\nGulls nest on the roof.', title: 'entry 1', hasFrame: false,
        });
    });

    it("keeps the entry's wrapper tags around the parts it sends, so the tags stay balanced", () => {
        const frame = { open: '<lighthouse>', close: '</lighthouse>' };
        const delivery = scanDeliveries([reviewed(2, [2], { frame })]).get('Harbor Atlas.2');
        expect([delivery.text, delivery.hasFrame]).toEqual(['<lighthouse>\nThe keeper sleeps by day.\n</lighthouse>', true]);
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
        expect(armScan(loaded, { selectedUidsOf, deliveries })).toEqual({ forced: [], sentCount: 0 });
        expect(loaded.globalLore[3].key).toEqual(['fog']);
        expect(loaded.chatLore[0].key).toEqual(['lighthouse']);
    });
});
