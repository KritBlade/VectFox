/**
 * ============================================================================
 * VECTFOX CONTENT VECTORIZER UI
 * ============================================================================
 * Modal interface for vectorizing different content types with intelligent
 * settings that adapt based on selected content type.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import {
    CONTENT_TYPES,
    CHUNKING_STRATEGIES,
    getContentType,
    getAllContentTypes,
    getChunkingStrategies,
    getChunkingStrategy,
    strategyNeedsSize,
    strategyNeedsOverlap,
    getContentTypeDefaults,
    hasFeature,
    SCOPE_OPTIONS,
    CHARACTER_FIELDS,
} from '../core/content-types.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getChatUUID, vectorizeAll } from '../core/chat-vectorization.js';
import { validateLLMConfig } from '../core/summarizer.js';
import { getOpenRouterApiKey } from '../core/api-keys.js';
import StringUtils from '../utils/string-utils.js';
import { resolveEffectiveSettings } from '../core/content-vectorization.js';
import { renderCollections } from './database-browser.js';
import { buildArchiveEventCollectionId } from '../core/collection-ids.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { getCleaningSettings } from '../core/text-cleaning.js';
import { progressTracker } from './progress-tracker.js';

// ============================================================================
// STATE
// ============================================================================

let currentContentType = 'lorebook';
let currentSettings = {};
let sourceData = null;
let activeVectorizeAbortController = null;
let isVectorizing = false;
let startFromMessage = 1;

function syncStartFromMessageFromUI() {
    const raw = parseInt($('#vectfox_cv_startfrom').val(), 10);
    startFromMessage = Number.isFinite(raw) && raw >= 1 ? raw : 1;
    $('#vectfox_cv_startfrom').val(startFromMessage);
}

/**
 * Returns true if this chat has any cached extraction state (window fingerprints
 * OR a vectorization tip). Used to decide whether the Vectorize button should
 * confirm before resetting. No state → fresh chat → no prompt needed.
 */
async function _hasPriorExtractionState(chatUUID) {
    if (!chatUUID) return false;
    const arr = extension_settings?.vectfox?.eventbase_extracted_windows?.[chatUUID];
    if (Array.isArray(arr) && arr.length > 0) return true;
    const { getVectorizationTip } = await import('../core/eventbase-store.js');
    return typeof getVectorizationTip(chatUUID) === 'number';
}

function updateVectorizeButtonState(running) {
    const btn = $('#vectfox_cv_vectorize');
    const cancelBtn = $('#vectfox_cv_cancel');
    const continueBtn = $('#vectfox_cv_continue');

    if (running) {
        btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Vectorizing...');
        cancelBtn.html('<i class="fa-solid fa-stop"></i> Stop');
        continueBtn.prop('disabled', true);
    } else {
        btn.prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Vectorize');
        cancelBtn.text('Cancel');
        continueBtn.prop('disabled', false);
    }
}

function stopActiveVectorization() {
    if (activeVectorizeAbortController && !activeVectorizeAbortController.signal.aborted) {
        activeVectorizeAbortController.abort('user-stop');
    }
}

// ============================================================================
// MODAL CREATION
// ============================================================================

/**
 * Opens the content vectorizer modal
 * @param {string} initialType - Optional initial content type to select
 */
export function openContentVectorizer(initialType = null) {
    currentContentType = initialType;
    currentSettings = initialType ? { ...getContentTypeDefaults(initialType) } : {};
    sourceData = null;

    createModal();
    bindEvents();

    // Only show subsequent sections if type is pre-selected
    if (currentContentType) {
        updateUIForContentType();
        $('.vectfox-cv-subsequent').show();
    } else {
        $('.vectfox-cv-subsequent').hide();
    }

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#vectfox_content_vectorizer_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    $('#vectfox_content_vectorizer_modal').fadeIn(200);
}

/**
 * Closes the modal
 */
export function closeContentVectorizer() {
    $('#vectfox_content_vectorizer_modal').fadeOut(200, function() {
        $(this).remove();
    });
}

/**
 * Hide the Content Vectorizer modal so the progress panel is visible while work runs.
 *
 * On touch devices the vectorizer is a full-screen modal that would completely cover
 * the progress bottom-sheet, so we fade it out. We deliberately use .fadeOut() (NOT
 * closeContentVectorizer()) so the modal stays in the DOM — downstream code still reads
 * its inputs (e.g. #vectfox_cv_parallel_windows), and closeContentVectorizer() removes
 * it for good once the run completes.
 *
 * Desktop leaves the modal open; the progress panel floats in the corner and doesn't
 * obscure it. Uses pointer/hover — NOT viewport width — so high-DPI phones whose CSS
 * viewport can exceed 768px are still treated as touch devices.
 *
 * Call this only AFTER the run is committed (past the isVectorizing guard / early
 * returns), so the modal never disappears on a path that shows no progress.
 */
function hideVectorizerForProgress() {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
        $('#vectfox_content_vectorizer_modal').fadeOut(200);
    }
}

/**
 * Creates the modal HTML
 */
