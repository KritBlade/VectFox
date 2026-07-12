/**
 * ============================================================================
 * AUTO-REFORMAT REVIEW MODAL
 * ============================================================================
 * Full before/after review for Auto-Reformat output. Runs BEFORE any
 * collection/hash/backend exists for the content being vectorized, so this
 * is its own fixed modal — not injected into content-vectorizer.js's DOM and
 * not wired to a live collection (unlike ui/chunk-visualizer.js, whose state
 * is keyed to an already-inserted collection's hashes).
 *
 * Reuses chunk-visualizer.js's dirty-tracking idiom (capture the original
 * value, flip a visual flag when the user edits a field) applied per-record
 * instead of per-stored-chunk — see _bindDirtyTracking() below.
 *
 * This module only renders and collects user decisions; it does not touch
 * the reformat cache, sourceHash, or vector DB. The caller (content-vectorizer.js)
 * owns that — see openReformatReview()'s onAccept/onDiscard/onRerun callbacks.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';

let _onAccept = null;
let _onDiscard = null;
let _onRerun = null;
let _records = []; // working copy: validated reformatted chunks + _accepted/_grounded flags

function _escapeHtml(text) {
    return StringUtils.escapeHtml(String(text ?? ''));
}

function _csv(arr) {
    return Array.isArray(arr) ? arr.join(', ') : '';
}

function _parseCsv(text) {
    return String(text || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * Opens the Auto-Reformat review modal.
 *
 * @param {object} params
 * @param {object[]} params.chunks - Validated reformatted records from reformatDocument()
 *        (each carries entry_type/name/aliases/affiliation/traits/relationships/keywords/body
 *        plus _nameGrounded/_ungroundedAliases from the hallucination guardrail)
 * @param {string[]} params.warnings - Batch-level warnings (truncation, per-batch failures)
 * @param {string} params.sourceText - Full prepared source text, shown read-only for reference
 * @param {string} params.sourceName
 * @param {string} params.contentType
 * @param {(acceptedRecords: object[]) => void} params.onAccept - Called with the
 *        kept (accepted, possibly edited) records, NOT yet expanded for oversized
 *        bodies — caller runs expandOversizedChunk() and freezes the cache.
 * @param {() => void} params.onDiscard - User chose to fall back to manual chunking.
 * @param {() => void} params.onRerun - User wants to discard this draft and re-run the LLM pass.
 */
export function openReformatReview({ chunks, warnings = [], sourceText = '', sourceName = '', contentType = '', onAccept, onDiscard, onRerun }) {
    _onAccept = onAccept;
    _onDiscard = onDiscard;
    _onRerun = onRerun;
    _records = (chunks || []).map((c, i) => ({ ...c, _id: i, _accepted: true }));

    _createModal({ warnings, sourceText, sourceName, contentType });
    _renderRecords();
    _bindEvents();

    $('#vectfox_rr_modal').fadeIn(200);
}

export function closeReformatReview() {
    $('#vectfox_rr_modal').fadeOut(200, function () { $(this).remove(); });
}

function _createModal({ warnings, sourceText, sourceName, contentType }) {
    $('#vectfox_rr_modal').remove();

    const warningsHtml = warnings.length
        ? `<div class="vectfox-rr-run-warnings">
             <i class="fa-solid fa-triangle-exclamation"></i>
             <div>${warnings.map(w => `<div>${_escapeHtml(w)}</div>`).join('')}</div>
           </div>`
        : '';

    const html = `
        <div id="vectfox_rr_modal" class="vectfox-modal">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-rr-modal">
                <div class="vectfox-modal-header">
                    <h3><i class="fa-solid fa-wand-magic-sparkles"></i> Review Auto-Reformat — ${_escapeHtml(sourceName)}</h3>
                    <button class="vectfox-modal-close" id="vectfox_rr_close"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="vectfox-rr-body">
                    ${warningsHtml}
                    <div class="vectfox-rr-summary">
                        <span><strong id="vectfox_rr_count">0</strong> entries extracted from <strong>${_escapeHtml(sourceName)}</strong> (${_escapeHtml(contentType)})</span>
                        <span class="vectfox-rr-hint">Review each entry below. Uncheck to drop one, edit any field to correct it, then Accept &amp; Continue.</span>
                    </div>
                    <div class="vectfox-rr-columns">
                        <div class="vectfox-rr-source-panel">
                            <div class="vectfox-rr-panel-title">Original source</div>
                            <pre class="vectfox-rr-source-text">${_escapeHtml(sourceText)}</pre>
                        </div>
                        <div class="vectfox-rr-records-panel" id="vectfox_rr_records"></div>
                    </div>
                </div>
                <div class="vectfox-rr-footer">
                    <button class="vectfox-btn vectfox-btn-secondary" id="vectfox_rr_discard">
                        <i class="fa-solid fa-rotate-left"></i> Discard &amp; Chunk Manually
                    </button>
                    <button class="vectfox-btn vectfox-btn-secondary" id="vectfox_rr_rerun">
                        <i class="fa-solid fa-arrows-rotate"></i> Re-run Auto-Reformat
                    </button>
                    <button class="vectfox-btn vectfox-btn-primary" id="vectfox_rr_accept">
                        <i class="fa-solid fa-check"></i> Accept &amp; Continue
                    </button>
                </div>
            </div>
        </div>
    `;
    $('body').append(html);

    $('#vectfox_rr_modal').on('mousedown touchstart', function (e) { e.stopPropagation(); });
}

