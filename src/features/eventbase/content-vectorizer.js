/**
 * ============================================================================
 * VECTORIZE CONTENT
 * ============================================================================
 * The dialog that runs EventBase over a chat: the open chat or an uploaded chat
 * file, read in windows of messages (content-vectorizer-markup.js draws it, and
 * content-vectorizer-core.js holds its rules). A run goes on with the dialog
 * closed, and the progress panel shows it. Sync chat and the auto-sync switch's
 * catch-up run here too, without the dialog.
 * ============================================================================
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { getContext } from '../../sillytavern/chat.js';
import { closePanelPopup, confirmPopup, noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { log } from '../../sillytavern/log.js';
import { validateLLMConfig } from '../llm-provider/index.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { getOpenRouterApiKey } from '../../shared/api-keys.js';
import { buildArchiveEventCollectionId, buildRegistryKey, getChatUUID } from '../../shared/collection-ids.js';
import { chooseCleaningPreset, cleaningPresetChoices, getCleaningSettings, openTextCleaningDialog } from '../text-cleaning/index.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { pickFiles } from '../../shared/pick-files.js';
import { bindGeneBehaviours, syncSliders } from '../../shared/gui-dna/gene-behaviours.js';
import {
    CHAT_FILE_FORMATS,
    chatCharacterName,
    eventBaseRunEnding,
    extractCharNameFromArchiveFilename,
    fileExtension,
    parseChatFile,
    startFromMessageOf,
    syncUpToDateLines,
} from './content-vectorizer-core.js';
import { CHAT_TYPE_ID, contentVectorizerMarkup, cvId, cvPageId, loadedSourceMarkup } from './content-vectorizer-markup.js';
import { runEventBaseOnOpenChat } from './eventbase-chat-sync.js';
import { askWhichChatCollection, chatOwnCollections, resolveEventBaseRunTarget } from './eventbase-chat-collections.js';
import { checkWindowSizeChanged, getVectorizationTip, prepareForFreshExtraction, readEventBaseProgress, setLastUsedWindowSize } from './eventbase-store.js';
import { countUnfinishedWindows, getChatAutoSyncStatus, notifyUnfinishedWindows, runEventBaseIngestion } from './eventbase-workflow.js';

/** How many windows EventBase reads at once when the dialog does not say. */
const DEFAULT_PARALLEL_WINDOWS = 3;

const formatCount = count => Number(count).toLocaleString('en-US');

/** The open dialog: its root and the chat file it loaded. Null while closed. */
let session = null;

/** The run in progress, from the dialog or without it: its abort controller and origin. Null when none runs. */
let activeRun = null;

// ── Opening and closing ─────────────────────────────────────────────────────────────────────────────────

/** The open chat as the Chat page shows it, or null. */
function currentChatView() {
    const context = getContext();
    if (!context?.chatId) return null;
    return { messageCount: context.chat?.length || 0, characterName: context.name2 || 'Unknown', chatId: getChatUUID() || 'unknown' };
}

/**
 * Open Vectorize Content. Resolves once the dialog is open; a run started in it goes on after it closes.
 */
