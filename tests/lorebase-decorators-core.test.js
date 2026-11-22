/**
 * SillyTavern's decorators, read as its World Info scan reads them (src/features/lorebase/lorebase-decorators-core.js,
 * parseDecorators in world-info.js, SillyTavern 1.19.0, plan §5.2 and §5.7 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): the content a scanned entry sends, and the decorator by which the scan
 * decides an entry whatever its keys.
 */
import { describe, expect, it } from 'vitest';
import {
    ACTIVATE_DECORATOR, DONT_ACTIVATE_DECORATOR, activationDecoratorOf, withoutDecoratorLines,
} from '../src/features/lorebase/lorebase-decorators-core.js';

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

describe('activationDecoratorOf', () => {
    it('reads @@activate and @@dont_activate among the lines that open an entry, @@activate first, as the scan does', () => {
        expect(activationDecoratorOf('@@activate\nThe lamp burns.')).toBe(ACTIVATE_DECORATOR);
        expect(activationDecoratorOf('@@if wren_is_here\n@@dont_activate\nThe lamp burns.')).toBe(DONT_ACTIVATE_DECORATOR);
        expect(activationDecoratorOf('@@dont_activate\n@@activate\nThe lamp burns.')).toBe(ACTIVATE_DECORATOR);
    });

    it('reads a line starting @@@ only as the fallback of an unknown decorator just before it', () => {
        expect(activationDecoratorOf('@@if wren_is_here\n@@@activate\nThe lamp burns.')).toBe(ACTIVATE_DECORATOR);
        expect(activationDecoratorOf('@@@activate\nThe lamp burns.')).toBeNull();
        expect(activationDecoratorOf('@@dont_activate\n@@@activate\nThe lamp burns.')).toBe(DONT_ACTIVATE_DECORATOR);
    });

    it('finds none below the text, in an unknown decorator, or in a line the scan does not read as written', () => {
        expect(activationDecoratorOf('The lamp burns.\n@@activate')).toBeNull();
        expect(activationDecoratorOf('@@if wren_is_here\nThe lamp burns.')).toBeNull();
        expect(activationDecoratorOf('@@activate_at_dusk\nThe lamp burns.')).toBeNull();
        expect(activationDecoratorOf('@@activate \nThe lamp burns.')).toBeNull();
        expect(activationDecoratorOf('')).toBeNull();
        expect(activationDecoratorOf(undefined)).toBeNull();
    });
});
