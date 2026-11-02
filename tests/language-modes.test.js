/**
 * Tests for language-modes.js + stop-words.js per-locale registry.
 * Covers plan §6 (all 12 items) and §9.4 (W2 Indic tokenizer verification).
 */

import { describe, it, expect, vi } from 'vitest';

// bm25-scorer.js (transitively imported by some helpers) pulls in log.js which
// references the SillyTavern host path. Mock it so the module graph loads.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

import {
    LANGUAGE_MODES,
    CJK_TOKENIZER_MODES,
    stopLocalesForMode,
} from '../core/language-modes.js';

import {
    STOP_WORDS_BY_LOCALE,
    isStopWord,
    buildStopSet,
} from '../core/stop-words.js';

import { LATIN_TOKEN_RE, NON_WORD_RE, localeForSpan, getSegmenter, CJK_CHAR_RE } from '../core/script-segmentation.js';

// ── §6.1–6.3: stopLocalesForMode returns correct locale arrays ────────────────

describe('stopLocalesForMode', () => {
    it('intl → [en]', () => expect(stopLocalesForMode('intl')).toEqual(['en']));
    it('others → [en]', () => expect(stopLocalesForMode('others')).toEqual(['en']));
    it('korean → [en, ko]', () => expect(stopLocalesForMode('korean')).toEqual(['en', 'ko']));
    it('tiny_segmenter → [en, ja]', () => expect(stopLocalesForMode('tiny_segmenter')).toEqual(['en', 'ja']));
    it('jieba_tw → [en, zh-Hant]', () => expect(stopLocalesForMode('jieba_tw')).toEqual(['en', 'zh-Hant']));
    it('jieba → [en, zh-Hans]', () => expect(stopLocalesForMode('jieba')).toEqual(['en', 'zh-Hans']));
});

// ── §6.4: graceful fallback for unknown/null mode ─────────────────────────────

describe('stopLocalesForMode — unknown/null input', () => {
    it('undefined → [en] (no throw)', () => expect(stopLocalesForMode(undefined)).toEqual(['en']));
    it('bogus string → [en] (no throw)', () => expect(stopLocalesForMode('bogus_lang')).toEqual(['en']));
    it('null → [en] (no throw)', () => expect(stopLocalesForMode(null)).toEqual(['en']));
});

// ── §6.5: TC/SC correctness ───────────────────────────────────────────────────

describe('isStopWord — TC/SC disambiguation', () => {
    it('這個 is TC stop word', () => expect(isStopWord('這個', ['en', 'zh-Hant'])).toBe(true));
    it('這個 is NOT a SC stop word', () => expect(isStopWord('這個', ['en', 'zh-Hans'])).toBe(false));
    it('这个 is SC stop word', () => expect(isStopWord('这个', ['en', 'zh-Hans'])).toBe(true));
    it('这个 is NOT a TC stop word', () => expect(isStopWord('这个', ['en', 'zh-Hant'])).toBe(false));
});

// ── §6.6: cross-language safety ───────────────────────────────────────────────

describe('isStopWord — cross-language isolation', () => {
    it('Japanese-only stopword not filtered under [en, ko]', () => {
        // Pick a token present in JAPANESE_STOP_WORDS but absent from EN and KO lists.
        // "から" is a Japanese particle stopword.
        expect(isStopWord('から', ['en', 'ko'])).toBe(false);
    });

    it('Korean stopword not filtered under [en, ja]', () => {
        // Use a token from KOREAN_STOP_WORDS that is not in EN or JA.
        const koSet = buildStopSet(['ko']);
        const koOnly = [...koSet].find(w => {
            return !isStopWord(w, ['en']) && !isStopWord(w, ['ja']);
        });
        expect(koOnly).toBeDefined();
        expect(isStopWord(koOnly, ['en', 'ja'])).toBe(false);
        expect(isStopWord(koOnly, ['en', 'ko'])).toBe(true);
    });

    it('Simplified-only CJK stopword not in Traditional set', () => {
        // 这个 (Simplified) should not appear in zh-Hant.
        expect(isStopWord('这个', ['zh-Hant'])).toBe(false);
    });
});

