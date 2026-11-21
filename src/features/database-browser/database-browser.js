/**
 * ============================================================================
 * VECTFOX DATABASE BROWSER
 * ============================================================================
 * Browses and manages every vector collection, in three pages: Collections (the
 * filters, the list with each collection's actions, and bulk actions on the
 * ticked ones), Search (a search across collections with a keyword filter) and
 * Size Inspector (size-inspector.js). The Collections list also holds each
 * lorebook's LoreBase rows, its keys and its vectors, each exported, imported and
 * deleted through LoreBase's storage module (features/lorebase), a vectors row's
 * chunks read only in the Chunk Visualizer, each with Edit entry, LoreBase's
 * entry editor, on a row of the list, what LoreBase
 * cannot use here behind Show leftovers; Import a collection takes a collection
 * file, and a LoreBase keys or vectors file into the lorebook it names, and names
 * the row whose Import takes a StoryArc links file. The browser opens in a
 * near-fullscreen dialog of its own
 * (sillytavern/popup.js openPanelPopup), drawn fresh on each open from
 * database-browser-markup.js, and its handlers are delegated on its root. Rename,
 * Switch model and Collection Settings, which opens Manage locks, are dialogs of
 * their own over it (collection-dialogs.js), and so is the Chunk Visualizer that
 * View chunks opens (chunk-visualizer.js).
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
  setCollectionEnabled,
  getCollectionLockCount,
  getCollectionCharacterLockCount,
  exportCollection,
  exportFileKind,
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
import { confirmPopup, openPanelPopup } from "../../sillytavern/popup.js";
import { pickFiles } from "../../shared/pick-files.js";
import { bindGeneBehaviours, scrollPageToTop, setCollapsed } from "../../shared/gui-dna/gene-behaviours.js";
import { COLLECTION_PREFIXES, vectorBackendName } from "../../shared/collection-ids.js";
import {
  STORY_LINKS_FILE_TYPE,
  buildCollectionLinksFile,
  compactCollection,
  deleteStoryLinks,
  describeCompaction,
  describeStoryLinkCoverage,
  describeStoryLinksImport,
  planCollectionCompaction,
  planStoryLinksDelete,
  planStoryLinksImport,
  readCollectionLinkCoverage,
  writeImportedStoryLinks,
} from "../eventbase/index.js";
import {
  KEYS,
  LOREBASE_KEYS_FILE_TYPE,
  LOREBASE_VECTORS_FILE_TYPE,
  VECTORS,
  currentEmbeddingModel,
  deleteStoredRow,
  describeDelete,
  describeExport,
  describeImport,
  describeImported,
  describeRemovedLoreBook,
  editLoreBookEntry,
  exportStored,
  loreBaseImportRow,
  loreBaseStorageRows,
  modelWords,
  nothingToImportText,
  planImport,
  removeLoreBookAfterConfirm,
  tenantChunkSource,
  writeImport,
} from "../lorebase/index.js";
import {
  qdrantTarget,
  queryMultipleCollections,
} from "../vector-backend/index.js";
import { getRequestHeaders } from "../../sillytavern/requests.js";
import { getContext } from "../../sillytavern/chat.js";
import { log } from "../../sillytavern/log.js";
import { openChunkVisualizer } from "./chunk-visualizer.js";
import { mergeSearchPieceResults } from "./search-results-core.js";
import { searchPieces } from "../embedding/index.js";
import { bindSizeInspector } from "./size-inspector.js";
import { editCollectionSettings, renameCollection, switchCollectionModel } from "./collection-dialogs.js";
import { activeLockLine } from "./collection-settings-core.js";
import { formatBytes, utf8ByteLength } from "../../shared/byte-size.js";
import { counted } from "../../shared/counted.js";
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
  loreBaseBookMarkup,
  loreBaseLeftoversMarkup,
  loreBaseProblemMarkup,
  noCollectionsMarkup,
  nothingToSearchMarkup,
  searchFailedMarkup,
  searchFailuresMarkup,
  searchResultsMarkup,
  searchRunningMarkup,
  storyLinksRowMarkup,
} from "./database-browser-markup.js";

const DEFAULT_FILTERS = Object.freeze({
  scope: "all", // 'all', 'character', 'chat': collections locked to at least one of these
  collectionType: "all", // 'all', 'chat'
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
  // LoreBase's rows, each book's keys and vectors (loreBaseStorageRows), as last read, and why the last read failed
  loreBaseRows: [],
  loreBaseProblem: null,
  // Whether the LoreBase leftovers are shown, and the lorebooks whose ⚠ words are open, by their group's key
  isShowingLeftovers: false,
  openLoreBaseFlags: new Set(),
};

const LOREBASE_TOAST = "VectFox LoreBase";
const kindWords = (kind) => (kind === KEYS ? "keys" : "vectors");

// Import a collection's word for each file a row's own Import takes instead.
const ROW_FILE_PLACES = Object.freeze({
  [STORY_LINKS_FILE_TYPE]: "This is a StoryArc links file. Use Import links on its collection's row in this list.",
});

// The kind of each LoreBase file Import a collection takes into the lorebook it names.
const LOREBASE_FILE_KINDS = Object.freeze({
  [LOREBASE_KEYS_FILE_TYPE]: KEYS,
  [LOREBASE_VECTORS_FILE_TYPE]: VECTORS,
});

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
    // Opened first, so the list paints into the dialog.
    const closed = openPanelPopup(root);
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
  browserState.loreBaseRows = [];
  browserState.loreBaseProblem = null;
  browserState.isShowingLeftovers = false;
  browserState.openLoreBaseFlags.clear();
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
  $root.on("click", "[data-lorebase-action]", function () {
    void runLoreBaseAction(this.dataset.lorebaseAction, this.dataset.lorebaseRow);
  });
  $root.on("click", "[data-lorebase-remove]", function () {
    void removeLoreBookOfRow(this.dataset.lorebaseRemove);
  });
  $root.on("click", "[data-lorebase-flag]", function () {
    toggleLoreBaseFlag(this.dataset.lorebaseFlag);
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
    case "toggle-leftovers": return toggleLeftovers();
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

    const kind = exportFileKind(data);
    if (LOREBASE_FILE_KINDS[kind]) {
      await importLoreBaseFileByBook(data, LOREBASE_FILE_KINDS[kind]);
      return;
    }
    if (kind !== "collection") {
      toastr.error(ROW_FILE_PLACES[kind] ?? `This is not a collection file: it holds "${kind}".`, "VectFox Import");
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
 * prefix is persona-scoped: events, archived events and lorebooks, and the
 * character and document ones for a collection start-up could not delete. A
 * collection without a VectFox prefix is always kept.
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
    await loadLoreBaseRows();

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

// The collection types each Type filter keeps. LoreBase keeps no collection: only LoreBase's rows (shownLoreBaseBooks).
const TYPE_FILTER_TYPES = Object.freeze({
  chat: ["chat"],
  lorebase: [],
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
 * Reads LoreBase's rows, each lorebook's keys and vectors as Similharity lists them. A failed read leaves a notice where
 * the rows go, and the collections show as ever.
 * @returns {Promise<void>}
 */
