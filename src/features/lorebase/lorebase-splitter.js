/**
 * Cuts a lorebook entry into the passages LoreBase indexes (plan §5.3 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md): the author's own markers first, then 300-token windows at line and
 * sentence ends, only inside a section that is still too long. A passage never crosses a section. A <tag> wrapper
 * around the whole entry is its frame, kept apart so a trim can keep the tags balanced.
 *
 * A port of the benchmark's splitter (InternalProject/Vectfox/tools/lorebase-benchmark/lore_passages.py), which the
 * live tests measured; it cuts the same passages. Pure: no SillyTavern, no network.
 */

const CJK_CHARACTER = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;
const LATIN_WORD = /[A-Za-z0-9]+/g;

// Section heading kinds, strongest first. Date A Live's '---' / '[NAME]' / '---' triple is matched apart. An entry's
// strongest kind present makes its sections; weaker kinds only open units inside them, so an all-capitals 'PHASE 3'
// line inside Date A Live's [BEHAVIOR] block stays in BEHAVIOR.
const HEADING_KINDS = ['triple', 'bracket', 'markdown', 'capitals'];
const HEADING_PATTERNS = {
    bracket: /^\[[^[\]\n]{1,60}\]$|^【[^】\n]{1,30}】$/u,
    markdown: /^#{1,6}\s+\S.{0,100}$/u,
    capitals: /^(?=.*[A-Z]{2})[A-Z0-9][A-Z0-9 &/'’\-—:().,!?]{3,100}$/u,
};
// Lines that open a unit inside a section: beat lines, heading-only 'Name:' lines and bare title-case headings.
const UNIT_STARTS = [
    /^[◆◈■□●○▶▷★☆※]\s*\S/u,
    /^[^\s:：]{1,24}[:：]$/u,
    /^[A-Z][A-Za-z]+(?: [A-Za-z]+){0,3}$/u,
];
const TRIPLE_RULE = /^-{3,}$/;
const TRIPLE_NAME = /^\[[^\]\n]{1,60}\]$/u;
const WRAPPER_OPEN = /^<([^\s<>/]{1,40})>$/u;
const WRAPPER_CLOSE = /^<\/([^\s<>/]{1,40})>$/u;
const SENTENCE_END = /(?<=[.!?。！？…])\s+|(?<=[。！？])/u;
const CATEGORY_PREFIX = /^\s*(\[[^\]]*\]|【[^】]*】|[^:：\s[]{1,12}[:：])\s*/u;

// A section up to this multiple of the window stays one passage.
const WHOLE_SECTION_SLACK = 1.5;
// A line longer than this is cut at sentence ends before windows are packed.
const LONG_LINE_TOKENS = 120;
export const DEFAULT_WINDOW_TOKENS = 300;

