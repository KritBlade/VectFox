/**
 * ============================================================================
 * STORY ARC PAGE
 * ============================================================================
 * Opens the StoryArc page in its dialog and runs its two tabs: Main, with the story
 * web, and Entity, with the merged names. The page is MOVED into the dialog, never
 * cloned, so every handler bound at startup keeps working, and moves back on close.
 * A page reads the chat's events when it opens, and again when asked.
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';
import { notice } from '../../shared/gui-dna/gui-dna-core.js';
import { saveEntityMerges, readEntityMerges } from './story-arc-entities.js';
import { buildEntityNameWriter, entityNamesLeftAlone, filterEntities, listEntities, mergeEntityNames, splitEntityName, withKeptEntityNames } from './story-arc-entity-core.js';
import { ENTITY_MERGE_TARGET_ID, ENTITY_SPLIT_NAME_ID, entityListMarkup } from './story-arc-entity-ui.js';
import { readChatStoryEvents } from './story-arc-links.js';
import { STORY_ARC_ELEMENT_ID, STORY_ARC_PAGE_HOLDER_ID, STORY_ARC_PAGE_ID } from './story-arc-page-markup.js';
import { findStoryWebEvents } from './story-arc-retrieval.js';
import { drawStoryWeb } from './story-arc-web.js';
import { buildStoryWeb, linksOfNode, selectedEventMarkup } from './story-arc-web-core.js';

const TOAST_TITLE = 'VectFox StoryArc';
const ENTITY_KINDS = ['people', 'factions', 'places'];

const page = {
    isOpen: false,
    settings: null,
    onOpen: null,
    collectionKey: '',
    events: [],
    merges: {},
    web: null,
    webData: null,
    webViewStatus: '',
    isWebFloating: null,
    openTab: 'main',
    entityKind: 'people',
    entityWord: '',
    entityPageIndex: 0,
    mergingName: null,
    splittingName: null,
};

const elementOf = id => document.getElementById(id);

/** Events as the page shows them, with kept names. */
const readableEvents = () => withKeptEntityNames(page.events, buildEntityNameWriter(page.merges, page.events));

function showProblem(id, problem) {
    elementOf(id).innerHTML = problem ? notice({ status: 'warning', name: problem }) : '';
}

// ---------------------------------------------------------------------------- Entity tab

function paintEntityTab() {
    const rows = filterEntities(listEntities(page.events, page.merges, page.entityKind), page.entityWord);
    const nameChoices = [...new Set(ENTITY_KINDS.flatMap(kind => listEntities(page.events, page.merges, kind).map(row => row.name)))];
    const { list, pagerMarkup, pageIndex } = entityListMarkup({
        rows,
        kind: page.entityKind,
        pageIndex: page.entityPageIndex,
        mergingName: page.mergingName,
        splittingName: page.splittingName,
        nameChoices,
    });
    page.entityPageIndex = pageIndex;
    elementOf(STORY_ARC_ELEMENT_ID.entityList).innerHTML = list;
    elementOf(STORY_ARC_ELEMENT_ID.entityPager).innerHTML = pagerMarkup;
}

/** Save a change to the merges, and show it wherever names are shown. */
function applyMerges(merges) {
    page.merges = merges;
    saveEntityMerges(page.collectionKey, merges);
    page.mergingName = null;
    page.splittingName = null;
    paintEntityTab();
    if (page.web) {
        const { nodes } = buildStoryWeb(readableEvents());
        page.web.setLines(new Map(nodes.map(node => [node.id, node.line])));
    }
}

async function confirmMerge(sourceName) {
    const targetName = elementOf(ENTITY_MERGE_TARGET_ID)?.value ?? '';
    const { isMerged, merges, reason } = mergeEntityNames(page.merges, sourceName, targetName);
    if (!isMerged) {
        toastr.warning(reason, TOAST_TITLE);
        return;
    }
    const leftAlone = entityNamesLeftAlone(merges, page.events).filter(name => name.includes(sourceName));
    const { confirmPopup } = await import('../../sillytavern/popup.js');
    const isConfirmed = await confirmPopup([
        { text: 'Merge these names?' },
        { text: 'Kept:', name: targetName.trim() },
        { text: 'Reads as the kept name:', name: sourceName },
        ...(leftAlone.length ? [{ text: 'Stays its own entity, unless you merge it too:', name: leftAlone.join(' · ') }] : []),
        { text: 'StoryArc then sees one entity. Stored events stay as they are, and Split undoes this.' },
    ], { okButton: 'Merge' });
    if (isConfirmed) applyMerges(merges);
}

