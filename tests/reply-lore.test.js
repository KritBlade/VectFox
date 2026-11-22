/**
 * @vitest-environment jsdom
 *
 * The lore of the latest reply (src/features/reply-lore/reply-lore.js), for the wand menu's Last reply's lore: only a
 * reply's World Info scan counts, never a quiet or dry generation's, and only a reply's scan has its lines read; a
 * reply whose scan activates nothing lists none; a chat change clears the list; and the dialog says why there is no
 * list, or lists the entries by book, LoreBase's picks in blue (the accent) with Jev's chance, and SillyTavern's own in
 * green with the keyword or rule that fired them and a loop pill after the first loop, or no line when nothing was
 * read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ listeners: {}, carried: new Map(), activations: new Map() }));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: { on: vi.fn((event, listener) => { (host.listeners[event] ??= []).push(listener); }) },
    event_types: {
        GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', WORLD_INFO_ACTIVATED: 'world_info_activated',
        GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped', CHAT_CHANGED: 'chat_id_changed',
    },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../src/sillytavern/popup.js', () => ({ noticePopup: vi.fn(async () => {}) }));
vi.mock('../src/sillytavern/world-info-activations.js', () => ({
    activationOf: entry => host.activations.get(`${entry.world}.${entry.uid}`) ?? null,
    startReadingActivations: vi.fn(),
    stopReadingActivations: vi.fn(),
}));
vi.mock('../src/features/lorebase/index.js', () => ({
    entryTitle: entry => entry.comment || `entry ${entry.uid}`,
    isReplyGeneration: (type, lastGeneration) => ['normal', 'swipe', 'regenerate', 'continue'].includes(type)
        || (type === 'quiet' && lastGeneration?.isQuietToLoud === true),
    loreBasePicksCarriedBy: entry => host.carried.get(`${entry.world}.${entry.uid}`) ?? null,
}));

const { noticePopup } = await import('../src/sillytavern/popup.js');
const { startReadingActivations, stopReadingActivations } = await import('../src/sillytavern/world-info-activations.js');
const { initializeReplyLore, openReplyLore } = await import('../src/features/reply-lore/reply-lore.js');

initializeReplyLore();

const emit = (event, ...args) => host.listeners[event]?.forEach(listener => listener(...args));
const startGeneration = (type, options = {}, isDryRun = false) => emit('GENERATION_AFTER_COMMANDS', type, options, isDryRun);
const activate = entries => emit('world_info_activated', entries);
const shown = async () => {
    noticePopup.mockClear();
    await openReplyLore();
    const [lines, { body }] = noticePopup.mock.calls[0];
    return {
        text: lines.map(line => line.text).join(' '),
        rows: body ? [...body.querySelectorAll('.vfx-row')].map(row => `${row.querySelector('.vfx-row-name').textContent} [${row.querySelector('.vfx-pill').className}]`) : [],
        books: body ? [...body.querySelectorAll('.vfx-group-title')].map(title => title.textContent.trim()) : [],
        details: body ? [...body.querySelectorAll('.vfx-row')].map(row => [
            row.querySelector('.vfx-row-name').textContent,
            [...row.querySelectorAll('.vfx-row-sub')].map(sub => sub.textContent).join(' / '),
            [...row.querySelectorAll('.vfx-pill')].map(pill => pill.textContent).join(', '),
        ].join(' | ')) : [],
    };
};

const SCAN = [
    { world: 'Harbor Atlas', uid: 0, comment: 'Lighthouse of Vell' },
    { world: 'Tide Tables', uid: 3, comment: 'Spring tides' },
];

beforeEach(() => {
    emit('chat_id_changed');
    vi.clearAllMocks();
    host.carried = new Map([['Harbor Atlas.0', [{ bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', isWhole: true }]]]);
    host.activations = new Map();
});

describe('the latest reply', () => {
    it('says there is no reply yet before one in this chat', async () => {
        expect((await shown()).text).toContain('No reply in this chat since the page loaded.');
    });

    it("lists a reply's entries by book, LoreBase's picks in blue and SillyTavern's own in green, with how many each chose", async () => {
        startGeneration('normal');
        activate(SCAN);
        const { text, rows, books } = await shown();
        expect(text).toContain('1 entry picked by LoreBase, in blue, and 1 entry by SillyTavern\'s own World Info, in green.');
        expect(books).toEqual(['Harbor Atlas', 'Tide Tables']);
        expect(rows).toEqual(['Lighthouse of Vell [vfx-pill is-accent]', 'Spring tides [vfx-pill is-success]']);
    });

    it("leaves the list to a quiet or dry generation's scan, but counts a quiet-to-loud one", async () => {
        startGeneration('swipe');
        activate(SCAN);
        startGeneration('quiet');
        activate([{ world: 'Notes', uid: 9, comment: 'Background' }]);
        startGeneration('normal', {}, true);
        activate([{ world: 'Notes', uid: 9, comment: 'Background' }]);
        expect((await shown()).rows).toHaveLength(2);

        startGeneration('quiet', { quietToLoud: true });
        activate([{ world: 'Notes', uid: 9, comment: 'Loud' }]);
        expect((await shown()).rows).toEqual(['Loud [vfx-pill is-success]']);
    });

    it('lists no entry for a reply whose scan activated none, and counts no scan after its generation ended', async () => {
        startGeneration('normal');
        activate(SCAN);
        startGeneration('regenerate');
        emit('generation_ended');
        activate(SCAN);
        expect((await shown()).text).toBe("The latest reply's prompt held no lorebook entry.");
    });

    it("reads the scan's lines from a reply's start to its scan, never for a quiet one", () => {
        startGeneration('quiet');
        expect(startReadingActivations).not.toHaveBeenCalled();
        expect(stopReadingActivations).toHaveBeenCalledTimes(1);
        startGeneration('normal');
        expect(startReadingActivations).toHaveBeenCalledTimes(1);
        expect(stopReadingActivations).toHaveBeenCalledTimes(1);
        activate(SCAN);
        expect(stopReadingActivations).toHaveBeenCalledTimes(2);
    });

    it("shows what brought each entry in: Jev's chance or High Accuracy's parts, SillyTavern's keyword, keywords and logic, or rule, and the loop after the first", async () => {
        host.carried = new Map([['Harbor Atlas.0', [
            { bookName: 'Harbor Atlas', uid: 0, title: 'Lighthouse of Vell', isWhole: true, jevChance: 0.823 },
            { bookName: 'Harbor Atlas', uid: 5, title: 'Lantern Room', isWhole: false, jevChance: null },
        ]]]);
        host.activations = new Map([
            ['Tide Tables.3', { primaryKey: ' spring tide ', loop: 1 }],
            ['Tide Tables.4', { primaryKey: 'neap', logic: 'AND ANY', secondaryKeys: ['moon', 'quarter'], loop: 2 }],
            ['Notes.9', { reason: 'constant', loop: 1 }],
            ['Notes.11', { loop: 3 }],
        ]);
        startGeneration('normal');
        activate([
            { world: 'Harbor Atlas', uid: 0 },
            { world: 'Tide Tables', uid: 3, comment: 'Spring tides' },
            { world: 'Tide Tables', uid: 4, comment: 'Neap tides' },
            { world: 'Notes', uid: 9, comment: 'Background' },
            { world: 'Notes', uid: 10, comment: 'Nothing read' },
            { world: 'Notes', uid: 11, comment: 'Loop only' },
        ]);
        expect((await shown()).details).toEqual([
            "Lighthouse of Vell | Jev's chance: 82% | LoreBase",
            'Lantern Room | Only the parts the reply needed | LoreBase',
            'Spring tides | Keyword: spring tide | SillyTavern',
            'Neap tides | Keywords: neap AND ANY moon, quarter | SillyTavern, Loop 2',
            'Background | Constant | SillyTavern',
            'Nothing read |  | SillyTavern',
            'Loop only |  | SillyTavern, Loop 3',
        ]);
    });

    it('clears the list when the chat changes', async () => {
        startGeneration('normal');
        activate(SCAN);
        emit('chat_id_changed');
        expect((await shown()).rows).toEqual([]);
        expect((await shown()).text).toContain('No reply in this chat since the page loaded.');
    });
});