function createModal() {
    // Remove existing
    $('#vectfox_content_vectorizer_modal').remove();

    const contentTypes = getAllContentTypes(); // All types including chat

    const html = `
        <div id="vectfox_content_vectorizer_modal" class="vectfox-modal">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-content-vectorizer">
                <div class="vectfox-modal-header">
                    <h3>
                        <i class="fa-solid fa-database"></i>
                        Vectorize Content
                    </h3>
                    <button class="vectfox-modal-close" id="vectfox_cv_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>

                <div class="vectfox-cv-body">
                    <!-- Step 1: Content Type Selection - BIG DROPDOWN -->
                    <div class="vectfox-cv-section vectfox-cv-type-section">
                        <div class="vectfox-cv-type-dropdown-wrapper">
                            <label class="vectfox-cv-main-label">What do you want to vectorize?</label>
                            <select id="vectfox_cv_type_select" class="vectfox-cv-type-dropdown">
                                <option value="">-- Choose content type --</option>
                                ${contentTypes.map(type => `
                                    <option value="${type.id}" ${type.id === currentContentType ? 'selected' : ''}>
                                        ${type.name}
                                    </option>
                                `).join('')}
                            </select>
                            <span class="vectfox-cv-type-hint" id="vectfox_cv_type_hint">
                                Select a content type to continue
                            </span>
                        </div>
                    </div>

                    <!-- Step 1: Backfill Range (chat only) -->
                    <div class="vectfox-cv-section vectfox-cv-startfrom-section vectfox-cv-subsequent" id="vectfox_cv_startfrom_section" style="display:none;">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">1</span>
                            <span class="vectfox-cv-section-title">Backfill Range</span>
                        </div>
                        <div class="vectfox-cv-section-body">
                            <div class="vectfox-cv-startfrom-row">
                                <label for="vectfox_cv_startfrom">Start From Message</label>
                                <input type="number" id="vectfox_cv_startfrom" class="vectfox-input" min="1" step="1" value="1" style="width:100px;">
                            </div>
                            <span class="vectfox-cv-type-hint">Default 1 = entire chat. Enter e.g. 2000 to start from message 2000 onward.</span>
                        </div>
                    </div>

                    <!-- Step 2: Source Selection (changes based on type) -->
                    <div class="vectfox-cv-section vectfox-cv-source-section vectfox-cv-subsequent">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">2</span>
                            <span class="vectfox-cv-section-title" id="vectfox_cv_source_title">Select Source</span>
                        </div>
                        <div id="vectfox_cv_source_content" class="vectfox-cv-section-body">
                            <!-- Dynamically populated based on content type -->
                        </div>
                    </div>

                    <!-- Step 2.5: Auto-Reformat (Optional, Document/URL/Wiki only) -->
                    <div class="vectfox-cv-section vectfox-cv-reformat-section vectfox-cv-subsequent" id="vectfox_cv_reformat_section" style="display:none;">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
                            <span class="vectfox-cv-section-title">Auto-Reformat (Optional)</span>
                        </div>
                        <div id="vectfox_cv_reformat_content" class="vectfox-cv-section-body">
                            <!-- Dynamically populated -->
                        </div>
                    </div>

                    <!-- Step 3: Chunking Settings -->
                    <div class="vectfox-cv-section vectfox-cv-chunking-section vectfox-cv-subsequent">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">3</span>
                            <span class="vectfox-cv-section-title">Chunking Strategy</span>
                            <button class="vectfox-cv-collapse-btn" data-target="chunking">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div class="vectfox-cv-collapsible" id="vectfox_cv_chunking_content">
                            <div class="vectfox-cv-strategy-select" id="vectfox_cv_strategy_select_wrapper">
                                <label>Strategy</label>
                                <select id="vectfox_cv_strategy" class="vectfox-select">
                                    <!-- Populated dynamically -->
                                </select>
                                <span class="vectfox-cv-strategy-desc" id="vectfox_cv_strategy_desc"></span>
                            </div>

                            <!-- Size/Overlap controls - only shown for text-based strategies -->
                            <div class="vectfox-cv-size-controls" id="vectfox_cv_size_controls">
                                <div class="vectfox-cv-slider-row" id="vectfox_cv_chunk_size_row">
                                    <label>
                                        Chunk Size
                                        <span class="vectfox-cv-value" id="vectfox_cv_chunk_size_val">400</span> chars
                                    </label>
                                    <input type="range" id="vectfox_cv_chunk_size"
                                           min="100" max="1000" step="50" value="400">
                                    <div class="vectfox-cv-slider-hints">
                                        <span>Precise</span>
                                        <span>Contextual</span>
                                    </div>
                                </div>
                                <div class="vectfox-cv-slider-row" id="vectfox_cv_overlap_row">
                                    <label>
                                        Chunk Overlap
                                        <span class="vectfox-cv-value" id="vectfox_cv_overlap_val">50</span> chars
                                    </label>
                                    <input type="range" id="vectfox_cv_overlap"
                                           min="0" max="200" step="10" value="50">
                                    <div class="vectfox-cv-slider-hints">
                                        <span>Off</span>
                                        <span>High</span>
                                    </div>
                                </div>
                                <!-- Batch size - only shown for message_batch strategy -->
                                <div class="vectfox-cv-slider-row" id="vectfox_cv_batch_size_row" style="display:none;">
                                    <label>
                                        Messages per Batch
                                        <span class="vectfox-cv-value" id="vectfox_cv_batch_size_val">4</span>
                                    </label>
                                    <input type="range" id="vectfox_cv_batch_size"
                                           min="1" max="20" step="1" value="4">
                                    <div class="vectfox-cv-slider-hints">
                                        <span>1 msg</span>
                                        <span>20 msgs</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Parallel Windows - EventBase/chat only -->
                            <div class="vectfox-cv-slider-row" id="vectfox_cv_parallel_row" style="display:none;">
                                <label>
                                    Parallel Windows
                                    <span class="vectfox-cv-value" id="vectfox_cv_parallel_val">3</span>
                                </label>
                                <input type="range" id="vectfox_cv_parallel_windows"
                                       min="1" max="8" step="1" value="3">
                                <div class="vectfox-cv-slider-hints">
                                    <span>1 (safe)</span>
                                    <span>8 (fast)</span>
                                </div>
                            </div>

                            <!-- Window Size - moved from EventBase tab (Feature A re-home).
                                 Shown for content types that use the EventBase extraction path
                                 (today: chat history + chat-history file upload). Gated via
                                 _usesEventBaseWindowControls() so future chunk-based summarizer
                                 types can opt in from one place. -->
                            <div class="vectfox-cv-slider-row" id="vectfox_cv_window_size_row" style="display:none;">
                                <label>
                                    Window Size
                                    <span class="vectfox-cv-value" id="vectfox_cv_window_size_val">2</span> messages
                                </label>
                                <input type="range" id="vectfox_cv_window_size"
                                       min="2" max="20" step="1" value="2">
                                <div class="vectfox-cv-slider-hints">
                                    <span>2 (granular)</span>
                                    <span>20 (coarse)</span>
                                </div>
                            </div>

                            <!-- Window Overlap - moved from EventBase tab (Feature A re-home). -->
                            <div class="vectfox-cv-slider-row" id="vectfox_cv_window_overlap_row" style="display:none;">
                                <label>
                                    Window Overlap
                                    <span class="vectfox-cv-value" id="vectfox_cv_window_overlap_val">0</span>
                                </label>
                                <input type="range" id="vectfox_cv_window_overlap"
                                       min="0" max="5" step="1" value="0">
                                <div class="vectfox-cv-slider-hints">
                                    <span>0 (none)</span>
                                    <span>5 (high)</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Step 4: Type-Specific Options -->
                    <div class="vectfox-cv-section vectfox-cv-options-section vectfox-cv-subsequent">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">4</span>
                            <span class="vectfox-cv-section-title">Options</span>
                            <button class="vectfox-cv-collapse-btn" data-target="options">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div class="vectfox-cv-collapsible" id="vectfox_cv_options_content">
                            <!-- Dynamically populated based on content type -->
                        </div>
                    </div>

                    <!-- Preview Section -->
                    <div class="vectfox-cv-section vectfox-cv-preview-section" style="display: none;">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number"><i class="fa-solid fa-eye"></i></span>
                            <span class="vectfox-cv-section-title">Preview</span>
                        </div>
                        <div id="vectfox_cv_preview_content" class="vectfox-cv-preview">
                            <!-- Preview of chunks will appear here -->
                        </div>
                    </div>
                </div>

                <div class="vectfox-cv-footer">
                    <button class="vectfox-btn-secondary" id="vectfox_cv_cancel">Cancel</button>
                    <button class="vectfox-btn-secondary" id="vectfox_cv_preview_btn">
                        <i class="fa-solid fa-eye"></i> Preview Chunks
                    </button>
                    <button class="vectfox-btn-secondary" id="vectfox_cv_continue" style="display: none;">
                        <i class="fa-solid fa-forward"></i> Resume
                    </button>
                    <button class="vectfox-btn-primary" id="vectfox_cv_vectorize">
                        <i class="fa-solid fa-bolt"></i> Vectorize
                    </button>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);
}

// ============================================================================
// UI UPDATES
// ============================================================================

/**
 * Updates the entire UI based on selected content type
 */
function updateUIForContentType() {
    const type = getContentType(currentContentType);
    if (!type) return;

    // Update source section
    updateSourceSection(type);

    // Auto-Reformat section (Document/URL/Wiki only) — must run before
    // updateChunkingSection() so the latter can see currentSettings.reformat
    // state for the current content type when deciding whether to show the
    // strategy dropdown or the "handled by Auto-Reformat" message.
    renderReformatSection();

    // Update chunking strategies
    updateChunkingSection(type);

    // Update options section
    updateOptionsSection(type);

    // Show Continue button only for chat type (backfills missing chunks via hash dedup)
    const isChatType = currentContentType === 'chat';
    $('#vectfox_cv_continue').toggle(isChatType);
    // Show Start From section only for chat
    $('#vectfox_cv_startfrom_section').toggle(isChatType);
    if (!isChatType) startFromMessage = 1;
}

/**
 * Updates the source selection section
 */
function updateSourceSection(type) {
    const container = $('#vectfox_cv_source_content');
    container.empty();

    let html = '';

    switch (type.sourceType) {
        case 'select':
            html = renderSelectSource(type);
            break;
        case 'input':
            html = renderInputSource(type);
            break;
        case 'url':
            html = renderUrlSource(type);
            break;
        case 'chat':
            html = renderChatSource(type);
            break;
        case 'current':
            html = renderCurrentChatSource(type);
            break;
        case 'wiki':
            html = renderWikiSource(type);
            break;
        case 'youtube':
            html = renderYouTubeSource(type);
            break;
    }

    container.html(html);

    // Bind source-specific events after rendering
    bindSourceEvents(type);
}

/**
 * Renders URL input source
 */
function renderUrlSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-url-source">
            <label>Enter URL</label>
            <div class="vectfox-cv-url-input-row">
                <input type="text" id="vectfox_cv_url_input"
                       class="vectfox-input"
                       placeholder="${options.placeholder || 'https://example.com'}">
                <button id="vectfox_cv_fetch_url" class="vectfox-btn-primary">
                    <i class="fa-solid fa-download"></i> Fetch
                </button>
            </div>
            <div class="vectfox-cv-url-status" id="vectfox_cv_url_status"></div>
            <div class="vectfox-cv-url-preview" id="vectfox_cv_url_preview" style="display: none;">
                <div class="vectfox-cv-url-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vectfox_cv_url_title">Page loaded</span>
                </div>
                <div class="vectfox-cv-url-preview-stats">
                    <span><strong id="vectfox_cv_url_chars">0</strong> characters</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders chat source with current chat + upload options
 */
function renderChatSource(type) {
    const context = getContext();
    const hasChat = !!context?.chatId;
    const messageCount = context?.chat?.length || 0;
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-chat-source">
            <div class="vectfox-cv-source-tabs">
                <button class="vectfox-cv-source-tab ${hasChat ? 'active' : ''}" data-source="current" ${!hasChat ? 'disabled' : ''}>
                    <i class="fa-solid fa-comment-dots"></i> Current Chat
                </button>
                <button class="vectfox-cv-source-tab ${!hasChat ? 'active' : ''}" data-source="upload">
                    <i class="fa-solid fa-upload"></i> Upload
                </button>
            </div>

            <!-- Current Chat Panel -->
            <div class="vectfox-cv-source-panel" data-panel="current" ${!hasChat ? 'style="display: none;"' : ''}>
                ${hasChat ? `
                    <div class="vectfox-cv-chat-info">
                        <div class="vectfox-cv-chat-stats">
                            <div class="vectfox-cv-stat">
                                <span class="vectfox-cv-stat-value">${messageCount}</span>
                                <span class="vectfox-cv-stat-label">Messages</span>
                            </div>
                            <div class="vectfox-cv-stat">
                                <span class="vectfox-cv-stat-value">${context?.name2 || 'Unknown'}</span>
                                <span class="vectfox-cv-stat-label">Character</span>
                            </div>
                        </div>
                        <div class="vectfox-cv-chat-uuid" style="text-align: center; margin-top: 8px;">
                            <code style="font-size: 0.7em; opacity: 0.6; user-select: all;">${getChatUUID() || 'unknown'}</code>
                        </div>
                        <div class="vectfox-cv-chat-note">
                            <i class="fa-solid fa-info-circle"></i>
                            Will vectorize all messages in the current chat
                        </div>
                    </div>
                ` : `
                    <div class="vectfox-cv-no-chat">
                        <i class="fa-solid fa-comment-slash"></i>
                        <span>No chat is currently open</span>
                    </div>
                `}
            </div>

            <!-- Upload Panel -->
            <div class="vectfox-cv-source-panel" data-panel="upload" ${hasChat ? 'style="display: none;"' : ''}>
                <div class="vectfox-cv-upload-zone" id="vectfox_cv_chat_upload_zone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <span>Drop chat file here or click to browse</span>
                    <span class="vectfox-cv-upload-formats">
                        Formats: ${options.uploadFormats.join(', ')}
                    </span>
                    <input type="file" id="vectfox_cv_chat_file_input"
                           accept="${options.uploadFormats.join(',')}" hidden>
                </div>
                <div class="vectfox-cv-upload-info" id="vectfox_cv_chat_upload_info" style="display: none;">
                    <i class="fa-solid fa-file"></i>
                    <span id="vectfox_cv_chat_upload_filename"></span>
                    <button class="vectfox-cv-upload-clear" id="vectfox_cv_chat_upload_clear">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vectfox-cv-chat-upload-stats" id="vectfox_cv_chat_upload_stats" style="display: none;">
                    <!-- Populated after file upload -->
                </div>
                <div class="vectfox-cv-upload-hint">
                    <strong>Supported formats:</strong><br>
                    • <code>.jsonl</code> - JSON Lines (one message per line)<br>
                    • <code>.json</code> - SillyTavern chat export<br>
                    • <code>.txt</code> - Plain text (will be chunked as-is)
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders current chat source (for chat type) - legacy, kept for compatibility
 */
function renderCurrentChatSource(type) {
    const context = getContext();
    const hasChat = !!context?.chatId;
    const messageCount = context?.chat?.length || 0;

    if (!hasChat) {
        return `
            <div class="vectfox-cv-no-chat">
                <i class="fa-solid fa-comment-slash"></i>
                <span>No chat is currently open</span>
                <span class="vectfox-cv-hint">Open a chat to vectorize its messages</span>
            </div>
        `;
    }

    return `
        <div class="vectfox-cv-chat-info">
            <div class="vectfox-cv-chat-stats">
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${messageCount}</span>
                    <span class="vectfox-cv-stat-label">Messages</span>
                </div>
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${context?.name2 || 'Unknown'}</span>
                    <span class="vectfox-cv-stat-label">Character</span>
                </div>
            </div>
            <div class="vectfox-cv-chat-uuid" style="text-align: center; margin-top: 8px;">
                <code style="font-size: 0.7em; opacity: 0.6; user-select: all;">${getChatUUID() || 'unknown'}</code>
            </div>
            <div class="vectfox-cv-chat-note">
                <i class="fa-solid fa-info-circle"></i>
                Will vectorize all messages in the current chat
            </div>
        </div>
    `;
}

/**
 * Renders select-based source (lorebook, character)
 */
function renderSelectSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-source-select">
            <div class="vectfox-cv-source-tabs">
                <button class="vectfox-cv-source-tab active" data-source="existing">
                    <i class="fa-solid fa-list"></i> Existing
                </button>
                ${options.allowUpload ? `
                    <button class="vectfox-cv-source-tab" data-source="upload">
                        <i class="fa-solid fa-upload"></i> Upload
                    </button>
                ` : ''}
            </div>

            <div class="vectfox-cv-source-panel" data-panel="existing">
                <label>${options.selectLabel || 'Select'}</label>
                <select id="vectfox_cv_source_select" class="vectfox-select">
                    <option value="">-- Select --</option>
                    <!-- Populated dynamically -->
                </select>
                <!-- Stats display (shown after selection) -->
                <div class="vectfox-cv-source-stats" id="vectfox_cv_source_stats" style="display: none;">
                    <div class="vectfox-cv-stats-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading info...
                    </div>
                </div>
            </div>

            ${options.allowUpload ? `
                <div class="vectfox-cv-source-panel" data-panel="upload" style="display: none;">
                    <div class="vectfox-cv-upload-zone" id="vectfox_cv_upload_zone">
                        <i class="fa-solid fa-cloud-arrow-up"></i>
                        <span>Drop file here or click to browse</span>
                        <span class="vectfox-cv-upload-formats">
                            Formats: ${options.uploadFormats.join(', ')}
                        </span>
                        <input type="file" id="vectfox_cv_file_input"
                               accept="${options.uploadFormats.join(',')}" hidden>
                    </div>
                    <div class="vectfox-cv-upload-info" id="vectfox_cv_upload_info" style="display: none;">
                        <i class="fa-solid fa-file"></i>
                        <span id="vectfox_cv_upload_filename"></span>
                        <button class="vectfox-cv-upload-clear" id="vectfox_cv_upload_clear">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * Renders input-based source (document)
 */
function renderInputSource(type) {
    const methods = type.sourceOptions.methods;

    return `
        <div class="vectfox-cv-input-source">
            <div class="vectfox-cv-input-tabs">
                ${methods.map((m, i) => `
                    <button class="vectfox-cv-input-tab ${i === 0 ? 'active' : ''}" data-method="${m.id}">
                        <i class="fa-solid ${m.icon}"></i>
                        <span>${m.name}</span>
                    </button>
                `).join('')}
            </div>

            <!-- Paste Text Panel -->
            <div class="vectfox-cv-input-panel" data-panel="paste">
                <textarea id="vectfox_cv_paste_text"
                          placeholder="Paste or type your text here..."
                          rows="8"></textarea>
            </div>

            <!-- Upload File Panel -->
            <div class="vectfox-cv-input-panel" data-panel="upload" style="display: none;">
                <div class="vectfox-cv-upload-zone" id="vectfox_cv_doc_upload_zone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <span>Drop file here or click to browse</span>
                    <span class="vectfox-cv-upload-formats">
                        Formats: ${methods.find(m => m.id === 'upload')?.formats?.join(', ') || '.txt, .md'}
                    </span>
                    <input type="file" id="vectfox_cv_doc_file_input"
                           accept="${methods.find(m => m.id === 'upload')?.formats?.join(',') || '.txt,.md'}" hidden>
                </div>
            </div>

            <!-- URL Fetch Panel -->
            <div class="vectfox-cv-input-panel" data-panel="url" style="display: none;">
                <div class="vectfox-cv-url-input">
                    <input type="text" id="vectfox_cv_url_input"
                           placeholder="https://example.com/article">
                    <button id="vectfox_cv_fetch_url" class="vectfox-btn-secondary">
                        <i class="fa-solid fa-download"></i> Fetch
                    </button>
                </div>
                <div class="vectfox-cv-url-status" id="vectfox_cv_url_status"></div>
            </div>

            <!-- Document Name -->
            <div class="vectfox-cv-doc-name">
                <label>Collection Name</label>
                <input type="text" id="vectfox_cv_doc_name"
                       placeholder="My Document">
            </div>
        </div>
    `;
}

/**
 * Renders Wiki source (Fandom / MediaWiki)
 */
function renderWikiSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-wiki-source">
            <!-- Plugin Status -->
            <div class="vectfox-cv-wiki-plugin-status" id="vectfox_cv_wiki_plugin_status">
                <i class="fa-solid fa-spinner fa-spin"></i> Checking plugin availability...
            </div>

            <!-- Wiki Type Selection -->
            <div class="vectfox-cv-wiki-type">
                <label>Wiki Type</label>
                <select id="vectfox_cv_wiki_type" class="vectfox-select">
                    ${options.types.map(t => `
                        <option value="${t.id}">${t.name}</option>
                    `).join('')}
                </select>
            </div>

            <!-- Wiki URL/ID Input -->
            <div class="vectfox-cv-wiki-url">
                <label>Wiki URL or ID</label>
                <input type="text" id="vectfox_cv_wiki_url"
                       class="vectfox-input"
                       placeholder="${options.types[0].placeholder}">
            </div>

            <!-- Page Filter (for bulk scraping) -->
            <div class="vectfox-cv-wiki-filter">
                <label>
                    Page Filter
                    <span class="vectfox-cv-optional">(optional)</span>
                </label>
                <input type="text" id="vectfox_cv_wiki_filter"
                       class="vectfox-input"
                       placeholder="${options.filterPlaceholder}">
                <div class="vectfox-cv-hint">
                    Leave empty to scrape single page, or enter comma-separated page names for bulk scrape
                </div>
            </div>

            <!-- Scrape Button -->
            <div class="vectfox-cv-wiki-actions">
                <button id="vectfox_cv_scrape_wiki" class="vectfox-btn-primary">
                    <i class="fa-solid fa-download"></i> Scrape Wiki
                </button>
            </div>

            <!-- Status/Preview -->
            <div class="vectfox-cv-wiki-status" id="vectfox_cv_wiki_status"></div>
            <div class="vectfox-cv-wiki-preview" id="vectfox_cv_wiki_preview" style="display: none;">
                <div class="vectfox-cv-wiki-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vectfox_cv_wiki_title">Wiki content loaded</span>
                </div>
                <div class="vectfox-cv-wiki-preview-stats">
                    <span><strong id="vectfox_cv_wiki_pages">0</strong> pages</span>
                    <span><strong id="vectfox_cv_wiki_chars">0</strong> characters</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders YouTube source
 */
function renderYouTubeSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-youtube-source">
            <!-- URL Input -->
            <div class="vectfox-cv-youtube-url">
                <label>YouTube URL or Video ID</label>
                <div class="vectfox-cv-youtube-input-row">
                    <input type="text" id="vectfox_cv_youtube_url"
                           class="vectfox-input"
                           placeholder="${options.placeholder}">
                    <button id="vectfox_cv_fetch_youtube" class="vectfox-btn-primary">
                        <i class="fa-brands fa-youtube"></i> Fetch
                    </button>
                </div>
            </div>

            <!-- Language (optional) -->
            <div class="vectfox-cv-youtube-lang">
                <label>
                    Language Code
                    <span class="vectfox-cv-optional">(optional)</span>
                </label>
                <input type="text" id="vectfox_cv_youtube_lang"
                       class="vectfox-input vectfox-input-sm"
                       placeholder="${options.langPlaceholder}"
                       maxlength="5"
                       style="width: 100px;">
                <div class="vectfox-cv-hint">
                    ISO 639-1 code (e.g., "en", "es", "ja"). Leave blank for auto-detect.
                </div>
            </div>

            <!-- Status/Preview -->
            <div class="vectfox-cv-youtube-status" id="vectfox_cv_youtube_status"></div>
            <div class="vectfox-cv-youtube-preview" id="vectfox_cv_youtube_preview" style="display: none;">
                <div class="vectfox-cv-youtube-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vectfox_cv_youtube_title">Transcript loaded</span>
                </div>
                <div class="vectfox-cv-youtube-preview-stats">
                    <span><strong id="vectfox_cv_youtube_chars">0</strong> characters</span>
                    <span><strong id="vectfox_cv_youtube_duration">~0</strong> min estimated</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Updates chunking strategy section
 */
/**
 * Content types whose Vectorize Content run uses the EventBase extraction path,
 * and therefore the Window Size / Window Overlap / Parallel Windows controls.
 * Today: 'chat' (covers both live chat history and chat-history .jsonl upload).
 * FUTURE: when a chunk-based summarizer path is added, return true for those
 * content-type ids here — slider visibility follows automatically, no other edits.
 * @param {string} typeId
 * @returns {boolean}
 */
function _usesEventBaseWindowControls(typeId) {
    return typeId === 'chat';
}

// ============================================================================
// AUTO-REFORMAT (Document/URL/Wiki only)
// ============================================================================

const REFORMAT_SUPPORTED_TYPES = ['document', 'url', 'wiki'];

function isReformatSupportedType() {
    return REFORMAT_SUPPORTED_TYPES.includes(currentContentType);
}

/**
 * Renders the Auto-Reformat section based on content type + current
 * currentSettings.reformat state. Safe to call any time content type or
 * reformat state changes (source-load, accept, discard, re-run).
 */
function renderReformatSection() {
    const section = $('#vectfox_cv_reformat_section');
    if (!isReformatSupportedType()) {
        section.hide();
        return;
    }
    section.show();

    const container = $('#vectfox_cv_reformat_content');
    const reformat = currentSettings.reformat;

    if (reformat?.accepted) {
        container.html(`
            <div class="vectfox-cv-reformat-accepted">
                <i class="fa-solid fa-circle-check"></i>
                <span>Auto-Reformat accepted. Chunking Strategy below is bypassed — the reviewed entries will be stored as-is.</span>
            </div>
            <div class="vectfox-cv-reformat-actions">
                <button class="vectfox-btn-secondary" id="vectfox_cv_reformat_discard">
                    <i class="fa-solid fa-rotate-left"></i> Discard &amp; Chunk Manually
                </button>
                <button class="vectfox-btn-secondary" id="vectfox_cv_reformat_rerun">
                    <i class="fa-solid fa-arrows-rotate"></i> Re-run Auto-Reformat
                </button>
            </div>
        `);
        $('#vectfox_cv_reformat_discard').on('click', () => {
            currentSettings.reformat = null;
            const type = getContentType(currentContentType);
            renderReformatSection();
            updateChunkingSection(type);
        });
        $('#vectfox_cv_reformat_rerun').on('click', runAutoReformat);
        return;
    }

    container.html(`
        <div class="vectfox-cv-reformat-intro">
            <span>Optional: have an LLM read this content, split it into clean per-entity/per-topic entries, and use those as the final chunks — instead of the mechanical strategy below. You'll review every entry before anything is stored.</span>
        </div>
        <button class="vectfox-btn-secondary" id="vectfox_cv_reformat_run">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Run Auto-Reformat
        </button>
    `);
    $('#vectfox_cv_reformat_run').on('click', runAutoReformat);
}

/**
 * Resolves the current source into plain text suitable for the reformatter.
 * Forces wiki away from `per_page` (which would return an array of per-page
 * objects, not a single string the batching packer can consume).
 */
async function _resolveReformatSourceText(source) {
    const { resolveAndPrepareContent } = await import('../core/content-vectorization.js');
    const prepSettings = currentContentType === 'wiki'
        ? { ...currentSettings, strategy: 'adaptive' }
        : currentSettings;
    const prepared = await resolveAndPrepareContent(currentContentType, source, prepSettings);
    if (typeof prepared.text === 'string') return prepared.text;
    if (Array.isArray(prepared.text)) {
        return prepared.text.map(t => (typeof t === 'string' ? t : t.text || '')).join('\n\n---\n\n');
    }
    return String(prepared.text || '');
}

/**
 * Runs the Auto-Reformat LLM pass and opens the review modal. Reused for
 * both the initial "Run Auto-Reformat" click and "Re-run Auto-Reformat".
 */
async function runAutoReformat() {
    const source = getSourceData();
    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    const container = $('#vectfox_cv_reformat_content');
    container.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Preparing content...</div>');

    try {
        const text = await _resolveReformatSourceText(source);
        if (!text.trim()) {
            container.html('<div class="vectfox-cv-error">Could not load content. Please check your selection.</div>');
            return;
        }

        const { getStringHash } = await import('../../../../utils.js');
        const sourceHash = getStringHash(text);
        const mergedSettings = resolveEffectiveSettings(currentSettings);

        const { getReformatCache } = await import('../core/reformat-store.js');
        const existing = getReformatCache(sourceHash);
        if (existing?.chunks?.length) {
            currentSettings.reformat = { accepted: true, sourceHash };
            renderReformatSection();
            updateChunkingSection(getContentType(currentContentType));
            toastr.info(`This exact content was already reformatted (${existing.chunks.length} chunks) — reusing the saved result.`, 'VectFox');
            return;
        }

        container.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Running Auto-Reformat...</div>');

        const { reformatDocument } = await import('../core/reformat-extractor.js');
        const result = await reformatDocument({
            text,
            contentType: currentContentType,
            settings: mergedSettings,
            onProgress: (done, total) => {
                container.find('.vectfox-cv-loading').html(
                    `<i class="fa-solid fa-spinner fa-spin"></i> Running Auto-Reformat (${done}/${total} batches)...`
                );
            },
        });

        if (result.chunks.length === 0) {
            const extra = result.warnings.length ? ` ${result.warnings.join(' ')}` : '';
            container.html(`<div class="vectfox-cv-error">Auto-Reformat produced no entries.${extra}</div>`);
            return;
        }

        renderReformatSection();

        const { openReformatReview } = await import('./reformat-review.js');
        const sourceName = source.name || source.filename || source.title || currentContentType;
        openReformatReview({
            chunks: result.chunks,
            warnings: result.warnings,
            sourceText: text,
            sourceName,
            contentType: currentContentType,
            onAccept: (acceptedRecords) => _finalizeReformatAccept({ acceptedRecords, sourceHash, text, sourceName, mergedSettings }),
            onDiscard: () => {
                currentSettings.reformat = null;
                renderReformatSection();
            },
            onRerun: () => runAutoReformat(),
        });
    } catch (e) {
        console.error('VectFox: Auto-Reformat failed:', e);
        container.html(`<div class="vectfox-cv-error">Auto-Reformat failed: ${e.message}</div>`);
    }
}

/**
 * Persists an accepted Auto-Reformat draft: expands any oversized entity body
 * via the existing adaptive splitter, shapes every physical chunk into the
 * same {text, metadata} form chunkText() itself produces (so nothing
 * downstream needs special-casing), freezes it in reformat-store.js keyed by
 * sourceHash, and flips currentSettings.reformat to accepted.
 */
async function _finalizeReformatAccept({ acceptedRecords, sourceHash, text, sourceName, mergedSettings }) {
    try {
        const { expandOversizedChunk } = await import('../core/reformat-extractor.js');
        const { saveReformatCache, getReformatCache } = await import('../core/reformat-store.js');

        const maxBodyChars = mergedSettings.reformat_max_body_chars || 2000;
        const previous = getReformatCache(sourceHash);

        const shapedChunks = [];
        for (const record of acceptedRecords) {
            const expanded = await expandOversizedChunk(record, maxBodyChars);
            for (const piece of expanded) {
                shapedChunks.push({
                    text: piece.body,
                    metadata: {
                        chunkIndex: shapedChunks.length,
                        totalChunks: 0, // patched below once the final count is known
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
        shapedChunks.forEach(c => { c.metadata.totalChunks = shapedChunks.length; });

        const providerModel = `${mergedSettings.reformat_provider || mergedSettings.chat_provider || 'openrouter'}:${mergedSettings.reformat_model || mergedSettings.chat_model || ''}`;

        if (previous?.chunks?.length) {
            // Re-running Auto-Reformat produces a new, non-deterministic generation.
            // Document/URL/Wiki vectorization always mints a brand-new collection per
            // run (there's no "same source → same collection" concept for these types,
            // unlike chat), so re-running can't silently duplicate data inside one
            // collection — but if the PREVIOUS generation was already vectorized into
            // its own collection, that old collection still exists independently.
            // Surface that plainly rather than guessing at which collection to touch.
            toastr.info(
                'This replaces the saved Auto-Reformat draft. If you already vectorized the previous version into a collection, that collection is untouched — delete it via Database Browser if you don\'t want both.',
                'VectFox',
                { timeOut: 10000 },
            );
        }

        if (text.length > 200000) {
            toastr.warning(
                `Auto-Reformat retains the original source text for audit (~${Math.round(text.length / 1024)} KB), adding to your settings storage size. Use "Clear Auto-Reformat originals" in Database Browser if this grows large.`,
                'VectFox',
                { timeOut: 10000 },
            );
        }

        saveReformatCache(sourceHash, {
            chunks: shapedChunks,
            originalText: text,
            contentType: currentContentType,
            sourceName,
            providerModel,
            schemaVersion: 1,
        });

        currentSettings.reformat = { accepted: true, sourceHash };
        toastr.success(`Auto-Reformat accepted: ${shapedChunks.length} chunk(s) ready. Click Vectorize to store them.`, 'VectFox');

        renderReformatSection();
        updateChunkingSection(getContentType(currentContentType));
    } catch (e) {
        console.error('VectFox: Failed to finalize Auto-Reformat accept:', e);
        toastr.error('Failed to save Auto-Reformat result: ' + e.message, 'VectFox');
    }
}

function updateChunkingSection(type) {
    const strategies = getChunkingStrategies(type.id);
    const defaults = getContentTypeDefaults(type.id);
    const selectedStrategyId = currentSettings.strategy || type.defaultStrategy;
    const isChatType = type.id === 'chat';

    // Default: ensure section is visible. The chat branch below may hide it for the
    // archive+EventBase route; non-chat types always need it visible.
    $('.vectfox-cv-chunking-section').show();

    // Window Size / Overlap / Parallel Windows are EventBase-extraction-path controls.
    // Show/hide them together based on the content type (single predicate above) so
    // they appear for chat history (+ chat upload) and, later, any chunk-based path.
    $('#vectfox_cv_parallel_row, #vectfox_cv_window_size_row, #vectfox_cv_window_overlap_row')
        .toggle(_usesEventBaseWindowControls(type.id));

    const strategySelect = $('#vectfox_cv_strategy');
    strategySelect.empty();

    strategies.forEach(s => {
        const selected = s.id === selectedStrategyId;
        strategySelect.append(`<option value="${s.id}" ${selected ? 'selected' : ''}>${s.name}</option>`);
    });

    // Update description
    const currentStrategy = getChunkingStrategy(strategySelect.val());
    $('#vectfox_cv_strategy_desc').text(currentStrategy?.description || '');

    // Get strategy-specific defaults if available
    const strategyDefaults = currentStrategy || {};
    const chunkSize = currentSettings.chunkSize || strategyDefaults.defaultSize || defaults.chunkSize;
    const chunkOverlap = currentSettings.chunkOverlap || strategyDefaults.defaultOverlap || defaults.chunkOverlap;

    // Update size controls values
    $('#vectfox_cv_chunk_size').val(chunkSize);
    $('#vectfox_cv_chunk_size_val').text(chunkSize);
    $('#vectfox_cv_overlap').val(chunkOverlap);
    $('#vectfox_cv_overlap_val').text(chunkOverlap === 0 ? 'Off' : chunkOverlap);

    const batchSize = currentSettings.batchSize || defaults.batchSize || 4;

    $('#vectfox_cv_batch_size').val(batchSize);
    $('#vectfox_cv_batch_size_val').text(batchSize);

    // Chat history now follows EventBase extraction settings from the dedicated GUI,
    // so keep the legacy strategy selector populated for internal compatibility but
    // hide the visible controls only for chat. Other content types still use them.
    // Auto-Reformat, once accepted, IS the final chunk set — the strategy
    // dropdown/size sliders below would be inert, so hide them and say so.
    // Checked before isChatType since the two are mutually exclusive (chat
    // never supports Auto-Reformat) but this ordering keeps the precedence
    // explicit if that ever changes.
    const isReformatActive = isReformatSupportedType() && currentSettings.reformat?.accepted === true;

    $('#vectfox_cv_strategy_select_wrapper').toggle(!isChatType && !isReformatActive);
    if (isReformatActive) {
        $('#vectfox_cv_strategy_desc').text('Chunking handled by Auto-Reformat — see the section above.');
        $('#vectfox_cv_size_controls').hide();
        $('.vectfox-cv-chunking-section').show();
        $('#vectfox_cv_parallel_row').hide();
        return;
    }
    if (isChatType) {
        $('#vectfox_cv_strategy_desc').text('');
        $('#vectfox_cv_size_controls').hide();
        $('.vectfox-cv-chunking-section').show();
        // Parallel/window rows already toggled above via _usesEventBaseWindowControls.
        return;
    }

    // Show/hide size controls based on strategy type
    updateSizeControlsVisibility();
}

/**
 * Show/hide size controls based on strategy requirements
 * Unit-based strategies (per_message, per_entry, etc.) don't need size/overlap
 * Text-based strategies (recursive, paragraph, sliding) need them
 */
function updateSizeControlsVisibility() {
    const strategyId = $('#vectfox_cv_strategy').val();
    const strategy = getChunkingStrategy(strategyId);

    const needsSize = strategy?.needsSize ?? false;
    const needsOverlap = strategy?.needsOverlap ?? false;

    const needsMessageBatchControl = strategyId === 'message_batch';

    // Show/hide size controls based on strategy requirements
    const hasAnyControls = needsSize || needsOverlap;
    $('#vectfox_cv_size_controls').toggle(hasAnyControls || needsMessageBatchControl);

    // Show/hide individual controls
    $('#vectfox_cv_chunk_size_row').toggle(needsSize);
    $('#vectfox_cv_overlap_row').toggle(needsOverlap);
    $('#vectfox_cv_batch_size_row').toggle(needsMessageBatchControl);

    // Update description when strategy changes
    $('#vectfox_cv_strategy_desc').text(strategy?.description || '');
}

/**
 * Updates options section based on content type
 */
function updateOptionsSection(type) {
    const container = $('#vectfox_cv_options_content');
    container.empty();

    let html = '';

    // Scope control (for types that support it)
    if (hasFeature(type.id, 'scopeControl')) {
        html += renderScopeOptions(type);
    }

    // Field selection (for character type)
    if (hasFeature(type.id, 'fieldSelection')) {
        html += renderFieldSelection();
    }

    // Text Cleaning settings
    html += renderTextCleaningOptions();

    // Keyword extraction settings (only for types whose ingestion path reads them —
    // EventBase chat ingestion does not, so this is hidden for the chat type).
    if (hasFeature(type.id, 'keywordExtraction')) {
        html += `
            <div class="vectfox-cv-option-row vectfox-cv-keyword-settings">
                <div class="vectfox-cv-keyword-header">
                    <span>Keyword Extraction</span>
                </div>
                <div class="vectfox-cv-keyword-controls">
                    <div class="vectfox-cv-keyword-level">
                        <label for="vectfox_cv_keyword_level">Level:</label>
                        <select id="vectfox_cv_keyword_level" class="vectfox-select">
                            <option value="off" ${currentSettings.keywordLevel === 'off' ? 'selected' : ''}>
                                Off - Manual only
                            </option>
                            <option value="minimal" ${currentSettings.keywordLevel === 'minimal' ? 'selected' : ''}>
                                Minimal - Intro section (5 max)
                            </option>
                            <option value="balanced" ${currentSettings.keywordLevel === 'balanced' || !currentSettings.keywordLevel ? 'selected' : ''}>
                                Balanced - Header area (12 max)
                            </option>
                            <option value="aggressive" ${currentSettings.keywordLevel === 'aggressive' ? 'selected' : ''}>
                                Aggressive - Full text (15 max)
                            </option>
                        </select>
                    </div>
                    <div class="vectfox-cv-keyword-weight">
                        <label for="vectfox_cv_keyword_weight">Base Weight:</label>
                        <input type="number" id="vectfox_cv_keyword_weight"
                               min="0.01" max="3.0" step="0.01"
                               value="${currentSettings.keywordBaseWeight || 1.5}"
                               class="vectfox-input-number">
                        <span class="vectfox-cv-weight-hint">×</span>
                    </div>
                </div>
                <span class="vectfox-cv-option-hint">
                    ${type.id === 'lorebook'
                        ? 'WI trigger keys always included. Auto-extraction adds more based on text frequency.'
                        : 'Higher frequency words get higher weights. Base weight applies to all extracted keywords.'}
                </span>
            </div>
        `;
    }

    // Lorebook-specific: respect disabled entries
    if (hasFeature(type.id, 'respectDisabled')) {
        html += `
            <div class="vectfox-cv-option-row">
                <label class="vectfox-cv-toggle-label">
                    <span>Include Disabled Entries</span>
                    <label class="vectfox-toggle-switch">
                        <input type="checkbox" id="vectfox_cv_include_disabled">
                        <span class="vectfox-toggle-slider"></span>
                    </label>
                </label>
                <span class="vectfox-cv-option-hint">
                    Vectorize entries even if disabled in World Info
                </span>
            </div>
        `;
    }

    container.html(html);
}

/**
 * Renders scope selection options with actual character/chat names
 */
function renderScopeOptions(type) {
    const defaultScope = type.defaults?.scope || 'character';
    const context = getContext();

    // Get current character name (if any)
    const hasCharacter = !!context?.characterId;
    const characterName = context?.name2 || 'No character';

    // Get current chat name (if any)
    const hasChat = !!context?.chatId;
    let chatName = 'No chat';
    if (hasChat) {
        // Try to get a meaningful chat name
        if (typeof chat_metadata !== 'undefined' && chat_metadata?.chat_name) {
            chatName = chat_metadata.chat_name;
        } else {
            chatName = `Chat #${context.chatId}`;
        }
    }

    const scopeData = [
        {
            id: 'character',
            name: hasCharacter ? characterName : 'Character',
            desc: hasCharacter ? `Only with ${characterName}` : 'No character selected',
            icon: 'fa-user',
            enabled: hasCharacter,
        },
        {
            id: 'chat',
            name: hasChat ? 'This Chat' : 'Chat',
            desc: hasChat ? chatName : 'No chat open',
            icon: 'fa-comment',
            enabled: hasChat,
        },
    ];

    return `
        <div class="vectfox-cv-scope-select">
            <label>Scope</label>
            <div class="vectfox-cv-scope-options">
                ${scopeData.map(scope => `
                    <label class="vectfox-cv-scope-option ${scope.id === defaultScope ? 'selected' : ''} ${!scope.enabled ? 'disabled' : ''}">
                        <input type="radio" name="vectfox_cv_scope" value="${scope.id}"
                               ${scope.id === defaultScope ? 'checked' : ''}
                               ${!scope.enabled ? 'disabled' : ''}>
                        <div class="vectfox-cv-scope-card">
                            <i class="fa-solid ${scope.icon}"></i>
                            <span class="vectfox-cv-scope-name">${scope.name}</span>
                            <span class="vectfox-cv-scope-desc">${scope.desc}</span>
                        </div>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Renders character field selection
 */
function renderFieldSelection() {
    const defaults = getContentTypeDefaults('character');

    return `
        <div class="vectfox-cv-field-select">
            <label>Fields to Vectorize</label>
            <div class="vectfox-cv-field-grid">
                ${CHARACTER_FIELDS.map(field => `
                    <label class="vectfox-cv-field-option">
                        <input type="checkbox" name="vectfox_cv_field"
                               value="${field.id}"
                               ${defaults.fields?.[field.id] ? 'checked' : ''}>
                        <span class="vectfox-cv-field-name">${field.name}</span>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Renders text cleaning options with preset dropdown and manage button
 */
function renderTextCleaningOptions() {
    // Import dynamically to get current settings
    const presets = [
        { id: 'none', name: 'None', desc: 'No cleaning applied' },
        { id: 'html_formatting', name: 'Strip HTML Formatting', desc: 'Removes font, color, bold/italic tags' },
        { id: 'metadata_blocks', name: 'Strip Metadata Blocks', desc: 'Removes hidden divs, details sections' },
        { id: 'ai_reasoning', name: 'Strip AI Reasoning Tags', desc: 'Removes thinking, tucao tags' },
        { id: 'comprehensive', name: 'Comprehensive Clean', desc: 'All formatting + metadata + reasoning' },
        { id: 'nuclear', name: 'Strip All HTML', desc: 'Plain text only' },
        { id: 'mvu_game_maker', name: 'MVU Game Maker', desc: 'Strips MVU engine tags + standard formatting' },
        { id: 'custom', name: 'Custom', desc: 'Your own pattern selection' },
    ];

    const currentPreset = currentSettings.cleaningPreset || getCleaningSettings().selectedPreset || 'custom';

    return `
        <div class="vectfox-cv-option-row vectfox-cv-cleaning-settings">
            <div class="vectfox-cv-cleaning-header">
                <span>Text Cleaning</span>
                <button class="vectfox-btn-icon" id="vectfox_cv_manage_cleaning" title="Manage Cleaning Patterns">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
            <div class="vectfox-cv-cleaning-controls">
                <div class="vectfox-cv-cleaning-preset">
                    <label for="vectfox_cv_cleaning_preset">Preset:</label>
                    <select id="vectfox_cv_cleaning_preset" class="vectfox-select">
                        ${presets.map(p => `
                            <option value="${p.id}" ${p.id === currentPreset ? 'selected' : ''}>
                                ${p.name}
                            </option>
                        `).join('')}
                    </select>
                </div>
            </div>
            <span class="vectfox-cv-option-hint" id="vectfox_cv_cleaning_hint">
                ${presets.find(p => p.id === currentPreset)?.desc || ''}
            </span>
        </div>
    `;
}

// ============================================================================
// EVENT BINDING
// ============================================================================

/**
 * Binds all event handlers
 */
function bindEvents() {
    // Close handlers
    $('#vectfox_cv_close').on('click', closeContentVectorizer);
    $('#vectfox_cv_cancel').on('click', function() {
        if (isVectorizing) {
            stopActiveVectorization();
            return;
        }
        closeContentVectorizer();
    });
    $('#vectfox_content_vectorizer_modal .vectfox-modal-overlay').on('click', function() {
        if (!isVectorizing) closeContentVectorizer();
    });

    // Content type dropdown selection
    $('#vectfox_cv_type_select').on('change', function() {
        const type = $(this).val();

        if (!type) {
            // No selection - hide subsequent sections
            currentContentType = null;
            currentSettings = {};
            $('.vectfox-cv-subsequent').slideUp(200);
            $('#vectfox_cv_type_hint').text('Select a content type to continue');
            return;
        }

        currentContentType = type;
        currentSettings = { ...getContentTypeDefaults(type) };

        // Show type-specific hint
        const typeInfo = getContentType(type);
        $('#vectfox_cv_type_hint').text(typeInfo?.description || '');

        // Show subsequent sections and update UI
        $('.vectfox-cv-subsequent').slideDown(200);
        updateUIForContentType();
    });

    // Start From Message input
    $(document).on('change input', '#vectfox_cv_startfrom', function() {
        const v = parseInt($(this).val(), 10);
        startFromMessage = Number.isFinite(v) && v >= 1 ? v : 1;
        $(this).val(startFromMessage);
    });

    // Collapse toggles
    $('.vectfox-cv-collapse-btn').on('click', function() {
        const target = $(this).data('target');
        const content = $(`#vectfox_cv_${target}_content`);
        const icon = $(this).find('i');

        content.slideToggle(200);
        icon.toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Strategy change
    $('#vectfox_cv_strategy').on('change', function() {
        const strategy = $(this).val();
        const type = getContentType(currentContentType);
        const strategies = getChunkingStrategies(currentContentType);
        const selected = strategies.find(s => s.id === strategy);

        $('#vectfox_cv_strategy_desc').text(selected?.description || '');
        currentSettings.strategy = strategy;
        updateSizeControlsVisibility();
    });

    // Size sliders
    $('#vectfox_cv_chunk_size').on('input', function() {
        const val = $(this).val();
        $('#vectfox_cv_chunk_size_val').text(val);
        currentSettings.chunkSize = parseInt(val);
    });

    $('#vectfox_cv_overlap').on('input', function() {
        const val = parseInt($(this).val());
        $('#vectfox_cv_overlap_val').text(val === 0 ? 'Off' : val);
        currentSettings.chunkOverlap = val;
    });

    $('#vectfox_cv_batch_size').on('input', function() {
        const val = parseInt($(this).val());
        $('#vectfox_cv_batch_size_val').text(val);
        currentSettings.batchSize = val;
    });

    $('#vectfox_cv_parallel_windows').on('input', function() {
        const val = parseInt($(this).val());
        $('#vectfox_cv_parallel_val').text(val);
    });

    // Window Size / Overlap (moved from the EventBase tab). Bind to the SAME setting
    // keys so the workflow + Continue path read them unchanged — no migration.
    {
        const vf = extension_settings.vectfox || {};
        const ws = vf.eventbase_window_size ?? 2;
        const wo = vf.eventbase_window_overlap ?? 0;
        $('#vectfox_cv_window_size').val(ws);
        $('#vectfox_cv_window_size_val').text(ws);
        $('#vectfox_cv_window_overlap').val(wo);
        $('#vectfox_cv_window_overlap_val').text(wo);

        $('#vectfox_cv_window_size').on('input', function() {
            const val = parseInt($(this).val(), 10) || 2;
            $('#vectfox_cv_window_size_val').text(val);
            extension_settings.vectfox.eventbase_window_size = val;
            saveSettingsDebounced();
        });
        $('#vectfox_cv_window_overlap').on('input', function() {
            const val = parseInt($(this).val(), 10) || 0;
            $('#vectfox_cv_window_overlap_val').text(val);
            extension_settings.vectfox.eventbase_window_overlap = val;
            saveSettingsDebounced();
        });
    }

    // Scope selection
    $(document).on('change', 'input[name="vectfox_cv_scope"]', function() {
        currentSettings.scope = $(this).val();
        $('.vectfox-cv-scope-option').removeClass('selected');
        $(this).closest('.vectfox-cv-scope-option').addClass('selected');
    });

    // Keyword level dropdown
    $(document).on('change', '#vectfox_cv_keyword_level', function() {
        currentSettings.keywordLevel = $(this).val();
    });

    // Keyword base weight
    $(document).on('change', '#vectfox_cv_keyword_weight', function() {
        const value = parseFloat($(this).val());
        currentSettings.keywordBaseWeight = isNaN(value) ? 1.5 : Math.min(3.0, Math.max(0.01, value));
        $(this).val(currentSettings.keywordBaseWeight);
    });

    // Cleaning preset dropdown
    $(document).on('change', '#vectfox_cv_cleaning_preset', function() {
        const presetId = $(this).val();
        currentSettings.cleaningPreset = presetId;

        // Update hint text
        const hints = {
            none: 'No cleaning applied',
            html_formatting: 'Removes font, color, bold/italic tags',
            metadata_blocks: 'Removes hidden divs, details sections',
            ai_reasoning: 'Removes thinking, tucao tags',
            comprehensive: 'All formatting + metadata + reasoning',
            nuclear: 'Plain text only',
            mvu_game_maker: 'Strips MVU engine tags (UpdateVariable, combat_calculation, StoryAnalysis, combat_log) + standard formatting',
            custom: 'Your own pattern selection',
        };
        $('#vectfox_cv_cleaning_hint').text(hints[presetId] || '');

        // Save to extension settings
        saveCleaningPresetToSettings(presetId);
    });

    // Manage cleaning patterns button - opens the standalone Text Cleaning Manager
    // Uses modal-scoped delegation since modal has stopPropagation on all clicks
    $('#vectfox_content_vectorizer_modal').on('click', '#vectfox_cv_manage_cleaning', function(e) {
        e.preventDefault();
        openTextCleaningManager();
    });

    // Preview button
    $('#vectfox_cv_preview_btn').on('click', previewChunks);

    // Continue button (backfill - skips purge, DB dedup handles already-inserted chunks)
    $('#vectfox_cv_continue').on('click', startContinueVectorization);

    // Vectorize button
    $('#vectfox_cv_vectorize').on('click', startVectorization);
}

/**
 * Binds source-specific events
 */
function bindSourceEvents(type) {
    // Source tabs (skip disabled tabs)
    $('.vectfox-cv-source-tab:not([disabled])').on('click', function() {
        if ($(this).prop('disabled')) return;
        const source = $(this).data('source');
        $('.vectfox-cv-source-tab').removeClass('active');
        $(this).addClass('active');
        $('.vectfox-cv-source-panel').hide();
        $(`.vectfox-cv-source-panel[data-panel="${source}"]`).show();

        // Clear sourceData when switching tabs
        sourceData = null;

        // Chat's window controls (Parallel Windows / Window Size / Overlap) live in
        // the chunking section and drive BOTH the live-chat and file-upload EventBase
        // routes — both call runEventBaseIngestion, and the upload route reads
        // #vectfox_cv_parallel_windows directly (see handleEventBaseVectorize). So keep
        // the section visible on the Upload sub-tab too. updateChunkingSection() already
        // hid the strategy/size controls and showed the window rows for the chat path,
        // so a plain show() reveals exactly the right controls.
        // (Was: hidden on upload — stale, predates the window controls being re-homed
        //  into this section from the old EventBase tab, which silently dropped Parallel
        //  Windows / Window Size / Overlap from the chat-upload screen.)
        if (currentContentType === 'chat') {
            $('.vectfox-cv-chunking-section').show();
        }
    });

    // Input method tabs (for document type)
    $('.vectfox-cv-input-tab').on('click', function() {
        const method = $(this).data('method');
        $('.vectfox-cv-input-tab').removeClass('active');
        $(this).addClass('active');
        $('.vectfox-cv-input-panel').hide();
        $(`.vectfox-cv-input-panel[data-panel="${method}"]`).show();
    });

    // Upload zone click (all upload zones)
    $('#vectfox_cv_upload_zone, #vectfox_cv_doc_upload_zone, #vectfox_cv_chat_upload_zone').on('click', function(e) {
        // Don't trigger if clicking the input itself
        if (e.target.tagName === 'INPUT') return;
        $(this).find('input[type="file"]').trigger('click');
    });

    // Upload zone drag and drop
    $('#vectfox_cv_upload_zone, #vectfox_cv_doc_upload_zone, #vectfox_cv_chat_upload_zone')
        .on('dragover', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).addClass('dragover');
        })
        .on('dragleave', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).removeClass('dragover');
        })
        .on('drop', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).removeClass('dragover');

            const files = e.originalEvent.dataTransfer.files;
            if (files.length > 0) {
                // Get the file input and set the files
                const input = $(this).find('input[type="file"]')[0];
                // Create a new DataTransfer to set files on the input
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(files[0]);
                input.files = dataTransfer.files;
                // Trigger change event to process the file
                $(input).trigger('change');
            }
        });

    // File input change
    $('#vectfox_cv_file_input, #vectfox_cv_doc_file_input').on('change', handleFileUpload);

    // Chat file input change (special handler for chat files)
    $('#vectfox_cv_chat_file_input').on('change', handleChatFileUpload);

    // Clear upload
    $('#vectfox_cv_upload_clear').on('click', clearUpload);
    $('#vectfox_cv_chat_upload_clear').on('click', clearChatUpload);

    // Fetch URL
    $('#vectfox_cv_fetch_url').on('click', fetchUrl);

    // Wiki scraping
    $('#vectfox_cv_scrape_wiki').on('click', scrapeWiki);
    $('#vectfox_cv_wiki_type').on('change', function() {
        const wikiType = $(this).val();
        const type = getContentType('wiki');
        const typeInfo = type.sourceOptions.types.find(t => t.id === wikiType);
        if (typeInfo) {
            $('#vectfox_cv_wiki_url').attr('placeholder', typeInfo.placeholder);
        }
        // Re-check plugin availability
        checkWikiPluginStatus();
    });

    // YouTube fetch
    $('#vectfox_cv_fetch_youtube').on('click', fetchYouTubeTranscript);

    // Source select change - show stats
    $('#vectfox_cv_source_select').on('change', function() {
        const value = $(this).val();
        if (value) {
            loadSourceStats(type.id, value);
        } else {
            $('#vectfox_cv_source_stats').hide();
        }
    });

    // Populate select if needed
    if (type.sourceType === 'select') {
        populateSourceSelect(type);
    }

    // Check wiki plugin availability when wiki type is selected
    if (type.sourceType === 'wiki') {
        checkWikiPluginStatus();
    }
}

/**
 * Loads and displays stats for the selected source
 */
async function loadSourceStats(contentType, sourceId) {
    const statsContainer = $('#vectfox_cv_source_stats');
    statsContainer.show().html('<div class="vectfox-cv-stats-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading info...</div>');

    try {
        if (contentType === 'lorebook') {
            // Load lorebook info
            const worldInfoModule = await import('../../../../world-info.js');
            const loadWorldInfo = worldInfoModule.loadWorldInfo;

            if (loadWorldInfo) {
                const data = await loadWorldInfo(sourceId);
                const entries = data?.entries ? Object.values(data.entries) : [];
                const enabledEntries = entries.filter(e => !e.disable);
                const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);

                statsContainer.html(`
                    <div class="vectfox-cv-stats-grid">
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${entries.length}</span>
                            <span class="vectfox-cv-stat-label">Total Entries</span>
                        </div>
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${enabledEntries.length}</span>
                            <span class="vectfox-cv-stat-label">Enabled</span>
                        </div>
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                            <span class="vectfox-cv-stat-label">Characters</span>
                        </div>
                    </div>
                `);
            } else {
                statsContainer.html('<div class="vectfox-cv-stats-info">Lorebook selected</div>');
            }

        } else if (contentType === 'character') {
            // Load character info
            const context = getContext();
            const character = context?.characters?.find(c => c.avatar === sourceId);

            if (character) {
                const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
                const filledFields = fields.filter(f => character[f]?.trim());
                const totalChars = fields.reduce((sum, f) => sum + (character[f]?.length || 0), 0);

                statsContainer.html(`
                    <div class="vectfox-cv-stats-grid">
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${filledFields.length}/${fields.length}</span>
                            <span class="vectfox-cv-stat-label">Fields Used</span>
                        </div>
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                            <span class="vectfox-cv-stat-label">Characters</span>
                        </div>
                    </div>
                `);
            } else {
                statsContainer.html('<div class="vectfox-cv-stats-info">Character selected</div>');
            }
        }
    } catch (e) {
        console.error('VectFox: Failed to load source stats:', e);
        statsContainer.html('<div class="vectfox-cv-stats-info">Selected</div>');
    }
}

/**
 * Populates the source dropdown based on type
 */
async function populateSourceSelect(type) {
    const select = $('#vectfox_cv_source_select');
    select.empty().append('<option value="">-- Select --</option>');

    try {
        if (type.id === 'lorebook') {
            // Import world_names from ST's world-info module (same as legacy)
            try {
                const worldInfoModule = await import('../../../../world-info.js');
                const worldNames = worldInfoModule.world_names || [];

                if (worldNames && worldNames.length > 0) {
                    worldNames.forEach(name => {
                        select.append(`<option value="${name}">${name}</option>`);
                    });
                } else {
                    select.append('<option value="" disabled>No lorebooks found</option>');
                }
            } catch (importError) {
                console.warn('VectFox: Could not import world-info module:', importError);
                select.append('<option value="" disabled>Could not load lorebooks</option>');
            }

        } else if (type.id === 'character') {
            // Get available characters from context
            const context = getContext();
            const characters = context?.characters || [];

            if (characters.length > 0) {
                // Add current character at top if available
                if (context?.characterId) {
                    const currentChar = characters.find(c => c.avatar === context.characterId);
                    if (currentChar) {
                        select.append(`<option value="${StringUtils.escapeHtml(currentChar.avatar)}" selected>📌 ${StringUtils.escapeHtml(currentChar.name)} (current)</option>`);
                    }
                }

                // Add all other characters
                characters.forEach(char => {
                    // Skip if already added as current
                    if (char.avatar === context?.characterId) return;
                    select.append(`<option value="${StringUtils.escapeHtml(char.avatar)}">${StringUtils.escapeHtml(char.name)}</option>`);
                });
            } else {
                select.append('<option value="" disabled>No characters found</option>');
            }
        }
    } catch (e) {
        console.error('VectFox: Failed to populate source select:', e);
        select.append('<option value="" disabled>Error loading sources</option>');
    }
}

// ============================================================================
// FILE HANDLING
// ============================================================================

/**
 * Handles file upload (lorebook JSON, character PNG/JSON)
 */
function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();

    // PNG character cards need special handling (embedded JSON in tEXt chunk)
    if (ext === 'png') {
        handleCharacterPngUpload(file);
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        const content = event.target.result;

        // For lorebook JSON, parse and validate
        if (currentContentType === 'lorebook' && ext === 'json') {
            try {
                const data = JSON.parse(content);
                // ST lorebook format has entries object
                if (data.entries) {
                    const entries = Object.values(data.entries).filter(e => e.content);
                    sourceData = {
                        type: 'file',
                        filename: file.name,
                        content: entries,
                        entries: entries,
                        name: file.name.replace(/\.[^/.]+$/, ''),
                    };

                    // Show stats
                    const enabledCount = entries.filter(e => !e.disable).length;
                    const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);

                    $('#vectfox_cv_upload_zone').hide();
                    $('#vectfox_cv_upload_info').show();
                    $('#vectfox_cv_upload_filename').text(file.name);

                    toastr.success(`Loaded lorebook: ${entries.length} entries (${enabledCount} enabled)`, 'VectFox');
                } else {
                    throw new Error('Invalid lorebook format - missing entries');
                }
            } catch (err) {
                toastr.error(`Failed to parse lorebook: ${err.message}`);
                return;
            }
        } else if (currentContentType === 'character' && ext === 'json') {
            // Character JSON file
            try {
                const data = JSON.parse(content);
                // Look for character data fields
                if (data.name || data.description || data.personality) {
                    sourceData = {
                        type: 'file',
                        filename: file.name,
                        content: data,
                        character: data,
                        name: data.name || file.name.replace(/\.[^/.]+$/, ''),
                    };

                    $('#vectfox_cv_upload_zone').hide();
                    $('#vectfox_cv_upload_info').show();
                    $('#vectfox_cv_upload_filename').text(`${data.name || file.name}`);

                    toastr.success(`Loaded character: ${data.name || 'Unknown'}`, 'VectFox');
                } else {
                    throw new Error('Invalid character format - missing name/description');
                }
            } catch (err) {
                toastr.error(`Failed to parse character: ${err.message}`);
                return;
            }
        } else {
            // Generic file upload
            sourceData = {
                type: 'file',
                filename: file.name,
                content: content,
            };

            $('#vectfox_cv_upload_zone').hide();
            $('#vectfox_cv_upload_info').show();
            $('#vectfox_cv_upload_filename').text(file.name);

            // Auto-fill document name
            if (currentContentType === 'document') {
                $('#vectfox_cv_doc_name').val(file.name.replace(/\.[^/.]+$/, ''));
            }

            toastr.success(`Loaded: ${file.name}`, 'VectFox');
        }
    };

    reader.readAsText(file);
}

/**
 * Handles PNG character card upload
 * PNG character cards have JSON data embedded in the tEXt chunk with keyword "chara"
 */
async function handleCharacterPngUpload(file) {
    try {
        // Read PNG as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // Extract character data from PNG tEXt chunk
        const characterData = extractCharaFromPng(bytes);

        if (!characterData) {
            throw new Error('No character data found in PNG');
        }

        sourceData = {
            type: 'file',
            filename: file.name,
            content: characterData,
            character: characterData,
            name: characterData.name || file.name.replace(/\.[^/.]+$/, ''),
        };

        $('#vectfox_cv_upload_zone').hide();
        $('#vectfox_cv_upload_info').show();
        $('#vectfox_cv_upload_filename').text(`${characterData.name || file.name}`);

        // Show character stats
        const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
        const filledFields = fields.filter(f => characterData[f]?.trim());
        const totalChars = fields.reduce((sum, f) => sum + (characterData[f]?.length || 0), 0);

        toastr.success(`Loaded character: ${characterData.name} (${filledFields.length} fields, ${(totalChars/1000).toFixed(1)}k chars)`, 'VectFox');

    } catch (err) {
        console.error('VectFox: PNG parse error:', err);
        toastr.error(`Failed to parse character PNG: ${err.message}`);
    }
}

/**
 * Extracts character data from PNG tEXt chunk
 * Character cards store JSON data base64-encoded in a tEXt chunk with keyword "chara"
 * @param {Uint8Array} bytes - PNG file bytes
 * @returns {object|null} Parsed character data or null
 */
function extractCharaFromPng(bytes) {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== pngSignature[i]) {
            throw new Error('Not a valid PNG file');
        }
    }

    // Read chunks
    let offset = 8; // Skip signature

    while (offset < bytes.length) {
        // Read chunk length (4 bytes, big endian)
        const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
                       (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 4;

        // Read chunk type (4 bytes ASCII)
        const type = String.fromCharCode(bytes[offset], bytes[offset + 1],
                                         bytes[offset + 2], bytes[offset + 3]);
        offset += 4;

        if (type === 'tEXt') {
            // tEXt chunk: keyword (null-terminated) + text data
            const dataStart = offset;
            const dataEnd = offset + length;

            // Find null terminator for keyword
            let nullPos = dataStart;
            while (nullPos < dataEnd && bytes[nullPos] !== 0) {
                nullPos++;
            }

            const keyword = new TextDecoder().decode(bytes.slice(dataStart, nullPos));

            if (keyword === 'chara') {
                // Get the base64 data after the null terminator
                const base64Data = new TextDecoder().decode(bytes.slice(nullPos + 1, dataEnd));

                // Decode base64 to JSON
                try {
                    const jsonStr = atob(base64Data);
                    const charData = JSON.parse(jsonStr);

                    // Handle V2 format (data wrapped in 'data' object)
                    if (charData.spec === 'chara_card_v2' && charData.data) {
                        return charData.data;
                    }

                    return charData;
                } catch (e) {
                    console.error('VectFox: Failed to decode character data:', e);
                    throw new Error('Invalid character data in PNG');
                }
            }
        }

        // Skip chunk data and CRC (4 bytes)
        offset += length + 4;

        // Safety check for IEND
        if (type === 'IEND') break;
    }

    return null;
}

