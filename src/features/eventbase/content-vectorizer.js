/**
 * ============================================================================
 * VECTORIZE CONTENT
 * ============================================================================
 * The dialog that runs EventBase over a chat: the open chat or an uploaded chat
 * file, read in windows of messages (content-vectorizer-markup.js draws it, and
 * content-vectorizer-core.js holds its rules). On a chat that has a collection,
 * Vectorize asks Catch up, Start over or New collection (§2.1 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md), or,
 * with Read windows already read again on, reads the stretch from Start to End
 * again (eventbase-read-again.js). A run goes on with the dialog closed, and the
 * progress panel shows it. Sync chat and the auto-sync switch's catch-up run here
 * too, without the dialog.
 * ============================================================================
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { getContext } from '../../sillytavern/chat.js';
import { choicePopup, closePanelPopup, confirmPopup, noticePopup, openPanelPopup } from '../../sillytavern/popup.js';
import { log } from '../../sillytavern/log.js';
import { validateLLMConfig } from '../llm-provider/index.js';
import { getSavedHashes } from '../vector-backend/index.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { getOpenRouterApiKey } from '../../shared/api-keys.js';
import { buildArchiveEventCollectionId, buildRegistryKey, getChatUUID, parseRegistryKey } from '../../shared/collection-ids.js';
import { chooseCleaningPreset, cleaningPresetChoices, getCleaningSettings, openTextCleaningDialog, presetDescription } from '../text-cleaning/index.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { pickFiles } from '../../shared/pick-files.js';
import { bindGeneBehaviours, syncSliders } from '../../shared/gui-dna/gene-behaviours.js';
import {
    CHAT_FILE_FORMATS,
    chatCharacterName,
    endAtMessageOf,
    eventBaseRunEnding,
    extractCharNameFromArchiveFilename,
    fileExtension,
    parseChatFile,
    startFromMessageOf,
    stretchWords,
    syncUpToDateLines,
} from './content-vectorizer-core.js';
import { CHAT_TYPE_ID, contentVectorizerMarkup, cvId, cvPageId, loadedSourceMarkup } from './content-vectorizer-markup.js';
import { runEventBaseOnOpenChat } from './eventbase-chat-sync.js';
import { describeReadingAgain, finishReadingAgain } from './eventbase-read-again.js';
import { readAgainConfirmLines } from './eventbase-read-again-core.js';
import {
    NEW_COLLECTION, askWhichChatCollection, collectionInUse, resolveEventBaseRunTarget, startNewChatCollection,
} from './eventbase-chat-collections.js';
import {
    emptyEventBaseCollection, getCollectionWindowSize, getVectorizationTip, prepareForFreshExtraction, readEventBaseProgress,
    setCollectionWindowSize,
} from './eventbase-store.js';
import { countUnfinishedWindows, getChatAutoSyncStatus, notifyUnfinishedWindows, runEventBaseIngestion } from './eventbase-workflow.js';

/** How many windows EventBase reads at once when the dialog does not say. */
const DEFAULT_PARALLEL_WINDOWS = 3;

const formatCount = count => Number(count).toLocaleString('en-US');

/**
 * The open dialog: its root, the chat file it loaded, and whether it was opened on New collection, so its Vectorize
 * reads the open chat into a new collection. Null while closed.
 */
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
 * @param {{isOnNewCollection?: boolean}} [opening] - isOnNewCollection: opened on New collection, as the last choice of
 *   Collection in use here and the question's New collection open it; an open dialog turns to it
 */
