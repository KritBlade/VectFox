// features/llm-provider — the chat-completions calls of EventBase extraction, AgentMode retrieval, StoryArc and
// LoreBase, on manual OpenRouter and vLLM or on a SillyTavern connection profile; the check that their settings or
// profile can run, the sentence for one that cannot, and what a profile readout shows; the connection Agent Mode takes
// from the EventBase model; the fixed message each consumer's Test connection sends; and a model's price on OpenRouter.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { resolveConnectionProfileId } from './connection-profile-core.js';
export { CONNECTION_TEST_MAX_TOKENS, CONNECTION_TEST_PROMPT, CONNECTION_TEST_TIMEOUT_MS, sendConnectionTest } from './connection-test.js';
export { resolveInheritedConnection } from './inherited-connection.js';
export { describeConnectionProblem, resolveLlmConnection, shownVllmUrl } from './llm-connection.js';
export { validateLLMConfig } from './llm-config-validation.js';
export { readOpenRouterModelPrice } from './openrouter-model-price.js';
export {
    LlmCallError,
    describeChatConnectionProfile,
    parseJsonArrayFromLlm,
    postChatCompletion,
    resolveModelParameterStyle,
} from './llm-provider-call.js';
