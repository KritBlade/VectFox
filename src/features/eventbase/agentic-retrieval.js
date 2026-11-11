/**
 * ============================================================================
 * AGENTIC RETRIEVAL
 * ============================================================================
 * The two optional modes around the ordinary pre-search, both Qdrant (A3) only.
 *
 * StoryArc mode adds a router alongside the pre-search. When the player asks
 * about the story's past, a recipe (story-arc-retrieval.js) answers with events in
 * time order. Any other turn keeps the pre-search, and a StoryArc turn reports the
 * Route rule that decided it in `debug.storyArc`. No planner runs under this mode.
 *
 * Agent Mode, with StoryArc mode off, adds an LLM planner alongside the pre-search.
 * It reads recent chat and writes follow-up queries, which run in parallel. The
 * pre-search keeps every seat it won, and the queries add a few from outside its
 * results (planner-seats-core.js).
 *
 * Every failure path falls back to the pre-search output, and Agent Mode says so:
 * a setup it cannot run on raises one sticky warning, and a planner or search that
 * fails on a turn counts as that turn's failed memory search.
 * ============================================================================
 */

import { getContext } from '../../sillytavern/chat.js';
import { isDuplicateEvent, removeEventsVisibleInContext, retrieveEvents } from './eventbase-retrieval.js';
import { seatPlannerHits } from './planner-seats-core.js';
import { searchEventCollection } from './eventbase-search.js';
import { buildPlannerUserMessage, getAgenticPlannerPrompt } from './prompts-i18n.js';
import { cleanText, stripReasoningBlocks, stripGameSystemBlocks } from '../text-cleaning/index.js';
import { getOpenRouterApiKey, getCustomApiKey } from '../../shared/api-keys.js';
import { checkConnectionProfile, postChatCompletion, resolveConnectionProfileId, resolveInheritedConnection, resolveModelParameterStyle, sendConnectionTest, LlmCallError } from '../llm-provider/index.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { resolveAgenticPlannerTimeoutMs, resolveAgenticQueryTimeoutMs, resolveAgenticMaxTokens } from '../../shared/retrieval-budget.js';
import { ORDINARY_TURN_ROUTE, STORY_ROUTER_PROMPT, STORY_ROUTE_RULE, THREAD_PICK_PROMPT, buildBlockCutMessage, buildBlockCutPrompt, buildStoryRouterMessage, buildThreadPickMessage, hasRecipe, isOrdinaryTurn, isStoryArcActive, listStoryThreads, readBlockCut, readStoryRoute, readThreadPick } from './story-arc-core.js';
import { retrieveStoryRecipeEvents, startStoryRecipeReads } from './story-arc-retrieval.js';
import { isInvalidModelConfigError, notifyInvalidModel, notifySetupIncomplete } from '../../shared/model-config-notifier.js';
import { log } from '../../sillytavern/log.js';

const AGENT_MODE = 'Agent Mode';
const NORMAL_SEARCH_ONLY = 'Until then each turn uses the normal memory search only.';
const AGENT_MODE_NEEDS_QDRANT = `Agent Mode is on, but it needs the Qdrant backend. Pick Qdrant in Vector Backend on the Core page, or turn Agent Mode off. ${NORMAL_SEARCH_ONLY}`;

// What each reason resolveLlmConnection gives means, and where it is fixed.
const AGENT_MODE_SETUP_FIXES = {
    missing_model: 'it has no model. Set Model on the AgentMode page, or under EventBase model on the Core page.',
    missing_openrouter_api_key: 'it runs on OpenRouter and no OpenRouter key is saved. Enter the key on the AgentMode or Core page.',
    missing_vllm_url: 'it runs on vLLM with no URL. Set Base URL on the AgentMode page, or under EventBase model on the Core page.',
    missing_vllm_api_key: 'it runs on vLLM and no vLLM key is saved. Enter the key on the AgentMode or Core page.',
};
const UNKNOWN_PROVIDER_PREFIX = 'unknown_provider_';
// The reason of a connection whose SillyTavern profile cannot be used; its `problem` says why and where to fix it.
const CONNECTION_PROFILE_REASON = 'connection_profile';

/**
 * The sentence for a planner connection that cannot run: what is wrong and where to fix it.
 *
 * @param {string} reason - From resolveLlmConnection
 * @param {string} [problem] - From resolveLlmConnection, for a profile that cannot be used
 * @returns {string}
 */
