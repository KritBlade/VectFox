/**
 * ============================================================================
 * OPENROUTER MODEL PRICE
 * ============================================================================
 * A model's price per token, from OpenRouter's public model list, which needs
 * no key. VectFox shows a price only where it can read one: a model run on
 * manual OpenRouter. Any other model, on a connection profile or vLLM, has no
 * price VectFox can know, so the caller shows tokens alone.
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';

/**
 * A model's price per token on OpenRouter. A prompt is priced at the cache-write price where the model has one, as a
 * whole StoryArc link pass on GPT-6 Luna was billed.
 *
 * @param {string} modelId - The model's OpenRouter ID
 * @returns {Promise<{input: number, output: number}|null>} null when the list has no price for it, or could not be read
 */
export async function readOpenRouterModelPrice(modelId) {
    if (!modelId) return null;
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { data } = await response.json();
        const pricing = (data ?? []).find(model => model.id === modelId)?.pricing;
        const input = Number(pricing?.input_cache_write ?? pricing?.prompt);
        const output = Number(pricing?.completion);
        return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
    } catch (err) {
        log.warn(`[VectFox] Could not read the price of ${modelId} from OpenRouter:`, err);
        return null;
    }
}
