/**
 * ============================================================================
 * VectFox PROGRESS TRACKER
 * ============================================================================
 * The progress panel a long run shows (progress-tracker-markup.js draws it): its title, Stop and close, a status line
 * over the bar, and pills for the items done, the units written, what was found, the time and the speed. The panel
 * stays after the run ends, until the user closes it; the Action page's Progress button shows it again.
 *
 * @author VectFox
 * ============================================================================
 */

import { log } from '../sillytavern/log.js';
import { placeOnTopmostModalLayer } from '../sillytavern/popup.js';
import { PROGRESS_PANEL_ID, PROGRESS_PILLS, progressErrorsMarkup, progressPanelMarkup, stopButtonMarkup } from './progress-tracker-markup.js';
import { setShown as showPart } from './gui-dna/gene-behaviours.js';

/** How often the time pill counts on. */
const TIME_TICK_MS = 250;

/** A speed taken over less time than this is a queue flushing at once, not work, so the run's average stands in. */
const MIN_BATCH_TIME_MS = 100;

const DEFAULT_UNIT_LABEL = 'Chunks';

const freshStats = (totalItems) => ({
    totalItems,
    processedItems: 0,
    currentBatch: 0,
    totalBatches: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    totalChunksToEmbed: 0,
    startTime: Date.now(),
    lastBatchTime: null,
    lastBatchSize: 0,
    lastBatchStartTime: Date.now(),
    errors: [],
});

function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
}

/**
 * Progress Tracker - Manages progress panel UI
 */
export class ProgressTracker {
    constructor() {
        this.panel = null;
        // On a touch screen the card sits over a backdrop covering the page; elsewhere it floats in the corner.
        this.isTouchLayout = false;
        this.isVisible = false;
        this.currentOperation = null;
        this.timeIntervalId = null;
        this.isComplete = false;
        this.completedSuccess = false;
        // The verdict complete() wrote, which stands on the status line however often the panel repaints after.
        this.finalStatus = '';
        this.isCancelling = false;
        this.cancelHandler = null;
        this.labels = { itemLabel: 'Progress', unitLabel: DEFAULT_UNIT_LABEL, foundLabel: '' };
        this.elements = null;
        this.stats = freshStats(0);
    }

    /**
     * Show the panel for a new run.
     *
     * @param {string} operation - The run's title, such as "EventBase Extraction"
     * @param {number} totalItems - How many items the run has
     * @param {string} itemLabel - What an item is: "Windows", "Steps", "Events"
     * @param {{unitLabel?: string, foundLabel?: string}} [labels] - unitLabel names what updateEmbeddingProgress counts
     *   ("Chunks" unless said; "Messages" on EventBase); foundLabel, when given, names what updateChunks counts ("Events")
     */
    show(operation, totalItems = 0, itemLabel = 'Progress', { unitLabel = DEFAULT_UNIT_LABEL, foundLabel = '' } = {}) {
        this.currentOperation = operation;
        this.isComplete = false;
        this.completedSuccess = false;
        this.finalStatus = '';
        this.isCancelling = false;
        this.labels = { itemLabel, unitLabel, foundLabel };
        this.stats = freshStats(totalItems);

        if (!this.panel) this.createPanel();
        // Last on the topmost open popup, so a run started from a popup shows above it, else last on the page, so it
        // layers above any ST panel opened after it
        placeOnTopmostModalLayer(this.panel);
        this.panel.removeAttribute('data-progress-outcome');
        showPart(this.elements.errors, false);
        showPart(this.elements.current, false);

        this.startTimeUpdater();
        showPart(this.panel, true);
        this.isVisible = true;
        this.updateDisplay();
        this.refreshCancelButton();
    }

    /**
     * Hide the panel. A run still going keeps its Stop handler; complete() clears it.
     */
    hide() {
        showPart(this.panel, false);
        this.isVisible = false;
        this.currentOperation = null;
        this.isCancelling = false;
        this.refreshCancelButton();
    }

    /**
     * Set cancellation callback for the current operation.
     * @param {Function|null} handler - Callback invoked when user clicks Stop
     */
    setCancelHandler(handler) {
        this.cancelHandler = typeof handler === 'function' ? handler : null;
        this.refreshCancelButton();
    }

    /**
     * Clear cancellation callback.
     */
    clearCancelHandler() {
        this.cancelHandler = null;
        this.refreshCancelButton();
    }

    /**
     * Trigger cancellation for the active operation.
     */
    requestCancel() {
        if (!this.cancelHandler || this.isComplete || this.isCancelling) return;
        this.isCancelling = true;
        this.updateDisplay('Stopping…');

        try {
            this.cancelHandler();
        } catch (error) {
            log.warn('[ProgressTracker] Stop failed:', error);
            this.addError(`Stop failed: ${error?.message || error}`);
            this.isCancelling = false;
        }

        this.refreshCancelButton();
    }

