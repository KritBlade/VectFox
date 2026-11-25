/**
 * Message sources (H4 of InternalProject/Vectfox/plans/executed/vectfox-public-api.md, §5.4, D6, D13): `chat.registerMessageSource`
 * on the VectFox object, which story order asks about each message it reads, wired as src/index.js wires it; a source
 * that throws, or answers anything but null or a list of messages, counts as null and is said in the console once; and
 * the sample message source for InlineSummary (tools/public-api-sample/message-source.js), registered as another
 * extension registers it, reading each of InlineSummary's three places for the originals, through summaries within
 * summaries, so EventBase reads the same messages in the same places before a summary, with it and after a restore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inlineSummaryOriginals, registerInlineSummarySource } from '../tools/public-api-sample/message-source.js';

const host = vi.hoisted(() => ({ listeners: {}, chatMetadata: {}, context: {} }));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: {
        on: (event, listener) => { (host.listeners[event] ??= []).push(listener); },
        removeListener: (event, listener) => {
            const listeners = host.listeners[event] ?? [];
            const index = listeners.indexOf(listener);
            if (index > -1) listeners.splice(index, 1);
        },
        emit: async (event, ...args) => {
            for (const listener of (host.listeners[event] ?? []).slice()) await listener(...args);
        },
    },
    event_types: {},
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/shared/extension-manifest.js', () => ({ loadExtensionManifest: async () => ({ version: '3.6.300' }) }));
vi.mock('../src/sillytavern/chat.js', () => ({ getContext: () => host.context, getCurrentChatId: () => null, chat_metadata: host.chatMetadata }));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: {} }));
vi.mock('../src/features/eventbase/index.js', () => ({ openChatCollectionInUse: () => ({ chatId: null, collectionId: null }), readEventFeed: vi.fn() }));

const { hashSourceMessage } = await import('../src/features/eventbase/eventbase-message-hash.js');

/** The modules fresh, as a page load gives them, the object published and story order asking its message sources. */
async function loadWiredApi() {
    vi.resetModules();
    const { log } = await import('../src/sillytavern/log.js');
    const { eventSource } = await import('../src/sillytavern/events.js');
    const publicApi = await import('../src/features/public-api/index.js');
    const chatMessages = await import('../src/shared/chat-messages.js');
    publicApi.publishPublicApi();
    chatMessages.setMessageSource(publicApi.askMessageSources);
    return { api: globalThis.VectFox, publicApi, log, eventSource, ...chatMessages };
}

const say = (name, mes) => ({ name, mes, is_user: name === 'Wren' });
/** A chat of made-up messages, from message `from` to message `to`. */
const story = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => say((from + i) % 2 === 0 ? 'Keeper Orrin' : 'Wren', `message ${from + i}`));
/** InlineSummary's summary message since 1.2.0: the originals on the message itself. */
const inlineSummaryOf = originals => ({ name: 'Summary', is_user: false, is_system: false, mes: `Summary of ${originals.length} messages.`, extra: {}, ILS_Data: { OriginalMessages: originals } });
/** The same summary as InlineSummary wrote it before 1.2.0: the originals in extra. */
const legacyInlineSummaryOf = originals => ({ name: 'Summary', is_user: false, mes: `Summary of ${originals.length} messages.`, extra: { ILS_Data: { OriginalMessages: originals } } });
/** brasen56's fork's summary: a Ref into the chat's metadata, which holds the originals. */
const forkSummaryOf = ref => ({ name: 'Summary', is_user: false, mes: 'Summary kept by Ref.', extra: { ILS_Data: { Ref: ref } } });

beforeEach(() => {
    host.listeners = {};
    host.context = {};
    delete globalThis.VectFox;
    delete globalThis.SillyTavern;
});

afterEach(() => {
    delete globalThis.VectFox;
    delete globalThis.SillyTavern;
    vi.clearAllMocks();
});

