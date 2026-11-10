/**
 * ============================================================================
 * VectFox DEAD CODE DELETION — REGRESSION CONTRACT TEST
 * ============================================================================
 *
 * Pins the state after the dead-code cleanups in InternalProject/Vectfox/plans/executed/
 * (delete-dead-chunk-chat-and-temporal-decay.md, unwire-dead-chat-vectorize-options.md,
 * centralize-collection-listing.md): the removed code stays deleted, and the live code
 * beside it stays in place.
 *
 * Static analysis only: it reads source files and imports none of them, so it needs no
 * SillyTavern mocks and still runs when a module fails to resolve.
 *
 * @author Kritblade
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Source roots to scan. Anything outside these is ignored (node_modules, etc).
const SCAN_DIRS = ['src'];

// ============================================================================
// HELPERS
// ============================================================================

function readRel(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

function existsRel(relPath) {
    return fs.existsSync(path.join(ROOT, relPath));
}

function* walkSourceFiles() {
    for (const dir of SCAN_DIRS) {
        const abs = path.join(ROOT, dir);
        if (!fs.existsSync(abs)) continue;
        yield* walkDir(abs);
    }
}

function* walkDir(absDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            yield* walkDir(full);
        } else if (entry.isFile() && /\.(js|mjs|cjs|ts)$/.test(entry.name)) {
            yield full;
        }
    }
}

/**
 * Search every source file under SCAN_DIRS for `pattern` and return `file:line: text`
 * for each hit, so failure messages tell you exactly where the dead code is hiding.
 */
