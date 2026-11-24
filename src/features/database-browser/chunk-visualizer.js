/**
 * ============================================================================
 * CHUNK VISUALIZER
 * ============================================================================
 * A collection's events, read and edited in their own dialog over the Database
 * Browser (chunk-visualizer-markup.js draws it, chunk-visualizer-core.js holds
 * its rules). It loads them from Similharity and lists them by the search,
 * filter and order chosen; one opens in a form that one Save writes, embedding
 * the text again first when it changed. Leaving one or closing with unsaved
 * edits asks first. Ticked ones are deleted together. The backend payload holds
 * every field. A Qdrant collection made with another CJK tokenizer than VectFox
 * is set to takes no new vector, so there the text is locked. A lorebook's
 * LoreBase parts open read only, in their entries' order: LoreBase writes them
 * from the entries, and an edit here would leave them out of step. Where the
 * browser gives an entry editor, a part's Edit entry opens it on the part's
 * entry, and a save reads the list again, the same part open.
 * ============================================================================
 */

import { deleteVectorItems, describeEmbeddingFailure, insertVectorItems, qdrantTarget, textWithoutKeywordSuffix, updateChunkMetadata } from '../vector-backend/index.js';
import { announceEventsRemoved, eventPointHash, packTimelineSortKey } from '../eventbase/index.js';
import { languageModeLabel } from '../keyword-search/index.js';
import { getStringHash } from '../../sillytavern/identifiers.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { log } from '../../sillytavern/log.js';
import { confirmPopup, openPanelPopup } from '../../sillytavern/popup.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import {
    CHUNK_SORTS,
    LIST_PAGE_SIZE,
    LOREBASE_PART_SORTS,
    chunkLabel,
    chunkTitle,
    collectionRecordLines,
    eventFields,
    formChanges,
    isLoreBasePart,
    loreBasePartPlace,
    originLine,
    reopenedChunk,
    saveProblem,
    savedChunkFields,
    tokenizerLockOf,
    visibleChunks,
} from './chunk-visualizer-core.js';
import {
    VISUALIZER_IDS as ids,
    chunkFormMarkup,
    chunkRowMarkup,
    chunkVisualizerMarkup,
    chunksFailedMarkup,
    chunksLoadingMarkup,
    collectionRecordMarkup,
    listFooterMarkup,
    noChunkOpenMarkup,
    noChunksMarkup,
    noMatchingChunksMarkup,
    tokenizerLockMarkup,
} from './chunk-visualizer-markup.js';
import { counted } from '../../shared/counted.js';

/** The list's order and filter, and how many chunks a load asks for (0 for all), kept from one opening to the next. */
const listChoices = { sort: 'index', filter: 'all', fetchLimit: 0 };

/** How long the search waits after the last key before it filters. */
const SEARCH_DELAY_MS = 200;

const formatCount = count => Number(count).toLocaleString('en-US');

/**
 * Open a collection's chunks over the Database Browser and load them, or a lorebook's LoreBase parts, read only.
 * Resolves when the visualizer closes; never throws.
 *
 * @param {{id: string, name?: string, type?: string, backend?: string, source?: string, model?: string,
 *   chunkCount?: number}} collection
 * @param {object} settings - VectFox's settings, with the collection's backend as `vector_backend`
 * @param {{isLoreBaseParts?: boolean, editEntry?: ((chunk: object) => Promise<boolean>)|null}} [options] -
 *   isLoreBaseParts: the collection is a lorebook's LoreBase parts; editEntry: opens the editor of a part's entry, and
 *   answers whether it saved, null where the entries cannot be edited
 * @returns {Promise<void>}
 */
