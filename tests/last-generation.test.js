/**
 * The last generation past its slash commands (src/shared/last-generation.js and last-generation-core.js), which says
 * whether a quiet generation is quiet-to-loud, shown as a reply, or a quiet prompt, whose caller builds its own prompt
 * (D4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md). SillyTavern passes the interceptor the type alone, so
 * the follower keeps what GENERATION_AFTER_COMMANDS carried, and a dry run, which reaches no interceptor, never stands
 * in for the generation that does.
 */
import { describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ listeners: {} }));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: { on: (event, listener) => { (host.listeners[event] ??= []).push(listener); } },
    event_types: { GENERATION_AFTER_COMMANDS: 'generation_after_commands' },
}));

const { generationPastCommands, isQuietPrompt, isQuietToLoud } = await import('../src/shared/last-generation-core.js');
const { followGenerations, lastGenerationPastCommands } = await import('../src/shared/last-generation.js');

describe('a quiet generation', () => {
    it('is quiet-to-loud only when the generation past its commands was quiet and said so', () => {
        expect(isQuietToLoud('quiet', { type: 'quiet', isQuietToLoud: true })).toBe(true);
        expect(isQuietToLoud('quiet', { type: 'quiet', isQuietToLoud: false })).toBe(false);
        expect(isQuietToLoud('quiet', null)).toBe(false);
        // A record another kind of generation left says nothing about this one.
        expect(isQuietToLoud('quiet', { type: 'continue', isQuietToLoud: true })).toBe(false);
        expect(isQuietToLoud('normal', { type: 'normal', isQuietToLoud: true })).toBe(false);
    });

    it('is a quiet prompt unless it is quiet-to-loud, and no other kind of generation is one', () => {
        expect(isQuietPrompt('quiet', { type: 'quiet', isQuietToLoud: false })).toBe(true);
        expect(isQuietPrompt('quiet', null)).toBe(true);
        expect(isQuietPrompt('quiet', { type: 'quiet', isQuietToLoud: true })).toBe(false);
        for (const type of ['normal', 'swipe', 'regenerate', 'continue', 'impersonate']) expect(isQuietPrompt(type, null), type).toBe(false);
    });

    it('reads its flag from GENERATION_AFTER_COMMANDS\'s options', () => {
        expect(generationPastCommands('quiet', { quietToLoud: true })).toEqual({ type: 'quiet', isQuietToLoud: true });
        expect(generationPastCommands('normal', undefined)).toEqual({ type: 'normal', isQuietToLoud: false });
    });
});

describe('followGenerations', () => {
    it('keeps the last generation past its commands, and a dry run does not stand in for it', () => {
        followGenerations();
        const afterCommands = (...args) => host.listeners.generation_after_commands.forEach(listener => listener(...args));

        expect(lastGenerationPastCommands()).toBeNull();
        afterCommands('quiet', { quietToLoud: true }, false);
        expect(lastGenerationPastCommands()).toEqual({ type: 'quiet', isQuietToLoud: true });
        afterCommands('normal', {}, true);
        expect(lastGenerationPastCommands()).toEqual({ type: 'quiet', isQuietToLoud: true });
        afterCommands('quiet', {}, false);
        expect(lastGenerationPastCommands()).toEqual({ type: 'quiet', isQuietToLoud: false });
    });
});
