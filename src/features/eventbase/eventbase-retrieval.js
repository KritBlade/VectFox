/**
 * ============================================================================
 * EVENTBASE RETRIEVAL
 * ============================================================================
 * Retrieves and re-ranks EventRecord objects from Qdrant for prompt injection.
 *
 * Pipeline:
 *  1. Dual vector query — user's last message + full context (Promise.all); merge by max score
 *  2. Filter by minimum importance
 *  3. Re-rank using weighted formula: cosine + importance + persist + recency
 *  4. Suppress near-duplicate events (same type + high character overlap)
 *  5. Return top-K events with debug metadata
 * ============================================================================
 */

import { queryCollection, getQueryVector, getBackendForCollection, getBackend } from '../vector-backend/index.js';
import { parseRegistryKey } from '../../shared/collection-ids.js';
import { parseEmbedText } from './eventbase-schema.js';
import { checkPluginAvailable } from '../../shared/similharity-plugin.js';
import { log } from '../../sillytavern/log.js';

// ---------------------------------------------------------------------------
// Default re-rank weights (tuned for long-form SillyTavern RP)
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
    cosine: 0.55,
    importance: 0.20,
    persist: 0.15,
    recency: 0.10,
};

// ---------------------------------------------------------------------------
// Re-rank helpers
// ---------------------------------------------------------------------------

/**
 * Compute overlap ratio between two string arrays (Jaccard index).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
function _characterOverlap(a, b) {
    if (!a?.length || !b?.length) return 0;
    const setA = new Set(a.map(s => s.toLowerCase()));
    const setB = new Set(b.map(s => s.toLowerCase()));
    let intersection = 0;
    for (const v of setA) {
        if (setB.has(v)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
}

/**
 * Recency bonus: exponential decay over the distance from the latest message.
 * Events whose source window ends near the current chat tail score higher.
 * @param {object} event
 * @param {number} chatLength
 * @returns {number} 0..1
 */
function _recencyBonus(event, chatLength) {
    if (!chatLength || chatLength === 0) return 0.5;
    const endIdx = event.source_window_end ?? 0;
    const age = chatLength - endIdx;
    // Half-life scales with chat length: 20% of total messages (floor 40).
    // In a 2000-msg chat the half-life is 400 msgs so old foundational events
    // still contribute; in a short 100-msg chat it stays at a minimum of 40.
    const halfLife = Math.max(40, chatLength * 0.20);
    return Math.pow(0.5, Math.max(0, age) / halfLife);
}

/**
 * Normalize 4 weights so they sum to 1.0.
 * @param {object} w
 * @returns {object}
 */
function _normalizeWeights(w) {
    const sum = w.cosine + w.importance + w.persist + w.recency;
    if (sum <= 0) return { ...DEFAULT_WEIGHTS };
    return {
        cosine: w.cosine / sum,
        importance: w.importance / sum,
        persist: w.persist / sum,
        recency: w.recency / sum,
    };
}

/**
 * Resolve the anchor boost amount from settings (clamped to [0, 0.5]).
 * Shared by the main scoring loop and compare-mode JS scoring.
 */
function _resolveAnchorBoostAmount(settings) {
    return typeof settings.eventbase_anchor_boost === 'number'
        ? Math.max(0, Math.min(0.5, settings.eventbase_anchor_boost))
        : 0.20;
}

/**
 * Compute anchor boost for a single event metadata object — same semantic as the
 * inline check at the bottom of `retrieveEvents`. Kept in a helper so the
 * compare-mode JS pipeline can use it without duplicating the substring logic.
 */
function _anchorBoostFor(meta, anchorText, anchorAmount) {
    if (!(anchorAmount > 0) || !anchorText) return 0;
    return (meta.keywords || []).some(k => k.length >= 2 && anchorText.includes(k.toLowerCase()))
        ? anchorAmount : 0;
}

/**
 * Compute the legacy JS final score for an event — same formula as the inline
 * loop at line 211+ of `retrieveEvents`. Used by compare mode for the parallel
 * JS path's scoring. Returns _finalScore on the meta object (not mutated).
 */