async function loadLoreBaseRows() {
  if (!browserState.pluginAvailable) return;
  try {
    browserState.loreBaseRows = await loreBaseStorageRows(browserState.settings);
    browserState.loreBaseProblem = null;
  } catch (error) {
    log.warn("VectFox Database Browser: LoreBase's keys and vectors could not be read:", error);
    browserState.loreBaseRows = [];
    browserState.loreBaseProblem = String(error?.message || error);
  }
}

/** Reads LoreBase's rows again after one changed, and draws the list. The WorldInfo page counts again as it opens. */
async function refreshLoreBaseRows() {
  await loadLoreBaseRows();
  renderCollections();
}

/**
 * Whether the Collections page's filters show LoreBase's rows: under All types and LoreBase, with no filter on pause,
 * locks or this chat, none of which they have.
 * @returns {boolean}
 */
function isLoreBaseTypeShown() {
  const { scope, collectionType, status, onlyActiveForChat } = browserState.filters;
  return ["all", "lorebase"].includes(collectionType) && scope === "all" && status === "all" && !onlyActiveForChat;
}

// A lorebook's rows share a group: the list's, or the leftovers', of one book, or of one tenant naming none.
const loreBaseGroupKey = (row) => `${row.isLeftover ? "leftovers" : "list"}|${row.book ?? row.tenant}`;

