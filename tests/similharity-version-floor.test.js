/**
 * The Similharity version floor: `similharity_minimum_version` in manifest.json, the one place it is written, read by
 * the shared /health probe (src/shared/similharity-plugin.js), and the startup warning checkSimilharityVersion raises
 * from it (src/app/network-startup.js).
 *
 * The version comes from the /health probe, which every plugin build answers with its version; the /version route is
 * missing from older plugins, the very ones the warning is for. These tests pin that a too-old plugin is always
 * surfaced, that "no plugin" stays silent, and that the floor never drops below the first plugin that sends a
 * profile's key by its ID. Raising the floor is a manifest.json edit these tests follow without a change.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({
    log: { warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), trace: vi.fn(), lifecycle: vi.fn(), enabled: () => false },
}));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../src/features/collections/collection-loader.js', () => ({
    discoverExistingCollections: vi.fn(async () => []),
}));
vi.mock('../src/features/eventbase/eventbase-store.js', () => ({
    pruneOrphanedEventBaseChatMaps: vi.fn(),
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
import { resetPluginAvailableCache, similharityStanding, checkPluginAvailable } from '../src/shared/similharity-plugin.js';
import { log } from '../src/sillytavern/log.js';

const MANIFEST = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const FLOOR = MANIFEST.similharity_minimum_version;
const OLDER = (() => {
    const [major, minor, patch] = FLOOR.split('.').map(Number);
    return patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.99`;
})();

const plugin = vi.hoisted(() => ({ health: null }));

/** Concatenated text of every toastr.warning call, for substring assertions. */
function toastText() {
    return globalThis.toastr.warning.mock.calls.map(c => c.join(' ')).join('\n');
}

/** The requests other than the two the probe makes, /health and manifest.json. */
const otherRequests = () => globalThis.fetch.mock.calls.map(([url]) => String(url))
    .filter(url => url !== '/api/plugins/similharity/health' && !url.includes('manifest.json'));

