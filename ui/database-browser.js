/**
 * ============================================================================
 * VECTFOX DATABASE BROWSER
 * ============================================================================
 * Comprehensive vector database browser UI
 * Main entry point for browsing, managing, and editing all vector collections
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import {
  loadAllCollections,
  setCollectionEnabled,
  registerCollection,
  unregisterCollection,
  clearCollectionRegistry,
  deleteCollection,
  sanitizeHandleId,
  getCollectionListing,
  checkPluginAvailable,
} from "../core/collection-loader.js";
import { COLLECTION_PREFIXES } from "../core/collection-ids.js";
import {
  purgeVectorIndex,
  queryMultipleCollections,
} from "../core/core-vector-api.js";
import { getRequestHeaders, getCurrentChatId, eventSource, event_types } from "../../../../../script.js";
import {
  cleanupOrphanedMeta,
  deleteCollectionMeta,
  getCollectionConditions,
  setCollectionConditions,
  getCollectionTriggers,
  setCollectionTriggers,
  getCollectionMeta,
  setCollectionMeta,
  getCollectionActivationSummary,
  isCollectionEnabled,
  // Locking API
  getCollectionLocks,
  setCollectionLock,
  removeCollectionLock,
  clearCollectionLock,
  isCollectionLockedToChat,
  getCollectionLockCount,
  // Character Locking API
  getCollectionCharacterLocks,
  setCollectionCharacterLock,
  removeCollectionCharacterLock,
  clearCollectionCharacterLocks,
  isCollectionLockedToCharacter,
  getCollectionCharacterLockCount,
  isCollectionActiveForContext,
} from "../core/collection-metadata.js";
import { getContext } from "../../../../extensions.js";
import {
  VALID_GENERATION_TYPES,
} from "../core/conditional-activation.js";
import { world_names, loadWorldInfo } from "../../../../world-info.js";
import { icons } from "./icons.js";
import StringUtils from "../utils/string-utils.js";
import { log } from "../core/log.js";
import { openVisualizer } from "./chunk-visualizer.js";
import { queryCollection } from "../core/core-vector-api.js";
import {
  exportCollection,
  importCollection,
  downloadExport,
  readImportFile,
  validateImportData,
  getExportInfo,
  MAX_IMPORT_FILE_BYTES,
} from "../core/collection-export.js";
import {
  embedDataInPNG,
  extractDataFromPNG,
  downloadPNG,
  readPNGFile,
  convertToPNG,
  isVectFoxPNG,
} from "../core/png-export.js";
import { renderSizeInspectorTab } from "./size-inspector.js";

// Browser state
// checkPluginAvailable() is imported from ../core/collection-loader.js —
// that is the canonical implementation shared across the UI layer.
let browserState = {
  isOpen: false,
  pluginAvailable: null,
  collections: [],
  selectedCollection: null,
  filters: {
    scope: "all", // 'all', 'character', 'chat'
    collectionType: "all", // 'all', 'chat', 'file', 'lorebook'
    searchQuery: "",
    onlyActiveForChat: false, // when true, only show collections active for the current chat (matches the 🔒 badge)
  },
  settings: null,
  // Bulk operations state
  bulkSelected: new Set(),
  bulkFilter: "all", // 'all', 'enabled', 'disabled'
  // Search state
  searchResults: null,
  isSearching: false,
  // Keyword filter state
  keywordFilter: '',
  availableKeywords: [],
  // PNG export state
  pendingPngExport: null,
};

// Event binding flags (module-level for proper reset on modal close)
let searchEventsBound = false;
let bulkEventsBound = false;

/**
 * Initializes the database browser
 * @param {object} settings VECTFOX settings
 */
export function initializeDatabaseBrowser(settings) {
  browserState.settings = settings;
  log.lifecycle("VectFox Database Browser: Initialized");
}

/**
 * Opens the database browser modal
 */
export async function openDatabaseBrowser() {
  console.log("VECTFOX Database Browser: openDatabaseBrowser called, isOpen=", browserState.isOpen);
  if (browserState.isOpen) {
    console.log("VECTFOX Database Browser: Already open (early return)");
    return;
  }

  browserState.isOpen = true;
  try {
    // Check plugin availability
    browserState.pluginAvailable = await checkPluginAvailable();
    console.log("VECTFOX Database Browser: pluginAvailable=", browserState.pluginAvailable);

    // Create modal if it doesn't exist
    if ($("#vectfox_database_browser_modal").length === 0) {
      console.log("VECTFOX Database Browser: creating modal");
      createBrowserModal();
    } else {
      console.log("VECTFOX Database Browser: modal already in DOM");
    }

    // Show/hide plugin warning banner
    updatePluginWarningBanner();

    // Force a fresh plugin scan on open so collections created since last scan
    // (e.g. just-vectorized EventBase collections) land in pluginCollectionData with
    // their real source/model — otherwise View Chunks sends source: 'unknown' and
    // the plugin queries the wrong on-disk path.
    console.log("VECTFOX Database Browser: about to refreshCollections(true)");
    await refreshCollections(true);
    console.log("VECTFOX Database Browser: refreshCollections done");

    // Show modal
    $("#vectfox_database_browser_modal").fadeIn(200);
    console.log("VECTFOX Database Browser: Opened (fadeIn fired)");
  } catch (err) {
    // Never leave isOpen=true on error — that would jam the button forever
    // (the early-return guard above would block every subsequent click).
    console.error("VECTFOX Database Browser: openDatabaseBrowser threw, resetting isOpen=false", err);
    browserState.isOpen = false;
    throw err;
  }
}

/**
 * Updates the plugin warning banner visibility
 */
function updatePluginWarningBanner() {
  const banner = $("#vectfox_plugin_warning_banner");
  if (browserState.pluginAvailable) {
    banner.hide();
  } else {
    banner.show();
  }
}

/**
 * Closes the database browser modal
 */
export function closeDatabaseBrowser() {
  $("#vectfox_database_browser_modal").fadeOut(200);
  browserState.isOpen = false;
  // Reset event bound flags for clean rebind on next open
  resetEventFlags();
  if (browserState.settings?.eventbase_debug_logging) console.log("VECTFOX Database Browser: Closed");
}

/**
 * Resets event bound flags (called on modal close)
 */
function resetEventFlags() {
  // Reset flags so events rebind properly on next modal open
  bulkEventsBound = false;
  searchEventsBound = false;
}

/**
 * Creates the browser modal HTML structure
 */