export function describeAgentModeSetupProblem(reason, problem = '') {
    if (reason === CONNECTION_PROFILE_REASON) return `${problem} ${NORMAL_SEARCH_ONLY}`;
    const fix = reason.startsWith(UNKNOWN_PROVIDER_PREFIX)
        ? `its provider "${reason.slice(UNKNOWN_PROVIDER_PREFIX.length)}" is not one VectFox knows. Pick a provider on the AgentMode page.`
        : AGENT_MODE_SETUP_FIXES[reason] ?? `its connection cannot run (${reason}). Check the AgentMode page.`;
    return `Agent Mode is on, but ${fix} ${NORMAL_SEARCH_ONLY}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Retrieval's entry point, which decides a turn's path: StoryArc mode if it is on, then
 * Agent Mode if it is on, and otherwise the pre-search alone, so callers need no other gate.
 *
 * @param {object} params - Same shape as retrieveEvents params
 * @returns {Promise<{events: object[], debug: object}>}
 */
export async function retrieveEventsForTurn(params) {
    const { settings } = params;
    if (isStoryArcActive(settings)) {
        return _retrieveWithStoryArc(params);
    }
    if (!settings?.agentic_retrieval_enabled) {
        return retrieveEvents(params);
    }
    if (settings.vector_backend !== 'qdrant') {
        notifySetupIncomplete(AGENT_MODE, AGENT_MODE_NEEDS_QDRANT);
        return retrieveEvents(params);
    }
    return _retrieveWithPlanner(params);
}

/**
 * StoryArc mode: a question about the story's past is answered by its recipe, which
 * skips the rerank, and an ordinary turn by the chain block with no LLM call. A turn
 * whose block finds nothing, or the router fails, keeps the pre-search, and no planner runs.
 *
 * @param {object} params - The retrieval params
 * @returns {Promise<{events: object[], debug: object, storyArcShape?: string, storyArcEntityNames?: object[]}>}
 */
async function _retrieveWithStoryArc(params) {
    const { settings } = params;
    const linkConnection = resolveStoryLinkLlmConfig(settings);
    const queryTimeoutMs = resolveAgenticQueryTimeoutMs(settings);
    const boundQuery = promise => _raceWithTimeout(promise, queryTimeoutMs);

    // The router, the pre-search and what a recipe reads all start now, so any turn that takes a block
    // finds its reads done, or under way, when the router answers. The pre-search stays for the turns that keep it.
    const storyRoutePromise = _routeStoryQuestion(params, linkConnection);
    const startedReads = linkConnection.ok ? startStoryRecipeReads({ ...params, boundQuery }) : null;
    const preSearch = await retrieveEvents(params);
    const storyRoute = await storyRoutePromise;
    const storyArc = {
        ruleName: storyRoute?.isKnownShape ? STORY_ROUTE_RULE.ORDINARY_TURN : STORY_ROUTE_RULE.ROUTER_UNUSABLE,
        cutRuleName: '',
        shape: storyRoute?.shape ?? '',
        subject: storyRoute?.subject ?? '',
        finalCount: 0,
    };
    const isOrdinary = isOrdinaryTurn(storyRoute);
    if (isOrdinary || (storyRoute && hasRecipe(storyRoute.shape))) {
        // An ordinary turn takes the chain block with no LLM call: no thread pick, and the fixed rule's cut.
        const recalled = await retrieveStoryRecipeEvents(isOrdinary ? ORDINARY_TURN_ROUTE : storyRoute, isOrdinary
            ? { ...params, boundQuery, startedReads, shouldCutByRule: true }
            : {
                ...params,
                boundQuery,
                startedReads,
                pickThreads: (storedEvents, keptNames) => _pickStoryThreads(storedEvents, { subject: keptNames.subject }, { ...params, keywordQuery: keptNames.question }, linkConnection),
                chooseBlockEvents: (events, keptNames, lineCount) => _chooseBlockEvents(events, { shape: storyRoute.shape, subject: keptNames.subject }, { ...params, keywordQuery: keptNames.question }, linkConnection, lineCount),
            });
        // Without links the ordinary turn's block is only the closest hits, so it keeps the pre-search.
        const isBlockKept = recalled.events.length > 0 && !(isOrdinary && recalled.ruleName === STORY_ROUTE_RULE.LINKS_NOT_GENERATED);
        storyArc.ruleName = isOrdinary && isBlockKept ? STORY_ROUTE_RULE.ORDINARY_TURN : recalled.ruleName;
        storyArc.cutRuleName = isBlockKept ? recalled.cutRuleName : '';
        storyArc.finalCount = isBlockKept ? recalled.events.length : 0;
        log.domain('story_arc', 'lifecycle', `[VectFox-StoryArc] rule=${storyArc.ruleName} cut=${storyArc.cutRuleName || 'none'} shape=${storyArc.shape} subject="${storyArc.subject}" block=${recalled.blockShape} threads=${recalled.pickedThreadCount} events=${storyArc.finalCount}`);
        if (isBlockKept) {
            return {
                events: recalled.events,
                storyArcShape: isOrdinary ? storyRoute.shape : recalled.blockShape,
                storyArcEntityNames: recalled.entityNames,
                // The block replaces the pre-search's events, so only the recipe's own failed searches cost this turn memory.
                debug: { ...preSearch.debug, storyArc, failedSearchCount: recalled.failedSearchCount, searchFailureMessage: recalled.searchFailureMessage },
            };
        }
    } else {
        log.domain('story_arc', 'lifecycle', `[VectFox-StoryArc] rule=${storyArc.ruleName} shape=${storyArc.shape}`);
    }

    return { events: preSearch.events, debug: { ...preSearch.debug, storyArc } };
}

/**
 * Agent Mode: the planner's queries add seats beside the pre-search's, which keeps all
 * its own. A plan needs no search results, so it runs alongside the pre-search.
 *
 * @param {object} params - The retrieval params
 * @returns {Promise<{events: object[], debug: object}>}
 */
async function _retrieveWithPlanner(params) {
    const { settings, chatLength, skipContextDedup } = params;
    const tAgentStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const [preSearch, planned] = await Promise.all([retrieveEvents(params), _searchPlannedQueries(params)]);
    if (!planned) {
        return preSearch;
    }
    if (planned.failureMessage) {
        return _withFailedSearch(preSearch, planned.failureMessage);
    }

    const minImportance = settings.eventbase_retrieval_min_importance || 1;
    const seatedEvents = preSearch.events;
    const addedEvents = seatPlannerHits({
        hitLists: planned.hitLists,
        poolEvents: preSearch.poolEvents,
        seatedEvents,
        canTakeSeat: event => (event.importance == null || event.importance >= minImportance)
            && removeEventsVisibleInContext([event], { chatLength, settings, skipContextDedup }).length > 0,
        isDuplicate: (candidate, seated) => isDuplicateEvent(candidate, seated, settings),
    });

    const hitCount = planned.hitLists.reduce((sum, hits) => sum + hits.length, 0);
    const tTotalMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tAgentStart));
    if (log.domainEnabled('agent')) {
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Final: ${seatedEvents.length} pre-search seats + ${addedEvents.length} added from ${hitCount} planner hits`);
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Total wall-clock: ${tTotalMs}ms (LLM=${planned.llmMs}ms, fanout=${planned.fanoutMs}ms)`);
    }

    // Annotate debug so callers can detect agentic mode in diagnostics.
    return {
        events: [...seatedEvents, ...addedEvents],
        debug: {
            ...preSearch.debug,
            agenticMode: true,
            agenticQueries: planned.queries,
            agenticRationale: planned.rationale,
            agenticLLMMs: planned.llmMs,
            agenticFanoutMs: planned.fanoutMs,
            agenticTotalMs: tTotalMs,
            agenticHitCount: hitCount,
            agenticAddedSeats: addedEvents.length,
        },
    };
}

/**
 * The pre-search's result with one more failed memory search, which the turn reports
 * (eventbase-workflow.js), so the toast names the failure the turn met first.
 *
 * @param {{events: object[], debug?: object}} preSearch
 * @param {string} failureMessage
 */
function _withFailedSearch(preSearch, failureMessage) {
    const debug = preSearch.debug ?? {};
    return {
        ...preSearch,
        debug: {
            ...debug,
            failedSearchCount: (debug.failedSearchCount ?? 0) + 1,
            searchFailureMessage: debug.searchFailureMessage || failureMessage,
        },
    };
}

/**
 * Ask the planner for queries and run them. Never throws, and every outcome keeps the
 * pre-search: null adds nothing, and a failure returns its message for the turn to report.
 * A setup that cannot run raises its own warning and returns null, as does a plan with no query.
 *
 * @param {object} params - The retrieval params
 * @returns {Promise<{queries: string[], rationale: string|null, hitLists: object[][], llmMs: number, fanoutMs: number}|{failureMessage: string}|null>} one list of hits per query and collection
 */
async function _searchPlannedQueries(params) {
    const { settings, liveCollectionIds, keywordQuery } = params;
    const isAgentDebugOn = log.domainEnabled('agent');

    const llmConnection = _resolveAgenticLLMConfig(settings);
    if (!llmConnection.ok) {
        notifySetupIncomplete(AGENT_MODE, describeAgentModeSetupProblem(llmConnection.reason, llmConnection.problem));
        log.warn(`[VectFox-Agentic] mode=SKIPPED reason=${llmConnection.problem ?? llmConnection.reason}`);
        return null;
    }

    if (isAgentDebugOn) {
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] mode=ON  trigger=user_message_len=${(keywordQuery || '').length}`);
    }

    const recentTurns = _getRecentChatTurns(settings);
    if (isAgentDebugOn) {
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Chat turns read: ${recentTurns.length}`);
        log.domain('agent', 'verbose', '[VectFox-Agentic] Narrative context preview (one ~50-word snippet per turn):');
        recentTurns.forEach((turn, idx) => {
            const label = `[-${recentTurns.length - idx}]`;
            const snippet = _firstNWords(turn.text || '', 50);
            log.domain('agent', 'trace', `  ${label} ${turn.speaker}: ${snippet}`);
        });
    }

    const userMessage = buildPlannerUserMessage({
        recentTurns,
        userMessage: keywordQuery || '',
    });

    if (isAgentDebugOn) {
        // Prompt size only — the full prompt is intentionally NOT dumped to keep
        // the log readable. The narrative-context preview above already shows
        // what the planner sees per turn; the static system prompt is
        // getAgenticPlannerPrompt() in src/features/eventbase/prompts-i18n.js.
        const systemPromptText = getAgenticPlannerPrompt(settings?.cjk_tokenizer_mode);
        const approxTokens = Math.round((systemPromptText.length + userMessage.length) / 4);
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] LLM prompt size: system+user approx ${approxTokens} tokens (${systemPromptText.length}+${userMessage.length} chars)`);
    }

    const timeoutMs = resolveAgenticPlannerTimeoutMs(settings);
    let plan;
    const tLlmStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
        // Throttle the planner LLM call. Shares one budget with EventBase
        // extraction via generationRateLimiter (same chat-completions provider).
        // 0 = off. The gate sleeps BEFORE callLlmForJson runs, so the per-request
        // AbortSignal.timeout (created inside callLlmForJson) is unaffected.
        plan = await generationRateLimiter.execute(
            () => callLlmForJson({
                systemPrompt: getAgenticPlannerPrompt(settings?.cjk_tokenizer_mode),
                userMessage,
                llmConnection,
                timeoutMs,
                maxTokens: resolveAgenticMaxTokens(settings),
            }),
            generationRateLimitSettings(settings),
            'agent',
        );
    } catch (err) {
        const failure = _reportAgentLlmFailure(err, 'Planner', tLlmStart, timeoutMs);
        if (!failure) return null;
        return {
            failureMessage: failure.isTimeout
                ? `Agent Mode's planner timed out after ${timeoutMs} ms. Raise Planner timeout on the AgentMode page if this repeats.`
                : `Agent Mode's planner failed: ${failure.detail}`,
        };
    }
    const tLlmMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tLlmStart));

    if (isAgentDebugOn) {
        // Surface real token usage from the API response (when the provider
        // returns it — OpenRouter/OpenAI-compatible APIs do). The chars/4
        // estimate above is a rough guess; this is the truth from the provider.
        const usage = plan && plan.__usage;
        if (usage && usage.prompt_tokens != null) {
            const tokPerSec = usage.completion_tokens != null && tLlmMs > 0
                ? (usage.completion_tokens / (tLlmMs / 1000)).toFixed(1)
                : '—';
            log.domain('agent', 'verbose', `[VectFox-Agentic] LLM call complete: ${tLlmMs}ms — prompt=${usage.prompt_tokens} tok, completion=${usage.completion_tokens ?? '?'} tok, total=${usage.total_tokens ?? '?'} tok (${tokPerSec} tok/s output)`);
        } else {
            log.domain('agent', 'verbose', `[VectFox-Agentic] LLM call complete: ${tLlmMs}ms (provider did not return usage data)`);
        }
        log.domain('agent', 'verbose', '[VectFox-Agentic] Planner output:');
        log.domain('agent', 'verbose', JSON.stringify(plan, null, 2));
    }

    // An empty list is a valid "nothing to search"; no list at all is a reply the planner got wrong.
    if (!Array.isArray(plan?.queries)) {
        log.warn('[VectFox-Agentic] Planner reply has no queries array, using pre-search only');
        return { failureMessage: 'Agent Mode\'s planner answered without a list of searches.' };
    }
    const maxQueries = Math.max(1, Math.min(6, settings.agentic_retrieval_max_queries || 6));
    const validatedQueries = _validateAndTrimQueries(plan?.queries, maxQueries);
    if (validatedQueries.length === 0) {
        if (isAgentDebugOn) {
            log.domain('agent', 'lifecycle', '[VectFox-Agentic] Planner returned 0 valid queries — falling back to pre-search only');
        }
        return null;
    }

    if (!liveCollectionIds?.length) {
        if (isAgentDebugOn) {
            log.domain('agent', 'lifecycle', '[VectFox-Agentic] No live collections to query — falling back to pre-search only');
        }
        return null;
    }

    const topK = (settings.eventbase_retrieval_top_k || 8) * 2;

    // Search timeout: the fanout runs in parallel, so the whole retrieval
    // waits on the SLOWEST query. A single embed/search latency spike (e.g. the
    // shared embedding provider stalling) could otherwise freeze the turn for
    // tens of seconds. Cap each query; a straggler is dropped and the other
    // queries' results still flow through. queryCollection has no abort hook, so
    // the underlying request keeps running — we just stop awaiting it.
    const queryTimeoutMs = resolveAgenticQueryTimeoutMs(settings);
    const tFanoutStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const fanoutPromises = [];
    const failedQueryMessages = [];
    // Query by query, so each one's lists are together and no collection takes every turn at the seats.
    for (const queryText of validatedQueries) {
        for (const colId of liveCollectionIds) {
            fanoutPromises.push(
                _raceWithTimeout(searchEventCollection(colId, queryText, topK, settings), queryTimeoutMs)
                    .then(({ hashes, metadata }) => {
                        if (!hashes?.length) return { queryText, hits: [] };
                        // _sortFrame tags these live-collection hits with their source
                        // collection so the injector groups them into the same frame as
                        // the pre-search live events before the chronological sort.
                        const hits = metadata.map((meta, i) => ({ ...meta, _hash: hashes[i], _sortFrame: colId }));
                        return { queryText, hits };
                    })
                    .catch(err => {
                        if (err?.__timeout) {
                            log.warn(`[VectFox-Agentic] Query timed out after ${queryTimeoutMs}ms (${colId}, "${queryText}") — dropped; other queries still count. Raise "Search timeout" on the AgentMode page if needed.`);
                            failedQueryMessages.push(`timed out after ${queryTimeoutMs} ms. Raise Search timeout on the AgentMode page if this repeats.`);
                        } else {
                            log.warn(`[VectFox-Agentic] Query failed (${colId}, "${queryText}"): ${err?.message || err}`);
                            failedQueryMessages.push(`failed: ${err?.message || err}`);
                        }
                        return { queryText, hits: [] };
                    })
            );
        }
    }
    const fanoutResults = await Promise.all(fanoutPromises);
    const tFanoutMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tFanoutStart));
    // One failed query only loses its own hits; all of them failing loses everything Agent Mode adds.
    if (failedQueryMessages.length === fanoutPromises.length) {
        return { failureMessage: `Every Agent Mode search ${failedQueryMessages[0]}` };
    }

    if (isAgentDebugOn) {
        log.domain('agent', 'verbose', `[VectFox-Agentic] Qdrant fanout: ${validatedQueries.length} queries × ${liveCollectionIds.length} collection(s) = ${fanoutPromises.length} parallel calls`);
        log.domain('agent', 'verbose', `[VectFox-Agentic] Qdrant fanout complete: ${tFanoutMs}ms`);
        log.domain('agent', 'verbose', '[VectFox-Agentic] Per-query hits:');
        fanoutResults.forEach((r, i) => {
            const topScore = r.hits[0]?.score ?? r.hits[0]?.vectorScore ?? 0;
            log.domain('agent', 'trace', `  Q${i + 1} "${r.queryText.slice(0, 60)}" → ${r.hits.length} hits (top score=${typeof topScore === 'number' ? topScore.toFixed(3) : '—'})`);
        });
    }

    return {
        queries: validatedQueries,
        rationale: typeof plan?.rationale === 'string' ? plan.rationale : null,
        hitLists: fanoutResults.map(result => result.hits),
        llmMs: tLlmMs,
        fanoutMs: tFanoutMs,
    };
}

