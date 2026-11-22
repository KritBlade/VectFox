/**
 * How SillyTavern's World Info scan activated each entry, the pure rules (src/sillytavern/world-info-activations-core.js):
 * the console.debug lines SillyTavern 1.19.0 and 1.19.1 print in checkWorldInfo, word for word, read into what fired
 * each entry: the primary key, the secondary keys with their logic, or another rule; a dry scan left unread; a line
 * of an entry not named last left unread; a reworded line not read; and the loop each entry went in.
 */
import { describe, expect, it } from 'vitest';
import {
    ACTIVATION_REASONS, activationKey, noteScanLoop, readWorldInfoLine, unreadScan,
} from '../src/sillytavern/world-info-activations-core.js';

const START = '[WI] --- START WI SCAN (on 12 messages, trigger = normal) ---';
const DRY_START = '[WI] --- START WI SCAN (on 12 messages, trigger = normal) (DRY RUN) ---';
const lighthouse = { uid: 21, world: 'Harbor Atlas', key: ['lighthouse', 'lamp'], keysecondary: ['night', 'storm'] };
const header = entry => [`[WI] Entry ${entry.uid}`, `from '${entry.world}' processing`, entry];
const line = (entry, ...args) => [`[WI] Entry ${entry.uid}`, ...args];
const read = calls => calls.reduce(readWorldInfoLine, unreadScan());
const activation = (scan, entry = lighthouse) => scan.activations.get(activationKey(entry.world, entry.uid));

describe('readWorldInfoLine', () => {
    it('reads the primary key that fired an entry with no secondary keys', () => {
        const scan = read([[START], header(lighthouse), line(lighthouse, 'activated by primary key match', 'lamp')]);
        expect(scan.isDryRun).toBe(false);
        expect(activation(scan)).toEqual({ primaryKey: 'lamp' });
    });

    it('reads each secondary logic with the primary key before it, one key or all the entry names', () => {
        const withLogic = (logicLine, value) => activation(read([
            [START], header(lighthouse),
            line(lighthouse, 'Entry with primary key match', 'lighthouse', 'has secondary keywords. Checking with logic logic', ['AND_ANY', 0]),
            line(lighthouse, logicLine, value),
        ]));
        expect(withLogic('activated. (AND ANY) Found match secondary keyword', 'night'))
            .toEqual({ primaryKey: 'lighthouse', logic: 'AND ANY', secondaryKeys: ['night'] });
        expect(withLogic('activated. (NOT ALL) Found not matching secondary keyword', 'storm'))
            .toEqual({ primaryKey: 'lighthouse', logic: 'NOT ALL', secondaryKeys: ['storm'] });
        expect(withLogic('activated. (NOT ANY) No secondary keywords found', ['night', ' storm ']))
            .toEqual({ primaryKey: 'lighthouse', logic: 'NOT ANY', secondaryKeys: ['night', 'storm'] });
        expect(withLogic('activated. (AND ALL) All secondary keywords found', ['night', 'storm']))
            .toEqual({ primaryKey: 'lighthouse', logic: 'AND ALL', secondaryKeys: ['night', 'storm'] });
    });

    it('reads the rules other than keys that bring an entry in', () => {
        const reasonOf = reasonLine => activation(read([[START], header(lighthouse), line(lighthouse, reasonLine)])).reason;
        expect(reasonOf('activated because of constant')).toBe(ACTIVATION_REASONS.CONSTANT);
        expect(reasonOf('activated because active sticky')).toBe(ACTIVATION_REASONS.STICKY);
        expect(reasonOf('activated by @@activate decorator')).toBe(ACTIVATION_REASONS.DECORATOR);
        expect(reasonOf('externally activated')).toBe(ACTIVATION_REASONS.EXTERNAL);
    });

    it('keeps a later loop\'s primary match over an earlier one whose secondary keys failed', () => {
        const scan = read([
            [START], header(lighthouse),
            line(lighthouse, 'Entry with primary key match', 'lamp', 'has secondary keywords. Checking with logic logic', ['AND_ANY', 0]),
            line(lighthouse, 'skipped. Secondary keywords not satisfied', lighthouse.keysecondary),
            header(lighthouse),
            line(lighthouse, 'Entry with primary key match', 'lighthouse', 'has secondary keywords. Checking with logic logic', ['AND_ANY', 0]),
            line(lighthouse, 'activated. (AND ANY) Found match secondary keyword', 'storm'),
        ]);
        expect(activation(scan)).toEqual({ primaryKey: 'lighthouse', logic: 'AND ANY', secondaryKeys: ['storm'] });
    });

    it('tells apart two books\' entries of the same uid by the book each header names', () => {
        const tides = { uid: 21, world: 'Tide Tables', key: ['spring tide'] };
        const scan = read([
            [START], header(lighthouse), line(lighthouse, 'activated by primary key match', 'lamp'),
            header(tides), line(tides, 'activated by primary key match', 'spring tide'),
        ]);
        expect([activation(scan), activation(scan, tides)]).toEqual([{ primaryKey: 'lamp' }, { primaryKey: 'spring tide' }]);
    });

    it('leaves unread a dry scan, a line of an entry not named last, other lines, and a reworded line', () => {
        expect(read([[DRY_START], header(lighthouse), line(lighthouse, 'activated by primary key match', 'lamp')]).activations.size).toBe(0);
        const other = { uid: 4, world: 'Harbor Atlas' };
        const scan = read([
            [START], header(lighthouse),
            line(other, 'activated by primary key match', 'gull'),
            ['[WI] Search done. Found 3 possible entries.'],
            ['VectFox: an unrelated line', 'activated by primary key match'],
            line(lighthouse, 'activated, primary key matched', 'lamp'),
        ]);
        expect(scan.activations.size).toBe(0);
    });

    it('begins a new read at the next scan, so a reply reads its own scan', () => {
        const first = read([[START], header(lighthouse), line(lighthouse, 'activated by primary key match', 'lamp')]);
        const next = readWorldInfoLine(first, [START]);
        expect(next).not.toBe(first);
        expect(next.activations.size).toBe(0);
    });
});

describe('noteScanLoop', () => {
    it('gives each entry the first loop it went in, keeping what fired it', () => {
        const scan = read([[START], header(lighthouse), line(lighthouse, 'activated by primary key match', 'lamp')]);
        const keeper = { uid: 7, world: 'Keeper Notes' };
        noteScanLoop(scan, 1, [lighthouse]);
        noteScanLoop(scan, 2, [lighthouse, keeper]);
        expect(activation(scan)).toEqual({ primaryKey: 'lamp', loop: 1 });
        expect(activation(scan, keeper)).toEqual({ loop: 2 });
        noteScanLoop(scan, undefined, [{ uid: 9, world: 'Keeper Notes' }]);
        expect(scan.activations.size).toBe(2);
    });
});