function createBrowserModal() {
  const modalHtml = `
        <div id="vectfox_database_browser_modal" class="vectfox-modal">
            <div class="vectfox-modal-content vectfox-database-browser-content">
                <!-- Header -->
                <div class="vectfox-modal-header">
                    <h3>🗃️ VECTFOX Database Browser</h3>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <button class="vectfox-btn vectfox-btn-sm" id="vectfox_browser_refresh_scan" title="Probe standard and qdrant backends, update the registry, and remove stale entries">
                            ${icons.refreshCw(14)} Refresh Scan
                        </button>
                        <button class="vectfox-btn vectfox-btn-sm" id="vectfox_browser_clear_reformat_originals" title="Auto-Reformat retains each source's original text for audit. Clear it to reclaim settings.json space — the accepted chunks themselves are untouched.">
                            🧹 Clear Auto-Reformat Originals
                        </button>
                        <button class="vectfox-btn-icon" id="vectfox_browser_close">✕</button>
                    </div>
                </div>

                <!-- Plugin Warning Banner (hidden by default, shown when plugin unavailable) -->
                <div id="vectfox_plugin_warning_banner" class="vectfox-warning-banner" style="display: none;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: var(--SmartThemeQuoteColor);"></i>
                    <div class="vectfox-warning-text">
                        <strong>Limited Discovery Mode</strong>
                        <span>Similharity plugin not detected. Only registered collections and current chat can be discovered.
                        Collections created outside VECTFOX won't appear here.
                        <a href="https://github.com/KritBlade/VectFox/tree/Similharity-Plugin#step-2-install-plugin-via-git-recommended" target="_blank">Install the plugin</a> for full filesystem scanning.</span>
                    </div>
                </div>

                <!-- Browser Tabs -->
                <div class="vectfox-browser-tabs">
                    <button class="vectfox-tab-btn active" data-tab="collections">
                        ${icons.folder(16)} Collections
                    </button>
                    <button class="vectfox-tab-btn" data-tab="search">
                        ${icons.search(16)} Search
                    </button>
                    <button class="vectfox-tab-btn" data-tab="bulk">
                        ${icons.listChecks(16)} Bulk Operations
                    </button>
                    <button class="vectfox-tab-btn" data-tab="size" title="Diagnose oversized collections / runaway injection">
                        ${icons.layers(16)} Size Inspector
                    </button>
                </div>

                <!-- Tab Content -->
                <div class="vectfox-browser-content">
                    <!-- Collections Tab -->
                    <div id="vectfox_tab_collections" class="vectfox-tab-content active">
                        <!-- Scope Filters (V1-style) -->
                        <div class="vectfox-scope-filters">
                            <button class="vectfox-scope-filter active" data-scope="all" title="Show all collections">All</button>
                            <button class="vectfox-scope-filter" data-scope="character" title="Character = collections locked to at least one character">Character</button>
                            <button class="vectfox-scope-filter" data-scope="chat" title="Chat = collections locked to at least one chat">Chat</button>

                            <!-- Small badge and hint describing current scope filter -->
                        </div>

                        <!-- Type Filters -->
                        <div class="vectfox-type-filters">
                            <label>
                                <input type="radio" name="vectfox_type_filter" value="all" checked>
                                All Types
                            </label>
                            <label>
                                <input type="radio" name="vectfox_type_filter" value="chat">
                                ${icons.messageSquare(14)} Chats
                            </label>
                            <label>
                                <input type="radio" name="vectfox_type_filter" value="lorebook">
                                ${icons.bookOpen(14)} Lorebooks
                            </label>
                            <label>
                                <input type="radio" name="vectfox_type_filter" value="character">
                                ${icons.user(14)} Characters
                            </label>
                            <label>
                                <input type="radio" name="vectfox_type_filter" value="document">
                                ${icons.fileText(14)} Documents
                            </label>
                            <label>
                                <input type="radio" name="vectfox_type_filter" value="web">
                                ${icons.globe(14)} Web
                            </label>
                        </div>

                        <!-- Search Box + Active-only toggle -->
                        <div class="vectfox-search-box" style="display:flex; gap:8px; align-items:center;">
                            <input type="text"
                                   id="vectfox_collection_search"
                                   placeholder="Search collections..."
                                   autocomplete="off"
                                   style="flex:1;">
                            <label id="vectfox_only_active_toggle_label"
                                   title="Show only collections active for the current chat (the ones with the 🔒 badge)"
                                   style="display:flex; gap:6px; align-items:center; white-space:nowrap; cursor:pointer; font-size:0.85em;">
                                <input type="checkbox" id="vectfox_only_active_toggle">
                                🔒 Active here only
                            </label>
                        </div>

                        <!-- Collections List -->
                        <div id="vectfox_collections_list" class="vectfox-collections-list">
                            <div class="vectfox-loading">Loading collections...</div>
                        </div>

                        <!-- Stats Footer -->
                        <div class="vectfox-browser-stats">
                            <span id="vectfox_browser_stats_text">No collections</span>
                            <div class="vectfox-browser-actions">
                                <button id="vectfox_import_collection" class="vectfox-btn-sm" title="Import collection from file">
                                    📥 Import
                                </button>
                                <button id="vectfox_reset_registry" class="vectfox-reset-btn" title="Clear registry and rescan from disk">
                                    <i class="fa-solid fa-arrows-rotate"></i> Resync
                                </button>
                            </div>
                        </div>
                        <!-- Hidden file inputs for import -->
                        <input type="file" id="vectfox_import_file" accept=".json,.vectfox.json,.png,image/png" style="display: none;">
                        <input type="file" id="vectfox_png_image_picker" accept="image/*" style="display: none;">
                    </div>

                    <!-- Search Tab -->
                    <div id="vectfox_tab_search" class="vectfox-tab-content">
                        <div class="vectfox-search-panel">
                            <!-- Search Input -->
                            <div class="vectfox-search-input-row">
                                <input type="text"
                                       id="vectfox_semantic_search"
                                       class="vectfox-search-input"
                                       placeholder="Search across all collections..."
                                       autocomplete="off">
                                <button id="vectfox_search_btn" class="vectfox-btn vectfox-btn-primary">
                                    ${icons.search(16)} Search
                                </button>
                            </div>

                            <!-- Search Options -->
                            <div class="vectfox-search-options">
                                <div class="vectfox-search-option">
                                    <label>Results per collection:</label>
                                    <input type="number" id="vectfox_search_topk" value="5" min="1" max="50">
                                </div>
                                <div class="vectfox-search-option">
                                    <label>Min score:</label>
                                    <input type="number" id="vectfox_search_threshold" value="0.3" min="0" max="1" step="0.05">
                                </div>
                                <div class="vectfox-search-option">
                                    <label>
                                        <input type="checkbox" id="vectfox_search_enabled_only" checked>
                                        Enabled collections only
                                    </label>
                                </div>
                            </div>

                            <!-- Keyword Filter -->
                            <div class="vectfox-keyword-filter-section">
                                <div class="vectfox-keyword-filter-header">
                                    ${icons.filter(16)} <span>Keyword Filter</span>
                                    <button id="vectfox_scan_keywords" class="vectfox-btn-sm" title="Scan all collections for keywords">
                                        <i class="fa-solid fa-sync"></i> Scan
                                    </button>
                                </div>
                                <div class="vectfox-keyword-filter-input-row">
                                    <input type="text"
                                           id="vectfox_keyword_filter"
                                           class="vectfox-keyword-filter-input"
                                           placeholder="Filter by keywords (comma-separated)..."
                                           autocomplete="off">
                                    <button id="vectfox_clear_keyword_filter" class="vectfox-btn-sm" title="Clear filter">
                                        ${icons.x(14)}
                                    </button>
                                </div>
                                <div id="vectfox_keyword_tags" class="vectfox-keyword-tags">
                                    <span class="vectfox-keyword-hint">Click "Scan" to discover keywords in your collections</span>
                                </div>
                            </div>

                            <!-- Search Results -->
                            <div id="vectfox_search_results" class="vectfox-search-results">
                                <div class="vectfox-search-empty">
                                    ${icons.search(48)}
                                    <p>Enter a query to search across all collections</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Bulk Operations Tab -->
                    <div id="vectfox_tab_bulk" class="vectfox-tab-content">
                        <div class="vectfox-bulk-panel">
                            <!-- Selection Info -->
                            <div class="vectfox-bulk-header">
                                <div class="vectfox-bulk-select-all">
                                    <label>
                                        <input type="checkbox" id="vectfox_bulk_select_all">
                                        Select All Visible
                                    </label>
                                    <span id="vectfox_bulk_count">0 selected</span>
                                </div>
                                <div class="vectfox-bulk-filter">
                                    <select id="vectfox_bulk_filter">
                                        <option value="all">All Collections</option>
                                        <option value="enabled">Enabled Only</option>
                                        <option value="disabled">Disabled Only</option>
                                    </select>
                                </div>
                            </div>

                            <!-- Bulk Actions -->
                            <div class="vectfox-bulk-actions">
                                <button id="vectfox_bulk_enable" class="vectfox-btn vectfox-btn-sm" disabled>
                                    ${icons.toggleRight(16)} Enable Selected
                                </button>
                                <button id="vectfox_bulk_disable" class="vectfox-btn vectfox-btn-sm" disabled>
                                    ${icons.toggleLeft(16)} Disable Selected
                                </button>
                                <button id="vectfox_bulk_export" class="vectfox-btn vectfox-btn-sm" disabled>
                                    ${icons.download(16)} Export Selected
                                </button>
                                <button id="vectfox_bulk_delete" class="vectfox-btn vectfox-btn-sm vectfox-btn-danger" disabled>
                                    ${icons.trash(16)} Delete Selected
                                </button>
                            </div>

                            <!-- Collection List with Checkboxes -->
                            <div id="vectfox_bulk_list" class="vectfox-bulk-list">
                                <div class="vectfox-loading">Loading collections...</div>
                            </div>
                        </div>
                    </div>

                    <!-- Size Inspector Tab -->
                    <div id="vectfox_tab_size" class="vectfox-tab-content">
                        <!-- Populated lazily by renderSizeInspectorTab() in switchTab() -->
                    </div>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);

  // Bind events
  bindBrowserEvents();
}

/**
 * Binds event handlers for browser UI
 */
function bindBrowserEvents() {
  // Refresh Scan button — probes both backends, removes stale entries, updates registry
  $("#vectfox_browser_refresh_scan").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    const $btn = $(this);
    $btn.prop("disabled", true).text("Scanning…");
    try {
      await refreshCollections(true);
      toastr.success("Scan complete — registry updated", "VectFox");
    } catch (err) {
      toastr.error(`Scan failed: ${err.message}`, "VectFox");
    } finally {
      $btn.prop("disabled", false).html(`${icons.refreshCw(14)} Refresh Scan`);
    }
  });

  // Clear Auto-Reformat Originals — maintenance action for reformat-store.js's
  // retained pre-reformat source text (kept for audit/revert; see reformat-store.js
  // docstring). Only clears the audit copy, never the accepted chunks/runId, so this
  // can never affect anything already vectorized.
  $("#vectfox_browser_clear_reformat_originals").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();
    try {
      const { listReformatCacheEntries, clearAllReformatOriginals } = await import("../core/reformat-store.js");
      const entries = listReformatCacheEntries();
      const totalBytes = entries.reduce((sum, entry) => sum + entry.originalTextBytes, 0);

      if (totalBytes === 0) {
        toastr.info("No retained Auto-Reformat originals to clear.", "VectFox");
        return;
      }

      const { callGenericPopup, POPUP_TYPE } = await import("../../../../popup.js");
      const confirmed = await callGenericPopup(
        `<div style="text-align:left;">
                    <p><strong>Clear retained Auto-Reformat originals?</strong></p>
                    <p>${entries.length} source(s), ~${Math.round(totalBytes / 1024)} KB of pre-reformat text.</p>
                    <p style="margin-top:10px;">This only removes the audit copy of the original source text — the accepted, already-reformatted chunks are untouched and remain usable. You won't be able to review the original wording later.</p>
                </div>`,
        POPUP_TYPE.CONFIRM,
        "",
        { okButton: "Clear Originals", cancelButton: "Cancel" },
      );
      if (!confirmed) return;

      const cleared = clearAllReformatOriginals();
      toastr.success(`Cleared retained original text for ${cleared} Auto-Reformat entr${cleared === 1 ? "y" : "ies"}.`, "VectFox");
    } catch (err) {
      toastr.error(`Failed to clear Auto-Reformat originals: ${err.message}`, "VectFox");
    }
  });

  // Close button
  $("#vectfox_browser_close").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    closeDatabaseBrowser();
  });

  // Stop propagation on mousedown (ST listens on mousedown to close drawers)
  // This prevents the drawer from closing when clicking inside the modal
  $("#vectfox_database_browser_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close when clicking directly on the modal background (overlay)
  $("#vectfox_database_browser_modal").on("click", function (e) {
    if (e.target === this) {
      e.preventDefault();
      closeDatabaseBrowser();
    }
  });

  // Tab switching
  $("#vectfox_database_browser_modal .vectfox-tab-btn").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    const tab = $(this).data("tab");
    switchTab(tab);
  });

  // Scope filters
  $("#vectfox_database_browser_modal .vectfox-scope-filter").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    $("#vectfox_database_browser_modal .vectfox-scope-filter").removeClass("active");
    $(this).addClass("active");
    browserState.filters.scope = $(this).data("scope");
    renderCollections();
  });

  // Type filters
  $('#vectfox_database_browser_modal input[name="vectfox_type_filter"]').on("change", function (e) {
    e.stopPropagation();
    browserState.filters.collectionType = $(this).val();
    renderCollections();
  });

  // Search input
  $("#vectfox_collection_search").on("input", function (e) {
    e.stopPropagation();
    browserState.filters.searchQuery = $(this).val().toLowerCase();
    renderCollections();
  });

  // "Active here only" toggle — filters down to the collections that currently
  // carry the 🔒 badge for the current chat. Uses the canonical isActiveById
  // lookup built from getCollectionListing inside renderCollections().
  $("#vectfox_only_active_toggle").on("change", function (e) {
    e.stopPropagation();
    browserState.filters.onlyActiveForChat = $(this).prop("checked");
    renderCollections();
  });

  // Resync button - clears registry and rescans from disk
  $("#vectfox_reset_registry").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();

    const confirmed = confirm(
      "This will clear the collection registry and rescan from disk.\n\n" +
        "Any ghost entries (collections that no longer exist on disk) will be removed.\n\n" +
        "Continue?",
    );

    if (!confirmed) return;

    try {
      // Clear the registry
      clearCollectionRegistry();

      // Probe both backends to repopulate from scratch
      await refreshCollections(true);

      toastr.success("Registry cleared and resynced from disk", "VectFox");
    } catch (error) {
      console.error("VectFox: Failed to resync", error);
      toastr.error(`Failed to resync: ${error.message}`, "VectFox");
    }
  });

  // Keyboard shortcuts
  $(document).on("keydown.vectfox_browser", function (e) {
    if (!browserState.isOpen) return;

    if (e.key === "Escape") {
      closeDatabaseBrowser();
    }
  });

  // Import button
  $("#vectfox_import_collection").on("click", function (e) {
    e.stopPropagation();
    $("#vectfox_import_file").click();
  });

  // Import file handler (supports JSON and PNG)
  $("#vectfox_import_file").on("change", async function (e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset input so same file can be selected again
    $(this).val("");

    // H-3 mitigation: reject oversized files at the picker before any read
    // commitment. Cap (MAX_IMPORT_FILE_BYTES) is defined once in
    // core/collection-export.js and shared between this PNG picker and the
    // JSON file-reader path — keeps the two import paths in sync if the
    // cap is ever retuned.
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      toastr.error(
        `File too large: ${mb} MB (max ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB).`,
        "VECTFOX Import",
      );
      return;
    }

    try {
      toastr.info("Reading import file...", "VectFox");

      let data;

      // Check if it's a PNG file
      if (
        file.type === "image/png" ||
        file.name.toLowerCase().endsWith(".png")
      ) {
        const pngData = await readPNGFile(file);
        data = await extractDataFromPNG(pngData);

        if (!data) {
          toastr.error(
            "This PNG does not contain VECTFOX data.",
            "VECTFOX Import",
          );
          return;
        }

        toastr.info("Found VECTFOX data in PNG!", "VectFox");
      } else {
        // JSON file
        data = await readImportFile(file);
      }

      const info = getExportInfo(data);
      const validation = validateImportData(data, browserState.settings);

      // Show import confirmation dialog
      let message = `Import "${info.collections[0]?.name || "collection"}"?\n\n`;
      message += `• ${info.totalChunks} chunks\n`;
      message += `• ${info.totalChunksWithVectors} with vectors\n`;

      if (info.embedding) {
        message += `\nEmbedding: ${info.embedding.source}/${info.embedding.model || "default"}\n`;
        message += `Dimension: ${info.embedding.dimension || "unknown"}\n`;

        // Show backend transition so user knows if data is being migrated.
        const _normBackend = b => (String(b || 'standard').toLowerCase() === 'vectra' ? 'standard' : String(b || 'standard').toLowerCase());
        const srcBackend  = _normBackend(info.embedding.backend);
        const destBackend = _normBackend(browserState.settings.vector_backend);
        message += `Backend: ${srcBackend} → ${destBackend}${srcBackend !== destBackend ? ' (migration)' : ''}\n`;
      }

      if (validation.warnings.length > 0) {
        message += `\n⚠️ Warnings:\n`;
        validation.warnings.forEach((w) => {
          message += `• ${w}\n`;
        });
      }

      if (!validation.compatible && info.totalChunksWithVectors > 0) {
        message += `\n⚠️ Your embedding settings don't match.\n`;
        message += `To use existing vectors, change your settings to:\n`;
        message += `  Source: ${info.embedding?.source || "unknown"}\n`;
        message += `  Model: ${info.embedding?.model || "default"}\n`;
        message += `\nOr continue to re-embed with current settings.`;
      }

      if (!validation.valid) {
        toastr.error(
          `Invalid export file:\n${validation.errors.join("\n")}`,
          "VECTFOX Import",
        );
        return;
      }

      const confirmed = confirm(message);
      if (!confirmed) return;

      // Perform import
      const result = await importCollection(data, browserState.settings, {
        overwrite: true, // Overwrite if exists
      });

      if (result.success) {
        const vectorMsg = result.usedVectors
          ? "(used existing vectors)"
          : "(re-embedded)";
        toastr.success(
          `Imported ${result.chunkCount} chunks ${vectorMsg}`,
          "VECTFOX Import",
        );

        // Refresh collections list
        await refreshCollections();
      }
    } catch (error) {
      const isStopped = error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('stopped by user');
      if (isStopped) {
        toastr.info('Import stopped', 'VectFox');
        await refreshCollections();
        return;
      }
      console.error("VectFox: Import failed", error);
      toastr.error(`Import failed: ${error.message}`, "VectFox");
    }
  });
}


/**
 * Switches active tab
 * @param {string} tabName Tab identifier
 */
function switchTab(tabName) {
  $("#vectfox_database_browser_modal .vectfox-tab-btn").removeClass("active");
  $(`#vectfox_database_browser_modal .vectfox-tab-btn[data-tab="${tabName}"]`).addClass("active");

  $("#vectfox_database_browser_modal .vectfox-tab-content").removeClass("active");
  $(`#vectfox_tab_${tabName}`).addClass("active");

  // Initialize tab-specific content
  if (tabName === "bulk") {
    renderBulkList();
    bindBulkEvents();
  } else if (tabName === "search") {
    bindSearchEvents();
  } else if (tabName === "size") {
    renderSizeInspectorTab(document.getElementById("vectfox_tab_size"));
  }
}

/**
 * Refreshes collections from storage
 */
/**
 * Sanitize a persona name into a handleId — must match the logic used by collection-ids.js
 * builders (buildEventBaseCollectionId, buildArchiveEventCollectionId).
 * @param {string} name
 * @returns {string}
 */
const _sanitizeHandleForFilter = sanitizeHandleId;

/**
 * Extract the persona handle embedded in a VECTFOX collection ID name.
 *
 * Naming convention (collection-ids.js):
 *   vectfox_<type>_<backend>_<handle>_<charname>_<uuid>   (new)
 *   vectfox_<type>_<handle>_<charname>_<uuid>             (legacy, no backend)
 *
 * Returns lowercased handle string, or null if the ID isn't persona-scoped
 * or can't be parsed.
 */
const _KNOWN_BACKEND_TAGS = ["standard", "vectra", "qdrant"];
function _extractHandleFromCollectionId(collectionId) {
  if (!collectionId) return null;
  const idLower = String(collectionId).toLowerCase();
  for (const prefix of _PERSONA_SCOPED_PREFIXES) {
    const p = prefix.toLowerCase();
    if (!idLower.startsWith(p)) continue;
    const segments = idLower.slice(p.length).split("_");
    if (segments.length === 0) return null;
    // Skip the optional backend tag if present in segment 0.
    const handleIdx = _KNOWN_BACKEND_TAGS.includes(segments[0]) ? 1 : 0;
    return segments[handleIdx] || null;
  }
  return null;
}

/**
 * Collection prefixes whose collections carry a persona-owned `creatorHandle`.
 * All VECTFOX content types follow the unified `vectfox_<type>_<backend>_<handle>_...`
 * naming protocol and are persona-scoped.
 */
const _PERSONA_SCOPED_PREFIXES = [
  COLLECTION_PREFIXES.VECTFOX_EVENTBASE,
  COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT,
  COLLECTION_PREFIXES.VECTFOX_LOREBOOK,
  COLLECTION_PREFIXES.VECTFOX_CHARACTER,
  COLLECTION_PREFIXES.VECTFOX_DOCUMENT,
];

/**
 * Filter collections to only the current persona's chat-scoped collections.
 * Global-scope collections (lorebook, document, character) are always kept.
 *
 * Authoritative source: `creatorHandle` stamped onto collection metadata at
 * registerCollection time (see core/collection-loader.js). Exact-equality check —
 * collision-proof regardless of underscores in handle or charName.
 *
 * Chat-scoped collections without a `creatorHandle` are treated as foreign and hidden.
 * loadAllCollections() calls registerCollection() for every registry entry on each open,
 * so the stamp is always applied before this filter runs — even for pre-stamp or imported entries.
 *
 * UI-only filter — not access control. The server still stores everything;
 * a determined user could load another persona's collection by knowing its ID.
 * Real isolation lives at the plugin / Qdrant layer.
 *
 * @param {object[]} collections
 * @returns {object[]}
 */