// ============================================================================
// StoryArc router and thread pick
// ============================================================================

/**
 * One StoryArc LLM call. Never throws: a failure is reported and returns null.
 *
 * @param {object} params
 * @param {object} params.settings
 * @param {string} params.label - Which call this is, for the log
 * @param {string} [params.nextStep] - What the turn does without this call
 * @param {object} params.call - What callLlmForJson needs, other than the time limit
 * @param {(reply: unknown) => T} params.read - Reads the reply, and may throw on a malformed one
 * @returns {Promise<T|null>}
 * @template T
 */
async function _askStoryLlm({ settings, label, nextStep, call, read }) {
    const timeoutMs = resolveAgenticPlannerTimeoutMs(settings);
    const tStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
        const reply = await generationRateLimiter.execute(
            () => callLlmForJson({ ...call, timeoutMs }),
            generationRateLimitSettings(settings),
            'agent',
        );
        return read(reply);
    } catch (err) {
        _reportAgentLlmFailure(err, label, tStart, timeoutMs, nextStep);
        return null;
    }
}

/**
 * Ask the router for the question's shape and subject. Never throws: a failure
 * is reported and returns null, so the turn keeps the pre-search.
 *
 * @param {object} params - The retrieval params
 * @param {object} linkConnection - From resolveStoryLinkLlmConfig
 * @returns {Promise<{shape: string, subject: string, isKnownShape: boolean}|null>}
 */
