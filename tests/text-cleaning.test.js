/**
 * Tests for stripReasoningBlocks() in core/text-cleaning.js.
 *
 * Covers the agentic-planner contract: the model's reasoning / planning blocks
 * must be removed so the planner reads narrative, while the narrative that
 * follows the block (the invariant: "main text always comes after <think>")
 * is preserved. Regression guard for the 2026-06-02 over-strip where an
 * unterminated <think> deleted the entire reply.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// text-cleaning.js (and its log.js dependency) import the SillyTavern host path.
// Mock it so the module graph loads under node.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));
vi.mock('../../../../utils.js', () => ({
    uuidv4: () => 'test-uuid',
}));

import { stripReasoningBlocks, stripGameSystemBlocks } from '../core/text-cleaning.js';

describe('stripReasoningBlocks', () => {
    it('removes a paired <think>…</think> block and keeps the narrative after it', () => {
        const out = stripReasoningBlocks('<think>plan the scene</think>\n\n莉莉安遞給她一枚貝殼。');
        expect(out).toBe('莉莉安遞給她一枚貝殼。');
    });

    it('removes <thinking>…</thinking> too (case-insensitive)', () => {
        const out = stripReasoningBlocks('<Thinking>reasoning</Thinking>The door opened.');
        expect(out).toBe('The door opened.');
    });

    it('handles an unterminated <think> whose only close is the inner planning wrapper', () => {
        // Real format: <think> never gets </think>; <konatan_planning~> closes,
        // then the main text follows. Narrative must survive.
        const raw = '<think><konatan_planning~>主線：送別\n行文注意…</konatan_planning~>\n\n列車停下的動靜很輕。柯拉莉亞走過來。';
        const out = stripReasoningBlocks(raw);
        expect(out).toBe('列車停下的動靜很輕。柯拉莉亞走過來。');
        expect(out).not.toMatch(/konatan_planning|行文注意|主線/);
    });

    it('does not depend on <gametxt> — keeps whatever follows the reasoning block', () => {
        const raw = '<think><x_planning~>plan</x_planning~>\nPlain narrative with no gametxt wrapper.';
        expect(stripReasoningBlocks(raw)).toBe('Plain narrative with no gametxt wrapper.');
    });

    it('strips a mid-text reasoning block without harming surrounding narrative', () => {
        const out = stripReasoningBlocks('Before.<think>aside</think>After.');
        expect(out).toBe('Before.After.');
    });

    it('leaves plain narrative untouched', () => {
        const text = '卡希雅從文件夾掏出街道圖。';
        expect(stripReasoningBlocks(text)).toBe(text);
    });

    it('empty-guard: a reasoning-only reply falls back to non-empty content, never ""', () => {
        // <think>…</think> with nothing after → strict strip would be empty.
        // The guard returns the (tag-peeled) content rather than an empty turn.
        const out = stripReasoningBlocks('<think>全部都是思考內容，沒有正文</think>');
        expect(out).not.toBe('');
        expect(out).toContain('全部都是思考內容');
    });

    it('returns falsy / non-string input unchanged', () => {
        expect(stripReasoningBlocks('')).toBe('');
        expect(stripReasoningBlocks(null)).toBe(null);
        expect(stripReasoningBlocks(undefined)).toBe(undefined);
    });

    // GitHub issue #18. The Agent Mode planner asks for `response_format:
    // json_object`, which does NOT stop a thinking model emitting its reasoning
    // first. _callPlanner runs this strip before JSON.parse; without it the
    // leading block throws and Agent Mode drops to pre-search with only a log
    // line, reading to the user as "agent mode does nothing".
    it('leaves a thinking model’s JSON reply parseable (the Agent Mode planner shape)', () => {
        const raw = '<think>The user asked about the shell. I should query for it.</think>\n'
            + '{"queries":["貝殼 莉莉安"],"filters":{"importance_gte":3}}';

        const out = stripReasoningBlocks(raw);

        expect(() => JSON.parse(out.trim())).not.toThrow();
        expect(JSON.parse(out.trim()).queries).toEqual(['貝殼 莉莉安']);
    });

    it('same, when the model also fences the JSON', () => {
        // _callPlanner strips reasoning FIRST, then the ``` fence — the fence is
        // only findable at the string edges once the reasoning ahead of it is gone.
        const raw = '<think>planning</think>\n```json\n{"queries":["a"]}\n```';

        const cleaned = stripReasoningBlocks(raw)
            .trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        expect(JSON.parse(cleaned).queries).toEqual(['a']);
    });
});

describe('stripGameSystemBlocks', () => {
    it('removes <UpdateVariable> wrapping <UpdateAnalysis> and <JSONPatch>', () => {
        const raw = '故事內容。\n<UpdateVariable>\n<UpdateAnalysis>ledger</UpdateAnalysis>\n<JSONPatch>[{"op":"x"}]</JSONPatch>\n</UpdateVariable>\n結尾。';
        const out = stripGameSystemBlocks(raw);
        expect(out).toBe('故事內容。\n\n結尾。');
        expect(out).not.toMatch(/UpdateVariable|UpdateAnalysis|JSONPatch|op/);
    });

    it('removes standalone (un-wrapped) <JSONPatch> and <UpdateAnalysis>', () => {
        const raw = 'A.<UpdateAnalysis>x</UpdateAnalysis>B.<JSONPatch>[]</JSONPatch>C.';
        expect(stripGameSystemBlocks(raw)).toBe('A.B.C.');
    });

    it('removes <combat_log> (even when empty)', () => {
        expect(stripGameSystemBlocks('hit.<combat_log>\n</combat_log>done.')).toBe('hit.done.');
    });

    it('leaves narrative without game-system blocks untouched', () => {
        const text = '柯拉莉亞走過來，說「拜托你了」。';
        expect(stripGameSystemBlocks(text)).toBe(text);
    });

    it('composes with stripReasoningBlocks to yield narrative only', () => {
        const raw = '<think><konatan_planning~>plan</konatan_planning~>\n敘事。<combat_log></combat_log><UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
        expect(stripGameSystemBlocks(stripReasoningBlocks(raw))).toBe('敘事。');
    });

    // Regression on a representative captured reply. Uses a committed, dedicated
    // fixture (NOT Doc/log.txt — that's a shared scratchpad that gets overwritten
    // with debug logs, which silently broke this test). Replace the fixture with a
    // real captured reply anytime; it just needs the same block types + narrative.
    it('clears reasoning + game-system blocks from the real captured reply', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const sample = join(here, 'fixtures', 'captured-reply.txt');
        if (!existsSync(sample)) return; // sample not in this checkout — nothing to assert
        const raw = readFileSync(sample, 'utf8');
        const out = stripGameSystemBlocks(stripReasoningBlocks(raw));
        expect(out).not.toMatch(/UpdateVariable|UpdateAnalysis|JSONPatch|combat_log|konatan_planning|回顾当前情况/);
        // The narrative after the reasoning block must survive.
        expect(out).toMatch(/列車停下的動靜很輕/);
    });
});