function _jsFinalScore(meta, weights, chatLength, anchorText, anchorAmount) {
    const cosineScore = typeof meta.vectorScore === 'number'
        ? meta.vectorScore
        : (typeof meta.score === 'number' ? meta.score : 0);
    const importanceNorm = (meta.importance ?? 5) / 10;
    const persistBonus = meta.should_persist === true ? 1 : 0;
    const recencyBonus = _recencyBonus(meta, chatLength);
    const anchorBoost = _anchorBoostFor(meta, anchorText, anchorAmount);
    return weights.cosine * cosineScore
         + weights.importance * importanceNorm
         + weights.persist * persistBonus
         + weights.recency * recencyBonus
         + anchorBoost;
}

/**
 * Run a single live (collection, queryText) lookup. Branches between the native
 * rerank path and the existing queryCollection path. In compare mode, fires the
 * JS path in parallel for observability — its results never escape this helper.
 * Every path, including each fallback, reuses `queryVector` — the query text's
 * embedding, computed once by retrieveEvents — so nothing here re-embeds the text.
 *
 * @returns {Promise<Array<object>>} candidate metadata array (each tagged with _hash)
 */
async function _runOneLiveQuery({
    colId, queryText, queryVector, topK, ebSettings, settings,
    useNativeRerank, rerankParams, compareMode, comparisonLog,
    chatLength, anchorText, anchorBoostAmount, rerankWeights,
}) {
    // Decide if native rerank is feasible for this specific collection. Even
    // when the global flag is on, an archive collection routed through Vectra
    // would fall back to the JS path. Duck-typed on the method presence so we
    // don't depend on a `.type` property the base interface doesn't define.
    if (useNativeRerank) {
        try {
            const parsed = parseRegistryKey(colId);
            const backend = parsed.backend
                ? await getBackendForCollection(parsed.backend, settings)
                : await getBackend(settings);
            if (backend && typeof backend.hybridQueryWithRerank === 'function') {
                const tStart = performance.now();

                // Fire JS comparison in parallel with native rerank so its latency
                // is hidden behind the native query rather than added on top.
                const JS_COMPARE_TIMEOUT_MS = 15_000;
                let jsCompletedAt = null;
                const jsQueryPromise = compareMode
                    ? Promise.race([
                        queryCollection(colId, queryText, topK, ebSettings, queryVector),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`JS compare timed out after ${JS_COMPARE_TIMEOUT_MS}ms`)), JS_COMPARE_TIMEOUT_MS)
                        ),
                    ]).then(res => { jsCompletedAt = performance.now(); return res; })
                    : null;

                const { hashes, metadata } = await backend.hybridQueryWithRerank(
                    colId, queryText, topK, ebSettings, rerankParams, {}, queryVector
                );
                const nativeMs = (performance.now() - tStart).toFixed(1);
                const nativeResults = (hashes || []).map((h, i) => ({
                    ...(metadata[i] || {}),
                    _hash: h,
                    _rerankApplied: !!metadata[i]?.rerankApplied,
                }));

                if (compareMode) {
                    try {
                        const jsRes = await jsQueryPromise;
                        const jsMs = (jsCompletedAt != null ? jsCompletedAt - tStart : performance.now() - tStart).toFixed(1);
                        const jsCandidates = (jsRes.hashes || []).map((h, i) => {
                            const m = jsRes.metadata?.[i] || {};
                            return { ...m, _hash: h, _jsFinal: _jsFinalScore(m, rerankWeights, chatLength, anchorText, anchorBoostAmount) };
                        });
                        // Filter by min-importance to mirror the server-side filter.
                        const jsFiltered = jsCandidates.filter(m => {
                            const imp = m.importance ?? m.metadata?.importance;
                            return imp == null || imp >= rerankParams.minImportance;
                        });
                        jsFiltered.sort((a, b) => b._jsFinal - a._jsFinal);

                        // Apples-to-apples: the JS final score includes anchor boost
                        // (from _jsFinalScore), and the main pipeline ALSO adds anchor
                        // boost to native results AFTER this helper returns. So for the
                        // comparison to be meaningful, project the same anchor-boosted
                        // score onto the native list here. Re-sort by the boosted score
                        // so the rank-correlation reflects what the user actually sees.
                        const nativeForCompare = nativeResults
                            .map(e => ({ ...e, score: (typeof e.score === 'number' ? e.score : 0) + _anchorBoostFor(e, anchorText, anchorBoostAmount) }))
                            .sort((a, b) => b.score - a.score);

                        _logRerankComparison(colId, queryText, nativeForCompare, jsFiltered, nativeMs, jsMs, settings, comparisonLog);
                    } catch (cmpErr) {
                        log.warn(`[EventBase compare] JS path failed for ${colId}:`, cmpErr.message);
                    }
                }

                return nativeResults;
            }
            // backendType !== qdrant or no method → fall through to legacy path
        } catch (err) {
            log.warn(`[EventBase] Native rerank backend resolution failed for ${colId} (falling back):`, err.message);
        }
    }

    // Legacy path: queryCollection (vector-only or hybrid, depending on settings).
    const { hashes, metadata } = await queryCollection(colId, queryText, topK, ebSettings, queryVector);
    if (!hashes?.length) return [];
    return metadata.map((m, i) => {
        const base = { ...m, _hash: hashes[i] };
        // Native ST Vectra only stores {hash, text, index} — no EventBase metadata.
        // Parse the embed text to recover content fields when they are absent.
        if (base.text && !base.event_type) {
            Object.assign(base, parseEmbedText(base.text));
        }
        return base;
    });
}

