/**
 * Keeps the last generation past its slash commands, for the readers that act on a generation by its kind: LoreBase's
 * pick and EventBase's reply step, which the generation interceptor runs (last-generation-core.js says what it means).
 */
import { eventSource, event_types } from '../sillytavern/events.js';
import { generationPastCommands } from './last-generation-core.js';

/** @type {import('./last-generation-core.js').GenerationPastCommands|null} */
let lastGeneration = null;

/** Follow each generation past its slash commands. Called once at start-up, before the readers. */
export function followGenerations() {
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, options, isDryRun) => {
        // A dry run reaches no interceptor, so it must not stand in for the generation that does.
        if (isDryRun) return;
        lastGeneration = generationPastCommands(type, options);
    });
}

/** @returns {import('./last-generation-core.js').GenerationPastCommands|null} the last generation past its slash commands */
export function lastGenerationPastCommands() {
    return lastGeneration;
}