function _filterCollectionsByCurrentPersona(collections) {
  // SUPERADMIN MODE bypass — when `settings.superadmin === true` (hand-edited
  // into settings.json, no UI toggle), skip persona filtering entirely and
  // show every collection on the server. See defaults in index.js.
  if (browserState.settings?.superadmin === true) {
    console.log(
      `VECTFOX DB Browser: ⚡ superadmin=true → bypassing persona/handle filter (showing ALL ${collections.length} collections)`,
    );
    return collections;
  }

  // Single source of truth for ownership: getCollectionListing already encodes
  // the superadmin bypass + creatorHandle check + ID-substring fallback.
  // Build a quick lookup by both registry key and bare collection id.
  const ownLookup = new Map();
  for (const entry of getCollectionListing(browserState.settings)) {
    ownLookup.set(entry.registryKey, entry.isOwn);
    ownLookup.set(entry.collectionId, entry.isOwn);
  }

  return collections.filter((c) => {
    const idLower = String(c.id || "").toLowerCase();

    // Persona-scoped check by prefix (chat / eventbase / archiveevent).
    const isPersonaScoped = _PERSONA_SCOPED_PREFIXES.some((prefix) =>
      idLower.startsWith(prefix.toLowerCase())
    );

    // Shared types (lorebook / document / character) — always visible.
    if (!isPersonaScoped) return true;

    // Persona-scoped — keep only if the listing says we own it.
    const key = c.registryKey || `${c.backend}:${c.id}`;
    return ownLookup.get(key) === true || ownLookup.get(c.id) === true;
  });
}

async function refreshCollections(withScan = false) {
  try {
    const allCollections = await loadAllCollections(browserState.settings, withScan);
    browserState.collections = _filterCollectionsByCurrentPersona(allCollections);

    if (allCollections.length !== browserState.collections.length) {
      const hidden = allCollections.length - browserState.collections.length;
      if (browserState.settings?.eventbase_debug_logging) console.log(
        `VECTFOX DB Browser: Hiding ${hidden} chat-scoped collection(s) from other personas (current: ${_sanitizeHandleForFilter(getContext()?.name1)})`,
      );
    }

    // Clean up orphaned metadata entries (collections that no longer exist).
    // IMPORTANT: pass the *unfiltered* list so we don't wipe metadata for other
    // personas' collections when this persona opens the browser.
    //
    // Storage is keyed by `registryKey` (backend:id) for backend-registered
    // collections, falling back to bare `id` otherwise. Pass the same form the
    // storage layer uses so strict set membership matches the actual keys.
    const actualIds = allCollections.map((c) => c.registryKey || c.id);
    const cleanupResult = cleanupOrphanedMeta(actualIds);
    if (cleanupResult.removed > 0 && browserState.settings?.eventbase_debug_logging) {
      console.log(
        `VectFox: Cleaned up ${cleanupResult.removed} orphaned metadata entries`,
      );
    }

    renderCollections();
  } catch (error) {
    console.error("VectFox: Failed to load collections", error);
    $("#vectfox_collections_list").html(`
            <div class="vectfox-error">
                Failed to load collections. Check console for details.
            </div>
        `);
  }
}

/**
 * Renders collections list based on current filters
 */
export function renderCollections() {
  const container = $("#vectfox_collections_list");

  // Build lock-state lookup once — same canonical source of truth used by the
  // card renderer (entry.isActive comes from getCollectionListing internally
  // calling isCollectionActiveForContext, keyed by registry-key form). Built
  // BEFORE the filter pass so "Active here only" can consult it without
  // re-computing per card. See Doc/collection_helper.md:54.
  const isActiveById = new Map();
  for (const entry of getCollectionListing(browserState.settings)) {
    isActiveById.set(entry.collectionId, entry.isActive);
    isActiveById.set(entry.registryKey, entry.isActive);
  }

    // Apply filters
    let filtered = browserState.collections.filter(c => {
        const scopeFilter = browserState.filters.scope;
        const lookupKey = c.registryKey || c.id;

        // Scope filter:
        // - 'all' => no filter
        // - 'chat' => show collections locked to at least one chat
        // - 'character' => show collections locked to at least one character
        if (scopeFilter !== 'all') {
            // Lock counts are keyed by registry-key form ("backend:id") — same key
            // setCollectionLock writes to.
            if (scopeFilter === 'chat') {
                if (getCollectionLockCount(lookupKey) <= 0) return false;
            } else if (scopeFilter === 'character') {
                if (getCollectionCharacterLockCount(lookupKey) <= 0) return false;
            }
        }

        // "Active here only" toggle — keeps just the collections that carry the
        // 🔒 badge for the current chat (chat-lock match OR character-lock match
        // for the active character). Uses the pre-built isActiveById lookup so
        // we stay aligned with the badge's source of truth.
        if (browserState.filters.onlyActiveForChat) {
            if (!isActiveById.get(lookupKey)) return false;
        }

    // Type filter - map filter categories to actual collection types
    if (browserState.filters.collectionType !== "all") {
      const typeMap = {
        chat: ["chat"],
        lorebook: ["lorebook"],
        character: ["character", "persona"],
        document: ["file", "doc", "paste", "select", "current"],
        web: ["url", "wiki", "youtube"],
      };
      const allowedTypes = typeMap[browserState.filters.collectionType];
      if (allowedTypes && !allowedTypes.includes(c.type)) {
        return false;
      }
    }

    // Search filter
    if (browserState.filters.searchQuery) {
      const searchLower = browserState.filters.searchQuery;
      return (
        c.name.toLowerCase().includes(searchLower) ||
        c.id.toLowerCase().includes(searchLower)
      );
    }

    return true;
  });

  if (filtered.length === 0) {
    container.html(`
            <div class="vectfox-empty-state">
                <p>No collections found.</p>
                <small>Vectorize some chat messages to create collections!</small>
            </div>
        `);
    updateStats(0, 0);
    return;
  }

  // isActiveById was built at the top of this function for the filter pass —
  // reused here by the card renderer (entry.isActive lookups, no per-card calls).

  // Render collection cards
  const cardsHtml = filtered.map((c) => renderCollectionCard(c, isActiveById)).join("");
  container.html(cardsHtml);

  // Bind card events
  bindCollectionCardEvents();

  // Update stats
  const totalChunks = filtered.reduce((sum, c) => sum + c.chunkCount, 0);
  updateStats(filtered.length, totalChunks);
}

/**
 * Renders a single collection card (V1-inspired layout)
 * @param {object} collection Collection data
 * @param {Map<string, boolean>} [isActiveById] Optional lookup keyed by both
 *   bare collectionId and `${backend}:${collectionId}` — produced by the
 *   caller from getCollectionListing(). When omitted, the badge falls back
 *   to a direct isCollectionActiveForContext call.
 * @returns {string} Card HTML
 */
function renderCollectionCard(collection, isActiveById = null) {
  // Map collection types to icon functions
  const typeIconMap = {
    chat: icons.messageSquare,
    file: icons.fileText,
    doc: icons.fileText,
    paste: icons.fileText,
    select: icons.fileText,
    current: icons.fileText,
    lorebook: icons.bookOpen,
    character: icons.user,
    persona: icons.user,
    url: icons.globe,
    wiki: icons.globe,
    youtube: icons.globe,
  };
  const iconFn = typeIconMap[collection.type] || icons.box;
  const typeIcon = iconFn(14, "vectfox-type-icon");

  const scopeBadge =
    {
      character:
        '<span class="vectfox-badge vectfox-badge-character">Character</span>',
      chat: '<span class="vectfox-badge vectfox-badge-chat">Chat</span>',
    }[collection.scope] || "";

  const statusBadge = collection.enabled
    ? '<span class="vectfox-badge vectfox-badge-success">Active</span>'
    : '<span class="vectfox-badge vectfox-badge-muted">Paused</span>';

  // Activation badge (shows triggers or conditions)
  const activationSummary = getCollectionActivationSummary(collection.id);
  let activationBadge = "";
  if (activationSummary.alwaysActive) {
    activationBadge =
      '<span class="vectfox-badge vectfox-badge-always" title="Always active">∞ Always</span>';
  } else if (activationSummary.triggerCount > 0) {
    activationBadge = `<span class="vectfox-badge vectfox-badge-triggers" title="${activationSummary.triggerCount} trigger(s)">🎯 ${activationSummary.triggerCount}</span>`;
  } else if (activationSummary.conditionsEnabled) {
    activationBadge = `<span class="vectfox-badge vectfox-badge-conditions" title="${activationSummary.conditionCount} condition(s)">⚡ ${activationSummary.conditionCount}</span>`;
  }

  // Backend badge - shows vector database (Standard, Qdrant)
  const backendDisplayName =
    {
      standard: "Standard",
      qdrant: "Qdrant",
    }[collection.backend] || collection.backend;

  const backendBadge = collection.backend
    ? `<span class="vectfox-badge vectfox-badge-backend" title="Vector backend">${backendDisplayName}</span>`
    : "";

  // Source badge - shows embedding source (transformers, palm, openai, etc.)
  const sourceBadge =
    collection.source && collection.source !== "unknown"
      ? `<span class="vectfox-badge vectfox-badge-source" title="Embedding source">${StringUtils.escapeHtml(collection.source)}</span>`
      : "";

  // Model info - show current model and count if multiple
  const hasMultipleModels = collection.models && collection.models.length > 1;
  const currentModelName = collection.model || "(default)";
  const safeCurrentModelName = StringUtils.escapeHtml(currentModelName);
  const modelBadge = hasMultipleModels
    ? `<span class="vectfox-badge vectfox-badge-model" title="Current model: ${safeCurrentModelName} (${collection.models.length} available)">📐 ${safeCurrentModelName}</span>`
    : "";

  // Lock badge — show only when locked to the CURRENT chat. Locks to other chats
  // still exist (visible in the Settings modal as "X lock (other chat)"), but the
  // listing badge would be misleading there since the collection isn't active here.
  // The lock badge mirrors the "Active for current chat" checkbox — same source
  // of truth (isCollectionActiveForContext, bundled into getCollectionListing).
  // Use registry-key form so the metadata layer keys lock state per-backend.
  // Two collections sharing a bare ID across different backends now report
  // their lock badges independently.
  const lockLookupId = collection.registryKey || collection.id;
  let isActive;
  if (isActiveById) {
    const key = collection.registryKey || `${collection.backend}:${collection.id}`;
    isActive = isActiveById.get(key) === true || isActiveById.get(collection.id) === true;
  } else {
    isActive = isCollectionActiveForContext(lockLookupId, {
      chatId: getCurrentChatId(),
      characterId: getContext()?.characterId,
    });
  }
  let lockBadge = "";
  if (isActive) {
    const lockTitle = collection.scope === 'character'
      ? "Active for current chat (locked to current character)"
      : (() => {
          const otherCount = getCollectionLockCount(lockLookupId) - 1;
          return otherCount > 0
            ? `Active for current chat (also locked to ${otherCount} other chat${otherCount !== 1 ? "s" : ""})`
            : "Active for current chat";
        })();
    lockBadge = `<span class="vectfox-badge vectfox-badge-lock" title="${lockTitle}">🔒</span>`;
  }

  // Use registryKey for unique identification (source:id format)
  const uniqueKey = collection.registryKey || collection.id;

  // Pre-escape every string field that ends up in HTML or attribute context.
  // Source data can include lorebook entry names / character card names that
  // came from third-party sharing sites (chub.ai, JanitorAI) and may contain
  // HTML payloads. C-3: defense-in-depth — even `collection.id` (auto-
  // generated `vf_*`) and the backend/source enums get escaped so a future
  // malformed registry entry can't introduce attribute-context XSS.
  const safeKey       = StringUtils.escapeHtml(uniqueKey);
  const safeId        = StringUtils.escapeHtml(collection.id);
  const safeName      = StringUtils.escapeHtml(collection.name);
  const safeBackend   = StringUtils.escapeHtml(collection.backend);
  const safeSource    = StringUtils.escapeHtml(collection.source || "transformers");
  const safeModel     = StringUtils.escapeHtml(collection.model || "");

  return `
        <div class="vectfox-collection-card" data-collection-key="${safeKey}" data-status="${collection.enabled ? "active" : "paused"}">
            <div class="vectfox-collection-header">
                <span class="vectfox-collection-title">
                    ${typeIcon} ${safeName}
                </span>
                <div class="vectfox-collection-badges">
                    ${scopeBadge}
                    ${backendBadge}
                    ${sourceBadge}
                    ${modelBadge}
                    ${lockBadge}
                    ${statusBadge}
                </div>
            </div>

            <div class="vectfox-collection-meta">
                <span>${collection.chunkCount} chunks</span>
                <span>ID: ${safeId}</span>
            </div>

            <div class="vectfox-collection-actions">
                <button class="vectfox-btn-sm vectfox-action-toggle"
                        data-collection-key="${safeKey}"
                        data-enabled="${collection.enabled}">
                    ${collection.enabled ? icons.pause(16) + " Pause" : icons.play(16) + " Enable"}
                </button>
                <button class="vectfox-btn-sm vectfox-action-rename"
                        data-collection-key="${safeKey}"
                        data-current-name="${safeName}"
                        title="Rename this collection">
                    ${icons.pencil(16)} Rename
                </button>
                <button class="vectfox-btn-sm vectfox-action-activation ${activationSummary.mode !== "auto" ? "vectfox-has-settings" : ""}"
                        data-collection-key="${safeKey}"
                        title="Configure activation, triggers, and conditions">
                    ${icons.settings(16)} Settings
                </button>
                ${
                  hasMultipleModels
                    ? `
                <button class="vectfox-btn-sm vectfox-action-switch-model"
                        data-collection-key="${safeKey}"
                        title="Switch embedding model (${collection.models.length} available)">
                    <i class="fa-solid fa-code-branch"></i> Model
                </button>
                `
                    : ""
                }
                <button class="vectfox-btn-sm vectfox-action-visualize"
                        data-collection-key="${safeKey}"
                        data-backend="${safeBackend}"
                        data-source="${safeSource}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
                <div class="vectfox-export-dropdown">
                    <button class="vectfox-btn-sm vectfox-btn-export vectfox-action-export-toggle"
                            title="Export collection">
                        ${icons.download(16)} Export
                    </button>
                    <div class="vectfox-export-options">
                        <button class="vectfox-btn-sm vectfox-btn-json vectfox-action-export"
                                data-collection-key="${safeKey}"
                                data-collection-id="${safeId}"
                                data-backend="${safeBackend}"
                                data-source="${safeSource}"
                                data-model="${safeModel}"
                                title="Export as JSON (includes vectors)">
                            ${icons.fileExport(16)} JSON
                        </button>
                        <button class="vectfox-btn-sm vectfox-btn-png vectfox-action-export-png"
                                data-collection-key="${safeKey}"
                                data-collection-id="${safeId}"
                                data-backend="${safeBackend}"
                                data-source="${safeSource}"
                                data-model="${safeModel}"
                                title="Export as PNG (shareable image)">
                            ${icons.image(16)} PNG
                        </button>
                    </div>
                </div>
                <button class="vectfox-btn-sm vectfox-btn-danger vectfox-action-delete"
                        data-collection-key="${safeKey}">
                    ${icons.trash(16)} Delete
                </button>
            </div>
        </div>
    `;
}

/**
 * Helper to find collection by its unique key (registryKey or id)
 */
function findCollectionByKey(key) {
  return browserState.collections.find((c) => (c.registryKey || c.id) === key);
}

