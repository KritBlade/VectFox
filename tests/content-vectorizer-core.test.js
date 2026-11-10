/**
 * @vitest-environment jsdom
 *
 * Vectorize Content's rules (src/features/chunkbase/content-vectorizer-core.js): the chunking controls a page shows, the
 * values its boxes take, what the dialog does once an EventBase run ends, and how files and fetched pages become
 * sources, including the old dialog's faults: a PNG card's non-ASCII name decoded byte by byte, and a web page read as
 * JSON when SillyTavern returns its HTML.
 */
/* global DOMParser -- this file runs under the jsdom environment */

import { describe, expect, it } from 'vitest';
import {
    CONTENT_TYPE_GROUPS,
    characterStats,
    chatCharacterName,
    chunkingControls,
    eventBaseRunEnding,
    extractCharNameFromArchiveFilename,
    extractCharaFromPng,
    extractFandomId,
    extractWikiName,
    keywordWeightFrom,
    lorebookStats,
    pageTextFromHtml,
    parseCharacterJson,
    parseChatFile,
    parseLorebookFile,
    parseYouTubeId,
    previewOf,
    startFromMessageOf,
} from '../src/features/chunkbase/content-vectorizer-core.js';
import { CONTENT_TYPES } from '../src/features/chunkbase/content-types.js';

const parseHtml = html => new DOMParser().parseFromString(html, 'text/html');

