/**
 * ============================================================================
 * VectFox QUERY TESTER MODAL
 * ============================================================================
 * Dry-runs the three retrieval pipelines (EventBase, ChunkBase, Lorebook WI)
 * against a test message and shows the text each would inject. Uses the
 * current settings and locked collections; the prompt is not touched.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { log } from '../core/log.js';

/**
 * Opens the Query Tester modal. The user types a test message, clicks Run, and
 * sees what each pipeline would inject for it, using all current settings
 * (agentic mode, filters, locked collections).
 */
export function openQueryTestModal() {
    $('#VectFox_query_tester_modal').remove();

    const sectionStyle = 'display:flex; flex-direction:column; gap:4px; border-left:3px solid; padding-left:8px;';

    const html = `
        <div id="VectFox_query_tester_modal" class="vectfox-modal" style="display:none;">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content" style="max-width:700px; max-height:92vh; display:flex; flex-direction:column;">
                <div class="vectfox-modal-header">
                    <h3><i class="fa-solid fa-flask"></i> VectFox Query Tester</h3>
                    <button class="vectfox-modal-close" id="VectFox_qtester_close">✕</button>
                </div>
                <div class="vectfox-modal-body" style="padding:16px; display:flex; flex-direction:column; gap:10px; overflow-y:auto; flex:1 1 auto;">
                    <small style="color:var(--SmartThemeQuoteColor,#999);">
                        Dry-run all three pipelines (EventBase, ChunkBase, Lorebook WI) against a test message.
                        Uses your current settings and locked collections. Prompt injection is <b>not</b> affected.
                    </small>
                    <textarea id="VectFox_qtester_input"
                        class="text_pole"
                        placeholder="e.g. Do you remember how I rescued you?"
                        rows="3"
                        style="resize:vertical; width:100%; box-sizing:border-box;"></textarea>
                    <button id="VectFox_qtester_run" class="menu_button" style="align-self:flex-start;">
                        <i class="fa-solid fa-play"></i>&nbsp;Run All Pipelines
                    </button>
                    <div id="VectFox_qtester_status" style="display:none; color:var(--SmartThemeQuoteColor,#999); font-size:0.85em;">
                        <i class="fa-solid fa-spinner fa-spin"></i>&nbsp;Running retrieval…
                    </div>
                    <div id="VectFox_qtester_result" style="display:none; flex-direction:column; gap:14px;">
                        <div style="${sectionStyle} border-color:#4a9eff;">
                            <small style="font-weight:bold; color:#4a9eff;">EventBase <span id="VectFox_qtester_meta_eb" style="font-weight:normal; color:var(--SmartThemeQuoteColor,#999);"></span></small>
                            <textarea id="VectFox_qtester_output_eb" readonly rows="8"
                                style="width:100%; box-sizing:border-box; font-family:monospace; font-size:0.78em; resize:vertical; white-space:pre-wrap; overflow-wrap:break-word;"></textarea>
                        </div>
                        <div style="${sectionStyle} border-color:#4dbb6e;">
                            <small style="font-weight:bold; color:#4dbb6e;">ChunkBase <span id="VectFox_qtester_meta_cb" style="font-weight:normal; color:var(--SmartThemeQuoteColor,#999);"></span></small>
                            <textarea id="VectFox_qtester_output_cb" readonly rows="8"
                                style="width:100%; box-sizing:border-box; font-family:monospace; font-size:0.78em; resize:vertical; white-space:pre-wrap; overflow-wrap:break-word;"></textarea>
                        </div>
                        <div style="${sectionStyle} border-color:#b06fff;">
                            <small style="font-weight:bold; color:#b06fff;">Lorebook WI <span id="VectFox_qtester_meta_lb" style="font-weight:normal; color:var(--SmartThemeQuoteColor,#999);"></span></small>
                            <textarea id="VectFox_qtester_output_lb" readonly rows="8"
                                style="width:100%; box-sizing:border-box; font-family:monospace; font-size:0.78em; resize:vertical; white-space:pre-wrap; overflow-wrap:break-word;"></textarea>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);

    $('#VectFox_query_tester_modal').on('mousedown touchstart', e => e.stopPropagation());
    $('#VectFox_qtester_close').on('click', _closeQueryTester);
    $('#VectFox_query_tester_modal').on('click', function (e) {
        if (e.target === this) _closeQueryTester();
    });

    $('#VectFox_qtester_run').on('click', async function () {
        const testMessage = $('#VectFox_qtester_input').val().trim();
        if (!testMessage) {
            toastr.warning('Enter a test message first.', 'VectFox');
            return;
        }

        $('#VectFox_qtester_run').prop('disabled', true);
        $('#VectFox_qtester_status').show();
        $('#VectFox_qtester_result').hide().css('display', 'none');

        try {
            const [
                { extension_settings, getContext },
                { runEventBaseRetrieval },
                { rearrangeChat },
                { runLorebookWIDryRun },
            ] = await Promise.all([
                import('../../../../extensions.js'),
                import('../core/eventbase-workflow.js'),
                import('../core/chat-vectorization.js'),
                import('../core/world-info-integration.js'),
            ]);

            const settings = extension_settings.vectfox;
            const { chat } = getContext();

            const [ebResult, cbResult, lbResult] = await Promise.all([
                runEventBaseRetrieval({ chat, searchText: testMessage, settings, dryRun: true, testMessage }),
                rearrangeChat(chat, settings, 'normal', { dryRun: true, testMessage }),
                runLorebookWIDryRun({ chat, testMessage, settings }),
            ]);

            $('#VectFox_qtester_status').hide();

            // --- EventBase ---
            if (ebResult?.injectionText) {
                $('#VectFox_qtester_meta_eb').text(`— ${ebResult.eventCount ?? '?'} event(s) retrieved`);
                $('#VectFox_qtester_output_eb').val(ebResult.injectionText);
            } else {
                const locked = (ebResult?.lockedCollectionsCount ?? 0) + (ebResult?.archiveCollectionsCount ?? 0);
                $('#VectFox_qtester_meta_eb').text('— no results');
                $('#VectFox_qtester_output_eb').val(
                    locked === 0
                        ? '(no EventBase collections are locked to this chat)'
                        : `(searched ${locked} collection(s) — 0 events matched. Try a more specific query or lower the score threshold.)`
                );
            }

            // --- ChunkBase ---
            if (cbResult?.injectionText) {
                $('#VectFox_qtester_meta_cb').text(`— ${cbResult.chunkCount ?? '?'} chunk(s) retrieved`);
                $('#VectFox_qtester_output_cb').val(cbResult.injectionText);
            } else {
                const reason = cbResult?.noCollections ? 'no ChunkBase collections are enabled'
                    : cbResult?.noActive ? 'no collections passed activation filters'
                    : cbResult?.allDuplicates ? 'all chunks already in context (dedup)'
                    : '0 chunks matched the query';
                $('#VectFox_qtester_meta_cb').text('— no results');
                $('#VectFox_qtester_output_cb').val(`(${reason})`);
            }

            // --- Lorebook WI ---
            if (lbResult?.injectionText) {
                $('#VectFox_qtester_meta_lb').text(`— ${lbResult.entryCount ?? '?'} entry/entries retrieved`);
                $('#VectFox_qtester_output_lb').val(lbResult.injectionText);
            } else {
                const reason = lbResult?.disabled ? 'Lorebook WI is disabled in settings'
                    : lbResult?.noCollections ? 'no vectorized lorebook collections found'
                    : '0 entries matched the query';
                $('#VectFox_qtester_meta_lb').text('— no results');
                $('#VectFox_qtester_output_lb').val(`(${reason})`);
            }

            $('#VectFox_qtester_result').css('display', 'flex').show();
        } catch (err) {
            $('#VectFox_qtester_status').hide();
            log.error('VectFox Query Tester: retrieval failed:', err);
            toastr.error(`Retrieval failed: ${err.message}`, 'VectFox');
        } finally {
            $('#VectFox_qtester_run').prop('disabled', false);
        }
    });

    $('#VectFox_query_tester_modal').fadeIn(200);
    setTimeout(() => $('#VectFox_qtester_input').focus(), 250);
}

function _closeQueryTester() {
    $('#VectFox_query_tester_modal').fadeOut(200, function () { $(this).remove(); });
}