    /**
     * Show Stop while a run that can stop is on the panel, and Stopping once asked.
     */
    refreshCancelButton() {
        const slot = this.elements?.stop;
        if (!slot) return;
        const canStop = Boolean(this.cancelHandler) && this.isVisible && !this.isComplete;
        showPart(slot, canStop);
        const isStoppingShown = slot.querySelector('[data-progress-action="stop"]') === null;
        if (canStop && isStoppingShown !== this.isCancelling) slot.innerHTML = stopButtonMarkup({ isStopping: this.isCancelling });
    }

    /**
     * Update progress
     * @param {number} processedItems - Number of items processed so far
     * @param {string} status - Current status message
     */
    updateProgress(processedItems, status = '') {
        this.stats.processedItems = processedItems;
        this.updateDisplay(status);
    }

    /**
     * Update batch progress
     * @param {number} currentBatch - Current batch number
     * @param {number} totalBatches - Total number of batches
     */
    updateBatch(currentBatch, totalBatches) {
        this.stats.currentBatch = currentBatch;
        this.stats.totalBatches = totalBatches;
        this.updateDisplay();
    }

    /**
     * Update what the run found or made: the chunks a source cut into, or the events EventBase found (foundLabel).
     * @param {number} totalChunks
     */
    updateChunks(totalChunks) {
        this.stats.totalChunks = totalChunks;
        this.updateDisplay();
    }

    /**
     * Update how many units are written of how many, which the bar and the speed follow.
     * @param {number} embeddedChunks - Units written so far
     * @param {number} totalChunksToEmbed - Units to write
     */
    updateEmbeddingProgress(embeddedChunks, totalChunksToEmbed) {
        log.verbose(`[ProgressTracker] updateEmbeddingProgress: ${embeddedChunks}/${totalChunksToEmbed}`);
        const batchSize = embeddedChunks - (this.stats.embeddedChunks || 0);
        if (batchSize > 0 && this.stats.lastBatchStartTime) {
            const now = Date.now();
            this.stats.lastBatchTime = now - this.stats.lastBatchStartTime;
            this.stats.lastBatchSize = batchSize;
            this.stats.lastBatchStartTime = now;
        }
        this.stats.embeddedChunks = embeddedChunks;
        this.stats.totalChunksToEmbed = totalChunksToEmbed;
        this.updateDisplay();
    }

    /**
     * Show the item at work under the pills, such as the collection a run writes; empty hides it.
     * @param {string} text
     */
    updateCurrentItem(text) {
        setText(this.elements?.current, text || '');
        showPart(this.elements?.current, Boolean(text));
    }

    /**
     * Add error to tracker
     * @param {string} error - Error message
     */
    addError(error) {
        this.stats.errors.push({ message: String(error), timestamp: Date.now() });
        if (this.elements?.errors) {
            this.elements.errors.innerHTML = progressErrorsMarkup(this.stats.errors.map(each => each.message));
            showPart(this.elements.errors, true);
        }
    }

    /**
     * End the run on the panel, which stays until the user closes it.
     * @param {boolean} success - Whether operation succeeded
     * @param {string} message - Completion message
     */
    complete(success, message = '') {
        this.isComplete = true;
        this.completedSuccess = success;
        this.isCancelling = false;
        this.clearCancelHandler();
        this.stopTimeUpdater();

        const seconds = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        const words = message || (success ? 'Done' : 'Failed');
        this.panel?.setAttribute('data-progress-outcome', success ? 'success' : 'failure');
        this.finalStatus = `${words} (${seconds} s)`;
        this.updateDisplay();
    }

    /**
     * Show the panel again after it was closed.
     * @returns {boolean} true if there was a panel to show
     */
    reopen() {
        if (!this.panel) return false;
        // Only revealed: show() put it on the page, or moved it off a popup that closed.
        showPart(this.panel, true);
        this.isVisible = true;
        this.updateDisplay();
        this.refreshCancelButton();
        return true;
    }