async function _routeStoryQuestion({ settings, keywordQuery }, linkConnection) {
    if (!linkConnection.ok) {
        log.warn(`[VectFox-StoryArc] Router skipped: ${linkConnection.problem ?? linkConnection.reason}`);
        return null;
    }
    if (!keywordQuery?.trim()) return { shape: 'scene', subject: '', isKnownShape: true };

    return _askStoryLlm({
        settings,
        label: 'StoryArc router',
        call: {
            systemPrompt: STORY_ROUTER_PROMPT,
            userMessage: buildStoryRouterMessage({ recentTurns: _getRecentChatTurns(settings), userMessage: keywordQuery }),
            llmConnection: _linkModelForRouter(linkConnection, settings),
            maxTokens: STORY_CHOICE_MAX_TOKENS,
            contextLabel: 'StoryArc router',
        },
        read: (reply) => {
            const route = readStoryRoute(reply);
            if (!route.isKnownShape) {
                log.warn(`[VectFox-StoryArc] Router returned an unknown shape, keeping the normal path: ${JSON.stringify(reply?.shape)}`);
            }
            return route;
        },
    });
}

/** A thinking model's reasoning counts against this, so it leaves room for that as well as the reply. */
const STORY_CHOICE_MAX_TOKENS = 9000;

function _linkModelAtEffort(linkConnection, reasoningEffort) {
    return { ...linkConnection, parameterStyle: { ...linkConnection.parameterStyle, reasoningEffort } };
}

