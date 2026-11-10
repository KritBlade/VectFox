// features/llm-provider — the chat-completions calls of EventBase extraction, AgentMode retrieval and
// Auto-Reformat, the check that their provider settings are filled in, and the connection Agent Mode and
// Auto-Reformat take from the EventBase model.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { resolveInheritedConnection } from './inherited-connection.js';
export { validateLLMConfig } from './llm-config-validation.js';
export {
    LlmCallError,
    parseJsonArrayFromLlm,
    postChatCompletion,
    resolveModelParameterStyle,
} from './llm-provider-call.js';
