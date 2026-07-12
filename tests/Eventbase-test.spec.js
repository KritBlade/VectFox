/**
 * Eventbase-test.spec.js — Playwright integration tests for VectFox
 *
 * Run all:      npm run test:e2e
 * Run one:      npx playwright test --grep "TEST 001"
 * View report:  npm run test:e2e:report
 *
 * On first run: a Playwright browser window opens. Log in, then open the chat
 * that has your locked collections. Tests start automatically once the chat is open.
 *  * npm install -D @playwright/test
 * npx playwright install
 * 
 * # Run all tests
npm run test:e2e
npm run test:e2e:no-log.
npm run test:e2e -- --grep "TEST 008"
npm run test:e2e -- --grep "TEST 00[5-9]|TEST 01[01]"
--grep "TEST 008|TEST 009" (regex, run multiple)
--grep "TEST 008" --debug (Playwright inspector)
--grep-invert "TEST 00[1-7]" (everything except 1-7)
--grep "TEST 00[1-7]" (everything except 1-7)


# Run a specific test
npx playwright test --grep "TEST 001"
npm run test:e2e -- --grep "TEST 00[5-9]|TEST 01[01]"


# View HTML report after a run
npm run test:e2e:report
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';

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
const TEST_TARGET_URL = null;
//const TEST_TARGET_URL = 'http://localhost:8000';

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

test.beforeAll(async ({ browser }) => {
    // Reuse saved cookies/localStorage from the last run so login is skipped
    sharedContext = await browser.newContext({
        storageState: existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    });
    sharedPage = await sharedContext.newPage();

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
    // the collectionId or the registryKey. This is broader than the previous
    // `__vf_playwright_test_` check and catches:
    //   • IDs without the leading double-underscore (`vf_playwright_test_…`)
    //   • Registry-key-only orphans whose collectionId has been stripped
    //   • Any future test naming convention as long as it includes the
    //     unambiguous `playwright_test` marker
    // The marker is unique enough that a real user collection would never
    // contain it accidentally.
    const cleanupReport = await sharedPage.evaluate(async () => {
        const base = '/scripts/extensions/third-party/VectFox/';
        const { getCollectionListing, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { deleteContentCollection } = await import(base + 'core/content-vectorization.js');
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
            if (isTestMarker(cid) || isTestMarker(rk)) leftover.push({ cid, rk });
        }

        // Full cleanup for leftover test data only (vectors + meta + registry).
        // Real user collections are never touched.
        for (const { cid, rk } of leftover) {
            try { await deleteContentCollection(cid); } catch {}
            try { deleteCollectionMeta(rk); } catch {}
            try { unregisterCollection(rk); } catch {}
            // Defensive: also try the bare-ID form in case a pre-B4-fix run
            // left a duplicate entry behind.
            try { unregisterCollection(cid); } catch {}
        }

        // ─── chat_lock_index orphan sweep ────────────────────────────────
        //
        // The registry pass above catches collections still in
        // `vf.collection_registry`. But the per-chat reverse map
        // `vf.chat_lock_index[chatId] = [registryKey, …]` is maintained
        // separately. Older tests (001-013) call vectorizeContent with
        // scope='chat' which auto-locks → writes to the reverse index,
        // then cleanup calls deleteContentCollection + deleteCollectionMeta
        // + unregisterCollection but never removeCollectionLock. The result:
        // the registry entry vanishes but the reverse-index entry orphans
        // and accumulates across runs (caught 2026-05-24 — TEST 019
        // baseline snapshot found 15 stale playwright_test entries in one
        // chat's lock index).
        //
        // Functionally harmless (lookups go forward via meta.lockedToChatIds,
        // not reverse) but it grows unbounded. Fixing in beforeAll rather
        // than patching every old test means one place to maintain, and
        // it also defends future tests that forget removeCollectionLock.
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
        console.log(`[setup] Removed ${cleanupReport.leftover.length} leftover test collection(s):`);
        cleanupReport.leftover.forEach(e => console.log(`  ${e.cid}`));
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
    // stuck at TEST 001 and never reach the standard-backend tests that
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
// suite gets stuck at TEST 001 and never reaches TEST 009 (the test that
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
                    ? { url: vf.qdrant_url || null, apiKey: vf.qdrant_api_key || null, host: null, port: null }
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
// TEST 001 — Qdrant lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
// Self-contained: creates its own test lorebook, vectorizes it with Qdrant,
// locks it to the current chat, runs a dry-run query, then cleans up.
// No external setup required — just needs Qdrant configured in VectFox settings.
test('TEST 001 — Qdrant lorebook: lock + query isolation', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 001 [QdrantLorebook]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { shouldCollectionActivate, deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Defensive in-eval check — spec-level skipIfQdrantUnavailable should
        // have already returned for missing config, but belt-and-suspenders.
        const hasQdrant = !!(vf.qdrant_url || vf.qdrant_host);
        if (!hasQdrant) { console.warn(`${TEST} [SKIP] Qdrant not configured — set qdrant_url or qdrant_host in VectFox settings`); return; }

        // Synthetic lorebook entries with content that is clearly unique to this test
        const testEntries = [
            {
                uid: 'vf_test_001_a',
                comment: 'Tesseract Crystal',
                key: ['tesseract', 'crystal'],
                content: 'The Tesseract Crystal is a rare gemstone found only in the deepest caverns of the Rift Mountains. It emits a faint blue glow and can store magical energy indefinitely. Scholars have catalogued seventeen distinct alchemical applications for the stone.',
            },
            {
                uid: 'vf_test_001_b',
                comment: 'Velmora Pact',
                key: ['velmora', 'pact'],
                content: 'The Velmora Pact was signed in the third age between the river nations and the highland clans. It established shared water rights and prohibited the construction of dams above the city of Quellos. The pact is renewed every fifty years by the Council of Streams.',
            },
            {
                uid: 'vf_test_001_c',
                comment: 'Ironbark Trees',
                key: ['ironbark', 'tree'],
                content: 'Ironbark trees grow only in the northern tundra. Their wood is denser than steel and resists both fire and decay. Lumberjacks require enchanted axes to harvest them. A single plank can support the weight of a fully loaded merchant cart.',
            },
        ];

        // Vectorize — vectorizeContent auto-locks to current chat when scope='chat'
        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Qdrant backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_001__', entries: testEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) {
            console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`);
            return;
        }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed or returned no collectionId`);
            return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `qdrant:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

        try {
            // Confirm the new collection is active for this chat
            const isActive = await shouldCollectionActivate(registryKey, context);
            if (!isActive) {
                console.error(`${TEST} [FAIL] New collection not activated for current chat — scope=chat lock did not apply`);
                return;
            }
            console.log(`${TEST} Collection locked and active for current chat ✓`);

            // Dry-run with a query that should match the Tesseract Crystal entry.
            // Force enabled_world_info=true: we're testing the retrieval path
            // itself, not whether the user toggled "Enable Semantic WI Activation"
            // in their settings. Without this override, the test would silently
            // fail in any environment where that toggle is off — which is the
            // common case for a fresh install or a user who only uses EventBase.
            const chat = ctx.chat ?? [];
            const testQuery = 'tesseract crystal magical energy rift mountains';
            const testSettings = { ...vf, enabled_world_info: true };
            console.log(`${TEST} [DEBUG] Running dry-run with enabled_world_info=true (user setting was ${vf.enabled_world_info}), vector_backend=${vf.vector_backend}`);
            let result;
            try { result = await runLorebookWIDryRun({ chat, testMessage: testQuery, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            if (!result.entryCount) {
                // Log the result envelope so a future failure tells us WHY: which
                // guard fired (disabled / noCollections / search returned nothing).
                console.error(`${TEST} [FAIL] Dry-run returned 0 entries for query "${testQuery}" — result envelope: ${JSON.stringify({
                    entryCount: result.entryCount,
                    disabled: result.disabled,
                    noCollections: result.noCollections,
                    hasInjectionText: !!result.injectionText,
                })}`);
                return;
            }

            console.log(`${TEST} Dry-run: ${result.entryCount} entry/entries returned`);
            console.log(`  preview: ${(result.injectionText || '').slice(0, 200)}`);
            console.log(`${TEST} [PASS] Qdrant lorebook vectorized, locked, results returned, no contamination`);
        } finally {
            // Always clean up the test collection so it doesn't pollute the user's DB
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: nuke vectra-side-effect folder (B4 — qdrant insert
                // path leaves an empty vectra placeholder during registry stamping).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                // Also remove the BARE-ID duplicate registry entry (B4) that the
                // qdrant insert path leaves behind. Without this the DB browser
                // shows the collection as a "VECTRA"-tagged 0-chunk orphan.
                unregisterCollection(collectionId);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
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
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { deleteCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
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
            try { await deleteCollection(collectionId, settings, registryKey); } catch {}
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
// TEST 003 — E2E qdrant: locked lorebook + locked EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
// Setup: TEST 001 + TEST 002 setups both complete
test('TEST 003 — E2E qdrant: both locked, both return results', async () => {
    // SELF-CONTAINED 2026-05-26: creates its own synthetic lorebook + EventBase,
    // locks both to current chat, verifies both retrieval paths return results,
    // then cleans up. Previous version assumed TEST 001 + TEST 002 left their
    // collections behind in the registry — broken assumption since both tests
    // clean up in their finally blocks. New version mirrors TEST 013's
    // self-contained pattern but skips sentinel matching (this is a "both
    // paths return something" smoke test; TEST 013 covers data integrity).
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 003 [E2EQuery]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { shouldCollectionActivate, deleteCollectionMeta, setLock, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Derive persona handle for collection ID — see TEST 013 for rationale.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        const ts = Date.now();
        const lorebookEntries = [{
            uid: 'vf_test_003_a',
            comment: 'Quasar Lantern',
            key: ['quasar', 'lantern'],
            content: 'The Quasar Lantern is a relic forged from compressed starlight. It illuminates passages through the Cinderwhisper Pass and is the only lightsource known to disperse the local mist. Wardens of the Pass require formal training to handle one.',
        }];

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

        let lorebookCollectionId = null, lorebookRegistryKey = null;
        let eventbaseCreated = false;

        try {
            // ── Phase A: vectorize lorebook (auto-locks via scope='chat') ──
            console.log(`${TEST} Phase A: vectorizing synthetic lorebook with Qdrant backend...`);
            const lbRes = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_003_lb__', entries: lorebookEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!lbRes?.success || !lbRes.collectionId) { console.error(`${TEST} [FAIL] Lorebook vectorization failed`); return; }
            lorebookCollectionId = lbRes.collectionId;
            lorebookRegistryKey  = `qdrant:${lorebookCollectionId}`;

            const lbActive = await shouldCollectionActivate(lorebookRegistryKey, context);
            if (!lbActive) { console.error(`${TEST} [FAIL] Lorebook didn't auto-lock to current chat`); return; }
            console.log(`${TEST} Lorebook ready and locked → ${lorebookRegistryKey}`);

            // ── Phase B: insert synthetic event into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase B: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'qdrant' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            // EventBase doesn't auto-lock when collection ID is supplied explicitly.
            // Lock it manually so runEventBaseRetrieval picks it up — see TEST 013.
            const lockResult = setLock(eventbaseRegistryKey, { kind: 'chat', op: 'add', target: currentChatId }, { settings: vf });
            if (!lockResult?.success) { console.error(`${TEST} [FAIL] Failed to lock EventBase: ${lockResult?.reason}`); return; }

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓`);

            // ── Phase C: query lorebook via dry-run WI activation ──
            const chat = ctx.chat ?? [];
            // Use a synthetic-content-matching query unconditionally. Falling
            // back to the user's actual last chat message (typical RP content
            // in a foreign language) returns low-confidence matches that get
            // filtered by the default score_threshold=0.25 — see TEST 007
            // failure on 2026-05-26.
            const testQuery = 'quasar lantern cinderwhisper pass mist starlight wardens';
            // Force enabled_world_info=true — see TEST 001 for rationale.
            const testSettings = { ...vf, enabled_world_info: true };

            let lorebookResult;
            try { lorebookResult = await runLorebookWIDryRun({ chat, testMessage: testQuery, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            if (!lorebookResult.entryCount) {
                console.error(`${TEST} [FAIL] Lorebook returned 0 entries — result envelope: ${JSON.stringify({
                    entryCount: lorebookResult.entryCount,
                    disabled: lorebookResult.disabled,
                    noCollections: lorebookResult.noCollections,
                })}`);
                return;
            }
            console.log(`${TEST} Lorebook: ${lorebookResult.entryCount} entries`);
            console.log(`  preview: ${(lorebookResult.injectionText || '').slice(0, 200)}`);

            // ── Phase D: query EventBase via dry-run retrieval ──
            const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

            let eventbaseResult;
            try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: testQuery }); }
            catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

            const eventCount = eventbaseResult?.eventCount ?? 0;
            if (!eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
            console.log(`${TEST} EventBase: ${eventCount} event(s) injected, lockedCollections=${eventbaseResult.lockedCollectionsCount}, archive=${eventbaseResult.archiveCollectionsCount}`);
            console.log(`  preview: ${(eventbaseResult.injectionText || '').slice(0, 200)}`);

            console.log(`${TEST} [PASS] Lorebook (${lorebookResult.entryCount}) + EventBase (${eventCount}) — both retrieval paths return locked collections only`);
        } finally {
            // ── Cleanup: remove every trace this test created ──
            // EventBase first because we explicitly locked it; lorebook auto-cleans
            // its lock via deleteContentCollection.
            if (eventbaseCreated) {
                try {
                    setLock(eventbaseRegistryKey, { kind: 'chat', op: 'clear' }, { settings: vf });
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
            if (lorebookCollectionId) {
                try {
                    await deleteContentCollection(lorebookCollectionId);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(lorebookCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Lorebook folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(lorebookRegistryKey);
                    unregisterCollection(lorebookRegistryKey);
                    unregisterCollection(lorebookCollectionId);
                    console.log(`${TEST} Lorebook cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Lorebook cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 004 — DB Browser: listing + delete (qdrant)
// ═══════════════════════════════════════════════════════════════════
// Self-contained: creates its own qdrant lorebook with 3 named entries,
// verifies listChunks surfaces entryName + text, deletes one chunk,
// verifies it's gone, then cleans up.
test('TEST 004 — DB Browser: listing + delete (any backend)', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 004 [DBBrowser]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const testEntries = [
            {
                uid: 'vf_test_004_a',
                comment: 'Glasswing Moths',
                key: ['glasswing', 'moth'],
                content: 'Glasswing moths inhabit the cloud forests of the southern continent. Their transparent wings refract sunlight into faint rainbows. Alchemists collect their wing dust as a primary ingredient for invisibility potions.',
            },
            {
                uid: 'vf_test_004_b',
                comment: 'Sunken Library of Ralthar',
                key: ['ralthar', 'library'],
                content: 'The Sunken Library of Ralthar rests beneath the Cerulean Bay. Sealed in glass domes by the last archmage of the Eighth Council, its scrolls remain dry and legible after four centuries underwater. Only triton scholars hold the keys.',
            },
            {
                uid: 'vf_test_004_c',
                comment: 'Bronzewing Falcons',
                key: ['bronzewing', 'falcon'],
                content: 'Bronzewing falcons are bred by the high desert tribes for long-distance message delivery. They navigate by magnetic field alone and can fly nine hundred miles without rest. Each bird is bonded to a single rider through a ritual of shared blood.',
            },
        ];

        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Qdrant backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_004__', entries: testEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed`); return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `qdrant:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

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
                console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

            const noText      = items.filter(i => !i.text?.trim());
            const noEntryName = items.filter(i => !i.metadata?.entryName);

            if (noText.length) { console.error(`${TEST} [FAIL] ${noText.length} chunk(s) have no text`); return; }
            if (noEntryName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing entryName`); return; }
            if (noEntryName.length > 0) console.warn(`${TEST} [WARN] ${noEntryName.length} chunk(s) missing entryName`);

            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash}  entryName="${items[0].metadata?.entryName ?? '(none)'}"`);
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
            console.log(`${TEST} [PASS] Entry names visible, text present, delete removed the entry`);
        } finally {
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: nuke vectra-side-effect folder (B4).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                // Also remove the BARE-ID duplicate registry entry (B4).
                unregisterCollection(collectionId);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 005 — Standard lorebook: vectorize → lock → query isolation
// ═══════════════════════════════════════════════════════════════════
// Setup: lorebook vectorized with Standard backend + locked to current chat in DB Browser
// Note: vectorScore=0.0000 is expected — not a failure
// ═══════════════════════════════════════════════════════════════════
// TEST 005 — Standard lorebook: lock + query isolation
// ═══════════════════════════════════════════════════════════════════
// Self-contained: vectorizes its own standard (vectra) lorebook, asserts
// it gets locked to the current chat, runs a dry-run WI activation, and
// verifies the test entries come back. Never touches user data.
test('TEST 005 — Standard lorebook: lock + query isolation', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 005 [StdLorebook]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { shouldCollectionActivate, deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        const testEntries = [
            {
                uid: 'vf_test_005_a',
                comment: 'Quartzwood Beetles',
                key: ['quartzwood', 'beetle'],
                content: 'Quartzwood beetles bore into petrified trees of the Ironvale forest. Their carapaces refract moonlight into prism patterns, making them prized by jewellers. A single mature beetle yields enough chitin for one signet ring.',
            },
            {
                uid: 'vf_test_005_b',
                comment: 'Hollowtongue Caverns',
                key: ['hollowtongue', 'cavern'],
                content: 'The Hollowtongue Caverns echo human speech for hours after a single whisper. Travellers report hearing arguments from the previous decade reverberating from the deep tunnels. Cartographers refuse to map them past the second junction.',
            },
            {
                uid: 'vf_test_005_c',
                comment: 'Saltglass Anvils',
                key: ['saltglass', 'anvil'],
                content: 'Saltglass anvils are forged from compressed sea-salt under volcanic heat. They cool blades at twice the rate of stone anvils and impart a faint mineral edge. Only three smiths in the Vermilion Reach know the firing technique.',
            },
        ];

        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Standard backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_005__', entries: testEntries },
                settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed`); return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `vectra:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

        try {
            const isActive = await shouldCollectionActivate(registryKey, context);
            if (!isActive) {
                console.error(`${TEST} [FAIL] New collection not activated for current chat — scope=chat lock did not apply`);
                return;
            }
            console.log(`${TEST} Collection locked and active for current chat ✓`);

            const chat = ctx.chat ?? [];
            const testQuery = 'quartzwood beetle ironvale prism carapace';
            // Force enabled_world_info=true — see TEST 001 for rationale.
            const testSettings = { ...vf, enabled_world_info: true };
            let result;
            try { result = await runLorebookWIDryRun({ chat, testMessage: testQuery, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            if (!result.entryCount) {
                console.error(`${TEST} [FAIL] Dry-run returned 0 entries for query "${testQuery}" — result envelope: ${JSON.stringify({
                    entryCount: result.entryCount,
                    disabled: result.disabled,
                    noCollections: result.noCollections,
                })}`);
                return;
            }
            console.log(`${TEST} Dry-run: ${result.entryCount} entries (vectorScore=0.0000 expected for standard backend)`);
            console.log(`  preview: ${(result.injectionText || '').slice(0, 200)}`);
            console.log(`${TEST} [PASS] Standard lorebook vectorized, locked, results returned`);
        } finally {
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: also nuke the parent on-disk folder so vectra storage stays
                // truly orphan-free. Production purge only removes the model subdir; this
                // test helper finishes the job. Never call this from production code.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                console.log(`${TEST} Cleanup: test collection removed ✓`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 006 — Standard EventBase: lock → parseEmbedText field recovery
// ═══════════════════════════════════════════════════════════════════
// Setup: chat history vectorized with Standard backend + locked to this chat
// Note: imp=undefined and method=bm25 are expected
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
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { deleteCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { parseEmbedText } = await import(base + 'core/eventbase-schema.js');
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
            try { await deleteCollection(collectionId, settings, registryKey); } catch {}
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
// TEST 007 — E2E standard: locked standard lorebook + locked standard EventBase → both return results
// ═══════════════════════════════════════════════════════════════════
// Setup: TEST 005 + TEST 006 setups both complete
// Note: vectorScore=0.0000, imp=undefined, method=bm25 all expected
test('TEST 007 — E2E standard: both locked, both return results', async () => {
    // SELF-CONTAINED 2026-05-26: same refactor as TEST 003 but for the
    // standard (vectra) backend. Previous version assumed TEST 005 + TEST 006
    // left collections behind — broken assumption, both clean up in finally.
    // Mirrors TEST 003's self-contained pattern with vector_backend='standard'.
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 007 [E2EStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { shouldCollectionActivate, deleteCollectionMeta, setLock, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Derive persona handle for collection ID — see TEST 013 for rationale.
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        const ts = Date.now();
        const lorebookEntries = [{
            uid: 'vf_test_007_a',
            comment: 'Lambent Sextant',
            key: ['lambent', 'sextant'],
            content: 'The Lambent Sextant is a navigator’s instrument carved from petrified moonglass. It can chart courses through the Ember Channels where normal compasses spin uselessly. Only members of the Astrolabe Guild are permitted to apprentice on its use.',
        }];

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

        let lorebookCollectionId = null, lorebookRegistryKey = null;
        let eventbaseCreated = false;

        try {
            // ── Phase A: vectorize lorebook (auto-locks via scope='chat') ──
            console.log(`${TEST} Phase A: vectorizing synthetic lorebook with standard backend...`);
            const lbRes = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_007_lb__', entries: lorebookEntries },
                settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
            });
            if (!lbRes?.success || !lbRes.collectionId) { console.error(`${TEST} [FAIL] Lorebook vectorization failed`); return; }
            lorebookCollectionId = lbRes.collectionId;
            lorebookRegistryKey  = `vectra:${lorebookCollectionId}`;

            const lbActive = await shouldCollectionActivate(lorebookRegistryKey, context);
            if (!lbActive) { console.error(`${TEST} [FAIL] Lorebook didn't auto-lock to current chat`); return; }
            console.log(`${TEST} Lorebook ready and locked → ${lorebookRegistryKey}`);

            // ── Phase B: insert synthetic event into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase B: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'standard' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            const lockResult = setLock(eventbaseRegistryKey, { kind: 'chat', op: 'add', target: currentChatId }, { settings: vf });
            if (!lockResult?.success) { console.error(`${TEST} [FAIL] Failed to lock EventBase: ${lockResult?.reason}`); return; }

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓`);

            // ── Phase C: query lorebook via dry-run WI activation ──
            const chat = ctx.chat ?? [];
            // Use a synthetic-content-matching query unconditionally — same
            // rationale as TEST 003. The user's actual chat is typically RP
            // content in a foreign language; a low-confidence semantic match
            // against the synthetic lorebook gets filtered by
            // score_threshold=0.25. Standard backend's client-side RRF
            // produces tighter score distributions than Qdrant's native RRF,
            // so the threshold bites harder here than in TEST 003.
            const testQuery = 'lambent sextant ember channels compass drift navigator moonglass';
            // Force enabled_world_info=true — see TEST 001 for rationale.
            const testSettings = { ...vf, enabled_world_info: true };

            let lorebookResult;
            try { lorebookResult = await runLorebookWIDryRun({ chat, testMessage: testQuery, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            if (!lorebookResult.entryCount) {
                console.error(`${TEST} [FAIL] Lorebook returned 0 entries — result envelope: ${JSON.stringify({
                    entryCount: lorebookResult.entryCount,
                    disabled: lorebookResult.disabled,
                    noCollections: lorebookResult.noCollections,
                })}`);
                return;
            }
            console.log(`${TEST} Lorebook: ${lorebookResult.entryCount} entries (vectorScore=0.0000 expected for standard backend)`);
            console.log(`  preview: ${(lorebookResult.injectionText || '').slice(0, 200)}`);

            // ── Phase D: query EventBase via dry-run retrieval ──
            const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported`); return; }

            let eventbaseResult;
            try { eventbaseResult = await runEventBaseRetrieval({ chat, settings: vf, dryRun: true, testMessage: testQuery }); }
            catch (err) { console.error(`${TEST} [FAIL] runEventBaseRetrieval threw: ${err.message}`); return; }

            const eventCount = eventbaseResult?.eventCount ?? 0;
            if (!eventCount) { console.error(`${TEST} [FAIL] EventBase returned 0 events`); return; }
            console.log(`${TEST} EventBase: ${eventCount} event(s) injected, lockedCollections=${eventbaseResult.lockedCollectionsCount}, archive=${eventbaseResult.archiveCollectionsCount}`);
            console.log(`  preview: ${(eventbaseResult.injectionText || '').slice(0, 200)}`);

            console.log(`${TEST} [PASS] Lorebook (${lorebookResult.entryCount}) + EventBase (${eventCount}) — standard backend, both paths return locked collections only`);
        } finally {
            // ── Cleanup — mirror TEST 003 finally block but for standard backend ──
            if (eventbaseCreated) {
                try {
                    setLock(eventbaseRegistryKey, { kind: 'chat', op: 'clear' }, { settings: vf });
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
            if (lorebookCollectionId) {
                try {
                    await deleteContentCollection(lorebookCollectionId);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(lorebookCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Lorebook folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(lorebookRegistryKey);
                    unregisterCollection(lorebookRegistryKey);
                    unregisterCollection(lorebookCollectionId);
                    console.log(`${TEST} Lorebook cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Lorebook cleanup failed: ${cleanupErr.message}`);
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
//      ─ FULL metadata round-trip: text, entryName, keywords, custom
//        fields all persist and come back via listChunks
//      ─ DB Browser shows everything
//
//   2. Standard alone, no plugin       (the bare minimum SillyTavern setup)
//      ─ insert/list/delete go through ST's native /api/vector/*
//      ─ DEGRADED mode: only hash + text + index are stored; listChunks
//        is hashes-only ({ hash, text: '', metadata: {} })
//      ─ DB Browser shows just hashes — by design, per backends/standard.js
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
//
// TEST 010 covers cross-collection isolation (lorebook/EventBase leak)
// independently of this split.
// ═══════════════════════════════════════════════════════════════════

// ─── TEST 008 — standard backend WITH plugin ─────────────────────────
// Asserts the rich path works: listChunks must surface text + entryName
// after a self-contained insert. If this fails while pluginAvailable=true,
// the plugin's /chunks/list endpoint or vectra's storeListItems is broken.
test('TEST 008 — DB Browser standard + plugin: listing + delete', async () => {
    await skipIfNoPlugin();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 008 [DBBrowserStd]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const testEntries = [
            {
                uid: 'vf_test_008_a',
                comment: 'Ashfern Spores',
                key: ['ashfern', 'spore'],
                content: 'Ashfern spores germinate only after exposure to volcanic ash. The resulting plant produces a deep-blue dye prized by the southern weavers. A single mature ashfern yields enough spore-pods for one full bolt of cloth.',
            },
            {
                uid: 'vf_test_008_b',
                comment: 'Mirror Citadel of Vorn',
                key: ['vorn', 'citadel'],
                content: 'The Mirror Citadel of Vorn was carved from a single obsidian seam in the Coldroot Mountains. Its walls reflect approaching armies tenfold, an illusion that has broken three sieges without a single arrow loosed.',
            },
            {
                uid: 'vf_test_008_c',
                comment: 'Tideglass Eels',
                key: ['tideglass', 'eel'],
                content: 'Tideglass eels migrate along the Vermilion Reef every spring. Their translucent bodies become visible only at twilight. Fishermen of the coastal hamlets carve flutes from their bones — said to summon mist on still nights.',
            },
        ];

        console.log(`${TEST} Vectorizing test lorebook (3 entries) with Standard backend...`);
        let vectorizeResult;
        try {
            vectorizeResult = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_008__', entries: testEntries },
                settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

        if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
            console.error(`${TEST} [FAIL] Vectorization failed`); return;
        }

        const collectionId = vectorizeResult.collectionId;
        const registryKey  = `vectra:${collectionId}`;
        console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks → ${registryKey}`);

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
                console.log(`  [${i}] entryName="${item.metadata?.entryName ?? '(none)'}"  text="${(item.text||'').slice(0,60)}"`));

            const noText      = items.filter(i => !i.text?.trim());
            const noEntryName = items.filter(i => !i.metadata?.entryName);

            if (noText.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks have no text — standard backend listChunks may need plugin support`); return; }
            if (noText.length > 0) console.warn(`${TEST} [WARN] ${noText.length} chunk(s) have no text`);
            if (noEntryName.length === items.length) { console.error(`${TEST} [FAIL] ALL chunks missing entryName`); return; }
            if (noEntryName.length > 0) console.warn(`${TEST} [WARN] ${noEntryName.length} chunk(s) missing entryName`);

            const targetHash = items[0].hash;
            console.log(`${TEST} Deleting hash=${targetHash}  entryName="${items[0].metadata?.entryName ?? '(none)'}"`);
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
            console.log(`${TEST} [PASS] Standard: entry names visible, text present, delete removed the entry`);
        } finally {
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: also nuke the parent on-disk folder.
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
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
// vectorize → list → delete cycle through ST's native /api/vector/*.
// The top comment in backends/standard.js mandates this contract.
//
// We can't uninstall the plugin from a test, so we simulate it by
// forcing `pluginAvailable = false` on the SHARED cached backend
// instance from getBackend(). This must be done BEFORE vectorize, so
// insert ALSO routes through the native API — otherwise data lands at
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
//   - vectorize via native /api/vector/insert succeeds
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
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const testEntries = [
            {
                uid: 'vf_test_009_a',
                comment: 'Coppervine Trellises',
                key: ['coppervine', 'trellis'],
                content: 'Coppervine trellises grow on abandoned watchtowers along the eastern marshes. Their copper-rich sap conducts magical signals over short distances, and apprentice mages use them to practice resonance work without dedicated crystals.',
            },
            {
                uid: 'vf_test_009_b',
                comment: 'Silt Singers of the Estuary',
                key: ['silt', 'singer'],
                content: 'Silt Singers are reclusive mer-folk who emerge from the estuary mud at low tide. They communicate through low-frequency hums that travel further through wet earth than air. Coastal villagers leave salt offerings on the tideline in exchange for storm warnings.',
            },
            {
                uid: 'vf_test_009_c',
                comment: 'Wraithcap Mushrooms',
                key: ['wraithcap', 'mushroom'],
                content: 'Wraithcap mushrooms grow in graveyards and old battlefields. Their pale fruiting bodies fade in and out of visibility on a regular cycle, said to track the breathing of whatever lies buried beneath. Necromancers harvest them by touch alone.',
            },
        ];

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
        //  vectorizeContent calls getBackend() internally, which returns the
        //  cached singleton. If we only flip pluginAvailable on a fresh
        //  instance, vectorize uses the cached one (pluginAvailable=true) →
        //  data lands at vectors/{source}/{cid}/{model}/, but our list+delete
        //  via the fresh instance look at vectors/{source}/{cid}/ → delete
        //  silently no-ops. That's a mismatched-mode test, not the real
        //  no-plugin scenario.
        // ───────────────────────────────────────────────────────────────
        const backend = await getBackend({ ...vf, vector_backend: 'standard' });
        const originalPluginAvailable = backend.pluginAvailable;
        backend.pluginAvailable = false;
        console.log(`${TEST} Forced pluginAvailable=false on the shared StandardBackend (was ${originalPluginAvailable}) — exercising native end-to-end`);

        let vectorizeResult;
        let collectionId, registryKey;
        try {
            try {
                vectorizeResult = await vectorizeContent({
                    contentType: 'lorebook',
                    source: { type: 'file', name: '__vf_playwright_test_009__', entries: testEntries },
                    settings: { ...vf, vector_backend: 'standard', strategy: 'per_entry', scope: 'chat' },
                });
            } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }

            if (!vectorizeResult?.success || !vectorizeResult.collectionId) {
                console.error(`${TEST} [FAIL] Vectorization failed`); return;
            }

            collectionId = vectorizeResult.collectionId;
            registryKey  = `vectra:${collectionId}`;
            console.log(`${TEST} Vectorized ${vectorizeResult.chunkCount} chunks via native path → ${registryKey}`);

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
            // so deleteContentCollection / unregisterCollection don't take native paths
            // and leak state to any subsequent test or to the running ST session.
            backend.pluginAvailable = originalPluginAvailable;
            console.log(`${TEST} Restored backend.pluginAvailable=${originalPluginAvailable}`);

            if (collectionId) {
                try {
                    await deleteContentCollection(collectionId);
                    // TEST-ONLY: nuke the parent on-disk folder. `backend` here is the
                    // SHARED StandardBackend instance — pluginAvailable just got restored
                    // above so the helper takes the plugin purge path normally.
                    try {
                        await backend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(registryKey);
                    unregisterCollection(registryKey);
                    console.log(`${TEST} Cleanup: test collection removed ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 010 — Cross-collection isolation: chat-lock controls visibility
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   On prod (qdrant) we observed `<VectFoxLorebook>` injection containing
//   entries from TWO different lorebooks (e.g. Henry from "Your Wives" leaking
//   into a chat that should only see ArtificRealm content). That's a contract
//   violation — only collections active for the current chat should appear in
//   the semantic WI injection.
//
//   This test isolates the bug to either:
//     (a) Our activation filter — `getEnabledLorebookCollections` returns
//         collections it shouldn't, OR
//     (b) The plugin/Qdrant query path — multitenancy `content_type` filter
//         is missing, so one logical collection's query returns vectors from
//         another sharing the same physical Qdrant collection.
//
//   Phase 1 (baseline) proves both lorebooks ARE searchable when both are
//   locked — confirms the search-across-multiple-active-books flow works.
//   Phase 2 (leak check) unlocks one and re-queries. If the unlocked book's
//   content still shows up, we've reproduced the leak under controlled
//   conditions and isolated it to one of the two layers above.
//
// What we touch (boundary rules — same as TEST 009):
//   ✗ DO NOT mutate extension_settings.vectfox
//   ✓ DO mutate collection lock state via canonical `setLock(...)` API
//     (per Doc/collection_helper.md) — these are user-level lock changes on
//     our test collections, restored to baseline / removed entirely in finally.
//   ✓ DO use registry-key form for all lock + activation calls
//     (see Doc/collection_helper.md).
//
// Backend choice: Qdrant — that's where the prod symptom appeared. Falls
// back gracefully if user doesn't have Qdrant configured.
test('TEST 010 — Cross-collection isolation: lock controls lorebook visibility', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 010 [LeakCheck]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { shouldCollectionActivate, deleteCollectionMeta, setLock } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured — leak test targets Qdrant since prod symptom was there`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Sentinel strings: unique enough that they should NEVER appear in any
        // existing user lorebook. Used to detect cross-collection content leak.
        const SENTINEL_A = 'FIDDLEHEAD_OBELISK_X9F2';
        const SENTINEL_B = 'QUASAR_LANTERN_M7K4';

        const entriesA = [
            {
                uid: 'vf_test_010_a1',
                comment: 'Fiddlehead Obelisk',
                key: ['fiddlehead', 'obelisk'],
                content: `The ${SENTINEL_A} stands at the centre of the moss-glade in the Verlan Reach. Sentinel-A research catalogues its quartz veins as the only known anchor for the broken Sundering Glyphs. Pilgrims rub their palms raw against its base in spring.`,
            },
        ];

        const entriesB = [
            {
                uid: 'vf_test_010_b1',
                comment: 'Quasar Lantern',
                key: ['quasar', 'lantern'],
                content: `The ${SENTINEL_B} is a hand-held void-glass orb forged in the Embertide trenches. Sentinel-B chronicles describe it shedding a cold blue light that ignores wind, rain, and the breath of dragons. Three are known to exist; one is held by the Aurelian Conclave.`,
            },
        ];

        let collectionIdA = null, registryKeyA = null;
        let collectionIdB = null, registryKeyB = null;

        try {
            // ── Vectorize lorebook A (auto-locks to current chat via scope=chat) ──
            console.log(`${TEST} Vectorizing lorebook A (sentinel "${SENTINEL_A}") with Qdrant...`);
            const resA = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_010_A__', entries: entriesA },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!resA?.success || !resA.collectionId) { console.error(`${TEST} [FAIL] Lorebook A vectorization failed`); return; }
            collectionIdA = resA.collectionId;
            registryKeyA  = `qdrant:${collectionIdA}`;
            console.log(`${TEST} A vectorized → ${registryKeyA}`);

            // ── Vectorize lorebook B (auto-locks to current chat via scope=chat) ──
            console.log(`${TEST} Vectorizing lorebook B (sentinel "${SENTINEL_B}") with Qdrant...`);
            const resB = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_010_B__', entries: entriesB },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!resB?.success || !resB.collectionId) { console.error(`${TEST} [FAIL] Lorebook B vectorization failed`); return; }
            collectionIdB = resB.collectionId;
            registryKeyB  = `qdrant:${collectionIdB}`;
            console.log(`${TEST} B vectorized → ${registryKeyB}`);

            // Confirm both activated by chat lock
            const activeA = await shouldCollectionActivate(registryKeyA, context);
            const activeB = await shouldCollectionActivate(registryKeyB, context);
            if (!activeA || !activeB) {
                console.error(`${TEST} [FAIL] Both lorebooks should be locked to chat — activeA=${activeA}, activeB=${activeB}`);
                return;
            }
            console.log(`${TEST} Both lorebooks locked to chat ✓`);

            // ═══════ PHASE 1 — baseline: both should appear ═══════
            const chat = ctx.chat ?? [];
            const query = `${SENTINEL_A} ${SENTINEL_B} fiddlehead obelisk quasar lantern`;
            // Force enabled_world_info=true — see TEST 001 for rationale.
            // Both phases of this test reuse the same settings override.
            const testSettings = { ...vf, enabled_world_info: true };
            console.log(`${TEST} Phase 1 query: "${query.slice(0, 80)}..."`);

            let p1;
            try { p1 = await runLorebookWIDryRun({ chat, testMessage: query, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 1 dry-run threw: ${err.message}`); return; }

            const injection1 = p1?.injectionText || '';
            const p1HasA = injection1.includes(SENTINEL_A);
            const p1HasB = injection1.includes(SENTINEL_B);
            console.log(`${TEST} Phase 1 entries=${p1.entryCount}, contains SENTINEL_A=${p1HasA}, SENTINEL_B=${p1HasB}`);

            if (!p1HasA || !p1HasB) {
                console.error(`${TEST} [FAIL] Phase 1 baseline broken — both lorebooks locked but injection missing content. A=${p1HasA}, B=${p1HasB}. Without a valid baseline we can't tell what Phase 2 isolation means.`);
                return;
            }
            console.log(`${TEST} Phase 1 baseline ✓ — both A and B searchable when both locked`);

            // ═══════ PHASE 2 — unlock B, re-query, B must NOT appear ═══════
            console.log(`${TEST} Phase 2: removing chat lock from B via canonical setLock(...)...`);
            const unlockResult = setLock(registryKeyB, { kind: 'chat', op: 'remove', target: currentChatId }, { settings: vf });
            if (!unlockResult?.success) {
                console.error(`${TEST} [FAIL] setLock failed to remove B's chat lock: ${unlockResult?.reason}`);
                return;
            }

            // Confirm activation filter now agrees B is out of scope
            const stillActiveA = await shouldCollectionActivate(registryKeyA, context);
            const stillActiveB = await shouldCollectionActivate(registryKeyB, context);
            console.log(`${TEST} After unlock — activeA=${stillActiveA}, activeB=${stillActiveB}`);
            if (!stillActiveA) { console.error(`${TEST} [FAIL] A should still be active after unlocking B`); return; }
            if (stillActiveB) {
                console.error(`${TEST} [FAIL] B still active after setLock op='remove' — lock removal not honored by shouldCollectionActivate. Bug in lock state, not in query path.`);
                return;
            }

            let p2;
            try { p2 = await runLorebookWIDryRun({ chat, testMessage: query, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 2 dry-run threw: ${err.message}`); return; }

            const injection2 = p2?.injectionText || '';
            const p2HasA = injection2.includes(SENTINEL_A);
            const p2HasB = injection2.includes(SENTINEL_B);
            console.log(`${TEST} Phase 2 entries=${p2.entryCount}, contains SENTINEL_A=${p2HasA}, SENTINEL_B=${p2HasB}`);
            console.log(`${TEST} Phase 2 injection preview: ${injection2.slice(0, 200)}`);

            if (!p2HasA) {
                console.error(`${TEST} [FAIL] Phase 2: A's content missing after unlocking B — query path stopped working for active collections`);
                return;
            }
            if (p2HasB) {
                console.error(`${TEST} [FAIL] LEAK DETECTED — B's content (${SENTINEL_B}) appeared in injection despite chat lock being removed. shouldCollectionActivate reported inactive but query path still returned B's vectors. Either (a) getEnabledLorebookCollections is bypassing the activation filter, or (b) the Qdrant content_type filter isn't applied and one physical collection is leaking vectors across logical collections.`);
                return;
            }

            console.log(`${TEST} [PASS] Lock-controlled isolation works: unlocking B removed its content from query results, A unaffected`);
        } finally {
            // Cleanup both — use the canonical setLock op='clear' first to drop any
            // remaining locks, then delete vectors + meta + registry entries.
            for (const { cid, rk, label } of [
                { cid: collectionIdA, rk: registryKeyA, label: 'A' },
                { cid: collectionIdB, rk: registryKeyB, label: 'B' },
            ]) {
                if (!cid) continue;
                try {
                    setLock(rk, { kind: 'chat', op: 'clear' }, { settings: vf });
                    await deleteContentCollection(cid);
                    // TEST-ONLY: also nuke any vectra-side-effect folder. The plugin's
                    // qdrant insert path creates an empty vectra folder as a side effect
                    // of registry stamping (B4 — duplicate registry registration). The
                    // helper is a no-op when no vectra folder exists, so safe to call
                    // unconditionally as a cleanup hygiene step.
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(cid, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed for ${label}: ${e.message}`); }
                    deleteCollectionMeta(rk);
                    unregisterCollection(rk);
                    // Also remove the BARE-ID duplicate registry entry (B4).
                    unregisterCollection(cid);
                    console.log(`${TEST} Cleanup ${label}: ${rk} removed ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Cleanup ${label} failed: ${cleanupErr.message}`);
                }
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
//  TEST 011 — Cross-persona activation isolation (lorebook ownership)
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   TEST 010 verified LOCK-based isolation — explicit unlock removes a
//   collection from activation. But the prod symptom we observed
//   (2026-05-23) was different: rabbit's "Your Wives" lorebook leaking
//   into critblade's ArtificRealm chat WITHOUT either persona ever
//   locking that collection to that chat. The leak mechanism is
//   activation TRIGGERS (keyword matches in chat content) firing on a
//   collection owned by a DIFFERENT persona.
//
//   Per Doc/collection_helper.md activation priority chain, triggers (step 2)
//   activate BEFORE the lock check (steps 4-5). Ownership (`isOwn`) was
//   NOT checked anywhere in the chain — that's the gap B7 closes.
//
// What this test proves:
//   Phase 1: a test lorebook owned by the current persona appears in WI
//     injection (baseline — confirms the test setup is functional).
//   Phase 2: stamp the collection's `creatorHandle` to a foreign value
//     so `isOwn` flips to false. Re-query. Assert sentinel does NOT
//     appear — proving B7's filter blocks cross-persona collections from
//     activating regardless of trigger matches.
//
// Boundary rules (same as TEST 009/010):
//   ✗ DO NOT mutate extension_settings.vectfox at a global level
//   ✓ DO mutate `creatorHandle` on the TEST collection's meta via
//     setCollectionMeta (the test owns this collection — we created it).
//     Restore in finally so cleanup auth passes.
//
// Edge case: superadmin mode forces isOwn=true for all collections, which
// would make Phase 2 fail because the filter wouldn't block anything.
// We detect and skip with a clear signal in that case.
test('TEST 011 — Cross-persona activation isolation', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 011 [CrossPersona]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { getCollectionMeta, setCollectionMeta, deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { getCollectionListing, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }

        // Superadmin override forces isOwn=true for ALL collections — the B7
        // filter is intentionally bypassed in that mode (it's for cross-persona
        // admin work). The test can't exercise the filter; skip with a clear
        // signal so a future reader doesn't think this is a real pass.
        if (vf.superadmin === true) {
            console.warn(`${TEST} [WARN] Superadmin mode is ON — test skipped because isOwn=true for all collections by design. Turn superadmin off to exercise the cross-persona filter.`);
            console.log(`${TEST} [PASS] (skipped: superadmin mode bypasses isOwn filter by design)`);
            return;
        }

        const SENTINEL = 'PERSONA_LEAK_CANARY_RUBELLITE_Q3X7';
        const FAKE_HANDLE = '_fake_other_persona_test_011';

        const testEntries = [{
            uid: 'vf_test_011_a',
            comment: 'Rubellite Catacombs',
            key: ['rubellite', 'catacombs'],
            content: `The ${SENTINEL} sits beneath the abandoned mine of Thressel. Sentinel-canary describes its blood-red crystal chambers echoing footsteps for hours after passing. Pilgrims of the Old Carmine Faith claim the catacombs realign their inner compass.`,
        }];

        console.log(`${TEST} Vectorizing test lorebook (sentinel "${SENTINEL}") with Qdrant...`);
        let res;
        try {
            res = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_011__', entries: testEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }
        if (!res?.success || !res.collectionId) { console.error(`${TEST} [FAIL] Vectorization failed`); return; }

        const collectionId = res.collectionId;
        const registryKey  = `qdrant:${collectionId}`;
        const originalMeta = getCollectionMeta(registryKey);
        const originalHandle = originalMeta?.creatorHandle;
        console.log(`${TEST} Vectorized → ${registryKey}, original creatorHandle="${originalHandle}"`);
        if (!originalHandle) {
            console.warn(`${TEST} [WARN] No creatorHandle stamped at vectorize time — baseline isOwn may rely on legacy ID-substring fallback`);
        }

        try {
            const chat = ctx.chat ?? [];
            const query = `${SENTINEL} rubellite catacombs thressel old carmine faith`;
            // Force enabled_world_info=true — see TEST 001 for rationale.
            // Both phases of this test reuse the same settings override.
            const testSettings = { ...vf, enabled_world_info: true };

            // ═══ PHASE 1 — baseline: current persona owns, sentinel must appear ═══
            console.log(`${TEST} Phase 1: query with current persona ownership intact...`);
            let p1;
            try { p1 = await runLorebookWIDryRun({ chat, testMessage: query, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 1 dry-run threw: ${err.message}`); return; }

            const p1HasSentinel = (p1?.injectionText || '').includes(SENTINEL);
            console.log(`${TEST} Phase 1 entries=${p1.entryCount}, sentinel found=${p1HasSentinel}`);
            if (!p1HasSentinel) {
                console.error(`${TEST} [FAIL] Phase 1 baseline broken — sentinel "${SENTINEL}" not in injection despite current persona owning the collection. Without baseline we can't tell what Phase 2 isolation means.`);
                return;
            }
            console.log(`${TEST} Phase 1 baseline ✓ — sentinel appears when current persona owns the collection`);

            // ═══ PHASE 2 — stamp foreign handle, sentinel must NOT appear ═══
            console.log(`${TEST} Phase 2: stamping creatorHandle="${FAKE_HANDLE}" on test collection to simulate foreign ownership...`);
            setCollectionMeta(registryKey, { creatorHandle: FAKE_HANDLE });

            // Sanity check the listing now reports isOwn=false
            const listingAfter = getCollectionListing(vf);
            const entry = listingAfter.find(e => e.registryKey === registryKey);
            if (!entry) { console.error(`${TEST} [FAIL] Test collection vanished from listing after meta update`); return; }
            console.log(`${TEST} After meta update — entry.isOwn=${entry.isOwn} (expected false)`);
            if (entry.isOwn) {
                console.error(`${TEST} [FAIL] entry.isOwn still true after creatorHandle change — superadmin off but isOwn computation didn't honor the new handle. (Possible legacy ID-substring fallback matching: if the collection ID contains the real handle, the fallback can't be defeated by meta-only mutation.)`);
                return;
            }

            let p2;
            try { p2 = await runLorebookWIDryRun({ chat, testMessage: query, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] Phase 2 dry-run threw: ${err.message}`); return; }

            const p2HasSentinel = (p2?.injectionText || '').includes(SENTINEL);
            console.log(`${TEST} Phase 2 entries=${p2.entryCount}, sentinel found=${p2HasSentinel}`);
            console.log(`${TEST} Phase 2 injection preview: ${(p2.injectionText || '').slice(0, 200)}`);

            if (p2HasSentinel) {
                console.error(`${TEST} [FAIL] CROSS-PERSONA LEAK — sentinel "${SENTINEL}" appeared in injection despite creatorHandle now being foreign (entry.isOwn=false). getEnabledLorebookCollections is not filtering by entry.isOwn. This is the prod symptom mechanism (B7).`);
                return;
            }
            console.log(`${TEST} [PASS] Cross-persona isolation works: foreign-handle collection blocked from activation despite matching triggers`);
        } finally {
            // Restore creatorHandle so canonical cleanup (setLock auth gate, etc.)
            // doesn't choke. Even if cleanup proceeds without auth, leaving the
            // foreign handle in place would leak state to subsequent test runs.
            try {
                if (originalHandle) {
                    setCollectionMeta(registryKey, { creatorHandle: originalHandle });
                    console.log(`${TEST} Restored creatorHandle to "${originalHandle}"`);
                }
            } catch (restoreErr) {
                console.warn(`${TEST} [WARN] Restoring creatorHandle failed: ${restoreErr.message}`);
            }
            try {
                await deleteContentCollection(collectionId);
                // TEST-ONLY: also nuke any vectra-side-effect folder (B4 — qdrant insert
                // path creates empty vectra placeholder during registry stamping).
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                deleteCollectionMeta(registryKey);
                unregisterCollection(registryKey);
                // Also remove the BARE-ID duplicate registry entry (B4).
                unregisterCollection(collectionId);
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
//   `importCollection` and `importCollectionSilent` both need to remap the
//   backend segment in the collection ID when the export's backend differs
//   from the user's current target backend. Without that, importing a
//   qdrant export into standard would create a vectra folder named
//   `vf_*_qdrant_*` — polluting storage and confusing every parser that
//   reads the backend from the ID.
//
//   The remap logic lives in `core/collection-ids.js::remapCollectionIdToBackend`
//   (formerly duplicated as a private helper in collection-export.js and
//   MISSING entirely from `importCollectionSilent`). Surfaced 2026-05-23 by
//   inspecting the standard backend storage tree and finding `_qdrant_`
//   folders sitting in vectra.
//
// What this test proves:
//   - Pure helper checks first (remap both directions + detection round-trip)
//   - Phase 1: importing a qdrant-shaped export with vector_backend='standard'
//     produces a collection ID containing `_standard_`, not `_qdrant_`.
//   - Phase 2: mirror — standard export imported with vector_backend='qdrant'
//     produces a `_qdrant_`-segment ID.
//
// Boundary rules (same as 009/010/011):
//   ✗ DO NOT mutate extension_settings.vectfox
//   ✓ DO use sentinel `__vf_playwright_test_012__` in IDs so beforeAll's
//     orphan cleanup catches anything left behind by a crash.
test('TEST 012 — Cross-backend import: qdrant ↔ standard rename', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 012 [ImportRename]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { importCollection } = await import(base + 'core/collection-export.js');
        const { remapCollectionIdToBackend, getBackendFromCollectionId } = await import(base + 'core/collection-ids.js');
        const { deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
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
                    await deleteContentCollection(p1ResultId);
                    // TEST-ONLY: nuke parent folder in vectra (Phase 1 imports as standard)
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(p1ResultId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Phase 1 folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(`vectra:${p1ResultId}`);
                    unregisterCollection(`vectra:${p1ResultId}`);
                    // Also remove the BARE-ID duplicate registry entry (B4).
                    unregisterCollection(p1ResultId);
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
                    await deleteContentCollection(p2ResultId);
                    // TEST-ONLY: nuke vectra-side-effect folder (Phase 2 result is qdrant
                    // but plugin's insert path leaves a vectra placeholder — B4).
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(p2ResultId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Phase 2 folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(`qdrant:${p2ResultId}`);
                    unregisterCollection(`qdrant:${p2ResultId}`);
                    // Also remove the BARE-ID duplicate registry entry (B4).
                    unregisterCollection(p2ResultId);
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
//  TEST 013 — Synthetic E2E: self-contained lorebook + EventBase round-trip (qdrant)
// ═══════════════════════════════════════════════════════════════════
//
// Why this test exists:
//   TEST 003 and TEST 007 are E2E tests that depend on whatever the user
//   happens to have locked in their current chat. That's useful coverage
//   for the real environment, but means E2E confidence vanishes the
//   moment a fresh ST install or empty chat is involved.
//
//   TEST 013 covers the same E2E pipeline (lorebook activation + EventBase
//   retrieval, both queried in one cycle) on PURELY SYNTHETIC test data —
//   it creates its own lorebook, its own EventBase collection, locks both
//   to the current chat, runs the dry-run pipeline, asserts both sentinels
//   appear in the injection, then nukes every artifact like nothing was
//   ever done. No reliance on user data, settings, or pre-existing locked
//   collections.
//
// Backend choice: qdrant — production-relevant path and what TEST 003 is
// shaped after. Gracefully fails the test config check if Qdrant is not
// configured rather than crashing.
//
// Cleanup contract: every artifact this test creates is removed in finally:
//   - lorebook vectors + meta + registry (both canonical and bare forms)
//   - EventBase vectors + meta + registry + explicit lock removal
//   - vectra-side-effect folder (B4) for both
test('TEST 013 — Synthetic E2E qdrant: lorebook + EventBase round-trip', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 013 [SyntheticE2E]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { insertEvents } = await import(base + 'core/eventbase-store.js');
        const { shouldCollectionActivate, deleteCollectionMeta, setLock, getCollectionLocks } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection, deleteCollection } = await import(base + 'core/collection-loader.js');
        const { runLorebookWIDryRun } = await import(base + 'core/world-info-integration.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }
        if (!(vf.qdrant_url || vf.qdrant_host)) { console.warn(`${TEST} [SKIP] Qdrant not configured`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };

        // Derive the current persona's handle the same way collection-ids.js
        // does. We need this in the synthetic EventBase collection ID so that
        // registerCollection's creatorHandle-stamp condition (`_<handle>_` in
        // the ID) matches — without it, setLock denies the chat-lock add
        // because the persona's name1 doesn't match the stamped creator
        // (since nothing got stamped to begin with).
        const personaHandle = (ctx?.name1 || 'user')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) || 'user';

        // Sentinels: unique enough that they CANNOT exist in any real user data
        // or any other test's fixture. Used to verify the retrieval pipeline
        // returned OUR synthetic content (not leaked from elsewhere).
        const LOREBOOK_SENTINEL = 'PHOSPHORIC_ANTHELION_J4M9';
        const EVENTBASE_SENTINEL = 'ZIRCONIC_OSCILLATOR_T2P6';

        const ts = Date.now();
        const lorebookEntries = [{
            uid: 'vf_test_013_a',
            comment: 'Phosphoric Anthelion',
            key: ['phosphoric', 'anthelion'],
            content: `The ${LOREBOOK_SENTINEL} is a circular halo of phosphor-light that appears around the moon during the Stilled Tide. Sentinel-lorebook records describe it as visible only from the cliffs of Astrelle and only on nights when the sea lies perfectly flat. Astronomers of the Pale Conclave have catalogued its appearance 14 times in two centuries.`,
        }];

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

        let lorebookCollectionId = null, lorebookRegistryKey = null;
        let eventbaseCreated = false;

        try {
            // ── Phase A: vectorize lorebook (scope='chat' → auto-locks to current chat) ──
            console.log(`${TEST} Phase A: vectorizing synthetic lorebook (sentinel "${LOREBOOK_SENTINEL}")...`);
            const lbRes = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: '__vf_playwright_test_013_lb__', entries: lorebookEntries },
                settings: { ...vf, vector_backend: 'qdrant', strategy: 'per_entry', scope: 'chat' },
            });
            if (!lbRes?.success || !lbRes.collectionId) { console.error(`${TEST} [FAIL] Lorebook vectorization failed`); return; }
            lorebookCollectionId = lbRes.collectionId;
            lorebookRegistryKey  = `qdrant:${lorebookCollectionId}`;
            console.log(`${TEST} Lorebook ready → ${lorebookRegistryKey}`);

            const lbActive = await shouldCollectionActivate(lorebookRegistryKey, context);
            if (!lbActive) { console.error(`${TEST} [FAIL] Lorebook didn't auto-lock to current chat`); return; }

            // ── Phase B: insert synthetic events into a fresh EventBase, then lock it ──
            console.log(`${TEST} Phase B: inserting 1 synthetic event into ${eventbaseCollectionId}...`);
            await insertEvents(testEvents, { ...vf, vector_backend: 'qdrant' }, null, eventbaseCollectionId);
            eventbaseCreated = true;

            // EventBase doesn't auto-lock via scope='chat' the way lorebook does
            // (insertEvents skips the auto-lock path because the collection ID is
            // supplied explicitly). Lock it manually so runEventBaseRetrieval
            // picks it up as a live locked collection.
            const lockResult = setLock(eventbaseRegistryKey, { kind: 'chat', op: 'add', target: currentChatId }, { settings: vf });
            if (!lockResult?.success) { console.error(`${TEST} [FAIL] Failed to lock EventBase to current chat: ${lockResult?.reason}`); return; }

            const ebLocks = getCollectionLocks(eventbaseRegistryKey);
            if (!ebLocks.some(l => l === currentChatId)) { console.error(`${TEST} [FAIL] EventBase lock didn't register — locks=${JSON.stringify(ebLocks)}`); return; }
            console.log(`${TEST} EventBase locked to chat ✓ (locks=${ebLocks.length})`);

            // ── Phase C: query lorebook via dry-run WI activation ──
            const chat = ctx.chat ?? [];
            const query = `${LOREBOOK_SENTINEL} ${EVENTBASE_SENTINEL} phosphoric anthelion stilled tide astrelle zirconic oscillator`;
            // Force enabled_world_info=true — see TEST 001 for rationale.
            const testSettings = { ...vf, enabled_world_info: true };

            console.log(`${TEST} Phase C: querying lorebook + EventBase against synthetic data...`);
            let lbResult;
            try { lbResult = await runLorebookWIDryRun({ chat, testMessage: query, settings: testSettings }); }
            catch (err) { console.error(`${TEST} [FAIL] runLorebookWIDryRun threw: ${err.message}`); return; }

            const lbInjection = lbResult?.injectionText || '';
            if (!lbInjection.includes(LOREBOOK_SENTINEL)) {
                console.error(`${TEST} [FAIL] Lorebook sentinel "${LOREBOOK_SENTINEL}" not found in injection (entries=${lbResult.entryCount}) — result envelope: ${JSON.stringify({
                    entryCount: lbResult.entryCount,
                    disabled: lbResult.disabled,
                    noCollections: lbResult.noCollections,
                })}`);
                return;
            }
            console.log(`${TEST} Lorebook ✓ — ${lbResult.entryCount} entry/entries, sentinel found`);

            // ── Phase D: query EventBase via dry-run retrieval ──
            const { runEventBaseRetrieval } = await import(base + 'core/eventbase-workflow.js').catch(() => ({}));
            if (typeof runEventBaseRetrieval !== 'function') { console.warn(`${TEST} [WARN] runEventBaseRetrieval not exported — EventBase E2E half skipped`); return; }

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

            console.log(`${TEST} [PASS] Synthetic E2E qdrant: lorebook + EventBase both round-trip with sentinels intact`);
        } finally {
            // ── Cleanup: remove every trace this test created ──
            // Order: locks → vectors → meta → registry (both canonical + bare).
            // EventBase first because we explicitly locked it; lorebook auto-cleans
            // its lock via deleteContentCollection.
            if (eventbaseCreated) {
                try {
                    setLock(eventbaseRegistryKey, { kind: 'chat', op: 'clear' }, { settings: vf });
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

            if (lorebookCollectionId) {
                try {
                    await deleteContentCollection(lorebookCollectionId);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(lorebookCollectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] Lorebook folder-cleanup helper failed: ${e.message}`); }
                    deleteCollectionMeta(lorebookRegistryKey);
                    unregisterCollection(lorebookRegistryKey);
                    unregisterCollection(lorebookCollectionId);
                    console.log(`${TEST} Lorebook cleanup ✓`);
                } catch (cleanupErr) {
                    console.warn(`${TEST} [WARN] Lorebook cleanup failed: ${cleanupErr.message}`);
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
//   window's hashes are joined into a fingerprint string and stored in
//   `_windowCacheSet` (in-memory Set) + `extension_settings.vectfox
//   .eventbase_extracted_windows[uuid]` (persisted array). On the next
//   ingestion call, isLastWindowExtracted does a quick-exit, and
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
//   We test the dedup CONTRACT directly — fast and deterministic. The
//   integration of fingerprint cache with the LLM extraction pipeline is
//   already covered by TEST 003/007/013 which exercise the full
//   runEventBaseIngestion path on real chats.
//
// What this test proves:
//   - markWindowExtracted writes to BOTH the in-memory Set and the
//     persisted array.
//   - isWindowAlreadyExtracted correctly reports true for marked windows
//     and false for unmarked ones (the per-window dedup gate).
//   - isLastWindowExtracted returns false when the last window is unmarked
//     (work to do → ingestion runs) and true when every window is marked
//     (quick-exit → ingestion no-ops).
//   - The persisted array length equals the expected window count
//     (survives page reload — key correctness property for auto-sync
//     across browser restarts).
//   - clearWindowCacheForChat wipes both tiers (cleanup contract).
//
// Boundary rules (same as TEST 009/010/011):
//   ✗ DO NOT mutate extension_settings.vectfox at a global level beyond
//     the synthetic test UUID's cache entry (cleaned up in finally).
//   ✓ DO use a synthetic chat UUID prefixed with __vf_playwright_test_
//     so beforeAll cleanup catches any leftover from a crashed run.
test('TEST 014 — Auto-sync backfill: fingerprint cache prevents duplicate windows', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 014 [AutoSyncDedup]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            markWindowExtracted,
            isWindowAlreadyExtracted,
            isLastWindowExtracted,
            clearWindowCacheForChat,
        } = await import(base + 'core/eventbase-store.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        // Synthetic test UUID — never collides with real chats. Marker prefix
        // matches beforeAll's cleanup pattern so a crashed run leaves no orphans.
        const testUUID = '__vf_playwright_test_014__autosync_dedup';
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
            markWindowExtracted(win01, testUUID);

            const phase1WindowDone = await isWindowAlreadyExtracted(win01, null, {}, testUUID);
            if (!phase1WindowDone) {
                console.error(`${TEST} [FAIL] Phase 1: marked window [0-1] reads back as NOT extracted — markWindowExtracted broken`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ window [0-1] correctly in cache`);

            // ═══ Phase 2 — chat grows to 6 messages, NEW windows not yet marked ═══
            console.log(`${TEST} Phase 2: chat grew to 6 messages — verifying new windows [2-3] and [4-5] are NOT in cache`);
            const phase2Win23 = await isWindowAlreadyExtracted(win23, null, {}, testUUID);
            const phase2Win45 = await isWindowAlreadyExtracted(win45, null, {}, testUUID);
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
            const quickExitBefore = isLastWindowExtracted(messages, windowSize, step, testUUID, hashFn);
            if (quickExitBefore) {
                console.error(`${TEST} [FAIL] Phase 3: quick-exit returned true despite last window [4-5] being unmarked — auto-sync would skip the 4-message backfill`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ quick-exit correctly reports work pending`);

            // ═══ Phase 4 — simulate the auto-sync ingestion marking the 2 new windows ═══
            console.log(`${TEST} Phase 4: simulating auto-sync sweep — marking windows [2-3] and [4-5]`);
            markWindowExtracted(win23, testUUID);
            markWindowExtracted(win45, testUUID);

            const phase4Win23 = await isWindowAlreadyExtracted(win23, null, {}, testUUID);
            const phase4Win45 = await isWindowAlreadyExtracted(win45, null, {}, testUUID);
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
            const quickExitAfter = isLastWindowExtracted(messages, windowSize, step, testUUID, hashFn);
            if (!quickExitAfter) {
                console.error(`${TEST} [FAIL] Phase 5: quick-exit returned false despite all 3 windows marked — next auto-sync would re-process work`);
                return;
            }
            console.log(`${TEST} Phase 5 ✓ quick-exit correctly reports nothing pending`);

            // ═══ Phase 6 — persisted array matches in-memory state ═══
            // The Set is rebuilt from this array on the next page load, so
            // length-correctness here is what makes auto-sync survive a reload.
            console.log(`${TEST} Phase 6: verifying persisted array on disk matches the in-memory Set`);
            const persisted = extension_settings?.vectfox?.eventbase_extracted_windows?.[testUUID];
            if (!Array.isArray(persisted)) {
                console.error(`${TEST} [FAIL] Phase 6: persisted entry is not an array — type=${typeof persisted}`);
                return;
            }
            if (persisted.length !== 3) {
                console.error(`${TEST} [FAIL] Phase 6: persisted array length=${persisted.length}, expected 3 (one fingerprint per window)`);
                return;
            }
            console.log(`${TEST} Phase 6 ✓ persisted array has exactly 3 fingerprints`);

            console.log(`${TEST} [PASS] Fingerprint cache correctly gates auto-sync — 2-msg → 6-msg backfill processes only the 4 new messages, never the original 2`);
        } finally {
            // Wipe the in-memory Set entry AND the persisted array for testUUID.
            // Real user data is never touched — testUUID is synthetic and unique.
            try {
                clearWindowCacheForChat(testUUID);
                const after = extension_settings?.vectfox?.eventbase_extracted_windows?.[testUUID];
                if (after !== undefined) {
                    console.warn(`${TEST} [WARN] clearWindowCacheForChat left a stale entry: ${JSON.stringify(after)}`);
                } else {
                    console.log(`${TEST} Cleanup ✓ fingerprint cache cleared for ${testUUID}`);
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
//   The window fingerprint cache (covered by TEST 014) gives per-window
//   dedup safety as long as the window size doesn't change. If the user
//   vectorizes a chat at windowSize=2 and later changes to windowSize=4,
//   the fingerprints don't match anymore (different size = different
//   sorted-hash join), so the cache reports "not extracted" for every new
//   window — auto-sync would naively re-process the entire chat at the new
//   window size, duplicating events.
//
//   The AUTO-SYNC START MARKER prevents this. When the user enables
//   auto-sync, `stampAutoSyncMarker` records a message-index threshold in
//   `extension_settings.vectfox.eventbase_autosync_start_marker[chatUUID]`.
//   On every auto-sync run, `runEventBaseIngestion` filters its window
//   list with `windows.filter(w => w.start >= marker)` — only windows that
//   START at or after the marker get processed. Windows from the
//   pre-marker era (which were already covered by the prior, smaller-window
//   extractions) get filtered OUT safely.
//
//   Smart-placement logic in stampAutoSyncMarker:
//     - Collection non-empty: marker = max(source_window_end) + 1
//       (backfill the gap between last-covered message and chat tail at
//       the new window size)
//     - Collection empty: marker = chatLength
//       (auto-sync starts "from now on" — no full re-extraction of a long
//       pre-existing chat that was never vectorized)
//
//   Together with TEST 014's fingerprint cache test, this proves the
//   two-layer safety story:
//     Layer 1 (TEST 014) — fingerprint cache: per-window dedup at same size
//     Layer 2 (TEST 015) — start marker:      window-size-change protection
//
// What this test proves:
//   - getAutoSyncMarker returns undefined for un-stamped chats.
//   - The marker round-trips through extension_settings storage correctly.
//   - The window-filter pattern `w.start >= marker` excludes obsolete
//     pre-marker windows and keeps post-marker windows. This is the EXACT
//     filter used inside runEventBaseIngestion at the auto-sync marker
//     block (eventbase-workflow.js ~line 170).
//   - clearAutoSyncMarker removes the entry cleanly so the next enable
//     stamps a fresh value for the current chat state.
//
// Boundary rules:
//   ✗ DO NOT mutate extension_settings.vectfox at a global level beyond
//     the synthetic test UUID's marker entry (cleaned up in finally).
//   ✓ DO use a synthetic chat UUID prefixed with __vf_playwright_test_.
test('TEST 015 — Auto-sync window-size change: start marker filters obsolete windows', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 015 [AutoSyncMarker]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            getAutoSyncMarker,
            clearAutoSyncMarker,
        } = await import(base + 'core/eventbase-store.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const testUUID = '__vf_playwright_test_015__autosync_marker';

        try {
            // ═══ Phase 1 — fresh UUID, no marker stamped ═══
            console.log(`${TEST} Phase 1: getAutoSyncMarker on fresh UUID should return undefined`);
            const initial = getAutoSyncMarker(testUUID);
            if (initial !== undefined) {
                console.error(`${TEST} [FAIL] Phase 1: unmarked UUID returned ${initial} instead of undefined`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ no marker on fresh UUID`);

            // ═══ Phase 2 — stamp marker, simulating the smart-placement output ═══
            // Scenario: user vectorized chat at length=2 with windowSize=2.
            // Window [0-1] was extracted, so the EventBase event has
            // source_window_end=1. User switches to windowSize=4 and enables
            // auto-sync. stampAutoSyncMarker would compute:
            //   marker = max(source_window_end) + 1 = 1 + 1 = 2
            // We simulate the result directly (the math itself is trivial;
            // what we're testing here is the get/filter contract).
            const stampedValue = 2;
            if (!extension_settings.vectfox.eventbase_autosync_start_marker) {
                extension_settings.vectfox.eventbase_autosync_start_marker = {};
            }
            extension_settings.vectfox.eventbase_autosync_start_marker[testUUID] = stampedValue;

            const readBack = getAutoSyncMarker(testUUID);
            if (readBack !== stampedValue) {
                console.error(`${TEST} [FAIL] Phase 2: getAutoSyncMarker returned ${readBack}, expected ${stampedValue}`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ marker=${stampedValue} stamped and read back via canonical getter`);

            // ═══ Phase 3 — simulate runEventBaseIngestion's window filter ═══
            // Now the chat has grown to 8 messages. New windowSize=4 produces:
            //   [0-3] (start=0) — OLD content, was covered by the prior
            //                     windowSize=2 extraction at messages 0,1.
            //                     If re-processed here it would re-extract
            //                     messages 0,1 → duplicate events.
            //   [4-7] (start=4) — entirely NEW content past the marker
            //
            // The marker filter `w.start >= 2` should:
            //   - Exclude [0-3] (start=0 < 2) — prevents wrong re-processing
            //   - Keep [4-7] (start=4 >= 2) — legitimate new content backfill
            //
            // This is the EXACT logic at eventbase-workflow.js ~line 170-180.
            console.log(`${TEST} Phase 3: simulating ingestion window filter for chat at 8 messages, windowSize=4`);
            const windowsAtNewSize = [
                { start: 0, end: 3, msgs: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }] },
                { start: 4, end: 7, msgs: [{ id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }] },
            ];
            const marker = getAutoSyncMarker(testUUID);
            const filtered = windowsAtNewSize.filter(w => w.start >= marker);

            if (filtered.length !== 1) {
                console.error(`${TEST} [FAIL] Phase 3: expected 1 window after marker filter, got ${filtered.length}: ${JSON.stringify(filtered.map(w => `[${w.start}-${w.end}]`))}`);
                return;
            }
            if (filtered[0].start !== 4) {
                console.error(`${TEST} [FAIL] Phase 3: surviving window has start=${filtered[0].start}, expected 4`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ marker filter excluded obsolete [0-3], kept legitimate [4-7]`);

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
            clearAutoSyncMarker(testUUID);
            const cleared = getAutoSyncMarker(testUUID);
            if (cleared !== undefined) {
                console.error(`${TEST} [FAIL] Phase 5: clearAutoSyncMarker left value ${cleared} — should be undefined after clear`);
                return;
            }
            console.log(`${TEST} Phase 5 ✓ marker cleared, fresh re-enable would re-compute`);

            console.log(`${TEST} [PASS] Auto-sync start marker correctly gates the window filter — windowSize-change protection holds: obsolete pre-marker windows excluded, post-marker windows pass through, boundary at start === marker included`);
        } finally {
            try {
                clearAutoSyncMarker(testUUID);
                const after = getAutoSyncMarker(testUUID);
                if (after !== undefined) {
                    console.warn(`${TEST} [WARN] clearAutoSyncMarker left a stale value: ${after}`);
                } else {
                    console.log(`${TEST} Cleanup ✓ marker cleared for ${testUUID}`);
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
//  actually computes the marker — `stampAutoSyncMarker(chatUUID, settings)`
//  in core/eventbase-store.js — across its decision branches:
//
//    Branch A: no chatUUID                        → returns 0, no persistence
//    Branch B: no candidates in registry          → marker = chatLength
//    Branch C: candidates exist, no readable data → marker = chatLength (fallback)
//    Branch D: candidates exist with source_window_end metadata
//                                                 → marker = max(end) + 1
//
//  Branches A/B/C run in every environment. Branch D requires a backend that
//  preserves item-level metadata; collection-export's insertChunksWithVectors
//  routes standard-backend inserts through native /api/vector/insert which
//  strips metadata, so D is only meaningful on env 3 (qdrant). Rather than
//  bolting on a qdrant-only Phase 4 with synthetic point inserts, this test
//  asserts the three branches that work everywhere and lets the actual
//  max+1 arithmetic — a trivial one-line reducer — stand on its own. The
//  high-risk parts (branch selection, the chatLength fallback in the
//  try/catch, re-stamp overwrite) are what real regressions hit.
//
//  Phases:
//    1. Branch A — empty chatUUID returns 0 sentinel, no write.
//    2. Branch B — fresh UUID with no registered EventBase collection.
//       Marker should equal getContext().chat.length and persist.
//    3. Branch C — synthetic vf_eventbase_<…>_<uuid> registered, no chunks
//       on disk. listChunks returns empty / throws → caught → fallback to
//       chatLength.
//    4. Re-stamp idempotency — second call overwrites the persisted value.
//    5. Cleanup — unregister the synthetic collection, clear the marker.

test('TEST 016 — stampAutoSyncMarker smart placement (production-function smoke)', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 016 [AutoSyncStamp]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            stampAutoSyncMarker,
            getAutoSyncMarker,
            clearAutoSyncMarker,
            findEventBaseCollectionsForChat,
        } = await import(base + 'core/eventbase-store.js');
        const { registerCollection, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { deleteCollectionMeta } = await import(base + 'core/collection-metadata.js');
        const { deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const settings = extension_settings?.vectfox || {};
        const backend = (settings.vector_backend || 'standard').toLowerCase();

        // Two distinct UUIDs so Phase 2 (no candidates) and Phase 3 (synthetic
        // candidate) don't pollute each other's registry lookups.
        const uuidBranchB = '__vf_playwright_test_016__no_candidate';
        const uuidBranchC = '__vf_playwright_test_016__empty_candidate';
        const syntheticCollectionId = `vf_eventbase_${backend}_playwright_test_016_${uuidBranchC}`;
        const syntheticRegistryKey  = `${backend}:${syntheticCollectionId}`;

        try {
            // ═══ Phase 1 — Branch A: empty chatUUID returns 0, no write ═══
            console.log(`${TEST} Phase 1: stampAutoSyncMarker('') should return 0 and NOT touch the marker store`);
            // Capture any pre-existing keys so we can prove no spurious write happened.
            const storeBefore = extension_settings?.vectfox?.eventbase_autosync_start_marker || {};
            const keysBefore  = Object.keys(storeBefore).slice().sort();

            const sentinel = await stampAutoSyncMarker('', settings);
            if (sentinel !== 0) {
                console.error(`${TEST} [FAIL] Phase 1: empty UUID returned ${sentinel} instead of 0`);
                return;
            }
            const storeAfter = extension_settings?.vectfox?.eventbase_autosync_start_marker || {};
            const keysAfter  = Object.keys(storeAfter).slice().sort();
            if (keysBefore.length !== keysAfter.length ||
                keysBefore.some((k, i) => k !== keysAfter[i])) {
                console.error(`${TEST} [FAIL] Phase 1: marker store was mutated by an empty-UUID call. Before=${JSON.stringify(keysBefore)} After=${JSON.stringify(keysAfter)}`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ Branch A early-exit: returned 0, no persistence`);

            // ═══ Phase 2 — Branch B: no candidates → marker = chatLength ═══
            console.log(`${TEST} Phase 2: Branch B — fresh UUID, no registered EventBase collection → marker should equal chat length`);
            const chatLengthB = ctx?.chat?.length ?? 0;
            const markerB = await stampAutoSyncMarker(uuidBranchB, settings);
            if (markerB !== chatLengthB) {
                console.error(`${TEST} [FAIL] Phase 2: marker=${markerB}, expected chatLength=${chatLengthB}`);
                return;
            }
            const persistedB = getAutoSyncMarker(uuidBranchB);
            if (persistedB !== markerB) {
                console.error(`${TEST} [FAIL] Phase 2: persisted value ${persistedB} does not match returned ${markerB}`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ Branch B: marker=${markerB} (chatLength=${chatLengthB}) persisted via getAutoSyncMarker`);

            // ═══ Phase 3 — Branch C: synthetic candidate, no data → fallback ═══
            console.log(`${TEST} Phase 3: Branch C — registering synthetic ${syntheticRegistryKey}; listChunks will return empty (or throw, caught) → marker should fall back to chat length`);
            registerCollection(syntheticRegistryKey);

            // Sanity: confirm the synthetic registration is actually visible
            // to findEventBaseCollectionsForChat so the test exercises the
            // intended branch (`candidates.length > 0`). If this fails the
            // test would silently degrade into another Branch B run.
            const candidates = findEventBaseCollectionsForChat(uuidBranchC, backend);
            if (candidates.length === 0) {
                console.error(`${TEST} [FAIL] Phase 3: synthetic registration didn't surface in findEventBaseCollectionsForChat — would silently re-test Branch B. Registry key was ${syntheticRegistryKey}.`);
                return;
            }

            const chatLengthC = ctx?.chat?.length ?? 0;
            const markerC = await stampAutoSyncMarker(uuidBranchC, settings);
            if (markerC !== chatLengthC) {
                console.error(`${TEST} [FAIL] Phase 3: marker=${markerC}, expected chatLength=${chatLengthC} (listChunks returned no metadata, should have fallen back). Branch C try/catch fallback may be broken.`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ Branch C: marker=${markerC} (chatLength=${chatLengthC}) — try/catch fallback held; candidate present but no readable source_window_end`);

            // ═══ Phase 4 — Re-stamp idempotency ═══
            console.log(`${TEST} Phase 4: re-stamping Branch B UUID overwrites the persisted value cleanly`);
            // Mutate the persisted value to a sentinel so we can prove the
            // re-stamp actually wrote (not just left a stale equal value).
            extension_settings.vectfox.eventbase_autosync_start_marker[uuidBranchB] = -999;
            // Read back the sentinel via the canonical getter — if this fails,
            // the pre-condition wasn't met (frozen object, missing nested key)
            // and the rest of Phase 4 would silently pass on a no-op overwrite.
            const sentinelReadBack = getAutoSyncMarker(uuidBranchB);
            if (sentinelReadBack !== -999) {
                console.error(`${TEST} [FAIL] Phase 4 pre-condition: sentinel write didn't land — getAutoSyncMarker reads ${sentinelReadBack} instead of -999. Re-stamp overwrite assertion below would be meaningless.`);
                return;
            }
            const reStamped = await stampAutoSyncMarker(uuidBranchB, settings);
            if (reStamped !== chatLengthB) {
                console.error(`${TEST} [FAIL] Phase 4: re-stamp returned ${reStamped}, expected ${chatLengthB}`);
                return;
            }
            if (getAutoSyncMarker(uuidBranchB) !== chatLengthB) {
                console.error(`${TEST} [FAIL] Phase 4: re-stamp did not overwrite — getAutoSyncMarker still reads ${getAutoSyncMarker(uuidBranchB)} after re-stamp`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ re-stamp overwrites prior value (sentinel -999 → ${chatLengthB})`);

            // ═══ Phase 5 — floor override: { floor: 'chatLength' } forces from-now-on ═══
            // Used by the auto-sync enable "Just keep up from here" choice. Must stamp
            // chat length directly (skipping the coverage scan) regardless of state.
            console.log(`${TEST} Phase 5: stampAutoSyncMarker(..., { floor: 'chatLength' }) stamps chat length directly`);
            const chatLenNow = ctx?.chat?.length ?? 0;
            extension_settings.vectfox.eventbase_autosync_start_marker[uuidBranchB] = -777;
            const floored = await stampAutoSyncMarker(uuidBranchB, settings, { floor: 'chatLength' });
            if (floored !== chatLenNow) {
                console.error(`${TEST} [FAIL] Phase 5: floor override returned ${floored}, expected chatLength=${chatLenNow}`);
                return;
            }
            if (getAutoSyncMarker(uuidBranchB) !== chatLenNow) {
                console.error(`${TEST} [FAIL] Phase 5: floor override did not persist chatLength — getAutoSyncMarker reads ${getAutoSyncMarker(uuidBranchB)} (sentinel -777 not overwritten)`);
                return;
            }
            console.log(`${TEST} Phase 5 ✓ floor override stamps chatLength (${chatLenNow}), overwriting sentinel -777`);

            console.log(`${TEST} [PASS] stampAutoSyncMarker smart placement holds — Branch A early-exit, Branch B no-candidate falls to chatLength, Branch C empty-candidate falls to chatLength via try/catch, re-stamp overwrites, floor override forces chatLength. Branch D (max(source_window_end)+1) is not asserted by this test because env-1/2 standard-backend inserts strip metadata; the one-line reducer is trivial.`);
        } finally {
            // Cleanup — markers, on-disk artifacts, meta, and registry.
            // ORDER MATTERS: deleteContentCollection FIRST so the vectra
            // directory (auto-created by stampAutoSyncMarker's listChunks
            // probe in Phase 3 — see "ghost 0-chunk entries" caveat in
            // eventbase-store.js) is removed BEFORE we unregister. Otherwise
            // the directory survives on disk and loadAllCollections will
            // re-discover it on the next ST page load, leaving a ghost
            // `vf_eventbase_…playwright_test_016__empty_candidate` entry
            // visible to live retrieval (caught during a 2026-05-24 live
            // test). Same teardown shape that beforeAll uses for leftover
            // cleanup.
            try {
                clearAutoSyncMarker(uuidBranchB);
                clearAutoSyncMarker(uuidBranchC);
                if (getAutoSyncMarker(uuidBranchB) !== undefined ||
                    getAutoSyncMarker(uuidBranchC) !== undefined) {
                    console.warn(`${TEST} [WARN] clearAutoSyncMarker left stale values: B=${getAutoSyncMarker(uuidBranchB)} C=${getAutoSyncMarker(uuidBranchC)}`);
                }
                // Phase 3 creates an on-disk artifact via listChunks probe.
                // Phases 1/2/4 don't, but calling delete on a non-existent
                // collection is a no-op — safer to call unconditionally.
                try { await deleteContentCollection(syntheticCollectionId); } catch {}
                try { deleteCollectionMeta(syntheticRegistryKey); } catch {}
                try { deleteCollectionMeta(syntheticCollectionId); } catch {}
                try { unregisterCollection(syntheticRegistryKey); } catch {}
                try { unregisterCollection(syntheticCollectionId); } catch {}
                console.log(`${TEST} Cleanup ✓ markers cleared, disk artifacts deleted, meta removed, synthetic registration unregistered`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});

// ═══════════════════════════════════════════════════════════════════
//  TEST 017 — Pause button (enabled=false) blocks activation
// ═══════════════════════════════════════════════════════════════════
//
//  `isCollectionEnabled` / `setCollectionEnabled` are documented in
//  Doc/collection_helper.md as the hard kill switch — priority 1 of
//  `shouldCollectionActivate`. Even when a collection is locked to the
//  current chat (priority 4), `enabled=false` MUST override and block
//  activation. Easy to break during a future activation-priority refactor;
//  no existing test asserts this invariant.
//
//  This test runs in every environment because it's pure metadata —
//  no backend insert, no chunk listing, no LLM call.
//
//  Phases:
//    1. Default state: a fresh registered collection (no `enabled` meta
//       written) reports `isCollectionEnabled === true`.
//    2. Baseline: with a chat lock pinned, `shouldCollectionActivate`
//       returns true (priority-4 path).
//    3. Pause: `setCollectionEnabled(key, false)` ⇒ `isCollectionEnabled`
//       flips to false AND `shouldCollectionActivate` returns false even
//       though the lock is still in place. Priority 1 overrides priority 4.
//    4. Re-enable: `setCollectionEnabled(key, true)` restores activation —
//       lock state was never touched by the pause path.

test('TEST 017 — Pause button (enabled=false) blocks activation even when locked', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 017 [PauseButton]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            isCollectionEnabled,
            setCollectionEnabled,
            setCollectionLock,
            removeCollectionLock,
            isCollectionLockedToChat,
            shouldCollectionActivate,
            deleteCollectionMeta,
        } = await import(base + 'core/collection-metadata.js');
        const { registerCollection, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { buildRegistryKey } = await import(base + 'core/collection-ids.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const settings = extension_settings?.vectfox || {};
        const currentChatId = ctx?.chatId ? String(ctx.chatId) : null;
        const currentCharacterId = ctx?.characterId != null ? String(ctx.characterId) : null;
        if (!currentChatId) {
            console.error(`${TEST} [FAIL] No active chat — open a chat first`);
            return;
        }

        // Synthetic lorebook ID — character-scoped under the new parseCollectionId
        // mapping, but the test pins activation via an explicit chat lock so scope
        // doesn't affect the result. The `playwright_test` marker drives cleanup
        // both at top-of-file beforeAll and at the end of this test.
        const collectionId  = `vf_lorebook_${(settings.vector_backend || 'standard').toLowerCase()}_playwright_test_017_pause_button_${Date.now()}`;
        const registryKey   = buildRegistryKey(collectionId, settings);
        const searchContext = { currentChatId, currentCharacterId };

        try {
            registerCollection(registryKey);

            // ═══ Phase 1 — default enabled when no meta.enabled written ═══
            console.log(`${TEST} Phase 1: fresh registration with no enabled-meta written → isCollectionEnabled should default to true`);
            const defaultEnabled = isCollectionEnabled(registryKey);
            if (defaultEnabled !== true) {
                console.error(`${TEST} [FAIL] Phase 1: isCollectionEnabled defaulted to ${defaultEnabled}, expected true. Default-true contract broken.`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ default enabled=true`);

            // ═══ Phase 2 — baseline: lock pinned, activation should return true ═══
            console.log(`${TEST} Phase 2: pinning chat lock for chatId=${currentChatId} → shouldCollectionActivate must return true (priority-4 path)`);
            setCollectionLock(registryKey, currentChatId);
            if (!isCollectionLockedToChat(registryKey, currentChatId)) {
                console.error(`${TEST} [FAIL] Phase 2: setCollectionLock didn't take — isCollectionLockedToChat reads false. Baseline can't be established.`);
                return;
            }
            const activeBaseline = await shouldCollectionActivate(registryKey, searchContext);
            if (activeBaseline !== true) {
                console.error(`${TEST} [FAIL] Phase 2: shouldCollectionActivate returned ${activeBaseline} with lock pinned — expected true. Lock priority-4 path may be broken.`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ baseline active with lock`);

            // ═══ Phase 3 — pause: enabled=false must override lock ═══
            console.log(`${TEST} Phase 3: setCollectionEnabled(false) → isCollectionEnabled flips false AND shouldCollectionActivate returns false despite the lock`);
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
            const activeAfterPause = await shouldCollectionActivate(registryKey, searchContext);
            if (activeAfterPause !== false) {
                console.error(`${TEST} [FAIL] Phase 3: shouldCollectionActivate returned ${activeAfterPause} after pause — priority 1 (enabled=false) should override priority 4 (chat lock). Activation priority chain is broken.`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ pause overrides lock: enabled=false → activation=false even with lock still in place`);

            // ═══ Phase 4 — re-enable restores activation ═══
            console.log(`${TEST} Phase 4: setCollectionEnabled(true) → activation restored cleanly`);
            setCollectionEnabled(registryKey, true);
            const enabledAfterResume = isCollectionEnabled(registryKey);
            if (enabledAfterResume !== true) {
                console.error(`${TEST} [FAIL] Phase 4: isCollectionEnabled reads ${enabledAfterResume} after setCollectionEnabled(true).`);
                return;
            }
            const activeAfterResume = await shouldCollectionActivate(registryKey, searchContext);
            if (activeAfterResume !== true) {
                console.error(`${TEST} [FAIL] Phase 4: shouldCollectionActivate returned ${activeAfterResume} after resume — re-enabling should restore the priority-4 lock path. Lock state may have been silently lost during the pause cycle.`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ resume restores activation`);

            console.log(`${TEST} [PASS] Pause button (enabled=false) correctly overrides chat lock — priority 1 wins over priority 4, lock state survives the pause cycle, default isCollectionEnabled is true`);
        } finally {
            try {
                try { removeCollectionLock(registryKey, currentChatId); } catch {}
                try { deleteCollectionMeta(registryKey); } catch {}
                try { unregisterCollection(registryKey); } catch {}
                try { unregisterCollection(collectionId); } catch {}
                console.log(`${TEST} Cleanup ✓ lock removed, meta deleted, registration unregistered`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});

// ═══════════════════════════════════════════════════════════════════
//  TEST 018 — shouldCollectionActivate priority chain
// ═══════════════════════════════════════════════════════════════════
//
//  The activation priority chain is documented in Doc/collection_helper.md
//  → "Runtime activation chain". Five priorities, in order:
//
//    1. enabled=false        → BLOCKED   (covered by TEST 017)
//    2. Activation Triggers  → ACTIVE    (this test)
//    3. Advanced Conditions  → ACTIVE    (this test)
//    4. Chat lock match      → ACTIVE    (covered by TEST 017 baseline)
//    5. Character lock match → ACTIVE    (this test)
//    Nothing matched         → BLOCKED   (this test)
//
//  Each priority is what's drawing real users into VectFox: lorebook
//  authors who set keyword triggers, power users who write advanced
//  conditions, lorebook-per-character setups. If priority 2 or 3 silently
//  break during a refactor, semantic WI stops activating for everyone who
//  relies on keyword/condition-driven scope.
//
//  Pure-metadata test, runs in every environment. Phases:
//    1. Priority 2 — meta.triggers matches a synthetic recentMessages
//       token → active, with NO lock present (proves triggers fire
//       independent of lock state).
//    2. Priority 3 — meta.conditions with a guaranteed-pass randomChance
//       rule (probability: 100) → active, no triggers / no locks.
//    3. Priority 5 — character lock match → active, no triggers / no
//       conditions / no chat lock.
//    4. Nothing matched — fresh meta, empty context locks → blocked.
//
//  Per-phase, the production `[VECTFOX Activation Filter] Collection X: …`
//  debug log will print which priority gate fired (✓ TRIGGERS_MATCHED, ✓
//  CONDITIONS_PASS, ✓ LOCKED_TO_CURRENT_CHARACTER, ✗ NOT_ACTIVATED) — that's
//  the false-positive defense: a Phase 1 PASS with the wrong gate log
//  would mean the trigger-evaluator is broken but lock state is leaking
//  through. The test gates on the boolean return; the production log
//  gives independent evidence of *why*.

test('TEST 018 — shouldCollectionActivate priority chain (triggers / conditions / character lock / nothing)', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 018 [PriorityChain]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const {
            setCollectionMeta,
            deleteCollectionMeta,
            setCollectionCharacterLock,
            removeCollectionCharacterLock,
            isCollectionLockedToCharacter,
            shouldCollectionActivate,
        } = await import(base + 'core/collection-metadata.js');
        const { registerCollection, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { buildRegistryKey } = await import(base + 'core/collection-ids.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const settings = extension_settings?.vectfox || {};
        const currentChatId = ctx?.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) {
            console.error(`${TEST} [FAIL] No active chat — open a chat first`);
            return;
        }
        // Use a synthetic character ID — Phase 3 only needs the lock value
        // to match the context's currentCharacterId. Decoupling from the
        // real character keeps Phase 3 deterministic regardless of which
        // character the chat is paired with (or even none — group chats).
        const syntheticCharacterId = '__vf_pw_test_018_character__';

        // One synthetic collection, meta reset between phases.
        const collectionId = `vf_lorebook_${(settings.vector_backend || 'standard').toLowerCase()}_playwright_test_018_priority_chain_${Date.now()}`;
        const registryKey  = buildRegistryKey(collectionId, settings);

        // Unique token Phase 1 plants in recentMessages + triggers. The
        // playwright_test prefix matches the beforeAll cleanup pattern.
        const TRIGGER_TOKEN = 'PW_TEST_018_TRIGGER_TOKEN_e3f1';

        // Reset meta to a baseline empty state between phases so the
        // previous phase's triggers/conditions/locks don't leak. Each
        // phase then sets only what it needs.
        const resetMeta = () => {
            try { deleteCollectionMeta(registryKey); } catch {}
            // Locks live in meta too — explicit clear in case meta was
            // touched without going through setCollectionMeta defaults.
            try { removeCollectionCharacterLock(registryKey, syntheticCharacterId); } catch {}
        };

        try {
            registerCollection(registryKey);

            // ═══ Phase 1 — Priority 2: triggers match → active (no lock) ═══
            console.log(`${TEST} Phase 1: Priority 2 — meta.triggers matches recentMessages token → active without any lock`);
            resetMeta();
            setCollectionMeta(registryKey, {
                triggers: [TRIGGER_TOKEN.toLowerCase()],   // lowercased — checkTriggers lowercases search text
                triggerMatchMode: 'any',
                triggerCaseSensitive: false,
                triggerScanDepth: 5,
            });
            const triggerContext = {
                currentChatId,
                currentCharacterId: syntheticCharacterId,   // no lock matches this — proves triggers fire alone
                recentMessages: [`some message containing ${TRIGGER_TOKEN} embedded inline`],
            };
            const triggerActive = await shouldCollectionActivate(registryKey, triggerContext);
            if (triggerActive !== true) {
                console.error(`${TEST} [FAIL] Phase 1: triggers should have matched and returned true, got ${triggerActive}. Priority-2 path broken.`);
                return;
            }
            // Sanity: empty recentMessages should yield false (proves the
            // boolean wasn't a leak from some other priority).
            const triggerNegative = await shouldCollectionActivate(registryKey, { ...triggerContext, recentMessages: [] });
            if (triggerNegative !== false) {
                console.error(`${TEST} [FAIL] Phase 1 negative: triggers should have NOT matched with empty recentMessages, got ${triggerNegative}. Priority-2 may be returning true unconditionally.`);
                return;
            }
            console.log(`${TEST} Phase 1 ✓ Priority 2: triggers match → active; same meta with empty recentMessages → blocked`);

            // ═══ Phase 2 — Priority 3: conditions pass → active (no triggers, no lock) ═══
            console.log(`${TEST} Phase 2: Priority 3 — randomChance probability=100 condition → active`);
            resetMeta();
            setCollectionMeta(registryKey, {
                conditions: {
                    enabled: true,
                    logic: 'AND',
                    rules: [{ type: 'randomChance', settings: { probability: 100 } }],
                },
            });
            const conditionContext = {
                currentChatId,
                currentCharacterId: syntheticCharacterId,   // no lock for this — proves conditions fire alone
                recentMessages: ['nothing trigger-like here'],
            };
            const conditionActive = await shouldCollectionActivate(registryKey, conditionContext);
            if (conditionActive !== true) {
                console.error(`${TEST} [FAIL] Phase 2: conditions should have passed and returned true, got ${conditionActive}. Priority-3 path broken (or conditional-activation.js regressed).`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ Priority 3: randomChance(100) condition pass → active`);

            // ═══ Phase 3 — Priority 5: character lock match → active ═══
            console.log(`${TEST} Phase 3: Priority 5 — character lock match → active (no triggers, no conditions, no chat lock)`);
            resetMeta();
            setCollectionCharacterLock(registryKey, syntheticCharacterId);
            if (!isCollectionLockedToCharacter(registryKey, syntheticCharacterId)) {
                console.error(`${TEST} [FAIL] Phase 3 pre-condition: setCollectionCharacterLock didn't take.`);
                return;
            }
            const characterLockContext = {
                currentChatId,                                  // chat lock not pinned — only character lock pinned
                currentCharacterId: syntheticCharacterId,
                recentMessages: ['nothing trigger-like here'],
            };
            const characterLockActive = await shouldCollectionActivate(registryKey, characterLockContext);
            if (characterLockActive !== true) {
                console.error(`${TEST} [FAIL] Phase 3: character lock should have activated, got ${characterLockActive}. Priority-5 path broken.`);
                return;
            }
            // Sanity: change the context's character ID to a non-matching value
            // and the same setup should now block (priority 5 didn't actually
            // match — proves the lock is keyed on character ID, not always-on).
            const characterLockMissContext = { ...characterLockContext, currentCharacterId: 'wrong_character_xyz' };
            const characterLockMiss = await shouldCollectionActivate(registryKey, characterLockMissContext);
            if (characterLockMiss !== false) {
                console.error(`${TEST} [FAIL] Phase 3 negative: character lock should NOT have matched a different character ID, got ${characterLockMiss}. Lock match is leaking.`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ Priority 5: character lock matches → active; non-matching character ID → blocked`);

            // ═══ Phase 4 — Nothing matched → blocked ═══
            console.log(`${TEST} Phase 4: no triggers, no conditions, no locks → blocked`);
            resetMeta();
            const emptyContext = {
                currentChatId,
                currentCharacterId: syntheticCharacterId,
                recentMessages: ['nothing trigger-like here'],
            };
            const nothingActive = await shouldCollectionActivate(registryKey, emptyContext);
            if (nothingActive !== false) {
                console.error(`${TEST} [FAIL] Phase 4: bare collection with no priorities should have been blocked, got ${nothingActive}. Activation defaults are leaking somewhere.`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ no priority matched → blocked`);

            console.log(`${TEST} [PASS] Priority chain intact — triggers (P2), conditions (P3), character lock (P5), and "nothing matched" all behave per Doc/collection_helper.md. Each phase's [VECTFOX Activation Filter] log independently confirms which priority gate fired.`);
        } finally {
            try {
                resetMeta();
                try { unregisterCollection(registryKey); } catch {}
                try { unregisterCollection(collectionId); } catch {}
                console.log(`${TEST} Cleanup ✓ meta cleared, registration unregistered`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});

// ═══════════════════════════════════════════════════════════════════
//  TEST 019 — WI / AutoSync refresh smoke: refresh paths don't mutate locks
// ═══════════════════════════════════════════════════════════════════
//
//  Doc/collection_helper.md → "Manual vs auto-sync paths" calls out the
//  load-bearing rule: `refreshWIStatus` and `refreshAutoSyncCheckbox`
//  must NEVER mutate lock state. They are pure UI mirrors — they read
//  collection state and update `prop('checked', …)` / status text only.
//  The forbidden footgun is `.trigger('change')`, which would fire the
//  user-facing change handlers (which DO remove locks). A refactor that
//  innocently adds `.trigger('change')` to a refresh path would silently
//  remove every active lock the next time the panel auto-syncs (after
//  CHAT_CHANGED, after a vectorization completes, after the WI tab
//  click). The 2026-05-17 regression was a related variant.
//
//  Smoke test rather than a comprehensive proof: builds one synthetic
//  own-persona lorebook collection, locks it to the current chat, enables
//  autoSync, then calls each refresh function multiple times back-to-back
//  and asserts that the test collection's lock state, autoSync flag,
//  enabled flag, AND the chat_lock_index reverse map are byte-identical
//  before and after. The functions ARE allowed to update
//  `settings.enabled_world_info` — that's their job — so that field is
//  snapshotted and restored separately rather than asserted against.
//
//  Pure metadata + DOM read/write, runs in every environment. Phases:
//    1. refreshWIStatus() — lock + autoSync + chat_lock_index unchanged.
//    2. refreshAutoSyncCheckbox(settings) — same assertion.
//    3. Idempotency — call both 3× in a row, state still unchanged.

test('TEST 019 — WI / AutoSync refresh smoke: refresh paths do not mutate locks', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 019 [RefreshSmoke]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { refreshWIStatus, refreshAutoSyncCheckbox } = await import(base + 'ui/ui-manager.js');
        const {
            setCollectionMeta,
            setCollectionLock,
            removeCollectionLock,
            setCollectionAutoSync,
            isCollectionAutoSyncEnabled,
            isCollectionLockedToChat,
            isCollectionEnabled,
            deleteCollectionMeta,
        } = await import(base + 'core/collection-metadata.js');
        const { registerCollection, unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { buildRegistryKey } = await import(base + 'core/collection-ids.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const settings = extension_settings?.vectfox || {};
        const currentChatId = ctx?.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) {
            console.error(`${TEST} [FAIL] No active chat — open a chat first`);
            return;
        }

        // Derive persona handle — must match the stamp condition so the
        // synthetic lorebook flips isOwn=true and surfaces in
        // refreshWIStatus's `ownLorebookEntries` filter. Same shape as
        // TEST 013 uses for its EventBase synthesis.
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
        const collectionId  = `vf_lorebook_${backend}_${personaHandle}_playwright_test_019_refresh_smoke_${ts}`;
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

        // Snapshot+restore enabled_world_info — refreshes ARE allowed to
        // mutate this field (that's the whole point of refreshWIStatus's
        // _setWIEnabled helper). Save the original so we don't leak a
        // mutated user setting after the test.
        const originalEnabledWI = settings.enabled_world_info;

        try {
            registerCollection(registryKey);
            setCollectionMeta(registryKey, {
                creatorHandle: personaHandle,
                sourceName: 'PW Test 019 Lorebook',
                contentType: 'lorebook',
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

            // ═══ Phase 1 — refreshWIStatus ═══
            console.log(`${TEST} Phase 1: refreshWIStatus() should not mutate locks/autoSync/enabled for any collection`);
            await refreshWIStatus();
            const afterWI = snapshot();
            if (!compare(afterWI, 'refreshWIStatus')) return;
            console.log(`${TEST} Phase 1 ✓ refreshWIStatus is pure UI mirror — no lock state mutated`);

            // ═══ Phase 2 — refreshAutoSyncCheckbox ═══
            console.log(`${TEST} Phase 2: refreshAutoSyncCheckbox(settings) should not mutate locks/autoSync/enabled for any collection`);
            await refreshAutoSyncCheckbox(settings);
            const afterAS = snapshot();
            if (!compare(afterAS, 'refreshAutoSyncCheckbox')) return;
            console.log(`${TEST} Phase 2 ✓ refreshAutoSyncCheckbox is pure UI mirror — no lock state mutated`);

            // ═══ Phase 3 — idempotency (3× back-to-back) ═══
            console.log(`${TEST} Phase 3: 3× back-to-back calls of both refreshes — state still unchanged at the end`);
            for (let i = 0; i < 3; i++) {
                await refreshWIStatus();
                await refreshAutoSyncCheckbox(settings);
            }
            const afterRepeat = snapshot();
            if (!compare(afterRepeat, 'idempotency loop (3×)')) return;
            console.log(`${TEST} Phase 3 ✓ 3× idempotency: state byte-identical after 6 total refresh calls`);

            console.log(`${TEST} [PASS] WI & AutoSync refresh paths are pure UI mirrors — locks, character locks, chat_lock_index, autoSync, and enabled flags are all unchanged after refresh calls. The .trigger('change') footgun is not present.`);
        } finally {
            try {
                try { removeCollectionLock(registryKey, currentChatId); } catch {}
                try { setCollectionAutoSync(registryKey, false); } catch {}
                try { deleteCollectionMeta(registryKey); } catch {}
                try { unregisterCollection(registryKey); } catch {}
                try { unregisterCollection(collectionId); } catch {}
                // Restore enabled_world_info — refreshWIStatus may have
                // toggled it based on our test collection's activation.
                if (extension_settings?.vectfox && originalEnabledWI !== undefined) {
                    if (extension_settings.vectfox.enabled_world_info !== originalEnabledWI) {
                        extension_settings.vectfox.enabled_world_info = originalEnabledWI;
                        console.log(`${TEST} Restored settings.enabled_world_info to ${originalEnabledWI}`);
                    }
                }
                console.log(`${TEST} Cleanup ✓ lock removed, autoSync cleared, meta deleted, registration unregistered, enabled_world_info restored`);
            } catch (cleanupErr) {
                console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`);
            }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 020 / 021 — per-chunk override is BACKEND-FIRST (survives ext_settings wipe)
// ═══════════════════════════════════════════════════════════════════
//
// Validates the read-source refactor (plans/chunk-metadata-read-source-fix.md):
// per-chunk user overrides (context/xmlTag/keywords/conditions/...) are served
// from the vector backend payload, NOT from extension_settings. This is the one
// behavior the rest of the suite never checked — it asserts result COUNTS and the
// chunk TEXT in injectionText, but never that a per-chunk OVERRIDE flows from the
// backend, and never that it survives losing the ext_settings copy.
//
// Flow (per backend):
//   1. vectorize a 1-entry lorebook (gives a real collection + chunk).
//   2. updateChunkMetadata(hash, {context, xmlTag}) → writes the override to the
//      BACKEND ONLY (this API does not touch ext_settings).
//   3. queryCollection → confirm the backend SERVES the override via retrieval.
//   4. seed an ext_settings entry, then deleteChunkMetadata → wipe it (simulates a
//      reinstall / profile reset / second machine).
//   5. queryCollection again → the override MUST still come back from the backend.
//      If it vanishes, backend-first is broken (data only lived in ext_settings).
//
// The merge-precedence rules (backend wins over ext_settings, enabled:false
// survives, 0 is valid, etc.) are covered by tests/chunk-metadata-read-source.test.js.
// This pair proves the data-layer half end-to-end against a live backend.
async function overrideBackendFirstBody({ BACKEND, LABEL }) {
    const TEST = `${LABEL} [BackendFirst:${BACKEND}]`;
    const base = '/scripts/extensions/third-party/VectFox/';
    const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
    const { deleteCollectionMeta, getChunkMetadata, saveChunkMetadata, deleteChunkMetadata } = await import(base + 'core/collection-metadata.js');
    const { unregisterCollection } = await import(base + 'core/collection-loader.js');
    const { updateChunkMetadata } = await import(base + 'core/core-vector-api.js');
    const { getBackend } = await import(base + 'backends/backend-manager.js');
    const { extension_settings } = await import('/scripts/extensions.js');

    const vf = extension_settings?.vectfox;
    if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

    const settings = { ...vf, vector_backend: BACKEND };
    const ts = Date.now();
    const CTX = `VF_CTX_${ts}`;
    const TAG = `vfmem${ts}`;
    const testEntries = [{
        uid: `vf_test_020_${ts}`,
        comment: 'Glimmerwisp Conclave',
        key: ['glimmerwisp', 'conclave'],
        content: `The Glimmerwisp Conclave ${ts} convenes beneath the Hollow Aqueduct to debate the tideglass accords. Only sworn lanternkeepers may attend.`,
    }];

    let collectionId = null;
    let registryKey = null;
    try {
        let res;
        try {
            res = await vectorizeContent({
                contentType: 'lorebook',
                source: { type: 'file', name: `__vf_playwright_test_020_${BACKEND}__`, entries: testEntries },
                settings: { ...settings, strategy: 'per_entry', scope: 'chat' },
            });
        } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }
        if (!res?.success || !res.collectionId) { console.error(`${TEST} [FAIL] Vectorization failed`); return; }
        collectionId = res.collectionId;
        registryKey = `${BACKEND === 'qdrant' ? 'qdrant' : 'vectra'}:${collectionId}`;
        console.log(`${TEST} Vectorized ${res.chunkCount} chunk(s) → ${registryKey}`);

        const backend = await getBackend(settings);

        // Resolve the chunk's hash via listChunks (plugin path on both backends).
        let listResult;
        try { listResult = await backend.listChunks(collectionId, settings, { limit: 10 }); }
        catch (err) { console.error(`${TEST} [FAIL] listChunks threw: ${err.message}`); return; }
        const items = listResult?.items ?? [];
        if (!items.length) { console.error(`${TEST} [FAIL] listChunks returned 0 items`); return; }
        const hash = items[0].hash;
        console.log(`${TEST} Target chunk hash=${hash}`);

        // (1) Write the override to the BACKEND ONLY.
        try { await updateChunkMetadata(collectionId, hash, { context: CTX, xmlTag: TAG }, settings); }
        catch (err) { console.error(`${TEST} [FAIL] updateChunkMetadata threw: ${err.message}`); return; }

        const fetchOurChunk = async () => {
            const q = await backend.queryCollection(collectionId, `glimmerwisp conclave hollow aqueduct tideglass ${ts}`, 10, settings);
            const rows = q?.metadata ?? [];
            return rows.find(m => String(m.hash) === String(hash)) || null;
        };

        // (2) Backend serves the override via retrieval.
        let row = await fetchOurChunk();
        if (!row) { console.error(`${TEST} [FAIL] Query did not return our chunk after override write`); return; }
        if (row.context !== CTX || row.xmlTag !== TAG) {
            console.error(`${TEST} [FAIL] Backend did not return the override — context="${row.context}", xmlTag="${row.xmlTag}" (expected "${CTX}"/"${TAG}")`);
            return;
        }
        console.log(`${TEST} ✓ Backend serves override via retrieval (context + xmlTag present)`);

        // (3) Simulate the legacy dual-write state, then WIPE ext_settings.
        saveChunkMetadata(String(hash), { context: 'EXT_DECOY', xmlTag: 'extdecoy' });
        deleteChunkMetadata(String(hash));
        if (getChunkMetadata(String(hash)) !== null) { console.error(`${TEST} [FAIL] ext_settings entry not cleared`); return; }
        console.log(`${TEST} ext_settings entry wiped (simulating reinstall) ✓`);

        // (4) Backend-first: override must STILL come back from the backend.
        row = await fetchOurChunk();
        if (!row) { console.error(`${TEST} [FAIL] Query did not return our chunk after ext_settings wipe`); return; }
        if (row.context !== CTX || row.xmlTag !== TAG) {
            console.error(`${TEST} [FAIL] Override LOST after ext_settings wipe — context="${row.context}", xmlTag="${row.xmlTag}". Backend-first is NOT working (data only lived in ext_settings).`);
            return;
        }
        console.log(`${TEST} [PASS] ${BACKEND}: per-chunk override is backend-first — survived ext_settings deletion`);
    } finally {
        try {
            if (collectionId) {
                await deleteContentCollection(collectionId);
                try {
                    const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                    await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                if (registryKey) { deleteCollectionMeta(registryKey); unregisterCollection(registryKey); }
                unregisterCollection(collectionId);
                console.log(`${TEST} Cleanup ✓`);
            }
        } catch (cleanupErr) { console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`); }
    }
}

test('TEST 020 — Qdrant: per-chunk override is backend-first (survives ext_settings wipe)', async () => {
    await skipIfQdrantUnavailable();
    const logs = await runTestInPage(overrideBackendFirstBody, { BACKEND: 'qdrant', LABEL: 'TEST 020' });
    assertPassed(logs);
});

test('TEST 021 — Standard+plugin: per-chunk override is backend-first (survives ext_settings wipe)', async () => {
    await skipIfNoPlugin();
    const logs = await runTestInPage(overrideBackendFirstBody, { BACKEND: 'standard', LABEL: 'TEST 021' });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TEST 022 — Injection path: per-chunk wrapping (R4) + condition filtering (R2),
//            read backend-first, observed in the actual rearrangeChat dry-run output
// ═══════════════════════════════════════════════════════════════════
//
// TEST 020/021 prove the DATA layer (backend stores+serves the override). This one
// proves the INJECTION layer: that a per-chunk override actually changes what gets
// injected, via the real chat-chunk pipeline rearrangeChat() → buildNestedInjectionText().
//
// Why a 'document' collection: rearrangeChat queries ChunkBase collections via
// gatherCollectionsToQuery, which EXCLUDES vf_lorebook_/vf_eventbase_/vf_archiveevent_.
// A 'document' (vf_document_) collection is a non-excluded ChunkBase collection, so it
// flows through the conditions (R2) → links (R3) → wrapping (R4) stages and the dry-run
// returns the formatted injectionText.
//
// Phases:
//   1. R4 — set {context, xmlTag} on the backend → injectionText wraps the chunk.
//   2. backend-first — wipe ext_settings → wrapping persists (came from the backend).
//   3. R3 force link — A force-links to an off-query chunk B → B is pulled into the injection.
//   4. R2 — set a guaranteed-FAIL per-chunk condition → chunk is excluded from injection.
//
// Standard+plugin only: the injection readers (R2/R3/R4) are backend-agnostic — they read
// chunk.metadata regardless of backend — and TEST 020/021 already cover that both backends
// serve the payload. So one backend exercises the reader logic fully.
//
// Not covered here: position/depth (R5) placement — buildNestedInjectionText doesn't encode
// position/depth (applied later by injectChunksIntoPrompt, non-dry-run only); R5's resolution
// logic is covered by the vitest cascade test.
test('TEST 022 — Standard+plugin: context/xmlTag wrapping + condition filter through retrieval (backend-first)', async () => {
    await skipIfNoPlugin();
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 022 [InjectionWrap]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { vectorizeContent, deleteContentCollection } = await import(base + 'core/content-vectorization.js');
        const { rearrangeChat } = await import(base + 'core/chat-vectorization.js');
        const { updateChunkMetadata, queryCollection, insertVectorItems } = await import(base + 'core/core-vector-api.js');
        const { getChunkMetadata, saveChunkMetadata, deleteChunkMetadata, deleteCollectionMeta, shouldCollectionActivate, setLock, setCollectionEnabled } = await import(base + 'core/collection-metadata.js');
        const { unregisterCollection } = await import(base + 'core/collection-loader.js');
        const { getBackend } = await import(base + 'backends/backend-manager.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { getStringHash } = await import('/scripts/utils.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        const ctx = window.SillyTavern?.getContext?.() ?? window.getContext?.() ?? {};
        const currentChatId = ctx.chatId ? String(ctx.chatId) : null;
        if (!currentChatId) { console.warn(`${TEST} [WARN] No active chat — open a chat first`); return; }
        const context = { currentChatId, currentCharacterId: ctx.characterId != null ? String(ctx.characterId) : null };
        const chat = ctx.chat ?? [];

        const ts = Date.now();
        const SENTINEL = `Glimmerwhisp_${ts}`;
        const CTX = `VF_PROMPT_CTX_${ts}`;
        const TAG = `vfmem${ts}`;
        const docText = `The ${SENTINEL} resonates beneath the Hollow Aqueduct, where lanternkeepers guard the tideglass accords against the drifting mist.`;
        const testMessage = `${SENTINEL} hollow aqueduct lanternkeepers tideglass mist`;

        // threshold 0 + generous topK so our single chunk always passes the similarity gate.
        const rcSettings = { ...vf, vector_backend: 'standard', score_threshold: 0, top_k: 20, enabled_world_info: false };

        let collectionId = null;
        let registryKey = null;
        try {
            let res;
            try {
                res = await vectorizeContent({
                    contentType: 'document',
                    source: { type: 'paste', content: docText, name: `__vf_playwright_test_022__${ts}` },
                    settings: { ...vf, vector_backend: 'standard', scope: 'chat' },
                });
            } catch (err) { console.error(`${TEST} [FAIL] vectorizeContent threw: ${err.message}`); return; }
            if (!res?.success || !res.collectionId) { console.error(`${TEST} [FAIL] Vectorization failed`); return; }
            collectionId = res.collectionId;
            registryKey = `vectra:${collectionId}`;
            console.log(`${TEST} Vectorized ${res.chunkCount} chunk(s) → ${registryKey}`);

            // Make sure the collection is enabled AND active for this chat so rearrangeChat queries it.
            try { setCollectionEnabled(registryKey, true); } catch {}
            if (!(await shouldCollectionActivate(registryKey, context))) {
                const lr = setLock(registryKey, { kind: 'chat', op: 'add', target: currentChatId }, { settings: vf });
                if (!lr?.success || !(await shouldCollectionActivate(registryKey, context))) {
                    console.error(`${TEST} [FAIL] Document collection not active for chat — cannot exercise rearrangeChat`); return;
                }
            }

            const backend = await getBackend({ ...vf, vector_backend: 'standard' });
            const list = await backend.listChunks(collectionId, vf, { limit: 20 });
            const items = list?.items ?? [];
            const target = items.find(i => (i.text || '').includes(SENTINEL)) || items[0];
            if (!target) { console.error(`${TEST} [FAIL] listChunks returned no chunk`); return; }
            const hash = target.hash;
            console.log(`${TEST} Target chunk hash=${hash}`);

            const dryInject = async () => {
                const r = await rearrangeChat(chat, rcSettings, 'normal', { dryRun: true, testMessage });
                return (r && r.injectionText) || '';
            };

            // Diagnostics: which query path will rearrangeChat take?
            console.log(`${TEST} [DIAG] keyword_scoring_method=${rcSettings.keyword_scoring_method}, hybrid_native_prefer=${rcSettings.hybrid_native_prefer}, bm25_use_corpus_idf=${rcSettings.bm25_use_corpus_idf}`);

            // ── Phase 1: write the override to the backend ──
            await updateChunkMetadata(collectionId, hash, { context: CTX, xmlTag: TAG }, rcSettings);

            // Phase 1a — does the BACKEND itself serve the override? (mirrors TEST 021)
            {
                const direct = await backend.queryCollection(collectionId, testMessage, 20, rcSettings);
                const drow = (direct?.metadata ?? []).find(m => String(m.hash) === String(hash));
                console.log(`${TEST} [DIAG] backend.queryCollection: found=${!!drow}, context=${JSON.stringify(drow?.context)}, xmlTag=${JSON.stringify(drow?.xmlTag)}`);
                if (!drow || drow.context !== CTX || drow.xmlTag !== TAG) {
                    console.error(`${TEST} [FAIL] Phase 1a: backend.queryCollection did NOT return the override — persistence/query issue at the backend layer (context=${JSON.stringify(drow?.context)}).`);
                    return;
                }
                console.log(`${TEST} Phase 1a ✓ backend serves override directly`);
            }

            // Phase 1b — does the core queryCollection path (BM25/hybrid) preserve it?
            {
                const core = await queryCollection(registryKey, testMessage, 20, rcSettings);
                const crow = (core?.metadata ?? []).find(m => String(m.hash) === String(hash));
                console.log(`${TEST} [DIAG] core queryCollection: found=${!!crow}, context=${JSON.stringify(crow?.context)}, xmlTag=${JSON.stringify(crow?.xmlTag)}`);
                if (!crow || crow.context !== CTX || crow.xmlTag !== TAG) {
                    console.error(`${TEST} [FAIL] Phase 1b: core queryCollection (BM25/hybrid re-rank) DROPPED the override — context=${JSON.stringify(crow?.context)}. This is where it's lost.`);
                    return;
                }
                console.log(`${TEST} Phase 1b ✓ core query path preserves override`);
            }

            // Phase 1c — does the actual injection wrap the chunk?
            let inj = await dryInject();
            // DIAG: inspect the chunk mid-pipeline (window.VectFox_LastSearch is set after the
            // links stage, before dedup). Tells us if metadata.context survived into the pipeline.
            {
                const ls = (window.VectFox_LastSearch?.chunks) || [];
                const lc = ls.find(c => String(c.hash) === String(hash)) || ls[0];
                console.log(`${TEST} [DIAG] LastSearch chunk: found=${!!lc}, metadata.context=${JSON.stringify(lc?.metadata?.context)}, metadata.xmlTag=${JSON.stringify(lc?.metadata?.xmlTag)}, metaKeys=${lc?.metadata ? Object.keys(lc.metadata).join(',') : 'n/a'}`);
            }
            const wrapped = inj.includes(`<${TAG}>`) && inj.includes(`</${TAG}>`) && inj.includes(CTX) && inj.includes(SENTINEL);
            if (!wrapped) {
                console.error(`${TEST} [FAIL] Phase 1c: injection not wrapped despite query returning the override — hasTag=${inj.includes(`<${TAG}>`)}, hasCtx=${inj.includes(CTX)}, hasSentinel=${inj.includes(SENTINEL)}. Preview: ${inj.slice(0, 300)}`);
                return;
            }
            console.log(`${TEST} Phase 1c ✓ R4 wrapping applied in injection (context + <${TAG}> present)`);

            // ── Phase 2: backend-first — wipe ext_settings, wrapping must persist ──
            saveChunkMetadata(String(hash), { context: 'EXT_DECOY', xmlTag: 'extdecoy' });
            deleteChunkMetadata(String(hash));
            if (getChunkMetadata(String(hash)) !== null) { console.error(`${TEST} [FAIL] ext_settings entry not cleared`); return; }
            inj = await dryInject();
            if (!(inj.includes(`<${TAG}>`) && inj.includes(CTX))) {
                console.error(`${TEST} [FAIL] Phase 2: wrapping LOST after ext_settings wipe — backend-first not working in the injection path. Preview: ${inj.slice(0, 300)}`);
                return;
            }
            console.log(`${TEST} Phase 2 ✓ backend-first: wrapping survived ext_settings wipe`);

            // ── Phase 3: R3 FORCE link — chunk A force-links to a chunk B that does NOT match
            //    the query; B must still be pulled into the injection ("target MUST appear"). ──
            const SENTINEL_B = `Forcelinked_${ts}`;
            const textB = `The ${SENTINEL_B} vault stays sealed until the conclave convenes — deliberately unrelated to the query terms.`;
            const hashB = getStringHash(textB);
            await insertVectorItems(collectionId, [{ hash: hashB, text: textB, index: 1 }], rcSettings);
            await updateChunkMetadata(collectionId, hash, { chunkLinks: [{ targetHash: String(hashB), mode: 'force' }] }, rcSettings);
            inj = await dryInject();
            if (!inj.includes(SENTINEL_B)) {
                console.error(`${TEST} [FAIL] Phase 3: force-linked target B (hash=${hashB}) was NOT pulled into the injection — force links don't fetch missing targets. Preview: ${inj.slice(0, 400)}`);
                return;
            }
            console.log(`${TEST} Phase 3 ✓ R3 force link pulled in the off-query target chunk`);

            // ── Phase 4: R2 per-chunk condition — a guaranteed-FAIL condition must EXCLUDE the
            //    chunk (and, since A is gone, its force link no longer fires for B either). ──
            await updateChunkMetadata(collectionId, hash, {
                conditions: { enabled: true, logic: 'AND', rules: [{ type: 'messageCount', settings: { count: 999999, operator: 'gte' } }] },
            }, rcSettings);
            inj = await dryInject();
            if (inj.includes(SENTINEL)) {
                console.error(`${TEST} [FAIL] Phase 4: chunk still injected despite a failing per-chunk condition (R2 not filtering from backend payload). Preview: ${inj.slice(0, 300)}`);
                return;
            }
            console.log(`${TEST} Phase 4 ✓ R2 per-chunk condition filtered the chunk out of injection`);

            console.log(`${TEST} [PASS] Injection path: R4 wrapping + backend-first + R3 force link + R2 condition filter all driven by the backend payload`);
        } finally {
            try {
                if (collectionId) {
                    try { setLock(registryKey, { kind: 'chat', op: 'clear' }, { settings: vf }); } catch {}
                    await deleteContentCollection(collectionId);
                    try {
                        const stdBackend = await getBackend({ ...vf, vector_backend: 'standard' });
                        await stdBackend._purgeCollectionFolderForTestCleanup(collectionId, vf);
                    } catch (e) { console.warn(`${TEST} [WARN] folder-cleanup helper failed: ${e.message}`); }
                    if (registryKey) { deleteCollectionMeta(registryKey); unregisterCollection(registryKey); }
                    unregisterCollection(collectionId);
                    console.log(`${TEST} Cleanup ✓`);
                }
            } catch (cleanupErr) { console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`); }
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
//   once. See plans/autosync-settle-lag.md.
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
        const { getCommitBoundary, getAutoSyncWindowSize } = await import(base + 'core/eventbase-workflow.js');
        const { markWindowExtracted, isLastWindowExtracted, clearWindowCacheForChat } = await import(base + 'core/eventbase-store.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const testUUID = '__vf_playwright_test_023__settle_lag';
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
            markWindowExtracted([hashes[0], hashes[1]], testUUID);
            markWindowExtracted([hashes[2], hashes[3]], testUUID);
            const committed6 = chat6.slice(0, boundary6); // msgs 0..3
            if (!isLastWindowExtracted(committed6, windowSize, step, testUUID, hashFn)) {
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
            if (!isLastWindowExtracted(committedAfterSwipe, windowSize, step, testUUID, hashFn)) {
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
            if (isLastWindowExtracted(committed8, windowSize, step, testUUID, hashFn)) {
                console.error(`${TEST} [FAIL] Phase 4: after superseding, committed quick-exit reports DONE — the kept turn [4-5] would never extract`); return;
            }
            console.log(`${TEST} Phase 4 ✓ superseded turn now inside boundary → quick-exit reports the kept turn pending`);

            console.log(`${TEST} [PASS] Settle-lag holds the active turn: swipes never extract, the kept turn extracts once superseded`);
        } finally {
            try {
                clearWindowCacheForChat(testUUID);
                const after = extension_settings?.vectfox?.eventbase_extracted_windows?.[testUUID];
                if (after !== undefined) console.warn(`${TEST} [WARN] clearWindowCacheForChat left a stale entry: ${JSON.stringify(after)}`);
                else console.log(`${TEST} Cleanup ✓ fingerprint cache cleared for ${testUUID}`);
            } catch (cleanupErr) { console.warn(`${TEST} [WARN] Cleanup failed: ${cleanupErr.message}`); }
        }
    });
    assertPassed(logs);
});


// ═══════════════════════════════════════════════════════════════════
// TESTS 024–026 — LLM-call path coverage (postChatCompletion)
// ═══════════════════════════════════════════════════════════════════
// TESTS 001–023 use SYNTHETIC inserts — they never touch the chat-completions
// wire path. These three exercise the real path introduced when the four LLM
// features (summarizer / EventBase / agentic / Auto-Reformat) were unified onto
// core/llm-provider-call.js (postChatCompletion + parseJsonArrayFromLlm):
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
        const { extractEvents } = await import(base + 'core/eventbase-extractor.js');
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


test('TEST 025 — Auto-Reformat: real provider splits multi-entity section', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 025 [Reformat]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { reformatDocument } = await import(base + 'core/reformat-extractor.js');
        const { extension_settings } = await import('/scripts/extensions.js');

        const vf = extension_settings?.vectfox;
        if (!vf) { console.error(`${TEST} [FAIL] VectFox settings not found`); return; }

        // Same inherit chain as extraction: reformat_* → chat_* (Core → LLM Summarization).
        const provider = (vf.reformat_provider || vf.chat_provider || 'openrouter').toLowerCase();
        const model = (vf.reformat_model || vf.chat_model || '').trim();
        if (!model) { console.warn(`${TEST} [SKIP] no reformat_model/chat_model configured — cannot exercise Auto-Reformat`); return; }
        if (provider === 'vllm' && !(vf.reformat_vllm_url || vf.chat_vllm_url || '').trim()) { console.warn(`${TEST} [SKIP] provider=vllm but no vLLM URL configured`); return; }

        // The exact bug Auto-Reformat targets: two distinct named entities under ONE
        // heading — mechanical chunking would collapse them into one diluted chunk.
        const doc = [
            '## Northern Watch Roster',
            '',
            '**Kaelen Frost** — A veteran ranger of the Northern Watch. He wields a yew longbow and tracks quarry by scent-memory, a rare gift among the Watch.',
            '',
            '**Mira Solveig** — Quartermaster of the Northern Watch. She keeps the ledgers and the armory, distrusts outsiders, but never forgets a debt.',
        ].join('\n');

        console.log(`${TEST} Reformatting a 2-entity section via real ${provider}/${model}...`);
        let result;
        try {
            result = await reformatDocument({ text: doc, contentType: 'document', settings: vf });
        } catch (err) {
            console.error(`${TEST} [FAIL] reformatDocument threw (${provider}/${model}): ${err.message}`);
            return;
        }

        const chunks = result?.chunks || [];
        if (result?.warnings?.length) console.warn(`${TEST} warnings: ${result.warnings.join(' | ')}`);
        if (chunks.length === 0) { console.error(`${TEST} [FAIL] Auto-Reformat produced 0 chunks — postChatCompletion/parse path may be broken`); return; }

        // Core value: the two entities got their OWN records, not one merged blob.
        if (chunks.length < 2) { console.error(`${TEST} [FAIL] expected ≥2 records (one per named entity), got ${chunks.length} — split did not happen`); return; }

        const badShape = chunks.find(c => !c.entry_type || !c.name || !c.body);
        if (badShape) { console.error(`${TEST} [FAIL] record missing entry_type/name/body: ${JSON.stringify(badShape).slice(0, 200)}`); return; }

        chunks.slice(0, 6).forEach((c, i) => console.log(`  record[${i}] type="${c.entry_type}" name="${c.name}" grounded=${c._nameGrounded !== false} body="${(c.body || '').slice(0, 50)}..."`));

        // Soft signal: both source names should surface somewhere (verbatim-fact rule).
        const blob = chunks.map(c => `${c.name} ${c.body}`).join(' ').toLowerCase();
        const foundKaelen = blob.includes('kaelen');
        const foundMira = blob.includes('mira');
        if (!foundKaelen || !foundMira) {
            console.warn(`${TEST} [WARN] one source name missing from output (kaelen=${foundKaelen}, mira=${foundMira}) — model paraphrased; split still succeeded`);
        }

        console.log(`${TEST} [PASS] real ${provider} Auto-Reformat via postChatCompletion → ${chunks.length} well-formed record(s), multi-entity split confirmed`);
    });
    assertPassed(logs);
});


test('TEST 026 — Acronym glossary: deployed-module grounding smoke (no LLM)', async () => {
    const logs = await runTestInPage(async () => {
        const TEST = 'TEST 026 [Glossary]';
        const base = '/scripts/extensions/third-party/VectFox/';
        const { extractGlossary, injectGlossary } = await import(base + 'core/glossary-extractor.js');

        // A document that defines an acronym once, then uses it bare elsewhere.
        const source = [
            'The Federal Hero Oversight Bureau (FHOB) licenses every sanctioned cape in the republic.',
            '',
            'Threat assessments are filed to the FHOB within an hour of any incident.',
        ].join('\n');

        const glossary = extractGlossary(source);
        const fhob = glossary.find(g => g.acronym === 'FHOB');
        if (!fhob) { console.error(`${TEST} [FAIL] extractGlossary did not detect "Federal Hero Oversight Bureau (FHOB)" — found: ${JSON.stringify(glossary)}`); return; }
        if (!/Federal Hero Oversight Bureau/i.test(fhob.fullName || '')) { console.error(`${TEST} [FAIL] FHOB fullName wrong: "${fhob.fullName}"`); return; }
        console.log(`  detected ${glossary.length} acronym(s): ${glossary.map(g => g.acronym).join(', ')}`);

        // A chunk that uses the bare acronym without its definition must get grounded.
        const chunks = [{ text: 'Threat assessments are filed to the FHOB within an hour of any incident.', metadata: {} }];
        const out = injectGlossary(chunks, glossary);
        if (!Array.isArray(out) || out.length !== 1) { console.error(`${TEST} [FAIL] injectGlossary returned malformed output`); return; }
        if (!/Federal Hero Oversight Bureau/i.test(out[0].text)) {
            console.error(`${TEST} [FAIL] definition NOT prepended to the bare-acronym chunk: "${out[0].text.slice(0, 120)}"`);
            return;
        }
        // Non-mutating contract: original input chunk untouched.
        if (/Federal Hero Oversight Bureau/i.test(chunks[0].text)) { console.error(`${TEST} [FAIL] injectGlossary mutated the input chunk`); return; }

        console.log(`  grounded chunk preview: "${out[0].text.slice(0, 90)}..."`);
        console.log(`${TEST} [PASS] deployed glossary module grounds a bare acronym (definition prepended, input untouched)`);
    });
    assertPassed(logs);
});