/**
 * The link model for the thread pick and the cut, at low effort whatever Core's thinking
 * switch says. Low effort finds about as much as more thought in much less time, and with no
 * reasoning the cut keeps far fewer lines.
 */
function _linkModelAtLowEffort(linkConnection) {
    return _linkModelAtEffort(linkConnection, 'low');
}

/**
 * The link model for the router, which runs on every message, so it follows Core's
 * `Turn off model thinking`. Off, it takes low effort rather than the switch's `minimal`,
 * because GPT-6 Luna, the default link model, rejects `minimal`. On, it takes `none`, which
 * newer Gemini rejects, so a link model there needs the switch off.
 */
function _linkModelForRouter(linkConnection, settings) {
    return _linkModelAtEffort(linkConnection, settings.should_disable_thinking === false ? 'low' : 'none');
}

/**
 * Ask the link model which threads could hold the answer. It reads every thread
 * name, so this runs only for a question about a thread. Never throws: a failure
 * is reported and returns null, so the recipe runs without a pick.
 *
 * @param {object[]} storedEvents
 * @param {{subject: string}} route
 * @param {object} params - The retrieval params
 * @param {object} linkConnection - From resolveStoryLinkLlmConfig, which the router has already needed
 * @returns {Promise<string[]|null>} thread names
 */
