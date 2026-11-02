/**
 * ============================================================================
 * VECTFOX SIZE INSPECTOR
 * ============================================================================
 * Diagnostic tool: surveys every collection on disk + Qdrant and reports
 * per-collection chunk-size distribution. Click a row to drill into the
 * largest entries of that single collection.
 *
 * Used to diagnose runaway injection (e.g. GitHub issue #3 — 1M+ token
 * injections) by finding bloated metadata or oversized event payloads.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from "../src/sillytavern/settings.js";
import { loadAllCollections } from "../core/collection-loader.js";
import { buildRegistryKey } from "../core/collection-ids.js";
import { listChunks } from "../core/core-vector-api.js";
import { icons } from "./icons.js";
import { escapeHtml } from "../src/shared/html-escape.js";

// Cache of last scan so the detail view can reuse already-fetched items
// without re-hitting the backend.
const _cache = {
    summaries: [],         // array of summary rows
    itemsByKey: new Map(), // key = registryKey (`backend:collectionId`) -> items[]
};

/**
 * Renders the Size Inspector tab content into the given container.
 * Idempotent — safe to call multiple times.
 * @param {jQuery|HTMLElement} container
 */
export function renderSizeInspectorTab(container) {
    const $c = window.jQuery ? window.jQuery(container) : null;
    if (!$c || !$c.length) return;

    if ($c.find(".vectfox-size-inspector").length) {
        // Already rendered — just rebind in case events were lost.
        bindEvents();
        return;
    }

    $c.html(`
        <div class="vectfox-size-inspector">
            <div class="vectfox-size-toolbar">
                <button id="vectfox_size_scan_btn" class="vectfox-btn vectfox-btn-primary">
                    ${icons.refreshCw(14)} Scan all collections
                </button>
                <span class="vectfox-size-hint">
                    Surveys every collection (FS + Qdrant) and reports the largest entries.
                    Use this to diagnose oversized injections.
                </span>
            </div>

            <div id="vectfox_size_status" class="vectfox-size-status"></div>

            <div id="vectfox_size_summary_wrap" class="vectfox-size-summary-wrap" style="display:none;">
                <h4>Per-collection summary <span class="vectfox-size-sort-hint">(sorted by max chars, click a row to drill in)</span></h4>
                <div class="vectfox-size-table-scroll">
                    <table class="vectfox-size-table" id="vectfox_size_summary_table">
                        <thead>
                            <tr>
                                <th>Collection</th>
                                <th>Backend</th>
                                <th class="num">Count</th>
                                <th class="num">Max chars</th>
                                <th class="num">Avg chars</th>
                                <th class="num">Total KB</th>
                                <th>Worst preview</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>

            <div id="vectfox_size_detail_wrap" class="vectfox-size-detail-wrap" style="display:none;">
                <div class="vectfox-size-detail-header">
                    <button id="vectfox_size_back_btn" class="vectfox-btn-sm">
                        ${icons.chevronLeft(14)} Back to summary
                    </button>
                    <h4 id="vectfox_size_detail_title">Collection detail</h4>
                </div>
                <div class="vectfox-size-table-scroll">
                    <table class="vectfox-size-table" id="vectfox_size_detail_table">
                        <thead>
                            <tr>
                                <th class="num">#</th>
                                <th class="num">Chars</th>
                                <th>Hash</th>
                                <th>Preview</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
        </div>
    `);

    bindEvents();
}

function bindEvents() {
    const $ = window.jQuery;
    if (!$) return;

    $("#vectfox_size_scan_btn").off("click").on("click", async function (e) {
        e.stopPropagation();
        e.preventDefault();
        await runScan();
    });

    $("#vectfox_size_back_btn").off("click").on("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        $("#vectfox_size_detail_wrap").hide();
        $("#vectfox_size_summary_wrap").show();
    });

    // Delegate row clicks (rows are re-rendered after scan)
    $("#vectfox_size_summary_table tbody").off("click", "tr.clickable").on("click", "tr.clickable", function () {
        const key = $(this).attr("data-key");
        if (key) showCollectionDetail(key);
    });
}

