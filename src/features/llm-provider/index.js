// features/llm-provider — the chat-completions calls of EventBase extraction, AgentMode retrieval and
// Auto-Reformat, and the check that their provider settings are filled in.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { validateLLMConfig } from './llm-config-validation.js';
export {
    LlmCallError,
    parseJsonArrayFromLlm,
    postChatCompletion,
    resolveModelParameterStyle,
} from './llm-provider-call.js';