/**
 * Clears uploaded file
 */
function clearUpload() {
    sourceData = null;
    $('#vectfox_cv_upload_zone').show();
    $('#vectfox_cv_upload_info').hide();
    $('#vectfox_cv_file_input, #vectfox_cv_doc_file_input').val('');
}

/**
 * Fetches content from URL
 */
async function fetchUrl() {
    const url = $('#vectfox_cv_url_input').val().trim();
    if (!url) {
        toastr.warning('Please enter a URL');
        return;
    }

    // Validate URL format
    try {
        new URL(url);
    } catch {
        toastr.warning('Please enter a valid URL (including http:// or https://)');
        return;
    }

    const status = $('#vectfox_cv_url_status');
    const preview = $('#vectfox_cv_url_preview');
    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Fetching...');
    preview.hide();

    try {
        // Use ST's readability endpoint if available
        const response = await fetch('/api/serpapi/visit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.content || data.text || '';

        if (!content || content.length < 50) {
            throw new Error('No meaningful content found on page');
        }

        sourceData = {
            type: 'url',
            url: url,
            content: content,
            title: data.title || url,
        };

        status.html('');

        // Show preview
        $('#vectfox_cv_url_title').text(sourceData.title);
        $('#vectfox_cv_url_chars').text(content.length.toLocaleString());
        preview.show();

        toastr.success(`Fetched ${content.length.toLocaleString()} characters`, 'VectFox');

    } catch (e) {
        console.error('VectFox: URL fetch failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vectfox-danger);"></i> ${e.message}`);
        toastr.error('Failed to fetch URL: ' + e.message);
    }
}

// ============================================================================
// WIKI SCRAPING
// ============================================================================

/**
 * Checks if the wiki scraper plugin is available
 */
async function checkWikiPluginStatus() {
    const statusEl = $('#vectfox_cv_wiki_plugin_status');
    const wikiType = $('#vectfox_cv_wiki_type').val() || 'fandom';
    const scrapeBtn = $('#vectfox_cv_scrape_wiki');

    statusEl.html('<i class="fa-solid fa-spinner fa-spin"></i> Checking plugin...');

    const isAvailable = await isWikiPluginAvailable(wikiType);

    if (isAvailable) {
        statusEl.html(`
            <i class="fa-solid fa-check-circle" style="color: var(--vectfox-success);"></i>
            <span>${wikiType === 'fandom' ? 'Fandom' : 'MediaWiki'} scraper ready</span>
        `);
        scrapeBtn.prop('disabled', false);
    } else {
        const type = getContentType('wiki');
        statusEl.html(`
            <div class="vectfox-cv-wiki-plugin-warning">
                <i class="fa-solid fa-exclamation-triangle" style="color: var(--vectfox-warning);"></i>
                <span>Wiki scraping requires the Fandom Scraper plugin</span>
                <a href="${type.sourceOptions.pluginUrl}" target="_blank" rel="noopener" class="vectfox-cv-plugin-link">
                    <i class="fa-solid fa-external-link"></i> Install Plugin
                </a>
            </div>
        `);
        scrapeBtn.prop('disabled', true);
    }
}

/**
 * Checks if the wiki plugin is available via probe endpoint
 */
async function isWikiPluginAvailable(wikiType) {
    try {
        const endpoint = wikiType === 'fandom'
            ? '/api/plugins/fandom/probe'
            : '/api/plugins/fandom/probe-mediawiki';

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        return response.ok;
    } catch (error) {
        console.debug('VectFox: Wiki plugin probe failed:', error);
        return false;
    }
}

/**
 * Scrapes wiki content using ST's fandom scraper plugin
 */
async function scrapeWiki() {
    const wikiType = $('#vectfox_cv_wiki_type').val();
    const url = $('#vectfox_cv_wiki_url').val().trim();
    const filter = $('#vectfox_cv_wiki_filter').val().trim();

    if (!url) {
        toastr.warning('Please enter a wiki URL or ID');
        return;
    }

    const status = $('#vectfox_cv_wiki_status');
    const preview = $('#vectfox_cv_wiki_preview');
    const scrapeBtn = $('#vectfox_cv_scrape_wiki');

    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Scraping wiki...');
    preview.hide();
    scrapeBtn.prop('disabled', true);

    try {
        const endpoint = wikiType === 'fandom'
            ? '/api/plugins/fandom/scrape'
            : '/api/plugins/fandom/scrape-mediawiki';

        // Build request body based on wiki type
        let requestBody;
        if (wikiType === 'fandom') {
            // Extract fandom ID from URL
            const fandomId = extractFandomId(url);
            requestBody = { fandom: fandomId, filter: filter };
        } else {
            requestBody = { url: url, filter: filter };
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }

        const pages = await response.json();

        if (!pages || pages.length === 0) {
            throw new Error('No content found');
        }

        // Combine pages into content
        const combinedContent = pages.map(page =>
            `# ${String(page.title).trim()}\n\n${String(page.content).trim()}`
        ).join('\n\n---\n\n');

        sourceData = {
            type: 'wiki',
            wikiType: wikiType,
            url: url,
            content: combinedContent,
            pages: pages,
            pageCount: pages.length,
            name: extractWikiName(url, wikiType),
        };

        status.html('');
        scrapeBtn.prop('disabled', false);

        // Show preview
        $('#vectfox_cv_wiki_title').text(`${pages.length} page(s) scraped`);
        $('#vectfox_cv_wiki_pages').text(pages.length);
        $('#vectfox_cv_wiki_chars').text(combinedContent.length.toLocaleString());
        preview.show();

        toastr.success(`Scraped ${pages.length} page(s), ${combinedContent.length.toLocaleString()} chars`, 'VectFox');

    } catch (e) {
        console.error('VectFox: Wiki scrape failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vectfox-danger);"></i> ${e.message}`);
        scrapeBtn.prop('disabled', false);
        toastr.error('Failed to scrape wiki: ' + e.message);
    }
}

/**
 * Extracts fandom ID from URL
 */
function extractFandomId(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.split('.')[0] || url;
    } catch {
        return url;
    }
}

/**
 * Extracts wiki name from URL for collection naming
 */
function extractWikiName(url, wikiType) {
    try {
        if (wikiType === 'fandom') {
            return extractFandomId(url);
        }
        const urlObj = new URL(url);
        // Try to get article name from path
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        return pathParts[pathParts.length - 1] || urlObj.hostname;
    } catch {
        return url.substring(0, 50);
    }
}

// ============================================================================
// YOUTUBE TRANSCRIPT
// ============================================================================

/**
 * Fetches YouTube transcript
 */
async function fetchYouTubeTranscript() {
    const url = $('#vectfox_cv_youtube_url').val().trim();
    const lang = $('#vectfox_cv_youtube_lang').val().trim();

    if (!url) {
        toastr.warning('Please enter a YouTube URL or video ID');
        return;
    }

    const videoId = parseYouTubeId(url);
    if (!videoId) {
        toastr.warning('Could not parse YouTube video ID');
        return;
    }

    const status = $('#vectfox_cv_youtube_status');
    const preview = $('#vectfox_cv_youtube_preview');
    const fetchBtn = $('#vectfox_cv_fetch_youtube');

    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Fetching transcript...');
    preview.hide();
    fetchBtn.prop('disabled', true);

    try {
        const response = await fetch('/api/search/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: videoId, lang: lang || undefined }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }

        const transcript = await response.text();

        if (!transcript || transcript.length < 50) {
            throw new Error('No transcript available for this video');
        }

        sourceData = {
            type: 'youtube',
            videoId: videoId,
            url: `https://youtube.com/watch?v=${videoId}`,
            content: transcript,
            lang: lang || 'auto',
            name: `YouTube-${videoId}`,
        };

        status.html('');
        fetchBtn.prop('disabled', false);

        // Show preview with estimated duration (assuming ~150 words/min speaking rate, ~5 chars/word)
        const estimatedMinutes = Math.round(transcript.length / 750);
        $('#vectfox_cv_youtube_title').text(`Transcript loaded (${videoId})`);
        $('#vectfox_cv_youtube_chars').text(transcript.length.toLocaleString());
        $('#vectfox_cv_youtube_duration').text(`~${estimatedMinutes}`);
        preview.show();

        toastr.success(`Fetched transcript: ${transcript.length.toLocaleString()} characters`, 'VectFox');

    } catch (e) {
        console.error('VectFox: YouTube fetch failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vectfox-danger);"></i> ${e.message}`);
        fetchBtn.prop('disabled', false);
        toastr.error('Failed to fetch transcript: ' + e.message);
    }
}

/**
 * Parses YouTube video ID from URL or ID string
 */
function parseYouTubeId(url) {
    // If already looks like an ID (11 chars, alphanumeric + _ -)
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
        return url;
    }

    // Parse from various YouTube URL formats
    const regex = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]*).*/;
    const match = url.match(regex);
    return (match?.length && match[1]) ? match[1] : null;
}

// ============================================================================
// CHAT FILE HANDLING
// ============================================================================

/**
 * Parse the character name from a SillyTavern export filename.
 * Pattern: "{CharacterName} - YYYY-MM-DD@HHhMMmSSs.{ext}"
 * Falls back to the full stem when the pattern doesn't match.
 * CJK and other Unicode chars survive unchanged.
 */
function extractCharNameFromArchiveFilename(filename) {
    const stem = filename.replace(/\.(jsonl|json|txt)$/i, '');
    const m = stem.match(/^(.*?)\s+-\s+\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s$/);
    return (m ? m[1] : stem).trim();
}

/**
 * Compute a hex SHA-1 digest of text via SubtleCrypto.
 * Used as a stable, content-derived archive UUID when the file lacks chat_metadata.integrity.
 * @param {string} text
 * @returns {Promise<string>}
 */
async function sha1Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Handles chat file upload (.txt, .jsonl, .json)
 * Supports SillyTavern JSONL backup format (first line = metadata, rest = messages)
 */
async function handleChatFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(event) {
        const content = event.target.result;
        const ext = file.name.split('.').pop().toLowerCase();

        let messages = [];
        let metadata = null;
        let parseError = null;

        try {
            if (ext === 'jsonl') {
                // SillyTavern JSONL format:
                // Line 1: metadata object with user_name, character_name, create_date, chat_metadata
                // Lines 2+: message objects with name, is_user, is_system, send_date, mes, extra
                const lines = content.split('\n').filter(l => l.trim());

                for (let i = 0; i < lines.length; i++) {
                    const parsed = JSON.parse(lines[i]);

                    // First line is usually metadata (has chat_metadata or user_name fields)
                    if (i === 0 && (parsed.chat_metadata || parsed.user_name || parsed.character_name)) {
                        metadata = parsed;
                        continue;
                    }

                    // Skip system messages and lines without content
                    if (parsed.is_system) continue;
                    if (!parsed.mes && !parsed.text && !parsed.content) continue;

                    // Normalize message format
                    messages.push({
                        name: parsed.name || (parsed.is_user ? 'User' : 'Assistant'),
                        mes: parsed.mes || parsed.text || parsed.content || '',
                        is_user: parsed.is_user || false,
                        send_date: parsed.send_date,
                        // Preserved for EventBase: reasoning carries date/time/location
                        // for older chats whose `mes` has no inline date (see
                        // plans/eventbase-scene-context-from-reasoning.md).
                        reasoning: parsed.extra?.reasoning || '',
                    });
                }

            } else if (ext === 'json') {
                // Could be ST chat export or array of messages
                const data = JSON.parse(content);

                if (Array.isArray(data)) {
                    // Array of messages — skip system messages (parity with .jsonl handling)
                    messages = data
                        .filter(m => !m.is_system && (m.mes || m.text || m.content))
                        .map(m => ({
                            name: m.name || (m.is_user ? 'User' : 'Assistant'),
                            mes: m.mes || m.text || m.content || '',
                            is_user: m.is_user || false,
                            send_date: m.send_date,
                            reasoning: m.extra?.reasoning || '',
                        }));
                } else if (data.chat || data.messages) {
                    // Object with chat/messages array — skip system messages
                    const arr = data.chat || data.messages;
                    metadata = { user_name: data.user_name, character_name: data.character_name };
                    messages = arr
                        .filter(m => !m.is_system && (m.mes || m.text || m.content))
                        .map(m => ({
                            name: m.name || (m.is_user ? 'User' : 'Assistant'),
                            mes: m.mes || m.text || m.content || '',
                            is_user: m.is_user || false,
                            send_date: m.send_date,
                            reasoning: m.extra?.reasoning || '',
                        }));
                } else if (data.mes || data.text || data.content) {
                    // Single message object
                    messages = [{
                        name: data.name || 'Message',
                        mes: data.mes || data.text || data.content || '',
                        is_user: data.is_user || false,
                        send_date: data.send_date,
                        reasoning: data.extra?.reasoning || '',
                    }];
                }

            } else if (ext === 'txt') {
                // Plain text - try to detect chat format
                // Check for "Name: message" format (common in chat logs)
                const chatPattern = /^(.+?):\s*(.+)$/gm;
                const matches = [...content.matchAll(chatPattern)];

                if (matches.length > 2) {
                    // Looks like a chat log
                    messages = matches.map(m => ({
                        name: m[1].trim(),
                        mes: m[2].trim(),
                        is_user: /^(you|user|me|myself)$/i.test(m[1].trim()),
                    }));
                } else {
                    // Plain text, treat as single content block
                    messages = [{ mes: content, name: 'Document', is_user: false }];
                }
            }
        } catch (err) {
            parseError = err;
            console.error('VectFox: Chat file parse error:', err);
        }

        if (parseError || messages.length === 0) {
            toastr.error(`Failed to parse chat file: ${parseError?.message || 'No messages found'}`);
            return;
        }

        // Determine character name from metadata or first non-user message
        let characterName = metadata?.character_name || 'Unknown';
        if (characterName === 'Unknown') {
            const firstCharMessage = messages.find(m => !m.is_user);
            if (firstCharMessage?.name) characterName = firstCharMessage.name;
        }

        // Derive a stable archive UUID for EventBase ingestion.
        // Priority: chat_metadata.integrity (jsonl only) → SHA-1 of raw file content.
        const integrity = metadata?.chat_metadata?.integrity;
        const archiveUUID = integrity || await sha1Hex(content);
        if (!integrity) {
            console.warn(`[VectFox] Archive "${file.name}" has no chat_metadata.integrity — using SHA-1 hash as UUID`);
        }

        const filenameCharName = extractCharNameFromArchiveFilename(file.name)
            || metadata?.character_name
            || 'archive';

        // Store as sourceData
        sourceData = {
            type: 'file',
            filename: file.name,
            content: messages,
            messages: messages,
            metadata: metadata,
            characterName: characterName,
            archiveUUID,
            filenameCharName,
        };

        // Show upload info
        $('#vectfox_cv_chat_upload_zone').hide();
        $('#vectfox_cv_chat_upload_info').show();
        $('#vectfox_cv_chat_upload_filename').text(file.name);

        // Show stats
        const totalChars = messages.reduce((sum, m) => sum + (m.mes?.length || 0), 0);
        const userCount = messages.filter(m => m.is_user).length;
        const charCount = messages.filter(m => !m.is_user).length;

        $('#vectfox_cv_chat_upload_stats').show().html(`
            <div class="vectfox-cv-stats-grid">
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${messages.length}</span>
                    <span class="vectfox-cv-stat-label">Messages</span>
                </div>
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${characterName}</span>
                    <span class="vectfox-cv-stat-label">Character</span>
                </div>
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                    <span class="vectfox-cv-stat-label">Characters</span>
                </div>
            </div>
        `);

        toastr.success(`Loaded ${messages.length} messages from ${file.name}`, 'VectFox');
    };

    reader.readAsText(file);
}

