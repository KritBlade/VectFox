/**
 * ============================================================================
 * VectFox QUERY TESTER
 * ============================================================================
 * Dry-runs EventBase's retrieval against a test message, with the current settings and locked collections (Agent Mode
 * and StoryArc included), and returns what it would inject. Nothing reaches the prompt. Diagnostics' Query Tester page
 * shows the result (diagnostics-dialog.js).
 *
 * @author Kritblade
 * ============================================================================
 */

/**
 * @param {string} testMessage
 * @returns {Promise<{eventBase: object|null, eventBaseThreshold: number}>}
 */
export async function runQueryTest(testMessage) {
    // Loaded on the first test, so the retrieval feature stays out of the dialog's own load.
    const [
        { extension_settings },
        { chatMessages },
        { runEventBaseRetrieval },
    ] = await Promise.all([
        import('../../sillytavern/settings.js'),
        import('../../shared/chat-messages.js'),
        import('../eventbase/index.js'),
    ]);
    const settings = extension_settings.vectfox;
    const eventBase = await runEventBaseRetrieval({ chat: chatMessages(), searchText: testMessage, settings, dryRun: true, testMessage });
    return { eventBase, eventBaseThreshold: Number(settings.eventbase_score_threshold) || 0 };
}