describe('chat.registerMessageSource', () => {
    it('is on the frozen chat group, named in capabilities, and takes a source before VectFox is ready', async () => {
        const { api, storyMessages } = await loadWiredApi();
        expect(typeof api.chat.registerMessageSource).toBe('function');
        expect(Object.isFrozen(api.chat)).toBe(true);
        expect(api.capabilities).toContain('chat.messageSource');
        expect(api.isReady()).toBe(false);

        const kept = story(0, 2);
        host.context = { chat: [inlineSummaryOf(kept), ...story(3, 4)], chatMetadata: {} };
        const unregister = api.chat.registerMessageSource({ owner: 'Lantern Summaries', originalsOf: inlineSummaryOriginals });
        expect(storyMessages()).toEqual(story(0, 4));
        unregister();
        unregister();
        expect(storyMessages().map(message => message.mes)).toEqual(['Summary of 3 messages.', 'message 3', 'message 4']);
    });

    it('throws a TypeError for a source that cannot be right, and registers nothing', async () => {
        const { api, storyMessages } = await loadWiredApi();
        const originalsOf = vi.fn(() => null);
        for (const source of [undefined, null, 'Lantern Summaries', [], { originalsOf }, { owner: '', originalsOf }, { owner: '   ', originalsOf },
            { owner: 7, originalsOf }, { owner: 'Lantern Summaries' }, { owner: 'Lantern Summaries', originalsOf: 'originals' }]) {
            expect(() => api.chat.registerMessageSource(source), JSON.stringify(source)).toThrow(TypeError);
        }
        host.context = { chat: story(0, 1) };
        storyMessages();
        expect(originalsOf).not.toHaveBeenCalled();
    });

    it('asks each source in the order it registered, until one answers for the message', async () => {
        const { api, storyMessages } = await loadWiredApi();
        const byLantern = say('Summary', 'Lantern\'s summary');
        const byHearth = say('Summary', 'Hearth\'s summary');
        const asked = [];
        const lantern = api.chat.registerMessageSource({
            owner: 'Lantern Summaries',
            originalsOf: (message) => {
                asked.push(`Lantern: ${message.mes}`);
                return message === byLantern ? [say('Wren', 'what Lantern summarized')] : null;
            },
        });
        api.chat.registerMessageSource({
            owner: 'Hearth Summaries',
            originalsOf: (message) => {
                asked.push(`Hearth: ${message.mes}`);
                return message === byHearth || message === byLantern ? [say('Wren', 'what Hearth summarized')] : null;
            },
        });
        host.context = { chat: [byLantern, byHearth] };
        expect(storyMessages().map(message => message.mes)).toEqual(['what Lantern summarized', 'what Hearth summarized']);
        expect(asked).toEqual([
            'Lantern: Lantern\'s summary',
            'Lantern: what Lantern summarized', 'Hearth: what Lantern summarized',
            'Lantern: Hearth\'s summary', 'Hearth: Hearth\'s summary',
            'Lantern: what Hearth summarized', 'Hearth: what Hearth summarized',
        ]);
        lantern();
        expect(storyMessages().map(message => message.mes)).toEqual(['what Hearth summarized', 'what Hearth summarized']);
    });

    it('counts a source that throws as answering null: the next is asked, the message reads as itself, and the console says so once', async () => {
        const { api, storyMessages, log } = await loadWiredApi();
        const failure = new Error('ILS_Data is not ready');
        api.chat.registerMessageSource({ owner: 'Lantern Summaries', originalsOf: () => { throw failure; } });
        host.context = { chat: [say('Summary', 'A summary.'), say('Wren', 'message 1')] };
        expect(storyMessages().map(message => message.mes)).toEqual(['A summary.', 'message 1']);

        api.chat.registerMessageSource({ owner: 'Hearth Summaries', originalsOf: message => (message.name === 'Summary' ? [say('Wren', 'message 0')] : null) });
        expect(storyMessages().map(message => message.mes)).toEqual(['message 0', 'message 1']);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][0]).toContain('VectFox public API: Lantern Summaries hook failed');
        expect(log.warn.mock.calls[0][1]).toBe(failure);
    });

    it('asks the next source after one that answers anything but null or a list of messages', async () => {
        const { api, storyMessages } = await loadWiredApi();
        api.chat.registerMessageSource({ owner: 'Lantern Summaries', originalsOf: () => 'not a list' });
        api.chat.registerMessageSource({ owner: 'Hearth Summaries', originalsOf: message => (message.name === 'Summary' ? [say('Wren', 'message 0')] : null) });
        host.context = { chat: [say('Summary', 'A summary.'), say('Wren', 'message 1')] };
        expect(storyMessages().map(message => message.mes)).toEqual(['message 0', 'message 1']);
    });

    it('counts an answer of anything but null or a list of messages as null, and says so once for each kind', async () => {
        const { api, storyMessages, log } = await loadWiredApi();
        const answers = new Map([
            ['undefined', undefined], ['a promise', Promise.resolve([])], ['a string', 'message 0'], ['an object', { mes: 'message 0' }],
            ['a list holding a string', ['message 0']], ['a list holding null', [null]], ['a list holding a list', [[say('Wren', 'message 0')]]],
        ]);
        api.chat.registerMessageSource({ owner: 'Lantern Summaries', originalsOf: message => answers.get(message.mes) });
        const chat = [...answers.keys()].map(kind => say('Summary', kind));
        host.context = { chat };
        expect(storyMessages()).toEqual(chat);
        storyMessages();
        const said = log.warn.mock.calls.map(([text]) => text);
        expect(said).toHaveLength(answers.size - 2);
        expect(said.every(text => text.startsWith('VectFox public API: Lantern Summaries hook failed: its message source answered'))).toBe(true);
        expect(said.some(text => text.includes('a promise, where it must answer at once'))).toBe(true);
    });
});