export function openContentVectorizer({ isOnNewCollection = false } = {}) {
    if (session) {
        if (isOnNewCollection) showNewCollectionChosen(true);
        return;
    }
    const cleaningPreset = getCleaningSettings().selectedPreset || 'custom';
    const template = document.createElement('template');
    const cleaningPresets = cleaningPresetChoices();
    template.innerHTML = contentVectorizerMarkup({ view: { chat: currentChatView(), cleaningPresets, cleaningPreset, cleaningNote: presetDescription(cleaningPresets, cleaningPreset) } });
    const root = template.content.firstElementChild;
    session = { root, sourceData: null, isDialogOpen: true, isOnNewCollection: false };
    setStartingValues();
    bindGeneBehaviours(root);
    bindVectorizer(root);
    syncSliders(root);
    showRunState();
    showNewCollectionChosen(isOnNewCollection);

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

/**
 * Whether the dialog's Vectorize reads the open chat into a new collection; the run card's line says so while the
 * source is the open chat, as a chat file reads into its archive collection.
 */
function showNewCollectionChosen(isChosen) {
    if (!session) return;
    session.isOnNewCollection = isChosen;
    showPart('new-collection', isChosen && sourceChoice() === 'this');
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
    // Only the open chat's collection in use is read again.
    showPart('read-again', choice === 'this');
    showNewCollectionChosen(session.isOnNewCollection);
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
 * What a run of the open chat reads into: its first collection, which the run makes, while the chat has none of its
 * own ('first'); the one locked to it ('in-use'), asked for while none is (askWhichChatCollection); or a new one
 * ('new'), chosen there or by opening the dialog on New collection.
 * @param {{canMakeNew: boolean, isNewCollectionChosen?: boolean}} options - canMakeNew: the question offers New
 *   collection; isNewCollectionChosen: the dialog was opened on it
 * @returns {Promise<'first'|'in-use'|'new'|null>} Null on Cancel
 */
async function collectionOfRun({ canMakeNew, isNewCollectionChosen = false }) {
    const settings = extension_settings.vectfox || {};
    if (!collectionInUse(settings).collections.length) return 'first';
    if (isNewCollectionChosen) return 'new';
    const answer = await askWhichChatCollection(settings, { canMakeNew });
    if (answer === NEW_COLLECTION) return 'new';
    return answer ? 'in-use' : null;
}

/**
 * The page's source once a run on it may start, with what the run reads into: no run going, a source chosen, the
 * EventBase model set, and for the open chat its collection (collectionOfRun); a chat file reads into its archive
 * collection ('file'). Null once the page or a dialog has said why not.
 * @param {{canMakeNew: boolean, isNewCollectionChosen?: boolean}} options - As collectionOfRun takes them
 * @returns {Promise<{source: object, collection: 'file'|'first'|'in-use'|'new'}|null>}
 */
async function sourceReadyToRun(options) {
    if (activeRun) return null;
    const { source, problem } = sourceOfPage();
    if (!source) {
        showRunState(problem);
        return null;
    }
    if (!hasLlmConfig()) return null;
    if (source.type === 'file') return { source, collection: 'file' };
    const collection = await collectionOfRun(options);
    return collection ? { source, collection } : null;
}

/**
 * The run the page sets up: its source, the messages it starts from and ends at, how many windows it reads at once,
 * and whether it reads the open chat's windows already read again.
 */
const runOfPage = source => ({
    source,
    startFromMessage: startFromMessageOf(controlOf('start_from').value),
    endAtMessage: endAtMessageOf(controlOf('end_at')?.value),
    parallelWindows: parallelWindowsOfPage(),
    isReadingAgain: source.type === 'current' && Boolean(controlOf('read_again')?.checked),
});

/**
 * Vectorize: a chat's first read into its first collection; on a chat that has a collection, Catch up, Start over or
 * New collection (askVectorizeChoice), or with Read windows already read again on, the stretch read again
 * (readStretchAgain); New collection at once when the dialog was opened on it or the question chose it; a chat file
 * read afresh into its archive collection.
 */
async function startVectorization() {
    const ready = await sourceReadyToRun({ canMakeNew: true, isNewCollectionChosen: Boolean(session?.isOnNewCollection) });
    if (!ready) return;
    const run = runOfPage(ready.source);
    if (ready.collection === 'file') return vectorizeChatFile(run);
    if (ready.collection === 'first') return readFirstCollection(run, { resetCaches: true });
    if (ready.collection === 'new') return readIntoNewCollection(run);
    if (run.isReadingAgain) return readStretchAgain(run);
    const choice = await askVectorizeChoice(run);
    if (choice === 'catch-up') return catchUp(run);
    if (choice === 'start-over') return startOver(run);
    if (choice === 'new-collection') return readIntoNewCollection(run);
    return undefined;
}

/** Resume: Catch up, the dialog's one click; a chat with no collection yet is read into its first. */
async function resumeChat() {
    const ready = await sourceReadyToRun({ canMakeNew: true });
    if (!ready) return;
    const run = runOfPage(ready.source);
    if (ready.collection === 'first') return readFirstCollection(run, { resetCaches: false });
    if (ready.collection === 'new') return readIntoNewCollection(run);
    return catchUp(run);
}

/**
 * Vectorize's question on a chat whose collection is in use (§2.1 of
 * InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md).
 * @param {{startFromMessage: number, endAtMessage: number|null}} run
 * @returns {Promise<'catch-up'|'start-over'|'new-collection'|null>} Null on Cancel
 */
function askVectorizeChoice(run) {
    const { collection } = collectionInUse(extension_settings.vectfox || {});
    return choicePopup([
        { text: 'This chat reads into:', name: collection?.name ?? '' },
        { text: 'Catch up reads the messages it has not read.' },
        { text: `Start over empties it, then reads the chat again ${stretchWords(run)}.` },
        { text: `New collection reads the chat ${stretchWords(run)} into a new collection, and keeps this one.` },
    ], { choices: [
        { text: 'Catch up', value: 'catch-up' },
        { text: 'Start over', value: 'start-over' },
        { text: 'New collection', value: 'new-collection' },
    ] });
}

/** The dialog's Window size, which a chat's first read, New collection and Start over read with (§2.7). */
const dialogWindowSize = () => Math.max(2, (extension_settings.vectfox || {}).eventbase_window_size || 2);

/**
 * The window size a run reads a collection with: the one the collection keeps, else the dialog's, which it keeps from
 * then on.
 * @param {string|null} registryKey
 * @returns {number}
 */
function windowSizeKeptBy(registryKey) {
    const kept = registryKey ? getCollectionWindowSize(registryKey) : undefined;
    if (typeof kept === 'number') return kept;
    const windowSize = dialogWindowSize();
    if (registryKey) setCollectionWindowSize(registryKey, windowSize);
    return windowSize;
}

/** Catch up: read the messages the collection in use has not read, at its window size. */
function catchUp(run) {
    const registryKey = registryKeyOfRun(run.source, extension_settings.vectfox || {});
    return runEventBaseBackfill({ ...run, resetCaches: false, windowSize: windowSizeKeptBy(registryKey) });
}

/**
 * A chat's first read into its first collection, at the dialog's window size, which the collection keeps. Vectorize
 * forgets what a collection of that ID left behind; Resume carries on from it.
 * @param {object} run
 * @param {{resetCaches: boolean}} reading
 */
function readFirstCollection(run, { resetCaches }) {
    const registryKey = registryKeyOfRun(run.source, extension_settings.vectfox || {});
    const windowSize = dialogWindowSize();
    if (registryKey) setCollectionWindowSize(registryKey, windowSize);
    return runEventBaseBackfill({ ...run, resetCaches, windowSize });
}

/**
 * A chat file's Vectorize: read it again into its archive collection, asking first when EventBase has read it before,
 * at the dialog's window size, which the collection keeps.
 */
async function vectorizeChatFile(run) {
    const registryKey = registryKeyOfRun(run.source, extension_settings.vectfox || {});
    if (hasPriorExtractionState(registryKey)) {
        const isConfirmed = await confirmPopup([
            { text: 'Read this chat again from the start?' },
            { text: 'From message:', name: String(run.startFromMessage) },
            ...(run.endAtMessage == null ? [] : [{ text: 'To message:', name: String(run.endAtMessage) }]),
            { text: 'Its progress resets, and EventBase reads it again, paying for each window.' },
            { text: 'Each window it reads again replaces the events it had, so they do not repeat.' },
            { text: 'Resume adds only the messages not read yet.' },
        ], { okButton: 'Read again', isDestructive: true });
        if (!isConfirmed) return;
    }
    const windowSize = dialogWindowSize();
    setCollectionWindowSize(registryKey, windowSize);
    await runEventBaseBackfill({ ...run, resetCaches: true, windowSize });
}

/**
 * Start over (§2.6): after a red confirm, empty the collection in use, its StoryArc links with its events, then read
 * the chat again from the Start from message at the dialog's window size. A delete that fails leaves the collection's
 * progress as it was, and says so.
 */
async function startOver(run) {
    const settings = extension_settings.vectfox || {};
    const { collection: inUse } = collectionInUse(settings);
    const registryKey = inUse?.registryKey;
    if (!registryKey) return;
    let eventCount = null;
    try {
        eventCount = (await getSavedHashes(parseRegistryKey(registryKey).collectionId, settings)).length;
    } catch (error) {
        log.warn('[EventBase] Start over could not count the events it would delete:', error);
    }
    const isConfirmed = await confirmPopup([
        { text: 'Start this collection over?', name: inUse?.name ?? '' },
        ...(eventCount === null ? [] : [{ text: 'Events it deletes, with their StoryArc links:', name: formatCount(eventCount) }]),
        { text: `EventBase then reads the chat again ${stretchWords(run)}, paying for each window.` },
        { text: 'New collection keeps these events, and reads the chat into a new collection instead.' },
    ], { okButton: 'Start over', isDestructive: true });
    if (!isConfirmed) return;
    const windowSize = dialogWindowSize();
    try {
        await emptyEventBaseCollection(registryKey, settings, { windowSize });
    } catch (error) {
        log.error('[EventBase] Start over could not empty the collection:', error);
        toastr.error(`Start over stopped: the collection could not be emptied (${error.message}), so nothing was read again. Start over again to retry.`, 'EventBase');
        return;
    }
    await runEventBaseBackfill({ ...run, resetCaches: true, windowSize });
}

/**
 * New collection (§2.1, §2.5): read the open chat from the Start from message into a new collection of its own, at the
 * dialog's window size; its run puts it in use, the chat's others unlocked there. Says once it is in use that auto-sync
 * is off for it, as the collection it replaces may have had it on.
 */
async function readIntoNewCollection(run) {
    const settings = extension_settings.vectfox || {};
    const windowSize = dialogWindowSize();
    let made;
    try {
        made = startNewChatCollection(settings, { windowSize });
    } catch (error) {
        log.error('[EventBase] New collection could not be made:', error);
        toastr.error(`New collection could not be made: ${error.message}`, 'EventBase');
        return;
    }
    showNewCollectionChosen(false);
    await runEventBaseBackfill({ ...run, resetCaches: true, windowSize, collectionIdOverride: made.collectionId });
    const isInUse = collectionInUse(settings).collection?.registryKey === made.registryKey;
    if (isInUse) toastr.info(`"${made.name}" is in use in this chat now. Auto-sync is off for it: turn it on on the AutoSync page.`, 'EventBase', { timeOut: 12000 });
}

/**
 * Read windows already read again (eventbase-read-range-again.md): after a red confirm that shows what the stretch from
 * Start to End holds and what the run costs, read every window of it again into the collection in use at its window
 * size, each replacing its events; StoryArc then links the new events and decides again the events whose links went
 * into it, on the same progress panel. Nothing to read says why on the page.
 */
async function readStretchAgain(run) {
    const settings = extension_settings.vectfox || {};
    const windowSize = windowSizeKeptBy(registryKeyOfRun(run.source, settings));
    const plan = await describeReadingAgain({ settings, startFromMessage: run.startFromMessage, endAtMessage: run.endAtMessage, windowSize });
    if (plan.problem) {
        showRunState(plan.problem);
        return;
    }
    const isConfirmed = await confirmPopup(readAgainConfirmLines(plan), { okButton: 'Read again', isDestructive: true });
    if (!isConfirmed) return;
    await runEventBaseBackfill({ ...run, resetCaches: false, windowSize, readAgainPlan: plan });
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
 * Whether EventBase has read a chat file into its archive collection before: windows it remembers, or a vectorization
 * tip. A collection with neither has nothing to reset, so the file's Vectorize does not ask.
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
 * Run EventBase on the open chat or an uploaded chat file, from startFromMessage to endAtMessage. resetCaches (a first
 * read, Start over, New collection, a chat file's Vectorize) forgets what was read into the collection, so it reads
 * again from startFromMessage; without it (Catch up, Resume, Sync chat, the auto-sync catch-up) only the unread
 * messages go, unless a readAgainPlan reads the stretch again (readStretchAgain).
 *
 * @param {{source: object|null, startFromMessage: number, endAtMessage?: number|null, parallelWindows: number,
 *   resetCaches: boolean, windowSize?: number, collectionIdOverride?: string|null, readAgainPlan?: object|null}} run -
 *   source null or of type current: the open chat; of type file: an uploaded chat. windowSize: the collection's
 *   (windowSizeKeptBy, dialogWindowSize). collectionIdOverride: New collection's collection, else the chat's run
 *   target. readAgainPlan: describeReadingAgain's plan, which reads the open chat's stretch again
 * @returns {Promise<{shouldClose: boolean, message: string, hasReadNothing: boolean}|null>} How the run ended
 *   (eventBaseRunEnding); null when it did not start or failed, having said why
 */
async function runEventBaseBackfill({ source, startFromMessage, endAtMessage = null, parallelWindows, resetCaches, windowSize, collectionIdOverride = null, readAgainPlan = null }) {
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
            const archiveCollectionId = buildArchiveEventCollectionId({ filenameCharName: source.filenameCharName, archiveUUID: chatUUID, backend: settings.vector_backend });
            // As on the open chat: Vectorize forgets what was read, and skipTipFallback keeps the Qdrant tip from
            // fast-forwarding past it.
            if (resetCaches) await prepareForFreshExtraction(buildRegistryKey(archiveCollectionId, settings));
            log.lifecycle(`[EventBase] Archive upload route — collection: ${archiveCollectionId}, messages: ${messages.length}`);

            result = await runEventBaseIngestion({ messages, startFromMessage, endAtMessage, chatUUID, settings, abortSignal: signal, parallelWindows, collectionIdOverride: archiveCollectionId, skipTipFallback: resetCaches, windowSizeOverride: windowSize });
        } else {
            result = await runOpenChat(signal, { startFromMessage, endAtMessage, parallelWindows, resetCaches, windowSize, collectionIdOverride, readAgainPlan });
        }
        // No result: the run could not start, and said why.
        if (!result) return null;

        const unfinishedWindowCount = countUnfinishedWindows(result);
        ending = eventBaseRunEnding(result, { isStopped: signal.aborted, unfinishedWindowCount });
        // The workflow put its verdict on the progress panel; a stop gets the count saved, and windows left a sticky
        // notice, as they are the user's to send again. A stretch read again links its events next, and its verdict
        // ends the panel.
        if (readAgainPlan) {
            const verdict = await finishReadingAgain({ result, plan: readAgainPlan, settings, shouldStop: () => signal.aborted });
            ending = { ...ending, shouldClose: ending.shouldClose && verdict.isSuccess, message: verdict.message };
            if (unfinishedWindowCount > 0 && !signal.aborted) notifyUnfinishedWindows(result);
        } else if (signal.aborted) progressTracker.complete(false, `Stopped — saved ${result.eventsExtracted} events from ${result.windowsProcessed} windows so far`);
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
 * Run EventBase over the open chat, into the collection given or the chat's run target, at the window size given. A
 * readAgainPlan reads the stretch's windows again and leaves the progress panel open for its link steps.
 *
 * @param {AbortSignal} signal - Stops the run
 * @param {{startFromMessage: number, endAtMessage: number|null, parallelWindows: number, resetCaches: boolean,
 *   windowSize?: number, collectionIdOverride?: string|null, readAgainPlan: object|null}} run
 * @returns {Promise<object|null>} The run's result, or null when it did not run, having said why
 */
async function runOpenChat(signal, { startFromMessage, endAtMessage, parallelWindows, resetCaches, windowSize, collectionIdOverride, readAgainPlan }) {
    const settings = extension_settings.vectfox || {};
    const context = getContext();
    if (!Array.isArray(context.chat) || !context.chat.length) {
        toastr.warning('The open chat has no messages to read.', 'EventBase');
        return null;
    }
    // The collection the run reads into: its pointer says how far the chat was read.
    const registryKey = collectionIdOverride ? buildRegistryKey(collectionIdOverride, settings) : registryKeyOfRun({ type: 'current' }, settings);
    // A read from the start forgets what was read into the collection, so ingestion starts from startFromMessage instead
    // of fast-forwarding past a tip a deleted collection left; skipTipFallback below keeps the workflow from finding that
    // tip in Qdrant.
    if (resetCaches && registryKey) await prepareForFreshExtraction(registryKey);

    const messageCount = context.chat.filter(message => message.mes && message.mes.trim().length > 0).length;
    return runEventBaseOnOpenChat(settings, signal, {
        startFromMessage,
        endAtMessage,
        isReadingAgain: Boolean(readAgainPlan),
        shouldCompleteProgress: !readAgainPlan,
        progressTitle: readAgainPlan?.stepTitles.windows,
        parallelWindows,
        // The progress panel's message count: one per message with words, as the windows read them.
        progressPlan: { strategy: 'per_message', batchSize: 1, totalChunks: messageCount },
        skipTipFallback: resetCaches,
        collectionIdOverride,
        windowSizeOverride: windowSize,
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
    const windowSize = windowSizeKeptBy(registryKeyOfRun({ type: 'current' }, extension_settings.vectfox || {}));
    await runEventBaseBackfill({ source: null, startFromMessage: 1, parallelWindows: 1, resetCaches: false, windowSize });
    return { ran: true };
}

/**
 * The Action page's Sync chat: once the user confirms, read what EventBase has not read of the open chat into its
 * collection in use, at the collection's window size, as Resume does with the dialog's defaults, without the dialog. A
 * chat with nothing stored yet opens Vectorize Content instead, since a first read takes the dialog's choices; one with
 * collections but none locked asks which one to use first, its New collection opening Vectorize Content on New
 * collection. A chat with nothing to read says so in a dialog: up to date as the AutoSync page has it, or read further
 * than the chat now goes. So does a run that finds nothing new, as the dialog is not open to say it.
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
        const answer = await askWhichChatCollection(settings, { canMakeNew: true });
        if (answer === NEW_COLLECTION) {
            openContentVectorizer({ isOnNewCollection: true });
            return { ran: false, reason: 'new-collection' };
        }
        if (!answer) return { ran: false, reason: 'cancelled' };
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
    // A tip past the chat's end was read on a longer chat (messages deleted, or a summary replacing some), so it counts
    // nothing here: Sync asks to read what the window record does not hold.
    const isTipPastChatEnd = status.state === 'vectorization-ahead';
    const messageCount = status.chatMessageCount ?? 0;
    const readCount = status.vectorizationTip ?? getVectorizationTip(status.registryKey) ?? null;
    const unreadMessages = Math.max(0, messageCount - (readCount ?? 0));
    const unfinishedWindows = status.unfinishedWindowCount ?? 0;
    // Up to date is the AutoSync page's verdict: the last full window read and none failed. Messages past it wait for
    // the chat to go on, and a run now would read nothing.
    if (!isTipPastChatEnd && (status.state === 'fully-vectorized' || (unreadMessages === 0 && unfinishedWindows === 0))) {
        await noticePopup(syncUpToDateLines({ readCount, messageCount }));
        return { ran: false, reason: 'in-sync' };
    }
    if (!hasLlmConfig()) return { ran: false, reason: 'no-model' };
    const isConfirmed = await confirmPopup([
        isTipPastChatEnd
            ? { icon: 'fa-rotate', text: 'This chat is shorter than what EventBase read, so the messages it has not read cannot be counted.' }
            : { icon: 'fa-rotate', text: 'Messages EventBase has not read:', name: String(unreadMessages) },
        ...(unfinishedWindows > 0 ? [{ text: 'Windows that failed before, read again:', name: String(unfinishedWindows) }] : []),
        { text: 'Sync reads them on the EventBase model, with a progress bar you can stop.' },
    ], { okButton: 'Sync' });
    if (!isConfirmed) return { ran: false, reason: 'cancelled' };
    const windowSize = windowSizeKeptBy(status.registryKey ?? registryKeyOfRun({ type: 'current' }, settings));
    const ending = await runEventBaseBackfill({ source: null, startFromMessage: 1, parallelWindows: DEFAULT_PARALLEL_WINDOWS, resetCaches: false, windowSize });
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
    if (note) note.textContent = presetDescription(cleaningPresetChoices(), presetId);
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
        case 'end_at': control.value = String(endAtMessageOf(control.value) ?? ''); return undefined;
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
