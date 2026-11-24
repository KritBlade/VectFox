/**
 * ============================================================================
 * STORY ARC PAGE, STATIC MARKUP
 * ============================================================================
 * VectFox's first page on the GUI-DNA (mvu-helper/devdoc/gui-dna.md), one page on
 * the settings panel's rail. Every control the page's handlers look for is found by
 * its id or a data-* hook. Pure: builds a string.
 * ============================================================================
 */

import { button, detail, fieldLabel, grid, hint, iconButton, resultList, selectOption, select, field } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, pageHeader, sliderNumber, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { counted } from '../../shared/counted.js';
import { LINK_PARALLEL_CALLS_DEFAULT, LINK_PARALLEL_CALLS_MAX, STORY_LINK_STATE, USABLE_DECIDED_SHARE, storyLinkState } from './story-arc-links-core.js';
import { chatProviderOptions, connectionProfileRows, testConnectionButton } from '../../shared/connection-profile-rows-markup.js';

/** The rail finds each page as VectFox_panel_<name> (settings-panel/panel-shell-markup.js). */
export const STORY_ARC_PAGE_ID = 'VectFox_panel_storyarc';

export const STORY_ARC_ELEMENT_ID = Object.freeze({
    webStatus: 'VectFox_story_arc_web_status',
    webCanvas: 'VectFox_story_arc_web',
    webQuery: 'VectFox_story_arc_web_query',
    webSelected: 'VectFox_story_arc_web_selected',
    webProblem: 'VectFox_story_arc_web_problem',
    entityProblem: 'VectFox_story_arc_entity_problem',
    entityKind: 'VectFox_story_arc_entity_kind',
    entitySearch: 'VectFox_story_arc_entity_search',
    entityList: 'VectFox_story_arc_entity_list',
    entityPager: 'VectFox_story_arc_entity_pager',
    entityHiddenToggle: 'VectFox_story_arc_entity_hidden_toggle',
});

const CHAT_CHIP = '<span class="vfx-chip"><i class="fa-solid fa-comments"></i><span>This chat</span></span>';

function subnavButton({ tab, icon, text, isActive = false }) {
    return `<button type="button" class="vfx-subnav-item${isActive ? ' is-active' : ''}" role="tab" aria-selected="${isActive}" data-story-arc-tab="${tab}"><i class="fa-solid ${icon}"></i><span>${text}</span></button>`;
}

function legendLinkType(text, typeClass) {
    return `<span class="vfx-story-web-key"><span class="vfx-story-web-line ${typeClass}"></span>${text}</span>`;
}

function storyWebCard() {
    const { webStatus, webCanvas, webQuery, webSelected, webProblem } = STORY_ARC_ELEMENT_ID;
    return `<section class="vfx-card">
        ${cardHeader({
            icon: 'fa-diagram-project',
            title: 'Story web',
            description: 'Every event and its links. Searching here calls no LLM.',
            actions: `${CHAT_CHIP}${iconButton({ icon: 'fa-rotate', title: 'Reload events', data: { 'web-action': 'reload' } })}`,
        })}
        <div class="vfx-card-body vfx-stack">
            <div class="vfx-control-row">
                <input type="text" id="${webQuery}" class="vfx-input vfx-story-web-query" placeholder="Ask about the story's past" title="Question to find links for">
                ${button({ text: 'Find links', icon: 'fa-magnifying-glass', kind: 'primary', data: { 'web-action': 'find' } })}
                ${button({ text: 'Show all', icon: 'fa-circle-nodes', data: { 'web-action': 'clear' } })}
                ${button({ text: 'Go back', icon: 'fa-arrow-left', data: { 'web-action': 'back' } })}
                ${button({ text: 'Pause', icon: 'fa-pause', data: { 'web-action': 'pause' } })}
            </div>
            <div id="${webProblem}"></div>
            <div id="${webCanvas}" class="vfx-story-web"></div>
            <div class="vfx-story-web-legend">
                <span class="vfx-story-web-key"><span>Few links</span><span class="vfx-story-web-heat"></span><span>Many</span></span>
                ${legendLinkType('Continues', 'is-continues')}
                ${legendLinkType('Caused by', 'is-caused-by')}
                ${legendLinkType('Reveals', 'is-reveals')}
                <span class="vfx-story-web-key"><span class="vfx-story-web-ring"></span>Closest hit</span>
            </div>
            <p id="${webStatus}" class="vfx-hint"></p>
            <div id="${webSelected}"></div>
        </div>
    </section>`;
}

function modeCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-link', title: 'StoryArc mode', description: 'The switch, and the links it follows.' })}
        <div class="vfx-card-body vfx-stack">
            ${switchRow({ id: 'VectFox_story_arc_mode_enabled', title: 'Enable StoryArc mode', description: 'Adds one small LLM call per message, on the link model. Needs Qdrant.' })}
            ${field([
                fieldLabel({ text: 'Events at once', forId: 'VectFox_story_arc_link_parallel_calls' }),
                sliderNumber({ id: 'VectFox_story_arc_link_parallel_calls', min: 1, max: LINK_PARALLEL_CALLS_MAX, step: 1, title: 'Events', value: LINK_PARALLEL_CALLS_DEFAULT }),
                hint({ text: 'How many events Regenerate links decides at once. More is faster but risks rate limits.' }),
            ])}
            <div class="vfx-control-row">
                <button type="button" id="VectFox_story_arc_regenerate_links" class="vfx-btn vfx-btn-primary"><i class="fa-solid fa-link"></i><span>Regenerate links</span></button>
            </div>
            <div id="VectFox_story_arc_link_status"></div>
            ${hint({ text: 'The Database Browser saves each chat\'s links to a file and puts them back.' })}
        </div>
    </section>`;
}

/** The colour of each STORY_LINK_STATE, on the links line and the pill: green, yellow, red. */
const LINK_STATE_STATUS = Object.freeze({
    [STORY_LINK_STATE.LINKED]: 'success',
    [STORY_LINK_STATE.PARTLY_LINKED]: 'warning',
    [STORY_LINK_STATE.UNLINKED]: 'danger',
});

/**
 * Why StoryArc does or does not walk a collection's links, once some events are decided: it walks them from
 * USABLE_DECIDED_SHARE decided with one link or more; at that share with none, no event builds on an earlier one.
 * @param {{linkedCount: number, isMostlyDecided: boolean, hasUsableLinks: boolean}} coverage
 * @returns {string}
 */
function linkUseText({ linkedCount, isMostlyDecided, hasUsableLinks }) {
    if (hasUsableLinks) return 'StoryArc follows threads through these links.';
    if (isMostlyDecided && linkedCount === 0) return 'No event links to an earlier one yet, so StoryArc searches without links.';
    return `StoryArc searches without links until ${Math.round(USABLE_DECIDED_SHARE * 100)}% of events are decided.`;
}

/**
 * The links line under Regenerate links: how far the collection in use is linked, coloured by storyLinkState, green
 * with every event decided, yellow with some, red with none, and what Regenerate links does about it; or, with no
 * collection to read, why (readStoryLinkCoverage's problem), uncoloured.
 * @param {{problem?: string, collectionName?: string, totalCount?: number, decidedCount?: number, linkedCount?: number,
 *   isMostlyDecided?: boolean, hasUsableLinks?: boolean}} coverage - readStoryLinkCoverage's answer
 * @returns {string}
 */
export function storyLinkStatusMarkup(coverage) {
    if (coverage.problem) return resultList({ lines: [{ name: coverage.problem }] });
    const { collectionName, totalCount, decidedCount, linkedCount } = coverage;
    const state = storyLinkState(coverage);
    const counts = `"${collectionName}": ${decidedCount} of ${counted(totalCount, 'event')} decided, ${linkedCount} with links.`;
    let next;
    if (state === STORY_LINK_STATE.UNLINKED) {
        next = 'StoryArc searches without links until Regenerate links links them, after showing the cost.';
    } else {
        next = linkUseText(coverage);
        if (state === STORY_LINK_STATE.PARTLY_LINKED) next += ' Regenerate links catches up the events not decided.';
    }
    return resultList({ lines: [{ status: LINK_STATE_STATUS[state], name: `${counts} ${next}` }] });
}

/**
 * The StoryArc page's links pill for a collection with events: its decided events, coloured as the links line is.
 * @param {{totalCount: number, decidedCount: number}} coverage
 * @returns {{status: string, text: string}} status: success, warning or danger, the pill's is- class
 */
export function storyLinkPill(coverage) {
    return { status: LINK_STATE_STATUS[storyLinkState(coverage)], text: `${coverage.decidedCount} of ${counted(coverage.totalCount, 'event')} decided` };
}

/**
 * Regenerate links' choices, by how far the collection is linked: Link with none decided, Catch up for the events not
 * decided beside Relink all with some, Relink all with every one.
 * @param {{undecidedCount: number, decidedCount: number, totalCount: number}} counts
 * @returns {Array<{text: string, value: 'undecided'|'all'}>} 'undecided' links the events not decided, 'all' every one
 */
export function linkPassChoices({ undecidedCount, decidedCount, totalCount }) {
    return [
        ...(undecidedCount > 0 ? [{ text: `${decidedCount > 0 ? 'Catch up' : 'Link'} ${counted(undecidedCount, 'event')}`, value: 'undecided' }] : []),
        ...(decidedCount > 0 || undecidedCount === 0 ? [{ text: `Relink all ${counted(totalCount, 'event')}`, value: 'all' }] : []),
    ];
}

/** A token count as an estimate shows it: from 950 in thousands, as "27k", and below that to the hundred, as "300". */
export const tokenCountText = count => (count >= 950 ? `${Math.round(count / 1000)}k` : String(Math.round(count / 100) * 100));

/**
 * One line of what a link pass would likely cost, for Regenerate links' dialog.
 * @param {{eventCount: number, inputTokens: number, outputTokens: number, minutes: number, costUsd: number|null}} estimate
 *   - estimateStoryLinkPass's answer
 * @returns {string}
 */
export function linkEstimateText({ eventCount, inputTokens, outputTokens, minutes, costUsd }) {
    const cost = costUsd === null ? 'price unknown' : `about $${costUsd.toFixed(2)}`;
    return `${counted(eventCount, 'event')}: ${cost}, about ${counted(minutes, 'minute')}, `
        + `about ${tokenCountText(inputTokens)} input and ${tokenCountText(outputTokens)} output tokens`;
}

function blockSizeCard() {
    const limits = 'min="0.4" max="1.0" step="0.05"';
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-sliders', title: 'Block size', description: 'How much of the story a question about the past reads.' })}
        <div class="vfx-card-body vfx-stack">
            ${field([
                fieldLabel({ text: 'Block size', forId: 'VectFox_story_arc_block_scale', hasHelp: true }),
                `<div class="vfx-slider">
                    <input type="range" class="vfx-range" data-vfx-slider-for="VectFox_story_arc_block_scale" ${limits} title="Block size">
                    <input type="number" id="VectFox_story_arc_block_scale" class="vfx-input" ${limits}>
                </div>`,
                hint({ text: 'Higher reads more of the story\'s past, at more tokens per question.' }),
                detail({ text: 'The cut reads chat windows and keeps lines, both growing with the square root of the story\'s events: at 1,800 events, 0.5 keeps 28 lines from 53 windows, 0.7 keeps 40 from 75 and 1.0 keeps 40 from 100. A short story keeps at least 10 lines from 40 windows. More windows also cost the cut more.' }),
            ])}
        </div>
    </section>`;
}

function debugCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-bug', title: 'Debug', description: 'Console detail for StoryArc. Errors and warnings always show.' })}
        <div class="vfx-card-body">
            ${switchRow({ id: 'VectFox_story_arc_debug', title: 'Route rules', description: 'Each turn\'s Route rule, and the search text with other names.' })}
        </div>
    </section>`;
}

function connectionCard() {
    const provider = select({
        id: 'VectFox_story_arc_link_provider',
        title: 'Link provider',
        options: chatProviderOptions(),
    });
    const model = '<input type="text" id="VectFox_story_arc_link_model" class="vfx-input" placeholder="openai/gpt-6-luna">';
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-plug', title: 'API connection', description: 'The model that writes links, routes each message, picks threads and cuts blocks.' })}
        <div class="vfx-card-body">
            ${grid([
                field([fieldLabel({ text: 'Link provider', forId: 'VectFox_story_arc_link_provider' }), provider]),
                field([fieldLabel({ text: 'Link model', forId: 'VectFox_story_arc_link_model' }), model, hint({ text: 'Use a model that thinks: a cheap one links too loosely to help.' })]),
                connectionProfileRows('VectFox_story_arc_link', { hintText: 'Use a profile whose model thinks. Its model, URL and key are used.' }),
                testConnectionButton('VectFox_story_arc_link', { hintText: 'Sends one short fixed message, never your chat, and shows the reply.' }),
            ])}
        </div>
    </section>`;
}