async function _pickStoryThreads(storedEvents, route, { settings, keywordQuery }, linkConnection) {
    const threads = listStoryThreads(storedEvents);
    if (!threads.length) return [];
    return _askStoryLlm({
        settings,
        label: 'StoryArc thread pick',
        nextStep: 'so the recipe runs without it',
        call: {
            systemPrompt: THREAD_PICK_PROMPT,
            userMessage: buildThreadPickMessage(threads, keywordQuery, route.subject),
            llmConnection: _linkModelAtLowEffort(linkConnection),
            maxTokens: STORY_CHOICE_MAX_TOKENS,
            contextLabel: 'StoryArc thread pick',
        },
        read: reply => readThreadPick(reply, threads),
    });
}

/**
 * Ask the link model which of a long block's events answer the question, with a
 * prompt chosen by the router's shape. Never throws: a failure is reported and
 * returns null, so the block is cut without it.
 *
 * @param {object[]} events - The block
 * @param {{shape: string, subject: string}} route
 * @param {object} params - The retrieval params
 * @param {object} linkConnection - From resolveStoryLinkLlmConfig, which the router has already needed
 * @param {number} lineCount - The lines the block keeps
 * @returns {Promise<object[]|null>} the chosen events
 */
async function _chooseBlockEvents(events, route, { settings, keywordQuery }, linkConnection, lineCount) {
    return _askStoryLlm({
        settings,
        label: 'StoryArc block cut',
        nextStep: 'so the block is cut without it',
        call: {
            systemPrompt: buildBlockCutPrompt(route.shape, lineCount),
            userMessage: buildBlockCutMessage(events, keywordQuery, route.subject),
            llmConnection: _linkModelAtLowEffort(linkConnection),
            maxTokens: STORY_CHOICE_MAX_TOKENS,
            contextLabel: 'StoryArc block cut',
        },
        read: reply => readBlockCut(reply, events),
    });
}

// ============================================================================
// LLM planner call
// ============================================================================

/**
 * Report a failed Agent Mode or StoryArc LLM call in the log. A retired or unknown model
 * would otherwise silently degrade to the pre-search forever, so it raises the sticky
 * invalid-model toast instead, while retrieval keeps working in the meantime.
 *
 * @param {unknown} err
 * @param {string} label - Which call failed
 * @param {number} tStart - When the call started
 * @param {number} timeoutMs - The call's configured limit
 * @param {string} [nextStep] - What the turn does without this call
 * @returns {{isTimeout: boolean, detail: string}|null} what the turn reports, or null when the invalid-model toast already said it
 */
function _reportAgentLlmFailure(err, label, tStart, timeoutMs, nextStep = 'using pre-search only') {
    const tLlmMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart));
    const isInvalidModel = isInvalidModelConfigError(err);
    if (isInvalidModel) {
        notifyInvalidModel(err.message);
    }
    // AbortSignal.timeout() throws either a TimeoutError or a generic
    // "user aborted a request" message depending on the runtime. Detect both
    // and surface a clearer log line so timeout vs. real error is obvious.
    const isTimeout =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        /aborted|timeout|timed out/i.test(err?.message || '');
    if (isTimeout) {
        log.warn(`[VectFox-Agentic] ${label} LLM call TIMED OUT after ${tLlmMs}ms (configured limit: ${timeoutMs}ms), ${nextStep}. Raise "Planner timeout" on the AgentMode page if your model needs longer.`);
    } else {
        log.warn(`[VectFox-Agentic] ${label} LLM call failed after ${tLlmMs}ms, ${nextStep}: ${err?.message || err}`);
    }
    return isInvalidModel ? null : { isTimeout, detail: String(err?.message || err) };
}

/**
 * Resolve the planner's connection: the AgentMode page's boxes, with Same as EventBase model and each blank box
 * taken from the EventBase model (resolveInheritedConnection), whose profile it takes too.
 *
 * Returns { ok: true, provider, model, apiKey, vllmUrl } on success, { ok: true, provider, connectionProfileId, … } on
 * a profile, or { ok: false, reason, problem? } when it cannot run.
 */
export function _resolveAgenticLLMConfig(settings = {}) {
    const inherited = resolveInheritedConnection(
        { provider: settings.agent_provider, model: settings.agent_model, vllmUrl: settings.agent_vllm_url },
        settings,
    );
    const connection = resolveLlmConnection({
        ...inherited,
        connectionProfileId: resolveConnectionProfileId(settings, 'agent'),
        feature: AGENT_MODE,
        page: String(settings.agent_provider ?? '').trim() ? 'AgentMode' : 'Core',
    });
    return connection.ok ? { ...connection, parameterStyle: resolveModelParameterStyle(settings) } : connection;
}

/**
 * Resolve the StoryArc link model, which writes links, routes questions, picks threads
 * and cuts blocks. A link needs thought, so the model keeps its own reasoning default
 * and its own temperature. The router, thread pick and block cut each set their own effort.
 *
 * @param {object} settings
 * @returns {{ok: true, provider: string, model: string, parameterStyle: object}|{ok: false, reason: string, problem?: string}}
 */
