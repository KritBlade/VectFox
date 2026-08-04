/**
 * Tests for core/retrieval-budget.js — how many ms one turn may spend looking
 * things up.
 *
 * The bug these pin (GitHub issue #16): Agent Mode's planner timeout defaulted
 * to 30s and clamped to 60s in the UI, while the retrieval it runs inside was
 * hard-bounded at 15s. Raising the planner knob did nothing, agent mode timed
 * out on its own defaults, and the user had no setting to change — they reported
 * it as "can I edit the threshold? if not, why?".
 *
 * So two properties matter here and neither is obvious from reading one file:
 *   1. the base budget comes from settings, clamped, never from a constant alone
 *   2. the EventBase budget CONTAINS the agent-mode timeouts rather than
 *      competing with them — outer >= inner, always.
 */

import { describe, it, expect } from 'vitest';

import {
    resolveRetrievalTimeoutMs,
    resolveAgenticPlannerTimeoutMs,
    resolveAgenticQueryTimeoutMs,
    resolveAgenticMaxTokens,
    agenticRetrievalExtraBudgetMs,
    resolveEventBaseRetrievalTimeoutMs,
} from '../core/retrieval-budget.js';
import {
    RETRIEVAL_TIMEOUT_DEFAULT_MS,
    RETRIEVAL_TIMEOUT_MIN_MS,
    RETRIEVAL_TIMEOUT_MAX_MS,
    AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS,
    AGENTIC_QUERY_TIMEOUT_DEFAULT_MS,
    AGENTIC_TIMEOUT_MIN_MS,
    AGENTIC_TIMEOUT_MAX_MS,
    AGENTIC_MAX_TOKENS_DEFAULT,
    AGENTIC_MAX_TOKENS_MIN,
    AGENTIC_MAX_TOKENS_MAX,
} from '../core/constants.js';

/** Agent mode active: enabled AND on the only backend that supports it. */
const agentOn = { agentic_retrieval_enabled: true, vector_backend: 'qdrant' };

describe('resolveRetrievalTimeoutMs', () => {
    it('uses the default when the setting is absent', () => {
        expect(resolveRetrievalTimeoutMs(undefined)).toBe(RETRIEVAL_TIMEOUT_DEFAULT_MS);
        expect(resolveRetrievalTimeoutMs({})).toBe(RETRIEVAL_TIMEOUT_DEFAULT_MS);
    });

    it('honors a configured value', () => {
        expect(resolveRetrievalTimeoutMs({ retrieval_timeout_ms: 45000 })).toBe(45000);
    });

    // The field is a number input, and jQuery hands back its value as a string.
    it('accepts the string a number input actually produces', () => {
        expect(resolveRetrievalTimeoutMs({ retrieval_timeout_ms: '45000' })).toBe(45000);
    });

    it('clamps rather than trusting a mistyped value', () => {
        expect(resolveRetrievalTimeoutMs({ retrieval_timeout_ms: 1 })).toBe(RETRIEVAL_TIMEOUT_MIN_MS);
        expect(resolveRetrievalTimeoutMs({ retrieval_timeout_ms: 9_000_000 })).toBe(RETRIEVAL_TIMEOUT_MAX_MS);
    });

    // A zero here would mean "every retrieval times out instantly", i.e. memory
    // silently stops working — the exact failure mode the module guards against.
    it('falls back to the default on values that would disable retrieval', () => {
        for (const bad of [0, -1, null, NaN, '', 'later', {}]) {
            expect(resolveRetrievalTimeoutMs({ retrieval_timeout_ms: bad }), String(bad))
                .toBe(RETRIEVAL_TIMEOUT_DEFAULT_MS);
        }
    });
});