export async function openChunkVisualizer(collection, settings, { isLoreBaseParts = false, editEntry = null } = {}) {
    const sorts = isLoreBaseParts ? LOREBASE_PART_SORTS : CHUNK_SORTS;
    const session = {
        collection,
        settings,
        isLoreBaseParts,
        editEntry,
        // The list's order, kept from the last opening when this list offers it; LoreBase parts have no filter.
        sort: sorts.some(({ value }) => value === listChoices.sort) ? listChoices.sort : 'index',
        filter: isLoreBaseParts ? 'all' : listChoices.filter,
        chunks: [],
        totalCount: null,
        query: '',
        shownLimit: LIST_PAGE_SIZE,
        matchingKeys: [],
        tickedKeys: new Set(),
        openKey: null,
        draft: null,
        isBusy: false,
        isAsking: false,
        loadCount: 0,
        tokenizerLock: null,
    };
    const template = document.createElement('template');
    template.innerHTML = chunkVisualizerMarkup({
        collectionName: collection.name || collection.id,
        collectionType: collection.type,
        fetchLimit: listChoices.fetchLimit,
        isLoreBaseParts,
    });
    const root = template.content.firstElementChild;
    root.querySelector(`#${ids.sort}`).value = session.sort;
    if (!isLoreBaseParts) root.querySelector(`#${ids.filter}`).value = session.filter;
    bindGeneBehaviours(root);
    bindVisualizer(root, session);

    const closed = openPanelPopup(root, { canClose: () => (session.isBusy ? true : confirmLeavingChunk(root, session)) });
    void loadChunks(root, session);
    // The record is the Qdrant collection's, which holds every lorebook's parts, and its tokenizer locks only an edit.
    if (!isLoreBaseParts) void showCollectionRecord(root, session);
    await closed;
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The chunks Similharity lists for a collection, with how many the collection holds.
 *
 * @param {object} collection
 * @param {number} limit - 0 for all
 * @param {object} settings - VectFox settings, for where a Qdrant collection's points are
 * @returns {Promise<{items: object[], total: number}>}
 */
async function fetchChunks(collection, limit, settings) {
    const target = collection.backend === 'qdrant' ? qdrantTarget(collection.id, settings) : { collectionId: collection.id, filters: {} };
    const response = await fetch('/api/plugins/similharity/chunks/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: collection.backend || 'vectra',
            collectionId: target.collectionId,
            filters: target.filters,
            source: collection.source || 'transformers',
            model: collection.model || '',
            ...(limit ? { limit } : {}),
        }),
    });
    if (!response.ok) throw new Error(`Similharity answered ${response.status} ${response.statusText}`);
    const data = await response.json();
    const items = data.items || data.chunks || data.results || [];
    const total = Number(data.total ?? data.totalCount ?? data.count ?? collection.chunkCount ?? items.length);
    return { items, total: Number.isFinite(total) ? total : items.length };
}

/**
 * A chunk's place in the list's first order: a LoreBase part's by its entry and part; else its place in the chat's
 * history, its timeline key, else its message number on the same scale.
 */
function placeValueOf(chunk) {
    if (isLoreBasePart(chunk)) return loreBasePartPlace(chunk);
    const payload = chunk.metadata;
    if (typeof payload.timeline_sort_key === 'number') return payload.timeline_sort_key;
    return packTimelineSortKey(payload.source_window_start ?? payload.source_window_end ?? chunk.index ?? 0, 0);
}

function loadedChunk(item, position) {
    const chunk = {
        key: String(position),
        hash: item.hash,
        index: item.index !== undefined && item.index !== null && item.index >= 0 ? item.index : position,
        // The text as written: Qdrant storage appends the keywords, which the row counts.
        text: textWithoutKeywordSuffix(String(item.text || item.metadata?.text || '')),
        metadata: { ...(item.metadata || {}) },
    };
    chunk.fields = savedChunkFields(chunk);
    chunk.placeValue = placeValueOf(chunk);
    return chunk;
}

async function loadChunks(root, session) {
    const loadNumber = ++session.loadCount;
    const previouslyOpen = openChunkOf(session);
    root.querySelector(`#${ids.list}`).innerHTML = chunksLoadingMarkup();
    root.querySelector(`#${ids.listFooter}`).innerHTML = '';
    try {
        const { items, total } = await fetchChunks(session.collection, listChoices.fetchLimit, session.settings);
        if (loadNumber !== session.loadCount) return;
        session.chunks = items.map(loadedChunk);
        session.totalCount = total;
        session.tickedKeys.clear();
        session.shownLimit = LIST_PAGE_SIZE;
        session.openKey = reopenedChunk(session.chunks, previouslyOpen)?.key ?? null;
        paintChunkCount(root, session);
        renderList(root, session);
        renderPane(root, session);
    } catch (error) {
        if (loadNumber !== session.loadCount) return;
        log.error('VectFox Chunk Visualizer: the chunks could not be loaded:', error);
        root.querySelector(`#${ids.list}`).innerHTML = chunksFailedMarkup(error.message);
    }
}