/**
 * Collapse events that are the SAME physical event (same event_id, or _hash
 * fallback) to a single copy, keeping the highest-scoring instance.
 *
 * Several searches can surface the same stored event. Those duplicates must be merged
 * by identity BEFORE the similarity-dedup stage — otherwise its score-override escape
 * hatch (high-score candidates survive dedup) lets identical events straight through,
 * so the "final 10" can be just 2 unique events repeated.
 *
 * @param {object[]} events
 * @returns {object[]} one entry per identity, highest .score retained
 */
export function dedupeEventsByIdentity(events) {
    const map = new Map();
    for (const event of events) {
        const key = event.event_id ?? event._hash ?? JSON.stringify(event);
        const existing = map.get(key);
        if (!existing || (event.score ?? -Infinity) > (existing.score ?? -Infinity)) {
            map.set(key, event);
        }
    }
    return [...map.values()];
}

/**
 * A candidate's similarity at or above this says it is a distinct event. Most Qdrant RRF
 * scores land in 0.2-0.6, so crossing it means the query and the event are tightly aligned.
 */
const DUPLICATE_SCORE_OVERRIDE = 0.75;

const _candidateSimScore = (candidate) =>
    typeof candidate.score === 'number' ? candidate.score :
    typeof candidate.vectorScore === 'number' ? candidate.vectorScore : 0;

/**
 * Events this many messages apart or more count as distinct. `eventbase_dedup_window_gap`
 * (Core tab slider, 0-200, default 10) sets it. 0 turns the check off, so every distance is
 * kept, including same-window duplicates extracted from one chunk. 1 suppresses only the
 * same window. 10 suppresses distances 0 to 9. 200 is the most aggressive.
 */
function _duplicateWindowGap(settings) {
    return typeof settings.eventbase_dedup_window_gap === 'number'
        ? Math.max(0, Math.min(200, settings.eventbase_dedup_window_gap))
        : 10;
}

/**
 * Whether a candidate repeats an event already accepted. All of these have to hold:
 *   (a) the same event_type, and
 *   (b) a character overlap (Jaccard) of 60% or more, which together catch the same cast
 *       and scene type that overlapping ingestion windows produce;
 *   (c) source windows closer than the gap, since the same cast and type far apart are two
 *       scenes. When either event has no source_window_end, the distance cannot be checked,
 *       so this counts as close;
 *   (d) on the JS path, a similarity below DUPLICATE_SCORE_OVERRIDE: real duplicates share
 *       scores with their winner, so one that matches the query this well is likely a
 *       distinct event of a similar shape. A formula-scored event is left out, because its
 *       `score` is a weighted sum that routinely passes 0.75, which would let duplicates
 *       fill every seat.
 *
 * @param {object} candidate
 * @param {object} accepted
 * @param {object} settings
 * @returns {boolean}
 */
export function isDuplicateEvent(candidate, accepted, settings) {
    if (accepted.event_type !== candidate.event_type) return false;
    if (_characterOverlap(accepted.characters || [], candidate.characters || []) < 0.6) return false;

    const acceptedEnd = accepted.source_window_end;
    const candidateEnd = candidate.source_window_end;
    const hasTiming = typeof acceptedEnd === 'number' && typeof candidateEnd === 'number';
    if (hasTiming && Math.abs(acceptedEnd - candidateEnd) >= _duplicateWindowGap(settings)) return false;

    if (!candidate._rerankApplied && !accepted._rerankApplied) {
        const similarity = _candidateSimScore(candidate);
        if (similarity >= DUPLICATE_SCORE_OVERRIDE) {
            log.trace(`[EventBase] Dedup: "${candidate.event_type}" ESCAPED dedup via score override (sim=${similarity.toFixed(3)} >= ${DUPLICATE_SCORE_OVERRIDE}, windows ${hasTiming ? Math.abs(acceptedEnd - candidateEnd) + ' msgs' : '?'} apart)`);
            return false;
        }
    }
    return true;
}