function grepSourcesWithLines(pattern) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const hits = [];
    for (const abs of walkSourceFiles()) {
        const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
        const lines = fs.readFileSync(abs, 'utf-8').split('\n');
        lines.forEach((line, i) => {
            if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    return hits;
}

// ============================================================================
// LIVE CODE — MUST CONTINUE TO PASS BEFORE AND AFTER DELETION
// ============================================================================

describe('Live code remains intact (regression guard)', () => {
    describe('EventBase pipeline (the chat path)', () => {
        it('src/features/eventbase/eventbase-workflow.js exists', () => {
            expect(existsRel('src/features/eventbase/eventbase-workflow.js')).toBe(true);
        });

        it('runEventBaseIngestion is exported', () => {
            expect(readRel('src/features/eventbase/eventbase-workflow.js'))
                .toMatch(/export\s+(?:async\s+)?function\s+runEventBaseIngestion/);
        });

        it('getChatAutoSyncStatus is exported', () => {
            expect(readRel('src/features/eventbase/eventbase-workflow.js'))
                .toMatch(/export\s+(?:async\s+)?function\s+getChatAutoSyncStatus/);
        });

        it('eventbase retrieval module exists with retrieveEvents', () => {
            const retrievalModule = 'src/features/eventbase/eventbase-retrieval.js';
            expect(existsRel(retrievalModule)).toBe(true);
            expect(readRel(retrievalModule)).toMatch(/retrieveEvents|hybridQueryWithRerank/);
        });
    });

    describe('ChunkBase pipeline (lorebook / document / character / url / wiki / youtube)', () => {
        it('src/features/chunkbase/chat-vectorization.js exists', () => {
            expect(existsRel('src/features/chunkbase/chat-vectorization.js')).toBe(true);
        });

        it('rearrangeChat is exported (main retrieval entry)', () => {
            expect(readRel('src/features/chunkbase/chat-vectorization.js'))
                .toMatch(/export\s+(?:async\s+)?function\s+rearrangeChat/);
        });

        it('Stage 8.5 chunk groups and links stage is still wired', () => {
            expect(readRel('src/features/chunkbase/chat-vectorization.js'))
                .toMatch(/applyGroupsAndLinksStage\s*\(/);
        });

        it('Keyword extraction is still wired for non-chat content', () => {
            // extractTextKeywords is what lorebook/document/character ingestion calls
            expect(readRel('src/features/chunkbase/content-vectorization.js'))
                .toMatch(/extractTextKeywords\s*\(/);
        });
    });

    describe('Centralized collection listing', () => {
        it('getCollectionListing is exported from collection-loader.js', () => {
            expect(readRel('src/features/collections/collection-loader.js'))
                .toMatch(/export\s+function\s+getCollectionListing/);
        });

        it('database-browser.js consumes getCollectionListing', () => {
            expect(readRel('src/features/database-browser/database-browser.js'))
                .toMatch(/getCollectionListing/);
        });

        it('eventbase-store.js consumes getCollectionListing', () => {
            // The EventBase path resolves its active collection through the listing,
            // inside resolveActiveEventBaseCollection.
            expect(readRel('src/features/eventbase/eventbase-store.js'))
                .toMatch(/getCollectionListing/);
        });

        it('settings-panel.js consumes getCollectionListing', () => {
            expect(readRel('src/features/settings-panel/settings-panel.js'))
                .toMatch(/getCollectionListing/);
        });
    });

    describe('Critical settings defaults', () => {
        it('keyword_scoring_method default is "hybrid"', () => {
            expect(readRel('src/index.js'))
                .toMatch(/keyword_scoring_method:\s*['"]hybrid['"]/);
        });

        it('chat content type has keywordExtraction flag set to false', () => {
            const src = readRel('src/features/chunkbase/content-types.js');
            const chatIdx = src.indexOf("chat: {");
            const block = src.slice(chatIdx, chatIdx + 800);
            expect(block).toMatch(/keywordExtraction:\s*false/);
        });
    });

    describe('Database browser still loads', () => {
        it('database-browser.js file exists', () => {
            expect(existsRel('src/features/database-browser/database-browser.js')).toBe(true);
        });

        it('chunk-visualizer.js file exists', () => {
            expect(existsRel('src/features/database-browser/chunk-visualizer.js')).toBe(true);
        });

        it('openChunkVisualizer is exported', () => {
            expect(readRel('src/features/database-browser/chunk-visualizer.js'))
                .toMatch(/export\s+(?:async\s+)?function\s+openChunkVisualizer/);
        });
    });
});

// ============================================================================
// DEAD CODE — FAILS UNTIL DELETION IS COMPLETE; PASSES AFTERWARD
// ============================================================================

describe('Dead code is removed (cleanup contract)', () => {
    describe('Phase B — DEAD-CHUNK-CHAT', () => {
        it('No source file contains the DEAD-CHUNK-CHAT marker', () => {
            const offenders = grepSourcesWithLines(/DEAD-CHUNK-CHAT/);
            expect(offenders, `Files still tagged DEAD-CHUNK-CHAT:\n${offenders.join('\n')}`)
                .toEqual([]);
        });

        it('getChatCollectionId is no longer defined', () => {
            const offenders = grepSourcesWithLines(/\bfunction\s+getChatCollectionId\b/);
            expect(offenders).toEqual([]);
        });

        it('getLegacyChatCollectionId is no longer defined', () => {
            const offenders = grepSourcesWithLines(/\bfunction\s+getLegacyChatCollectionId\b/);
            expect(offenders).toEqual([]);
        });

        it('buildChatCollectionId is no longer defined', () => {
            const offenders = grepSourcesWithLines(/\bfunction\s+buildChatCollectionId\b/);
            expect(offenders).toEqual([]);
        });

        it('buildLegacyChatCollectionId is no longer defined', () => {
            const offenders = grepSourcesWithLines(/\bfunction\s+buildLegacyChatCollectionId\b/);
            expect(offenders).toEqual([]);
        });

        it('prepareItemsForInsertion is no longer defined', () => {
            const offenders = grepSourcesWithLines(/\bfunction\s+prepareItemsForInsertion\b/);
            expect(offenders).toEqual([]);
        });

        it('VECTFOX_CHAT prefix is removed from COLLECTION_PREFIXES', () => {
            const src = readRel('src/shared/collection-ids.js');
            expect(src).not.toMatch(/VECTFOX_CHAT:\s*['"]vf_chat_['"]/);
        });

        it('No code references VECTFOX_CHAT prefix anymore', () => {
            const offenders = grepSourcesWithLines(/COLLECTION_PREFIXES\.VECTFOX_CHAT/);
            expect(offenders).toEqual([]);
        });

        it('No production code stamps source: "chat" on chunks', () => {
            // The collection-loader museum-mode loader is allowed (per plan §1.3
            // it's kept but stripped of the source stamp). All other producers
            // must be gone.
            const offenders = grepSourcesWithLines(/source:\s*['"]chat['"]/);
            // Test fixtures are excluded by SCAN_DIRS scope; tests/ isn't scanned.
            expect(offenders, `Files still stamping source: 'chat':\n${offenders.join('\n')}`)
                .toEqual([]);
        });
    });

    describe('Phase C — Temporal decay subsystem', () => {
        it('no temporal-decay.js remains under src/', () => {
            const remaining = [...walkSourceFiles()].filter(file => path.basename(file) === 'temporal-decay.js');
            expect(remaining).toEqual([]);
        });

        it('tests/temporal-decay.test.js file is deleted', () => {
            expect(existsRel('tests/temporal-decay.test.js')).toBe(false);
        });

        it('No imports from temporal-decay anywhere', () => {
            const offenders = grepSourcesWithLines(
                /from\s+['"][^'"]*temporal-decay['"]|require\(\s*['"][^'"]*temporal-decay['"]\s*\)/
            );
            expect(offenders, `Files still importing temporal-decay:\n${offenders.join('\n')}`)
                .toEqual([]);
        });

        it('applyTemporalDecay is no longer referenced', () => {
            const offenders = grepSourcesWithLines(/\bapplyTemporalDecay\b/);
            expect(offenders).toEqual([]);
        });

        it('applyTemporalDecayStage is no longer referenced', () => {
            const offenders = grepSourcesWithLines(/\bapplyTemporalDecayStage\b/);
            expect(offenders).toEqual([]);
        });

        it('applyDecayToResults is no longer referenced', () => {
            const offenders = grepSourcesWithLines(/\bapplyDecayToResults\b/);
            expect(offenders).toEqual([]);
        });

        it('applyNostalgiaToResults is no longer referenced', () => {
            const offenders = grepSourcesWithLines(/\bapplyNostalgiaToResults\b/);
            expect(offenders).toEqual([]);
        });

        it('applyDecayForCollection is no longer referenced (orphan export)', () => {
            const offenders = grepSourcesWithLines(/\bapplyDecayForCollection\b/);
            expect(offenders).toEqual([]);
        });

        it('isChunkTemporallyBlind is no longer referenced', () => {
            const offenders = grepSourcesWithLines(/\bisChunkTemporallyBlind\b/);
            expect(offenders).toEqual([]);
        });

        it('setChunkTemporallyBlind is no longer referenced', () => {
            const offenders = grepSourcesWithLines(/\bsetChunkTemporallyBlind\b/);
            expect(offenders).toEqual([]);
        });

        it('No code references the temporallyBlind chunk metadata field', () => {
            // The field may still exist in user-stored settings (no migration),
            // but no source code should read or write it.
            const offenders = grepSourcesWithLines(/\btemporallyBlind\b/);
            expect(offenders, `Code still touches temporallyBlind:\n${offenders.join('\n')}`)
                .toEqual([]);
        });

        it('Pipeline no longer has Stage 7 temporal decay marker', () => {
            const src = readRel('src/features/chunkbase/chat-vectorization.js');
            // Match the comment block "STAGE 7: Temporal decay" or similar
            expect(src).not.toMatch(/STAGE\s*7\s*:.*[Tt]emporal.*[Dd]ecay/);
            expect(src).not.toMatch(/===\s*STAGE\s*7\s*:\s*Temporal\s*decay/);
        });

        it('temporal_decay setting is gone from index.js defaults', () => {
            const src = readRel('src/index.js');
            expect(src).not.toMatch(/temporal_decay\s*:/);
        });

        it('nostalgia_* settings are gone from index.js defaults', () => {
            const src = readRel('src/index.js');
            expect(src).not.toMatch(/nostalgia_\w+\s*:/);
        });

        it('UI bindings for temporal_decay are removed from settings-panel.js', () => {
            const src = readRel('src/features/settings-panel/settings-panel.js');
            // Allow incidental string mentions but no live `settings.temporal_decay.X = ...`
            expect(src).not.toMatch(/settings\.temporal_decay\./);
            expect(src).not.toMatch(/\$\(['"]#VectFox_temporal_decay/);
        });

        it('Decay Immune toggle is removed from chunk visualizer', () => {
            const src = readRel('src/features/database-browser/chunk-visualizer.js');
            expect(src).not.toContain('Decay Immune');
            expect(src).not.toMatch(/VectFox_detail_blind/);
        });

        it('"blind" filter option is removed from chunk visualizer', () => {
            const src = readRel('src/features/database-browser/chunk-visualizer.js');
            // The filterBy enum used to include 'blind'
            expect(src).not.toMatch(/filterBy\s*===?\s*['"]blind['"]/);
            expect(src).not.toMatch(/data\.temporallyBlind/);
        });

        it('Vectorize Content modal no longer has Temporal Weighting block', () => {
            const src = readRel('src/features/chunkbase/content-vectorizer.js');
            expect(src).not.toMatch(/Temporal\s+Weighting/);
        });

        it('content-types.js no longer has temporalDecay feature flag', () => {
            // The flag itself becomes meaningless once the subsystem is gone.
            // It can be removed entirely from CONTENT_TYPES feature blocks.
            const src = readRel('src/features/chunkbase/content-types.js');
            expect(src).not.toMatch(/temporalDecay:\s*(true|false)/);
        });
    });

    describe('Phase B + C — diagnostics cleanup', () => {
        it('src/features/diagnostics/configuration-checks.js has no DEAD-CHUNK-CHAT branches', () => {
            if (!existsRel('src/features/diagnostics/configuration-checks.js')) return; // file may be deleted
            const src = readRel('src/features/diagnostics/configuration-checks.js');
            expect(src).not.toMatch(/DEAD-CHUNK-CHAT/);
        });

        it('src/features/diagnostics/production-tests.js has no temporal-decay test blocks', () => {
            if (!existsRel('src/features/diagnostics/production-tests.js')) return;
            const src = readRel('src/features/diagnostics/production-tests.js');
            expect(src).not.toMatch(/applyTemporalDecay/);
            expect(src).not.toMatch(/setChunkTemporallyBlind/);
        });
    });

    // ──────────────────────────────────────────────────────────────────────
    // Phase D — the preview-only chunk-chat layer: prepareChatContent in
    // content-vectorization.js, the dispatcher case that called it, cleanMessages
    // in text-cleaning.js, and the chunkingStrategies / defaultStrategy / defaults
    // fields of CONTENT_TYPES.chat.
    //
    // The defensive `case 'chat':` tripwire in generateCollectionId() is
    // INTENTIONALLY kept — it throws if anyone tampers with source to
    // bypass the production gates and route chat through the chunk pipeline.
    // ──────────────────────────────────────────────────────────────────────
    describe('Phase D — Preview-only chunk-chat zombie layer', () => {
        it('prepareChatContent function no longer exists', () => {
            const offenders = grepSourcesWithLines(/\bfunction\s+prepareChatContent\b/);
            expect(offenders, `prepareChatContent still defined in:\n${offenders.join('\n')}`)
                .toEqual([]);
        });

        it('cleanMessages function no longer exists', () => {
            const offenders = grepSourcesWithLines(/\bexport\s+function\s+cleanMessages\b/);
            expect(offenders, `cleanMessages still defined in:\n${offenders.join('\n')}`)
                .toEqual([]);
        });

        it('No "chat" case remains in the prepareContent dispatcher', () => {
            // The dispatcher lives in content-vectorization.js's
            // prepareContent(contentType, ...) switch. We grep narrowly so
            // we don't flag the unrelated tripwire in generateCollectionId
            // (different function, intentional defense).
            const src = readRel('src/features/chunkbase/content-vectorization.js');
            const prepIdx = src.indexOf('function prepareContent(');
            expect(prepIdx, 'prepareContent function not found').toBeGreaterThan(-1);
            // Slice a generous window covering the whole switch.
            const block = src.slice(prepIdx, prepIdx + 2000);
            expect(block, 'case \'chat\': still present in prepareContent dispatcher')
                .not.toMatch(/case\s+['"]chat['"]\s*:/);
        });

        it('generateCollectionId tripwire for chat is preserved (intentional defense)', () => {
            // Mirror of the above but inverted — we WANT this case to stay.
            // It's the last line of defense if both UI gates are bypassed.
            const src = readRel('src/features/chunkbase/content-vectorization.js');
            const genIdx = src.indexOf('function generateCollectionId(');
            expect(genIdx, 'generateCollectionId function not found').toBeGreaterThan(-1);
            const block = src.slice(genIdx, genIdx + 1500);
            expect(block, 'generateCollectionId tripwire removed — restore the case \'chat\': throw block')
                .toMatch(/case\s+['"]chat['"]\s*:[\s\S]*throw\s+new\s+Error/);
        });

        it('CONTENT_TYPES.chat no longer declares chunkingStrategies', () => {
            const src = readRel('src/features/chunkbase/content-types.js');
            const chatIdx = src.indexOf('chat: {');
            expect(chatIdx, 'CONTENT_TYPES.chat entry not found').toBeGreaterThan(-1);
            const block = src.slice(chatIdx, chatIdx + 800);
            expect(block, 'chat entry still declares chunkingStrategies')
                .not.toMatch(/chunkingStrategies\s*:/);
        });

        it('CONTENT_TYPES.chat no longer declares defaultStrategy', () => {
            const src = readRel('src/features/chunkbase/content-types.js');
            const chatIdx = src.indexOf('chat: {');
            expect(chatIdx, 'CONTENT_TYPES.chat entry not found').toBeGreaterThan(-1);
            const block = src.slice(chatIdx, chatIdx + 800);
            expect(block, 'chat entry still declares defaultStrategy')
                .not.toMatch(/defaultStrategy\s*:/);
        });

        it('CONTENT_TYPES.chat keeps defaults as an EMPTY object (defensive shim) or omits it', () => {
            // Two acceptable shapes:
            //   (a) `defaults: {}` — defensive shim against TypeError from
            //       readers like `type.defaults.chunkSize` at
            //       content-vectorization.js:98 that don't use optional
            //       chaining. The UI's `isChatType` toggle hides the
            //       chunking section so those readers never fire for chat,
            //       but the shim is cheap insurance.
            //   (b) No `defaults` field at all — also acceptable if every
            //       reader has been updated to use optional chaining.
            //
            // What we MUST NOT see: `defaults: { chunkSize: ..., batchSize: ... }`
            // with legacy chunking config still wired up.
            const src = readRel('src/features/chunkbase/content-types.js');
            const chatIdx = src.indexOf('chat: {');
            expect(chatIdx, 'CONTENT_TYPES.chat entry not found').toBeGreaterThan(-1);
            const block = src.slice(chatIdx, chatIdx + 800);
            expect(block, 'chat entry still declares chunkSize in defaults')
                .not.toMatch(/defaults\s*:\s*\{[^}]*chunkSize/);
            expect(block, 'chat entry still declares batchSize in defaults')
                .not.toMatch(/defaults\s*:\s*\{[^}]*batchSize/);
        });
    });
});

// ============================================================================
// META — sanity check that the test infrastructure itself is sane
// ============================================================================

describe('Test infrastructure self-check', () => {
    it('walkSourceFiles finds at least 50 source files', () => {
        const files = [...walkSourceFiles()];
        expect(files.length).toBeGreaterThan(50);
    });

    it('repo root resolves correctly', () => {
        expect(existsRel('package.json')).toBe(true);
        expect(existsRel('src/index.js')).toBe(true);
    });
});