/**
 * The collection's own Qdrant record under the list, when it has one, and the lock on what Similharity would refuse
 * when the record names another CJK tokenizer than VectFox is set to.
 */
async function showCollectionRecord(root, session) {
    if ((session.settings?.vector_backend || 'standard') !== 'qdrant') return;
    // The record sits on the Qdrant collection itself, which with "One shared collection" on is vectfox_main.
    const { collectionId } = qdrantTarget(String(session.collection.id), session.settings);
    try {
        const response = await fetch('/api/plugins/similharity/chunks/collection-metadata', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backend: 'qdrant', collectionId }),
        });
        if (!response.ok) {
            log.verbose(`VectFox Chunk Visualizer: no collection record for ${collectionId} (${response.status})`);
            return;
        }
        const payload = (await response.json())?.payload;
        session.tokenizerLock = tokenizerLockOf(payload, session.settings.cjk_tokenizer_mode);
        paintTokenizerLock(root, session);
        refreshFormState(root, session);
        const lines = collectionRecordLines(payload, languageModeLabel);
        if (!lines.length) return;
        const record = root.querySelector(`#${ids.record}`);
        record.innerHTML = collectionRecordMarkup(lines);
        record.hidden = false;
    } catch (error) {
        log.warn('VectFox Chunk Visualizer: the collection record could not be read:', error);
    }
}

// ── List ──────────────────────────────────────────────────────────────────────────────────────────────

const chunkByKey = (session, key) => session.chunks.find(chunk => chunk.key === key) ?? null;
const openChunkOf = session => (session.openKey === null ? null : chunkByKey(session, session.openKey));

function paintChunkCount(root, session) {
    const loaded = session.chunks.length;
    const total = session.totalCount ?? loaded;
    root.querySelector('[data-chunk-count]').textContent = loaded < total
        ? `${formatCount(loaded)} of ${formatCount(total)} chunks loaded`
        : `${formatCount(total)} ${total === 1 ? 'chunk' : 'chunks'}`;
}

function rowView(chunk, session) {
    return {
        key: chunk.key,
        title: chunkTitle(chunk),
        origin: originLine(chunk),
        characterCount: chunk.fields.text.length,
        keywordCount: chunk.fields.keywords.length,
        isOpen: chunk.key === session.openKey,
        isTicked: session.tickedKeys.has(chunk.key),
        isReadOnly: session.isLoreBaseParts,
    };
}

function renderList(root, session) {
    const matching = visibleChunks(session.chunks, { query: session.query, filter: session.filter, sort: session.sort });
    session.matchingKeys = matching.map(chunk => chunk.key);
    // A chunk the search or filter hides is no longer ticked, so a bulk action never reaches what the list does not show.
    const matchingKeys = new Set(session.matchingKeys);
    for (const key of session.tickedKeys) if (!matchingKeys.has(key)) session.tickedKeys.delete(key);

    const shown = matching.slice(0, session.shownLimit);
    let listMarkup = shown.map(chunk => chunkRowMarkup(rowView(chunk, session))).join('');
    if (!session.chunks.length) listMarkup = noChunksMarkup();
    else if (!matching.length) listMarkup = noMatchingChunksMarkup();
    root.querySelector(`#${ids.list}`).innerHTML = listMarkup;
    root.querySelector(`#${ids.listFooter}`).innerHTML = listFooterMarkup({
        shownCount: shown.length,
        matchCount: matching.length,
        hasMore: matching.length > shown.length,
    });
    paintBulkBar(root, session);
}