/** A PNG holding one tEXt chunk per [keyword, text] pair, as SillyTavern writes a card. */
function pngWith(chunks) {
    const bytes = [137, 80, 78, 71, 13, 10, 26, 10];
    const chunk = (type, data) => {
        const length = data.length;
        bytes.push((length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255);
        bytes.push(...[...type].map(character => character.charCodeAt(0)), ...data, 0, 0, 0, 0);
    };
    for (const [keyword, text] of chunks) chunk('tEXt', [...new TextEncoder().encode(keyword), 0, ...new TextEncoder().encode(text)]);
    chunk('IEND', []);
    return new Uint8Array(bytes);
}
const base64Of = text => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('the rail and the chunking controls', () => {
    it('groups every content type once', () => {
        const grouped = CONTENT_TYPE_GROUPS.flatMap(group => group.typeIds);
        expect([...grouped].sort()).toEqual(Object.keys(CONTENT_TYPES).sort());
    });

    it('shows a chat EventBase\'s windows, an accepted Auto-Reformat nothing, and a strategy its own size', () => {
        expect(chunkingControls('chat', 'per_message', false)).toMatchObject({ showsStrategy: false, showsWindows: true });
        expect(chunkingControls('document', 'adaptive', true)).toMatchObject({ showsStrategy: false, showsSize: false, showsWindows: false });
        expect(chunkingControls('document', 'adaptive', false)).toMatchObject({ showsStrategy: true, showsSize: true, showsBatch: false });
        expect(chunkingControls('lorebook', 'per_entry', false)).toMatchObject({ showsStrategy: true, showsSize: false });
        // Auto-Reformat reads only Document, URL and Wiki, so a lorebook ignores a stale accepted flag.
        expect(chunkingControls('lorebook', 'per_entry', true).showsStrategy).toBe(true);
    });

    it('holds a keyword weight to 0.01 to 3 and a start message to whole numbers from 1', () => {
        expect([keywordWeightFrom('9'), keywordWeightFrom('0'), keywordWeightFrom('x'), keywordWeightFrom('1.2')]).toEqual([3, 0.01, 1.5, 1.2]);
        expect([startFromMessageOf('2000'), startFromMessageOf('0'), startFromMessageOf(''), startFromMessageOf('-3')]).toEqual([2000, 1, 1, 1]);
    });
});

describe('chat files', () => {
    it('reads a SillyTavern .jsonl: its header, its messages and their reasoning, without system lines', () => {
        const text = [
            JSON.stringify({ user_name: 'Rin', character_name: 'Harbor Keeper', chat_metadata: { integrity: 'abc' } }),
            JSON.stringify({ name: 'Rin', is_user: true, mes: 'Open the gate.' }),
            JSON.stringify({ name: 'System', is_system: true, mes: 'Note' }),
            JSON.stringify({ name: 'Harbor Keeper', mes: 'It opens.', extra: { reasoning: 'Evening, at the dock.' } }),
        ].join('\n');
        const { messages, metadata } = parseChatFile(text, 'jsonl');
        expect(metadata.chat_metadata.integrity).toBe('abc');
        expect(messages.map(message => message.mes)).toEqual(['Open the gate.', 'It opens.']);
        expect(messages[1].reasoning).toBe('Evening, at the dock.');
        expect(chatCharacterName(messages, metadata)).toBe('Harbor Keeper');
    });

    it('reads a .json export or array, and a .txt log of "Name: words" lines or one block', () => {
        expect(parseChatFile(JSON.stringify({ chat: [{ name: 'A', mes: 'x' }] }), 'json').messages).toHaveLength(1);
        expect(parseChatFile(JSON.stringify([{ name: 'A', mes: 'x' }, { mes: '' }]), 'json').messages).toHaveLength(1);
        const log = parseChatFile('You: hello\nKeeper: welcome\nYou: thanks', 'txt');
        expect(log.messages.map(message => message.is_user)).toEqual([true, false, true]);
        expect(parseChatFile('Just one paragraph.', 'txt').messages).toEqual([{ mes: 'Just one paragraph.', name: 'Document', is_user: false }]);
        expect(chatCharacterName(log.messages, null)).toBe('Keeper');
    });

    it('names an export\'s character from its file name', () => {
        expect(extractCharNameFromArchiveFilename('Harbor Keeper - 2026-04-14@15h56m11s.jsonl')).toBe('Harbor Keeper');
        expect(extractCharNameFromArchiveFilename('notes.txt')).toBe('notes');
    });
});

describe('lorebook and character files', () => {
    it('reads a lorebook\'s entries with text, and refuses a file without entries', () => {
        const entries = parseLorebookFile(JSON.stringify({ entries: { 0: { content: 'Gate' }, 1: { content: '' }, 2: { content: 'Tide', disable: true } } }));
        expect(entries).toHaveLength(2);
        expect(lorebookStats(entries)).toEqual({ entryCount: 2, enabledCount: 1, textLength: 8 });
        expect(() => parseLorebookFile('{}')).toThrow('no entries');
    });

    it('unwraps a V2 JSON card, and refuses a file with no character', () => {
        expect(parseCharacterJson(JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Keeper', description: 'Old.' } })).name).toBe('Keeper');
        expect(() => parseCharacterJson('{"x":1}')).toThrow('not a character card');
        expect(characterStats({ description: 'Old.', personality: ' ' })).toEqual({ filledCount: 1, fieldCount: 5, textLength: 5 });
    });

    // atob alone read each byte of a UTF-8 name as a letter of its own.
    it('reads a PNG card\'s name in any script, preferring its V3 chunk', () => {
        const v2 = base64Of(JSON.stringify({ spec: 'chara_card_v2', data: { name: '茶 Keeper' } }));
        const v3 = base64Of(JSON.stringify({ spec: 'chara_card_v3', data: { name: '茶 Keeper v3' } }));
        expect(extractCharaFromPng(pngWith([['chara', v2]])).name).toBe('茶 Keeper');
        expect(extractCharaFromPng(pngWith([['chara', v2], ['ccv3', v3]])).name).toBe('茶 Keeper v3');
        expect(extractCharaFromPng(pngWith([]))).toBeNull();
        expect(() => extractCharaFromPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('not a PNG');
    });
});

describe('fetched sources', () => {
    it('finds a YouTube ID in any link, and a wiki\'s name in its address', () => {
        expect(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toBe('dQw4w9WgXcQ');
        expect(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
        expect(parseYouTubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
        expect(parseYouTubeId('not a video')).toBeNull();
        expect(extractFandomId('https://baldursgate.fandom.com/wiki/Gate')).toBe('baldursgate');
        expect(extractFandomId('baldursgate')).toBe('baldursgate');
        expect(extractWikiName('https://en.wikipedia.org/wiki/Harbor', 'mediawiki')).toBe('Harbor');
    });

    // SillyTavern's visit route returns the page's HTML, which the old dialog read as JSON.
    it('reads a web page\'s title and readable text, headings as Markdown, without scripts and menus', () => {
        const html = '<html><head><title>The Harbor</title><style>p{}</style></head><body><nav>Home | About</nav>'
            + '<article><h1>The Harbor</h1><p>The gate   stood open.</p><script>track()</script><h2>Tides</h2><p>The tide came in.</p></article>'
            + '<footer>© site</footer></body></html>';
        expect(pageTextFromHtml(html, parseHtml)).toEqual({ title: 'The Harbor', text: '# The Harbor\n\nThe gate stood open.\n\n## Tides\n\nThe tide came in.' });
    });
});

describe('preview', () => {
    it('lists the first ten chunks with their opening words and lengths, an entry\'s type and name first', () => {
        const chunks = Array.from({ length: 12 }, (_, index) => `Chunk ${index}`);
        const preview = previewOf(chunks, 84);
        expect(preview).toMatchObject({ count: 12, averageLength: 7, moreCount: 2 });
        expect(preview.rows[0]).toEqual({ number: 1, text: 'Chunk 0', length: 7 });
        const entry = previewOf([{ text: 'Rules the harbor.', metadata: { strategy: 'llm_reformat', entry_type: 'character', name: 'Keeper' } }], 17);
        expect(entry.rows[0].text).toBe('[character] Keeper: Rules the harbor.');
    });
});

describe('the end of an EventBase run', () => {
    it('closes after a clean read of something new', () => {
        expect(eventBaseRunEnding({ windowsProcessed: 4 }, { unfinishedWindowCount: 0 })).toEqual({ shouldClose: true, message: '' });
    });

    it('stays open saying so when nothing was new, a message short of a window included', () => {
        const ending = eventBaseRunEnding({ windowsProcessed: 0 }, { unfinishedWindowCount: 0 });
        expect(ending.shouldClose).toBe(false);
        expect(ending.message).toBe('Nothing new to read. A message that does not fill a window waits for the next one.');
    });

    it('stays open on a stop, with or without a result, pointing at Resume', () => {
        expect(eventBaseRunEnding({ windowsProcessed: 2 }, { isStopped: true }).message).toContain('Resume');
        expect(eventBaseRunEnding(null, { isStopped: true }).shouldClose).toBe(false);
    });

    it('stays open quietly when windows were left, whose notice says the rest, or when the run never started', () => {
        expect(eventBaseRunEnding({ windowsProcessed: 3 }, { unfinishedWindowCount: 1 })).toEqual({ shouldClose: false, message: '' });
        expect(eventBaseRunEnding(null)).toEqual({ shouldClose: false, message: '' });
    });
});