/** Round half to even, as Python's round does, so sizes match the benchmark's. */
function roundHalfEven(value) {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction > 0.5) return floor + 1;
    if (fraction < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * About 1 token per CJK character and 1.3 per Latin word, so one size serves every language (plan §5.3).
 * @param {string} text
 * @returns {number}
 */
export function estimatedTokens(text) {
    const cjk = (text.match(CJK_CHARACTER) || []).length;
    const words = (text.match(LATIN_WORD) || []).length;
    return roundHalfEven(cjk + words * 1.3);
}

/**
 * The entry's title: its comment without a category prefix such as "[DAL Spirits]" or "角色:".
 * @param {{comment?: string, uid?: number}} entry
 * @returns {string}
 */
export function entryTitle(entry) {
    const comment = entry.comment || '';
    return comment.replace(CATEGORY_PREFIX, '').trim() || comment.trim() || `entry ${entry.uid}`;
}

/**
 * The entry's category: the prefix of its comment, such as "[DAL Spirits]" or "角色:", or ''.
 * @param {{comment?: string}} entry
 * @returns {string}
 */
export function entryCategory(entry) {
    const match = CATEGORY_PREFIX.exec(entry.comment || '');
    return match ? match[1].trim() : '';
}

const stripNewlines = text => text.replace(/^\n+|\n+$/g, '');

function isTripleAt(lines, index) {
    return index + 2 < lines.length
        && TRIPLE_RULE.test(lines[index].trim())
        && TRIPLE_NAME.test(lines[index + 1].trim())
        && TRIPLE_RULE.test(lines[index + 2].trim());
}

function strongestHeadingKind(lines) {
    if (lines.some((_, index) => isTripleAt(lines, index))) return 'triple';
    for (const kind of HEADING_KINDS.slice(1)) {
        if (lines.some(line => line.trim() && HEADING_PATTERNS[kind].test(line.trim()))) return kind;
    }
    return null;
}

/** Heading patterns weaker than the entry's section kind: they open units, not sections. */
function weakerPatterns(kind) {
    if (kind === null) return [];
    return HEADING_KINDS.slice(HEADING_KINDS.indexOf(kind) + 1).map(weaker => HEADING_PATTERNS[weaker]);
}

const headingName = line => line.trim().replace(/^[[\]【】#]+|[[\]【】#]+$/gu, '').trim();

/** Splits off a <tag> ... </tag> wrapper around the whole entry: [frame or null, the lines inside]. */
function frameAndBody(lines) {
    const filled = lines.map((line, index) => (line.trim() ? index : -1)).filter(index => index >= 0);
    if (filled.length < 2) return [null, lines];
    const first = filled[0];
    const last = filled[filled.length - 1];
    const opened = WRAPPER_OPEN.exec(lines[first].trim());
    const closed = WRAPPER_CLOSE.exec(lines[last].trim());
    if (opened && closed && opened[1] === closed[1]) {
        return [{ open: lines[first].trim(), close: lines[last].trim() }, lines.slice(first + 1, last)];
    }
    return [null, lines];
}

/** [name, headingLineCount, lines] per section, at the entry's strongest heading kind; text before the first is the intro. */
function sections(lines, kind) {
    const found = [];
    let name = '(intro)';
    let headingLineCount = 0;
    let current = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index].trim();
        const startsSection = kind === 'triple'
            ? isTripleAt(lines, index)
            : Boolean(kind && line && HEADING_PATTERNS[kind].test(line));
        if (startsSection) {
            if (current.some(text => text.trim())) found.push([name, headingLineCount, current]);
            headingLineCount = kind === 'triple' ? 3 : 1;
            name = headingName(kind === 'triple' ? lines[index + 1] : line);
            current = lines.slice(index, index + headingLineCount);
            index += headingLineCount;
            continue;
        }
        current.push(lines[index]);
        index += 1;
    }
    if (current.some(text => text.trim())) found.push([name, headingLineCount, current]);
    return found;
}

/**
 * Groups a section's lines into units, each opened by a beat line, a heading-only line or a weaker heading. The
 * section's own heading lines stay with its first unit.
 */
function units(sectionLines, headingLineCount, extraStarts) {
    const starts = [...UNIT_STARTS, ...extraStarts];
    const grouped = [];
    let current = [];
    let hasContent = false;
    sectionLines.forEach((line, index) => {
        const text = line.trim();
        const isHeadingLine = index < headingLineCount;
        if (hasContent && text && starts.some(pattern => pattern.test(text))) {
            grouped.push(current);
            current = [];
            hasContent = false;
        }
        current.push(line);
        if (text && !isHeadingLine) hasContent = true;
    });
    if (current.length) grouped.push(current);
    return grouped;
}

/** Lines, and the sentences of a line longer than LONG_LINE_TOKENS, as the smallest pieces a window may hold. */
function atoms(text) {
    const pieces = [];
    for (const line of text.split('\n')) {
        if (estimatedTokens(line) <= LONG_LINE_TOKENS) {
            pieces.push(line);
            continue;
        }
        pieces.push(...line.split(SENTENCE_END).filter(part => part));
    }
    return pieces;
}

/** Greedy packing of pieces into windows of about windowTokens, never splitting a piece. */
function pack(pieces, windowTokens, joiner) {
    const windows = [];
    let current = [];
    let currentTokens = 0;
    for (const piece of pieces) {
        const pieceTokens = estimatedTokens(piece);
        if (current.length && currentTokens + pieceTokens > windowTokens) {
            windows.push(current.join(joiner));
            current = [];
            currentTokens = 0;
        }
        current.push(piece);
        currentTokens += pieceTokens;
    }
    if (current.length) windows.push(current.join(joiner));
    return windows.filter(window => window.trim());
}

/**
 * Cuts an entry's content into passages.
 * @param {string} content - The entry's content
 * @param {number} [windowTokens] - The window size, 300 tokens by default (D10)
 * @returns {{frame: {open: string, close: string}|null, passages: Array<{section: string, text: string}>}}
 */
export function splitEntry(content, windowTokens = DEFAULT_WINDOW_TOKENS) {
    const [frame, body] = frameAndBody(String(content || '').replace(/\r\n/g, '\n').split('\n'));
    const kind = strongestHeadingKind(body);
    const extraStarts = weakerPatterns(kind);
    const passages = [];
    for (const [name, headingLineCount, sectionLines] of sections(body, kind)) {
        const sectionText = stripNewlines(sectionLines.join('\n'));
        if (estimatedTokens(sectionText) <= windowTokens * WHOLE_SECTION_SLACK) {
            passages.push({ section: name, text: sectionText });
            continue;
        }
        for (const unit of units(sectionLines, headingLineCount, extraStarts)) {
            const unitText = stripNewlines(unit.join('\n'));
            if (!unitText.trim()) continue;
            if (estimatedTokens(unitText) <= windowTokens) {
                passages.push({ section: name, text: unitText });
            } else {
                for (const window of pack(atoms(unitText), windowTokens, '\n')) passages.push({ section: name, text: window });
            }
        }
    }
    const merged = [];
    for (const passage of passages) {
        // A unit smaller than a tenth of the window joins the passage before it in the same section.
        const previous = merged[merged.length - 1];
        if (previous && previous.section === passage.section && estimatedTokens(passage.text) < windowTokens / 10
            && estimatedTokens(previous.text) + estimatedTokens(passage.text) <= windowTokens) {
            previous.text += `\n${passage.text}`;
        } else {
            merged.push({ ...passage });
        }
    }
    return { frame, passages: merged };
}

/**
 * An entry's passages as LoreBase stores them: each with its place in the entry, its size, and the text it is
 * embedded as, prefixed with the entry's title and the section's name (plan §5.3).
 * @param {{uid: number, comment?: string, content?: string}} entry
 * @param {number} [windowTokens]
 * @returns {{title: string, frame: object|null, passages: Array<{section: string, text: string, passageIndex: number, passageCount: number, tokens: number, embeddingText: string}>}}
 */
export function entryPassages(entry, windowTokens = DEFAULT_WINDOW_TOKENS) {
    const { frame, passages } = splitEntry(entry.content, windowTokens);
    const title = entryTitle(entry);
    return {
        title,
        frame,
        passages: passages.map((passage, passageIndex) => {
            const text = passage.text.trim();
            return {
                section: passage.section,
                text,
                passageIndex,
                passageCount: passages.length,
                tokens: estimatedTokens(text),
                embeddingText: passage.section === '(intro)' ? `${title} — ${text}` : `${title} / ${passage.section} — ${text}`,
            };
        }),
    };
}