/** Mark the open chunk's row, by class: cheaper than painting the list again. */
function markOpenRow(root, session) {
    for (const entry of root.querySelectorAll('[data-chunk-entry]')) {
        const isOpen = entry.dataset.chunkEntry === session.openKey;
        entry.classList.toggle('is-open', isOpen);
        if (isOpen) entry.setAttribute('aria-current', 'true');
        else entry.removeAttribute('aria-current');
    }
}

function paintBulkBar(root, session) {
    if (session.isLoreBaseParts) return;
    const tickedCount = session.tickedKeys.size;
    root.querySelector('[data-chunk-bulk-count]').textContent = `${tickedCount} selected`;
    root.querySelector('[data-chunk-action="bulk-delete"]').disabled = tickedCount === 0 || session.isBusy;
    const selectAll = root.querySelector(`#${ids.selectAll}`);
    const matchingCount = session.matchingKeys.length;
    selectAll.checked = matchingCount > 0 && tickedCount === matchingCount;
    selectAll.indeterminate = tickedCount > 0 && tickedCount < matchingCount;
    selectAll.disabled = matchingCount === 0;
}

// ── Chunk form ────────────────────────────────────────────────────────────────────────────────────────

function renderPane(root, session) {
    const pane = root.querySelector(`#${ids.pane}`);
    const chunk = openChunkOf(session);
    if (!chunk) {
        session.openKey = null;
        session.draft = null;
        pane.innerHTML = noChunkOpenMarkup(session.isLoreBaseParts);
        markOpenRow(root, session);
        return;
    }
    pane.innerHTML = chunkFormMarkup({
        number: Number(chunk.key) + 1,
        hash: chunk.hash,
        origin: originLine(chunk),
        fields: chunk.fields,
        event: eventFields(chunk),
        isLoreBasePart: session.isLoreBaseParts,
        title: chunkTitle(chunk),
        canEditEntry: Boolean(session.editEntry) && isLoreBasePart(chunk),
    });
    pane.querySelector('.vfx-card-body').scrollTop = 0;
    markOpenRow(root, session);
    if (session.isLoreBaseParts) root.querySelector(`#${ids.text}`).readOnly = true;
    else paintTokenizerLock(root, session);
    refreshFormState(root, session);
}

/**
 * In a collection whose new vectors Similharity refuses, the open chunk's text is locked, under a warning that names
 * both CJK tokenizers.
 */
function paintTokenizerLock(root, session) {
    const slot = root.querySelector('[data-chunk-tokenizer-notice]');
    if (!slot) return;
    const lock = session.tokenizerLock;
    slot.innerHTML = lock ? tokenizerLockMarkup({ madeWith: languageModeLabel(lock.madeWith), setTo: languageModeLabel(lock.setTo) }) : '';
    slot.hidden = !lock;
    root.querySelector(`#${ids.text}`).readOnly = Boolean(lock);
}

function readForm(root) {
    const value = id => root.querySelector(`#${id}`)?.value ?? '';
    return { name: value(ids.name), text: value(ids.text) };
}

function changesOf(root, session) {
    const chunk = openChunkOf(session);
    return chunk ? formChanges(chunk.fields, readForm(root)) : null;
}

/**
 * Save and Delete as the form allows, and the lines that say what the form holds; a LoreBase part has only its size,
 * and Edit entry while nothing is being written.
 */
function refreshFormState(root, session) {
    const changes = changesOf(root, session);
    if (!changes) return;
    const pane = root.querySelector(`#${ids.pane}`);
    const characters = root.querySelector(`#${ids.text}`).value.trim().length;
    pane.querySelector('[data-chunk-text-count]').textContent = `${formatCount(characters)} ${characters === 1 ? 'character' : 'characters'}.`;
    if (session.isLoreBaseParts) {
        const editButton = pane.querySelector('[data-chunk-action="edit-entry"]');
        if (editButton) editButton.disabled = session.isBusy;
        return;
    }
    const problem = saveProblem(changes, session.tokenizerLock);
    pane.querySelector('[data-chunk-save-state]').textContent = problem || (changes.hasChanges ? 'Unsaved changes.' : 'No changes.');
    pane.querySelector('[data-chunk-action="save"]').disabled = session.isBusy || !changes.hasChanges || Boolean(problem);
    pane.querySelector('[data-chunk-action="delete"]').disabled = session.isBusy;
}

