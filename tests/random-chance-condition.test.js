/**
 * Random Chance condition: passes with the configured probability — 0 never,
 * 100 always — and 50% of the time when no probability is set.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({
    log: new Proxy({}, { get: () => () => {} }),
}));

import { evaluateConditionRule } from '../src/features/collections/conditional-activation.js';

/** Pins Math.random() so the roll (Math.random() * 100) is known. */
const rollAt = (value) => vi.spyOn(Math, 'random').mockReturnValue(value);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('randomChance condition', () => {
    it('never passes at probability 0, even on the lowest roll', () => {
        rollAt(0);
        expect(evaluateConditionRule({ type: 'randomChance', settings: { probability: 0 } }, {})).toBe(false);
    });

    it('always passes at probability 100, even on the highest roll', () => {
        rollAt(0.999999);
        expect(evaluateConditionRule({ type: 'randomChance', settings: { probability: 100 } }, {})).toBe(true);
    });

    it('passes on rolls below the configured percentage and fails from it up', () => {
        rollAt(0.299);
        expect(evaluateConditionRule({ type: 'randomChance', settings: { probability: 30 } }, {})).toBe(true);
        rollAt(0.3);
        expect(evaluateConditionRule({ type: 'randomChance', settings: { probability: 30 } }, {})).toBe(false);
    });

    it('reads a legacy rule.value, including 0', () => {
        rollAt(0);
        expect(evaluateConditionRule({ type: 'randomChance', value: '0' }, {})).toBe(false);
        rollAt(0.249);
        expect(evaluateConditionRule({ type: 'randomChance', value: '25' }, {})).toBe(true);
    });

    it('uses 50% when no probability is set', () => {
        rollAt(0.49);
        expect(evaluateConditionRule({ type: 'randomChance', settings: {} }, {})).toBe(true);
        rollAt(0.5);
        expect(evaluateConditionRule({ type: 'randomChance', settings: {} }, {})).toBe(false);
    });
});