/**
 * Clears chat upload
 */
function clearChatUpload() {
    sourceData = null;
    $('#vectfox_cv_chat_upload_zone').show();
    $('#vectfox_cv_chat_upload_info').hide();
    $('#vectfox_cv_chat_upload_stats').hide();
    $('#vectfox_cv_chat_file_input').val('');
}

// ============================================================================
// PREVIEW & VECTORIZATION
// ============================================================================

/**
 * Previews how content will be chunked
 */
async function previewChunks() {
    const type = getContentType(currentContentType);
    const source = getSourceData();

    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // EventBase is the exclusive chat pipeline — chat content is processed
    // by LLM event extraction at vectorize time, not chunked synchronously,
    // so there's nothing meaningful to preview. Mirrors the production gate
    // at startVectorization() so chat never reaches the chunk-prepare path.
    if (currentContentType === 'chat') {
        $('.vectfox-cv-preview-section').show();
        $('#vectfox_cv_preview_content').html(
            '<div class="vectfox-cv-info">' +
            'Chat content is processed by EventBase (LLM event extraction) ' +
            'rather than chunked. Click <strong>Vectorize</strong> to run extraction — ' +
            'there is no synchronous chunk preview for chat.' +
            '</div>'
        );
        return;
    }

    // Auto-Reformat, once accepted, already IS the final chunk set — nothing
    // to mechanically re-chunk. Show the frozen result instead of running
    // chunkText(), mirroring the chat/EventBase special case above.
    if (isReformatSupportedType() && currentSettings.reformat?.accepted) {
        $('.vectfox-cv-preview-section').show();
        const reformatContainer = $('#vectfox_cv_preview_content');
        reformatContainer.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading Auto-Reformat result...</div>');
        try {
            const { getReformatCache } = await import('../core/reformat-store.js');
            const frozen = getReformatCache(currentSettings.reformat.sourceHash);
            const chunks = frozen?.chunks || [];
            if (chunks.length === 0) {
                reformatContainer.html('<div class="vectfox-cv-error">No frozen Auto-Reformat chunks found — try Re-running Auto-Reformat above.</div>');
                return;
            }
            const totalChars = chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0);
            const avgChars = Math.round(totalChars / chunks.length);
            reformatContainer.html(`
                <div class="vectfox-cv-preview-stats">
                    <span><strong>${chunks.length}</strong> chunks (Auto-Reformat)</span>
                    <span>~<strong>${avgChars}</strong> chars avg</span>
                </div>
                <div class="vectfox-cv-preview-list">
                    ${chunks.slice(0, 10).map((chunk, i) => {
                        const label = `[${chunk.metadata?.entry_type || 'entry'}] ${chunk.metadata?.name || ''}: `;
                        return `
                        <div class="vectfox-cv-preview-chunk">
                            <span class="vectfox-cv-preview-num">#${i + 1}</span>
                            <span class="vectfox-cv-preview-text">${StringUtils.escapeHtml(label)}${StringUtils.escapeHtml(chunk.text.substring(0, 120))}${chunk.text.length > 120 ? '...' : ''}</span>
                            <span class="vectfox-cv-preview-size">${chunk.text.length} chars</span>
                        </div>
                    `}).join('')}
                    ${chunks.length > 10 ? `<div class="vectfox-cv-preview-more">...and ${chunks.length - 10} more</div>` : ''}
                </div>
            `);
        } catch (e) {
            console.error('VectFox: Auto-Reformat preview failed:', e);
            reformatContainer.html(`<div class="vectfox-cv-error">Preview failed: ${e.message}</div>`);
        }
        return;
    }

    // Show preview section
    $('.vectfox-cv-preview-section').show();
    const container = $('#vectfox_cv_preview_content');
    container.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Generating preview...</div>');

    try {
        // Import modules for content resolution and chunking
        const { chunkText } = await import('../core/chunking.js');
        const { resolveAndPrepareContent } = await import('../core/content-vectorization.js');

        // Resolve and prepare content (handles 'select' type sources like lorebooks)
        const prepared = await resolveAndPrepareContent(currentContentType, source, currentSettings);
        const contentText = prepared.text;

        if (!contentText || (Array.isArray(contentText) && contentText.length === 0)) {
            container.html('<div class="vectfox-cv-error">Could not load content. Please check your selection.</div>');
            return;
        }

        const chunks = await chunkText(contentText, {
            strategy: currentSettings.strategy || type.defaultStrategy,
            chunkSize: currentSettings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: currentSettings.chunkOverlap || type.defaults.chunkOverlap,
            batchSize: currentSettings.batchSize || 4,
        });

        // Handle empty or undefined chunks
        if (!chunks || chunks.length === 0) {
            container.html('<div class="vectfox-cv-error">No chunks generated. Content may be too short or empty.</div>');
            return;
        }

        // Calculate total chars for average
        const totalChars = Array.isArray(contentText)
            ? contentText.reduce((sum, t) => sum + (t?.length || 0), 0)
            : contentText.length;
        const avgChars = Math.round(totalChars / chunks.length);

        container.html(`
            <div class="vectfox-cv-preview-stats">
                <span><strong>${chunks.length}</strong> chunks</span>
                <span>~<strong>${avgChars}</strong> chars avg</span>
            </div>
            <div class="vectfox-cv-preview-list">
                ${chunks.slice(0, 10).map((chunk, i) => {
                    const chunkText = chunk.text || chunk;
                    return `
                    <div class="vectfox-cv-preview-chunk">
                        <span class="vectfox-cv-preview-num">#${i + 1}</span>
                        <span class="vectfox-cv-preview-text">${StringUtils.escapeHtml(chunkText.substring(0, 150))}${chunkText.length > 150 ? '...' : ''}</span>
                        <span class="vectfox-cv-preview-size">${chunkText.length} chars</span>
                    </div>
                `}).join('')}
                ${chunks.length > 10 ? `<div class="vectfox-cv-preview-more">...and ${chunks.length - 10} more</div>` : ''}
            </div>
        `);

    } catch (e) {
        console.error('VectFox: Preview failed:', e);
        container.html(`<div class="vectfox-cv-error">Preview failed: ${e.message}</div>`);
    }
}