async function runEntityAction(action, name) {
    if (action === 'merge') {
        page.mergingName = page.mergingName === name ? null : name;
        page.splittingName = null;
    } else if (action === 'split') {
        page.splittingName = page.splittingName === name ? null : name;
        page.mergingName = null;
    } else if (action === 'close-panel') {
        page.mergingName = null;
        page.splittingName = null;
    } else if (action === 'page-previous') {
        page.entityPageIndex = Math.max(page.entityPageIndex - 1, 0);
    } else if (action === 'page-next') {
        page.entityPageIndex += 1;
    } else if (action === 'merge-confirm') {
        await confirmMerge(name);
        return;
    } else if (action === 'split-confirm') {
        applyMerges(splitEntityName(page.merges, name, elementOf(ENTITY_SPLIT_NAME_ID).value));
        return;
    }
    paintEntityTab();
}

// ---------------------------------------------------------------------------- Story web

function setWebStatus(text) {
    elementOf(STORY_ARC_ELEMENT_ID.webStatus).textContent = text;
}

function describeWholeWeb() {
    const { nodes, links } = page.webData;
    return `${nodes.length} events, ${links.length} links. Hover near a dot to stop the web and light what connects to it, and click to go into it.`;
}

function webActionButton(action) {
    return elementOf(STORY_ARC_ELEMENT_ID.webCanvas).closest('.vfx-card').querySelector(`[data-web-action="${action}"]`);
}

/** What the page says about the view the web now shows: a sub graph's centre, or null for the whole web. */
function showWebView(centre, shownNodes) {
    webActionButton('back').style.display = centre ? '' : 'none';
    if (!centre) {
        elementOf(STORY_ARC_ELEMENT_ID.webSelected).innerHTML = '';
        setWebStatus(page.webViewStatus);
        return;
    }
    const nodeById = new Map(page.webData.nodes.map(node => [node.id, node]));
    elementOf(STORY_ARC_ELEMENT_ID.webSelected).innerHTML = selectedEventMarkup(centre, linksOfNode(centre.id, page.webData.links, nodeById));
    const connectedCount = shownNodes.length - 1;
    setWebStatus(connectedCount
        ? `#${centre.message} and the ${connectedCount} ${connectedCount === 1 ? 'event' : 'events'} linked to it. Click one to go on from there.`
        : `#${centre.message} has no links.`);
}

function showFloatingButton() {
    const button = webActionButton('pause');
    button.querySelector('span').textContent = page.isWebFloating ? 'Pause' : 'Resume';
    button.querySelector('i').className = `fa-solid ${page.isWebFloating ? 'fa-pause' : 'fa-play'}`;
}

function toggleFloating() {
    page.isWebFloating = !page.isWebFloating;
    showFloatingButton();
    page.web?.setFloating(page.isWebFloating);
}

function closeWeb() {
    page.web?.destroy();
    page.web = null;
    page.webData = null;
    elementOf(STORY_ARC_ELEMENT_ID.webSelected).innerHTML = '';
    webActionButton('back').style.display = 'none';
}

async function drawWeb() {
    closeWeb();
    page.webData = buildStoryWeb(readableEvents());
    setWebStatus(`Drawing ${page.webData.nodes.length} events...`);
    showFloatingButton();
    try {
        const web = await drawStoryWeb(elementOf(STORY_ARC_ELEMENT_ID.webCanvas), page.webData, {
            onViewChange: showWebView,
            isFloating: page.isWebFloating,
        });
        if (!page.isOpen) {
            web.destroy();
            return;
        }
        page.web = web;
        page.webViewStatus = describeWholeWeb();
        showWebView(null, []);
    } catch (error) {
        log.error('[VectFox-StoryArc] The story web could not be drawn:', error);
        toastr.error(`The story web could not be drawn: ${error.message}`, TOAST_TITLE);
        setWebStatus('');
    }
}

async function findLinks() {
    const question = elementOf(STORY_ARC_ELEMENT_ID.webQuery).value.trim();
    if (!question || !page.web) return;
    setWebStatus('Searching...');
    const found = await findStoryWebEvents({
        question,
        collectionKey: page.collectionKey,
        storedEvents: page.events,
        merges: page.merges,
        settings: page.settings,
    });
    if (!found.reachedHashes.length) {
        setWebStatus('The search found nothing for that.');
        return;
    }
    page.webViewStatus = `${found.closestHashes.length} closest events, and ${found.reachedHashes.length} events along their links. No LLM was called.`;
    page.web.showFound(found);
    setWebStatus(page.webViewStatus);
}

function clearFound() {
    elementOf(STORY_ARC_ELEMENT_ID.webQuery).value = '';
    if (!page.web) return;
    page.webViewStatus = describeWholeWeb();
    page.web.clearFound();
    setWebStatus(page.webViewStatus);
}

function runWebAction(action) {
    if (action === 'find') return findLinks();
    if (action === 'clear') return clearFound();
    if (action === 'back') return page.web?.goBack();
    if (action === 'pause') return toggleFloating();
    return readAndPaintPage();
}