/**
 * Performs PNG export with optional custom image
 * @param {File|null} imageFile - Custom image file or null for default
 */
async function performPngExport(imageFile) {
  const pending = browserState.pendingPngExport;
  if (!pending) {
    toastr.error("No export pending", "VectFox");
    return;
  }

  browserState.pendingPngExport = null;

  try {
    toastr.info("Preparing PNG export...", "VectFox");

    // Get export data
    const exportData = await exportCollection(
      pending.collectionId,
      browserState.settings,
      {
        backend: pending.backend,
        source: pending.source,
        model: pending.model,
      },
    );

    // Convert custom image to PNG if provided
    let pngData = null;
    if (imageFile) {
      toastr.info("Converting image...", "VectFox");
      pngData = await convertToPNG(imageFile);
    }

    // Embed data in PNG
    toastr.info("Embedding data in PNG...", "VectFox");
    const pngWithData = await embedDataInPNG(exportData, pngData);

    // Download
    const filename = `${pending.collection.name || pending.collectionId}.vectfox`;
    downloadPNG(pngWithData, filename);

    // Show compression stats
    const jsonSize = JSON.stringify(exportData).length;
    const pngSize = pngWithData.length;
    const ratio = Math.round((pngSize / jsonSize) * 100);

    toastr.success(
      `PNG export complete!\n${exportData.stats.chunkCount} chunks\n` +
        `Original: ${formatBytes(jsonSize)}\n` +
        `PNG: ${formatBytes(pngSize)} (${ratio}%)`,
      "VECTFOX Export",
    );
  } catch (error) {
    console.error("VectFox: PNG export failed", error);
    toastr.error(`PNG export failed: ${error.message}`, "VectFox");
  }
}

/**
 * Formats bytes to human readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Loads and opens the chunk visualizer for a collection.
 * Shared by both the collections tab and search results tab handlers.
 */
async function openChunkVisualizer(collection) {
  try {
    toastr.info("Loading chunks...", "VectFox");

    if (!collection.backend) {
      toastr.error("Collection has no backend defined - this is a bug", "VectFox");
      console.error("VectFox: Collection missing backend:", collection);
      return;
    }

    if (!browserState.pluginAvailable) {
      toastr.warning(
        "The Similharity plugin is required to view chunks. Install the plugin to use this feature.",
        "VectFox",
        { timeOut: 6000 },
      );
      return;
    }

    const collectionSettings = {
      ...browserState.settings,
      vector_backend: collection.backend,
    };

    const doLoad = async (limit) => {
      const requestBody = {
        backend: collection.backend || "vectra",
        collectionId: collection.id,
        source: collection.source || "transformers",
        model: collection.model || "",
        ...(limit ? { limit } : {}),
      };

      console.log("VECTFOX DB Browser: Requesting chunks with:", requestBody);

      const response = await fetch("/api/plugins/similharity/chunks/list", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`Failed to list chunks: ${response.statusText}`);
      }

      const data = await response.json();
      const results = data.items || data.chunks || data.results || [];
      const dbChunkCount = Number(
        data.total ?? data.totalCount ?? data.count ?? collection.chunkCount ?? results.length,
      );

      if (!results || results.length === 0) {
        toastr.warning("No chunks found in this collection", "VectFox");
        return;
      }

      const chunks = results.map((item, idx) => ({
        hash: item.hash,
        index: (item.index != null && item.index >= 0) ? item.index : idx,
        text: item.text || item.metadata?.text || "No text available",
        score: 1.0,
        similarity: 1.0,
        messageAge: item.metadata?.messageAge,
        decayApplied: false,
        decayMultiplier: 1.0,
        metadata: item.metadata,
      }));

      openVisualizer(
        { chunks, collectionType: collection.type, dbChunkCount },
        collection.id,
        collectionSettings,
        doLoad,
      );
    };

    await doLoad(null);
  } catch (error) {
    console.error("VectFox: Failed to load chunks", error);
    toastr.error(`Failed to load chunks: ${error.message}`, "VectFox");
  }
}

/**
 * Binds events for collection card actions
 */
function bindCollectionCardEvents() {
  // Toggle enabled/disabled
  $(".vectfox-action-toggle")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const currentEnabled = $(this).data("enabled");
      const newEnabled = !currentEnabled;

      setCollectionEnabled(collectionKey, newEnabled);

      // Update UI
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        collection.enabled = newEnabled;
      }

      renderCollections();

      toastr.success(
        `Collection ${newEnabled ? "enabled" : "paused"}`,
        "VectFox",
      );
    });

  // Delete collection - uses unified deleteCollection() to handle all 3 stores
  $(".vectfox-action-delete")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      const confirmed = confirm(
        `Delete collection "${collection.name}"?\n\n` +
          `This will remove ${collection.chunkCount} chunks from the vector index.\n` +
          `This action cannot be undone.`,
      );

      if (!confirmed) return;

      try {
        // Use unified delete function - handles vectors, registry, AND metadata.
        // _discoveredModels carries the model subdirectories the plugin actually
        // found on disk, so the Standard backend purge can target the right
        // {source}/{collectionId}/{model}/ paths instead of guessing from the
        // user's current UI setting (which may not match what's on disk).
        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
          source: collection.source,
          _discoveredModels: collection.models,
        };

        const result = await deleteCollection(
          collection.id,
          collectionSettings,
          collection.registryKey,
        );

        // Remove from state
        browserState.collections = browserState.collections.filter(
          (c) => (c.registryKey || c.id) !== collectionKey,
        );

        // Re-render
        renderCollections();

        if (result.success) {
          toastr.success(`Deleted collection "${collection.name}"`, "VectFox");
        } else {
          toastr.warning(
            `Partial deletion: ${result.errors.join(", ")}`,
            "VectFox",
          );
        }
      } catch (error) {
        console.error("VectFox: Failed to delete collection", error);
        toastr.error(`Failed to delete collection: ${error.message}`, "VectFox");
      }
    });

  // Visualize chunks
  $(".vectfox-action-visualize")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;
      await openChunkVisualizer(collection);
    });

  // Export toggle - show/hide export options
  $(".vectfox-action-export-toggle")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const $dropdown = $(this).closest(".vectfox-export-dropdown");
      const isExpanded = $dropdown.hasClass("expanded");

      // Close any other open dropdowns
      $(".vectfox-export-dropdown.expanded")
        .not($dropdown)
        .removeClass("expanded");

      // Toggle this one
      $dropdown.toggleClass("expanded", !isExpanded);
    });

  // Close export dropdown when clicking elsewhere
  $(document)
    .off("click.vectfox-export")
    .on("click.vectfox-export", function (e) {
      if (!$(e.target).closest(".vectfox-export-dropdown").length) {
        $(".vectfox-export-dropdown.expanded").removeClass("expanded");
      }
    });

  // Export collection (JSON)
  $(".vectfox-action-export")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      try {
        toastr.info("Exporting collection...", "VectFox");

        const exportData = await exportCollection(
          collectionId,
          browserState.settings,
          {
            backend,
            source,
            model,
          },
        );

        downloadExport(exportData, collection.name || collectionId);

        toastr.success(
          `Exported ${exportData.stats.chunkCount} chunks (${exportData.stats.chunksWithVectors} with vectors)`,
          "VECTFOX Export",
        );
      } catch (error) {
        console.error("VectFox: Export failed", error);
        toastr.error(`Export failed: ${error.message}`, "VectFox");
      }
    });

  // Export collection (PNG)
  $(".vectfox-action-export-png")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      // Store export context for image picker callback
      browserState.pendingPngExport = {
        collectionKey,
        collectionId,
        backend,
        source,
        model,
        collection,
      };

      // Ask if they want to use a custom image
      const useCustomImage = confirm(
        "Export as PNG\n\n" +
          "Would you like to use a custom image?\n\n" +
          "• Click OK to choose an image file\n" +
          "• Click Cancel to use default VECTFOX image",
      );

      if (useCustomImage) {
        $("#vectfox_png_image_picker").click();
      } else {
        // Export with default image
        await performPngExport(null);
      }
    });

  // PNG image picker handler
  $("#vectfox_png_image_picker")
    .off("change")
    .on("change", async function (e) {
      const file = e.target.files[0];
      $(this).val(""); // Reset for next use

      if (!file) {
        browserState.pendingPngExport = null;
        return;
      }

      await performPngExport(file);
    });

  // Activation editor (triggers + conditions)
  $(".vectfox-action-activation")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        // Pass the registry key form (backend:id) so the metadata layer keys
        // locks per-backend. Two collections that share a bare ID but live on
        // different backends now have separate lock state.
        openActivationEditor(collection.registryKey || collection.id, collection.name);
      }
    });

  // Rename collection
  $(".vectfox-action-rename")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        // Pass registry-key form so the metadata write lands at the same key
        // the loader/import/cleanup paths use.
        openRenameDialog(collection.registryKey || collection.id, collection.name);
      }
    });

  // Switch model (for collections with multiple embedding models)
  $(".vectfox-action-switch-model")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection || !collection.models || collection.models.length < 2) {
        return;
      }

      openModelSwitcher(collection);
    });
}

/**
 * Updates stats footer
 * @param {number} collectionCount Number of collections shown
 * @param {number} chunkCount Total chunks
 */
function updateStats(collectionCount, chunkCount) {
  const statsText =
    collectionCount === 0
      ? "No collections"
      : `${collectionCount} collection${collectionCount === 1 ? "" : "s"}, ${chunkCount} total chunks`;

  $("#vectfox_browser_stats_text").text(statsText);
}

// ============================================================================
// RENAME DIALOG
// ============================================================================

/**
 * Opens a rename dialog for a collection
 * @param {string} collectionId Collection ID
 * @param {string} currentName Current display name
 */
function openRenameDialog(collectionId, currentName) {
  // Create modal if needed
  if ($("#vectfox_rename_modal").length === 0) {
    const modalHtml = `
            <div id="vectfox_rename_modal" class="vectfox-modal">
                <div class="vectfox-modal-content vectfox-rename-dialog popup">
                    <div class="vectfox-modal-header">
                        <h3>✏️ Rename Collection</h3>
                        <button class="vectfox-btn-icon" id="vectfox_rename_close">✕</button>
                    </div>
                    <div class="vectfox-rename-body">
                        <label for="vectfox_rename_input">New name:</label>
                        <input type="text" id="vectfox_rename_input" placeholder="Enter new name..." autocomplete="off">
                        <small class="vectfox-rename-hint">Leave empty to reset to auto-generated name</small>
                    </div>
                    <div class="vectfox-modal-footer">
                        <button class="vectfox-btn" id="vectfox_rename_cancel">Cancel</button>
                        <button class="vectfox-btn vectfox-btn-primary" id="vectfox_rename_save">Save</button>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind events
    $("#vectfox_rename_close, #vectfox_rename_cancel").on(
      "click",
      closeRenameDialog,
    );
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vectfox_rename_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vectfox_rename_modal").on("click", function (e) {
      if (e.target === this) closeRenameDialog();
    });
    $("#vectfox_rename_input").on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#vectfox_rename_save").click();
      } else if (e.key === "Escape") {
        closeRenameDialog();
      }
    });
  }

  // Store collection ID for save handler
  $("#vectfox_rename_modal").data("collection-id", collectionId);

  // Set current name
  $("#vectfox_rename_input").val(currentName);

  // Bind save handler (rebind each time to get fresh collectionId)
  $("#vectfox_rename_save")
    .off("click")
    .on("click", function () {
      const newName = $("#vectfox_rename_input").val().trim();
      const id = $("#vectfox_rename_modal").data("collection-id");

      // Save the new name (or null to reset)
      setCollectionMeta(id, { displayName: newName || null });

      // Update local state
      const collection = browserState.collections.find((c) => c.id === id);
      if (collection) {
        collection.name = newName || collection.name; // Will refresh properly on next load
      }

      closeRenameDialog();
      refreshCollections(); // Reload to get updated names

      if (newName) {
        toastr.success(`Renamed to "${newName}"`, "VectFox");
      } else {
        toastr.success("Reset to auto-generated name", "VectFox");
      }
    });

  // Show modal and focus input
  $("#vectfox_rename_modal").fadeIn(200, function () {
    $("#vectfox_rename_input").focus().select();
  });
}

/**
 * Closes the rename dialog
 */
function closeRenameDialog() {
  $("#vectfox_rename_modal").fadeOut(200);
}

// ============================================================================
// MODEL SWITCHER
// ============================================================================

/**
 * Opens the model switcher modal
 * @param {object} collection Collection object with models array
 */
function openModelSwitcher(collection) {
  // Create modal if it doesn't exist
  if ($("#vectfox_model_switcher_modal").length === 0) {
    const modalHtml = `
            <div id="vectfox_model_switcher_modal" class="vectfox-modal">
                <div class="vectfox-modal-content vectfox-model-switcher-content popup">
                    <div class="vectfox-modal-header">
                        <h3><i class="fa-solid fa-code-branch"></i> Switch Embedding Model</h3>
                        <button class="vectfox-btn-icon" id="vectfox_model_switcher_close">✕</button>
                    </div>
                    <div class="vectfox-modal-body">
                        <p class="vectfox-model-switcher-desc">
                            Select which embedding model to use for this collection.
                            Each model may have different vectors from different embedding providers.
                        </p>
                        <div id="vectfox_model_list" class="vectfox-model-list"></div>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind close
    $("#vectfox_model_switcher_close").on("click", closeModelSwitcher);
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vectfox_model_switcher_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vectfox_model_switcher_modal").on("click", function (e) {
      if (e.target === this) closeModelSwitcher();
    });
  }

  // Store collection reference
  $("#vectfox_model_switcher_modal").data("collection", collection);

  // Build model list
  const modelListHtml = collection.models
    .map((model) => {
      const isActive = model.path === collection.model;
      const modelName = model.name || "(default)";
      const chunkLabel = model.chunkCount === 1 ? "chunk" : "chunks";

      return `
            <div class="vectfox-model-item ${isActive ? "vectfox-model-active" : ""}"
                 data-model-path="${model.path}">
                <div class="vectfox-model-item-info">
                    <span class="vectfox-model-name">
                        ${isActive ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-cube"></i>'}
                        ${modelName}
                    </span>
                    <span class="vectfox-model-chunks">${model.chunkCount} ${chunkLabel}</span>
                </div>
                ${
                  isActive
                    ? '<span class="vectfox-model-badge-current">Current</span>'
                    : '<button class="vectfox-btn-sm vectfox-model-select-btn">Set as Primary</button>'
                }
            </div>
        `;
    })
    .join("");

  $("#vectfox_model_list").html(modelListHtml);

  // Bind selection
  $(".vectfox-model-select-btn")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const modelPath = $(this)
        .closest(".vectfox-model-item")
        .data("model-path");
      const coll = $("#vectfox_model_switcher_modal").data("collection");

      // Update collection
      coll.model = modelPath;
      const modelInfo = coll.models.find((m) => m.path === modelPath);
      if (modelInfo) {
        coll.chunkCount = modelInfo.chunkCount;
      }

      // Persist
      setCollectionMeta(coll.registryKey || coll.id, {
        preferredModel: modelPath,
      });

      toastr.success(
        `Set primary model: ${modelPath || "(default)"}`,
        "VectFox",
      );
      closeModelSwitcher();
      renderCollections();
    });

  // Show
  $("#vectfox_model_switcher_modal").fadeIn(200);
}

