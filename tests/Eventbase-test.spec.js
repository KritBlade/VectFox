/**
 * Eventbase-test.spec.js — Playwright integration tests for VectFox
 *
 * Run all:      npm run test:e2e
 * Run one:      npx playwright test --grep "TEST 002"
 * View report:  npm run test:e2e:report
 *
 * On first run: a Playwright browser window opens. Log in, then open the chat
 * that has your locked collections. Tests start automatically once the chat is open.
 *
 * Install Playwright once:
 *   npm install -D @playwright/test
 *   npx playwright install
 * 
 * # Run all tests
npm run test:e2e
npm run test:e2e:no-log
npm run test:e2e -- --grep "TEST 008"
npm run test:e2e -- --grep "TEST 00[6-9]|TEST 01[23]"
--grep "TEST 008|TEST 009" (regex, run multiple)
--grep "TEST 008" --debug (Playwright inspector)
--grep-invert "TEST 00[2-7]" (everything except 2-7)
--grep "TEST 00[2-7]" (only 2-7)


# Run a specific test
npx playwright test --grep "TEST 002"
npm run test:e2e -- --grep "TEST 00[6-9]|TEST 01[23]"


# View HTML report after a run
npm run test:e2e:report
 */

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// SillyTavern target URL — override here for quick A/B testing across machines
// ---------------------------------------------------------------------------
//
// Set TEST_TARGET_URL to point the suite at a different ST instance for one
// run. Leave it as `null` to fall back to the default chain:
//   1. `process.env.SILLYTAVERN_URL` if set, otherwise
//   2. `baseURL` in playwright.config.js
//
// Examples:
//   const TEST_TARGET_URL = 'http://192.168.1.50:8000';   // LAN box
//   const TEST_TARGET_URL = 'http://localhost:8000';      // local ST
//   const TEST_TARGET_URL = null;                          // use config/env
//
// This override only affects THIS test file — it doesn't mutate the config
// for any other suite.
// ---------------------------------------------------------------------------
//const TEST_TARGET_URL = null;
const TEST_TARGET_URL = 'http://localhost:8000';

if (TEST_TARGET_URL) {
    test.use({ baseURL: TEST_TARGET_URL });
    console.log(`[setup] Eventbase-test.spec.js: baseURL overridden → ${TEST_TARGET_URL}`);
}

// ---------------------------------------------------------------------------
// serial mode — one browser window, shared across all tests
// ---------------------------------------------------------------------------
test.describe.configure({ mode: 'serial' });

let sharedPage;
let sharedContext;

const AUTH_FILE = '.playwright-auth.json';

// The folder SillyTavern serves VectFox from, and every VectFox file the page requested but could not load
// (HTTP 400 and up, or a network failure other than a cancelled request), recorded from the first navigation on.
// TEST 000 asserts it is empty.
const VECTFOX_SERVED_PATH = '/scripts/extensions/third-party/VectFox/';
const vectfoxLoadFailures = [];

function watchVectFoxLoads(page) {
    page.on('response', (response) => {
        if (response.url().includes(VECTFOX_SERVED_PATH) && response.status() >= 400) {
            vectfoxLoadFailures.push(`${response.status()} ${response.url()}`);
        }
    });
    page.on('requestfailed', (request) => {
        const errorText = request.failure()?.errorText ?? 'request failed';
        // EXPECTED: net::ERR_ABORTED is a request the browser cancelled, such as one still loading when setup
        // reloads the page. A missing file arrives as an HTTP status, which the response handler records.
        if (request.url().includes(VECTFOX_SERVED_PATH) && errorText !== 'net::ERR_ABORTED') {
            vectfoxLoadFailures.push(`${errorText} ${request.url()}`);
        }
    });
}

/** Every file under src/ in this repo, as a path relative to the repo root. */
function shippedFiles(folder = 'src') {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return readdirSync(path.join(repoRoot, folder)).flatMap((name) => {
        const relative = `${folder}/${name}`;
        return statSync(path.join(repoRoot, relative)).isDirectory() ? shippedFiles(relative) : [relative];
    });
}

test.beforeAll(async ({ browser }) => {
    // Reuse saved cookies/localStorage from the last run so login is skipped
    sharedContext = await browser.newContext({
        storageState: existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    });
    sharedPage = await sharedContext.newPage();
    watchVectFoxLoads(sharedPage);

    // Force-disable HTTP cache via Chrome DevTools Protocol BEFORE the first
    // navigation. Without this, the browser will happily reuse a cached copy
    // of VectFox's JS files across test runs, masking code changes — leading
    // to "the fix is on disk but the test still sees the old behavior".
    try {
        const cdp = await sharedContext.newCDPSession(sharedPage);
        await cdp.send('Network.clearBrowserCache');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        console.log('[setup] HTTP cache cleared and disabled (CDP)');
    } catch (err) {
        console.warn(`[setup] CDP cache disable failed (non-Chromium?): ${err.message}`);
    }

    // First navigation: load the page so we can access window APIs. ST may register
    // a service worker that caches JS files — survives HTTP cache busting because
    // it serves from its own Cache Storage. Unregister it and wipe Cache Storage,
    // then reload so the page comes up SW-free with fresh JS.
    await sharedPage.goto('/');
    try {
        const swWiped = await sharedPage.evaluate(async () => {
            const result = { regsBefore: 0, regsAfter: 0, cacheKeys: [] };
            if (navigator.serviceWorker) {
                const regs = await navigator.serviceWorker.getRegistrations();
                result.regsBefore = regs.length;
                await Promise.all(regs.map(r => r.unregister()));
                result.regsAfter = (await navigator.serviceWorker.getRegistrations()).length;
            }
            if (typeof caches !== 'undefined') {
                result.cacheKeys = await caches.keys();
                await Promise.all(result.cacheKeys.map(k => caches.delete(k)));
            }
            return result;
        });
        console.log(`[setup] Service workers: ${swWiped.regsBefore} → ${swWiped.regsAfter}, Cache Storage cleared: ${swWiped.cacheKeys.length} key(s)`);
        if (swWiped.regsBefore || swWiped.cacheKeys.length) {
            console.log('[setup] Reloading page so fresh JS (no SW) is fetched...');
            await sharedPage.reload({ waitUntil: 'load' });
        }
    } catch (err) {
        console.warn(`[setup] Service worker / Cache Storage wipe failed: ${err.message}`);
    }

    // Show a banner in the Playwright window so the user knows what to do
    await sharedPage.waitForSelector('body');
    await sharedPage.evaluate(() => {
        const el = document.createElement('div');
        el.id = '__vf_test_hint';
        el.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
            'background:#1a1a2e', 'color:#eee', 'padding:14px 20px',
            'font:15px/1.5 sans-serif', 'text-align:center',
            'box-shadow:0 2px 8px rgba(0,0,0,0.6)',
        ].join(';');
        el.innerHTML = '🧪 <b>VectFox Tests</b> — log in (if needed), then open the chat that has your locked collections. Tests start automatically once the chat is open.';
        document.body.prepend(el);
    }).catch(() => {});

    console.log('[setup] Log in (if needed) and open the correct chat in the Playwright browser window...');

    // Wait for ST's send button — present once logged in and on the main page
    await sharedPage.waitForSelector('#send_but', { timeout: 120000 });

    // Wait until a chat is actually open. Strictly gate on ctx.chatId — the
    // previous DOM-presence fallback (#chat .mes count > 0) could trigger on
    // stale UI from a previous session even when the user hadn't focused the
    // Playwright window and clicked into a chat yet. Tests downstream all
    // strictly check ctx.chatId, so beforeAll must match that contract or
    // tests start before they should and fail mysteriously with "No active
    // chat — open a chat first."
    console.log('[setup] Waiting for chat to become active (focus the Playwright window and click a chat)...');
    await sharedPage.waitForFunction(
        () => {
            const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? null;
            return !!ctx?.chatId;
        },
        { timeout: 120000 }
    );

    // Save cookies + localStorage so the next run skips login
    await sharedContext.storageState({ path: AUTH_FILE });
    console.log(`[setup] Auth state saved → ${AUTH_FILE}`);

    // Let VectFox and other extensions finish initialising
    await sharedPage.waitForTimeout(2000);

    // Pre-test cleanup: remove leftover *playwright_test* collections from
    // previous (possibly interrupted) runs.
    //
    // Match pattern: case-insensitive `playwright_test` substring on EITHER
    // the collectionId or the registryKey. It catches:
    //   • IDs with or without the leading double-underscore
    //     (`__vf_playwright_test_…`, `playwright_test_…`)
    //   • Registry-key-only orphans whose collectionId has been stripped
    //   • Any test naming convention as long as it includes the
    //     unambiguous `playwright_test` marker
    // The marker is unique enough that a real user collection would never
    // contain it accidentally.
    const cleanupReport = await sharedPage.evaluate(async () => {
        const base = '/scripts/extensions/third-party/VectFox/';
        const { deleteCollectionWhereDiscovered, getCollectionListing } = await import(base + 'src/features/collections/collection-loader.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { saveSettingsDebounced } = await import('/script.js');
        const vf = extension_settings?.vectfox;
        if (!vf) return { leftover: [], indexOrphans: 0, indexChatsScanned: 0 };

        const listing = getCollectionListing(vf);
        const leftover = [];
        const isTestMarker = (s) => typeof s === 'string' && s.toLowerCase().includes('playwright_test');

        for (const e of listing) {
            const cid = e.collectionId || '';
            const rk  = e.registryKey  || '';
            if (isTestMarker(cid) || isTestMarker(rk)) leftover.push({ cid, rk, backend: e.backend || null });
        }

        // Full cleanup for leftover test data only. deleteCollectionWhereDiscovered deletes each one as the
        // Database Browser does: its vectors on the backend and in every index discovery found it in, then its
        // registry entry and metadata under both key forms (registry key and bare ID). It logs a failure itself.
        // Real user collections are never touched.
        for (const entry of leftover) {
            entry.isDeleted = await deleteCollectionWhereDiscovered(
                { registryKey: entry.rk, collectionId: entry.cid, backend: entry.backend }, vf, 'e2e cleanup');
        }

        // ─── chat_lock_index orphan sweep ────────────────────────────────
        //
        // The registry pass above catches collections still in
        // `vf.vectfox_collection_registry`. The per-chat reverse map
        // `vf.chat_lock_index[chatId] = [registryKey, …]` is kept separately:
        // a test collection locked to a chat (setCollectionLock) can leave
        // its entry there after its registry entry is gone.
        //
        // Functionally harmless (lookups go forward via meta.lockedToChatIds,
        // not reverse) but it grows unbounded. Sweeping it here keeps one
        // place to maintain and covers any test that forgets removeCollectionLock.
        //
        // Production user data is never touched — we only filter entries
        // whose registryKey contains the unmistakable `playwright_test`
        // substring. A real user collection name would never include it.
        let indexOrphans = 0;
        let indexChatsScanned = 0;
        const idx = vf.chat_lock_index;
        if (idx && typeof idx === 'object') {
            for (const chatId of Object.keys(idx)) {
                const arr = idx[chatId];
                if (!Array.isArray(arr) || arr.length === 0) continue;
                indexChatsScanned++;
                const kept = arr.filter(rk => !isTestMarker(rk));
                if (kept.length !== arr.length) {
                    indexOrphans += (arr.length - kept.length);
                    if (kept.length === 0) {
                        delete idx[chatId];
                    } else {
                        idx[chatId] = kept;
                    }
                }
            }
            if (indexOrphans > 0) {
                saveSettingsDebounced();
            }
        }

        return { leftover, indexOrphans, indexChatsScanned };
    });

    if (cleanupReport.leftover.length) {
        const deletedCount = cleanupReport.leftover.filter(e => e.isDeleted).length;
        console.log(`[setup] Deleted ${deletedCount} of ${cleanupReport.leftover.length} leftover test collection(s):`);
        cleanupReport.leftover.forEach(e => console.log(`  ${e.cid}${e.isDeleted ? '' : ' (not fully deleted: VectFox logs why in the browser console)'}`));
    } else {
        console.log('[setup] Nothing to clean up ✓');
    }

    if (cleanupReport.indexOrphans > 0) {
        console.log(`[setup] Pruned ${cleanupReport.indexOrphans} stale playwright_test entries from chat_lock_index across ${cleanupReport.indexChatsScanned} chat(s)`);
    }

    console.log('[setup] Chat open — running tests ✓');
});

