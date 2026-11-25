/**
 * LoreBase's scene (plan §5.5 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): the last
 * 6 messages of the stored chat up to the user's last message, hidden ones left out, each cleaned as the route trials
 * cleaned their chats.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/chat.js', () => ({ getContext: vi.fn(), substituteParams: vi.fn(text => text.replaceAll('{{user}}', 'Wren')) }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../src/features/text-cleaning/index.js', () => ({
    cleanText: vi.fn(text => `clean(${text})`),
    stripReasoningBlocks: vi.fn(text => `reasoning(${text})`),
    stripGameSystemBlocks: vi.fn(text => `game(${text})`),
}));

const { getContext } = await import('../src/sillytavern/chat.js');
const { sceneMessages, sceneText } = await import('../src/features/lorebase/lorebase-scene-core.js');
const { sceneMessagesFromChat } = await import('../src/features/lorebase/lorebase-scene.js');

const say = (name, mes, more = {}) => ({ name, mes, is_user: name === 'Wren', ...more });
const asWritten = text => text.trim();

describe("the scene's messages", () => {
    it("keeps the last 6 that hold text, hidden ones left out, ending with the user's last message", () => {
        const chat = [
            say('Keeper Orrin', 'one'), say('Wren', 'two'), say('Keeper Orrin', 'three'), say('Wren', 'four'),
            say('Narrator', 'hidden', { is_system: true }), say('Keeper Orrin', '   '), say('Keeper Orrin', 'five'),
            say('Wren', 'six'), say('Keeper Orrin', 'seven'), say('Wren', 'eight'),
        ];
        expect(sceneMessages(chat, asWritten)).toEqual([
            { name: 'Keeper Orrin', text: 'three' }, { name: 'Wren', text: 'four' }, { name: 'Keeper Orrin', text: 'five' },
            { name: 'Wren', text: 'six' }, { name: 'Keeper Orrin', text: 'seven' }, { name: 'Wren', text: 'eight' },
        ]);
    });

    it('leaves out the reply a swipe, a regenerate or a continue replaces', () => {
        const chat = [say('Keeper Orrin', 'one'), say('Wren', 'two'), say('Keeper Orrin', 'the reply being replaced')];
        expect(sceneMessages(chat, asWritten)).toEqual([{ name: 'Keeper Orrin', text: 'one' }, { name: 'Wren', text: 'two' }]);
    });

    it("has no scene without a user message, or when the user's last message holds no text once read", () => {
        expect(sceneMessages([], asWritten)).toBeNull();
        expect(sceneMessages([say('Keeper Orrin', 'greeting')], asWritten)).toBeNull();
        expect(sceneMessages([say('Keeper Orrin', 'greeting'), say('Wren', 'hidden', { is_system: true })], asWritten)).toBeNull();
        expect(sceneMessages([say('Keeper Orrin', 'greeting'), say('Wren', '<picture>')], text => text.replace('<picture>', ''))).toBeNull();
    });

    it('reads only the messages the scene needs', () => {
        const chat = Array.from({ length: 200 }, (_, index) => say(index % 2 ? 'Wren' : 'Keeper Orrin', `line ${index}`));
        const readText = vi.fn(asWritten);
        expect(sceneMessages(chat, readText)).toHaveLength(6);
        expect(readText).toHaveBeenCalledTimes(6);
    });
});

describe('the scene as the prompts show it', () => {
    it('shows the last 6 messages, each as name: text, with a blank line between them', () => {
        const messages = Array.from({ length: 8 }, (_, index) => ({ name: index % 2 ? 'Wren' : 'Keeper Orrin', text: `line ${index + 1}` }));
        expect(sceneText(messages)).toBe([
            'Keeper Orrin: line 3', 'Wren: line 4', 'Keeper Orrin: line 5', 'Wren: line 6', 'Keeper Orrin: line 7', 'Wren: line 8',
        ].join('\n\n'));
    });
});

describe("the open chat's scene", () => {
    it('reads the stored chat with macros substituted, then Text Cleaning, then the reasoning and game-system blocks stripped', () => {
        vi.mocked(getContext).mockReturnValue({ chat: [say('Keeper Orrin', 'Welcome, {{user}}.'), say('Wren', 'Thanks.')] });
        expect(sceneMessagesFromChat()).toEqual([
            { name: 'Keeper Orrin', text: 'game(reasoning(clean(Welcome, Wren.)))' },
            { name: 'Wren', text: 'game(reasoning(clean(Thanks.)))' },
        ]);
    });

    it('has no scene in a chat with no messages', () => {
        vi.mocked(getContext).mockReturnValue({});
        expect(sceneMessagesFromChat()).toBeNull();
    });
});
