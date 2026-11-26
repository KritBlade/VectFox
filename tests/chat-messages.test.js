/**
 * The one place VectFox reads the open chat (src/shared/chat-messages.js and chat-messages-core.js, H4 of
 * InternalProject/Vectfox/plans/executed/vectfox-public-api.md, §5.4): the chat as SillyTavern holds it, and story order, where a
 * summary the message sources answer for reads as the messages it stands for, through summaries within summaries, with
 * a guard against a summary that holds one it is read inside and against summaries too deep; and no other file of src/
 * reads the open chat from SillyTavern's context.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ context: {} }));

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));

const { MAX_SUMMARY_DEPTH, hasText, storyOrderOf } = await import('../src/shared/chat-messages-core.js');
const { chatMessages, openChatStoryOrder, setMessageSource, storyMessages } = await import('../src/shared/chat-messages.js');
const { log } = await import('../src/sillytavern/log.js');

const say = (name, mes) => ({ name, mes, is_user: name === 'Wren' });
/** A summary holding the messages it stands for, as a made-up summarizer keeps them. */
const summaryOf = (mes, originals) => ({ name: 'Summary', mes, is_user: false, stands: originals });
/** The made-up summarizer's message source, as askMessageSources gives its answer. */
const askLanternSummaries = message => (Array.isArray(message.stands) ? { owner: 'Lantern Summaries', originals: message.stands } : null);
const readStory = (chat, askSources = askLanternSummaries, onProblem) => storyOrderOf(chat, { chatMetadata: {}, askSources, onProblem });

beforeEach(() => {
    host.context = {};
    vi.clearAllMocks();
});

afterEach(() => {
    setMessageSource(null);
});