/**
 * Closes the model switcher modal
 */
function closeModelSwitcher() {
  $("#vectfox_model_switcher_modal").fadeOut(200);
}

// ============================================================================
// CONDITIONS EDITOR
// ============================================================================

// Collection-level condition types (11 types)
// Note: "keyword" renamed to "pattern" - triggers handle simple keywords,
// this is for advanced regex/pattern matching with custom scan depth
const CONDITION_TYPES = [
  {
    value: "pattern",
    label: "🔍 Pattern Match",
    desc: "Advanced regex/pattern in messages",
  },
  { value: "speaker", label: "🗣️ Speaker", desc: "Match by who spoke last" },
  {
    value: "characterPresent",
    label: "👥 Character Present",
    desc: "Check if character spoke recently",
  },
  {
    value: "messageCount",
    label: "#️⃣ Message Count",
    desc: "Conversation length check",
  },
  { value: "isGroupChat", label: "👪 Group Chat", desc: "Group vs 1-on-1" },
  {
    value: "generationType",
    label: "⚙️ Gen Type",
    desc: "Normal, swipe, continue, etc.",
  },
  {
    value: "lorebookActive",
    label: "📖 Lorebook",
    desc: "Check if lorebook entry active",
  },
  {
    value: "swipeCount",
    label: "👆 Swipe Count",
    desc: "Swipes on last message",
  },
  {
    value: "timeOfDay",
    label: "🕐 Time of Day",
    desc: "Real-world time window",
  },
  {
    value: "randomChance",
    label: "🎲 Random",
    desc: "Probabilistic activation",
  },
];

// ============================================================================
// COLLECTION SETTINGS EDITOR (Activation + Triggers + Conditions + Decay)
// ============================================================================

let activationEditorState = {
  collectionId: null,
  collectionName: null,
  collectionType: "unknown",
  alwaysActive: false,
  triggers: [],
  triggerMatchMode: "any",
  triggerCaseSensitive: false,
  triggerScanDepth: 5,
  conditions: null,
  // Injection settings (position/depth)
  position: null, // null = use global default
  depth: null, // null = use global default
};

/**
 * Opens the collection settings editor
 * @param {string} collectionId Collection ID
 * @param {string} collectionName Display name
 */
function openActivationEditor(collectionId, collectionName) {
  const meta = getCollectionMeta(collectionId);
  const triggerSettings = getCollectionTriggers(collectionId);
  const conditions = getCollectionConditions(collectionId);

  const collectionType =
    meta.scope === "chat" ? "chat" : meta.type || "unknown";

  const currentChatId = getCurrentChatId();
  const currentCharacterId = getContext()?.characterId;
  const resolvedAlwaysActive = isCollectionActiveForContext(collectionId, {
    chatId: currentChatId,
    characterId: currentCharacterId,
  });
  console.log(
    `[VECTFOX DB Browser] Active-for-current-chat resolution for ${collectionId}: ` +
    `resolved=${resolvedAlwaysActive}, scope=${meta.scope}, chatId=${currentChatId || 'none'}, charId=${currentCharacterId ?? 'none'}`
  );

  activationEditorState = {
    collectionId,
    collectionName,
    collectionType,
    alwaysActive: resolvedAlwaysActive,
    triggers: triggerSettings.triggers || [],
    triggerMatchMode: triggerSettings.matchMode || "any",
    triggerCaseSensitive: triggerSettings.caseSensitive || false,
    triggerScanDepth: triggerSettings.scanDepth || 5,
    conditions,
    // Prompt context
    context: meta.context || "",
    xmlTag: meta.xmlTag || "",
    // Injection position/depth (null = use global default)
    position: meta.position ?? null,
    depth: meta.depth ?? null,
  };

  // Create modal if needed
  if ($("#vectfox_activation_editor_modal").length === 0) {
    createActivationEditorModal();
  }

  // Populate with current settings
  renderActivationEditor();

  $("#vectfox_activation_editor_modal").fadeIn(200);
}

/**
 * Closes the activation editor
 */
function closeActivationEditor() {
  $("#vectfox_activation_editor_modal").fadeOut(200);
  activationEditorState.collectionId = null;
}

/**
 * Creates the activation editor modal
 * Primary: Triggers (like lorebook)
 * Secondary: Advanced conditions
 */
