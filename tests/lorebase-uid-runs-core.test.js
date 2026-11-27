/**
 * The short form LoreBase's record keeps a set of entry uids in (src/features/lorebase/lorebase-uid-runs-core.js), the
 * entries a selection holds and those the selection screen last saw: runs of whole-number uids as "first-last", a
 * single one as itself, any other uid as itself after them; never longer than a list of the uids, and the same set read
 * back.
 */
import { describe, expect, it } from 'vitest';
import { runsHoldUid, uidRunsOf, uidsOfRuns } from '../src/features/lorebase/lorebase-uid-runs-core.js';

describe('the short form of a set of uids', () => {
    it('writes each run of whole numbers as first-last and a single one as itself, in order, each uid once', () => {
        expect(uidRunsOf(['0', '1', '2', '3'])).toEqual(['0-3']);
        expect(uidRunsOf([5, '9', 4, 6, '12', 10, 6])).toEqual(['4-6', '9-10', '12']);
        expect(uidRunsOf([])).toEqual([]);
    });

    it('keeps a uid that is not a whole number written plainly as itself, after the runs', () => {
        expect(uidRunsOf(['harbor', '1', '07', '0', 'harbor'])).toEqual(['0-1', 'harbor', '07']);
    });

    it('is never longer than the list of uids it stands for, scattered uids making one string each', () => {
        const scattered = ['3', '400', '9071', '998552'];
        expect(uidRunsOf(scattered)).toEqual(scattered);
        expect(JSON.stringify(uidRunsOf(scattered)).length).toBeLessThanOrEqual(JSON.stringify(scattered).length);
    });
});

describe('reading the short form back', () => {
    it('gives every uid of its runs, in order, then the others', () => {
        expect(uidsOfRuns(['0-3', '7', 'harbor'])).toEqual(['0', '1', '2', '3', '7', 'harbor']);
        expect(uidsOfRuns([])).toEqual([]);
        expect(uidsOfRuns(undefined)).toEqual([]);
    });

    it('says whether it holds a uid without writing the runs out', () => {
        const runs = ['0-3', '7', 'harbor'];
        expect(['0', '3', '7', 'harbor', 2].map(uid => runsHoldUid(runs, uid))).toEqual([true, true, true, true, true]);
        expect(['4', '6', '8', 'keeper', '07'].map(uid => runsHoldUid(runs, uid))).toEqual([false, false, false, false, false]);
        expect(runsHoldUid(undefined, '0')).toBe(false);
    });

    it('stands for the same set of uids it was made from, for sets of any shape', () => {
        let state = 11;
        const nextRandom = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
        for (let round = 0; round < 200; round += 1) {
            const uids = [];
            for (let uid = 0; uid < 60; uid += 1) if (nextRandom() < 0.5) uids.push(String(uid));
            if (nextRandom() < 0.3) uids.push('harbor');
            const runs = uidRunsOf(uids);
            expect(new Set(uidsOfRuns(runs))).toEqual(new Set(uids));
            for (let uid = 0; uid < 60; uid += 1) expect(runsHoldUid(runs, uid)).toBe(uids.includes(String(uid)));
        }
    });
});