/**
 * Whether the open chunk may be left: yes when it holds no unsaved edit, else when the user discards them.
 *
 * @returns {Promise<boolean>}
 */
async function confirmLeavingChunk(root, session) {
    if (!changesOf(root, session)?.hasChanges) return true;
    // Escape can ask again while the question is open; the open question answers.
    if (session.isAsking) return false;
    session.isAsking = true;
    try {
        return Boolean(await confirmPopup([
            { text: 'Leave this chunk without saving?' },
            { text: 'Chunk:', name: chunkLabel(openChunkOf(session)) },
            { text: 'Lost: the edits made since it was opened or last saved.' },
            { text: 'Discard leaves it as saved. Cancel goes back to it.' },
        ], { okButton: 'Discard', isDestructive: true }));
    } finally {
        session.isAsking = false;
    }
}

async function openChunk(root, session, key) {
    if (key === session.openKey || session.isBusy || !chunkByKey(session, key)) return;
    if (!(await confirmLeavingChunk(root, session))) return;
    session.openKey = key;
    renderPane(root, session);
    // On a phone the panes stack, so the chunk scrolls into view under the list.
    const pane = root.querySelector(`#${ids.pane}`);
    if (getComputedStyle(root.querySelector(`#${ids.split}`)).flexDirection === 'column') pane.scrollIntoView({ block: 'start' });
}

// ── Saving ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Store one chunk's vector. A failure is an embedding failure, read for the person who pressed Save: whether saving
 * again can work.
 */
async function insertChunkVector(session, item) {
    try {
        await insertVectorItems(session.collection.id, [item], session.settings);
    } catch (error) {
        throw Object.assign(new Error(error?.message ?? String(error), { cause: error }), { embeddingFailure: describeEmbeddingFailure(error) });
    }
}

/**
 * The ID a chunk with this text is stored under: an EventBase event keeps the one EventBase gives it from its event ID,
 * so its new text replaces it in place and a later read of its window replaces it again, never adding a second copy;
 * anything without an event ID takes its ID from its text.
 */
function storedHashFor(metadata, text) {
    const eventId = metadata.event_id;
    return typeof eventId === 'string' && eventId !== '' ? eventPointHash(eventId) : getStringHash(text);
}

/** Write a chunk whose text is unchanged: the payload fields the form changed. */
async function writeChunkChanges(session, chunk, changes) {
    if (!Object.keys(changes.payload).length) return;
    await updateChunkMetadata(session.collection.id, chunk.hash, changes.payload, session.settings);
    chunk.metadata = { ...chunk.metadata, ...changes.payload };
}

/**
 * Write a chunk whose text changed: the text embedded under the ID storedHashFor gives, with every field it keeps and
 * the form's changes; then a copy under another ID goes. The new text goes in first, so a failed embedding leaves the
 * stored chunk as it was, and a later failure leaves both, never neither.
 */
async function reembedChunk(session, chunk, changes) {
    const { collection, settings } = session;
    const oldHash = chunk.hash;
    const metadata = { ...chunk.metadata, ...changes.payload };
    for (const field of ['hash', 'text']) delete metadata[field];
    const newHash = storedHashFor(metadata, changes.text);

    await insertChunkVector(session, { hash: newHash, text: changes.text, index: chunk.index, metadata });
    Object.assign(chunk, { hash: newHash, text: changes.text, metadata });

    if (String(newHash) !== String(oldHash)) {
        try {
            await deleteVectorItems(collection.id, [oldHash], settings);
        } catch (error) {
            throw new Error(`the new text is saved, but the old copy is still in the collection: ${error.message}`, { cause: error });
        }
    }
}

function setBusy(root, session, isBusy) {
    session.isBusy = isBusy;
    paintBulkBar(root, session);
    refreshFormState(root, session);
    for (const control of root.querySelectorAll('[data-chunk-action="reload"]')) control.disabled = isBusy;
}