/**
 * Drop events whose source window is already visible in recent context: if
 * source_window_end falls within the last deduplication_depth messages, the LLM
 * can see that content directly, so injecting the event adds nothing. Skipped
 * when cross-chat locked, where source_window_end belongs to a different
 * conversation and means nothing against the current chat length.
 *
 * @param {object[]} events
 * @param {object} params
 * @param {number} params.chatLength
 * @param {object} params.settings
 * @param {boolean} [params.skipContextDedup]
 * @returns {object[]}
 */
export function removeEventsVisibleInContext(events, { chatLength, settings, skipContextDedup }) {
    const dedupDepth = settings.deduplication_depth ?? 0;
    if (skipContextDedup || dedupDepth <= 0) return events;
    const visibleThreshold = chatLength - dedupDepth;
    return events.filter(e => {
        // _rerankApplied events were already filtered server-side by the outer
        // range filter in the formula query (when applyContextDedupFilter was
        // true). Don't re-filter them or we'd double-apply.
        if (e._rerankApplied) return true;
        const windowEnd = e.source_window_end ?? -1;
        const inRecentContext = windowEnd >= visibleThreshold;
        if (inRecentContext) {
            log.trace(`[EventBase] Dedup-depth skip: event "${e.event_type}" source_window_end=${windowEnd} is within last ${dedupDepth} messages (threshold=${visibleThreshold})`);
        }
        return !inRecentContext;
    });
}

/**
 * Compare-mode logger. Reports per (collection, queryText):
 *   - top-K overlap (by event_id, fallback hash)
 *   - symmetric difference with ranks in each list
 *   - Spearman rank correlation on the union
 *   - timing for both paths
 * Verbose mode (eventbase_compare_rerank_verbose) additionally logs per-event
 * score breakdowns for events present in both lists.
 * Comparisons are also appended to the supplied `comparisonLog` array (if any)
 * so they can be returned in the debug object for offline analysis.
 */
function _logRerankComparison(colId, queryText, native, js, nativeMs, jsMs, settings, comparisonLog) {
    const keyOf = e => e.event_id ?? e._hash ?? null;
    const nativeTop = native.slice(0, 20).map(keyOf).filter(Boolean);
    const jsTop = js.slice(0, 20).map(keyOf).filter(Boolean);
    const nativeSet = new Set(nativeTop);
    const jsSet = new Set(jsTop);
    const overlap = nativeTop.filter(k => jsSet.has(k));
    const onlyNative = nativeTop.filter(k => !jsSet.has(k));
    const onlyJs = jsTop.filter(k => !nativeSet.has(k));

    // Spearman ρ on the union (events absent from one side get rank past end).
    const union = [...new Set([...nativeTop, ...jsTop])];
    const nativeRank = new Map(nativeTop.map((k, i) => [k, i + 1]));
    const jsRank = new Map(jsTop.map((k, i) => [k, i + 1]));
    const N = union.length;
    let rho = 0;
    if (N >= 2) {
        let dSumSq = 0;
        for (const k of union) {
            const r1 = nativeRank.get(k) ?? (nativeTop.length + 1);
            const r2 = jsRank.get(k) ?? (jsTop.length + 1);
            dSumSq += (r1 - r2) ** 2;
        }
        rho = 1 - (6 * dSumSq) / (N * (N * N - 1));
    }

    const previewQuery = String(queryText || '').replace(/\s+/g, ' ').slice(0, 80);
    log.domain('rerank', 'trace', `[EventBase compare] col=${colId} q="${previewQuery}" — overlap@${Math.min(nativeTop.length, jsTop.length)}=${overlap.length}, spearmanRho=${rho.toFixed(3)}, native=${nativeMs}ms, js=${jsMs}ms`);
    if (onlyNative.length || onlyJs.length) {
        log.domain('rerank', 'trace', `[EventBase compare]   onlyNative=[${onlyNative.slice(0, 5).join(', ')}${onlyNative.length > 5 ? `, +${onlyNative.length - 5}` : ''}], onlyJs=[${onlyJs.slice(0, 5).join(', ')}${onlyJs.length > 5 ? `, +${onlyJs.length - 5}` : ''}]`);
    }

    if (settings.eventbase_compare_rerank_verbose) {
        const nativeByKey = new Map(native.map(e => [keyOf(e), e]));
        const jsByKey = new Map(js.map(e => [keyOf(e), e]));
        for (const k of overlap.slice(0, 5)) {
            const n = nativeByKey.get(k);
            const j = jsByKey.get(k);
            log.domain('rerank', 'trace', `[EventBase compare verbose]   key=${k} nativeScore=${n?.score?.toFixed(4)} jsFinal=${j?._jsFinal?.toFixed(4)} (imp=${n?.importance}, persist=${n?.should_persist}, swe=${n?.source_window_end})`);
        }
    }

    if (comparisonLog) {
        comparisonLog.push({
            collectionId: colId,
            queryText: previewQuery,
            overlapCount: overlap.length,
            overlapDenominator: Math.min(nativeTop.length, jsTop.length),
            spearmanRho: rho,
            onlyNativeCount: onlyNative.length,
            onlyJsCount: onlyJs.length,
            nativeMs: parseFloat(nativeMs),
            jsMs: parseFloat(jsMs),
        });
    }
}

