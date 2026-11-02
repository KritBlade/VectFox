/**
 * ============================================================================
 * VectFox DIAGNOSTICS - ACTIVATION TESTS
 * ============================================================================
 * Comprehensive tests for conditional activation system
 * Tests all 10 condition types + activation triggers + chunk-only features
 * Returns individual test results for each condition type
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

/**
 * Test: Conditional activation system - returns array of individual test results
 * Each test is a separate diagnostic item for clearer reporting
 */
export async function testConditionalActivation() {
    const results = [];

    try {
        const {
            evaluateConditions,
            evaluateConditionRule,
            buildSearchContext,
            filterChunksByConditions,
            validateConditionRule,
            processChunkLinks
        } = await import('../src/features/collections/conditional-activation.js');

        // Build mock context for all tests
        const mockChat = [
            { mes: 'Hello there!', name: 'User', is_user: true },
            { mes: 'Hi! How are you doing today?', name: 'Luna', is_user: false },
            { mes: 'I am feeling happy and excited today!', name: 'User', is_user: true },
            { mes: '*smiles warmly* That makes me so glad to hear!', name: 'Luna', is_user: false },
            { mes: 'Do you want to go on an adventure?', name: 'User', is_user: true }
        ];

        const context = buildSearchContext(mockChat, 10, [], {
            generationType: 'normal',
            isGroupChat: false,
            currentCharacter: 'Luna',
            activeLorebookEntries: [{ key: 'adventure', uid: '123' }]
        });

        // Helper to add test result
        const addTest = (name, passed, detail = '') => {
            results.push({
                name: `Condition: ${name}`,
                status: passed ? 'pass' : 'fail',
                message: passed ? (detail || 'Test passed') : (detail || 'Test failed'),
                category: 'production'
            });
        };

        // Test: Context building
        addTest('Context Build', context.recentMessages?.length === 5, `Built context with ${context.recentMessages?.length || 0} messages`);

        // Test: No conditions (should always pass)
        const chunkNoConditions = { text: 'test', hash: 12345 };
        addTest('No Conditions', evaluateConditions(chunkNoConditions, context) === true, 'Chunks without conditions pass');

        // Test: Pattern condition
        const patternRule = { type: 'pattern', settings: { patterns: ['happy', 'excited'], matchMode: 'any', caseSensitive: false } };
        addTest('Pattern Match', evaluateConditionRule(patternRule, context) === true, 'Found "happy"/"excited" in chat');

        // Test: Pattern with regex
        const patternRegexRule = { type: 'pattern', settings: { patterns: ['/adventur\\w*/i'], matchMode: 'any' } };
        addTest('Pattern Regex', evaluateConditionRule(patternRegexRule, context) === true, 'Regex /adventur\\w*/i matched');

        // Test: Speaker condition
        const speakerRule = { type: 'speaker', settings: { values: ['User'], matchType: 'any' } };
        addTest('Speaker', evaluateConditionRule(speakerRule, context) === true, 'Found User in speakers');

        // Test: Message count
        const messageCountRule = { type: 'messageCount', settings: { count: 3, operator: 'gte' } };
        addTest('Message Count', evaluateConditionRule(messageCountRule, context) === true, 'Chat has >= 3 messages');

        // Test: Character present
        const charPresentRule = { type: 'characterPresent', settings: { values: ['Luna'], matchType: 'any' } };
        addTest('Character Present', evaluateConditionRule(charPresentRule, context) === true, 'Luna is present');

        // Test: Generation type
        const genTypeRule = { type: 'generationType', settings: { values: ['normal'], matchType: 'any' } };
        addTest('Generation Type', evaluateConditionRule(genTypeRule, context) === true, 'Type is "normal"');

        // Test: Is group chat
        const isGroupRule = { type: 'isGroupChat', settings: { isGroup: false } };
        addTest('Group Chat', evaluateConditionRule(isGroupRule, context) === true, 'Not a group chat');

        // Test: Lorebook active
        const lorebookRule = { type: 'lorebookActive', settings: { values: ['adventure'], matchType: 'any' } };
        addTest('Lorebook Active', evaluateConditionRule(lorebookRule, context) === true, '"adventure" entry active');

        // Test: Random chance (100% should always pass)
        const randomRule100 = { type: 'randomChance', settings: { probability: 100 } };
        addTest('Random Chance', evaluateConditionRule(randomRule100, context) === true, '100% probability passed');

        // Test: Time of day (always valid range)
        const timeRule = { type: 'timeOfDay', settings: { startTime: '00:00', endTime: '23:59' } };
        addTest('Time of Day', evaluateConditionRule(timeRule, context) === true, 'Within 00:00-23:59');

        // Test: Swipe count
        const swipeContext = { ...context, swipeCount: 2 };
        const swipeRule = { type: 'swipeCount', settings: { count: 1, operator: 'gte' } };
        addTest('Swipe Count', evaluateConditionRule(swipeRule, swipeContext) === true, 'Swipe count >= 1');

        // Test: Score threshold
        const scoreContext = { ...context, currentChunkScore: 0.75, currentChunkHash: 12345 };
        const scoreRule = { type: 'scoreThreshold', settings: { threshold: 0.5 } };
        addTest('Score Threshold', evaluateConditionRule(scoreRule, scoreContext) === true, '0.75 >= 0.5 threshold');

        // Test: Recency
        const recencyContext = { ...context, messageCount: 100, currentChunkMessageIndex: 20 };
        const recencyRule = { type: 'recency', settings: { messagesAgo: 50, operator: 'gte' } };
        addTest('Recency', evaluateConditionRule(recencyRule, recencyContext) === true, 'Chunk is >= 50 msgs old');

        // Test: Frequency
        const frequencyContext = { ...context, currentChunkHash: 99999, activationHistory: { 99999: { count: 1, lastActivation: 90 } }, messageCount: 100 };
        const frequencyRule = { type: 'frequency', settings: { maxActivations: 3, cooldownMessages: 5 } };
        addTest('Frequency', evaluateConditionRule(frequencyRule, frequencyContext) === true, 'Under max activations');

        // Test: AND logic
        const chunkWithAndLogic = { text: 'test', hash: 55555, conditions: { enabled: true, logic: 'AND', rules: [
            { type: 'messageCount', settings: { count: 3, operator: 'gte' } },
            { type: 'isGroupChat', settings: { isGroup: false } }
        ]}};
        addTest('AND Logic', evaluateConditions(chunkWithAndLogic, context) === true, 'Both conditions passed');

        // Test: OR logic
        const chunkWithOrLogic = { text: 'test', hash: 66666, conditions: { enabled: true, logic: 'OR', rules: [
            { type: 'messageCount', settings: { count: 1000, operator: 'gte' } },
            { type: 'isGroupChat', settings: { isGroup: false } }
        ]}};
        addTest('OR Logic', evaluateConditions(chunkWithOrLogic, context) === true, 'One condition passed');

        // Test: Negation
        const negatedRule = { type: 'isGroupChat', settings: { isGroup: true }, negate: true };
        addTest('Negation', evaluateConditionRule(negatedRule, context) === true, 'NOT isGroupChat worked');

        // Test: Chunk links (soft)
        const chunks = [{ hash: 1001, score: 0.8, text: 'A' }, { hash: 1002, score: 0.6, text: 'B' }];
        const chunkMetadataMap = { 1001: { chunkLinks: [{ targetHash: '1002', mode: 'soft' }] }, 1002: {} };
        const linkResult = processChunkLinks(chunks, chunkMetadataMap, 0.15);
        const boostedChunk = linkResult.chunks.find(c => c.hash === 1002);
        addTest('Soft Links', boostedChunk?.softLinked && boostedChunk?.score > 0.6, 'Soft-linked chunk boosted');

        // Test: Chunk links (hard)
        const chunks2 = [{ hash: 2001, score: 0.8, text: 'A' }];
        const chunkMetadataMap2 = { 2001: { chunkLinks: [{ targetHash: '2002', mode: 'force' }] } };
        const linkResult2 = processChunkLinks(chunks2, chunkMetadataMap2, 0.15);
        addTest('Hard Links', linkResult2.missingHardLinks?.includes(2002), 'Missing hard link detected');

        // Test: Filter chunks
        const chunksToFilter = [
            { hash: 1, text: 'A', score: 0.8 },
            { hash: 2, text: 'B', score: 0.7, conditions: { enabled: true, logic: 'AND', rules: [{ type: 'messageCount', settings: { count: 3, operator: 'gte' } }] } },
            { hash: 3, text: 'C', score: 0.6, conditions: { enabled: true, logic: 'AND', rules: [{ type: 'messageCount', settings: { count: 1000, operator: 'gte' } }] } }
        ];
        const filtered = filterChunksByConditions(chunksToFilter, context);
        addTest('Filter Chunks', filtered.length === 2, `Filtered to ${filtered.length} chunks (expected 2)`);

        // Test: Validation (valid rule)
        const validRule = { type: 'pattern', settings: { patterns: ['test'] } };
        addTest('Validation Valid', validateConditionRule(validRule).valid, 'Valid rule accepted');

        // Test: Validation (invalid rule)
        const invalidRule = { type: 'messageCount', settings: { count: -5 } };
        addTest('Validation Invalid', !validateConditionRule(invalidRule).valid, 'Invalid rule rejected');

        return results;

    } catch (error) {
        return [{
            name: 'Conditional Activation',
            status: 'fail',
            message: `Test error: ${error.message}`,
            category: 'production'
        }];
    }
}