describe('the sample message source for InlineSummary (D13)', () => {
    it('reads the originals on the summary itself, as InlineSummary keeps them since 1.2.0, and each ordinary message as itself', () => {
        const originals = story(0, 2);
        expect(inlineSummaryOriginals(inlineSummaryOf(originals), { chatMetadata: {} })).toBe(originals);
        expect(inlineSummaryOriginals(say('Wren', 'message 3'), { chatMetadata: {} })).toBeNull();
        expect(inlineSummaryOriginals({ ...say('Wren', 'message 3'), extra: { gen_id: 1 } }, { chatMetadata: {} })).toBeNull();
    });

    it('reads the originals in the summary\'s extra, as InlineSummary kept them before 1.2.0', () => {
        const originals = story(0, 2);
        expect(inlineSummaryOriginals(legacyInlineSummaryOf(originals), { chatMetadata: {} })).toBe(originals);
    });

    it('reads brasen56\'s fork\'s originals from the chat\'s metadata, under the summary\'s Ref, and a summary whose originals are gone as itself', () => {
        const originals = story(0, 2);
        const chatMetadata = { ILS_Originals: { 'ils-ref-1': originals } };
        expect(inlineSummaryOriginals(forkSummaryOf('ils-ref-1'), { chatMetadata })).toBe(originals);
        expect(inlineSummaryOriginals(forkSummaryOf('ils-ref-2'), { chatMetadata })).toBeNull();
        expect(inlineSummaryOriginals(forkSummaryOf('ils-ref-1'), { chatMetadata: {} })).toBeNull();
        expect(inlineSummaryOriginals({ ...inlineSummaryOf([]), ILS_Data: {} }, { chatMetadata })).toBeNull();
    });

    it('registered through VectFox, reads each of the three places and summaries within summaries in story order', async () => {
        const { api, storyMessages } = await loadWiredApi();
        api.chat.registerMessageSource({ owner: 'InlineSummary message source', originalsOf: inlineSummaryOriginals });
        // Messages 0 to 3 under a summary inside a summary, 4 to 5 under an old summary, 6 to 7 kept by the fork's
        // Ref, and 8 as it is; a summary whose Ref holds nothing reads as itself.
        const inner = inlineSummaryOf(story(0, 1));
        const outer = inlineSummaryOf([inner, ...story(2, 3)]);
        const gone = forkSummaryOf('ils-ref-gone');
        host.context = {
            chat: [outer, legacyInlineSummaryOf(story(4, 5)), forkSummaryOf('ils-ref-1'), ...story(8, 8), gone],
            chatMetadata: { ILS_Originals: { 'ils-ref-1': story(6, 7) } },
        };
        expect(storyMessages()).toEqual([...story(0, 8), gone]);
    });

    it('registers right away with VectFox\'s object there, on vectfox_ready when VectFox loads after it, and leaves a VectFox without message sources alone', async () => {
        const kept = story(0, 1);
        const summarized = [inlineSummaryOf(kept), ...story(2, 2)];

        // Loaded after VectFox: registers right away.
        let wired = await loadWiredApi();
        host.context = { chat: summarized };
        registerInlineSummarySource();
        expect(wired.storyMessages()).toEqual(story(0, 2));

        // Loaded before VectFox: waits for vectfox_ready on SillyTavern's eventSource.
        delete globalThis.VectFox;
        host.listeners = {};
        const { eventSource } = await import('../src/sillytavern/events.js');
        globalThis.SillyTavern = { getContext: () => ({ eventSource }) };
        registerInlineSummarySource();
        wired = await loadWiredApi();
        expect(wired.storyMessages()).toEqual(summarized);
        await wired.publicApi.announcePublicApiReady({});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(wired.storyMessages()).toEqual(story(0, 2));

        // A VectFox too old for message sources is left alone.
        const registerMessageSource = vi.fn();
        globalThis.VectFox = { capabilities: ['events', 'chat'], chat: { registerMessageSource } };
        registerInlineSummarySource();
        expect(registerMessageSource).not.toHaveBeenCalled();
    });
});