// ---------------------------------------------------------------------------
// Main retrieval function
// ---------------------------------------------------------------------------

/**
 * Query and re-rank EventBase records for injection.
 *
 * @param {object} params
 * @param {string} params.searchText    - Recent chat messages joined (from buildSearchQuery)
 * @param {string} [params.keywordQuery] - User's last message; used for keyword extraction and
 *                                         a second parallel vector query (dual-query mode).
 *                                         Falls back to searchText when absent or identical.
 * @param {number} params.chatLength    - Current total chat message count (for recency)
 * @param {object} params.settings      - VectFox settings
 * @param {string[]} [params.liveCollectionIds] - EventBase collection IDs to query for live
 *        events. Resolved by the workflow from collections locked to the current chat.
 *        Empty/missing → no live query.
 * @param {object[]} [params.additionalCandidates] - Pre-queried events from archive event
 *        collections (VectFox_archiveevent_*). Already event-shaped; merged before re-ranking.
 * @param {boolean}  [params.skipLiveQuery]    - When true, skip live EventBase collection query.
 *        Used when the live collection is paused or not locked to the current chat.
 * @param {boolean}  [params.skipContextDedup] - When true, skip the dedup-depth step.
 *        Set when locked cross-chat: source_window_end values belong to a different conversation
 *        and cannot be compared to the current chat length.
 * @returns {Promise<{ events: object[], poolEvents: object[], debug: object }>} poolEvents is
 *        everything the live searches found, before any filter or trim
 */
/**
 * Stamp each event with its source conversation frame (collection id) so the
 * injector can group by conversation before sorting chronologically —
 * `source_window_end` is a message index within ONE conversation and must not
 * be compared across collections. Internal field; `_cleanEventForInjection`
 * whitelists output fields, so it never reaches the prompt.
 * @param {unknown} events
 * @param {string} frame
 * @returns {unknown}
 */
function _tagFrame(events, frame) {
    if (!Array.isArray(events)) return events;
    return events.map(e => (e && typeof e === 'object') ? { ...e, _sortFrame: frame } : e);
}

