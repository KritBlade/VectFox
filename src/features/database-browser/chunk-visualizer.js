/**
 * ============================================================================
 * CHUNK VISUALIZER
 * ============================================================================
 * A collection's chunks, read and edited in their own dialog over the Database
 * Browser (chunk-visualizer-markup.js draws it, chunk-visualizer-core.js holds
 * its rules). It loads the chunks from Similharity and lists them by the search,
 * filter and order chosen; a chunk opens in a form that one Save writes,
 * embedding the text again first when it changed. Leaving a chunk or closing
 * with unsaved edits asks first. Ticked chunks are enabled, disabled or deleted
 * together. The backend payload holds a chunk's fields; its summaries live in
 * VectFox's settings and each is a vector of its own pointing at the chunk. A
 * Qdrant collection made with another CJK tokenizer than VectFox is set to takes
 * no new vector, so there a chunk's text and new summaries are locked.
 * ============================================================================
 */

import { deleteChunkMetadata, getChunkMetadata, saveChunkMetadata } from '../collections/index.js';
import { deleteVectorItems, insertVectorItems, updateChunkMetadata } from '../vector-backend/index.js';
import { packTimelineSortKey } from '../eventbase/index.js';
import { languageModeLabel } from '../keyword-search/index.js';
import { getStringHash } from '../../sillytavern/identifiers.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { log } from '../../sillytavern/log.js';
import { confirmPopup, openPanelPopup } from '../../sillytavern/popup.js';
import { bindGeneBehaviours } from '../../shared/gui-dna/gene-behaviours.js';
import {
    DEFAULT_KEYWORD_WEIGHT,
    LIST_PAGE_SIZE,
    chunkLabel,
    collectionRecordLines,
    eventFields,
    formChanges,
    isEventBaseCollection,
    linkTargetLabel,
    linkTargetOptions,
    messageLine,
    partLabel,
    saveProblem,
    savedChunkFields,
    textPreview,
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
    keywordRowsMarkup,
    linkRowsMarkup,
    listFooterMarkup,
    noChunkOpenMarkup,
    noChunksMarkup,
    noMatchingChunksMarkup,
    summaryRowsMarkup,
    tokenizerLockMarkup,
} from './chunk-visualizer-markup.js';
import { IN_CHAT_POSITION, sanitizeXmlTag } from './collection-settings-core.js';
import { counted } from './counted.js';

/** The list's order and filter, and how many chunks a load asks for (0 for all), kept from one opening to the next. */
const listChoices = { sort: 'index', filter: 'all', fetchLimit: 0 };

/** How long the search waits after the last key before it filters. */
const SEARCH_DELAY_MS = 200;

const formatCount = count => Number(count).toLocaleString('en-US');

/**
 * Open a collection's chunks over the Database Browser and load them. Resolves when the visualizer closes; never throws.
 *
 * @param {{id: string, name?: string, type?: string, backend?: string, source?: string, model?: string,
 *   chunkCount?: number}} collection
 * @param {object} settings - VectFox's settings, with the collection's backend as `vector_backend`
 * @returns {Promise<void>}
 */
export async function openChunkVisualizer(collection, settings) {
    const session = {
        collection,
        settings,
        isEventBase: isEventBaseCollection(collection.id),
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
        isEventBase: session.isEventBase,
        fetchLimit: listChoices.fetchLimit,
    });
    const root = template.content.firstElementChild;
    root.querySelector(`#${ids.sort}`).value = listChoices.sort;
    root.querySelector(`#${ids.filter}`).value = listChoices.filter;
    bindGeneBehaviours(root);
    bindVisualizer(root, session);

    const closed = openPanelPopup(root, { canClose: () => (session.isBusy ? true : confirmLeavingChunk(root, session)) });
    void loadChunks(root, session);
    void showCollectionRecord(root, session);
    await closed;
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The chunks Similharity lists for a collection, with how many the collection holds.
 *
 * @param {object} collection
 * @param {number} limit - 0 for all
 * @returns {Promise<{items: object[], total: number}>}
 */
