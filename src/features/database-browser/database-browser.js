/**
 * ============================================================================
 * VECTFOX DATABASE BROWSER
 * ============================================================================
 * Browses and manages every vector collection, in three pages: Collections (the
 * filters, the list with each collection's actions, and bulk actions on the
 * ticked ones), Search (a search across collections with a keyword filter) and
 * Size Inspector (size-inspector.js). The browser opens in a near-fullscreen dialog of its
 * own (sillytavern/popup.js openPanelPopup), drawn fresh on each open from
 * database-browser-markup.js, and its handlers are delegated on its root. Rename,
 * Switch model, Collection Settings and Manage locks open their own modals on
 * that dialog, and Escape closes only those while one is open.
 *
 * @author Kritblade
 * ============================================================================
 */

import {
  loadAllCollections,
  clearCollectionRegistry,
  deleteCollection,
  sanitizeHandleId,
  getCollectionListing,
  cleanupOrphanedMeta,
  getCollectionConditions,
  setCollectionConditions,
  getCollectionTriggers,
  getCollectionMeta,
  setCollectionMeta,
  getCollectionActivationSummary,
  setCollectionEnabled,
  getCollectionLocks,
  setCollectionLock,
  removeCollectionLock,
  isCollectionLockedToChat,
  getCollectionLockCount,
  getCollectionCharacterLocks,
  setCollectionCharacterLock,
  removeCollectionCharacterLock,
  isCollectionLockedToCharacter,
  getCollectionCharacterLockCount,
  isCollectionActiveForContext,
  VALID_GENERATION_TYPES,
  exportCollection,
  importCollection,
  downloadExport,
  readImportFile,
  validateImportData,
  getExportInfo,
  MAX_IMPORT_FILE_BYTES,
  embedDataInPNG,
  extractDataFromPNG,
  downloadPNG,
  readPNGFile,
  convertToPNG,
} from "../collections/index.js";
import { checkPluginAvailable } from "../../shared/similharity-plugin.js";
import { confirmPopup, openPanelPopup, placeMarkupOnTopmostModalLayer, placeOnTopmostModalLayer } from "../../sillytavern/popup.js";
import { isModalOpenOnDialogOf } from "../../sillytavern/popup-core.js";
import { pickFiles } from "../../shared/pick-files.js";
import { bindGeneBehaviours, scrollPageToTop, setCollapsed } from "../../shared/gui-dna/gene-behaviours.js";
import { COLLECTION_PREFIXES } from "../../shared/collection-ids.js";
import {
  STORY_LINKS_FILE_TYPE,
  buildCollectionLinksFile,
  deleteStoryLinks,
  describeStoryLinkCoverage,
  describeStoryLinksImport,
  planStoryLinksDelete,
  planStoryLinksImport,
  readCollectionLinkCoverage,
  writeImportedStoryLinks,
} from "../eventbase/index.js";
import {
  queryMultipleCollections,
} from "../vector-backend/index.js";
import { getRequestHeaders } from "../../sillytavern/requests.js";
import { getCurrentChatId, getContext } from "../../sillytavern/chat.js";
import { eventSource, event_types } from "../../sillytavern/events.js";
import { world_names, loadWorldInfo } from "../../sillytavern/world-info.js";
import { log } from "../../sillytavern/log.js";
import { openVisualizer } from "./chunk-visualizer.js";
import { bindSizeInspector } from "./size-inspector.js";
import { formatBytes, utf8ByteLength } from "../../shared/byte-size.js";
import {
  BROWSER_PAGES,
  browserPageId,
  browserTabId,
  collectionEntryMarkup,
  collectionsFailedMarkup,
  databaseBrowserMarkup,
  keywordScanFailedMarkup,
  keywordScanRunningMarkup,
  keywordTagsMarkup,
  noCollectionsMarkup,
  nothingToSearchMarkup,
  searchFailedMarkup,
  searchResultsMarkup,
  searchRunningMarkup,
  storyLinksRowMarkup,
} from "./database-browser-markup.js";

const DEFAULT_FILTERS = Object.freeze({
  scope: "all", // 'all', 'character', 'chat': collections locked to at least one of these
  collectionType: "all", // 'all', 'chat', 'lorebook', 'character', 'document', 'web'
  status: "all", // 'all', 'enabled', 'disabled'
  searchQuery: "",
  onlyActiveForChat: false, // only collections active for the current chat (the Active here pill)
});

const browserState = {
  isOpen: false,
  pluginAvailable: null,
  collections: [],
  filters: { ...DEFAULT_FILTERS },
  settings: null,
  // The ticked collections' keys. A filter change drops the ones it hides, so a bulk action never reaches a hidden one.
  bulkSelected: new Set(),
  // The keys the list shows now, which "Select all shown" ticks
  shownKeys: [],
  keywordFilter: "",
  // The keywords the last scan found, the most common first; null before a scan
  availableKeywords: null,
  // Each StoryArc links row's read of its collection, by collection key, so a redraw reads nothing again
  storyLinkCoverage: new Map(),
  // Each read's count in words, once it is in, so a redraw shows it at once
  storyLinkDescriptions: new Map(),
};

const collectionKey = (collection) => collection.registryKey || collection.id;

/**
 * Initializes the database browser
 * @param {object} settings VECTFOX settings
 */
export function initializeDatabaseBrowser(settings) {
  browserState.settings = settings;
  // A content-vectorizer run may change the collections; redraw the list when it closes.
  document.addEventListener("vectfox:content-vectorizer-closed", renderCollectionsWhileOpen);
  log.lifecycle("VectFox Database Browser: Initialized");
}

function renderCollectionsWhileOpen() {
  if (browserState.isOpen) renderCollections();
}

/**
 * Opens the browser in its dialog and waits until it closes. Rejects only when it could not open.
 * @returns {Promise<void>}
 */
export async function openDatabaseBrowser() {
  log.verbose("VectFox Database Browser: open asked, isOpen=", browserState.isOpen);
  if (browserState.isOpen) return;

  browserState.isOpen = true;
  try {
    browserState.pluginAvailable = await checkPluginAvailable();
    resetBrowserState();
    const root = createBrowser();
    // Opened first, so the list paints into the dialog. While one of the browser's own modals is open on the
    // dialog, Escape and Close leave the browser open, and Escape closes only that modal.
    const closed = openPanelPopup(root, { canClose: () => !isModalOpenOnDialogOf(root) });
    foldFiltersOnPhone(root);
    $("#vectfox_plugin_warning_banner").toggle(!browserState.pluginAvailable);

    // A fresh scan on open, so collections made since the last one (a just-vectorized EventBase collection) carry
    // their real source and model: View chunks would otherwise ask the plugin for source 'unknown', the wrong path.
    await refreshCollections(true);
    log.lifecycle("VectFox Database Browser: Opened");
    await closed;
  } finally {
    browserState.isOpen = false;
    log.lifecycle("VectFox Database Browser: Closed");
  }
}

/** Each open starts on the full list, with nothing ticked and no keywords. */
function resetBrowserState() {
  browserState.filters = { ...DEFAULT_FILTERS };
  browserState.bulkSelected.clear();
  browserState.shownKeys = [];
  browserState.keywordFilter = "";
  browserState.availableKeywords = null;
  browserState.storyLinkCoverage.clear();
  browserState.storyLinkDescriptions.clear();
}

/** GUI-DNA draws a shell this wide or narrower in its phone layout (gui-dna.css, `@container vfx-shell`). */
const PHONE_LAYOUT_MAX_WIDTH = 720;

/**
 * In the phone layout the Filters card starts folded, so the Collections page opens on the list. Its chevron opens
 * it, as on any card. Called once the browser is in its dialog, where the shell has its width.
 * @param {HTMLElement} root
 */
function foldFiltersOnPhone(root) {
  if (root.clientWidth > PHONE_LAYOUT_MAX_WIDTH) return;
  setCollapsed(root.querySelector("#vectfox_browser_filters"), true);
}