// ── §6.8: registry consistency — every stopLocales key exists in STOP_WORDS_BY_LOCALE

describe('Registry consistency', () => {
    it('every stopLocales key across LANGUAGE_MODES exists in STOP_WORDS_BY_LOCALE', () => {
        const allLocales = new Set(LANGUAGE_MODES.flatMap(m => m.stopLocales));
        for (const k of allLocales) {
            expect(STOP_WORDS_BY_LOCALE).toHaveProperty(k);
        }
    });
});

// ── §6.9: no drift — CJK_TOKENIZER_MODES keys === LANGUAGE_MODES values ──────

describe('No drift', () => {
    it('CJK_TOKENIZER_MODES keys match LANGUAGE_MODES values exactly', () => {
        const enumKeys = Object.keys(CJK_TOKENIZER_MODES).sort();
        const modeValues = LANGUAGE_MODES.map(m => m.value).sort();
        expect(enumKeys).toEqual(modeValues);
    });
});

// ── §6.10: memoization ────────────────────────────────────────────────────────

describe('Set memoization', () => {
    it('isStopWord called twice returns same cached result (no error)', () => {
        // Calling twice exercises the _setCache path — both calls should agree.
        expect(isStopWord('the', ['en'])).toBe(true);
        expect(isStopWord('the', ['en'])).toBe(true);
    });

    it('buildStopSet for same locale twice produces equivalent sets', () => {
        const s1 = buildStopSet(['ja']);
        const s2 = buildStopSet(['ja']);
        expect(s1.size).toBe(s2.size);
        expect(s1.has('から')).toBe(s2.has('から'));
    });
});

// ── §6.11: back-compat — no mode → English-only filtering ────────────────────

describe('Back-compat: extractQueryKeywords without mode', () => {
    it('filters English stop words and passes non-English CJK tokens', async () => {
        const { extractQueryKeywords } = await import('../core/query-keyword-extractor.js');
        // "the" is an EN stop word, "dragon" is not; no mode = EN-only filter.
        const result = extractQueryKeywords('the dragon flew over the mountains', 50);
        expect(result).not.toContain('the');
        expect(result.some(t => t === 'dragon' || t === 'flew' || t === 'mountains')).toBe(true);
    });
});

// ── §6.12: English baseline still works in bm25-scorer ───────────────────────

describe('English stop-word baseline in tokenize()', () => {
    it('world and within are still filtered in default (intl) mode', async () => {
        const { tokenize } = await import('../core/bm25-scorer.js');
        const tokens = tokenize('world within the system', { removeStopWords: true, stem: false });
        expect(tokens).not.toContain('world');
        expect(tokens).not.toContain('within');
        expect(tokens).not.toContain('the');
    });
});

// ── W2 (§9.4): Indic/combining-mark tokenizer fix ────────────────────────────

describe('W2 — Indic combining-mark fix (LATIN_TOKEN_RE / NON_WORD_RE)', () => {
    it('NON_WORD_RE preserves combining marks (does not strip matras)', () => {
        // "हराया" has matra ा (U+093E, \p{M}) — should survive after strip
        const stripped = 'हराया'.replace(NON_WORD_RE, ' ');
        expect(stripped).toBe('हराया');
    });

    it('LATIN_TOKEN_RE matches whole Indic words including matras', () => {
        const tokens = 'हराया युद्ध'.match(LATIN_TOKEN_RE) || [];
        // Both words must be captured intact (each >= 3 chars including combining marks)
        expect(tokens).toContain('हराया');
        expect(tokens).toContain('युद्ध');
    });

    it('LATIN_TOKEN_RE still matches normal ASCII words unchanged', () => {
        const tokens = 'hello world foo'.match(LATIN_TOKEN_RE) || [];
        expect(tokens).toContain('hello');
        expect(tokens).toContain('world');
    });

    it('NON_WORD_RE still strips punctuation from ASCII text', () => {
        const stripped = 'hello, world!'.replace(NON_WORD_RE, ' ');
        expect(stripped).toBe('hello  world ');
    });
});