async function runScan() {
    const $ = window.jQuery;
    const $btn = $("#vectfox_size_scan_btn");
    const $status = $("#vectfox_size_status");
    const $wrap = $("#vectfox_size_summary_wrap");
    const $tbody = $("#vectfox_size_summary_table tbody");

    $btn.prop("disabled", true);
    $status.removeClass("error").text("Listing collections…");
    $wrap.hide();
    $("#vectfox_size_detail_wrap").hide();
    $tbody.empty();
    _cache.summaries = [];
    _cache.itemsByKey.clear();

    try {
        // Single source of truth for collection listing — same path the Database
        // Browser, WI panel, and auto-sync use. loadAllCollections() handles plugin
        // discovery, dedup of (backend, collectionId) collisions, scope migration,
        // and per-entry source/model resolution. Each returned entry already
        // carries { id, registryKey, backend, source, model, chunkCount } — no
        // local fetch + dedup needed here. See Doc/collection_helper.md.
        const settings = extension_settings?.vectfox;
        if (!settings) {
            throw new Error("VectFox settings not initialized");
        }
        $status.text("Listing collections via loadAllCollections…");
        const collections = await loadAllCollections(settings, false);

        $status.text(`Found ${collections.length} collections. Probing chunks…`);

        if (!collections.length) {
            $btn.prop("disabled", false);
            return;
        }

        const summaries = [];
        let done = 0;

        for (const entry of collections) {
            const collectionId = entry.id;
            const backend = entry.backend || "qdrant";
            // loadAllCollections already resolved source + primary model from
            // plugin discovery. Vectra/standard indexes are partitioned by
            // (source, model) on disk, so forwarding the discovered values is
            // mandatory — defaults would silently hit an empty new index.
            const source = entry.source || "transformers";
            const registryKey = entry.registryKey || buildRegistryKey(collectionId, backend);
            if (!collectionId) {
                done++;
                continue;
            }

            try {
                const entrySettings = {
                    ...settings,
                    vector_backend: backend,
                    source,
                };
                const data = await listChunks(collectionId, entrySettings, { limit: 5000 });
                const items = data.items || [];

                const row = summarize(collectionId, backend, items, registryKey);
                summaries.push(row);
                _cache.itemsByKey.set(registryKey, items);
            } catch (err) {
                summaries.push({
                    key: registryKey,
                    collectionId,
                    backend,
                    count: 0,
                    maxChars: 0,
                    avgChars: 0,
                    totalKB: 0,
                    worstPreview: `(error: ${err.message})`,
                    error: true,
                });
            }

            done++;
            $status.text(`Probing chunks… (${done}/${collections.length})`);
        }

        summaries.sort((a, b) => b.maxChars - a.maxChars);
        _cache.summaries = summaries;

        renderSummaryRows(summaries);
        $wrap.show();
        $status.text(`Done. ${summaries.length} collections scanned. Click a row to see its largest entries.`);
    } catch (err) {
        console.error("[VectFox SizeInspector] scan failed", err);
        $status.addClass("error").text(`Scan failed: ${err.message}`);
    } finally {
        $btn.prop("disabled", false);
    }
}

function summarize(collectionId, backend, items, registryKey) {
    const key = registryKey || buildRegistryKey(collectionId, backend);
    if (!items.length) {
        return {
            key,
            collectionId,
            backend,
            count: 0,
            maxChars: 0,
            avgChars: 0,
            totalKB: 0,
            worstPreview: "(empty)",
        };
    }
    const sizes = items.map(it => JSON.stringify(it.metadata || {}).length);
    const total = sizes.reduce((a, b) => a + b, 0);
    const max = Math.max(...sizes);
    const maxIdx = sizes.indexOf(max);
    const worstMeta = items[maxIdx]?.metadata || {};
    const previewSrc = worstMeta.text || worstMeta.summary || JSON.stringify(worstMeta);
    return {
        key,
        collectionId,
        backend,
        count: items.length,
        maxChars: max,
        avgChars: Math.round(total / items.length),
        totalKB: Math.round(total / 1024),
        worstPreview: String(previewSrc).slice(0, 120),
    };
}

function renderSummaryRows(rows) {
    const $tbody = window.jQuery("#vectfox_size_summary_table tbody");
    $tbody.empty();
    for (const r of rows) {
        const cls = r.error ? "error" : (r.count > 0 ? "clickable" : "");
        $tbody.append(`
            <tr class="${cls}" data-key="${escapeHtml(r.key)}">
                <td class="collection-cell" title="${escapeHtml(r.collectionId)}">${escapeHtml(truncateMid(r.collectionId, 60))}</td>
                <td>${escapeHtml(r.backend)}</td>
                <td class="num">${r.count}</td>
                <td class="num">${r.maxChars}</td>
                <td class="num">${r.avgChars}</td>
                <td class="num">${r.totalKB}</td>
                <td class="preview-cell" title="${escapeHtml(r.worstPreview)}">${escapeHtml(r.worstPreview.slice(0, 60))}</td>
            </tr>
        `);
    }
}

function showCollectionDetail(key) {
    const $ = window.jQuery;
    const items = _cache.itemsByKey.get(key) || [];
    const summary = _cache.summaries.find(s => s.key === key);

    $("#vectfox_size_detail_title").text(
        summary ? `${summary.collectionId} — ${items.length} entries` : "Collection detail"
    );

    const $tbody = $("#vectfox_size_detail_table tbody");
    $tbody.empty();

    const rows = items.map((it, idx) => {
        const metaStr = JSON.stringify(it.metadata || {});
        const text = it.metadata?.text || it.metadata?.summary || metaStr;
        return {
            origIdx: idx,
            chars: metaStr.length,
            hash: it.hash ?? it.id ?? "",
            preview: String(text).slice(0, 200),
        };
    });
    rows.sort((a, b) => b.chars - a.chars);

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        $tbody.append(`
            <tr>
                <td class="num">${i + 1}</td>
                <td class="num">${r.chars}</td>
                <td class="hash-cell">${escapeHtml(String(r.hash))}</td>
                <td class="preview-cell" title="${escapeHtml(r.preview)}">${escapeHtml(r.preview.slice(0, 120))}</td>
            </tr>
        `);
    }

    $("#vectfox_size_summary_wrap").hide();
    $("#vectfox_size_detail_wrap").show();
}

// ---------- small helpers ----------

function truncateMid(s, max) {
    s = String(s);
    if (s.length <= max) return s;
    const head = Math.ceil(max / 2) - 1;
    const tail = Math.floor(max / 2) - 2;
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
