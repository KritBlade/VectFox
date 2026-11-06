/**
 * ============================================================================
 * PROMPTS I18N — Language-specific prompt variants
 * ============================================================================
 * Single source of truth for all localised prompt strings.
 *
 * The agentic planner and EventBase extraction pick their prompts from here
 * based on the user's CJK Tokenizer Mode setting, which doubles as the
 * "story language" selector.
 *
 * Supported modes (mirrors CJK_TOKENIZER_MODES in bm25-scorer.js):
 *   intl            → English / Latin           (English examples)
 *   jieba           → Simplified Chinese         (简体中文 examples)
 *   jieba_tw        → Traditional Chinese        (繁體中文 examples)
 *   tiny_segmenter  → Japanese                   (日本語 examples)
 *   korean          → Korean                     (한국어 examples)
 *   others          → Any other language          (English examples + language notice)
 *
 * Every example's cast is made up and written in English in every language. The
 * language rules tell the LLM to keep a name as the chat writes it.
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC PLANNER SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
// Shared structural header — output format, question type guide.
// Language rule + examples are in the per-language blocks below.

const _PLANNER_HEADER =
`You are a retrieval planner for a roleplay memory system. Your job: surface the
stored backstory that makes the CURRENT USER MESSAGE fully understandable.

PLAN FROM these sources, in priority order:
  1. THE CURRENT USER MESSAGE — the primary driver. Break down every claim,
     reference, and assumption in it into backstory sub-questions, ONE per
     distinct fact. Three rules when decomposing:
       a) RESOLVE who each reference points to, using recent chat to map it to a
          NAME. Second-person / possessive words are relative to the ADDRESSEE:
          spoken TO Kai, "your father" = Kai's father (find his name in the chat,
          e.g. Marcus), "your brother" = Kai's brother (e.g. Dorin).
       b) WRITE THE NAME, not the kinship word. A query must say "Marcus", never
          "father" / "your dad" / "the mother". Only if the name is nowhere in the
          chat may you fall back to the kinship word — look first.
       c) Query the ACTUAL PARTICIPANTS. Do NOT anchor every query on the addressee
          by reflex: a line said TO one character often states a fact BETWEEN OTHER
          people, and the addressee is not a party. For a relationship between two
          non-addressee parties, NAME BOTH and leave the addressee out.
          FREQUENCY CHECK: the addressee's name should appear in only the MINORITY
          of your queries — usually ONE (the fact they actually act in). If you've
          bolted it onto most queries, you defaulted to the addressee — REDO.
     E.g. spoken to Kai (chat establishes father = Marcus, brother = Dorin, sister = Tessa):
       "your brother and your father never trusted each other"
          → "Dorin and Marcus mutual distrust" (both named; Kai is NOT a party).
       "your father is finally pardoned" → "Marcus pardoned — what cleared him" (subject = Marcus)
       "you finally found your sister"   → addressee IS a party → "Kai and Tessa reunion".
     ✗ WRONG — addressee bolted onto facts they're not part of:
         "Kai's father pardoned", "Kai and his brother's distrust", "Kai and his sister reunion"
         (Kai forced into all three; the first two aren't even about Kai)
     ✓ RIGHT — query the real parties; addressee appears ONCE (only the reunion):
         "Marcus pardoned — what cleared him", "Dorin and Marcus mutual distrust",
         "Kai and Tessa reunion"
  2. RECENT CHAT — background for what is happening right now. When the user
     message is SHORT or thin on references, lean on recent chat (especially the
     previous reply) to decide what backstory is worth retrieving.

Output STRICT JSON with exactly two fields:

  queries    1–6 short search strings (5–15 words). Prefer one query per distinct
             backstory reference in the user message; add more only while each
             stays distinct on an axis below. LANGUAGE: match the recent
             chat — CHECK the chat's language before writing (English chat →
             English queries; Chinese chat → Chinese queries; Japanese → Japanese;
             etc.). Each query MUST differ on at least one of these axes — not
             just wording:
               • TIME        (early arc vs recent vs aftermath)
               • PERSPECTIVE (character A's view vs character B's view)
               • GRANULARITY (specific event vs general pattern over time)
               • FACET       (action vs emotion vs setting vs dialogue vs consequence)
               • RELATION    (X with Y vs X alone vs X versus Z)
             Paraphrase check: if two queries share ≥3 content words OR differ only by
             wording / synonyms, they are paraphrases — DROP one and replace it with a
             different axis (e.g. lead-up history, reaction from another character,
             setting context, consequence).
             Genre note: in slice-of-life / dating / workplace stories, prefer pattern +
             key-moment pairs over causal chains. Causal chains fit RPG/mystery/thriller.

  rationale  One sentence in the story language. Debug only — not used in retrieval.

══ QUESTION TYPE GUIDE ═══════════════════════════════════════════════

  statement that  → decompose: one query per person / event / relationship the
   references past    user states as already-known (see PLAN FROM rule 1)
  "why X?"        → one query per causal stage: cause → act → aftermath
  "at location?"  → events at that place
  "the [event]?"  → the event itself + lead-up history that caused it + key participants + consequences
  "remember...?"  → event + result + reactions
  "Z's reaction?" → Z's events around that moment
  Vague/open      → broad queries

`;

const _PLANNER_FOOTER =
`Return ONLY the JSON object. No commentary, no markdown fences, no preamble.`;

// ── Per-language EXAMPLES blocks ─────────────────────────────────────────────

const _PLANNER_EXAMPLES_INTL =
`══ LANGUAGE RULE ═════════════════════════════════════════════════════
Write ALL queries in English. Never mix languages.
Proper nouns (names, places, items) keep their exact form from the chat.

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — Causal "why" chain (plot-driven, RPG/mystery/thriller):
User: "Do you remember why we had to pay off Kai's debt?"
{
  "queries": [
    "Kai debt loan note amount",
    "debt collectors threats at his door",
    "repayment negotiation middleman",
    "Kai after the debt was cleared emotional reaction"
  ],
  "rationale": "Causal chain — different TIME slices: debt → collectors → negotiation → aftermath."
}

Example 2 — Slice-of-life / character state pattern (mixed-axis decomposition):
User: "How has Yuki been adjusting to the dorm?"
{
  "queries": [
    "Yuki dorm move-in first impression",
    "Yuki mealtime conversations roommates",
    "Yuki study routine late night habits",
    "Yuki mood shifts recent weeks"
  ],
  "rationale": "Mixed axes — arrival event (TIME), social pattern (FACET), daily habit (GRANULARITY), emotional trajectory (FACET)."
}

Example 3 — A line said TO X, but about a relationship BETWEEN OTHERS (participant resolution):
User: To Kai — "Your father is finally cleared, your sister never got on with your father, but you've found your sister again."
(relative to Kai: your father = Marcus, your sister = Tessa)
{
  "queries": [
    "Marcus cleared of the charge — how",
    "Tessa and Marcus long-standing rift",
    "Kai and Tessa reunion"
  ],
  "rationale": "Resolve participants: 'cleared' is about Marcus; 'rift' is Tessa↔Marcus (Kai not a party); only 'reunion' is Kai↔Tessa. Don't pin every query on Kai."
}
✗ WRONG — Kai bolted onto every fact (even ones he is not in):
    "Kai's father cleared", "Kai and Marcus rift", "Kai and Tessa reunion"
✓ RIGHT — query the real parties; Kai appears once (the reunion he is in):
    "Marcus cleared of the charge — how", "Tessa and Marcus rift", "Kai and Tessa reunion"
Note: in a line said TO X, most facts are BETWEEN OTHERS — X's name should appear in only a few (usually one) query.

`;

const _PLANNER_EXAMPLES_JIEBA_TW =
`══ 語言規則 ══════════════════════════════════════════════════════════
所有 queries 必須以繁體中文書寫，不得混入英文或其他語言。
例外：人名、地名、物品名稱保留原文形式（英文名稱不翻譯）。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果「為何」鏈 (劇情驅動 / RPG / 推理 / 懸疑)：
User: 我對 Kai 説 "你記得我當時為甚麼幫你還債嗎?"
{
  "queries": [
    "Kai 欠債 借據 金額",
    "Kai 遭人上門討債 威脅",
    "還債 談判 中間人",
    "Kai 還清之後 情感反應"
  ],
  "rationale": "因果鏈，TIME 軸分段：欠債→討債→談判→還清後反應。"
}

Example 2 — 日常狀態 / 角色適應 (混合軸分解)：
User: "Yuki 最近過得怎麼樣？"
{
  "queries": [
    "Yuki 搬到新城市 初次反應",
    "Yuki 與同事 日常相處",
    "Yuki 工作 學習 進步",
    "Yuki 情緒變化 最近幾日"
  ],
  "rationale": "混合軸：搬家事件 (TIME)、社交模式 (FACET)、能力成長 (GRANULARITY)、情感軌跡 (FACET)。"
}

Example 3 — 對 X 説的話，描述的卻是「其他人之間」的關係 (參與者解析)：
User: 我對 Kai 説 "你爸終於洗脱罪名了, 你姊雖然跟你爸一直有心結, 不過你已經找回你姊了"
（對 Kai 而言：你爸 = Marcus、你姊 = Tessa）
{
  "queries": [
    "Marcus 洗脱罪名 經過 原因",
    "Tessa 與 Marcus 心結 不和",
    "Kai 與 Tessa 重逢 經過"
  ],
  "rationale": "解析參與者：「洗脱罪名」主角是 Marcus、「心結」是 Tessa↔Marcus(父女，Kai 非當事人)、「重逢」才是 Kai↔Tessa。不把每條都掛在 Kai 身上。"
}
✗ 錯誤 — 把 Kai 硬加在每一條（連他不相關的事都掛上）：
    "Kai 父親 洗脱罪名", "Kai 與 Marcus 心結 不和", "Kai 與 Tessa 重逢"
    （前兩條 Kai 根本不是當事人，「心結」是 Tessa↔Marcus）
✓ 正確 — 查真正的當事人，Kai 只出現一次（他真正參與的重逢）：
    "Marcus 洗脱罪名 經過", "Tessa 與 Marcus 心結 不和", "Kai 與 Tessa 重逢"
注意：對 X 説的話，多數事實是「別人之間」的，X 的名字應只出現在少數（通常一條）query。

`;

const _PLANNER_EXAMPLES_JIEBA =
`══ 语言规则 ══════════════════════════════════════════════════════════
所有 queries 必须以简体中文书写，不得混入英文或其他语言。
例外：人名、地名、物品名称保留原文形式（英文名称不翻译）。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果"为何"链 (剧情驱动 / RPG / 推理 / 悬疑)：
User: 我对 Kai 说 "你记得我当时为什么帮你还债吗?"
{
  "queries": [
    "Kai 欠债 借据 金额",
    "Kai 遭人上门讨债 威胁",
    "还债 谈判 中间人",
    "Kai 还清之后 情感反应"
  ],
  "rationale": "因果链，TIME 轴分段：欠债→讨债→谈判→还清后反应。"
}

Example 2 — 日常状态 / 角色适应 (混合轴分解)：
User: "Yuki 最近过得怎么样？"
{
  "queries": [
    "Yuki 搬到新城市 初次反应",
    "Yuki 与同事 日常相处",
    "Yuki 工作 学习 进步",
    "Yuki 情绪变化 最近几日"
  ],
  "rationale": "混合轴：搬家事件 (TIME)、社交模式 (FACET)、能力成长 (GRANULARITY)、情感轨迹 (FACET)。"
}

Example 3 — 对 X 说的话，描述的却是「其他人之间」的关系 (参与者解析)：
User: 我对 Kai 说 "你爸终于洗脱罪名了, 你姐虽然跟你爸一直有心结, 不过你已经找回你姐了"
（对 Kai 而言：你爸 = Marcus、你姐 = Tessa）
{
  "queries": [
    "Marcus 洗脱罪名 经过 原因",
    "Tessa 与 Marcus 心结 不和",
    "Kai 与 Tessa 重逢 经过"
  ],
  "rationale": "解析参与者：「洗脱罪名」主角是 Marcus、「心结」是 Tessa↔Marcus(父女，Kai 非当事人)、「重逢」才是 Kai↔Tessa。不把每条都挂在 Kai 身上。"
}
✗ 错误 — 把 Kai 硬加在每一条（连他不相关的事都挂上）：
    "Kai 父亲 洗脱罪名", "Kai 与 Marcus 心结 不和", "Kai 与 Tessa 重逢"
    （前两条 Kai 根本不是当事人，「心结」是 Tessa↔Marcus）
✓ 正确 — 查真正的当事人，Kai 只出现一次（他真正参与的重逢）：
    "Marcus 洗脱罪名 经过", "Tessa 与 Marcus 心结 不和", "Kai 与 Tessa 重逢"
注意：对 X 说的话，多数事实是「别人之间」的，X 的名字应只出现在少数（通常一条）query。

`;

const _PLANNER_EXAMPLES_TINY_SEGMENTER =
`══ 言語ルール ════════════════════════════════════════════════════════
queriesはすべて日本語で記述する。他の言語を混在させない。
例外：人名・地名・物品名は会話中の元の表記をそのまま使用する。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果「なぜ」チェーン (プロット駆動 / RPG / ミステリー / スリラー)：
User: "なぜあのときKaiの借金を返さなければならなかったの覚えてる？"
{
  "queries": [
    "Kai 借金 借用書 金額",
    "Kai 取り立て 脅し",
    "返済 交渉 仲介人",
    "Kai 完済後 感情 反応"
  ],
  "rationale": "因果連鎖、TIME 軸の分割：借金→取り立て→交渉→完済後。"
}

Example 2 — 日常的状況・キャラクターの適応 (混合軸の分解)：
User: "Yukiは寮の生活にどう馴染んでる？"
{
  "queries": [
    "Yuki 寮 引っ越し 最初の印象",
    "Yuki ルームメイト 食事 会話",
    "Yuki 勉強 夜 習慣",
    "Yuki 気分 変化 最近"
  ],
  "rationale": "混合軸：到着 (TIME)、社交パターン (FACET)、日常習慣 (GRANULARITY)、感情の推移 (FACET)。"
}

Example 3 — X に向けた台詞だが、実は「他人同士」の関係を述べている (当事者の特定)：
User: Kaiに — 「君の父さんはやっと無実が証明された、君の姉さんは父さんとずっと折り合いが悪かったが、君は姉さんと再会できた」
（Kaiから見て：君の父さん = Marcus、君の姉さん = Tessa）
{
  "queries": [
    "Marcus 無実 証明 経緯",
    "Tessa と Marcus 不和 確執",
    "Kai と Tessa 再会"
  ],
  "rationale": "当事者を特定：「無実」はMarcus、「確執」はTessa↔Marcus(Kaiは当事者でない)、「再会」だけがKai↔Tessa。すべてをKaiに結びつけない。"
}
✗ 誤り — Kaiを全部の事実に無理やり付ける（無関係なものまで）：
    "Kaiの父 無実", "Kai と Marcus 確執", "Kai と Tessa 再会"
✓ 正しい — 本当の当事者で検索；Kaiは一度だけ（本人が関わる再会）：
    "Marcus 無実 証明 経緯", "Tessa と Marcus 確執", "Kai と Tessa 再会"
注意：X に向けた台詞では、ほとんどの事実は「他人同士」のもの。X の名前は少数（通常一つ）の query にのみ現れるべき。

`;

const _PLANNER_EXAMPLES_KOREAN =
`══ 언어 규칙 ════════════════════════════════════════════════════════
모든 queries는 한국어로만 작성한다. 다른 언어를 섞지 않는다.
예외: 인명·지명·아이템명은 대화에서 사용된 원래 표기를 그대로 유지한다.

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 인과 「왜」 체인 (플롯 중심 / RPG / 미스터리 / 스릴러):
User: "우리가 왜 Kai의 빚을 갚아야 했는지 기억해?"
{
  "queries": [
    "Kai 빚 차용증 금액",
    "Kai 빚 독촉 협박",
    "빚 상환 협상 중개인",
    "Kai 완납 이후 감정 반응"
  ],
  "rationale": "인과 사슬, TIME 축 분할: 빚→독촉→협상→완납 이후."
}

Example 2 — 일상생활 / 캐릭터 적응 (혼합 축 분해):
User: "Yuki는 기숙사 생활에 어떻게 적응하고 있어?"
{
  "queries": [
    "Yuki 기숙사 입주 첫 인상",
    "Yuki 룸메이트 식사 대화",
    "Yuki 공부 밤 습관",
    "Yuki 기분 변화 최근"
  ],
  "rationale": "혼합 축: 도착 사건 (TIME), 사회적 패턴 (FACET), 일상 습관 (GRANULARITY), 감정 변화 (FACET)."
}

Example 3 — X에게 한 말이지만, 실은 「다른 사람들 사이」의 관계를 서술 (당사자 식별):
User: Kai에게 — "네 아버지는 마침내 누명을 벗었어, 네 누나는 아버지와 늘 사이가 안 좋았지만, 너는 누나와 다시 만났잖아"
(Kai 기준: 네 아버지 = Marcus, 네 누나 = Tessa)
{
  "queries": [
    "Marcus 누명 벗음 경위",
    "Tessa 와 Marcus 오랜 불화",
    "Kai 와 Tessa 재회"
  ],
  "rationale": "당사자 식별: '누명'은 Marcus, '불화'는 Tessa↔Marcus(Kai는 당사자 아님), '재회'만 Kai↔Tessa. 모든 query를 Kai에게 걸지 않는다."
}
✗ 틀림 — Kai를 모든 사실에 억지로 붙임(관련 없는 것까지):
    "Kai 아버지 누명", "Kai 와 Marcus 불화", "Kai 와 Tessa 재회"
✓ 맞음 — 진짜 당사자로 검색; Kai는 한 번만(그가 참여한 재회):
    "Marcus 누명 벗음 경위", "Tessa 와 Marcus 불화", "Kai 와 Tessa 재회"
참고: X에게 한 말에서 대부분의 사실은 「다른 사람들 사이」의 것 — X의 이름은 소수(보통 하나)의 query에만 나와야 한다.

`;

const _PLANNER_EXAMPLES_OTHERS =
`══ LANGUAGE RULE ═════════════════════════════════════════════════════
Detect the story language from the chat. Write ALL queries
in that language only. Do NOT default to English — match the roleplay language.
Proper nouns (names, places, items) keep their exact form from the chat.

══ EXAMPLES (shown in English — apply the same pattern in your detected language) ══

Example 1 — Causal "why" chain (plot-driven, RPG/mystery/thriller):
User: "Do you remember why we had to pay off Kai's debt?"
{
  "queries": [
    "Kai debt loan note amount",
    "debt collectors threats at his door",
    "repayment negotiation middleman",
    "Kai after the debt was cleared emotional reaction"
  ],
  "rationale": "Causal chain — different TIME slices: debt → collectors → negotiation → aftermath."
}

Example 2 — Slice-of-life / character state pattern (mixed-axis decomposition):
User: "How has Yuki been adjusting to the dorm?"
{
  "queries": [
    "Yuki dorm move-in first impression",
    "Yuki mealtime conversations roommates",
    "Yuki study routine late night habits",
    "Yuki mood shifts recent weeks"
  ],
  "rationale": "Mixed axes — arrival event (TIME), social pattern (FACET), daily habit (GRANULARITY), emotional trajectory (FACET)."
}

Example 3 — A line said TO X, but about a relationship BETWEEN OTHERS (participant resolution):
User: To Kai — "Your father is finally cleared, your sister never got on with your father, but you've found your sister again."
(relative to Kai: your father = Marcus, your sister = Tessa)
{
  "queries": [
    "Marcus cleared of the charge — how",
    "Tessa and Marcus long-standing rift",
    "Kai and Tessa reunion"
  ],
  "rationale": "Resolve participants: 'cleared' is about Marcus; 'rift' is Tessa↔Marcus (Kai not a party); only 'reunion' is Kai↔Tessa. Don't pin every query on Kai."
}
✗ WRONG — Kai bolted onto every fact (even ones he is not in):
    "Kai's father cleared", "Kai and Marcus rift", "Kai and Tessa reunion"
✓ RIGHT — query the real parties; Kai appears once (the reunion he is in):
    "Marcus cleared of the charge — how", "Tessa and Marcus rift", "Kai and Tessa reunion"
Note: in a line said TO X, most facts are BETWEEN OTHERS — X's name should appear in only a few (usually one) query.

`;

const _PLANNER_PROMPTS = {
    intl:           _PLANNER_HEADER + _PLANNER_EXAMPLES_INTL           + _PLANNER_FOOTER,
    jieba:          _PLANNER_HEADER + _PLANNER_EXAMPLES_JIEBA           + _PLANNER_FOOTER,
    jieba_tw:       _PLANNER_HEADER + _PLANNER_EXAMPLES_JIEBA_TW        + _PLANNER_FOOTER,
    tiny_segmenter: _PLANNER_HEADER + _PLANNER_EXAMPLES_TINY_SEGMENTER  + _PLANNER_FOOTER,
    korean:         _PLANNER_HEADER + _PLANNER_EXAMPLES_KOREAN          + _PLANNER_FOOTER,
    others:         _PLANNER_HEADER + _PLANNER_EXAMPLES_OTHERS          + _PLANNER_FOOTER,
};

/**
 * Returns the agentic planner system prompt for the given story language mode.
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getAgenticPlannerPrompt(mode) {
    return _PLANNER_PROMPTS[mode] ?? _PLANNER_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// EVENTBASE EXTRACTION PROMPT
// ─────────────────────────────────────────────────────────────────────────────
// The extraction prompt is sent to the LLM for every chat window during
// EventBase ingestion. It tells the LLM to return a JSON array of structured
// event records. Mostly the same across languages — what varies is:
//   1. The LANGUAGE rule (which language to write string fields in)
//   2. The VALID OUTPUT EXAMPLES (shown in the target language so the LLM
//      anchors on the right script)
// Everything else (event_type list, importance guide, schema fields) stays
// shared since it's instructional metadata for the LLM, not output.

// ── Shared TOP: intro + ABSOLUTE RULES heading ───────────────────────────────
const _EXTRACTION_TOP =
`You are a story event archivist for a roleplay session. Extract ONLY narratively significant story events from the excerpt below.

=========================
ABSOLUTE RULES (DO NOT BREAK)
=========================
`;

// ── Per-language LANGUAGE rule (Rule 1) ──────────────────────────────────────
const _EXTRACTION_LANG_INTL =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in English.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS examples for this language (see full rules in OUTPUT SCHEMA below):
       GOOD: "sacrifice", "trust", "obligation", "isolation", "redemption", "the cost of victory"
       BAD:  "Aria" (character), "tavern" (location), "sword" (item),
             "combat" (action), "leveling up" (mechanic)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_JIEBA =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Simplified Chinese (简体中文).
   - DO NOT convert to Traditional Chinese.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 范例（完整规则见下方 OUTPUT SCHEMA）：
       好的概念：「牺牲」、「胜利的代价」、「信仰」、「情感依附」、「亲情」、「孤独」、「背叛」
       不要放：「Aria」(人名)、「酒馆」(地点)、「长剑」(物品)、
                「战斗」(动作)、「升级」(机制)、「Goblin」(怪物名)、
                「属性点分配」(游戏机制)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_JIEBA_TW =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Traditional Chinese (繁體中文).
   - DO NOT convert to Simplified Chinese.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 範例（完整規則見下方 OUTPUT SCHEMA）：
       好的概念：「犧牲」、「勝利的代價」、「信仰」、「情感依附」、「親情」、「孤獨」、「背叛」
       不要放：「Aria」(人名)、「酒館」(地點)、「長劍」(物品)、
                「戰鬥」(動作)、「升級」(機制)、「Goblin」(怪物名)、
                「屬性點分配」(遊戲機制)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_TINY_SEGMENTER =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Japanese (日本語).
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 例（詳しいルールは下の OUTPUT SCHEMA を参照）：
       良い概念：「誓い」、「罪悪感」、「信頼」、「孤独」、「家族の絆」、「贖罪」、「裏切り」
       不可：「Aria」(人名)、「酒場」(場所)、「剣」(アイテム)、
              「戦闘」(動作)、「レベルアップ」(ゲーム機構)、
              「Goblin」(モンスター名)、「ステータス振り分け」(機構)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_KOREAN =
`1. LANGUAGE — MANDATORY:
   - All string fields (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) MUST be in Korean (한국어).
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS 예시 (전체 규칙은 아래 OUTPUT SCHEMA 참조):
       좋은 개념: "맹세", "가족의 정", "신뢰", "고독", "속죄", "배신", "희생"
       나쁨: "Aria" (인명), "주막" (장소), "검" (아이템),
             "전투" (행동), "레벨업" (게임 메커닉),
             "Goblin" (몬스터 이름), "능력치 분배" (게임 메커닉)
   - Violating this rule makes the output invalid.

`;

const _EXTRACTION_LANG_OTHERS =
`1. LANGUAGE — MANDATORY:
   - Detect the dominant language of the excerpt. All string fields MUST be in THAT language.
   - Do NOT default to English unless the excerpt is in English.
   - If the excerpt mixes languages, follow the dominant language of each individual field's source content.
   - Proper nouns: preserve exact form from the excerpt — DO NOT translate, romanize, or transliterate names.
   - CONCEPTS examples (English shown — translate the SHAPE into the detected language):
       GOOD (abstract themes that recur): "sacrifice", "trust", "obligation",
             "isolation", "redemption", "the cost of victory"
       BAD  (entity / action / mechanic — belong in OTHER fields):
             a character name → characters, a location → locations,
             an item → items, a specific battle → keywords / summary,
             "leveling up" → keywords (it's a game mechanic, not a theme)
   - Violating this rule makes the output invalid.

`;

// ── Shared middle: Rules 2, 3, and full OUTPUT SCHEMA ────────────────────────
// This is instructional text for the LLM, not output content, so it stays in
// English regardless of story language. The schema fields are also defined here
// since their structure is identical across languages.
const _EXTRACTION_RULES_BODY =
`2. EVENT COUNT:
   - Return AT MOST {{maxCount}} events.
   - Return as many real events as actually occurred — do not artificially cap or pad.
   - DO NOT invent events. DO NOT duplicate the same event under different names.

3. WHEN TO RETURN ZERO EVENTS ([]):
   Default to EXTRACTING. Return [] only when the excerpt holds no character
   interaction, no dialogue, no revelation, no relationship movement and no world
   information — a pure scene-setting paragraph, or an out-of-character note.

   Ordinary conversation IS extractable. A character sharing something personal,
   asking a question that gets answered, offering or accepting help, or reacting to
   how they were treated all change what a reader knows about them.

   When unsure whether an event is worth keeping, EXTRACT IT and score it at the
   BOTTOM of its event_type's range in the OUTPUT SCHEMA below. Importance RANKS
   events; it is not a filter you apply here. A low score keeps the event
   available for later retrieval. Omitting it loses the event permanently.

   Always extract these — they steer the main storyline:
   - A promise or oath is made — it shapes future obligations.
   - A character's inner fear or secret is revealed — it reframes past or future behaviour.
   - A character's status, allegiance, or circumstances permanently change. Concrete
     details (a sum paid, a name given, a term agreed) are worth remembering.

   SEXUAL / INTIMATE SCENES — THE ONE EXCEPTION TO "DEFAULT TO EXTRACTING":
   Do NOT extract the encounter itself, at ANY importance. Intimate scenes read alike,
   so storing them fills the memory with near-identical entries that match later
   queries while telling the reader nothing about the storyline.
   Extract ONLY a consequence that would still stand if the scene were removed: a
   promise or oath, a confession, a revelation, a change in status or allegiance, or a
   stated shift in the relationship. If the scene carries none of those, return [].

4. REASONING BLOCKS — CONTEXT ONLY (DO NOT BREAK):
   Some messages in the excerpt include a block marked exactly:
       [REASONING — CONTEXT ONLY, for date/time/location; NOT a source of events]
   This is the author-model's private planning/notes. It is NOT narrative, and what it
   describes may be PLANNED but never actually happened.
   - Use a reasoning block ONLY to fill DateTime, scene_time, and locations when the
     narrative text itself does not state them. Prefer the narrative; fall back to the
     reasoning block per-field (date from narrative, location from reasoning, etc.).
   - NEVER extract an event from a reasoning block. NEVER treat an intended/planned
     action inside it as something that occurred.
   - NEVER copy reasoning text into summary, cause, result, characters, factions,
     items, concepts, keywords, or open_threads.
   - If a fact appears ONLY in a reasoning block and nowhere in the narrative, it did
     NOT happen — ignore it (except date/time/location, which you may borrow as above).

=========================
OUTPUT SCHEMA
=========================
Return ONLY a valid JSON array. No prose. No markdown. No code fences.

Each event object MUST have these fields:
- event_type: one of [main_quest_update, side_quest_update, combat, travel, discovery, dialogue_significant, relationship_change, character_introduction, character_state_change, item_acquired, item_lost, faction_change, location_change, revelation, promise_or_oath, betrayal, death, other]
- importance: integer 1-10. Higher = the event keeps shaping the story after this scene.
  Anchor your score against these per-type guidelines:

  PERMANENT / IRREVERSIBLE changes score highest — they reshape the story permanently.
  EPHEMERAL moments score lowest — they happened but leave no lasting trace.

  main_quest_update:    7-10 (major milestone/turning point), 4-6 (incremental progress)
  side_quest_update:    3-6  (completion or key step), 1-3 (minor update)
  combat:               1-3  (common mobs, random encounter, trash fight — won or lost),
                        4-6  (a costly or hard-won fight, or one that reveals an enemy's nature),
                        7-8  (a NAMED boss, elite, or rival is defeated — or defeats the party),
                        9-10 (combat that kills a major character or changes the story permanently)
  travel:               1-2  (moving between locations), 3-5 (arrival at a key destination that opens new story)
  discovery:            3-5  (minor lore or clue), 6-8 (world-changing revelation or hidden truth uncovered)
  dialogue_significant: 3-5  (key conversation, character insight), 6-8 (confession, confrontation, defining moment)
  relationship_change:  5-7  (gradual shift in trust/bond), 8-10 (permanent status change — e.g. freed from slavery, marriage, sworn enemy)
  character_introduction: 3-5 (new named character joins), 6-8 (introduction of a major antagonist or pivotal NPC)
  character_state_change: 4-6 (injury, level-up, mood shift), 7-9 (permanent transformation — power gained, identity revealed, disability)
  item_acquired:        1-3  (common item), 5-7 (plot-critical item or unique artifact)
  item_lost:            1-3  (minor loss), 6-8 (loss of a plot-critical item or irreplaceable object)
  faction_change:       6-9  (political/social alignment shifted — alliances broken or formed)
  location_change:      1-2  (routine travel), 3-5 (arrival at a narratively important new location)
  revelation:           6-8  (important hidden truth exposed), 9-10 (revelation that fundamentally reframes the story or a character)
  promise_or_oath:      5-7  (significant promise between characters), 8-9 (binding oath with major consequences)
  betrayal:             7-10 (trust broken — scale with how close the relationship was and how severe the consequences)
  death:                6-8  (minor/enemy character), 9-10 (death of a named ally or major character)
  other:                1-4  (flavor worth remembering), 5-7 (genuinely significant but doesn't fit other types)

  IF NONE OF THE ABOVE FITS the situation, use your own judgement and score by how much the
  event changes the MAIN STORYLINE:
    7-10 — major impact: the main storyline moves, or a main character is permanently altered.
    4-6  — real but local impact: it matters to a scene, a subplot, or one relationship.
    1-3  — it happened, but the main storyline is unchanged by it.
  Never skip an event because no guideline matches. Score it and return it.
- summary: 2-8 dense sentences capturing WHO did WHAT, the key detail, the emotional/narrative impact, and any important consequences or reactions. SAME LANGUAGE AS EXCERPT (see Rule 1)
- cause: short explanation of why it happened, SAME LANGUAGE AS EXCERPT (may be "")
- result: outcome / state change, SAME LANGUAGE AS EXCERPT (may be "")
- characters: array of proper-noun names, EXACT ORIGINAL SCRIPT
- locations: array of strings, EXACT ORIGINAL SCRIPT, taken from the narrative OR a reasoning block (see Rule 4).
- factions: array of strings, EXACT ORIGINAL SCRIPT
- DateTime: ISO 8601 string (e.g., "2024-01-01T12:00:00Z") for when the event occurred in the story timeline, derived from the narrative OR a reasoning block (see Rule 4), if it can be determined; otherwise null. In-world calendar dates are fine (a year like 1577 is valid). If the date CANNOT be expressed as a real calendar date (e.g. "Day 3", "Third Age 47", a fictional calendar), leave DateTime null and put the original form in scene_time instead.
- scene_time: the scene's date and/or time EXACTLY as written in the source — verbatim, any calendar or format, any language. Examples: "1577年8月17日 22:30", "早晨 8:00", "Day 3, dusk". Do NOT normalize, translate, or convert it (that is what DateTime is for). Take it from the narrative if stated there, otherwise from a reasoning block (see Rule 4). Use "" if no date/time is stated anywhere. Keep it to a single short line.
- items: array of strings, EXACT ORIGINAL SCRIPT
- concepts: array of 2-5 strings, SAME LANGUAGE AS EXCERPT.
  Concepts are ABSTRACT THEMES — the answer to "what is this event ABOUT,
  beyond what literally happened?". They are NOT a second copy of keywords,
  and they are NOT a place for entity names.

  RULES — apply ALL THREE before adding a term to concepts:
    (a) NOT-ENTITY:    Must NOT be a character, location, item, faction,
                       monster, organization, or game stat/mechanic. Those
                       go in their own fields. If you can point to it on a
                       map, hold it in your hand, or look it up in a rules
                       book, it is not a concept.
    (b) NOT-ACTION:    Must NOT be a specific verb or event. A single combat,
                       a level-up, a trade, a quest hand-in are NOT concepts.
                       The IDEA behind them ("the cost of victory", "trust
                       building", "betrayal of loyalty") IS a concept.
    (c) GENERALIZES:   Must be broad enough to apply to multiple events
                       across the story (themes recur). If the term only
                       fits this one specific event, it is a keyword,
                       not a concept.

  Language-specific GOOD / BAD examples appear in Rule 1 above. Refer to
  those — do NOT use examples from a different language than the excerpt.

  Self-check before returning: for each concept you wrote, ask "could this
  be a recurring theme across multiple events in this story?". If no,
  move it to keywords or remove it. Fewer good concepts beats more weak ones.
- keywords: array of 8-15 strings, SAME LANGUAGE AS EXCERPT. Search aids used by a keyword retrieval engine — be GENEROUS and INCLUSIVE. Include every distinctive term that a future query about this event might use: key actions/verbs, distinctive objects/items, emotional or thematic tags, unique concepts, and any rare/specific noun that isn't generic filler. DO NOT pad with generic words. Quality matters but err on the side of MORE rather than fewer — sparse keywords cause retrieval misses. CRITICAL: keywords MUST be in the same language as the excerpt (see Rule 1). NEVER output a different language in this field.
- open_threads: array of strings, SAME LANGUAGE AS EXCERPT (unresolved questions/promises)
- should_persist: boolean (false for ephemeral moments unlikely to matter later)

=========================
VALID OUTPUT EXAMPLES
=========================
Zero events (filler scene):
[]

`;

// ── Per-language EXAMPLES (one localized example per variant) ────────────────
const _EXTRACTION_EXAMPLES_INTL =
`One event (English excerpt):
[{"event_type":"relationship_change","importance":7,"summary":"Aria takes the blame for Leon's mistake in front of the commander, shielding him from punishment at personal cost. Leon is visibly shaken by her sacrifice and vows to repay her.","cause":"Leon froze during the mission briefing and Aria covered for him without hesitation.","result":"Leon feels indebted to Aria; their dynamic shifts from rivalry to fragile trust.","characters":["Aria","Leon","Commander Voss"],"locations":["Command Tent"],"factions":["Iron Company"],"DateTime":null,"scene_time":"","items":[],"concepts":["sacrifice","debt","trust"],"keywords":["blame","shield","punishment","mistake","sacrifice","debt","trust","rivalry","vow","repay","commander","mission briefing","froze","covered"],"open_threads":["Will Leon repay Aria?","How will Commander Voss react if he finds out?"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_JIEBA =
`One event (Simplified Chinese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"Aria 承诺帮 Leon 找回被盗的传家罗盘。","cause":"Leon 在房间中央哭着请求帮助。","result":"找回罗盘成为队伍的核心目标。","characters":["Aria","Leon"],"locations":["Harbor Inn 顶楼客房"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","scene_time":"","items":["传家罗盘"],"concepts":["传承","承诺","亲情"],"keywords":["传家罗盘","寻找罗盘","承诺","哭泣","请求","失窃","核心目标","队伍任务","誓言","亲情"],"open_threads":["查明罗盘落在谁手里"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_JIEBA_TW =
`One event (Traditional Chinese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"Aria 承諾幫 Leon 找回被盜的傳家羅盤。","cause":"Leon 在房間中央哭著請求幫助。","result":"找回羅盤成為隊伍的核心目標。","characters":["Aria","Leon"],"locations":["Harbor Inn 頂樓客房"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","scene_time":"","items":["傳家羅盤"],"concepts":["傳承","承諾","親情"],"keywords":["傳家羅盤","尋找羅盤","承諾","哭泣","請求","失竊","核心目標","隊伍任務","誓言","親情"],"open_threads":["查明羅盤落在誰手裡"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_TINY_SEGMENTER =
`One event (Japanese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"Aria は Leon の盗まれた家宝の羅針盤を取り戻すと約束した。","cause":"Leon が部屋の中央で泣きながら助けを求めた。","result":"羅針盤の奪還がパーティーの中心目標となった。","characters":["Aria","Leon"],"locations":["Harbor Inn 最上階の客室"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","scene_time":"","items":["家宝の羅針盤"],"concepts":["継承","誓い","家族の絆"],"keywords":["家宝の羅針盤","羅針盤の捜索","約束","泣く","懇願","盗難","中心目標","パーティーの任務","誓い","家族の絆"],"open_threads":["羅針盤を持ち去った者を突き止める"],"should_persist":true}]

`;

const _EXTRACTION_EXAMPLES_KOREAN =
`One event (Korean excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"Aria는 Leon의 도둑맞은 가보 나침반을 되찾아 주기로 약속했다.","cause":"Leon이 방 한가운데서 울며 도움을 청했다.","result":"나침반을 되찾는 것이 파티의 핵심 목표가 되었다.","characters":["Aria","Leon"],"locations":["Harbor Inn 꼭대기 층 객실"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","scene_time":"","items":["가보 나침반"],"concepts":["대물림","약속","가족의 정"],"keywords":["가보 나침반","나침반 찾기","약속","울음","간청","도난","핵심 목표","파티 임무","맹세","가족의 정"],"open_threads":["나침반을 가져간 자 확인"],"should_persist":true}]

`;

// "others" reuses the English example with a notice — the LLM will follow the
// LANGUAGE rule from this variant's _EXTRACTION_LANG block to write its own
// output in whatever language the excerpt actually uses.
const _EXTRACTION_EXAMPLES_OTHERS =
`One event (English excerpt — apply the same field structure in your detected language):
[{"event_type":"relationship_change","importance":7,"summary":"Aria takes the blame for Leon's mistake in front of the commander, shielding him from punishment at personal cost. Leon is visibly shaken by her sacrifice and vows to repay her.","cause":"Leon froze during the mission briefing and Aria covered for him without hesitation.","result":"Leon feels indebted to Aria; their dynamic shifts from rivalry to fragile trust.","characters":["Aria","Leon","Commander Voss"],"locations":["Command Tent"],"factions":["Iron Company"],"DateTime":null,"scene_time":"","items":[],"concepts":["sacrifice","debt","trust"],"keywords":["blame","shield","punishment","mistake","sacrifice","debt","trust","rivalry","vow","repay","commander","mission briefing","froze","covered"],"open_threads":["Will Leon repay Aria?","How will Commander Voss react if he finds out?"],"should_persist":true}]

`;

// ── Shared FOOTER: the excerpt slot ──────────────────────────────────────────
// The excerpt runs to thousands of characters, which leaves the "no prose, no code
// fences" line in OUTPUT SCHEMA far behind by the time the model starts writing —
// measured as a prose preamble on 4 of 15 gemini-3.5-flash runs. Restating it AFTER
// the excerpt makes it the last thing read.
const _EXTRACTION_FOOTER =
`=========================
EXCERPT
=========================
{{text}}

=========================
Return ONLY the JSON array now. Begin your reply with [ and end it with ].
No preamble, no explanation, no markdown, no code fences.`;

const _EXTRACTION_PROMPTS = {
    intl:           _EXTRACTION_TOP + _EXTRACTION_LANG_INTL           + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_INTL           + _EXTRACTION_FOOTER,
    jieba:          _EXTRACTION_TOP + _EXTRACTION_LANG_JIEBA          + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_JIEBA          + _EXTRACTION_FOOTER,
    jieba_tw:       _EXTRACTION_TOP + _EXTRACTION_LANG_JIEBA_TW       + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_JIEBA_TW       + _EXTRACTION_FOOTER,
    tiny_segmenter: _EXTRACTION_TOP + _EXTRACTION_LANG_TINY_SEGMENTER + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_TINY_SEGMENTER + _EXTRACTION_FOOTER,
    korean:         _EXTRACTION_TOP + _EXTRACTION_LANG_KOREAN         + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_KOREAN         + _EXTRACTION_FOOTER,
    others:         _EXTRACTION_TOP + _EXTRACTION_LANG_OTHERS         + _EXTRACTION_RULES_BODY + _EXTRACTION_EXAMPLES_OTHERS         + _EXTRACTION_FOOTER,
};

/**
 * Returns the EventBase extraction prompt template for the given story
 * language mode. The template still contains the {{text}} and {{maxCount}}
 * placeholders — buildExtractionPrompt() in eventbase-schema.js substitutes
 * those before sending to the LLM.
 *
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getEventBaseExtractionPrompt(mode) {
    return _EXTRACTION_PROMPTS[mode] ?? _EXTRACTION_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// PLANNER USER MESSAGE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the user-message portion of the planner prompt: recent chat and the
 * current user message.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.recentTurns - Past chat (oldest first)
 * @param {string} params.userMessage - Current user input verbatim
 * @returns {string} The user-message text
 */
export function buildPlannerUserMessage({ recentTurns, userMessage }) {
    const parts = [];

    parts.push('Recent chat (oldest first):');
    if (!recentTurns || recentTurns.length === 0) {
        parts.push('  (no recent context — start of conversation)');
    } else {
        recentTurns.forEach((turn, idx) => {
            const idxLabel = `[-${recentTurns.length - idx}]`;
            const speaker = turn.speaker || (turn.is_user ? '{{user}}' : '{{character}}');
            // Soft-trim each turn to ~600 chars so very long replies don't blow the budget.
            const body = (turn.text || '').slice(0, 600);
            const ellipsis = (turn.text || '').length > 600 ? '...' : '';
            parts.push(`  ${idxLabel} ${speaker}: ${body}${ellipsis}`);
        });
    }

    parts.push('');
    parts.push('Current user message:');
    parts.push(`  ${userMessage || '(empty)'}`);

    parts.push('');
    parts.push('Plan retrieval. Return strict JSON only.');

    return parts.join('\n');
}
