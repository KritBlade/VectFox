/**
 * The last generation past its slash commands, and what it says of a quiet generation (D4 of
 * InternalProject/Vectfox/plans/executed/vectfox-public-api.md). A quiet generation is quiet-to-loud when it is shown as a reply;
 * any other quiet generation is a quiet prompt, whose caller builds its own prompt: a summary, an emotion, an image
 * prompt, another extension's background job. SillyTavern passes the generation interceptor a generation's type alone,
 * and GENERATION_AFTER_COMMANDS, which fires just before the interceptors run, carries whether a quiet one is
 * quiet-to-loud (last-generation.js keeps it). Pure: no SillyTavern.
 */

const QUIET_GENERATION_TYPE = 'quiet';

/** @typedef {{type: string, isQuietToLoud: boolean}} GenerationPastCommands */

/**
 * A generation past its slash commands, from GENERATION_AFTER_COMMANDS's arguments.
 * @param {string} type - The generation's type
 * @param {{quietToLoud?: boolean}|undefined} options - The generation's options
 * @returns {GenerationPastCommands}
 */
export function generationPastCommands(type, options) {
    return { type, isQuietToLoud: Boolean(options?.quietToLoud) };
}

/**
 * Whether a generation the interceptor runs for is quiet-to-loud.
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {GenerationPastCommands|null} lastGeneration - The last generation past its slash commands
 * @returns {boolean}
 */
export function isQuietToLoud(type, lastGeneration) {
    return type === QUIET_GENERATION_TYPE && lastGeneration?.type === QUIET_GENERATION_TYPE && lastGeneration.isQuietToLoud === true;
}

/**
 * Whether a generation the interceptor runs for is a quiet prompt: quiet, and not quiet-to-loud.
 * @param {string} type - The generation's type, as SillyTavern passes the generation interceptor
 * @param {GenerationPastCommands|null} lastGeneration - The last generation past its slash commands
 * @returns {boolean}
 */
export function isQuietPrompt(type, lastGeneration) {
    return type === QUIET_GENERATION_TYPE && !isQuietToLoud(type, lastGeneration);
}