/**
 * The lorebooks whose LoreBase rows the filters keep, each its rows in order: the list's, and the leftovers'. Name or
 * ID keeps a book whose name, or one of whose tenants' IDs, holds the words.
 * @returns {{listed: object[][], leftovers: object[][]}}
 */
function shownLoreBaseBooks() {
  if (!isLoreBaseTypeShown()) return { listed: [], leftovers: [] };
  const books = [];
  for (const row of browserState.loreBaseRows) {
    const last = books.at(-1);
    if (last && loreBaseGroupKey(last[0]) === loreBaseGroupKey(row)) last.push(row);
    else books.push([row]);
  }
  const { searchQuery } = browserState.filters;
  const holds = (value) => String(value ?? "").toLowerCase().includes(searchQuery);
  const kept = searchQuery ? books.filter((rows) => rows.some((row) => holds(row.book) || holds(row.tenant))) : books;
  return { listed: kept.filter(([first]) => !first.isLeftover), leftovers: kept.filter(([first]) => first.isLeftover) };
}

// An embedding model in words, as a row names the one that made its vectors; "" for a row holding none.
const embeddingWords = (row) => (row?.pointCount ? modelWords(row.embeddingSource, row.embeddingModel) : "");

/**
 * What the ⚠ beside a lorebook with no selected entry LoreBase decides says, on hover and opened under its name.
 * @param {boolean} hasVectors
 * @returns {string}
 */
function noSelectionWords(hasVectors) {
  return hasVectors
    ? "No selected entry LoreBase decides: it leaves this lorebook out, and its vectors are erased on the next write. Select its entries on VectFox's WorldInfo page to keep them."
    : "No selected entry LoreBase decides: it leaves this lorebook out. Select its entries on VectFox's WorldInfo page.";
}

/**
 * A lorebook's LoreBase rows as plain values, for loreBaseBookMarkup (§3.2 of vectfox-multi-collection-per-chat.md):
 * the lorebook's row, with its selected entries in the list, where its vectors are stored and their ID, its ⚠ while
 * none of its entries is selected, and Remove from LoreBase on a lorebook of the list, a leftover's rows being deleted
 * one at a time (D13); then each of its rows in one line. Export and Delete need something stored, and so does a
 * vectors row's View chunks; Import needs a row of the list and, for vectors, the collection LoreBase reads now, which
 * an import writes to.
 * @param {object[]} rows - One book's rows, from loreBaseStorageRows
 * @returns {object}
 */
function loreBaseBookView(rows) {
  const [first] = rows;
  const key = loreBaseGroupKey(first);
  const tenantRows = rows.filter((row) => row.kind === VECTORS && row.tenant);
  const shownEmbedding = embeddingWords(tenantRows.find((row) => row.pointCount));
  return {
    key,
    name: `📖 Lorebook: ${first.book ?? "none named"}`,
    bookName: first.book,
    canRemove: !first.isLeftover,
    isInSillyTavern: first.isInSillyTavern,
    selectedCount: first.isLeftover ? null : first.selectedCount,
    selectionCount: first.isLeftover ? null : first.selectionCount,
    storedIn: shownEmbedding ? `Qdrant, embedded by ${shownEmbedding}` : "Qdrant",
    id: tenantRows[0]?.tenant ?? "",
    flag: !first.isLeftover && first.selectedCount === 0 ? noSelectionWords(tenantRows.some((row) => row.pointCount)) : "",
    isFlagOpen: browserState.openLoreBaseFlags.has(key),
    rows: rows.map((row) => {
      const count = row.kind === KEYS ? row.entryCount : row.pointCount;
      return {
        key: row.key,
        kind: row.kind,
        line: row.kind === KEYS ? counted(count, "entry with keys", "entries with keys") : vectorsLine(row, shownEmbedding),
        isElsewhere: row.kind === VECTORS && !row.isHere,
        canViewChunks: row.kind === VECTORS && count > 0,
        canExport: count > 0,
        canImport: !row.isLeftover && (row.kind === KEYS || row.isHere),
        canDelete: count > 0,
      };
    }),
  };
}

