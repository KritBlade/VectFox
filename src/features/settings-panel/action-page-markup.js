/**
 * ============================================================================
 * ACTION PAGE, STATIC MARKUP
 * ============================================================================
 * The settings panel's Action page on GUI-DNA: the master switch, the tools VectFox
 * opens, the console's debug switches and the danger zone. action-page.js wires every
 * control by its id. Pure: builds strings.
 * ============================================================================
 */

import { select, selectOption } from '../../shared/gui-dna/gui-dna-core.js';
import { actionCard, cardHeader, dangerZone, switchRow } from '../../shared/gui-dna/panel-page-genes.js';

/** The ids action-page.js wires. */
export const ACTION_PAGE_ELEMENT_ID = Object.freeze({
    masterSwitch: 'VectFox_master_enabled',
    masterOnPill: 'VectFox_master_on_pill',
    masterOffPill: 'VectFox_master_off_pill',
    vectorizeContent: 'VectFox_vectorize_content',
    syncChat: 'VectFox_sync_chat',
    databaseBrowser: 'VectFox_database_browser',
    textCleaning: 'VectFox_text_cleaning',
    reopenProgress: 'VectFox_reopen_progress',
    openChecks: 'VectFox_open_checks',
    openBackendHealth: 'VectFox_open_backend_health',
    openQueryTester: 'VectFox_open_query_tester',
    previewSummarizer: 'VectFox_preview_summarizer',
    debugVerbosity: 'VectFox_debug_verbosity',
    purge: 'VectFox_purge',
    cleanupCorrupted: 'VectFox_cleanup_corrupted',
});

/**
 * Each debug switch: its id, and the log.domain() deep-dive (settings.debug_domain) or the setting of its own it
 * saves. sillytavern/log.js reads the domains; a setting of its own goes with the request it changes.
 */
export const DEBUG_SWITCHES = Object.freeze([
    { id: 'VectFox_injection_debug_logging', domain: 'injection', title: 'Injection', description: 'Each turn\'s injected chunks and events: score, collection, text and placement.' },
    { id: 'VectFox_debug_domain_raw_llm', domain: 'raw_llm', title: 'Raw LLM reply', description: 'Each EventBase window\'s excerpt, raw reply and parse. Very noisy.' },
    { id: 'VectFox_agentic_debug', domain: 'agent', title: 'Agent Mode', description: 'The planner\'s context, searches and timing, and each search\'s hits.' },
    { id: 'VectFox_eventbase_debug_qdrant_backend', setting: 'eventbase_debug_qdrant_backend', title: 'Qdrant backend', description: 'Similharity logs Qdrant\'s keyword and fusion detail in the server console.' },
    { id: 'VectFox_eventbase_compare_rerank', domain: 'rerank', title: 'Compare re-rank', description: 'With native re-rank on, runs the JS re-rank too and logs the difference. Doubles cost.' },
    { id: 'VectFox_eventbase_compare_rerank_verbose', setting: 'eventbase_compare_rerank_verbose', title: 'Compare per event', description: 'Adds each shared event\'s score breakdown to the re-rank comparison.' },
]);

const VERBOSITY_LEVELS = [
    { value: 'off', text: 'Off' },
    { value: 'lifecycle', text: 'Lifecycle' },
    { value: 'verbose', text: 'Verbose' },
    { value: 'trace', text: 'Trace' },
];

const ID = ACTION_PAGE_ELEMENT_ID;

/**
 * The page header's pills for the master switch: one shows, by the switch (action-page.js).
 *
 * @returns {string}
 */
export function masterSwitchPillsMarkup() {
    return `<span id="${ID.masterOnPill}" class="vfx-pill is-success" style="display:none;">Enabled</span>`
        + `<span id="${ID.masterOffPill}" class="vfx-pill is-neutral" style="display:none;">Disabled</span>`;
}

function masterSwitchCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-power-off', title: 'Master switch' })}
        <div class="vfx-card-body vfx-grid">
            ${switchRow({ id: ID.masterSwitch, title: 'Enable VectFox', description: 'Off: nothing reaches the prompt and auto-sync pauses. The tools here still work.', isSpan: true })}
        </div>
    </section>`;
}

function memoryCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-database', title: 'Memory', description: 'Put content into memory, keep this chat in step, and see what is stored.' })}
        <div class="vfx-card-body">
            <div class="vfx-action-grid">
                ${actionCard({ icon: 'fa-circle-plus', title: 'Vectorize Content', description: 'Store a chat, lorebook, character card, web or wiki page, document or YouTube transcript.', button: { id: ID.vectorizeContent, text: 'Vectorize content', icon: 'fa-plus' }, isPrimary: true })}
                ${actionCard({ icon: 'fa-rotate', title: 'Sync chat', description: 'Reads the messages EventBase has not read in this chat yet, after you confirm.', button: { id: ID.syncChat, text: 'Sync chat', icon: 'fa-rotate' } })}
                ${actionCard({ icon: 'fa-folder-open', title: 'Database Browser', description: 'Every stored collection, with its chunks and events, locks, names and exports.', button: { id: ID.databaseBrowser, text: 'Open browser', icon: 'fa-folder-open' } })}
                ${actionCard({ icon: 'fa-eraser', title: 'Text Cleaning', description: 'The patterns that strip markup and noise from messages before VectFox reads them.', button: { id: ID.textCleaning, text: 'Edit patterns', icon: 'fa-pen' } })}
                ${actionCard({ icon: 'fa-chart-line', title: 'Progress', description: 'Shows the progress panel of a vectorization again after you hid it.', button: { id: ID.reopenProgress, text: 'Show progress', icon: 'fa-eye' } })}
            </div>
        </div>
    </section>`;
}

function checksCard() {
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-stethoscope', title: 'Checks', description: 'Test the setup, the backend, and what a turn would retrieve or inject.' })}
        <div class="vfx-card-body">
            <div class="vfx-action-grid">
                ${actionCard({ icon: 'fa-stethoscope', title: 'Diagnostics', description: 'Checks every part of the setup and lists what passes, warns or fails.', button: { id: ID.openChecks, text: 'Open Checks', icon: 'fa-stethoscope' } })}
                ${actionCard({ icon: 'fa-heart-pulse', title: 'Backend health', description: 'Live counts of the vector backend\'s queries, inserts and errors, and its latency.', button: { id: ID.openBackendHealth, text: 'Open Backend health', icon: 'fa-gauge' } })}
                ${actionCard({ icon: 'fa-magnifying-glass', title: 'Query Tester', description: 'Type a message and see what each retrieval would inject for it. Nothing is sent.', button: { id: ID.openQueryTester, text: 'Test a query', icon: 'fa-vial' } })}
                ${actionCard({ icon: 'fa-eye', title: 'Summarizer preview', description: 'The summarizer block this turn would inject, shown and not injected.', button: { id: ID.previewSummarizer, text: 'Preview block', icon: 'fa-eye' } })}
            </div>
        </div>
    </section>`;
}

function debugCard() {
    const verbosity = select({
        id: ID.debugVerbosity,
        title: 'Console verbosity',
        options: VERBOSITY_LEVELS.map(level => selectOption(level)),
    });
    return `<section class="vfx-card">
        ${cardHeader({ icon: 'fa-bug', title: 'Debug', description: 'Console detail for VectFox. Errors and warnings always show.', actions: verbosity })}
        <div class="vfx-card-body vfx-grid">
            ${DEBUG_SWITCHES.map(({ id, title, description }) => switchRow({ id, title, description })).join('\n            ')}
        </div>
    </section>`;
}

function storedDataDangerZone() {
    return dangerZone({
        title: 'Stored data',
        buttons: [
            { id: ID.purge, icon: 'fa-trash', text: 'Purge everything', tooltip: 'Delete SillyTavern\'s local vectors folder and reset every VectFox setting.' },
            { id: ID.cleanupCorrupted, icon: 'fa-broom', text: 'Clean up corrupted', tooltip: 'Delete the collections VectFox cannot read, and SillyTavern\'s file_* collections.' },
        ],
    });
}

/**
 * The page's content under its header: the master switch first, the danger zone last.
 *
 * @returns {string}
 */
export function actionPageMarkup() {
    return [masterSwitchCard(), memoryCard(), checksCard(), debugCard(), storedDataDangerZone()].join('\n');
}
