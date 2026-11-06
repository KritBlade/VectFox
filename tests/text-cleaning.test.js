/**
 * Tests for src/features/text-cleaning/text-cleaning.js.
 *
 * stripReasoningBlocks / stripGameSystemBlocks: the agentic-planner contract —
 * reasoning, planning and engine blocks are removed so the planner reads
 * narrative, while the narrative that follows a reasoning block (the invariant:
 * "main text always comes after <think>") is preserved, including an
 * unterminated <think>.
 *
 * strip_mvu_engine_tags: the vectorization builtin removes MVU engine state and
 * UI-scaffolding blocks (paired and self-closing) without touching narrative.
 *
 * strip_mvu_pictures / strip_mvu_cast_records: the vectorization builtins remove
 * mvu-helper's stored pictures (every wrap shape it writes, with the image
 * prompts inside) and its <cast> records, and never swallow prose next to a
 * shape they don't know.
 *
 * strip_thinking_tags: the vectorization builtin removes closed thinking blocks and
 * planning wrappers, so the event extractor does not read them, and leaves a tag with
 * no closing tag, since nothing says where its thinking ends.
 *
 * strip_mvu_status_tags / strip_mvu_world_blocks / strip_mvu_internal_states: paired
 * patterns that start at the opener nearest the closer, so a quoted tag name cannot
 * make them eat the story.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// text-cleaning.js reaches SillyTavern through src/sillytavern/: settings.js (extensions.js and
// script.js), identifiers.js (utils.js) and log.js (extensions.js). Mock each host module so the
// module graph loads under node; script.js is empty because text-cleaning.js calls nothing from it.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));
vi.mock('../../../../../script.js', () => ({}));
vi.mock('../../../../utils.js', () => ({
    uuidv4: () => 'test-uuid',
}));

import {
    stripReasoningBlocks,
    stripGameSystemBlocks,
    BUILTIN_PATTERNS,
    CLEANING_PRESETS,
    getCleaningSettings,
    testPattern,
    cleanText,
} from '../src/features/text-cleaning/text-cleaning.js';

// The picture shapes mvu-helper writes into message.mes
// (mvu-helper src/features/imagegen/image-splice-core.js): the original <pic>
// tag rides HTML-escaped in data-rawtag, the full image prompt in the <img> title.
const ESCAPED_PIC_TAG = '&lt;pic char=&quot;橘美月&quot; outfit=&quot;default&quot; prompt=&quot;1girl, mitsuki pouting &gt;_&lt; at the gate&quot;&gt;';
const PICTURE_WRAPS = {
    rendered: `<span class="auto-img-wrap" data-rawtag="${ESCAPED_PIC_TAG}"><img src="/user/images/ArtificKoi/a.png" title="masterpiece, best quality, 1girl, mitsuki pouting" alt="generated image">`
        + '<span class="auto-img-regen fa-solid fa-arrows-rotate" title="Regenerate image" role="button" tabindex="0" style="cursor:pointer;margin-inline-start:6px;opacity:0.7;"></span></span>',
    'rendered with debug line': `<span class="auto-img-wrap" data-rawtag="${ESCAPED_PIC_TAG}"><img src="/user/images/ArtificKoi/a.png" title="masterpiece, best quality, 1girl" alt="generated image">`
        + `<code class="auto-img-pictag" style="display:block;font-size:0.75em;opacity:0.65;overflow-wrap:anywhere;">${ESCAPED_PIC_TAG}</code>`
        + '<span class="auto-img-regen fa-solid fa-arrows-rotate" title="Regenerate image" role="button" tabindex="0"></span></span>',
    unrendered: `<span class="auto-img-wrap" data-rawtag="${ESCAPED_PIC_TAG}">`
        + `<code class="auto-img-pictag" style="display:block;font-size:0.75em;opacity:0.65;overflow-wrap:anywhere;">${ESCAPED_PIC_TAG}</code>`
        + '<span class="auto-img-unrendered" title="This pic tag was not rendered (generation failed, or it was over the per-reply image cap)"></span></span>',
    trace: `<span class="auto-img-wrap" data-rawtag="${ESCAPED_PIC_TAG}"><span class="auto-img-trace"></span></span>`,
};

const stripWith = (builtinId) => (text) => {
    const { pattern, flags, replacement } = BUILTIN_PATTERNS[builtinId];
    const outcome = testPattern(pattern, flags, replacement, text);
    expect(outcome.success).toBe(true);
    return outcome.result;
};

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

    it.each(['thinking_left', 'reasoning'])('removes <%s> blocks too', (tag) => {
        expect(stripReasoningBlocks(`<${tag}>plan</${tag}>The door opened.`)).toBe('The door opened.');
    });

    it('takes a <thinking_*> tag with no partner, as it does <think>', () => {
        expect(stripReasoningBlocks('<thinking_left>The door opened.')).toBe('The door opened.');
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
    // first. callLlmForJson runs this strip before JSON.parse; without it the
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
        // callLlmForJson strips reasoning FIRST, then the ``` fence — the fence is
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

    it('removes mvu-helper pictures, cast records and the <reply_cast> block', () => {
        const raw = `美月跑了過來。\n${PICTURE_WRAPS.rendered}\n<cast name="橘美月" outfit="default">\n<reply_cast>\n<cast name="有川真奈">\n</reply_cast>`;
        expect(stripGameSystemBlocks(raw)).toBe('美月跑了過來。');
    });
});

describe('strip_thinking_tags builtin', () => {
    const strip = stripWith('strip_thinking_tags');

    it.each(['think', 'thinking', 'thinking_left', 'thinking_step_2', 'THINK'])('removes a closed <%s> block and keeps the story after it', (tag) => {
        expect(strip(`<${tag}>plan the scene</${tag}>The door opened.`)).toBe('The door opened.');
    });

    it('removes a block whose open tag has attributes', () => {
        expect(strip('<think depth="2">plan</think>The door opened.')).toBe('The door opened.');
    });

    it('removes a closed planning wrapper inside a <think> that is never closed, and leaves that <think>', () => {
        expect(strip('<think><writer_planning~>主線：送別</writer_planning~>\n\n列車停下的動靜很輕。')).toBe('<think>\n\n列車停下的動靜很輕。');
    });

    it.each(['<think>', '<thinking_left>', '<writer_planning~>', '</think>', '</thinking_left>', '</writer_planning~>'])('leaves %s when it has no partner', (tag) => {
        const text = `${tag}列車停下的動靜很輕。`;
        expect(strip(text)).toBe(text);
    });

    it('starts at the opener nearest the closer, so a <think> never closed keeps the story after it', () => {
        expect(strip('<think>\n列車停下的動靜很輕。\n<think>草稿</think>\n她下了車。')).toBe('<think>\n列車停下的動靜很輕。\n\n她下了車。');
    });

    it('needs the closing tag of the same name', () => {
        const text = '<thinking_left>列車停下的動靜很輕。</thinking_right>';
        expect(strip(text)).toBe(text);
    });

    it('leaves tags whose name only starts with a thinking name untouched', () => {
        const text = '<thinker>a</thinker><thinking-cap>b</thinking-cap><thinking_>c</thinking_>';
        expect(strip(text)).toBe(text);
    });
});

describe('paired patterns start at the opener nearest the closer', () => {
    const PAIRS = [
        ['strip_mvu_status_tags', '<current_event>', '</current_event>'],
        ['strip_mvu_status_tags', '<Analysis>', '</Analysis>'],
        ['strip_mvu_status_tags', '<konatan_chat>', '</konatan_chat>'],
        ['strip_mvu_world_blocks', '<Blocks>', '</Blocks>'],
        ['strip_mvu_world_blocks', '<World_State>', '</World_State>'],
        ['strip_mvu_world_blocks', '<Bonds>', '</Bonds>'],
        ['strip_mvu_internal_states', '<!-- GFX_START -->', '<!-- GFX_END -->'],
        ['strip_mvu_internal_states', '<internal_states>', '</internal_states>'],
    ];

    it.each(PAIRS)('%s removes %s, and leaves a quote of it and the story alone', (builtinId, open, close) => {
        const before = `<think>\nNext I will print ${open} and fill it.\n故事在這裡。\n`;
        const out = stripWith(builtinId)(`${before}${open}\nREAL BODY\n${close}\nAFTER`);
        expect(out).toBe(`${before}AFTER`);
    });

    it('leaves a block that never closes', () => {
        const text = '故事。\n<Blocks>\n<World_State>x';
        expect(stripWith('strip_mvu_world_blocks')(text)).toBe(text);
    });

    it('leaves tags whose name only ends or starts with a listed name untouched', () => {
        const text = '<UpdateAnalysis>a</UpdateAnalysis><StoryAnalysis>b</StoryAnalysis><current_event_log>c</current_event_log>';
        expect(stripWith('strip_mvu_status_tags')(text)).toBe(text);
    });

    it('keeps <progress>, where the event extractor finds a scene\'s date and clock time', () => {
        const text = '<progress>1577年8月17日 22:30</progress>';
        expect(cleanText(text)).toBe(text);
    });
});

describe('strip_mvu_engine_tags builtin', () => {
    const strip = stripWith('strip_mvu_engine_tags');

    // Shape of a real ArtificKoi reply: narrative inside <maintext>, engine
    // blocks after it, and a self-closing <background … /> up front.
    const reply = [
        '<maintext>',
        '<background scene="gcd6g3mt-ioxmse_scene_1_1sgldoj" />',
        '<p>美月整個人趴在課桌上。</p>',
        '<styled type="terminal" title="Scene Stats">\nMitsuki Tachibana: Affection 19 (+4)\n</styled>',
        '</maintext>',
        '<reply_cast>\n<cast name="Mitsuki">\n</reply_cast>',
        '<choices>\n1. 吃下厚蛋燒\n2. 拒絕\n</choices>',
        '<classmate_trait_check>\nMitsuki: Tsundere\n</classmate_trait_check>',
        '<POSTUpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/Intent/initiative/0"}]</JSONPatch>\n</POSTUpdateVariable>',
        '<RES_Variable>\n[{"op":"replace","path":"/World/Time/0","value":"12:05"}]\n</RES_Variable>',
        '<RES_POST_Variable>\n[{"op":"replace","path":"/Classmate/Mitsuki/LastInitiative/0"}]\n</RES_POST_Variable>',
    ].join('\n');

    it('removes every engine state / scaffolding block and keeps the narrative', () => {
        const out = strip(reply);
        expect(out).not.toMatch(/background|reply_cast|cast name|choices|厚蛋燒|classmate_trait_check|Tsundere/);
        expect(out).not.toMatch(/POSTUpdateVariable|RES_Variable|RES_POST_Variable|JSONPatch|"op"/);
        expect(out).not.toMatch(/styled|Scene Stats|Affection/);
        expect(out).toContain('<p>美月整個人趴在課桌上。</p>');
        expect(out).toContain('<maintext>');
        expect(out).toContain('</maintext>');
    });

    it('closes <RES_Variable> on its own closer, not on a sibling <RES_POST_Variable>', () => {
        const out = strip('<RES_Variable>a</RES_Variable>keep<RES_POST_Variable>b</RES_POST_Variable>');
        expect(out).toBe('keep');
    });

    it('is non-greedy across sibling blocks of the same tag', () => {
        expect(strip('<choices>1</choices>middle<choices>2</choices>')).toBe('middle');
    });

    it('leaves a tag whose name only starts with a listed name untouched', () => {
        const text = '<backgroundMusic>rain</backgroundMusic><stylesheet>x</stylesheet>';
        expect(strip(text)).toBe(text);
    });

    it('is enabled by the default cleaning settings (fresh install)', () => {
        const out = cleanText(reply);
        expect(out).not.toMatch(/RES_Variable|reply_cast|Scene Stats|<background/);
        expect(out).toContain('美月整個人趴在課桌上。');
    });
});

describe('strip_mvu_pictures builtin', () => {
    const strip = stripWith('strip_mvu_pictures');

    it.each(Object.entries(PICTURE_WRAPS))('removes the %s wrap whole, image prompts included', (shape, wrap) => {
        expect(strip(`前文。\n${wrap}\n後文。`)).toBe('前文。\n\n後文。');
    });

    it('removes a bare <img> and its title prompt', () => {
        expect(strip('A<img src="/user/images/a.png" title="1girl, smile" alt="a">B')).toBe('AB');
    });

    it('removes an undrawn <pic> whose quoted prompt contains ">"', () => {
        expect(strip('A<pic char="橘美月" outfit="default" prompt="mitsuki pouting >_< at the gate">B')).toBe('AB');
    });

    it('leaves a wrap holding anything else alone, so the prose after it survives', () => {
        const text = '<span class="auto-img-wrap"><b>kept</b></span>美月笑了。</span></span>';
        expect(strip(text)).toBe(text);
    });

    it('leaves tags whose name only starts with pic or img untouched', () => {
        const text = '<picture><source srcset="a.webp"></picture><image_generation>rules</image_generation>';
        expect(strip(text)).toBe(text);
    });
});

describe('strip_mvu_cast_records builtin', () => {
    const strip = stripWith('strip_mvu_cast_records');

    it('removes every record and keeps the prose between them', () => {
        expect(strip('<cast name="橘美月" outfit="default">\n美月笑了。\n<cast name="有川真奈" key="mana">'))
            .toBe('\n美月笑了。\n');
    });

    it('cannot cross a line, so a record missing its ">" never swallows the prose after it', () => {
        const text = '<cast name="橘美月" outfit="default\n美月笑了。>';
        expect(strip(text)).toBe(text);
    });

    it('leaves tags whose name only starts with cast untouched', () => {
        const text = '<castle>tower</castle><cast_list>a</cast_list>';
        expect(strip(text)).toBe(text);
    });
});

describe('MVU preset', () => {
    it('is the fresh-install default', () => {
        expect(getCleaningSettings().selectedPreset).toBe('mvu_game_maker');
        expect(CLEANING_PRESETS.mvu_game_maker.name).toBe('MVU');
    });

    it('holds every MVU builtin, so a new one reaches everyone on the preset', () => {
        const mvuBuiltins = Object.keys(BUILTIN_PATTERNS).filter((id) => id.startsWith('strip_mvu_'));
        expect(CLEANING_PRESETS.mvu_game_maker.patterns).toEqual(expect.arrayContaining(mvuBuiltins));
    });

    it('cleans pictures and cast records on a fresh install', () => {
        const reply = `<p>美月跑了過來。</p>\n${PICTURE_WRAPS.rendered}\n<cast name="橘美月" outfit="default">`;
        expect(cleanText(reply)).toBe('<p>美月跑了過來。</p>');
    });

    it('leaves the story and <progress> of a whole reply, with no tag lookup', () => {
        const reply = [
            '<think><writer_planning~>主線：送別</writer_planning~></think>',
            '<Analysis>分析</Analysis>',
            '<content>',
            '<p>美月跑了過來。</p>',
            '</content>',
            '<tucao>吐槽</tucao>',
            '<current_event>事件</current_event>',
            '<progress>進度</progress>',
            '<konatan_chat>閒聊</konatan_chat>',
            '<cast name="橘美月" outfit="school" clothes="校服">',
            '<Blocks>\n<World_State>weather: clear</World_State>\n</Blocks>',
            '<!-- GFX_START -->\n<div>panel</div>\n<!-- GFX_END -->',
            '<internal_states>state</internal_states>',
        ].join('\n');
        expect(cleanText(reply)).toBe('<content>\n<p>美月跑了過來。</p>\n</content>\n\n<progress>進度</progress>');
    });
});