    /**
     * Build the panel once; later runs reuse it.
     */
    createPanel() {
        this.isTouchLayout = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        // A panel a previous load left behind goes, so its handlers do not answer twice.
        document.getElementById(PROGRESS_PANEL_ID)?.remove();

        const template = document.createElement('template');
        template.innerHTML = progressPanelMarkup({ isTouchLayout: this.isTouchLayout });
        this.panel = template.content.firstElementChild;
        document.body.appendChild(this.panel);

        const part = name => this.panel.querySelector(`[data-progress-part="${name}"]`);
        this.elements = {
            title: part('title'),
            stop: part('stop'),
            status: part('status'),
            percent: part('percent'),
            bar: part('bar'),
            current: part('current'),
            errors: part('errors'),
            pills: Object.fromEntries(PROGRESS_PILLS.map(name => [name, part(name)])),
        };

        this.panel.addEventListener('click', (event) => {
            const action = event.target.closest('[data-progress-action]')?.dataset.progressAction;
            if (action === 'stop') this.requestCancel();
            else if (action === 'close') this.hide();
        });
    }

    /** The bar's share done: the units written when the run counts them, else its items. */
    percentDone() {
        if (this.isComplete && this.completedSuccess) return 100;
        const { embeddedChunks, totalChunksToEmbed, processedItems, totalItems } = this.stats;
        if (totalChunksToEmbed > 0) return Math.round((embeddedChunks / totalChunksToEmbed) * 100);
        if (totalItems > 0) return Math.round((processedItems / totalItems) * 100);
        return 0;
    }

    /**
     * Units written a second: over the last batch, or the run's average when that batch took no real time. Under a
     * second in, an average says nothing, so there is none.
     */
    unitsPerSecond() {
        const { lastBatchTime, lastBatchSize, embeddedChunks, startTime } = this.stats;
        if (lastBatchTime >= MIN_BATCH_TIME_MS && lastBatchSize > 0) return lastBatchSize / (lastBatchTime / 1000);
        const elapsed = (Date.now() - startTime) / 1000;
        return embeddedChunks > 0 && elapsed >= 1 ? embeddedChunks / elapsed : 0;
    }

    /** What each pill says, '' for a pill with nothing to say. */
    pillTexts() {
        const { itemLabel, unitLabel, foundLabel } = this.labels;
        const { totalItems, processedItems, totalChunks, embeddedChunks, totalChunksToEmbed, startTime } = this.stats;
        const units = totalChunksToEmbed > 0 ? `${unitLabel} ${embeddedChunks} of ${totalChunksToEmbed}`
            : (!foundLabel && totalChunks > 0 ? `${unitLabel} ${totalChunks}` : '');
        const speed = this.unitsPerSecond();
        return {
            items: totalItems > 0 ? `${itemLabel} ${processedItems} / ${totalItems}` : '',
            // A run whose items are its units says it once.
            units: unitLabel === itemLabel ? '' : units,
            found: foundLabel ? `${foundLabel} ${totalChunks}` : '',
            time: `${((Date.now() - startTime) / 1000).toFixed(1)} s`,
            speed: speed > 0 ? `${speed.toFixed(1)} ${unitLabel.toLowerCase()}/s` : '',
        };
    }

    /**
     * Paint the panel from the run's numbers.
     * @param {string} statusOverride - Words for the status line instead of the ones the numbers give
     */
    updateDisplay(statusOverride = '') {
        if (!this.panel || !this.isVisible || !this.elements) return;
        const els = this.elements;
        const percent = this.percentDone();
        setText(els.title, this.currentOperation || 'VectFox Progress');
        setText(els.status, statusOverride || this.finalStatus || this.generateStatusMessage());
        setText(els.percent, `${percent}%`);
        if (els.bar.value !== percent) els.bar.value = percent;
        const texts = this.pillTexts();
        for (const name of PROGRESS_PILLS) {
            setText(els.pills[name], texts[name]);
            showPart(els.pills[name], Boolean(texts[name]));
        }
    }

    /**
     * Generate status message based on current state
     */
    generateStatusMessage() {
        const { processedItems, totalItems, totalChunksToEmbed, embeddedChunks, currentBatch, totalBatches } = this.stats;
        if (this.isCancelling) return 'Stopping…';
        if (processedItems === 0) return 'Starting…';
        if (totalChunksToEmbed > 0) return embeddedChunks < totalChunksToEmbed ? 'Processing…' : 'Finishing…';
        if (processedItems >= totalItems) return 'Finishing…';
        if (totalBatches > 0) return `Batch ${currentBatch} of ${totalBatches}`;
        return 'Processing…';
    }

    /**
     * Count the time pill on while the run goes.
     */
    startTimeUpdater() {
        this.stopTimeUpdater();
        this.timeIntervalId = setInterval(() => {
            if (this.isVisible && !this.isComplete) setText(this.elements?.pills.time, this.pillTexts().time);
        }, TIME_TICK_MS);
    }

    stopTimeUpdater() {
        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
            this.timeIntervalId = null;
        }
    }
}

// Export singleton instance
export const progressTracker = new ProgressTracker();