async function fetchChunks(collection, limit) {
    const response = await fetch('/api/plugins/similharity/chunks/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: collection.backend || 'vectra',
            collectionId: collection.id,
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

/** A chunk's place in the chat's history: its timeline key, else its message number on the same scale. */
function timelineValueOf(chunk) {
    const payload = chunk.metadata;
    if (typeof payload.timeline_sort_key === 'number') return payload.timeline_sort_key;
    return packTimelineSortKey(payload.source_window_start ?? payload.source_window_end ?? chunk.index ?? 0, 0);
}

function loadedChunk(item, position) {
    const chunk = {
        key: String(position),
        hash: item.hash,
        index: item.index !== undefined && item.index !== null && item.index >= 0 ? item.index : position,
        text: String(item.text || item.metadata?.text || ''),
        metadata: { ...(item.metadata || {}) },
    };
    chunk.fields = savedChunkFields(chunk, getChunkMetadata(chunk.hash) || {});
    chunk.timelineValue = timelineValueOf(chunk);
    return chunk;
}

async function loadChunks(root, session) {
    const loadNumber = ++session.loadCount;
    const reopenHash = openChunkOf(session)?.hash ?? null;
    root.querySelector(`#${ids.list}`).innerHTML = chunksLoadingMarkup();
    root.querySelector(`#${ids.listFooter}`).innerHTML = '';
    try {
        const { items, total } = await fetchChunks(session.collection, listChoices.fetchLimit);
        if (loadNumber !== session.loadCount) return;
        session.chunks = items.map(loadedChunk);
        session.totalCount = total;
        session.tickedKeys.clear();
        session.shownLimit = LIST_PAGE_SIZE;
        const reopened = reopenHash === null ? null : session.chunks.find(chunk => String(chunk.hash) === String(reopenHash));
        session.openKey = reopened?.key ?? null;
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
    const id = String(session.collection.id);
    const withoutBackend = id.startsWith('qdrant:') ? id.slice('qdrant:'.length) : id;
    const collectionId = withoutBackend.includes(':') ? withoutBackend.split(':')[1] : withoutBackend;
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
        title: chunk.fields.name || textPreview(chunk.fields.text) || 'No text',
        message: messageLine(chunk),
        part: partLabel(chunk),
        characterCount: chunk.fields.text.length,
        keywordCount: chunk.fields.keywords.length,
        isEnabled: chunk.fields.enabled,
        isOpen: chunk.key === session.openKey,
        isTicked: session.tickedKeys.has(chunk.key),
    };
}

function renderList(root, session) {
    const matching = visibleChunks(session.chunks, { query: session.query, filter: listChoices.filter, sort: listChoices.sort });
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
    const tickedCount = session.tickedKeys.size;
    root.querySelector('[data-chunk-bulk-count]').textContent = `${tickedCount} selected`;
    for (const name of ['bulk-enable', 'bulk-disable', 'bulk-delete']) {
        const bulkButton = root.querySelector(`[data-chunk-action="${name}"]`);
        if (bulkButton) bulkButton.disabled = tickedCount === 0 || session.isBusy;
    }
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
        pane.innerHTML = noChunkOpenMarkup();
        markOpenRow(root, session);
        return;
    }
    session.draft = {
        keywords: chunk.fields.keywords.map(keyword => ({ text: keyword.text, weightText: String(keyword.weight) })),
        chunkLinks: chunk.fields.chunkLinks.map(link => ({ ...link })),
        summaries: [...chunk.fields.summaries],
    };
    pane.innerHTML = chunkFormMarkup({
        number: Number(chunk.key) + 1,
        hash: chunk.hash,
        isEventBase: session.isEventBase,
        message: messageLine(chunk),
        part: partLabel(chunk),
        fields: chunk.fields,
        event: eventFields(chunk),
        links: linkViews(session),
        linkTargets: linkTargetOptions(session.chunks, chunk.hash),
    });
    const enabledSwitch = pane.querySelector(`#${ids.enabled}`);
    if (enabledSwitch) enabledSwitch.checked = chunk.fields.enabled;
    pane.querySelector('.vfx-card-body').scrollTop = 0;
    markOpenRow(root, session);
    paintTokenizerLock(root, session);
    refreshFormState(root, session);
}

/**
 * In a collection whose new vectors Similharity refuses, the open chunk's text and the box for a new summary are
 * locked, under a warning that names both CJK tokenizers.
 */
function paintTokenizerLock(root, session) {
    const slot = root.querySelector('[data-chunk-tokenizer-notice]');
    if (!slot) return;
    const lock = session.tokenizerLock;
    slot.innerHTML = lock ? tokenizerLockMarkup({ madeWith: languageModeLabel(lock.madeWith), setTo: languageModeLabel(lock.setTo) }) : '';
    slot.hidden = !lock;
    root.querySelector(`#${ids.text}`).readOnly = Boolean(lock);
    root.querySelector(`#${ids.summaryNew}`).disabled = Boolean(lock);
    root.querySelector('[data-chunk-action="add-summary"]').disabled = Boolean(lock);
}

const linkViews = session => session.draft.chunkLinks.map(link => ({ ...linkTargetLabel(session.chunks, link.targetHash), mode: link.mode }));

function readForm(root, session) {
    const value = id => root.querySelector(`#${id}`)?.value ?? '';
    return {
        name: value(ids.name),
        text: value(ids.text),
        enabled: session.isEventBase ? undefined : root.querySelector(`#${ids.enabled}`).checked,
        context: value(ids.context),
        xmlTag: value(ids.xmlTag),
        positionText: value(ids.position),
        depthText: value(ids.depth),
        keywords: session.isEventBase ? undefined : session.draft.keywords,
        chunkLinks: session.isEventBase ? undefined : session.draft.chunkLinks,
        summaries: session.draft.summaries,
    };
}

function changesOf(root, session) {
    const chunk = openChunkOf(session);
    return chunk && session.draft ? formChanges(chunk.fields, readForm(root, session)) : null;
}

/** Save and Delete as the form allows, and the lines that say what the form holds. */
function refreshFormState(root, session) {
    const changes = changesOf(root, session);
    if (!changes) return;
    const pane = root.querySelector(`#${ids.pane}`);
    const characters = root.querySelector(`#${ids.text}`).value.trim().length;
    pane.querySelector('[data-chunk-text-count]').textContent = `${formatCount(characters)} ${characters === 1 ? 'character' : 'characters'}.`;
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

function repaintDraftList(root, session, hook) {
    const list = root.querySelector(`[data-${hook}]`);
    if (hook === 'chunk-keywords') list.innerHTML = keywordRowsMarkup(session.draft.keywords.map(keyword => ({ text: keyword.text, weight: keyword.weightText })));
    if (hook === 'chunk-links') list.innerHTML = linkRowsMarkup(linkViews(session));
    if (hook === 'chunk-summaries') list.innerHTML = summaryRowsMarkup(session.draft.summaries);
    refreshFormState(root, session);
}

function addKeyword(root, session) {
    const box = root.querySelector(`#${ids.keywordNew}`);
    const text = box.value.trim();
    if (!text) return;
    if (!session.draft.keywords.some(keyword => keyword.text === text)) {
        session.draft.keywords.push({ text, weightText: String(DEFAULT_KEYWORD_WEIGHT) });
        repaintDraftList(root, session, 'chunk-keywords');
    }
    box.value = '';
    box.focus();
}

function addLink(root, session) {
    const targetHash = root.querySelector(`#${ids.linkTarget}`)?.value;
    if (!targetHash || session.draft.chunkLinks.some(link => String(link.targetHash) === targetHash)) return;
    session.draft.chunkLinks.push({ targetHash, mode: root.querySelector(`#${ids.linkMode}`).value === 'soft' ? 'soft' : 'force' });
    repaintDraftList(root, session, 'chunk-links');
}

function addSummary(root, session) {
    const box = root.querySelector(`#${ids.summaryNew}`);
    const text = box.value.trim();
    if (!text) return;
    if (!session.draft.summaries.includes(text)) {
        session.draft.summaries.push(text);
        repaintDraftList(root, session, 'chunk-summaries');
    }
    box.value = '';
}

// ── Saving ────────────────────────────────────────────────────────────────────────────────────────────

/** A summary as its own vector, pointing at its chunk. */
const summaryItem = (text, parentHash) => ({
    text,
    hash: getStringHash(text),
    index: 0,
    keywords: [],
    metadata: { isSummary: true, parentHash, contentType: 'summary' },
});

/**
 * Write a chunk whose text is unchanged: its payload fields, then the summaries added and removed.
 */
async function writeChunkChanges(session, chunk, changes) {
    const { collection, settings } = session;
    if (Object.keys(changes.payload).length) {
        await updateChunkMetadata(collection.id, chunk.hash, changes.payload, settings);
        chunk.metadata = { ...chunk.metadata, ...changes.payload };
    }
    if (changes.removedSummaries.length) await deleteVectorItems(collection.id, changes.removedSummaries.map(getStringHash), settings);
    if (changes.addedSummaries.length) await insertVectorItems(collection.id, changes.addedSummaries.map(summary => summaryItem(summary, chunk.hash)), settings);
    if (changes.addedSummaries.length || changes.removedSummaries.length) {
        saveChunkMetadata(String(chunk.hash), { ...(getChunkMetadata(String(chunk.hash)) || {}), summaries: changes.summaries });
    }
}

/**
 * Write a chunk whose text changed: the text under its new hash, embedded, with every field it keeps and the form's
 * changes; then the old one goes, and its summaries point at the new one. The new chunk goes in first, so a failed
 * embedding leaves the old chunk as it was, and a later failure leaves both, never neither.
 */
async function reembedChunk(session, chunk, changes) {
    const { collection, settings } = session;
    const oldHash = chunk.hash;
    const newHash = getStringHash(changes.text);
    // A chunk saved before the payload carried its fields has them in the settings; summaries stay there.
    const { summaries: storedSummaries, updatedAt, ...storedFields } = getChunkMetadata(String(oldHash)) || {};
    const metadata = { ...storedFields, ...chunk.metadata, ...changes.payload };
    for (const field of ['hash', 'text', 'summaries']) delete metadata[field];

    await insertVectorItems(collection.id, [{ hash: newHash, text: changes.text, index: chunk.index, metadata }], settings);
    Object.assign(chunk, { hash: newHash, text: changes.text, metadata });
    deleteChunkMetadata(String(oldHash));
    if (changes.summaries.length) saveChunkMetadata(String(newHash), { summaries: changes.summaries });

    try {
        await deleteVectorItems(collection.id, [oldHash], settings);
    } catch (error) {
        throw new Error(`the new text is saved, but the old chunk is still in the collection: ${error.message}`, { cause: error });
    }
    try {
        const oldSummaries = [...new Set([...(storedSummaries || []), ...changes.removedSummaries, ...changes.summaries])];
        if (oldSummaries.length) await deleteVectorItems(collection.id, oldSummaries.map(getStringHash), settings);
        if (changes.summaries.length) await insertVectorItems(collection.id, changes.summaries.map(summary => summaryItem(summary, newHash)), settings);
    } catch (error) {
        throw new Error(`the new text is saved, but its summaries still point at the old chunk: ${error.message}`, { cause: error });
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
        log.lifecycle(`VectFox Chunk Visualizer: saved chunk ${chunk.hash} of ${session.collection.id}${changes.text !== null ? ', embedded again' : ''}`);
    } catch (error) {
        log.error('VectFox Chunk Visualizer: a chunk could not be saved:', error);
        toastr.error(`The chunk was not saved: ${error.message}`, 'VectFox');
    } finally {
        // What is saved now, as far as the save got; the form keeps any edit it did not write.
        chunk.fields = savedChunkFields(chunk, getChunkMetadata(String(chunk.hash)) || {});
        chunk.timelineValue = timelineValueOf(chunk);
        setBusy(root, session, false);
    }
    renderList(root, session);
    if (isSaved) renderPane(root, session);
    else refreshFormState(root, session);
}

// ── Deleting and bulk actions ─────────────────────────────────────────────────────────────────────────

/** Delete chunks and their summaries' vectors, and forget their settings. */
async function deleteChunks(session, chunks) {
    const hashes = chunks.flatMap(chunk => [chunk.hash, ...chunk.fields.summaries.map(getStringHash)]);
    await deleteVectorItems(session.collection.id, hashes, session.settings);
    const deletedKeys = new Set(chunks.map(chunk => chunk.key));
    for (const chunk of chunks) deleteChunkMetadata(String(chunk.hash));
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
        { text: 'Lost: its text, its vector, its settings and its summaries. It cannot be undone.' },
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
        { text: 'Lost: their text, vectors, settings and summaries. It cannot be undone.' },
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

async function bulkSetEnabled(root, session, isEnabled) {
    const targets = session.chunks.filter(chunk => session.tickedKeys.has(chunk.key) && chunk.fields.enabled !== isEnabled);
    if (session.isBusy) return;
    const open = openChunkOf(session);
    const enabledSwitch = root.querySelector(`#${ids.enabled}`);
    // The open chunk's switch follows when the user has not moved it.
    const shouldMoveSwitch = Boolean(open && enabledSwitch && enabledSwitch.checked === open.fields.enabled);
    setBusy(root, session, true);
    let doneCount = 0;
    try {
        for (const chunk of targets) {
            await updateChunkMetadata(session.collection.id, chunk.hash, { enabled: isEnabled }, session.settings);
            chunk.metadata = { ...chunk.metadata, enabled: isEnabled };
            chunk.fields = { ...chunk.fields, enabled: isEnabled };
            doneCount++;
        }
        log.lifecycle(`VectFox Chunk Visualizer: ${isEnabled ? 'enabled' : 'disabled'} ${counted(doneCount, 'chunk')} of ${session.collection.id}`);
    } catch (error) {
        log.error('VectFox Chunk Visualizer: a bulk switch stopped:', error);
        toastr.error(`${doneCount} of ${counted(targets.length, 'chunk')} ${isEnabled ? 'enabled' : 'disabled'}; the rest were not: ${error.message}`, 'VectFox');
    } finally {
        if (shouldMoveSwitch && open && enabledSwitch.isConnected) enabledSwitch.checked = open.fields.enabled;
        setBusy(root, session, false);
    }
    renderList(root, session);
}

// ── Events ────────────────────────────────────────────────────────────────────────────────────────────

function runAction(root, session, button) {
    const { chunkAction: name } = button.dataset;
    const draftIndex = key => Number(button.dataset[key]);
    switch (name) {
        case 'open': return openChunk(root, session, button.dataset.chunkKey);
        case 'reload': return reloadChunks(root, session);
        case 'show-more':
            session.shownLimit += LIST_PAGE_SIZE;
            return renderList(root, session);
        case 'bulk-enable': return bulkSetEnabled(root, session, true);
        case 'bulk-disable': return bulkSetEnabled(root, session, false);
        case 'bulk-delete': return bulkDelete(root, session);
        case 'save': return saveOpenChunk(root, session);
        case 'delete': return deleteOpenChunk(root, session);
        case 'add-keyword': return addKeyword(root, session);
        case 'remove-keyword':
            session.draft.keywords.splice(draftIndex('keywordIndex'), 1);
            return repaintDraftList(root, session, 'chunk-keywords');
        case 'add-link': return addLink(root, session);
        case 'remove-link':
            session.draft.chunkLinks.splice(draftIndex('linkIndex'), 1);
            return repaintDraftList(root, session, 'chunk-links');
        case 'add-summary': return addSummary(root, session);
        case 'remove-summary':
            session.draft.summaries.splice(draftIndex('summaryIndex'), 1);
            return repaintDraftList(root, session, 'chunk-summaries');
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
        if (target.dataset.keywordWeight !== undefined && session.draft) {
            session.draft.keywords[Number(target.dataset.keywordWeight)].weightText = target.value;
        }
        if (target.closest(`#${ids.pane}`)) refreshFormState(root, session);
    });

    root.addEventListener('change', (event) => {
        const { target } = event;
        if (target.id === ids.sort || target.id === ids.filter) {
            listChoices[target.id === ids.sort ? 'sort' : 'filter'] = target.value;
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
        if (target.id === ids.xmlTag) target.value = sanitizeXmlTag(target.value);
        if (target.id === ids.position) {
            root.querySelector(`#${ids.depthField}`).hidden = Number.parseInt(target.value, 10) !== IN_CHAT_POSITION;
        }
        if (target.closest(`#${ids.pane}`)) refreshFormState(root, session);
        return undefined;
    });

    // Enter in a box that adds to a list adds, as its Add button does.
    root.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const adders = { [ids.keywordNew]: addKeyword, [ids.summaryNew]: addSummary };
        const add = adders[event.target.id];
        if (!add || (event.target.tagName === 'TEXTAREA' && event.shiftKey)) return;
        event.preventDefault();
        add(root, session);
    });
}