/**
 * Builds the browser from its markup and binds its handlers.
 * @returns {HTMLElement} The browser's root, not yet on the page
 */
function createBrowser() {
  const template = document.createElement("template");
  template.innerHTML = databaseBrowserMarkup();
  const root = template.content.firstElementChild;
  $(root).find("#vectfox_search_enabled_only").prop("checked", true);
  bindGeneBehaviours(root);
  bindBrowserEvents(root);
  bindSizeInspector(root);
  return root;
}

/**
 * Shows one page and marks its nav item. A page that replaces another is shown from its top.
 * @param {string} name A page in BROWSER_PAGES
 */
function showBrowserPage(name) {
  const isAnotherPage = !$(`#${browserTabId(name)}`).hasClass("is-active");
  for (const page of BROWSER_PAGES) {
    const isShown = page.name === name;
    $(`#${browserPageId(page.name)}`).toggle(isShown);
    $(`#${browserTabId(page.name)}`).toggleClass("is-active", isShown).attr("aria-current", isShown ? "page" : null);
  }
  if (isAnotherPage) scrollPageToTop(document.getElementById(browserPageId(name)));
}

/**
 * Binds the browser's handlers, delegated on its root, so rows painted later answer too.
 * @param {HTMLElement} root
 */
function bindBrowserEvents(root) {
  const $root = $(root);
  for (const page of BROWSER_PAGES) {
    $root.find(`#${browserTabId(page.name)}`).on("click", () => showBrowserPage(page.name));
  }

  $root.on("click", "[data-browser-action]", function () {
    void runBrowserAction(this.dataset.browserAction, this);
  });
  $root.on("click", "[data-collection-action]", function () {
    void runCollectionAction(this.dataset.collectionAction, this.dataset.collectionKey);
  });

  // Collections page: the filters, then the ticks
  const filterOn = (selector, eventName, update) => $root.on(eventName, selector, function () {
    update(this);
    renderCollections();
  });
  filterOn("#vectfox_browser_type", "change", (select) => { browserState.filters.collectionType = select.value; });
  filterOn("#vectfox_browser_status", "change", (select) => { browserState.filters.status = select.value; });
  filterOn("#vectfox_browser_scope", "change", (select) => { browserState.filters.scope = select.value; });
  filterOn("#vectfox_collection_search", "input", (box) => { browserState.filters.searchQuery = box.value.toLowerCase(); });
  filterOn("#vectfox_only_active_toggle", "change", (toggle) => { browserState.filters.onlyActiveForChat = toggle.checked; });
  $root.on("change", "[data-collection-select]", function () {
    setTicked(this.dataset.collectionSelect, this.checked);
  });
  $root.on("change", "#vectfox_bulk_select_all", function () {
    tickAllShown(this.checked);
  });
  $root.on("click", "#vectfox_reset_registry", () => void resyncRegistry());
  $root.on("click", "#vectfox_browser_clear_reformat_originals", () => void clearReformatOriginals());

  // Search page
  $root.on("click", "#vectfox_search_btn", () => void performSearch());
  $root.on("keydown", "#vectfox_semantic_search", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void performSearch();
  });
  $root.on("input", "#vectfox_keyword_filter", updateKeywordFilterFromInput);
  $root.on("click", "[data-keyword]", function () {
    toggleKeywordFilter(this.dataset.keyword);
  });
}

/**
 * Runs one of a page's buttons.
 * @param {string} action The button's data-browser-action
 * @param {HTMLButtonElement} button
 */
async function runBrowserAction(action, button) {
  switch (action) {
    case "refresh-scan": return refreshScan(button);
    case "import": return importFromPicker();
    case "bulk-enable": return setTickedEnabled(true);
    case "bulk-disable": return setTickedEnabled(false);
    case "bulk-export": return exportTicked();
    case "bulk-delete": return deleteTicked();
    case "scan-keywords": return scanKeywords(button);
    case "clear-keywords": return clearKeywordFilter();
    default: log.warn(`VectFox Database Browser: no page button runs "${action}"`);
  }
}

/**
 * Probes the Standard and Qdrant backends, updates the registry and drops entries that no longer exist.
 * @param {HTMLButtonElement} button
 */
async function refreshScan(button) {
  button.disabled = true;
  try {
    await refreshCollections(true);
    log.lifecycle("VectFox Database Browser: Scan complete, registry updated");
  } finally {
    button.disabled = false;
  }
}

/** Clears the collection registry and rescans the backends, after asking. */
async function resyncRegistry() {
  const isConfirmed = await confirmPopup([
    { text: "Resync the registry?" },
    { text: "VectFox forgets its list of collections, then scans the backends again. A collection the scan cannot find drops off the list, with its settings." },
    { text: "Resync clears the list and scans. Cancel keeps it." },
  ], { okButton: "Resync", isDestructive: true });
  if (!isConfirmed) return;

  try {
    clearCollectionRegistry();
    await refreshCollections(true);
    log.lifecycle("VectFox Database Browser: Registry cleared and resynced");
  } catch (error) {
    log.error("VectFox: Failed to resync", error);
    toastr.error(`Failed to resync: ${error.message}`, "VectFox");
  }
}

/**
 * Clears the source text Auto-Reformat keeps for review (reformat-store.js), after asking. Only that copy goes: the
 * accepted chunks and their run stay, so nothing vectorized changes.
 */
async function clearReformatOriginals() {
  try {
    const { listReformatCacheEntries, clearAllReformatOriginals } = await import("../chunkbase/index.js");
    const entries = listReformatCacheEntries();
    const totalBytes = entries.reduce((sum, entry) => sum + entry.originalTextBytes, 0);
    if (totalBytes === 0) {
      toastr.info("No Auto-Reformat originals are kept, so there is nothing to clear.", "VectFox");
      return;
    }

    const isConfirmed = await confirmPopup([
      { text: "Clear the Auto-Reformat originals?" },
      { text: "Kept now:", name: `${entries.length} sources, about ${formatBytes(totalBytes)}` },
      { text: "Lost: each source's text as it was before Auto-Reformat. The reformatted chunks stay, so nothing vectorized changes." },
      { text: "Clear deletes them. Cancel keeps them." },
    ], { okButton: "Clear", isDestructive: true });
    if (!isConfirmed) return;

    const cleared = clearAllReformatOriginals();
    toastr.success(`Cleared the original text of ${cleared} Auto-Reformat source${cleared === 1 ? "" : "s"}.`, "VectFox");
  } catch (err) {
    log.error("VectFox: Failed to clear Auto-Reformat originals", err);
    toastr.error(`Failed to clear Auto-Reformat originals: ${err.message}`, "VectFox");
  }
}

/** Picks a collection file and imports it. */
async function importFromPicker() {
  const [file] = await pickFiles({ accept: ".json,.vectfox.json,.png,image/png" });
  if (file) await importCollectionFile(file);
}

/**
 * Imports a collection from a JSON file or a PNG card, after showing what it holds and asking.
 * @param {File} file
 */