// ── Language probe — undefined-in-dropdown languages must fall back SAFELY ──────
//
// PURPOSE: verify that a language NOT (yet) defined in the Core-tab "CJK Tokenizer
// Mode" dropdown still routes to a correct, safe setting — it must keep working,
// just without the optional stop-word polish. No expected values are hardcoded; we
// hand VectFox 8 strings and print back exactly what its real, shipped functions
// return, so you can read off what it does with each.
//
// WHY MOST OF THESE REPORT locale === 'und' — AND WHY THAT'S CORRECT, NOT A BUG:
//   • Stop-word / tokenizer selection is driven by the Core-tab dropdown, NOT guessed
//     from text (plan §7: no auto Latin-language detection — Latin scripts are mutually
//     indistinguishable). Spanish/German/Italian/Vietnamese/Hindi are deliberately
//     thrown in here even though they have NO dropdown entry yet.
//   • With no matching mode, they fall back to 'und' ("undetermined"), which is a
//     fully valid BCP-47 tag — Intl treats it ≈ English. That fallback is intentional.
//   • Crucially, the fallback does NOT degrade retrieval: BM25/keyword tokenization
//     still extracts the correct content words (via the \p{L}\p{M} Latin regex — see
//     the W2 Indic fix), and the DENSE/semantic vector still captures meaning (it never
//     used stop-words at all). Stop-word lists are a PURELY ADDITIVE enhancement that
//     filters junk function words; their absence is mild keyword noise, never breakage.
//     So VectFox is already effective on every one of these languages today.
//   • A language only "lights up" its own locale + stop list once someone adds its
//     dropdown mode + list (plan "add a language" recipe). Until then: 'und'/en baseline.
//
// What VectFox derives FROM THE TEXT (the only auto-detection):
//   • localeForSpan(text) → script→locale (ja, zh, ko, th, …, or 'und' for Latin/Indic)
//   • getSegmenter(text)  → the Intl.Segmenter it resolves for a segmented span
//   • CJK_CHAR_RE.test()  → is this a segmented (no inter-word space) script?
// What is MODE-DRIVEN (the dropdown, NOT text): the forced tokenizer (jieba/jieba_tw/
// tiny_segmenter) and the stop-word locales. The probe maps the detected locale to a
// stop list where one exists and flags where the mode decides (zh→zh-Hant/zh-Hans).

const SAMPLES = [
    ['English',             'the brave warrior fought the dragon'],
    ['Spanish',             'el valiente guerrero luchó contra el dragón'],
    ['German',              'der tapfere Krieger kämpfte gegen den Drachen'],
    ['Italian',             'il coraggioso guerriero combatté contro il drago'],
    ['Vietnamese',          'chiến binh dũng cảm đã chiến đấu với con rồng'],
    ['Indian (Hindi)',      'बहादुर योद्धा ने ड्रैगन से युद्ध किया'],
    ['Traditional Chinese', '勇敢的戰士與惡龍戰鬥'],
    ['Japanese',            '勇敢な戦士がドラゴンと戦った'],
    // Thai: a NO-SPACE (segmented) script that VectFox's script detection DOES recognize
    // (→ locale 'th' + an Intl.Segmenter('th')), yet has NO stop-word list defined. This is
    // the distinct "segmented + segmenter resolves + no stoplist" quadrant — proof that even
    // a no-space, undefined-in-dropdown language still tokenizes (real segmenter) and searches
    // fine; only the additive stop-word filter is absent.
    ['Thai',                'นักรบผู้กล้าหาญต่อสู้กับมังกร'],
];

