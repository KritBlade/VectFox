/**
 * checkSimilharityVersion — the cross-repo version floor warning.
 *
 * The version comes from the /health probe checkPluginAvailable() already makes,
 * which every plugin build answers with its version; the /version route is missing
 * from older plugins, the very ones the warning is for. These tests pin that a
 * too-old plugin is always surfaced, and that "no plugin" stays silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../src/features/collections/collection-loader.js', () => ({
    discoverExistingCollections: vi.fn(async () => []),
}));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    pruneOrphanedEventBaseChatMaps: vi.fn(),
}));
// The probe is stubbed; the floor and the comparison are the module's own.
vi.mock('../src/shared/similharity-plugin.js', async importOriginal => ({
    ...(await importOriginal()),
    checkPluginAvailable: vi.fn(async () => true),
    getDetectedPluginVersion: vi.fn(() => null),
}));

// SillyTavern modules the feature barrels reach; nothing this test runs uses them. SECRET_KEYS is
// read when embedding/providers.js loads.
vi.mock('../../../../extensions.js', () => ({}));
vi.mock('../../../../../script.js', () => ({}));
vi.mock('../../../../openai.js', () => ({}));
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({}));
vi.mock('../../../../utils.js', () => ({}));
vi.mock('../../../../world-info.js', () => ({}));
vi.mock('../../../../popup.js', () => ({}));

import { checkSimilharityVersion } from '../src/app/network-startup.js';
import { checkPluginAvailable, getDetectedPluginVersion } from '../src/shared/similharity-plugin.js';
import { log } from '../src/sillytavern/log.js';

/** Concatenated text of every toastr.warning call, for substring assertions. */
function toastText() {
    return globalThis.toastr.warning.mock.calls.map(c => c.join(' ')).join('\n');
}

beforeEach(() => {
    vi.clearAllMocks();
    globalThis.toastr = { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() };
    globalThis.fetch = vi.fn(async () => { throw new Error('no HTTP request should be made'); });
    checkPluginAvailable.mockResolvedValue(true);
});
afterEach(() => { delete globalThis.toastr; delete globalThis.fetch; });

describe('checkSimilharityVersion', () => {
    it('warns about a plugin far below the floor — the issue #11 case', async () => {
        // The reporter's plugin era reported 2.0.0; only the unreadable version stopped this from firing.
        getDetectedPluginVersion.mockReturnValue('2.0.0');

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toContain('2.0.0');
        expect(toastText()).toContain('3.4.0');
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('warns on 3.3.4, the last plugin that deletes data on a vector size change', async () => {
        getDetectedPluginVersion.mockReturnValue('3.3.4');

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toContain('3.4.0');
    });

    it('warns on 3.3.5, the last plugin that cannot embed on a llama.cpp, KoboldCPP or Custom profile', async () => {
        getDetectedPluginVersion.mockReturnValue('3.3.5');

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toContain('need v3.4.0+, got v3.3.5');
    });

    it('makes no HTTP request of its own — the version rides the /health probe', async () => {
        // Requesting /version is what created the blind spot; a plugin too old to
        // have that route is the one we most need to identify.
        getDetectedPluginVersion.mockReturnValue('2.0.0');

        await checkSimilharityVersion();

        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('tells the user how to fix it, including the ZIP-install trap', async () => {
        getDetectedPluginVersion.mockReturnValue('3.0.0');

        await checkSimilharityVersion();

        expect(toastText()).toContain('Restart SillyTavern');
        expect(toastText()).toMatch(/ZIP/i);
        expect(toastText()).toContain('git clone');
    });

    it('warns when the plugin answers without a version instead of assuming it is fine', async () => {
        getDetectedPluginVersion.mockReturnValue(null);

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toMatch(/could not determine/i);
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('stays silent when no plugin is installed — a supported setup, not an error', async () => {
        checkPluginAvailable.mockResolvedValue(false);
        getDetectedPluginVersion.mockReturnValue(null);

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('stays silent on the exact floor and on newer builds', async () => {
        for (const version of ['3.4.0', '3.4.1', '4.0.0', '3.10.0']) {
            vi.clearAllMocks();
            checkPluginAvailable.mockResolvedValue(true);
            getDetectedPluginVersion.mockReturnValue(version);

            await checkSimilharityVersion();

            expect(globalThis.toastr.warning, `v${version} should not warn`).not.toHaveBeenCalled();
        }
    });

    it('compares numerically, not lexically — 3.10.0 is newer than 3.4.0', async () => {
        // String comparison would rank '3.10.0' < '3.4.0' and nag an up-to-date user.
        getDetectedPluginVersion.mockReturnValue('3.10.0');

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('survives a missing toastr (headless) after logging', async () => {
        delete globalThis.toastr;
        getDetectedPluginVersion.mockReturnValue('2.0.0');

        await expect(checkSimilharityVersion()).resolves.toBeUndefined();
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});
