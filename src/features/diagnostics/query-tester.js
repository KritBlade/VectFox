/**
 * ============================================================================
 * VectFox QUERY TESTER
 * ============================================================================
 * Dry-runs the two retrievals (EventBase, ChunkBase) against a test message, with the current settings
 * and locked collections (Agent Mode and StoryArc included), and returns what each would inject. Nothing reaches the
 * prompt. Diagnostics' Query Tester page shows the result (diagnostics-dialog.js).
 *
 * @author Kritblade
 * ============================================================================
 */

/**
 * @param {string} testMessage
 * @returns {Promise<{eventBase: object|null, chunkBase: object|null, eventBaseThreshold: number}>}
 */
export async function runQueryTest(testMessage) {
    // Loaded on the first test, so the retrieval features stay out of the dialog's own load.
    const [
        { extension_settings },
        { getContext },
        { runEventBaseRetrieval },
        { rearrangeChat },
    ] = await Promise.all([
        import('../../sillytavern/settings.js'),
        import('../../sillytavern/chat.js'),
        import('../eventbase/index.js'),
        import('../chunkbase/index.js'),
    ]);
    const settings = extension_settings.vectfox;
    const { chat } = getContext();
    const [eventBase, chunkBase] = await Promise.all([
        runEventBaseRetrieval({ chat, searchText: testMessage, settings, dryRun: true, testMessage }),
        rearrangeChat(chat, settings, 'normal', { dryRun: true, testMessage }),
    ]);
    return { eventBase, chunkBase, eventBaseThreshold: Number(settings.eventbase_score_threshold) || 0 };
}