describe('story order across a summary and a restore', () => {
    it('gives EventBase the same messages, in the same places, before InlineSummary summarizes, while it does, and after a restore', async () => {
        const { api, storyMessages, openChatStoryOrder } = await loadWiredApi();
        const unregister = api.chat.registerMessageSource({ owner: 'InlineSummary message source', originalsOf: inlineSummaryOriginals });
        const chat = story(0, 9);
        host.context = { chat, chatMetadata: {} };
        const before = storyMessages();
        const hashesBefore = before.map(hashSourceMessage);

        // InlineSummary summarizes messages 2 to 6: it takes them out and puts one summary holding them in their place.
        const originals = chat.splice(2, 5);
        chat.splice(2, 0, inlineSummaryOf(originals));
        expect(chat).toHaveLength(6);
        const summarized = storyMessages();
        expect(summarized).toHaveLength(10);
        summarized.forEach((message, place) => expect(message, `message ${place}`).toBe(before[place]));
        expect(summarized.map(hashSourceMessage)).toEqual(hashesBefore);
        expect(openChatStoryOrder().places.map(({ start, end }) => [start, end])).toEqual([[0, 1], [1, 2], [2, 7], [7, 8], [8, 9], [9, 10]]);

        // Restore puts the originals back where the summary was.
        chat.splice(2, 1, ...originals);
        expect(storyMessages().map(hashSourceMessage)).toEqual(hashesBefore);

        // Without the source, the summary reads as a message of its own, and every message after it moves.
        chat.splice(2, 5, inlineSummaryOf(originals));
        unregister();
        expect(storyMessages().map(message => message.mes)).toEqual(['message 0', 'message 1', 'Summary of 5 messages.', 'message 7', 'message 8', 'message 9']);
    });
});
