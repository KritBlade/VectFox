/**
 * ============================================================================
 * VectFox DEAD CODE DELETION — REGRESSION CONTRACT TEST
 * ============================================================================
 *
 * Pins the state after the dead-code cleanups in InternalProject/Vectfox/plans/executed/
 * (delete-dead-chunk-chat-and-temporal-decay.md, unwire-dead-chat-vectorize-options.md,
 * centralize-collection-listing.md) and B7 and B29 of plans/lorebook-semantic-overhaul-
 * passage-index.md, which deleted the old vectorized lorebook path and retired ChunkBase:
 * the removed code stays deleted, and the live code beside it stays in place.
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

    describe('Centralized collection listing', () => {
        it('getCollectionListing is exported from collection-loader.js', () => {
            expect(readRel('src/features/collections/collection-loader.js'))
                .toMatch(/export\s+function\s+getCollectionListing/);
        });

        it('database-browser.js consumes getCollectionListing', () => {
            expect(readRel('src/features/database-browser/database-browser.js'))
                .toMatch(/getCollectionListing/);
        });

        it('eventbase-chat-collections.js consumes getCollectionListing', () => {
            // The one route to a chat's collection in use (collectionInUse) reads ownership from the listing.
            expect(readRel('src/features/eventbase/eventbase-chat-collections.js'))
                .toMatch(/getCollectionListing/);
        });
    });

    describe('Critical settings defaults', () => {
        it('keyword_scoring_method default is "hybrid"', () => {
            expect(readRel('src/index.js'))
                .toMatch(/keyword_scoring_method:\s*['"]hybrid['"]/);
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
    describe('E6 — one route to the collection a chat uses (D18 of vectfox-multi-collection-per-chat.md)', () => {
        it('the helpers that each answered which collection a chat uses, by a rule of their own, are gone', () => {
            const offenders = grepSourcesWithLines(/\b(?:resolveActiveEventBaseCollection|resolveEventBaseWriteTarget|_gatherLockedEventBaseCollections|_gatherArchiveEventCollections|isLockedTo|buildChatSearchPatterns|matchesPatterns)\b/);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('the yellow toast on opening a chat with none in use, its words and the pause of every collection of a chat are gone', () => {
            const offenders = grepSourcesWithLines(/\b(?:warnOfAutoSyncNotInUse|autoSyncNotInUseText|NONE_IN_USE_TEXT|pauseAutoSyncForChat)\b/);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('a backend is named by one function', () => {
            const offenders = grepSourcesWithLines(/\bBACKEND_NAMES\b/);
            expect(offenders, offenders.join('\n')).toEqual([]);
            expect(readRel('src/shared/collection-ids.js')).toMatch(/export\s+function\s+vectorBackendName\b/);
        });
    });

    describe('LoreBase — one route per question (the user, 2026-11-21)', () => {
        it('the near-copies that each answered a LoreBase question by a rule of their own are gone', () => {
            const offenders = grepSourcesWithLines(/\b(?:uidsWithCurrentVectors|deleteAllVectors|recordedLoreBookNames|REMOVAL_OFF_QDRANT)\b/);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it("no one reads a book's selection in use here but through selectionInUseHere", () => {
            const offenders = grepSourcesWithLines(/selectionInUse\([^)]*lockTarget\(\)/);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('each question has its one route, defined once', () => {
            const routes = [
                ['src/features/lorebase/lorebase-reply-core.js', /export\s+function\s+(?:isDecidedEntry|undecidableReasonOf)\b/g, 2],
                ['src/features/lorebase/lorebase-selection-core.js', /export\s+function\s+(?:isDecidedRow|canToggleRow)\b/g, 2],
                ['src/features/lorebase/lorebase-readiness.js', /export\s+function\s+isEntryReady\b/g, 1],
                ['src/features/lorebase/lorebase-setup.js', /export\s+function\s+(?:qdrantProblem|keyWritingProblem|vectorWritingProblem|writingProblem|replyModel)\b/g, 5],
                ['src/features/lorebase/lorebase-books.js', /export\s+async\s+function\s+decidedCountOf\b/g, 1],
                ['src/features/lorebase/lorebase-storage-core.js', /export\s+function\s+hasLoreBaseHoldings\b/g, 1],
                ['src/features/lorebase/lorebase-chat-books.js', /export\s+function\s+(?:whereFor|selectionInUseHere)\b/g, 2],
            ];
            expect(routes.map(([file, pattern]) => [file, (readRel(file).match(pattern) ?? []).length])).toEqual(routes.map(([file, , count]) => [file, count]));
            const copies = grepSourcesWithLines(/(?:const\s+isDecidedRow\s*=|function\s+keyWritingProblem\b|function\s+undecidableReasonOf\b|async\s+function\s+decidedCountOf\b)/)
                .filter(line => !/lorebase-(?:selection-core|setup|reply-core|books)\.js/.test(line));
            expect(copies, copies.join('\n')).toEqual([]);
        });
    });

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

        it('No source draws the Temporal Weighting block', () => {
            const offenders = grepSourcesWithLines(/Temporal\s+Weighting/);
            expect(offenders, offenders.join('\n')).toEqual([]);
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
    // Phase D — the preview-only chunk-chat layer: prepareChatContent and
    // cleanMessages in text-cleaning.js. The content pipeline that held the
    // rest of it (the prepareContent dispatcher, generateCollectionId and
    // CONTENT_TYPES) is gone with ChunkBase, which the B29 block pins.
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
    });

    describe('LoreBase B7 — the old vectorized lorebook path', () => {
        it('features/world-info, its vector search and rename check, is gone', () => {
            expect(existsRel('src/features/world-info')).toBe(false);
            expect(existsRel('src/app/settings-migration-world-info-threshold.js')).toBe(false);
            expect(existsRel('src/features/chunkbase/lorebook-content-preparer.js')).toBe(false);
        });

        it('no source reads its settings, but the migration that deletes them from saved settings', () => {
            const migration = 'src/app/settings-migration-semantic-world-info-settings.js';
            // SillyTavern's Vector Storage names its own World Info switch enabled_world_info too, in its settings.
            const vectorStorage = 'src/sillytavern/vector-storage.js';
            const offenders = grepSourcesWithLines(
                /\b(enabled_world_info|world_info_threshold|world_info_top_k|world_info_query_depth|world_info_retrieval_popup|world_info_respect_entry_disable|lorebook_xml_tag)\b/,
            ).filter(hit => !hit.startsWith(`${migration}:`) && !hit.startsWith(`${vectorStorage}:`));
            expect(existsRel(migration)).toBe(true);
            expect(offenders, offenders.join('\n')).toEqual([]);
            // The one read there is Vector Storage's own setting, never one of VectFox's.
            expect(grepSourcesWithLines(/\benabled_world_info\b/).filter(hit => hit.startsWith(`${vectorStorage}:`)).every(hit => hit.includes('vectors?.enabled_world_info'))).toBe(true);
        });

        it('no source sends the <VectFoxLorebook> block or offers its dry run', () => {
            const offenders = grepSourcesWithLines(/VectFoxLorebook|LOREBOOK_PROMPT_TAG|clearLorebookPrompt|runLorebookWIDryRun|VectFox_WorldInfo/);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('Vectorize Content no longer vectorizes a lorebook', () => {
            const offenders = grepSourcesWithLines(/prepareLorebookContent|extractLorebookKeywords|buildLorebookCollectionId|parseLorebookFile|lorebookStats/);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });
    });

    describe('ChunkBase retired (B29)', () => {
        it('features/chunkbase, its content pipeline, chunk retrieval and Auto-Reformat, is gone, and no source imports from it', () => {
            expect(existsRel('src/features/chunkbase')).toBe(false);
            const offenders = grepSourcesWithLines(/\bfrom\s+['"][^'"]*\/chunkbase\/|\bimport\(\s*['"][^'"]*\/chunkbase\//);
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('no source module of Auto-Reformat, the glossary, chunking, content types or the content pipeline remains', () => {
            const retiredModule = /^(reformat-[\w-]+|glossary-extractor|chunking|content-types|content-vectorization)\.js$/;
            const remaining = [...walkSourceFiles()]
                .map(file => path.relative(ROOT, file).replace(/\\/g, '/'))
                .filter(file => retiredModule.test(path.posix.basename(file)));
            expect(remaining).toEqual([]);
            for (const file of ['src/features/settings-panel/chunkbase-page-markup.js', 'src/features/keyword-search/keyword-extraction.js', 'src/features/diagnostics/activation-tests.js']) {
                expect(existsRel(file), file).toBe(false);
            }
        });

        it('conditional-activation.js is gone, and no source gates a collection by triggers or conditions', () => {
            expect(existsRel('src/features/collections/conditional-activation.js')).toBe(false);
            const offenders = grepSourcesWithLines(
                /conditional-activation|\b(checkTriggers|shouldCollectionActivate|filterActiveCollections|getCollectionTriggers|getCollectionActivationSummary|getCollectionConditions|setCollectionConditions)\b/,
            );
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('no source reads per-chunk metadata, but the migration that deletes it from saved settings', () => {
            const migration = 'src/app/settings-migration-chunkbase-settings.js';
            const offenders = grepSourcesWithLines(/vectfox_chunk_meta_|\b(?:get|save|delete)ChunkMetadata\b|\bgetAllChunkMetadata\b/)
                .filter(hit => !hit.startsWith(`${migration}:`));
            expect(existsRel(migration)).toBe(true);
            expect(readRel(migration)).toContain("'vectfox_chunk_meta_'");
            expect(offenders, offenders.join('\n')).toEqual([]);
        });

        it('the generation interceptor runs EventBase\'s reply step, and nothing of rearrangeChat is left but the window global', () => {
            const replyStep = 'src/features/eventbase/eventbase-reply.js';
            expect(existsRel(replyStep)).toBe(true);
            expect(readRel(replyStep)).toMatch(/export\s+async\s+function\s+runEventBaseReplyStep\b/);
            expect(readRel('src/index.js')).toMatch(/\brunEventBaseReplyStep\(chat, settings, type\)/);
            // SillyTavern calls the interceptor by the global the manifest names.
            expect(JSON.parse(readRel('manifest.json')).generate_interceptor).toBe('vectfox_rearrangeChat');
            expect(readRel('src/index.js')).toMatch(/window\[['"]vectfox_rearrangeChat['"]\]\s*=/);
            const offenders = grepSourcesWithLines(/\brearrangeChat\b/);
            expect(offenders, offenders.join('\n')).toEqual([]);
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
