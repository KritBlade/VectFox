/**
 * Vectorize Content's rules (src/features/eventbase/content-vectorizer-core.js): the message a chat run starts from,
 * how an uploaded chat file becomes messages and whose chat it is, what the dialog does once an EventBase run ends,
 * and Sync chat's answer for a chat that is up to date.
 */

import { describe, expect, it } from 'vitest';
import {
    CHAT_FILE_FORMATS,
    chatCharacterName,
    eventBaseRunEnding,
    syncUpToDateLines,
    extractCharNameFromArchiveFilename,
    fileExtension,
    parseChatFile,
    startFromMessageOf,
} from '../src/features/eventbase/content-vectorizer-core.js';

describe('the message a run starts from', () => {
    it('holds a start message to whole numbers from 1', () => {
        expect([startFromMessageOf('2000'), startFromMessageOf('0'), startFromMessageOf(''), startFromMessageOf('-3')]).toEqual([2000, 1, 1, 1]);
    });
});

describe('chat files', () => {
    it('takes a .txt, .jsonl or .json file, read by its extension in any case', () => {
        expect(CHAT_FILE_FORMATS).toEqual(['.txt', '.jsonl', '.json']);
        expect([fileExtension('Harbor Keeper - 2026-04-14@15h56m11s.JSONL'), fileExtension('notes.txt')]).toEqual(['jsonl', 'txt']);
    });

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

describe('the end of an EventBase run', () => {
    it('closes after a clean read of something new', () => {
        expect(eventBaseRunEnding({ windowsProcessed: 4 }, { unfinishedWindowCount: 0 })).toEqual({ shouldClose: true, message: '', hasReadNothing: false });
    });

    it('stays open saying so when nothing was new, a message short of a window included', () => {
        const ending = eventBaseRunEnding({ windowsProcessed: 0 }, { unfinishedWindowCount: 0 });
        expect(ending.shouldClose).toBe(false);
        expect(ending.message).toBe('Nothing new to read. A message that does not fill a window waits for the next one.');
        expect(ending.hasReadNothing).toBe(true);
    });

    it('stays open on a stop, with or without a result, pointing at Resume', () => {
        expect(eventBaseRunEnding({ windowsProcessed: 2 }, { isStopped: true }).message).toContain('Resume');
        expect(eventBaseRunEnding({ windowsProcessed: 0 }, { isStopped: true }).hasReadNothing).toBe(false);
        expect(eventBaseRunEnding(null, { isStopped: true }).shouldClose).toBe(false);
    });

    it('stays open quietly when windows were left, whose notice says the rest, or when the run never started', () => {
        expect(eventBaseRunEnding({ windowsProcessed: 3 }, { unfinishedWindowCount: 1 })).toEqual({ shouldClose: false, message: '', hasReadNothing: false });
        expect(eventBaseRunEnding({ windowsProcessed: 0 }, { unfinishedWindowCount: 1 }).hasReadNothing).toBe(false);
        expect(eventBaseRunEnding(null)).toEqual({ shouldClose: false, message: '', hasReadNothing: false });
    });
});

describe('Sync chat\'s answer for a chat that is up to date', () => {
    it('says how far EventBase has read, and why the rest waits', () => {
        expect(syncUpToDateLines({ readCount: 12, messageCount: 13 })).toEqual([
            { icon: 'fa-circle-check', text: 'This chat is up to date.' },
            { parts: [{ text: 'EventBase has read ' }, { name: '12' }, { text: ' of its ' }, { name: '13' }, { text: ' messages.' }] },
            { text: 'The rest wait until the chat goes on. EventBase reads a window only once it is full, and the latest turn only once it settles.' },
        ]);
    });

    it('says nothing waits when every message is read, and never more read than the chat holds', () => {
        expect(syncUpToDateLines({ readCount: 40, messageCount: 40 })).toHaveLength(2);
        const lines = syncUpToDateLines({ readCount: 15, messageCount: 13 });
        expect(lines).toHaveLength(2);
        expect(lines[1].parts[1]).toEqual({ name: '13' });
    });

    it('gives no count when how far EventBase has read is not known', () => {
        expect(syncUpToDateLines({ readCount: null, messageCount: 13 })).toEqual([{ icon: 'fa-circle-check', text: 'This chat is up to date.' }]);
    });
});