async function importCollectionFile(file) {
  // The cap (MAX_IMPORT_FILE_BYTES, collections/collection-export.js) is checked before any read, and the JSON
  // reader checks the same one, so the two import paths stay in step.
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    toastr.error(`File too large: ${formatBytes(file.size)} (max ${formatBytes(MAX_IMPORT_FILE_BYTES)}).`, "VectFox Import");
    return;
  }

  try {
    toastr.info("Reading import file...", "VectFox");
    let data;
    if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) {
      data = await extractDataFromPNG(await readPNGFile(file));
      if (!data) {
        toastr.error("This PNG does not contain VectFox data.", "VectFox Import");
        return;
      }
    } else {
      data = await readImportFile(file);
    }

    if (data?.type === STORY_LINKS_FILE_TYPE) {
      toastr.error("This is a StoryArc links file. Use Import links on its collection's row in this list.", "VectFox Import");
      return;
    }

    const info = getExportInfo(data);
    const validation = validateImportData(data, browserState.settings);
    if (!validation.valid) {
      toastr.error(`Invalid export file:\n${validation.errors.join("\n")}`, "VectFox Import");
      return;
    }

    const lines = [
      { text: "Import this collection?" },
      { text: "Name:", name: info.collections[0]?.name || "collection" },
      { text: "Chunks:", name: `${info.totalChunks}, ${info.totalChunksWithVectors} with vectors` },
    ];
    if (info.embedding) {
      // The backend move tells the user whether the data changes backend on the way in.
      const normalBackend = b => (String(b || "standard").toLowerCase() === "vectra" ? "standard" : String(b || "standard").toLowerCase());
      const fromBackend = normalBackend(info.embedding.backend);
      const toBackend = normalBackend(browserState.settings.vector_backend);
      lines.push({ text: "Embedding:", name: `${info.embedding.source}/${info.embedding.model || "default"}, ${info.embedding.dimension || "unknown"} dimensions` });
      lines.push({ text: "Backend:", name: `${fromBackend} to ${toBackend}${fromBackend !== toBackend ? ", moved on import" : ""}` });
    }
    for (const warning of validation.warnings) lines.push({ icon: "fa-triangle-exclamation", parts: [{ name: warning }] });
    if (!validation.compatible && info.totalChunksWithVectors > 0) {
      lines.push({
        icon: "fa-triangle-exclamation",
        text: "Your embedding settings differ, so the chunks are embedded again with yours. To use the saved vectors, switch to:",
        name: `${info.embedding?.source || "unknown"}/${info.embedding?.model || "default"}`,
      });
    }
    lines.push({ text: "A collection with the same ID is replaced." });
    lines.push({ text: "Import adds it. Cancel leaves everything as it is." });
    if (!await confirmPopup(lines, { okButton: "Import", isDestructive: true })) return;

    const result = await importCollection(data, browserState.settings, { overwrite: true });
    if (result.success) {
      toastr.success(`Imported ${result.chunkCount} chunks ${result.usedVectors ? "(used existing vectors)" : "(re-embedded)"}`, "VectFox Import");
      await refreshCollections();
    }
  } catch (error) {
    const isStopped = error?.name === "AbortError" || String(error?.message || "").toLowerCase().includes("stopped by user");
    if (isStopped) {
      toastr.info("Import stopped", "VectFox");
      await refreshCollections();
      return;
    }
    log.error("VectFox: Import failed", error);
    toastr.error(`Import failed: ${error.message}`, "VectFox");
  } finally {
    // The settings panel re-checks its auto-sync status on this event: an import clears what
    // VectFox remembered about the imported chat.
    document.dispatchEvent(new CustomEvent("vectfox:collections-updated"));
  }
}

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
 * All VECTFOX content types follow the unified `vf_<type>_<backend>_<handle>_...`
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
 * Hides the VectFox collections the current persona does not own. Every VectFox
 * content type (eventbase, archived events, lorebook, character, document) is
 * persona-scoped; a collection without a VectFox prefix is always kept.
 *
 * Ownership comes from getCollectionListing: the `creatorHandle` stamped onto
 * collection metadata at registerCollection time (exact equality, collision-proof
 * regardless of underscores in handle or charName), or for an unstamped entry the
 * handle inside its ID. loadAllCollections() calls registerCollection() for every
 * registry entry on each open, so the stamp is applied before this filter runs —
 * even for pre-stamp or imported entries.
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
    log.lifecycle(
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

    // Persona-scoped: any VectFox content-type prefix.
    const isPersonaScoped = _PERSONA_SCOPED_PREFIXES.some((prefix) =>
      idLower.startsWith(prefix.toLowerCase())
    );

    // Not a VectFox collection — always visible.
    if (!isPersonaScoped) return true;

    // Persona-scoped — keep only if the listing says we own it.
    const key = c.registryKey || `${c.backend}:${c.id}`;
    return ownLookup.get(key) === true || ownLookup.get(c.id) === true;
  });
}