/**
 * A Vectors row's line: its parts, the collection when LoreBase does not read it now, and the embedding model when it
 * is not the one its lorebook's row names.
 * @param {object} row
 * @param {string} shownEmbedding - The model the lorebook's row names
 * @returns {string}
 */
function vectorsLine(row, shownEmbedding) {
  const embedding = embeddingWords(row);
  return [
    counted(row.pointCount, "part"),
    row.isHere ? "" : `in ${row.collection}, which LoreBase does not read now`,
    embedding && embedding !== shownEmbedding ? `embedded by ${embedding}` : "",
  ].filter(Boolean).join(", ");
}

/** Shows the LoreBase leftovers, or hides them. */
function toggleLeftovers() {
  browserState.isShowingLeftovers = !browserState.isShowingLeftovers;
  renderCollections();
}

/**
 * Opens a lorebook's ⚠ words under its name, or closes them.
 * @param {string} key The lorebook's group key
 */
function toggleLoreBaseFlag(key) {
  if (browserState.openLoreBaseFlags.has(key)) browserState.openLoreBaseFlags.delete(key);
  else browserState.openLoreBaseFlags.add(key);
  renderCollections();
}

/**
 * Renders the collections list from the current filters, keeps only the shown collections ticked, fills in the
 * StoryArc links rows, and draws LoreBase's rows after the collections, then Show leftovers when there are some.
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
  const { listed: loreBaseBooks, leftovers } = shownLoreBaseBooks();
  const shownLeftovers = browserState.isShowingLeftovers ? leftovers : [];
  const loreBaseProblem = isLoreBaseTypeShown() ? browserState.loreBaseProblem : null;
  updateStats(shown.length, shown.reduce((sum, c) => sum + c.chunkCount, 0), loreBaseBooks.length + shownLeftovers.length);
  paintTicks();

  const container = $("#vectfox_collections_list");
  if (shown.length === 0 && loreBaseBooks.length === 0 && leftovers.length === 0 && !loreBaseProblem) {
    container.html(noCollectionsMarkup());
    return;
  }
  container.html([
    ...shown.map((collection) => collectionEntryMarkup(collectionRowView(collection, isActiveById))),
    ...loreBaseBooks.map((rows) => loreBaseBookMarkup(loreBaseBookView(rows))),
    leftovers.length ? loreBaseLeftoversMarkup({
      lorebookCount: leftovers.length,
      isOpen: browserState.isShowingLeftovers,
      booksMarkup: shownLeftovers.map((rows) => loreBaseBookMarkup(loreBaseBookView(rows))).join(""),
    }) : "",
    loreBaseProblem ? loreBaseProblemMarkup(loreBaseProblem) : "",
  ].join(""));
  if (shown.length) fillStoryLinkRows().catch((err) => log.warn("VectFox: Could not fill in the StoryArc links rows:", err));
}

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
    backend: vectorBackendName(collection.backend),
    embedding: embeddingOfCollection(collection),
    model: hasMultipleModels ? (collection.model || "(default)") : "",
    hasMultipleModels,
    activeHereLine: activeHereLine(collection, isActiveById),
    canCompact: canCompactCollection(collection),
    hasStoryLinks: hasStoryLinksRow(collection),
    storyLinksDescription: browserState.storyLinkDescriptions.get(key) ?? "",
  };
}

/**
 * The embedding model that made a collection's chunks, as its Stored in line names it: the source, and the model's
 * name where the scan knows it; "" when the source is unknown.
 * @param {object} collection
 * @returns {string}
 */