async function saveOpenChunk(root, session) {
    const chunk = openChunkOf(session);
    const changes = changesOf(root, session);
    if (!chunk || !changes?.hasChanges || saveProblem(changes, session.tokenizerLock) || session.isBusy) return;
    setBusy(root, session, true);
    let isSaved = false;
    try {
        if (changes.text !== null) await reembedChunk(session, chunk, changes);
        else await writeChunkChanges(session, chunk, changes);
        isSaved = true;
        const how = changes.text !== null ? ', embedded again' : '';
        log.lifecycle(`VectFox Chunk Visualizer: saved chunk ${chunk.hash} of ${session.collection.id}${how}`);
    } catch (error) {
        log.error('VectFox Chunk Visualizer: a chunk could not be saved:', error);
        const failure = error.embeddingFailure;
        if (failure) {
            toastr.error(`The chunk was not saved. ${failure.advice} Embedding error: ${failure.detail}`, 'VectFox — chunk not saved', { timeOut: 0, extendedTimeOut: 0 });
        } else {
            toastr.error(`The chunk was not saved: ${error.message}`, 'VectFox');
        }
    } finally {
        // What is saved now, as far as the save got; the form keeps any edit it did not write.
        chunk.fields = savedChunkFields(chunk);
        chunk.placeValue = placeValueOf(chunk);
        setBusy(root, session, false);
    }
    renderList(root, session);
    if (isSaved) renderPane(root, session);
    else refreshFormState(root, session);
}

// ── Deleting and bulk actions ─────────────────────────────────────────────────────────────────────────

/** Delete chunks' vectors. The IDs of the EventBase events among them go to EventBase's listener. */
async function deleteChunks(session, chunks) {
    await deleteVectorItems(session.collection.id, chunks.map(chunk => chunk.hash), session.settings);
    const eventIds = chunks.map(chunk => chunk.metadata?.event_id).filter(eventId => typeof eventId === 'string' && eventId !== '');
    announceEventsRemoved(session.collection.id, eventIds);
    const deletedKeys = new Set(chunks.map(chunk => chunk.key));
    session.chunks = session.chunks.filter(chunk => !deletedKeys.has(chunk.key));
    for (const key of deletedKeys) session.tickedKeys.delete(key);
    if (deletedKeys.has(session.openKey)) session.openKey = null;
    if (session.totalCount !== null) session.totalCount = Math.max(0, session.totalCount - chunks.length);
}

async function deleteOpenChunk(root, session) {
    const chunk = openChunkOf(session);
    if (!chunk || session.isBusy) return;
    const isConfirmed = await confirmPopup([
        { text: 'Delete this chunk?' },
        { text: 'Chunk:', name: chunkLabel(chunk) },
        { text: 'Lost: its text and its vector. It cannot be undone.' },
        { text: 'Delete removes it. Cancel keeps it.' },
    ], { okButton: 'Delete', isDestructive: true });
    if (!isConfirmed) return;
    await runDeletion(root, session, [chunk]);
}

async function bulkDelete(root, session) {
    const targets = session.chunks.filter(chunk => session.tickedKeys.has(chunk.key));
    if (!targets.length || session.isBusy) return;
    const named = targets.slice(0, 3).map(chunkLabel).join('; ');
    const isConfirmed = await confirmPopup([
        { text: `Delete ${counted(targets.length, 'chunk')}?` },
        { text: 'Chunks:', name: targets.length > 3 ? `${named}; and ${targets.length - 3} more` : named },
        { text: 'Lost: their text and vectors. It cannot be undone.' },
        { text: 'Delete removes them. Cancel keeps them.' },
    ], { okButton: 'Delete', isDestructive: true });
    if (!isConfirmed) return;
    await runDeletion(root, session, targets);
}