async function refreshCollections(withScan = false) {
  try {
    browserState.storyLinkCoverage.clear();
    browserState.storyLinkDescriptions.clear();
    const allCollections = await loadAllCollections(browserState.settings, withScan);
    browserState.collections = _filterCollectionsByCurrentPersona(allCollections);

    if (allCollections.length !== browserState.collections.length) {
      const hidden = allCollections.length - browserState.collections.length;
      log.verbose(
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
    if (cleanupResult.removed > 0) {
      log.lifecycle(
        `VectFox: Cleaned up ${cleanupResult.removed} orphaned metadata entries`,
      );
    }

    renderCollections();
  } catch (error) {
    log.error("VectFox: Failed to load collections", error);
    $("#vectfox_collections_list").html(collectionsFailedMarkup());
  }
}

// The collection types each Type filter keeps.
const TYPE_FILTER_TYPES = Object.freeze({
  chat: ["chat"],
  lorebook: ["lorebook"],
  character: ["character", "persona"],
  document: ["file", "doc", "paste", "select", "current"],
  web: ["url", "wiki", "youtube"],
});

/**
 * Whether a collection passes the Collections page's filters.
 * @param {object} collection
 * @param {Map<string, boolean>} isActiveById Active for the current chat, by registry key and by bare id
 * @returns {boolean}
 */
function passesFilters(collection, isActiveById) {
  const { scope, collectionType, status, searchQuery, onlyActiveForChat } = browserState.filters;
  // Lock counts are keyed by registry-key form ("backend:id"), the key setCollectionLock writes to.
  const lookupKey = collectionKey(collection);
  if (scope === "chat" && getCollectionLockCount(lookupKey) <= 0) return false;
  if (scope === "character" && getCollectionCharacterLockCount(lookupKey) <= 0) return false;
  // The Active here pill's own source, so the filter keeps exactly the collections that show it.
  if (onlyActiveForChat && !isActiveById.get(lookupKey)) return false;
  const allowedTypes = TYPE_FILTER_TYPES[collectionType];
  if (allowedTypes && !allowedTypes.includes(collection.type)) return false;
  if (status === "enabled" && !collection.enabled) return false;
  if (status === "disabled" && collection.enabled) return false;
  if (searchQuery) {
    return collection.name.toLowerCase().includes(searchQuery) || collection.id.toLowerCase().includes(searchQuery);
  }
  return true;
}

/**
 * Renders the collections list from the current filters, keeps only the shown collections ticked, and fills in the
 * StoryArc links rows.
 */
function renderCollections() {
  // One read of the lock state for the filter pass and every row: getCollectionListing computes each entry's
  // isActive with isCollectionActiveForContext, keyed both ways. See Doc/collection_helper.md:54.
  const isActiveById = new Map();
  for (const entry of getCollectionListing(browserState.settings)) {
    isActiveById.set(entry.collectionId, entry.isActive);
    isActiveById.set(entry.registryKey, entry.isActive);
  }

  const shown = browserState.collections.filter((collection) => passesFilters(collection, isActiveById));
  browserState.shownKeys = shown.map(collectionKey);
  for (const key of [...browserState.bulkSelected]) {
    if (!browserState.shownKeys.includes(key)) browserState.bulkSelected.delete(key);
  }
  updateStats(shown.length, shown.reduce((sum, c) => sum + c.chunkCount, 0));
  paintTicks();

  const container = $("#vectfox_collections_list");
  if (shown.length === 0) {
    container.html(noCollectionsMarkup());
    return;
  }
  container.html(shown.map((collection) => collectionEntryMarkup(collectionRowView(collection, isActiveById))).join(""));
  fillStoryLinkRows().catch((err) => log.warn("VectFox: Could not fill in the StoryArc links rows:", err));
}

const BACKEND_NAMES = Object.freeze({ standard: "Standard", qdrant: "Qdrant" });

/**
 * A collection's row as plain values, for collectionEntryMarkup.
 * @param {object} collection
 * @param {Map<string, boolean>} isActiveById
 * @returns {object}
 */
function collectionRowView(collection, isActiveById) {
  const key = collectionKey(collection);
  const hasMultipleModels = collection.models?.length > 1;
  return {
    key,
    name: collection.name,
    id: collection.id,
    type: collection.type,
    chunkCount: collection.chunkCount,
    isEnabled: Boolean(collection.enabled),
    isSelected: browserState.bulkSelected.has(key),
    scope: collection.scope,
    backend: BACKEND_NAMES[collection.backend] || collection.backend || "",
    source: collection.source && collection.source !== "unknown" ? collection.source : "",
    model: hasMultipleModels ? (collection.model || "(default)") : "",
    hasMultipleModels,
    activeHereLine: activeHereLine(collection, isActiveById),
    // The registry-key (backend:id) metadata the Collection Settings dialog writes
    activationMode: getCollectionActivationSummary(key).mode,
    hasStoryLinks: hasStoryLinksRow(collection),
    storyLinksDescription: browserState.storyLinkDescriptions.get(key) ?? "",
  };
}

/**
 * Which lock makes a collection active in the current chat, in words, or "" when none does. It names the lock that
 * actually matched, not the one its scope implies: shouldCollectionActivate() takes a chat lock OR a character lock
 * whatever the scope, so a chat-scoped collection can be active here through a character lock. Locks elsewhere show in
 * Collection Settings.
 * @param {object} collection
 * @param {Map<string, boolean>} isActiveById
 * @returns {string}
 */
function activeHereLine(collection, isActiveById) {
  const isActive = isActiveById.get(collection.registryKey || `${collection.backend}:${collection.id}`) === true
    || isActiveById.get(collection.id) === true;
  if (!isActive) return "";

  // Registry-key form, so two collections sharing a bare ID on different backends keep their own locks.
  const lockKey = collectionKey(collection);
  const currentChatId = getCurrentChatId();
  const isViaChat = Boolean(currentChatId && isCollectionLockedToChat(lockKey, currentChatId));
  const isViaCharacter = Boolean(isCollectionLockedToCharacter(lockKey, getContext()?.characterId));
  let line;
  if (isViaChat && isViaCharacter) line = "Locked to this chat and to this character";
  else if (isViaCharacter) line = "Locked to this character, so it is active in every chat with them";
  else line = "Locked to this chat";

  const otherChatCount = getCollectionLockCount(lockKey) - (isViaChat ? 1 : 0);
  if (otherChatCount > 0) line += `, and to ${otherChatCount} other chat${otherChatCount === 1 ? "" : "s"}`;
  return line;
}

/**
 * Ticks or unticks one collection for the bulk actions.
 * @param {string} key
 * @param {boolean} isTicked
 */
function setTicked(key, isTicked) {
  if (isTicked) browserState.bulkSelected.add(key);
  else browserState.bulkSelected.delete(key);
  paintTicks();
}

/**
 * Ticks every shown collection, or none.
 * @param {boolean} isTicked
 */
function tickAllShown(isTicked) {
  browserState.bulkSelected.clear();
  if (isTicked) browserState.shownKeys.forEach((key) => browserState.bulkSelected.add(key));
  $("[data-collection-select]").each(function () {
    this.checked = browserState.bulkSelected.has(this.dataset.collectionSelect);
  });
  paintTicks();
}

/** Paints the tick count, the bulk buttons and "Select all shown" from the ticked collections. */
function paintTicks() {
  const count = browserState.bulkSelected.size;
  const shownCount = browserState.shownKeys.length;
  $("[data-bulk-count]").text(`${count} selected`);
  $('[data-browser-action^="bulk-"]').prop("disabled", count === 0);
  $("#vectfox_bulk_select_all")
    .prop("checked", count > 0 && count === shownCount)
    .prop("indeterminate", count > 0 && count < shownCount);
}

/** The ticked collections still in the list. */
function tickedCollections() {
  return [...browserState.bulkSelected].map(findCollectionByKey).filter(Boolean);
}

/**
 * Whether a collection gets a StoryArc links row: links need Qdrant, and only a
 * live EventBase collection holds them.
 * @param {object} collection Collection data
 * @returns {boolean}
 */
function hasStoryLinksRow(collection) {
  const { settings } = browserState;
  return Boolean(settings?.story_arc_mode_enabled)
    && settings.vector_backend === "qdrant"
    && collection.backend === "qdrant"
    && String(collection.id).startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE);
}

/**
 * Fills in the count on each StoryArc links row, one row at a time since each reads
 * a whole collection. A redraw starts this again and shares the reads already made.
 * @returns {Promise<void>}
 */
async function fillStoryLinkRows() {
  for (const row of $("[data-story-links-row]").toArray()) {
    const key = row.dataset.storyLinksRow;
    const collection = findCollectionByKey(key);
    if (!collection) continue;
    if (!browserState.storyLinkCoverage.has(key)) {
      browserState.storyLinkCoverage.set(key, readCollectionLinkCoverage(collection.id, browserState.settings));
    }
    const description = describeStoryLinkCoverage(await browserState.storyLinkCoverage.get(key));
    browserState.storyLinkDescriptions.set(key, description);
    $(row).replaceWith(storyLinksRowMarkup(key, description));
  }
}

/** Reads a collection's StoryArc links again, after they changed. */
async function refreshStoryLinkRow(key) {
  browserState.storyLinkCoverage.delete(key);
  browserState.storyLinkDescriptions.delete(key);
  await fillStoryLinkRows();
}

/**
 * Picks a links file and puts its links onto a collection's events.
 * @param {object} collection
 */
async function importStoryLinksFromPicker(collection) {
  const [file] = await pickFiles({ accept: ".json" });
  if (file) await importStoryLinksFile(file, collectionKey(collection));
}

/**
 * Puts a links file's links onto a collection's events, after showing what that changes.
 * @param {File} file The picked file
 * @param {string} key The collection whose Import links button was pressed
 * @returns {Promise<void>}
 */
async function importStoryLinksFile(file, key) {
  const collection = findCollectionByKey(key);
  if (!collection) return;
  try {
    const data = await readImportFile(file);
    const plan = await planStoryLinksImport(data, collection.id, browserState.settings);
    if (plan.writes.length === 0) {
      toastr.error(
        `None of this file's ${plan.fileEventCount} events are in ${collection.name}, so nothing was written.`,
        "VectFox StoryArc",
      );
      return;
    }

    const isConfirmed = await confirmPopup([
      { text: "Import StoryArc links into this collection?" },
      { text: "Collection:", name: collection.name },
      ...describeStoryLinksImport(plan).map((sentence) => ({ parts: [{ name: sentence }] })),
      { text: "Saved from:", name: `${data.collection?.name ?? "an unnamed collection"}, on ${String(data.exportDate ?? "an unknown date").slice(0, 10)}` },
      { text: "Nothing else about the events changes, and this makes no LLM call." },
      { text: "Import links writes them. Cancel leaves the events as they are." },
    ], { okButton: "Import links", isDestructive: true });
    if (!isConfirmed) return;

    const { writtenCount, failedCount, isStopped } = await writeImportedStoryLinks(plan.writes, collection.id, browserState.settings);
    if (failedCount === 0 && !isStopped) {
      toastr.success(`Imported the links of ${writtenCount} events`, "VectFox StoryArc");
    }
    await refreshStoryLinkRow(key);
    document.dispatchEvent(new CustomEvent("vectfox:collections-updated"));
  } catch (error) {
    log.error("VectFox: Import links failed", error);
    toastr.error(`Import links failed: ${error.message}`, "VectFox StoryArc");
  }
}

/**
 * Deletes a collection's StoryArc links, after showing how many events lose them.
 * @param {string} key The collection whose Delete links button was pressed
 * @returns {Promise<void>}
 */
async function deleteCollectionStoryLinks(key) {
  const collection = findCollectionByKey(key);
  if (!collection) return;
  try {
    const writes = await planStoryLinksDelete(collection.id, browserState.settings);
    if (writes.length === 0) {
      toastr.info("This collection has no links to delete.", "VectFox StoryArc");
      return;
    }

    const isConfirmed = await confirmPopup([
      { text: "Delete the StoryArc links of this collection?" },
      { text: "Collection:", name: collection.name },
      { text: "Lost:", name: `the links of ${writes.length} events, which go back to not decided` },
      { text: "The events stay as they are. StoryArc answers without links, and new events wait, until Regenerate links on the StoryArc page makes new ones at the link model's cost. Export links first to keep a copy." },
      { text: "Delete links deletes them. Cancel keeps them." },
    ], { okButton: "Delete links", isDestructive: true });
    if (!isConfirmed) return;

    const { writtenCount, failedCount, isStopped } = await deleteStoryLinks(writes, collection.id, browserState.settings);
    if (failedCount === 0 && !isStopped) {
      toastr.success(`Deleted the links of ${writtenCount} events`, "VectFox StoryArc");
    }
    await refreshStoryLinkRow(key);
    document.dispatchEvent(new CustomEvent("vectfox:collections-updated"));
  } catch (error) {
    log.error("VectFox: Delete links failed", error);
    toastr.error(`Delete links failed: ${error.message}`, "VectFox StoryArc");
  }
}

/**
 * Saves a collection's StoryArc links to a file.
 * @param {object} collection
 */
async function exportCollectionStoryLinks(collection) {
  try {
    const linksFile = await buildCollectionLinksFile(collection, browserState.settings);
    if (linksFile.events.length === 0) {
      toastr.info("This collection has no links to export yet.", "VectFox StoryArc");
      return;
    }
    downloadExport(linksFile, `${collection.name || collection.id}-storyarc-links`);
    toastr.success(`Exported the links of ${linksFile.events.length} events`, "VectFox StoryArc");
  } catch (error) {
    log.error("VectFox: Export links failed", error);
    toastr.error(`Export links failed: ${error.message}`, "VectFox StoryArc");
  }
}

/**
 * Helper to find collection by its unique key (registryKey or id)
 */
function findCollectionByKey(key) {
  return browserState.collections.find((c) => collectionKey(c) === key);
}

/**
 * Runs one of a collection's buttons. Rename, Collection Settings and the model switcher take the registry key form
 * (backend:id), so the metadata layer keys names, locks and activation per backend.
 * @param {string} action The button's data-collection-action
 * @param {string} key The collection's key
 */
async function runCollectionAction(action, key) {
  const collection = findCollectionByKey(key);
  if (!collection) return;
  switch (action) {
    case "toggle": return toggleCollection(collection);
    case "rename": return openRenameDialog(collectionKey(collection), collection.name);
    case "settings": return openActivationEditor(collectionKey(collection), collection.name);
    case "switch-model": return collection.models?.length > 1 ? openModelSwitcher(collection) : undefined;
    case "view-chunks": return openChunkVisualizer(collection);
    case "export-json": return exportCollectionJson(collection);
    case "export-png": return exportCollectionPng(collection);
    case "delete": return deleteOneCollection(collection);
    case "export-links": return exportCollectionStoryLinks(collection);
    case "import-links": return importStoryLinksFromPicker(collection);
    case "delete-links": return deleteCollectionStoryLinks(key);
    default: log.warn(`VectFox Database Browser: no collection button runs "${action}"`);
  }
}

/**
 * Pauses a collection, or resumes it.
 * @param {object} collection
 */
function toggleCollection(collection) {
  collection.enabled = !collection.enabled;
  setCollectionEnabled(collectionKey(collection), collection.enabled);
  renderCollections();
  log.lifecycle(`VectFox Database Browser: ${collection.enabled ? "Resumed" : "Paused"} ${collectionKey(collection)}`);
}

/**
 * Deletes one collection from every store, after asking.
 * @param {object} collection
 */
async function deleteOneCollection(collection) {
  const key = collectionKey(collection);
  const isConfirmed = await confirmPopup([
    { text: "Delete this collection?" },
    { text: "Collection:", name: collection.name },
    { text: "Lost:", name: `${collection.chunkCount} chunks${hasStoryLinksRow(collection) ? ", and the StoryArc links of their events" : ""}` },
    { text: "This cannot be undone." },
    { text: "Delete deletes it. Cancel keeps it." },
  ], { okButton: "Delete", isDestructive: true });
  if (!isConfirmed) return;

  try {
    const result = await deleteCollectionEverywhere(collection);
    browserState.collections = browserState.collections.filter((c) => collectionKey(c) !== key);
    browserState.storyLinkCoverage.delete(key);
    browserState.storyLinkDescriptions.delete(key);
    renderCollections();
    // The settings panel re-checks its Semantic WI and auto-sync checkboxes on
    // this event; the deleted collection may have been what kept either one on.
    document.dispatchEvent(new CustomEvent("vectfox:collections-updated"));

    if (result.success) {
      log.lifecycle(`VectFox Database Browser: Deleted collection ${key}`);
    } else {
      toastr.warning(`Partial deletion: ${result.errors.join(", ")}`, "VectFox");
    }
  } catch (error) {
    log.error("VectFox: Failed to delete collection", error);
    toastr.error(`Failed to delete collection: ${error.message}`, "VectFox");
  }
}

/**
 * Deletes a collection's vectors, registry entry and metadata. `_discoveredSources` carries every {source, models}
 * index the plugin found on disk, so the Standard backend purges the real {source}/{collectionId}/{model}/ paths, not
 * the current embedding provider's, which may not match what is on disk.
 * @param {object} collection
 * @returns {Promise<{success: boolean, errors: string[]}>}
 */
function deleteCollectionEverywhere(collection) {
  const collectionSettings = {
    ...browserState.settings,
    vector_backend: collection.backend,
    _discoveredSources: collection.sources,
  };
  return deleteCollection(collection.id, collectionSettings, collection.registryKey);
}

/**
 * Reads a collection's whole export, its chunks with their vectors, from the index its backend, source and model name.
 * @param {object} collection
 * @returns {Promise<object>}
 */
function readCollectionExport(collection) {
  return exportCollection(collection.id, browserState.settings, {
    backend: collection.backend,
    source: collection.source || "transformers",
    model: collection.model || "",
  });
}

/**
 * Downloads a collection as JSON, vectors included.
 * @param {object} collection
 */
async function exportCollectionJson(collection) {
  try {
    toastr.info("Exporting collection...", "VectFox");
    const exportData = await readCollectionExport(collection);
    downloadExport(exportData, collection.name || collection.id);
    toastr.success(
      `Exported ${exportData.stats.chunkCount} chunks (${exportData.stats.chunksWithVectors} with vectors)`,
      "VectFox Export",
    );
  } catch (error) {
    log.error("VectFox: Export failed", error);
    toastr.error(`Export failed: ${error.message}`, "VectFox");
  }
}

/**
 * Downloads a collection inside a PNG card, on the user's own picture or the default one.
 * @param {object} collection
 */
async function exportCollectionPng(collection) {
  const wantsOwnPicture = await confirmPopup([
    { text: "Put the PNG card on a picture of your own?" },
    { text: "The collection is saved inside the picture, so it can be shared as an image." },
    { text: "Choose a picture opens the file picker. Use the default puts it on the VectFox picture." },
  ], { okButton: "Choose a picture", cancelButton: "Use the default" });

  let picture = null;
  if (wantsOwnPicture) {
    [picture = null] = await pickFiles({ accept: "image/*" });
    if (!picture) return; // the picker was dismissed: nothing is exported
  }
  await performPngExport(collection, picture);
}

/**
 * Performs PNG export with optional custom image
 * @param {object} collection
 * @param {File|null} imageFile Custom image file or null for default
 */
async function performPngExport(collection, imageFile) {
  try {
    toastr.info("Preparing PNG export...", "VectFox");
    const exportData = await readCollectionExport(collection);

    let pngData = null;
    if (imageFile) {
      toastr.info("Converting image...", "VectFox");
      pngData = await convertToPNG(imageFile);
    }

    toastr.info("Embedding data in PNG...", "VectFox");
    const pngWithData = await embedDataInPNG(exportData, pngData);
    downloadPNG(pngWithData, `${collection.name || collection.id}.vectfox`);

    const jsonSize = utf8ByteLength(JSON.stringify(exportData));
    const pngSize = pngWithData.length;
    toastr.success(
      `PNG export complete!\n${exportData.stats.chunkCount} chunks\n` +
        `Original: ${formatBytes(jsonSize)}\n` +
        `PNG: ${formatBytes(pngSize)} (${Math.round((pngSize / jsonSize) * 100)}%)`,
      "VectFox Export",
    );
  } catch (error) {
    log.error("VectFox: PNG export failed", error);
    toastr.error(`PNG export failed: ${error.message}`, "VectFox");
  }
}

/**
 * Pauses or resumes every ticked collection.
 * @param {boolean} isEnabled
 */
function setTickedEnabled(isEnabled) {
  const collections = tickedCollections();
  for (const collection of collections) {
    setCollectionEnabled(collectionKey(collection), isEnabled);
    collection.enabled = isEnabled;
  }
  renderCollections();
  log.lifecycle(`VectFox Database Browser: ${isEnabled ? "Resumed" : "Paused"} ${collections.length} collections`);
}

/** Downloads every ticked collection, one file each, after asking. */
async function exportTicked() {
  const collections = tickedCollections();
  if (collections.length === 0) return;
  const isConfirmed = await confirmPopup([
    { text: "Export the ticked collections?" },
    { text: "Collections:", name: collections.length },
    { text: "Each one downloads as a file of its own." },
    { text: "Export downloads them. Cancel stops here." },
  ], { okButton: "Export" });
  if (!isConfirmed) return;

  toastr.info(`Exporting ${collections.length} collection(s)...`, "VectFox");
  let successCount = 0;
  for (const collection of collections) {
    try {
      downloadExport(await readCollectionExport(collection), collection.name || collection.id);
      successCount++;
    } catch (error) {
      log.error(`VectFox: Failed to export ${collection.id}`, error);
    }
  }
  if (successCount === collections.length) {
    toastr.success(`Exported ${successCount} collection(s)`, "VectFox");
  } else {
    toastr.warning(`Exported ${successCount} of ${collections.length} collections. The console has the reason.`, "VectFox");
  }
}

/** Deletes every ticked collection, after one confirm that names them. */
async function deleteTicked() {
  const collections = tickedCollections();
  if (collections.length === 0) return;
  const names = collections.map((c) => c.name || c.id);
  const namesShown = names.length > 10 ? `${names.slice(0, 10).join(", ")}, and ${names.length - 10} more` : names.join(", ");
  const isConfirmed = await confirmPopup([
    { text: "Delete the ticked collections?" },
    { text: "Collections:", name: `${collections.length}: ${namesShown}` },
    { text: "Lost: every chunk in them, and the StoryArc links of their events. This cannot be undone." },
    { text: "Delete deletes them. Cancel keeps them." },
  ], { okButton: "Delete", isDestructive: true });
  if (!isConfirmed) return;

  toastr.info(`Deleting ${collections.length} collection(s)...`, "VectFox");
  let successCount = 0;
  let partialCount = 0;
  for (const collection of collections) {
    try {
      const result = await deleteCollectionEverywhere(collection);
      if (result.success) successCount++;
      else partialCount++;
    } catch (error) {
      log.error(`VectFox: Failed to delete ${collection.id}`, error);
    }
  }

  browserState.bulkSelected.clear();
  await refreshCollections();
  // Same settings-panel refresh as the single delete above.
  document.dispatchEvent(new CustomEvent("vectfox:collections-updated"));

  const failedCount = collections.length - successCount - partialCount;
  if (partialCount > 0 || failedCount > 0) {
    toastr.warning(`Deleted ${successCount}, partly deleted ${partialCount}, failed ${failedCount}. The console has the reason.`, "VectFox");
  } else {
    log.lifecycle(`VectFox Database Browser: Deleted ${successCount} collections`);
  }
}

/**
 * Paints the page header's counts.
 * @param {number} collectionCount Number of collections shown
 * @param {number} chunkCount Total chunks
 */
function updateStats(collectionCount, chunkCount) {
  $('[data-browser-count="collections"]').text(`${collectionCount} collection${collectionCount === 1 ? "" : "s"}`);
  $('[data-browser-count="chunks"]').text(`${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`);
}

/**
 * Loads and opens the chunk visualizer for a collection.
 * Opened by View chunks on the Collections page and on each Search result.
 */
async function openChunkVisualizer(collection) {
  try {
    toastr.info("Loading chunks...", "VectFox");

    if (!collection.backend) {
      toastr.error("Collection has no backend defined - this is a bug", "VectFox");
      log.error("VectFox: Collection missing backend:", collection);
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

      log.verbose("VECTFOX DB Browser: Requesting chunks with:", requestBody);

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
    log.error("VectFox: Failed to load chunks", error);
    toastr.error(`Failed to load chunks: ${error.message}`, "VectFox");
  }
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
  // A dialog made on an earlier open moved down when the browser's dialog closed; it goes back on top of the browser.
  const existingModal = document.getElementById("vectfox_rename_modal");
  if (existingModal) placeOnTopmostModalLayer(existingModal);
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
    placeMarkupOnTopmostModalLayer(modalHtml);

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
      const collection = browserState.collections.find((c) => (c.registryKey || c.id) === id);
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
  // A dialog made on an earlier open moved down when the browser's dialog closed; it goes back on top of the browser.
  const existingModal = document.getElementById("vectfox_model_switcher_modal");
  if (existingModal) placeOnTopmostModalLayer(existingModal);
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
    placeMarkupOnTopmostModalLayer(modalHtml);

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
  // The rule controls edit these conditions in place: work on a copy, so Save
  // writes it back and Cancel discards it.
  const conditions = structuredClone(getCollectionConditions(collectionId));

  const collectionType =
    meta.scope === "chat" ? "chat" : meta.type || "unknown";

  const currentChatId = getCurrentChatId();
  const currentCharacterId = getContext()?.characterId;
  const resolvedAlwaysActive = isCollectionActiveForContext(collectionId, {
    chatId: currentChatId,
    characterId: currentCharacterId,
  });
  log.verbose(
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
  } else {
    placeOnTopmostModalLayer(document.getElementById("vectfox_activation_editor_modal"));
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
 * Creates the collection settings modal: the lock (required), activation
 * triggers and advanced conditions (filters on a locked collection), then
 * prompt context and injection position.
 */
function createActivationEditorModal() {
  const modalHtml = `
        <div id="vectfox_activation_editor_modal" class="vectfox-modal">
            <div class="vectfox-activation-editor">
                <div class="vectfox-modal-header">
                    <h3>⚙️ Collection Settings</h3>
                    <div class="vectfox-modal-header-actions">
                        <button id="vectfox_activation_lock_collection" class="vectfox-btn-sm" title="Manage this collection's chat and character locks">🔒 Manage Locks</button>
                    </div>
                    <button class="vectfox-btn-icon" id="vectfox_activation_close">✕</button>
                </div>

                <div class="vectfox-activation-body">
                    <div class="vectfox-activation-collection-name">
                        Collection: <strong id="vectfox_activation_collection_name"></strong>
                    </div>

                    <!-- ========================================== -->
                    <!-- REQUIRED: THE LOCK IS THE MASTER SWITCH      -->
                    <!-- Nothing below activates a collection that is -->
                    <!-- not locked; triggers/conditions only narrow. -->
                    <!-- ========================================== -->
                    <div class="vectfox-activation-section vectfox-always-active">
                        <div class="vectfox-section-header">
                            <h4>🔒 Lock <span class="vectfox-badge-required">Required</span></h4>
                            <small>The master switch. A collection that is not locked never activates, whatever else is set below.</small>
                        </div>
                        <label class="vectfox-checkbox-label">
                            <input type="checkbox" id="vectfox_always_active">
                        <strong id="vectfox_always_active_label">Active for current chat</strong>
                        </label>
                      <small id="vectfox_always_active_hint">When enabled, this collection is active for the current chat</small>
                    </div>

                    <!-- ========================================== -->
                    <!-- FILTER: ACTIVATION TRIGGERS (Like Lorebook)  -->
                    <!-- Narrows an already-locked collection. Has no -->
                    <!-- effect on its own - see the Lock block above. -->
                    <!-- ========================================== -->
                    <div class="vectfox-activation-section vectfox-triggers-section">
                        <div class="vectfox-section-header">
                            <h4>🎯 Activation Triggers <span class="vectfox-badge-primary">Filter</span></h4>
                            <small>Narrows a locked collection to turns whose recent messages contain a keyword. Leave empty to keep it active on every turn.</small>
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
                    <!-- FILTER: ADVANCED CONDITIONS                  -->
                    <!-- Narrows a locked collection further; with    -->
                    <!-- triggers set too, both must pass.            -->
                    <!-- ========================================== -->
                    <div class="vectfox-activation-section vectfox-conditions-section">
                        <div class="vectfox-section-header">
                            <h4>⚡ Advanced Conditions <span class="vectfox-badge-secondary">Filter</span></h4>
                            <small>Rules that narrow a locked collection further. When triggers are also set, both must pass this turn.</small>
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

                    <!-- Activation chain summary -->
                    <div class="vectfox-activation-info">
                        <strong>Activation Chain — every step that applies must pass:</strong>
                        <ol>
                            <li><strong>Disabled</strong> → never queries (pause kills all activation)</li>
                            <li><strong>Lock</strong> → <em>required</em>. Not locked to this chat or character → does not activate, full stop</li>
                            <li><strong>Triggers</strong>, if set → a keyword must match recent messages this turn</li>
                            <li><strong>Advanced Conditions</strong>, if set → the rules must also pass this turn</li>
                            <li><strong>Locked, nothing else set</strong> → active on every turn</li>
                        </ol>
                        <small>Triggers and conditions <strong>narrow</strong> a locked collection. They cannot switch one on by themselves.</small>
                    </div>
                </div>

                <div class="vectfox-modal-footer">
                    <button class="vectfox-btn" id="vectfox_activation_cancel">Cancel</button>
                    <button class="vectfox-btn vectfox-btn-primary" id="vectfox_activation_save">Save</button>
                </div>
            </div>
        </div>
    `;

  placeMarkupOnTopmostModalLayer(modalHtml);
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

  // Master-switch toggle (status only, does not disable other settings).
  // Its label follows the collection's scope - see syncLockCheckboxToScope().
  $("#vectfox_always_active").on("change", function (e) {
    e.stopPropagation();
  });

  // Activation editor: Manage Locks button - opens the dialog that adds and removes
  // BOTH chat and character locks. It is the only route to a character lock; the
  // master-switch checkbox writes just the one lock matching the collection's scope.
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
      log.error("VectFox: Failed to open lock dialog", err);
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
 * Points the master-switch checkbox at the lock it actually writes.
 *
 * saveActivation() branches on the collection's scope: scope='chat' writes a chat
 * lock, scope='character' writes a character lock, so the label names the lock this
 * checkbox changes. A character lock (the default scope for lorebooks) makes the
 * collection active in every chat with that character.
 *
 * Without a lock target the checkbox is disabled and the hint points to the
 * 🔒 Manage Locks dialog instead: a character-scoped collection in a group chat has
 * no characterId, but the group chat still has a chat ID that dialog can lock.
 */
function syncLockCheckboxToScope(collectionId) {
  const scope = getCollectionMeta(collectionId)?.scope || "character";
  const isCharacterScope = scope !== "chat";
  const hasLockTarget = isCharacterScope
    ? getContext()?.characterId !== undefined && getContext()?.characterId !== null
    : Boolean(getCurrentChatId());

  $("#vectfox_always_active_label").text(
    isCharacterScope ? "Active for current character" : "Active for current chat",
  );

  let hint;
  if (!hasLockTarget) {
    hint = isCharacterScope
      ? "No active character - group chats have none. Use 🔒 Manage Locks below to lock this collection to the current chat instead."
      : "No active chat. Open a chat, or use 🔒 Manage Locks below.";
  } else {
    hint = isCharacterScope
      ? "When enabled, this collection is active in every chat with the current character."
      : "When enabled, this collection is active for the current chat.";
  }
  $("#vectfox_always_active_hint").text(hint);
  $("#vectfox_always_active").prop("disabled", !hasLockTarget);
}

/**
 * Renders the activation editor content
 */
function renderActivationEditor() {
  const state = activationEditorState;

  $("#vectfox_activation_collection_name").text(state.collectionName);
  $("#vectfox_always_active").prop("checked", state.alwaysActive);
  syncLockCheckboxToScope(state.collectionId);

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
      $btn.prop("disabled", true).text("🔒 Manage Locks");
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
      // CHAT_CHANGED can move us between a solo and a group chat, which changes
      // which lock the checkbox writes - and whether it can write one at all.
      syncLockCheckboxToScope(collId);
    }

    if (totalLocks === 0) {
      $btn.prop("disabled", false).text("🔒 Manage Locks");
      $btn.attr("title", "No locks set. Click to add locks");
    } else {
      // totalLocks counts BOTH kinds, so the suffix must not name one of them
      // unless it is the lock that actually matches here. The old label read
      // "(other chat)" for a collection whose only locks were CHARACTER locks,
      // sending the user to look for a chat lock that never existed.
      const isActiveHere = Boolean(isLockedToCurrentChat || isLockedToCurrentChar);
      const lockedStatus = isActiveHere ? "🔓" : "🔒";
      const lockLabel = `${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      let scopeLabel;
      if (isLockedToCurrentChat && isLockedToCurrentChar) scopeLabel = "(this chat + character)";
      else if (isLockedToCurrentChat) scopeLabel = "(this chat)";
      else if (isLockedToCurrentChar) scopeLabel = "(this character)";
      else scopeLabel = "(elsewhere)";
      $btn.prop("disabled", false).text(`${lockedStatus} ${lockLabel} ${scopeLabel}`);

      const lockBreakdown = [];
      if (chatLockCount > 0) lockBreakdown.push(`${chatLockCount} chat${chatLockCount !== 1 ? "s" : ""}`);
      if (charLockCount > 0) lockBreakdown.push(`${charLockCount} character${charLockCount !== 1 ? "s" : ""}`);
      let tooltip = `Collection has ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}: ${lockBreakdown.join(", ")}.`;
      tooltip += isActiveHere
        ? " ACTIVE here — the master switch is on for this context."
        : " Not active here — none of these locks match the current chat or character.";
      // A character lock can never match in a group chat (no single active
      // character), so a collection locked only to characters looks inert there.
      // Say why, rather than leaving the user to work it out.
      if (!isActiveHere && charLockCount > 0 && chatLockCount === 0 && !charId) {
        tooltip += " Only character locks are set, and a group chat has no active character — add a chat lock.";
      }

      $btn.attr("title", tooltip);
    }
  } catch (err) {
    log.error("VectFox: Failed to refresh activation lock button", err);
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
  log.lifecycle(`[VectFox] saveActivation: checkbox=${isChecked}, scope=${saveMeta.scope}, chatId=${currentChatId || 'none'}, charId=${currentCharacterId ?? 'none'}, collection=${state.collectionId}`);

  // The master-switch checkbox controls a single lock keyed by the collection's scope.
  // syncLockCheckboxToScope() labels it to match, and disables it when the scope's
  // lock target is missing - so the no-target branches below are backstops.
  //   scope='chat'      → chat lock for currentChatId       ("Active for current chat")
  //   scope='character' → character lock for currentCharacterId ("Active for current character")
  if (saveMeta.scope === 'chat') {
    if (!currentChatId) {
      toastr.info('No active chat; "Active for current chat" was not changed');
    } else if (isChecked) {
      setCollectionLock(state.collectionId, currentChatId);
    } else {
      removeCollectionLock(state.collectionId, currentChatId);
    }
  } else if (saveMeta.scope === 'character') {
    if (!currentCharacterId) {
      toastr.info('No active character; use 🔒 Manage Locks to lock this collection to the current chat', 'VectFox');
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
      '<div class="vectfox-empty-rules">No conditions yet. Click "+ Add" to add one.</div>',
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

    case "generationType": {
      const genOptions = VALID_GENERATION_TYPES.map(
        (g) =>
          `<option value="${g}" ${(settings.values || []).includes(g) ? "selected" : ""}>${g}</option>`,
      ).join("");
      return `
                <select multiple data-field="values" data-rule-index="${index}" class="vectfox-multi-select">
                    ${genOptions}
                </select>
            `;
    }

    case "lorebookActive": {
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
    }

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
                       value="${settings.probability ?? 50}"
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
        log.error("VectFox: Failed to load world info", error);
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
// SEARCH PAGE
// ============================================================================

/**
 * Scans the collections for the keywords their chunks carry, the most common first.
 * @param {HTMLButtonElement} button
 */
async function scanKeywords(button) {
  const $tags = $("#vectfox_keyword_tags");
  button.disabled = true;
  $tags.html(keywordScanRunningMarkup());

  try {
    const isEnabledOnly = $("#vectfox_search_enabled_only").is(":checked");
    const collectionsToScan = isEnabledOnly
      ? browserState.collections.filter((c) => c.enabled)
      : browserState.collections;

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
        if (!response.ok) {
          log.warn(`VectFox: Keyword scan could not list ${collection.id}: HTTP ${response.status}`);
          continue;
        }

        const data = await response.json();
        for (const item of data.items || []) {
          for (const keyword of item.metadata?.keywords || item.keywords || []) {
            const text = (typeof keyword === "object" ? keyword.text : keyword)?.toLowerCase();
            if (text) keywordCounts.set(text, (keywordCounts.get(text) || 0) + 1);
          }
        }
      } catch (err) {
        log.warn(`VectFox: Failed to scan keywords from ${collection.id}:`, err);
      }
    }

    browserState.availableKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => ({ text, count }));
    renderKeywordTags();
    log.lifecycle(`VectFox Database Browser: Found ${browserState.availableKeywords.length} keywords`);
  } catch (error) {
    log.error("VectFox: Keyword scan failed", error);
    $tags.html(keywordScanFailedMarkup());
  } finally {
    button.disabled = false;
  }
}

/** The keywords in the filter, lower case. */
function activeKeywords() {
  return browserState.keywordFilter.toLowerCase().split(",").map((k) => k.trim()).filter(Boolean);
}

/** Paints the scanned keywords as buttons; before a scan there are none to paint. */
function renderKeywordTags() {
  if (browserState.availableKeywords === null) return;
  $("#vectfox_keyword_tags").html(keywordTagsMarkup(browserState.availableKeywords, activeKeywords()));
}

/**
 * Adds a keyword to the filter, or drops it.
 * @param {string} keyword
 */
function toggleKeywordFilter(keyword) {
  const keywords = activeKeywords();
  const index = keywords.indexOf(keyword.toLowerCase());
  if (index >= 0) keywords.splice(index, 1);
  else keywords.push(keyword.toLowerCase());
  browserState.keywordFilter = keywords.join(", ");
  $("#vectfox_keyword_filter").val(browserState.keywordFilter);
  renderKeywordTags();
}

/** Empties the keyword filter. */
function clearKeywordFilter() {
  browserState.keywordFilter = "";
  $("#vectfox_keyword_filter").val("");
  renderKeywordTags();
}

/** Takes the keyword filter from its box. */
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
  const filterKeywords = activeKeywords();
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
        (typeof kw === "object" ? kw.text : kw)?.toLowerCase(),
      ).filter(Boolean);

      // A chunk passes when it carries ANY of the filter's keywords.
      if (filterKeywords.some(fk => chunkKeywords.includes(fk))) {
        filteredHashes.push(collectionResults.hashes[i]);
        filteredMetadata.push(metadata);
      }
    }

    if (filteredHashes.length > 0) {
      filtered[collectionId] = { hashes: filteredHashes, metadata: filteredMetadata };
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
  const isEnabledOnly = $("#vectfox_search_enabled_only").is(":checked");

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

  if (isEnabledOnly) {
    collectionIds = collectionIds.filter((id) => browserState.collections.find((c) => c.id === id)?.enabled);
  }

  const $results = $("#vectfox_search_results");
  if (collectionIds.length === 0) {
    $results.html(nothingToSearchMarkup());
    return;
  }

  $("#vectfox_search_btn").prop("disabled", true);
  $results.html(searchRunningMarkup());
  try {
    const results = await queryMultipleCollections(collectionIds, query, topK, threshold, browserState.settings);
    renderSearchResults(filterResultsByKeywords(results), results);
  } catch (error) {
    log.error("VectFox: Search failed", error);
    $results.html(searchFailedMarkup(error.message));
  } finally {
    $("#vectfox_search_btn").prop("disabled", false);
  }
}

/**
 * How many chunks a set of results holds.
 * @param {object} results Results by collection
 * @returns {number}
 */
function countResults(results) {
  return Object.values(results).reduce((sum, collectionResults) => sum + (collectionResults?.hashes?.length || 0), 0);
}

/**
 * One result as plain values, for searchResultsMarkup.
 * @param {string} hash
 * @param {object} metadata
 * @returns {object}
 */
function searchResultView(hash, metadata) {
  const vectorScore = metadata.vectorScore !== undefined ? (metadata.vectorScore * 100).toFixed(0) : null;
  const textScore = metadata.textScore !== undefined ? (metadata.textScore * 100).toFixed(0) : null;
  const text = metadata.text || `[Hash: ${hash}]`;
  const keywords = (metadata.keywords || []).map((kw) => (typeof kw === "object" ? kw.text : kw));
  return {
    score: metadata.score !== undefined ? (metadata.score * 100).toFixed(1) : "?",
    vectorScore,
    textScore,
    // A hybrid search scores meaning and words apart.
    isHybrid: Boolean(metadata.hybridSearch) || (vectorScore !== null && textScore !== null),
    preview: text.length > 200 ? `${text.substring(0, 200)}…` : text,
    keywords: keywords.slice(0, 5),
    moreKeywordCount: Math.max(0, keywords.length - 5),
  };
}

/**
 * Renders search results
 * @param {object} results Results from queryMultipleCollections, after the keyword filter
 * @param {object} originalResults The results before it
 */
function renderSearchResults(results, originalResults) {
  const groups = [];
  for (const [collectionId, collectionResults] of Object.entries(results)) {
    if (!collectionResults?.hashes?.length) continue;
    const collection = browserState.collections.find((c) => c.id === collectionId);
    groups.push({
      key: collection ? collectionKey(collection) : collectionId,
      name: collection?.name || collectionId,
      results: collectionResults.hashes.map((hash, index) => searchResultView(hash, collectionResults.metadata?.[index] || {})),
    });
  }
  const isKeywordFiltered = activeKeywords().length > 0;
  $("#vectfox_search_results").html(searchResultsMarkup({
    groups,
    totalCount: countResults(results),
    countBeforeKeywords: isKeywordFiltered ? countResults(originalResults) : null,
  }));
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
    // A chat id with no character id means a group chat. Character locks can never
    // match there — shouldCollectionActivate() only sees a characterId in a solo
    // chat — so name the reason instead of leaving a dead button unexplained.
    const isGroupChat = Boolean(currentChatId) && !currentCharacterId;
    const charHintText = currentCharacterId
        ? characterLocks.includes(currentCharacterId)
            ? '✓ Already locked to this character'
            : 'Lock this collection to the current character'
        : isGroupChat
            ? 'A group chat has no single active character, so character locks never match here — use a chat lock above.'
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

    const $dialog = $(placeMarkupOnTopmostModalLayer(dialogHtml));

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