export async function retrieveEvents({ searchText, keywordQuery, chatLength, settings, liveCollectionIds, additionalCandidates, skipLiveQuery, skipContextDedup = false }) {
    const topK = (settings.eventbase_retrieval_top_k || 8) * 2; // overfetch for re-rank
    const minImportance = settings.eventbase_retrieval_min_importance || 1;

    // EventBase always uses its own keyword scoring key so that ChunkBase's
    // keyword_scoring_method setting never accidentally switches EventBase into
    // client-side hybrid mode. Default is 'bm25'; override via eventbase_keyword_scoring_method.
    const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };

    // Native rerank: push importance filter + dedup-depth filter + weighted-sum
    // scoring into Qdrant via a formula query, in the same /query call as the
    // existing dense+sparse RRF hybrid. Gated on Qdrant backend + native hybrid
    // preference + opt-in flag (default off). When on, the per-collection call
    // returns events with their formula score already in `score`, and the rest
    // of this pipeline (anchor boost, pairwise dedup, final trim) runs on top.
    // See InternalProject/Vectfox/plans/executed/qdrant-native-eventbase-rerank-formula.md.
    const useNativeRerank = (
        settings.vector_backend === 'qdrant'
        && settings.hybrid_native_prefer !== false
        && settings.eventbase_native_rerank === true
    );
    const compareMode = useNativeRerank && log.domainEnabled('rerank');

    // Detect "no vector scoring" state — Standard backend without the Similharity
    // plugin returns score=0 from the native /api/vector/query path (see
    // StandardBackend.queryCollection in src/features/vector-backend/standard.js).
    // Coerce cosine to 0 so _normalizeWeights redistributes its share onto
    // importance/persist/recency, instead of leaving it as dead weight that
    // silently caps the effective scoring budget.
    // The user's saved cosine value is preserved and takes effect again the
    // moment the plugin is installed or they switch to a backend with real
    // vector scores. The UI mirrors this state by greying out the cosine input.
    const activeBackend = settings.vector_backend || 'standard';
    const cosineInactive = activeBackend === 'standard' && !(await checkPluginAvailable());
    const effectiveCosine = cosineInactive
        ? 0
        : (settings.eventbase_rerank_w_cosine ?? DEFAULT_WEIGHTS.cosine);

    // Build re-rank params once — values are constant across the per-(collection,
    // queryText) calls in this retrieve invocation.
    const rerankWeights = _normalizeWeights({
        cosine: effectiveCosine,
        importance: settings.eventbase_rerank_w_importance ?? DEFAULT_WEIGHTS.importance,
        persist: settings.eventbase_rerank_w_persist ?? DEFAULT_WEIGHTS.persist,
        recency: settings.eventbase_rerank_w_recency ?? DEFAULT_WEIGHTS.recency,
    });
    if (cosineInactive) {
        log.lifecycle(`[EventBase] Cosine weight coerced to 0 (Standard backend, plugin unavailable). Effective weights:`, rerankWeights);
    }
    const halfLife = !chatLength || chatLength === 0 ? 40 : Math.max(40, chatLength * 0.20);
    const dedupDepthForFilter = settings.deduplication_depth ?? 0;
    const visibleThresholdForFilter = dedupDepthForFilter > 0 ? chatLength - dedupDepthForFilter : -1;
    const rerankParams = {
        weights: rerankWeights,
        chatLength: chatLength || 0,
        halfLife,
        minImportance,
        visibleThreshold: visibleThresholdForFilter,
        applyContextDedupFilter: !skipContextDedup,
    };

    if (log.enabled('lifecycle')) {
        const method = ebSettings.keyword_scoring_method;
        const nativePrefer = settings.hybrid_native_prefer !== false;
        log.lifecycle(`[EventBase] Retrieval start — topK overfetch=${topK}, minImportance=${minImportance}, method=${method}, nativePrefer=${nativePrefer}, liveCollections=${liveCollectionIds?.length || 0}, nativeRerank=${useNativeRerank}${compareMode ? ' (compare ON)' : ''}`);
    }

    // 1. Dual vector query against each locked live EventBase collection.
    //    userQuery  → user's last message: high-precision, intent-focused
    //    searchText → full multi-message context: broad narrative coverage
    //    Empty/undefined inputs are dropped (B5: dryRun callers may pass only
    //    one of the two; firing a query with empty text returns plugin 400).
    //    Identical strings are deduped so we never pay double cost.
    //    Skipped entirely when no live collection is available.
    let rawCandidates = [];
    // Query embeddings that still failed after their retry, one per query text.
    const failedEmbeddings = [];
    const queryTexts = [keywordQuery, searchText]
        .filter(q => q && String(q).trim())
        .filter((q, i, arr) => arr.indexOf(q) === i);
    const dualQuery = queryTexts.length > 1;

    // Per-(collection, queryText) live query. When useNativeRerank is on AND the
    // collection resolves to a Qdrant backend, dispatch to hybridQueryWithRerank
    // and tag results with _rerankApplied. Otherwise fall back to the existing
    // queryCollection path. In compare mode, the JS path also runs in parallel
    // for observability — its results are logged but not returned.
    const comparisonLog = compareMode ? [] : null;

    if (skipLiveQuery || !liveCollectionIds?.length) {
        log.verbose('[EventBase] Live query skipped (no locked collection or paused)');
    } else {
        // Embed each query text ONCE for every collection and every fallback inside
        // _runOneLiveQuery (see getQueryVector). If a text's embedding still fails
        // after its retry, it is counted in failedEmbeddings, and each of its queries
        // fails into the per-query catch below.
        const queryVectorByText = new Map(queryTexts.map(text => [
            text,
            getBackend(settings).then(backend => getQueryVector(backend, text, ebSettings).catch((error) => {
                failedEmbeddings.push(error);
                throw error;
            })),
        ]));
        const promises = [];
        for (const colId of liveCollectionIds) {
            for (const queryText of queryTexts) {
                promises.push(
                    queryVectorByText.get(queryText)
                        .then(queryVector => _runOneLiveQuery({
                            colId,
                            queryText,
                            queryVector,
                            topK,
                            ebSettings,
                            settings,
                            useNativeRerank,
                            rerankParams,
                            compareMode,
                            comparisonLog,
                            chatLength,
                            anchorText: (keywordQuery || '').toLowerCase(),
                            anchorBoostAmount: _resolveAnchorBoostAmount(settings),
                            rerankWeights,
                        }))
                        .then(evts => _tagFrame(evts, colId))
                        .catch(err => {
                            log.error(`[EventBase] Live query failed (${colId}):`, err);
                            return [];
                        })
                );
            }
        }

        const allResults = await Promise.all(promises);

        // Merge by event_id (or hash fallback) — keep the copy with the highest
        // cosine score so the re-ranker sees the best similarity signal per event.
        rawCandidates = dedupeEventsByIdentity(allResults.flat());

        log.verbose(`[EventBase] Live query: ${liveCollectionIds.length} collection(s) × ${queryTexts.length} query/queries → ${rawCandidates.length} unique events`);
    }

    // Merge in caller-supplied candidates: archive events (VectFox_archiveevent_*). They can
    // repeat a live hit, so dedupe the combined set by identity (keeping the highest score).
    let allCandidates;
    if (additionalCandidates?.length) {
        const combinedLen = rawCandidates.length + additionalCandidates.length;
        allCandidates = dedupeEventsByIdentity([...rawCandidates, ...additionalCandidates]);
        log.verbose(`[EventBase] Merged ${additionalCandidates.length} additional candidate(s) with ${rawCandidates.length} live → ${allCandidates.length} unique by identity (from ${combinedLen})`);
    } else {
        allCandidates = rawCandidates;
    }

    // 3. Filter by minimum importance — server already filtered _rerankApplied
    // candidates via the outer range filter in the formula query, so they pass
    // through unconditionally. Non-rerank candidates (archive events or fallback
    // path results) still go through the JS filter.
    //
    // Native ST backend (Vectra) cannot store arbitrary metadata, so importance
    // is never persisted for native-inserted events. When importance is absent,
    // default to minImportance (i.e. just-pass) rather than 0 so native users
    // still get results. Plugin/Qdrant data always carries the field.
    const importanceFiltered = allCandidates.filter(m => {
        if (m._rerankApplied) return true;
        const imp = m.importance ?? m.metadata?.importance;
        if (imp == null) return true;   // missing importance → pass (native backend)
        return imp >= minImportance;
    });

    log.verbose(`[EventBase] After importance filter (>=${minImportance}): ${importanceFiltered.length} candidates`);

    // 3. Build weights from settings
    const rawWeights = {
        cosine: settings.eventbase_rerank_w_cosine ?? DEFAULT_WEIGHTS.cosine,
        importance: settings.eventbase_rerank_w_importance ?? DEFAULT_WEIGHTS.importance,
        persist: settings.eventbase_rerank_w_persist ?? DEFAULT_WEIGHTS.persist,
        recency: settings.eventbase_rerank_w_recency ?? DEFAULT_WEIGHTS.recency,
    };
    const weights = _normalizeWeights(rawWeights);

    // 4. Re-rank
    // Pre-build anchor keyword lookup from the user's last message so that events
    // whose keywords explicitly match what the user just asked about get a boost.
    // Matching is substring-based (event keyword appears verbatim in anchor text)
    // which handles CJK multi-char terms (e.g. 還債) and Latin names alike.
    const anchorText = (keywordQuery || '').toLowerCase();

    // Anchor boost is computed for ALL candidates (both rerank-applied and not)
    // because anchor matching is intentionally substring-based — a semantic the
    // server-side formula path cannot replicate (multi-token LLM-extracted
    // keywords like "還債的經過" need verbatim substring presence in the user's
    // message, not tokenized any-of). Configurable via `eventbase_anchor_boost`.
    const anchorBoostAmount = _resolveAnchorBoostAmount(settings);

    const scored = importanceFiltered.map(meta => {
        const anchorBoost = _anchorBoostFor(meta, anchorText, anchorBoostAmount);

        if (meta._rerankApplied) {
            // Server-side formula already computed the weighted sum (cosine ×
            // RRF×scale + importance + persist + recency_decay). Just add the
            // client-side anchor boost on top — same additive shape as the JS
            // path's final line.
            const finalScore = (typeof meta.score === 'number' ? meta.score : 0) + anchorBoost;
            return { ...meta, _finalScore: finalScore };
        }

        // Legacy JS scoring (Standard backend, archive events, fallback path).
        // When hybrid is active, metadata carries vectorScore (raw cosine) separately
        // from the fusion score stored in .score. Prefer vectorScore so the re-ranker's
        // cosine weight retains its correct semantic meaning regardless of fusion method.
        const cosineScore = typeof meta.vectorScore === 'number'
            ? meta.vectorScore
            : (typeof meta.score === 'number' ? meta.score : 0);
        const importanceNorm = (meta.importance ?? 5) / 10;
        const persistBonus = meta.should_persist === true ? 1 : 0;
        const recencyBonus = _recencyBonus(meta, chatLength);

        const finalScore =
            weights.cosine * cosineScore +
            weights.importance * importanceNorm +
            weights.persist * persistBonus +
            weights.recency * recencyBonus +
            anchorBoost;

        return { ...meta, _finalScore: finalScore };
    });

    scored.sort((a, b) => b._finalScore - a._finalScore);

    // 5. Duplicate suppression (isDuplicateEvent).
    const dedupedEvents = [];
    for (const candidate of scored) {
        const repeated = dedupedEvents.find(accepted => isDuplicateEvent(candidate, accepted, settings));
        if (!repeated) {
            dedupedEvents.push(candidate);
        } else if (log.enabled('trace')) {
            const hasTiming = typeof repeated.source_window_end === 'number' && typeof candidate.source_window_end === 'number';
            log.trace(`[EventBase] Dedup: "${candidate.event_type}" suppressed (sim=${_candidateSimScore(candidate).toFixed(3)}${candidate._rerankApplied ? ' [formula]' : ''}, ${hasTiming ? `windows ${Math.abs(repeated.source_window_end - candidate.source_window_end)} msgs apart` : 'no timing info'})`);
        }
    }

    // 6. Dedup depth — skip events whose source window is already visible in recent context.
    const contextDedupedEvents = removeEventsVisibleInContext(dedupedEvents, { chatLength, settings, skipContextDedup });

    if (contextDedupedEvents.length < dedupedEvents.length) {
        log.verbose(`[EventBase] Dedup depth (${settings.deduplication_depth}) removed ${dedupedEvents.length - contextDedupedEvents.length} event(s) already visible in context`);
    }

    // 7. Trim to requested top-K
    const finalTopK = settings.eventbase_retrieval_top_k || 8;
    const finalEvents = contextDedupedEvents.slice(0, finalTopK);

    log.lifecycle(`[EventBase] Final events after dedup + trim: ${finalEvents.length}`);
    if (log.enabled('trace')) {
        finalEvents.forEach((e, i) => {
            log.trace(`  [${i}] type=${e.event_type} imp=${e.importance} score=${e._finalScore?.toFixed(3)} persist=${e.should_persist}`);
        });
    }

    return {
        events: finalEvents,
        // Everything the live searches found, before any filter or trim.
        poolEvents: rawCandidates,
        debug: {
            dualQuery,
            keywordScoringMethod: ebSettings.keyword_scoring_method,
            nativeHybridPrefer: settings.hybrid_native_prefer !== false,
            fusionMethod: settings.hybrid_fusion_method || 'rrf',
            nativeRerank: useNativeRerank,
            rerankComparison: comparisonLog || undefined,
            rawCount: rawCandidates.length,
            failedEmbeddingCount: failedEmbeddings.length,
            embeddingFailureMessage: failedEmbeddings.length ? String(failedEmbeddings[0]?.message || failedEmbeddings[0]) : '',
            archiveCandidates: additionalCandidates?.length || 0,
            afterImportanceFilter: importanceFiltered.length,
            afterDedup: dedupedEvents.length,
            afterContextDedup: contextDedupedEvents.length,
            finalCount: finalEvents.length,
            weights,
        },
    };
}
