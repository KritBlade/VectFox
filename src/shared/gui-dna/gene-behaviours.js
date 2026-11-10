/**
 * ============================================================================
 * GENE BEHAVIOURS
 * ============================================================================
 * The behaviours every VectFox surface on GUI-DNA shares (mvu-helper/devdoc/gui-dna.md
 * §7), for its shell: the settings panel (settings-panel/panel-shell.js), the
 * Database Browser, its Chunk Visualizer, Vectorize Content, Diagnostics, Text
 * Cleaning and the progress panel. The (?) and chevron toggles, a split's divider
 * and a slider beside its number box are bound once on the surface's root,
 * delegated, so a field, card or split painted later behaves the same way, and no
 * such state is saved. Code folds a card as its chevron does, moves sliders to
 * boxes it set, shows a page the nav switches to from its top, and shows or hides
 * a part with as few style writes as it can.
 * ============================================================================
 */

/** How far an arrow key moves a split's divider, and the narrowest either pane gets (devdoc/gui-dna.md §5 Split). */
export const SPLIT_KEY_STEP = 16;
export const SPLIT_MIN_PANE = 240;

/**
 * Where a divider may go: each pane keeps its minimum width, and in a split too narrow for both the start pane keeps
 * its own.
 *
 * @param {number} splitWidth
 * @param {number} dividerWidth
 * @returns {{min: number, max: number}} The start pane's width, in pixels
 */
export function splitLimits(splitWidth, dividerWidth) {
    return { min: SPLIT_MIN_PANE, max: Math.max(SPLIT_MIN_PANE, Math.round(splitWidth - dividerWidth - SPLIT_MIN_PANE)) };
}

/**
 * The start pane's width after a key on its divider: an arrow moves it a step, Home and End to the limits. Null for
 * any other key.
 *
 * @param {number} width
 * @param {string} key
 * @param {{min: number, max: number}} limits
 * @returns {number|null}
 */
export function splitWidthAfterKey(width, key, { min, max }) {
    const moved = { ArrowLeft: width - SPLIT_KEY_STEP, ArrowRight: width + SPLIT_KEY_STEP, Home: min, End: max }[key];
    return moved === undefined ? null : Math.min(max, Math.max(min, Math.round(moved)));
}

/**
 * The rule that holds a split's start width, by the split's id. The width lives in a stylesheet and never on the
 * element: on SillyTavern's page an element's style attribute costs about three times a rule's to change (its
 * toggle-dependent.css matches style attributes inside :has()), and a dragged divider changes it every frame.
 */
const splitWidthRules = new Map();
let splitWidthSheet = null;

function splitWidthRule(split) {
    if (!splitWidthSheet?.isConnected) {
        splitWidthSheet = document.createElement('style');
        splitWidthSheet.dataset.vfxSplitWidths = '';
        document.head.append(splitWidthSheet);
        splitWidthRules.clear();
    }
    let rule = splitWidthRules.get(split.id);
    if (!rule) {
        const { sheet } = splitWidthSheet;
        rule = sheet.cssRules[sheet.insertRule(`#${split.id} {}`, sheet.cssRules.length)];
        splitWidthRules.set(split.id, rule);
    }
    return rule;
}

/** Give a split's start pane `width` pixels, and tell a screen reader where its divider is. */
function setSplitWidth(split, divider, width, limits) {
    splitWidthRule(split).style.setProperty('--vfx-split-start', `${width}px`);
    divider.setAttribute('aria-valuemin', String(limits.min));
    divider.setAttribute('aria-valuemax', String(limits.max));
    divider.setAttribute('aria-valuenow', String(width));
}

function dividerContext(divider) {
    const split = divider.closest('.vfx-split');
    if (!split?.id) return null;
    const limits = splitLimits(split.getBoundingClientRect().width, divider.getBoundingClientRect().width);
    return { split, limits, width: Math.round(split.firstElementChild.getBoundingClientRect().width) };
}

/** Drag a divider: its pane follows the pointer, written once a frame. */
function dragDivider(divider, startEvent) {
    const context = dividerContext(divider);
    if (!context) return;
    const { split, limits } = context;
    const splitLeft = split.getBoundingClientRect().left;
    let pendingWidth = context.width;
    let frame = 0;
    divider.setPointerCapture?.(startEvent.pointerId);
    divider.classList.add('is-dragging');
    const onMove = (event) => {
        pendingWidth = Math.min(limits.max, Math.max(limits.min, Math.round(event.clientX - splitLeft)));
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            setSplitWidth(split, divider, pendingWidth, limits);
        });
    };
    const onEnd = () => {
        cancelAnimationFrame(frame);
        setSplitWidth(split, divider, pendingWidth, limits);
        divider.classList.remove('is-dragging');
        divider.removeEventListener('pointermove', onMove);
        divider.removeEventListener('pointerup', onEnd);
        divider.removeEventListener('pointercancel', onEnd);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onEnd);
    divider.addEventListener('pointercancel', onEnd);
}