function _recordCardHtml(record) {
    const ungrounded = !record._nameGrounded || (record._ungroundedAliases?.length > 0);
    const warningHtml = ungrounded
        ? `<div class="vectfox-rr-hallucination-warning">
             <i class="fa-solid fa-triangle-exclamation"></i>
             ${!record._nameGrounded ? `"${_escapeHtml(record.name)}" wasn't found in the source text — verify this wasn't invented.` : ''}
             ${record._ungroundedAliases?.length ? `Alias(es) not found in source: ${_escapeHtml(record._ungroundedAliases.join(', '))}.` : ''}
           </div>`
        : '';

    return `
        <div class="vectfox-rr-card ${ungrounded ? 'vectfox-rr-card-flagged' : ''}" data-id="${record._id}">
            <div class="vectfox-rr-card-header">
                <label class="checkbox_label">
                    <input type="checkbox" class="vectfox-rr-accept-toggle" ${record._accepted ? 'checked' : ''} />
                    <span>Keep this entry</span>
                </label>
                <select class="vectfox-rr-field vectfox-rr-entry-type" data-field="entry_type">
                    ${['character', 'organization', 'concept', 'location', 'item', 'other'].map(t =>
                        `<option value="${t}" ${t === record.entry_type ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            ${warningHtml}
            <div class="vectfox-rr-field-row">
                <label>Name</label>
                <input type="text" class="vectfox-rr-field" data-field="name" value="${_escapeHtml(record.name)}" />
            </div>
            <div class="vectfox-rr-field-row">
                <label>Aliases</label>
                <input type="text" class="vectfox-rr-field" data-field="aliases" value="${_escapeHtml(_csv(record.aliases))}" placeholder="comma-separated" />
            </div>
            <div class="vectfox-rr-field-row">
                <label>Affiliation</label>
                <input type="text" class="vectfox-rr-field" data-field="affiliation" value="${_escapeHtml(record.affiliation)}" />
            </div>
            <div class="vectfox-rr-field-row">
                <label>Traits</label>
                <input type="text" class="vectfox-rr-field" data-field="traits" value="${_escapeHtml(_csv(record.traits))}" placeholder="comma-separated" />
            </div>
            <div class="vectfox-rr-field-row">
                <label>Relationships</label>
                <input type="text" class="vectfox-rr-field" data-field="relationships" value="${_escapeHtml(_csv(record.relationships))}" placeholder="comma-separated" />
            </div>
            <div class="vectfox-rr-field-row">
                <label>Keywords</label>
                <input type="text" class="vectfox-rr-field" data-field="keywords" value="${_escapeHtml(_csv(record.keywords))}" placeholder="comma-separated" />
            </div>
            <div class="vectfox-rr-field-row vectfox-rr-field-row-body">
                <label>Body</label>
                <textarea class="vectfox-rr-field" data-field="body" rows="4">${_escapeHtml(record.body)}</textarea>
            </div>
        </div>
    `;
}

function _renderRecords() {
    const container = $('#vectfox_rr_records');
    container.html(_records.map(_recordCardHtml).join(''));
    $('#vectfox_rr_count').text(_records.length);
    _bindDirtyTracking();
}

/**
 * Flags a card as edited (visual only) the moment any field differs from its
 * value at render time — mirrors chunk-visualizer.js's originalText/
 * hasUnsavedChanges pattern, applied per-record instead of per-stored-chunk.
 * Accept & Continue always serializes current field values regardless of
 * this flag; it's a review aid, not a save gate.
 */
function _bindDirtyTracking() {
    $('.vectfox-rr-card').each(function () {
        const card = $(this);
        const originals = new Map();
        card.find('.vectfox-rr-field').each(function () {
            originals.set(this, $(this).val());
        });
        card.find('.vectfox-rr-field').on('input change', function () {
            const isDirty = $(this).val() !== originals.get(this);
            card.toggleClass('vectfox-rr-card-dirty', isDirty || card.find('.vectfox-rr-field').toArray().some(el => $(el).val() !== originals.get(el)));
        });
    });
}

function _collectRecordFromCard(cardEl) {
    const card = $(cardEl);
    const id = Number(card.data('id'));
    const original = _records.find(r => r._id === id) || {};
    const get = (field) => card.find(`[data-field="${field}"]`).val();

    return {
        ...original,
        entry_type: get('entry_type'),
        name: String(get('name') || '').trim(),
        aliases: _parseCsv(get('aliases')),
        affiliation: String(get('affiliation') || '').trim(),
        traits: _parseCsv(get('traits')),
        relationships: _parseCsv(get('relationships')),
        keywords: _parseCsv(get('keywords')),
        body: String(get('body') || '').trim(),
        _accepted: card.find('.vectfox-rr-accept-toggle').prop('checked'),
    };
}

function _bindEvents() {
    $('#vectfox_rr_close, #vectfox_rr_discard').off('click').on('click', () => {
        closeReformatReview();
        _onDiscard?.();
    });

    $('#vectfox_rr_rerun').off('click').on('click', () => {
        closeReformatReview();
        _onRerun?.();
    });

    $('#vectfox_rr_accept').off('click').on('click', () => {
        const accepted = $('.vectfox-rr-card').toArray()
            .map(_collectRecordFromCard)
            .filter(r => r._accepted && r.name && r.body);

        if (accepted.length === 0) {
            toastr.warning('No entries were kept — nothing to accept. Uncheck none, or use Discard.', 'VectFox');
            return;
        }

        closeReformatReview();
        _onAccept?.(accepted);
    });
}
