/**
 * LoreBase's delivery through SillyTavern's World Info scan, the pure rules (src/features/lorebase/
 * lorebase-delivery-core.js, plan §5.7 and D14 of InternalProject/Vectfox/plans/lorebook-semantic-overhaul-passage-
 * index.md): what each pick sends, and how a scan is armed: the keys of every entry LoreBase decides blanked in the
 * scan's copy, never in SillyTavern's cached book, and each pick force-activated with its own fields.
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
        expect(scanDeliveries([reviewed(0, [1, 2, 3])]).get('Harbor Atlas.0')).toEqual({ isWhole: true, text: '' });
    });

    it("sends the parts its review kept, in the entry's order, one to a line", () => {
        expect(scanDeliveries([reviewed(1, [1, 3])]).get('Harbor Atlas.1')).toEqual({ isWhole: false, text: 'The lamp burns all night.\nGulls nest on the roof.' });
    });

    it("keeps the entry's wrapper tags around the parts it sends, so the tags stay balanced", () => {
        const frame = { open: '<lighthouse>', close: '</lighthouse>' };
        expect(scanDeliveries([reviewed(2, [2], { frame })]).get('Harbor Atlas.2').text).toBe('<lighthouse>\nThe keeper sleeps by day.\n</lighthouse>');
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

    it('forces each pick as the scan loaded it, its own fields kept, with the text its review kept', () => {
        const deliveries = new Map([['Harbor Atlas.0', { isWhole: false, text: 'The lamp burns.' }]]);
        const forced = armScan(loadedScan(), { selectedUidsOf, deliveries });
        expect(forced).toEqual([{
            uid: 0, world: 'Harbor Atlas', key: ['lighthouse'], keysecondary: ['night'], content: 'The lamp burns.',
            position: 4, order: 300, depth: 2, group: 'lights', probability: 80, useProbability: true,
        }]);
    });

    it('sends a whole pick with the content the scan loaded, less its opening decorator lines', () => {
        const deliveries = new Map([['Keeper Notes.7', { isWhole: true, text: '' }], ['Harbor Atlas.1', { isWhole: true, text: '' }]]);
        const forced = armScan(loadedScan(), { selectedUidsOf, deliveries });
        expect(forced.map(entry => [entry.world, entry.uid, entry.content])).toEqual([
            ['Harbor Atlas', 1, 'The tide turns at noon.'],
            ['Keeper Notes', 7, 'Oil lasts a week.'],
        ]);
    });

    it('sends no pick the scan does not hold, or no longer leaves to LoreBase, and leaves the latter its keys', () => {
        const loaded = loadedScan();
        const deliveries = new Map([['Harbor Atlas.9', { isWhole: true, text: '' }], ['Harbor Atlas.5', { isWhole: true, text: '' }], ['Voyage Log.0', { isWhole: true, text: '' }]]);
        expect(armScan(loaded, { selectedUidsOf, deliveries })).toEqual([]);
        expect(loaded.globalLore[3].key).toEqual(['fog']);
        expect(loaded.chatLore[0].key).toEqual(['lighthouse']);
    });
});