export function resolveStoryLinkLlmConfig(settings) {
    const connection = resolveLlmConnection({
        provider: settings.story_arc_link_provider || 'openrouter',
        model: settings.story_arc_link_model,
        vllmUrl: settings.agent_vllm_url || settings.chat_vllm_url,
        connectionProfileId: resolveConnectionProfileId(settings, 'storyarc'),
        feature: 'StoryArc',
        page: 'StoryArc',
    });
    if (!connection.ok) return connection;
    return {
        ...connection,
        parameterStyle: { ...resolveModelParameterStyle(settings), sendTemperature: false, reasoningEffort: null },
    };
}

/**
 * Agent Mode's Test connection (AgentMode page): the connection test message on the planner's connection, resolved as
 * a planner call resolves it, Same as EventBase model included.
 *
 * @param {object} settings
 * @returns {Promise<{content: string, cutReason: string|null}>}
 * @throws {Error} Why the planner cannot run, as its setup warning says it, or what the call threw
 */
export async function testAgentModeConnection(settings) {
    const connection = _resolveAgenticLLMConfig(settings);
    if (!connection.ok) throw new Error(describeAgentModeSetupProblem(connection.reason, connection.problem));
    return sendConnectionTest(connection, { contextLabel: AGENT_MODE, parameterStyle: connection.parameterStyle });
}

/**
 * StoryArc's Test connection (StoryArc page): the connection test message on the link model's connection, resolved
 * as the link pass, the router, the thread pick and the cut resolve it.
 *
 * @param {object} settings
 * @returns {Promise<{content: string, cutReason: string|null}>}
 * @throws {Error} Why the link model cannot run, as the link pass says it, or what the call threw
 */
export async function testStoryArcConnection(settings) {
    const connection = resolveStoryLinkLlmConfig(settings);
    if (!connection.ok) throw new Error(connection.problem ?? `StoryArc link model is not ready: ${connection.reason}`);
    return sendConnectionTest(connection, { contextLabel: 'StoryArc', parameterStyle: connection.parameterStyle });
}

/**
 * Check that an LLM connection is filled in, and return what a call needs. On a SillyTavern connection profile the
 * profile supplies the model, URL and key, so only the profile is checked.
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} [params.model]
 * @param {string} [params.vllmUrl]
 * @param {string} [params.connectionProfileId]
 * @param {string} [params.feature] - Names the feature in a profile's problem
 * @param {string} [params.page] - The page that chooses the profile, named in its problem
 * @returns {{ok: true, provider: string, model: string, apiKey?: string, vllmUrl?: string, connectionProfileId?: string,
 *     connectionProfilePage?: string}|{ok: false, reason: string, problem?: string}}
 */
export function resolveLlmConnection({ provider: providerName, model: modelName, vllmUrl: rawVllmUrl, connectionProfileId = '', feature = AGENT_MODE, page = 'AgentMode' }) {
    const provider = String(providerName ?? '').toLowerCase();
    if (provider === CONNECTION_PROFILE_PROVIDER) {
        const check = checkConnectionProfile(connectionProfileId, { feature, page });
        if (!check.ok) return { ok: false, reason: CONNECTION_PROFILE_REASON, problem: check.reason };
        return { ok: true, provider, model: check.profile.model || '', connectionProfileId, connectionProfilePage: page };
    }

    const model = (modelName || '').trim();

    if (!model) {
        return { ok: false, reason: 'missing_model' };
    }

    if (provider === 'openrouter') {
        // One shared OpenRouter key (SECRET_KEYS.OPENROUTER): the Embedding, EventBase model and
        // Agent Mode key boxes all write that slot. See src/shared/api-keys.js.
        const apiKey = getOpenRouterApiKey();
        if (!apiKey) {
            return { ok: false, reason: 'missing_openrouter_api_key' };
        }
        return { ok: true, provider, model, apiKey };
    }

    if (provider === 'vllm') {
        const vllmUrl = (rawVllmUrl || '').trim();
        if (!vllmUrl) {
            return { ok: false, reason: 'missing_vllm_url' };
        }
        // Key lives in SECRET_KEYS.CUSTOM (masked client-side). getCustomApiKey
        // returns the masked presence indicator; real key is read server-side
        // by ST's chat-completions proxy. Same shared slot as summarize/agent.
        const apiKey = getCustomApiKey();
        if (!apiKey) {
            return { ok: false, reason: 'missing_vllm_api_key' };
        }
        return { ok: true, provider, model, vllmUrl, apiKey };
    }

    return { ok: false, reason: `unknown_provider_${provider}` };
}

/**
 * Call an LLM for a JSON reply and return it parsed: the planner, the StoryArc
 * router, thread pick and links. Throws on network/auth failure, a reply with no text,
 * or unparseable JSON, naming the provider's cut when it cut the reply short. A cut
 * reply whose JSON parses lost nothing, since the JSON closed before the cut.
 */