beforeEach(() => {
    vi.clearAllMocks();
    resetPluginAvailableCache();
    plugin.health = { status: 'ok', version: FLOOR };
    globalThis.toastr = { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() };
    globalThis.fetch = vi.fn(async (url) => {
        if (String(url).includes('manifest.json')) return { ok: true, status: 200, json: async () => MANIFEST };
        if (url === '/api/plugins/similharity/health') {
            return plugin.health ? { ok: true, status: 200, json: async () => plugin.health } : { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error(`no other request should be made: ${url}`);
    });
});
afterEach(() => { delete globalThis.toastr; delete globalThis.fetch; });

describe('the floor in manifest.json', () => {
    it('is a version, and never older than 3.4.0, the first plugin that sends a llama.cpp, KoboldCPP or Custom profile\'s key by its ID', async () => {
        // Below 3.4.0 the plugin ignores the key ID on llama.cpp and SillyTavern sends its active key instead.
        expect(FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
        const parse = text => text.split('.').map(Number);
        const [major, minor] = parse(FLOOR);
        expect(major > 3 || (major === 3 && minor >= 4)).toBe(true);
    });

    it('is what the probe reads, beside the plugin it found', async () => {
        await checkPluginAvailable();
        expect(similharityStanding()).toEqual({ isFound: true, version: FLOOR, requiredVersion: FLOOR, isCurrent: true });
    });

    it('stands unread, and no plugin current, when manifest.json cannot be read', async () => {
        // A fresh session: the manifest and the floor are read once per session, and earlier tests read them.
        vi.resetModules();
        const fresh = await import('../src/shared/similharity-plugin.js');
        const { log: freshLog } = await import('../src/sillytavern/log.js');
        globalThis.fetch.mockImplementation(async url => (String(url).includes('manifest.json')
            ? { ok: false, status: 404, json: async () => ({}) }
            : { ok: true, status: 200, json: async () => plugin.health }));
        await fresh.checkPluginAvailable();
        expect(fresh.similharityStanding()).toMatchObject({ isFound: true, requiredVersion: null, isCurrent: false });
        expect(freshLog.error).toHaveBeenCalledWith(expect.stringContaining('could not read manifest.json'), expect.any(Error));
    });
});

describe('the probe', () => {
    it('lets no probe started before a reset write its result after it', async () => {
        let releaseFirst;
        let healthCalls = 0;
        globalThis.fetch.mockImplementation(async (url) => {
            if (String(url).includes('manifest.json')) return { ok: true, status: 200, json: async () => MANIFEST };
            healthCalls += 1;
            if (healthCalls === 1) {
                await new Promise((resolve) => { releaseFirst = resolve; });
                return { ok: true, status: 200, json: async () => ({ status: 'ok', version: '2.0.0' }) };
            }
            return { ok: true, status: 200, json: async () => ({ status: 'ok', version: FLOOR }) };
        });
        const stale = checkPluginAvailable();
        await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
        resetPluginAvailableCache();
        await checkPluginAvailable();
        releaseFirst();
        await stale;
        expect(similharityStanding()).toMatchObject({ version: FLOOR, isCurrent: true });
    });
});

describe('checkSimilharityVersion', () => {
    it('warns about a plugin far below the floor — the issue #11 case', async () => {
        // The reporter's plugin era reported 2.0.0; only the unreadable version stopped this from firing.
        plugin.health = { status: 'ok', version: '2.0.0' };

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toContain(`need v${FLOOR}+, got v2.0.0`);
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('warns on the version just below the floor', async () => {
        plugin.health = { status: 'ok', version: OLDER };

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toContain(`need v${FLOOR}+, got v${OLDER}`);
    });

    it('makes no HTTP request beyond the probe\'s — the version rides the /health probe', async () => {
        // Requesting /version is what created the blind spot; a plugin too old to
        // have that route is the one we most need to identify.
        plugin.health = { status: 'ok', version: '2.0.0' };

        await checkSimilharityVersion();

        expect(otherRequests()).toEqual([]);
    });

    it('tells the user how to fix it, including the ZIP-install trap', async () => {
        plugin.health = { status: 'ok', version: '3.0.0' };

        await checkSimilharityVersion();

        expect(toastText()).toContain('Restart SillyTavern');
        expect(toastText()).toMatch(/ZIP/i);
        expect(toastText()).toContain('git clone');
    });

    it('warns when the plugin answers without a version instead of assuming it is fine', async () => {
        plugin.health = { status: 'ok' };

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastText()).toMatch(/could not determine/i);
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('stays silent when no plugin is installed — a supported setup, not an error', async () => {
        plugin.health = null;

        await checkSimilharityVersion();

        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('stays silent on the exact floor and on newer builds', async () => {
        const [major, minor, patch] = FLOOR.split('.').map(Number);
        for (const version of [FLOOR, `${major}.${minor}.${patch + 1}`, `${major + 1}.0.0`, `${major}.${minor + 10}.0`]) {
            vi.clearAllMocks();
            resetPluginAvailableCache();
            plugin.health = { status: 'ok', version };

            await checkSimilharityVersion();

            expect(globalThis.toastr.warning, `v${version} should not warn`).not.toHaveBeenCalled();
        }
    });

    it('compares numerically, not lexically — 3.10.0 is newer than 3.4.0', async () => {
        // String comparison would rank '3.10.0' < '3.4.0' and nag an up-to-date user.
        const { isSimilharityVersionBehind } = await import('../src/shared/similharity-plugin.js');
        expect(isSimilharityVersionBehind('3.10.0', '3.4.0')).toBe(false);
        expect(isSimilharityVersionBehind('3.4.0', '3.10.0')).toBe(true);
    });

    it('logs, and does not throw, when the warning cannot be shown', async () => {
        delete globalThis.toastr;
        plugin.health = { status: 'ok', version: '2.0.0' };

        await expect(checkSimilharityVersion()).resolves.toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith('[VectFox] Could not show the Similharity version warning:', expect.any(Error));
    });
});
