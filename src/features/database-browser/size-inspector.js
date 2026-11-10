/**
 * ============================================================================
 * VECTFOX SIZE INSPECTOR
 * ============================================================================
 * The Database Browser's Size page: surveys every collection on disk and in
 * Qdrant, ranks them by their largest entry, and lists one collection's entries,
 * the largest first. Used to find what bloats an injection (GitHub issue #3, 1M+
 * token injections), such as oversized metadata or event payloads. The page's
 * markup is database-browser-markup.js; this paints its rows.
 *
 * @author Kritblade
 * ============================================================================
 */

import { extension_settings } from "../../sillytavern/settings.js";
import { loadAllCollections } from "../collections/index.js";
import { buildRegistryKey } from "../../shared/collection-ids.js";
import { listChunks } from "../vector-backend/index.js";
import { log } from '../../sillytavern/log.js';
import { sizeEntriesMarkup, sizeStatusMarkup, sizeSummaryRowMarkup } from "./database-browser-markup.js";

// The last scan, so a collection's entry list reuses the items it already fetched.
const lastScan = {
    summaries: [],         // one summary row per collection
    itemsByKey: new Map(), // registry key (`backend:collectionId`) -> items[]
};

// The entries of the collection shown, largest first.
let shownEntries = [];

/**
 * Bind the Size page's buttons, delegated on the browser's root, so rows painted later answer too.
 *
 * @param {HTMLElement} root - The Database Browser's root
 */
export function bindSizeInspector(root) {
    const $root = $(root);
    $root.on("click", "#vectfox_size_scan_btn", () => void runScan());
    $root.on("click", '[data-size-action="show"]', function () {
        showCollectionEntries(this.dataset.sizeKey);
    });
    $root.on("click", '[data-size-action="back"]', showRanking);
    $root.on("click", "[data-size-page]", function () {
        showEntriesPage(Number(this.dataset.sizePage));
    });
}

function paintStatus(text, isFailed = false) {
    $("#vectfox_size_status").html(sizeStatusMarkup({ text, isFailed }));
}

async function runScan() {
    const $button = $("#vectfox_size_scan_btn");
    $button.prop("disabled", true);
    paintStatus("Listing collections…");
    $("#vectfox_size_summary_wrap, #vectfox_size_detail_wrap").hide();
    $("#vectfox_size_summary_list").empty();
    lastScan.summaries = [];
    lastScan.itemsByKey.clear();

    try {
        // One path lists collections for the Database Browser, the WorldInfo page and auto-sync:
        // loadAllCollections handles plugin discovery, (backend, collectionId) collisions, scope
        // migration and each entry's source and model, so each entry carries
        // { id, registryKey, backend, source, model, chunkCount }. See Doc/collection_helper.md.
        const settings = extension_settings?.vectfox;
        if (!settings) {
            throw new Error("VectFox settings not initialized");
        }
        const collections = await loadAllCollections(settings, false);
        if (!collections.length) {
            paintStatus("Found no collections.");
            return;
        }
        paintStatus(`Found ${collections.length} collections. Reading their entries…`);

        const summaries = [];
        let done = 0;
        for (const entry of collections) {
            const collectionId = entry.id;
            const backend = entry.backend || "qdrant";
            // Vectra and Standard indexes are partitioned by (source, model) on disk, so the
            // discovered values must be forwarded: defaults would silently read an empty index.
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

                summaries.push(summarize(collectionId, backend, items, registryKey));
                lastScan.itemsByKey.set(registryKey, items);
            } catch (err) {
                log.warn(`[VectFox SizeInspector] could not read ${collectionId}:`, err);
                summaries.push({
                    key: registryKey,
                    collectionId,
                    backend,
                    count: 0,
                    maxChars: 0,
                    avgChars: 0,
                    totalKB: 0,
                    worstPreview: `Could not read it: ${err.message}`,
                    error: true,
                });
            }

            done++;
            paintStatus(`Reading entries… (${done}/${collections.length})`);
        }

        summaries.sort((a, b) => b.maxChars - a.maxChars);
        lastScan.summaries = summaries;

        $("#vectfox_size_summary_list").html(summaries.map(sizeSummaryRowMarkup).join(""));
        $("#vectfox_size_summary_wrap").show();
        paintStatus(`Done: ${summaries.length} collections read. Show entries lists one collection's entries.`);
    } catch (err) {
        log.error("[VectFox SizeInspector] scan failed", err);
        paintStatus(err.message, true);
    } finally {
        $button.prop("disabled", false);
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

function showCollectionEntries(key) {
    const items = lastScan.itemsByKey.get(key) || [];
    const summary = lastScan.summaries.find(s => s.key === key);
    shownEntries = items
        .map((item) => {
            const metadataText = JSON.stringify(item.metadata || {});
            const text = item.metadata?.text || item.metadata?.summary || metadataText;
            return { chars: metadataText.length, hash: String(item.hash ?? item.id ?? ""), preview: String(text).slice(0, 200) };
        })
        .sort((a, b) => b.chars - a.chars)
        .map((entry, index) => ({ ...entry, rank: index + 1 }));

    $("#vectfox_size_detail_title").text(`${summary?.collectionId ?? key}: ${items.length} entries`);
    showEntriesPage(0);
    $("#vectfox_size_summary_wrap").hide();
    $("#vectfox_size_detail_wrap").show();
}

function showEntriesPage(page) {
    const { list, pager } = sizeEntriesMarkup(shownEntries, page);
    $("#vectfox_size_detail_list").html(list);
    $("#vectfox_size_detail_pager").html(pager);
}

function showRanking() {
    $("#vectfox_size_detail_wrap").hide();
    $("#vectfox_size_summary_wrap").show();
}