function embeddingOfCollection(collection) {
  const source = collection.source && collection.source !== "unknown" ? collection.source : "";
  const modelName = collection.models?.find((model) => model.path === collection.model)?.name || "";
  return source && modelName ? `${source}/${modelName}` : source;
}

/**
 * Which lock makes a collection active in the current chat, in words, or "" when none does: the kind its scope reads,
 * as isCollectionActiveForContext() reads only that one (activeLockLine). Locks elsewhere show in Collection Settings.
 * @param {object} collection
 * @param {Map<string, boolean>} isActiveById
 * @returns {string}
 */
function activeHereLine(collection, isActiveById) {
  const isActive = isActiveById.get(collection.registryKey || `${collection.backend}:${collection.id}`) === true
    || isActiveById.get(collection.id) === true;
  if (!isActive) return "";
  // Registry-key form, so two collections sharing a bare ID on different backends keep their own locks.
  return activeLockLine({ isCharacterScope: collection.scope !== "chat", chatLockCount: getCollectionLockCount(collectionKey(collection)) });
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
 * Whether Compact collection can clean a collection: one of EventBase events, from a chat or a chat file, in Qdrant,
 * the backend VectFox uses now, which lists each event with its window.
 * @param {object} collection Collection data
 * @returns {boolean}
 */
function canCompactCollection(collection) {
  const id = String(collection.id);
  return browserState.settings?.vector_backend === "qdrant"
    && collection.backend === "qdrant"
    && (id.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) || id.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT));
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
 * Runs one of a LoreBase row's buttons.
 * @param {string} action The button's data-lorebase-action
 * @param {string} key The row's key
 */
async function runLoreBaseAction(action, key) {
  const row = browserState.loreBaseRows.find((each) => each.key === key);
  if (!row) return;
  switch (action) {
    case "view-chunks": return viewLoreBaseChunks(row);
    case "export": return exportLoreBaseRow(row);
    case "import": return importLoreBaseFromPicker(row);
    case "delete": return deleteLoreBaseRow(row);
    default: log.warn(`VectFox Database Browser: no LoreBase row button runs "${action}"`);
  }
}

/**
 * Opens a vectors row's chunks in the Chunk Visualizer, read only, over the browser: LoreBase writes them from the
 * lorebook's entries. On a row of the list, a chunk's Edit entry opens LoreBase's entry editor, whose Save writes the
 * entry and its vectors; a leftover's lorebook is not in SillyTavern, or its vectors not where LoreBase writes them, so
 * its entries are not edited here. Once the visualizer closes after a save, the rows are read again, as an entry's
 * parts may have changed in number. The rows are listed only with Similharity, which the visualizer reads them through.
 * @param {object} row
 * @returns {Promise<void>}
 */
async function viewLoreBaseChunks(row) {
  const { collection, settings } = tenantChunkSource(row, browserState.settings);
  let isEntrySaved = false;
  const editEntry = row.isLeftover ? null : async (chunk) => {
    const isSaved = await editLoreBookEntry(row.book, String(chunk.metadata.entryUid));
    isEntrySaved ||= isSaved;
    return isSaved;
  };
  await openChunkVisualizer(collection, settings, { isLoreBaseParts: true, editEntry });
  if (isEntrySaved) await refreshLoreBaseRows();
}

/**
 * Saves a LoreBase row's keys or vectors to a file, and says how much it holds and what it left out.
 * @param {object} row
 */