function createActivationEditorModal() {
  const modalHtml = `
        <div id="vectfox_activation_editor_modal" class="vectfox-modal">
            <div class="vectfox-activation-editor">
                <div class="vectfox-modal-header">
                                    <h3>⚙️ Collection Settings</h3>
                                    <div style="display:flex; gap:8px; align-items:center;">
                                        <button id="vectfox_activation_lock_collection" class="vectfox-btn-sm" title="Lock this collection to the current chat">🔒 Lock to Chat</button>
                                        <button class="vectfox-btn-icon" id="vectfox_activation_close">✕</button>
                                    </div>
                                </div>

                <div class="vectfox-activation-body">
                    <div class="vectfox-activation-collection-name">
                        Collection: <strong id="vectfox_activation_collection_name"></strong>
                    </div>

                    <!-- Always Active Toggle -->
                    <div class="vectfox-activation-section vectfox-always-active">
                        <label class="vectfox-checkbox-label">
                            <input type="checkbox" id="vectfox_always_active">
                        <strong id="vectfox_always_active_label">Active for current chat</strong>
                        </label>
                      <small id="vectfox_always_active_hint">When enabled, this collection is active for the current chat</small>
                    </div>

                    <!-- ========================================== -->
                    <!-- PRIMARY: ACTIVATION TRIGGERS (Like Lorebook) -->
                    <!-- ========================================== -->
                    <div class="vectfox-activation-section vectfox-triggers-section">
                        <div class="vectfox-section-header">
                            <h4>🎯 Activation Triggers <span class="vectfox-badge-primary">Primary</span></h4>
                            <small>Simple keyword-based activation, like lorebook entries</small>
                        </div>

                        <div class="vectfox-triggers-input">
                            <label>Trigger keywords:</label>
                            <textarea id="vectfox_triggers_input"
                                      placeholder="Enter keywords, one per line or comma-separated.&#10;Supports regex: /pattern/i"
                                      rows="4"></textarea>
                        </div>

                        <div class="vectfox-triggers-options">
                            <div class="vectfox-option-row">
                                <label>Match mode:</label>
                                <select id="vectfox_trigger_match_mode">
                                    <option value="any">ANY trigger matches (OR)</option>
                                    <option value="all">ALL triggers must match (AND)</option>
                                </select>
                            </div>
                            <div class="vectfox-option-row">
                                <label>Scan depth:</label>
                                <input type="number" id="vectfox_trigger_scan_depth" min="1" max="20" value="5">
                                <small>recent messages</small>
                            </div>
                            <div class="vectfox-option-row">
                                <label class="vectfox-checkbox-label">
                                    <input type="checkbox" id="vectfox_trigger_case_sensitive">
                                    Case sensitive
                                </label>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- SECONDARY: ADVANCED CONDITIONS -->
                    <!-- ========================================== -->
                    <div class="vectfox-activation-section vectfox-conditions-section">
                        <div class="vectfox-section-header">
                            <h4>⚡ Advanced Conditions <span class="vectfox-badge-secondary">Secondary</span></h4>
                            <small>Complex rule-based activation (evaluated if triggers don't match or are empty)</small>
                        </div>

                        <!-- Enable toggle -->
                        <div class="vectfox-conditions-toggle">
                            <label class="vectfox-checkbox-label">
                                <input type="checkbox" id="vectfox_conditions_enabled">
                                Enable advanced conditions
                            </label>
                        </div>

                        <!-- Logic selector -->
                        <div class="vectfox-conditions-logic">
                            <label>Condition logic:</label>
                            <select id="vectfox_conditions_logic">
                                <option value="AND">ALL conditions must match (AND)</option>
                                <option value="OR">ANY condition can match (OR)</option>
                            </select>
                        </div>

                        <!-- Rules list -->
                        <div class="vectfox-conditions-rules">
                            <div class="vectfox-conditions-rules-header">
                                <span>Conditions</span>
                                <button class="vectfox-btn-sm" id="vectfox_add_condition">+ Add</button>
                            </div>
                            <div id="vectfox_conditions_list"></div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- PROMPT CONTEXT -->
                    <!-- ========================================== -->
                    <div class="vectfox-activation-section vectfox-context-section">
                        <div class="vectfox-section-header">
                            <h4>💬 Prompt Context</h4>
                            <small>Add context prompts to help the AI understand chunks from this collection</small>
                        </div>

                        <div class="vectfox-context-settings">
                            <div class="vectfox-option-row">
                                <label>Context prompt:</label>
                                <textarea id="vectfox_collection_context"
                                          placeholder="e.g., Things {{char}} remembers about {{user}}:"
                                          rows="2"></textarea>
                                <small>Shown before this collection's chunks. Supports {{user}} and {{char}}.</small>
                            </div>

                            <div class="vectfox-option-row">
                                <label>XML tag (optional):</label>
                                <input type="text" id="vectfox_collection_xml_tag" placeholder="e.g., memories">
                                <small>Wraps this collection's chunks in &lt;tag&gt;...&lt;/tag&gt;</small>
                            </div>

                            <div class="vectfox-option-row vectfox-injection-row">
                                <label>Injection position:</label>
                                <select id="vectfox_collection_position">
                                    <option value="">Use global default</option>
                                    <option value="2">Before Main Prompt</option>
                                    <option value="0">After Main Prompt</option>
                                    <option value="1">In-Chat @ Depth</option>
                                </select>
                                <small>Where this collection's chunks appear in the prompt</small>
                            </div>

                            <div class="vectfox-option-row vectfox-depth-row" id="vectfox_collection_depth_row" style="display: none;">
                                <label>Injection depth: <span id="vectfox_collection_depth_value">2</span></label>
                                <input type="range" id="vectfox_collection_depth" min="0" max="50" step="1" value="2">
                                <small>Messages from end of chat to insert at</small>
                            </div>
                        </div>
                    </div>

                    <!-- Activation Priority Info -->
                    <div class="vectfox-activation-info">
                        <strong>Activation Priority:</strong>
                        <ol>
                            <li><strong>Disabled</strong> → Collection never queries (pause kills all activation)</li>
                            <li><strong>Triggers</strong> → Match keywords in recent messages → activates</li>
                            <li><strong>Advanced Conditions</strong> → Evaluated if triggers empty/don't match → activates</li>
                            <li><strong>Active for current chat / Character lock</strong> → Manual always-on</li>
                            <li><strong>Nothing configured</strong> → Collection does not activate</li>
                        </ol>
                    </div>
                </div>

                <div class="vectfox-modal-footer">
                    <button class="vectfox-btn" id="vectfox_activation_cancel">Cancel</button>
                    <button class="vectfox-btn vectfox-btn-primary" id="vectfox_activation_save">Save</button>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);
  bindActivationEditorEvents();
}

/**
 * Binds event handlers for activation editor
 */
function bindActivationEditorEvents() {
  $("#vectfox_activation_close, #vectfox_activation_cancel").on(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeActivationEditor();
    },
  );

  $("#vectfox_activation_save").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveActivation();
  });

  $("#vectfox_add_condition").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    addConditionRule();
  });

  // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
  $("#vectfox_activation_editor_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close on background click
  $("#vectfox_activation_editor_modal").on("click", function (e) {
    if (e.target === this) closeActivationEditor();
  });

  // Active-for-current-chat toggle (status only, does not disable other settings)
  $("#vectfox_always_active").on("change", function (e) {
    e.stopPropagation();
  });

  // Activation editor: Lock-to-chat button - opens dialog to manage multiple locks
  $("#vectfox_activation_lock_collection").off("click").on("click", async function (e) {
    e.stopPropagation();
    const collId = activationEditorState.collectionId;

    if (!collId) {
      toastr.warning("No collection selected");
      return;
    }

    try {
      openCollectionLockDialog(collId);
    } catch (err) {
      console.error("VectFox: Failed to open lock dialog", err);
      toastr.error("Failed to open lock dialog");
    }
  });

  // Refresh lock button when chat changes
  eventSource.on(event_types.CHAT_CHANGED, () => {
    refreshActivationLockButton();
  });

  // Injection position toggle shows/hides depth row
  $("#vectfox_collection_position").on("change", function (e) {
    e.stopPropagation();
    const position = $(this).val();
    // Show depth row only if "In-Chat @ Depth" (value 1) is selected
    $("#vectfox_collection_depth_row").toggle(position === "1");
  });

  // Injection depth slider updates label
  $("#vectfox_collection_depth").on("input", function (e) {
    e.stopPropagation();
    $("#vectfox_collection_depth_value").text($(this).val());
  });
}

/**
 * Renders the activation editor content
 */
function renderActivationEditor() {
  const state = activationEditorState;

  $("#vectfox_activation_collection_name").text(state.collectionName);
  $("#vectfox_always_active").prop("checked", state.alwaysActive);
  $("#vectfox_always_active").prop("disabled", false);
  $("#vectfox_always_active_label").text("Active for current chat");
  $("#vectfox_always_active_hint").text("When enabled, this collection is active for the current chat");

  // Triggers
  const triggersText = state.triggers.join("\n");
  $("#vectfox_triggers_input").val(triggersText);
  $("#vectfox_trigger_match_mode").val(state.triggerMatchMode);
  $("#vectfox_trigger_scan_depth").val(state.triggerScanDepth);
  $("#vectfox_trigger_case_sensitive").prop(
    "checked",
    state.triggerCaseSensitive,
  );

  // Conditions
  $("#vectfox_conditions_enabled").prop("checked", state.conditions.enabled);
  $("#vectfox_conditions_logic").val(state.conditions.logic || "AND");

  // Prompt Context
  $("#vectfox_collection_context").val(state.context || "");
  $("#vectfox_collection_xml_tag").val(state.xmlTag || "");

  // Injection position/depth
  const posValue = state.position !== null ? String(state.position) : "";
  $("#vectfox_collection_position").val(posValue);
  $("#vectfox_collection_depth").val(state.depth ?? 2);
  $("#vectfox_collection_depth_value").text(state.depth ?? 2);
  // Show depth row only if position is "In-Chat @ Depth" (value 1)
  $("#vectfox_collection_depth_row").toggle(state.position === 1);

  // Keep trigger/condition sections enabled regardless of chat activation toggle.
  $(".vectfox-triggers-section, .vectfox-conditions-section").removeClass("vectfox-disabled");

  // Refresh lock button state for this collection
  refreshActivationLockButton();

  renderConditionRules();
}

/**
 * Refresh the lock button in the activation editor based on current collection and chat
 */
function refreshActivationLockButton() {
  try {
    const collId = activationEditorState.collectionId;
    const $btn = $("#vectfox_activation_lock_collection");
    const chatId = getCurrentChatId();
    const context = getContext();
    const charId = context?.characterId || null;

    if (!$btn || $btn.length === 0) return;

    if (!collId) {
      $btn.prop("disabled", true).text("🔒 Lock to Chat");
      $btn.attr("title", "No collection selected");
      return;
    }

    const chatLockCount = getCollectionLockCount(collId);
    const charLockCount = getCollectionCharacterLockCount(collId);
    const isLockedToCurrentChat = chatId && isCollectionLockedToChat(collId, chatId);
    const isLockedToCurrentChar = charId && isCollectionLockedToCharacter(collId, charId);
    const totalLocks = chatLockCount + charLockCount;

    // Keep the "Active for current chat" checkbox in sync with the lock state that matches
    // the collection's scope. Without this, saveActivation() reads a stale unchecked checkbox
    // and calls removeCollectionLock(), undoing any lock the user just added via the lock dialog.
    const shouldBeActive = isCollectionActiveForContext(collId, { chatId, characterId: charId });
    if (activationEditorState.collectionId) {
      activationEditorState.alwaysActive = shouldBeActive;
      $("#vectfox_always_active").prop("checked", shouldBeActive);
    }

    if (totalLocks === 0) {
      $btn.prop("disabled", false).text("🔒 Manage Locks");
      $btn.attr("title", "No locks set. Click to add locks");
    } else {
      const hasCurrentChatLock = Boolean(isLockedToCurrentChat);
      const lockedStatus = hasCurrentChatLock ? "🔓" : "🔒";
      const lockLabel = `${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      const scopeLabel = hasCurrentChatLock ? "(this chat)" : "(other chat)";
      $btn.prop("disabled", false).text(`${lockedStatus} ${lockLabel} ${scopeLabel}`);

      let tooltip = `Collection has ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      if (chatLockCount > 0) tooltip += ` (${chatLockCount} chat${chatLockCount !== 1 ? "s" : ""})`;
      if (charLockCount > 0) tooltip += ` (${charLockCount} character${charLockCount !== 1 ? "s" : ""})`;
      if (isLockedToCurrentChat || isLockedToCurrentChar) tooltip += " - ACTIVE for current context";

      $btn.attr("title", tooltip);
    }
  } catch (err) {
    console.error("VectFox: Failed to refresh activation lock button", err);
  }
}

/**
 * Saves collection settings (activation + triggers + conditions)
 */
function saveActivation() {
  const state = activationEditorState;

  // Parse triggers from textarea
  const triggersRaw = $("#vectfox_triggers_input").val();
  const triggers = triggersRaw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Get prompt context values (sanitize xml tag)
  const contextPrompt = $("#vectfox_collection_context").val() || "";
  const xmlTagRaw = $("#vectfox_collection_xml_tag").val() || "";
  const xmlTag = xmlTagRaw.replace(/[^a-zA-Z0-9_-]/g, "");

  // Get injection position/depth (empty string = use global default = null)
  const positionRaw = $("#vectfox_collection_position").val();
  const position = positionRaw === "" ? null : parseInt(positionRaw);
  const depth =
    position === 1
      ? parseInt($("#vectfox_collection_depth").val()) || 2
      : null;

  const isChecked = $("#vectfox_always_active").prop("checked");
  const currentChatId = getCurrentChatId();
  const currentCharacterId = getContext()?.characterId;
  const saveMeta = getCollectionMeta(state.collectionId);
  console.log(`[VectFox] saveActivation: checkbox=${isChecked}, scope=${saveMeta.scope}, chatId=${currentChatId || 'none'}, charId=${currentCharacterId ?? 'none'}, collection=${state.collectionId}`);

  // The "Active for current chat" checkbox controls a single lock keyed by the collection's scope.
  //   scope='chat'      → chat lock for currentChatId
  //   scope='character' → character lock for currentCharacterId
  if (saveMeta.scope === 'chat') {
    if (!currentChatId) {
      toastr.info('No active chat context; "Active for current chat" was not changed');
    } else if (isChecked) {
      setCollectionLock(state.collectionId, currentChatId);
    } else {
      removeCollectionLock(state.collectionId, currentChatId);
    }
  } else if (saveMeta.scope === 'character') {
    if (!currentCharacterId) {
      toastr.info('No active character; "Active for current chat" was not changed');
    } else if (isChecked) {
      setCollectionCharacterLock(state.collectionId, String(currentCharacterId));
    } else {
      removeCollectionCharacterLock(state.collectionId, String(currentCharacterId));
    }
  }

  // Update metadata (all in one call)
  setCollectionMeta(state.collectionId, {
    alwaysActive: false,
    triggers: triggers,
    triggerMatchMode: $("#vectfox_trigger_match_mode").val(),
    triggerScanDepth: parseInt($("#vectfox_trigger_scan_depth").val()) || 5,
    triggerCaseSensitive: $("#vectfox_trigger_case_sensitive").prop("checked"),
    context: contextPrompt,
    xmlTag: xmlTag,
    position: position,
    depth: depth,
  });

  // Save conditions
  const conditions = {
    enabled: $("#vectfox_conditions_enabled").prop("checked"),
    logic: $("#vectfox_conditions_logic").val(),
    rules: state.conditions.rules || [],
  };
  setCollectionConditions(state.collectionId, conditions);

  closeActivationEditor();
  renderCollections(); // metadata-only change, no need to re-discover collections
  document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
  toastr.success("Collection settings saved", "VectFox");
}

/**
 * Renders the list of condition rules
 */
function renderConditionRules() {
  const rules = activationEditorState.conditions.rules || [];
  const container = $("#vectfox_conditions_list");

  if (rules.length === 0) {
    container.html(
      '<div class="vectfox-empty-rules">No conditions yet. Click "+ Add Condition" to add one.</div>',
    );
    return;
  }

  const rulesHtml = rules
    .map((rule, idx) => renderConditionRule(rule, idx))
    .join("");
  container.html(rulesHtml);

  // Bind rule events
  bindConditionRuleEvents();
}

/**
 * Renders a single condition rule
 */
function renderConditionRule(rule, index) {
  const typeOptions = CONDITION_TYPES.map(
    (t) =>
      `<option value="${t.value}" ${rule.type === t.value ? "selected" : ""}>${t.label}</option>`,
  ).join("");

  return `
        <div class="vectfox-condition-rule" data-rule-index="${index}">
            <div class="vectfox-condition-row">
                <select class="vectfox-condition-type" data-rule-index="${index}">
                    ${typeOptions}
                </select>
                <label class="vectfox-condition-negate">
                    <input type="checkbox" ${rule.negate ? "checked" : ""} data-rule-index="${index}">
                    NOT
                </label>
                <button class="vectfox-btn-icon vectfox-condition-remove" data-rule-index="${index}">🗑️</button>
            </div>
            <div class="vectfox-condition-settings" data-rule-index="${index}">
                ${renderConditionSettings(rule, index)}
            </div>
        </div>
    `;
}

/**
 * Renders settings for a specific condition type
 */
function renderConditionSettings(rule, index) {
  const settings = rule.settings || {};

  switch (rule.type) {
    case "keyword": // Legacy support
    case "pattern":
      return `
                <div class="vectfox-pattern-condition-wrapper">
                    <div class="vectfox-pattern-row">
                        <textarea class="vectfox-pattern-input" placeholder="Patterns (one per line)&#10;Plain text or regex: /pattern/i"
                                  data-field="patterns" data-rule-index="${index}"
                                  rows="3">${(settings.patterns || settings.values || []).join("\n")}</textarea>
                    </div>
                    <div class="vectfox-pattern-options">
                        <div class="vectfox-option-row">
                            <label>Match mode:</label>
                            <select data-field="matchMode" data-rule-index="${index}">
                                <option value="any" ${settings.matchMode === "any" ? "selected" : ""}>ANY pattern matches</option>
                                <option value="all" ${settings.matchMode === "all" ? "selected" : ""}>ALL patterns must match</option>
                            </select>
                        </div>
                        <div class="vectfox-option-row">
                            <label>Scan depth:</label>
                            <input type="number" data-field="scanDepth" data-rule-index="${index}"
                                   min="1" max="100" value="${settings.scanDepth || 10}">
                            <small>messages</small>
                        </div>
                        <div class="vectfox-option-row">
                            <label>Search in:</label>
                            <select data-field="searchIn" data-rule-index="${index}">
                                <option value="all" ${settings.searchIn === "all" ? "selected" : ""}>All messages</option>
                                <option value="user" ${settings.searchIn === "user" ? "selected" : ""}>User only</option>
                                <option value="assistant" ${settings.searchIn === "assistant" ? "selected" : ""}>Assistant only</option>
                            </select>
                        </div>
                        <div class="vectfox-option-row">
                            <label class="vectfox-checkbox-label">
                                <input type="checkbox" data-field="caseSensitive" data-rule-index="${index}"
                                       ${settings.caseSensitive ? "checked" : ""}>
                                Case sensitive
                            </label>
                        </div>
                    </div>
                </div>
            `;

    case "speaker":
    case "characterPresent":
      return `
                <input type="text" placeholder="Character names (comma-separated)"
                       value="${(settings.values || []).join(", ")}"
                       data-field="values" data-rule-index="${index}">
                <select data-field="matchType" data-rule-index="${index}">
                    <option value="any" ${settings.matchType === "any" ? "selected" : ""}>Any matches</option>
                    <option value="all" ${settings.matchType === "all" ? "selected" : ""}>All must match</option>
                </select>
            `;

    case "messageCount":
    case "swipeCount":
      return `
                <input type="number" placeholder="Count" min="0"
                       value="${settings.count || 0}"
                       data-field="count" data-rule-index="${index}">
                <select data-field="operator" data-rule-index="${index}">
                    <option value="eq" ${settings.operator === "eq" ? "selected" : ""}>Exactly</option>
                    <option value="gte" ${settings.operator === "gte" ? "selected" : ""}>At least</option>
                    <option value="lte" ${settings.operator === "lte" ? "selected" : ""}>At most</option>
                </select>
            `;

    case "isGroupChat":
      return `
                <select data-field="isGroup" data-rule-index="${index}">
                    <option value="true" ${settings.isGroup === true ? "selected" : ""}>Is group chat</option>
                    <option value="false" ${settings.isGroup === false ? "selected" : ""}>Is 1-on-1 chat</option>
                </select>
            `;

    case "generationType":
      const genOptions = VALID_GENERATION_TYPES.map(
        (g) =>
          `<option value="${g}" ${(settings.values || []).includes(g) ? "selected" : ""}>${g}</option>`,
      ).join("");
      return `
                <select multiple data-field="values" data-rule-index="${index}" class="vectfox-multi-select">
                    ${genOptions}
                </select>
            `;

    case "lorebookActive":
      // Get available world names for the picker
      const availableWorlds = world_names || [];
      const worldOptions = availableWorlds
        .map((w) => `<option value="${w}">${w}</option>`)
        .join("");
      const selectedValues = settings.values || [];
      return `
                <div class="vectfox-lorebook-picker-wrapper">
                    <div class="vectfox-lorebook-picker-row">
                        <select class="vectfox-lorebook-select" data-rule-index="${index}">
                            <option value="">-- Select Lorebook --</option>
                            ${worldOptions}
                        </select>
                        <select class="vectfox-lorebook-entry-select" data-rule-index="${index}" disabled>
                            <option value="">-- Select Entry (optional) --</option>
                        </select>
                        <button class="vectfox-btn-sm vectfox-lorebook-add" data-rule-index="${index}" type="button">+ Add</button>
                    </div>
                    <div class="vectfox-lorebook-selected" data-rule-index="${index}">
                        ${selectedValues
                          .map(
                            (v) => `
                            <span class="vectfox-lorebook-tag" data-value="${v}">
                                ${v} <button class="vectfox-lorebook-remove" data-value="${v}" data-rule-index="${index}">×</button>
                            </span>
                        `,
                          )
                          .join("")}
                    </div>
                    <input type="hidden" data-field="values" data-rule-index="${index}" value="${selectedValues.join(",")}">
                </div>
            `;

    case "timeOfDay":
      return `
                <input type="time" value="${settings.startTime || "00:00"}"
                       data-field="startTime" data-rule-index="${index}">
                <span>to</span>
                <input type="time" value="${settings.endTime || "23:59"}"
                       data-field="endTime" data-rule-index="${index}">
            `;

    case "randomChance":
      return `
                <input type="number" placeholder="Probability %" min="0" max="100"
                       value="${settings.probability || 50}"
                       data-field="probability" data-rule-index="${index}">
                <span>%</span>
            `;

    default:
      return '<span class="vectfox-unknown-type">Unknown condition type</span>';
  }
}

/**
 * Binds events for individual condition rules
 */
function bindConditionRuleEvents() {
  // Type change
  $(".vectfox-condition-type")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].type = $(this).val();
      activationEditorState.conditions.rules[idx].settings = {};
      renderConditionRules();
    });

  // Negate toggle
  $(".vectfox-condition-negate input")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].negate =
        $(this).prop("checked");
    });

  // Remove rule
  $(".vectfox-condition-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules.splice(idx, 1);
      renderConditionRules();
    });

  // Settings fields (inputs, selects, and textareas)
  $(
    ".vectfox-condition-settings input, .vectfox-condition-settings select, .vectfox-condition-settings textarea",
  )
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const field = $(this).data("field");
      let value = $(this).val();

      // Handle patterns (textarea, newline-separated)
      if (field === "patterns" && typeof value === "string") {
        value = value
          .split("\n")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle comma-separated values
      if (field === "values" && typeof value === "string") {
        value = value
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle multi-select
      if ($(this).prop("multiple")) {
        value = $(this).val() || [];
      }

      // Handle checkboxes
      if ($(this).attr("type") === "checkbox") {
        value = $(this).prop("checked");
      }

      // Handle booleans from select
      if (field === "isGroup") {
        value = value === "true";
      }

      // Handle numbers
      if (["count", "probability", "scanDepth"].includes(field)) {
        value = parseInt(value) || 0;
      }

      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings[field] = value;
    });

  // Lorebook picker: world select change - load entries
  $(".vectfox-lorebook-select")
    .off("change")
    .on("change", async function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldName = $(this).val();
      const entrySelect = $(
        `.vectfox-lorebook-entry-select[data-rule-index="${idx}"]`,
      );

      if (!worldName) {
        entrySelect
          .prop("disabled", true)
          .html('<option value="">-- Select Entry (optional) --</option>');
        return;
      }

      // Load world info entries
      entrySelect
        .prop("disabled", true)
        .html('<option value="">Loading...</option>');
      try {
        const worldData = await loadWorldInfo(worldName);
        if (worldData && worldData.entries) {
          const entries = Object.values(worldData.entries);
          const entryOptions = entries
            .map((entry) => {
              const displayName =
                entry.comment || entry.key?.join(", ") || `Entry ${entry.uid}`;
              return `<option value="${entry.uid}" data-key="${entry.key?.join(",") || ""}">${displayName}</option>`;
            })
            .join("");
          entrySelect.html(
            `<option value="">-- Entire Lorebook --</option>${entryOptions}`,
          );
          entrySelect.prop("disabled", false);
        }
      } catch (error) {
        console.error("VectFox: Failed to load world info", error);
        entrySelect.html(
          '<option value="">-- Error loading entries --</option>',
        );
      }
    });

  // Lorebook picker: add button
  $(".vectfox-lorebook-add")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldSelect = $(
        `.vectfox-lorebook-select[data-rule-index="${idx}"]`,
      );
      const entrySelect = $(
        `.vectfox-lorebook-entry-select[data-rule-index="${idx}"]`,
      );
      const selectedContainer = $(
        `.vectfox-lorebook-selected[data-rule-index="${idx}"]`,
      );
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      const worldName = worldSelect.val();
      if (!worldName) {
        toastr.warning("Please select a lorebook first", "VectFox");
        return;
      }

      const entryUid = entrySelect.val();
      let valueToAdd;

      if (entryUid) {
        // Specific entry: use "worldName:uid" format
        valueToAdd = `${worldName}:${entryUid}`;
      } else {
        // Entire lorebook
        valueToAdd = worldName;
      }

      // Get current values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v)
        : [];
      if (currentValues.includes(valueToAdd)) {
        toastr.info("Already added", "VectFox");
        return;
      }

      currentValues.push(valueToAdd);
      hiddenInput.val(currentValues.join(","));

      // Update the visual tags
      const displayName = entryUid
        ? `${worldName}:${entrySelect.find(":selected").text()}`
        : worldName;
      selectedContainer.append(`
            <span class="vectfox-lorebook-tag" data-value="${valueToAdd}">
                ${displayName} <button class="vectfox-lorebook-remove" data-value="${valueToAdd}" data-rule-index="${idx}">×</button>
            </span>
        `);

      // Update state
      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings.values =
        currentValues;

      // Rebind remove buttons
      bindLorebookRemoveButtons();

      // Reset selects
      worldSelect.val("");
      entrySelect
        .prop("disabled", true)
        .html('<option value="">-- Select Entry (optional) --</option>');
    });

  // Bind remove buttons
  bindLorebookRemoveButtons();
}

/**
 * Binds lorebook tag remove buttons
 */
function bindLorebookRemoveButtons() {
  $(".vectfox-lorebook-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const valueToRemove = $(this).data("value");
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      // Remove from values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v && v !== valueToRemove)
        : [];
      hiddenInput.val(currentValues.join(","));

      // Update state
      if (activationEditorState.conditions.rules[idx]?.settings) {
        activationEditorState.conditions.rules[idx].settings.values =
          currentValues;
      }

      // Remove the tag
      $(this).closest(".vectfox-lorebook-tag").remove();
    });
}

/**
 * Adds a new condition rule
 */
function addConditionRule() {
  if (!activationEditorState.conditions.rules) {
    activationEditorState.conditions.rules = [];
  }

  activationEditorState.conditions.rules.push({
    type: "pattern",
    negate: false,
    settings: {},
  });

  renderConditionRules();
}

// ============================================================================
// SEARCH TAB FUNCTIONS
// ============================================================================

/**
 * Binds search tab events
 */
function bindSearchEvents() {
  if (searchEventsBound) return;
  searchEventsBound = true;

  // Search button click
  $("#vectfox_search_btn").off("click").on("click", performSearch);

  // Enter key in search input
  $("#vectfox_semantic_search")
    .off("keydown")
    .on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });

  // Keyword filter events
  $("#vectfox_scan_keywords").off("click").on("click", scanKeywords);
  $("#vectfox_clear_keyword_filter").off("click").on("click", clearKeywordFilter);
  $("#vectfox_keyword_filter").off("input").on("input", updateKeywordFilterFromInput);
}

/**
 * Scans all collections for keywords
 */
async function scanKeywords() {
  const $btn = $("#vectfox_scan_keywords");
  const $tags = $("#vectfox_keyword_tags");

  $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
  $tags.html('<span class="vectfox-keyword-hint">Scanning collections...</span>');

  try {
    const enabledOnly = $("#vectfox_search_enabled_only").is(":checked");
    let collectionsToScan = browserState.collections;

    if (enabledOnly) {
      collectionsToScan = collectionsToScan.filter(c => c.enabled);
    }

    const keywordCounts = new Map();

    for (const collection of collectionsToScan) {
      try {
        const response = await fetch("/api/plugins/similharity/chunks/list", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 500,
          }),
        });

        if (!response.ok) continue;

        const data = await response.json();
        const items = data.items || [];

        for (const item of items) {
          const keywords = item.metadata?.keywords || item.keywords || [];
          for (const kw of keywords) {
            const text = (typeof kw === 'object' ? kw.text : kw)?.toLowerCase();
            if (text) {
              keywordCounts.set(text, (keywordCounts.get(text) || 0) + 1);
            }
          }
        }
      } catch (err) {
        console.warn(`VectFox: Failed to scan keywords from ${collection.id}:`, err);
      }
    }

    // Sort by count and store
    browserState.availableKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => ({ text, count }));

    renderKeywordTags();

    if (browserState.availableKeywords.length === 0) {
      $tags.html('<span class="vectfox-keyword-hint">No keywords found in scanned collections</span>');
    } else {
      toastr.success(`Found ${browserState.availableKeywords.length} unique keywords`, "VectFox");
    }
  } catch (error) {
    console.error("VectFox: Keyword scan failed", error);
    $tags.html('<span class="vectfox-keyword-hint vectfox-error">Scan failed</span>');
    toastr.error("Failed to scan keywords", "VectFox");
  } finally {
    $btn.prop("disabled", false).html('<i class="fa-solid fa-sync"></i> Scan');
  }
}

/**
 * Renders clickable keyword tags
 */
function renderKeywordTags() {
  const $tags = $("#vectfox_keyword_tags");
  const keywords = browserState.availableKeywords;

  if (keywords.length === 0) {
    $tags.html('<span class="vectfox-keyword-hint">No keywords available</span>');
    return;
  }

  // Show top 30 keywords with counts
  const displayKeywords = keywords.slice(0, 30);
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

  let html = displayKeywords.map(kw => {
    const isActive = currentFilter.includes(kw.text);
    return `<span class="vectfox-keyword-tag ${isActive ? 'active' : ''}"
                  data-keyword="${StringUtils.escapeHtml(kw.text)}"
                  title="${kw.count} occurrence(s)">
              ${StringUtils.escapeHtml(kw.text)} <small>(${kw.count})</small>
            </span>`;
  }).join('');

  if (keywords.length > 30) {
    html += `<span class="vectfox-keyword-more">+${keywords.length - 30} more</span>`;
  }

  $tags.html(html);

  // Bind click events on tags
  $tags.find(".vectfox-keyword-tag").off("click").on("click", function() {
    const keyword = $(this).data("keyword");
    toggleKeywordFilter(keyword);
  });
}

/**
 * Toggles a keyword in the filter
 */
function toggleKeywordFilter(keyword) {
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  const idx = currentFilter.indexOf(keyword.toLowerCase());

  if (idx >= 0) {
    currentFilter.splice(idx, 1);
  } else {
    currentFilter.push(keyword.toLowerCase());
  }

  browserState.keywordFilter = currentFilter.join(', ');
  $("#vectfox_keyword_filter").val(browserState.keywordFilter);
  renderKeywordTags();
}

/**
 * Clears the keyword filter
 */
function clearKeywordFilter() {
  browserState.keywordFilter = '';
  $("#vectfox_keyword_filter").val('');
  renderKeywordTags();
}

/**
 * Updates keyword filter from input field
 */
function updateKeywordFilterFromInput() {
  browserState.keywordFilter = $("#vectfox_keyword_filter").val();
  renderKeywordTags();
}

/**
 * Filters search results by keywords
 * @param {object} results Search results by collection
 * @returns {object} Filtered results
 */
function filterResultsByKeywords(results) {
  const filterKeywords = browserState.keywordFilter.toLowerCase()
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (filterKeywords.length === 0) {
    return results;
  }

  const filtered = {};

  for (const [collectionId, collectionResults] of Object.entries(results)) {
    if (!collectionResults?.hashes?.length) continue;

    const filteredHashes = [];
    const filteredMetadata = [];

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const chunkKeywords = (metadata.keywords || []).map(kw =>
        (typeof kw === 'object' ? kw.text : kw)?.toLowerCase()
      ).filter(Boolean);

      // Check if chunk has ANY of the filter keywords
      const hasMatch = filterKeywords.some(fk => chunkKeywords.includes(fk));

      if (hasMatch) {
        filteredHashes.push(collectionResults.hashes[i]);
        filteredMetadata.push(metadata);
      }
    }

    if (filteredHashes.length > 0) {
      filtered[collectionId] = {
        hashes: filteredHashes,
        metadata: filteredMetadata
      };
    }
  }

  return filtered;
}

/**
 * Performs semantic search across collections
 */
async function performSearch() {
  const query = $("#vectfox_semantic_search").val().trim();
  if (!query) {
    toastr.warning("Please enter a search query", "VectFox");
    return;
  }

  const topK = parseInt($("#vectfox_search_topk").val()) || 5;
  const threshold = parseFloat($("#vectfox_search_threshold").val()) || 0.3;
  const enabledOnly = $("#vectfox_search_enabled_only").is(":checked");

  // Get collection IDs to search
  let collectionIds = browserState.collections.map((c) => c.id);

  // Defense-in-depth: even though browserState.collections is already filtered by
  // creatorHandle metadata, also drop any persona-scoped collection whose embedded
  // handle in the *name itself* doesn't match the current persona. This guards
  // against foreign collections that leaked through (missing/stale metadata, etc.)
  // and prevents the search from ever hitting another user's collection.
  //
  // SUPERADMIN MODE bypass — when `settings.superadmin === true`, skip this gate
  // too so the search can reach foreign collections that the user wants to query.
  if (browserState.settings?.superadmin !== true) {
    const ownHandle = _sanitizeHandleForFilter(getContext()?.name1);
    collectionIds = collectionIds.filter((id) => {
      const handle = _extractHandleFromCollectionId(id);
      if (handle === null) return true; // not persona-scoped (e.g. legacy file_*)
      return handle === ownHandle;
    });
  }

  if (enabledOnly) {
    collectionIds = collectionIds.filter((id) => {
      const collection = browserState.collections.find((c) => c.id === id);
      return collection && collection.enabled;
    });
  }

  if (collectionIds.length === 0) {
    $("#vectfox_search_results").html(`
            <div class="vectfox-search-empty">
                ${icons.search(48)}
                <p>No collections available to search</p>
            </div>
        `);
    return;
  }

  // Show loading state
  browserState.isSearching = true;
  $("#vectfox_search_btn")
    .prop("disabled", true)
    .html(`${icons.search(16)} Searching...`);
  $("#vectfox_search_results").html(`
        <div class="vectfox-search-loading">
            <i class="fa-solid fa-spinner fa-spin"></i> Searching ${collectionIds.length} collections...
        </div>
    `);

  try {
    const results = await queryMultipleCollections(
      collectionIds,
      query,
      topK,
      threshold,
      browserState.settings,
    );

    browserState.searchResults = results;

    // Apply keyword filter if set
    const filteredResults = filterResultsByKeywords(results);
    renderSearchResults(filteredResults, query, results);
  } catch (error) {
    console.error("VectFox: Search failed", error);
    $("#vectfox_search_results").html(`
            <div class="vectfox-search-error">
                ${icons.x(24)} Search failed: ${error.message}
            </div>
        `);
  } finally {
    browserState.isSearching = false;
    $("#vectfox_search_btn")
      .prop("disabled", false)
      .html(`${icons.search(16)} Search`);
  }
}

/**
 * Renders search results
 * @param {object} results Results from queryMultipleCollections (possibly filtered)
 * @param {string} query Original search query
 * @param {object} originalResults Original unfiltered results (for showing filter info)
 */
function renderSearchResults(results, query, originalResults = null) {
  const collectionIds = Object.keys(results);
  const totalResults = collectionIds.reduce(
    (sum, id) => sum + (results[id]?.hashes?.length || 0),
    0,
  );

  // Calculate original counts if keyword filter was applied
  const wasFiltered = originalResults && browserState.keywordFilter.trim();
  const originalTotal = originalResults
    ? Object.keys(originalResults).reduce((sum, id) => sum + (originalResults[id]?.hashes?.length || 0), 0)
    : totalResults;

  if (totalResults === 0) {
    const filterMsg = wasFiltered
      ? `<p>No results match keyword filter: "${StringUtils.escapeHtml(browserState.keywordFilter)}"</p><small>${originalTotal} result(s) found before filtering</small>`
      : `<p>No results found for "${StringUtils.escapeHtml(query)}"</p><small>Try adjusting the score threshold or search in more collections</small>`;

    $("#vectfox_search_results").html(`
            <div class="vectfox-search-empty">
                ${icons.search(48)}
                ${filterMsg}
            </div>
        `);
    return;
  }

  let summaryHtml = `<div class="vectfox-search-summary">Found ${totalResults} result(s) in ${collectionIds.length} collection(s)`;
  if (wasFiltered) {
    summaryHtml += ` <span class="vectfox-filter-badge" title="Keyword filter active">🏷️ filtered from ${originalTotal}</span>`;
  }
  summaryHtml += `</div>`;

  let html = summaryHtml;

  for (const collectionId of collectionIds) {
    const collectionResults = results[collectionId];
    if (!collectionResults?.hashes?.length) continue;

    const collection = browserState.collections.find(
      (c) => c.id === collectionId,
    );
    const collectionName = collection?.name || collectionId;
    // Use registryKey for unique identification (source:id format)
    const uniqueKey = collection.registryKey || collection.id;

    html += `
            <div class="vectfox-search-collection">
                <div class="vectfox-search-collection-header">
                    ${icons.folder(16)} ${StringUtils.escapeHtml(collectionName)}
                    <span class="vectfox-search-count">${collectionResults.hashes.length} result(s)</span>
                </div>
                <div class="vectfox-search-collection-results">
        `;

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const score =
        metadata.score !== undefined ? (metadata.score * 100).toFixed(1) : "?";
      const text = metadata.text || `[Hash: ${collectionResults.hashes[i]}]`;
      const preview = text.length > 200 ? text.substring(0, 200) + "..." : text;

      // Build score breakdown for hybrid search results
      const vectorScore = metadata.vectorScore !== undefined ? (metadata.vectorScore * 100).toFixed(0) : null;
      const textScore = metadata.textScore !== undefined ? (metadata.textScore * 100).toFixed(0) : null;
      const isHybrid = metadata.hybridSearch || (vectorScore !== null && textScore !== null);

      let scoreDisplay = `<div class="vectfox-search-result-score">${score}%</div>`;
      if (isHybrid) {
        scoreDisplay = `
          <div class="vectfox-search-result-score-hybrid">
            <div class="vectfox-score-main">${score}%</div>
            <div class="vectfox-score-breakdown">
              <span class="vectfox-score-vector" title="Semantic similarity">🔷${vectorScore || '?'}%</span>
              <span class="vectfox-score-text" title="Keyword match">📝${textScore || '0'}%</span>
            </div>
          </div>`;
      }

      // Build keywords display
      const chunkKeywords = metadata.keywords || [];
      let keywordsHtml = '';
      if (chunkKeywords.length > 0) {
        const keywordTags = chunkKeywords.slice(0, 5).map(kw => {
          const text = typeof kw === 'object' ? kw.text : kw;
          return `<span class="vectfox-result-keyword">${StringUtils.escapeHtml(text)}</span>`;
        }).join('');
        const moreCount = chunkKeywords.length > 5 ? `<span class="vectfox-result-keyword-more">+${chunkKeywords.length - 5}</span>` : '';
        keywordsHtml = `<div class="vectfox-result-keywords">${keywordTags}${moreCount}</div>`;
      }

      html += `
                <div class="vectfox-search-result" data-collection="${StringUtils.escapeHtml(collectionId)}" data-hash="${collectionResults.hashes[i]}">
                    ${scoreDisplay}
                    <div class="vectfox-search-result-content">
                        <div class="vectfox-search-result-text">${StringUtils.escapeHtml(preview)}</div>
                        ${keywordsHtml}
                    </div>
                </div>

                <button class="vectfox-btn-sm vectfox-action-visualize"
                        data-collection-key="${StringUtils.escapeHtml(uniqueKey)}"
                        data-backend="${StringUtils.escapeHtml(collection.backend)}"
                        data-source="${StringUtils.escapeHtml(collection.source || "transformers")}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
            `;
    }

    html += `</div></div>`;
  }

  $("#vectfox_search_results").html(html);
  $(".vectfox-action-visualize")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;
      await openChunkVisualizer(collection);
    });
}

// ============================================================================
// BULK OPERATIONS TAB FUNCTIONS
// ============================================================================

/**
 * Renders bulk operations list
 */
function renderBulkList() {
  const filter = browserState.bulkFilter;
  let collections = [...browserState.collections];

  // Apply filter
  if (filter === "enabled") {
    collections = collections.filter((c) => c.enabled);
  } else if (filter === "disabled") {
    collections = collections.filter((c) => !c.enabled);
  }

  if (collections.length === 0) {
    $("#vectfox_bulk_list").html(`
            <div class="vectfox-bulk-empty">
                ${icons.folder(48)}
                <p>No collections match the current filter</p>
            </div>
        `);
    return;
  }

  let html = "";
  for (const collection of collections) {
    const uniqueKey = collection.registryKey || collection.id;
    const isSelected = browserState.bulkSelected.has(uniqueKey);
    const safeKey = StringUtils.escapeHtml(uniqueKey);

    html += `
            <div class="vectfox-bulk-item ${isSelected ? "selected" : ""}" data-key="${safeKey}">
                <label class="vectfox-bulk-checkbox">
                    <input type="checkbox" ${isSelected ? "checked" : ""} data-key="${safeKey}">
                </label>
                <div class="vectfox-bulk-item-info">
                    <span class="vectfox-bulk-item-name">${StringUtils.escapeHtml(collection.name || collection.id)}</span>
                    <span class="vectfox-bulk-item-meta">
                        ${collection.chunkCount || 0} chunks •
                        ${collection.enabled ? `${icons.toggleRight(12)} Enabled` : `${icons.toggleLeft(12)} Disabled`}
                    </span>
                </div>
            </div>
        `;
  }

  $("#vectfox_bulk_list").html(html);
  updateBulkCount();
}

/**
 * Binds bulk operations events
 */
function bindBulkEvents() {
  if (bulkEventsBound) return;
  bulkEventsBound = true;

  // Filter change
  $("#vectfox_bulk_filter")
    .off("change")
    .on("change", function () {
      browserState.bulkFilter = $(this).val();
      browserState.bulkSelected.clear();
      renderBulkList();
    });

  // Select all checkbox
  $("#vectfox_bulk_select_all")
    .off("change")
    .on("change", function () {
      const isChecked = $(this).is(":checked");
      const filter = browserState.bulkFilter;
      let collections = [...browserState.collections];

      if (filter === "enabled") {
        collections = collections.filter((c) => c.enabled);
      } else if (filter === "disabled") {
        collections = collections.filter((c) => !c.enabled);
      }

      browserState.bulkSelected.clear();
      if (isChecked) {
        collections.forEach((c) =>
          browserState.bulkSelected.add(c.registryKey || c.id),
        );
      }

      renderBulkList();
    });

  // Individual checkbox clicks (delegated)
  $("#vectfox_bulk_list")
    .off("change", 'input[type="checkbox"]')
    .on("change", 'input[type="checkbox"]', function () {
      const key = $(this).data("key");
      if ($(this).is(":checked")) {
        browserState.bulkSelected.add(key);
      } else {
        browserState.bulkSelected.delete(key);
      }
      updateBulkCount();
      $(this)
        .closest(".vectfox-bulk-item")
        .toggleClass("selected", $(this).is(":checked"));
    });

  // Bulk enable
  $("#vectfox_bulk_enable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, true);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = true;
      }

      toastr.success(
        `Enabled ${browserState.bulkSelected.size} collection(s)`,
        "VectFox",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk disable
  $("#vectfox_bulk_disable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, false);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = false;
      }

      toastr.success(
        `Disabled ${browserState.bulkSelected.size} collection(s)`,
        "VectFox",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk export
  $("#vectfox_bulk_export")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `Export ${browserState.bulkSelected.size} collection(s)?\n\nEach collection will be downloaded as a separate file.`,
      );
      if (!confirmed) return;

      toastr.info(
        `Exporting ${browserState.bulkSelected.size} collection(s)...`,
        "VectFox",
      );

      let successCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const exportData = await exportCollection(
            collection.id,
            browserState.settings,
            {
              backend: collection.backend,
              source: collection.source || "transformers",
              model: collection.model || "",
            },
          );

          downloadExport(exportData, collection.name || collection.id);
          successCount++;
        } catch (error) {
          console.error(`VectFox: Failed to export ${collection.id}`, error);
        }
      }

      toastr.success(`Exported ${successCount} collection(s)`, "VectFox");
    });

  // Bulk delete - uses unified deleteCollection()
  $("#vectfox_bulk_delete")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `⚠️ DELETE ${browserState.bulkSelected.size} COLLECTION(S)?\n\n` +
          `This will permanently delete all vectors in these collections.\n` +
          `This action CANNOT be undone!\n\n` +
          `Type "DELETE" to confirm.`,
      );

      if (!confirmed) return;

      const confirmText = prompt("Type DELETE to confirm:");
      if (confirmText !== "DELETE") {
        toastr.info("Deletion cancelled", "VectFox");
        return;
      }

      toastr.info(
        `Deleting ${browserState.bulkSelected.size} collection(s)...`,
        "VectFox",
      );

      let successCount = 0;
      let partialCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const collectionSettings = {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
            _discoveredModels: collection.models,
          };
          const result = await deleteCollection(
            collection.id,
            collectionSettings,
            collection.registryKey,
          );
          if (result.success) {
            successCount++;
          } else {
            partialCount++;
          }
        } catch (error) {
          console.error(`VectFox: Failed to delete ${collection.id}`, error);
        }
      }

      browserState.bulkSelected.clear();
      await refreshCollections();
      renderBulkList();

      if (partialCount > 0) {
        toastr.warning(
          `Deleted ${successCount}, partial: ${partialCount}`,
          "VectFox",
        );
      } else {
        toastr.success(`Deleted ${successCount} collection(s)`, "VectFox");
      }
    });
}

/**
 * Updates bulk selection count and button states
 */
function updateBulkCount() {
  const count = browserState.bulkSelected.size;
  $("#vectfox_bulk_count").text(`${count} selected`);

  // Enable/disable buttons based on selection
  const hasSelection = count > 0;
  $(
    "#vectfox_bulk_enable, #vectfox_bulk_disable, #vectfox_bulk_export, #vectfox_bulk_delete",
  ).prop("disabled", !hasSelection);
}

// ============================================================================
// COLLECTION LOCK MANAGEMENT DIALOG
// ============================================================================

/**
 * Opens a dialog to manage locks for a collection (add/remove multiple chats)
 * @param {string} collectionId
 */
function openCollectionLockDialog(collectionId) {
    const locks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const currentChatId = getCurrentChatId();
    const context = getContext();
    const currentCharacterId = context?.characterId || null;
    const characters = context?.characters || [];

    // Build HTML for locked chats
    const locksHtml = locks.length === 0
        ? '<div class="vectfox-lock-list-empty">No chats locked yet</div>'
        : locks.map((chatId) => `
            <div class="vectfox-lock-item" data-chat-id="${chatId}">
                <span class="vectfox-lock-chat-id" title="${chatId}">${chatId}</span>
                <div class="vectfox-lock-item-actions">
                    ${String(chatId) === String(currentChatId) ? '<span class="vectfox-lock-badge-current">Current</span>' : ''}
                    <button class="vectfox-lock-remove-btn" data-chat-id="${chatId}" title="Remove lock">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');

    // Build HTML for locked characters
    const charLocksHtml = characterLocks.length === 0
        ? '<div class="vectfox-lock-list-empty">No characters locked yet</div>'
        : characterLocks.map((charId) => {
            const charName = characters[charId]?.data?.name || `Character ${charId}`;
            return `
                <div class="vectfox-lock-item" data-character-id="${charId}">
                    <span class="vectfox-lock-character-name">
                        <i class="fa-solid fa-user"></i>
                        ${charName}
                    </span>
                    <div class="vectfox-lock-item-actions">
                        ${String(charId) === String(currentCharacterId) ? '<span class="vectfox-lock-badge-current">Active</span>' : ''}
                        <button class="vectfox-lock-remove-char-btn" data-character-id="${charId}" title="Remove lock">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    // Generate hint text for chat section
    const chatHintClass = currentChatId && locks.includes(currentChatId) ? 'vectfox-lock-hint vectfox-lock-hint-success' : 'vectfox-lock-hint';
    const chatHintText = currentChatId
        ? locks.includes(currentChatId)
            ? '✓ Already locked to this chat'
            : 'Lock this collection to the current chat'
        : 'Open a chat first to lock this collection';

    // Generate hint text for character section
    const charHintClass = currentCharacterId && characterLocks.includes(currentCharacterId) ? 'vectfox-lock-hint vectfox-lock-hint-success' : 'vectfox-lock-hint';
    const charHintText = currentCharacterId
        ? characterLocks.includes(currentCharacterId)
            ? '✓ Already locked to this character'
            : 'Lock this collection to the current character'
        : 'No character currently active';

    const dialogHtml = `
        <div id="vectfox_lock_dialog" class="vectfox-modal" style="display: flex;">
            <div class="vectfox-modal-content vectfox-lock-dialog">
                <div class="vectfox-modal-header">
                    <h3><i class="fa-solid fa-lock"></i> Manage Collection Locks</h3>
                    <button class="vectfox-modal-close" data-action="close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vectfox-modal-body">
                    <!-- Chat Locks Section -->
                    <div class="vectfox-lock-section">
                        <h4><i class="fa-solid fa-comments"></i> Chat Locks <span class="vectfox-badge vectfox-badge-muted">${locks.length}</span></h4>
                        <div class="vectfox-lock-list">
                            ${locksHtml}
                        </div>
                        <p class="${chatHintClass}">${chatHintText}</p>
                        <button id="vectfox_lock_add_current" class="vectfox-btn-sm vectfox-btn-primary" ${!currentChatId || locks.includes(currentChatId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Chat
                        </button>
                    </div>

                    <hr class="vectfox-lock-divider">

                    <!-- Character Locks Section -->
                    <div class="vectfox-lock-section">
                        <h4><i class="fa-solid fa-user"></i> Character Locks <span class="vectfox-badge vectfox-badge-muted">${characterLocks.length}</span></h4>
                        <div class="vectfox-lock-list">
                            ${charLocksHtml}
                        </div>
                        <p class="${charHintClass}">${charHintText}</p>
                        <button id="vectfox_lock_add_character" class="vectfox-btn-sm vectfox-btn-primary" ${!currentCharacterId || characterLocks.includes(currentCharacterId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Character
                        </button>
                    </div>
                </div>
                <div class="vectfox-modal-footer">
                    <button class="vectfox-btn" data-action="close">
                        <i class="fa-solid fa-check"></i> Done
                    </button>
                </div>
            </div>
        </div>
    `;

    const $dialog = $(dialogHtml);
    $('body').append($dialog);

    // Handle add lock button (chat)
    $('#vectfox_lock_add_current').on('click', function() {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('Open a chat first');
            return;
        }

        setCollectionLock(collectionId, chatId);
        toastr.success('Collection locked to current chat', 'VectFox');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle add lock button (character)
    $('#vectfox_lock_add_character').on('click', function() {
        const context = getContext();
        const charId = context?.characterId;
        if (!charId) {
            toastr.warning('No character currently active');
            return;
        }

        setCollectionCharacterLock(collectionId, charId);
        toastr.success('Collection locked to current character', 'VectFox');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (chat)
    $dialog.find('.vectfox-lock-remove-btn').on('click', function(e) {
        e.stopPropagation();
        const chatId = $(this).data('chat-id');

        removeCollectionLock(collectionId, chatId);
        toastr.info('Removed lock from chat', 'VectFox');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (character)
    $dialog.find('.vectfox-lock-remove-char-btn').on('click', function(e) {
        e.stopPropagation();
        const charId = $(this).data('character-id');

        removeCollectionCharacterLock(collectionId, charId);
        toastr.info('Removed lock from character', 'VectFox');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle close button
    $dialog.find('[data-action="close"]').on('click', function(e) {
        e.preventDefault();
        $dialog.remove();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $dialog.on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // Close on background click
    $dialog.on('click', function(e) {
        if (e.target === this) {
            $dialog.remove();
        }
    });

    // Handle escape key
    $(document).one('keydown.lock_dialog', function(e) {
        if (e.key === 'Escape') {
            $dialog.remove();
        }
    });
}