/**
 * Gets the source data based on current selections
 */
function getSourceData() {
    const type = getContentType(currentContentType);

    // If we already have sourceData from file upload or URL fetch, use it
    if (sourceData) {
        return sourceData;
    }

    switch (type.id) {
        case 'document': {
            // Check for paste content
            const pasteContent = $('#vectfox_cv_paste_text').val()?.trim();
            if (pasteContent) {
                return {
                    type: 'paste',
                    content: pasteContent,
                    name: $('#vectfox_cv_doc_name').val() || 'Pasted Document',
                };
            }
            break;
        }

        case 'lorebook': {
            const selectVal = $('#vectfox_cv_source_select').val();
            if (selectVal) {
                return {
                    type: 'select',
                    id: selectVal,
                    name: selectVal,
                };
            }
            break;
        }

        case 'character': {
            const selectVal = $('#vectfox_cv_source_select').val();
            if (selectVal) {
                const context = getContext();
                const char = context?.characters?.find(c => c.avatar === selectVal);
                return {
                    type: 'select',
                    id: selectVal,
                    name: char?.name || selectVal,
                };
            }
            break;
        }

        case 'chat': {
            // Check which tab is active
            const activeTab = $('.vectfox-cv-chat-source .vectfox-cv-source-tab.active').data('source');

            if (activeTab === 'current') {
                // Use current chat
                const context = getContext();
                if (context?.chatId && context?.chat?.length > 0) {
                    return {
                        type: 'current',
                        id: context.chatId,
                        name: context.name2 || 'Chat',
                        content: context.chat,
                    };
                }
            }
            // If upload tab is active but no file loaded, sourceData will be null
            // and we'll fall through to return null
            break;
        }

        case 'url': {
            // URL type should have sourceData set by fetchUrl()
            // If not, check if URL input has a value (user hasn't clicked fetch yet)
            const urlInput = $('#vectfox_cv_url_input').val()?.trim();
            if (urlInput) {
                toastr.warning('Please click "Fetch" to load the URL content first');
            }
            break;
        }

        case 'wiki': {
            // Wiki type should have sourceData set by scrapeWiki()
            const wikiUrl = $('#vectfox_cv_wiki_url').val()?.trim();
            if (wikiUrl) {
                toastr.warning('Please click "Scrape Wiki" to load the content first');
            }
            break;
        }

        case 'youtube': {
            // YouTube type should have sourceData set by fetchYouTubeTranscript()
            const ytUrl = $('#vectfox_cv_youtube_url').val()?.trim();
            if (ytUrl) {
                toastr.warning('Please click "Fetch" to load the transcript first');
            }
            break;
        }
    }

    return null;
}