test.afterAll(async () => {
    await sharedContext?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runTestInPage(testFn, arg) {
    const logs = [];
    const handler = msg => logs.push({ type: msg.type(), text: msg.text() });
    sharedPage.on('console', handler);
    try {
        await sharedPage.evaluate(testFn, arg);
    } catch (err) {
        logs.push({ type: 'error', text: `page.evaluate threw: ${err.message}` });
    }
    sharedPage.off('console', handler);
    return logs;
}

function assertPassed(logs) {
    const failLines = logs.filter(m => m.text.includes('[FAIL]')).map(m => m.text);
    const warnLines = logs.filter(m => m.text.includes('[WARN]')).map(m => m.text);
    const skipLines = logs.filter(m => m.text.includes('[SKIP]')).map(m => m.text);
    const passed    = logs.some(m => m.text.includes('[PASS]'));

    logs.forEach(m => {
        if      (m.type === 'error')   console.error(m.text);
        else if (m.type === 'warning') console.warn(m.text);
        else                           console.log(m.text);
    });

    if (warnLines.length) console.warn('WARNINGS:\n' + warnLines.join('\n'));

    // [SKIP] is a soft-pass: the test couldn't run because a prerequisite
    // wasn't met (no plugin, no qdrant config, wrong backend, etc.). In
    // serial-mode suites this is critical — a hard FAIL halts every
    // subsequent test, so a no-plugin user running the full suite would be
    // stuck at the first qdrant test and never reach the standard-backend tests that
    // DO work on their machine. SKIP keeps the suite moving.
    //
    // Precedence: SKIP wins over the PASS-required check, so a test that
    // skipped without emitting [FAIL] is treated as cleanly bypassed.
    // SKIP does NOT override [FAIL] — a test that emits both is still a
    // hard failure (someone should fix the test or the environment).
    expect(failLines.length, '[FAIL] found:\n' + failLines.join('\n')).toBe(0);
    if (skipLines.length) {
        console.warn('SKIPPED:\n' + skipLines.join('\n'));
        return;
    }
    expect(passed, 'No [PASS] found — test did not reach success path').toBe(true);
}

// ---------------------------------------------------------------------------
// Environment probes — used by soft-skip helpers below
// ---------------------------------------------------------------------------
//
// These probes run at the spec level (outside runTestInPage) so we can call
// `test.skip(...)` cleanly before the test body executes. Skipping at this
// layer marks the test as ⏭️ skipped in the Playwright report instead of as
// failed — critical for serial-mode suites, where a hard FAIL halts every
// subsequent test. Without soft-skip, a no-plugin user running the full
// suite gets stuck at the first qdrant test (TEST 002) and never reaches TEST 009 (the test that
// specifically validates their environment).

let _pluginAvailableCache = null;
async function isSimilharityPluginAvailable() {
    if (_pluginAvailableCache !== null) return _pluginAvailableCache;
    try {
        const probe = await sharedPage.evaluate(async () => {
            try {
                // Hit the plugin's `/health` endpoint — a real route the
                // plugin registers (similharity/index.js:526) that returns
                // `{ status: 'ok', plugin, version, backends: [...] }`.
                const resp = await fetch('/api/plugins/similharity/health', { method: 'GET' });
                const status = resp.status;
                const ct = resp.headers.get('content-type') || '';
                if (!resp.ok) return { ok: false, status, contentType: ct, body: null };
                const data = await resp.json().catch(() => null);
                return { ok: data?.status === 'ok', status, contentType: ct, body: data };
            } catch (e) { return { ok: false, error: e.message }; }
        });
        _pluginAvailableCache = !!probe?.ok;
        console.log(`[probe] plugin: status=${probe.status ?? 'n/a'}, available=${_pluginAvailableCache}, body=${JSON.stringify(probe.body)}${probe.error ? `, error=${probe.error}` : ''}`);
    } catch (e) {
        _pluginAvailableCache = false;
        console.log(`[probe] plugin: probe threw at page-eval level: ${e.message}`);
    }
    return !!_pluginAvailableCache;
}

let _qdrantConfigCache = null;
async function hasQdrantConfig() {
    if (_qdrantConfigCache !== null) return _qdrantConfigCache;
    try {
        const result = await sharedPage.evaluate(async () => {
            const { extension_settings } = await import('/scripts/extensions.js');
            const vf = extension_settings?.vectfox;
            return {
                hasConfig: !!(vf?.qdrant_url || vf?.qdrant_host),
                qdrant_url: vf?.qdrant_url || null,
                qdrant_host: vf?.qdrant_host || null,
                qdrant_port: vf?.qdrant_port || null,
                qdrant_use_cloud: vf?.qdrant_use_cloud || false,
            };
        });
        console.log(`[probe] qdrant config: hasConfig=${result.hasConfig}, url=${result.qdrant_url || '(unset)'}, host=${result.qdrant_host || '(unset)'}, port=${result.qdrant_port || '(default 6333)'}, useCloud=${result.qdrant_use_cloud}`);
        _qdrantConfigCache = result.hasConfig;
    } catch (e) {
        console.log(`[probe] qdrant config: probe threw: ${e.message}`);
        _qdrantConfigCache = false;
    }
    return !!_qdrantConfigCache;
}

/**
 * Probe whether qdrant is actually reachable. Sends the user's qdrant
 * config (URL/host/port from VectFox settings) to the plugin's
 * `/backend/init/qdrant` route — this is the same init flow QdrantBackend
 * uses on every fresh page load. If init succeeds, qdrant is reachable.
 * If it fails (qdrant server down, wrong port, container not running),
 * the test caller treats this as "user has config but isn't actively
 * using qdrant" and skips with a WARNING — not a hard failure.
 *
 * Why not just let the test fail loudly when qdrant is down? Because
 * users in case 2 (plugin installed, qdrant config present but not used)
 * shouldn't see test FAILURES when they don't even care about qdrant.
 * A common scenario: user set up qdrant once, took it down, kept the
 * config in VectFox settings. They're now a pure standard-backend user.
 * Hard-failing on qdrant tests would be confusing UX.
 *
 * Cached per page like the plugin probe.
 */
let _qdrantReachableCache = null;
async function isQdrantReachable() {
    if (_qdrantReachableCache !== null) return _qdrantReachableCache;
    try {
        const probe = await sharedPage.evaluate(async () => {
            try {
                const { extension_settings } = await import('/scripts/extensions.js');
                const vf = extension_settings?.vectfox;
                if (!vf) return { ok: false, reason: 'no_settings' };
                // Use ST's getRequestHeaders — it includes the CSRF token that
                // ST's auth middleware requires for POST. Without this, the
                // probe gets 403 Forbidden from Express's CSRF guard and
                // misclassifies qdrant as "unreachable" even when it's up.
                // This is the same header-source every other VectFox plugin
                // call uses (qdrant.js, standard.js, collection-export.js...).
                const { getRequestHeaders } = await import('/script.js');
                // Mirror QdrantBackend.initialize's config-building logic.
                const config = vf.qdrant_use_cloud
                    ? { url: vf.qdrant_url || null, apiKey: null, host: null, port: null }
                    : { host: vf.qdrant_host || 'localhost', port: vf.qdrant_port || 6333, url: null, apiKey: null };
                const resp = await fetch('/api/plugins/similharity/backend/init/qdrant', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(config),
                });
                const status = resp.status;
                if (!resp.ok) {
                    const errBody = await resp.text().catch(() => '<no body>');
                    return { ok: false, status, sentConfig: config, errBody: errBody.slice(0, 200) };
                }
                const data = await resp.json().catch(() => null);
                return { ok: data?.success === true, status, sentConfig: config, body: data };
            } catch (e) { return { ok: false, error: e.message }; }
        });
        _qdrantReachableCache = !!probe?.ok;
        if (probe?.ok) {
            console.log(`[probe] qdrant reachable: status=${probe.status}, sentConfig=${JSON.stringify(probe.sentConfig)}, response=${JSON.stringify(probe.body)}`);
        } else {
            console.log(`[probe] qdrant NOT reachable: status=${probe.status ?? 'n/a'}, sentConfig=${JSON.stringify(probe.sentConfig)}, errBody="${probe.errBody || ''}"${probe.error ? `, error=${probe.error}` : ''}`);
        }
    } catch (e) {
        _qdrantReachableCache = false;
        console.log(`[probe] qdrant reachable: probe threw at page-eval level: ${e.message}`);
    }
    return !!_qdrantReachableCache;
}

/**
 * Soft-skip helper for tests that require the qdrant pipeline. Skips cleanly
 * (test marked ⏭️ in report, not failed) when ANY of these are true:
 *
 *   1. The Similharity plugin isn't installed — qdrant requires it
 *      (see Doc/dev_helper.md §15 plugin-dependency policy).
 *   2. VectFox settings have no `qdrant_url` / `qdrant_host` configured —
 *      this is case 2 in §15's 3-environment matrix (plugin installed but
 *      user runs standard backend only).
 *   3. Qdrant config is present but qdrant is not reachable — user had
 *      qdrant at some point but isn't actively using it now. Emits a
 *      WARNING (not a failure) because nothing is "wrong" — the user
 *      just doesn't use qdrant.
 *
 * Use at the very top of any qdrant-requiring test body.
 */
async function skipIfQdrantUnavailable() {
    if (!(await isSimilharityPluginAvailable())) {
        test.skip(true, 'Similharity plugin not installed — qdrant requires it. See Doc/dev_helper.md §15.');
    }
    if (!(await hasQdrantConfig())) {
        test.skip(true, 'Qdrant URL/host not configured in VectFox settings (case 2: plugin-only standard backend usage).');
    }
    if (!(await isQdrantReachable())) {
        test.skip(true, 'WARNING: Qdrant config present but server is unreachable — user not actively running qdrant. Skipping qdrant tests cleanly so the rest of the suite continues. If you DO want qdrant tests to run, check that your qdrant container/server is up.');
    }
}

/**
 * Soft-skip helper for TEST 008 — uses standard backend but specifically
 * exercises the plugin-enhanced path. Skips when the plugin isn't installed.
 * (TEST 009 is the no-plugin counterpart and should run on any machine.)
 */
async function skipIfNoPlugin() {
    if (!(await isSimilharityPluginAvailable())) {
        test.skip(true, 'Similharity plugin not installed — this test exercises the plugin-enhanced path. TEST 009 is the no-plugin counterpart.');
    }
}


// ═══════════════════════════════════════════════════════════════════
// TEST 000 — the deployed copy is complete: every VectFox file loads
// ═══════════════════════════════════════════════════════════════════
// A file missing from the deployed copy, or a path that names no file, fails here instead of when a user first
// opens the screen that loads it. Three checks: nothing VectFox requested since the first navigation failed (the
// manifest's src/index.js and src/vectfox.css with everything they import); every file under this repo's src/ is
// served; and every module outside src/vendor/ imports, which also loads the modules VectFox imports on demand.
test('TEST 000 — every VectFox file loads from the deployed copy', async () => {
    expect(vectfoxLoadFailures, 'VectFox files that failed to load at startup').toEqual([]);

    const files = shippedFiles();
    const modules = files.filter((file) => file.endsWith('.js') && !file.startsWith('src/vendor/'));
    const problems = await sharedPage.evaluate(async ({ base, files, modules }) => {
        const found = [];
        for (const file of files) {
            const response = await fetch(base + file, { method: 'HEAD', cache: 'no-store' });
            // Read the empty body: Chrome cancels a request whose response the page never reads.
            await response.arrayBuffer();
            if (!response.ok) found.push(`${response.status} ${file}`);
        }
        for (const module of modules) {
            try {
                await import(base + module);
            } catch (error) {
                found.push(`import failed: ${module}: ${error.message}`);
            }
        }
        return found;
    }, { base: VECTFOX_SERVED_PATH, files, modules });

    console.log(`TEST 000: ${files.length} files served, ${modules.length} modules imported, ${problems.length} problem(s)`);
    expect(problems, 'VectFox files the deployed copy does not serve or cannot import').toEqual([]);
    expect(vectfoxLoadFailures, 'VectFox files that failed to load').toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════
// TEST 002 — Qdrant EventBase: insert + field check
// ═══════════════════════════════════════════════════════════════════
// Self-contained: creates its own EventBase collection, inserts 2 test
// events, queries them back, verifies fields, then cleans up.
test('TEST 002 — Qdrant EventBase: insert + field check', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 002 [EventBaseQdrant]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const settings = { ...vf, vector_backend: 'qdrant' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_qdrant_playwright___vf_playwright_test_002__${ts}`;
        const registryKey  = `qdrant:${collectionId}`;
        const testChatUUID = `__vf_playwright_test_002__${ts}`;

        const testEvents = [
            {
                event_type: 'dialogue_significant',
                importance: 8,
                summary: 'Charlotte and Prince Estra forge a naval alliance against the empire',
                DateTime: '2026-01-01T12:00:00Z',
                cause: 'War council meeting at Royal HQ',
                result: 'Alliance formally established',
                characters: ['Charlotte', 'Prince Estra'],
                locations: ['Royal Navy HQ'],
                factions: ['Eltherins Empire', 'Floran Privateers'],
                items: [],
                concepts: ['naval warfare', 'diplomacy', 'alliance'],
                keywords: ['naval', 'strategy', 'alliance', 'charlotte', 'prince'],
                open_threads: ['Will the empire retaliate?'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_001_${ts}`,
                source_window_start: 0,
                source_window_end: 5,
                source_message_hashes: [11111, 22222],
                schema_version: 1,
            },
            {
                event_type: 'combat',
                importance: 9,
                summary: 'Pirate fleet ambushes the imperial supply convoy near the Skaagi islands',
                DateTime: '2026-01-02T08:00:00Z',
                cause: 'Intelligence report from Floran agents',
                result: 'Supply convoy destroyed, 3 ships sunk',
                characters: ['Captain Loren', 'Charlotte'],
                locations: ['Skaagi Islands', 'Southern Sea'],
                factions: ['Floran Privateers', 'Eltherins Empire'],
                items: ['Floran warship', 'imperial cargo'],
                concepts: ['piracy', 'naval combat', 'supply disruption'],
                keywords: ['pirate', 'ambush', 'convoy', 'skaagi', 'combat'],
                open_threads: ['Imperial response fleet dispatched'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_002_${ts}`,
                source_window_start: 5,
                source_window_end: 10,
                source_message_hashes: [33333, 44444],
                schema_version: 1,
            },
        ];

        console.log(`${TEST} Inserting 2 test events into ${collectionId}...`);
        try {
            await insertEvents(testEvents, settings, null, collectionId);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertEvents threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollection failed:', cleanupError); }
            return;
        }
        console.log(`${TEST} Insert complete ✓`);

        try {
            // Per Doc/collection_helper.md (canonical-API rule): use
            // getBackend so the shared singleton (with pluginAvailable +
            // Qdrant init already done) is returned.
            // A fresh `new QdrantBackend()` would skip that initialization.
            const backend = await getBackend(settings);
            let results;
            try {
                results = await backend.queryCollection(collectionId, 'naval alliance combat pirate', 10, settings);
            } catch (err) {
                console.error(`${TEST} [FAIL] Query threw: ${err.message}`);
                return;
            }

            const items = results?.metadata ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] Query returned 0 results after insert`); return; }

            // Verify each inserted event_id is present and has its event_type field.
            // Extras (e.g. orphan vectors from prior runs) are warned but don't fail the test.
            const expectedIds = new Set(testEvents.map(e => e.event_id));
            const foundIds = new Set();
            let extras = 0;
            for (const m of items) {
                if (m.event_id && expectedIds.has(m.event_id)) {
                    if (!m.event_type) { console.error(`${TEST} [FAIL] Event ${m.event_id}: missing event_type`); return; }
                    foundIds.add(m.event_id);
                    console.log(`  ✓ ${m.event_id}  type=${m.event_type}  imp=${m.importance}  chars=${JSON.stringify(m.characters)}`);
                } else {
                    extras++;
                }
            }
            if (extras) console.warn(`${TEST} [WARN] ${extras} unrelated result(s) returned (orphan vectors in physical Qdrant collection)`);

            const missing = [...expectedIds].filter(id => !foundIds.has(id));
            if (missing.length) { console.error(`${TEST} [FAIL] ${missing.length} inserted event(s) not retrieved: ${missing.join(', ')}`); return; }

            console.log(`${TEST} [PASS] All ${expectedIds.size} inserted event(s) retrieved with event_type + payload fields`);
        } finally {
            try {
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: nuke vectra-side-effect folder + bare registry entry (B4).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 003 — E2E qdrant: a locked EventBase returns results
// ═══════════════════════════════════════════════════════════════════
// Self-contained: inserts one synthetic event into its own qdrant EventBase,
// locks it to the current chat, runs the EventBase dry-run retrieval and
// checks that it returns events, then cleans up. A smoke test: other
// collections locked to this chat can supply the events too; TEST 013 checks
// that the synthetic event itself comes back.
test('TEST 003 — E2E qdrant: locked EventBase returns results', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 003 [E2EQuery]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollectionMeta, setCollectionLock, clearCollectionLock, getCollectionLocks } = await import(base + 'src/features/collections/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

        // Derive persona handle for collection ID — see TEST 013 for rationale.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        const ts = Date.now();
        const eventbaseCollectionId = `vf_eventbase_qdrant_${personaHandle}___vf_playwright_test_003__${ts}`;
        const eventbaseRegistryKey  = `qdrant:${eventbaseCollectionId}`;
        const testEvents = [{
            event_type: 'discovery',
            importance: 8,
            summary: 'Wardens of Cinderwhisper Pass document an unusual mist pattern around the Quasar Lantern stations',
            DateTime: '2027-09-03T04:15:00Z',
            cause: 'Routine night patrol',
            result: 'Pattern logged for further study',
            characters: ['Warden Eilis', 'Tham Verlen'],
            locations: ['Cinderwhisper Pass'],
            factions: ['Order of Wardens'],
            items: ['Quasar Lantern'],
            concepts: ['mist', 'starlight', 'pass'],
            keywords: ['quasar', 'lantern', 'mist'],
            open_threads: ['Cause of the new mist pattern?'],
            should_persist: true,
            chat_uuid: currentChatId,
            event_id: `test_event_003_001_${ts}`,
            source_window_start: 0,
            source_window_end: 5,
            source_message_hashes: [33301, 33302],
            schema_version: 1,
        }];

        let eventbaseCreated = false;

        try {
            // ── Phase A: insert synthetic event into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase A: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'qdrant' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            // EventBase doesn't auto-lock when collection ID is supplied explicitly.
            // Lock it manually so runEventBaseRetrieval picks it up — see TEST 013.
            setCollectionLock(eventbaseRegistryKey, currentChatId);

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓`);

            // ── Phase B: query EventBase via dry-run retrieval ──
            const chat = ctx.chat ?? [];
            // A query made of the synthetic event's own words, so the result
            // does not depend on what the user's chat says.
            const testQuery = 'quasar lantern cinderwhisper pass mist starlight wardens';

            const { runEventBaseRetrieval } = await import(base + 'src/features/eventbase/eventbase-workflow.js');
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

            let eventbaseResult;
            try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: testQuery }); }
            catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

            const eventCount = eventbaseResult?.eventCount ?? 0;
            if (!eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
            console.log(`${TEST} EventBase: ${eventCount} event(s) injected, lockedCollections=${eventbaseResult.lockedCollectionsCount}, archive=${eventbaseResult.archiveCollectionsCount}`);
            console.log(`  preview: ${(eventbaseResult.injectionText || '').slice(0, 200)}`);

            console.log(`${TEST} [PASS] EventBase (${eventCount}) — the retrieval path returns events with the test collection locked`);
        } finally {
            // ── Cleanup: remove every trace this test created ──
            if (eventbaseCreated) {
                try {
                    clearCollectionLock(eventbaseRegistryKey);
                    await deleteCollection(eventbaseCollectionId, { ...vf, vector_backend: 'qdrant' }, eventbaseRegistryKey);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(eventbaseCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] EventBase folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(eventbaseRegistryKey);
                    unregisterCollection(eventbaseRegistryKey);
                    unregisterCollection(eventbaseCollectionId);
                    console.log(`${TEST} EventBase cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] EventBase cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 004 — DB Browser: listing + delete (qdrant)
// ═══════════════════════════════════════════════════════════════════
// Self-contained: inserts 3 one-paragraph chunks, each carrying a sourceName
// in its metadata, into its own qdrant collection, verifies listChunks
// surfaces text + sourceName, deletes one chunk, verifies it's gone, then
// cleans up.
test('TEST 004 — DB Browser: listing + delete (qdrant)', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 004 [DBBrowser]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertVectorItems } = await import(base + 'src/features/vector-backend/vector-api.js');
        const { registerCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { getStringHash } = await import('/scripts/utils.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const settings = { ...vf, vector_backend: 'qdrant' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_qdrant_playwright___vf_playwright_test_004__${ts}`;
        const registryKey  = `qdrant:${collectionId}`;
        const sourceName   = '__vf_playwright_test_004__';

        // One chunk per paragraph, hashed by its text.
        const documentParagraphs = [
            'Glasswing moths inhabit the cloud forests of the southern continent. Their transparent wings refract sunlight into faint rainbows. Alchemists collect their wing dust as a primary ingredient for invisibility potions.',
            'The Sunken Library of Ralthar rests beneath the Cerulean Bay. Sealed in glass domes by the last archmage of the Eighth Council, its scrolls remain dry and legible after four centuries underwater. Only triton scholars hold the keys.',
            'Bronzewing falcons are bred by the high desert tribes for long-distance message delivery. They navigate by magnetic field alone and can fly nine hundred miles without rest. Each bird is bonded to a single rider through a ritual of shared blood.',
        ];
        const testItems = documentParagraphs.map((text, index) => ({ hash: getStringHash(text), text, index, metadata: { sourceName } }));

        console.log(`${TEST} Inserting ${testItems.length} test chunks into ${collectionId} with Qdrant backend...`);
        try {
            await insertVectorItems(collectionId, testItems, settings);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertVectorItems threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollection failed:', cleanupError); }
            return;
        }
        registerCollection(registryKey);
        console.log(`${TEST} Inserted ${testItems.length} chunks → ${registryKey}`);

        try {
            // Per Doc/collection_helper.md (canonical-API rule): use
            // getBackend so the shared, initialized singleton is returned. A
            // fresh `new QdrantBackend()` would skip the plugin probe and
            // Qdrant init that happens at first use.
            const backend = await getBackend({ ...vf, vector_backend: 'qdrant' });
            let listResult;
            try { listResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

            const items = listResult?.items ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
            console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

            items.slice(0, 3).forEach((item, i) =>
                console.log(`  [${i}] sourceName="${item.metadata?.sourceName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

            const noText       = items.filter(i => !i.text?.trim());
            const noSourceName = items.filter(i => !i.metadata?.sourceName);

            if (noText.length) { console.error(`${TEST} [FAIL] ${noText.length} chunk(s) have no text`); return; }
            if (noSourceName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing sourceName`); return; }
            if (noSourceName.length > 0) console.warn(`${TEST} [WARN] ${noSourceName.length} chunk(s) missing sourceName`);

            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash}  text="${(items[0].text || '').slice(0, 40)}"`);
            try { await backend.deleteVectorItems(collectionId, [targetHash], vf); }
            catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

            let afterResult;
            try { afterResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

            if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
                console.error(`${TEST} [FAIL] Deleted hash still in listing`); return;
            }
            if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

            console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
            console.log(`${TEST} [PASS] Source name visible, text present, delete removed the chunk`);
        } finally {
            try {
                // Vectors, the registry entry and the metadata, under both key forms.
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: nuke vectra-side-effect folder (B4).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 006 — Standard EventBase: insert + parseEmbedText recovery
// ═══════════════════════════════════════════════════════════════════
// Self-contained: inserts two test events into its own standard (vectra)
// EventBase collection, queries them back via StandardBackend, and verifies
// parseEmbedText can recover event_type / summary from the embed text.
// This is the no-rich-metadata path — structured fields live INSIDE the
// embed text and have to be parsed back out client-side.
test('TEST 006 — Standard EventBase: insert + parseEmbedText recovery', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 006 [StdEventBase]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { parseEmbedText } = await import(base + 'src/features/eventbase/eventbase-schema.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const settings = { ...vf, vector_backend: 'standard' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_standard_playwright___vf_playwright_test_006__${ts}`;
        const registryKey  = `vectra:${collectionId}`;
        const testChatUUID = `__vf_playwright_test_006__${ts}`;

        const testEvents = [
            {
                event_type: 'discovery',
                importance: 8,
                summary: 'The party uncovers a hidden Saltglass Anvil chamber beneath the Vermilion Reach forge',
                DateTime: '2027-03-15T09:00:00Z',
                cause: 'Investigating mysterious heat signatures',
                result: 'Anvil chamber catalogued, contents preserved',
                characters: ['Bramwell the Smith', 'Iris Quench'],
                locations: ['Vermilion Reach', 'Saltglass Forge'],
                factions: ['Smiths Conclave'],
                items: ['Saltglass Anvil'],
                concepts: ['ancient forging', 'discovery', 'archaeology'],
                keywords: ['saltglass', 'anvil', 'vermilion', 'forge', 'discovery'],
                open_threads: ['Who built the original chamber?'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_006_001_${ts}`,
                source_window_start: 0,
                source_window_end: 5,
                source_message_hashes: [55501, 55502],
                schema_version: 1,
            },
            {
                event_type: 'combat',
                importance: 9,
                summary: 'Quartzwood beetle swarm attacks Bramwell mid-forging, scattered with Iris pyrotechnics',
                DateTime: '2027-03-15T11:00:00Z',
                cause: 'Disturbed nest in the forge ceiling beams',
                result: 'Swarm dispersed, two beetles captured for study',
                characters: ['Bramwell the Smith', 'Iris Quench'],
                locations: ['Vermilion Reach', 'Saltglass Forge'],
                factions: ['Smiths Conclave'],
                items: ['quartzwood beetle specimens'],
                concepts: ['combat', 'insect swarm', 'pyrotechnic dispersal'],
                keywords: ['quartzwood', 'beetle', 'swarm', 'forge', 'combat'],
                open_threads: ['Beetles may have been drawn by the chamber discovery'],
                should_persist: true,
                chat_uuid: testChatUUID,
                event_id: `test_event_006_002_${ts}`,
                source_window_start: 5,
                source_window_end: 10,
                source_message_hashes: [55503, 55504],
                schema_version: 1,
            },
        ];

        console.log(`${TEST} Inserting 2 test events into ${collectionId}...`);
        try {
            await insertEvents(testEvents, settings, null, collectionId);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertEvents threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollection failed:', cleanupError); }
            return;
        }
        console.log(`${TEST} Insert complete ✓`);

        try {
            // Per Doc/collection_helper.md (canonical-API rule): use
            // getBackend so the shared, initialized singleton is returned. A
            // fresh `new StandardBackend()` would have pluginAvailable=false
            // until initialize() runs — silently routing every call to the
            // native fallback and masking real plugin paths.
            const backend = await getBackend(settings);
            let results;
            try { results = await backend.queryCollection(collectionId, 'saltglass anvil quartzwood beetle', 10, settings); }
            catch (err) { console.error(`${TEST} [FAIL] queryCollection threw: ${err.message}`); return; }

            const items = results?.metadata ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] Query returned 0 results after insert`); return; }
            console.log(`${TEST} Query: ${items.length} result(s)`);

            // For the standard (vectra) backend, structured event fields live INSIDE the
            // embed text — they have to be recovered via parseEmbedText. Match by
            // `summary` (which IS in the embed text and round-trips via parseEmbedText)
            // rather than `event_id` (which is a metadata-only field — not in the embed
            // text, and stripped by native ST API on no-plugin standard backend).
            //
            // The no-plugin path is the strictest contract: only fields that survive
            // the embed-text round-trip are guaranteed. event_id, importance, persist,
            // chat_uuid etc. all need plugin-side metadata storage. The test's purpose
            // is "parseEmbedText recovery" — so we verify the embed-text contract.
            const expectedSummaries = new Set(testEvents.map(e => e.summary));
            const foundSummaries = new Set();
            let recoveredCount = 0;
            for (const m of items) {
                const r = parseEmbedText(m.text || '');
                if (r.summary && expectedSummaries.has(r.summary)) {
                    foundSummaries.add(r.summary);
                }
                if (r.event_type) {
                    recoveredCount++;
                    console.log(`  ✓ ${m.event_id || '(no event_id — plugin metadata not available)'}  type="${r.event_type}"  summary="${(r.summary||'').slice(0,50)}"`);
                }
            }

            const missing = [...expectedSummaries].filter(s => !foundSummaries.has(s));
            if (missing.length) { console.error(`${TEST} [FAIL] ${missing.length} inserted event summary/summaries not recovered by parseEmbedText: ${missing.map(s => s.slice(0,60)).join(' | ')}`); return; }
            if (recoveredCount < expectedSummaries.size) {
                console.error(`${TEST} [FAIL] parseEmbedText recovered event_type for only ${recoveredCount}/${expectedSummaries.size} inserted events`);
                return;
            }

            console.log(`${TEST} [PASS] All ${expectedSummaries.size} inserted event(s) recovered via parseEmbedText (event_type + summary intact)`);
        } finally {
            try {
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: also nuke the parent on-disk folder.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 007 — E2E standard: a locked EventBase returns results
// ═══════════════════════════════════════════════════════════════════
// TEST 003 on the standard (vectra) backend: inserts one synthetic event into
// its own standard EventBase, locks it to the current chat, runs the EventBase
// dry-run retrieval and checks that it returns events, then cleans up.
test('TEST 007 — E2E standard: locked EventBase returns results', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 007 [E2EStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollectionMeta, setCollectionLock, clearCollectionLock, getCollectionLocks } = await import(base + 'src/features/collections/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

        // Derive persona handle for collection ID — see TEST 013 for rationale.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        const ts = Date.now();
        const eventbaseCollectionId = `vf_eventbase_standard_${personaHandle}___vf_playwright_test_007__${ts}`;
        const eventbaseRegistryKey  = `vectra:${eventbaseCollectionId}`;
        const testEvents = [{
            event_type: 'discovery',
            importance: 8,
            summary: 'Astrolabe Guild apprentices report unexpected compass drift in the Ember Channels coinciding with Lambent Sextant readings',
            DateTime: '2027-11-14T08:42:00Z',
            cause: 'Routine charting expedition',
            result: 'Drift correlation logged; further study scheduled',
            characters: ['Apprentice Yves', 'Master Kallin'],
            locations: ['Ember Channels'],
            factions: ['Astrolabe Guild'],
            items: ['Lambent Sextant'],
            concepts: ['navigation', 'magnetic drift', 'guild apprentice'],
            keywords: ['lambent', 'sextant', 'compass', 'drift'],
            open_threads: ['Source of compass drift?'],
            should_persist: true,
            chat_uuid: currentChatId,
            event_id: `test_event_007_001_${ts}`,
            source_window_start: 0,
            source_window_end: 5,
            source_message_hashes: [77701, 77702],
            schema_version: 1,
        }];

        let eventbaseCreated = false;

        try {
            // ── Phase A: insert synthetic event into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase A: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'standard' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            setCollectionLock(eventbaseRegistryKey, currentChatId);

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓`);

            // ── Phase B: query EventBase via dry-run retrieval ──
            const chat = ctx.chat ?? [];
            // A query made of the synthetic event's own words — same rationale as TEST 003.
            const testQuery = 'lambent sextant ember channels compass drift navigator moonglass';

            const { runEventBaseRetrieval } = await import(base + 'src/features/eventbase/eventbase-workflow.js');
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

            let eventbaseResult;
            try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: testQuery }); }
            catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

            const eventCount = eventbaseResult?.eventCount ?? 0;
            if (!eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
            console.log(`${TEST} EventBase: ${eventCount} event(s) injected, lockedCollections=${eventbaseResult.lockedCollectionsCount}, archive=${eventbaseResult.archiveCollectionsCount}`);
            console.log(`  preview: ${(eventbaseResult.injectionText || '').slice(0, 200)}`);

            console.log(`${TEST} [PASS] EventBase (${eventCount}) — standard backend, the retrieval path returns events with the test collection locked`);
        } finally {
            // ── Cleanup — the TEST 003 cleanup, on the standard backend ──
            if (eventbaseCreated) {
                try {
                    clearCollectionLock(eventbaseRegistryKey);
                    await deleteCollection(eventbaseCollectionId, { ...vf, vector_backend: 'standard' }, eventbaseRegistryKey);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(eventbaseCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] EventBase folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(eventbaseRegistryKey);
                    unregisterCollection(eventbaseRegistryKey);
                    unregisterCollection(eventbaseCollectionId);
                    console.log(`${TEST} EventBase cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] EventBase cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  Why TEST 008 AND TEST 009? — read this before touching either
// ═══════════════════════════════════════════════════════════════════
//
// The Standard (vectra) backend has TWO operational modes that look
// identical at the API surface but behave VERY differently underneath:
//
//   1. Standard + Similharity plugin  (the path most users have)
//      ─ insert/list/delete go through /api/plugins/similharity/chunks/*
//      ─ FULL metadata round-trip: text, sourceName, keywords, custom
//        fields all persist and come back via listChunks
//      ─ DB Browser shows everything
//
//   2. Standard alone, no plugin       (the bare minimum SillyTavern setup)
//      ─ insert/list/delete go through ST's native /api/vector/*
//      ─ DEGRADED mode: only hash + text + index are stored; listChunks
//        is hashes-only ({ hash, text: '', metadata: {} })
//      ─ DB Browser shows just hashes — by design, per src/features/vector-backend/standard.js
//        top comment ("Plugin dependency rule"). The standard backend MUST
//        remain fully functional without the plugin installed.
//
// Both modes are *supported* contracts. Both have to work. So we test both
// — TEST 008 verifies the rich path, TEST 009 verifies graceful degradation
// to the lean path. A regression in either mode breaks real users.
//
// If you find yourself wondering "why are we doing the same test twice?" —
// you're not. They exercise different code paths via the same surface
// (StandardBackend.listChunks). The plugin/native branch inside that
// function is the seam.
// ═══════════════════════════════════════════════════════════════════

// ─── TEST 008 — standard backend WITH plugin ─────────────────────────
// Asserts the rich path works: listChunks must surface text + sourceName
// after a self-contained insert. If this fails while pluginAvailable=true,
// the plugin's /chunks/list endpoint or vectra's storeListItems is broken.
test('TEST 008 — DB Browser standard + plugin: listing + delete', async () => {
    await skipIfNoPlugin();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 008 [DBBrowserStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertVectorItems } = await import(base + 'src/features/vector-backend/vector-api.js');
        const { registerCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { getStringHash } = await import('/scripts/utils.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const settings = { ...vf, vector_backend: 'standard' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_standard_playwright___vf_playwright_test_008__${ts}`;
        const registryKey  = `vectra:${collectionId}`;
        const sourceName   = '__vf_playwright_test_008__';

        // One chunk per paragraph, hashed by its text.
        const documentParagraphs = [
            'Ashfern spores germinate only after exposure to volcanic ash. The resulting plant produces a deep-blue dye prized by the southern weavers. A single mature ashfern yields enough spore-pods for one full bolt of cloth.',
            'The Mirror Citadel of Vorn was carved from a single obsidian seam in the Coldroot Mountains. Its walls reflect approaching armies tenfold, an illusion that has broken three sieges without a single arrow loosed.',
            'Tideglass eels migrate along the Vermilion Reef every spring. Their translucent bodies become visible only at twilight. Fishermen of the coastal hamlets carve flutes from their bones — said to summon mist on still nights.',
        ];
        const testItems = documentParagraphs.map((text, index) => ({ hash: getStringHash(text), text, index, metadata: { sourceName } }));

        console.log(`${TEST} Inserting ${testItems.length} test chunks into ${collectionId} with Standard backend...`);
        try {
            await insertVectorItems(collectionId, testItems, settings);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertVectorItems threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollection failed:', cleanupError); }
            return;
        }
        registerCollection(registryKey);
        console.log(`${TEST} Inserted ${testItems.length} chunks → ${registryKey}`);

        try {
            // Use the backend manager so we get the shared, properly-initialized
            // StandardBackend (pluginAvailable already detected). A fresh
            // `new StandardBackend()` would have pluginAvailable=false until
            // initialize() runs — silently routing every listChunks call to
            // the native fallback and masking real plugin issues.
            const backend = await getBackend({ ...vf, vector_backend: 'standard' });
            console.log(`${TEST} backend.pluginAvailable=${backend.pluginAvailable}`);

            let listResult;
            try { listResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

            const items = listResult?.items ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
            console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

            items.slice(0, 3).forEach((item, i) =>
                console.log(`  [${i}] sourceName="${item.metadata?.sourceName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

            const noText       = items.filter(i => !i.text?.trim());
            const noSourceName = items.filter(i => !i.metadata?.sourceName);

            if (noText.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks have no text — standard backend listChunks may need plugin support`); return; }
            if (noText.length > 0) console.warn(`${TEST} [WARN] ${noText.length} chunk(s) have no text`);
            if (noSourceName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing sourceName`); return; }
            if (noSourceName.length > 0) console.warn(`${TEST} [WARN] ${noSourceName.length} chunk(s) missing sourceName`);

            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash}  text="${(items[0].text || '').slice(0, 40)}"`);
            try { await backend.deleteVectorItems(collectionId, [targetHash], vf); }
            catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

            let afterResult;
            try { afterResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

            if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
                console.error(`${TEST} [FAIL] Deleted hash still in listing`); return;
            }
            if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

            console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
            console.log(`${TEST} [PASS] Standard: source name visible, text present, delete removed the chunk`);
        } finally {
            try {
                // Vectors, the registry entry and the metadata, under both key forms.
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: also nuke the parent on-disk folder.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ─── TEST 009 — standard backend WITHOUT plugin (degraded path) ─────
// Read the "Why TEST 008 AND TEST 009?" block above test 008 first.
//
// This test verifies graceful degradation: when the Similharity plugin
// is unavailable, the standard backend must still support the basic
// insert → list → delete cycle through ST's native /api/vector/*.
// The top comment in src/features/vector-backend/standard.js mandates this contract.
//
// We can't uninstall the plugin from a test, so we simulate it by
// forcing `pluginAvailable = false` on the SHARED cached backend
// instance from getBackend(). This must be done BEFORE the insert, so
// it ALSO routes through the native API — otherwise data lands at
// vectors/{source}/{collectionId}/{model}/ (plugin path) while our list
// and delete look at vectors/{source}/{collectionId}/ (native path),
// and the delete silently no-ops because it can't find the data. That
// path-mismatch isn't a real-world scenario; either users have plugin
// (all ops plugin) or don't (all ops native). The test must mirror one.
//
// We restore pluginAvailable in the finally block so subsequent
// operations (cleanup, any later tests, the running ST session) aren't
// poisoned by our override.
//
// Expectations:
//   - insert via native /api/vector/insert succeeds
//   - listChunks returns N items where N matches what insert wrote
//   - Each item has `hash` populated; text === '' and metadata === {}
//     are degraded-but-expected
//   - Delete by hash via native /api/vector/delete actually removes it
//
// A FAIL here means the no-plugin contract is broken — real users on
// vanilla SillyTavern would lose DB Browser functionality entirely.
test('TEST 009 — DB Browser standard, no plugin: graceful degradation', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 009 [DBBrowserStdNoPlugin]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertVectorItems } = await import(base + 'src/features/vector-backend/vector-api.js');
        const { registerCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { getStringHash } = await import('/scripts/utils.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const settings = { ...vf, vector_backend: 'standard' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_standard_playwright___vf_playwright_test_009__${ts}`;
        const registryKey  = `vectra:${collectionId}`;
        const sourceName   = '__vf_playwright_test_009__';

        // One chunk per paragraph, hashed by its text. The native insert stores only
        // hash, text and index, so the sourceName in each item's metadata is not kept.
        const documentParagraphs = [
            'Coppervine trellises grow on abandoned watchtowers along the eastern marshes. Their copper-rich sap conducts magical signals over short distances, and apprentice mages use them to practice resonance work without dedicated crystals.',
            'Silt Singers are reclusive mer-folk who emerge from the estuary mud at low tide. They communicate through low-frequency hums that travel further through wet earth than air. Coastal villagers leave salt offerings on the tideline in exchange for storm warnings.',
            'Wraithcap mushrooms grow in graveyards and old battlefields. Their pale fruiting bodies fade in and out of visibility on a regular cycle, said to track the breathing of whatever lies buried beneath. Necromancers harvest them by touch alone.',
        ];
        const testItems = documentParagraphs.map((text, index) => ({ hash: getStringHash(text), text, index, metadata: { sourceName } }));

        // ───────────────────────────────────────────────────────────────
        //  Boundary rules for this test:
        //
        //  ✗ DO NOT mutate extension_settings.vectfox — that's the user's
        //    config and must remain untouched. All settings overrides go
        //    through the `settings: { ...vf, ...override }` parameter on
        //    function calls (e.g. vector_backend, source, model).
        //
        //  ✓ DO mutate `backend.pluginAvailable` (the cached singleton's
        //    runtime flag) because there's no settings-level toggle for
        //    "pretend the plugin isn't installed." The flag lives on the
        //    backend instance, not in config. Restore it in `finally` so
        //    a test crash doesn't leak degraded-mode into the live ST
        //    session.
        //
        //  Why mutate the SHARED instance (not a fresh `new StandardBackend()`):
        //  insertVectorItems calls getBackend() internally, which returns the
        //  cached singleton. If we only flip pluginAvailable on a fresh
        //  instance, the insert uses the cached one (pluginAvailable=true) →
        //  data lands at vectors/{source}/{cid}/{model}/, but our list+delete
        //  via the fresh instance look at vectors/{source}/{cid}/ → delete
        //  silently no-ops. That's a mismatched-mode test, not the real
        //  no-plugin scenario.
        // ───────────────────────────────────────────────────────────────
        const backend = await getBackend(settings);
        const originalPluginAvailable = backend.pluginAvailable;
        backend.pluginAvailable = false;
        console.log(`${TEST} Forced pluginAvailable=false on the shared StandardBackend (was ${originalPluginAvailable}) — exercising native end-to-end`);

        try {
            console.log(`${TEST} Inserting ${testItems.length} test chunks into ${collectionId} via the native path...`);
            try {
                await insertVectorItems(collectionId, testItems, settings);
            } catch (err) { console.error(`${TEST} [FAIL] insertVectorItems threw: ${err.message}`); return; }
            registerCollection(registryKey);
            console.log(`${TEST} Inserted ${testItems.length} chunks via native path → ${registryKey}`);

            let listResult;
            try { listResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }

            const items = listResult?.items ?? [];
            if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
            console.log(`${TEST} listChunks: ${items.length} items (total: ${listResult.total})`);

            items.slice(0, 3).forEach((item, i) =>
                console.log(`  [${i}] hash=${item.hash}  text="${(item.text||'')}"  metaKeys=[${Object.keys(item.metadata || {}).join(',')}]`));

            // Degraded contract: every item has a hash, but text + metadata are intentionally empty.
            const noHash       = items.filter(i => i.hash == null);
            const hasText      = items.filter(i => i.text?.trim());
            const hasMetaField = items.filter(i => i.metadata && Object.keys(i.metadata).length > 0);

            if (noHash.length) { console.error(`${TEST} [FAIL] ${noHash.length} item(s) missing hash — native path must always return hashes`); return; }
            if (hasText.length) {
                // Not a failure — means the native path silently grew richer; but it does
                // mean the contract is now stronger than documented, so flag it.
                console.warn(`${TEST} [WARN] ${hasText.length} item(s) HAVE text in no-plugin mode — native fallback returning more than documented?`);
            }
            if (hasMetaField.length) {
                console.warn(`${TEST} [WARN] ${hasMetaField.length} item(s) HAVE metadata fields in no-plugin mode — native fallback returning more than documented?`);
            }

            // Delete-by-hash via native /api/vector/delete should still work even without plugin.
            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash} via no-plugin path...`);
            try { await backend.deleteVectorItems(collectionId, [targetHash], vf); }
            catch (err) { console.error(`${TEST} [FAIL] deleteVectorItems threw: ${err.message}`); return; }

            let afterResult;
            try { afterResult = await backend.listChunks(collectionId, vf, { limit: 10 }); }
            catch (err) { console.error(`${TEST} [FAIL] listChunks after delete threw: ${err.message}`); return; }

            if ((afterResult?.items ?? []).some(i => i.hash === targetHash)) {
                console.error(`${TEST} [FAIL] Deleted hash still in listing after no-plugin delete`); return;
            }
            if (afterResult.total >= listResult.total) console.warn(`${TEST} [WARN] total count did not decrease`);

            console.log(`${TEST} After delete: ${listResult.total} → ${afterResult.total} ✓`);
            console.log(`${TEST} [PASS] Standard (no plugin) end-to-end: insert + list + delete via native path`);
        } finally {
            // Restore plugin availability on the SHARED backend instance BEFORE cleanup
            // so deleteCollection doesn't take native paths
            // and leak state to any subsequent test or to the running ST session.
            backend.pluginAvailable = originalPluginAvailable;
            console.log(`${TEST} Restored backend.pluginAvailable=${originalPluginAvailable}`);

            // Runs after a failed insert too: an insert that threw can still have stored some chunks.
            try {
                // Vectors, the registry entry and the metadata, under both key forms.
                await deleteCollection(collectionId, settings, registryKey);
                // TEST-ONLY: nuke the parent on-disk folder. `backend` here is the
                // SHARED StandardBackend instance — pluginAvailable just got restored
                // above so the helper takes the plugin purge path normally.
                try {
                    await backend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 012 — Cross-backend import: qdrant ↔ standard rename
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   `importCollection` needs to remap the backend segment in the collection
//   ID when the export's backend differs from the user's current target
//   backend. Without that, importing a qdrant export into standard would
//   create a vectra folder named `vf_*_qdrant_*` — polluting storage and
//   confusing every parser that reads the backend from the ID.
//
//   The remap logic lives in `src/shared/collection-ids.js::remapCollectionIdToBackend`;
//   importCollection calls it.
//
// What this test proves:
//   - Pure helper checks first (remap both directions + detection round-trip)
//   - Phase 1: importing a qdrant-shaped export with vector_backend='standard'
//     produces a collection ID containing `_standard_`, not `_qdrant_`.
//   - Phase 2: mirror — standard export imported with vector_backend='qdrant'
//     produces a `_qdrant_`-segment ID.
//
// Boundary rules (same as TEST 009):
//   ✗ DO NOT mutate extension_settings.vectfox
//   ✓ DO use sentinel `__vf_playwright_test_012__` in IDs so beforeAll's
//     orphan cleanup catches anything left behind by a crash.
test('TEST 012 — Cross-backend import: qdrant ↔ standard rename', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 012 [ImportRename]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { importCollection } = await import(base + 'src/features/collections/collection-export.js');
        const { remapCollectionIdToBackend, getBackendFromCollectionId } = await import(base + 'src/shared/collection-ids.js');
        const { deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured — need both backends to test the rename`); return; }

        // ═══ Pure-helper sanity checks (no I/O) ═══════════════════════════
        // Verify the helper does what it claims before triggering an actual
        // cross-backend import. If the helper is broken, no point chasing
        // on-disk behavior.
        const ts = Date.now();
        const qdrantId   = `vf_lorebook_qdrant_playwright___vf_playwright_test_012__${ts}`;
        const standardId = `vf_lorebook_standard_playwright___vf_playwright_test_012__${ts}`;

        const q2s = remapCollectionIdToBackend(qdrantId, 'standard');
        const s2q = remapCollectionIdToBackend(standardId, 'qdrant');
        console.log(`${TEST} q→s remap: ${qdrantId} → ${q2s}`);
        console.log(`${TEST} s→q remap: ${standardId} → ${s2q}`);
        if (q2s !== standardId) { console.error(`${TEST} [FAIL] qdrant→standard remap broken: expected "${standardId}", got "${q2s}"`); return; }
        if (s2q !== qdrantId)   { console.error(`${TEST} [FAIL] standard→qdrant remap broken: expected "${qdrantId}", got "${s2q}"`); return; }

        // Idempotency: remap to same backend = no-op
        const noop = remapCollectionIdToBackend(qdrantId, 'qdrant');
        if (noop !== qdrantId) { console.error(`${TEST} [FAIL] same-backend remap should be a no-op, got "${noop}"`); return; }

        // Detection round-trip + registry-key prefix stripping
        if (getBackendFromCollectionId(qdrantId)   !== 'qdrant')   { console.error(`${TEST} [FAIL] getBackend(qdrant id) wrong`); return; }
        if (getBackendFromCollectionId(standardId) !== 'standard') { console.error(`${TEST} [FAIL] getBackend(standard id) wrong`); return; }
        if (getBackendFromCollectionId(`qdrant:${qdrantId}`) !== 'qdrant') { console.error(`${TEST} [FAIL] getBackend strips registry-key prefix incorrectly`); return; }
        console.log(`${TEST} Pure-helper checks ✓ — remap + detection work both directions`);

        // ═══ Phase 1: qdrant → standard import ═══════════════════════════
        const sentinel1 = 'IMPORT_RENAME_CANARY_FOXGLOVE_K8N2';
        const qdrantExport = {
            collection: {
                id: qdrantId,
                name: '__vf_playwright_test_012_q2s__',
                type: 'lorebook',
            },
            embedding: {
                backend: 'qdrant',
                source: vf.source || 'openrouter',
                model: vf.openrouter_model || vf.model || null,
            },
            chunks: [
                { text: `${sentinel1} — a flower whose pollen induces vivid dreams.`, index: 0, metadata: { entryName: 'Foxglove K8N2' } },
            ],
        };

        let p1ResultId = null;
        try {
            console.log(`${TEST} Phase 1: importing qdrant export → standard backend...`);
            const r = await importCollection(qdrantExport, { ...vf, vector_backend: 'standard' }, { overwrite: true, forceReembed: true });
            p1ResultId = r?.collectionId || r?.id || null;
            console.log(`${TEST} Phase 1 import returned collectionId="${p1ResultId}"`);
        } catch (err) {
            console.error(`${TEST} [FAIL] Phase 1 import threw: ${err.message}`);
            return;
        }

        try {
            if (!p1ResultId) { console.error(`${TEST} [FAIL] Phase 1: importCollection returned no collectionId`); return; }
            if (p1ResultId.includes('_qdrant_')) {
                console.error(`${TEST} [FAIL] Phase 1: import kept the qdrant segment — rename did NOT happen. Got "${p1ResultId}"`);
                return;
            }
            if (!p1ResultId.includes('_standard_')) {
                console.error(`${TEST} [FAIL] Phase 1: import didn't produce a standard-segment ID. Got "${p1ResultId}"`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ — qdrant export imported as standard ID: ${p1ResultId}`);
        } finally {
            if (p1ResultId) {
                try {
                    // Vectors, the registry entry and the metadata, under both key forms (the BARE-ID duplicate, B4).
                    await deleteCollection(p1ResultId, { ...vf, vector_backend: 'standard' }, `vectra:${p1ResultId}`);
                    // TEST-ONLY: nuke parent folder in vectra (Phase 1 imports as standard)
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(p1ResultId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Phase 1 folder-cleanup helper failed: ${e.message}`); }
                    console.log(`${TEST} Phase 1 cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Phase 1 cleanup failed: ${cleanupErr.message}`);
                }
            }
        }

        // ═══ Phase 2: standard → qdrant import ═══════════════════════════
        const sentinel2 = 'IMPORT_RENAME_CANARY_VERMILION_R6Q9';
        const standardExport = {
            collection: {
                id: standardId,
                name: '__vf_playwright_test_012_s2q__',
                type: 'lorebook',
            },
            embedding: {
                backend: 'standard',
                source: vf.source || 'openrouter',
                model: vf.openrouter_model || vf.model || null,
            },
            chunks: [
                { text: `${sentinel2} — a metalwork pigment forged from oxidized copper.`, index: 0, metadata: { entryName: 'Vermilion R6Q9' } },
            ],
        };

        let p2ResultId = null;
        try {
            console.log(`${TEST} Phase 2: importing standard export → qdrant backend...`);
            const r = await importCollection(standardExport, { ...vf, vector_backend: 'qdrant' }, { overwrite: true, forceReembed: true });
            p2ResultId = r?.collectionId || r?.id || null;
            console.log(`${TEST} Phase 2 import returned collectionId="${p2ResultId}"`);
        } catch (err) {
            console.error(`${TEST} [FAIL] Phase 2 import threw: ${err.message}`);
            return;
        }

        try {
            if (!p2ResultId) { console.error(`${TEST} [FAIL] Phase 2: importCollection returned no collectionId`); return; }
            if (p2ResultId.includes('_standard_')) {
                console.error(`${TEST} [FAIL] Phase 2: import kept the standard segment — rename did NOT happen. Got "${p2ResultId}"`);
                return;
            }
            if (!p2ResultId.includes('_qdrant_')) {
                console.error(`${TEST} [FAIL] Phase 2: import didn't produce a qdrant-segment ID. Got "${p2ResultId}"`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ — standard export imported as qdrant ID: ${p2ResultId}`);
            console.log(`${TEST} [PASS] Cross-backend import rename works both directions`);
        } finally {
            if (p2ResultId) {
                try {
                    // Vectors, the registry entry and the metadata, under both key forms (the BARE-ID duplicate, B4).
                    await deleteCollection(p2ResultId, { ...vf, vector_backend: 'qdrant' }, `qdrant:${p2ResultId}`);
                    // TEST-ONLY: nuke vectra-side-effect folder (Phase 2 result is qdrant
                    // but plugin's insert path leaves a vectra placeholder — B4).
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(p2ResultId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Phase 2 folder-cleanup helper failed: ${e.message}`); }
                    console.log(`${TEST} Phase 2 cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Phase 2 cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 013 — Synthetic E2E: self-contained EventBase round-trip (qdrant)
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   TEST 003 and TEST 007 pass on any returned event, so an event from
//   another collection locked to the current chat satisfies them too.
//
//   TEST 013 runs the same EventBase retrieval on PURELY SYNTHETIC test
//   data and checks what comes back — it creates its own EventBase
//   collection, locks it to the current chat, runs the dry-run retrieval,
//   asserts its sentinel appears in the injection, then nukes every
//   artifact like nothing was ever done. No reliance on user data,
//   settings, or pre-existing locked collections.
//
// Backend choice: qdrant — production-relevant path and what TEST 003 is
// shaped after. Gracefully fails the test config check if Qdrant is not
// configured rather than crashing.
//
// Cleanup contract: every artifact this test creates is removed in finally:
//   - EventBase vectors + meta + registry (both canonical and bare forms)
//     + explicit lock removal
//   - vectra-side-effect folder (B4)
test('TEST 013 — Synthetic E2E qdrant: EventBase round-trip', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 013 [SyntheticE2E]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollectionMeta, setCollectionLock, clearCollectionLock, getCollectionLocks } = await import(base + 'src/features/collections/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

        // Derive the current persona's handle the same way collection-ids.js
        // does. It goes into the synthetic EventBase collection ID so that
        // registerCollection's creatorHandle-stamp condition (`_<handle>_` in
        // the ID) matches and the collection is this persona's, like a real one.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        // Sentinel: unique enough that it CANNOT exist in any real user data
        // or any other test's fixture. Used to verify the retrieval pipeline
        // returned OUR synthetic content (not leaked from elsewhere).
        const EVENTBASE_SENTINEL = 'ZIRCONIC_OSCILLATOR_T2P6';

        const ts = Date.now();
        const eventbaseCollectionId = `vf_eventbase_qdrant_${personaHandle}___vf_playwright_test_013__${ts}`;
        const eventbaseRegistryKey  = `qdrant:${eventbaseCollectionId}`;
        const testEvents = [{
            event_type: 'discovery',
            importance: 9,
            summary: `Astrelle expedition records the ${EVENTBASE_SENTINEL} — a resonance instrument unearthed beneath the Stilled Tide cliffs`,
            DateTime: '2027-08-12T22:30:00Z',
            cause: 'Routine survey of phosphor-light anomalies',
            result: 'Instrument catalogued, primary resonance frequency logged at 7.3 Hz',
            characters: ['Saskia Marrow', 'Halvard Cresswell'],
            locations: ['Astrelle Cliffs', 'Stilled Tide'],
            factions: ['Pale Conclave'],
            items: [EVENTBASE_SENTINEL],
            concepts: ['discovery', 'resonance', 'phosphoric phenomena'],
            keywords: ['zirconic', 'oscillator', 'astrelle', 'discovery'],
            open_threads: ['What does the oscillator resonate with?'],
            should_persist: true,
            chat_uuid: currentChatId, // pivot for getCollectionLocks lookup
            event_id: `test_event_013_001_${ts}`,
            source_window_start: 0,
            source_window_end: 5,
            source_message_hashes: [77701, 77702],
            schema_version: 1,
        }];

        let eventbaseCreated = false;

        try {
            // ── Phase A: insert synthetic events into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase A: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'qdrant' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            // EventBase doesn't auto-lock here: insertEvents skips the auto-lock
            // path because the collection ID is supplied explicitly. Lock it
            // manually so runEventBaseRetrieval picks it up as a live locked
            // collection.
            setCollectionLock(eventbaseRegistryKey, currentChatId);

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓ (locks=${ebLocks.length})`);

            // ── Phase B: query EventBase via dry-run retrieval ──
            const chat = ctx.chat ?? [];
            const query = `${EVENTBASE_SENTINEL} phosphoric stilled tide astrelle zirconic oscillator`;

            console.log(`${TEST} Phase B: querying EventBase against synthetic data...`);
            const { runEventBaseRetrieval } = await import(base + 'src/features/eventbase/eventbase-workflow.js');
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

            let ebResult;
            try { ebResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: query }); }
            catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

            const ebInjection = ebResult?.injectionText || '';
            if (!ebResult?.eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
            if (!ebInjection.includes(EVENTBASE_SENTINEL)) {
                console.error(`${TEST} [FAIL] EventBase sentinel "${EVENTBASE_SENTINEL}" not in injection (events=${ebResult.eventCount})`);
                console.log(`${TEST} EventBase injection preview: ${ebInjection.slice(0, 300)}`);
                return;
            }
            console.log(`${TEST} EventBase ✓ — ${ebResult.eventCount} event(s), sentinel found`);

            console.log(`${TEST} [PASS] Synthetic E2E qdrant: EventBase round-trips with its sentinel intact`);
        } finally {
            // ── Cleanup: remove every trace this test created ──
            // Order: locks → vectors → meta → registry (both canonical + bare).
            if (eventbaseCreated) {
                try {
                    clearCollectionLock(eventbaseRegistryKey);
                    await deleteCollection(eventbaseCollectionId, { ...vf, vector_backend: 'qdrant' }, eventbaseRegistryKey);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(eventbaseCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] EventBase folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(eventbaseRegistryKey);
                    unregisterCollection(eventbaseRegistryKey);
                    unregisterCollection(eventbaseCollectionId);
                    console.log(`${TEST} EventBase cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] EventBase cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 014 — Auto-sync backfill: fingerprint cache prevents duplicate windows
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   Auto-sync's correctness rests on the WINDOW FINGERPRINT CACHE (see
//   Doc/dev_helper.md §4 and Doc/collection_helper.md "Chat Auto-Sync").
//   Without it, every auto-sync trigger would re-extract every window from
//   the beginning of chat — burning LLM tokens and duplicating events.
//
//   This is the "smart marker" that makes auto-sync safe: each completed
//   window's hashes are joined into a fingerprint string and stored in the
//   collection's pointer (`extension_settings.vectfox.collections[<registry
//   key>].eventbaseProgress.extractedWindows`, read through an in-memory Set).
//   On the next ingestion call, isLastWindowExtracted does a quick-exit, and
//   isWindowAlreadyExtracted gates each window. Already-done windows are
//   skipped.
//
//   User scenario this exercises:
//     1. Vectorize a chat at 2 messages (window size = 2) → window [0-1] done
//     2. User replies twice — chat now has 6 messages
//     3. User checks "Enable Auto-Sync" → next trigger should backfill the
//        4 new messages (windows [2-3] and [4-5]) WITHOUT re-processing the
//        original [0-1] window.
//
//   We test the dedup CONTRACT directly — fast and deterministic. No test
//   in this suite runs the cache inside the LLM extraction pipeline
//   (runEventBaseIngestion): TEST 003/007/013 insert synthetic events
//   straight into their collections.
//
// What this test proves:
//   - markWindowExtracted writes the window into the collection's record.
//   - isWindowAlreadyExtracted correctly reports true for marked windows
//     and false for unmarked ones (the per-window dedup gate).
//   - isLastWindowExtracted returns false when the last window is unmarked
//     (work to do → ingestion runs) and true when every window is marked
//     (quick-exit → ingestion no-ops).
//   - isWindowAlreadyExtracted reports true for a window of another size
//     whose messages were all read, and false for one holding an unread
//     message: no message is read twice, in windows of any size (§2.7 of
//     InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md).
//   - The persisted array length equals the expected window count
//     (survives page reload — key correctness property for auto-sync
//     across browser restarts).
//   - clearWindowCache wipes the window record (cleanup contract).
//
// Boundary rules (same as TEST 009):
//   ✗ DO NOT mutate extension_settings.vectfox at a global level beyond
//     the synthetic test collection's record (deleted in finally).
//   ✓ DO use a synthetic collection ID holding __vf_playwright_test_.
test('TEST 014 — Auto-sync backfill: fingerprint cache prevents duplicate windows', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 014 [AutoSyncDedup]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            markWindowExtracted,
            isWindowAlreadyExtracted,
            isLastWindowExtracted,
            clearWindowCache,
        } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollectionMeta } = await import(base + 'src/features/collections/collection-metadata.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        // Synthetic test collection — never collides with a real one. Its record holds the pointer the test writes.
        const testKey = 'qdrant:vf_eventbase_qdrant_playwright___vf_playwright_test_014__autosync_dedup';
        const windowSize = 2;
        const step = 2;

        // Build a fake 6-message chat. The hashes are arbitrary integers — what
        // matters is that they're stable across the test and unique per message,
        // which matches the windowFingerprint contract (sorted hashes joined).
        const messages = [
            { mes: 'human msg 0', name: 'You' },
            { mes: 'ai msg 0',    name: 'AI'  },
            { mes: 'human msg 1', name: 'You' },
            { mes: 'ai msg 1',    name: 'AI'  },
            { mes: 'human msg 2', name: 'You' },
            { mes: 'ai msg 2',    name: 'AI'  },
        ];
        const hashes = [100, 200, 300, 400, 500, 600];
        const hashFn = (m) => hashes[messages.indexOf(m)];
        const win01 = [hashes[0], hashes[1]];   // initial vectorization window
        const win23 = [hashes[2], hashes[3]];   // backfill window 1
        const win45 = [hashes[4], hashes[5]];   // backfill window 2 (last)

        try {
            // ═══ Phase 1 — initial state: chat at 2 messages, window [0-1] done ═══
            console.log(`${TEST} Phase 1: simulating initial vectorization (2 messages → window [0-1])`);
            markWindowExtracted(win01, testKey);

            const phase1WindowDone = isWindowAlreadyExtracted(win01, testKey);
            if (!phase1WindowDone) {
                console.error(`${TEST} [FAIL] Phase 1: marked window [0-1] reads back as NOT extracted — markWindowExtracted broken`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ window [0-1] correctly in cache`);

            // ═══ Phase 2 — chat grows to 6 messages, NEW windows not yet marked ═══
            console.log(`${TEST} Phase 2: chat grew to 6 messages — verifying new windows [2-3] and [4-5] are NOT in cache`);
            const phase2Win23 = isWindowAlreadyExtracted(win23, testKey);
            const phase2Win45 = isWindowAlreadyExtracted(win45, testKey);
            if (phase2Win23) {
                console.error(`${TEST} [FAIL] Phase 2: window [2-3] reads as extracted but was never marked — false positive in dedup gate`);
                return;
            }
            if (phase2Win45) {
                console.error(`${TEST} [FAIL] Phase 2: window [4-5] reads as extracted but was never marked — false positive in dedup gate`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ unmarked windows correctly report not-extracted`);

            // ═══ Phase 3 — quick-exit gate should report MORE WORK TO DO ═══
            // This is the gate runEventBaseIngestion checks first. If it
            // returned true here, auto-sync would no-op even though 4 messages
            // are unprocessed — exactly the bug the smart marker prevents.
            console.log(`${TEST} Phase 3: isLastWindowExtracted should return false (last window [4-5] unmarked → work to do)`);
            const quickExitBefore = isLastWindowExtracted(messages, windowSize, step, testKey, hashFn);
            if (quickExitBefore) {
                console.error(`${TEST} [FAIL] Phase 3: quick-exit returned true despite last window [4-5] being unmarked — auto-sync would skip the 4-message backfill`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ quick-exit correctly reports work pending`);

            // ═══ Phase 4 — simulate the auto-sync ingestion marking the 2 new windows ═══
            console.log(`${TEST} Phase 4: simulating auto-sync sweep — marking windows [2-3] and [4-5]`);
            markWindowExtracted(win23, testKey);
            markWindowExtracted(win45, testKey);

            const phase4Win23 = isWindowAlreadyExtracted(win23, testKey);
            const phase4Win45 = isWindowAlreadyExtracted(win45, testKey);
            if (!phase4Win23 || !phase4Win45) {
                console.error(`${TEST} [FAIL] Phase 4: after marking, windows [2-3] (${phase4Win23}) or [4-5] (${phase4Win45}) still report as not-extracted`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ all 3 windows now marked in cache`);

            // ═══ Phase 5 — quick-exit should now report NOTHING TO DO ═══
            // This proves the fingerprint cache prevents the next auto-sync
            // trigger from re-processing already-done windows. Without this,
            // every chat message would re-extract the entire chat — burning
            // LLM tokens linearly with each new message.
            console.log(`${TEST} Phase 5: isLastWindowExtracted should return true (all windows marked → next trigger no-ops)`);
            const quickExitAfter = isLastWindowExtracted(messages, windowSize, step, testKey, hashFn);
            if (!quickExitAfter) {
                console.error(`${TEST} [FAIL] Phase 5: quick-exit returned false despite all 3 windows marked — next auto-sync would re-process work`);
                return;
            }
            console.log(`${TEST} Phase 5 ✓ quick-exit correctly reports nothing pending`);

            // ═══ Phase 6 — the record's array matches what the Set reports ═══
            // The Set is rebuilt from this array on the next page load, so
            // length-correctness here is what makes auto-sync survive a reload.
            console.log(`${TEST} Phase 6: verifying the window record in the collection's record`);
            const persisted = extension_settings?.vectfox?.collections?.[testKey]?.eventbaseProgress?.extractedWindows;
            if (!Array.isArray(persisted)) {
                console.error(`${TEST} [FAIL] Phase 6: persisted entry is not an array — type=${typeof persisted}`);
                return;
            }
            if (persisted.length !== 3) {
                console.error(`${TEST} [FAIL] Phase 6: persisted array length=${persisted.length}, expected 3 (one fingerprint per window)`);
                return;
            }
            console.log(`${TEST} Phase 6 ✓ persisted array has exactly 3 fingerprints`);

            // ═══ Phase 7 — windows of another size follow the messages read ═══
            console.log(`${TEST} Phase 7: window [1-2], its messages read in two windows, reads as extracted; window [5-6], message 6 unread, does not`);
            const straddlingRead = isWindowAlreadyExtracted([hashes[1], hashes[2]], testKey);
            const holdingUnread = isWindowAlreadyExtracted([hashes[5], 700], testKey);
            if (!straddlingRead || holdingUnread) {
                console.error(`${TEST} [FAIL] Phase 7: window [1-2] extracted=${straddlingRead} (want true), window [5-6] extracted=${holdingUnread} (want false)`);
                return;
            }
            console.log(`${TEST} Phase 7 ✓ no message read twice, in windows of any size`);

            console.log(`${TEST} [PASS] Fingerprint cache correctly gates auto-sync — 2-msg → 6-msg backfill processes only the 4 new messages, never the original 2`);
        } finally {
            // Wipe the window record, then the synthetic collection's record.
            // Real user data is never touched — testKey is synthetic and unique.
            try {
                clearWindowCache(testKey);
                const after = extension_settings?.vectfox?.collections?.[testKey]?.eventbaseProgress?.extractedWindows;
                deleteCollectionMeta(testKey);
                if (after !== undefined) {
                    console.warn(`${TEST} [WARN] clearWindowCache left a stale entry: ${JSON.stringify(after)}`);
                } else {
                    console.log(`${TEST} Cleanup ✓ window record cleared for ${testKey}`);
                }
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 015 — Auto-sync window-size change: start marker filters obsolete windows
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   The window record (covered by TEST 014) skips a window once every
//   message in it was read, in windows of any size. A window of a new size
//   that holds messages read and unread is read: if the user vectorizes a
//   chat at windowSize=2 (messages 0-1) and auto-sync then reads at
//   windowSize=4, its window [0-3] holds messages 0 and 1, which would be
//   read again, duplicating their events.
//
//   The AUTO-SYNC START MARKER prevents this. When the user enables
//   auto-sync, `stampAutoSyncMarker` records the first message auto-sync
//   reads in the collection's pointer (`eventbaseProgress.autoSyncStartMarker`).
//   On every auto-sync run, `runEventBaseIngestion` builds its windows from
//   the marker's place among windows of its size (`autoSyncFirstWindowStart`),
//   so one starts exactly at the marker, and filters them with
//   `windows.filter(w => w.start >= marker)`. No window holding messages read
//   before the marker is read, and no message after it is skipped.
//
//   Smart-placement logic in stampAutoSyncMarker:
//     - Collection non-empty: marker = max(source_window_end) + 1
//       (backfill the gap between last-covered message and chat tail at
//       the new window size)
//     - Collection empty: marker = the chat's length, its messages with text
//       (auto-sync starts "from now on" — no full re-extraction of a long
//       pre-existing chat that was never vectorized)
//
//   Together with TEST 014's window record test, this proves the
//   two-layer safety story:
//     Layer 1 (TEST 014) — the window record: no window, and no window of
//                          any size whose messages were all read, read twice
//     Layer 2 (TEST 015) — start marker: auto-sync's windows start at it, and
//                          it reads none that starts before it, as one may
//                          hold messages read
//
// What this test proves:
//   - getAutoSyncMarker returns undefined for an un-stamped collection.
//   - The marker round-trips through the collection's record correctly.
//   - Windows counted from autoSyncFirstWindowStart, as runEventBaseIngestion
//     counts auto-sync's, start at the marker, and the filter
//     `w.start >= marker` keeps them. This is the EXACT filter used inside
//     runEventBaseIngestion at its auto-sync marker block (eventbase-workflow.js).
//   - clearAutoSyncMarker removes the entry cleanly so the next enable
//     stamps a fresh value for the current chat state.
//
// Boundary rules:
//   ✗ DO NOT mutate extension_settings.vectfox at a global level beyond
//     the synthetic test collection's record (deleted in finally).
//   ✓ DO use a synthetic collection ID holding __vf_playwright_test_.
test('TEST 015 — Auto-sync window-size change: start marker filters obsolete windows', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 015 [AutoSyncMarker]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            getAutoSyncMarker,
            clearAutoSyncMarker,
            writeEventBaseProgress,
            autoSyncFirstWindowStart,
        } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollectionMeta } = await import(base + 'src/features/collections/collection-metadata.js');

        const testKey = 'qdrant:vf_eventbase_qdrant_playwright___vf_playwright_test_015__autosync_marker';

        try {
            // ═══ Phase 1 — fresh collection, no marker stamped ═══
            console.log(`${TEST} Phase 1: getAutoSyncMarker on a fresh collection should return undefined`);
            const initial = getAutoSyncMarker(testKey);
            if (initial !== undefined) {
                console.error(`${TEST} [FAIL] Phase 1: unmarked collection returned ${initial} instead of undefined`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ no marker on a fresh collection`);

            // ═══ Phase 2 — stamp marker, simulating the smart-placement output ═══
            // Scenario: user vectorized chat at length=2 with windowSize=2.
            // Window [0-1] was extracted, so the EventBase event has
            // source_window_end=1. User switches to windowSize=4 and enables
            // auto-sync. stampAutoSyncMarker would compute:
            //   marker = max(source_window_end) + 1 = 1 + 1 = 2
            // We simulate the result directly (the math itself is trivial;
            // what we're testing here is the get/filter contract).
            const stampedValue = 2;
            writeEventBaseProgress(testKey, { autoSyncStartMarker: stampedValue });

            const readBack = getAutoSyncMarker(testKey);
            if (readBack !== stampedValue) {
                console.error(`${TEST} [FAIL] Phase 2: getAutoSyncMarker returned ${readBack}, expected ${stampedValue}`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ marker=${stampedValue} stamped and read back via canonical getter`);

            // ═══ Phase 3 — the windows runEventBaseIngestion builds, then its filter ═══
            // Now the chat has grown to 10 messages. Auto-sync's windows at the new
            // windowSize=4 count from the marker's place among windows of that size
            // (2 % 4 = 2): [2-5] and [6-9]. Counted from message 0 instead, [0-3]
            // would hold messages 0,1 (read) and 2,3 (unread): the filter would drop
            // it, and messages 2,3 would never be read.
            //
            // The marker filter `w.start >= 2` keeps both, the first starting exactly
            // at the marker. This is the EXACT logic in runEventBaseIngestion.
            console.log(`${TEST} Phase 3: building auto-sync's windows for a chat of 10 messages at windowSize=4`);
            const marker = getAutoSyncMarker(testKey);
            const windowSize = 4;
            const windowsAtNewSize = [];
            for (let start = autoSyncFirstWindowStart(testKey, windowSize); start + windowSize <= 10; start += windowSize) {
                windowsAtNewSize.push({ start, end: start + windowSize - 1 });
            }
            const filtered = windowsAtNewSize.filter(w => w.start >= marker);
            const spans = windows => JSON.stringify(windows.map(w => `[${w.start}-${w.end}]`));

            if (spans(filtered) !== JSON.stringify(['[2-5]', '[6-9]']) || filtered.length !== windowsAtNewSize.length) {
                console.error(`${TEST} [FAIL] Phase 3: expected windows [2-5] and [6-9], all kept by the filter; built ${spans(windowsAtNewSize)}, kept ${spans(filtered)}`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ auto-sync's windows start at the marker: [2-5] and [6-9], messages 0 and 1 not read again, messages 2 and 3 read`);

            // ═══ Phase 4 — boundary check: start === marker should be KEPT ═══
            // The filter uses `>=` not `>`. This matters because
            // stampAutoSyncMarker uses max(source_window_end)+1, so the next
            // legitimate window starts exactly AT the marker. A `>` filter
            // would skip the first new window — extraction gap.
            console.log(`${TEST} Phase 4: verifying boundary inclusion — start === marker survives the filter`);
            const boundaryWindows = [
                { start: 1, end: 4, msgs: [] },  // start=1 < 2 → out
                { start: 2, end: 5, msgs: [] },  // start=2 === marker → in
                { start: 3, end: 6, msgs: [] },  // start=3 > 2 → in
            ];
            const boundaryFiltered = boundaryWindows.filter(w => w.start >= marker);
            if (boundaryFiltered.length !== 2) {
                console.error(`${TEST} [FAIL] Phase 4: expected 2 windows (start=2 and start=3), got ${boundaryFiltered.length}`);
                return;
            }
            if (boundaryFiltered[0].start !== 2 || boundaryFiltered[1].start !== 3) {
                console.error(`${TEST} [FAIL] Phase 4: surviving windows have wrong starts: ${JSON.stringify(boundaryFiltered.map(w => w.start))}`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ boundary at start === marker correctly included`);

            // ═══ Phase 5 — clearAutoSyncMarker removes the entry ═══
            // Called when auto-sync is disabled, so re-enabling later
            // re-computes a fresh marker for the current chat state.
            console.log(`${TEST} Phase 5: clearAutoSyncMarker removes the entry`);
            clearAutoSyncMarker(testKey);
            const cleared = getAutoSyncMarker(testKey);
            if (cleared !== undefined) {
                console.error(`${TEST} [FAIL] Phase 5: clearAutoSyncMarker left value ${cleared} — should be undefined after clear`);
                return;
            }
            console.log(`${TEST} Phase 5 ✓ marker cleared, fresh re-enable would re-compute`);

            console.log(`${TEST} [PASS] Auto-sync start marker correctly gates the window filter — windowSize-change protection holds: auto-sync's windows start at the marker, the filter keeps them, boundary at start === marker included`);
        } finally {
            try {
                clearAutoSyncMarker(testKey);
                const after = getAutoSyncMarker(testKey);
                deleteCollectionMeta(testKey);
                if (after !== undefined) {
                    console.warn(`${TEST} [WARN] clearAutoSyncMarker left a stale value: ${after}`);
                } else {
                    console.log(`${TEST} Cleanup ✓ marker cleared for ${testKey}`);
                }
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});

// ═══════════════════════════════════════════════════════════════════
//  TEST 016 — stampAutoSyncMarker smart placement (production-function smoke)
// ═══════════════════════════════════════════════════════════════════
//
//  TEST 015 covered the marker get/clear contract and the workflow filter
//  using simulated data. TEST 016 exercises the *production* function that
//  actually computes the marker — `stampAutoSyncMarker(registryKey, settings)`
//  in src/features/eventbase/eventbase-store.js — across its decision branches:
//
//    Branch A: no registry key                    → returns 0, no persistence
//    Branch B: a collection the backend lacks     → marker = chatLength
//    Branch C: a registered collection, no events → marker = chatLength (fallback)
//    Branch D: a collection with source_window_end metadata
//                                                 → marker = max(end) + 1
//
//  Branches A/B/C run in every environment. Branch D requires a backend that
//  preserves item-level metadata; collection-export's insertChunksWithVectors
//  routes standard-backend inserts through native /api/vector/insert which
//  strips metadata, so D is only meaningful on env 3 (qdrant). Rather than
//  bolting on a qdrant-only Phase 4 with synthetic point inserts, this test
//  asserts the three branches that work everywhere and lets the actual
//  max+1 arithmetic — a trivial one-line reducer — stand on its own. The
//  high-risk parts (branch selection, the chatLength fallback, re-stamp
//  overwrite) are what real regressions hit.
//
//  Phases:
//    1. Branch A — empty registry key returns 0 sentinel, no write.
//    2. Branch B — a key naming a collection the backend does not have.
//       Its listChunks returns nothing or throws, caught, so the marker
//       equals the chat's length, its messages with text as a run counts
//       them, and persists.
//    3. Branch C — synthetic vf_eventbase_<…> registered, no chunks on disk.
//       The marker falls back to chatLength the same way.
//    4. Re-stamp idempotency — second call overwrites the persisted value.
//    5. Floor override — { floor: 'chatLength' } stamps chat length directly.
//    Cleanup — clear the markers, delete the synthetic collection and records.

test('TEST 016 — stampAutoSyncMarker smart placement (production-function smoke)', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 016 [AutoSyncStamp]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            stampAutoSyncMarker,
            getAutoSyncMarker,
            clearAutoSyncMarker,
            writeEventBaseProgress,
        } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { registerCollection, deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { deleteCollectionMeta } = await import(base + 'src/features/collections/collection-metadata.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const settings = extension_settings?.vectfox || {};
        // The chat's length as a run counts it, its messages with text, which the stamp uses.
        const chatLengthOf = () => (ctx?.chat ?? []).filter(message => message.mes && message.mes.trim().length > 0).length;
        const backend = (settings.vector_backend || 'standard').toLowerCase();
        const registryBackend = backend === 'standard' ? 'vectra' : backend;

        // Two distinct collections so Phase 2 (no collection) and Phase 3 (a
        // registered one) don't pollute each other's records.
        const keyBranchB = `${registryBackend}:vf_eventbase_${backend}_playwright___vf_playwright_test_016__no_candidate`;
        const syntheticCollectionId = `vf_eventbase_${backend}_playwright___vf_playwright_test_016__empty_candidate`;
        const syntheticRegistryKey  = `${registryBackend}:${syntheticCollectionId}`;

        try {
            // ═══ Phase 1 — Branch A: empty registry key returns 0, no write ═══
            console.log(`${TEST} Phase 1: stampAutoSyncMarker('') should return 0 and NOT touch the records`);
            // Capture the records so we can prove no spurious write happened.
            const recordsBefore = JSON.stringify(extension_settings?.vectfox?.collections || {});

            const sentinel = await stampAutoSyncMarker('', settings);
            if (sentinel !== 0) {
                console.error(`${TEST} [FAIL] Phase 1: empty key returned ${sentinel} instead of 0`);
                return;
            }
            const recordsAfter = JSON.stringify(extension_settings?.vectfox?.collections || {});
            if (recordsBefore !== recordsAfter) {
                console.error(`${TEST} [FAIL] Phase 1: the collection records were changed by an empty-key call`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ Branch A early-exit: returned 0, no persistence`);

            // ═══ Phase 2 — Branch B: a collection the backend lacks → marker = chatLength ═══
            console.log(`${TEST} Phase 2: Branch B — a collection the backend does not have → marker should equal chat length`);
            const chatLengthB = chatLengthOf();
            const markerB = await stampAutoSyncMarker(keyBranchB, settings);
            if (markerB !== chatLengthB) {
                console.error(`${TEST} [FAIL] Phase 2: marker=${markerB}, expected chatLength=${chatLengthB}`);
                return;
            }
            const persistedB = getAutoSyncMarker(keyBranchB);
            if (persistedB !== markerB) {
                console.error(`${TEST} [FAIL] Phase 2: persisted value ${persistedB} does not match returned ${markerB}`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ Branch B: marker=${markerB} (chatLength=${chatLengthB}) persisted via getAutoSyncMarker`);

            // ═══ Phase 3 — Branch C: a registered collection, no events → fallback ═══
            console.log(`${TEST} Phase 3: Branch C — registering synthetic ${syntheticRegistryKey} with no events → marker should fall back to chat length`);
            registerCollection(syntheticRegistryKey);

            const chatLengthC = chatLengthOf();
            const markerC = await stampAutoSyncMarker(syntheticRegistryKey, settings);
            if (markerC !== chatLengthC) {
                console.error(`${TEST} [FAIL] Phase 3: marker=${markerC}, expected chatLength=${chatLengthC} (the candidate holds no source_window_end, so the marker should have fallen back). Branch C fallback may be broken.`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ Branch C: marker=${markerC} (chatLength=${chatLengthC}) — fallback held; candidate present but no readable source_window_end`);

            // ═══ Phase 4 — Re-stamp idempotency ═══
            console.log(`${TEST} Phase 4: re-stamping Branch B's collection overwrites the persisted value cleanly`);
            // Mutate the persisted value to a sentinel so we can prove the
            // re-stamp actually wrote (not just left a stale equal value).
            writeEventBaseProgress(keyBranchB, { autoSyncStartMarker: -999 });
            // Read back the sentinel via the canonical getter — if this fails,
            // the pre-condition wasn't met and the rest of Phase 4 would
            // silently pass on a no-op overwrite.
            const sentinelReadBack = getAutoSyncMarker(keyBranchB);
            if (sentinelReadBack !== -999) {
                console.error(`${TEST} [FAIL] Phase 4 pre-condition: sentinel write didn't land — getAutoSyncMarker reads ${sentinelReadBack} instead of -999. Re-stamp overwrite assertion below would be meaningless.`);
                return;
            }
            const reStamped = await stampAutoSyncMarker(keyBranchB, settings);
            if (reStamped !== chatLengthB) {
                console.error(`${TEST} [FAIL] Phase 4: re-stamp returned ${reStamped}, expected ${chatLengthB}`);
                return;
            }
            if (getAutoSyncMarker(keyBranchB) !== chatLengthB) {
                console.error(`${TEST} [FAIL] Phase 4: re-stamp did not overwrite — getAutoSyncMarker still reads ${getAutoSyncMarker(keyBranchB)} after re-stamp`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ re-stamp overwrites prior value (sentinel -999 → ${chatLengthB})`);

            // ═══ Phase 5 — floor override: { floor: 'chatLength' } forces from-now-on ═══
            // Used by the auto-sync enable "Just keep up from here" choice. Must stamp
            // chat length directly (skipping the coverage scan) regardless of state.
            console.log(`${TEST} Phase 5: stampAutoSyncMarker(..., { floor: 'chatLength' }) stamps chat length directly`);
            const chatLenNow = chatLengthOf();
            writeEventBaseProgress(keyBranchB, { autoSyncStartMarker: -777 });
            const floored = await stampAutoSyncMarker(keyBranchB, settings, { floor: 'chatLength' });
            if (floored !== chatLenNow) {
                console.error(`${TEST} [FAIL] Phase 5: floor override returned ${floored}, expected chatLength=${chatLenNow}`);
                return;
            }
            if (getAutoSyncMarker(keyBranchB) !== chatLenNow) {
                console.error(`${TEST} [FAIL] Phase 5: floor override did not persist chatLength — getAutoSyncMarker reads ${getAutoSyncMarker(keyBranchB)} (sentinel -777 not overwritten)`);
                return;
            }
            console.log(`${TEST} Phase 5 ✓ floor override stamps chatLength (${chatLenNow}), overwriting sentinel -777`);

            console.log(`${TEST} [PASS] stampAutoSyncMarker smart placement holds — Branch A early-exit, Branch B missing collection falls to chatLength, Branch C empty collection falls to chatLength, re-stamp overwrites, floor override forces chatLength. Branch D (max(source_window_end)+1) is not asserted by this test because env-1/2 standard-backend inserts strip metadata; the one-line reducer is trivial.`);
        } finally {
            // Cleanup — the markers, then the synthetic collection and Branch B's record.
            // deleteCollection purges its vectors before it unregisters it and deletes
            // its metadata (registry key and bare ID), so anything a backend call left
            // on disk for it is gone before the registration: a folder left behind would
            // be re-discovered by loadAllCollections on the next ST page load as a ghost
            // `vf_eventbase_…playwright_test_016__empty_candidate` entry visible to
            // live retrieval. Deleting a collection with nothing on disk is harmless,
            // so it runs unconditionally, as the beforeAll cleanup deletes leftovers.
            try {
                clearAutoSyncMarker(keyBranchB);
                clearAutoSyncMarker(syntheticRegistryKey);
                if (getAutoSyncMarker(keyBranchB) !== undefined ||
                    getAutoSyncMarker(syntheticRegistryKey) !== undefined) {
                    console.warn(`${TEST} [WARN] clearAutoSyncMarker left stale values: B=${getAutoSyncMarker(keyBranchB)} C=${getAutoSyncMarker(syntheticRegistryKey)}`);
                }
                deleteCollectionMeta(keyBranchB);
                try { await deleteCollection(syntheticCollectionId, settings, syntheticRegistryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollection failed:', cleanupError); }
                console.log(`${TEST} Cleanup ✓ markers cleared, disk artifacts deleted, meta removed, synthetic registration unregistered`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});

// ═══════════════════════════════════════════════════════════════════
//  TEST 017 — Pause button (enabled=false) keeps a locked EventBase out of retrieval
// ═══════════════════════════════════════════════════════════════════
//
//  `isCollectionEnabled` / `setCollectionEnabled` are the pause button.
//  EventBase retrieval searches a live collection only when it is not paused
//  and is locked to the current chat (`isCollectionEnabled`, then
//  `isCollectionActiveForContextAnyKey`, in eventbase-workflow.js). A paused
//  collection stays out even with its lock in place, and pausing never
//  touches the lock.
//
//  Self-contained on the standard backend, as TEST 007 is: inserts one
//  synthetic event into its own EventBase, locks it to the current chat and
//  runs the EventBase dry-run retrieval with a query made of the event's own
//  words. The dry run's `lockedCollectionsCount` counts every live
//  collection the retrieval searched, those other collections locked to this
//  chat included, so the phases compare counts.
//
//  Phases:
//    1. Default state: the fresh collection, never paused, reports
//       `isCollectionEnabled === true`.
//    2. Baseline: locked → the retrieval counts it.
//    3. Pause: `setCollectionEnabled(key, false)` ⇒ `isCollectionEnabled`
//       flips to false, the lock is still in place, the count drops by one,
//       and the event's sentinel is not in the injection.
//    4. Resume: `setCollectionEnabled(key, true)` ⇒ the count is back to the
//       baseline — the pause cycle lost no lock.

test('TEST 017 — Pause button (enabled=false) keeps a locked EventBase out of retrieval', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 017 [PauseButton]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { insertEvents } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { runEventBaseRetrieval } = await import(base + 'src/features/eventbase/eventbase-workflow.js');
        const {
            isCollectionEnabled,
            setCollectionEnabled,
            setCollectionLock,
            clearCollectionLock,
            isCollectionLockedToChat,
        } = await import(base + 'src/features/collections/collection-metadata.js');
        const { deleteCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { getBackend } = await import(base + 'src/features/vector-backend/backend-registry.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx?.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) {
            console.error(`${TEST} [FAIL] No active chat — open a chat first`);
            return;
        }

        // Derive persona handle for collection ID — see TEST 013 for rationale.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        // Sentinel only this test's event carries: no other collection can put it in the injection.
        const SENTINEL = 'TIDEMARK_QUILL_P4X7';

        const settings = { ...vf, vector_backend: 'standard' };
        const ts = Date.now();
        // collectionId contains __vf_playwright_test_ so beforeAll cleanup catches orphans
        const collectionId = `vf_eventbase_standard_${personaHandle}___vf_playwright_test_017__${ts}`;
        const registryKey  = `vectra:${collectionId}`;
        const testEvents = [{
            event_type: 'discovery',
            importance: 8,
            summary: `Cartographers of the Hollowmere Basin recover the ${SENTINEL}, a brass quill that redraws flooded roads on any map it touches`,
            DateTime: '2027-10-21T06:20:00Z',
            cause: 'Survey of the receding floodplain',
            result: 'Quill sealed in the guild archive',
            characters: ['Surveyor Oriel', 'Archivist Benn'],
            locations: ['Hollowmere Basin'],
            factions: ['Cartographers Guild'],
            items: [SENTINEL],
            concepts: ['cartography', 'flood', 'artifact'],
            keywords: ['tidemark', 'quill', 'hollowmere', 'cartographer'],
            open_threads: ['Who forged the quill?'],
            should_persist: true,
            chat_uuid: currentChatId,
            event_id: `test_event_017_001_${ts}`,
            source_window_start: 0,
            source_window_end: 5,
            source_message_hashes: [17701, 17702],
            schema_version: 1,
        }];

        // A query made of the synthetic event's own words — same rationale as TEST 003.
        const chat = ctx.chat ?? [];
        const testQuery = `${SENTINEL} hollowmere basin cartographers brass quill flooded roads`;
        const retrieve = async (phase) => {
            try { return await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: testQuery }); }
            catch (err) { console.error(`${TEST} [FAIL] ${phase}: runEventBaseRetrieval threw: ${err.message}`); return null; }
        };

        console.log(`${TEST} Inserting 1 synthetic event into ${collectionId}...`);
        try {
            await insertEvents(testEvents, settings, null, collectionId);
        } catch (err) {
            console.error(`${TEST} [FAIL] insertEvents threw: ${err.message}`);
            try { await deleteCollection(collectionId, settings, registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollection failed:', cleanupError); }
            return;
        }

        try {
            // ═══ Phase 1 — a collection never paused is enabled ═══
            console.log(`${TEST} Phase 1: fresh collection, never paused → isCollectionEnabled should default to true`);
            const defaultEnabled = isCollectionEnabled(registryKey);
            if (defaultEnabled !== true) {
                console.error(`${TEST} [FAIL] Phase 1: isCollectionEnabled defaulted to ${defaultEnabled}, expected true. Default-true contract broken.`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ default enabled=true`);

            // ═══ Phase 2 — baseline: locked, the retrieval searches it ═══
            console.log(`${TEST} Phase 2: pinning chat lock for chatId=${currentChatId} → the dry-run retrieval must count the collection`);
            setCollectionLock(registryKey, currentChatId);
            if (!isCollectionLockedToChat(registryKey, currentChatId)) {
                console.error(`${TEST} [FAIL] Phase 2: setCollectionLock didn't take — isCollectionLockedToChat reads false. Baseline can't be established.`);
                return;
            }
            const baseline = await retrieve('Phase 2');
            if (!baseline) return;
            const baselineCount = baseline.lockedCollectionsCount ?? 0;
            if (baselineCount < 1) {
                console.error(`${TEST} [FAIL] Phase 2: lockedCollectionsCount=${baselineCount} with the lock pinned — the retrieval did not search the locked collection. The lock gate may be broken.`);
                return;
            }
            if (!(baseline.injectionText || '').includes(SENTINEL)) {
                // Not a failure: another collection locked to this chat can outrank the event (see TEST 007).
                console.warn(`${TEST} [WARN] Phase 2: sentinel not in the injection (events=${baseline.eventCount ?? 0}) — other locked collections may have outranked it`);
            }
            console.log(`${TEST} Phase 2 ✓ baseline: lockedCollectionsCount=${baselineCount}, events=${baseline.eventCount ?? 0}`);

            // ═══ Phase 3 — pause: the lock stays, the retrieval skips the collection ═══
            console.log(`${TEST} Phase 3: setCollectionEnabled(false) → isCollectionEnabled flips false AND the retrieval skips the collection despite the lock`);
            setCollectionEnabled(registryKey, false);
            const enabledAfterPause = isCollectionEnabled(registryKey);
            if (enabledAfterPause !== false) {
                console.error(`${TEST} [FAIL] Phase 3: isCollectionEnabled reads ${enabledAfterPause} after setCollectionEnabled(false). Pause meta didn't land.`);
                return;
            }
            // Lock must still be there — pause should not touch lock state.
            if (!isCollectionLockedToChat(registryKey, currentChatId)) {
                console.error(`${TEST} [FAIL] Phase 3: pause path silently removed the chat lock — setCollectionEnabled should only flip enabled meta, never touch locks.`);
                return;
            }
            const paused = await retrieve('Phase 3');
            if (!paused) return;
            const pausedCount = paused.lockedCollectionsCount ?? 0;
            if (pausedCount !== baselineCount - 1) {
                console.error(`${TEST} [FAIL] Phase 3: lockedCollectionsCount=${pausedCount} after pause, expected ${baselineCount - 1} — the pause (enabled=false) must keep a chat-locked collection out of retrieval.`);
                return;
            }
            if ((paused.injectionText || '').includes(SENTINEL)) {
                console.error(`${TEST} [FAIL] Phase 3: the paused collection's sentinel "${SENTINEL}" is in the injection — a paused collection was searched.`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ pause overrides lock: lockedCollectionsCount ${baselineCount} → ${pausedCount}, sentinel absent, lock still in place`);

            // ═══ Phase 4 — resume: the retrieval searches it again ═══
            console.log(`${TEST} Phase 4: setCollectionEnabled(true) → the retrieval counts the collection again`);
            setCollectionEnabled(registryKey, true);
            const enabledAfterResume = isCollectionEnabled(registryKey);
            if (enabledAfterResume !== true) {
                console.error(`${TEST} [FAIL] Phase 4: isCollectionEnabled reads ${enabledAfterResume} after setCollectionEnabled(true).`);
                return;
            }
            const resumed = await retrieve('Phase 4');
            if (!resumed) return;
            const resumedCount = resumed.lockedCollectionsCount ?? 0;
            if (resumedCount !== baselineCount) {
                console.error(`${TEST} [FAIL] Phase 4: lockedCollectionsCount=${resumedCount} after resume, expected ${baselineCount} — re-enabling should let the lock bring the collection back. Lock state may have been silently lost during the pause cycle.`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ resume restores the collection to retrieval (lockedCollectionsCount=${resumedCount})`);

            console.log(`${TEST} [PASS] Pause button (enabled=false) keeps a chat-locked EventBase out of retrieval — lock state survives the pause cycle, default isCollectionEnabled is true`);
        } finally {
            // ── Cleanup: the lock, then deleteCollection (vectors, registry entry and meta under both key forms), then the on-disk folder ──
            try {
                clearCollectionLock(registryKey);
                await deleteCollection(collectionId, settings, registryKey);
                try {
                    const stdBackend = await getBackend(settings);
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                console.log(`${TEST} Cleanup ✓ lock removed, collection deleted`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});

// ═══════════════════════════════════════════════════════════════════
//  TEST 019 — AutoSync refresh smoke: the refresh path does not mutate locks
// ═══════════════════════════════════════════════════════════════════
//
//  Doc/collection_helper.md → "Manual vs auto-sync paths" calls out the
//  load-bearing rule: `refreshAutoSyncCheckbox` must NEVER mutate lock
//  state. It is a pure UI mirror — it reads collection state and updates
//  `prop('checked', …)` / status text only. The forbidden footgun is
//  `.trigger('change')`, which would fire the user-facing change handler
//  (which DOES remove locks). A refactor that innocently adds
//  `.trigger('change')` to the refresh path would silently remove every
//  active lock the next time the panel auto-syncs (after CHAT_CHANGED,
//  after a vectorization completes).
//
//  Smoke test rather than a comprehensive proof: builds one synthetic
//  own-persona EventBase collection (registered, no events), locks it to
//  the current chat, enables autoSync, then calls the refresh function
//  multiple times back-to-back and asserts that the test collection's lock
//  state, autoSync flag, enabled flag, AND the chat_lock_index reverse map
//  (every collection locked to this chat) are byte-identical before and
//  after. Its ID carries no chat UUID, so the refresh never takes it for
//  this chat's write target and no backend call reaches it.
//
//  Pure metadata + DOM read/write, runs in every environment. Phases:
//    1. refreshAutoSyncCheckbox(settings) — lock + autoSync + chat_lock_index unchanged.
//    2. Idempotency — call it 3× in a row, state still unchanged.

test('TEST 019 — AutoSync refresh smoke: the refresh path does not mutate locks', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 019 [RefreshSmoke]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { refreshAutoSyncCheckbox } = await import(base + 'src/features/settings-panel/settings-panel.js');
        const {
            setCollectionMeta,
            setCollectionLock,
            removeCollectionLock,
            setCollectionAutoSync,
            isCollectionAutoSyncEnabled,
            isCollectionLockedToChat,
            isCollectionEnabled,
            deleteCollectionMeta,
        } = await import(base + 'src/features/collections/collection-metadata.js');
        const { registerCollection, unregisterCollection } = await import(base + 'src/features/collections/collection-loader.js');
        const { buildRegistryKey } = await import(base + 'src/shared/collection-ids.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const settings = extension_settings?.vectfox || {};
        const currentChatId = ctx?.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) {
            console.error(`${TEST} [FAIL] No active chat — open a chat first`);
            return;
        }

        // Derive persona handle — the same shape TEST 013 uses for its
        // EventBase synthesis — so the synthetic collection is this
        // persona's own (isOwn=true), as a real one is.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        const backend = (settings.vector_backend || 'standard').toLowerCase();
        const ts = Date.now();
        // Handle embedded in the ID itself so the legacy substring fallback
        // also recognizes ownership even if creatorHandle meta drifts.
        const collectionId  = `vf_eventbase_${backend}_${personaHandle}_playwright_test_019_refresh_smoke_${ts}`;
        const registryKey   = buildRegistryKey(collectionId, settings);

        // Snapshot of fields refreshes MUST NOT touch. JSON.stringify gives
        // us a stable byte-comparable form for arrays.
        const snapshot = () => ({
            // The forward lock arrays inside meta.
            lockedToChatIds: JSON.stringify(
                extension_settings?.vectfox?.collections?.[registryKey]?.lockedToChatIds || []
            ),
            lockedToCharacterIds: JSON.stringify(
                extension_settings?.vectfox?.collections?.[registryKey]?.lockedToCharacterIds || []
            ),
            // The reverse-index entry for our chat (registryKeys locked to currentChatId).
            chatLockIndex: JSON.stringify(
                (extension_settings?.vectfox?.chat_lock_index?.[currentChatId] || [])
                    .slice().sort()
            ),
            autoSync: isCollectionAutoSyncEnabled(registryKey),
            enabled:  isCollectionEnabled(registryKey),
            // Boolean lock-presence check via the canonical getter so we
            // catch shape changes that bypass the raw-array peek above.
            isLockedToChat: isCollectionLockedToChat(registryKey, currentChatId),
        });

        try {
            registerCollection(registryKey);
            // The scope EventBase ingestion stamps on the collection it writes.
            setCollectionMeta(registryKey, {
                creatorHandle: personaHandle,
                scope: 'chat',
            });
            setCollectionLock(registryKey, currentChatId);
            setCollectionAutoSync(registryKey, true);

            // Verify the baseline took — otherwise the snapshot comparison
            // below would be comparing two "lock missing" states and pass
            // trivially.
            if (!isCollectionLockedToChat(registryKey, currentChatId)) {
                console.error(`${TEST} [FAIL] Baseline: setCollectionLock didn't take, can't assert refresh hygiene.`);
                return;
            }
            if (isCollectionAutoSyncEnabled(registryKey) !== true) {
                console.error(`${TEST} [FAIL] Baseline: setCollectionAutoSync(true) didn't take, can't assert refresh hygiene.`);
                return;
            }

            const before = snapshot();
            console.log(`${TEST} Baseline snapshot: ${JSON.stringify(before)}`);

            const compare = (after, label) => {
                const drift = [];
                if (after.lockedToChatIds      !== before.lockedToChatIds)      drift.push(`lockedToChatIds:    ${before.lockedToChatIds} → ${after.lockedToChatIds}`);
                if (after.lockedToCharacterIds !== before.lockedToCharacterIds) drift.push(`lockedToCharacterIds: ${before.lockedToCharacterIds} → ${after.lockedToCharacterIds}`);
                if (after.chatLockIndex        !== before.chatLockIndex)        drift.push(`chat_lock_index[${currentChatId}]: ${before.chatLockIndex} → ${after.chatLockIndex}`);
                if (after.autoSync             !== before.autoSync)             drift.push(`autoSync: ${before.autoSync} → ${after.autoSync}`);
                if (after.enabled              !== before.enabled)              drift.push(`enabled: ${before.enabled} → ${after.enabled}`);
                if (after.isLockedToChat       !== before.isLockedToChat)       drift.push(`isLockedToChat: ${before.isLockedToChat} → ${after.isLockedToChat}`);
                if (drift.length) {
                    console.error(`${TEST} [FAIL] ${label} mutated forbidden state:\n  - ${drift.join('\n  - ')}`);
                    return false;
                }
                return true;
            };

            // ═══ Phase 1 — refreshAutoSyncCheckbox ═══
            console.log(`${TEST} Phase 1: refreshAutoSyncCheckbox(settings) should not mutate locks/autoSync/enabled for any collection`);
            await refreshAutoSyncCheckbox(settings);
            const afterAS = snapshot();
            if (!compare(afterAS, 'refreshAutoSyncCheckbox')) return;
            console.log(`${TEST} Phase 1 ✓ refreshAutoSyncCheckbox is pure UI mirror — no lock state mutated`);

            // ═══ Phase 2 — idempotency (3× back-to-back) ═══
            console.log(`${TEST} Phase 2: 3× back-to-back refreshAutoSyncCheckbox calls — state still unchanged at the end`);
            for (let i = 0; i < 3; i++) {
                await refreshAutoSyncCheckbox(settings);
            }
            const afterRepeat = snapshot();
            if (!compare(afterRepeat, 'idempotency loop (3×)')) return;
            console.log(`${TEST} Phase 2 ✓ 3× idempotency: state byte-identical after 4 total refresh calls`);

            console.log(`${TEST} [PASS] AutoSync refresh path is a pure UI mirror — locks, character locks, chat_lock_index, autoSync, and enabled flags are all unchanged after refresh calls. The .trigger('change') footgun is not present.`);
        } finally {
            try {
                try { removeCollectionLock(registryKey, currentChatId); } catch (cleanupError) { console.warn('[e2e cleanup] removeCollectionLock failed:', cleanupError); }
                try { setCollectionAutoSync(registryKey, false); } catch (cleanupError) { console.warn('[e2e cleanup] setCollectionAutoSync failed:', cleanupError); }
                try { deleteCollectionMeta(registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] deleteCollectionMeta failed:', cleanupError); }
                try { unregisterCollection(registryKey); } catch (cleanupError) { console.warn('[e2e cleanup] unregisterCollection failed:', cleanupError); }
                try { unregisterCollection(collectionId); } catch (cleanupError) { console.warn('[e2e cleanup] unregisterCollection failed:', cleanupError); }
                console.log(`${TEST} Cleanup ✓ lock removed, autoSync cleared, meta deleted, registration unregistered`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 023 — Auto-sync settle/commit lag: re-rolls on the active turn
//             never extract; the kept turn extracts once superseded
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   Auto-sync fires on MESSAGE_SWIPED. Without the settle-lag, every swipe of
//   the latest AI reply rewrites .mes → new hash → new window fingerprint →
//   a fresh extraction, leaving one embedding per discarded generation.
//
//   The settle/commit lag (getCommitBoundary) holds the active last turn back:
//   the window-builder, the quick-exit, and the LED all evaluate against the
//   COMMITTED slice = messages minus the last auto-sync window. So a swipe on
//   the active turn changes only messages beyond the boundary → the committed
//   slice is unchanged → no re-extraction. Once the user sends a newer turn,
//   the previously-active turn falls inside the boundary and extracts exactly
//   once. See InternalProject/Vectfox/plans/executed/autosync-settle-lag.md.
//
// What it proves (using the SAME real functions the ingestion loop uses):
//   - getCommitBoundary holds back exactly one turn by default, none when off.
//   - A swipe on the active turn leaves the committed quick-exit "done" (no work).
//   - Superseding the turn flips the committed quick-exit to "work pending" so
//     the kept turn extracts.
test('TEST 023 — Auto-sync settle/commit lag: swipes on active turn never extract', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 023 [SettleLag]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCommitBoundary, getAutoSyncWindowSize } = await import(base + 'src/features/eventbase/eventbase-workflow.js');
        const { markWindowExtracted, isLastWindowExtracted, clearWindowCache } = await import(base + 'src/features/eventbase/eventbase-store.js');
        const { deleteCollectionMeta } = await import(base + 'src/features/collections/collection-metadata.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const testKey = 'qdrant:vf_eventbase_qdrant_playwright___vf_playwright_test_023__settle_lag';
        const windowSize = 2, step = 2;

        // 8-message chat (4 turns). hashes are arbitrary-but-stable per message.
        const messages = [
            { mes: 'human 0', name: 'You' }, { mes: 'ai 0', name: 'AI' },
            { mes: 'human 1', name: 'You' }, { mes: 'ai 1', name: 'AI' },
            { mes: 'human 2', name: 'You' }, { mes: 'ai 2', name: 'AI' },
            { mes: 'human 3', name: 'You' }, { mes: 'ai 3', name: 'AI' },
        ];
        const hashes = [100, 200, 300, 400, 500, 600, 700, 800];
        const hashFn = (m) => hashes[messages.indexOf(m)];

        try {
            // ═══ Phase 1 — boundary math: hold back exactly one turn ═══
            const chat6 = messages.slice(0, 6); // chat currently 6 messages (3 turns)
            const win = getAutoSyncWindowSize({});
            const boundary6 = getCommitBoundary(chat6, {});
            if (win !== 2) { console.error(`${TEST} [FAIL] Phase 1: auto-sync window=${win}, expected 2`); return; }
            if (boundary6 !== 4) { console.error(`${TEST} [FAIL] Phase 1: commitBoundary=${boundary6} for 6 msgs, expected 4 (last turn held)`); return; }
            if (getCommitBoundary(chat6, { eventbase_autosync_settle_lag: false }) !== 6) {
                console.error(`${TEST} [FAIL] Phase 1: lag-off boundary should equal full length 6`); return;
            }
            console.log(`${TEST} Phase 1 ✓ commitBoundary holds back exactly one turn (6→4), off→6`);

            // ═══ Phase 2 — committed windows extracted → quick-exit reports DONE ═══
            // The held-back turn [4-5] is intentionally NOT marked.
            markWindowExtracted([hashes[0], hashes[1]], testKey);
            markWindowExtracted([hashes[2], hashes[3]], testKey);
            const committed6 = chat6.slice(0, boundary6); // msgs 0..3
            if (!isLastWindowExtracted(committed6, windowSize, step, testKey, hashFn)) {
                console.error(`${TEST} [FAIL] Phase 2: committed quick-exit reports work pending, but all committed windows are marked → LED would stick yellow`); return;
            }
            console.log(`${TEST} Phase 2 ✓ committed slice fully extracted → quick-exit DONE (LED green)`);

            // ═══ Phase 3 — SWIPE the active last turn (msg 5) ═══
            // Re-roll rewrites the AI reply text → new hash. The active turn is
            // beyond the boundary, so the committed slice is untouched and no
            // re-extraction is triggered. This is the anti-duplicate property.
            messages[5] = { mes: 'ai 2 (re-rolled)', name: 'AI' };
            hashes[5] = 99999; // swipe → different hash
            const boundaryAfterSwipe = getCommitBoundary(messages.slice(0, 6), {});
            if (boundaryAfterSwipe !== 4) { console.error(`${TEST} [FAIL] Phase 3: boundary changed to ${boundaryAfterSwipe} after swipe, expected still 4`); return; }
            const committedAfterSwipe = messages.slice(0, 6).slice(0, boundaryAfterSwipe);
            if (!isLastWindowExtracted(committedAfterSwipe, windowSize, step, testKey, hashFn)) {
                console.error(`${TEST} [FAIL] Phase 3: swipe on the active turn flipped committed quick-exit to "work pending" — it would re-extract a discarded generation`); return;
            }
            console.log(`${TEST} Phase 3 ✓ swipe on active turn leaves committed slice unchanged → NO re-extraction`);

            // ═══ Phase 4 — SUPERSEDE: user sends the next turn (chat → 8 msgs) ═══
            // The previously-active turn [4-5] now falls inside the boundary and
            // must extract. Quick-exit on the new committed slice reports pending
            // because window [4-5] was never marked.
            const boundary8 = getCommitBoundary(messages, {});
            if (boundary8 !== 6) { console.error(`${TEST} [FAIL] Phase 4: commitBoundary=${boundary8} for 8 msgs, expected 6`); return; }
            const committed8 = messages.slice(0, boundary8); // msgs 0..5 — now includes the kept turn
            if (isLastWindowExtracted(committed8, windowSize, step, testKey, hashFn)) {
                console.error(`${TEST} [FAIL] Phase 4: after superseding, committed quick-exit reports DONE — the kept turn [4-5] would never extract`); return;
            }
            console.log(`${TEST} Phase 4 ✓ superseded turn now inside boundary → quick-exit reports the kept turn pending`);

            console.log(`${TEST} [PASS] Settle-lag holds the active turn: swipes never extract, the kept turn extracts once superseded`);
        } finally {
            try {
                clearWindowCache(testKey);
                const after = extension_settings?.vectfox?.collections?.[testKey]?.eventbaseProgress?.extractedWindows;
                deleteCollectionMeta(testKey);
                if (after !== undefined) console.warn(`${TEST} [WARN] clearWindowCache left a stale entry: ${JSON.stringify(after)}`);
                else console.log(`${TEST} Cleanup ✓ window record cleared for ${testKey}`);
            } catch (cleanupErr) { console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`); }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TESTS 024–026 — LLM-call path coverage (postChatCompletion)
// ═══════════════════════════════════════════════════════════════════
// TESTS 002–023 use SYNTHETIC inserts — they never touch the chat-completions
// wire path. These three exercise the real path introduced when the four LLM
// features (summarizer / EventBase / agentic / Auto-Reformat) were unified onto
// src/features/llm-provider/llm-provider-call.js (postChatCompletion + parseJsonArrayFromLlm):
//
//   024  EventBase LLM extraction — real provider round-trip + parse/validate
//   025  Auto-Reformat            — real provider, multi-entity split
//   026  Acronym glossary         — pure, deployed-module smoke (no LLM)
//
// 024/025 make REAL LLM calls (cost tokens + a few seconds each). They soft-
// SKIP when no summarization model is configured (Core → LLM Summarization),
// so a box without a chat model keeps the serial suite moving. 026 is
// deterministic and always runs.
// ═══════════════════════════════════════════════════════════════════

test('TEST 024 — EventBase LLM extraction: real provider round-trip (postChatCompletion)', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 024 [LLMExtract]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { extractEvents } = await import(base + 'src/features/eventbase/eventbase-extractor.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        // Real extraction needs a summarization model. Soft-skip (not fail) when
        // absent so the serial suite continues on boxes with no chat model set.
        const provider = (vf.chat_provider || 'openrouter').toLowerCase();
        const model = (vf.chat_model || '').trim();
        if (!model) { console.warn(`${TEST} [SKIP] no chat_model configured (Core → LLM Summarization) — cannot exercise real extraction`); return; }
        if (provider === 'vllm' && !(vf.chat_vllm_url || '').trim()) { console.warn(`${TEST} [SKIP] provider=vllm but no chat_vllm_url configured`); return; }

        // Synthetic 2-message window with two unmistakable events (a kill + an
        // item pickup) so any competent model yields ≥1 event regardless of tuning.
        const messages = [
            { name: 'Klein', is_user: true, mes: 'Klein drew his iron sword and charged the frost wolf blocking the Hollow Bridge, cutting it down after a brief, fierce struggle.' },
            { name: 'Narrator', is_user: false, mes: 'With the wolf dead, Klein pried a glowing Moonstone Shard loose from the ice where it had fallen and pocketed it.' },
        ];

        console.log(`${TEST} Extracting via real ${provider}/${model} (2-message window)...`);
        let events;
        try {
            events = await extractEvents({ messages, windowStart: 0, windowEnd: 1, settings: vf, windowIndex: 0 });
        } catch (err) {
            console.error(`${TEST} [FAIL] extractEvents threw (${provider}/${model}): ${err.message}`);
            return;
        }

        if (!Array.isArray(events)) { console.error(`${TEST} [FAIL] extractEvents did not return an array`); return; }
        if (events.length === 0) {
            console.error(`${TEST} [FAIL] 0 events for a window with two clear events — the postChatCompletion or parseJsonArrayFromLlm path may be broken`);
            return;
        }

        // Confirm the shared parse + schema-validate path produced well-formed records.
        const bad = events.find(e => !e.event_type || !e.summary || typeof e.importance !== 'number');
        if (bad) { console.error(`${TEST} [FAIL] event missing event_type/summary/importance: ${JSON.stringify(bad).slice(0, 200)}`); return; }

        events.slice(0, 5).forEach((e, i) => console.log(`  event[${i}] type="${e.event_type}" imp=${e.importance} summary="${(e.summary || '').slice(0, 60)}"`));
        console.log(`${TEST} [PASS] real ${provider} extraction via postChatCompletion → ${events.length} valid event(s)`);
    });
    assertPassed(logs);
});
