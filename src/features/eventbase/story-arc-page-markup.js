/**
 * ============================================================================
 * STORY ARC PAGE, STATIC MARKUP
 * ============================================================================
 * VectFox's first page on the GUI-DNA (mvu-helper/devdoc/gui-dna.md), one page on
 * the settings panel's rail. Every control the page's handlers look for is found by
 * its id or a data-* hook. Pure: builds a string.
 * ============================================================================
 */

import { button, detail, fieldLabel, grid, hint, iconButton, selectOption, select, field } from '../../shared/gui-dna/gui-dna-core.js';
import { cardHeader, pageHeader, switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { connectionProfileRows, testConnectionButton } from '../../shared/connection-profile-rows-markup.js';

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
            <div class="vfx-control-row">
                <button type="button" id="VectFox_story_arc_regenerate_links" class="vfx-btn vfx-btn-primary"><i class="fa-solid fa-link"></i><span>Regenerate links</span></button>
            </div>
            <p id="VectFox_story_arc_link_status" class="vfx-hint"></p>
            ${hint({ text: 'The Database Browser saves each chat\'s links to a file and puts them back.' })}
        </div>
    </section>`;
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
        options: [
            selectOption({ value: 'openrouter', name: 'OpenRouter' }),
            selectOption({ value: 'vllm', name: 'vLLM' }),
            selectOption({ value: CONNECTION_PROFILE_PROVIDER, text: 'SillyTavern profile' }),
        ],
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
    const { entityProblem, entityKind, entitySearch, entityList, entityPager } = STORY_ARC_ELEMENT_ID;
    const kind = select({
        id: entityKind,
        title: 'Kind of name',
        options: [selectOption({ value: 'people', name: 'People', isSelected: true }), selectOption({ value: 'factions', name: 'Factions' }), selectOption({ value: 'places', name: 'Places' })],
    });
    return `<section class="vfx-card">
        ${cardHeader({
            icon: 'fa-users',
            title: 'Entities',
            description: 'Merge the names of one person, place or faction. Nothing stored changes.',
            actions: CHAT_CHIP,
        })}
        <div class="vfx-card-body vfx-stack">
            <div class="vfx-control-row">
                ${kind}
                <input type="text" id="${entitySearch}" class="vfx-input" placeholder="Search names" title="Search names">
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
            ${subnavButton({ tab: 'main', icon: 'fa-diagram-project', text: 'Main', isActive: true })}
            ${subnavButton({ tab: 'entity', icon: 'fa-users', text: 'Entity' })}
        </nav>
        <div class="vfx-page" data-story-arc-panel="main">
            ${storyWebCard()}
            ${modeCard()}
            ${blockSizeCard()}
            ${debugCard()}
            ${connectionCard()}
        </div>
        <div class="vfx-page" data-story-arc-panel="entity" style="display:none;">
            ${entityCard()}
        </div>
    </div>`;
}