describe('story order', () => {
    it('reads each message with text as itself while no source is set, and one with no text, or no message, takes no place', () => {
        const chat = [say('Orrin', 'The lamp is out.'), say('Wren', ''), say('Orrin', '   '), { name: 'Wren' }, null, say('Wren', 'I will light it.')];
        const { messages, places } = readStory(chat, null);
        expect(messages).toEqual([chat[0], chat[5]]);
        expect(messages[0]).toBe(chat[0]);
        expect(places).toEqual([
            { isSummary: false, start: 0, end: 1 },
            ...Array(4).fill({ isSummary: false, start: 1, end: 1 }),
            { isSummary: false, start: 1, end: 2 },
        ]);
        expect([' x ', 'x', '', '  ', undefined, 7].map(mes => hasText({ mes }))).toEqual([true, true, false, false, false, false]);
        // A source is never asked about something that is not a message.
        const asked = [];
        const read = readStory([null, 'The lamp is out.', 7, chat[5]], (message) => {
            asked.push(message);
            return null;
        });
        expect(read.messages).toEqual([chat[5]]);
        expect(asked).toEqual([chat[5]]);
    });

    it('reads a summary as the messages it stands for, in its place, and skips one answered with none', () => {
        const kept = [say('Orrin', 'The lamp is out.'), say('Wren', 'I will light it.'), say('Orrin', 'Mind the wick.')];
        const chat = [summaryOf('Orrin and Wren light the lamp.', kept), summaryOf('Earlier, they argued.', []), say('Wren', 'It burns.')];
        const { messages, places } = readStory(chat);
        expect(messages).toEqual([...kept, chat[2]]);
        expect(places).toEqual([
            { isSummary: true, start: 0, end: 3 },
            { isSummary: true, start: 3, end: 3 },
            { isSummary: false, start: 3, end: 4 },
        ]);
    });

    it('reads summaries within summaries, asking about each message a summary stands for in turn', () => {
        const one = say('Orrin', 'one');
        const two = say('Wren', 'two');
        const three = say('Orrin', 'three');
        const inner = summaryOf('inner', [one, two]);
        const outer = summaryOf('outer', [inner, three]);
        const four = say('Wren', 'four');
        const asked = [];
        const { messages, places } = readStory([outer, four], (message) => {
            asked.push(message);
            return askLanternSummaries(message);
        });
        expect(messages).toEqual([one, two, three, four]);
        expect(places).toEqual([{ isSummary: true, start: 0, end: 3 }, { isSummary: false, start: 3, end: 4 }]);
        expect(asked).toEqual([outer, inner, one, two, three, four]);
    });

    it('reads as it is a message that is one of the summaries it is read inside, and says so', () => {
        const one = say('Orrin', 'one');
        const looping = summaryOf('The summary of itself.', [one]);
        looping.stands.push(looping);
        const onProblem = vi.fn();
        const { messages, places } = readStory([looping, say('Wren', 'two')], askLanternSummaries, onProblem);
        expect(messages.map(message => message.mes)).toEqual(['one', 'The summary of itself.', 'two']);
        expect(places[0]).toEqual({ isSummary: true, start: 0, end: 2 });
        expect(onProblem).toHaveBeenCalledTimes(1);
        expect(onProblem).toHaveBeenCalledWith({ kind: 'loop', owner: 'Lantern Summaries' });
    });

    it(`opens summaries ${MAX_SUMMARY_DEPTH} deep, and reads one deeper as it is, saying so`, () => {
        // summaries[0] stands for summaries[1], and so on; the last stands for the message under them all.
        const chainOf = (depth) => {
            const under = say('Wren', 'under them all');
            const summaries = Array.from({ length: depth }, (_, level) => summaryOf(`level ${level}`, []));
            summaries.forEach((summary, level) => summary.stands.push(summaries[level + 1] ?? under));
            return summaries[0];
        };
        const onProblem = vi.fn();
        expect(readStory([chainOf(MAX_SUMMARY_DEPTH)], askLanternSummaries, onProblem).messages.map(message => message.mes)).toEqual(['under them all']);
        expect(onProblem).not.toHaveBeenCalled();

        const { messages, places } = readStory([chainOf(MAX_SUMMARY_DEPTH + 1)], askLanternSummaries, onProblem);
        expect(messages.map(message => message.mes)).toEqual([`level ${MAX_SUMMARY_DEPTH}`]);
        expect(places).toEqual([{ isSummary: true, start: 0, end: 1 }]);
        expect(onProblem).toHaveBeenCalledWith({ kind: 'depth', owner: 'Lantern Summaries' });
        expect(MAX_SUMMARY_DEPTH).toBe(64);
    });

    it('asks with each message and one frozen object holding the chat\'s metadata', () => {
        const chatMetadata = { integrity: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' };
        const asked = [];
        storyOrderOf([say('Orrin', 'one'), say('Wren', 'two')], {
            chatMetadata,
            askSources: (message, context) => {
                asked.push(context);
                return null;
            },
        });
        expect(asked).toHaveLength(2);
        expect(asked[0]).toBe(asked[1]);
        expect(asked[0]).toEqual({ chatMetadata });
        expect(asked[0].chatMetadata).toBe(chatMetadata);
        expect(Object.isFrozen(asked[0])).toBe(true);
    });
});

describe('the open chat', () => {
    it('chatMessages gives the chat itself, a summary as itself, and none with no chat open', () => {
        const chat = [summaryOf('Orrin and Wren light the lamp.', [say('Orrin', 'one')]), say('Wren', '')];
        host.context = { chat };
        setMessageSource(askLanternSummaries);
        expect(chatMessages()).toBe(chat);
        host.context = {};
        expect(chatMessages()).toEqual([]);
        host.context = undefined;
        expect(chatMessages()).toEqual([]);
    });

    it('storyMessages reads the open chat in story order, asking the source set, with the chat\'s metadata as it is now', () => {
        const kept = [say('Orrin', 'one'), say('Wren', 'two')];
        const chat = [summaryOf('Orrin and Wren light the lamp.', kept), say('Orrin', 'three')];
        const metadataSeen = [];
        setMessageSource((message, { chatMetadata }) => {
            metadataSeen.push(chatMetadata);
            return askLanternSummaries(message);
        });
        const loaded = { integrity: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' };
        host.context = { chat, chatMetadata: loaded };
        expect(storyMessages()).toEqual([...kept, chat[1]]);
        expect(new Set(metadataSeen)).toEqual(new Set([loaded]));

        // A chat reload replaces the metadata object: the next read hands over the new one.
        const reloaded = { integrity: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' };
        host.context = { chat, chatMetadata: reloaded };
        metadataSeen.length = 0;
        storyMessages();
        expect(new Set(metadataSeen)).toEqual(new Set([reloaded]));

        expect(openChatStoryOrder().places).toEqual([{ isSummary: true, start: 0, end: 2 }, { isSummary: false, start: 2, end: 3 }]);
        setMessageSource(null);
        expect(storyMessages()).toEqual(chat);
    });

    it('says once in the console, for each owner and kind, that a summary was read as it is', () => {
        const looping = summaryOf('The summary of itself.', []);
        looping.stands.push(looping);
        setMessageSource(askLanternSummaries);
        host.context = { chat: [looping] };
        storyMessages();
        storyMessages();
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][0]).toContain('Lantern Summaries');

        const deep = summaryOf('level 0', []);
        let summary = deep;
        for (let level = 1; level <= MAX_SUMMARY_DEPTH; level++) {
            const next = summaryOf(`level ${level}`, []);
            summary.stands.push(next);
            summary = next;
        }
        summary.stands.push(say('Wren', 'under them all'));
        host.context = { chat: [deep] };
        storyMessages();
        storyMessages();
        expect(log.warn).toHaveBeenCalledTimes(2);
    });
});

describe('the one read path', () => {
    const sourceFolder = fileURLToPath(new URL('../src/', import.meta.url));
    const sourceFiles = folder => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = `${folder}${entry.name}`;
        if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sourceFiles(`${path}/`);
        return entry.name.endsWith('.js') ? [path] : [];
    });
    /** Whether a file reads the open chat from SillyTavern's context: getContext().chat, destructured, or on a name it gave the context. */
    const readsTheOpenChat = (source) => {
        const contextNames = [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:SillyTavern\.)?getContext\(\)/g)].map(match => match[1]);
        return [
            /getContext\(\)\??\.chat\b/,
            /\{[^}]*\bchat\b[^}]*\}\s*=\s*(?:SillyTavern\.)?getContext\(\)/,
            ...contextNames.map(name => new RegExp(`\\b${name}\\??\\.chat\\b`)),
        ].some(pattern => pattern.test(source));
    };

    it('reads the open chat in src/shared/chat-messages.js alone', () => {
        const readers = sourceFiles(sourceFolder)
            .filter(path => readsTheOpenChat(readFileSync(path, 'utf8')))
            .map(path => path.slice(sourceFolder.length).replaceAll('\\', '/'));
        expect(readers).toEqual(['shared/chat-messages.js']);
    });

    it('gives EventBase and the counts on VectFox\'s pages story order, and the search text, LoreBase\'s scene, the planner and Entity-Lore\'s story language the chat as the model reads it', () => {
        const readsOf = path => [...new Set([...readFileSync(path, 'utf8').matchAll(/\b(chatMessages|storyMessages|openChatStoryOrder)\(\)/g)].map(match => match[1]))].sort();
        const readers = Object.fromEntries(sourceFiles(sourceFolder)
            .map(path => [path.slice(sourceFolder.length).replaceAll('\\', '/'), readsOf(path)])
            .filter(([path, reads]) => reads.length > 0 && path !== 'shared/chat-messages.js'));
        expect(readers).toEqual({
            // Story order: extraction, its runs and counts.
            'features/eventbase/content-vectorizer.js': ['storyMessages'],
            'features/eventbase/eventbase-chat-sync.js': ['storyMessages'],
            'features/eventbase/eventbase-fork.js': ['storyMessages'],
            'features/eventbase/eventbase-read-again.js': ['storyMessages'],
            'features/eventbase/eventbase-store.js': ['storyMessages'],
            'features/eventbase/eventbase-workflow.js': ['storyMessages'],
            'features/settings-panel/settings-panel.js': ['storyMessages'],
            // The chat as the model reads it.
            'features/diagnostics/query-tester.js': ['chatMessages'],
            'features/eventbase/agentic-retrieval.js': ['chatMessages'],
            'features/entity-lore/entity-lore.js': ['chatMessages'],
            'features/lorebase/lorebase-scene.js': ['chatMessages'],
            'features/lorebase/lorebase-tester.js': ['chatMessages'],
            // Ghosting: story order mapped back to the chat.
            'features/eventbase/summarizer-injection.js': ['chatMessages', 'openChatStoryOrder'],
        });
    });

    it('catches each way a file can read it', () => {
        expect([
            'const chat = getContext().chat;',
            'const chat = SillyTavern.getContext()?.chat;',
            'const { chat } = getContext();',
            'const { chat: messages, chatId } = getContext();',
            'const context = getContext();\nreturn context.chat.length;',
            'const ctx = getContext();\nreturn ctx?.chat;',
        ].map(readsTheOpenChat)).toEqual([true, true, true, true, true, true]);
        expect([
            'const metadata = getContext().chatMetadata;',
            'const { chatMetadata, chatId } = getContext();',
            'const context = getContext();\nreturn context.chat_metadata;',
        ].map(readsTheOpenChat)).toEqual([false, false, false]);
    });
});
