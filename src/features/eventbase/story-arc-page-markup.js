/**
 * ============================================================================
 * STORY ARC PAGE, STATIC MARKUP
 * ============================================================================
 * VectFox's first page on the GUI-DNA (mvu-helper/devdoc/gui-dna.md). It opens in a
 * wide dialog of its own, and joins the panel's rail when the panel moves to the DNA.
 * Every control the page's handlers look for is found by its id or a data-* hook.
 * Pure: builds a string.
 * ============================================================================
 */

import { button, fieldLabel, grid, hint, iconButton, selectOption, select, field } from '../../shared/gui-dna/gui-dna-core.js';

export const STORY_ARC_PAGE_ID = 'VectFox_story_arc_page';
export const STORY_ARC_PAGE_HOLDER_ID = 'VectFox_story_arc_page_holder';

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

const COLLAPSE_BUTTON = '<button type="button" class="vfx-collapse" aria-expanded="true" title="Show or hide"><i class="fa-solid fa-chevron-up"></i></button>';
const CHAT_CHIP = '<span class="vfx-chip"><i class="fa-solid fa-comments"></i><span>This chat</span></span>';

/** A card's header: badge, title, one-line description, then any actions and the chevron. */
function cardHeader({ icon, title, description, actions = '' }) {
    return `<header class="vfx-card-header">
        <span class="vfx-badge"><i class="fa-solid ${icon}"></i></span>
        <h3 class="vfx-card-title">${title}</h3>
        <p class="vfx-card-desc">${description}</p>
        ${actions ? `<div class="vfx-card-actions">${actions}</div>` : ''}
        ${COLLAPSE_BUTTON}
    </header>`;
}

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
            <label class="vfx-switch-row">
                <input type="checkbox" role="switch" id="VectFox_story_arc_mode_enabled" class="vfx-switch">
                <span class="vfx-switch-title">Enable StoryArc mode</span>
                <span class="vfx-switch-desc">Adds one small LLM call per message, on the link model. Needs Qdrant.</span>
            </label>
            <div class="vfx-control-row">
                <button type="button" id="VectFox_story_arc_regenerate_links" class="vfx-btn vfx-btn-primary"><i class="fa-solid fa-link"></i><span>Regenerate links</span></button>
            </div>
            <p id="VectFox_story_arc_link_status" class="vfx-hint"></p>
            ${hint({ text: 'The Database Browser saves each chat\'s links to a file and puts them back.' })}
        </div>
    </section>`;
}

function blockSizeCard() {
    const limits = 'min="0.4" max="0.8" step="0.05"';
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-sliders', title: 'Block size', description: 'How much of the story a question about the past reads.' })}
        <div class="vfx-card-body vfx-stack">
            ${field([
                fieldLabel({ text: 'Block size', forId: 'VectFox_story_arc_block_scale' }),
                `<div class="vfx-slider">
                    <input type="range" class="vfx-range" data-vfx-slider-for="VectFox_story_arc_block_scale" ${limits} title="Block size">
                    <input type="number" id="VectFox_story_arc_block_scale" class="vfx-input" ${limits}>
                </div>`,
                hint({ text: 'A block keeps this × the square root of the story\'s events as lines, from 10 to 40, chosen from 2.5 times as many chat windows, at least 40. At 1,800 events, 0.5 keeps 21 lines from 53 windows, and 0.7 keeps 30 from 75. More lines cost more tokens on those questions.' }),
            ])}
        </div>
    </section>`;
}

function debugCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-bug', title: 'Debug', description: 'Console detail for StoryArc. Errors and warnings always show.' })}
        <div class="vfx-card-body">
            <label class="vfx-switch-row">
                <input type="checkbox" role="switch" id="VectFox_story_arc_debug" class="vfx-switch">
                <span class="vfx-switch-title">Route rules</span>
                <span class="vfx-switch-desc">Each turn's Route rule, and the search text with other names.</span>
            </label>
        </div>
    </section>`;
}

function connectionCard() {
    const provider = select({
        id: 'VectFox_story_arc_link_provider',
        title: 'Link provider',
        options: [selectOption({ value: 'openrouter', name: 'OpenRouter' }), selectOption({ value: 'vllm', name: 'vLLM' })],
    });
    const model = '<input type="text" id="VectFox_story_arc_link_model" class="vfx-input" placeholder="openai/gpt-6-luna">';
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-plug', title: 'API connection', description: 'The model that writes links, routes each message, picks threads and cuts blocks.' })}
        <div class="vfx-card-body">
            ${grid([
                field([fieldLabel({ text: 'Link provider', forId: 'VectFox_story_arc_link_provider' }), provider]),
                field([fieldLabel({ text: 'Link model', forId: 'VectFox_story_arc_link_model' }), model, hint({ text: 'Use a model that thinks: a cheap one links too loosely to help.' })]),
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
 * The page, hidden in its holder until it opens.
 *
 * @returns {string}
 */
export function storyArcPageMarkup() {
    return `<div id="${STORY_ARC_PAGE_HOLDER_ID}">
    <div id="${STORY_ARC_PAGE_ID}" class="vfx-ui vfx-shell">
        <main class="vfx-main">
            <div class="vfx-page">
                <header class="vfx-page-header">
                    <span class="vfx-page-icon"><i class="fa-solid fa-timeline"></i></span>
                    <div class="vfx-page-heading">
                        <div class="vfx-page-eyebrow">Settings / StoryArc</div>
                        <h2 class="vfx-page-title">StoryArc</h2>
                        <p class="vfx-page-subtitle">Follows story threads for questions about the past.</p>
                    </div>
                    <div class="vfx-page-status">
                        <span class="vfx-chip"><i class="fa-solid fa-globe"></i><span>Global</span></span>
                        <span id="VectFox_story_arc_link_pill" class="vfx-pill is-accent" style="display:none;"></span>
                    </div>
                </header>
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
            </div>
        </main>
    </div>
</div>`;
}