// ---------------------------------------------------------------------------- Page

function showTab(tab) {
    page.openTab = tab;
    const root = elementOf(STORY_ARC_PAGE_ID);
    for (const button of root.querySelectorAll('[data-story-arc-tab]')) {
        const isShown = button.dataset.storyArcTab === tab;
        button.classList.toggle('is-active', isShown);
        button.setAttribute('aria-selected', String(isShown));
    }
    for (const panel of root.querySelectorAll('[data-story-arc-panel]')) {
        panel.style.display = panel.dataset.storyArcPanel === tab ? '' : 'none';
    }
    page.web?.setPaused(tab !== 'main');
}

/** Read the chat's events, then paint both tabs from them. */
async function readAndPaintPage() {
    closeWeb();
    const chat = await readChatStoryEvents(page.settings, { shouldLogResolution: false });
    if (!page.isOpen) return;
    showProblem(STORY_ARC_ELEMENT_ID.webProblem, chat.problem);
    showProblem(STORY_ARC_ELEMENT_ID.entityProblem, chat.problem);
    if (chat.problem) {
        page.events = [];
        page.merges = {};
        page.collectionKey = '';
        setWebStatus('');
        paintEntityTab();
        return;
    }
    page.events = chat.events;
    page.collectionKey = chat.registryKey;
    page.merges = readEntityMerges([chat.registryKey]);
    paintEntityTab();
    await drawWeb();
    page.web?.setPaused(page.openTab !== 'main');
}

/**
 * Bind the page's handlers once, at startup, on the page's own elements. Delegated, so
 * rows painted later behave the same.
 *
 * @param {object} settings
 */
export function wireStoryArcPage(settings) {
    page.settings = settings;
    const root = elementOf(STORY_ARC_PAGE_ID);
    if (!root) {
        log.error('[VectFox-StoryArc] The page markup is missing, so its handlers cannot be bound');
        return;
    }
    root.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const tabButton = target?.closest('[data-story-arc-tab]');
        if (tabButton) showTab(tabButton.dataset.storyArcTab);
        const collapse = target?.closest('.vfx-collapse');
        if (collapse) {
            const card = collapse.closest('.vfx-card');
            const isCollapsed = !card.classList.contains('is-collapsed');
            card.classList.toggle('is-collapsed', isCollapsed);
            collapse.setAttribute('aria-expanded', String(!isCollapsed));
        }
        const entityButton = target?.closest('[data-entity-action]');
        if (entityButton && !entityButton.disabled) {
            runEntityAction(entityButton.dataset.entityAction, entityButton.dataset.name)
                .catch(error => log.error('[VectFox-StoryArc] An entity action failed:', error));
        }
        const webButton = target?.closest('[data-web-action]');
        if (webButton) {
            Promise.resolve(runWebAction(webButton.dataset.webAction))
                .catch(error => log.error('[VectFox-StoryArc] A story web action failed:', error));
        }
    });
    elementOf(STORY_ARC_ELEMENT_ID.webQuery).addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        findLinks().catch(error => log.error('[VectFox-StoryArc] A story web search failed:', error));
    });
    elementOf(STORY_ARC_ELEMENT_ID.entityKind).addEventListener('change', (event) => {
        page.entityKind = event.target.value;
        page.entityPageIndex = 0;
        paintEntityTab();
    });
    elementOf(STORY_ARC_ELEMENT_ID.entitySearch).addEventListener('input', (event) => {
        page.entityWord = event.target.value;
        page.entityPageIndex = 0;
        paintEntityTab();
    });
}

/**
 * Open the page in its dialog, and wait until it closes.
 *
 * @param {() => void} onOpen - Refreshes what the page's other handlers own
 * @returns {Promise<void>}
 */
export async function openStoryArcPage(onOpen) {
    const root = elementOf(STORY_ARC_PAGE_ID);
    const holder = elementOf(STORY_ARC_PAGE_HOLDER_ID);
    if (!root || !holder) {
        log.error('[VectFox-StoryArc] The page or its holder is missing, so it cannot open');
        return;
    }
    if (page.isOpen) return;
    page.isOpen = true;
    page.isWebFloating ??= !matchMedia('(prefers-reduced-motion: reduce)').matches;
    onOpen();
    const { openPanelPopup } = await import('../../sillytavern/popup.js');
    const closed = openPanelPopup(root);
    readAndPaintPage().catch(error => log.error('[VectFox-StoryArc] The page could not read this chat:', error));
    try {
        await closed;
    } finally {
        // First: SillyTavern has removed the dialog by now, so the page's elements cannot be found until it is back,
        // and the next open cannot find the page at all if a failure below strands it.
        holder.appendChild(root);
        page.isOpen = false;
        closeWeb();
    }
}
