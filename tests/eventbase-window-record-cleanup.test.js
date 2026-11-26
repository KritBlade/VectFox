/**
 * The one-time cleanup of EventBase's window records (src/app/eventbase-window-record-cleanup.js, §3.6 of
 * InternalProject/Vectfox/plans/eventbase-window-record.md): every EventBase and archive collection on the backend in
 * use whose record lists windows has its events loaded, which trims it; the flag is set once each one read or came back
 * without payload, and not while any listing failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const host = vi.hoisted(() => ({ registry: [], progress: {}, answers: {} }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, getContext: vi.fn(() => ({})) }));
vi.mock('../../../../../script.js', () => ({ characters: [], saveSettingsDebounced: vi.fn(), getRequestHeaders: vi.fn(() => ({})), getCurrentChatId: vi.fn(() => null) }));
vi.mock('../src/features/collections/index.js', () => ({ getCollectionRegistry: () => host.registry }));
vi.mock('../src/features/eventbase/index.js', () => ({
    readEventBaseProgress: registryKey => host.progress[registryKey] ?? {},
    loadEventWindows: vi.fn(async (registryKey) => {
        const answer = host.answers[registryKey] ?? { isRead: true };
        // Loading trims the record to the windows the events do not show.
        if (answer.isRead && host.progress[registryKey]?.extractedWindows) host.progress[registryKey].extractedWindows = answer.keptWindows ?? [];
        return answer;
    }),
}));
vi.mock('../src/sillytavern/settings.js', () => ({ saveSettingsDebounced: vi.fn() }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { lifecycle: vi.fn(), warn: vi.fn() } }));

const { trimEventBaseWindowRecords } = await import('../src/app/eventbase-window-record-cleanup.js');
const { loadEventWindows } = await import('../src/features/eventbase/index.js');
const { saveSettingsDebounced } = await import('../src/sillytavern/settings.js');

const EVENTBASE = 'qdrant:vf_eventbase_qdrant_wren_keeper_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ARCHIVE = 'qdrant:vf_archiveevent_qdrant_wren_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NO_WINDOWS = 'qdrant:vf_eventbase_qdrant_wren_keeper_cccccccc-3333-4333-8333-cccccccccccc';
const OTHER_BACKEND = 'vectra:vf_eventbase_standard_wren_keeper_dddddddd-4444-4444-8444-dddddddddddd';
const LOREBOOK = 'qdrant:vf_lorebase_harbor_book';

beforeEach(() => {
    vi.clearAllMocks();
    host.registry = [EVENTBASE, ARCHIVE, NO_WINDOWS, OTHER_BACKEND, LOREBOOK];
    host.progress = {
        [EVENTBASE]: { extractedWindows: ['1,2', '3,4'] },
        [ARCHIVE]: { extractedWindows: ['5,6'] },
        [NO_WINDOWS]: { vectorizationTip: 40 },
        [OTHER_BACKEND]: { extractedWindows: ['7,8'] },
        [LOREBOOK]: { extractedWindows: ['9,10'] },
    };
    host.answers = { [EVENTBASE]: { isRead: true, keptWindows: ['3,4'] }, [ARCHIVE]: { isRead: true, keptWindows: ['5,6'] } };
});

describe('the window record cleanup', () => {
    it('loads every EventBase and archive collection on the backend in use whose record lists windows, and sets the flag', async () => {
        const settings = { vector_backend: 'qdrant' };

        expect(await trimEventBaseWindowRecords(settings)).toEqual({ trimmedCount: 1, failedCount: 0, collectionCount: 2 });

        expect(loadEventWindows.mock.calls.map(([registryKey]) => registryKey)).toEqual([EVENTBASE, ARCHIVE]);
        expect(settings.eventbase_window_records_trimmed).toBe(true);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('counts a collection whose events came back without payload as done, as no later start changes it', async () => {
        host.answers[ARCHIVE] = { isRead: false, problem: 'its events came back without their payload', isWithoutPayload: true };
        const settings = { vector_backend: 'qdrant' };

        expect((await trimEventBaseWindowRecords(settings)).failedCount).toBe(0);
        expect(settings.eventbase_window_records_trimmed).toBe(true);
    });

    it('leaves the flag unset while any listing failed, so the next start tries again', async () => {
        host.answers[ARCHIVE] = { isRead: false, problem: 'Qdrant is not answering' };
        const settings = { vector_backend: 'qdrant' };

        expect(await trimEventBaseWindowRecords(settings)).toEqual({ trimmedCount: 1, failedCount: 1, collectionCount: 2 });
        expect(settings.eventbase_window_records_trimmed).toBeUndefined();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('does nothing once the flag is set', async () => {
        expect(await trimEventBaseWindowRecords({ vector_backend: 'qdrant', eventbase_window_records_trimmed: true })).toBeNull();
        expect(loadEventWindows).not.toHaveBeenCalled();
    });

    it('reads the Standard backend\'s collections when Standard is in use', async () => {
        await trimEventBaseWindowRecords({ vector_backend: 'standard' });

        expect(loadEventWindows.mock.calls.map(([registryKey]) => registryKey)).toEqual([OTHER_BACKEND]);
    });
});