/**
 * Runs vectorization without purging existing vectors (continue/backfill mode).
 * The DB's hash-based deduplication automatically skips already-inserted chunks.
 * If no vectors exist yet, delegates to the normal startVectorization flow.
 */
async function startContinueVectorization() {
    if (isVectorizing) return;

    syncStartFromMessageFromUI();

    const source = getSourceData();
    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // currentSettings only carries content-type defaults — merge global VECTFOX settings
    // so the user's chat_model / API key (set in Core → LLM Summarization) is visible.
    const mergedSettings = resolveEffectiveSettings(currentSettings);
    console.log('[VectFox] LLM config check (vectorize-content):', {
        provider: mergedSettings.chat_provider,
        model: mergedSettings.chat_model,
        hasOpenRouterKey: !!getOpenRouterApiKey(mergedSettings),
        hasVllmUrl: !!mergedSettings.chat_vllm_url,
    });
    const llmCheck = validateLLMConfig(mergedSettings);
    if (!llmCheck.ok) {
        toastr.error(
            `${llmCheck.reason} Open VECTFOX → Core → LLM Summarization & EventBase Extraction and fill in the required fields.`,
            'Configuration required',
            { timeOut: 8000 }
        );
        return;
    }

    // If no vectors exist yet, just run the normal vectorization
    if (currentContentType === 'chat' && (source.type === 'current' || source.type === 'file')) {
        return _runEventBaseBackfill();
    }
    // (dead code guard — left in place so chunk path below still compiles)
    if (false) {
        try {
            const { doesChatHaveVectors } = await import('../core/collection-loader.js');
            const existing = await doesChatHaveVectors(currentSettings);
            if (!existing.hasVectors || existing.chunkCount === 0) {
                return startVectorization();
            }
        } catch (e) {
            // If check fails, fall through to backfill path
        }
    }

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());
    hideVectorizerForProgress();

    try {
        const { vectorizeContent } = await import('../core/content-vectorization.js');
        // Merge global VECTFOX settings (vector_backend, source, model, etc.) into currentSettings,
        // which by itself is only the content-type defaults. Without this, the collection-ID builder
        // sees `settings.vector_backend` as undefined and drops the backend segment from the name.
        const mergedSettings = resolveEffectiveSettings(currentSettings);
        const result = await vectorizeContent({
            contentType: currentContentType,
            source: source,
            settings: mergedSettings,
            abortSignal: activeVectorizeAbortController.signal,
            continueMode: true,
            startFromMessage,
        });
        if (result.chunkCount === 0) {
            // Already up to date — message shown by vectorizeContent
        } else {
            toastr.success(`Inserted ${result.chunkCount} new chunks`, 'VectFox');
        }
        closeContentVectorizer();
        if (currentContentType === 'lorebook') {
            const { refreshWIStatus } = await import('./ui-manager.js');
            await refreshWIStatus();
        }
    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            toastr.info('Vectorization stopped', 'VectFox');
            return;
        }
        console.error('VectFox: Continue vectorization failed:', e);
        toastr.error('Vectorization failed: ' + e.message, 'VectFox');
    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Runs EventBase ingestion for the current chat (live) or an uploaded archive file.
 * Called by startVectorization / continueVectorization for all chat content types.
 */