async function exportLoreBaseRow(row) {
  try {
    const exported = await exportStored(row, browserState.settings);
    if (!exported.count) {
      toastr.info(`This lorebook has no ${kindWords(row.kind)} to export.`, LOREBASE_TOAST);
      return;
    }
    downloadExport(exported.file, `${row.book ?? row.tenant}-lorebase-${kindWords(row.kind)}`);
    toastr.success(describeExport(row.kind, exported), LOREBASE_TOAST);
  } catch (error) {
    log.error(`VectFox: Export of LoreBase ${kindWords(row.kind)} failed`, error);
    toastr.error(`Export failed: ${error.message}`, LOREBASE_TOAST);
  }
}

/**
 * Picks a LoreBase file and writes it onto a row's lorebook.
 * @param {object} row
 */
async function importLoreBaseFromPicker(row) {
  const [file] = await pickFiles({ accept: ".json" });
  if (!file) return;
  let data;
  try {
    data = await readImportFile(file);
  } catch (error) {
    log.error(`VectFox: Import of LoreBase ${kindWords(row.kind)} failed`, error);
    toastr.error(`Import failed: ${error.message}`, LOREBASE_TOAST);
    return;
  }
  await importLoreBaseData(data, row);
}

/**
 * Writes a LoreBase file Import a collection took into the lorebook the file names (§3.3 of
 * vectfox-multi-collection-per-chat.md): through its row, or the row it would have, so a book with none comes back.
 * @param {object} data The file, parsed
 * @param {string} kind KEYS or VECTORS
 * @returns {Promise<void>}
 */
async function importLoreBaseFileByBook(data, kind) {
  const bookName = typeof data.book?.name === "string" ? data.book.name : "";
  if (!bookName) {
    toastr.error(`This LoreBase ${kindWords(kind)} file names no lorebook. Use Import on the ${kindWords(kind)} row of the lorebook you want it in.`, LOREBASE_TOAST);
    return;
  }
  let row;
  try {
    row = loreBaseImportRow(kind, bookName, browserState.loreBaseRows, browserState.settings);
  } catch (error) {
    log.warn(`VectFox: LoreBase ${kindWords(kind)} file for "${bookName}" not imported:`, error);
    toastr.error(error.message, LOREBASE_TOAST);
    return;
  }
  await importLoreBaseData(data, row);
}

/**
 * Writes a file's keys or vectors onto what matches in a row's lorebook, after showing what that writes and skips.
 * @param {object} data The file, parsed
 * @param {object} row The row it goes to
 * @returns {Promise<void>}
 */
async function importLoreBaseData(data, row) {
  const words = kindWords(row.kind);
  try {
    const plan = await planImport(row, data, browserState.settings);
    if (plan.writes.length === 0) {
      toastr.error(nothingToImportText(row.kind, plan, row.book), LOREBASE_TOAST);
      return;
    }
    const current = currentEmbeddingModel(browserState.settings);
    const isConfirmed = await confirmPopup([
      { text: `Import LoreBase ${words} into this lorebook?` },
      { text: "Lorebook:", name: row.book },
      ...describeImport(row.kind, plan, current).map((sentence) => ({ parts: [{ name: sentence }] })),
      { text: "Saved from:", name: `${data.book?.name ?? "an unnamed lorebook"}, on ${String(data.exportDate ?? "an unknown date").slice(0, 10)}` },
      row.kind === KEYS ? { text: "This makes no LLM call." } : null,
      { text: `Import ${words} writes them. Cancel leaves the lorebook as it is.` },
    ].filter(Boolean), { okButton: `Import ${words}`, isDestructive: true });
    if (!isConfirmed) return;

    const outcome = await writeImport(plan, browserState.settings);
    if (outcome.failed) toastr.warning(describeImported(row.kind, outcome, row.book), LOREBASE_TOAST);
    else toastr.success(describeImported(row.kind, outcome, row.book), LOREBASE_TOAST);
    await refreshLoreBaseRows();
  } catch (error) {
    log.error(`VectFox: Import of LoreBase ${words} failed`, error);
    toastr.error(`Import failed: ${error.message}`, LOREBASE_TOAST);
  }
}

/**
 * Deletes a LoreBase row's keys or vectors, after showing what is lost and what follows.
 * @param {object} row
 * @returns {Promise<void>}
 */
