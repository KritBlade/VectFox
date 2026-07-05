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

import { queryCollection } from './core-vector-api.js';
import { getBackendForCollection, getBackend } from '../backends/backend-manager.js';
import { parseRegistryKey } from './collection-ids.js';
import { parseEmbedText } from './eventbase-schema.js';
import { checkPluginAvailable } from './collection-loader.js';
import { log } from './log.js';

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
 *
 * @returns {Promise<Array<object>>} candidate metadata array (each tagged with _hash)
 */
async function _runOneLiveQuery({
    colId, queryText, topK, ebSettings, settings,
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
                        queryCollection(colId, queryText, topK, ebSettings),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`JS compare timed out after ${JS_COMPARE_TIMEOUT_MS}ms`)), JS_COMPARE_TIMEOUT_MS)
                        ),
                    ]).then(res => { jsCompletedAt = performance.now(); return res; })
                    : null;

                const { hashes, metadata } = await backend.hybridQueryWithRerank(
                    colId, queryText, topK, ebSettings, rerankParams
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
    const { hashes, metadata } = await queryCollection(colId, queryText, topK, ebSettings);
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
 * The agentic planner fans one user message into several queries, each of which
 * can surface the same stored event. Those duplicates must be merged by identity
 * BEFORE the similarity-dedup stage — otherwise its score-override escape hatch
 * (high-score candidates survive dedup) lets identical events straight through,
 * so the "final 10" can be just 2 unique events repeated (observed 2026-06-02).
 *
 * @param {object[]} events
 * @returns {object[]} one entry per identity, highest .score retained
 */
function _dedupeByIdentity(events) {
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
 * @returns {Promise<{ events: object[], debug: object }>}
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
    // See plans/qdrant-native-eventbase-rerank-formula.md.
    const useNativeRerank = (
        settings.vector_backend === 'qdrant'
        && settings.hybrid_native_prefer !== false
        && settings.eventbase_native_rerank === true
    );
    const compareMode = useNativeRerank && log.domainEnabled('rerank');

    // Detect "no vector scoring" state — Standard backend without the Similharity
    // plugin returns score=0 from the native /api/vector/query path (see
    // backends/standard.js:438). Coerce cosine to 0 so _normalizeWeights
    // redistributes its share onto importance/persist/recency, instead of
    // leaving it as dead weight that silently caps the effective scoring budget.
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
        const promises = [];
        for (const colId of liveCollectionIds) {
            for (const queryText of queryTexts) {
                promises.push(
                    _runOneLiveQuery({
                        colId,
                        queryText,
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
                    })
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
        rawCandidates = _dedupeByIdentity(allResults.flat());

        log.verbose(`[EventBase] Live query: ${liveCollectionIds.length} collection(s) × ${queryTexts.length} query/queries → ${rawCandidates.length} unique events`);
    }

    // Merge in caller-supplied candidates: archive events (VectFox_archiveevent_*)
    // and the agentic planner's per-query fanout. The fanout can surface the SAME
    // event from multiple queries, so dedupe the combined set by identity (keeping
    // the highest score) — otherwise identical events reach similarity-dedup as
    // separate candidates and the score-override escape hatch lets them through.
    let allCandidates;
    if (additionalCandidates?.length) {
        const combinedLen = rawCandidates.length + additionalCandidates.length;
        allCandidates = _dedupeByIdentity([...rawCandidates, ...additionalCandidates]);
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
    // which handles CJK multi-char terms (e.g. 贖身) and Latin names alike.
    const anchorText = (keywordQuery || '').toLowerCase();

    // Anchor boost is computed for ALL candidates (both rerank-applied and not)
    // because anchor matching is intentionally substring-based — a semantic the
    // server-side formula path cannot replicate (multi-token LLM-extracted
    // keywords like "贖身的儀式" need verbatim substring presence in the user's
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

    // 5. Duplicate suppression — same event_type + character overlap >= 60%
    //    AND temporal proximity (source windows within DUPLICATE_WINDOW_GAP messages)
    //    AND similarity score below DUPLICATE_SCORE_OVERRIDE.
    //
    //    Three conditions ALL have to hold for a candidate to be suppressed:
    //      (a) Same event_type as an already-accepted event
    //      (b) Character overlap (Jaccard) >= 60%
    //      (c) Source windows within DUPLICATE_WINDOW_GAP messages
    //      (d) Candidate's raw similarity score below DUPLICATE_SCORE_OVERRIDE
    //
    //    Why each condition:
    //      (a)+(b) catch the "same cast + same scene type" duplicate pattern that
    //              overlapping ingestion windows produce.
    //      (c)     prevents false positives where two distinct scenes happen to share
    //              the same cast type 50 days / 1000 messages apart.
    //      (d)     score-based escape hatch — a candidate that scored above 0.75 on
    //              the query is almost certainly a real signal the user asked for,
    //              not an ingestion artifact. Let it survive even if (a)+(b)+(c)
    //              would normally flag it. The thinking: real duplicates from
    //              overlapping windows tend to share scores closely with their
    //              "winner"; if a "duplicate" significantly out-scores or matches
    //              the query, it's more likely a distinct event with similar shape.
    //
    //    DUPLICATE_WINDOW_GAP is intentionally small (20 messages). Real ingestion
    //    duplicates come from overlapping windows during extraction (window size is
    //    typically 2-6 messages, so adjacent windows are within a few messages).
    //    Anything beyond 20 messages is almost certainly a distinct narrative beat.
    //
    //    DUPLICATE_SCORE_OVERRIDE = 0.75 is intentionally high. Most Qdrant RRF
    //    scores land in 0.2-0.6; crossing 0.75 means the query text and event are
    //    very tightly aligned (often a near-exact concept/keyword anchor match).
    // Configurable via `eventbase_dedup_window_gap` (Core tab slider, 0-200,
    // default 10). Semantics: events N or more messages apart are kept.
    //   0   → temporal-proximity dedup fully DISABLED (every distance kept,
    //         including same-window duplicates that were extracted from one chunk).
    //   1   → only literal same-window (distance=0) duplicates suppressed.
    //   10  → distances 0..9 suppressed; 10+ kept (default).
    //   200 → aggressive dedup (max).
    const DUPLICATE_WINDOW_GAP = typeof settings.eventbase_dedup_window_gap === 'number'
        ? Math.max(0, Math.min(200, settings.eventbase_dedup_window_gap))
        : 10;
    const DUPLICATE_SCORE_OVERRIDE = 0.75;
    const _candidateSimScore = (c) =>
        typeof c.score === 'number' ? c.score :
        typeof c.vectorScore === 'number' ? c.vectorScore : 0;

    const dedupedEvents = [];
    for (const candidate of scored) {
        let isDuplicate = false;
        for (const accepted of dedupedEvents) {
            if (accepted.event_type !== candidate.event_type) continue;
            if (_characterOverlap(accepted.characters || [], candidate.characters || []) < 0.6) continue;

            // Temporal proximity check: only suppress when source windows are close.
            // Semantics: gap N means "events N or more messages apart are KEPT
            // (treated as distinct)". So we use STRICT less-than:
            //   gap=1  → only same-window (distance 0) gets suppressed
            //   gap=20 → distances 0..19 get suppressed; 20+ are kept
            //   gap=200 → distances 0..199 get suppressed; 200+ are kept
            //
            // When either event is missing source_window_end (unknown timing), we
            // can't verify proximity — fall back to the old behavior (suppress) to
            // stay safe against unannotated duplicates.
            const aEnd = accepted.source_window_end;
            const cEnd = candidate.source_window_end;
            const haveTiming = typeof aEnd === 'number' && typeof cEnd === 'number';
            const withinWindow = haveTiming
                ? Math.abs(aEnd - cEnd) < DUPLICATE_WINDOW_GAP
                : true;  // unknown timing → treat as suspect (legacy safety)

            if (!withinWindow) continue;

            // Score-based escape hatch: high-similarity candidates survive dedup.
            // IMPORTANT: only apply on the JS path, where `score` is raw cosine /
            // RRF similarity (typically 0.2-0.6, threshold 0.75 is a real signal).
            // For `_rerankApplied` (Qdrant native formula path), `score` is the
            // server-side weighted sum (cosine·RRF + importance + persist + recency)
            // which routinely lands at 0.8-1.5+ for important persistent events —
            // applying the same 0.75 threshold would ALWAYS escape dedup and let
            // ingestion duplicates fill every slot (see Qdrant duplicate-fill bug).
            // Score override only applies when the accepted event is also on the JS
            // path (not formula-scored). If accepted._rerankApplied is true, its
            // formula score is authoritative and a high-cosine sibling chunk must not
            // escape — that's the exact scenario that causes duplicate chunk injection.
            if (!candidate._rerankApplied && !accepted._rerankApplied) {
                const candSim = _candidateSimScore(candidate);
                if (candSim >= DUPLICATE_SCORE_OVERRIDE) {
                    log.trace(`[EventBase] Dedup: "${candidate.event_type}" ESCAPED dedup via score override (sim=${candSim.toFixed(3)} >= ${DUPLICATE_SCORE_OVERRIDE}, windows ${haveTiming ? Math.abs(aEnd - cEnd) + ' msgs' : '?'} apart)`);
                    continue;  // not a duplicate after all — let it through
                }
            }

            isDuplicate = true;
            if (log.enabled('trace')) {
                const simForLog = _candidateSimScore(candidate);
                log.trace(`[EventBase] Dedup: "${candidate.event_type}" suppressed (sim=${simForLog.toFixed(3)}${candidate._rerankApplied ? ' [formula]' : ''}, ${haveTiming ? `windows ${Math.abs(aEnd - cEnd)} msgs apart` : 'no timing info'})`);
            }
            break;
        }
        if (!isDuplicate) dedupedEvents.push(candidate);
    }

    // 6. Dedup depth — skip events whose source window is already visible in recent context.
    // If source_window_end falls within the last deduplication_depth messages, the LLM can
    // already see that content directly; injecting the event adds redundant information.
    // Skipped when cross-chat locked: source_window_end belongs to a different conversation
    // and is meaningless relative to the current chat length.
    const dedupDepth = settings.deduplication_depth ?? 0;
    const visibleThreshold = dedupDepth > 0 ? chatLength - dedupDepth : -1;

    const contextDedupedEvents = (skipContextDedup || dedupDepth <= 0)
        ? dedupedEvents
        : dedupedEvents.filter(e => {
            // _rerankApplied events were already filtered server-side by the
            // outer range filter in the formula query (when applyContextDedupFilter
            // was true). Don't re-filter them or we'd double-apply.
            if (e._rerankApplied) return true;
            const windowEnd = e.source_window_end ?? -1;
            const inRecentContext = windowEnd >= visibleThreshold;
            if (inRecentContext) {
                log.trace(`[EventBase] Dedup-depth skip: event "${e.event_type}" source_window_end=${windowEnd} is within last ${dedupDepth} messages (threshold=${visibleThreshold})`);
            }
            return !inRecentContext;
        });

    if (contextDedupedEvents.length < dedupedEvents.length) {
        log.verbose(`[EventBase] Dedup depth (${dedupDepth}) removed ${dedupedEvents.length - contextDedupedEvents.length} event(s) already visible in context`);
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
        debug: {
            dualQuery,
            keywordScoringMethod: ebSettings.keyword_scoring_method,
            nativeHybridPrefer: settings.hybrid_native_prefer !== false,
            fusionMethod: settings.hybrid_fusion_method || 'rrf',
            nativeRerank: useNativeRerank,
            rerankComparison: comparisonLog || undefined,
            rawCount: rawCandidates.length,
            archiveCandidates: additionalCandidates?.length || 0,
            afterImportanceFilter: importanceFiltered.length,
            afterDedup: dedupedEvents.length,
            afterContextDedup: contextDedupedEvents.length,
            finalCount: finalEvents.length,
            weights,
        },
    };
}