async function _runEventBaseBackfill({ resetCaches = false } = {}) {
    if (isVectorizing) return;

    syncStartFromMessageFromUI();

    console.log(`[EventBase] _runEventBaseBackfill: starting... (resetCaches=${resetCaches})`);

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());

    // Touch devices only — desktop behavior is left exactly as it was. On mobile the
    // vectorizer is a full-screen modal that covers the progress panel, and the
    // workflow's own show() runs deep inside runEventBaseIngestion (after cache checks
    // and several early-return paths). So here we show the panel upfront and fade the
    // modal out: the bottom-sheet appears immediately and the Action-tab "Progress"
    // button always has a panel to reopen, even on the workflow's quick-exit paths
    // (no messages / last window already extracted). On desktop none of this runs —
    // the panel is shown by the workflow exactly as before, in the corner, with the
    // modal left open. (hideVectorizerForProgress() is itself touch-gated.)
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
        progressTracker.show('EventBase Extraction', 0, 'Windows');
    }
    hideVectorizerForProgress();

    try {
        const { runEventBaseIngestion } = await import('../core/eventbase-workflow.js');
        const { chunkText } = await import('../core/chunking.js');
        const context = getContext();
        const settings = extension_settings.vectfox || {};
        const source = getSourceData();

        // Vectorize button = fresh start. Drop BOTH "already-extracted" caches for
        // this chat so ingestion re-runs from the chosen Start-From message instead
        // of fast-forwarding. Clears the stale-tip trap: a tip left over from a
        // previously-deleted collection makes the tip-based fast-forward skip every
        // window → "0 events extracted". Continue passes resetCaches=false to keep
        // the caches and only backfill new messages.
        const maybeResetCaches = async (uuid) => {
            if (!resetCaches || !uuid) return;
            // Routes through prepareForFreshExtraction (single source of truth for
            // "user wants fresh re-extraction"). The returned { skipTipFallback: true }
            // is also threaded into vectorizeAll / runEventBaseIngestion below via the
            // `resetCaches` truthiness — keeping both legs of the dual-mechanism fix
            // (clear caches + bypass Qdrant tip fallback) coordinated through one call.
            const { prepareForFreshExtraction } = await import('../core/eventbase-store.js');
            await prepareForFreshExtraction(uuid);
        };

        let messages, chatUUID, collectionIdOverride = null; // only used by archive route

        if (source?.type === 'file') {
            // Archive upload route — .jsonl / .json / .txt
            if (!source.messages?.length) {
                toastr.warning('Archive contains no usable messages', 'EventBase');
                return;
            }
            const allMessages = source.messages.filter(m => m.mes && m.mes.trim().length > 0);
            messages = allMessages;
            if (startFromMessage > 1) {
                const sliceIdx = Math.min(startFromMessage - 1, allMessages.length);
                console.log(`[EventBase] Archive start-from message ${startFromMessage} — skipping first ${sliceIdx} messages, ${allMessages.length - sliceIdx} remaining`);
                messages = allMessages.slice(sliceIdx);
            }
            chatUUID = source.archiveUUID;
            collectionIdOverride = buildArchiveEventCollectionId({
                filenameCharName: source.filenameCharName,
                archiveUUID: source.archiveUUID,
                backend: settings.vector_backend,
            });
            await maybeResetCaches(chatUUID);
            console.log(`[EventBase] Archive upload route — collection: ${collectionIdOverride}, messages: ${messages.length}`);

            const parallelWindows = parseInt($('#vectfox_cv_parallel_windows').val()) || 1;
            const result = await runEventBaseIngestion({
                messages,
                chatUUID,
                settings,
                abortSignal: activeVectorizeAbortController.signal,
                parallelWindows,
                collectionIdOverride,
                // When the caller cleared the caches (Reset & Vectorize popup), also
                // bypass the tip-based fallback in the workflow — otherwise the workflow
                // re-derives the tip from Qdrant contents and silently fast-forwards past
                // everything we wanted re-extracted. See 2026-05-30 bug report.
                skipTipFallback: resetCaches,
            });

            if (activeVectorizeAbortController?.signal?.aborted) {
                progressTracker.complete(false, `Stopped — saved ${result.eventsExtracted} events from ${result.windowsProcessed} windows so far`);
                toastr.info('EventBase ingestion stopped', 'VectFox');
            } else {
                progressTracker.complete(true, `EventBase: extracted ${result.eventsExtracted} events from ${result.windowsProcessed} windows`);
                toastr.success(`EventBase: extracted ${result.eventsExtracted} events across ${result.windowsProcessed} windows`, 'VectFox');
                closeContentVectorizer();
            }
        } else {
            // Live chat route — delegate entirely to vectorizeAll (same path as Sync Chat button)
            console.log('[EventBase] Context chat length:', context.chat?.length);
            if (!Array.isArray(context.chat) || context.chat.length === 0) {
                toastr.warning('No chat messages to process', 'EventBase');
                return;
            }

            chatUUID = getChatUUID();
            await maybeResetCaches(chatUUID);

            // Window-size-change warning. The window fingerprint dedup cache is
            // window-size-dependent (see eventbase-store.js#windowFingerprint), so
            // changing window size silently invalidates every cached fingerprint
            // and triggers full re-extraction with duplicate-coverage events.
            // Warn the user before they unknowingly pay that cost.
            //
            // The two checks below (`checkWindowSizeChanged` and `prepareForFreshExtraction`)
            // are the single source of truth for "did size change?" and "prep for fresh
            // re-extraction" — DO NOT inline these. Two bugs on 2026-05-30 came from
            // popups inlining incompatible versions of this logic.
            const { checkWindowSizeChanged, prepareForFreshExtraction } = await import('../core/eventbase-store.js');
            const sizeCheck = checkWindowSizeChanged(chatUUID, Math.max(2, settings.eventbase_window_size || 6));
            let freshExtractionOpts = null;
            if (sizeCheck.changed) {
                const estimatedWindows = Math.max(0, Math.floor(
                    context.chat.filter(m => m.mes && m.mes.trim().length > 0).length / sizeCheck.newSize
                ));
                const proceed = await callGenericPopup(
                    `<div style="text-align: left;">
                        <p><strong>Window size changed</strong> since the last extraction on this chat (was <strong>${sizeCheck.oldSize}</strong>, now <strong>${sizeCheck.newSize}</strong>).</p>
                        <p>The dedup cache is window-size-dependent, so Resume will re-extract from message ${startFromMessage || 1} at the new window size.</p>
                        <p style="margin-top: 10px;">Estimated cost: <strong>~${estimatedWindows} LLM calls</strong>. Existing events will not be deleted, so the collection will contain overlapping-coverage events at both sizes.</p>
                        <p style="margin-top: 10px;">Proceed anyway?</p>
                    </div>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    {
                        okButton: `Proceed (re-extract at window=${sizeCheck.newSize})`,
                        cancelButton: 'Cancel',
                    },
                );
                if (!proceed) {
                    progressTracker.complete(false, 'Cancelled — window size mismatch');
                    toastr.info('Resume cancelled', 'VectFox');
                    return;
                }
                // Stamp the new window size NOW, not at run-end. The workflow's
                // own setLastUsedWindowSize at the end of runEventBaseIngestion
                // only fires when the run completes AND windowsProcessed > 0 —
                // if the run dies partway (plugin error, abort, network failure)
                // the stamp never lands and this popup fires again on every
                // subsequent Continue, even though the user already explicitly
                // acknowledged the cost. Stamping at the Proceed click ties the
                // mark to user intent, not to run success. The workflow's
                // end-of-run stamp is still useful for non-popup paths (no-op
                // here since it'd just write the same value).
                // See 2026-05-30 bug report — user clicked Proceed multiple
                // times because intermediate runs failed without updating the
                // stamp.
                const { setLastUsedWindowSize } = await import('../core/eventbase-store.js');
                setLastUsedWindowSize(chatUUID, sizeCheck.newSize);
                console.log(`[EventBase] Window-size-change Proceed: stamped lastUsedWindowSize=${sizeCheck.newSize} for ${chatUUID} (user intent locked in regardless of run outcome)`);
                // Single shared entry point for "user said yes to fresh re-extraction".
                // Clears local caches + returns { skipTipFallback: true } to propagate.
                freshExtractionOpts = await prepareForFreshExtraction(chatUUID);
            }

            const legacyStrategy = currentSettings.strategy || 'per_message';
            const legacyBatchSize = Number(currentSettings.batchSize) || 4;
            const legacyChunks = await chunkText(context.chat.filter(m => m.mes && m.mes.trim().length > 0), {
                strategy: legacyStrategy,
                chunkSize: currentSettings.chunkSize || 1000,
                chunkOverlap: currentSettings.chunkOverlap || 200,
                batchSize: legacyBatchSize,
            });
            const legacyTotalChunks = Array.isArray(legacyChunks) ? legacyChunks.length : 0;
            const parallelWindows = parseInt($('#vectfox_cv_parallel_windows').val()) || 1;

            await vectorizeAll(settings, legacyBatchSize, activeVectorizeAbortController.signal, {
                startFromMessage,
                parallelWindows,
                progressPlan: {
                    strategy: legacyStrategy,
                    batchSize: legacyBatchSize,
                    totalChunks: legacyTotalChunks,
                },
                // Bypass the tip-based fallback inside runEventBaseIngestion when EITHER:
                // (a) the caller cleared the caches via Reset & Vectorize popup
                //     (resetCaches=true → maybeResetCaches at top of function already ran), OR
                // (b) the user proceeded through the window-size-change popup above
                //     (prepareForFreshExtraction returned { skipTipFallback: true }).
                // In both cases the user explicitly asked for re-extraction and the
                // Qdrant-side tip would silently fast-forward past everything. See
                // 2026-05-30 bug reports.
                skipTipFallback: resetCaches || !!freshExtractionOpts?.skipTipFallback,
            });

            if (!activeVectorizeAbortController?.signal?.aborted) {
                closeContentVectorizer();
            }
        }
    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            toastr.info('EventBase ingestion stopped', 'VectFox');
            console.log('[EventBase] Ingestion stopped by user');
            return;
        }
        // Insert failed after 3 retries — surface the underlying Qdrant error in a
        // popup so the user can see WHY (rate-limit / disk full / collection
        // schema mismatch / etc). A toast is too short for the multi-line errors
        // Qdrant tends to return; a popup gives the user something to copy and
        // share when reporting the problem. See plans/eventbase-extract-insert-pipeline.md §3.4.
        if (e?.code === 'insert_failed_max_retries') {
            console.error('[EventBase] Insert failed after 3 retries:', e);
            await callGenericPopup(
                `<div style="text-align: left;">
                    <p><strong>Vectorization stopped — database insert failed</strong></p>
                    <p>VectFox tried 3 times to write a batch of events to the vector store and the database rejected every attempt. Your collection is consistent (no partial writes), and the next run will pick up where this one stopped.</p>
                    <p>Underlying error:</p>
                    <pre style="white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;">${StringUtils.escapeHtml(e.message)}</pre>
                </div>`,
                POPUP_TYPE.TEXT,
                '',
                { okButton: 'Close' },
            );
            return;
        }
        // Silent insert loss detected — events made it through the workflow but
        // the count stored in Qdrant is smaller than expected. This is the
        // last-line defense against data-loss bugs in the layers beneath us
        // (hash collisions, plugin-side rejection, etc). Show the user the
        // counts so they know to investigate before relying on the collection.
        if (e?.code === 'insert_verification_failed') {
            console.error('[EventBase] Insert verification failed:', e);
            await callGenericPopup(
                `<div style="text-align: left;">
                    <p><strong>Vectorization stopped — silent data loss detected</strong></p>
                    <p>The number of events stored in the database is smaller than the number VectFox tried to insert. Some events were dropped between the workflow and Qdrant without any error being raised. <strong>Your collection is incomplete</strong> and should not be trusted until this is resolved.</p>
                    <p>This is usually one of: (a) a hash collision (two events colliding to the same point ID, where Qdrant treats the second as an overwrite of the first), (b) the Similharity plugin silently rejecting a payload field, or (c) a Qdrant capacity / network issue under the gateway.</p>
                    <p>Details:</p>
                    <pre style="white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;">${StringUtils.escapeHtml(e.message)}</pre>
                    <p>Suggested next step: delete this collection and re-vectorize after the fix. The console has more details.</p>
                </div>`,
                POPUP_TYPE.TEXT,
                '',
                { okButton: 'Close' },
            );
            return;
        }
        console.error('[EventBase] Backfill failed:', e);
        toastr.error('EventBase ingestion failed: ' + e.message, 'VectFox');
    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Headless backfill of the CURRENT chat, reusing the Continue path — but invokable
 * WITHOUT the vectorizer modal being open. Used by the auto-sync "Catch up now"
 * flow (ui-manager.js): when the user enables auto-sync on a chat with a large
 * unvectorized gap, this runs the backfill with the standard progress tracker
 * (full-screen on mobile, corner panel on desktop) and resolves when extraction
 * completes, so the caller can then enable auto-sync.
 *
 * Reuses _runEventBaseBackfill (Continue semantics: resetCaches=false → keep
 * caches, fill only the gap via tip/fingerprint dedup). Its modal-DOM touches
 * (hideVectorizerForProgress / updateVectorizeButtonState / closeContentVectorizer)
 * are jQuery no-ops when the modal is closed, and messages come from getContext(),
 * so it works headless. See plans/autosync-backlog-catchup-on-enable.md.
 *
 * @returns {Promise<{ ran: boolean, reason?: string }>}
 */
export async function backfillCurrentChatWithProgress() {
    if (isVectorizing) {
        toastr.info('A vectorization is already running');
        return { ran: false, reason: 'busy' };
    }
    // Point the (closed) vectorizer state at the live chat so _runEventBaseBackfill's
    // live-chat route is taken. getSourceData() returning null still routes here —
    // only source.type==='file' diverges to the archive path.
    currentContentType = 'chat';
    currentSettings = { ...getContentTypeDefaults('chat') };
    await _runEventBaseBackfill({ resetCaches: false });
    return { ran: true };
}

/**
 * Starts the vectorization process
 */
async function startVectorization() {
    if (isVectorizing) return;

    syncStartFromMessageFromUI();

    const type = getContentType(currentContentType);
    const source = getSourceData();

    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // All vectorization paths (EventBase for chat, chunk pipeline for non-chat) eventually
    // make LLM calls that share the summarize_* settings. Fail fast with a clear message
    // rather than letting it blow up mid-ingest. Merge global settings so the user's
    // chat_model / API key set in Core → LLM Summarization is visible here.
    const mergedSettings = resolveEffectiveSettings(currentSettings);
    console.log('[VectFox] LLM config check (start-vectorization):', {
        provider: mergedSettings.chat_provider,
        model: mergedSettings.chat_model,
        hasOpenRouterKey: !!getOpenRouterApiKey(mergedSettings),
        hasVllmUrl: !!mergedSettings.chat_vllm_url,
    });
    const llmCheck = validateLLMConfig(mergedSettings);
    if (!llmCheck.ok) {
        toastr.error(
            `${llmCheck.reason} Open VECTFOX → Core → LLM Summarization & EventBase Extraction and fill in the required fields.`,
            'Configuration required',
            { timeOut: 8000 }
        );
        return;
    }

    // EventBase is the exclusive path for chat — always redirect through EventBase ingestion pipeline.
    // The Vectorize button is the "fresh start" action: it resets the extraction caches so ingestion
    // re-runs from the chosen Start-From message. Confirm first when prior extraction state exists,
    // since the reset re-extracts (LLM cost) what may already be vectorized — use Continue to backfill
    // without resetting. No prompt on a never-vectorized chat (nothing to reset).
    if (currentContentType === 'chat' && (source.type === 'current' || source.type === 'file')) {
        const resetUUID = source.type === 'file' ? source.archiveUUID : getChatUUID();
        if (await _hasPriorExtractionState(resetUUID)) {
            const proceed = await callGenericPopup(
                `<div style="text-align: left;">
                    <p><strong>Re-vectorize from scratch?</strong></p>
                    <p>This resets the extraction progress for this chat and re-extracts from message ${startFromMessage || 1} onward. Existing events are not deleted, so you may get overlapping-coverage events.</p>
                    <p style="margin-top: 10px;">To add only new messages without re-extracting, use <strong>Resume</strong> instead.</p>
                </div>`,
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: 'Reset & Vectorize', cancelButton: 'Cancel' },
            );
            if (!proceed) {
                toastr.info('Vectorize cancelled', 'VectFox');
                return;
            }
        }
        return _runEventBaseBackfill({ resetCaches: true });
    }

    // Check if vectors already exist for this content (chat specifically)
    if (currentContentType === 'chat' && source.type === 'current') {
        try {
            const { doesChatHaveVectors } = await import('../core/collection-loader.js');
            const existing = await doesChatHaveVectors(currentSettings);

            if (existing.hasVectors && existing.chunkCount > 0) {
                const confirmed = await callGenericPopup(
                    `<div style="text-align: center;">
                        <p>This chat already has <strong>${existing.chunkCount} chunks</strong> vectorized.</p>
                        <p style="margin-top: 10px;">What would you like to do?</p>
                    </div>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    {
                        okButton: 'Replace All',
                        cancelButton: 'Cancel',
                    }
                );

                if (!confirmed) {
                    return;
                }

                // User wants to replace - purge existing first
                const { purgeVectorIndex } = await import('../core/core-vector-api.js');
                const { unregisterCollection } = await import('../core/collection-loader.js');
                await purgeVectorIndex(existing.collectionId, currentSettings);
                unregisterCollection(existing.collectionId);
                toastr.info('Cleared existing vectors', 'VectFox');
            }
        } catch (e) {
            console.warn('VectFox: Could not check for existing vectors:', e);
            // Continue anyway
        }
    }

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());
    hideVectorizerForProgress();

    try {
        // Import the appropriate handler
        const { vectorizeContent } = await import('../core/content-vectorization.js');

        // Merge global VECTFOX settings (vector_backend, source, model, etc.) into currentSettings.
        const mergedSettings = resolveEffectiveSettings(currentSettings);
        const result = await vectorizeContent({
            contentType: currentContentType,
            source: source,
            settings: mergedSettings,
            abortSignal: activeVectorizeAbortController.signal,
            startFromMessage,
        });

        toastr.success(`Vectorized ${result.chunkCount} chunks`, 'VectFox');
        renderCollections();
        closeContentVectorizer();

        // After lorebook vectorization, refresh the WI status so the checkbox
        // auto-enables if the new collection is now active (global scope or chat-locked).
        if (currentContentType === 'lorebook') {
            const { refreshWIStatus } = await import('./ui-manager.js');
            await refreshWIStatus();
        }

    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');

        if (isStopped) {
            toastr.info('Vectorization stopped', 'VectFox');
            return;
        }

        console.error('VectFox: Vectorization failed:', e);

        // Check for dimension mismatch error and provide helpful guidance
        if (e.message.includes('dimension mismatch') || e.message.includes('Vector dimension error')) {
            toastr.error(
                'Vector dimension mismatch detected. You likely switched embedding models. ' +
                'Please delete this collection in Database Browser and try again.',
                'VECTFOX - Dimension Mismatch',
                { timeOut: 10000 }
            );
        } else {
            toastr.error('Vectorization failed: ' + e.message, 'VectFox');
        }

    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

// ============================================================================
// TEXT CLEANING MANAGEMENT
// ============================================================================

/**
 * Saves the cleaning preset to extension settings
 */
async function saveCleaningPresetToSettings(presetId) {
    const { saveCleaningSettings, getCleaningSettings } = await import('../core/text-cleaning.js');
    const settings = getCleaningSettings();
    settings.selectedPreset = presetId;
    saveCleaningSettings(settings);
    saveSettingsDebounced();
}

// Note: Text cleaning management is now handled by the standalone Text Cleaning Manager
// accessible from the Actions panel. The openTextCleaningManager() function is imported
// from './text-cleaning-manager.js' and used by the gear button in the Content Vectorizer.

