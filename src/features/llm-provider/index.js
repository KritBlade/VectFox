// features/llm-provider — the chat-completions calls of EventBase extraction, AgentMode retrieval, StoryArc and
// LoreBase, on manual OpenRouter and vLLM or on a SillyTavern connection profile; the check that their settings or
// profile can run, the sentence for one that cannot, and what a profile readout shows; the connection Agent Mode takes
// from the EventBase model; the fixed message each consumer's Test connection sends; a model's price on OpenRouter; and
// the report of each call that ended, LoreBase's Jev calls through Similharity included, to a listener set at start-up,
// and the signal each call's request is sent with, handed to a marker set at start-up that may mark it.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { resolveConnectionProfileId } from './connection-profile-core.js';
export { CONNECTION_TEST_MAX_TOKENS, CONNECTION_TEST_PROMPT, CONNECTION_TEST_TIMEOUT_MS, sendConnectionTest } from './connection-test.js';
export { resolveInheritedConnection } from './inherited-connection.js';
export {
    LLM_CALL_CONNECTIONS,
    LLM_CALL_FEATURES,
    LLM_CALL_OUTCOMES,
    outcomeOfFailedCall,
    ownRequestSignal,
    reportLlmCallFinished,
    setLlmCallFinishedListener,
    setOwnRequestMarker,
} from './llm-call-report.js';
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
