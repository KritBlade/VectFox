/**
 * WebLLM Vector Provider - Singleton Pattern
 *
 * This provider manages the WebLLM engine for embedding generation.
 * Uses singleton pattern to ensure only one engine instance exists across
 * the entire application (both core-vector-api and ui-manager).
 */
class WebLlmVectorProvider {
    /** @type {object?} WebLLM engine */
    #engine = null;

    constructor() {
        this.#engine = null;
    }

    /**
     * Check if WebLLM is available and up-to-date
     * @throws {Error} If WebLLM is not available or not up-to-date
     */
    #checkWebLlm() {
        if (!Object.hasOwn(SillyTavern, 'llm')) {
            throw new Error('WebLLM is not available', { cause: 'webllm-not-available' });
        }

        if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
            throw new Error('WebLLM is not updated', { cause: 'webllm-not-updated' });
        }
    }

    /**
     * Initialize the engine with a model.
     * @param {string} modelId Model ID to initialize the engine with
     * @returns {Promise<void>} Promise that resolves when the engine is initialized
     */
    #initEngine(modelId) {
        this.#checkWebLlm();
        if (!this.#engine) {
            this.#engine = SillyTavern.llm.getEngine();
        }

        return this.#engine.loadModel(modelId);
    }

    /**
     * Get available models.
     * @returns {{id:string, toString: function(): string}[]} Array of available models
     */
    getModels() {
        this.#checkWebLlm();
        return SillyTavern.llm.getEmbeddingModels();
    }

    /**
     * Generate embeddings for a list of texts.
     * @param {string[]} texts Array of texts to generate embeddings for
     * @param {string} modelId Model to use for generating embeddings
     * @returns {Promise<number[][]>} Array of embeddings for each text
     */
    async embedTexts(texts, modelId) {
        await this.#initEngine(modelId);
        return this.#engine.generateEmbedding(texts);
    }

    /**
     * Loads a model into the engine.
     * @param {string} modelId Model ID to load
     */
    async loadModel(modelId) {
        await this.#initEngine(modelId);
    }

    /**
     * Check if the engine has a model loaded
     * @returns {boolean} True if a model is loaded
     */
    hasLoadedModel() {
        return this.#engine !== null;
    }
}

// Singleton instance - shared across all imports
let singletonInstance = null;

/**
 * Get the shared WebLLM provider instance (singleton).
 * Use this instead of creating new instances to ensure engine state is shared.
 * @returns {WebLlmVectorProvider} The shared provider instance
 */
export function getWebLlmProvider() {
    if (!singletonInstance) {
        singletonInstance = new WebLlmVectorProvider();
    }
    return singletonInstance;
}

// Export class for type checking (but prefer getWebLlmProvider() for instances)
export { WebLlmVectorProvider };
