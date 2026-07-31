/**
 * checkSimilharityVersion — the cross-repo version floor warning.
 *
 * WHY THIS SUITE EXISTS: the check used to source the version from
 * `/api/plugins/similharity/version` and bail on `if (!response.ok) return;`.
 * That route only landed in the plugin on 2026-05-14, so every plugin older
 * than it 404'd and the check went SILENT — in exactly the case it was written
 * to catch. GitHub issue #11 burned hours on a plugin reporting v2.0.0-era
 * behaviour (well under the v3.3.1 floor) with nothing anywhere naming the
 * version.
 *
 * The version now comes from the /health probe checkPluginAvailable() already
 * makes, which has carried `version` since the plugin's first commit — so every
 * build ever shipped is covered, at no extra request. These tests pin that a
 * too-old plugin is always surfaced, and that "no plugin" stays silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../core/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../core/collection-loader.js', () => ({
    discoverExistingCollections: vi.fn(async () => []),
    pruneOrphanedEventBaseChatMaps: vi.fn(),
    checkPluginAvailable: vi.fn(async () => true),
    getDetectedPluginVersion: vi.fn(() => null),
}));

import { checkSimilharityVersion } from '../core/network-startup.js';
import { checkPluginAvailable, getDetectedPluginVersion } from '../core/collection-loader.js';
import { log } from '../core/log.js';

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
        // The reporter's plugin era reported 2.0.0. The floor has been 3.3.1 the
        // whole time; only the unreadable version stopped this from firing.
        getDetectedPluginVersion.mockReturnValue('2.0.0');

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toContain('2.0.0');
        expect(toastText()).toContain('3.3.1');
        expect(log.warn).toHaveBeenCalledTimes(1);
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
        for (const version of ['3.3.1', '3.3.4', '3.4.0', '4.0.0', '3.10.0']) {
            vi.clearAllMocks();
            checkPluginAvailable.mockResolvedValue(true);
            getDetectedPluginVersion.mockReturnValue(version);

            await checkSimilharityVersion();

            expect(globalThis.toastr.warning, `v${version} should not warn`).not.toHaveBeenCalled();
        }
    });

    it('compares numerically, not lexically — 3.10.0 is newer than 3.3.1', async () => {
        // String comparison would rank '3.10.0' < '3.3.1' and nag an up-to-date user.
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