async function deleteLoreBaseRow(row) {
  const words = kindWords(row.kind);
  const { lost, after } = describeDelete(row);
  const isConfirmed = await confirmPopup([
    { text: `Delete the LoreBase ${words} of this lorebook?` },
    { text: "Lorebook:", name: row.book ?? row.tenant },
    { text: "Lost:", name: lost },
    { text: after },
    { text: `Delete ${words} deletes them. Cancel keeps them.` },
  ], { okButton: `Delete ${words}`, isDestructive: true });
  if (!isConfirmed) return;

  try {
    const deletedCount = await deleteStoredRow(row, browserState.settings);
    toastr.success(row.kind === KEYS
      ? `Deleted the keys of ${counted(deletedCount, "entry", "entries")}`
      : `Deleted the vectors of ${counted(deletedCount, "part")}`, LOREBASE_TOAST);
    await refreshLoreBaseRows();
  } catch (error) {
    log.error(`VectFox: Delete of LoreBase ${words} failed`, error);
    toastr.error(`Delete failed: ${error.message}`, LOREBASE_TOAST);
  }
}

/**
 * Removes a lorebook from LoreBase, from its row (removeLoreBookAfterConfirm, the WorldInfo page's book row's too): once
 * confirmed and done, a toast says what went, and the rows are read again, so the lorebook leaves the list.
 * @param {string} bookName
 * @returns {Promise<void>}
 */
async function removeLoreBookOfRow(bookName) {
  try {
    const removed = await removeLoreBookAfterConfirm(bookName, browserState.settings);
    if (!removed) return;
    toastr.success(describeRemovedLoreBook(removed), LOREBASE_TOAST);
    await refreshLoreBaseRows();
  } catch (error) {
    log.error(`VectFox: Remove of lorebook "${bookName}" from LoreBase failed`, error);
    toastr.error(`Remove failed: ${error.message}`, LOREBASE_TOAST);
  }
}

/**
 * Helper to find collection by its unique key (registryKey or id)
 */
function findCollectionByKey(key) {
  return browserState.collections.find((c) => collectionKey(c) === key);
}

/**
 * Runs one of a collection's buttons. Rename and Collection Settings take the registry key form (backend:id), so the
 * metadata layer keys names, locks and activation per backend.
 * @param {string} action The button's data-collection-action
 * @param {string} key The collection's key
 */
