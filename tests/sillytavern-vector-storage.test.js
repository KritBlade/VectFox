/**
 * SillyTavern's Vector Storage where LoreBase meets it (src/sillytavern/vector-storage.js, plan §5.9 of
 * InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md): its World Info search reads as on only
 * while the extension runs with Enabled for World Info, and turning it off goes through Vector Storage's own command,
 * leaving its chat search alone and saying whether the search is off afterwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn() } }));

const { log } = await import('../src/sillytavern/log.js');
const { isVectorStorageWorldInfoOn, turnOffVectorStorageWorldInfo } = await import('../src/sillytavern/vector-storage.js');

let extensionSettings;
const executeSlashCommandsWithOptions = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    extensionSettings = { disabledExtensions: [], vectors: { enabled_world_info: true, enabled_chats: true } };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings, executeSlashCommandsWithOptions }) };
    // What Vector Storage's own command does: its handler saves the checkbox's state to its settings.
    executeSlashCommandsWithOptions.mockImplementation(async command => {
        if (command === '/vector-worldinfo-state false') extensionSettings.vectors.enabled_world_info = false;
    });
});

describe("Vector Storage's World Info search", () => {
    it('reads as on only while Vector Storage runs with Enabled for World Info', () => {
        expect(isVectorStorageWorldInfoOn()).toBe(true);
        extensionSettings.vectors.enabled_world_info = false;
        expect(isVectorStorageWorldInfoOn()).toBe(false);

        extensionSettings.vectors.enabled_world_info = true;
        extensionSettings.disabledExtensions = ['vectors'];
        expect(isVectorStorageWorldInfoOn()).toBe(false);

        extensionSettings.disabledExtensions = [];
        delete extensionSettings.vectors;
        expect(isVectorStorageWorldInfoOn()).toBe(false);
    });

    it("turns off through Vector Storage's own command, leaving its chat search on", async () => {
        expect(await turnOffVectorStorageWorldInfo()).toBe(true);
        expect(executeSlashCommandsWithOptions).toHaveBeenCalledWith('/vector-worldinfo-state false');
        expect(extensionSettings.vectors).toEqual({ enabled_world_info: false, enabled_chats: true });
    });

    it('says the search is still on, with a warning, when the command fails', async () => {
        const failure = new Error('Unknown command');
        executeSlashCommandsWithOptions.mockRejectedValueOnce(failure);
        expect(await turnOffVectorStorageWorldInfo()).toBe(false);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be turned off'), failure);
    });
});