export async function callLlmForJson({ systemPrompt, userMessage, llmConnection, timeoutMs, maxTokens, contextLabel = 'Agent Mode' }) {
    // Shared HTTP + response classification (llm-provider-call.js). The planner
    // is a two-message, json_object call. authBranch:false folds 401/403 into the
    // model-config and generic paths, since the caller degrades to pre-search.
    let content, usage, finishReason, cutReason;
    try {
        ({ content, usage, finishReason, cutReason } = await postChatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            model: llmConnection.model,
            provider: llmConnection.provider,
            vllmUrl: llmConnection.vllmUrl || '',
            connectionProfileId: llmConnection.connectionProfileId || '',
            connectionProfilePage: llmConnection.connectionProfilePage || '',
            maxTokens,
            temperature: 0.2,
            timeoutMs,
            responseFormat: { type: 'json_object' },
            contextLabel,
            authBranch: false,
            ...(llmConnection.parameterStyle || {}),
        }));
    } catch (e) {
        if (e instanceof LlmCallError) {
            const err = new Error(e.message);
            if (e.kind === 'model_config') err.code = 'invalid_model_config';
            throw err;
        }
        throw e;
    }

    // A thinking model can emit its reasoning BEFORE the JSON — `<think>…</think>{…}`.
    // SillyTavern's proxy never forwards `response_format`, so nothing asks the
    // provider for bare JSON. Left in, that leading block fails JSON.parse and the
    // turn drops to pre-search (GitHub issue #18). `should_disable_thinking` sends
    // `reasoning_effort: 'none'`, but that is a REQUEST: plenty of models ignore
    // it, and a 200 response never proves the parameter took effect. So strip
    // unconditionally rather than trusting the switch — same reasoning as the
    // stripReasoningBlocks() docstring, which is already unconditional for
    // exactly this class of failure.
    // Runs BEFORE the fence strip: a fenced reply reads ```json…``` only once the
    // reasoning ahead of it is gone.
    const withoutReasoning = stripReasoningBlocks(String(content));
    // Some models wrap the JSON in markdown fences.
    const cleaned = withoutReasoning.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        const cause = !cutReason ? 'is not valid JSON'
            : finishReason === 'length' ? `was cut at the ${maxTokens}-token limit, so it is not valid JSON`
                : `was cut short by the provider, with finish reason ${cutReason}, so it is not valid JSON`;
        throw new Error(`${contextLabel} reply ${cause}: ${err.message}. Got: ${cleaned.slice(0, 200)}`);
    }

    // Attach usage as a non-enumerable property so callers can read it without
    // polluting the planner JSON contract (queries / rationale).
    Object.defineProperty(parsed, '__usage', { value: usage, enumerable: false });
    return parsed;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve/reject with whichever settles first: the wrapped promise, or a timeout
 * that rejects with an error tagged `__timeout` after `ms`. Used to bound each
 * parallel fanout query so one slow Qdrant/embedding call can't stall the turn.
 * The timer is always cleared so a fast resolve doesn't leak a pending timeout.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function _raceWithTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`query timed out after ${ms}ms`);
            err.__timeout = true;
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The characters the planner and the StoryArc router read from the start of each recent
 * chat turn, once the blocks below and Text Cleaning are removed, where the story sits. A
 * reply of over 1,000 Chinese characters fits whole, and a reply far longer cannot fill the call.
 */
const RECENT_TURN_CHARACTERS = 3500;

/**
 * Read recent non-system chat turns from getContext().chat, as the planner and the
 * StoryArc router see them. Independent from the embedding search's searchText parameter.
 */
function _getRecentChatTurns(settings) {
    const chat = getContext().chat || [];
    const depth = Math.max(1, Math.min(50, settings.agentic_retrieval_chat_depth || 3));
    return chat
        .filter(m => !m.is_system)
        .slice(-depth)
        .map(m => ({
            speaker: m.is_user ? '{{user}}' : (m.name || '{{character}}'),
            // Reduce each turn to narrative: drop the model's <think>/planning blocks
            // (chain-of-thought that names off-screen characters and meta plot lines), the
            // MVU game-system blocks (<UpdateVariable>/<JSONPatch>/<combat_log> bookkeeping,
            // the cast roster) and pictures with their image prompts, then what the player's
            // Text Cleaning removes, as the extractor reads them.
            text: cleanText(stripGameSystemBlocks(stripReasoningBlocks((m.mes || '').toString()))).slice(0, RECENT_TURN_CHARACTERS),
        }));
}

/**
 * Take the first N whitespace-delimited words. Used for the debug-log
 * narrative-context preview (~50 words per turn).
 */
function _firstNWords(text, n) {
    if (!text) return '';
    const trimmed = String(text).replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    const parts = trimmed.split(' ');
    if (parts.length <= n) return trimmed;
    return parts.slice(0, n).join(' ') + '...';
}

/**
 * Validate, dedupe, and trim planner-emitted queries. Drops empties, strings
 * outside 3..300 chars, exact duplicates, and clamps array length to maxQueries.
 */
function _validateAndTrimQueries(queries, maxQueries) {
    if (!Array.isArray(queries)) return [];
    const seen = new Set();
    const out = [];
    for (const q of queries) {
        if (typeof q !== 'string') continue;
        const trimmed = q.trim();
        if (trimmed.length < 3 || trimmed.length > 300) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= maxQueries) break;
    }
    return out;
}