export function openContentVectorizer() {
    if (session) return;
    const cleaningPreset = getCleaningSettings().selectedPreset || 'custom';
    const template = document.createElement('template');
    template.innerHTML = contentVectorizerMarkup({ view: { chat: currentChatView(), cleaningPresets: cleaningPresetChoices(), cleaningPreset } });
    const root = template.content.firstElementChild;
    session = { root, sourceData: null, isDialogOpen: true };
    setStartingValues();
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

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────

const pageElement = () => session?.root.querySelector(`#${cvPageId(CHAT_TYPE_ID)}`) ?? null;
const controlOf = name => session?.root.querySelector(`#${cvId(CHAT_TYPE_ID, name)}`) ?? null;
const hintOf = name => pageElement()?.querySelector(`[data-cv-hint="${name}"]`) ?? null;

function showPart(name, isShown) {
    for (const part of pageElement()?.querySelectorAll(`[data-cv-part="${name}"]`) ?? []) part.hidden = !isShown;
}

function paintFile(markup) {
    const region = pageElement()?.querySelector('[data-cv-region="file"]');
    if (region) region.innerHTML = markup;
}

/** The values the sliders start with: the windows at once, and the saved window size and overlap. */
function setStartingValues() {
    const settings = extension_settings.vectfox || {};
    const setValue = (name, value) => {
        const control = controlOf(name);
        if (control) control.value = String(value);
    };
    setValue('parallel_windows', DEFAULT_PARALLEL_WINDOWS);
    setValue('window_size', settings.eventbase_window_size ?? 2);
    setValue('window_overlap', settings.eventbase_window_overlap ?? 0);
}

// ── Source ──────────────────────────────────────────────────────────────────────────────────────────────

const sourceChoice = () => controlOf('source_choice')?.value ?? null;

/** Show the part of the Source card the choice names, and forget a chat file loaded before. */
function chooseSource() {
    const choice = sourceChoice();
    for (const name of ['this', 'file']) showPart(name, name === choice);
    session.sourceData = null;
    paintFile('');
}

/** Read a picked or dropped chat file into the page's source. */
async function loadFile(file) {
    paintFile(loadedSourceMarkup({ state: 'busy', busyText: `Reading ${file.name}…` }));
    try {
        const text = await file.text();
        const { messages, metadata } = parseChatFile(text, fileExtension(file.name));
        if (!messages.length) throw new Error('It holds no messages.');
        const integrity = metadata?.chat_metadata?.integrity;
        if (!integrity) log.warn(`[VectFox] Archive "${file.name}" has no chat_metadata.integrity — using SHA-1 hash as UUID`);
        const characterName = chatCharacterName(messages, metadata);
        session.sourceData = {
            type: 'file',
            filename: file.name,
            messages,
            metadata,
            characterName,
            archiveUUID: integrity || await sha1Hex(text),
            filenameCharName: extractCharNameFromArchiveFilename(file.name) || metadata?.character_name || 'archive',
        };
        paintFile(loadedSourceMarkup({ state: 'done', lines: [
            { text: 'File', name: file.name },
            { text: 'Messages', name: formatCount(messages.length) },
            { text: 'Character', name: characterName },
            { text: 'Text', name: `${formatCount(messages.reduce((sum, message) => sum + (message.mes?.length || 0), 0))} characters` },
        ] }));
        log.lifecycle(`VectFox Vectorize Content: loaded ${file.name}`);
    } catch (error) {
        log.error(`VectFox Vectorize Content: ${file.name} could not be read:`, error);
        if (session) session.sourceData = null;
        paintFile(loadedSourceMarkup({ state: 'failed', reason: error.message }));
    }
}

/** A hex SHA-1 of text: an archive's ID when its file carries no chat_metadata.integrity. */
async function sha1Hex(text) {
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The page's source, or why there is none: the chat file it loaded, or the open chat.
 *
 * @returns {{source: object|null, problem: string}}
 */
function sourceOfPage() {
    if (session.sourceData) return { source: session.sourceData, problem: '' };
    if (sourceChoice() === 'file') return { source: null, problem: 'Choose a file first.' };
    const context = getContext();
    if (!context?.chatId || !context.chat?.length) return { source: null, problem: 'The open chat has no messages.' };
    return { source: { type: 'current', id: context.chatId, name: context.name2 || 'Chat' }, problem: '' };
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The run state on the open page: while a run goes on, its buttons are off and Stop shows; else the line under the
 * buttons says what the last attempt needs.
 *
 * @param {string} [message] - Why the last attempt did not start, or how the last run ended
 */
function showRunState(message = '') {
    if (!session) return;
    const isRunning = Boolean(activeRun);
    for (const name of ['resume', 'vectorize']) {
        for (const control of pageElement().querySelectorAll(`[data-cv-action="${name}"]`)) control.disabled = isRunning;
    }
    showPart('stop', isRunning);
    const line = hintOf('run-state');
    if (line) line.textContent = isRunning ? 'Vectorizing; the progress panel shows how far.' : message;
}

/** The EventBase model is set, or the user is told where to set it. */
function hasLlmConfig() {
    const settings = extension_settings.vectfox || {};
    const isOnProfile = settings.chat_provider === CONNECTION_PROFILE_PROVIDER;
    log.verbose('[VectFox] LLM config check (vectorize-content):', {
        provider: settings.chat_provider,
        model: settings.chat_model,
        connectionProfileId: isOnProfile ? settings.chat_connection_profile_id : '',
        hasOpenRouterKey: !!getOpenRouterApiKey(),
        hasVllmUrl: !!settings.chat_vllm_url,
    });
    const check = validateLLMConfig(settings);
    // A profile's reason already names where to fix it.
    const where = isOnProfile ? '' : ' Open VectFox → Core → EventBase model and fill in the required fields.';
    // Sticky, as every run fails the same way until the user fixes it.
    if (!check.ok) toastr.error(`${check.reason}${where}`, 'Configuration required', { timeOut: 0, extendedTimeOut: 0 });
    return check.ok;
}

const isTouchScreen = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** On a touch screen the dialog covers the progress panel, so it closes while the run goes on. */
function closeForProgressOnTouch() {
    if (isTouchScreen()) void closeContentVectorizer();
}

function startRun() {
    activeRun = { abortController: new AbortController(), isFromDialog: Boolean(session) };
    progressTracker.setCancelHandler(() => stopRun());
    showRunState();
    return activeRun.abortController.signal;
}

/** @param {string} [message] - What the page says once the run ends, where nothing else has said it */
function endRun(message = '') {
    progressTracker.clearCancelHandler();
    const { isFromDialog } = activeRun;
    activeRun = null;
    showRunState(message);
    // A run without the dialog has no close to announce.
    if (isFromDialog) announceClosedWhenIdle();
}

/** The progress panel's Stop and the page's call it; the run ends once what was already sent comes back. */
function stopRun() {
    if (!activeRun || activeRun.abortController.signal.aborted) return;
    activeRun.abortController.abort('user-stop');
    const line = hintOf('run-state');
    if (line) line.textContent = 'Stopping: what was already sent finishes first.';
}

const isStoppedError = error => error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('stopped by user');

/**
 * Whether the open chat may be read now: one of its collections is locked to it, or it has none yet, which its first
 * read makes; with collections but none locked, the question asks which one to use and locks it (askWhichChatCollection).
 * @returns {Promise<boolean>} False on Cancel
 */
async function hasCollectionInUse() {
    const settings = extension_settings.vectfox || {};
    if (!chatOwnCollections(settings).length) return true;
    return Boolean(await askWhichChatCollection(settings));
}

/**
 * The page's source once a run on it may start: no run going, a source chosen, the EventBase model set, and for the
 * open chat a collection in use (hasCollectionInUse). Null once the page or a dialog has said why not.
 * @returns {Promise<object|null>}
 */
async function sourceReadyToRun() {
    if (activeRun) return null;
    const { source, problem } = sourceOfPage();
    if (!source) {
        showRunState(problem);
        return null;
    }
    if (!hasLlmConfig()) return null;
    if (source.type !== 'file' && !await hasCollectionInUse()) return null;
    return source;
}

/** Vectorize: read the chat afresh from its Start From message, asking first when EventBase has read it before. */
async function startVectorization() {
    const source = await sourceReadyToRun();
    if (!source) return;
    // Resume adds only what is new.
    const registryKey = registryKeyOfRun(source, extension_settings.vectfox || {});
    const startFromMessage = startFromMessageOf(controlOf('start_from').value);
    if (hasPriorExtractionState(registryKey)) {
        const isConfirmed = await confirmPopup([
            { text: 'Read this chat again from the start?' },
            { text: 'From message:', name: String(startFromMessage) },
            { text: 'Its progress resets, and EventBase reads it again, paying for each window.' },
            { text: 'Each window it reads again replaces the events it had, so they do not repeat.' },
            { text: 'Resume adds only the messages not read yet.' },
        ], { okButton: 'Read again', isDestructive: true });
        if (!isConfirmed) return;
    }
    await runEventBaseBackfill({ source, startFromMessage, parallelWindows: parallelWindowsOfPage(), resetCaches: true });
}

/** Add what EventBase has not read of the chat yet, keeping what it read. */
async function resumeChat() {
    const source = await sourceReadyToRun();
    if (!source) return;
    await runEventBaseBackfill({
        source,
        startFromMessage: startFromMessageOf(controlOf('start_from').value),
        parallelWindows: parallelWindowsOfPage(),
        resetCaches: false,
    });
}

const parallelWindowsOfPage = () => parseInt(controlOf('parallel_windows')?.value, 10) || DEFAULT_PARALLEL_WINDOWS;

/**
 * The registry key ("backend:id") of the collection a run on the source reads into: an uploaded chat's archive
 * collection, or the open chat's (resolveEventBaseRunTarget). Null when no chat is open, or none of its collections is
 * locked to it.
 *
 * @param {{type: string, archiveUUID?: string, filenameCharName?: string}} source
 * @param {object} settings - extension_settings.vectfox
 * @returns {string|null}
 */
function registryKeyOfRun(source, settings) {
    if (source.type === 'file') {
        const archiveCollectionId = buildArchiveEventCollectionId({ filenameCharName: source.filenameCharName, archiveUUID: source.archiveUUID, backend: settings.vector_backend });
        return buildRegistryKey(archiveCollectionId, settings);
    }
    const chatUUID = getChatUUID();
    return chatUUID ? resolveEventBaseRunTarget(settings, chatUUID)?.registryKey ?? null : null;
}

/**
 * Whether EventBase has read the chat into the collection before: windows it remembers, or a vectorization tip. A
 * collection with neither has nothing to reset, so Vectorize does not ask.
 *
 * @param {string|null} registryKey - The collection's registry key ("backend:id")
 * @returns {boolean}
 */
function hasPriorExtractionState(registryKey) {
    if (!registryKey) return false;
    const windows = readEventBaseProgress(registryKey).extractedWindows;
    if (Array.isArray(windows) && windows.length > 0) return true;
    return typeof getVectorizationTip(registryKey) === 'number';
}

/**
 * Run EventBase on the open chat or an uploaded chat file. resetCaches (Vectorize) forgets what it read of the chat,
 * so it reads again from startFromMessage; without it (Resume, the auto-sync catch-up) only the unread messages go.
 *
 * @param {{source: object|null, startFromMessage: number, parallelWindows: number, resetCaches: boolean}} run - source
 *   null or of type current: the open chat; of type file: an uploaded chat
 * @returns {Promise<{shouldClose: boolean, message: string, hasReadNothing: boolean}|null>} How the run ended
 *   (eventBaseRunEnding); null when it did not start or failed, having said why
 */
async function runEventBaseBackfill({ source, startFromMessage, parallelWindows, resetCaches }) {
    if (activeRun) return null;
    log.lifecycle(`[EventBase] runEventBaseBackfill: starting... (resetCaches=${resetCaches})`);
    const signal = startRun();
    // On a touch screen the panel shows at once and the dialog closes, so the quick exits below still leave the
    // Progress button a panel to open.
    const isPanelShownAtStart = isTouchScreen();
    if (isPanelShownAtStart) progressTracker.show('EventBase Extraction', 0, 'Windows', { unitLabel: 'Messages', foundLabel: 'Events' });
    closeForProgressOnTouch();
    let endMessage = '';
    let ending = null;

    try {
        const settings = extension_settings.vectfox || {};

        let result = null;
        if (source?.type === 'file') {
            const messages = (source.messages || []).filter(message => message.mes && message.mes.trim().length > 0);
            if (!messages.length) {
                toastr.warning('The chat file holds no messages EventBase can read.', 'EventBase');
                return null;
            }
            const chatUUID = source.archiveUUID;
            const collectionIdOverride = buildArchiveEventCollectionId({ filenameCharName: source.filenameCharName, archiveUUID: chatUUID, backend: settings.vector_backend });
            // As on the open chat: Vectorize forgets what was read, and skipTipFallback keeps the Qdrant tip from
            // fast-forwarding past it.
            if (resetCaches) await prepareForFreshExtraction(buildRegistryKey(collectionIdOverride, settings));
            log.lifecycle(`[EventBase] Archive upload route — collection: ${collectionIdOverride}, messages: ${messages.length}`);

            result = await runEventBaseIngestion({ messages, startFromMessage, chatUUID, settings, abortSignal: signal, parallelWindows, collectionIdOverride, skipTipFallback: resetCaches });
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
    const settings = extension_settings.vectfox || {};
    const context = getContext();
    if (!Array.isArray(context.chat) || !context.chat.length) {
        toastr.warning('The open chat has no messages to read.', 'EventBase');
        return null;
    }
    // The collection the run reads into: its pointer says how far the chat was read.
    const registryKey = registryKeyOfRun({ type: 'current' }, settings);
    // Vectorize forgets what was read of the chat, so ingestion starts from startFromMessage instead of fast-forwarding
    // past a tip a deleted collection left; skipTipFallback below keeps the workflow from finding that tip in Qdrant.
    if (resetCaches && registryKey) await prepareForFreshExtraction(registryKey);

    const messageCount = context.chat.filter(message => message.mes && message.mes.trim().length > 0).length;
    // EventBase remembers the windows it read by their size, so a new size reads the whole chat again, paying for every
    // window. Ask first. checkWindowSizeChanged and prepareForFreshExtraction are the one rule for it.
    const sizeCheck = checkWindowSizeChanged(registryKey, Math.max(2, settings.eventbase_window_size || 2));
    let freshExtraction = null;
    if (sizeCheck.changed) {
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
        setLastUsedWindowSize(registryKey, sizeCheck.newSize);
        log.lifecycle(`[EventBase] Window-size-change Proceed: stamped lastUsedWindowSize=${sizeCheck.newSize} for ${registryKey} (user intent locked in regardless of run outcome)`);
        freshExtraction = await prepareForFreshExtraction(registryKey);
    }

    return runEventBaseOnOpenChat(settings, signal, {
        startFromMessage,
        parallelWindows,
        // The progress panel's message count: one per message with words, as the windows read them.
        progressPlan: { strategy: 'per_message', batchSize: 1, totalChunks: messageCount },
        // Both a Vectorize and a Yes to the window-size question asked to read the chat again, which the workflow's
        // Qdrant-side tip would otherwise fast-forward past.
        skipTipFallback: resetCaches || Boolean(freshExtraction?.skipTipFallback),
    });
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
    await runEventBaseBackfill({ source: null, startFromMessage: 1, parallelWindows: 1, resetCaches: false });
    return { ran: true };
}

/**
 * The Action page's Sync chat: once the user confirms, read what EventBase has not read of the open chat, as Resume does
 * with the dialog's defaults, without the dialog. A chat with nothing stored yet opens Vectorize Content instead, since
 * a first read takes the dialog's choices; one with collections but none locked asks which one to use first. A chat with nothing to read says so in a dialog: up to date as the AutoSync
 * page has it, or read further than the chat now goes. So does a run that finds nothing new, as the dialog is not open
 * to say it.
 *
 * @returns {Promise<{ran: boolean, reason?: string}>}
 */
export async function syncOpenChat() {
    if (activeRun) {
        toastr.info('A vectorization is already running', 'VectFox');
        return { ran: false, reason: 'busy' };
    }
    const settings = extension_settings.vectfox;
    let status = await getChatAutoSyncStatus(settings);
    if (status.state === 'none-locked') {
        if (!await askWhichChatCollection(settings)) return { ran: false, reason: 'cancelled' };
        status = await getChatAutoSyncStatus(settings);
    }
    if (status.state === 'no-chat') {
        toastr.info('Open a chat to sync it.', 'VectFox');
        return { ran: false, reason: 'no-chat' };
    }
    if (status.state === 'no-collection') {
        toastr.info('This chat has nothing stored yet, so Vectorize Content opens to read it the first time.', 'VectFox');
        openContentVectorizer();
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
    const readCount = status.vectorizationTip ?? getVectorizationTip(status.registryKey) ?? null;
    const unreadMessages = Math.max(0, messageCount - (readCount ?? 0));
    const unfinishedWindows = status.unfinishedWindowCount ?? 0;
    // Up to date is the AutoSync page's verdict: the last full window read and none failed. Messages past it wait for
    // the chat to go on, and a run now would read nothing.
    if (status.state === 'fully-vectorized' || (unreadMessages === 0 && unfinishedWindows === 0)) {
        await noticePopup(syncUpToDateLines({ readCount, messageCount }));
        return { ran: false, reason: 'in-sync' };
    }
    if (!hasLlmConfig()) return { ran: false, reason: 'no-model' };
    const isConfirmed = await confirmPopup([
        { icon: 'fa-rotate', text: 'Messages EventBase has not read:', name: String(unreadMessages) },
        ...(unfinishedWindows > 0 ? [{ text: 'Windows that failed before, read again:', name: String(unfinishedWindows) }] : []),
        { text: 'Sync reads them on the EventBase model, with a progress bar you can stop.' },
    ], { okButton: 'Sync' });
    if (!isConfirmed) return { ran: false, reason: 'cancelled' };
    const ending = await runEventBaseBackfill({ source: null, startFromMessage: 1, parallelWindows: DEFAULT_PARALLEL_WINDOWS, resetCaches: false });
    if (ending?.hasReadNothing) await noticePopup([{ icon: 'fa-circle-info', text: ending.message }]);
    return { ran: true };
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────────────

async function chooseFile() {
    const [file] = await pickFiles({ accept: CHAT_FILE_FORMATS.join(',') });
    if (file) await loadFile(file);
}

function runAction(name) {
    switch (name) {
        case 'choose-file': return chooseFile();
        case 'manage-cleaning': return void openTextCleaningDialog().then(() => showCleaningPreset(getCleaningSettings().selectedPreset || 'custom'));
        case 'resume': return resumeChat();
        case 'vectorize': return startVectorization();
        // Through the panel first, so it says Stopping too; stopRun covers a run whose panel has not shown yet.
        case 'stop':
            progressTracker.requestCancel();
            return stopRun();
        default: return undefined;
    }
}

/** The cleaning preset is VectFox's one setting, so the select shows the one chosen, here or in Text Cleaning. */
function showCleaningPreset(presetId) {
    if (!session) return;
    const select = controlOf('cleaning_preset');
    if (select) select.value = presetId;
    const note = hintOf('cleaning-note');
    if (note) note.textContent = cleaningPresetChoices().find(preset => preset.id === presetId)?.description || '';
}

/** Each control writes what it sets; the window size and overlap are VectFox's saved settings. */
function readControl(control) {
    switch (control.id.slice(cvId(CHAT_TYPE_ID, '').length)) {
        case 'source_choice': return chooseSource();
        case 'window_size':
            extension_settings.vectfox.eventbase_window_size = parseInt(control.value, 10) || 2;
            return saveSettingsDebounced();
        case 'window_overlap':
            extension_settings.vectfox.eventbase_window_overlap = parseInt(control.value, 10) || 0;
            return saveSettingsDebounced();
        case 'start_from': control.value = String(startFromMessageOf(control.value)); return undefined;
        case 'cleaning_preset':
            chooseCleaningPreset(control.value);
            return showCleaningPreset(control.value);
        default: return undefined;
    }
}

function bindVectorizer(root) {
    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-cv-action]');
        if (!button || button.disabled) return;
        void runAction(button.dataset.cvAction);
    });
    root.addEventListener('change', (event) => {
        if (event.target.id) void readControl(event.target);
    });
    // A file dropped on the Source card loads as one picked there. Any file drag stops at the dialog: SillyTavern's own
    // drop on the page body imports a dropped PNG, JSON or YAML as a character.
    root.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = isOnSourceCard(event.target) ? 'copy' : 'none';
    });
    root.addEventListener('drop', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        const file = event.dataTransfer.files?.[0];
        if (!isOnSourceCard(event.target) || !file) return;
        const control = controlOf('source_choice');
        if (control.value !== 'file') {
            control.value = 'file';
            chooseSource();
        }
        void loadFile(file);
    });
}

/** Whether an element sits in the Source card, which takes a dropped chat file. */
const isOnSourceCard = element => Boolean(element.closest?.(`#${cvId(CHAT_TYPE_ID, 'source_card')}`));
