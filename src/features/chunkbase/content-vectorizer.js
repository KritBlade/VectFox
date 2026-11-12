/**
 * ============================================================================
 * VECTORIZE CONTENT
 * ============================================================================
 * The dialog that reads a source into a collection: a rail of the content
 * types and a page for each (content-vectorizer-markup.js draws it, and
 * content-vectorizer-core.js holds its rules). A page keeps what was typed or
 * loaded on it while another is shown. A chat runs through EventBase, which
 * reads it in windows of messages; every other source is chunked by its
 * strategy, or by Auto-Reformat's reviewed entries, and embedded. A run goes on
 * with the dialog closed, and the progress panel shows it.
 * ============================================================================
 */

import { getContentType, getContentTypeDefaults } from './content-types.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { getContext } from '../../sillytavern/chat.js';
import { closePanelPopup, confirmPopup, noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { getRequestHeaders } from '../../sillytavern/requests.js';
import { log } from '../../sillytavern/log.js';
import { getChatUUID, runEventBaseOnOpenChat } from './chat-vectorization.js';
import { checkConnectionProfile, resolveInheritedConnection, validateLLMConfig } from '../llm-provider/index.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { getOpenRouterApiKey } from '../../shared/api-keys.js';
import { resolveEffectiveSettings } from './content-vectorization.js';
import { buildArchiveEventCollectionId } from '../../shared/collection-ids.js';
import { chooseCleaningPreset, cleaningPresetChoices, getCleaningSettings, openTextCleaningDialog } from '../text-cleaning/index.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { formatBytes, utf8ByteLength } from '../../shared/byte-size.js';
import { pickFiles } from '../../shared/pick-files.js';
import { bindGeneBehaviours, scrollPageToTop, syncSliders } from '../../shared/gui-dna/gene-behaviours.js';
import {
    CONTENT_TYPE_GROUPS,
    characterStats,
    chatCharacterName,
    chunkingControls,
    eventBaseRunEnding,
    extractCharNameFromArchiveFilename,
    extractCharaFromPng,
    extractFandomId,
    extractWikiName,
    fileExtension,
    fileStem,
    isReformatType,
    lorebookStats,
    pageTextFromHtml,
    parseCharacterJson,
    parseChatFile,
    parseLorebookFile,
    parseYouTubeId,
    previewOf,
    startFromMessageOf,
    syncUpToDateLines,
    usesEventBaseWindows,
} from './content-vectorizer-core.js';
import {
    contentVectorizerMarkup,
    cvId,
    cvPageId,
    cvTabId,
    loadedSourceMarkup,
    previewBusyMarkup,
    previewFailedMarkup,
    previewMarkup,
    reformatMarkup,
    sourceOptionsMarkup,
    wikiPluginMarkup,
} from './content-vectorizer-markup.js';

const ALL_TYPE_IDS = CONTENT_TYPE_GROUPS.flatMap(group => group.typeIds);

/** How many windows EventBase reads at once when the dialog does not say. */
const DEFAULT_PARALLEL_WINDOWS = 3;

const formatCount = count => Number(count).toLocaleString('en-US');

/** The open dialog: its root, the page shown, and each page's settings and loaded source. Null while closed. */
let session = null;

/** The run in progress, from the dialog or the auto-sync catch-up: its page, abort controller and origin. Null when none runs. */
let activeRun = null;

// ── Opening and closing ─────────────────────────────────────────────────────────────────────────────────

/** The open chat as the Chat page shows it, or null. */
function currentChatView() {
    const context = getContext();
    if (!context?.chatId) return null;
    return { messageCount: context.chat?.length || 0, characterName: context.name2 || 'Unknown', chatId: getChatUUID() || 'unknown' };
}

/**
 * Open Vectorize Content on a type's page, the Chat page by default when a chat is open, else the Lorebook page.
 * Resolves once the dialog is open; a run started in it goes on after it closes.
 *
 * @param {string|null} [initialType] - A content type's id
 */
export function openContentVectorizer(initialType = null) {
    const activeTypeId = ALL_TYPE_IDS.includes(initialType) ? initialType : (getContext()?.chatId ? 'chat' : 'lorebook');
    if (session) {
        showTypePage(activeTypeId);
        return;
    }
    const cleaningPreset = getCleaningSettings().selectedPreset || 'custom';
    const view = {
        chat: currentChatView(),
        characterName: getContext()?.characterId !== undefined ? getContext()?.name2 : '',
        cleaningPresets: cleaningPresetChoices(),
        cleaningPreset,
    };
    const template = document.createElement('template');
    template.innerHTML = contentVectorizerMarkup({ activeTypeId, view });
    const root = template.content.firstElementChild;
    session = { root, activeTypeId, pages: new Map(), isDialogOpen: true };
    for (const typeId of ALL_TYPE_IDS) {
        session.pages.set(typeId, { settings: { ...getContentTypeDefaults(typeId), cleaningPreset }, sourceData: null, isLoaded: false });
        setStartingValues(typeId);
    }
    bindGeneBehaviours(root);
    bindVectorizer(root);
    syncSliders(root);
    showRunState();

    const opened = session;
    void openPanelPopup(root).then(() => {
        opened.isDialogOpen = false;
        if (session === opened) session = null;
        announceClosedWhenIdle();
    });
    void loadPage(activeTypeId);
}

/**
 * Close the dialog. A run goes on, shown by the progress panel; the close is announced once the run is over.
 */
async function closeContentVectorizer() {
    if (session?.isDialogOpen) await closePanelPopup(session.root);
}

/**
 * Announce that Vectorize Content closed, once its dialog is gone and no run is going. Callers that sent the user
 * here tell "finished" from "changed their mind" by it: the auto-sync checkbox sends a chat with no collection here
 * and must not enable itself if the user closed without running. A successful run's `vectfox:eventbase-synced`
 * comes first, so the resume wins on success. An open Database Browser redraws its collections on it.
 */
function announceClosedWhenIdle() {
    if (session || activeRun) return;
    document.dispatchEvent(new CustomEvent('vectfox:content-vectorizer-closed'));
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────

const pageOf = typeId => session?.root.querySelector(`#${cvPageId(typeId)}`) ?? null;
const controlOf = (typeId, name) => session?.root.querySelector(`#${cvId(typeId, name)}`) ?? null;
const regionOf = (typeId, name) => pageOf(typeId)?.querySelector(`[data-cv-region="${name}"]`) ?? null;
const partsOf = (typeId, name) => [...(pageOf(typeId)?.querySelectorAll(`[data-cv-part="${name}"]`) ?? [])];
const hintOf = (typeId, name) => pageOf(typeId)?.querySelector(`[data-cv-hint="${name}"]`) ?? null;
const pageStateOf = typeId => session?.pages.get(typeId);

function showPart(typeId, name, isShown) {
    for (const part of partsOf(typeId, name)) part.hidden = !isShown;
}

function paint(typeId, regionName, markup) {
    const region = regionOf(typeId, regionName);
    if (region) region.innerHTML = markup;
}

/** The values a page starts with that its markup cannot hold: sizes from its strategy, the saved window settings. */
function setStartingValues(typeId) {
    const type = getContentType(typeId);
    const defaults = getContentTypeDefaults(typeId);
    const setValue = (name, value) => {
        const control = controlOf(typeId, name);
        if (control) control.value = String(value);
    };
    setValue('chunk_size', type.defaults?.chunkSize || 400);
    setValue('batch_size', defaults.batchSize || 4);
    if (usesEventBaseWindows(typeId)) {
        const settings = extension_settings.vectfox || {};
        setValue('parallel_windows', DEFAULT_PARALLEL_WINDOWS);
        setValue('window_size', settings.eventbase_window_size ?? 2);
        setValue('window_overlap', settings.eventbase_window_overlap ?? 0);
    }
    refreshChunking(typeId);
}

/** Show the chunking controls the page's type, strategy and Auto-Reformat state call for. */
function refreshChunking(typeId) {
    const state = pageStateOf(typeId);
    const strategyId = controlOf(typeId, 'strategy')?.value || state.settings.strategy;
    const controls = chunkingControls(typeId, strategyId, state.settings.reformat?.accepted === true);
    showPart(typeId, 'strategy', controls.showsStrategy);
    showPart(typeId, 'size', controls.showsSize);
    showPart(typeId, 'batch', controls.showsBatch);
    showPart(typeId, 'windows', controls.showsWindows);
    const note = hintOf(typeId, 'strategy-note');
    if (note) note.textContent = controls.note;
}

function showTypePage(typeId) {
    if (!session) return;
    const isAnotherPage = session.activeTypeId !== typeId;
    session.activeTypeId = typeId;
    for (const each of ALL_TYPE_IDS) {
        // Written only where it changes: each inline style write costs SillyTavern's page a style pass.
        const display = each === typeId ? '' : 'none';
        if (pageOf(each).style.display !== display) pageOf(each).style.display = display;
        const tab = session.root.querySelector(`#${cvTabId(each)}`);
        tab.classList.toggle('is-active', each === typeId);
        if (each === typeId) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    if (isAnotherPage) scrollPageToTop(pageOf(typeId));
    void loadPage(typeId);
}

/** Fill what a page reads from SillyTavern the first time it shows: the lorebooks or characters, the wiki plugin. */
async function loadPage(typeId) {
    const state = pageStateOf(typeId);
    if (!state || state.isLoaded) return;
    state.isLoaded = true;
    if (typeId === 'lorebook' || typeId === 'character') await fillSourceSelect(typeId);
    if (typeId === 'wiki') await showWikiPluginState();
}

async function fillSourceSelect(typeId) {
    const select = controlOf(typeId, 'source_select');
    try {
        if (typeId === 'lorebook') {
            const { world_names: worldNames = [] } = await import('../../sillytavern/world-info.js');
            select.innerHTML = sourceOptionsMarkup(worldNames.map(name => ({ value: name, name })), 'No lorebooks found');
        } else {
            const context = getContext();
            const characters = context?.characters || [];
            const current = characters[context?.characterId];
            const ordered = current ? [current, ...characters.filter(character => character !== current)] : characters;
            select.innerHTML = sourceOptionsMarkup(ordered.map(character => ({ value: character.avatar, name: character.name, isCurrent: character === current })), 'No characters found');
            if (current) await showSourceStats(typeId, current.avatar);
        }
    } catch (error) {
        log.error(`VectFox Vectorize Content: the ${typeId === 'lorebook' ? 'lorebooks' : 'characters'} could not be listed:`, error);
        select.innerHTML = sourceOptionsMarkup([], 'They could not be listed');
    }
}

/** What the chosen lorebook or character holds, as pills under its select. */
async function showSourceStats(typeId, sourceId) {
    if (!sourceId) {
        paint(typeId, 'stats', '');
        return;
    }
    paint(typeId, 'stats', loadedSourceMarkup({ state: 'busy', busyText: 'Reading it…' }));
    try {
        if (typeId === 'lorebook') {
            const { loadWorldInfo } = await import('../../sillytavern/world-info.js');
            const data = await loadWorldInfo(sourceId);
            const stats = lorebookStats(Object.values(data?.entries || {}));
            paint(typeId, 'stats', loadedSourceMarkup({ state: 'done', lines: [
                { text: 'Entries', name: formatCount(stats.entryCount) },
                { text: 'Enabled', name: formatCount(stats.enabledCount) },
                { text: 'Text', name: `${formatCount(stats.textLength)} characters` },
            ] }));
        } else {
            const character = getContext()?.characters?.find(each => each.avatar === sourceId);
            const stats = characterStats(character);
            paint(typeId, 'stats', loadedSourceMarkup({ state: 'done', lines: [
                { text: 'Fields with text', name: `${stats.filledCount} of ${stats.fieldCount}` },
                { text: 'Text', name: `${formatCount(stats.textLength)} characters` },
            ] }));
        }
    } catch (error) {
        log.error('VectFox Vectorize Content: the source could not be read:', error);
        paint(typeId, 'stats', loadedSourceMarkup({ state: 'failed', reason: error.message }));
    }
}

// ── Sources ─────────────────────────────────────────────────────────────────────────────────────────────

const sourceChoiceOf = typeId => controlOf(typeId, 'source_choice')?.value ?? null;

/** Show the part of the Source card the choice names, and forget a source the other part loaded. */
function chooseSource(typeId) {
    const choice = sourceChoiceOf(typeId);
    for (const name of ['this', 'file', 'existing', 'paste']) showPart(typeId, name, name === choice);
    pageStateOf(typeId).sourceData = null;
    paint(typeId, 'file', '');
}

/** Read a picked or dropped file into the page's source. */
async function loadFile(typeId, file) {
    const state = pageStateOf(typeId);
    const extension = fileExtension(file.name);
    paint(typeId, 'file', loadedSourceMarkup({ state: 'busy', busyText: `Reading ${file.name}…` }));
    try {
        if (typeId === 'chat') {
            const text = await file.text();
            const { messages, metadata } = parseChatFile(text, extension);
            if (!messages.length) throw new Error('It holds no messages.');
            const integrity = metadata?.chat_metadata?.integrity;
            if (!integrity) log.warn(`[VectFox] Archive "${file.name}" has no chat_metadata.integrity — using SHA-1 hash as UUID`);
            const characterName = chatCharacterName(messages, metadata);
            state.sourceData = {
                type: 'file',
                filename: file.name,
                content: messages,
                messages,
                metadata,
                characterName,
                archiveUUID: integrity || await sha1Hex(text),
                filenameCharName: extractCharNameFromArchiveFilename(file.name) || metadata?.character_name || 'archive',
            };
            showLoadedFile(typeId, file.name, [
                { text: 'Messages', name: formatCount(messages.length) },
                { text: 'Character', name: characterName },
                { text: 'Text', name: `${formatCount(messages.reduce((sum, message) => sum + (message.mes?.length || 0), 0))} characters` },
            ]);
        } else if (typeId === 'lorebook') {
            const entries = parseLorebookFile(await file.text());
            state.sourceData = { type: 'file', filename: file.name, content: entries, entries, name: fileStem(file.name) };
            const stats = lorebookStats(entries);
            showLoadedFile(typeId, file.name, [
                { text: 'Entries', name: formatCount(stats.entryCount) },
                { text: 'Enabled', name: formatCount(stats.enabledCount) },
            ]);
        } else if (typeId === 'character') {
            const character = extension === 'png'
                ? extractCharaFromPng(new Uint8Array(await file.arrayBuffer()))
                : parseCharacterJson(await file.text());
            if (!character) throw new Error('This PNG carries no character.');
            state.sourceData = { type: 'file', filename: file.name, content: character, character, name: character.name || fileStem(file.name) };
            const stats = characterStats(character);
            showLoadedFile(typeId, file.name, [
                { text: 'Character', name: character.name || 'Unnamed' },
                { text: 'Fields with text', name: `${stats.filledCount} of ${stats.fieldCount}` },
            ]);
        } else {
            const text = await file.text();
            state.sourceData = { type: 'file', filename: file.name, content: text };
            const nameBox = controlOf(typeId, 'doc_name');
            if (nameBox && !nameBox.value.trim()) nameBox.value = fileStem(file.name);
            showLoadedFile(typeId, file.name, [{ text: 'Text', name: `${formatCount(text.length)} characters` }]);
        }
        log.lifecycle(`VectFox Vectorize Content: loaded ${file.name} for ${typeId}`);
    } catch (error) {
        log.error(`VectFox Vectorize Content: ${file.name} could not be read:`, error);
        state.sourceData = null;
        paint(typeId, 'file', loadedSourceMarkup({ state: 'failed', reason: error.message }));
    }
}

function showLoadedFile(typeId, filename, lines) {
    paint(typeId, 'file', loadedSourceMarkup({ state: 'done', lines: [{ text: 'File', name: filename }, ...lines] }));
}

/** A hex SHA-1 of text: an archive's ID when its file carries no chat_metadata.integrity. */
async function sha1Hex(text) {
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** POST to SillyTavern with its CSRF token, as every request to it must carry. */
const postToSillyTavern = (url, body) => fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });

async function failedResponseReason(response) {
    const text = await response.text().catch(() => '');
    return text.trim() || `SillyTavern answered ${response.status}`;
}

/** Fetch the page's web page, wiki or video into its source. */
async function fetchSource(typeId) {
    const state = pageStateOf(typeId);
    state.sourceData = null;
    try {
        if (typeId === 'url') state.sourceData = await fetchWebPage();
        else if (typeId === 'wiki') state.sourceData = await scrapeWiki();
        else if (typeId === 'youtube') state.sourceData = await fetchTranscript();
    } catch (error) {
        log.error(`VectFox Vectorize Content: the ${typeId} could not be fetched:`, error);
        paint(typeId, 'fetched', loadedSourceMarkup({ state: 'failed', reason: error.message }));
    }
}

async function fetchWebPage() {
    const url = controlOf('url', 'url_input').value.trim();
    try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http');
    } catch {
        // EXPECTED: anything but an http or https address is the user's typo, said in the card.
        throw new Error('Type a full address, starting with http:// or https://.');
    }
    paint('url', 'fetched', loadedSourceMarkup({ state: 'busy', busyText: 'Fetching the page…' }));
    const response = await postToSillyTavern('/api/search/visit', { url, html: true });
    if (!response.ok) throw new Error(await failedResponseReason(response));
    const page = pageTextFromHtml(await response.text(), html => new DOMParser().parseFromString(html, 'text/html'));
    if (page.text.length < 50) throw new Error('The page holds no readable text.');
    paint('url', 'fetched', loadedSourceMarkup({ state: 'done', lines: [
        { text: 'Page', name: page.title || url },
        { text: 'Text', name: `${formatCount(page.text.length)} characters` },
    ] }));
    return { type: 'url', url, content: page.text, title: page.title || url };
}

async function showWikiPluginState() {
    const wikiType = controlOf('wiki', 'wiki_type').value;
    paint('wiki', 'plugin', loadedSourceMarkup({ state: 'busy', busyText: 'Looking for the Fandom Scraper plugin…' }));
    const response = await postToSillyTavern(wikiType === 'fandom' ? '/api/plugins/fandom/probe' : '/api/plugins/fandom/probe-mediawiki', {})
        .catch((error) => {
            log.warn('VectFox Vectorize Content: the Fandom Scraper probe failed:', error);
            return null;
        });
    const isAvailable = Boolean(response?.ok);
    paint('wiki', 'plugin', wikiPluginMarkup({ isAvailable, wikiName: wikiType === 'fandom' ? 'Fandom' : 'MediaWiki', pluginUrl: getContentType('wiki').sourceOptions.pluginUrl }));
}

async function scrapeWiki() {
    const wikiType = controlOf('wiki', 'wiki_type').value;
    const address = controlOf('wiki', 'wiki_url').value.trim();
    const filter = controlOf('wiki', 'wiki_filter').value.trim();
    if (!address) throw new Error('Type the wiki\'s address or ID first.');
    paint('wiki', 'fetched', loadedSourceMarkup({ state: 'busy', busyText: 'Scraping the wiki…' }));
    const response = wikiType === 'fandom'
        ? await postToSillyTavern('/api/plugins/fandom/scrape', { fandom: extractFandomId(address), filter })
        : await postToSillyTavern('/api/plugins/fandom/scrape-mediawiki', { url: address, filter });
    if (!response.ok) throw new Error(await failedResponseReason(response));
    const pages = await response.json();
    if (!Array.isArray(pages) || !pages.length) throw new Error('The wiki returned no pages.');
    const content = pages.map(page => `# ${String(page.title).trim()}\n\n${String(page.content).trim()}`).join('\n\n---\n\n');
    paint('wiki', 'fetched', loadedSourceMarkup({ state: 'done', lines: [
        { text: 'Pages', name: formatCount(pages.length) },
        { text: 'Text', name: `${formatCount(content.length)} characters` },
    ] }));
    return { type: 'wiki', wikiType, url: address, content, pages, pageCount: pages.length, name: extractWikiName(address, wikiType) };
}

async function fetchTranscript() {
    const videoId = parseYouTubeId(controlOf('youtube', 'youtube_url').value);
    const lang = controlOf('youtube', 'youtube_lang').value.trim();
    if (!videoId) throw new Error('That is not a YouTube address or video ID.');
    paint('youtube', 'fetched', loadedSourceMarkup({ state: 'busy', busyText: 'Fetching the transcript…' }));
    const response = await postToSillyTavern('/api/search/transcript', { id: videoId, lang: lang || undefined });
    if (!response.ok) throw new Error(await failedResponseReason(response));
    const transcript = await response.text();
    // SillyTavern answers empty when its server got no caption lines; YouTube withholds them from many servers, so a video
    // with captions can come back empty too.
    if (transcript.length < 50) throw new Error('SillyTavern got no transcript for this video. YouTube often withholds transcripts from servers, even for videos with captions.');
    paint('youtube', 'fetched', loadedSourceMarkup({ state: 'done', lines: [
        { text: 'Video', name: videoId },
        { text: 'Text', name: `${formatCount(transcript.length)} characters` },
        // About 150 spoken words a minute, of about 5 characters each.
        { text: 'Length', name: `about ${Math.max(1, Math.round(transcript.length / 750))} min` },
    ] }));
    return { type: 'youtube', videoId, url: `https://youtube.com/watch?v=${videoId}`, content: transcript, lang: lang || 'auto', name: `YouTube-${videoId}` };
}

/**
 * The page's source, or why there is none: a file or fetch it loaded, its pasted text, the lorebook or character it
 * names, or the open chat.
 *
 * @param {string} typeId
 * @returns {{source: object|null, problem: string}}
 */
function sourceOf(typeId) {
    const state = pageStateOf(typeId);
    if (state.sourceData) return { source: state.sourceData, problem: '' };
    const choice = sourceChoiceOf(typeId);
    if (choice === 'file') return { source: null, problem: 'Choose a file first.' };
    if (typeId === 'document') {
        const text = controlOf(typeId, 'paste_text').value.trim();
        if (!text) return { source: null, problem: 'Paste the text first.' };
        return { source: { type: 'paste', content: text, name: controlOf(typeId, 'doc_name').value.trim() || 'Pasted Document' }, problem: '' };
    }
    if (typeId === 'lorebook' || typeId === 'character') {
        const sourceId = controlOf(typeId, 'source_select').value;
        if (!sourceId) return { source: null, problem: `Choose a ${typeId} first.` };
        const character = typeId === 'character' ? getContext()?.characters?.find(each => each.avatar === sourceId) : null;
        return { source: { type: 'select', id: sourceId, name: character?.name || sourceId }, problem: '' };
    }
    if (typeId === 'chat') {
        const context = getContext();
        if (!context?.chatId || !context.chat?.length) return { source: null, problem: 'The open chat has no messages.' };
        return { source: { type: 'current', id: context.chatId, name: context.name2 || 'Chat', content: context.chat }, problem: '' };
    }
    return { source: null, problem: typeId === 'wiki' ? 'Scrape the wiki first.' : 'Fetch it first.' };
}

// ── Auto-Reformat ───────────────────────────────────────────────────────────────────────────────────────

/** The source as one text for the reformatter; a wiki is read whole, as Per Page would hand over its pages apart. */
async function reformatSourceText(typeId, source) {
    const { resolveAndPrepareContent } = await import('./content-vectorization.js');
    const settings = pageStateOf(typeId).settings;
    const prepared = await resolveAndPrepareContent(typeId, source, typeId === 'wiki' ? { ...settings, strategy: 'adaptive' } : settings);
    if (typeof prepared.text === 'string') return prepared.text;
    if (Array.isArray(prepared.text)) return prepared.text.map(part => (typeof part === 'string' ? part : part.text || '')).join('\n\n---\n\n');
    return String(prepared.text || '');
}

function showReformat(typeId) {
    const accepted = pageStateOf(typeId).settings.reformat;
    paint(typeId, 'reformat', accepted?.accepted ? reformatMarkup({ state: 'accepted', entryCount: accepted.entryCount }) : reformatMarkup({ state: 'idle' }));
    refreshChunking(typeId);
}

/** Run the Auto-Reformat LLM pass on the page's source and open its review; reused by Run again. */
async function runAutoReformat(typeId) {
    const { source, problem } = sourceOf(typeId);
    if (!source) {
        showRunState(problem, typeId);
        return;
    }
    const state = pageStateOf(typeId);
    paint(typeId, 'reformat', reformatMarkup({ state: 'busy', progressText: 'Reading the source…' }));
    try {
        const text = await reformatSourceText(typeId, source);
        if (!text.trim()) {
            paint(typeId, 'reformat', reformatMarkup({ state: 'failed', reason: 'The source holds no text.' }));
            return;
        }
        const { getStringHash } = await import('../../sillytavern/identifiers.js');
        const sourceHash = getStringHash(text);
        const mergedSettings = resolveEffectiveSettings(state.settings);
        const { getReformatCache } = await import('./reformat-store.js');
        const existing = getReformatCache(sourceHash);
        if (existing?.chunks?.length) {
            state.settings.reformat = { accepted: true, sourceHash, entryCount: existing.chunks.length };
            showReformat(typeId);
            log.lifecycle(`VectFox Auto-Reformat: this exact source was reformatted before; its ${existing.chunks.length} saved chunks are reused`);
            return;
        }
        paint(typeId, 'reformat', reformatMarkup({ state: 'busy', progressText: 'Running Auto-Reformat…' }));
        const { reformatDocument } = await import('./reformat-extractor.js');
        const result = await reformatDocument({
            text,
            contentType: typeId,
            settings: mergedSettings,
            onProgress: (done, total) => paint(typeId, 'reformat', reformatMarkup({ state: 'busy', progressText: `Running Auto-Reformat: batch ${done} of ${total}.` })),
        });
        if (!result.chunks.length) {
            paint(typeId, 'reformat', reformatMarkup({ state: 'empty', reason: result.warnings.join(' ') || 'The LLM returned none.' }));
            return;
        }
        showReformat(typeId);
        const { openReformatReview } = await import('./reformat-review.js');
        const sourceName = source.name || source.filename || source.title || typeId;
        openReformatReview({
            chunks: result.chunks,
            warnings: result.warnings,
            sourceText: text,
            sourceName,
            contentType: getContentType(typeId).name,
            onAccept: acceptedRecords => acceptReformat(typeId, { acceptedRecords, sourceHash, text, sourceName, mergedSettings }),
            onDiscard: () => {
                state.settings.reformat = null;
                showReformat(typeId);
            },
            onRerun: () => runAutoReformat(typeId),
        });
    } catch (error) {
        log.error('VectFox: Auto-Reformat failed:', error);
        // A setting or a profile's key is wrong: shown where the run was started, and as the sticky toast.
        if (isInvalidModelConfigError(error)) notifyInvalidModel(error.message);
        paint(typeId, 'reformat', reformatMarkup({ state: 'failed', reason: error.message }));
    }
}

/** The provider and model, or the profile, an Auto-Reformat draft was made with, as its record names them. */
function reformatProviderModel(settings) {
    const connection = resolveInheritedConnection({
        provider: settings.reformat_provider,
        model: settings.reformat_model,
        connectionProfileId: settings.reformat_connection_profile_id,
    }, settings);
    if (connection.provider !== CONNECTION_PROFILE_PROVIDER) return `${connection.provider}:${connection.model}`;
    const check = checkConnectionProfile(connection.connectionProfileId, { feature: 'Auto-Reformat', page: 'ChunkBase' });
    return `${connection.provider}:${check.ok ? check.profile.name : connection.connectionProfileId}`;
}

/**
 * Keep an accepted Auto-Reformat draft: split any entry too long for one chunk with the adaptive splitter, shape each
 * piece as chunkText() shapes a chunk, freeze them in reformat-store.js under the source's hash, and mark the page's
 * Auto-Reformat accepted.
 */
async function acceptReformat(typeId, { acceptedRecords, sourceHash, text, sourceName, mergedSettings }) {
    const state = pageStateOf(typeId);
    try {
        const { expandOversizedChunk } = await import('./reformat-extractor.js');
        const { saveReformatCache, getReformatCache } = await import('./reformat-store.js');
        const maxBodyChars = mergedSettings.reformat_max_body_chars || 2000;
        const previous = getReformatCache(sourceHash);

        const shapedChunks = [];
        for (const record of acceptedRecords) {
            for (const piece of await expandOversizedChunk(record, maxBodyChars)) {
                shapedChunks.push({
                    text: piece.body,
                    metadata: {
                        chunkIndex: shapedChunks.length,
                        totalChunks: 0,
                        strategy: 'llm_reformat',
                        entry_type: piece.entry_type,
                        name: piece.name,
                        aliases: piece.aliases,
                        affiliation: piece.affiliation,
                        traits: piece.traits,
                        relationships: piece.relationships,
                        keywords: piece.keywords,
                        subChunkIndex: piece.subChunkIndex,
                        subChunkTotal: piece.subChunkTotal,
                    },
                });
            }
        }
        shapedChunks.forEach(chunk => { chunk.metadata.totalChunks = shapedChunks.length; });

        if (previous?.chunks?.length) {
            // Each Document, URL or Wiki run makes a collection of its own, so a collection made from the draft this
            // replaces stays as it is.
            toastr.info('This replaces the saved Auto-Reformat draft. A collection already made from the old one stays; delete it in the Database Browser if you do not want both.', 'VectFox', { timeOut: 10000 });
        }
        if (text.length > 200000) {
            toastr.warning(`Auto-Reformat keeps the original text, about ${formatBytes(utf8ByteLength(text))}, in your settings. Clear originals, at the foot of the Database Browser's Collections page, frees it.`, 'VectFox', { timeOut: 10000 });
        }
        saveReformatCache(sourceHash, {
            chunks: shapedChunks,
            originalText: text,
            contentType: typeId,
            sourceName,
            providerModel: reformatProviderModel(mergedSettings),
            schemaVersion: 1,
        });
        state.settings.reformat = { accepted: true, sourceHash, entryCount: shapedChunks.length };
        log.lifecycle(`VectFox Auto-Reformat: accepted, ${shapedChunks.length} chunk(s) ready for Vectorize`);
        showReformat(typeId);
    } catch (error) {
        log.error('VectFox: Failed to finalize Auto-Reformat accept:', error);
        toastr.error(`The Auto-Reformat result could not be saved: ${error.message}`, 'VectFox');
    }
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────────────────

async function previewChunks(typeId) {
    const { source, problem } = sourceOf(typeId);
    if (!source) {
        showRunState(problem, typeId);
        return;
    }
    const settings = pageStateOf(typeId).settings;
    paint(typeId, 'preview', previewBusyMarkup());
    try {
        if (isReformatType(typeId) && settings.reformat?.accepted) {
            const { getReformatCache } = await import('./reformat-store.js');
            const chunks = getReformatCache(settings.reformat.sourceHash)?.chunks || [];
            if (!chunks.length) throw new Error('The saved Auto-Reformat chunks are gone; run Auto-Reformat again.');
            const textLength = chunks.reduce((sum, chunk) => sum + (chunk.text?.length || 0), 0);
            paint(typeId, 'preview', previewMarkup(previewOf(chunks, textLength), true));
            return;
        }
        const type = getContentType(typeId);
        const { chunkText } = await import('./chunking.js');
        const { resolveAndPrepareContent } = await import('./content-vectorization.js');
        const prepared = await resolveAndPrepareContent(typeId, source, settings);
        const text = prepared.text;
        if (!text || (Array.isArray(text) && !text.length)) throw new Error('The source holds no text.');
        const chunks = await chunkText(text, {
            strategy: settings.strategy || type.defaultStrategy,
            chunkSize: settings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: type.defaults.chunkOverlap,
            batchSize: settings.batchSize || 4,
        });
        if (!chunks?.length) throw new Error('No chunks came of it: the text may be too short.');
        const textLength = Array.isArray(text) ? text.reduce((sum, part) => sum + (part?.length || 0), 0) : text.length;
        paint(typeId, 'preview', previewMarkup(previewOf(chunks, textLength), false));
    } catch (error) {
        log.error('VectFox: Preview failed:', error);
        paint(typeId, 'preview', previewFailedMarkup(error.message));
    }
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The run state on every open page: while a run goes on, its buttons are off and Stop shows; else the line under
 * the buttons says what the last attempt needs, on the page it was made from.
 *
 * @param {string} [message] - Why the last attempt did not start
 * @param {string} [typeId] - The page it was made from
 */
function showRunState(message = '', typeId = null) {
    if (!session) return;
    const isRunning = Boolean(activeRun);
    for (const each of ALL_TYPE_IDS) {
        const page = pageOf(each);
        for (const name of ['preview', 'resume', 'vectorize', 'reformat']) {
            for (const control of page.querySelectorAll(`[data-cv-action="${name}"]`)) control.disabled = isRunning;
        }
        showPart(each, 'stop', isRunning && activeRun?.typeId === each);
        const line = hintOf(each, 'run-state');
        if (!line) continue;
        if (isRunning) line.textContent = activeRun.typeId === each ? 'Vectorizing; the progress panel shows how far.' : 'Another page is vectorizing.';
        else line.textContent = each === typeId ? message : '';
    }
}

/** The LLM a run needs is set, or the user is told where to set it. */
function hasLlmConfig(settings) {
    const merged = resolveEffectiveSettings(settings);
    const isOnProfile = merged.chat_provider === CONNECTION_PROFILE_PROVIDER;
    log.verbose('[VectFox] LLM config check (vectorize-content):', {
        provider: merged.chat_provider,
        model: merged.chat_model,
        connectionProfileId: isOnProfile ? merged.chat_connection_profile_id : '',
        hasOpenRouterKey: !!getOpenRouterApiKey(),
        hasVllmUrl: !!merged.chat_vllm_url,
    });
    const check = validateLLMConfig(merged);
    // A profile's reason already names where to fix it.
    const where = isOnProfile ? '' : ' Open VectFox → Core → EventBase model and fill in the required fields.';
    if (!check.ok) toastr.error(`${check.reason}${where}`, 'Configuration required', { timeOut: 8000 });
    return check.ok;
}

const isTouchScreen = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** On a touch screen the dialog covers the progress panel, so it closes while the run goes on. */
function closeForProgressOnTouch() {
    if (isTouchScreen()) void closeContentVectorizer();
}

function startRun(typeId) {
    activeRun = { typeId, abortController: new AbortController(), isFromDialog: Boolean(session) };
    progressTracker.setCancelHandler(() => stopRun());
    showRunState();
    return activeRun.abortController.signal;
}

/** @param {string} [message] - What the run's page says once it ends, where nothing else has said it */
function endRun(message = '') {
    progressTracker.clearCancelHandler();
    const { isFromDialog, typeId } = activeRun;
    activeRun = null;
    showRunState(message, typeId);
    // The auto-sync catch-up runs with no dialog, so there is no close to announce.
    if (isFromDialog) announceClosedWhenIdle();
}

/** The progress panel's Stop and the page's call it; the run ends once what was already sent comes back. */
function stopRun() {
    if (!activeRun || activeRun.abortController.signal.aborted) return;
    activeRun.abortController.abort('user-stop');
    const line = hintOf(activeRun.typeId, 'run-state');
    if (line) line.textContent = 'Stopping: what was already sent finishes first.';
}

const isStoppedError = error => error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('stopped by user');

/** Vectorize the page's source: a chat from its Start From message, any other source as a new collection. */
async function startVectorization(typeId) {
    if (activeRun) return;
    const { source, problem } = sourceOf(typeId);
    if (!source) {
        showRunState(problem, typeId);
        return;
    }
    const settings = pageStateOf(typeId).settings;
    if (!hasLlmConfig(settings)) return;

    if (usesEventBaseWindows(typeId)) {
        // Vectorize starts the chat afresh from its Start From message, so it asks when EventBase has read it before;
        // Resume adds only what is new.
        const chatUUID = source.type === 'file' ? source.archiveUUID : getChatUUID();
        const startFromMessage = startFromMessageOf(controlOf(typeId, 'start_from').value);
        if (await hasPriorExtractionState(chatUUID)) {
            const isConfirmed = await confirmPopup([
                { text: 'Read this chat again from the start?' },
                { text: 'From message:', name: String(startFromMessage) },
                { text: 'Its progress resets, and EventBase reads it again, paying for each window. The events it has stay, so some may repeat.' },
                { text: 'Resume adds only the messages not read yet.' },
            ], { okButton: 'Read again', isDestructive: true });
            if (!isConfirmed) return;
        }
        await runEventBaseBackfill(typeId, { source, startFromMessage, parallelWindows: parallelWindowsOf(typeId), resetCaches: true });
        return;
    }

    const signal = startRun(typeId);
    closeForProgressOnTouch();
    try {
        const { vectorizeContent } = await import('./content-vectorization.js');
        const result = await vectorizeContent({
            contentType: typeId,
            source,
            settings: resolveEffectiveSettings(settings),
            abortSignal: signal,
            startFromMessage: 1,
        });
        log.lifecycle(`VectFox Vectorize Content: ${typeId} vectorized into ${result.chunkCount} chunks`);
        await closeContentVectorizer();
        // The settings panel refreshes the World Info status on this, so its switch turns on when the new
        // collection is active here (global, or locked to this chat or character).
        if (typeId === 'lorebook') document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
    } catch (error) {
        if (isStoppedError(error)) {
            log.lifecycle('VectFox Vectorize Content: stopped by the user');
            return;
        }
        log.error('VectFox: Vectorization failed:', error);
        // A configuration error, such as a collection holding another vector size, already says how to fix it.
        if (isInvalidModelConfigError(error)) notifyInvalidModel(error.message);
        else toastr.error(`Vectorization failed: ${error.message}`, 'VectFox');
    } finally {
        endRun();
    }
}

/** Add what EventBase has not read of the chat yet, keeping what it read. */
async function resumeChat(typeId) {
    if (activeRun) return;
    const { source, problem } = sourceOf(typeId);
    if (!source) {
        showRunState(problem, typeId);
        return;
    }
    if (!hasLlmConfig(pageStateOf(typeId).settings)) return;
    await runEventBaseBackfill(typeId, {
        source,
        startFromMessage: startFromMessageOf(controlOf(typeId, 'start_from').value),
        parallelWindows: parallelWindowsOf(typeId),
        resetCaches: false,
    });
}

const parallelWindowsOf = typeId => parseInt(controlOf(typeId, 'parallel_windows')?.value, 10) || DEFAULT_PARALLEL_WINDOWS;

/**
 * Whether EventBase has read this chat before: windows it remembers, or a vectorization tip. A chat with neither has
 * nothing to reset, so Vectorize does not ask.
 */
async function hasPriorExtractionState(chatUUID) {
    if (!chatUUID) return false;
    const windows = extension_settings?.vectfox?.eventbase_extracted_windows?.[chatUUID];
    if (Array.isArray(windows) && windows.length > 0) return true;
    const { getVectorizationTip } = await import('../eventbase/index.js');
    return typeof getVectorizationTip(chatUUID) === 'number';
}

/**
 * Run EventBase on the open chat or an uploaded chat file. resetCaches (Vectorize) forgets what it read of the chat,
 * so it reads again from startFromMessage; without it (Resume, the auto-sync catch-up) only the unread messages go.
 *
 * @param {string} typeId - The page the run belongs to
 * @param {{source: object|null, startFromMessage: number, parallelWindows: number, resetCaches: boolean}} run - source
 *   null or of type current: the open chat; of type file: an uploaded chat
 * @returns {Promise<{shouldClose: boolean, message: string, hasReadNothing: boolean}|null>} How the run ended
 *   (eventBaseRunEnding); null when it did not start or failed, having said why
 */
async function runEventBaseBackfill(typeId, { source, startFromMessage, parallelWindows, resetCaches }) {
    if (activeRun) return null;
    log.lifecycle(`[EventBase] runEventBaseBackfill: starting... (resetCaches=${resetCaches})`);
    const signal = startRun(typeId);
    // On a touch screen the panel shows at once and the dialog closes, so the quick exits below still leave the
    // Progress button a panel to open.
    const isPanelShownAtStart = isTouchScreen();
    if (isPanelShownAtStart) progressTracker.show('EventBase Extraction', 0, 'Windows', { unitLabel: 'Messages', foundLabel: 'Events' });
    closeForProgressOnTouch();
    let endMessage = '';
    let ending = null;

    try {
        const { runEventBaseIngestion, countUnfinishedWindows, notifyUnfinishedWindows, prepareForFreshExtraction } = await import('../eventbase/index.js');
        const settings = extension_settings.vectfox || {};

        let result = null;
        if (source?.type === 'file') {
            const allMessages = (source.messages || []).filter(message => message.mes && message.mes.trim().length > 0);
            if (!allMessages.length) {
                toastr.warning('The chat file holds no messages EventBase can read.', 'EventBase');
                return null;
            }
            const skipped = Math.min(startFromMessage - 1, allMessages.length);
            if (skipped > 0) log.lifecycle(`[EventBase] Archive start-from message ${startFromMessage} — skipping first ${skipped} messages, ${allMessages.length - skipped} remaining`);
            const messages = allMessages.slice(skipped);
            const chatUUID = source.archiveUUID;
            const collectionIdOverride = buildArchiveEventCollectionId({ filenameCharName: source.filenameCharName, archiveUUID: chatUUID, backend: settings.vector_backend });
            // As on the open chat: Vectorize forgets what was read, and skipTipFallback keeps the Qdrant tip from
            // fast-forwarding past it.
            if (resetCaches && chatUUID) await prepareForFreshExtraction(chatUUID);
            log.lifecycle(`[EventBase] Archive upload route — collection: ${collectionIdOverride}, messages: ${messages.length}`);

            result = await runEventBaseIngestion({ messages, chatUUID, settings, abortSignal: signal, parallelWindows, collectionIdOverride, skipTipFallback: resetCaches });
        } else {
            result = await runOpenChat(signal, { startFromMessage, parallelWindows, resetCaches });
        }
        // No result: the run could not start, and said why.
        if (!result) return null;

        const unfinishedWindowCount = countUnfinishedWindows(result);
        ending = eventBaseRunEnding(result, { isStopped: signal.aborted, unfinishedWindowCount });
        // The workflow put its verdict on the progress panel; a stop gets the count saved, and windows left a sticky
        // notice, as they are the user's to send again.
        if (signal.aborted) progressTracker.complete(false, `Stopped — saved ${result.eventsExtracted} events from ${result.windowsProcessed} windows so far`);
        else if (unfinishedWindowCount > 0) notifyUnfinishedWindows(result);
        else if (!ending.shouldClose && isPanelShownAtStart) progressTracker.complete(true, ending.message);
        log.lifecycle(`[EventBase] Run ended: ${result.eventsExtracted} events from ${result.windowsProcessed} windows, ${result.windowsSkipped ?? 0} skipped, ${unfinishedWindowCount} unfinished`);
        endMessage = ending.message;
        if (ending.shouldClose) await closeContentVectorizer();
    } catch (error) {
        if (isStoppedError(error)) {
            log.lifecycle('[EventBase] Ingestion stopped by user');
            ending = eventBaseRunEnding(null, { isStopped: true });
            endMessage = ending.message;
            return ending;
        }
        // Insert failures carry Qdrant's own words, too long for a toast; a dialog lets the user read and copy them.
        if (error?.code === 'insert_failed_max_retries') {
            log.error('[EventBase] Insert failed after 3 retries:', error);
            await noticePopup([
                { text: 'EventBase stopped: the database refused the events.' },
                { text: 'VectFox tried 3 times. Nothing was half written, and the next run starts where this one stopped.' },
                { text: 'The database said:', name: error.message },
            ], { isWide: true });
            return null;
        }
        if (error?.code === 'insert_verification_failed') {
            log.error('[EventBase] Insert verification failed:', error);
            await noticePopup([
                { text: 'EventBase stopped: the database holds fewer events than VectFox wrote, with no error.' },
                { text: 'The collection is incomplete. The usual causes: two events sharing one ID, Similharity dropping a field, or Qdrant running out of room.' },
                { text: 'Details:', name: error.message },
                { text: 'Delete the collection and vectorize again once the cause is fixed. The console has more.' },
            ], { isWide: true });
            return null;
        }
        log.error('[EventBase] Backfill failed:', error);
        progressTracker.complete(false, `EventBase failed: ${error.message}`);
        // A configuration error, such as a model the provider does not offer, already says how to fix it.
        if (isInvalidModelConfigError(error)) notifyInvalidModel(error.message);
        else toastr.error(`EventBase failed: ${error.message}`, 'VectFox');
    } finally {
        endRun(endMessage);
    }
    return ending;
}

/**
 * Run EventBase over the open chat, asking first when its window size changed since EventBase last read it.
 *
 * @param {AbortSignal} signal - Stops the run
 * @param {{startFromMessage: number, parallelWindows: number, resetCaches: boolean}} run
 * @returns {Promise<object|null>} The run's result, or null when it did not run, having said why
 */
async function runOpenChat(signal, { startFromMessage, parallelWindows, resetCaches }) {
    const { prepareForFreshExtraction, checkWindowSizeChanged, setLastUsedWindowSize } = await import('../eventbase/index.js');
    const settings = extension_settings.vectfox || {};
    const context = getContext();
    if (!Array.isArray(context.chat) || !context.chat.length) {
        toastr.warning('The open chat has no messages to read.', 'EventBase');
        return null;
    }
    const chatUUID = getChatUUID();
    // Vectorize forgets what was read of the chat, so ingestion starts from startFromMessage instead of fast-forwarding
    // past a tip a deleted collection left; skipTipFallback below keeps the workflow from finding that tip in Qdrant.
    if (resetCaches && chatUUID) await prepareForFreshExtraction(chatUUID);

    // EventBase remembers the windows it read by their size, so a new size reads the whole chat again, paying for every
    // window. Ask first. checkWindowSizeChanged and prepareForFreshExtraction are the one rule for it.
    const sizeCheck = checkWindowSizeChanged(chatUUID, Math.max(2, settings.eventbase_window_size || 2));
    let freshExtraction = null;
    if (sizeCheck.changed) {
        const messageCount = context.chat.filter(message => message.mes && message.mes.trim().length > 0).length;
        const isConfirmed = await confirmPopup([
            { text: 'The window size changed since EventBase last read this chat.' },
            { text: 'Then:', name: `${sizeCheck.oldSize} messages` },
            { text: 'Now:', name: `${sizeCheck.newSize} messages` },
            { text: 'EventBase reads the chat again from the Start From message, about this many LLM calls:', name: formatCount(Math.floor(messageCount / sizeCheck.newSize)) },
            { text: 'The events it has stay, so the collection holds events at both sizes.' },
        ], { okButton: 'Read again', isDestructive: true });
        if (!isConfirmed) {
            progressTracker.complete(false, 'Cancelled — window size mismatch');
            return null;
        }
        // Stamped now, as the answer, not at the run's end: a run that fails midway would ask again otherwise.
        setLastUsedWindowSize(chatUUID, sizeCheck.newSize);
        log.lifecycle(`[EventBase] Window-size-change Proceed: stamped lastUsedWindowSize=${sizeCheck.newSize} for ${chatUUID} (user intent locked in regardless of run outcome)`);
        freshExtraction = await prepareForFreshExtraction(chatUUID);
    }

    const plan = getContentTypeDefaults('chat');
    const batchSize = Number(plan.batchSize) || 4;
    const { chunkText } = await import('./chunking.js');
    const plannedChunks = await chunkText(context.chat.filter(message => message.mes && message.mes.trim().length > 0), {
        strategy: plan.strategy || 'per_message',
        chunkSize: plan.chunkSize || 1000,
        chunkOverlap: plan.chunkOverlap || 200,
        batchSize,
    });
    return runEventBaseOnOpenChat(settings, signal, {
        startFromMessage,
        parallelWindows,
        progressPlan: { strategy: plan.strategy || 'per_message', batchSize, totalChunks: Array.isArray(plannedChunks) ? plannedChunks.length : 0 },
        // Both a Vectorize and a Yes to the window-size question asked to read the chat again, which the workflow's
        // Qdrant-side tip would otherwise fast-forward past.
        skipTipFallback: resetCaches || Boolean(freshExtraction?.skipTipFallback),
    });
}

/**
 * Auto-Reformat's Test connection, for the ChunkBase page. Loads the extractor when pressed, as a reformat does.
 *
 * @param {object} settings
 * @returns {Promise<{content: string, cutReason: string|null}>}
 */
export async function testAutoReformatConnection(settings) {
    const { runAutoReformatConnectionTest } = await import('./reformat-extractor.js');
    return runAutoReformatConnectionTest(settings);
}

/**
 * Run the open chat's catch-up without the dialog, as Resume does: the auto-sync switch calls it when a chat it turns
 * on has messages EventBase has not read. Resolves when the run ends; the progress panel shows it.
 *
 * @returns {Promise<{ran: boolean, reason?: string}>}
 */
export async function backfillCurrentChatWithProgress() {
    if (activeRun) {
        toastr.info('A vectorization is already running', 'VectFox');
        return { ran: false, reason: 'busy' };
    }
    await runEventBaseBackfill('chat', { source: null, startFromMessage: 1, parallelWindows: 1, resetCaches: false });
    return { ran: true };
}

/**
 * The Action page's Sync chat: once the user confirms, read what EventBase has not read of the open chat, as Resume does
 * with the dialog's defaults, without the dialog. A chat with nothing stored yet opens Vectorize Content on its Chat
 * page instead, since a first read takes that page's choices. A chat with nothing to read says so in a dialog: up to
 * date as the AutoSync page has it, or read further than the chat now goes. So does a run that finds nothing new, as no
 * page of the dialog is open to say it.
 *
 * @returns {Promise<{ran: boolean, reason?: string}>}
 */
export async function syncOpenChat() {
    if (activeRun) {
        toastr.info('A vectorization is already running', 'VectFox');
        return { ran: false, reason: 'busy' };
    }
    const settings = extension_settings.vectfox;
    const { getChatAutoSyncStatus, getVectorizationTip } = await import('../eventbase/index.js');
    const status = await getChatAutoSyncStatus(settings);
    if (status.state === 'no-chat') {
        toastr.info('Open a chat to sync it.', 'VectFox');
        return { ran: false, reason: 'no-chat' };
    }
    if (status.state === 'no-collection') {
        toastr.info('This chat has nothing stored yet, so Vectorize Content opens to read it the first time.', 'VectFox');
        openContentVectorizer('chat');
        return { ran: false, reason: 'no-collection' };
    }
    if (status.state === 'vectorization-ahead') {
        await noticePopup([
            { icon: 'fa-circle-info', text: 'Nothing to sync.' },
            { text: 'EventBase has read this chat further than it now goes, as after you delete messages. It reads again once the chat gets past that point.' },
        ]);
        return { ran: false, reason: 'ahead' };
    }
    const messageCount = status.chatMessageCount ?? 0;
    const readCount = status.vectorizationTip ?? getVectorizationTip(getChatUUID()) ?? null;
    const unreadMessages = Math.max(0, messageCount - (readCount ?? 0));
    const unfinishedWindows = status.unfinishedWindowCount ?? 0;
    // Up to date is the AutoSync page's verdict: the last full window read and none failed. Messages past it wait for
    // the chat to go on, and a run now would read nothing.
    if (status.state === 'fully-vectorized' || (unreadMessages === 0 && unfinishedWindows === 0)) {
        await noticePopup(syncUpToDateLines({ readCount, messageCount }));
        return { ran: false, reason: 'in-sync' };
    }
    if (!hasLlmConfig(settings)) return { ran: false, reason: 'no-model' };
    const isConfirmed = await confirmPopup([
        { icon: 'fa-rotate', text: 'Messages EventBase has not read:', name: String(unreadMessages) },
        ...(unfinishedWindows > 0 ? [{ text: 'Windows that failed before, read again:', name: String(unfinishedWindows) }] : []),
        { text: 'Sync reads them on the EventBase model, with a progress bar you can stop.' },
    ], { okButton: 'Sync' });
    if (!isConfirmed) return { ran: false, reason: 'cancelled' };
    const ending = await runEventBaseBackfill('chat', { source: null, startFromMessage: 1, parallelWindows: DEFAULT_PARALLEL_WINDOWS, resetCaches: false });
    if (ending?.hasReadNothing) await noticePopup([{ icon: 'fa-circle-info', text: ending.message }]);
    return { ran: true };
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────────────

const typeOfElement = element => element.closest('[data-cv-type]')?.dataset.cvType ?? null;

async function chooseFile(typeId) {
    const type = getContentType(typeId);
    const formats = type.sourceOptions.uploadFormats || type.sourceOptions.methods?.find(method => method.id === 'upload')?.formats || [];
    const [file] = await pickFiles({ accept: formats.join(',') });
    if (file) await loadFile(typeId, file);
}

function runAction(typeId, name) {
    switch (name) {
        case 'choose-file': return chooseFile(typeId);
        case 'fetch': return fetchSource(typeId);
        case 'reformat': return runAutoReformat(typeId);
        case 'reformat-discard':
            pageStateOf(typeId).settings.reformat = null;
            return showReformat(typeId);
        // Text Cleaning may change the preset, which every page shows.
        case 'manage-cleaning': return void openTextCleaningDialog().then(() => showCleaningPreset(getCleaningSettings().selectedPreset || 'custom'));
        case 'preview': return previewChunks(typeId);
        case 'resume': return resumeChat(typeId);
        case 'vectorize': return startVectorization(typeId);
        // Through the panel first, so it says Stopping too; stopRun covers a run whose panel has not shown yet.
        case 'stop':
            progressTracker.requestCancel();
            return stopRun();
        default: return undefined;
    }
}

/** The cleaning preset is VectFox's one setting, so every page's select shows the one chosen, on a page or in Text Cleaning. */
function showCleaningPreset(presetId) {
    if (!session) return;
    const description = cleaningPresetChoices().find(preset => preset.id === presetId)?.description || '';
    for (const each of ALL_TYPE_IDS) {
        pageStateOf(each).settings.cleaningPreset = presetId;
        const select = controlOf(each, 'cleaning_preset');
        if (select) select.value = presetId;
        const note = hintOf(each, 'cleaning-note');
        if (note) note.textContent = description;
    }
}

/** Each control writes its page's settings; the window size and overlap are VectFox's saved settings. */
function readControl(control) {
    const typeId = typeOfElement(control);
    if (!typeId) return;
    const settings = pageStateOf(typeId).settings;
    const name = control.id.slice(cvId(typeId, '').length);
    switch (name) {
        case 'source_choice': return chooseSource(typeId);
        case 'source_select': return showSourceStats(typeId, control.value);
        case 'strategy':
            settings.strategy = control.value;
            return refreshChunking(typeId);
        case 'chunk_size': settings.chunkSize = parseInt(control.value, 10) || undefined; return undefined;
        case 'batch_size': settings.batchSize = parseInt(control.value, 10) || undefined; return undefined;
        case 'window_size':
            extension_settings.vectfox.eventbase_window_size = parseInt(control.value, 10) || 2;
            return saveSettingsDebounced();
        case 'window_overlap':
            extension_settings.vectfox.eventbase_window_overlap = parseInt(control.value, 10) || 0;
            return saveSettingsDebounced();
        case 'start_from': control.value = String(startFromMessageOf(control.value)); return undefined;
        case 'scope': settings.scope = control.value; return undefined;
        case 'cleaning_preset':
            chooseCleaningPreset(control.value);
            return showCleaningPreset(control.value);
        case 'keyword_level': settings.keywordLevel = control.value; return undefined;
        case 'include_disabled': settings.includeDisabled = control.checked; return undefined;
        case 'wiki_type': {
            const wiki = getContentType('wiki').sourceOptions.types.find(each => each.id === control.value);
            if (wiki) controlOf('wiki', 'wiki_url').placeholder = wiki.placeholder;
            return showWikiPluginState();
        }
        default: return undefined;
    }
}

function bindVectorizer(root) {
    root.addEventListener('click', (event) => {
        const tab = event.target.closest('.vfx-nav-item');
        if (tab && root.contains(tab)) {
            showTypePage(tab.id.slice(cvTabId('').length));
            return;
        }
        const button = event.target.closest('[data-cv-action]');
        if (!button || button.disabled) return;
        const typeId = typeOfElement(button);
        if (typeId) void runAction(typeId, button.dataset.cvAction);
    });
    root.addEventListener('change', (event) => {
        const control = event.target;
        if (control.matches('[data-cv-field]')) {
            const typeId = typeOfElement(control);
            const fields = { ...(pageStateOf(typeId).settings.fields || getContentTypeDefaults(typeId).fields) };
            fields[control.dataset.cvField] = control.checked;
            pageStateOf(typeId).settings.fields = fields;
            return;
        }
        if (control.id) void readControl(control);
    });
    // A file dropped on the Source card of a page that takes files loads as one picked there. Any file drag stops at the
    // dialog: SillyTavern's own drop on the page body imports a dropped PNG, JSON or YAML as a character.
    root.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = fileDropPageOf(event.target) ? 'copy' : 'none';
    });
    root.addEventListener('drop', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        const typeId = fileDropPageOf(event.target);
        const file = event.dataTransfer.files?.[0];
        if (!typeId || !file) return;
        const control = controlOf(typeId, 'source_choice');
        if (control.value !== 'file') {
            control.value = 'file';
            chooseSource(typeId);
        }
        void loadFile(typeId, file);
    });
}

/** The page whose Source card an element sits in, when that page can take a file; null otherwise. */
function fileDropPageOf(element) {
    const sourceCard = element.closest?.('[id$="_source_card"]');
    if (!sourceCard) return null;
    const typeId = typeOfElement(sourceCard);
    const control = controlOf(typeId, 'source_choice');
    return control && [...control.options].some(option => option.value === 'file') ? typeId : null;
}