async function runCollectionAction(action, key) {
  const collection = findCollectionByKey(key);
  if (!collection) return;
  switch (action) {
    case "toggle": return toggleCollection(collection);
    case "rename":
      if (await renameCollection(collectionKey(collection), collection.name)) await refreshCollections();
      return;
    case "settings":
      if (await editCollectionSettings(collectionKey(collection), collection.name)) renderCollections();
      return;
    case "switch-model":
      if (collection.models?.length > 1 && await switchCollectionModel(collection)) renderCollections();
      return;
    case "view-chunks": return viewCollectionChunks(collection);
    case "export-json": return exportCollectionJson(collection);
    case "export-png": return exportCollectionPng(collection);
    case "compact": return compactOneCollection(key);
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
 * Compacts one EventBase collection, after showing what it removes: the events a window holds from readings before its
 * newest one. The row then shows the collection's new count.
 * @param {string} key The collection whose Compact collection button was pressed
 * @returns {Promise<void>}
 */
async function compactOneCollection(key) {
  const collection = findCollectionByKey(key);
  if (!collection) return;
  try {
    const plan = await planCollectionCompaction(collection.id, browserState.settings);
    if (plan.repeats.length === 0) {
      toastr.info("This collection has nothing to compact.", "VectFox");
      return;
    }

    const isConfirmed = await confirmPopup([
      { text: "Compact this collection?" },
      { text: "Collection:", name: collection.name },
      ...describeCompaction(plan).map((sentence) => ({ parts: [{ name: sentence }] })),
      { text: "This makes no LLM call, and it cannot be undone. Export the collection first to keep a copy." },
      { text: "Compact removes them. Cancel keeps them." },
    ], { okButton: "Compact", isDestructive: true });
    if (!isConfirmed) return;

    const { removedCount } = await compactCollection(plan, collection.id, browserState.settings);
    if (removedCount === 0) {
      toastr.warning("Nothing was removed, as the StoryArc links did not all move. Press Compact collection again to finish.", "VectFox");
      return;
    }
    collection.chunkCount = Math.max(0, collection.chunkCount - removedCount);
    browserState.storyLinkCoverage.delete(key);
    browserState.storyLinkDescriptions.delete(key);
    renderCollections();
    document.dispatchEvent(new CustomEvent("vectfox:collections-updated"));
    toastr.success(`Removed ${counted(removedCount, "repeated event")} from ${collection.name}`, "VectFox");
  } catch (error) {
    log.error("VectFox: Compact collection failed", error);
    toastr.error(`Compact collection failed: ${error.message}`, "VectFox");
  }
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
    // The settings panel re-checks its auto-sync checkbox on this event; the
    // deleted collection may have been what kept it on.
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
 * Paints the page header's counts; the lorebooks' only while LoreBase rows are shown.
 * @param {number} collectionCount Number of collections shown
 * @param {number} chunkCount Total chunks
 * @param {number} loreBookCount Number of lorebooks whose LoreBase rows are shown
 */
function updateStats(collectionCount, chunkCount, loreBookCount) {
  $('[data-browser-count="collections"]').text(`${collectionCount} collection${collectionCount === 1 ? "" : "s"}`);
  $('[data-browser-count="chunks"]').text(`${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`);
  $('[data-browser-count="lorebooks"]').text(counted(loreBookCount, "lorebook")).toggle(loreBookCount > 0);
}

/**
 * Open a collection's chunks in the Chunk Visualizer, over the browser.
 * Opened by View chunks on the Collections page and on each Search result.
 */
function viewCollectionChunks(collection) {
  if (!collection.backend) {
    toastr.error("This collection names no backend, so its chunks cannot be read. The console has its details.", "VectFox");
    log.error("VectFox: Collection missing backend:", collection);
    return;
  }
  if (!browserState.pluginAvailable) {
    toastr.warning("Viewing chunks needs the Similharity plugin. Install it to read them.", "VectFox", { timeOut: 6000 });
    return;
  }
  void openChunkVisualizer(collection, { ...browserState.settings, vector_backend: collection.backend });
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
        const target = collection.backend === "qdrant"
          ? qdrantTarget(collection.id, browserState.settings)
          : { collectionId: collection.id, filters: {} };
        const response = await fetch("/api/plugins/similharity/chunks/list", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({
            backend: collection.backend || "vectra",
            collectionId: target.collectionId,
            filters: target.filters,
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
    // A query over the embedding provider's piece size is searched in pieces, merged to one result per hash.
    const pieceResults = await Promise.all(searchPieces(query, browserState.settings)
      .map((piece) => queryMultipleCollections(collectionIds, piece, topK, threshold, browserState.settings)));
    const results = mergeSearchPieceResults(pieceResults, topK);
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
  // A collection whose query failed carries an error and no hits: it was not searched, which is not "nothing matched".
  const failures = Object.entries(originalResults)
    .filter(([, collectionResults]) => collectionResults?.error)
    .map(([collectionId, collectionResults]) => ({
      name: browserState.collections.find((c) => c.id === collectionId)?.name || collectionId,
      reason: collectionResults.error,
    }));
  if (failures.length > 0 && failures.length === Object.keys(originalResults).length) {
    $("#vectfox_search_results").html(searchFailedMarkup(failures[0].reason));
    return;
  }
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
  $("#vectfox_search_results").html(searchFailuresMarkup(failures) + searchResultsMarkup({
    groups,
    totalCount: countResults(results),
    countBeforeKeywords: isKeywordFiltered ? countResults(originalResults) : null,
  }));
}