async function runDeletion(root, session, chunks) {
    setBusy(root, session, true);
    try {
        await deleteChunks(session, chunks);
        log.lifecycle(`VectFox Chunk Visualizer: deleted ${counted(chunks.length, 'chunk')} from ${session.collection.id}`);
    } catch (error) {
        log.error('VectFox Chunk Visualizer: chunks could not be deleted:', error);
        toastr.error(`Nothing was deleted: ${error.message}`, 'VectFox');
    } finally {
        setBusy(root, session, false);
    }
    paintChunkCount(root, session);
    renderList(root, session);
    if (!openChunkOf(session)) renderPane(root, session);
}

// ── Editing a LoreBase part's entry ───────────────────────────────────────────────────────────────────

/**
 * Open the editor of the open LoreBase part's entry, the visualizer waiting meanwhile; once it saves, which writes the
 * entry's vectors again, read the list again with the same part open.
 */
async function editOpenEntry(root, session) {
    const chunk = openChunkOf(session);
    if (!chunk || session.isBusy || !session.editEntry) return;
    setBusy(root, session, true);
    let isSaved = false;
    try {
        isSaved = await session.editEntry(chunk);
    } catch (error) {
        log.error('VectFox Chunk Visualizer: the entry editor failed:', error);
        toastr.error(`The entry editor failed: ${error.message}`, 'VectFox');
    } finally {
        setBusy(root, session, false);
    }
    if (isSaved) await loadChunks(root, session);
}

// ── Events ────────────────────────────────────────────────────────────────────────────────────────────

function runAction(root, session, button) {
    switch (button.dataset.chunkAction) {
        case 'open': return openChunk(root, session, button.dataset.chunkKey);
        case 'reload': return reloadChunks(root, session);
        case 'show-more':
            session.shownLimit += LIST_PAGE_SIZE;
            return renderList(root, session);
        case 'bulk-delete': return bulkDelete(root, session);
        case 'save': return saveOpenChunk(root, session);
        case 'delete': return deleteOpenChunk(root, session);
        case 'edit-entry': return editOpenEntry(root, session);
        default: return undefined;
    }
}

async function reloadChunks(root, session) {
    if (session.isBusy || !(await confirmLeavingChunk(root, session))) return;
    await loadChunks(root, session);
}

function bindVisualizer(root, session) {
    let searchTimer = 0;
    root.addEventListener('click', (event) => {
        const actionButton = event.target.closest('[data-chunk-action]');
        if (actionButton && root.contains(actionButton)) {
            if (!actionButton.disabled) void runAction(root, session, actionButton);
            return;
        }
        // A click on a row's words opens it, as its Open button does.
        const row = event.target.closest('.vfx-pick-body .vfx-row[data-chunk-key]');
        if (row && !event.target.closest('a, button, input, label, select, textarea')) void openChunk(root, session, row.dataset.chunkKey);
    });

    root.addEventListener('input', (event) => {
        const { target } = event;
        if (target.id === ids.search) {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                session.query = target.value;
                session.shownLimit = LIST_PAGE_SIZE;
                renderList(root, session);
            }, SEARCH_DELAY_MS);
            return;
        }
        if (target.closest(`#${ids.pane}`)) refreshFormState(root, session);
    });

    root.addEventListener('change', (event) => {
        const { target } = event;
        if (target.id === ids.sort || target.id === ids.filter) {
            const choice = target.id === ids.sort ? 'sort' : 'filter';
            session[choice] = target.value;
            listChoices[choice] = target.value;
            session.shownLimit = LIST_PAGE_SIZE;
            return renderList(root, session);
        }
        if (target.id === ids.fetchLimit) {
            const limit = Number.parseInt(target.value, 10);
            listChoices.fetchLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
            target.value = String(listChoices.fetchLimit);
            return undefined;
        }
        if (target.id === ids.selectAll) {
            for (const key of session.matchingKeys) {
                if (target.checked) session.tickedKeys.add(key);
                else session.tickedKeys.delete(key);
            }
            return renderList(root, session);
        }
        if (target.dataset.chunkTick !== undefined) {
            if (target.checked) session.tickedKeys.add(target.dataset.chunkTick);
            else session.tickedKeys.delete(target.dataset.chunkTick);
            return paintBulkBar(root, session);
        }
        if (target.closest(`#${ids.pane}`)) refreshFormState(root, session);
        return undefined;
    });
}