/**
 * Bind them on a surface's root: the (?) beside a label opens its field's longer explanation in place, a tap and never
 * a hover; a card's or record's chevron collapses it; and a split's divider is dragged, or moved with the arrow keys,
 * Home and End. A split needs an id, a plain identifier, which names its width's rule.
 *
 * @param {HTMLElement|null} root
 */
export function bindGeneBehaviours(root) {
    const $root = $(root);
    $root.on('click', '.vfx-help-toggle', function () {
        const $field = $(this).closest('.vfx-field');
        const isOpen = !$field.hasClass('is-help-open');
        $field.toggleClass('is-help-open', isOpen);
        $(this).attr('aria-expanded', String(isOpen));
    });
    $root.on('click', '.vfx-collapse', function () {
        const box = this.closest('.vfx-card, .vfx-record');
        if (box) setCollapsed(box, !box.classList.contains('is-collapsed'));
    });
    $root.on('pointerdown', '.vfx-split-divider', function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        dragDivider(this, event.originalEvent ?? event);
    });
    $root.on('keydown', '.vfx-split-divider', function (event) {
        const context = dividerContext(this);
        const width = context && splitWidthAfterKey(context.width, event.key, context.limits);
        if (width === null || width === undefined) return;
        event.preventDefault();
        setSplitWidth(context.split, this, width, context.limits);
    });
    // Dragging a slider writes its number box and fires the box's own input and change, so the box's handler saves
    // exactly as if the number had been typed; typing a number moves its slider.
    $root.on('input', '.vfx-range[data-vfx-slider-for]', function () {
        $(document.getElementById(this.dataset.vfxSliderFor)).val(this.value).trigger('input').trigger('change');
    });
    $root.on('input change', 'input[type="number"]', function () {
        $root.find(`.vfx-range[data-vfx-slider-for="${this.id}"]`).val(this.value);
    });
}

/**
 * Move every slider under `root` to its number box, which owns the value. Setting a number with .val() fires no
 * event, so code that sets numbers after the surface is wired calls this. A box's id is a plain identifier.
 *
 * @param {HTMLElement|null} root
 */
export function syncSliders(root) {
    for (const slider of root?.querySelectorAll('.vfx-range[data-vfx-slider-for]') ?? []) {
        const number = root.querySelector(`#${slider.dataset.vfxSliderFor}`);
        if (number) slider.value = number.value;
    }
}

/**
 * Fold or unfold a card or record as its chevron does, and tell a screen reader through that chevron. A card or record
 * nested inside keeps its own state.
 *
 * @param {HTMLElement} box - A .vfx-card or .vfx-record
 * @param {boolean} isCollapsed
 */
export function setCollapsed(box, isCollapsed) {
    box.classList.toggle('is-collapsed', isCollapsed);
    for (const chevron of box.querySelectorAll('.vfx-collapse')) {
        if (chevron.closest('.vfx-card, .vfx-record') === box) chevron.setAttribute('aria-expanded', String(!isCollapsed));
    }
}

/**
 * Show or hide an element by its inline display, writing the style only when that changes: on SillyTavern's page each
 * inline style write costs a style pass. A DNA page, button or pill draws its own display, so `hidden` would not hide it.
 *
 * @param {HTMLElement|null} element
 * @param {boolean} isShown
 */
export function setShown(element, isShown) {
    if (!element) return;
    const isHiddenNow = element.style.display === 'none';
    if (isShown && isHiddenNow) element.style.removeProperty('display');
    else if (!isShown && !isHiddenNow) element.style.display = 'none';
}

/**
 * Show a page the nav just switched to from its top. Every page of a surface scrolls in the same box (a top bar's main
 * pane, or a rail's dialog), so without this the new page opens as far down as the last one was scrolled. Every box
 * from the page up to its dialog goes back to the top. A page outside a dialog is left alone.
 *
 * @param {HTMLElement|null} page
 */
export function scrollPageToTop(page) {
    const dialog = page?.closest('dialog');
    if (!dialog) return;
    for (let box = page.parentElement; box && dialog.contains(box); box = box.parentElement) {
        box.scrollTop = 0;
    }
}