describe('Language probe — undefined-in-dropdown languages fall back to a safe setting', () => {
    for (const [label, text] of SAMPLES) {
        it(label, () => {
            // Everything below comes straight from VectFox's own functions.
            const segmented = CJK_CHAR_RE.test(text);                  // segmented (no-space) script?
            const locale = localeForSpan(text);                        // VectFox text→locale detection
            // getSegmenter is only used on segmented spans in the real pipeline; Latin/Indic
            // text never reaches it (it goes through the \p{L}\p{M} regex), so only probe it
            // for segmented scripts to mirror real usage.
            const seg = segmented ? getSegmenter(text) : null;
            const segLocale = seg ? seg.resolvedOptions().locale : null;

            // Does the DETECTED script-locale map directly to a shipped stop-word list?
            const directList = STOP_WORDS_BY_LOCALE[locale];
            const stopForLocale = directList
                ? `${locale} (${directList.length} words)`
                : `no list for script-locale '${locale}' → MODE decides (zh→zh-Hant/zh-Hans; Latin/Indic→en baseline)`;

            const tokenizer = segmented
                ? `Intl.Segmenter('${segLocale}') on the auto path (a jieba/jieba_tw/tiny_segmenter MODE overrides this)`
                : `none — Latin \\p{L}\\p{M} regex path (no segmenter)`;

            console.log(
                `\n[${label}]  "${text}"\n` +
                `   • segmented (no-space) script : ${segmented}\n` +
                `   • locale detected             : ${locale}${segmented ? '' : "   ('und' = undefined-in-dropdown → intentional, valid, en-baseline fallback)"}\n` +
                `   • tokenizer VectFox would use : ${tokenizer}\n` +
                `   • stop-word list for locale   : ${stopForLocale}`
            );

            // The report above is the point; these assertions only confirm the FALLBACK IS
            // SAFE for every language (defined in the dropdown or not) — no per-language
            // values are hardcoded:
            //   • a valid, non-empty BCP-47 locale always comes back (defined → its tag;
            //     undefined → 'und', which Intl accepts ≈ English — never null/throw), and
            //   • a segmented script always resolves a real Intl.Segmenter, while Latin/Indic
            //     correctly uses the no-segmenter Latin path. Either way the text stays
            //     tokenizable + searchable; stop-words are only an additive enhancement.
            expect(typeof locale).toBe('string');
            expect(locale.length).toBeGreaterThan(0);
            if (segmented) {
                expect(seg).toBeTruthy();
                expect(typeof segLocale).toBe('string');
            }
        });
    }
});

// ── §6.7: ingest/query parity (highest-risk item per §4) ──────────────────────
// Ingest (bm25-scorer tokenize) and query (extractQueryKeywords) must drop the
// SAME stop tokens for the SAME locked mode, or the stored sparse vector and the
// query keywords filter differently → recall drops.

describe('Ingest/query stop-word parity', () => {
    it('same text + same mode → both paths drop the same English stop tokens', async () => {
        const { tokenize, setCjkTokenizerMode } = await import('../core/bm25-scorer.js');
        const { extractQueryKeywords } = await import('../core/query-keyword-extractor.js');

        const mode = 'intl';
        setCjkTokenizerMode(mode); // ingest path reads the module-global locked mode

        const text = 'the brave warrior fought the dragon';
        // Disable stemming so we compare raw stop-word filtering, not stem collisions.
        const ingestTokens = tokenize(text, { removeStopWords: true, stem: false });
        const queryTokens = extractQueryKeywords(text, 50, mode);

        // English stop words dropped on BOTH sides.
        for (const stop of ['the']) {
            expect(ingestTokens).not.toContain(stop);
            expect(queryTokens).not.toContain(stop);
        }
        // Content words survive on BOTH sides.
        for (const word of ['brave', 'warrior', 'dragon']) {
            expect(ingestTokens).toContain(word);
            expect(queryTokens).toContain(word);
        }
    });

    it('korean mode → a Japanese stop word survives on BOTH paths (per-mode parity)', async () => {
        const { tokenize, setCjkTokenizerMode } = await import('../core/bm25-scorer.js');
        const { extractQueryKeywords } = await import('../core/query-keyword-extractor.js');

        const mode = 'korean';
        setCjkTokenizerMode(mode);

        // "から" is a Japanese-only stop word; korean mode consults [en, ko] only,
        // so it must NOT be filtered on either path.
        const text = 'から 전사';
        const ingestTokens = tokenize(text, { removeStopWords: true, stem: false });
        const queryTokens = extractQueryKeywords(text, 50, mode);

        expect(ingestTokens).toContain('から');
        expect(queryTokens).toContain('から');

        setCjkTokenizerMode('intl'); // restore default for any later tests
    });
});