describe('agent mode timeouts', () => {
    it('default and clamp the same way as the base budget', () => {
        expect(resolveAgenticPlannerTimeoutMs({})).toBe(AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS);
        expect(resolveAgenticQueryTimeoutMs({})).toBe(AGENTIC_QUERY_TIMEOUT_DEFAULT_MS);

        expect(resolveAgenticPlannerTimeoutMs({ agentic_retrieval_timeout_ms: 1 })).toBe(AGENTIC_TIMEOUT_MIN_MS);
        expect(resolveAgenticQueryTimeoutMs({ agentic_retrieval_query_timeout_ms: 999_999 })).toBe(AGENTIC_TIMEOUT_MAX_MS);
    });

    // Issue #18: this was a hardcoded 2000 inside _callPlanner with no setting
    // and no UI, so a thinking planner — which spends the cap on reasoning before
    // emitting any JSON — could not be given more room.
    it('expose the planner token cap, defaulting to the literal it replaced', () => {
        expect(resolveAgenticMaxTokens({})).toBe(AGENTIC_MAX_TOKENS_DEFAULT);
        expect(AGENTIC_MAX_TOKENS_DEFAULT).toBe(2000);   // exposing a knob must not move behavior
    });

    it('honors and clamps a configured token cap, string included', () => {
        expect(resolveAgenticMaxTokens({ agentic_retrieval_max_tokens: 8000 })).toBe(8000);
        expect(resolveAgenticMaxTokens({ agentic_retrieval_max_tokens: '8000' })).toBe(8000);
        expect(resolveAgenticMaxTokens({ agentic_retrieval_max_tokens: 1 })).toBe(AGENTIC_MAX_TOKENS_MIN);
        expect(resolveAgenticMaxTokens({ agentic_retrieval_max_tokens: 999_999 })).toBe(AGENTIC_MAX_TOKENS_MAX);
    });

    // A 0 here would cap the planner at nothing, i.e. agent mode never works.
    it('falls back to the default on values that would starve the planner', () => {
        for (const bad of [0, -1, null, NaN, '', 'lots', {}]) {
            expect(resolveAgenticMaxTokens({ agentic_retrieval_max_tokens: bad }), String(bad))
                .toBe(AGENTIC_MAX_TOKENS_DEFAULT);
        }
    });

    it('adds nothing when agent mode is off', () => {
        expect(agenticRetrievalExtraBudgetMs({ vector_backend: 'qdrant' })).toBe(0);
        expect(agenticRetrievalExtraBudgetMs(undefined)).toBe(0);
    });

    // Same gate as STAGE 2 of retrieveEventsWithAgent: the planner never runs on
    // the standard backend, so paying for it would just make failures slower.
    it('adds nothing on a backend that cannot run the planner', () => {
        expect(agenticRetrievalExtraBudgetMs({ ...agentOn, vector_backend: 'standard' })).toBe(0);
    });

    it('adds planner + one per-query timeout when agent mode is live', () => {
        expect(agenticRetrievalExtraBudgetMs(agentOn))
            .toBe(AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS + AGENTIC_QUERY_TIMEOUT_DEFAULT_MS);
    });
});

describe('resolveEventBaseRetrievalTimeoutMs', () => {
    it('equals the base budget when agent mode is off', () => {
        expect(resolveEventBaseRetrievalTimeoutMs({ retrieval_timeout_ms: 20000 })).toBe(20000);
    });

    // THE regression. Before this, EventBase ran under a flat 15s while the
    // planner inside it was allowed 30s, so agent mode could not finish even on
    // stock settings.
    it('always leaves room for the agent-mode timeouts it wraps', () => {
        const settings = {
            ...agentOn,
            retrieval_timeout_ms: 15000,
            agentic_retrieval_timeout_ms: 45000,
            agentic_retrieval_query_timeout_ms: 20000,
        };
        const budget = resolveEventBaseRetrievalTimeoutMs(settings);

        expect(budget).toBe(15000 + 45000 + 20000);
        expect(budget).toBeGreaterThan(resolveAgenticPlannerTimeoutMs(settings));
        expect(budget).toBeGreaterThan(resolveAgenticQueryTimeoutMs(settings));
    });

    it('leaves room on stock settings too — the reported case needed no tuning', () => {
        expect(resolveEventBaseRetrievalTimeoutMs(agentOn))
            .toBeGreaterThan(AGENTIC_PLANNER_TIMEOUT_DEFAULT_MS + AGENTIC_QUERY_TIMEOUT_DEFAULT_MS);
    });
});
