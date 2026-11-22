/**
 * How SillyTavern's World Info scan activated each entry, read while a reply's scan runs
 * (src/sillytavern/world-info-activations.js): the reader passes every console.debug call on as it came; it reads only
 * between a start and a stop; it goes back on top at a start when another extension wrapped console.debug since; a
 * scan whose lines another wrapper held back leaves every entry with nothing read, which the console says once; each
 * entry gets the loop it went in from WORLDINFO_SCAN_DONE; and a dry scan is left unread.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ listeners: {} }));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: { on: vi.fn((event, listener) => { (host.listeners[event] ??= []).push(listener); }) },
    event_types: { WORLDINFO_SCAN_DONE: 'worldinfo_scan_done' },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));

const { log } = await import('../src/sillytavern/log.js');
const { activationOf, startReadingActivations, stopReadingActivations } = await import('../src/sillytavern/world-info-activations.js');

const START = '[WI] --- START WI SCAN (on 12 messages, trigger = normal) ---';
const DRY_START = '[WI] --- START WI SCAN (on 12 messages, trigger = normal) (DRY RUN) ---';
const lighthouse = { uid: 21, world: 'Harbor Atlas', key: ['lighthouse', 'lamp'] };
const keeper = { uid: 7, world: 'Keeper Notes', key: ['keeper'] };
const scanLines = (start = START) => [
    [start],
    [`[WI] Entry ${lighthouse.uid}`, `from '${lighthouse.world}' processing`, lighthouse],
    [`[WI] Entry ${lighthouse.uid}`, 'activated by primary key match', 'lamp'],
];
const print = lines => lines.forEach(args => console.debug(...args));
const loopDone = (loop, entries) => host.listeners.worldinfo_scan_done?.forEach(listener => listener({ state: { loopCount: loop }, new: { successful: entries } }));

const nativeDebug = console.debug;
let shown;

beforeEach(() => {
    vi.clearAllMocks();
    stopReadingActivations();
    shown = vi.fn();
    console.debug = shown;
});

afterAll(() => {
    console.debug = nativeDebug;
});

describe('reading a scan', () => {
    it('passes every call on as it came, and reads only between a start and a stop', () => {
        startReadingActivations();
        const other = { note: 'an object' };
        console.debug('VectFox: an unrelated line', other);
        print(scanLines());
        stopReadingActivations();
        expect(shown).toHaveBeenCalledTimes(4);
        expect(shown.mock.calls[0]).toEqual(['VectFox: an unrelated line', other]);
        expect(shown.mock.calls[3]).toEqual(scanLines()[2]);
        expect(activationOf(lighthouse)).toEqual({ primaryKey: 'lamp' });

        print([...scanLines(), [`[WI] Entry ${keeper.uid}`, `from '${keeper.world}' processing`, keeper]]);
        expect(activationOf(keeper)).toBeNull();
        expect(activationOf(lighthouse)).toEqual({ primaryKey: 'lamp' });
    });

    it('gives each entry the loop it went in, and leaves a dry scan unread', () => {
        startReadingActivations();
        print(scanLines());
        loopDone(1, [lighthouse]);
        loopDone(2, [keeper]);
        stopReadingActivations();
        expect(activationOf(lighthouse)).toEqual({ primaryKey: 'lamp', loop: 1 });
        expect(activationOf(keeper)).toEqual({ loop: 2 });

        startReadingActivations();
        print(scanLines(DRY_START));
        loopDone(1, [lighthouse]);
        stopReadingActivations();
        expect(activationOf(lighthouse)).toBeNull();
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('reads nothing under a wrapper that holds back the lines, says so once, and goes back on top at the next start', () => {
        startReadingActivations();
        const below = console.debug;
        console.debug = (...args) => { if (!String(args[0]).startsWith('[WI]')) below(...args); };
        print(scanLines());
        loopDone(1, [lighthouse]);
        stopReadingActivations();
        expect(activationOf(lighthouse)).toEqual({ loop: 1 });
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no line of SillyTavern'));

        startReadingActivations();
        print(scanLines());
        loopDone(1, [lighthouse]);
        stopReadingActivations();
        expect(activationOf(lighthouse)).toEqual({ primaryKey: 'lamp', loop: 1 });

        startReadingActivations();
        console.debug = () => {};
        loopDone(1, [lighthouse]);
        stopReadingActivations();
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});