function entityCard() {
    const { entityProblem, entityKind, entitySearch, entityList, entityPager, entityHiddenToggle } = STORY_ARC_ELEMENT_ID;
    const kind = select({
        id: entityKind,
        title: 'Kind of name',
        options: [selectOption({ value: 'people', name: 'People', isSelected: true }), selectOption({ value: 'factions', name: 'Factions' }), selectOption({ value: 'places', name: 'Places' })],
    });
    return `<section class="vfx-card">
        ${cardHeader({
            icon: 'fa-users',
            title: 'Entities',
            description: 'Merge the names of one person, place or faction, or hide one. Nothing stored changes.',
            actions: CHAT_CHIP,
        })}
        <div class="vfx-card-body vfx-stack">
            <div class="vfx-control-row">
                ${kind}
                <input type="text" id="${entitySearch}" class="vfx-input" placeholder="Search names" title="Search names">
                <span id="${entityHiddenToggle}" class="vfx-story-arc-hidden-toggle"></span>
            </div>
            <div id="${entityProblem}"></div>
            <div id="${entityList}" class="vfx-list"></div>
            <div id="${entityPager}"></div>
        </div>
    </section>`;
}

/**
 * The page, hidden until the rail shows it.
 *
 * @param {{notice?: string}} [options] - notice: the panel's notice that VectFox is off, as markup, shown under the header
 * @returns {string}
 */
export function storyArcPageMarkup({ notice = '' } = {}) {
    return `<div id="${STORY_ARC_PAGE_ID}" class="vfx-page" style="display:none;">
        ${pageHeader({
            icon: 'fa-timeline',
            eyebrow: 'Retrieval / StoryArc',
            title: 'StoryArc',
            subtitle: 'Follows story threads for questions about the past.',
            status: '<span class="vfx-chip"><i class="fa-solid fa-globe"></i><span>Global</span></span>'
                + '<span id="VectFox_story_arc_link_pill" class="vfx-pill is-accent" style="display:none;"></span>',
        })}
        ${notice}
        <nav class="vfx-subnav" role="tablist">
            ${subnavButton({ tab: 'main', icon: 'fa-sliders', text: 'Main', isActive: true })}
            ${subnavButton({ tab: 'linkgraph', icon: 'fa-diagram-project', text: 'LinkGraph' })}
            ${subnavButton({ tab: 'entity', icon: 'fa-users', text: 'Entity' })}
        </nav>
        <div class="vfx-page" data-story-arc-panel="main">
            ${modeCard()}
            ${blockSizeCard()}
            ${debugCard()}
            ${connectionCard()}
        </div>
        <div class="vfx-page" data-story-arc-panel="linkgraph" style="display:none;">
            ${storyWebCard()}
        </div>
        <div class="vfx-page" data-story-arc-panel="entity" style="display:none;">
            ${entityCard()}
        </div>
    </div>`;
}
