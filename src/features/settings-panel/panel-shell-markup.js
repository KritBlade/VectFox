/**
 * ============================================================================
 * SETTINGS PANEL SHELL, STATIC MARKUP
 * ============================================================================
 * The GUI-DNA shell the settings panel sits in (mvu-helper/devdoc/gui-dna.md §4): the
 * rail with its groups, one nav item per page and the theme switch, and each page's
 * header. A nav item is `VectFox_tab_<name>` and its page `VectFox_panel_<name>`, which
 * panel-shell.js finds by id. Pure: builds strings.
 * ============================================================================
 */

/**
 * The panel's pages, in rail order, each under its group. StoryArc's page draws its own header
 * (eventbase/story-arc-page-markup.js), so it has no subtitle here.
 */
export const PANEL_TABS = Object.freeze([
    { name: 'action', group: 'General', icon: 'fa-bolt', title: 'Action', subtitle: 'Run vectorization, browse the database and run diagnostics.' },
    { name: 'core', group: 'General', icon: 'fa-gear', title: 'Core', subtitle: 'Embedding, vector backend, retrieval and the model that writes events.' },
    { name: 'eventbase', group: 'Memory', icon: 'fa-database', title: 'EventBase', subtitle: 'Events the AI extracts from this chat and from archived chats.' },
    { name: 'chunkbase', group: 'Memory', icon: 'fa-layer-group', title: 'ChunkBase', subtitle: 'Chunked content: lorebooks, character cards, web pages and documents.' },
    { name: 'autosync', group: 'Memory', icon: 'fa-comments', title: 'AutoSync', subtitle: 'Keeps the open chat and its collection in step as messages arrive.' },
    { name: 'worldinfo', group: 'Memory', icon: 'fa-globe', title: 'WorldInfo', subtitle: 'Lorebook entries chosen by meaning instead of keywords.' },
    { name: 'rag', group: 'Retrieval', icon: 'fa-quote-left', title: 'RAG', subtitle: 'How retrieved memory is wrapped and placed in the prompt.' },
    { name: 'agentmode', group: 'Retrieval', icon: 'fa-robot', title: 'AgentMode', subtitle: 'An LLM planner that adds searches beside the normal one.' },
    { name: 'storyarc', group: 'Retrieval', icon: 'fa-timeline', title: 'StoryArc' },
]);

/** The page the panel opens on. */
export const FIRST_PANEL_TAB = PANEL_TABS[0].name;

export const panelTabId = name => `VectFox_tab_${name}`;
export const panelPageId = name => `VectFox_panel_${name}`;

const THEME_OPTIONS = [
    { theme: 'dark', icon: 'fa-moon', text: 'Dark' },
    { theme: 'light', icon: 'fa-sun', text: 'Light' },
];

function navItem({ name, icon, title }) {
    const isFirst = name === FIRST_PANEL_TAB;
    return `<button type="button" id="${panelTabId(name)}" class="vfx-nav-item${isFirst ? ' is-active' : ''}"${isFirst ? ' aria-current="page"' : ''}><i class="fa-solid ${icon}"></i><span>${title}</span></button>`;
}

function themeOption({ theme, icon, text }) {
    return `<button type="button" class="vfx-theme-option" data-vfx-theme-option="${theme}" aria-pressed="false"><i class="fa-solid ${icon}"></i><span>${text}</span></button>`;
}

/**
 * The rail: the brand, then each group's label and its pages, then the theme switch at its foot.
 *
 * @returns {string}
 */
export function panelNavMarkup() {
    const items = [];
    let group = '';
    for (const tab of PANEL_TABS) {
        if (tab.group !== group) {
            group = tab.group;
            items.push(`<div class="vfx-nav-group">${group}</div>`);
        }
        items.push(navItem(tab));
    }
    return `<nav class="vfx-nav">
            <div class="vfx-nav-inner">
                <div class="vfx-nav-brand"><i class="fa-solid fa-brain"></i><span>VectFox</span></div>
                ${items.join('\n                ')}
                <div class="vfx-nav-footer">
                    <div class="vfx-theme-switch" role="group" title="Theme">
                        ${THEME_OPTIONS.map(themeOption).join('\n                        ')}
                    </div>
                </div>
            </div>
        </nav>`;
}

/**
 * One page's header: its icon, "<group> / <title>", the title and the one-line subtitle.
 *
 * @param {string} name - A name in PANEL_TABS
 * @returns {string}
 */
export function pageHeaderMarkup(name) {
    const tab = PANEL_TABS.find(each => each.name === name);
    if (!tab) throw new Error(`No panel page is named "${name}"`);
    return `<header class="vfx-page-header">
                <span class="vfx-page-icon"><i class="fa-solid ${tab.icon}"></i></span>
                <div class="vfx-page-heading">
                    <div class="vfx-page-eyebrow">${tab.group} / ${tab.title}</div>
                    <h2 class="vfx-page-title">${tab.title}</h2>
                    <p class="vfx-page-subtitle">${tab.subtitle}</p>
                </div>
            </header>`;
}

/**
 * A page of the panel around its content, hidden unless it is the first page.
 *
 * @param {string} name - A name in PANEL_TABS
 * @param {string} content - The page's markup after its header
 * @returns {string}
 */
export function panelPageMarkup(name, content) {
    const hidden = name === FIRST_PANEL_TAB ? '' : ' style="display:none;"';
    return `<div id="${panelPageId(name)}" class="vfx-page"${hidden}>
            ${pageHeaderMarkup(name)}
            ${content}
        </div>`;
}
